from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from app.db import Database
from app.main import create_app
from app.trading.metrics import AccountValuationService
from app.trading.reporting import TradingReportService
from app.trading.store import (
    ReviewLeaseConflict,
    ReviewRevisionConflict,
    TradingStore,
    TradingStoreError,
)
from httpx import ASGITransport, AsyncClient

SHANGHAI = ZoneInfo("Asia/Shanghai")


class Calendar:
    def __init__(self, days: list[str]) -> None:
        self.days = days

    def trade_cal(self, *, start_date, end_date):
        return [
            {"cal_date": day.replace("-", ""), "is_open": 1}
            for day in self.days
            if start_date.isoformat() <= day <= end_date.isoformat()
        ]


class Market:
    def __init__(self, days: list[str]) -> None:
        self.days = days

    def daily(self, symbol: str, *, start_date, end_date, as_of=None):
        start = start_date.isoformat() if hasattr(start_date, "isoformat") else start_date
        end = end_date.isoformat() if hasattr(end_date, "isoformat") else end_date
        return [
            {
                "ts_code": symbol,
                "trade_date": day.replace("-", ""),
                "open": "10",
                "high": "11",
                "low": "9",
                "close": "10",
                "vol": "1000",
            }
            for day in self.days
            if start <= day <= end
        ]


def _app(clock, scheduler, *, market=None, calendar=None, database=None):
    return create_app(
        database=database or Database(),
        trading_market_provider=market
        or Market(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]),
        trading_calendar_provider=calendar
        or Calendar(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]),
        trading_clock=lambda: clock,
        trading_report_scheduler=scheduler,
    )


