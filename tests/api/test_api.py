from datetime import UTC, date, datetime

import pytest
from app.db import Database
from app.main import create_app
from app.reporting import AgentRuntimeError, information_reference
from httpx import ASGITransport, AsyncClient


class FakeInformationService:
    def __init__(self, quality_status="ok"):
        self.quality_status = quality_status
        self.calls = []

    def get_information(self, symbol, *, limit=20, as_of=None):
        self.calls.append((symbol, limit, as_of))
        return {
            "symbol": "002940.SZ",
            "snapshot_id": "information-stable",
            "generated_at": "2026-08-13T09:00:00+08:00",
            "news": [
                {
                    "id": "news-1",
                    "title": "新闻",
                    "summary": "摘要",
                    "published_at": "2026-08-13T08:00:00+08:00",
                    "source": "东财",
                    "url": "not-yet-validated://external",
                }
            ],
            "messages": [
                {
                    "id": "irm-1",
                    "question": "问题",
                    "answer": "回答",
                    "answerer": "证券部",
                    "published_at": "2026-08-12T16:00:00+08:00",
                    "source": "cninfo",
                }
            ],
            "sentiment": {
                "hot_rank": 8,
                "heat": 9123,
                "rank_change": 2,
                "concepts": ["机器人"],
                "tag": "热股",
                "observed_at": "2026-08-13T09:00:00+08:00",
            },
            "quality": {
                "status": self.quality_status,
                "warnings": [] if self.quality_status == "ok" else ["来源降级"],
                "sources": {
                    "eastmoney_news": {
                        "status": "fresh" if self.quality_status == "ok" else "unavailable",
                        "fetched_at": "2026-08-13T09:00:00+08:00",
                    }
                },
            },
        }


class MarketServiceMustNotRun:
    def analyze(self, *args, **kwargs):
        raise AssertionError("information route must not call market service")


class FakeReportMarketService:
    def __init__(self):
        self.calls = []

    def analyze(self, symbol, *, as_of, timeframe):
        self.calls.append((symbol, as_of.isoformat(), timeframe))
        bars = [
            {
                "symbol": symbol,
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
        ]
        return {
            "market_snapshot": {
                "snapshot_id": f"market-{timeframe}",
                "source": "tushare",
                "adjustment": "qfq",
                "bars": bars,
                "window": {"start": "20260803", "end": "20260807", "bar_count": 1},
                "facts": [
                    {"id": "latest_qfq_close", "label": "最新前复权收盘", "value": 20.6}
                ],
                "quality": {"status": "ok", "warnings": []},
            },
            "chan_analysis": {
                "analysis_id": f"chan-{timeframe}",
                "engine_version": "chan-engine.v1",
                "timeframe": timeframe,
                "snapshot": {
                    "bars": bars,
                    "confirmed": [],
                    "provisional": [],
                    "centers": [],
                    "occurred_at": "2026-08-07T00:00:00+00:00",
                },
            },
        }


class RecordingScheduler:
    def __init__(self):
        self.tasks = []

    def __call__(self, task):
        self.tasks.append(task)

    def run_next(self):
        self.tasks.pop(0)()


class FakeAgentRuntimeClient:
    def __init__(
        self,
        information,
        error=None,
        resume_from_artifacts=False,
        before_error=None,
    ):
        self.information = information
        self.error = error
        self.resume_from_artifacts = resume_from_artifacts
        self.before_error = before_error
        self.calls = []

    def execute(self, *, run_id, execution_id, lease_epoch, expected_state_version):
        self.calls.append(
            {
                "run_id": run_id,
                "execution_id": execution_id,
                "lease_epoch": lease_epoch,
                "expected_state_version": expected_state_version,
            }
        )
        if self.error:
            if self.before_error:
                self.before_error(run_id)
            raise self.error
        news_ref = information_reference("news", self.information["news"][0])
        draft = _valid_runtime_draft(run_id, news_ref)
        if self.resume_from_artifacts:
            return {"state": "COMPLETED", "artifacts": {"report": draft}}
        return {"report": draft}


def _valid_runtime_draft(run_id, news_ref):
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
                    "evidence_refs": ["market.latest_close", "chan.structure", news_ref],
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
        "risks": [{"narrative": "资讯来源可能存在时效差异。", "evidence_refs": [news_ref]}],
        "evidence_refs": ["market.latest_close", "chan.structure", news_ref],
    }


