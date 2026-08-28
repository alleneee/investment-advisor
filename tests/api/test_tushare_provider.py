from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from app.analysis import MarketAnalysisService
from app.main import create_app
from app.providers.tushare import MarketProviderError, TushareMarketProvider
from httpx import ASGITransport, AsyncClient


class FakeClient:
    def __init__(self):
        self.calls = []

    def daily(self, **kwargs):
        self.calls.append(("daily", kwargs))
        return [
            {"ts_code": "600000.SH", "trade_date": "20240802", "open": 10, "high": 12, "low": 9, "close": 11, "vol": 100},
            {"ts_code": "600000.SH", "trade_date": "20240801", "open": 9, "high": 10, "low": 8, "close": 9, "vol": 90},
        ]

    def adj_factor(self, **kwargs):
        return [
            {"ts_code": "600000.SH", "trade_date": "20240801", "adj_factor": 2},
            {"ts_code": "600000.SH", "trade_date": "20240802", "adj_factor": 3},
        ]

    def trade_cal(self, **kwargs):
        return [{"cal_date": "20240802", "is_open": 1}, {"cal_date": "20240803", "is_open": 0}]


class FailingClient:
    def daily(self, **kwargs):
        raise RuntimeError("api_key=diagnostic-secret")


def test_provider_qfq_and_payload_hash(monkeypatch):
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    provider = TushareMarketProvider(client=FakeClient())
    rows = provider.daily("600000.SH", as_of=date(2024, 8, 2))
    assert rows[-1]["close"] == 11
    assert rows[-1]["qfq_close"] == pytest.approx(11)
    assert len(rows[-1]["payload_hash"]) == 64


def test_provider_rejects_non_a_share_code(monkeypatch):
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    provider = TushareMarketProvider(client=FakeClient())
    with pytest.raises(ValueError):
        provider.daily("00700.HK")


def test_fake_client_does_not_require_network_token():
    provider = TushareMarketProvider(client=FakeClient())
    assert provider.client is not None


def test_provider_hides_upstream_error_details():
    provider = TushareMarketProvider(client=FailingClient())

    with pytest.raises(MarketProviderError) as error:
        provider.daily("600000.SH", as_of=date(2024, 8, 2))

    assert str(error.value) == "Tushare 数据服务调用失败"
    assert "diagnostic-secret" not in str(error.value)
    assert isinstance(error.value.__cause__, RuntimeError)


@pytest.mark.anyio
async def test_market_analysis_api_hides_upstream_error_details():
    service = MarketAnalysisService(TushareMarketProvider(client=FailingClient()))
    app = create_app(market_service=service)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/market/600000.SH/analysis",
            params={"as_of": "2024-08-02", "timeframe": "1d"},
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Tushare 数据服务调用失败"}
    assert "diagnostic-secret" not in response.text


def test_daily_and_weekly_request_five_year_window():
    as_of = date(2024, 8, 19)
    client = FakeClient()
    provider = TushareMarketProvider(client=client)

    provider.daily("600000.SH", as_of=as_of)
    provider.weekly("600000.SH", as_of=as_of)

    daily_calls = [kwargs for method, kwargs in client.calls if method == "daily"]
    assert len(daily_calls) == 2
    assert all(call["start_date"] == (as_of - timedelta(days=365 * 5)).strftime("%Y%m%d") for call in daily_calls)
    assert all(call["end_date"] == as_of.strftime("%Y%m%d") for call in daily_calls)


def test_real_client_uses_api_url_from_environment(monkeypatch):
    client = SimpleNamespace()
    tushare = SimpleNamespace(pro_api=lambda token: client)
    monkeypatch.setitem(__import__("sys").modules, "tushare", tushare)
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    monkeypatch.setenv("TUSHARE_API_URL", "https://example.test/api")

    provider = TushareMarketProvider()

    assert provider.client._DataApi__http_url == "https://example.test/api"


def test_explicit_api_url_overrides_environment(monkeypatch):
    client = SimpleNamespace()
    tushare = SimpleNamespace(pro_api=lambda token: client)
    monkeypatch.setitem(__import__("sys").modules, "tushare", tushare)
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    monkeypatch.setenv("TUSHARE_API_URL", "https://environment.test/api")

    provider = TushareMarketProvider(api_url="https://explicit.test/api")

    assert provider.client._DataApi__http_url == "https://explicit.test/api"


def test_weekly_excludes_unfinished_week(monkeypatch):
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    provider = TushareMarketProvider(client=FakeClient())
    assert provider.weekly("600000.SH", as_of=date(2024, 8, 2)) == []


def test_weekly_uses_qfq_prices_and_one_calendar_query(monkeypatch):
    class TwoWeekClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.calendar_calls = 0

        def daily(self, **kwargs):
            return [
                {"ts_code": "600000.SH", "trade_date": day, "open": 10, "high": 12, "low": 9, "close": 11, "vol": 100}
                for day in ["20240805", "20240806", "20240807", "20240808", "20240809", "20240812", "20240813", "20240814", "20240815", "20240816"]
            ]

        def adj_factor(self, **kwargs):
            return [{"trade_date": day, "adj_factor": 2} for day in ["20240805", "20240806", "20240807", "20240808", "20240809", "20240812", "20240813", "20240814", "20240815", "20240816"]]

        def trade_cal(self, **kwargs):
            self.calendar_calls += 1
            return []

    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    client = TwoWeekClient()
    provider = TushareMarketProvider(client=client)
    rows = provider.weekly("600000.SH", as_of=date(2024, 8, 19))
    assert len(rows) == 2
    assert rows[0]["open"] == pytest.approx(10)
    assert client.calendar_calls == 1


