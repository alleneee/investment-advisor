from __future__ import annotations

import hashlib
import json
import uuid
from calendar import monthrange
from collections import Counter
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

from .bs_analysis import BarNotFoundError, assert_bar_exists, build_bs_chart, symbol_bs_summary
from .contracts import LedgerEvent, TradingReducerError
from .metrics import AccountValuationService, period_return_curve, replay_rows, window_max_drawdown
from .reducer import (
    InsufficientCashError,
    InsufficientPositionError,
    canonical_decimal_text,
    money_text,
    replay_ledger,
)
from .store import (
    AccountAlreadyExists,
    AccountNotFound,
    IdempotencyConflict,
    RevisionConflict,
    TradingStore,
    TradingStoreError,
)

_CLIENT_STORE_CODES = {
    "DUPLICATE_TYPE",
    "MARK_TYPE_IN_USE",
    "MARK_TYPE_PRESET",
    "MARK_TYPE_DISABLED",
    "BAR_NOT_FOUND",
}


class TradingServiceError(ValueError):
    code = "TRADING_SERVICE_ERROR"
    status_code = 400

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class TradingNotFoundError(TradingServiceError):
    code = "ACCOUNT_NOT_FOUND"
    status_code = 404


class TradingConflictError(TradingServiceError):
    status_code = 409


class InvalidTradingRequestError(TradingServiceError):
    code = "INVALID_REQUEST"


class _ChartMarketProvider:
    def __init__(self, inner: Any | None) -> None:
        self._inner = inner

    def daily(self, symbol: str, *, as_of=None, start_date=None, end_date=None):
        inner = self._inner
        if inner is None:
            raise RuntimeError("行情不可用")
        method = getattr(inner, "daily", None) or getattr(inner, "get_daily", None)
        if method is None:
            raise RuntimeError("行情不可用")
        return method(symbol, as_of=as_of, start_date=start_date, end_date=end_date)

    def minutes(self, symbol: str, *, freq: str, as_of, start_date, end_date):
        inner = self._inner
        if inner is None:
            raise RuntimeError("分钟行情不可用")
        method = getattr(inner, "minutes", None)
        if method is None:
            raise RuntimeError("分钟行情不可用")
        return method(symbol, freq=freq, as_of=as_of, start_date=start_date, end_date=end_date)


def _from_store_error(exc: TradingStoreError) -> TradingServiceError:
    code = getattr(exc, "code", "INVALID_REQUEST")
    if code == "REVISION_CONFLICT":
        return TradingConflictError(str(exc), code=code)
    if code in _CLIENT_STORE_CODES:
        return InvalidTradingRequestError(str(exc), code=code)
    return InvalidTradingRequestError(str(exc))


