from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from statistics import median
from typing import Any, Literal
from zoneinfo import ZoneInfo

from .contracts import LedgerEvent
from .reducer import ClosedCycle, canonical_decimal_text, money_text, replay_ledger
from .store import outdate_market_snapshots_for_dependencies

SHANGHAI = ZoneInfo("Asia/Shanghai")
UnavailableReason = Literal[
    "no_sample",
    "no_winning_cycle",
    "no_losing_cycle",
    "zero_denominator",
    "zero_equity_baseline",
]
ComparisonUnavailableReason = Literal["partial_period", "no_previous_period"]


@dataclass(frozen=True, slots=True)
class NavPoint:
    date: date
    equity: Decimal
    external_flow: Decimal
    daily_return: Decimal | None
    nav: Decimal | None
    drawdown_rate: Decimal | None
    unavailable_reason: UnavailableReason | None = None
    previous_equity: Decimal | None = None

    @property
    def valuation_date(self) -> date:
        return self.date

    @property
    def return_rate(self) -> Decimal | None:
        return self.daily_return

    @property
    def flow(self) -> Decimal:
        return self.external_flow


@dataclass(frozen=True, slots=True)
class NullableDecimalMetric:
    value: Decimal | None
    unavailable_reason: UnavailableReason | None

    def as_dict(self) -> dict[str, str | None]:
        return nullable_metric(self.value, self.unavailable_reason)


@dataclass(frozen=True, slots=True)
class LedgerMetrics:
    result: Any
    executions: tuple[Mapping[str, Any], ...]
    cash_flows: tuple[Mapping[str, Any], ...]


def _decimal(value: Any, *, field: str = "value") -> Decimal:
    if isinstance(value, bool):
        raise TypeError(f"{field} 必须是十进制值")
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field} 不是有效十进制值") from exc
    if not result.is_finite():
        raise ValueError(f"{field} 必须是有限十进制值")
    return result


def _business_date(value: Any) -> date:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            return value.date()
        return value.astimezone(SHANGHAI).date()
    if isinstance(value, date):
        return value
    text = str(value)
    if len(text) == 8 and text.isdigit():
        return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:]}")
    return date.fromisoformat(text[:10])


def _date_from_valuation(value: Mapping[str, Any]) -> date:
    source = value.get("date", value.get("valuation_date"))
    if source is None:
        raise ValueError("估值点必须包含 date")
    return _business_date(source)


def build_nav(
    *,
    base_equity: Decimal | int | str,
    valuations: Iterable[Mapping[str, Any] | NavPoint],
    base_nav: Decimal | int | str = Decimal(1),
) -> list[NavPoint]:
    previous_equity = _decimal(base_equity, field="base_equity")
    current_nav = _decimal(base_nav, field="base_nav")
    result: list[NavPoint] = []
    peak = current_nav
    for item in valuations:
        if isinstance(item, NavPoint):
            valuation_date = item.date
            equity = item.equity
            external_flow = item.external_flow
        else:
            valuation_date = _date_from_valuation(item)
            equity = _decimal(item.get("equity"), field="equity")
            external_flow = _decimal(item.get("external_flow", item.get("flow", "0")), field="external_flow")
        denominator = previous_equity + external_flow
        daily_return: Decimal | None
        nav: Decimal | None
        drawdown_rate: Decimal | None
        reason: UnavailableReason | None = None
        if denominator > 0:
            daily_return = equity / denominator - Decimal(1)
            nav = current_nav * (Decimal(1) + daily_return)
            peak = max(peak, nav)
            drawdown_rate = Decimal(1) - nav / peak
        elif denominator == 0 and equity == 0:
            daily_return = Decimal(0)
            nav = current_nav
            drawdown_rate = Decimal(1) - nav / peak if peak else Decimal(0)
        elif denominator == 0:
            daily_return = None
            nav = None
            drawdown_rate = None
            reason = "zero_equity_baseline"
        else:
            daily_return = None
            nav = None
            drawdown_rate = None
            reason = "zero_equity_baseline"
        point = NavPoint(
            date=valuation_date,
            equity=equity,
            external_flow=external_flow,
            daily_return=daily_return,
            nav=nav,
            drawdown_rate=drawdown_rate,
            unavailable_reason=reason,
            previous_equity=previous_equity,
        )
        result.append(point)
        previous_equity = equity
        if nav is not None:
            current_nav = nav
    return result


def period_max_drawdown(points: Iterable[NavPoint | Mapping[str, Any]]) -> Decimal | None:
    peak = Decimal(1)
    maximum = Decimal(0)
    found = False
    for point in points:
        nav = point.nav if isinstance(point, NavPoint) else point.get("nav")
        if nav is None:
            continue
        nav = _decimal(nav, field="nav")
        found = True
        peak = max(peak, nav)
        maximum = max(maximum, Decimal(1) - nav / peak)
    return maximum if found else None


def nullable_metric(
    value: Decimal | int | str | None,
    reason: UnavailableReason | None,
) -> dict[str, str | None]:
    if (value is None) == (reason is None):
        raise ValueError("value and reason must be exclusive")
    return {
        "value": None if value is None else canonical_decimal_text(_decimal(value)),
        "unavailable_reason": reason,
    }


