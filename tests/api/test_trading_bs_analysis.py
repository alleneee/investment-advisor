from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from app.providers.tushare import MarketProviderError
from app.trading.bs_analysis import (
    BarNotFoundError,
    assert_bar_exists,
    build_bs_chart,
    project_executions,
    project_marks,
    symbol_bs_summary,
)
from app.trading.metrics import calculate_review_metrics, replay_rows
from app.trading.reducer import money_text

PERIOD_START = date(2026, 1, 1)
PERIOD_END = date(2026, 1, 31)


def _execution(
    execution_id: str,
    day: str,
    side: str,
    price: str = "10",
    *,
    symbol: str = "600000.SH",
    name: str = "浦发银行",
    **changes,
) -> dict:
    return {
        "execution_id": execution_id,
        "occurred_at": f"{day}T10:00:00+08:00",
        "created_at": f"{day}T10:00:01+08:00",
        "symbol": symbol,
        "name": name,
        "side": side,
        "price": price,
        "quantity": 1,
        "fee": "0",
        "primary_reason": "pullback_confirmation" if side == "buy" else "take_profit",
        "tags": [],
        "note": "",
        "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
    } | changes


def _bar(occurred_at: str) -> dict:
    return {"occurred_at": occurred_at}


def _by_id(rows: list[dict], key: str) -> dict[str, dict]:
    return {row[key]: row for row in rows}


def test_symbol_realized_pnl_sums_to_account_and_includes_buy_only() -> None:
    executions = [
        _execution("a-buy", "2026-01-05", "buy", symbol="600000.SH", name="浦发银行"),
        _execution("a-sell", "2026-01-06", "sell", "11", symbol="600000.SH", name="浦发银行"),
        _execution("b-buy", "2026-01-05", "buy", symbol="600519.SH", name="贵州茅台"),
        _execution("b-sell", "2026-01-08", "sell", "13", symbol="600519.SH", name="贵州茅台"),
        _execution("c-buy", "2026-01-09", "buy", symbol="000001.SZ", name="平安银行"),
    ]
    names = {"600000.SH": "浦发银行", "600519.SH": "贵州茅台", "000001.SZ": "平安银行"}
    ledger = replay_rows("100000", executions, [])
    account = calculate_review_metrics(
        initial_capital="100000",
        executions=executions,
        period_start=PERIOD_START,
        period_end=PERIOD_END,
    )
    summary = symbol_bs_summary(
        executions,
        ledger,
        names,
        PERIOD_START,
        PERIOD_END,
        trading_days=[date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 8), date(2026, 1, 9)],
    )
    by_symbol = _by_id(summary, "symbol")

    assert set(by_symbol) == {"600000.SH", "600519.SH", "000001.SZ"}
    assert by_symbol["000001.SZ"]["name"] == "平安银行"
    assert by_symbol["000001.SZ"]["realized_pnl"] == money_text(0)
    assert sum(
        (Decimal(item["realized_pnl"]) for item in summary),
        Decimal(0),
    ) == Decimal(account["period_realized_pnl"])
    assert Decimal(by_symbol["600000.SH"]["realized_pnl"]) == Decimal(1)
    assert Decimal(by_symbol["600519.SH"]["realized_pnl"]) == Decimal(3)


def test_open_cycle_excluded_from_closed_stats_and_empty_win_rate_is_unavailable() -> None:
    executions = [
        _execution("closed-buy", "2026-01-05", "buy"),
        _execution("closed-sell", "2026-01-06", "sell", "11"),
        _execution("reopen-buy", "2026-01-07", "buy"),
        _execution("open-buy", "2026-01-05", "buy", symbol="000001.SZ", name="平安银行"),
    ]
    names = {"600000.SH": "浦发银行", "000001.SZ": "平安银行"}
    trading_days = [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)]
    ledger = replay_rows("100000", executions, [])
    summary = _by_id(
        symbol_bs_summary(executions, ledger, names, PERIOD_START, PERIOD_END, trading_days),
        "symbol",
    )

    closed = summary["600000.SH"]
    assert closed["closed_cycle_count"] == 1
    assert closed["win_rate"] == {"value": "1", "unavailable_reason": None}

    opened = summary["000001.SZ"]
    assert opened["closed_cycle_count"] == 0
    assert opened["win_rate"]["value"] is None
    assert opened["win_rate"]["unavailable_reason"] == "no_closed_cycle"
    assert opened["median_holding_days"]["value"] is None
    assert opened["median_holding_days"]["unavailable_reason"] == "no_closed_cycle"


