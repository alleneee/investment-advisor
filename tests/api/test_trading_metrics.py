import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from decimal import Decimal
from threading import Barrier
from zoneinfo import ZoneInfo

import pytest
from app.db import Database
from app.main import create_app
from app.trading.metrics import (
    NavPoint,
    build_chart_bundle,
    build_nav,
    calculate_review_metrics,
    compare_period_metrics,
    holding_trade_days,
    period_max_drawdown,
    period_return_curve,
    previous_period_bounds,
    raw_bar_digest,
)
from app.trading.service import TradingService
from app.trading.store import TradingStore
from httpx import ASGITransport, AsyncClient

SHANGHAI = ZoneInfo("Asia/Shanghai")


def test_full_withdrawal_preserves_nav_and_does_not_create_drawdown() -> None:
    points = build_nav(
        base_equity=Decimal(100000),
        valuations=[
            {
                "date": date(2026, 1, 5),
                "equity": Decimal(0),
                "external_flow": Decimal(-100000),
            }
        ],
    )

    assert points[-1].daily_return == Decimal(0)
    assert points[-1].nav == Decimal(1)
    assert period_max_drawdown(points) == Decimal(0)


def test_activation_day_fee_is_return_not_a_baseline_reset() -> None:
    points = build_nav(
        base_equity=Decimal(100000),
        valuations=[
            {
                "date": date(2026, 1, 5),
                "equity": Decimal(99995),
                "external_flow": Decimal(0),
            }
        ],
    )

    assert points[-1].nav == Decimal("0.99995")
    assert points[-1].daily_return == Decimal("-0.00005")


def test_zero_equity_baseline_is_explicit_when_end_equity_is_non_zero() -> None:
    points = build_nav(
        base_equity=Decimal(0),
        valuations=[
            {
                "date": date(2026, 1, 5),
                "equity": Decimal(100),
                "external_flow": Decimal(0),
            }
        ],
    )

    assert points[-1].nav is None
    assert points[-1].unavailable_reason == "zero_equity_baseline"
    assert period_max_drawdown(points) is None


def test_period_drawdown_uses_period_start_as_peak() -> None:
    points = build_nav(
        base_equity=Decimal(100),
        valuations=[
            {"date": date(2026, 1, 1), "equity": Decimal(120), "external_flow": Decimal(0)},
            {"date": date(2026, 1, 2), "equity": Decimal(90), "external_flow": Decimal(0)},
        ],
    )

    assert period_max_drawdown(points) == Decimal("0.25")


def test_period_return_curve_normalizes_positive_nav_and_keeps_gaps() -> None:
    points = [
        NavPoint(date(2026, 1, 1), Decimal(1), Decimal(0), None, Decimal(2), None),
        NavPoint(date(2026, 1, 2), Decimal(0), Decimal(0), None, Decimal(0), None),
        NavPoint(
            date(2026, 1, 3),
            Decimal(0),
            Decimal(0),
            None,
            None,
            None,
            "no_sample",
        ),
        NavPoint(date(2026, 1, 4), Decimal(0), Decimal(0), None, None, None),
        NavPoint(date(2026, 1, 5), Decimal(100), Decimal(100), None, Decimal(1), Decimal(0)),
        NavPoint(date(2026, 1, 6), Decimal(110), Decimal(0), None, Decimal("1.1"), Decimal(0)),
        NavPoint(
            date(2026, 1, 7),
            Decimal(110),
            Decimal(0),
            None,
            None,
            None,
            "zero_equity_baseline",
        ),
        NavPoint(date(2026, 1, 8), Decimal(0), Decimal(0), None, Decimal(0), Decimal(1)),
        NavPoint(date(2026, 1, 9), Decimal(1), Decimal(0), None, Decimal(1), Decimal(0)),
    ]

    assert period_return_curve(points, date(2026, 1, 2), date(2026, 1, 8)) == [
        {
            "date": "2026-01-02",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-03",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "no_sample",
            },
        },
        {
            "date": "2026-01-04",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-05",
            "cumulative_return_rate": {"value": "0", "unavailable_reason": None},
        },
        {
            "date": "2026-01-06",
            "cumulative_return_rate": {"value": "0.1", "unavailable_reason": None},
        },
        {
            "date": "2026-01-07",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-08",
            "cumulative_return_rate": {"value": "-1", "unavailable_reason": None},
        },
    ]