def _unavailable(reason: UnavailableReason) -> dict[str, str | None]:
    return nullable_metric(None, reason)


def _available(value: Decimal | int | str) -> dict[str, str | None]:
    return nullable_metric(_decimal(value), None)


def holding_trade_days(
    started_at: date | datetime,
    ended_at: date | datetime,
    trading_days: Iterable[date] | None = None,
) -> int:
    start, end = _business_date(started_at), _business_date(ended_at)
    if end < start:
        return 0
    if trading_days is None:
        return sum(1 for offset in range((end - start).days + 1) if (start + timedelta(days=offset)).weekday() < 5)
    open_days = {_business_date(item) for item in trading_days}
    return sum(1 for offset in range((end - start).days + 1) if start + timedelta(days=offset) in open_days)


def _event_from_execution(row: Mapping[str, Any]) -> LedgerEvent:
    return LedgerEvent(
        event_id=str(row.get("execution_id", row.get("event_id", ""))),
        occurred_at=_parse_datetime(row.get("occurred_at", row.get("executed_at"))),
        created_at=_parse_datetime(row.get("created_at", row.get("occurred_at", row.get("executed_at")))),
        kind=str(row["side"]),
        symbol=str(row["symbol"]),
        amount=_decimal(row.get("price"), field="price"),
        quantity=int(row["quantity"]),
        fee=_decimal(row.get("fee", "0"), field="fee"),
        primary_reason=str(row.get("primary_reason")) if row.get("primary_reason") is not None else None,
    )


def _event_from_cash_flow(row: Mapping[str, Any]) -> LedgerEvent:
    return LedgerEvent(
        event_id=str(row.get("cash_flow_id", row.get("event_id", ""))),
        occurred_at=_parse_datetime(row["occurred_at"]),
        created_at=_parse_datetime(row.get("created_at", row["occurred_at"])),
        kind=str(row["kind"]),
        symbol=None,
        amount=_decimal(row["amount"], field="amount"),
    )


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        parsed = parsed.replace(tzinfo=SHANGHAI)
    return parsed.astimezone(SHANGHAI)


def replay_rows(
    initial_capital: Decimal | int | str,
    executions: Sequence[Mapping[str, Any]],
    cash_flows: Sequence[Mapping[str, Any]],
) -> LedgerMetrics:
    events = [_event_from_cash_flow(row) for row in cash_flows]
    events.extend(_event_from_execution(row) for row in executions)
    return LedgerMetrics(
        result=replay_ledger(_decimal(initial_capital, field="initial_capital"), events),
        executions=tuple(executions),
        cash_flows=tuple(cash_flows),
    )


def _cycle_holding_days(cycle: ClosedCycle, trading_days: Iterable[date] | None) -> int:
    if cycle.ended_at is None:
        return 0
    return holding_trade_days(cycle.started_at, cycle.ended_at, trading_days)


def _review_discipline(
    review_by_date: Mapping[date, Mapping[str, Any]],
    ended_at: datetime | None,
) -> bool | None:
    if ended_at is None:
        return None
    review = review_by_date.get(_business_date(ended_at))
    if not review or review.get("status") != "completed":
        return None
    value = review.get("discipline_followed")
    return value if isinstance(value, bool) else None


def _cycle_case(
    cycle: ClosedCycle,
    *,
    trading_days: Iterable[date] | None,
    review_by_date: Mapping[date, Mapping[str, Any]],
    names: Mapping[str, str],
) -> dict[str, Any]:
    holding_days = _cycle_holding_days(cycle, trading_days)
    return {
        "cycle_id": cycle.end_event_id or cycle.start_event_id,
        "symbol": cycle.symbol,
        "name": names.get(cycle.symbol, cycle.symbol),
        "started_at": _parse_datetime(cycle.started_at).isoformat(),
        "ended_at": _parse_datetime(cycle.ended_at).isoformat() if cycle.ended_at else None,
        "net_pnl": canonical_decimal_text(cycle.net_pnl),
        "cycle_return_rate": canonical_decimal_text(cycle.cycle_return_rate),
        "holding_days": holding_days,
        "buy_reason_code": cycle.primary_buy_reason,
        "sell_reason_code": cycle.primary_sell_reason,
        "discipline_followed": _review_discipline(review_by_date, cycle.ended_at),
    }