async def _seed_account_and_position(client: AsyncClient, *, activated_on: str = "2026-01-05") -> None:
    assert (
        await client.post(
            "/api/trading/account",
            json={"name": "主账户", "activated_on": activated_on, "initial_capital": "100000"},
        )
    ).status_code == 201
    response = await client.post(
        "/api/trading/executions",
        json={
            "symbol": "600000.SH",
            "name": "浦发银行",
            "executed_at": f"{activated_on}T10:00:00+08:00",
            "side": "buy",
            "price": "10",
            "quantity": 100,
            "fee": "0",
            "primary_reason": "pullback_confirmation",
            "tags": [],
            "note": "",
            "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
        },
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_report_rejects_before_period_close_and_waits_for_market_watermark(
    make_isolated_database,
):
    scheduled = []
    app = _app(datetime(2026, 1, 9, 14, 59, 59, tzinfo=SHANGHAI), scheduled.append)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        early = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
    assert early.status_code == 422
    assert early.json()["error"]["code"] == "PERIOD_NOT_CLOSED"
    assert early.json()["retryable"] is False
    assert scheduled == []

    class EmptyMarket(Market):
        def daily(self, *args, **kwargs):
            return []

    scheduled.clear()
    app = _app(
        datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=EmptyMarket([]),
        database=make_isolated_database(),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        not_ready = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
    assert not_ready.status_code == 503
    assert not_ready.json()["error"]["code"] == "MARKET_DATA_NOT_READY"
    assert not_ready.json()["retryable"] is True


@pytest.mark.anyio
async def test_report_rejects_non_natural_period_boundaries():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        for body in (
            {"period_kind": "week", "period_start": "2026-01-06", "period_end": "2026-01-09"},
            {"period_kind": "month", "period_start": "2026-01-05", "period_end": "2026-01-09"},
            {"period_kind": "quarter", "period_start": "2026-01-05", "period_end": "2026-01-09"},
            {"period_kind": "year", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        ):
            response = await client.post("/api/trading/reports", json=body)
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert scheduled == []


@pytest.mark.anyio
async def test_report_is_reused_by_digest_and_task_produces_deterministic_snapshot():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        body = {"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"}
        first = await client.post("/api/trading/reports", json=body)
        replay = await client.post("/api/trading/reports", json=body)
        assert first.status_code == 202
        assert replay.status_code == 200
        assert replay.json()["report_id"] == first.json()["report_id"]
        assert len(scheduled) == 1
        scheduled.pop()()
        ready = await client.get(f"/api/trading/reports/{first.json()['report_id']}")
        history = await client.get(
            "/api/trading/reports",
            params={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )

    assert ready.status_code == 200
    result = ready.json()
    assert result["snapshot_status"] == "ready"
    assert result["deterministic_report"]["schema_version"] == "deterministic_trading_review.v1"
    assert result["deterministic_report"]["chart_bundles"][0]["adjustment"] == "none"
    assert result["deterministic_report"]["quality"]["warnings"] == ["insufficient_overall_sample"]
    assert history.status_code == 200
    assert len(history.json()) == 1


@pytest.mark.anyio
async def test_failed_report_retry_changes_attempt_but_old_lease_cannot_complete():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        assert created.status_code == 202
        scheduled.pop()()
        report_id = created.json()["report_id"]
        failed = await client.get(f"/api/trading/reports/{report_id}")
        assert failed.json()["snapshot_status"] == "ready"


@pytest.mark.anyio
async def test_daily_review_revision_outdates_report_and_creates_successor():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    body = {"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"}
    review = {
        "revision": None,
        "status": "completed",
        "invalidation_condition": "跌破前低",
        "next_day_plan": "观察成交量",
        "emotion": "calm",
        "discipline_followed": True,
        "note": "",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        first = await client.post("/api/trading/reports", json=body)
        scheduled.pop()()
        old = await client.get(f"/api/trading/reports/{first.json()['report_id']}")
        assert old.json()["is_outdated"] is False
        assert (await client.put("/api/trading/daily-reviews/2026-01-09", json=review)).status_code == 200
        outdated = await client.get(f"/api/trading/reports/{first.json()['report_id']}")
        second = await client.post("/api/trading/reports", json=body)

    assert outdated.json()["is_outdated"] is True
    assert second.status_code == 202
    assert second.json()["report_id"] != first.json()["report_id"]
    assert second.json()["report_version"] == 2
    assert second.json()["supersedes_snapshot_id"] == first.json()["snapshot_id"]


@pytest.mark.anyio
async def test_account_enabled_inside_period_is_partial_and_not_comparable():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client, activated_on="2026-01-07")
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        scheduled.pop()()
        report = await client.get(f"/api/trading/reports/{created.json()['report_id']}")

    assert report.json()["partial_period"] is True
    deterministic = report.json()["deterministic_report"]
    assert deterministic["comparison"] is None
    assert deterministic["comparison_unavailable_reason"] == "partial_period"


@pytest.mark.anyio
async def test_previous_ready_period_is_used_for_comparison():
    days = [f"2026-01-0{day}" for day in range(1, 10)]
    scheduled = []
    database = Database()
    app = _app(
        datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=Market(days),
        calendar=Calendar(days),
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client, activated_on="2026-01-01")
        account_id = (await client.get("/api/trading/account")).json()["account_id"]
        AccountValuationService(
            database,
            market_provider=Market(days),
            calendar_provider=Calendar(days),
        ).refresh_market_prices(
            account_id,
            ["600000.SH"],
            [date(2026, 1, day) for day in range(1, 10)],
        )
        previous = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-01", "period_end": "2026-01-04"},
        )
        scheduled.pop()()
        current = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        scheduled.pop()()
        report = await client.get(f"/api/trading/reports/{current.json()['report_id']}")

    assert previous.status_code == 202
    assert current.status_code == 202
    comparison = report.json()["deterministic_report"]["comparison"]
    assert comparison["previous_period"] == {
        "kind": "week",
        "start": "2026-01-01",
        "end": "2026-01-04",
    }


@pytest.mark.anyio
async def test_previous_month_with_non_trading_first_day_is_comparable():
    days = [
        day.isoformat()
        for day in (
            date(2026, 1, 2) + timedelta(days=offset)
            for offset in range((date(2026, 2, 27) - date(2026, 1, 2)).days + 1)
        )
    ]
    scheduled = []
    database = Database()
    app = _app(
        datetime(2026, 2, 28, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=Market(days),
        calendar=Calendar(days),
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client, activated_on="2026-01-02")
        previous = await client.post(
            "/api/trading/reports",
            json={"period_kind": "month", "period_start": "2026-01-01", "period_end": "2026-01-31"},
        )
        assert previous.status_code == 202
        scheduled.pop()()
        current = await client.post(
            "/api/trading/reports",
            json={"period_kind": "month", "period_start": "2026-02-01", "period_end": "2026-02-28"},
        )
        assert current.status_code == 202
        scheduled.pop()()
        report = await client.get(f"/api/trading/reports/{current.json()['report_id']}")
        history = await client.get(
            "/api/trading/reports",
            params={"period_kind": "month", "period_start": "2026-01-01", "period_end": "2026-01-31"},
        )
    comparison = report.json()["deterministic_report"]["comparison"]
    assert comparison is not None
    assert comparison["previous_period"] == {
        "kind": "month",
        "start": "2026-01-02",
        "end": "2026-01-31",
    }
    assert history.status_code == 200
    assert len(history.json()) == 1


@pytest.mark.anyio
async def test_retry_month_report_reconstructs_natural_bounds_from_effective_snapshot():
    days = [
        day.isoformat()
        for day in (
            date(2026, 1, 2) + timedelta(days=offset)
            for offset in range((date(2026, 1, 31) - date(2026, 1, 2)).days + 1)
        )
    ]
    scheduled = []
    database = Database()
    app = _app(
        datetime(2026, 2, 28, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=Market(days),
        calendar=Calendar(days),
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client, activated_on="2026-01-02")
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "month", "period_start": "2026-01-01", "period_end": "2026-01-31"},
        )
        assert created.status_code == 202
        store = TradingStore(database)
        job = store.get_review_job(created.json()["report_id"])
        claimed = store.claim_review_job(created.json()["report_id"], "owner-a")
        store.fail_review_job(
            created.json()["report_id"],
            execution_id="owner-a",
            lease_epoch=claimed["lease_epoch"],
            error={"code": "INTERNAL_ERROR", "message": "retry", "retryable": True},
        )
        assert job is not None
        retried = await client.post(f"/api/trading/reports/{created.json()['report_id']}/retry")

    assert retried.status_code == 202
    assert retried.json()["period_start"] == "2026-01-02"
    assert retried.json()["period_end"] == "2026-01-31"


@pytest.mark.anyio
async def test_previous_pending_or_outdated_period_is_not_comparable():
    days = [f"2026-01-0{day}" for day in range(1, 10)]
    scheduled = []
    app = _app(
        datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=Market(days),
        calendar=Calendar(days),
    )
    body = {"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client, activated_on="2026-01-01")
        pending = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-01", "period_end": "2026-01-04"},
        )
        assert pending.status_code == 202
        current = await client.post("/api/trading/reports", json=body)
        scheduled.pop()()
        report = await client.get(f"/api/trading/reports/{current.json()['report_id']}")

    assert report.json()["deterministic_report"]["comparison"] is None
    assert report.json()["deterministic_report"]["comparison_unavailable_reason"] == "no_previous_period"


@pytest.mark.anyio
async def test_chart_bundles_filter_period_markers_and_closed_old_symbols():
    days = [f"2026-01-0{day}" for day in range(1, 10)]
    scheduled = []
    app = _app(
        datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        market=Market(days),
        calendar=Calendar(days),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await client.post(
            "/api/trading/account",
            json={"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"},
        )
        assert account.status_code == 201
        for payload in (
            {
                "symbol": "000001.SZ",
                "name": "平安银行",
                "executed_at": "2026-01-01T10:00:00+08:00",
                "side": "buy",
                "price": "10",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "pullback_confirmation",
                "tags": [],
                "note": "",
                "client_idempotency_key": "00000000-0000-4000-8000-000000000001",
            },
            {
                "symbol": "000002.SZ",
                "name": "万科A",
                "executed_at": "2026-01-01T10:00:00+08:00",
                "side": "buy",
                "price": "10",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "pullback_confirmation",
                "tags": [],
                "note": "",
                "client_idempotency_key": "00000000-0000-4000-8000-000000000002",
            },
            {
                "symbol": "000002.SZ",
                "name": "万科A",
                "executed_at": "2026-01-02T10:00:00+08:00",
                "side": "sell",
                "price": "11",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "take_profit",
                "tags": [],
                "note": "",
                "client_idempotency_key": "00000000-0000-4000-8000-000000000003",
            },
            {
                "symbol": "600000.SH",
                "name": "浦发银行",
                "executed_at": "2026-01-05T10:00:00+08:00",
                "side": "buy",
                "price": "10",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "pullback_confirmation",
                "tags": [],
                "note": "",
                "client_idempotency_key": "00000000-0000-4000-8000-000000000004",
            },
        ):
            assert (await client.post("/api/trading/executions", json=payload)).status_code == 201
        report = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        scheduled.pop()()
        ready = await client.get(f"/api/trading/reports/{report.json()['report_id']}")

    bundles = ready.json()["deterministic_report"]["chart_bundles"]
    assert {bundle["symbol"] for bundle in bundles} == {"000001.SZ", "600000.SH"}
    assert next(bundle for bundle in bundles if bundle["symbol"] == "000001.SZ")["executions"] == []
    assert len(next(bundle for bundle in bundles if bundle["symbol"] == "600000.SH")["executions"]) == 1


@pytest.mark.anyio
async def test_frozen_input_contains_all_normalized_dependencies():
    scheduled = []
    database = Database()
    app = _app(
        datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        scheduled.append,
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        daily_review = await client.put(
            "/api/trading/daily-reviews/2026-01-09",
            json={
                "revision": None,
                "status": "completed",
                "invalidation_condition": "跌破前低",
                "next_day_plan": "观察成交量",
                "emotion": "calm",
                "discipline_followed": True,
                "note": "",
            },
        )
        assert daily_review.status_code == 200
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )

    with database.read() as connection:
        row = connection.execute(
            "SELECT frozen_input FROM trading_review_jobs WHERE review_job_id = %s",
            (created.json()["report_id"],),
        ).fetchone()
    frozen = json.loads(row["frozen_input"])
    assert {
        "executions",
        "cash_flows",
        "daily_reviews",
        "price_dependencies",
        "chart_bundles",
        "engine_version",
        "prompt_version",
        "ledger_revision",
        "daily_review_revision",
        "market_revision",
    } <= frozen.keys()
    assert frozen["row_ids"]["daily_reviews"] == [daily_review.json()["daily_review_id"]]


@pytest.mark.anyio
async def test_period_external_daily_review_revision_reuses_same_report_digest():
    scheduled = []
    app = _app(datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI), scheduled.append)
    body = {"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        first = await client.post("/api/trading/reports", json=body)
        assert first.status_code == 202
        scheduled.pop()()
        review = await client.put(
            "/api/trading/daily-reviews/2026-01-01",
            json={
                "revision": None,
                "status": "completed",
                "invalidation_condition": "无",
                "next_day_plan": "观察",
                "emotion": "calm",
                "discipline_followed": True,
                "note": "",
            },
        )
        assert review.status_code == 200
        second = await client.post("/api/trading/reports", json=body)
    assert second.status_code == 200
    assert second.json()["report_id"] == first.json()["report_id"]


def test_cross_connection_same_digest_has_one_report_owner(tmp_path):
    str(tmp_path / "reports.sqlite")
    first_store = TradingStore(Database())
    account = first_store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    second_store = TradingStore(Database())
    request = {
        "account_id": account["account_id"],
        "period_kind": "week",
        "period_start": "2026-01-05",
        "period_end": "2026-01-09",
        "input_digest": "same-digest",
        "snapshot_payload": {},
        "data_quality": "ok",
    }
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda store: store.get_or_create_review_job(request), [first_store, second_store]))

    assert sorted(result[1] for result in results) == [False, True]
    assert results[0][0]["review_job_id"] == results[1][0]["review_job_id"]


def test_get_or_create_review_job_rejects_stale_source_revisions():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    store.create_execution(
        {
            "account_id": account["account_id"],
            "client_idempotency_key": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "occurred_at": "2026-01-05T10:00:00+08:00",
            "symbol": "600000.SH",
            "side": "buy",
            "price": "10",
            "quantity": 1,
            "fee": "0",
            "primary_reason": "pullback_confirmation",
        }
    )
    with pytest.raises(ReviewRevisionConflict):
        store.get_or_create_review_job(
            {
                "account_id": account["account_id"],
                "period_kind": "week",
                "period_start": "2026-01-05",
                "period_end": "2026-01-09",
                "input_digest": "stale-revision",
                "ledger_revision": 0,
                "daily_review_revision": 0,
                "market_revision": 0,
                "snapshot_payload": {},
            }
        )
    assert store.list_review_jobs(
        account["account_id"],
        period_kind="week",
        period_start="2026-01-05",
        period_end="2026-01-09",
    ) == []


def test_old_review_schema_migrates_lease_epoch_and_snapshot_payload(tmp_path):
    database = Database()
    database.execute_script(
        """
        CREATE TABLE trading_account(
            account_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            activated_on TEXT NOT NULL,
            initial_capital TEXT NOT NULL,
            is_active INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE trading_meta(
            account_id TEXT PRIMARY KEY,
            ledger_revision INTEGER NOT NULL,
            daily_review_revision INTEGER NOT NULL,
            market_revision INTEGER NOT NULL
        );
        CREATE TABLE trading_review_jobs(
            review_job_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            period_kind TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE trading_review_snapshots(
            snapshot_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            period_kind TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            ledger_revision INTEGER NOT NULL,
            daily_review_revision INTEGER NOT NULL,
            market_revision INTEGER NOT NULL,
            is_outdated INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        INSERT INTO trading_account VALUES
            ('old-account', '主账户', '2026-01-01', '100000', 1, '2026-01-01T00:00:00+00:00');
        INSERT INTO trading_meta VALUES ('old-account', 0, 0, 0);
        """
    )
    store = TradingStore(database)
    job, created = store.get_or_create_review_job(
        {
            "account_id": "old-account",
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "old-schema",
            "snapshot_payload": {},
        }
    )
    assert created is True
    assert job["lease_epoch"] == 1
    with database.read() as connection:
        job_columns = {
            row["column_name"]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'trading_review_jobs'"
            )
        }
        snapshot_columns = {
            row["column_name"]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'trading_review_snapshots'"
            )
        }
    assert {"lease_epoch", "lease_expires_at"} <= job_columns
    assert "payload" in snapshot_columns