def test_period_return_curve_keeps_all_dates_when_no_positive_nav_exists() -> None:
    points = [
        NavPoint(date(2026, 1, 2), Decimal(0), Decimal(0), None, Decimal(0), None),
        NavPoint(
            date(2026, 1, 5),
            Decimal(100),
            Decimal(0),
            None,
            None,
            None,
            "zero_equity_baseline",
        ),
    ]

    assert period_return_curve(points, date(2026, 1, 1), date(2026, 1, 31)) == [
        {
            "date": "2026-01-02",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-05",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
    ]


@pytest.mark.parametrize(
    "value",
    [
        {"date": date(2026, 1, 5), "equity": Decimal(100), "external_flow": Decimal(0)},
        {
            "valuation_date": date(2026, 1, 5),
            "equity": Decimal(100),
            "external_flow": Decimal(0),
        },
    ],
)
def test_valuation_accepts_business_date_aliases(value: dict) -> None:
    points = build_nav(base_equity=Decimal(100), valuations=[value])

    assert points[-1].date == date(2026, 1, 5)


def _execution(execution_id: str = "execution", day: str = "2026-01-05", side: str = "buy", price: str = "10", reason: str = "pullback_confirmation", **changes) -> dict:
    return {
        "execution_id": execution_id,
        "occurred_at": f"{day}T10:00:00+08:00",
        "created_at": f"{day}T10:00:01+08:00",
        "symbol": "600000.SH",
        "name": "浦发银行",
        "side": side,
        "price": price,
        "quantity": 1,
        "fee": "0",
        "primary_reason": reason,
        "tags": [],
        "note": "",
        "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
    } | changes


def test_period_realized_pnl_is_separate_from_closed_cycle_pnl() -> None:
    executions = [
        _execution("buy", "2025-12-31", "buy", "10", "pullback_confirmation"),
        _execution("sell-jan", "2026-01-05", "sell", "11", "take_profit"),
        _execution("sell-feb", "2026-02-02", "sell", "9", "stop_loss"),
    ]
    executions[0]["quantity"] = 2
    executions[1]["quantity"] = 1
    executions[2]["quantity"] = 1

    january = calculate_review_metrics(
        initial_capital="100",
        executions=executions,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
    )
    february = calculate_review_metrics(
        initial_capital="100",
        executions=executions,
        period_start=date(2026, 2, 1),
        period_end=date(2026, 2, 28),
    )

    assert january["period_realized_pnl"] == "1"
    assert january["closed_cycle_pnl"] == "0"
    assert january["closed_cycle_count"] == 0
    assert february["period_realized_pnl"] == "-1"
    assert february["closed_cycle_pnl"] == "0"
    assert february["closed_cycle_count"] == 1


def test_all_unavailable_nav_points_keep_zero_equity_baseline_reason() -> None:
    result = calculate_review_metrics(
        initial_capital="0",
        executions=[],
        valuation_points=[
            NavPoint(
                date=date(2026, 1, 5),
                equity=Decimal(100),
                external_flow=Decimal(0),
                daily_return=None,
                nav=None,
                drawdown_rate=None,
                unavailable_reason="zero_equity_baseline",
            )
        ],
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
    )

    assert result["account_adjusted_return_rate"] == {
        "value": None,
        "unavailable_reason": "zero_equity_baseline",
    }
    assert result["period_max_drawdown_rate"] == {
        "value": None,
        "unavailable_reason": "zero_equity_baseline",
    }


def test_reason_threshold_holding_median_and_closing_day_discipline() -> None:
    executions = []
    for index, (start, end, sell_reason) in enumerate(
        (("2026-01-05", "2026-01-05", "take_profit"), ("2026-01-06", "2026-01-08", "take_profit")),
        start=1,
    ):
        executions.extend(
            [
                _execution(f"b{index}", start, "buy", "10", "pullback_confirmation"),
                _execution(f"s{index}", end, "sell", "11", sell_reason),
            ]
        )
    result = calculate_review_metrics(
        initial_capital="1000",
        executions=executions,
        daily_reviews=[
            {"trade_date": "2026-01-05", "status": "completed", "discipline_followed": True},
            {"trade_date": "2026-01-08", "status": "draft", "discipline_followed": None},
        ],
        trading_days=[date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7), date(2026, 1, 8)],
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
    )

    assert result["median_holding_days"]["value"] == "2"
    assert result["reason_performance"][0]["sample_count"] == 2
    assert result["reason_performance"][0]["conclusion_allowed"] is False
    assert result["cycle_cases"][0]["discipline_followed"] is True
    assert result["cycle_cases"][1]["discipline_followed"] is None
    assert holding_trade_days(date(2026, 1, 2), date(2026, 1, 5), [date(2026, 1, 2), date(2026, 1, 5)]) == 2


