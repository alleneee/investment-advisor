import copy
import re

import pytest
from app.analysis import MarketAnalysisService
from app.db import Database
from app.main import create_app
from app.providers.tushare import TushareMarketProvider
from app.reporting import build_reference_registry
from httpx import ASGITransport, AsyncClient


class FakeRpcClient:
    def daily(self, **kwargs):
        return [
            {"ts_code": "600000.SH", "trade_date": "20240805", "open": 10, "high": 12, "low": 9, "close": 11, "vol": 100},
            {"ts_code": "600000.SH", "trade_date": "20240802", "open": 9, "high": 10, "low": 8, "close": 9, "vol": 90},
        ]

    def adj_factor(self, **kwargs):
        return [
            {"trade_date": "20240802", "adj_factor": 1},
            {"trade_date": "20240805", "adj_factor": 1},
        ]


class InformationServiceMustNotRun:
    def __init__(self):
        self.calls = 0

    def get_information(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("evidence must use the persisted snapshot")


class MarketServiceMustNotRun:
    def __init__(self):
        self.calls = 0

    def analyze(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("internal tools must use frozen snapshots")


def seed_information_state(database, snapshot):
    batch = database.create_batch(["002940.SZ"])
    state = database.get_advisor_state(batch["run_id"])
    state["state"] = "CHAN_READY"
    state["state_version"] = 1
    state["artifacts"]["chan"] = {"analysis_id": "chan-existing"}
    state["artifacts"]["information_snapshot"] = snapshot
    database.save_advisor_state(state)
    return batch["run_id"]


def information_snapshot():
    long_text = "长内容" * 300
    return {
        "symbol": "002940.SZ",
        "snapshot_id": "information-frozen",
        "generated_at": "2026-08-13T09:00:00+08:00",
        "news": [
            {
                "id": f"news-provider+id-{index}",
                "title": f"新闻 {index}",
                "summary": long_text,
                "published_at": f"2026-08-{13 - index:02d}T08:00:00+08:00",
                "source": "东财",
                "url": f"https://example.com/news/{index}?token=unsafe+value",
            }
            for index in range(7)
        ],
        "messages": [
            {
                "id": f"irm-provider+id-{index}",
                "question": f"问题 {index} {long_text}",
                "answer": None if index == 1 else f"回答 {index} {long_text}",
                "answerer": "证券部",
                "published_at": f"2026-08-{12 - index:02d}T16:00:00+08:00",
                "source": "cninfo",
            }
            for index in range(5)
        ],
        "sentiment": {
            "hot_rank": 8,
            "heat": 9123,
            "rank_change": 2,
            "concepts": ["机器人", "人工智能"],
            "tag": "热股",
            "observed_at": "2026-08-13T09:00:00+08:00",
        },
        "quality": {
            "status": "degraded",
            "warnings": ["巨潮使用旧缓存"],
            "sources": {
                "eastmoney_news": {"status": "fresh", "fetched_at": "2026-08-13T09:00:00+08:00"},
                "cninfo_irm": {"status": "stale", "fetched_at": "2026-08-13T02:00:00+08:00"},
                "ths_hot_list": {"status": "cached", "fetched_at": "2026-08-13T08:58:00+08:00"},
            },
        },
    }


def seed_frozen_report_state(database):
    market = {
        "snapshot_id": "market-frozen-weekly",
        "source": "tushare",
        "adjustment": "qfq",
        "bars": [
            {
                "symbol": "002940.SZ",
                "occurred_at": "2026-08-07T00:00:00+00:00",
                "known_at": "2026-08-07T00:00:00+00:00",
                "stable_through": "2026-08-07T00:00:00+00:00",
                "open": "20.10",
                "high": "21.00",
                "low": "19.80",
                "close": "20.60",
                "volume": "1000",
                "payload_hash": None,
            }
        ],
        "window": {"start": "20260803", "end": "20260807", "bar_count": 1},
        "facts": [
            {"id": "bar_count", "label": "K 线数量", "value": 1, "unit": "bars"},
            {"id": "latest_qfq_close", "label": "最新前复权收盘", "value": 20.6},
        ],
        "quality": {"status": "ok", "warnings": []},
    }
    chan = {
        "analysis_id": "chan-frozen-weekly",
        "engine_version": "chan-engine.v1",
        "timeframe": "1w",
        "snapshot": {
            "bars": market["bars"],
            "confirmed": [],
            "provisional": [],
            "centers": [],
            "occurred_at": "2026-08-07T00:00:00+00:00",
        },
    }
    frozen = {
        "symbol": "002940.SZ",
        "timeframe": "1w",
        "as_of": "2026-08-13",
        "market_snapshot": market,
        "chan_analysis": chan,
        "information_snapshot": information_snapshot(),
        "report_schema_version": "investment_report.v2",
        "prompt_version": "pi-advisor.v2",
        "provider": "new-api",
        "model": "glm-5.2",
    }
    frozen["reference_registry"] = build_reference_registry(frozen)
    job, _ = database.get_or_create_investment_report_job("digest-frozen", frozen)
    return job, frozen


def valid_emit_report(run_id, frozen):
    registry = frozen["reference_registry"]
    info_ref = next(ref for ref in registry if ref.startswith("news."))
    return {
        "version": "ReportDraftV2",
        "run_id": run_id,
        "title": "结构与资讯综合研判",
        "executive_summary": "结构处于等待确认阶段，资讯面提供补充观察。",
        "outlook": {
            "horizon": "5-20-trading-days",
            "direction": "uncertain",
            "confidence": "medium",
            "thesis": "后续以结构确认和失效条件作为情景切换依据。",
            "scenarios": [
                {
                    "case": "bullish",
                    "narrative": "向上结构确认后，强势情景成立。",
                    "trigger": {"operator": "break_above", "fact_ref": "market.recent_high"},
                    "invalidation": {"operator": "break_below", "fact_ref": "market.recent_low"},
                    "evidence_refs": ["market.latest_close", "chan.structure", info_ref],
                },
                {
                    "case": "base",
                    "narrative": "中枢约束仍在，基准情景保持震荡。",
                    "trigger": {"operator": "structure_confirmed", "fact_ref": "chan.structure"},
                    "invalidation": {"operator": "structure_invalidated", "fact_ref": "chan.structure"},
                    "evidence_refs": ["chan.structure"],
                },
                {
                    "case": "bearish",
                    "narrative": "向下结构确认后，弱势情景成立。",
                    "trigger": {"operator": "break_below", "fact_ref": "market.recent_low"},
                    "invalidation": {"operator": "break_above", "fact_ref": "market.recent_high"},
                    "evidence_refs": ["market.recent_low"],
                },
            ],
        },
        "risks": [{"narrative": "资讯来源可能存在时效差异。", "evidence_refs": [info_ref]}],
        "evidence_refs": ["market.latest_close", "chan.structure", info_ref],
    }


@pytest.mark.anyio
async def test_internal_rpc_uses_frozen_weekly_market_and_chan_without_provider(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, frozen = seed_frozen_report_state(database)
    database.claim_investment_report_job(job["report_id"], "exec-1")
    service = MarketServiceMustNotRun()
    app = create_app(database=database, market_service=service)
    headers = {"Authorization": "Bearer rpc-secret"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        run_id = job["run_id"]
        state = await client.get(f"/internal/v1/agent-runs/{run_id}/state")
        assert state.status_code == 401
        state = await client.get(f"/internal/v1/agent-runs/{run_id}/state", headers=headers)
        assert state.status_code == 200
        assert state.json()["state"] == "QUEUED"
        snapshot = await client.post(
            "/internal/v1/tools/fetch_market_snapshot",
            json={
                "run_id": run_id,
                "execution_id": "exec-1",
                "lease_epoch": 1,
                "expected_state_version": 0,
                "idempotency_key": "market-1",
            },
            headers=headers,
        )
        assert snapshot.status_code == 200
        assert snapshot.json()["snapshot_id"] == "market-frozen-weekly"
        assert snapshot.json()["as_of"] == "2026-08-13"
        next_state = state.json()
        next_state["state"] = "MARKET_READY"
        next_state["state_version"] = 1
        next_state["artifacts"]["market"] = snapshot.json()
        saved = await client.post(
            f"/internal/v1/agent-runs/{run_id}/state",
            json=next_state,
            headers=headers,
        )
        assert saved.status_code == 200
        chan = await client.post(
            "/internal/v1/tools/run_chan_analysis",
            json={
                "run_id": run_id,
                "execution_id": "exec-1",
                "lease_epoch": 1,
                "expected_state_version": 1,
                "idempotency_key": "chan-1",
            },
            headers=headers,
        )

    assert chan.status_code == 200
    assert chan.json()["analysis_id"] == frozen["chan_analysis"]["analysis_id"]
    assert chan.json()["evidence_refs"] == [frozen["market_snapshot"]["snapshot_id"]]
    assert service.calls == 0


@pytest.mark.anyio
async def test_internal_rpc_rejects_missing_and_wrong_bearer_when_configured(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, _ = seed_frozen_report_state(database)
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing = await client.get(f"/internal/v1/agent-runs/{job['run_id']}/state")
        wrong = await client.get(
            f"/internal/v1/agent-runs/{job['run_id']}/state",
            headers={"Authorization": "Bearer wrong"},
        )

    assert missing.status_code == 401
    assert wrong.status_code == 401


@pytest.mark.anyio
async def test_internal_rpc_is_fail_closed_when_token_is_not_configured(monkeypatch):
    monkeypatch.delenv("INTERNAL_AGENT_TOKEN", raising=False)
    database = Database()
    job, _ = seed_frozen_report_state(database)
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing = await client.get(f"/internal/v1/agent-runs/{job['run_id']}/state")
        supplied = await client.get(
            f"/internal/v1/agent-runs/{job['run_id']}/state",
            headers={"Authorization": "Bearer arbitrary"},
        )

    assert missing.status_code == 401
    assert supplied.status_code == 401


@pytest.mark.anyio
async def test_investment_tool_calls_are_fenced_by_running_lease_and_execution(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, _ = seed_frozen_report_state(database)
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    headers = {"Authorization": "Bearer rpc-secret"}
    payload = {
        "run_id": job["run_id"],
        "execution_id": "execution-a",
        "lease_epoch": 1,
        "expected_state_version": 0,
        "idempotency_key": "market-1",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        queued = await client.post(
            "/internal/v1/tools/fetch_market_snapshot", json=payload, headers=headers
        )
        database.claim_investment_report_job(job["report_id"], "execution-a")
        wrong_execution = await client.post(
            "/internal/v1/tools/fetch_market_snapshot",
            json={**payload, "execution_id": "execution-b"},
            headers=headers,
        )
        accepted = await client.post(
            "/internal/v1/tools/fetch_market_snapshot", json=payload, headers=headers
        )
        database.fail_investment_report_job(
            job["report_id"],
            1,
            {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
        )
        after_failure = await client.post(
            "/internal/v1/tools/fetch_market_snapshot", json=payload, headers=headers
        )

    assert queued.status_code == 409
    assert wrong_execution.status_code == 409
    assert accepted.status_code == 200
    assert after_failure.status_code == 409


@pytest.mark.anyio
async def test_investment_state_write_requires_running_job_and_rejects_same_version_mutation(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, _ = seed_frozen_report_state(database)
    state = database.get_advisor_state(job["run_id"])
    changed = copy.deepcopy(state)
    changed["state"] = "MARKET_READY"
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    headers = {"Authorization": "Bearer rpc-secret"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        queued = await client.post(
            f"/internal/v1/agent-runs/{job['run_id']}/state", json=state, headers=headers
        )
        database.claim_investment_report_job(job["report_id"], "execution-a")
        idempotent = await client.post(
            f"/internal/v1/agent-runs/{job['run_id']}/state", json=state, headers=headers
        )
        mutation = await client.post(
            f"/internal/v1/agent-runs/{job['run_id']}/state", json=changed, headers=headers
        )

    assert queued.status_code == 409
    assert idempotent.status_code == 200
    assert mutation.status_code == 409


@pytest.mark.anyio
async def test_internal_emit_binds_report_to_job_run(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, frozen = seed_frozen_report_state(database)
    database.claim_investment_report_job(job["report_id"], "execution-a")
    draft = valid_emit_report(job["run_id"], frozen)
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    headers = {"Authorization": "Bearer rpc-secret"}
    envelope = {
        "run_id": job["run_id"],
        "execution_id": "execution-a",
        "lease_epoch": 1,
        "expected_state_version": 0,
        "idempotency_key": "emit-1",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        accepted = await client.post(
            "/internal/v1/tools/emit_research_report",
            json={**envelope, "report": draft},
            headers=headers,
        )
        wrong = await client.post(
            "/internal/v1/tools/emit_research_report",
            json={**envelope, "report": {**draft, "run_id": "different-run"}},
            headers=headers,
        )

    assert accepted.status_code == 200
    assert wrong.status_code == 422


@pytest.mark.anyio
async def test_internal_rpc_rejects_late_state_and_emit_from_old_lease(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    job, _ = seed_frozen_report_state(database)
    database.claim_investment_report_job(job["report_id"], "execution-1")
    database.fail_investment_report_job(
        job["report_id"],
        1,
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )
    database.retry_investment_report_job(job["report_id"])
    old_state = database.get_advisor_state(job["run_id"])
    old_state["lease_epoch"] = 1
    app = create_app(database=database, market_service=MarketServiceMustNotRun())
    headers = {"Authorization": "Bearer rpc-secret"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        state_response = await client.post(
            f"/internal/v1/agent-runs/{job['run_id']}/state",
            json=old_state,
            headers=headers,
        )
        emit_response = await client.post(
            "/internal/v1/tools/emit_research_report",
            json={
                "run_id": job["run_id"],
                "execution_id": "execution-1",
                "lease_epoch": 1,
                "expected_state_version": 1,
                "idempotency_key": "emit-old",
                "report": {},
            },
            headers=headers,
        )

    assert state_response.status_code == 409
    assert emit_response.status_code == 409


@pytest.mark.anyio
async def test_internal_rpc_rejects_stale_state_version(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    service = MarketAnalysisService(TushareMarketProvider(client=FakeRpcClient()))
    app = create_app(market_service=service)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/api/batches", json={"symbols": ["600000.SH"]})
        run_id = created.json()["run_id"]
        response = await client.post(
            "/internal/v1/tools/fetch_market_snapshot",
            json={
                "run_id": run_id,
                "execution_id": "exec-1",
                "lease_epoch": 1,
                "expected_state_version": 9,
                "idempotency_key": "market-1",
            },
            headers={"Authorization": "Bearer rpc-secret"},
        )
    assert response.status_code == 409


@pytest.mark.anyio
async def test_information_evidence_uses_only_frozen_snapshot_with_safe_bounded_claims(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    snapshot = information_snapshot()
    original = copy.deepcopy(snapshot)
    run_id = seed_information_state(database, snapshot)
    information_service = InformationServiceMustNotRun()
    instance = create_app(database=database, information_service=information_service)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/tools/collect_information_evidence",
            json={
                "run_id": run_id,
                "execution_id": "exec-information",
                "lease_epoch": 1,
                "expected_state_version": 1,
                "idempotency_key": "information-1",
            },
            headers={"Authorization": "Bearer rpc-secret"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "information"
    assert body["evidence_id"] == f"information-{run_id}"
    assert len(body["claims"]) <= 10
    assert sum(claim["source_ref"].startswith("news.") for claim in body["claims"]) == 5
    assert sum(claim["source_ref"].startswith("irm.") for claim in body["claims"]) == 3
    assert sum(claim["source_ref"].startswith("hot.") for claim in body["claims"]) == 2
    assert all(len(claim["claim"]) <= 400 for claim in body["claims"])
    assert all(
        re.fullmatch(r"(?:news|irm|hot)\.[0-9a-f]+", claim["source_ref"])
        for claim in body["claims"]
    )
    assert information_service.calls == 0
    assert database.get_advisor_state(run_id)["artifacts"]["information_snapshot"] == original


@pytest.mark.anyio
async def test_information_evidence_emits_quality_when_snapshot_has_no_facts(monkeypatch):
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", "rpc-secret")
    database = Database()
    snapshot = information_snapshot()
    snapshot["news"] = []
    snapshot["messages"] = []
    snapshot["sentiment"] = {
        "hot_rank": None,
        "heat": None,
        "rank_change": None,
        "concepts": [],
        "tag": None,
        "observed_at": None,
    }
    run_id = seed_information_state(database, snapshot)
    instance = create_app(database=database, information_service=InformationServiceMustNotRun())
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/tools/collect_information_evidence",
            json={
                "run_id": run_id,
                "execution_id": "exec-empty-information",
                "lease_epoch": 1,
                "expected_state_version": 1,
                "idempotency_key": "information-empty",
            },
            headers={"Authorization": "Bearer rpc-secret"},
        )

    assert response.status_code == 200
    assert response.json()["claims"] == [
        {
            "claim": "资讯快照质量为 degraded；巨潮使用旧缓存",
            "source_ref": "information.quality",
        }
    ]