def test_review_store_rejects_stale_lease_and_retries_failed_job():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    request = {
        "account_id": account["account_id"],
        "period_kind": "week",
        "period_start": "2026-01-05",
        "period_end": "2026-01-09",
        "input_digest": "digest-1",
        "snapshot_payload": {"deterministic_report": {"schema_version": "deterministic_trading_review.v1"}},
        "data_quality": "ok",
    }
    job, created = store.get_or_create_review_job(request)
    assert created is True
    claimed = store.claim_review_job(job["review_job_id"], "owner-a")
    with pytest.raises(ReviewLeaseConflict):
        store.complete_review_job(
            job["review_job_id"],
            execution_id="owner-b",
            lease_epoch=claimed["lease_epoch"],
            payload={},
            data_quality="ok",
        )
    store.fail_review_job(
        job["review_job_id"],
        execution_id="owner-a",
        lease_epoch=claimed["lease_epoch"],
        error={"code": "INTERNAL_ERROR", "message": "retry", "retryable": True},
    )
    retried = store.retry_review_job(job["review_job_id"])
    assert retried["attempt"] == 2
    assert retried["lease_epoch"] == claimed["lease_epoch"] + 1
    assert retried["status"] == "pending"


def test_complete_review_job_rejects_empty_or_invalid_deterministic_payload():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    job, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "digest-invalid-payload",
            "snapshot_payload": {},
            "data_quality": "ok",
        }
    )
    claimed = store.claim_review_job(job["review_job_id"], "owner-a")
    with pytest.raises(TradingStoreError):
        store.complete_review_job(
            job["review_job_id"],
            execution_id="owner-a",
            lease_epoch=claimed["lease_epoch"],
            payload={},
            data_quality="ok",
        )