def test_reason_performance_exposes_max_cycle_profit_and_loss() -> None:
    executions = [
        _execution("b1", "2026-01-05", "buy", "10", "pullback_confirmation"),
        _execution("s1", "2026-01-06", "sell", "12", "take_profit"),
        _execution("b2", "2026-01-07", "buy", "10", "pullback_confirmation"),
        _execution("s2", "2026-01-08", "sell", "8", "stop_loss"),
    ]
    result = calculate_review_metrics(
        initial_capital="100",
        executions=executions,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
    )

    buy_group = next(item for item in result["reason_performance"] if item["side"] == "buy")
    assert buy_group["max_cycle_profit"] == {"value": "2", "unavailable_reason": None}
    assert buy_group["max_cycle_loss"] == {"value": "-2", "unavailable_reason": None}


def test_review_metrics_materializes_trading_day_generator_once() -> None:
    executions = [
        _execution("b1", "2026-01-05", "buy", "10", "pullback_confirmation"),
        _execution("s1", "2026-01-06", "sell", "11", "take_profit"),
        _execution("b2", "2026-01-07", "buy", "10", "pullback_confirmation"),
        _execution("s2", "2026-01-08", "sell", "11", "take_profit"),
    ]
    result = calculate_review_metrics(
        initial_capital="100",
        executions=executions,
        trading_days=(day for day in [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7), date(2026, 1, 8)]),
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
    )

    assert result["median_holding_days"]["value"] == "2"
    assert [case["holding_days"] for case in result["cycle_cases"]] == [2, 2]


def test_previous_period_and_comparison_expose_finite_deltas() -> None:
    assert previous_period_bounds("month", date(2026, 2, 1), date(2026, 2, 28)) == (
        date(2026, 1, 1), date(2026, 1, 31)
    )
    current = {"win_rate": {"value": "0.6", "unavailable_reason": None}}
    previous = {"win_rate": {"value": "0.4", "unavailable_reason": None}}
    comparison = compare_period_metrics(current, previous)

    win_rate = next(item for item in comparison["comparison"]["metrics"] if item["metric_ref"] == "account.win_rate")
    assert win_rate["delta"]["value"] == "0.2"
    assert compare_period_metrics(current, previous, partial_period=True)["comparison_unavailable_reason"] == "partial_period"


def test_raw_bar_digest_ignores_adjusted_fields_and_chart_bundle_keeps_volume_and_markers() -> None:
    raw = {
        "trade_date": "20260105",
        "open": "10",
        "high": "11",
        "low": "9",
        "close": "10.5",
        "vol": "1000",
        "qfq_close": "20",
        "payload_hash": "provider-specific",
    }
    adjusted = raw | {"qfq_close": "30", "payload_hash": "changed"}
    assert raw_bar_digest(raw) == raw_bar_digest(adjusted)
    bundle = build_chart_bundle(
        symbol="600000.SH",
        name="浦发银行",
        bars=[raw, raw | {"trade_date": "20260106", "close": "10.8", "qfq_close": "21"}],
        executions=[
            _execution("buy", "2026-01-05", "buy", "10.2", "pullback_confirmation")
        ],
    )

    assert bundle["adjustment"] == "none"
    assert bundle["bars"][0]["volume"] == "1000"
    assert bundle["executions"][0]["trade_date"] == "2026-01-05"
    assert "chan_facts" not in bundle
    json.dumps(bundle)
    assert "strokes" in bundle and "centers" in bundle


def test_chart_bundle_maps_chan_indices_to_merged_bar_dates() -> None:
    values = [(10, 8), (7, 5), (9, 6), (11, 8), (13, 10), (16, 13), (14, 11)]
    bars = [
        {
            "trade_date": f"202601{index + 1:02d}",
            "open": str(low),
            "high": str(high),
            "low": str(low),
            "close": str(low),
            "vol": "100",
        }
        for index, (high, low) in enumerate(values)
    ]

    bundle = build_chart_bundle(symbol="600000.SH", name="浦发银行", bars=bars)

    assert bundle["strokes"][0]["start_at"].startswith("2026-01-02")
    assert bundle["strokes"][0]["end_at"].startswith("2026-01-06")


