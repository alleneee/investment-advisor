from datetime import date
from decimal import Decimal

import pytest
from app.analysis import MarketAnalysisService
from app.db import Database
from app.main import create_app
from app.providers.tushare import TushareMarketProvider
from httpx import ASGITransport, AsyncClient


class FakeAnalysisClient:
    def __init__(self):
        self.daily_calls = 0
        self.adj_factor_calls = 0

    def daily(self, **kwargs):
        self.daily_calls += 1
        return [
            {"ts_code": "600000.SH", "trade_date": "20240805", "open": 10, "high": 12, "low": 9, "close": 11, "vol": 100},
            {"ts_code": "600000.SH", "trade_date": "20240802", "open": 9, "high": 9.5, "low": 8, "close": 9, "vol": 90},
            {"ts_code": "600000.SH", "trade_date": "20240801", "open": 8, "high": 10, "low": 7, "close": 8, "vol": 80},
        ]

    def adj_factor(self, **kwargs):
        self.adj_factor_calls += 1
        return [
            {"trade_date": "20240801", "adj_factor": 2},
            {"trade_date": "20240802", "adj_factor": 2},
            {"trade_date": "20240805", "adj_factor": 2},
        ]


@pytest.mark.anyio
async def test_market_analysis_connects_tushare_to_chan_engine():
    service = MarketAnalysisService(TushareMarketProvider(client=FakeAnalysisClient()))
    app = create_app(market_service=service)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/market/600000.SH/analysis",
            params={"as_of": "2024-08-05", "timeframe": "1d"},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["market_snapshot"]["source"] == "tushare"
    assert payload["market_snapshot"]["adjustment"] == "qfq"
    assert payload["market_snapshot"]["window"]["bar_count"] == 3
    assert len(payload["market_snapshot"]["bars"]) == 3
    assert Decimal(payload["market_snapshot"]["bars"][0]["close"]) == Decimal(8)
    assert payload["chan_analysis"]["engine_version"] == "chan-engine.v1"
    assert len(payload["chan_analysis"]["snapshot"]["bars"]) < 3
    assert payload["market_snapshot"]["bars"][0]["occurred_at"].startswith("2024-08-01")
    assert payload["chan_analysis"]["snapshot"]["bars"][0]["occurred_at"].startswith("2024-08-02")


def test_market_analysis_rejects_out_of_scope_code():
    service = MarketAnalysisService(TushareMarketProvider(client=FakeAnalysisClient()))
    with pytest.raises(ValueError, match="沪深个股"):
        service.analyze("00700.HK", as_of=date(2024, 8, 5))


def test_market_analysis_persists_history_and_reuses_it_across_connections(tmp_path):
    database_path = tmp_path / "market-cache.sqlite3"
    first_database = Database(str(database_path))
    first_client = FakeAnalysisClient()
    first_service = MarketAnalysisService(
        TushareMarketProvider(client=first_client),
        history_store=first_database,
    )

    first = first_service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1d")
    second = first_service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1d")

    assert first["market_snapshot"]["snapshot_id"] == second["market_snapshot"]["snapshot_id"]
    assert first_client.daily_calls == 1
    assert first_client.adj_factor_calls == 1

    second_database = Database(str(database_path))
    offline_client = FakeAnalysisClient()
    persisted_service = MarketAnalysisService(
        TushareMarketProvider(client=offline_client),
        history_store=second_database,
    )
    persisted = persisted_service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1d")

    assert persisted["market_snapshot"]["snapshot_id"] == first["market_snapshot"]["snapshot_id"]
    assert offline_client.daily_calls == 0
    assert offline_client.adj_factor_calls == 0


def test_weekly_analysis_reuses_the_cached_daily_history():
    database = Database()
    client = FakeAnalysisClient()
    service = MarketAnalysisService(
        TushareMarketProvider(client=client),
        history_store=database,
    )

    service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1d")
    weekly = service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1w")

    assert weekly["market_snapshot"]["window"]["bar_count"] == 1
    assert client.daily_calls == 1
    assert client.adj_factor_calls == 1