def test_median_holding_days_uses_inclusive_trading_day_calendar() -> None:
    executions = [
        _execution("b1", "2026-01-05", "buy"),
        _execution("s1", "2026-01-05", "sell", "11", occurred_at="2026-01-05T14:00:00+08:00"),
        _execution("b2", "2026-01-06", "buy"),
        _execution("s2", "2026-01-08", "sell", "11"),
    ]
    # 2026-01-07 is a weekday but omitted so a calendar-day count would be wrong.
    trading_days = [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 8)]
    ledger = replay_rows("100000", executions, [])
    summary = _by_id(
        symbol_bs_summary(
            executions,
            ledger,
            {"600000.SH": "浦发银行"},
            PERIOD_START,
            PERIOD_END,
            trading_days,
        ),
        "symbol",
    )

    assert summary["600000.SH"]["closed_cycle_count"] == 2
    assert summary["600000.SH"]["median_holding_days"] == {
        "value": "1.5",
        "unavailable_reason": None,
    }


def test_project_marks_matches_exact_minute_bar_and_daily_calendar_day() -> None:
    daily_bars = [
        _bar("2026-01-09T00:00:00+08:00"),
        _bar("2026-01-10T00:00:00+08:00"),
        _bar("2026-01-12T00:00:00+08:00"),
    ]
    minute_bars = [
        _bar("2026-01-09T10:00:00+08:00"),
        _bar("2026-01-09T10:30:00+08:00"),
        _bar("2026-01-09T11:00:00+08:00"),
        _bar("2026-01-10T10:00:00+08:00"),
        _bar("2026-01-10T10:30:00+08:00"),
        _bar("2026-01-10T11:00:00+08:00"),
    ]
    marks = [
        {"mark_id": "exact-30m", "occurred_at": "2026-01-09T10:00:00+08:00", "type_id": "high"},
        {"mark_id": "daily-midnight", "occurred_at": "2026-01-10T00:00:00+08:00", "type_id": "review"},
        {"mark_id": "no-minute-day", "occurred_at": "2026-01-12T00:00:00+08:00", "type_id": "low"},
    ]

    projected = project_marks(marks, daily_bars, minute_bars)
    daily = _by_id(projected["daily"], "mark_id")
    minute = projected["minute"]
    minute_by_id = {row["mark_id"]: row for row in minute}

    assert daily["exact-30m"]["bar_occurred_at"] == "2026-01-09T00:00:00+08:00"
    assert minute_by_id["exact-30m"]["bar_occurred_at"] == "2026-01-09T10:00:00+08:00"

    assert daily["daily-midnight"]["bar_occurred_at"] == "2026-01-10T00:00:00+08:00"
    midnight_minute = [row for row in minute if row["mark_id"] == "daily-midnight"]
    assert [row["bar_occurred_at"] for row in midnight_minute] == ["2026-01-10T11:00:00+08:00"]

    assert daily["no-minute-day"]["bar_occurred_at"] == "2026-01-12T00:00:00+08:00"
    assert "no-minute-day" not in minute_by_id