class FakeMarketProvider:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls = 0

    def daily(self, symbol: str, *, as_of: date, start_date: date | None = None, end_date: date | None = None) -> list[dict]:
        self.calls += 1
        rows = []
        for row in self.rows:
            if _date(row["trade_date"]) > as_of:
                continue
            if "symbol" in row and row["symbol"] != symbol:
                continue
            rows.append({key: value for key, value in row.items() if key != "symbol"})
        return rows


class FakeCalendarProvider:
    def __init__(self, days: list[date]) -> None:
        self.days = days

    def trade_cal(self, *, start_date: date, end_date: date) -> list[dict]:
        return [
            {"cal_date": day.isoformat(), "is_open": 1}
            for day in self.days
            if start_date <= day <= end_date
        ]


def _date(value: str) -> date:
    text = str(value)
    return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:]}") if len(text) == 8 else date.fromisoformat(text)


@pytest.mark.anyio
async def test_account_summary_uses_raw_close_and_reports_daily_pnl_and_drawdown() -> None:
    provider = FakeMarketProvider(
        [
            {"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000", "qfq_close": "20"},
        ]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(price="10", quantity=1000, fee="5")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"})).status_code == 201
        execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
        execution_payload["executed_at"] = execution["occurred_at"]
        assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
        account = await client.get("/api/trading/account")

    assert account.status_code == 200
    body = account.json()
    assert body["cash"] == "89995"
    assert body["position_market_value"] == "10000.00"
    assert body["total_equity"] == "99995.00"
    assert body["valuation_date"] == "2026-01-05"
    assert body["daily_pnl"] == "-5.00"
    assert body["data_quality"] == "ok"
    assert body["since_inception_drawdown"] == "0.00005"
    assert provider.calls == 1


@pytest.mark.anyio
async def test_account_daily_pnl_uses_round_half_up() -> None:
    provider = FakeMarketProvider(
        [{"trade_date": "20260105", "open": "1.005", "high": "1.005", "low": "1.005", "close": "1.005", "vol": "1"}]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(price="1", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        execution_payload["client_idempotency_key"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        assert (await client.post("/api/trading/executions", json=execution_payload | {"price": "1"})).status_code == 201
        account = await client.get("/api/trading/account")

    assert account.json()["daily_pnl"] == "0.01"


@pytest.mark.anyio
async def test_account_summary_maps_weekend_cash_flow_to_next_valuation_day() -> None:
    provider = FakeMarketProvider([])
    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    flow = {
        "occurred_at": "2026-01-03T10:00:00+08:00",
        "kind": "deposit",
        "amount": "50",
        "note": "周末入金",
        "client_idempotency_key": "22222222-2222-4222-8222-222222222222",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json=flow)).status_code == 201
        account = await client.get("/api/trading/account")

    assert account.json()["cash"] == "150"
    assert account.json()["total_equity"] == "150.00"
    assert account.json()["daily_pnl"] == "0.00"
    assert account.json()["data_quality"] == "ok"


@pytest.mark.anyio
async def test_missing_calendar_provider_is_lazy_tushare_calendar_not_weekday_fallback(monkeypatch) -> None:
    class LazyCalendarProvider:
        instances = 0
        calendar_calls = 0

        def __init__(self) -> None:
            LazyCalendarProvider.instances += 1

        def trade_cal(self, *, start_date: date, end_date: date) -> list[dict]:
            LazyCalendarProvider.calendar_calls += 1
            return [{"cal_date": "2026-01-05", "is_open": 1}]

    monkeypatch.setattr("app.providers.tushare.TushareMarketProvider", LazyCalendarProvider)
    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_clock=lambda: datetime(2026, 1, 6, 16, tzinfo=SHANGHAI),
    )

    assert LazyCalendarProvider.instances == 0
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        account = await client.get("/api/trading/account")

    assert LazyCalendarProvider.instances == 1
    assert LazyCalendarProvider.calendar_calls == 1
    assert account.json()["valuation_date"] == "2026-01-05"


@pytest.mark.anyio
async def test_market_cache_avoids_repeat_provider_calls_and_raw_refresh_advances_revision() -> None:
    provider = FakeMarketProvider(
        [
            {"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000", "qfq_close": "20"},
        ]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    database = Database()
    app = create_app(
        database=database,
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(price="10", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
        assert (await client.get("/api/trading/account")).status_code == 200
        assert (await client.get("/api/trading/account")).status_code == 200

    assert provider.calls >= 2
    account = TradingStore(database).get_account()
    assert account["market_revision"] >= 1
    service = TradingService(
        TradingStore(database),
        market_provider=provider,
        calendar_provider=calendar,
        clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    provider.rows[0]["qfq_close"] = "99"
    assert service.refresh_market_prices() == 1
    provider.rows[0]["close"] = "10.5"
    assert service.refresh_market_prices() == 2


@pytest.mark.anyio
async def test_account_summary_refetches_today_close_after_session_cache() -> None:
    provider = FakeMarketProvider(
        [
            _bar("600000.SH", "2026-01-05", "10"),
            _bar("600000.SH", "2026-01-06", "10.2"),
        ]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5), date(2026, 1, 6)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 6, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(price="10", quantity=100, fee="0")
    payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "10000"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=payload)).status_code == 201
        first = await client.get("/api/trading/account")
        for row in provider.rows:
            if row["trade_date"] in {"20260106", "2026-01-06"}:
                row["close"] = "12"
        second = await client.get("/api/trading/account")

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["daily_pnl"] == "200.00"
    assert second.json()["data_quality"] == "ok"


@pytest.mark.anyio
async def test_account_summary_returns_when_market_provider_hangs() -> None:
    class HangingMarketProvider:
        def daily(self, symbol: str, *, as_of: date, start_date: date | None = None, end_date: date | None = None) -> list[dict]:
            time.sleep(30)
            return []

    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    app = create_app(
        database=Database(),
        trading_market_provider=HangingMarketProvider(),
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(price="10", quantity=1, fee="0")
    payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=payload)).status_code == 201
        started = time.monotonic()
        account = await client.get("/api/trading/account")
        elapsed = time.monotonic() - started

    assert account.status_code == 200
    assert elapsed < 8
    body = account.json()
    assert body["name"] == "主账户"
    assert Decimal(body["cash"]) == Decimal(90)
    assert body["data_quality"] in {"degraded", "unavailable"}


def test_concurrent_same_market_dependency_advances_revision_once(tmp_path) -> None:
    class BarrierMarketProvider:
        def __init__(self) -> None:
            self.barrier = Barrier(2)

        def daily(self, symbol: str, *, as_of: date, start_date: date, end_date: date) -> list[dict]:
            self.barrier.wait(timeout=5)
            return [{"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000"}]

    str(tmp_path / "trading.sqlite")
    first_database = Database()
    first_service = TradingService(
        TradingStore(first_database),
        market_provider=BarrierMarketProvider(),
        clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    first_service.create_account({"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})
    first_service.create_execution(
        {
            "symbol": "600000.SH",
            "occurred_at": "2026-01-05T10:00:00+08:00",
            "side": "buy",
            "price": "10",
            "quantity": 1,
            "fee": "0",
            "primary_reason": "pullback_confirmation",
            "client_idempotency_key": "55555555-5555-4555-8555-555555555555",
        },
        {"name": "浦发银行", "tags": [], "note": ""},
    )

    provider = BarrierMarketProvider()
    services = [
        TradingService(
            TradingStore(Database()),
            market_provider=provider,
            clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
        )
        for _ in range(2)
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        revisions = list(executor.map(lambda service: service.refresh_market_prices(), services))

    assert revisions == [1, 1]


@pytest.mark.anyio
async def test_refresh_market_prices_rechecks_cached_historical_valuation_dates() -> None:
    provider = FakeMarketProvider(
        [{"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000"}]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5)])
    database = Database()
    app = create_app(
        database=database,
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(day="2026-01-05", price="10", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async def seed_market_cache() -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
            assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
            assert (await client.get("/api/trading/account")).status_code == 200

    await seed_market_cache()
    provider.rows[0]["close"] = "10.5"
    service = TradingService(
        TradingStore(database),
        market_provider=provider,
        calendar_provider=calendar,
        clock=lambda: datetime(2026, 1, 6, 16, tzinfo=SHANGHAI),
    )

    assert service.refresh_market_prices() == 2
    with database.read() as connection:
        cached = connection.execute(
            "SELECT close FROM trading_market_prices WHERE valuation_date = %s",
            ("2026-01-05",),
        ).fetchone()
    assert cached is not None
    assert cached["close"] == "10.5"


def test_market_digest_changes_only_for_raw_ohlcv() -> None:
    first = {"trade_date": "20260105", "open": "10", "high": "11", "low": "9", "close": "10", "vol": "100"}
    assert raw_bar_digest(first | {"qfq_close": "20"}) == raw_bar_digest(first | {"qfq_close": "30"})
    assert raw_bar_digest(first | {"close": "10.01"}) != raw_bar_digest(first)


@pytest.mark.anyio
async def test_missing_current_close_uses_last_valid_close_and_marks_degraded() -> None:
    provider = FakeMarketProvider(
        [
            {"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000"},
        ]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5), date(2026, 1, 6)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 6, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(day="2026-01-05", price="10", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
        account = await client.get("/api/trading/account")

    assert account.json()["valuation_date"] == "2026-01-06"
    assert account.json()["total_equity"] == "100.00"
    assert account.json()["data_quality"] == "degraded"
    assert account.json()["data_quality_warnings"] == ["missing_close_price"]


@pytest.mark.anyio
async def test_cached_previous_close_is_carried_to_new_valuation_date_when_provider_fails() -> None:
    provider = FakeMarketProvider(
        [
            {"trade_date": "20260105", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000"},
        ]
    )
    calendar_days = [date(2026, 1, 5)]
    calendar = FakeCalendarProvider(calendar_days)
    clock_value = [datetime(2026, 1, 5, 16, tzinfo=SHANGHAI)]
    database = Database()
    app = create_app(
        database=database,
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: clock_value[0],
    )
    execution = _execution(day="2026-01-05", price="10", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
        assert (await client.get("/api/trading/account")).json()["valuation_date"] == "2026-01-05"

        calendar_days.append(date(2026, 1, 6))
        clock_value[0] = datetime(2026, 1, 6, 16, tzinfo=SHANGHAI)
        provider.rows.clear()
        account = await client.get("/api/trading/account")

    assert account.json()["valuation_date"] == "2026-01-06"
    assert account.json()["total_equity"] == "100.00"
    assert account.json()["data_quality"] == "degraded"
    with database.read() as connection:
        cached = connection.execute(
            "SELECT source_trade_date FROM trading_market_prices WHERE valuation_date = %s",
            ("2026-01-06",),
        ).fetchone()
    assert cached is not None
    assert cached["source_trade_date"] == "2026-01-05"


@pytest.mark.anyio
async def test_weekend_cash_flow_updates_cash_preview_without_next_valuation_day() -> None:
    calendar = FakeCalendarProvider([date(2026, 1, 9)])
    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 11, 16, tzinfo=SHANGHAI),
    )
    cash_flow = {
        "occurred_at": "2026-01-11T10:00:00+08:00",
        "kind": "deposit",
        "amount": "50",
        "note": "周日入金",
        "client_idempotency_key": "33333333-3333-4333-8333-333333333333",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json=cash_flow)).status_code == 201
        account = await client.get("/api/trading/account")

    body = account.json()
    assert body["cash"] == "150"
    assert body["valuation_date"] == "2026-01-09"


@pytest.mark.anyio
async def test_empty_calendar_does_not_fabricate_as_of_valuation() -> None:
    class EmptyCalendarProvider:
        calls = 0

        def trade_cal(self, *, start_date: date, end_date: date) -> list[dict]:
            EmptyCalendarProvider.calls += 1
            return []

    provider = FakeMarketProvider(
        [{"trade_date": "20260111", "open": "10", "high": "10", "low": "10", "close": "10", "vol": "1000"}]
    )
    calendar = EmptyCalendarProvider()
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 11, 16, tzinfo=SHANGHAI),
    )
    execution = _execution(day="2026-01-09", price="10", quantity=1, fee="0")
    execution_payload = {key: value for key, value in execution.items() if key not in {"execution_id", "created_at", "occurred_at"}}
    execution_payload["executed_at"] = execution["occurred_at"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/executions", json=execution_payload)).status_code == 201
        account = await client.get("/api/trading/account")

    body = account.json()
    assert body["cash"] == "90"
    assert body["valuation_date"] is None
    assert body["data_quality"] == "unavailable"
    assert EmptyCalendarProvider.calls == 1


@pytest.mark.anyio
async def test_calendar_failure_keeps_cash_preview_but_marks_valuation_unavailable() -> None:
    class FailingCalendarProvider:
        def trade_cal(self, *, start_date: date, end_date: date) -> list[dict]:
            raise RuntimeError("calendar unavailable")

    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_calendar_provider=FailingCalendarProvider(),
        trading_clock=lambda: datetime(2026, 1, 11, 16, tzinfo=SHANGHAI),
    )
    cash_flow = {
        "occurred_at": "2026-01-11T10:00:00+08:00",
        "kind": "deposit",
        "amount": "50",
        "note": "日历失败时入金",
        "client_idempotency_key": "44444444-4444-4444-8444-444444444444",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json=cash_flow)).status_code == 201
        account = await client.get("/api/trading/account")

    body = account.json()
    assert body["cash"] == "150"
    assert body["valuation_date"] is None
    assert body["data_quality"] == "unavailable"


@pytest.mark.anyio
async def test_calendar_failure_is_retried_for_same_range_and_can_recover() -> None:
    class RecoveringCalendarProvider:
        calls = 0

        def trade_cal(self, *, start_date: date, end_date: date) -> list[dict]:
            RecoveringCalendarProvider.calls += 1
            if RecoveringCalendarProvider.calls == 1:
                raise RuntimeError("temporary calendar failure")
            return [{"cal_date": "2026-01-05", "is_open": 1}]

    calendar = RecoveringCalendarProvider()
    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 6, 16, tzinfo=SHANGHAI),
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100"})).status_code == 201
        account = await client.get("/api/trading/account")

    assert RecoveringCalendarProvider.calls == 2
    assert account.json()["valuation_date"] == "2026-01-05"


def _bar(symbol: str, day: str, close: str) -> dict:
    return {
        "symbol": symbol,
        "trade_date": day.replace("-", ""),
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "vol": "1000",
    }


@pytest.mark.anyio
async def test_calendar_values_sold_holdings_and_does_not_count_deposits_as_pnl() -> None:
    provider = FakeMarketProvider(
        [
            _bar("600000.SH", "2026-01-05", "10"),
            _bar("600000.SH", "2026-01-06", "10"),
            _bar("600000.SH", "2026-01-07", "10"),
            _bar("600519.SH", "2026-01-07", "10"),
        ]
    )
    calendar = FakeCalendarProvider([date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)])
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 7, 16, tzinfo=SHANGHAI),
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"})).status_code == 201
        assert (await client.post("/api/trading/executions", json={
            "symbol": "600000.SH",
            "name": "浦发银行",
            "executed_at": "2026-01-05T10:00:00+08:00",
            "side": "buy",
            "price": "10",
            "quantity": 1000,
            "fee": "0",
            "primary_reason": "other",
            "tags": [],
            "note": "",
            "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
        })).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json={
            "occurred_at": "2026-01-06T10:00:00+08:00",
            "kind": "deposit",
            "amount": "50000",
            "note": "转入",
            "client_idempotency_key": "22222222-2222-4222-8222-222222222222",
        })).status_code == 201
        assert (await client.post("/api/trading/executions", json={
            "symbol": "600000.SH",
            "name": "浦发银行",
            "executed_at": "2026-01-07T10:00:00+08:00",
            "side": "sell",
            "price": "10",
            "quantity": 1000,
            "fee": "0",
            "primary_reason": "other",
            "tags": [],
            "note": "",
            "client_idempotency_key": "33333333-3333-4333-8333-333333333333",
        })).status_code == 201
        assert (await client.post("/api/trading/executions", json={
            "symbol": "600519.SH",
            "name": "贵州茅台",
            "executed_at": "2026-01-07T10:01:00+08:00",
            "side": "buy",
            "price": "10",
            "quantity": 1000,
            "fee": "0",
            "primary_reason": "other",
            "tags": [],
            "note": "",
            "client_idempotency_key": "44444444-4444-4444-8444-444444444444",
        })).status_code == 201
        month = await client.get("/api/trading/calendar", params={"month": "2026-01"})

    assert month.status_code == 200
    by_date = {item["date"]: item for item in month.json()["days"]}
    assert by_date["2026-01-05"]["daily_pnl"] == "0.00"
    assert by_date["2026-01-06"]["daily_pnl"] == "0.00"
    assert by_date["2026-01-07"]["daily_pnl"] == "0.00"
    assert month.json()["net_pnl"] == "0.00"