@pytest.mark.anyio
async def test_cors_allows_local_web_origin():
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.options(
            "/api/watchlist",
            headers={
                "origin": "http://127.0.0.1:5173",
                "access-control-request-method": "GET",
                "access-control-request-headers": "content-type",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


@pytest.mark.anyio
async def test_watchlist_crud_and_limit():
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.post("/api/watchlist", json={"symbol": "600000.SH"})
        assert response.status_code == 201
        assert (await client.get("/api/watchlist")).json()[0]["symbol"] == "600000.SH"
        await client.delete("/api/watchlist/600000.SH")
        assert (await client.get("/api/watchlist")).json() == []


@pytest.mark.anyio
async def test_batch_report_and_review_are_replayable():
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        created = await client.post("/api/batches", json={"symbols": ["600000.SH"]})
        assert created.status_code == 201
        batch = await client.get(f"/api/batches/{created.json()['id']}")
        assert batch.status_code == 200
        run = await client.get(f"/api/runs/{created.json()['run_id']}")
        assert run.status_code == 200
        report_id = run.json()["report_id"]
        report = await client.get(f"/api/reports/{report_id}")
        assert report.status_code == 200
        review = await client.post(f"/api/reports/{report_id}/reviews", json={"decision": "accepted", "note": "ok"})
        assert review.status_code == 201


@pytest.mark.anyio
async def test_report_create_returns_202_then_poll_returns_hydrated_report():
    market = FakeReportMarketService()
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ", limit=20)
    runtime = FakeAgentRuntimeClient(information)
    scheduler = RecordingScheduler()
    instance = create_app(
        market_service=market,
        information_service=information_service,
        agent_runtime_client=runtime,
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1w"})
        assert created.status_code == 202
        assert created.json()["status"] == "queued"
        assert created.json()["cached"] is False
        report_id = created.json()["report_id"]
        queued = await client.get(f"/api/reports/{report_id}")
        assert queued.json()["status"] == "queued"
        assert set(queued.json()) == {
            "report_id",
            "status",
            "symbol",
            "timeframe",
            "as_of",
            "input_digest",
            "attempt_count",
            "review_status",
            "reviewed_at",
            "published_at",
            "share_token",
            "outcome",
            "updated_at",
            "report",
            "error",
        }

        scheduler.run_next()
        completed = await client.get(f"/api/reports/{report_id}")

    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["report"]["schema_version"] == "investment_report.v2"
    assert completed.json()["report"]["timeframe"] == "1w"
    assert completed.json()["report"]["information_snapshot"]["snapshot_id"] == "information-stable"
    assert runtime.calls[0]["lease_epoch"] == 1
    assert market.calls == [("002940.SZ", "2026-08-13", "1w")]


@pytest.mark.anyio
async def test_report_as_of_uses_shanghai_calendar_date_not_utc():
    market = FakeReportMarketService()
    information_service = FakeInformationService()
    scheduler = RecordingScheduler()
    instance = create_app(
        market_service=market,
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(information_service.get_information("002940.SZ")),
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 12, 16, 30, tzinfo=UTC),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        job = await client.get(f"/api/reports/{created.json()['report_id']}")
    assert created.status_code == 202
    assert job.json()["as_of"] == "2026-08-13"
    assert market.calls == [("002940.SZ", "2026-08-13", "1d")]
    assert information_service.calls[-1] == ("002940.SZ", 20, date(2026, 8, 13))


@pytest.mark.anyio
async def test_list_report_jobs_returns_latest_per_symbol():
    market = FakeReportMarketService()
    information_service = FakeInformationService()
    scheduler = RecordingScheduler()
    instance = create_app(
        market_service=market,
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(information_service.get_information("002940.SZ")),
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        first = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        listed = await client.get("/api/reports/jobs", params={"timeframe": "1d"})
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["report_id"] == first.json()["report_id"]
    assert rows[0]["symbol"] == "002940.SZ"
    assert rows[0]["status"] == "queued"
    assert rows[0]["outcome"] is None


@pytest.mark.anyio
async def test_list_report_jobs_archive_keeps_history_and_attaches_outcomes():
    scheduler = RecordingScheduler()
    instance = _closed_loop_app(scheduler)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        daily = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        weekly = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1w"})
        scheduler.run_next()
        scheduler.run_next()
        report_id = daily.json()["report_id"]
        await client.post(f"/api/reports/{report_id}/outcome")
        latest_daily = await client.get("/api/reports/jobs", params={"timeframe": "1d"})
        archive = await client.get("/api/reports/jobs", params={"latest_per_symbol": False})

    daily_id, weekly_id = daily.json()["report_id"], weekly.json()["report_id"]
    assert [row["report_id"] for row in latest_daily.json()] == [daily_id]
    assert {row["report_id"] for row in archive.json()} == {daily_id, weekly_id}
    attached = {row["report_id"]: row["outcome"] for row in archive.json()}
    assert attached[daily_id]["status"] == "realized"
    assert attached[weekly_id] is None


@pytest.mark.anyio
async def test_legacy_outcome_without_adjudication_is_hydrated_on_read():
    scheduler = RecordingScheduler()
    database = Database()
    instance = _closed_loop_app(scheduler, database=database)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        report_id = await _completed_report(client, scheduler)
        await client.post(f"/api/reports/{report_id}/outcome")
        stored = database.get_report_outcome(report_id)
        assert stored is not None
        stored.pop("adjudication")
        database.save_report_outcome(report_id, stored)
        assert "adjudication" not in (database.get_report_outcome(report_id) or {})

        fetched = await client.get(f"/api/reports/{report_id}/outcome")
        envelope = await client.get(f"/api/reports/{report_id}")
        jobs = await client.get("/api/reports/jobs", params={"latest_per_symbol": False})

    attached = next(row for row in jobs.json() if row["report_id"] == report_id)
    assert fetched.json()["status"] == "realized"
    assert fetched.json()["adjudication"] == "single_candidate"
    assert envelope.json()["outcome"]["adjudication"] == "single_candidate"
    assert attached["outcome"]["adjudication"] == "single_candidate"


@pytest.mark.anyio
@pytest.mark.parametrize("field", ["provider", "model", "api_key", "token", "snapshot_id", "as_of"])
async def test_report_create_rejects_browser_control_of_server_fields(field):
    instance = create_app(
        market_service=FakeReportMarketService(),
        information_service=FakeInformationService(),
        agent_runtime_client=FakeAgentRuntimeClient(FakeInformationService().get_information("002940.SZ")),
        report_scheduler=RecordingScheduler(),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.post(
            "/api/market/002940.SZ/reports",
            json={"timeframe": "1d", field: "browser-value"},
        )

    assert response.status_code == 422


@pytest.mark.anyio
async def test_completed_report_create_is_cached_and_does_not_reschedule():
    market = FakeReportMarketService()
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ")
    scheduler = RecordingScheduler()
    instance = create_app(
        market_service=market,
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(information),
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        first = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        scheduler.run_next()
        second = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})

    assert second.status_code == 200
    assert second.json() == {
        "report_id": first.json()["report_id"],
        "status": "completed",
        "cached": True,
    }
    assert scheduler.tasks == []


@pytest.mark.anyio
async def test_report_runner_resumes_completed_advisor_state_from_persisted_artifacts():
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ")
    scheduler = RecordingScheduler()
    instance = create_app(
        market_service=FakeReportMarketService(),
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(information, resume_from_artifacts=True),
        report_scheduler=scheduler,
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        scheduler.run_next()
        completed = await client.get(f"/api/reports/{created.json()['report_id']}")

    assert completed.json()["status"] == "completed"
    assert completed.json()["report"]["schema_version"] == "investment_report.v2"


@pytest.mark.anyio
async def test_retry_reuses_frozen_input_and_increments_lease():
    database = Database()
    market = FakeReportMarketService()
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ")
    scheduler = RecordingScheduler()
    def persist_partial_progress(run_id):
        state = database.get_advisor_state(run_id)
        state["state"] = "MARKET_READY"
        state["state_version"] = 1
        state["artifacts"]["market"] = {"snapshot_id": "market-progress"}
        database.save_advisor_state(state)
        state = database.get_advisor_state(run_id)
        state["state"] = "CHAN_READY"
        state["state_version"] = 2
        state["artifacts"]["chan"] = {"analysis_id": "chan-progress"}
        database.save_advisor_state(state)

    runtime = FakeAgentRuntimeClient(
        information,
        AgentRuntimeError("TIMEOUT", "请求超时", retryable=True),
        before_error=persist_partial_progress,
    )
    instance = create_app(
        database=database,
        market_service=market,
        information_service=information_service,
        agent_runtime_client=runtime,
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1w"})
        report_id = created.json()["report_id"]
        scheduler.run_next()
        failed = await client.get(f"/api/reports/{report_id}")
        assert failed.json()["error"] == {
            "code": "TIMEOUT",
            "message": "请求超时",
            "retryable": True,
        }
        retry = await client.post(f"/api/reports/{report_id}/retry")
        scheduler.run_next()

    assert retry.status_code == 202
    assert retry.json()["report_id"] == report_id
    assert retry.json() == {"report_id": report_id, "status": "queued", "cached": False}
    assert scheduler.tasks == []
    assert market.calls == [("002940.SZ", "2026-08-13", "1w")]
    assert runtime.calls[-1]["expected_state_version"] == 2


@pytest.mark.anyio
async def test_non_retryable_report_failure_cannot_retry():
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ")
    scheduler = RecordingScheduler()
    runtime = FakeAgentRuntimeClient(
        information,
        AgentRuntimeError("INVALID_MODEL_OUTPUT", "模型报告无效", retryable=False),
    )
    instance = create_app(
        market_service=FakeReportMarketService(),
        information_service=information_service,
        agent_runtime_client=runtime,
        report_scheduler=scheduler,
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        scheduler.run_next()
        response = await client.post(f"/api/reports/{created.json()['report_id']}/retry", json={})

    assert response.status_code == 409


@pytest.mark.anyio
async def test_report_retry_accepts_empty_object_and_rejects_extra_fields():
    database = Database()
    information_service = FakeInformationService()
    information = information_service.get_information("002940.SZ")
    scheduler = RecordingScheduler()
    instance = create_app(
        database=database,
        market_service=FakeReportMarketService(),
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(
            information,
            AgentRuntimeError("TIMEOUT", "请求超时", retryable=True),
        ),
        report_scheduler=scheduler,
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        report_id = created.json()["report_id"]
        scheduler.run_next()
        extra = await client.post(
            f"/api/reports/{report_id}/retry", json={"provider": "browser"}
        )
        accepted = await client.post(f"/api/reports/{report_id}/retry", json={})

    assert extra.status_code == 422
    assert accepted.status_code == 202
    assert accepted.json() == {"report_id": report_id, "status": "queued", "cached": False}


class FakeOutcomeMarketProvider:
    """展望窗口行情：锚定日与报告固化基准一致，随后走出向上突破。"""

    def __init__(self, closes=("20.80", "21.20", "21.50", "21.30", "21.60")):
        self.closes = closes
        self.calls = []

    def daily(self, code, *, as_of=None, start_date=None, end_date=None):
        self.calls.append((code, start_date.isoformat(), end_date.isoformat()))
        rows = [{"trade_date": "20260807", "close": "20.60", "qfq_close": "20.60"}]
        for index, close in enumerate(self.closes):
            rows.append(
                {
                    "trade_date": f"202608{10 + index:02d}",
                    "close": close,
                    "qfq_close": close,
                }
            )
        return rows


async def _completed_report(client, scheduler):
    created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
    scheduler.run_next()
    return created.json()["report_id"]


def _closed_loop_app(scheduler, provider=None, database=None):
    information_service = FakeInformationService()
    return create_app(
        database=database,
        market_service=FakeReportMarketService(),
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(
            information_service.get_information("002940.SZ")
        ),
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
        outcome_market_provider=provider or FakeOutcomeMarketProvider(),
        outcome_clock=lambda: datetime(2026, 9, 10, 9, tzinfo=UTC),
    )


@pytest.mark.anyio
async def test_report_publish_requires_accepted_review():
    scheduler = RecordingScheduler()
    instance = _closed_loop_app(scheduler)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        report_id = await _completed_report(client, scheduler)

        before_review = await client.post(f"/api/reports/{report_id}/publish")
        rejected = await client.post(
            f"/api/reports/{report_id}/reviews",
            json={"decision": "rejected", "reviewer": "analyst", "note": "结构证据不足"},
        )
        after_reject = await client.post(f"/api/reports/{report_id}/publish")
        accepted = await client.post(
            f"/api/reports/{report_id}/reviews",
            json={"decision": "accepted", "reviewer": "analyst"},
        )
        published = await client.post(f"/api/reports/{report_id}/publish")
        republished = await client.post(f"/api/reports/{report_id}/publish")
        listed = await client.get("/api/reports/published")
        envelope = await client.get(f"/api/reports/{report_id}")

    assert before_review.status_code == 409
    assert rejected.status_code == 201
    assert after_reject.status_code == 409
    assert accepted.status_code == 201
    assert published.status_code == 200
    assert published.json()["review_status"] == "accepted"
    assert published.json()["published_at"]
    assert republished.json()["published_at"] == published.json()["published_at"]
    assert [item["report_id"] for item in listed.json()] == [report_id]
    assert envelope.json()["review_status"] == "accepted"
    assert envelope.json()["published_at"] == published.json()["published_at"]


@pytest.mark.anyio
async def test_review_rejects_unknown_decision_and_unfinished_report():
    scheduler = RecordingScheduler()
    instance = _closed_loop_app(scheduler)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        report_id = created.json()["report_id"]
        while_queued = await client.post(
            f"/api/reports/{report_id}/reviews", json={"decision": "accepted"}
        )
        scheduler.run_next()
        invalid_decision = await client.post(
            f"/api/reports/{report_id}/reviews", json={"decision": "maybe"}
        )
        missing = await client.post(
            "/api/reports/00000000-0000-4000-8000-000000000000/reviews",
            json={"decision": "accepted"},
        )

    assert while_queued.status_code == 409
    assert invalid_decision.status_code == 422
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_report_outcome_evaluates_window_and_feeds_quality_dashboard():
    scheduler = RecordingScheduler()
    provider = FakeOutcomeMarketProvider()
    instance = _closed_loop_app(scheduler, provider)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        report_id = await _completed_report(client, scheduler)
        await client.post(f"/api/reports/{report_id}/reviews", json={"decision": "accepted"})

        before = await client.get(f"/api/reports/{report_id}/outcome")
        evaluated = await client.post(f"/api/reports/{report_id}/outcome")
        stored = await client.get(f"/api/reports/{report_id}/outcome")
        envelope = await client.get(f"/api/reports/{report_id}")
        unpublished_quality = await client.get("/api/reports/quality")
        internal_quality = await client.get("/api/reports/quality?scope=all")
        await client.post(f"/api/reports/{report_id}/publish")
        published_quality = await client.get("/api/reports/quality")

    assert before.status_code == 404
    assert evaluated.status_code == 200
    assert evaluated.json()["status"] == "realized"
    assert evaluated.json()["realized_case"] == "bullish"
    assert evaluated.json()["window"]["bar_count"] == 5
    assert provider.calls == [("002940.SZ", "2026-08-07", "2026-09-10")]
    assert stored.json()["realized_case"] == "bullish"
    assert envelope.json()["outcome"]["realized_case"] == "bullish"
    # 尚未发布时对客看板不计入，内部复盘视角能看到。
    assert unpublished_quality.json()["scope"] == "published"
    assert unpublished_quality.json()["outcome"]["evaluated"] == 0
    assert unpublished_quality.json()["review"]["decided"] == 0
    assert internal_quality.json()["outcome"]["evaluated"] == 1
    assert internal_quality.json()["review"]["decided"] == 1
    assert published_quality.json()["review"] == {
        "accepted": 1,
        "rejected": 0,
        "decided": 1,
        "accept_rate": "1.0000",
    }
    assert published_quality.json()["outcome"]["realized"] == 1
    assert published_quality.json()["outcome"]["realized_rate_over_conclusive"] == "1.0000"
    assert published_quality.json()["outcome"]["realized_rate_over_evaluated"] == "1.0000"


@pytest.mark.anyio
async def test_quality_dashboard_excludes_rejected_reports_from_client_track_record():
    scheduler = RecordingScheduler()
    instance = _closed_loop_app(scheduler)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        report_id = await _completed_report(client, scheduler)
        await client.post(f"/api/reports/{report_id}/reviews", json={"decision": "rejected"})
        await client.post(f"/api/reports/{report_id}/outcome")
        published = await client.get("/api/reports/quality")
        internal = await client.get("/api/reports/quality?scope=all")
        invalid = await client.get("/api/reports/quality?scope=everything")

    assert published.json()["outcome"]["evaluated"] == 0
    assert published.json()["review"]["rejected"] == 0
    assert internal.json()["scope"] == "all"
    assert internal.json()["outcome"]["evaluated"] == 1
    assert internal.json()["review"]["rejected"] == 1
    assert invalid.status_code == 422


@pytest.mark.anyio
async def test_report_outcome_stays_pending_before_minimum_window():
    scheduler = RecordingScheduler()
    provider = FakeOutcomeMarketProvider(closes=("20.80", "21.20"))
    instance = _closed_loop_app(scheduler, provider)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        report_id = await _completed_report(client, scheduler)
        evaluated = await client.post(f"/api/reports/{report_id}/outcome")

    assert evaluated.status_code == 200
    assert evaluated.json()["status"] == "pending"
    assert evaluated.json()["realized_case"] is None


@pytest.mark.anyio
async def test_outcome_evaluation_rejects_unfinished_and_missing_reports():
    scheduler = RecordingScheduler()
    instance = _closed_loop_app(scheduler)
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        queued = await client.post(f"/api/reports/{created.json()['report_id']}/outcome")
        missing = await client.post(
            "/api/reports/00000000-0000-4000-8000-000000000000/outcome"
        )

    assert queued.status_code == 409
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_information_endpoint_returns_complete_dto_without_market_service():
    information_service = FakeInformationService()
    instance = create_app(
        market_service=MarketServiceMustNotRun(),
        information_service=information_service,
    )
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.get("/api/market/002940.SZ/information?limit=10")

    assert response.status_code == 200
    assert response.json() == information_service.get_information("002940.SZ", limit=10)
    assert information_service.calls == [("002940.SZ", 10, None), ("002940.SZ", 10, None)]


@pytest.mark.anyio
@pytest.mark.parametrize("path", [
    "/api/market/002940.SZ/information?limit=0",
    "/api/market/002940.SZ/information?limit=21",
    "/api/market/not-a-symbol/information?limit=10",
])
async def test_information_endpoint_rejects_invalid_limit_and_symbol(path):
    instance = create_app(information_service=FakeInformationService())
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.get(path)

    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("quality_status", ["degraded", "unavailable"])
async def test_information_endpoint_returns_200_for_source_failures(quality_status):
    instance = create_app(information_service=FakeInformationService(quality_status))
    async with AsyncClient(transport=ASGITransport(app=instance), base_url="http://test") as client:
        response = await client.get("/api/market/002940.SZ/information")

    assert response.status_code == 200
    assert response.json()["quality"]["status"] == quality_status