def test_stock_basic_keeps_supported_a_shares_and_drops_other_listings():
    class Client:
        def __init__(self) -> None:
            self.kwargs: dict | None = None

        def stock_basic(self, **kwargs):
            self.kwargs = kwargs
            return [
                {
                    "ts_code": "600519.SH",
                    "symbol": "600519",
                    "name": "贵州茅台",
                    "cnspell": "GZMT",
                    "exchange": "SSE",
                    "list_status": "L",
                },
                {
                    "ts_code": "430047.BJ",
                    "symbol": "430047",
                    "name": "诺思兰德",
                    "cnspell": "nsld",
                    "exchange": "BSE",
                    "list_status": "L",
                },
                {
                    "ts_code": "00700.HK",
                    "symbol": "00700",
                    "name": "腾讯控股",
                    "cnspell": "txkg",
                    "exchange": "HKEX",
                    "list_status": "L",
                },
            ]

    client = Client()
    rows = TushareMarketProvider(client=client).stock_basic()

    assert client.kwargs == {
        "list_status": "L",
        "fields": "ts_code,symbol,name,cnspell,exchange,list_status",
    }
    assert rows == [
        {
            "ts_code": "600519.SH",
            "symbol": "600519",
            "name": "贵州茅台",
            "cnspell": "gzmt",
            "exchange": "SSE",
            "list_status": "L",
        }
    ]


def test_monthly_aggregates_completed_months_from_qfq_daily():
    class Client(FakeClient):
        def daily(self, **kwargs):
            return [
                {"ts_code": "600000.SH", "trade_date": "20240731", "open": 9, "high": 10, "low": 8, "close": 9, "vol": 10, "qfq_open": 9, "qfq_high": 10, "qfq_low": 8, "qfq_close": 9},
                {"ts_code": "600000.SH", "trade_date": "20240801", "open": 10, "high": 12, "low": 9, "close": 11, "vol": 20, "qfq_open": 10, "qfq_high": 12, "qfq_low": 9, "qfq_close": 11},
                {"ts_code": "600000.SH", "trade_date": "20240802", "open": 11, "high": 13, "low": 10, "close": 12, "vol": 30, "qfq_open": 11, "qfq_high": 13, "qfq_low": 10, "qfq_close": 12},
            ]

        def adj_factor(self, **kwargs):
            return [
                {"trade_date": "20240731", "adj_factor": 1},
                {"trade_date": "20240801", "adj_factor": 1},
                {"trade_date": "20240802", "adj_factor": 1},
            ]

    rows = TushareMarketProvider(client=Client()).monthly("600000.SH", as_of=date(2024, 8, 2))
    assert len(rows) == 1
    assert rows[0]["trade_date"] == "20240731"
    assert rows[0]["qfq_open"] == 9
    assert rows[0]["qfq_close"] == 9
    assert rows[0]["vol"] == 10


def test_minutes_rebases_with_same_day_factor_and_skips_missing_day():
    class Client(FakeClient):
        def __init__(self):
            super().__init__()
            self.mins = []

        def stk_mins(self, **kwargs):
            self.mins.append(kwargs)
            return [
                {"ts_code": "600000.SH", "trade_time": "2024-08-01 10:30:00", "open": 20, "high": 22, "low": 19, "close": 21, "vol": 5},
                {"ts_code": "600000.SH", "trade_time": "2024-08-02 10:30:00", "open": 30, "high": 33, "low": 29, "close": 31, "vol": 8},
            ]

        def adj_factor(self, **kwargs):
            return [{"trade_date": "20240802", "adj_factor": 3}]

    client = Client()
    rows = TushareMarketProvider(client=client).minutes(
        "600000.SH",
        freq="30m",
        as_of=date(2024, 8, 2),
        start_date=date(2024, 8, 1),
        end_date=date(2024, 8, 2),
    )
    assert client.mins[0]["freq"] == "30min"
    assert client.mins[0]["start_date"] == "2024-08-01 09:30:00"
    assert client.mins[0]["end_date"] == "2024-08-02 15:00:00"
    by_day = {row["trade_date"]: row for row in rows}
    assert by_day["20240802"]["qfq_close"] == pytest.approx(31)
    assert "qfq_close" not in by_day["20240801"]
    assert by_day["20240801"]["close"] == 21


def test_stock_basic_hides_upstream_error_details():
    class Client:
        def stock_basic(self, **kwargs):
            raise RuntimeError("api_key=diagnostic-secret")

    with pytest.raises(MarketProviderError) as error:
        TushareMarketProvider(client=Client()).stock_basic()

    assert str(error.value) == "Tushare 数据服务调用失败"
    assert "diagnostic-secret" not in str(error.value)
