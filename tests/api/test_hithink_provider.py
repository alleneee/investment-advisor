from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from app.analysis import MarketAnalysisService
from app.providers.factory import (
    CompositeMarketProvider,
    create_market_provider,
    resolve_hithink_api_key,
)
from app.providers.hithink import HithinkMarketProvider
from app.providers.tushare import MarketProviderError, TushareMarketProvider

SHANGHAI = ZoneInfo("Asia/Shanghai")


def _ms(day: date, hour: int = 0) -> int:
    return int(datetime(day.year, day.month, day.day, hour, tzinfo=SHANGHAI).timestamp() * 1000)


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="https://fuyao.aicubes.cn")


def test_daily_maps_forward_adjust_and_converts_volume_to_lots():
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        assert request.headers.get("x-api-key") == "test-key"
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "success",
                "request_id": "req",
                "data": {
                    "timestamp": _ms(date(2024, 8, 2)),
                    "item": [
                        {
                            "date_ms": _ms(date(2024, 8, 1)),
                            "open_price": 10,
                            "high_price": 12,
                            "low_price": 9,
                            "close_price": 11,
                            "volume": 1000,
                        },
                        {
                            "date_ms": _ms(date(2024, 8, 2)),
                            "open_price": 11,
                            "high_price": 13,
                            "low_price": 10,
                            "close_price": 12,
                            "volume": 2500,
                        },
                        {
                            "date_ms": _ms(date(2024, 8, 5)),
                            "open_price": 12,
                            "high_price": 14,
                            "low_price": 11,
                            "close_price": 13,
                            "volume": 800,
                        },
                    ],
                },
            },
        )

    provider = HithinkMarketProvider(api_key="test-key", client=_client(handler))
    rows = provider.daily("600000.SH", as_of=date(2024, 8, 2), start_date=date(2024, 8, 1))
    assert [row["trade_date"] for row in rows] == ["20240801", "20240802"]
    assert rows[-1]["qfq_close"] == 12
    assert rows[-1]["close"] == 12
    assert rows[-1]["vol"] == 25
    assert len(rows[-1]["payload_hash"]) == 64
    params = dict(httpx.URL(captured[0].url).params)
    assert params["thscode"] == "600000.SH"
    assert params["interval"] == "1d"
    assert params["adjust"] == "forward"


def test_provider_rejects_non_a_share_code():
    provider = HithinkMarketProvider(api_key="test-key", client=_client(lambda request: httpx.Response(200, json={})))
    with pytest.raises(ValueError, match="沪深个股"):
        provider.daily("00700.HK", as_of=date(2024, 8, 2))


def test_provider_hides_upstream_error_details():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 2003, "message": "api_key=diagnostic-secret", "request_id": "x", "data": None},
        )

    provider = HithinkMarketProvider(api_key="test-key", client=_client(handler))
    with pytest.raises(MarketProviderError) as error:
        provider.daily("600000.SH", as_of=date(2024, 8, 2))
    assert str(error.value) == "同花顺数据服务调用失败"
    assert "diagnostic-secret" not in str(error.value)


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("HITHINK_FINANCE_API_KEY", raising=False)
    monkeypatch.delenv("FUYAO_API_KEY", raising=False)
    monkeypatch.delenv("FUYAO_TOKEN", raising=False)
    monkeypatch.setattr("app.providers.factory.credential_paths", list)
    with pytest.raises(MarketProviderError, match="同花顺金融数据 API Key"):
        HithinkMarketProvider(api_key=None, client=_client(lambda request: httpx.Response(200, json={})))


def test_stock_basic_paginates_and_drops_beijing_listings():
    pages = [
        [
            {"thscode": "600519.SH", "ticker": "600519", "name": "贵州茅台", "exchange": "SH", "asset_type": "a-share"},
            {"thscode": "430047.BJ", "ticker": "430047", "name": "诺思兰德", "exchange": "BJ", "asset_type": "a-share"},
        ],
        [
            {"thscode": "000001.SZ", "ticker": "000001", "name": "平安银行", "exchange": "SZ", "asset_type": "a-share"},
        ],
    ]
    offsets: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(httpx.URL(request.url).params)
        offsets.append(params.get("offset", "0"))
        page = pages[int(params.get("offset", "0")) // 2] if int(params.get("offset", "0")) < 4 else []
        return httpx.Response(200, json={"code": 0, "message": "ok", "request_id": "r", "data": {"item": page}})

    provider = HithinkMarketProvider(api_key="test-key", client=_client(handler), list_page_size=2)
    rows = provider.stock_basic()
    assert offsets == ["0", "2"]
    assert [row["ts_code"] for row in rows] == ["600519.SH", "000001.SZ"]
    assert rows[0]["name"] == "贵州茅台"
    assert rows[0]["symbol"] == "600519"


def test_minutes_are_not_supported():
    provider = HithinkMarketProvider(api_key="test-key", client=_client(lambda request: httpx.Response(200, json={})))
    with pytest.raises(MarketProviderError, match="不提供分钟"):
        provider.minutes("600000.SH", freq="30m", as_of=date(2024, 8, 2), start_date=date(2024, 8, 1), end_date=date(2024, 8, 2))


def test_search_tickers_keeps_supported_a_shares():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "request_id": "r",
                "data": {
                    "item": [
                        {"thscode": "600519.SH", "ticker": "600519", "name": "贵州茅台", "exchange": "SH", "asset_type": "a-share"},
                        {"thscode": "00700.HK", "ticker": "00700", "name": "腾讯控股", "exchange": "HK", "asset_type": "a-share"},
                    ]
                },
            },
        )

    rows = HithinkMarketProvider(api_key="test-key", client=_client(handler)).search_tickers("茅台", limit=8)
    assert rows == [{"symbol": "600519.SH", "name": "贵州茅台", "cnspell": ""}]


