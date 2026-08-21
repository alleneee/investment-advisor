from __future__ import annotations

import hashlib
import json
import threading
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo

import psycopg

from .contracts import LedgerEvent
from .metrics import (
    AccountValuationService,
    NavPoint,
    _business_date,
    _event_from_cash_flow,
    _event_from_execution,
    _raw_bar,
    build_chart_bundle,
    build_nav,
    calculate_review_metrics,
    compare_period_metrics,
    previous_period_bounds,
    raw_bar_digest,
)
from .reducer import canonical_decimal_text, replay_ledger
from .service import TradingServiceError
from .store import (
    MarketRevisionConflict,
    ReviewJobNotFound,
    ReviewLeaseConflict,
    ReviewNotRetryable,
    ReviewRevisionConflict,
    TradingStore,
)

SHANGHAI = ZoneInfo("Asia/Shanghai")
PeriodKind = Literal["week", "month", "quarter", "year"]
REPORT_SCHEMA_VERSION = "deterministic_trading_review.v1"
ENGINE_VERSION = "trading-review-engine.v1"
PROMPT_VERSION = "trading-review-prompt.v1"


class TradingReportError(TradingServiceError):
    status_code = 409
    retryable = False


class InvalidPeriodError(TradingReportError):
    code = "INVALID_REQUEST"
    status_code = 400


class PeriodNotClosedError(TradingReportError):
    code = "PERIOD_NOT_CLOSED"
    status_code = 422


class MarketDataNotReadyError(TradingReportError):
    code = "MARKET_DATA_NOT_READY"
    status_code = 503
    retryable = True


class TradingReportConsistencyError(TradingReportError):
    code = "REPORT_INPUT_CHANGED"
    retryable = True


class TradingReportNotFoundError(TradingReportError):
    code = "REPORT_NOT_FOUND"
    status_code = 404