def test_project_executions_covers_half_open_thirty_minute_windows() -> None:
    daily_bars = [_bar("2026-01-09T00:00:00+08:00")]
    minute_bars = [
        _bar("2026-01-09T10:00:00+08:00"),
        _bar("2026-01-09T10:30:00+08:00"),
        _bar("2026-01-09T11:00:00+08:00"),
    ]
    times = {
        "at-left-open": "2026-01-09T09:30:00+08:00",
        "inside-first": "2026-01-09T09:31:00+08:00",
        "at-first-close": "2026-01-09T10:00:00+08:00",
        "just-after-first": "2026-01-09T10:00:01+08:00",
        "at-second-close": "2026-01-09T10:30:00+08:00",
        "at-last-close": "2026-01-09T11:00:00+08:00",
        "after-last": "2026-01-09T11:00:01+08:00",
    }
    executions = [
        _execution(execution_id, "2026-01-09", "buy", occurred_at=occurred_at)
        for execution_id, occurred_at in times.items()
    ]

    projected = project_executions(executions, daily_bars, minute_bars)
    daily = _by_id(projected["daily"], "execution_id")
    minute = _by_id(projected["minute"], "execution_id")

    assert set(daily) == set(times)
    assert all(row["bar_occurred_at"] == "2026-01-09T00:00:00+08:00" for row in daily.values())
    assert "at-left-open" not in minute
    assert "after-last" not in minute
    assert minute["inside-first"]["bar_occurred_at"] == "2026-01-09T10:00:00+08:00"
    assert minute["at-first-close"]["bar_occurred_at"] == "2026-01-09T10:00:00+08:00"
    assert minute["just-after-first"]["bar_occurred_at"] == "2026-01-09T10:30:00+08:00"
    assert minute["at-second-close"]["bar_occurred_at"] == "2026-01-09T10:30:00+08:00"
    assert minute["at-last-close"]["bar_occurred_at"] == "2026-01-09T11:00:00+08:00"


def test_project_marks_last_of_day_uses_true_last_bar_when_minute_bars_are_reversed() -> None:
    daily_bars = list(
        reversed(
            [
                _bar("2026-01-10T00:00:00+08:00"),
                _bar("2026-01-12T00:00:00+08:00"),
            ]
        )
    )
    minute_bars = list(
        reversed(
            [
                _bar("2026-01-10T10:00:00+08:00"),
                _bar("2026-01-10T10:30:00+08:00"),
                _bar("2026-01-10T11:00:00+08:00"),
            ]
        )
    )
    marks = [
        {"mark_id": "daily-midnight", "occurred_at": "2026-01-10T00:00:00+08:00", "type_id": "review"},
        {"mark_id": "no-minute-day", "occurred_at": "2026-01-12T00:00:00+08:00", "type_id": "low"},
    ]

    projected = project_marks(marks, daily_bars, minute_bars)
    daily = _by_id(projected["daily"], "mark_id")
    minute = [row for row in projected["minute"] if row["mark_id"] == "daily-midnight"]

    assert daily["daily-midnight"]["bar_occurred_at"] == "2026-01-10T00:00:00+08:00"
    assert [row["bar_occurred_at"] for row in minute] == ["2026-01-10T11:00:00+08:00"]
    assert "no-minute-day" not in {row["mark_id"] for row in projected["minute"]}


def test_project_executions_covering_uses_chronological_windows_when_bars_are_reversed() -> None:
    daily_bars = [_bar("2026-01-09T00:00:00+08:00")]
    minute_bars = list(
        reversed(
            [
                _bar("2026-01-09T10:00:00+08:00"),
                _bar("2026-01-09T10:30:00+08:00"),
                _bar("2026-01-09T11:00:00+08:00"),
            ]
        )
    )
    executions = [
        _execution("inside-first", "2026-01-09", "buy", occurred_at="2026-01-09T09:31:00+08:00"),
        _execution("at-first-close", "2026-01-09", "buy", occurred_at="2026-01-09T10:00:00+08:00"),
        _execution("just-after-first", "2026-01-09", "buy", occurred_at="2026-01-09T10:00:01+08:00"),
        _execution("at-last-close", "2026-01-09", "buy", occurred_at="2026-01-09T11:00:00+08:00"),
        _execution("at-left-open", "2026-01-09", "buy", occurred_at="2026-01-09T09:30:00+08:00"),
    ]

    minute = _by_id(project_executions(executions, daily_bars, minute_bars)["minute"], "execution_id")

    assert minute["inside-first"]["bar_occurred_at"] == "2026-01-09T10:00:00+08:00"
    assert minute["at-first-close"]["bar_occurred_at"] == "2026-01-09T10:00:00+08:00"
    assert minute["just-after-first"]["bar_occurred_at"] == "2026-01-09T10:30:00+08:00"
    assert minute["at-last-close"]["bar_occurred_at"] == "2026-01-09T11:00:00+08:00"
    assert "at-left-open" not in minute


class _FakeStore:
    def __init__(self, bars: list[dict] | None = None) -> None:
        self.bars = bars or []

    def list_market_bars(self, account_id, symbol, period_start, period_end) -> list[dict]:
        return list(self.bars)