def test_report_response_removes_nested_retryable_from_failed_error():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    job, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "response-error",
            "snapshot_payload": {},
        }
    )
    claimed = store.claim_review_job(job["review_job_id"], "owner-a")
    store.fail_review_job(
        job["review_job_id"],
        execution_id="owner-a",
        lease_epoch=claimed["lease_epoch"],
        error={"code": "INTERNAL_ERROR", "message": "retry", "retryable": True},
    )
    response = TradingReportService(store).get(job["review_job_id"])
    assert response["retryable"] is True
    assert response["error"] == {"code": "INTERNAL_ERROR", "message": "retry"}


def test_run_internal_failure_persists_retryable_but_hides_nested_flag():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    job, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "run-invalid-payload",
            "snapshot_payload": {},
        }
    )
    service = TradingReportService(store)
    service._run(job["review_job_id"])
    response = service.get(job["review_job_id"])
    assert response["snapshot_status"] == "failed"
    assert response["retryable"] is True
    assert response["error"]["code"] == "INTERNAL_ERROR"
    assert "retryable" not in response["error"]


def test_new_digest_creates_successor_snapshot_version():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    base = {
        "account_id": account["account_id"],
        "period_kind": "week",
        "period_start": "2026-01-05",
        "period_end": "2026-01-09",
        "data_quality": "ok",
        "snapshot_payload": {},
    }
    first, _ = store.get_or_create_review_job(base | {"input_digest": "digest-1"})
    second, created = store.get_or_create_review_job(base | {"input_digest": "digest-2"})
    assert created is True
    assert second["report_version"] == first["report_version"] + 1
    assert second["supersedes_snapshot_id"] == first["snapshot_id"]


