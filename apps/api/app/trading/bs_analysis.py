"""周期复盘个股 BS 摘要与日线/30 分钟时间投影。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import median
from typing import Any

from .metrics import LedgerMetrics, _business_date, _cycle_holding_days, _parse_datetime
from .reducer import canonical_decimal_text, money_text

MINUTE_BAR_WIDTH = timedelta(minutes=30)


def _event_id(row: Mapping[str, Any]) -> str:
    return str(row.get("execution_id", row.get("event_id", "")))


def _metric(value: Decimal | None, reason: str | None) -> dict[str, str | None]:
    return {
        "value": None if value is None else canonical_decimal_text(value),
        "unavailable_reason": reason,
    }


def _bar_at(bar: Mapping[str, Any]) -> datetime:
    return _parse_datetime(bar["occurred_at"])


def _bar_at_text(bar: Mapping[str, Any]) -> str:
    value = bar["occurred_at"]
    if isinstance(value, datetime):
        return _parse_datetime(value).isoformat()
    return str(value)


def _with_bar(row: Mapping[str, Any], bar: Mapping[str, Any]) -> dict[str, Any]:
    return {**dict(row), "bar_occurred_at": _bar_at_text(bar)}


def _sorted_bars(bars: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(bars, key=_bar_at)


def _daily_bar_for(
    occurred: datetime,
    daily_bars: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    day = _business_date(occurred)
    for bar in _sorted_bars(daily_bars):
        if _business_date(_bar_at(bar)) == day:
            return bar
    return None


def _exact_or_last_minute_bar(
    occurred: datetime,
    minute_bars: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    ordered = _sorted_bars(minute_bars)
    for bar in ordered:
        if _bar_at(bar) == occurred:
            return bar
    day = _business_date(occurred)
    same_day = [bar for bar in ordered if _business_date(_bar_at(bar)) == day]
    return same_day[-1] if same_day else None


def _covering_minute_bar(
    occurred: datetime,
    minute_bars: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    ordered = _sorted_bars(minute_bars)
    if not ordered:
        return None
    ends = [_bar_at(bar) for bar in ordered]
    starts = [ends[0] - MINUTE_BAR_WIDTH, *ends[:-1]]
    for index, (start, end) in enumerate(zip(starts, ends)):
        if start < occurred <= end:
            return ordered[index]
    return None


def symbol_bs_summary(
    executions: Sequence[Mapping[str, Any]],
    ledger: LedgerMetrics,
    names: Mapping[str, str],
    period_start: date,
    period_end: date,
    trading_days: Iterable[date] | None,
) -> list[dict[str, Any]]:
    trading_days_tuple = (
        None if trading_days is None else tuple(_business_date(item) for item in trading_days)
    )
    period_rows = [
        row
        for row in executions
        if period_start
        <= _business_date(row.get("occurred_at", row.get("executed_at")))
        <= period_end
    ]
    realized_by_event = ledger.result.realized_by_event_id
    closed_by_symbol: dict[str, list[Any]] = {}
    for cycle in ledger.result.cycles:
        if not cycle.closed or cycle.ended_at is None:
            continue
        if not (period_start <= _business_date(cycle.ended_at) <= period_end):
            continue
        closed_by_symbol.setdefault(cycle.symbol, []).append(cycle)

    summaries: list[dict[str, Any]] = []
    for symbol in sorted({str(row["symbol"]) for row in period_rows if row.get("symbol")}):
        realized = sum(
            (
                realized_by_event.get(_event_id(row), Decimal(0))
                for row in period_rows
                if row.get("side") == "sell" and str(row["symbol"]) == symbol
            ),
            Decimal(0),
        )
        closed = closed_by_symbol.get(symbol, [])
        if closed:
            wins = sum(1 for cycle in closed if cycle.net_pnl > 0)
            win_rate = _metric(Decimal(wins) / len(closed), None)
            holding = [_cycle_holding_days(cycle, trading_days_tuple) for cycle in closed]
            median_holding = _metric(Decimal(str(median(holding))), None)
        else:
            win_rate = _metric(None, "no_closed_cycle")
            median_holding = _metric(None, "no_closed_cycle")
        summaries.append(
            {
                "symbol": symbol,
                "name": names.get(symbol, symbol),
                "realized_pnl": money_text(realized),
                "closed_cycle_count": len(closed),
                "median_holding_days": median_holding,
                "win_rate": win_rate,
            }
        )
    return summaries


def project_marks(
    marks: Sequence[Mapping[str, Any]],
    daily_bars: Sequence[Mapping[str, Any]],
    minute_bars: Sequence[Mapping[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    daily_bars = _sorted_bars(daily_bars)
    minute_bars = _sorted_bars(minute_bars)
    daily: list[dict[str, Any]] = []
    minute: list[dict[str, Any]] = []
    for mark in marks:
        occurred = _parse_datetime(mark["occurred_at"])
        daily_bar = _daily_bar_for(occurred, daily_bars)
        if daily_bar is not None:
            daily.append(_with_bar(mark, daily_bar))
        minute_bar = _exact_or_last_minute_bar(occurred, minute_bars)
        if minute_bar is not None:
            minute.append(_with_bar(mark, minute_bar))
    return {"daily": daily, "minute": minute}


def project_executions(
    executions: Sequence[Mapping[str, Any]],
    daily_bars: Sequence[Mapping[str, Any]],
    minute_bars: Sequence[Mapping[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    daily_bars = _sorted_bars(daily_bars)
    minute_bars = _sorted_bars(minute_bars)
    daily: list[dict[str, Any]] = []
    minute: list[dict[str, Any]] = []
    for row in executions:
        occurred = _parse_datetime(row.get("occurred_at", row.get("executed_at")))
        daily_bar = _daily_bar_for(occurred, daily_bars)
        if daily_bar is not None:
            daily.append(_with_bar(row, daily_bar))
        minute_bar = _covering_minute_bar(occurred, minute_bars)
        if minute_bar is not None:
            minute.append(_with_bar(row, minute_bar))
    return {"daily": daily, "minute": minute}


__all__ = [
    "project_executions",
    "project_marks",
    "symbol_bs_summary",
]
