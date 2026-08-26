from datetime import date, datetime, timedelta

import pytest
from app.chan_review import ChanReviewService
from app.main import create_app
from httpx import ASGITransport, AsyncClient


def _daily_rows():
    start = date(2024, 1, 2)
    rows = []
    price = 10
    for index in range(80):
        day = start + timedelta(days=index)
        if day.weekday() >= 5:
            continue
        price += 1 if index % 3 else -1
        rows.append(
            {
                "ts_code": "600000.SH",
                "trade_date": day.strftime("%Y%m%d"),
                "open": price,
                "high": price + 1,
                "low": price - 1,
                "close": price,
                "vol": 100,
                "qfq_open": price,
                "qfq_high": price + 1,
                "qfq_low": price - 1,
                "qfq_close": price,
            }
        )
    return rows


class FakeReviewProvider:
    def daily(self, code, **kwargs):
        return _daily_rows()

    def weekly_from_daily(self, code, rows, *, as_of):
        return rows[::5]

    def monthly_from_daily(self, code, rows, *, as_of):
        return rows[::20]

    def minutes(self, code, *, freq, as_of, start_date, end_date):
        rows = []
        stamp = datetime(2024, 8, 1, 1, 30)
        price = 10
        for index in range(90):
            price += 1 if index % 4 else -1
            rows.append(
                {
                    "ts_code": code,
                    "trade_time": stamp.isoformat(),
                    "trade_date": stamp.strftime("%Y%m%d"),
                    "open": price,
                    "high": price + 1,
                    "low": price - 1,
                    "close": price,
                    "vol": 10,
                    "qfq_open": price,
                    "qfq_high": price + 1,
                    "qfq_low": price - 1,
                    "qfq_close": price,
                }
            )
            stamp += timedelta(minutes=30)
        return rows


def test_chan_review_builds_six_frames_from_provider_rows():
    payload = ChanReviewService(FakeReviewProvider()).review("600000.SH", as_of=date(2024, 8, 2), name="浦发银行")
    assert payload["engine_version"] == "chan-engine.v1.2"
    assert payload["adjustment"] == "qfq"
    assert set(payload["frames"]) == {"1M", "1w", "1d", "60m", "30m", "15m"}
    daily = payload["frames"]["1d"]
    assert daily["available"] is True
    assert "segments" in daily["snapshot"]
    assert "segment_centers" in daily["snapshot"]
    assert "macd" in daily["snapshot"]


@pytest.mark.anyio
async def test_chan_review_api_returns_frames():
    app = create_app(chan_review_service=ChanReviewService(FakeReviewProvider()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/market/600000.SH/chan-review", params={"as_of": "2024-08-02"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["frames"]["1d"]["available"] is True
    assert payload["frames"]["1d"]["snapshot"]["trend"]["type"] in {
        "uptrend",
        "downtrend",
        "consolidation",
        "unavailable",
    }
