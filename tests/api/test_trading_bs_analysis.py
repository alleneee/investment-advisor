from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.trading.bs_analysis import project_executions, project_marks, symbol_bs_summary
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