def _reason_metric(
    cycles: Sequence[tuple[ClosedCycle, int]],
    *,
    reason: str,
) -> dict[str, Any]:
    selected = [cycle for cycle, _ in cycles]
    count = len(selected)
    wins = [cycle for cycle in selected if cycle.net_pnl > 0]
    losses = [cycle for cycle in selected if cycle.net_pnl < 0]
    returns = [cycle.cycle_return_rate for cycle in selected]
    holds = [days for _, days in cycles]
    return {
        "sample_count": count,
        "conclusion_allowed": count >= 5,
        "win_rate": _unavailable("no_sample") if not selected else _available(Decimal(len(wins)) / count),
        "net_pnl": canonical_decimal_text(sum((cycle.net_pnl for cycle in selected), Decimal(0))),
        "average_cycle_return_rate": _unavailable("no_sample") if not selected else _available(sum(returns, Decimal(0)) / count),
        "median_holding_days": _unavailable("no_sample") if not selected else _available(Decimal(str(median(holds)))),
        "max_cycle_profit": _unavailable("no_winning_cycle") if not wins else _available(max(cycle.net_pnl for cycle in wins)),
        "max_cycle_loss": _unavailable("no_losing_cycle") if not losses else _available(min(cycle.net_pnl for cycle in losses)),
        "reason_code": reason,
    }


def _period_metric(
    cycles: Sequence[ClosedCycle],
    *,
    trading_days: Iterable[date] | None,
    reviews: Sequence[Mapping[str, Any]],
    valuation_points: Sequence[NavPoint] | None,
    period_start: date | None,
    period_end: date | None,
) -> dict[str, Any]:
    closed = [cycle for cycle in cycles if cycle.closed]
    if period_start is not None and period_end is not None:
        closed = [
            cycle for cycle in closed
            if period_start <= _business_date(cycle.ended_at) <= period_end
        ]
    holding = [_cycle_holding_days(cycle, trading_days) for cycle in closed]
    wins = [cycle.net_pnl for cycle in closed if cycle.net_pnl > 0]
    losses = [cycle.net_pnl for cycle in closed if cycle.net_pnl < 0]
    total_wins = sum(wins, Decimal(0))
    total_losses = sum((abs(value) for value in losses), Decimal(0))
    scoped_reviews = [
        review for review in reviews
        if period_start is None
        or period_start <= _business_date(review["trade_date"]) <= (period_end or period_start)
    ]
    complete_reviews = [review for review in scoped_reviews if review.get("status") == "completed" and isinstance(review.get("discipline_followed"), bool)]
    if complete_reviews:
        discipline = _available(Decimal(sum(bool(item["discipline_followed"]) for item in complete_reviews)) / len(complete_reviews))
    else:
        discipline = _unavailable("no_sample")
    if not closed:
        win_rate = _unavailable("no_sample")
        median_holding = _unavailable("no_sample")
        efficiency = _unavailable("no_sample")
    else:
        win_rate = _available(Decimal(len(wins)) / len(closed))
        median_holding = _available(Decimal(str(median(holding))))
        efficiency_values = [cycle.cycle_return_rate / days for cycle, days in zip(closed, holding) if days > 0]
        efficiency = _unavailable("zero_denominator") if not efficiency_values else _available(Decimal(str(median(efficiency_values))))
    if not wins:
        average_ratio = _unavailable("no_winning_cycle")
    elif not losses:
        average_ratio = _unavailable("no_losing_cycle")
    else:
        average_ratio = _available((sum(wins, Decimal(0)) / len(wins)) / (total_losses / len(losses)))
    if not wins:
        profit_factor = _unavailable("no_winning_cycle")
    elif not losses:
        profit_factor = _unavailable("no_losing_cycle")
    elif total_losses == 0:
        profit_factor = _unavailable("zero_denominator")
    else:
        profit_factor = _available(total_wins / total_losses)
    adjusted_return = _unavailable("no_sample")
    drawdown = _unavailable("no_sample")
    if valuation_points:
        scoped_points = list(valuation_points)
        if period_start is not None and period_end is not None:
            scoped_points = [point for point in scoped_points if period_start <= point.date <= period_end]
        available = [point for point in scoped_points if point.nav is not None]
        if period_start is not None and period_end is not None:
            available = [point for point in available if period_start <= point.date <= period_end]
        if available:
            start_nav = Decimal(1)
            prior = [point for point in valuation_points if point.date < available[0].date and point.nav is not None]
            if prior:
                start_nav = prior[-1].nav or Decimal(1)
            adjusted_return = _available((available[-1].nav or start_nav) / start_nav - Decimal(1))
            normalized = [
                NavPoint(
                    date=point.date,
                    equity=point.equity,
                    external_flow=point.external_flow,
                    daily_return=point.daily_return,
                    nav=(point.nav or start_nav) / start_nav,
                    drawdown_rate=None,
                    unavailable_reason=point.unavailable_reason,
                    previous_equity=point.previous_equity,
                )
                for point in available
            ]
            drawdown_value = period_max_drawdown(normalized)
            drawdown = _unavailable("zero_equity_baseline") if drawdown_value is None else _available(drawdown_value)
        elif scoped_points:
            unavailable_reasons = {point.unavailable_reason for point in scoped_points if point.unavailable_reason}
            reason = "zero_equity_baseline" if "zero_equity_baseline" in unavailable_reasons else "no_sample"
            adjusted_return = _unavailable(reason)
            drawdown = _unavailable(reason)
    return {
        "period_realized_pnl": "0",
        "closed_cycle_pnl": canonical_decimal_text(sum((cycle.net_pnl for cycle in closed), Decimal(0))),
        "account_adjusted_return_rate": adjusted_return,
        "period_max_drawdown_rate": drawdown,
        "win_rate": win_rate,
        "average_win_loss_ratio": average_ratio,
        "profit_factor": profit_factor,
        "median_holding_days": median_holding,
        "median_capital_efficiency": efficiency,
        "discipline_adherence_rate": discipline,
        "closed_cycle_count": len(closed),
        "overall_conclusion_allowed": len(closed) >= 5,
    }


