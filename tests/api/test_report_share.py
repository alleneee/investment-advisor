"""分享链接闭环：签发、公开净化视图与撤销。"""

from datetime import UTC, datetime

import pytest
from app.main import create_app
from app.reporting import information_reference
from httpx import ASGITransport, AsyncClient


class FakeInformationService:
    def get_information(self, symbol, *, limit=20, as_of=None):
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
                    "url": "https://example.com/news/1",
                }
            ],
            "messages": [],
            "sentiment": {
                "hot_rank": None,
                "heat": None,
                "rank_change": None,
                "concepts": [],
                "tag": None,
                "observed_at": None,
            },
            "quality": {
                "status": "ok",
                "warnings": [],
                "sources": {
                    "eastmoney_news": {
                        "status": "fresh",
                        "fetched_at": "2026-08-13T09:00:00+08:00",
                    }
                },
            },
        }


class FakeReportMarketService:
    def analyze(self, symbol, *, as_of, timeframe):
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
    def __init__(self, information):
        self.information = information

    def execute(self, *, run_id, execution_id, lease_epoch, expected_state_version):
        news_ref = information_reference("news", self.information["news"][0])
        return {
            "report": {
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
        }


class FakeOutcomeMarketProvider:
    """展望窗口行情：锚定日之后走出向上突破，兑现 bullish 情景。"""

    def daily(self, code, *, as_of=None, start_date=None, end_date=None):
        rows = [{"trade_date": "20260807", "close": "20.60", "qfq_close": "20.60"}]
        for index, close in enumerate(("20.80", "21.20", "21.50", "21.30", "21.60")):
            rows.append(
                {"trade_date": f"202608{10 + index:02d}", "close": close, "qfq_close": close}
            )
        return rows


def _share_app(scheduler):
    information_service = FakeInformationService()
    return create_app(
        market_service=FakeReportMarketService(),
        information_service=information_service,
        agent_runtime_client=FakeAgentRuntimeClient(
            information_service.get_information("002940.SZ")
        ),
        report_scheduler=scheduler,
        report_clock=lambda: datetime(2026, 8, 13, 10, tzinfo=UTC),
        outcome_market_provider=FakeOutcomeMarketProvider(),
        outcome_clock=lambda: datetime(2026, 9, 10, 9, tzinfo=UTC),
    )


async def _completed_report(client, scheduler):
    created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
    scheduler.run_next()
    return created.json()["report_id"]


async def _published_report(client, scheduler):
    report_id = await _completed_report(client, scheduler)
    await client.post(f"/api/reports/{report_id}/reviews", json={"decision": "accepted"})
    await client.post(f"/api/reports/{report_id}/publish")
    return report_id


@pytest.mark.anyio
async def test_share_requires_published_report():
    scheduler = RecordingScheduler()
    async with AsyncClient(
        transport=ASGITransport(app=_share_app(scheduler)), base_url="http://test"
    ) as client:
        created = await client.post("/api/market/002940.SZ/reports", json={"timeframe": "1d"})
        report_id = created.json()["report_id"]
        while_queued = await client.post(f"/api/reports/{report_id}/share")
        scheduler.run_next()
        completed_unpublished = await client.post(f"/api/reports/{report_id}/share")
        await client.post(f"/api/reports/{report_id}/reviews", json={"decision": "accepted"})
        reviewed_unpublished = await client.post(f"/api/reports/{report_id}/share")
        missing = await client.post(
            "/api/reports/00000000-0000-4000-8000-000000000000/share"
        )

    assert while_queued.status_code == 409
    assert completed_unpublished.status_code == 409
    assert reviewed_unpublished.status_code == 409
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_share_is_idempotent_and_exposed_in_workbench_envelope():
    scheduler = RecordingScheduler()
    async with AsyncClient(
        transport=ASGITransport(app=_share_app(scheduler)), base_url="http://test"
    ) as client:
        report_id = await _published_report(client, scheduler)
        created = await client.post(f"/api/reports/{report_id}/share")
        repeated = await client.post(f"/api/reports/{report_id}/share")
        envelope = await client.get(f"/api/reports/{report_id}")

    assert created.status_code == 201
    token = created.json()["share_token"]
    assert token
    assert created.json() == {
        "report_id": report_id,
        "share_token": token,
        "share_url_path": f"#/share/{token}",
    }
    assert repeated.status_code == 200
    assert repeated.json()["share_token"] == token
    assert envelope.json()["share_token"] == token


@pytest.mark.anyio
async def test_shared_view_is_sanitized_field_by_field():
    scheduler = RecordingScheduler()
    async with AsyncClient(
        transport=ASGITransport(app=_share_app(scheduler)), base_url="http://test"
    ) as client:
        report_id = await _published_report(client, scheduler)
        share = await client.post(f"/api/reports/{report_id}/share")
        shared = await client.get(f"/api/shared/{share.json()['share_token']}")

    assert shared.status_code == 200
    view = shared.json()
    # 白名单：净化视图只允许这些顶层字段。
    assert set(view) == {
        "symbol",
        "timeframe",
        "as_of",
        "generated_at",
        "published_at",
        "title",
        "executive_summary",
        "outlook",
        "risks",
        "evidence",
        "disclaimer",
        "market_snapshot",
        "chan_analysis",
        "outcome",
    }
    # 逐字段断言剔除项：任务/执行内部字段绝不外泄。
    for forbidden in (
        "report_id",
        "input_digest",
        "run_id",
        "frozen_input",
        "lease_epoch",
        "execution_id",
        "attempt_count",
        "status",
        "error",
        "review_status",
        "reviewed_at",
        "review",
        "draft",
        "reference_registry",
        "information_snapshot",
        "share_token",
        "created_at",
        "updated_at",
        "started_at",
        "completed_at",
    ):
        assert forbidden not in view, forbidden
    # 嵌套快照同样净化：只保留图表所需数据。
    assert set(view["market_snapshot"]) == {"bars", "window", "quality"}
    assert set(view["chan_analysis"]) == {"timeframe", "snapshot"}
    assert view["market_snapshot"]["bars"][0]["close"] == "20.60"
    assert view["chan_analysis"]["snapshot"]["confirmed"] == []
    # 报告正文保持水合形态：情景条件带完整事实，证据带标签与链接。
    assert view["title"] == "结构与资讯综合研判"
    assert view["disclaimer"] == "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。"
    scenarios = view["outlook"]["scenarios"]
    assert [scenario["case"] for scenario in scenarios] == ["bullish", "base", "bearish"]
    assert scenarios[0]["trigger"]["fact"]["value"] == "21.00"
    assert any(fact.get("url") == "https://example.com/news/1" for fact in view["evidence"])
    assert view["outcome"] is None


@pytest.mark.anyio
async def test_shared_view_includes_sanitized_outcome_when_evaluated():
    scheduler = RecordingScheduler()
    async with AsyncClient(
        transport=ASGITransport(app=_share_app(scheduler)), base_url="http://test"
    ) as client:
        report_id = await _published_report(client, scheduler)
        share = await client.post(f"/api/reports/{report_id}/share")
        await client.post(f"/api/reports/{report_id}/outcome")
        shared = await client.get(f"/api/shared/{share.json()['share_token']}")

    outcome = shared.json()["outcome"]
    assert set(outcome) == {"status", "realized_case", "evaluated_at", "window", "quality"}
    assert outcome["status"] == "realized"
    assert outcome["realized_case"] == "bullish"
    assert outcome["window"]["bar_count"] == 5
    assert outcome["window"]["required_bars"] == 20
    # 窗口未走满时的质量告警属于对客信息，保留在净化视图里。
    assert "展望窗口尚未走满二十个交易日" in outcome["quality"]["warnings"]
    assert "report_id" not in outcome
    assert "scenarios" not in outcome
    assert "adjudication" not in outcome


@pytest.mark.anyio
async def test_revoked_share_returns_404_and_reissue_rotates_token():
    scheduler = RecordingScheduler()
    async with AsyncClient(
        transport=ASGITransport(app=_share_app(scheduler)), base_url="http://test"
    ) as client:
        report_id = await _published_report(client, scheduler)
        share = await client.post(f"/api/reports/{report_id}/share")
        token = share.json()["share_token"]
        revoked = await client.delete(f"/api/reports/{report_id}/share")
        revoked_again = await client.delete(f"/api/reports/{report_id}/share")
        revoked_missing = await client.delete(
            "/api/reports/00000000-0000-4000-8000-000000000000/share"
        )
        after_revoke = await client.get(f"/api/shared/{token}")
        invalid_token = await client.get("/api/shared/not-a-token")
        reissued = await client.post(f"/api/reports/{report_id}/share")
        old_token_still_dead = await client.get(f"/api/shared/{token}")
        new_token_live = await client.get(f"/api/shared/{reissued.json()['share_token']}")

    assert revoked.status_code == 204
    assert revoked_again.status_code == 204
    assert revoked_missing.status_code == 204
    assert after_revoke.status_code == 404
    assert invalid_token.status_code == 404
    assert reissued.status_code == 201
    assert reissued.json()["share_token"] != token
    assert old_token_still_dead.status_code == 404
    assert new_token_live.status_code == 200