class TradingService:
    def __init__(
        self,
        store: TradingStore,
        *,
        market_provider: Any | None = None,
        calendar_provider: Any | None = None,
        clock: Any | None = None,
    ) -> None:
        self.store = store
        self.database = store.database
        self.valuation = AccountValuationService(
            self.database,
            market_provider=market_provider,
            calendar_provider=calendar_provider,
            clock=clock,
        )

    def create_account(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        try:
            account = self.store.create_account(payload)
        except AccountAlreadyExists as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._account_summary(account)

    def account(self) -> dict[str, Any]:
        account = self.store.get_account()
        if account is None:
            raise TradingNotFoundError("交易账户不存在")
        return self._account_summary(account)

    def create_execution(self, payload: Mapping[str, Any], details: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
        account = self._account()
        request = {"account_id": account["account_id"], **payload}
        existing = self._find_by_key(self.store.list_executions(account["account_id"], include_deleted=True), request)
        digest = self._execution_request_digest(request, details)
        request["_service_request_digest"] = digest
        if existing is None:
            self._validate_ledger(account, self._execution_event(request), replace_execution=None)
        try:
            row, created = self.store.create_execution(
                request,
                details=details,
                return_outcome=True,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, self._execution_event(request)
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except (AccountNotFound, TradingStoreError) as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._execution_response(row), created

    def list_executions(
        self, *, on: date | None, start: date | None, end: date | None, symbol: str | None
    ) -> list[dict[str, Any]]:
        account = self._account()
        self._validate_range(on, start, end)
        rows = self.store.list_executions(account["account_id"])
        return [
            self._execution_response(row)
            for row in rows
            if self._in_range(row["occurred_at"], on, start, end)
            and (symbol is None or row["symbol"] == symbol)
        ]

    def update_execution(
        self, execution_id: str, payload: Mapping[str, Any], details: Mapping[str, Any], revision: int
    ) -> dict[str, Any]:
        account = self._account()
        rows = self.store.list_executions(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "execution_id", execution_id)
        self._require_current(existing, revision, "成交")
        request = {"account_id": account["account_id"], **payload}
        digest = self._execution_request_digest(request, details)
        request["_service_request_digest"] = digest
        candidate = self._execution_event(
            request, event_id=execution_id, created_at=existing["created_at"]
        )
        self._validate_ledger(account, candidate, replace_execution=execution_id)
        try:
            row = self.store.update_execution(
                execution_id,
                request,
                details=details,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection,
                    account,
                    candidate,
                    replace_execution=execution_id,
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._execution_response(row)

    def delete_execution(self, execution_id: str, revision: int) -> None:
        account = self._account()
        rows = self.store.list_executions(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "execution_id", execution_id)
        self._require_current(existing, revision, "成交")
        self._validate_ledger(account, None, replace_execution=execution_id)
        try:
            self.store.delete_execution(
                execution_id,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, None, replace_execution=execution_id
                ),
            )
        except RevisionConflict as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def create_cash_flow(self, payload: Mapping[str, Any], *, note: str) -> tuple[dict[str, Any], bool]:
        account = self._account()
        request = {"account_id": account["account_id"], **payload}
        existing = self._find_by_key(self.store.list_cash_flows(account["account_id"], include_deleted=True), request)
        digest = self._cash_flow_request_digest(request, note)
        request["_service_request_digest"] = digest
        if existing is None:
            self._validate_ledger(account, self._cash_flow_event(request), replace_cash_flow=None)
        try:
            row, created = self.store.create_cash_flow(
                request,
                details={"note": note},
                return_outcome=True,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, self._cash_flow_event(request)
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except (AccountNotFound, TradingStoreError) as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._cash_flow_response(row), created

    def list_cash_flows(self, *, on: date | None, start: date | None, end: date | None) -> list[dict[str, Any]]:
        account = self._account()
        self._validate_range(on, start, end)
        return [
            self._cash_flow_response(row)
            for row in self.store.list_cash_flows(account["account_id"])
            if self._in_range(row["occurred_at"], on, start, end)
        ]

    def update_cash_flow(
        self, cash_flow_id: str, payload: Mapping[str, Any], *, note: str, revision: int
    ) -> dict[str, Any]:
        account = self._account()
        rows = self.store.list_cash_flows(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "cash_flow_id", cash_flow_id)
        self._require_current(existing, revision, "现金流")
        request = {"account_id": account["account_id"], **payload}
        digest = self._cash_flow_request_digest(request, note)
        request["_service_request_digest"] = digest
        candidate = self._cash_flow_event(
            request, event_id=cash_flow_id, created_at=existing["created_at"]
        )
        self._validate_ledger(account, candidate, replace_cash_flow=cash_flow_id)
        try:
            row = self.store.update_cash_flow(
                cash_flow_id,
                request,
                details={"note": note},
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection,
                    account,
                    candidate,
                    replace_cash_flow=cash_flow_id,
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._cash_flow_response(row)

    def delete_cash_flow(self, cash_flow_id: str, revision: int) -> None:
        account = self._account()
        rows = self.store.list_cash_flows(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "cash_flow_id", cash_flow_id)
        self._require_current(existing, revision, "现金流")
        self._validate_ledger(account, None, replace_cash_flow=cash_flow_id)
        try:
            self.store.delete_cash_flow(
                cash_flow_id,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, None, replace_cash_flow=cash_flow_id
                ),
            )
        except RevisionConflict as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def put_daily_review(self, trade_date: date, payload: Mapping[str, Any]) -> dict[str, Any]:
        account = self._account()
        expected_revision = payload["revision"]
        body = {key: value for key, value in payload.items() if key != "revision"}
        now = datetime.now(UTC).isoformat()
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM daily_reviews WHERE account_id = %s AND trade_date = %s",
                (account["account_id"], trade_date.isoformat()),
            ).fetchone()
            if row is None:
                if expected_revision is not None:
                    raise TradingConflictError("每日收盘复盘 revision 已过期", code="REVISION_CONFLICT")
                review_id, revision = str(uuid.uuid4()), 1
                connection.execute(
                    """
                    INSERT INTO daily_reviews(
                        daily_review_id, account_id, trade_date, payload, revision, is_deleted, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, 0, %s, %s)
                    """,
                    (review_id, account["account_id"], trade_date.isoformat(), json.dumps(body, ensure_ascii=False), revision, now, now),
                )
            else:
                if expected_revision != int(row["revision"]):
                    raise TradingConflictError("每日收盘复盘 revision 已过期", code="REVISION_CONFLICT")
                review_id, revision = row["daily_review_id"], int(row["revision"]) + 1
                connection.execute(
                    """
                    UPDATE daily_reviews SET payload = %s, revision = %s, is_deleted = 0, updated_at = %s
                    WHERE daily_review_id = %s AND revision = %s
                    """,
                    (json.dumps(body, ensure_ascii=False), revision, now, review_id, expected_revision),
                )
            updated = connection.execute(
                """
                UPDATE trading_meta SET daily_review_revision = daily_review_revision + 1
                WHERE account_id = %s
                """,
                (account["account_id"],),
            )
            if updated.rowcount != 1:
                raise TradingNotFoundError("交易账户不存在")
            daily_revision = connection.execute(
                "SELECT daily_review_revision FROM trading_meta WHERE account_id = %s",
                (account["account_id"],),
            ).fetchone()["daily_review_revision"]
            connection.execute(
                """
                UPDATE trading_review_snapshots SET is_outdated = 1
                WHERE account_id = %s AND period_start <= %s AND period_end >= %s
                    AND daily_review_revision < %s
                """,
                (account["account_id"], trade_date.isoformat(), trade_date.isoformat(), daily_revision),
            )
        return {"daily_review_id": review_id, "trade_date": trade_date.isoformat(), **body, "revision": revision,
                "daily_review_revision": daily_revision}

    def calendar_month(self, month: date) -> dict[str, Any]:
        account = self._account()
        start = month.replace(day=1)
        end = start.replace(day=monthrange(start.year, start.month)[1])
        executions = self.store.list_executions(account["account_id"])
        cash_flows = self.store.list_cash_flows(account["account_id"])
        counts: Counter[date] = Counter()
        for row in executions:
            occurred = _shanghai_date(row["occurred_at"])
            if start <= occurred <= end:
                counts[occurred] += 1
        reviews = self._reviews_in_range(account["account_id"], start, end)
        try:
            nav = self.valuation.nav_points(account, executions, cash_flows)
        except (ArithmeticError, LookupError, OSError, RuntimeError, TypeError, ValueError):
            nav = []
        pnl_by_date = {
            point.date: point.equity - point.previous_equity - point.external_flow
            for point in nav
            if point.previous_equity is not None
        }
        max_drawdown = window_max_drawdown(nav, start, end)
        trading_days = set(self.valuation._calendar_dates(start, end))
        days = []
        cursor = start
        month_pnl = Decimal(0)
        has_pnl = False
        while cursor <= end:
            pnl = pnl_by_date.get(cursor)
            if pnl is not None:
                month_pnl += pnl
                has_pnl = True
            days.append({
                "date": cursor.isoformat(),
                "execution_count": int(counts[cursor]),
                "daily_pnl": None if pnl is None else money_text(pnl),
                "review_status": reviews.get(cursor),
                "is_open": cursor in trading_days if trading_days else cursor.weekday() < 5,
            })
            cursor += timedelta(days=1)
        return {
            "month": start.isoformat()[:7],
            "net_pnl": money_text(month_pnl) if has_pnl else None,
            "max_drawdown": None if max_drawdown is None else canonical_decimal_text(max_drawdown),
            "days": days,
        }

    def period_summary(self, start: date, end: date) -> dict[str, Any]:
        if end < start:
            raise InvalidTradingRequestError("start 必须早于或等于 end")
        account = self._account()
        executions = self.store.list_executions(account["account_id"])
        cash_flows = self.store.list_cash_flows(account["account_id"])
        nav = self.valuation.nav_points(account, executions, cash_flows)
        max_drawdown = window_max_drawdown(nav, start, end)
        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "max_drawdown": None if max_drawdown is None else canonical_decimal_text(max_drawdown),
            "return_curve": period_return_curve(nav, start, end),
        }

    def bs_summary(self, start: date, end: date) -> dict[str, Any]:
        if end < start:
            raise InvalidTradingRequestError("start 必须早于或等于 end")
        account = self._account()
        executions = self._named_executions(account["account_id"])
        ledger = replay_rows(
            account["initial_capital"],
            executions,
            self.store.list_cash_flows(account["account_id"]),
        )
        names: dict[str, str] = {}
        for row in executions:
            symbol = str(row["symbol"])
            name = row.get("name")
            if symbol not in names and name:
                names[symbol] = str(name)
        trading_days = self.valuation._calendar_dates(start, end) or None
        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "symbols": symbol_bs_summary(executions, ledger, names, start, end, trading_days),
        }

    def bs_chart(self, *, symbol: str, timeframe: str, start: date, end: date) -> dict[str, Any]:
        if end < start:
            raise InvalidTradingRequestError("start 必须早于或等于 end")
        account = self._account()
        return build_bs_chart(
            symbol=symbol,
            timeframe=timeframe,
            period_start=start,
            period_end=end,
            executions=self._named_executions(account["account_id"]),
            provider=self._chart_provider(),
            store=self.store,
            account_id=account["account_id"],
        )

    def list_chart_mark_types(self) -> list[dict[str, Any]]:
        account = self._account()
        return self.store.ensure_preset_mark_types(account["account_id"])

    def create_chart_mark_type(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        account = self._account()
        self.store.ensure_preset_mark_types(account["account_id"])
        try:
            return self.store.create_chart_mark_type({"account_id": account["account_id"], **payload})
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def update_chart_mark_type(self, type_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        self._account()
        try:
            return self.store.update_chart_mark_type(type_id, payload)
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def delete_chart_mark_type(self, type_id: str) -> None:
        self._account()
        try:
            self.store.delete_chart_mark_type(type_id)
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def list_chart_marks(self, *, symbol: str, start: date, end: date) -> list[dict[str, Any]]:
        account = self._account()
        if end < start:
            raise InvalidTradingRequestError("start 不能晚于 end")
        return [
            row
            for row in self.store.list_chart_marks(account["account_id"])
            if row["symbol"] == symbol and self._in_range(row["occurred_at"], None, start, end)
        ]

    def create_chart_mark(
        self,
        payload: Mapping[str, Any],
        *,
        start: date | None = None,
        end: date | None = None,
    ) -> dict[str, Any]:
        account = self._account()
        self.store.ensure_preset_mark_types(account["account_id"])
        comment = payload.get("comment") or ""
        if not isinstance(comment, str):
            raise InvalidTradingRequestError("comment 必须是字符串")
        if len(comment) > 1000:
            raise InvalidTradingRequestError("comment 不能超过 1000 字")
        occurred = datetime.fromisoformat(str(payload["occurred_at"]))
        occurred_on = _shanghai_date(occurred)
        period_start = start or occurred_on
        period_end = end or occurred_on
        if period_end < period_start:
            raise InvalidTradingRequestError("start 不能晚于 end")
        chart = build_bs_chart(
            symbol=str(payload["symbol"]),
            timeframe=str(payload["timeframe"]),
            period_start=period_start,
            period_end=period_end,
            executions=self.store.list_executions(account["account_id"]),
            provider=self._chart_provider(),
            store=self.store,
            account_id=account["account_id"],
        )
        try:
            assert_bar_exists(chart["bars"], occurred)
        except BarNotFoundError as exc:
            raise InvalidTradingRequestError(str(exc), code=exc.code) from exc
        try:
            return self.store.create_chart_mark(
                {
                    "account_id": account["account_id"],
                    "symbol": payload["symbol"],
                    "occurred_at": payload["occurred_at"],
                    "type_id": payload["type_id"],
                    "comment": comment,
                }
            )
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def update_chart_mark(
        self, mark_id: str, payload: Mapping[str, Any], revision: int
    ) -> dict[str, Any]:
        self._account()
        comment = payload.get("comment")
        if comment is not None:
            if not isinstance(comment, str):
                raise InvalidTradingRequestError("comment 必须是字符串")
            if len(comment) > 1000:
                raise InvalidTradingRequestError("comment 不能超过 1000 字")
        try:
            return self.store.update_chart_mark(mark_id, payload, expected_revision=revision)
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def delete_chart_mark(self, mark_id: str, revision: int) -> None:
        self._account()
        try:
            self.store.delete_chart_mark(mark_id, expected_revision=revision)
        except TradingStoreError as exc:
            raise _from_store_error(exc) from exc

    def get_daily_review(self, trade_date: date) -> dict[str, Any]:
        account = self._account()
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT review.*, meta.daily_review_revision FROM daily_reviews AS review
                JOIN trading_meta AS meta ON meta.account_id = review.account_id
                WHERE review.account_id = %s AND review.trade_date = %s AND review.is_deleted = 0
                """,
                (account["account_id"], trade_date.isoformat()),
            ).fetchone()
        if row is None:
            raise TradingNotFoundError("每日收盘复盘不存在")
        return {
            "daily_review_id": row["daily_review_id"],
            "trade_date": row["trade_date"],
            **json.loads(row["payload"]),
            "revision": row["revision"],
            "daily_review_revision": row["daily_review_revision"],
        }

    def _reviews_in_range(self, account_id: str, start: date, end: date) -> dict[date, str]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT trade_date, payload FROM daily_reviews
                WHERE account_id = %s AND is_deleted = 0 AND trade_date BETWEEN %s AND %s
                """,
                (account_id, start.isoformat(), end.isoformat()),
            ).fetchall()
        result: dict[date, str] = {}
        for row in rows:
            payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
            status = payload.get("status")
            if status in {"draft", "completed"}:
                result[_shanghai_date(row["trade_date"])] = status
        return result

    def _account(self) -> dict[str, Any]:
        account = self.store.get_account()
        if account is None:
            raise TradingNotFoundError("交易账户不存在")
        return account

    def _chart_provider(self) -> _ChartMarketProvider:
        return _ChartMarketProvider(self.valuation.market_provider)

    def _named_executions(self, account_id: str) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.store.list_executions(account_id)]
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

    def _account_summary(self, account: dict[str, Any]) -> dict[str, Any]:
        return self.valuation.account_summary(
            account,
            self.store.list_executions(account["account_id"]),
            self.store.list_cash_flows(account["account_id"]),
        )

    def refresh_market_prices(self) -> int:
        account = self._account()
        result = self._replay(account)
        account_id = account["account_id"]
        valuation_dates = {self.valuation._now().date()}
        symbols = set(result.positions)
        with self.database.read() as connection:
            cached_rows = connection.execute(
                "SELECT symbol, valuation_date FROM trading_market_prices WHERE account_id = %s",
                (account_id,),
            ).fetchall()
            snapshot_ranges = connection.execute(
                """
                SELECT period_start, period_end
                FROM trading_review_snapshots
                WHERE account_id = %s
                """,
                (account_id,),
            ).fetchall()
        for row in cached_rows:
            symbols.add(str(row["symbol"]))
            valuation_dates.add(date.fromisoformat(str(row["valuation_date"])[:10]))
        for row in snapshot_ranges:
            start_date = date.fromisoformat(str(row["period_start"])[:10])
            end_date = date.fromisoformat(str(row["period_end"])[:10])
            valuation_dates.update(self.valuation._calendar_dates(start_date, end_date))
        return self.valuation.refresh_market_prices(
            account_id,
            sorted(symbols),
            sorted(valuation_dates),
        )

    def _replay(
        self,
        account: Mapping[str, Any],
        *,
        replacement: LedgerEvent | None = None,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ):
        return self._replay_events(
            account,
            self._ledger_events(account["account_id"]),
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _replay_events(
        self,
        account: Mapping[str, Any],
        events: list[LedgerEvent],
        *,
        replacement: LedgerEvent | None = None,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ):
        filtered = [
            event for event in events
            if event.event_id not in {replace_execution, replace_cash_flow}
        ]
        if replacement is not None:
            filtered.append(replacement)
        try:
            return replay_ledger(Decimal(account["initial_capital"]), filtered)
        except (InsufficientCashError, InsufficientPositionError, TradingReducerError) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def _validate_ledger(self, account: Mapping[str, Any], replacement: LedgerEvent | None,
                         *, replace_execution: str | None = None, replace_cash_flow: str | None = None) -> None:
        self._replay(
            account,
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _validate_ledger_in(
        self,
        connection: psycopg.Connection,
        account: Mapping[str, Any],
        replacement: LedgerEvent | None,
        *,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ) -> None:
        self._replay_events(
            account,
            self._ledger_events_in(connection, account["account_id"]),
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _ledger_events(self, account_id: str) -> list[LedgerEvent]:
        events = []
        for row in self.store.list_cash_flows(account_id):
            events.append(self._cash_flow_event(row, event_id=row["cash_flow_id"], created_at=row["created_at"]))
        for row in self.store.list_executions(account_id):
            events.append(self._execution_event(row, event_id=row["execution_id"], created_at=row["created_at"]))
        return events

    def _ledger_events_in(self, connection: psycopg.Connection, account_id: str) -> list[LedgerEvent]:
        events = []
        for row in connection.execute(
            "SELECT * FROM cash_flows WHERE account_id = %s AND is_deleted = 0", (account_id,)
        ).fetchall():
            events.append(self._cash_flow_event(row, event_id=row["cash_flow_id"], created_at=row["created_at"]))
        for row in connection.execute(
            "SELECT * FROM trade_executions WHERE account_id = %s AND is_deleted = 0", (account_id,)
        ).fetchall():
            events.append(self._execution_event(row, event_id=row["execution_id"], created_at=row["created_at"]))
        return events

    @staticmethod
    def _execution_event(request: Mapping[str, Any], *, event_id: str | None = None,
                         created_at: str | None = None) -> LedgerEvent:
        return LedgerEvent(
            event_id=event_id or str(uuid.uuid4()),
            occurred_at=datetime.fromisoformat(str(request["occurred_at"])),
            created_at=datetime.fromisoformat(created_at) if created_at else datetime.now(UTC),
            kind=request["side"],
            symbol=str(request["symbol"]),
            amount=Decimal(str(request["price"])),
            quantity=int(request["quantity"]),
            fee=Decimal(str(request["fee"])),
            primary_reason=str(request["primary_reason"]),
        )

    @staticmethod
    def _cash_flow_event(request: Mapping[str, Any], *, event_id: str | None = None,
                         created_at: str | None = None) -> LedgerEvent:
        return LedgerEvent(
            event_id=event_id or str(uuid.uuid4()),
            occurred_at=datetime.fromisoformat(str(request["occurred_at"])),
            created_at=datetime.fromisoformat(created_at) if created_at else datetime.now(UTC),
            kind=request["kind"],
            symbol=None,
            amount=Decimal(str(request["amount"])),
        )

    @staticmethod
    def _find_by_key(rows: list[dict[str, Any]], request: Mapping[str, Any]) -> dict[str, Any] | None:
        return next((row for row in rows if row["client_idempotency_key"] == request["client_idempotency_key"]), None)

    @staticmethod
    def _find_by_id(rows: list[dict[str, Any]], field: str, value: str) -> dict[str, Any] | None:
        return next((row for row in rows if row[field] == value), None)

    @staticmethod
    def _require_current(row: dict[str, Any] | None, revision: int, label: str) -> None:
        if row is None:
            raise TradingNotFoundError(f"{label}不存在")
        if row["is_deleted"] or row["revision"] != revision:
            raise TradingConflictError(f"{label} revision 已过期", code="REVISION_CONFLICT")

    @staticmethod
    def _details_digest(value: Mapping[str, Any]) -> str:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()

    @classmethod
    def _execution_request_digest(cls, request: Mapping[str, Any], details: Mapping[str, Any]) -> str:
        return cls._details_digest(
            {
                "account_id": request["account_id"],
                "client_idempotency_key": request["client_idempotency_key"],
                "symbol": request["symbol"],
                "side": request["side"],
                "price": canonical_decimal_text(request["price"]),
                "quantity": request["quantity"],
                "fee": canonical_decimal_text(request["fee"]),
                "primary_reason": request["primary_reason"],
                "occurred_at": cls._normalized_time(request["occurred_at"]),
                **details,
            }
        )

    @classmethod
    def _cash_flow_request_digest(cls, request: Mapping[str, Any], note: str) -> str:
        return cls._details_digest(
            {
                "account_id": request["account_id"],
                "client_idempotency_key": request["client_idempotency_key"],
                "kind": request["kind"],
                "amount": canonical_decimal_text(request["amount"]),
                "occurred_at": cls._normalized_time(request["occurred_at"]),
                "note": note,
            }
        )

    @staticmethod
    def _normalized_time(value: Any) -> str:
        return datetime.fromisoformat(str(value)).astimezone(ZoneInfo("Asia/Shanghai")).isoformat()

    def _execution_response(self, row: Mapping[str, Any]) -> dict[str, Any]:
        with self.database.read() as connection:
            details = connection.execute(
                "SELECT name, tags, note FROM trading_execution_details WHERE execution_id = %s", (row["execution_id"],)
            ).fetchone()
        return {
            "execution_id": row["execution_id"], "symbol": row["symbol"],
            "name": details["name"] if details else "", "executed_at": row["occurred_at"],
            "side": row["side"], "price": row["price"], "quantity": row["quantity"], "fee": row["fee"],
            "primary_reason": row["primary_reason"],
            "tags": json.loads(details["tags"]) if details else [], "note": details["note"] if details else "",
            "client_idempotency_key": row["client_idempotency_key"], "revision": row["revision"],
            "ledger_revision": row["ledger_revision"],
        }

    def _cash_flow_response(self, row: Mapping[str, Any]) -> dict[str, Any]:
        with self.database.read() as connection:
            details = connection.execute(
                "SELECT note FROM trading_cash_flow_details WHERE cash_flow_id = %s", (row["cash_flow_id"],)
            ).fetchone()
        return {
            "cash_flow_id": row["cash_flow_id"], "occurred_at": row["occurred_at"], "kind": row["kind"],
            "amount": row["amount"], "note": details["note"] if details else "",
            "client_idempotency_key": row["client_idempotency_key"], "revision": row["revision"],
            "ledger_revision": row["ledger_revision"],
        }

    @staticmethod
    def _validate_range(on: date | None, start: date | None, end: date | None) -> None:
        if on is not None and (start is not None or end is not None):
            raise InvalidTradingRequestError("date 不能与 start/end 同时使用")
        if on is None and (start is None or end is None):
            raise InvalidTradingRequestError("必须提供 date 或成对的 start/end")
        if start is not None and end is not None and start > end:
            raise InvalidTradingRequestError("start 不能晚于 end")

    @staticmethod
    def _in_range(value: str, on: date | None, start: date | None, end: date | None) -> bool:
        occurred_on = date.fromisoformat(value[:10])
        return occurred_on == on if on else start <= occurred_on <= end


def _shanghai_date(value: Any) -> date:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            return value.date()
        return value.astimezone(ZoneInfo("Asia/Shanghai")).date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def error_status(error: TradingServiceError) -> int:
    return error.status_code


def error_code(error: TradingServiceError) -> str:
    return getattr(error, "code", "TRADING_SERVICE_ERROR")