def calculate_review_metrics(
    *,
    initial_capital: Decimal | int | str,
    executions: Sequence[Mapping[str, Any]],
    cash_flows: Sequence[Mapping[str, Any]] = (),
    daily_reviews: Sequence[Mapping[str, Any]] = (),
    trading_days: Iterable[date] | None = None,
    valuation_points: Sequence[NavPoint] | None = None,
    period_start: date | None = None,
    period_end: date | None = None,
    names: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    trading_days_tuple = None if trading_days is None else tuple(_business_date(item) for item in trading_days)
    ledger = replay_rows(initial_capital, executions, cash_flows)
    start, end = period_start, period_end
    period_sells = [
        row for row in executions
        if row.get("side") == "sell" and (start is None or start <= _business_date(row.get("occurred_at", row.get("executed_at"))) <= (end or start))
    ]
    realized = sum((ledger.result.realized_by_event_id.get(str(row.get("execution_id", row.get("event_id", ""))), Decimal(0)) for row in period_sells), Decimal(0))
    cycles = ledger.result.cycles
    period = _period_metric(
        cycles,
        trading_days=trading_days_tuple,
        reviews=daily_reviews,
        valuation_points=valuation_points,
        period_start=start,
        period_end=end,
    )
    period["period_realized_pnl"] = canonical_decimal_text(realized)
    cycle_cases = [
        _cycle_case(cycle, trading_days=trading_days_tuple, review_by_date={_business_date(item["trade_date"]): item for item in daily_reviews}, names=names or {})
        for cycle in cycles
        if cycle.closed and (start is None or start <= _business_date(cycle.ended_at) <= (end or start))
    ]
    execution_reason_facts: list[dict[str, Any]] = []
    fact_groups: dict[tuple[str, str], dict[str, Any]] = {}
    for row in executions:
        occurred = _business_date(row.get("occurred_at", row.get("executed_at")))
        if start is not None and not (start <= occurred <= (end or start)):
            continue
        key = (str(row["side"]), str(row["primary_reason"]))
        fact = fact_groups.setdefault(key, {"side": key[0], "reason_code": key[1], "execution_count": 0, "quantity": 0, "gross_amount": Decimal(0)})
        fact["execution_count"] += 1
        fact["quantity"] += int(row["quantity"])
        fact["gross_amount"] += _decimal(row["price"]) * int(row["quantity"])
    for fact in fact_groups.values():
        execution_reason_facts.append({**fact, "gross_amount": canonical_decimal_text(fact["gross_amount"])})
    reason_performance: list[dict[str, Any]] = []
    for side, attr in (("buy", "primary_buy_reason"), ("sell", "primary_sell_reason")):
        grouped: dict[str, list[tuple[ClosedCycle, int]]] = defaultdict(list)
        for cycle in cycles:
            if not cycle.closed or cycle.primary_buy_reason is None or cycle.primary_sell_reason is None:
                continue
            if start is not None and not (start <= _business_date(cycle.ended_at) <= (end or start)):
                continue
            grouped[getattr(cycle, attr)].append((cycle, _cycle_holding_days(cycle, trading_days_tuple)))
        reason_performance.extend({"side": side, **_reason_metric(items, reason=reason)} for reason, items in grouped.items())
    period["reason_performance"] = reason_performance
    period["execution_reason_facts"] = execution_reason_facts
    period["cycle_cases"] = cycle_cases
    return period


def previous_period_bounds(
    period_kind: Literal["week", "month", "quarter", "year"],
    period_start: date,
    period_end: date,
    trading_days: Iterable[date] | None = None,
) -> tuple[date, date]:
    if period_kind == "week":
        end = period_start - timedelta(days=1)
        start, previous_end = end - timedelta(days=6), end
    elif period_kind == "month":
        first = period_start.replace(day=1)
        previous_end = first - timedelta(days=1)
        start = previous_end.replace(day=1)
    elif period_kind == "quarter":
        quarter_start_month = ((period_start.month - 1) // 3) * 3 + 1
        current_first = period_start.replace(month=quarter_start_month, day=1)
        previous_end = current_first - timedelta(days=1)
        previous_month = ((previous_end.month - 1) // 3) * 3 + 1
        start = previous_end.replace(month=previous_month, day=1)
    else:
        previous_end = period_start.replace(month=1, day=1) - timedelta(days=1)
        start = previous_end.replace(month=1, day=1)
    if trading_days is None:
        return start, previous_end
    available = sorted(
        item for item in {_business_date(value) for value in trading_days}
        if start <= item <= previous_end
    )
    return (available[0], available[-1]) if available else (start, previous_end)


def compare_period_metrics(
    current: Mapping[str, Any],
    previous: Mapping[str, Any] | None,
    *,
    partial_period: bool = False,
) -> dict[str, Any]:
    if partial_period:
        return {"comparison": None, "comparison_unavailable_reason": "partial_period"}
    if previous is None:
        return {"comparison": None, "comparison_unavailable_reason": "no_previous_period"}
    refs = (
        ("account.adjusted_return_rate", "account_adjusted_return_rate"),
        ("account.period_max_drawdown_rate", "period_max_drawdown_rate"),
        ("account.win_rate", "win_rate"),
        ("account.average_win_loss_ratio", "average_win_loss_ratio"),
        ("account.profit_factor", "profit_factor"),
        ("account.median_holding_days", "median_holding_days"),
        ("account.median_capital_efficiency", "median_capital_efficiency"),
        ("discipline.adherence_rate", "discipline_adherence_rate"),
    )
    metrics: list[dict[str, Any]] = []
    for ref, field in refs:
        current_metric = current.get(ref, current.get(field, _unavailable("no_sample")))
        previous_metric = previous.get(ref, previous.get(field, _unavailable("no_sample")))
        current_value = current_metric.get("value")
        previous_value = previous_metric.get("value")
        delta = (
            _available(_decimal(current_value) - _decimal(previous_value))
            if current_value is not None and previous_value is not None
            else _unavailable(current_metric.get("unavailable_reason") or previous_metric.get("unavailable_reason") or "no_sample")
        )
        metrics.append({"metric_ref": ref, "current": current_metric, "previous": previous_metric, "delta": delta})
    return {"comparison": {"metrics": metrics}, "comparison_unavailable_reason": None}


def raw_bar_digest(row: Mapping[str, Any]) -> str:
    payload = {
        "trade_date": _business_date(row["trade_date"]).isoformat(),
        "open": canonical_decimal_text(_decimal(row.get("open"), field="open")),
        "high": canonical_decimal_text(_decimal(row.get("high"), field="high")),
        "low": canonical_decimal_text(_decimal(row.get("low"), field="low")),
        "close": canonical_decimal_text(_decimal(row.get("close"), field="close")),
        "vol": None
        if row.get("vol", row.get("volume")) is None
        else canonical_decimal_text(_decimal(row.get("vol", row.get("volume")), field="vol")),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _raw_bar(row: Mapping[str, Any]) -> dict[str, Any]:
    trade_date = _business_date(row["trade_date"])
    occurred_at = datetime.combine(trade_date, datetime.min.time(), tzinfo=SHANGHAI)
    return {
        "trade_date": trade_date.isoformat(),
        "occurred_at": occurred_at.isoformat(),
        "open": canonical_decimal_text(_decimal(row.get("open"), field="open")),
        "high": canonical_decimal_text(_decimal(row.get("high"), field="high")),
        "low": canonical_decimal_text(_decimal(row.get("low"), field="low")),
        "close": canonical_decimal_text(_decimal(row.get("close"), field="close")),
        "volume": None
        if row.get("vol", row.get("volume")) is None
        else canonical_decimal_text(_decimal(row.get("vol", row.get("volume")), field="vol")),
    }


def build_chart_bundle(
    *,
    symbol: str,
    name: str,
    bars: Sequence[Mapping[str, Any]],
    executions: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    from app.domain.chan_engine import CanonicalBar, ChanEngine

    normalized = [_raw_bar(row) for row in bars if row.get("close") is not None]
    normalized.sort(key=lambda item: item["trade_date"])
    canonical_bars = [
        CanonicalBar(
            symbol=symbol,
            occurred_at=datetime.fromisoformat(item["occurred_at"]),
            known_at=datetime.fromisoformat(item["occurred_at"]),
            stable_through=datetime.fromisoformat(item["occurred_at"]),
            open=item["open"], high=item["high"], low=item["low"], close=item["close"], volume=item["volume"],
            payload_hash=raw_bar_digest(row),
        )
        for item, row in zip(normalized, sorted((row for row in bars if row.get("close") is not None), key=lambda item: _business_date(item["trade_date"])))
    ]
    snapshot = ChanEngine().replay(canonical_bars)
    chan_bars = snapshot.get("bars", [])
    market_snapshot_id = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    stroke_items = []
    for item in snapshot.get("strokes", []):
        start_index, end_index = item["start_index"], item["end_index"]
        stroke_items.append({
            "direction": item["direction"],
            "start_at": _parse_datetime(chan_bars[start_index]["occurred_at"]).isoformat(),
            "end_at": _parse_datetime(chan_bars[end_index]["occurred_at"]).isoformat(),
            "start_price": item["start_price"],
            "end_price": item["end_price"],
            "state": "provisional" if item in snapshot.get("provisional", []) else "confirmed",
        })
    center_items = []
    for item in snapshot.get("centers", []):
        center_items.append({
            "start_at": _parse_datetime(chan_bars[item["start_index"]]["occurred_at"]).isoformat(),
            "end_at": _parse_datetime(chan_bars[item["end_index"]]["occurred_at"]).isoformat(),
            "lower": item["lower"],
            "upper": item["upper"],
        })
    markers = []
    for row in executions:
        if str(row.get("symbol")) != symbol:
            continue
        executed_at = _parse_datetime(row.get("occurred_at", row.get("executed_at")))
        markers.append({
            "execution_id": row.get("execution_id"),
            "trade_date": executed_at.date().isoformat(),
            "executed_at": executed_at.isoformat(),
            "side": row["side"],
            "price": canonical_decimal_text(_decimal(row["price"])),
            "quantity": int(row["quantity"]),
            "fee": canonical_decimal_text(_decimal(row.get("fee", "0"))),
            "primary_reason": row.get("primary_reason"),
        })
    warnings = [] if normalized and len(normalized) == len(bars) else ["missing_close_price"]
    return {
        "symbol": symbol,
        "name": name,
        "adjustment": "none",
        "market_snapshot_id": market_snapshot_id,
        "chan_analysis_id": f"chan-{market_snapshot_id[:24]}",
        "chan_engine_version": "chan-engine.v1",
        "bars": normalized,
        "strokes": stroke_items,
        "centers": center_items,
        "executions": markers,
        "quality": {"warnings": warnings, "status": "degraded" if warnings else "ok"},
    }


def _calendar_dates(
    provider: Any,
    start_date: date,
    end_date: date,
) -> list[date]:
    if start_date > end_date:
        return []
    raw: Any = None
    if provider is not None:
        if hasattr(provider, "trade_cal"):
            raw = provider.trade_cal(start_date=start_date, end_date=end_date)
        elif callable(provider):
            try:
                raw = provider(start_date=start_date, end_date=end_date)
            except TypeError:
                raw = provider(start_date, end_date)
    if raw is None:
        return []
    result: list[date] = []
    for item in raw or []:
        if isinstance(item, (date, datetime, str)):
            result.append(_business_date(item))
            continue
        if not isinstance(item, Mapping):
            continue
        is_open = item.get("is_open", item.get("open", True))
        if is_open not in (1, "1", True, "true", "True"):
            continue
        value = item.get("cal_date", item.get("trade_date", item.get("date")))
        if value is not None:
            result.append(_business_date(value))
    return sorted({item for item in result if start_date <= item <= end_date})


def _provider_daily(
    provider: Any,
    symbol: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    if provider is None:
        from ..providers.tushare import TushareMarketProvider

        provider = TushareMarketProvider()
    method = getattr(provider, "daily", None) or getattr(provider, "get_daily", None)
    if method is None:
        raise ValueError("行情 provider 必须提供 daily")
    try:
        rows = method(symbol, as_of=end_date, start_date=start_date, end_date=end_date)
    except TypeError:
        rows = method(symbol, start_date=start_date, end_date=end_date)
    return [dict(row) for row in (rows or []) if isinstance(row, Mapping)]


def _candidate_price(rows: Sequence[Mapping[str, Any]], valuation_date: date) -> tuple[dict[str, Any] | None, bool]:
    eligible = [row for row in rows if row.get("close") is not None and _business_date(row["trade_date"]) <= valuation_date]
    if not eligible:
        return None, False
    selected = max(eligible, key=lambda row: _business_date(row["trade_date"]))
    return dict(selected), _business_date(selected["trade_date"]) != valuation_date


def _cached_market_rows(database: Any, account_id: str, symbol: str) -> dict[date, dict[str, Any]]:
    with database.read() as connection:
        rows = connection.execute(
            "SELECT * FROM trading_market_prices WHERE account_id = %s AND symbol = %s",
            (account_id, symbol),
        ).fetchall()
    return {_business_date(row["valuation_date"]): dict(row) for row in rows}


def _persist_market_rows(
    database: Any,
    account_id: str,
    selected: Sequence[tuple[str, date, date, Decimal, str]],
) -> int:
    with database.transaction(immediate=True) as connection:
        meta = connection.execute(
            "SELECT market_revision FROM trading_meta WHERE account_id = %s", (account_id,)
        ).fetchone()
        if meta is None:
            raise ValueError("交易账户不存在")
        revision = int(meta["market_revision"])
        changed = False
        changed_dependencies: list[tuple[str, str]] = []
        for symbol, valuation_date, source_date, close, digest in selected:
            existing = connection.execute(
                """
                SELECT source_trade_date, close, bar_digest
                FROM trading_market_prices
                WHERE account_id = %s AND symbol = %s AND valuation_date = %s
                """,
                (account_id, symbol, valuation_date.isoformat()),
            ).fetchone()
            if (
                existing is None
                or existing["source_trade_date"] != source_date.isoformat()
                or _decimal(existing["close"], field="close") != close
                or existing["bar_digest"] != digest
            ):
                changed = True
                changed_dependencies.append((symbol, valuation_date.isoformat()))
        if changed:
            revision += 1
            connection.execute(
                "UPDATE trading_meta SET market_revision = %s WHERE account_id = %s",
                (revision, account_id),
            )
            outdate_market_snapshots_for_dependencies(
                connection,
                account_id,
                changed_dependencies,
                revision,
            )
        for symbol, valuation_date, source_date, close, digest in selected:
            connection.execute(
                """
                INSERT INTO trading_market_prices(
                    account_id, symbol, valuation_date, source_trade_date, close, bar_digest, revision
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(account_id, symbol, valuation_date) DO UPDATE SET
                    source_trade_date = excluded.source_trade_date,
                    close = excluded.close,
                    bar_digest = excluded.bar_digest,
                    revision = excluded.revision
                """,
                (
                    account_id,
                    symbol,
                    valuation_date.isoformat(),
                    source_date.isoformat(),
                    canonical_decimal_text(close),
                    digest,
                    revision,
                ),
            )
    return revision


class AccountValuationService:
    def __init__(
        self,
        database: Any,
        *,
        market_provider: Any | None = None,
        calendar_provider: Any | None = None,
        clock: Any | None = None,
    ) -> None:
        self.database = database
        self.market_provider = market_provider
        self.calendar_provider = calendar_provider
        self._calendar_cache: dict[tuple[date, date], list[date]] = {}
        self.clock = clock or (lambda: datetime.now(SHANGHAI))

    def _now(self) -> datetime:
        value = self.clock()
        if not isinstance(value, datetime):
            raise TypeError("trading_clock 必须返回 datetime")
        if value.tzinfo is None or value.utcoffset() is None:
            value = value.replace(tzinfo=SHANGHAI)
        return value.astimezone(SHANGHAI)

    def _calendar_dates(self, start_date: date, end_date: date) -> list[date]:
        cache_key = (start_date, end_date)
        if cache_key in self._calendar_cache:
            return list(self._calendar_cache[cache_key])
        if self.calendar_provider is None:
            try:
                from ..providers.tushare import TushareMarketProvider

                self.calendar_provider = TushareMarketProvider()
            except (RuntimeError, TypeError, ValueError):
                return []
        try:
            result = _calendar_dates(self.calendar_provider, start_date, end_date)
        except (RuntimeError, TypeError, ValueError):
            return []
        self._calendar_cache[cache_key] = result
        return list(result)

    def _market_prices(
        self,
        account_id: str,
        symbols: Sequence[str],
        valuation_dates: Sequence[date],
        *,
        force_refresh: bool = False,
    ) -> tuple[dict[tuple[str, date], dict[str, Any]], str, list[str]]:
        if not symbols or not valuation_dates:
            return {}, "ok", []
        quality = "ok"
        warnings: list[str] = []
        selected_rows: list[tuple[str, date, date, Decimal, str]] = []
        result: dict[tuple[str, date], dict[str, Any]] = {}
        for symbol in sorted(set(symbols)):
            cached = _cached_market_rows(self.database, account_id, symbol)
            missing = [day for day in valuation_dates if day not in cached]
            rows: list[dict[str, Any]] = []
            if missing or force_refresh:
                try:
                    rows = _provider_daily(self.market_provider, symbol, min(valuation_dates), max(valuation_dates))
                except (RuntimeError, TypeError, ValueError):
                    rows = []
            for valuation_date in valuation_dates:
                cached_row = cached.get(valuation_date)
                candidate, degraded = _candidate_price(rows, valuation_date)
                if candidate is None:
                    cached_candidate = cached_row
                    if cached_candidate is None:
                        prior_cached = [
                            (cached_date, row)
                            for cached_date, row in cached.items()
                            if cached_date <= valuation_date
                        ]
                        if prior_cached:
                            cached_candidate = max(prior_cached, key=lambda item: item[0])[1]
                    if cached_candidate is not None:
                        source_date = _business_date(cached_candidate["source_trade_date"])
                        close = _decimal(cached_candidate["close"], field="close")
                        digest = str(cached_candidate["bar_digest"])
                        selected_rows.append((symbol, valuation_date, source_date, close, digest))
                        result[(symbol, valuation_date)] = {
                            "symbol": symbol,
                            "valuation_date": valuation_date.isoformat(),
                            "source_trade_date": source_date.isoformat(),
                            "close": canonical_decimal_text(close),
                            "bar_digest": digest,
                        }
                        if source_date != valuation_date:
                            quality = "degraded"
                            warnings.append("missing_close_price")
                        continue
                if candidate is None:
                    quality = "unavailable"
                    warnings.append("missing_close_price")
                    continue
                source_date = _business_date(candidate["trade_date"])
                close = _decimal(candidate["close"], field="close")
                digest = raw_bar_digest(candidate)
                if degraded:
                    quality = "degraded" if quality != "unavailable" else quality
                    warnings.append("missing_close_price")
                selected_rows.append((symbol, valuation_date, source_date, close, digest))
                result[(symbol, valuation_date)] = {
                    "symbol": symbol,
                    "valuation_date": valuation_date.isoformat(),
                    "source_trade_date": source_date.isoformat(),
                    "close": canonical_decimal_text(close),
                    "bar_digest": digest,
                }
        if self.market_provider is None and any((symbol, day) not in result for symbol in symbols for day in valuation_dates):
            quality = "unavailable"
        _persist_market_rows(self.database, account_id, selected_rows)
        return result, quality, sorted(set(warnings))

    def refresh_market_prices(
        self,
        account_id: str,
        symbols: Sequence[str],
        valuation_dates: Sequence[date],
    ) -> int:
        self._market_prices(account_id, symbols, valuation_dates, force_refresh=True)
        with self.database.read() as connection:
            row = connection.execute("SELECT market_revision FROM trading_meta WHERE account_id = %s", (account_id,)).fetchone()
        return int(row["market_revision"]) if row else 0

    def account_summary(
        self,
        account: Mapping[str, Any],
        executions: Sequence[Mapping[str, Any]],
        cash_flows: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        now = self._now()
        as_of = now.date()
        activation = _business_date(account["activated_on"])
        events = [_event_from_cash_flow(row) for row in cash_flows]
        events.extend(_event_from_execution(row) for row in executions)
        current_result = replay_ledger(_decimal(account["initial_capital"]), [event for event in events if event.occurred_at.date() <= as_of])
        symbols = sorted(current_result.positions)
        valuation_dates = self._calendar_dates(activation, as_of)
        calendar_available = bool(valuation_dates)
        prices, quality, warnings = self._market_prices(account["account_id"], symbols, valuation_dates)
        valuations: list[dict[str, Any]] = []
        flow_by_day: dict[date, Decimal] = defaultdict(Decimal)
        for row in cash_flows:
            occurred = _business_date(row["occurred_at"])
            amount = _decimal(row["amount"])
            flow_by_day[occurred] += amount if row["kind"] == "deposit" else -amount
        for flow_date, flow in list(flow_by_day.items()):
            target = next((day for day in valuation_dates if day >= flow_date), None)
            if target is not None and target != flow_date:
                flow_by_day[target] += flow
                del flow_by_day[flow_date]
        for valuation_date in valuation_dates:
            included = [event for event in events if event.occurred_at.date() <= valuation_date]
            result = replay_ledger(_decimal(account["initial_capital"]), included)
            market_value = Decimal(0)
            missing = False
            for symbol, position in result.positions.items():
                price_row = prices.get((symbol, valuation_date))
                if price_row is None:
                    missing = True
                    continue
                market_value += Decimal(position.quantity) * _decimal(price_row["close"])
            if missing:
                continue
            valuations.append({
                "date": valuation_date,
                "equity": result.cash + market_value,
                "external_flow": flow_by_day.get(valuation_date, Decimal(0)),
            })
        if valuations and not (quality == "unavailable" and symbols):
            nav_points = build_nav(base_equity=_decimal(account["initial_capital"]), valuations=valuations)
            last = nav_points[-1]
            position_market_value = valuations[-1]["equity"] - replay_ledger(_decimal(account["initial_capital"]), [event for event in events if event.occurred_at.date() <= valuations[-1]["date"]]).cash
            daily_pnl = None if last.previous_equity is None else last.equity - last.previous_equity - last.external_flow
            return {
                "account_id": account["account_id"],
                "name": account["name"],
                "activated_on": account["activated_on"],
                "initial_capital": account["initial_capital"],
                "ledger_revision": account["ledger_revision"],
                "cash": canonical_decimal_text(current_result.cash),
                "position_market_value": None if quality == "unavailable" else money_text(position_market_value),
                "total_equity": None if quality == "unavailable" else money_text(last.equity),
                "valuation_date": last.date.isoformat(),
                "daily_pnl": None if daily_pnl is None else money_text(daily_pnl),
                "since_inception_drawdown": None if period_max_drawdown(nav_points) is None else canonical_decimal_text(period_max_drawdown(nav_points) or Decimal(0)),
                "data_quality": quality,
                "data_quality_warnings": warnings,
            }
        return {
            "account_id": account["account_id"],
            "name": account["name"],
            "activated_on": account["activated_on"],
            "initial_capital": account["initial_capital"],
            "ledger_revision": account["ledger_revision"],
            "cash": canonical_decimal_text(current_result.cash),
            "position_market_value": None if symbols or not calendar_available else "0.00",
            "total_equity": None if symbols or not calendar_available else money_text(current_result.cash),
            "valuation_date": None,
            "daily_pnl": None if symbols or not calendar_available else "0.00",
            "since_inception_drawdown": None,
            "data_quality": "unavailable" if symbols or not calendar_available else "ok",
            "data_quality_warnings": ["missing_close_price"] if symbols else [],
        }


__all__ = [
    "AccountValuationService",
    "ComparisonUnavailableReason",
    "LedgerMetrics",
    "NavPoint",
    "UnavailableReason",
    "build_chart_bundle",
    "build_nav",
    "calculate_review_metrics",
    "compare_period_metrics",
    "holding_trade_days",
    "nullable_metric",
    "period_max_drawdown",
    "previous_period_bounds",
    "raw_bar_digest",
    "replay_rows",
]