def test_expired_running_lease_can_be_taken_over_across_connections(tmp_path):
    str(tmp_path / "lease.sqlite")
    first_store = TradingStore(Database())
    account = first_store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    second_store = TradingStore(Database())
    job, _ = first_store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "lease-expiry",
            "snapshot_payload": {},
            "data_quality": "ok",
        }
    )
    started_at = datetime(2026, 1, 10, tzinfo=ZoneInfo("UTC"))
    first = first_store.claim_review_job(
        job["review_job_id"], "owner-a", now=started_at, lease_seconds=1
    )
    second = second_store.claim_review_job(
        job["review_job_id"],
        "owner-b",
        now=started_at + timedelta(seconds=2),
        lease_seconds=10,
    )
    assert second["lease_epoch"] == first["lease_epoch"] + 1
    assert second["execution_id"] == "owner-b"
    payload = {"deterministic_report": {"schema_version": "deterministic_trading_review.v1"}}
    with pytest.raises(ReviewLeaseConflict):
        first_store.complete_review_job(
            job["review_job_id"],
            execution_id="owner-a",
            lease_epoch=first["lease_epoch"],
            payload=payload,
            data_quality="ok",
            now=started_at + timedelta(seconds=2),
        )
    with pytest.raises(ReviewLeaseConflict):
        first_store.fail_review_job(
            job["review_job_id"],
            execution_id="owner-a",
            lease_epoch=first["lease_epoch"],
            error={"code": "INTERNAL_ERROR", "message": "late", "retryable": True},
            now=started_at + timedelta(seconds=2),
        )
    completed = second_store.complete_review_job(
        job["review_job_id"],
        execution_id="owner-b",
        lease_epoch=second["lease_epoch"],
        payload=payload,
        data_quality="ok",
        now=started_at + timedelta(seconds=3),
    )
    assert completed["status"] == "ready"