@pytest.mark.anyio
async def test_period_summary_drawdown_is_intra_month_not_since_inception() -> None:
    provider = FakeMarketProvider(
        [
            _bar("600000.SH", "2026-01-05", "10"),
            _bar("600000.SH", "2026-01-06", "7"),
            _bar("600000.SH", "2026-02-05", "7.2"),
            _bar("600000.SH", "2026-02-06", "7"),
        ]
    )
    calendar = FakeCalendarProvider(
        [date(2026, 1, 5), date(2026, 1, 6), date(2026, 2, 5), date(2026, 2, 6)]
    )
    app = create_app(
        database=Database(),
        trading_market_provider=provider,
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 2, 6, 16, tzinfo=SHANGHAI),
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"})).status_code == 201
        assert (await client.post("/api/trading/executions", json={
            "symbol": "600000.SH",
            "name": "浦发银行",
            "executed_at": "2026-01-05T10:00:00+08:00",
            "side": "buy",
            "price": "10",
            "quantity": 9000,
            "fee": "0",
            "primary_reason": "other",
            "tags": [],
            "note": "",
            "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
        })).status_code == 201
        january = await client.get("/api/trading/calendar", params={"month": "2026-01"})
        february = await client.get("/api/trading/calendar", params={"month": "2026-02"})
        account = await client.get("/api/trading/account")
        february_window = await client.get(
            "/api/trading/period-summary", params={"start": "2026-02-05", "end": "2026-02-06"}
        )
        year_window = await client.get(
            "/api/trading/period-summary", params={"start": "2026-01-01", "end": "2026-12-31"}
        )
        inverted = await client.get(
            "/api/trading/period-summary", params={"start": "2026-02-06", "end": "2026-02-05"}
        )

    assert january.status_code == 200
    assert february.status_code == 200
    january_dd = Decimal(january.json()["max_drawdown"])
    february_dd = Decimal(february.json()["max_drawdown"])
    since_inception = Decimal(account.json()["since_inception_drawdown"])
    assert january_dd == Decimal("0.27")
    assert february_dd < Decimal("0.05")
    assert since_inception == Decimal("0.27")
    assert february_dd != since_inception
    assert february_window.status_code == 200
    assert Decimal(february_window.json()["max_drawdown"]) == february_dd
    february_curve = february_window.json()["return_curve"]
    assert [point["date"] for point in february_curve] == ["2026-02-05", "2026-02-06"]
    assert february_curve[0]["cumulative_return_rate"] == {
        "value": "0",
        "unavailable_reason": None,
    }
    assert year_window.status_code == 200
    assert Decimal(year_window.json()["max_drawdown"]) == since_inception
    assert inverted.status_code == 400