class TradingReportService:
    def __init__(
        self,
        store: TradingStore,
        *,
        market_provider: Any | None = None,
        calendar_provider: Any | None = None,
        scheduler: Callable[[Callable[[], None]], None] | None = None,
        clock: Callable[[], datetime] | None = None,
        review_lease_seconds: int = 300,
    ) -> None:
        self.store = store
        self.database = store.database
        self.market_provider = market_provider
        self.calendar_provider = calendar_provider
        self.scheduler = scheduler or self._thread_scheduler
        self.clock = clock or (lambda: datetime.now(SHANGHAI))
        self.review_lease_seconds = review_lease_seconds
        self.valuation = AccountValuationService(
            self.database,
            market_provider=market_provider,
            calendar_provider=calendar_provider,
            clock=clock,
        )

    def preview(
        self,
        period_kind: PeriodKind,
        period_start: date,
        period_end: date,
    ) -> dict[str, Any]:
        prepared = self._prepare(period_kind, period_start, period_end, formal=False)
        return {
            "period_kind": prepared["period_kind"],
            "period_start": prepared["period_start"].isoformat(),
            "period_end": prepared["period_end"].isoformat(),
            "partial_period": prepared["partial_period"],
            "data_quality": prepared["data_quality"],
            "input_digest": prepared["input_digest"],
            "ledger_revision": prepared["ledger_revision"],
            "daily_review_revision": prepared["daily_review_revision"],
            "market_revision": prepared["market_revision"],
            "market_watermark": prepared["market_watermark"],
            "deterministic_report": prepared["deterministic_report"],
            "error": None,
        }

    def create(
        self,
        period_kind: PeriodKind,
        period_start: date,
        period_end: date,
    ) -> tuple[dict[str, Any], bool]:
        prepared = self._prepare(period_kind, period_start, period_end, formal=True)
        try:
            job, owner = self.store.get_or_create_review_job(
                {
                    "account_id": prepared["account_id"],
                    "period_kind": prepared["period_kind"],
                    "period_start": prepared["period_start"].isoformat(),
                    "period_end": prepared["period_end"].isoformat(),
                    "input_digest": prepared["input_digest"],
                    "ledger_revision": prepared["ledger_revision"],
                    "daily_review_revision": prepared["daily_review_revision"],
                    "market_revision": prepared["market_revision"],
                    "data_as_of": prepared["data_as_of"],
                    "market_watermark": prepared["market_watermark"],
                    "data_quality": prepared["data_quality"],
                    "frozen_input": prepared["frozen_input"],
                    "snapshot_payload": prepared["snapshot_payload"],
                }
            )
        except ReviewRevisionConflict as exc:
            raise TradingReportConsistencyError(str(exc)) from exc
        if owner:
            self._schedule(job["review_job_id"])
        return self._response(job), owner

    def get(self, report_id: str) -> dict[str, Any]:
        job = self.store.get_review_job(report_id)
        if job is None:
            raise TradingReportNotFoundError("复盘报告不存在")
        return self._response(job)

    def list(
        self,
        period_kind: PeriodKind,
        period_start: date,
        period_end: date,
    ) -> list[dict[str, Any]]:
        self._validate_period_bounds(period_kind, period_start, period_end)
        calendar_days = self.valuation._calendar_dates(period_start, period_end)
        if not calendar_days:
            raise MarketDataNotReadyError("交易日历尚未就绪")
        account = self._account()
        rows = self.store.list_review_jobs(
            account["account_id"],
            period_kind=period_kind,
            period_start=calendar_days[0].isoformat(),
            period_end=calendar_days[-1].isoformat(),
        )
        return [self._response(row) for row in rows]

    def retry(self, report_id: str) -> tuple[dict[str, Any], bool]:
        current = self.store.get_review_job(report_id)
        if current is None:
            raise TradingReportNotFoundError("复盘报告不存在")
        if current["status"] != "failed":
            raise TradingReportError("只有 failed 报告可以重试", code="REPORT_NOT_RETRYABLE")
        effective_start = date.fromisoformat(current["period_start"])
        effective_end = date.fromisoformat(current["period_end"])
        natural_start, natural_end = self._natural_bounds(
            current["period_kind"], effective_start, effective_end
        )
        prepared = self._prepare(
            current["period_kind"],
            natural_start,
            natural_end,
            formal=True,
        )
        request = {
            "account_id": prepared["account_id"],
            "period_kind": prepared["period_kind"],
            "period_start": prepared["period_start"].isoformat(),
            "period_end": prepared["period_end"].isoformat(),
            "input_digest": prepared["input_digest"],
            "ledger_revision": prepared["ledger_revision"],
            "daily_review_revision": prepared["daily_review_revision"],
            "market_revision": prepared["market_revision"],
            "data_as_of": prepared["data_as_of"],
            "market_watermark": prepared["market_watermark"],
            "data_quality": prepared["data_quality"],
            "frozen_input": prepared["frozen_input"],
            "snapshot_payload": prepared["snapshot_payload"],
        }
        try:
            same, created = self.store.get_or_create_review_job(request)
        except ReviewRevisionConflict as exc:
            raise TradingReportConsistencyError(str(exc)) from exc
        if created:
            self._schedule(same["review_job_id"])
            return self._response(same), True
        if same["review_job_id"] != report_id:
            self._schedule(same["review_job_id"])
            return self._response(same), True
        try:
            retried = self.store.retry_review_job(report_id)
        except (ReviewJobNotFound, ReviewLeaseConflict, ReviewNotRetryable) as exc:
            raise TradingReportError(str(exc), code=getattr(exc, "code", "REPORT_NOT_RETRYABLE")) from exc
        self._schedule(report_id)
        return self._response(retried), True

    def _schedule(self, report_id: str) -> None:
        self.scheduler(lambda: self._run(report_id))

    def _run(self, report_id: str) -> None:
        execution_id = f"trading-review-{uuid.uuid4()}"
        try:
            job = self.store.claim_review_job(
                report_id,
                execution_id,
                now=self._now(),
                lease_seconds=self.review_lease_seconds,
            )
        except (ReviewJobNotFound, ReviewLeaseConflict):
            return
        try:
            payload = job.get("snapshot_payload") or {}
            self.store.complete_review_job(
                report_id,
                execution_id=execution_id,
                lease_epoch=job["lease_epoch"],
                payload=payload,
                data_quality=job.get("data_quality", "unavailable"),
                data_as_of=job.get("data_as_of"),
                market_watermark=job.get("market_watermark"),
                now=self._now(),
            )
        except (KeyError, RuntimeError, TypeError, ValueError, psycopg.Error) as exc:
            try:
                self.store.fail_review_job(
                    report_id,
                    execution_id=execution_id,
                    lease_epoch=job["lease_epoch"],
                    error={"code": "INTERNAL_ERROR", "message": str(exc), "retryable": True},
                    now=self._now(),
                )
            except (KeyError, RuntimeError, TypeError, ValueError, psycopg.Error):
                return

    def _prepare(
        self,
        period_kind: PeriodKind,
        requested_start: date,
        requested_end: date,
        *,
        formal: bool,
        include_comparison: bool = True,
    ) -> dict[str, Any]:
        if requested_start > requested_end:
            raise InvalidPeriodError("period_start 不能晚于 period_end")
        self._validate_period_bounds(period_kind, requested_start, requested_end)
        account = self._account()
        start_revisions = self._revisions(account["account_id"])
        calendar_days = self.valuation._calendar_dates(requested_start, requested_end)
        if not calendar_days:
            raise MarketDataNotReadyError("交易日历尚未就绪")
        effective_start, effective_end = calendar_days[0], calendar_days[-1]
        activation = _business_date(account["activated_on"])
        baseline_days = self.valuation._calendar_dates(activation, effective_start - timedelta(days=1))
        valuation_days = sorted(set(baseline_days + calendar_days))
        now = self._now()
        if formal and (
            now.date() < effective_end
            or (now.date() == effective_end and now.timetz().replace(tzinfo=None) < time(15, 0))
        ):
            raise PeriodNotClosedError("报告周期尚未收盘")
        executions = self._executions(account["account_id"])
        cash_flows = self.store.list_cash_flows(account["account_id"])
        reviews = self._reviews(
            account["account_id"],
            self.database,
            period_start=effective_start,
            period_end=effective_end,
        )
        events = [
            _event_from_cash_flow(row) for row in cash_flows
        ] + [_event_from_execution(row) for row in executions]
        period_executions = [
            row for row in executions
            if effective_start <= _business_date(row.get("occurred_at", row.get("executed_at"))) <= effective_end
        ]
        period_symbols = {str(row["symbol"]) for row in period_executions}
        baseline = replay_ledger(
            Decimal(str(account["initial_capital"])),
            [event for event in events if _business_date(event.occurred_at) < effective_start],
        )
        symbols = sorted(period_symbols | set(baseline.positions))
        prices, quality, warnings = self.valuation._market_prices(
            account["account_id"], symbols, valuation_days
        )
        missing = self._missing_valuation_prices(
            account, events, prices, valuation_days, valued_symbols=set(symbols)
        )
        if formal and missing:
            raise MarketDataNotReadyError("报告周期存在未就绪的收盘价")
        try:
            chart_bundles = self._chart_bundles(
                account["account_id"],
                symbols,
                executions,
                effective_start,
                effective_end,
                expected_dates=calendar_days,
                period_executions=period_executions,
            )
        except MarketRevisionConflict as exc:
            raise TradingReportConsistencyError("报告生成期间行情 revision 发生变化，请重试") from exc
        if quality == "ok" and any(
            bundle.get("quality", {}).get("warnings") for bundle in chart_bundles
        ):
            quality = "degraded"
        valuations = self._valuations(
            account, events, cash_flows, prices, valuation_days, valued_symbols=set(symbols)
        )
        nav_points = build_nav(
            base_equity=Decimal(str(account["initial_capital"])),
            valuations=valuations,
        )
        metrics = calculate_review_metrics(
            initial_capital=account["initial_capital"],
            executions=executions,
            cash_flows=cash_flows,
            daily_reviews=reviews,
            trading_days=calendar_days,
            valuation_points=nav_points,
            period_start=effective_start,
            period_end=effective_end,
            names={row["symbol"]: row.get("name", row["symbol"]) for row in executions},
        )
        deterministic = self._deterministic_report(
            metrics,
            nav_points,
            chart_bundles,
            calendar_days,
            executions,
            effective_start,
            effective_end,
            period_kind,
            account,
        )
        partial_period = _business_date(account["activated_on"]) > effective_start
        quality_warnings = set(warnings)
        for bundle in chart_bundles:
            quality_warnings.update(bundle.get("quality", {}).get("warnings", []))
        if partial_period:
            quality_warnings.add("partial_period")
        if metrics["closed_cycle_count"] < 5:
            quality_warnings.add("insufficient_overall_sample")
        if any(not item["conclusion_allowed"] for item in metrics["reason_performance"]):
            quality_warnings.add("insufficient_reason_sample")
        if any(item.get("discipline_followed") is None for item in metrics["cycle_cases"]):
            quality_warnings.add("missing_daily_review")
        deterministic["quality"] = {"warnings": sorted(quality_warnings)}
        daily_review_dependency = self._digest({"daily_reviews": reviews})
        market_revision_before_previous = self._revisions(account["account_id"])["market_revision"]
        previous = (
            self._previous_report(account["account_id"], period_kind, effective_start, effective_end)
            if include_comparison
            else None
        )
        expected_market_revision = self._revisions(account["account_id"])["market_revision"]
        if expected_market_revision < market_revision_before_previous:
            raise TradingReportConsistencyError("行情 revision 回退，请重试")
        comparison = compare_period_metrics(
            metrics,
            previous["payload"] if previous else None,
            partial_period=partial_period,
        )
        if comparison["comparison"] is not None:
            comparison["comparison"]["previous_period"] = {
                "kind": period_kind,
                "start": previous["period_start"],
                "end": previous["period_end"],
            }
        deterministic["comparison"] = comparison["comparison"]
        deterministic["comparison_unavailable_reason"] = comparison["comparison_unavailable_reason"]
        end_revisions = self._revisions(account["account_id"])
        if (
            end_revisions["ledger_revision"] != start_revisions["ledger_revision"]
            or end_revisions["daily_review_revision"] != start_revisions["daily_review_revision"]
            or end_revisions["market_revision"] != expected_market_revision
        ):
            raise TradingReportConsistencyError("报告生成期间输入 revision 发生变化，请重试")
        market_revision = end_revisions["market_revision"]
        ledger_revision = end_revisions["ledger_revision"]
        daily_revision = end_revisions["daily_review_revision"]
        watermark = self._watermark(prices, chart_bundles)
        digest = self._digest(
            {
                "schema_version": REPORT_SCHEMA_VERSION,
                "period_kind": period_kind,
                "period_start": effective_start.isoformat(),
                "period_end": effective_end.isoformat(),
                "ledger_revision": ledger_revision,
                "daily_review_dependency": daily_review_dependency,
                "market_revision": market_revision,
                "market_watermark": watermark,
                "chart_bundles": chart_bundles,
                "previous": previous and {
                    "period_start": previous["period_start"],
                    "period_end": previous["period_end"],
                    "input_digest": previous["input_digest"],
                    "ledger_revision": previous["ledger_revision"],
                    "daily_review_dependency": previous["daily_review_dependency"],
                    "market_revision": previous["market_revision"],
                },
                "engine_version": ENGINE_VERSION,
                "prompt_version": PROMPT_VERSION,
            }
        )
        snapshot_payload = {
            "deterministic_report": deterministic,
            "metrics": metrics,
            "partial_period": partial_period,
            "warnings": sorted(set(warnings)),
            "period_kind": period_kind,
            "period_start": effective_start.isoformat(),
            "period_end": effective_end.isoformat(),
        }
        price_dependencies = [
            {
                "symbol": symbol,
                "valuation_date": valuation_date.isoformat(),
                **dict(row),
            }
            for (symbol, valuation_date), row in sorted(
                prices.items(), key=lambda item: (item[0][0], item[0][1])
            )
        ]
        frozen_input = {
            "schema_version": REPORT_SCHEMA_VERSION,
            "period_kind": period_kind,
            "period_start": effective_start.isoformat(),
            "period_end": effective_end.isoformat(),
            "input_digest": digest,
            "data_as_of": now.isoformat(),
            "market_watermark": watermark,
            "ledger_revision": ledger_revision,
            "daily_review_revision": daily_revision,
            "daily_review_dependency": daily_review_dependency,
            "market_revision": market_revision,
            "engine_version": ENGINE_VERSION,
            "prompt_version": PROMPT_VERSION,
            "executions": [dict(row) for row in executions],
            "cash_flows": [dict(row) for row in cash_flows],
            "daily_reviews": [dict(row) for row in reviews],
            "price_dependencies": price_dependencies,
            "chart_bundles": [dict(bundle) for bundle in chart_bundles],
            "row_ids": {
                "executions": [row.get("execution_id") for row in executions],
                "cash_flows": [row.get("cash_flow_id") for row in cash_flows],
                "daily_reviews": [row.get("daily_review_id") for row in reviews],
            },
        }
        return {
            "account_id": account["account_id"],
            "period_kind": period_kind,
            "period_start": effective_start,
            "period_end": effective_end,
            "partial_period": partial_period,
            "data_quality": quality,
            "data_as_of": now.isoformat(),
            "market_watermark": watermark,
            "ledger_revision": ledger_revision,
            "daily_review_revision": daily_revision,
            "daily_review_dependency": daily_review_dependency,
            "market_revision": market_revision,
            "input_digest": digest,
            "deterministic_report": deterministic,
            "snapshot_payload": snapshot_payload,
            "metrics": metrics,
            "frozen_input": frozen_input,
        }

    def _deterministic_report(
        self,
        metrics: Mapping[str, Any],
        nav_points: Sequence[NavPoint],
        chart_bundles: Sequence[Mapping[str, Any]],
        trading_days: Sequence[date],
        executions: Sequence[Mapping[str, Any]],
        period_start: date,
        period_end: date,
        period_kind: PeriodKind,
        account: Mapping[str, Any],
    ) -> dict[str, Any]:
        metric_names = (
            "account_adjusted_return_rate",
            "period_max_drawdown_rate",
            "win_rate",
            "average_win_loss_ratio",
            "profit_factor",
            "median_holding_days",
            "median_capital_efficiency",
            "discipline_adherence_rate",
        )
        equity_curve = []
        for point in nav_points:
            if not period_start <= point.date <= period_end:
                continue
            equity_curve.append(
                {
                    "date": point.date.isoformat(),
                    "equity": canonical_decimal_text(point.equity),
                    "nav": _nullable(point.nav, point.unavailable_reason),
                    "drawdown_rate": _nullable(point.drawdown_rate, point.unavailable_reason),
                }
            )
        return {
            "schema_version": REPORT_SCHEMA_VERSION,
            "sample": {
                "trading_day_count": len(trading_days),
                "execution_count": len(
                    [
                        row for row in executions
                        if period_start <= _business_date(row.get("occurred_at", row.get("executed_at"))) <= period_end
                    ]
                ),
                "closed_cycle_count": metrics["closed_cycle_count"],
                "overall_conclusion_allowed": metrics["overall_conclusion_allowed"],
            },
            "metrics": {name: metrics[name] for name in ("period_realized_pnl", "closed_cycle_pnl", *metric_names)},
            "equity_curve": equity_curve,
            "execution_reason_facts": metrics["execution_reason_facts"],
            "reason_performance": metrics["reason_performance"],
            "cycle_cases": metrics["cycle_cases"],
            "comparison": None,
            "comparison_unavailable_reason": None,
            "chart_bundles": list(chart_bundles),
        }

    def _valuations(
        self,
        account: Mapping[str, Any],
        events: Sequence[LedgerEvent],
        cash_flows: Sequence[Mapping[str, Any]],
        prices: Mapping[tuple[str, date], Mapping[str, Any]],
        trading_days: Sequence[date],
        *,
        valued_symbols: set[str],
    ) -> list[dict[str, Any]]:
        flow_by_day: dict[date, Decimal] = {}
        for row in cash_flows:
            day = _business_date(row["occurred_at"])
            flow = Decimal(str(row["amount"])) * (1 if row["kind"] == "deposit" else -1)
            target = next((item for item in trading_days if item >= day), None)
            if target is not None:
                flow_by_day[target] = flow_by_day.get(target, Decimal(0)) + flow
        result = []
        initial = Decimal(str(account["initial_capital"]))
        for day in trading_days:
            replay = replay_ledger(initial, [event for event in events if _business_date(event.occurred_at) <= day])
            market_value = Decimal(0)
            missing = False
            for symbol, position in replay.positions.items():
                if symbol not in valued_symbols:
                    continue
                row = prices.get((symbol, day))
                if row is None:
                    missing = True
                    break
                market_value += Decimal(position.quantity) * Decimal(str(row["close"]))
            if not missing:
                result.append(
                    {
                        "date": day,
                        "equity": replay.cash + market_value,
                        "external_flow": flow_by_day.get(day, Decimal(0)),
                    }
                )
        return result

    @staticmethod
    def _missing_valuation_prices(
        account: Mapping[str, Any],
        events: Sequence[LedgerEvent],
        prices: Mapping[tuple[str, date], Mapping[str, Any]],
        trading_days: Sequence[date],
        *,
        valued_symbols: set[str],
    ) -> bool:
        initial = Decimal(str(account["initial_capital"]))
        for day in trading_days:
            replay = replay_ledger(initial, [event for event in events if _business_date(event.occurred_at) <= day])
            for symbol in replay.positions:
                if symbol not in valued_symbols:
                    continue
                if (symbol, day) not in prices:
                    return True
        return False

    def _chart_bundles(
        self,
        account_id: str,
        symbols: Sequence[str],
        executions: Sequence[Mapping[str, Any]],
        start: date,
        end: date,
        *,
        expected_dates: Sequence[date],
        period_executions: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        bundles = []
        for symbol in symbols:
            bars = self.store.list_market_bars(account_id, symbol, start, end)
            cached_by_date = {str(bar["trade_date"]): bar for bar in bars}
            missing_dates = {day.isoformat() for day in expected_dates} - set(cached_by_date)
            if missing_dates:
                expected_market_revision = self._revisions(account_id)["market_revision"]
                try:
                    from .metrics import _provider_daily

                    raw_bars = _provider_daily(self.market_provider, symbol, start, end)
                except (RuntimeError, TypeError, ValueError):
                    raw_bars = []
                bars = [_raw_bar(row) for row in raw_bars if row.get("close") is not None]
                if bars:
                    self.store.cache_market_bars(
                        account_id,
                        [{"symbol": symbol, **bar} for bar in bars],
                        expected_market_revision=expected_market_revision,
                    )
                    cached_by_date.update({str(bar["trade_date"]): bar for bar in bars})
                bars = [cached_by_date[key] for key in sorted(cached_by_date)]
            name = next((row.get("name", symbol) for row in executions if row["symbol"] == symbol), symbol)
            bundle = build_chart_bundle(
                symbol=symbol,
                name=name,
                bars=bars,
                executions=period_executions,
            )
            bundle["quality"] = {
                "warnings": list(bundle.get("quality", {}).get("warnings", [])),
            }
            bundles.append(bundle)
        return bundles

    def _executions(self, account_id: str) -> list[dict[str, Any]]:
        rows = self.store.list_executions(account_id)
        with self.database.read() as connection:
            for row in rows:
                detail = connection.execute(
                    "SELECT name, tags, note FROM trading_execution_details WHERE execution_id = %s",
                    (row["execution_id"],),
                ).fetchone()
                if detail is not None:
                    row["name"] = detail["name"]
                    row["tags"] = json.loads(detail["tags"])
                    row["note"] = detail["note"]
        return rows

    @staticmethod
    def _reviews(
        database_account_id: str,
        database: Any | None = None,
        *,
        period_start: date | None = None,
        period_end: date | None = None,
    ) -> list[dict[str, Any]]:
        if database is None:
            return []
        if (period_start is None) != (period_end is None):
            raise ValueError("period_start 与 period_end 必须成对提供")
        query = (
            "SELECT daily_review_id, trade_date, payload, revision FROM daily_reviews "
            "WHERE account_id = %s AND is_deleted = 0"
        )
        params: list[Any] = [database_account_id]
        if period_start is not None and period_end is not None:
            query += " AND trade_date BETWEEN %s AND %s"
            params.extend([period_start.isoformat(), period_end.isoformat()])
        with database.read() as connection:
            rows = connection.execute(query, params).fetchall()
        return [
            {
                "daily_review_id": row["daily_review_id"],
                "trade_date": row["trade_date"],
                **json.loads(row["payload"]),
                "revision": row["revision"],
            }
            for row in rows
        ]

    def _previous_report(
        self,
        account_id: str,
        period_kind: PeriodKind,
        period_start: date,
        period_end: date,
    ) -> dict[str, Any] | None:
        account = self.store.get_account(account_id)
        if account is None:
            return None
        natural_previous_start, natural_previous_end = previous_period_bounds(
            period_kind, period_start, period_end
        )
        previous_start, previous_end = natural_previous_start, natural_previous_end
        previous_days = self.valuation._calendar_dates(previous_start, previous_end)
        if previous_days:
            previous_start, previous_end = previous_days[0], previous_days[-1]
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT job.*, snapshot.payload, snapshot.period_start AS snap_start,
                    snapshot.period_end AS snap_end, snapshot.is_outdated,
                    snapshot.ledger_revision AS snap_ledger_revision,
                    snapshot.daily_review_revision AS snap_daily_revision,
                    snapshot.market_revision AS snap_market_revision
                FROM trading_review_jobs AS job
                JOIN trading_review_snapshots AS snapshot ON snapshot.snapshot_id = job.snapshot_id
                WHERE job.account_id = %s AND job.period_kind = %s
                    AND snapshot.period_start = %s AND snapshot.period_end = %s
                    AND job.status = 'ready' AND snapshot.snapshot_status = 'ready'
                    AND snapshot.is_outdated = 0
                ORDER BY snapshot.period_end DESC, job.report_version DESC
                LIMIT 1
                """,
                (
                    account_id,
                    period_kind,
                    previous_start.isoformat(),
                    previous_end.isoformat(),
                ),
            ).fetchall()
        if not rows:
            return None
        row = rows[0]
        if _business_date(account["activated_on"]) > _business_date(row["snap_start"]):
            return None
        try:
            previous_payload = json.loads(row["payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            return None
        if previous_payload.get("partial_period") is True:
            return None
        prepare_start, prepare_end = (
            (previous_start, previous_end)
            if period_kind == "week"
            else (natural_previous_start, natural_previous_end)
        )
        prepared = self._prepare(
            period_kind,
            prepare_start,
            prepare_end,
            formal=False,
            include_comparison=False,
        )
        return {
            "period_start": prepared["period_start"].isoformat(),
            "period_end": prepared["period_end"].isoformat(),
            "input_digest": prepared["input_digest"],
            "ledger_revision": prepared["ledger_revision"],
            "daily_review_revision": prepared["daily_review_revision"],
            "daily_review_dependency": prepared["daily_review_dependency"],
            "market_revision": prepared["market_revision"],
            "payload": prepared["metrics"],
        }

    def _account(self) -> dict[str, Any]:
        account = self.store.get_account()
        if account is None:
            raise TradingReportError("交易账户不存在", code="ACCOUNT_NOT_FOUND")
        return account

    def _validate_period_bounds(
        self,
        period_kind: PeriodKind,
        period_start: date,
        period_end: date,
    ) -> None:
        if period_kind == "month":
            expected_end = self._last_day_of_month(period_start)
            valid = period_start.day == 1 and period_end == expected_end
        elif period_kind == "quarter":
            quarter_start_month = ((period_start.month - 1) // 3) * 3 + 1
            expected_start = period_start.replace(month=quarter_start_month, day=1)
            expected_end = self._last_day_of_month(expected_start.replace(month=quarter_start_month + 2))
            valid = period_start == expected_start and period_end == expected_end
        elif period_kind == "year":
            valid = period_start == date(period_start.year, 1, 1) and period_end == date(period_start.year, 12, 31)
        else:
            week_start = period_start - timedelta(days=period_start.weekday())
            week_end = week_start + timedelta(days=6)
            if period_start < week_start or period_end > week_end:
                valid = False
            else:
                trading_days = self.valuation._calendar_dates(week_start, week_end)
                valid = not trading_days or (trading_days[0] == period_start and trading_days[-1] == period_end)
        if not valid:
            raise InvalidPeriodError(f"{period_kind} 报告必须使用自然周期边界")

    @classmethod
    def _natural_bounds(
        cls,
        period_kind: PeriodKind,
        effective_start: date,
        effective_end: date,
    ) -> tuple[date, date]:
        if period_kind == "month":
            natural_start = effective_start.replace(day=1)
            return natural_start, cls._last_day_of_month(natural_start)
        if period_kind == "quarter":
            quarter_start_month = ((effective_start.month - 1) // 3) * 3 + 1
            natural_start = effective_start.replace(month=quarter_start_month, day=1)
            natural_end = cls._last_day_of_month(natural_start.replace(month=quarter_start_month + 2))
            return natural_start, natural_end
        if period_kind == "year":
            return date(effective_start.year, 1, 1), date(effective_start.year, 12, 31)
        return effective_start, effective_end

    @staticmethod
    def _last_day_of_month(value: date) -> date:
        if value.month == 12:
            next_month = date(value.year + 1, 1, 1)
        else:
            next_month = date(value.year, value.month + 1, 1)
        return next_month - timedelta(days=1)

    def _revisions(self, account_id: str) -> dict[str, int]:
        account = self.store.get_account(account_id)
        if account is None:
            raise TradingReportError("交易账户不存在", code="ACCOUNT_NOT_FOUND")
        return {
            "ledger_revision": int(account["ledger_revision"]),
            "daily_review_revision": int(account["daily_review_revision"]),
            "market_revision": int(account["market_revision"]),
        }

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None or value.utcoffset() is None:
            value = value.replace(tzinfo=SHANGHAI)
        return value.astimezone(SHANGHAI)

    @staticmethod
    def _watermark(prices: Mapping[tuple[str, date], Mapping[str, Any]], bundles: Sequence[Mapping[str, Any]]) -> str:
        value = {
            "prices": [
                {
                    "symbol": symbol,
                    "valuation_date": day.isoformat(),
                    **dict(row),
                }
                for (symbol, day), row in sorted(prices.items(), key=lambda item: (item[0][0], item[0][1]))
            ],
            "bars": [
                {
                    "symbol": bundle["symbol"],
                    "market_snapshot_id": bundle["market_snapshot_id"],
                    "trade_dates": [bar["trade_date"] for bar in bundle.get("bars", [])],
                    "refs": [
                        {
                            "trade_date": bar["trade_date"],
                            "bar_digest": raw_bar_digest(bar),
                        }
                        for bar in bundle.get("bars", [])
                    ],
                    "bar_digests": [raw_bar_digest(bar) for bar in bundle.get("bars", [])],
                }
                for bundle in bundles
            ],
        }
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _digest(value: Mapping[str, Any]) -> str:
        return hashlib.sha256(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()

    @staticmethod
    def _response(job: Mapping[str, Any]) -> dict[str, Any]:
        stored_error = job.get("error")
        retryable = bool(isinstance(stored_error, Mapping) and stored_error.get("retryable") is True)
        error = None
        if isinstance(stored_error, Mapping):
            error = {
                "code": stored_error.get("code", "INTERNAL_ERROR"),
                "message": stored_error.get("message", "报告任务失败"),
            }
        payload = job.get("snapshot_payload") or {}
        return {
            "report_id": job["review_job_id"],
            "snapshot_id": job.get("snapshot_id"),
            "report_version": int(job.get("report_version") or 1),
            "supersedes_snapshot_id": job.get("supersedes_snapshot_id"),
            "account_id": job["account_id"],
            "period_kind": job["period_kind"],
            "period_start": job.get("period_start"),
            "period_end": job.get("period_end"),
            "data_as_of": job.get("data_as_of"),
            "input_digest": job["input_digest"],
            "ledger_revision": int(job.get("ledger_revision", 0)),
            "daily_review_revision": int(job.get("daily_review_revision", 0)),
            "market_revision": int(job.get("market_revision", 0)),
            "market_watermark": job.get("market_watermark"),
            "attempt": int(job.get("attempt") or 1),
            "snapshot_status": job.get("status"),
            "data_quality": job.get("data_quality", "unavailable"),
            "ai_status": job.get("ai_status", "not_requested"),
            "is_outdated": bool(job.get("is_outdated", False)),
            "partial_period": bool(payload.get("partial_period", False)),
            "retryable": retryable,
            "deterministic_report": payload.get("deterministic_report") if job.get("status") == "ready" else None,
            "ai_review": None,
            "error": error,
        }

    @staticmethod
    def _thread_scheduler(task: Callable[[], None]) -> None:
        threading.Thread(target=task, daemon=True).start()


def _nullable(value: Decimal | None, reason: str | None) -> dict[str, str | None]:
    if value is None:
        return {"value": None, "unavailable_reason": reason or "no_sample"}
    return {"value": canonical_decimal_text(value), "unavailable_reason": None}


__all__ = [
    "ENGINE_VERSION",
    "REPORT_SCHEMA_VERSION",
    "MarketDataNotReadyError",
    "PeriodNotClosedError",
    "TradingReportConsistencyError",
    "TradingReportError",
    "TradingReportNotFoundError",
    "TradingReportService",
]