class _FakeProvider:
    def __init__(
        self,
        *,
        daily_rows: list[dict] | None = None,
        minute_rows: list[dict] | None = None,
        daily_error: Exception | None = None,
        minutes_error: Exception | None = None,
    ) -> None:
        self.daily_rows = daily_rows or []
        self.minute_rows = minute_rows or []
        self.daily_error = daily_error
        self.minutes_error = minutes_error
        self.daily_calls: list[dict] = []
        self.minute_calls: list[dict] = []

    def daily(self, symbol: str, *, as_of=None, start_date=None, end_date=None) -> list[dict]:
        self.daily_calls.append(
            {"symbol": symbol, "as_of": as_of, "start_date": start_date, "end_date": end_date}
        )
        if self.daily_error is not None:
            raise self.daily_error
        return list(self.daily_rows)

    def minutes(self, symbol: str, *, freq: str, as_of, start_date, end_date) -> list[dict]:
        self.minute_calls.append(
            {
                "symbol": symbol,
                "freq": freq,
                "as_of": as_of,
                "start_date": start_date,
                "end_date": end_date,
            }
        )
        if self.minutes_error is not None:
            raise self.minutes_error
        return list(self.minute_rows)


def _daily_row(day: date, close: str = "10") -> dict:
    return {
        "trade_date": day.strftime("%Y%m%d"),
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "vol": "1000",
    }


def _n_daily_rows(count: int, *, end: date = PERIOD_END) -> list[dict]:
    start = end - timedelta(days=count - 1)
    return [_daily_row(start + timedelta(days=offset)) for offset in range(count)]


def test_build_bs_chart_daily_macd_not_ready_before_warmup() -> None:
    provider = _FakeProvider(daily_rows=_n_daily_rows(34))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="1d",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
    )

    assert chart["available"] is True
    assert chart["adjustment"] == "none"
    assert "executions" in chart
    assert chart["executions"] == []
    assert chart["macd"]["ready"] is False
    assert chart["macd"]["dif"] == []
    assert chart["macd"]["dea"] == []
    assert chart["macd"]["histogram"] == []
    assert provider.daily_calls[0]["start_date"] == PERIOD_START - timedelta(days=180)
    assert provider.daily_calls[0]["end_date"] == PERIOD_END
    assert provider.daily_calls[0]["as_of"] == PERIOD_END


def test_build_bs_chart_daily_macd_ready_matches_bar_length() -> None:
    provider = _FakeProvider(daily_rows=list(reversed(_n_daily_rows(35))))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="1d",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
    )

    assert chart["available"] is True
    assert chart["adjustment"] == "none"
    assert len(chart["bars"]) == 35
    assert [bar["occurred_at"] for bar in chart["bars"]] == sorted(bar["occurred_at"] for bar in chart["bars"])
    assert chart["macd"]["ready"] is True
    assert len(chart["macd"]["dif"]) == 35
    assert len(chart["macd"]["dea"]) == 35
    assert len(chart["macd"]["histogram"]) == 35


_BS_CHART_EXECUTION_KEYS = {
    "execution_id",
    "symbol",
    "occurred_at",
    "bar_occurred_at",
    "side",
    "price",
    "quantity",
    "fee",
    "primary_reason",
}


def test_build_bs_chart_projects_executions_onto_current_timeframe() -> None:
    provider = _FakeProvider(daily_rows=_n_daily_rows(35))
    executions = [
        _execution("buy-1", "2026-01-09", "buy", "10.5"),
        _execution("other", "2026-01-09", "buy", symbol="000001.SZ", name="平安银行"),
    ]
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="1d",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=executions,
        provider=provider,
    )

    by_id = _by_id(chart["executions"], "execution_id")
    assert set(by_id) == {"buy-1"}
    row = by_id["buy-1"]
    assert set(row) == _BS_CHART_EXECUTION_KEYS
    assert row["symbol"] == "600000.SH"
    assert row["side"] == "buy"
    assert row["price"] == "10.5"
    assert row["quantity"] == 1
    assert row["fee"] == "0"
    assert row["primary_reason"] == "pullback_confirmation"
    assert row["occurred_at"] == "2026-01-09T10:00:00+08:00"
    assert row["bar_occurred_at"] == "2026-01-09T00:00:00+08:00"
    assert "tags" not in row
    assert "note" not in row
    assert "client_idempotency_key" not in row