@pytest.mark.anyio
async def test_period_summary_cash_flows_do_not_create_cumulative_return() -> None:
    calendar = FakeCalendarProvider(
        [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)]
    )
    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_calendar_provider=calendar,
        trading_clock=lambda: datetime(2026, 1, 7, 16, tzinfo=SHANGHAI),
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={
            "name": "主账户",
            "activated_on": "2026-01-05",
            "initial_capital": "100",
        })).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json={
            "occurred_at": "2026-01-06T10:00:00+08:00",
            "kind": "deposit",
            "amount": "50",
            "note": "入金",
            "client_idempotency_key": "55555555-5555-4555-8555-555555555555",
        })).status_code == 201
        assert (await client.post("/api/trading/cash-flows", json={
            "occurred_at": "2026-01-07T10:00:00+08:00",
            "kind": "withdrawal",
            "amount": "20",
            "note": "出金",
            "client_idempotency_key": "66666666-6666-4666-8666-666666666666",
        })).status_code == 201
        summary = await client.get(
            "/api/trading/period-summary",
            params={"start": "2026-01-05", "end": "2026-01-07"},
        )

    assert summary.status_code == 200
    assert summary.json()["return_curve"] == [
        {
            "date": day,
            "cumulative_return_rate": {"value": "0", "unavailable_reason": None},
        }
        for day in ["2026-01-05", "2026-01-06", "2026-01-07"]
    ]


@pytest.mark.anyio
async def test_period_summary_returns_failure_when_valuation_fails(monkeypatch) -> None:
    app = create_app(
        database=Database(),
        trading_market_provider=FakeMarketProvider([]),
        trading_calendar_provider=FakeCalendarProvider([date(2026, 1, 5)]),
        trading_clock=lambda: datetime(2026, 1, 5, 16, tzinfo=SHANGHAI),
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json={
            "name": "主账户",
            "activated_on": "2026-01-05",
            "initial_capital": "100",
        })).status_code == 201
        monkeypatch.setattr(
            "app.trading.metrics.AccountValuationService.nav_points",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("估值失败")),
        )
        summary = await client.get(
            "/api/trading/period-summary",
            params={"start": "2026-01-05", "end": "2026-01-05"},
        )

    assert summary.status_code == 500
    assert summary.json() == {
        "status": "failed",
        "error": {"code": "INTERNAL_ERROR", "message": "交易服务内部错误"},
        "retryable": True,
    }