def test_composite_uses_hithink_daily_and_tushare_minutes():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "request_id": "r",
                "data": {
                    "item": [
                        {
                            "date_ms": _ms(date(2024, 8, 2)),
                            "open_price": 10,
                            "high_price": 11,
                            "low_price": 9,
                            "close_price": 10,
                            "volume": 100,
                        }
                    ]
                },
            },
        )

    class MinuteClient:
        def stk_mins(self, **kwargs):
            return [
                {"ts_code": "600000.SH", "trade_time": "2024-08-02 10:30:00", "open": 10, "high": 11, "low": 9, "close": 10, "vol": 8},
            ]

        def adj_factor(self, **kwargs):
            return [{"trade_date": "20240802", "adj_factor": 1}]

        def daily(self, **kwargs):
            return []

    provider = CompositeMarketProvider(
        HithinkMarketProvider(api_key="test-key", client=_client(handler)),
        TushareMarketProvider(client=MinuteClient()),
    )
    assert provider.source == "hithink"
    assert provider.daily("600000.SH", as_of=date(2024, 8, 2), start_date=date(2024, 8, 2))[0]["qfq_close"] == 10
    minutes = provider.minutes(
        "600000.SH",
        freq="30m",
        as_of=date(2024, 8, 2),
        start_date=date(2024, 8, 2),
        end_date=date(2024, 8, 2),
    )
    assert minutes[0]["qfq_close"] == pytest.approx(10)


def test_create_market_provider_auto_prefers_hithink(monkeypatch):
    monkeypatch.setenv("MARKET_PROVIDER", "auto")
    monkeypatch.setenv("HITHINK_FINANCE_API_KEY", "from-env")
    monkeypatch.delenv("TUSHARE_TOKEN", raising=False)
    provider = create_market_provider(client=_client(lambda request: httpx.Response(200, json={"code": 0, "data": {"item": []}})))
    assert getattr(provider, "source", None) == "hithink"


def test_resolve_hithink_api_key_reads_credentials_file(tmp_path, monkeypatch):
    monkeypatch.delenv("HITHINK_FINANCE_API_KEY", raising=False)
    monkeypatch.delenv("FUYAO_API_KEY", raising=False)
    monkeypatch.delenv("FUYAO_TOKEN", raising=False)
    path = tmp_path / "credentials.env"
    path.write_text('HITHINK_FINANCE_API_KEY="file-secret"\n', encoding="utf-8")
    monkeypatch.setattr("app.providers.factory.credential_paths", lambda: [path])
    assert resolve_hithink_api_key() == "file-secret"


def test_market_analysis_records_hithink_source():
    def handler(request: httpx.Request) -> httpx.Response:
        day = date(2024, 8, 1)
        items = []
        for offset in range(3):
            current = day + timedelta(days=offset)
            items.append(
                {
                    "date_ms": _ms(current),
                    "open_price": 8 + offset,
                    "high_price": 10 + offset,
                    "low_price": 7 + offset,
                    "close_price": 8 + offset,
                    "volume": 800,
                }
            )
        return httpx.Response(200, json={"code": 0, "message": "ok", "request_id": "r", "data": {"item": items}})

    service = MarketAnalysisService(HithinkMarketProvider(api_key="test-key", client=_client(handler)))
    payload = service.analyze("600000.SH", as_of=date(2024, 8, 3), timeframe="1d")
    assert payload["market_snapshot"]["source"] == "hithink"
    assert payload["market_snapshot"]["adjustment"] == "qfq"
    assert payload["chan_analysis"]["engine_version"] == "chan-engine.v1.2"