def test_build_bs_chart_minutes_provider_error_is_unavailable() -> None:
    provider = _FakeProvider(minutes_error=RuntimeError("stk_mins failed"))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="30m",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[_execution("buy-1", "2026-01-09", "buy")],
        provider=provider,
    )

    assert chart["available"] is False
    assert chart["bars"] == []
    assert chart["executions"] == []
    assert chart["quality"]["status"] == "unavailable"
    assert chart["quality"]["warnings"]
    assert "stk_mins failed" in chart["quality"]["warnings"][0]
    assert provider.minute_calls[0]["freq"] == "30m"
    assert provider.minute_calls[0]["as_of"] == PERIOD_END
    assert provider.minute_calls[0]["end_date"] == PERIOD_END
    assert provider.minute_calls[0]["start_date"] == PERIOD_END - timedelta(days=40)


def test_build_bs_chart_minutes_normalizes_naive_trade_time_as_shanghai() -> None:
    provider = _FakeProvider(
        minute_rows=[
            {
                "trade_time": "2026-01-09 10:00:00",
                "open": "10",
                "high": "11",
                "low": "9",
                "close": "10.2",
                "vol": "100",
            }
        ]
    )
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="30m",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
    )

    assert chart["available"] is True
    assert chart["adjustment"] == "none"
    assert chart["executions"] == []
    assert chart["bars"][0]["occurred_at"] == "2026-01-09T10:00:00+08:00"


def test_build_bs_chart_minutes_market_provider_error_is_unavailable_with_warning() -> None:
    provider = _FakeProvider(minutes_error=MarketProviderError("tushare stk_mins down"))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="30m",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
    )

    assert chart["available"] is False
    assert chart["bars"] == []
    assert chart["executions"] == []
    assert chart["quality"]["status"] == "unavailable"
    assert chart["quality"]["warnings"]
    assert "tushare stk_mins down" in chart["quality"]["warnings"][0]


def test_build_bs_chart_daily_provider_error_without_store_is_unavailable_with_warning() -> None:
    provider = _FakeProvider(daily_error=MarketProviderError("daily feed failed"))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="1d",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
        store=_FakeStore([]),
        account_id="acct-1",
    )

    assert chart["available"] is False
    assert chart["bars"] == []
    assert chart["executions"] == []
    assert chart["quality"]["status"] == "unavailable"
    assert chart["quality"]["warnings"]
    assert "daily feed failed" in chart["quality"]["warnings"][0]


def test_build_bs_chart_daily_keeps_store_bars_when_provider_fails() -> None:
    cached = _n_daily_rows(8)
    provider = _FakeProvider(daily_error=RuntimeError("provider timeout"))
    chart = build_bs_chart(
        symbol="600000.SH",
        timeframe="1d",
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        executions=[],
        provider=provider,
        store=_FakeStore(cached),
        account_id="acct-1",
    )

    assert chart["available"] is True
    assert len(chart["bars"]) == 8
    assert chart["quality"]["status"] == "degraded"
    assert chart["quality"]["warnings"]
    assert "provider timeout" in chart["quality"]["warnings"][0]


def test_assert_bar_exists_rejects_missing_daily_and_minute_bars() -> None:
    daily = [_bar("2026-01-09T00:00:00+08:00")]
    minute = [_bar("2026-01-09T10:00:00+08:00")]

    assert assert_bar_exists(daily, "2026-01-09T00:00:00+08:00") is daily[0]
    assert assert_bar_exists(minute, "2026-01-09T10:00:00+08:00") is minute[0]

    with pytest.raises(BarNotFoundError) as missing_daily:
        assert_bar_exists(daily, "2026-01-10T00:00:00+08:00")
    assert missing_daily.value.code == "BAR_NOT_FOUND"

    with pytest.raises(BarNotFoundError) as missing_minute:
        assert_bar_exists(minute, "2026-01-09T10:30:00+08:00")
    assert missing_minute.value.code == "BAR_NOT_FOUND"
