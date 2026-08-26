from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from app.db import Database
from app.job_worker import DurableJobWorker
from app.main import create_app
from app.reporting import InvestmentReportService
from app.trading.reporting import TradingReportService
from app.trading.store import TradingStore
from fastapi.testclient import TestClient


def frozen_input() -> dict:
    return {
        "symbol": "002940.SZ",
        "timeframe": "1d",
        "as_of": "2026-08-21",
        "market_snapshot": {"snapshot_id": "market-1"},
        "chan_analysis": {"analysis_id": "chan-1"},
        "information_snapshot": {"snapshot_id": "info-1"},
        "reference_registry": {},
    }


def test_expired_investment_job_is_recoverable_and_old_owner_is_fenced(
    make_isolated_database,
):
    database: Database = make_isolated_database()
    started = datetime(2026, 8, 21, 9, 0, tzinfo=UTC)
    job, _ = database.get_or_create_investment_report_job(
        "recoverable-digest", frozen_input(), now=started
    )
    old = database.claim_investment_report_job(
        job["report_id"], "old-owner", now=started, lease_seconds=30
    )

    recoverable = database.list_recoverable_investment_report_jobs(
        now=started + timedelta(seconds=31)
    )
    assert [item["report_id"] for item in recoverable] == [job["report_id"]]
    new = database.claim_investment_report_job(
        job["report_id"],
        "new-owner",
        now=started + timedelta(seconds=31),
        lease_seconds=30,
    )
    assert new["lease_epoch"] == old["lease_epoch"] + 1
    with pytest.raises(ValueError, match="lease"):
        database.complete_investment_report_job(
            job["report_id"], old["lease_epoch"], {"stale": True}, now=started
        )


def test_services_recover_only_persisted_runnable_jobs(monkeypatch):
    class InvestmentDatabase:
        def list_recoverable_investment_report_jobs(self, *, now):
            return [{"report_id": "investment-pending"}, {"report_id": "investment-expired"}]

    investment = InvestmentReportService(
        InvestmentDatabase(), object(), object(), object(), scheduler=lambda task: task()
    )
    investment_calls = []
    monkeypatch.setattr(investment, "_run", investment_calls.append)
    investment.recover_pending()
    assert investment_calls == ["investment-pending", "investment-expired"]

    class TradingStore:
        database = object()

        def list_recoverable_review_jobs(self, *, now):
            return [
                {"review_job_id": "deterministic", "recover_stage": "deterministic"},
                {"review_job_id": "ai", "recover_stage": "ai"},
            ]

    trading = TradingReportService(
        TradingStore(),
        scheduler=lambda task: task(),
        ai_scheduler=lambda task: task(),
        agent_runtime_client=object(),
    )
    deterministic_calls = []
    ai_calls = []
    monkeypatch.setattr(trading, "_run", deterministic_calls.append)
    monkeypatch.setattr(trading, "_run_ai", ai_calls.append)
    trading.recover_pending()
    assert deterministic_calls == ["deterministic"]
    assert ai_calls == ["ai"]


def test_durable_worker_runs_immediately_and_stops_cleanly():
    called = threading.Event()
    worker = DurableJobWorker([called.set], interval_seconds=60)
    worker.start()
    assert called.wait(timeout=1)
    worker.stop()
    assert worker.is_running is False


def test_app_lifespan_recovers_a_persisted_trading_report_after_restart(
    make_isolated_database,
):
    database: Database = make_isolated_database()
    store = TradingStore(database)
    account = store.create_account(
        {"name": "主账户", "activated_on": "2026-08-18", "initial_capital": "100000"}
    )
    job, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-08-18",
            "period_end": "2026-08-21",
            "input_digest": "restart-recovery-digest",
            "ledger_revision": 0,
            "daily_review_revision": 0,
            "market_revision": 0,
            "data_as_of": "2026-08-21T15:00:00+08:00",
            "market_watermark": "market-restart",
            "data_quality": "ok",
            "frozen_input": {"row_ids": {}},
            "snapshot_payload": {
                "partial_period": False,
                "deterministic_report": {"schema_version": "deterministic_trading_review.v1"},
            },
        }
    )
    app = create_app(
        database=database,
        trading_store=store,
        trading_agent_runtime_client=None,
    )

    with TestClient(app) as client:
        deadline = time.monotonic() + 2
        payload = None
        while time.monotonic() < deadline:
            payload = client.get(f"/api/trading/reports/{job['review_job_id']}").json()
            if payload["snapshot_status"] == "ready":
                break
            time.sleep(0.02)

    assert payload is not None
    assert payload["snapshot_status"] == "ready"
    assert payload["ai_status"] == "not_requested"