def test_market_chart_cache_persists_raw_bars_and_outdates_snapshot_on_change():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    snapshot = store.create_review_snapshot(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "market-chart-1",
            "market_watermark": json.dumps(
                {
                    "bars": [
                        {
                            "symbol": "600000.SH",
                            "trade_dates": ["2026-01-05"],
                            "refs": [{"trade_date": "2026-01-05", "bar_digest": "first"}],
                        }
                    ]
                }
            ),
        }
    )
    first_bar = {
        "symbol": "600000.SH",
        "trade_date": "2026-01-05",
        "open": "10",
        "high": "11",
        "low": "9",
        "close": "10",
        "volume": "1000",
    }
    first_revision = store.cache_market_bars(account["account_id"], [first_bar])
    assert first_revision == 1
    with store.database.read() as connection:
        cached = connection.execute(
            "SELECT open, high, low, close, volume, bar_digest FROM trading_market_prices"
        ).fetchone()
    assert dict(cached) == {
        "open": "10",
        "high": "11",
        "low": "9",
        "close": "10",
        "volume": "1000",
        "bar_digest": cached["bar_digest"],
    }
    assert store.get_review_snapshot(snapshot["snapshot_id"])["is_outdated"] is True
    second_revision = store.cache_market_bars(
        account["account_id"], [first_bar | {"high": "12"}]
    )
    assert second_revision == 2


