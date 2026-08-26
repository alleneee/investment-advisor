from datetime import UTC, datetime, timedelta

import pytest
from app.db import Database
from app.main import create_app
from app.providers.tushare import MarketProviderError
from app.stock_universe import StockUniverseService, match_stocks
from httpx import ASGITransport, AsyncClient

NOW = datetime(2026, 8, 25, 9, 0, tzinfo=UTC)

UNIVERSE = [
    {
        "ts_code": "600519.SH",
        "symbol": "600519",
        "name": "贵州茅台",
        "cnspell": "gzmt",
        "exchange": "SSE",
        "list_status": "L",
    },
    {
        "ts_code": "600809.SH",
        "symbol": "600809",
        "name": "山西汾酒",
        "cnspell": "sxfj",
        "exchange": "SSE",
        "list_status": "L",
    },
    {
        "ts_code": "000858.SZ",
        "symbol": "000858",
        "name": "五粮液",
        "cnspell": "wly",
        "exchange": "SZSE",
        "list_status": "L",
    },
    {
        "ts_code": "601318.SH",
        "symbol": "601318",
        "name": "中国平安",
        "cnspell": "zgpa",
        "exchange": "SSE",
        "list_status": "L",
    },
]


def test_match_stocks_ranks_name_code_and_pinyin():
    assert [row["symbol"] for row in match_stocks(UNIVERSE, "茅台")] == ["600519.SH"]
    assert [row["symbol"] for row in match_stocks(UNIVERSE, "gzmt")] == ["600519.SH"]
    assert [row["symbol"] for row in match_stocks(UNIVERSE, "600519")] == ["600519.SH"]
    assert [row["symbol"] for row in match_stocks(UNIVERSE, "600519.SH")] == ["600519.SH"]
    assert [row["symbol"] for row in match_stocks(UNIVERSE, "600")] == ["600519.SH", "600809.SH"]


def test_match_stocks_returns_empty_for_blank_or_unknown_query():
    assert match_stocks(UNIVERSE, "  ") == []
    assert match_stocks(UNIVERSE, "不存在的公司") == []
    assert match_stocks(UNIVERSE, "x") == []


def test_match_stocks_caps_limit_at_twenty():
    rows = [
        {
            "ts_code": f"600{index:03d}.SH",
            "symbol": f"600{index:03d}",
            "name": f"测试{index}",
            "cnspell": f"cs{index}",
            "exchange": "SSE",
            "list_status": "L",
        }
        for index in range(30)
    ]
    assert len(match_stocks(rows, "测试", limit=50)) == 20


class FakeStockBasic:
    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = list(rows or UNIVERSE)
        self.calls = 0

    def stock_basic(self) -> list[dict]:
        self.calls += 1
        return list(self.rows)


class FailingStockBasic:
    def stock_basic(self) -> list[dict]:
        raise MarketProviderError("Tushare 数据服务调用失败")


class MutableClock:
    def __init__(self, value: datetime = NOW) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


def test_stock_universe_search_uses_cached_listing_within_one_day():
    provider = FakeStockBasic()
    clock = MutableClock()
    service = StockUniverseService(Database(), provider, clock=clock)

    first = service.search("茅台")
    clock.value = NOW + timedelta(hours=23)
    second = service.search("gzmt")

    assert first == [{"symbol": "600519.SH", "name": "贵州茅台", "cnspell": "gzmt"}]
    assert second == first
    assert provider.calls == 1


def test_stock_universe_search_refreshes_after_ttl_and_falls_back_to_stale_cache():
    provider = FakeStockBasic()
    clock = MutableClock()
    service = StockUniverseService(Database(), provider, clock=clock)

    service.search("茅台")
    clock.value = NOW + timedelta(hours=25)
    service.search("五粮液")
    assert provider.calls == 2

    provider.stock_basic = FailingStockBasic().stock_basic  # type: ignore[method-assign]
    clock.value = NOW + timedelta(hours=50)
    assert service.search("平安") == [{"symbol": "601318.SH", "name": "中国平安", "cnspell": "zgpa"}]


def test_stock_universe_search_without_cache_surfaces_provider_error():
    service = StockUniverseService(Database(), FailingStockBasic(), clock=MutableClock())
    with pytest.raises(MarketProviderError, match="Tushare 数据服务调用失败"):
        service.search("茅台")


@pytest.mark.anyio
async def test_stock_search_api_returns_ranked_matches():
    app = create_app(stock_universe_service=StockUniverseService(Database(), FakeStockBasic(), clock=MutableClock()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        empty = await client.get("/api/stocks", params={"q": "  "})
        matched = await client.get("/api/stocks", params={"q": "茅台"})
        missing = await client.get("/api/stocks", params={"q": "不存在"})

    assert empty.status_code == 200
    assert empty.json() == []
    assert matched.json() == [{"symbol": "600519.SH", "name": "贵州茅台", "cnspell": "gzmt"}]
    assert missing.json() == []


@pytest.mark.anyio
async def test_watchlist_includes_names_from_stock_universe():
    app = create_app(stock_universe_service=StockUniverseService(Database(), FakeStockBasic(), clock=MutableClock()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/api/watchlist", json={"symbol": "600519.SH"})
        listed = await client.get("/api/watchlist")

    assert created.json()["symbol"] == "600519.SH"
    assert created.json()["name"] == "贵州茅台"
    assert listed.json()[0]["symbol"] == "600519.SH"
    assert listed.json()[0]["name"] == "贵州茅台"


@pytest.mark.anyio
async def test_watchlist_omits_names_when_universe_is_unavailable():
    app = create_app(stock_universe_service=StockUniverseService(Database(), FailingStockBasic(), clock=MutableClock()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/api/watchlist", json={"symbol": "600519.SH"})
        listed = await client.get("/api/watchlist")

    assert created.status_code == 201
    assert created.json()["symbol"] == "600519.SH"
    assert "name" not in created.json()
    assert listed.json()[0]["symbol"] == "600519.SH"
    assert "name" not in listed.json()[0]


@pytest.mark.anyio
async def test_stock_search_api_hides_upstream_failure_when_cache_is_empty():
    app = create_app(stock_universe_service=StockUniverseService(Database(), FailingStockBasic(), clock=MutableClock()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/stocks", params={"q": "茅台"})

    assert response.status_code == 503
    assert response.json() == {"detail": "Tushare 数据服务调用失败"}
