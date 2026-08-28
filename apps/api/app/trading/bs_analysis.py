"""周期复盘个股 BS 摘要与日线/30 分钟时间投影。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import median
from typing import Any

from app.domain.chan_macd import compute_macd
from app.providers.tushare import MarketProviderError

from .metrics import (
    LedgerMetrics,
    _business_date,
    _cycle_holding_days,
    _decimal,
    _parse_datetime,
    _provider_daily,
    _raw_bar,
    replay_rows,
)
from .reducer import canonical_decimal_text, money_text

MINUTE_BAR_WIDTH = timedelta(minutes=30)
DAILY_LOOKBACK_DAYS = 180
MINUTE_LOOKBACK_CALENDAR_DAYS = 40
_PROVIDER_FAILURES = (
    MarketProviderError,
    RuntimeError,
    TypeError,
    ValueError,
    OSError,
    LookupError,
)
_WARNING_MAX_LENGTH = 300


class BarNotFoundError(ValueError):
    code = "BAR_NOT_FOUND"


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


def _chart_execution(row: Mapping[str, Any]) -> dict[str, Any]:
    occurred = row.get("occurred_at", row.get("executed_at"))
    return {
        "execution_id": row["execution_id"],
        "symbol": row["symbol"],
        "occurred_at": occurred.isoformat() if isinstance(occurred, datetime) else str(occurred),
        "bar_occurred_at": row["bar_occurred_at"],
        "side": row["side"],
        "price": row["price"],
        "quantity": row["quantity"],
        "fee": row["fee"],
        "primary_reason": row["primary_reason"],
    }


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
    *,
    initial_capital: Decimal | int | str | None = None,
    closes: Mapping[tuple[str, date], Decimal] | None = None,
    mark_start: date | None = None,
    mark_end: date | None = None,
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

    symbols = {str(row["symbol"]) for row in period_rows if row.get("symbol")}
    start_positions = _positions_as_of(executions, ledger.cash_flows, initial_capital, mark_start)
    end_positions = _positions_as_of(executions, ledger.cash_flows, initial_capital, mark_end)
    if closes is not None:
        symbols.update(start_positions)
        symbols.update(end_positions)

    summaries: list[dict[str, Any]] = []
    for symbol in sorted(symbols):
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
        trade_rows = [row for row in period_rows if str(row["symbol"]) == symbol]
        summaries.append(
            {
                "symbol": symbol,
                "name": names.get(symbol, symbol),
                "realized_pnl": money_text(realized),
                "period_pnl": money_text(_period_pnl(
                    symbol,
                    realized,
                    trade_rows,
                    start_positions,
                    end_positions,
                    closes,
                    mark_start,
                    mark_end,
                )),
                "closed_cycle_count": len(closed),
                "median_holding_days": median_holding,
                "win_rate": win_rate,
            }
        )
    return summaries


def _positions_as_of(
    executions: Sequence[Mapping[str, Any]],
    cash_flows: Sequence[Mapping[str, Any]],
    initial_capital: Decimal | int | str | None,
    as_of: date | None,
) -> dict[str, Any]:
    if initial_capital is None or as_of is None:
        return {}
    included_executions = [
        row
        for row in executions
        if _business_date(row.get("occurred_at", row.get("executed_at"))) <= as_of
    ]
    included_flows = [
        row
        for row in cash_flows
        if _business_date(row["occurred_at"]) <= as_of
    ]
    return dict(replay_rows(initial_capital, included_executions, included_flows).result.positions)


def _period_pnl(
    symbol: str,
    realized: Decimal,
    trade_rows: Sequence[Mapping[str, Any]],
    start_positions: Mapping[str, Any],
    end_positions: Mapping[str, Any],
    closes: Mapping[tuple[str, date], Decimal] | None,
    mark_start: date | None,
    mark_end: date | None,
) -> Decimal:
    if closes is None:
        return realized
    start_qty = getattr(start_positions.get(symbol), "quantity", 0) or 0
    end_qty = getattr(end_positions.get(symbol), "quantity", 0) or 0
    start_close = closes.get((symbol, mark_start)) if mark_start is not None else None
    end_close = closes.get((symbol, mark_end)) if mark_end is not None else None
    if start_qty and start_close is None:
        return realized
    if end_qty and end_close is None:
        return realized
    start_mv = Decimal(start_qty) * start_close if start_qty else Decimal(0)
    end_mv = Decimal(end_qty) * end_close if end_qty else Decimal(0)
    return end_mv - start_mv + _period_trade_cash(trade_rows)


def _period_trade_cash(rows: Sequence[Mapping[str, Any]]) -> Decimal:
    total = Decimal(0)
    for row in rows:
        notional = _decimal(row["price"]) * Decimal(int(row["quantity"]))
        fee = _decimal(row.get("fee") or 0)
        if row.get("side") == "buy":
            total -= notional + fee
        else:
            total += notional - fee
    return total


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


def assert_bar_exists(bars: Sequence[Mapping[str, Any]], occurred_at: datetime | str) -> Mapping[str, Any]:
    target = _parse_datetime(occurred_at)
    for bar in bars:
        if _bar_at(bar) == target:
            return bar
    raise BarNotFoundError("行情柱不存在")


def build_bs_chart(
    *,
    symbol: str,
    timeframe: str,
    period_start: date,
    period_end: date,
    executions: Sequence[Mapping[str, Any]] = (),
    provider: Any,
    store: Any | None = None,
    account_id: str | None = None,
) -> dict[str, Any]:
    if timeframe == "1d":
        start = period_start - timedelta(days=DAILY_LOOKBACK_DAYS)
        bars, failure = _load_daily_bars(symbol, start, period_end, provider, store, account_id)
    elif timeframe == "30m":
        start = period_end - timedelta(days=MINUTE_LOOKBACK_CALENDAR_DAYS)
        bars, failure = _load_minute_bars(symbol, start, period_end, provider)
    else:
        raise ValueError("timeframe 仅支持 1d 或 30m")
    warnings = [_safe_warning(failure)] if failure is not None else []
    if not bars:
        return _unavailable_chart(symbol, timeframe, warnings)
    bars = _sorted_bars(bars)
    daily_bars = bars if timeframe == "1d" else []
    minute_bars = bars if timeframe == "30m" else []
    macd = compute_macd([Decimal(str(bar["close"])) for bar in bars])
    projected = project_executions(
        _period_symbol_executions(executions, symbol, period_start, period_end),
        daily_bars,
        minute_bars,
    )["daily" if timeframe == "1d" else "minute"]
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "available": True,
        "adjustment": "none",
        "bars": list(bars),
        "executions": [_chart_execution(row) for row in projected],
        "macd": macd,
        "quality": {
            "status": "degraded" if failure is not None else "ok",
            "warnings": warnings,
        },
    }


def _unavailable_chart(symbol: str, timeframe: str, warnings: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "available": False,
        "adjustment": "none",
        "bars": [],
        "executions": [],
        "macd": {"ready": False, "dif": [], "dea": [], "histogram": []},
        "quality": {"status": "unavailable", "warnings": list(warnings)},
    }


def _safe_warning(exc: BaseException) -> str:
    text = str(exc).strip() or type(exc).__name__
    if len(text) > _WARNING_MAX_LENGTH:
        return text[:_WARNING_MAX_LENGTH]
    return text


def _period_symbol_executions(
    executions: Sequence[Mapping[str, Any]],
    symbol: str,
    period_start: date,
    period_end: date,
) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for row in executions:
        if str(row.get("symbol")) != symbol:
            continue
        occurred = row.get("occurred_at", row.get("executed_at"))
        if occurred is None:
            continue
        day = _business_date(occurred)
        if period_start <= day <= period_end:
            rows.append(row)
    return rows


def _load_daily_bars(
    symbol: str,
    start: date,
    end: date,
    provider: Any,
    store: Any | None,
    account_id: str | None,
) -> tuple[list[Mapping[str, Any]], BaseException | None]:
    cached: dict[str, dict[str, Any]] = {}
    if store is not None and account_id:
        for row in store.list_market_bars(account_id, symbol, start, end):
            if row.get("close") is None:
                continue
            bar = _raw_bar(row)
            cached[str(bar["trade_date"])] = bar
    failure: BaseException | None = None
    try:
        raw = _provider_daily(provider, symbol, start, end)
    except _PROVIDER_FAILURES as exc:
        raw = []
        failure = exc
    for row in raw:
        if row.get("close") is None:
            continue
        bar = _raw_bar(row)
        cached.setdefault(str(bar["trade_date"]), bar)
    return [cached[key] for key in sorted(cached)], failure


def _load_minute_bars(
    symbol: str, start: date, end: date, provider: Any
) -> tuple[list[dict[str, Any]], BaseException | None]:
    try:
        rows = provider.minutes(symbol, freq="30m", as_of=end, start_date=start, end_date=end)
    except _PROVIDER_FAILURES as exc:
        return [], exc
    bars: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, Mapping) or row.get("close") is None:
            continue
        bars.append(_raw_minute_bar(row))
    return bars, None


def _raw_minute_bar(row: Mapping[str, Any]) -> dict[str, Any]:
    occurred = _parse_datetime(row.get("trade_time", row.get("occurred_at")))
    volume = row.get("vol", row.get("volume"))
    return {
        "trade_date": occurred.date().isoformat(),
        "occurred_at": occurred.isoformat(),
        "open": canonical_decimal_text(_decimal(row.get("open"), field="open")),
        "high": canonical_decimal_text(_decimal(row.get("high"), field="high")),
        "low": canonical_decimal_text(_decimal(row.get("low"), field="low")),
        "close": canonical_decimal_text(_decimal(row.get("close"), field="close")),
        "volume": None
        if volume is None
        else canonical_decimal_text(_decimal(volume, field="vol")),
    }


__all__ = [
    "BarNotFoundError",
    "assert_bar_exists",
    "build_bs_chart",
    "project_executions",
    "project_marks",
    "symbol_bs_summary",
]