def test_market_revision_only_outdates_snapshots_with_matching_watermark_dependency():
    store = TradingStore(Database())
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}
    )
    bars = [
        {
            "symbol": "600000.SH",
            "trade_date": "2026-01-05",
            "open": "10",
            "high": "11",
            "low": "9",
            "close": "10",
            "volume": "1000",
        },
        {
            "symbol": "600000.SH",
            "trade_date": "2026-02-05",
            "open": "10",
            "high": "11",
            "low": "9",
            "close": "10",
            "volume": "1000",
        },
    ]
    store.cache_market_bars(account["account_id"], bars)
    jan_watermark = json.dumps(
        {
            "prices": [{"symbol": "600000.SH", "valuation_date": "2026-01-05"}],
            "bars": [
                {
                    "symbol": "600000.SH",
                    "trade_dates": ["2026-01-05"],
                    "refs": [{"trade_date": "2026-01-05", "bar_digest": "jan"}],
                }
            ],
        }
    )
    feb_watermark = json.dumps(
        {
            "prices": [{"symbol": "600000.SH", "valuation_date": "2026-02-05"}],
            "bars": [
                {
                    "symbol": "600000.SH",
                    "trade_dates": ["2026-02-05"],
                    "refs": [{"trade_date": "2026-02-05", "bar_digest": "feb"}],
                }
            ],
        }
    )
    jan, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "month",
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "input_digest": "jan-market-dependency",
            "market_watermark": jan_watermark,
        }
    )
    feb, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "month",
            "period_start": "2026-02-01",
            "period_end": "2026-02-28",
            "input_digest": "feb-market-dependency",
            "market_watermark": feb_watermark,
        }
    )
    legacy = store.create_review_snapshot(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "legacy-null-market-dependency",
        }
    )

    store.cache_market_bars(account["account_id"], [bars[0] | {"high": "12"}])

    assert store.get_review_snapshot(jan["snapshot_id"])["is_outdated"] is True
    assert store.get_review_snapshot(feb["snapshot_id"])["is_outdated"] is False
    assert store.get_review_snapshot(legacy["snapshot_id"])["is_outdated"] is False


