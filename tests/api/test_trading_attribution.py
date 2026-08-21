"""成交 × 结构位置归因：领域纯函数与端点测试。

行情夹具是一段 38 根日线的锯齿走势（2024-01-01 起，日历日连续）。顺序笔中枢
在 2024-02-06 与 2024-02-07 的时点快照上，活跃中枢都是 [7, 11]。
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from app.db import Database
from app.main import create_app
from app.trading.attribution import (
    active_center,
    adjusted_execution_price,
    attribute_executions,
    build_structure_attribution,
    classify_price,
)
from app.trading.metrics import replay_rows
from httpx import ASGITransport, AsyncClient

BASE_DAY = date(2024, 1, 1)
LAST_DAY = "2024-02-07"
ZIGZAG = [
    ("13", "12"), ("12", "11"), ("11", "10"), ("10", "9"), ("9", "8"), ("8", "7"), ("7", "6"),
    ("7.75", "6.75"), ("8.5", "7.5"), ("9.25", "8.25"), ("10", "9"), ("10.75", "9.75"),
    ("11.5", "10.5"),
    ("10.9", "9.9"), ("10.3", "9.3"), ("9.7", "8.7"), ("9.1", "8.1"), ("8.5", "7.5"), ("8", "7"),
    ("8.5", "7.5"), ("9", "8"), ("9.5", "8.5"), ("10", "9"), ("10.5", "9.5"), ("11", "10"),
    ("10.6", "9.6"), ("10.2", "9.2"), ("9.8", "8.8"), ("9.4", "8.4"), ("9", "8"), ("8.5", "7.5"),
    ("8.9", "7.9"), ("9.3", "8.3"), ("9.7", "8.7"), ("10.1", "9.1"), ("10.45", "9.45"),
    ("10.8", "9.8"),
    ("10.5", "9.5"),
]


def market_rows(*, factor: str = "1") -> list[dict]:
    """qfq 序列固定为 ZIGZAG；原始价 = qfq 价 × factor（factor≠1 模拟复权因子变化）。"""
    rows = []
    for index, (high, low) in enumerate(ZIGZAG):
        day = BASE_DAY + timedelta(days=index)
        scale = Decimal(factor)
        rows.append({
            "trade_date": day.strftime("%Y%m%d"),
            "open": str(Decimal(low) * scale),
            "high": str(Decimal(high) * scale),
            "low": str(Decimal(low) * scale),
            "close": str(Decimal(high) * scale),
            "qfq_open": low,
            "qfq_high": high,
            "qfq_low": low,
            "qfq_close": high,
            "vol": "1000",
        })
    return rows


def execution(execution_id: str, *, symbol: str, day: str, side: str, price: str,
              quantity: int = 100, time: str = "10:00:00") -> dict:
    return {
        "execution_id": execution_id,
        "symbol": symbol,
        "side": side,
        "price": price,
        "quantity": quantity,
        "fee": "0",
        "occurred_at": f"{day}T{time}+08:00",
        "created_at": f"{day}T{time}+08:00",
        "primary_reason": "structure_breakout" if side == "buy" else "take_profit",
    }


class FakeQfqProvider:
    def __init__(self, rows_by_symbol: dict[str, list[dict]]) -> None:
        self.rows_by_symbol = rows_by_symbol
        self.calls = 0

    def daily(self, symbol: str, *, as_of=None, start_date=None, end_date=None) -> list[dict]:
        self.calls += 1
        return list(self.rows_by_symbol.get(symbol, []))


def by_id(attributions):
    return {item.execution_id: item for item in attributions}


def test_classifies_above_inside_below_no_center_and_suspension() -> None:
    rows = {"600000.SH": market_rows()}
    executions = [
        execution("e-above", symbol="600000.SH", day=LAST_DAY, side="buy", price="11.5"),
        execution("e-inside", symbol="600000.SH", day=LAST_DAY, side="buy", price="10"),
        execution("e-below", symbol="600000.SH", day=LAST_DAY, side="buy", price="6.5"),
        execution("e-no-center", symbol="600000.SH", day="2024-01-06", side="buy", price="8"),
        execution("e-suspended", symbol="600000.SH", day="2024-02-08", side="buy", price="10"),
    ]

    result = by_id(attribute_executions(executions, rows))

    assert result["e-above"].category == "above_center"
    assert result["e-above"].center_lower == Decimal("7")
    assert result["e-above"].center_upper == Decimal("11")
    assert result["e-inside"].category == "inside_center"
    assert result["e-below"].category == "below_center"
    assert result["e-no-center"].category == "no_center"
    assert result["e-no-center"].reason is None
    assert result["e-suspended"].category == "unclassified"
    assert result["e-suspended"].reason == "missing_bar_on_execution_date"


def test_missing_market_data_is_unclassified_with_reason() -> None:
    executions = [execution("e-1", symbol="600001.SH", day=LAST_DAY, side="buy", price="10")]

    result = by_id(attribute_executions(executions, {"600001.SH": None}))

    assert result["e-1"].category == "unclassified"
    assert result["e-1"].reason == "missing_market_data"


def test_adjusted_price_uses_execution_day_factor_pair() -> None:
    """原始价 = qfq × 2（分红/拆股导致复权因子变化）时，先换算再与中枢比较。"""
    rows = {"600156.SH": market_rows(factor="2")}
    executions = [
        execution("e-adjusted", symbol="600156.SH", day=LAST_DAY, side="buy", price="21.6"),
    ]

    result = by_id(attribute_executions(executions, rows))

    # 21.6 × qfq_close(10.5) / close(21) = 10.8，落在顺序中枢 [7, 11] 内 → inside。
    assert result["e-adjusted"].adjusted_price == Decimal("10.8")
    assert result["e-adjusted"].category == "inside_center"
    assert result["e-adjusted"].as_dict()["adjusted_price"] == "10.8"


def test_boundary_prices_on_center_edges_count_as_inside() -> None:
    rows = {"600000.SH": market_rows()}
    executions = [
        execution("e-upper", symbol="600000.SH", day=LAST_DAY, side="buy", price="10.8"),
        execution("e-lower", symbol="600000.SH", day=LAST_DAY, side="buy", price="7.5"),
    ]

    result = by_id(attribute_executions(executions, rows))

    assert result["e-upper"].category == "inside_center"
    assert result["e-lower"].category == "inside_center"


def test_classify_price_and_active_center_units() -> None:
    centers = [
        {"start_index": 6, "end_index": 36, "lower": "7", "upper": "11"},
        {"start_index": 18, "end_index": 36, "lower": "7.5", "upper": "10.8"},
        {"start_index": 12, "end_index": 30, "lower": "7.5", "upper": "11"},
    ]
    center = active_center(centers)

    assert center is not None and center["start_index"] == 18
    assert active_center([]) is None
    assert classify_price(Decimal("10.81"), center) == "above_center"
    assert classify_price(Decimal("10.8"), center) == "inside_center"
    assert classify_price(Decimal("7.5"), center) == "inside_center"
    assert classify_price(Decimal("7.49"), center) == "below_center"
    assert adjusted_execution_price(
        Decimal("21.6"), raw_close=Decimal(21), qfq_close=Decimal("10.5")
    ) == Decimal("10.8")
    with pytest.raises(ValueError, match="原始收盘价为 0"):
        adjusted_execution_price(Decimal(10), raw_close=Decimal(0), qfq_close=Decimal(1))


def test_cycle_is_attributed_to_first_buy_and_open_cycle_skips_win_rate() -> None:
    rows = {"600000.SH": market_rows(), "000001.SZ": market_rows()}
    executions = [
        # 闭合周期：首买 inside（10），加仓 above（11.5），清仓获利。
        execution("e-first", symbol="600000.SH", day=LAST_DAY, side="buy", price="10",
                  time="09:31:00"),
        execution("e-add", symbol="600000.SH", day=LAST_DAY, side="buy", price="11.5",
                  time="10:00:00"),
        execution("e-sell", symbol="600000.SH", day=LAST_DAY, side="sell", price="11.5",
                  quantity=200, time="14:00:00"),
        # 开放周期：首买 inside，未清仓。
        execution("e-open", symbol="000001.SZ", day=LAST_DAY, side="buy", price="10"),
    ]
    ledger = replay_rows("100000", executions, [])

    result = build_structure_attribution(
        executions=executions, cycles=ledger.result.cycles, market_rows_by_symbol=rows
    )

    summary = {item["category"]: item for item in result["summary"]}
    assert summary["inside_center"] == {
        "category": "inside_center",
        "closed_cycles": 1,
        "open_cycles": 1,
        "won": 1,
        "win_rate": "1",
        "total_pnl": "150",
        "avg_pnl": "150.00",
    }
    # 加仓的 above 成交不重复归因周期。
    assert summary["above_center"]["closed_cycles"] == 0
    assert summary["above_center"]["win_rate"] is None
    assert summary["above_center"]["avg_pnl"] is None
    assert [item["execution_id"] for item in result["executions"]] == [
        "e-first", "e-add", "e-open", "e-sell",
    ]
    detail = {item["execution_id"]: item for item in result["executions"]}
    assert detail["e-add"]["category"] == "above_center"
    assert detail["e-sell"]["side"] == "sell"
    assert result["quality"] == {
        "unclassified_executions": [],
        "symbols_missing_market_data": [],
    }


def test_unclassified_cycle_and_quality_report() -> None:
    executions = [
        execution("e-first", symbol="600001.SH", day=LAST_DAY, side="buy", price="10"),
        execution("e-sell", symbol="600001.SH", day=LAST_DAY, side="sell", price="9",
                  time="14:00:00"),
    ]
    ledger = replay_rows("100000", executions, [])

    result = build_structure_attribution(
        executions=executions,
        cycles=ledger.result.cycles,
        market_rows_by_symbol={"600001.SH": None},
    )

    summary = {item["category"]: item for item in result["summary"]}
    assert summary["unclassified"]["closed_cycles"] == 1
    assert summary["unclassified"]["won"] == 0
    assert summary["unclassified"]["win_rate"] == "0"
    assert result["quality"]["symbols_missing_market_data"] == ["600001.SH"]
    assert {item["execution_id"] for item in result["quality"]["unclassified_executions"]} == {
        "e-first", "e-sell",
    }
    assert result["quality"]["unclassified_executions"][0]["reason"] == "missing_market_data"


ACCOUNT = {"name": "主账户", "activated_on": "2024-01-01", "initial_capital": "100000"}


def _api_execution(key_suffix: str, *, day: str, side: str, price: str, quantity: int = 100,
                   time: str = "10:00:00") -> dict:
    return {
        "symbol": "600000.SH",
        "name": "浦发银行",
        "executed_at": f"{day}T{time}+08:00",
        "side": side,
        "price": price,
        "quantity": quantity,
        "fee": "0",
        "primary_reason": "structure_breakout" if side == "buy" else "take_profit",
        "tags": [],
        "note": "",
        "client_idempotency_key": f"11111111-1111-4111-8111-1111111111{key_suffix}",
    }


@pytest.mark.anyio
async def test_endpoint_attributes_executions_and_caches_market_rows() -> None:
    provider = FakeQfqProvider({"600000.SH": market_rows()})
    app = create_app(database=Database(), trading_market_provider=provider)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=ACCOUNT)).status_code == 201
        for index, payload in enumerate([
            _api_execution("01", day=LAST_DAY, side="buy", price="10", time="09:31:00"),
            _api_execution("02", day=LAST_DAY, side="sell", price="11.5", time="14:00:00"),
        ]):
            assert (await client.post("/api/trading/executions", json=payload)).status_code == 201, index
        first = await client.get("/api/trading/structure-attribution")
        second = await client.get("/api/trading/structure-attribution")

    assert first.status_code == 200
    body = first.json()
    summary = {item["category"]: item for item in body["summary"]}
    assert summary["inside_center"]["closed_cycles"] == 1
    assert summary["inside_center"]["won"] == 1
    assert summary["inside_center"]["win_rate"] == "1"
    assert summary["inside_center"]["total_pnl"] == "150"
    assert len(body["executions"]) == 2
    assert body["executions"][0]["category"] == "inside_center"
    assert body["executions"][0]["adjusted_price"] == "10"
    assert body["executions"][0]["center_lower"] == "7"
    assert body["executions"][0]["center_upper"] == "11"
    assert body["quality"]["unclassified_executions"] == []
    assert second.json() == body
    assert provider.calls == 1  # 第二次请求命中 market_history_snapshots 缓存


@pytest.mark.anyio
async def test_endpoint_filters_by_period_on_first_buy_date() -> None:
    provider = FakeQfqProvider({"600000.SH": market_rows()})
    app = create_app(database=Database(), trading_market_provider=provider)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=ACCOUNT)).status_code == 201
        for payload in [
            _api_execution("01", day="2024-02-06", side="buy", price="10", time="09:31:00"),
            _api_execution("02", day="2024-02-06", side="sell", price="10.5", time="14:00:00"),
            _api_execution("03", day=LAST_DAY, side="buy", price="10", time="09:31:00"),
            _api_execution("04", day=LAST_DAY, side="sell", price="9.5", time="14:00:00"),
        ]:
            assert (await client.post("/api/trading/executions", json=payload)).status_code == 201
        everything = await client.get("/api/trading/structure-attribution")
        filtered = await client.get(
            f"/api/trading/structure-attribution?period_start={LAST_DAY}&period_end={LAST_DAY}"
        )
        invalid = await client.get(
            "/api/trading/structure-attribution?period_start=2024-02-08&period_end=2024-02-07"
        )

    all_summary = {item["category"]: item for item in everything.json()["summary"]}
    assert all_summary["inside_center"]["closed_cycles"] == 2
    body = filtered.json()
    summary = {item["category"]: item for item in body["summary"]}
    assert summary["inside_center"]["closed_cycles"] == 1
    assert summary["inside_center"]["won"] == 0
    assert summary["inside_center"]["win_rate"] == "0"
    assert [item["trade_date"] for item in body["executions"]] == [LAST_DAY, LAST_DAY]
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.anyio
async def test_endpoint_without_account_returns_404_and_empty_ledger_returns_zeroes() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing = await client.get("/api/trading/structure-attribution")
        assert (await client.post("/api/trading/account", json=ACCOUNT)).status_code == 201
        empty = await client.get("/api/trading/structure-attribution")

    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "ACCOUNT_NOT_FOUND"
    assert empty.status_code == 200
    body = empty.json()
    assert [item["category"] for item in body["summary"]] == [
        "above_center", "inside_center", "below_center", "no_center", "unclassified",
    ]
    assert all(
        item["closed_cycles"] == 0 and item["win_rate"] is None for item in body["summary"]
    )
    assert body["executions"] == []
    assert body["quality"] == {"unclassified_executions": [], "symbols_missing_market_data": []}