@pytest.mark.anyio
async def test_report_rejects_ledger_revision_drift_during_market_fetch():
    database = Database()
    scheduled = []

    class MutatingMarket(Market):
        def __init__(self, days):
            super().__init__(days)
            self.account_id = None
            self.mutated = False

        def daily(self, symbol: str, *, start_date, end_date, as_of=None):
            if not self.mutated:
                self.mutated = True
                TradingStore(database).create_cash_flow(
                    {
                        "account_id": self.account_id,
                        "client_idempotency_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "occurred_at": "2026-01-05T09:00:00+08:00",
                        "kind": "deposit",
                        "amount": "1",
                    }
                )
            return super().daily(symbol, start_date=start_date, end_date=end_date, as_of=as_of)

    market = MutatingMarket(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"])
    app = _app(
        datetime(2026, 1, 9, 15, tzinfo=SHANGHAI),
        scheduled.append,
        market=market,
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await client.post(
            "/api/trading/account",
            json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"},
        )
        market.account_id = account.json()["account_id"]
        execution = await client.post(
            "/api/trading/executions",
            json={
                "symbol": "600000.SH",
                "name": "浦发银行",
                "executed_at": "2026-01-05T10:00:00+08:00",
                "side": "buy",
                "price": "10",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "pullback_confirmation",
                "tags": [],
                "note": "",
                "client_idempotency_key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
        )
        assert execution.status_code == 201
        response = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REPORT_INPUT_CHANGED"
    assert response.json()["retryable"] is True
    assert scheduled == []


@pytest.mark.anyio
async def test_chart_cache_does_not_overwrite_interleaved_market_revision():
    database = Database()
    scheduled = []

    class InterleavingMarket(Market):
        def __init__(self, days):
            super().__init__(days)
            self.account_id = None
            self.calls = 0

        def daily(self, symbol: str, *, start_date, end_date, as_of=None):
            self.calls += 1
            if self.calls == 2:
                TradingStore(database).cache_market_bars(
                    self.account_id,
                    [
                        {
                            "symbol": symbol,
                            "trade_date": "2026-01-05",
                            "open": "10",
                            "high": "12",
                            "low": "9",
                            "close": "10",
                            "volume": "1000",
                        }
                    ],
                )
            return super().daily(symbol, start_date=start_date, end_date=end_date, as_of=as_of)

    market = InterleavingMarket(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"])
    app = _app(
        datetime(2026, 1, 9, 15, tzinfo=SHANGHAI),
        scheduled.append,
        market=market,
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        account = await client.post(
            "/api/trading/account",
            json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"},
        )
        market.account_id = account.json()["account_id"]
        execution = await client.post(
            "/api/trading/executions",
            json={
                "symbol": "600000.SH",
                "name": "浦发银行",
                "executed_at": "2026-01-05T10:00:00+08:00",
                "side": "buy",
                "price": "10",
                "quantity": 100,
                "fee": "0",
                "primary_reason": "pullback_confirmation",
                "tags": [],
                "note": "",
                "client_idempotency_key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            },
        )
        assert execution.status_code == 201
        response = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REPORT_INPUT_CHANGED"
    with database.read() as connection:
        cached = connection.execute(
            "SELECT high FROM trading_market_prices WHERE account_id = %s AND symbol = %s AND valuation_date = %s",
            (market.account_id, "600000.SH", "2026-01-05"),
        ).fetchone()
    assert cached["high"] == "12"
    assert scheduled == []


@pytest.mark.anyio
async def test_chart_cache_fills_missing_dates_from_provider():
    database = Database()
    scheduled = []
    market = Market(["2026-01-05"])
    calendar = Calendar(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"])
    app = _app(
        datetime(2026, 1, 9, 15, tzinfo=SHANGHAI),
        scheduled.append,
        market=market,
        calendar=calendar,
        database=database,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await _seed_account_and_position(client)
        first = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        assert first.status_code == 202
        scheduled.pop()()
        market.days.append("2026-01-06")
        second = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        assert second.status_code == 202
        scheduled.pop()()
        report = await client.get(f"/api/trading/reports/{second.json()['report_id']}")
    bars = report.json()["deterministic_report"]["chart_bundles"][0]["bars"]
    assert {bar["trade_date"] for bar in bars} >= {"2026-01-05", "2026-01-06"}
