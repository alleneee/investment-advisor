from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from app.db import Database
from app.main import create_app
from app.trading.reporting import (
    TradingReviewAgentError,
    build_trading_review_model_input,
    validate_trading_review_draft,
    validate_trading_review_model_input,
)
from app.trading.store import ReviewLeaseConflict, TradingStore
from httpx import ASGITransport, AsyncClient

SHANGHAI = ZoneInfo("Asia/Shanghai")
FIXTURES = Path(__file__).parents[2] / "tests" / "fixtures" / "trading-review"


class Calendar:
    def trade_cal(self, *, start_date, end_date):
        days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]
        return [
            {"cal_date": day.replace("-", ""), "is_open": 1}
            for day in days
            if start_date.isoformat() <= day <= end_date.isoformat()
        ]


class Market:
    def daily(self, symbol, *, start_date, end_date, as_of=None):
        days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]
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
            for day in days
            if start_date.isoformat() <= day <= end_date.isoformat()
        ]


class Agent:
    def __init__(self) -> None:
        self.calls = []
        self.error: TradingReviewAgentError | None = None

    def execute(self, *, report_id, execution_id, lease_epoch, model_input):
        self.calls.append(
            {
                "report_id": report_id,
                "execution_id": execution_id,
                "lease_epoch": lease_epoch,
                "model_input": model_input,
            }
        )
        if self.error is not None:
            raise self.error
        allowed = [
            item["ref"]
            for item in model_input["metric_registry"]
            if item["conclusion_allowed"] is True
        ]
        refs = allowed[:1]
        narrative = {"narrative": "样本结论需要持续验证", "metric_refs": refs}
        return {
            "report_id": report_id,
            "execution_id": execution_id,
            "lease_epoch": lease_epoch,
            "draft": {
                "schema_version": "trading_review_draft.v1",
                "title": "周期交易复盘",
                "profit_sources": [narrative] if refs else [],
                "loss_patterns": [narrative] if refs else [],
                "discipline_review": narrative,
                "limitations": ["样本数量有限，结论仅用于复盘假设"],
                "next_period_experiment": {
                    "hypothesis": "减少计划外操作可能改善执行一致性",
                    "action": "下一周期只执行预先定义的交易模式",
                    "measurement": "比较执行纪律与周期结果的同步变化",
                    "success_criterion": "执行纪律改善且回撤没有恶化",
                    "metric_refs": refs,
                },
            },
            "trace": {
                "session_id": "session-one",
                "attempt_count": 1,
                "usage": {"input_tokens": 10, "output_tokens": 5},
            },
        }


async def seed(client: AsyncClient) -> None:
    assert (
        await client.post(
            "/api/trading/account",
            json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"},
        )
    ).status_code == 201
    assert (
        await client.post(
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
                "tags": ["原始标签"],
                "note": "原始备注不能进入模型",
                "client_idempotency_key": "11111111-1111-4111-8111-111111111111",
            },
        )
    ).status_code == 201


def load(name: str):
    return json.loads((FIXTURES / name).read_text())


def test_python_validators_accept_and_reject_the_shared_contract_fixtures():
    model_input = load("valid-model-input.json")
    draft = load("valid-draft.json")
    assert validate_trading_review_model_input(model_input) == []
    assert validate_trading_review_draft(draft, model_input) == []
    invalid = load("invalid-cases.json")
    for item in invalid["model_input"]:
        candidate = json.loads(json.dumps(model_input))
        set_path(candidate, item["path"], item["value"])
        assert validate_trading_review_model_input(candidate), item["name"]
    for item in invalid["draft"]:
        candidate = json.loads(json.dumps(draft))
        set_path(candidate, item["path"], item["value"])
        assert validate_trading_review_draft(candidate, model_input), item["name"]


def test_python_validator_rejects_registry_values_that_contradict_source_metrics():
    model_input = load("valid-model-input.json")
    metric = next(
        item
        for item in model_input["metric_registry"]
        if item["ref"] == "account.win_rate"
    )
    metric["value"] = 0.99
    assert validate_trading_review_model_input(model_input)


def test_python_validator_rejects_duplicate_reason_groups():
    model_input = load("valid-model-input.json")
    model_input["reason_groups"].append(model_input["reason_groups"][0].copy())
    assert validate_trading_review_model_input(model_input)


def set_path(value, path: str, replacement) -> None:
    parts = path.split(".")
    cursor = value
    for part in parts[:-1]:
        cursor = cursor[int(part)] if isinstance(cursor, list) else cursor[part]
    if isinstance(cursor, list):
        index = int(parts[-1])
        if index == len(cursor):
            cursor.append(replacement)
        else:
            cursor[index] = replacement
    else:
        cursor[parts[-1]] = replacement


def test_model_input_builder_excludes_private_trading_facts():
    payload = {
        "period_kind": "week",
        "partial_period": False,
        "deterministic_report": {
            "sample": {
                "trading_day_count": 5,
                "closed_cycle_count": 1,
                "overall_conclusion_allowed": False,
            },
            "metrics": {
                "account_adjusted_return_rate": {"value": "0.01", "unavailable_reason": None},
                "period_max_drawdown_rate": {"value": "0.02", "unavailable_reason": None},
                "win_rate": {"value": "1", "unavailable_reason": None},
                "average_win_loss_ratio": {"value": None, "unavailable_reason": "no_losing_cycle"},
                "profit_factor": {"value": None, "unavailable_reason": "no_losing_cycle"},
                "median_holding_days": {"value": "2", "unavailable_reason": None},
                "median_capital_efficiency": {"value": "0.005", "unavailable_reason": None},
                "discipline_adherence_rate": {"value": "1", "unavailable_reason": None},
            },
            "reason_performance": [
                {
                    "side": "buy",
                    "reason_code": "pullback_confirmation",
                    "sample_count": 1,
                    "conclusion_allowed": False,
                    "win_rate": {"value": "1", "unavailable_reason": None},
                    "average_cycle_return_rate": {"value": "0.02", "unavailable_reason": None},
                }
            ],
            "cycle_cases": [
                {
                    "cycle_id": "stable-row-id",
                    "symbol": "600000.SH",
                    "name": "浦发银行",
                    "net_pnl": "200",
                    "cycle_return_rate": "0.02",
                    "holding_days": 2,
                    "buy_reason_code": "pullback_confirmation",
                    "sell_reason_code": "take_profit",
                    "discipline_followed": True,
                }
            ],
            "comparison": None,
            "comparison_unavailable_reason": "no_previous_period",
            "quality": {"warnings": ["insufficient_overall_sample"]},
        },
    }
    result = build_trading_review_model_input(payload)
    encoded = json.dumps(result, ensure_ascii=False)
    assert validate_trading_review_model_input(result) == []
    assert "600000" not in encoded
    assert "浦发银行" not in encoded
    assert "stable-row-id" not in encoded
    assert "net_pnl" not in encoded


@pytest.mark.anyio
async def test_deterministic_snapshot_stays_ready_when_pi_completes(make_isolated_database):
    report_tasks = []
    ai_tasks = []
    agent = Agent()
    app = create_app(
        database=make_isolated_database(),
        trading_market_provider=Market(),
        trading_calendar_provider=Calendar(),
        trading_clock=lambda: datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        trading_report_scheduler=report_tasks.append,
        trading_ai_scheduler=ai_tasks.append,
        trading_agent_runtime_client=agent,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await seed(client)
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        report_tasks.pop()()
        pending = await client.get(f"/api/trading/reports/{created.json()['report_id']}")
        assert pending.json()["snapshot_status"] == "ready"
        assert pending.json()["ai_status"] == "pending"
        ai_tasks.pop()()
        ready = await client.get(f"/api/trading/reports/{created.json()['report_id']}")
    assert ready.json()["snapshot_status"] == "ready"
    assert ready.json()["ai_status"] == "ready"
    assert ready.json()["ai_review"]["title"] == "周期交易复盘"
    encoded = json.dumps(agent.calls[0]["model_input"], ensure_ascii=False)
    assert "600000" not in encoded
    assert "浦发银行" not in encoded
    assert "原始备注" not in encoded
    assert "100000" not in encoded


@pytest.mark.anyio
async def test_ai_failure_can_retry_same_snapshot_without_new_report_version(make_isolated_database):
    report_tasks = []
    ai_tasks = []
    agent = Agent()
    agent.error = TradingReviewAgentError("MODEL_NOT_READY", "模型服务尚未就绪", retryable=True)
    database: Database = make_isolated_database()
    app = create_app(
        database=database,
        trading_market_provider=Market(),
        trading_calendar_provider=Calendar(),
        trading_clock=lambda: datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
        trading_report_scheduler=report_tasks.append,
        trading_ai_scheduler=ai_tasks.append,
        trading_agent_runtime_client=agent,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await seed(client)
        created = await client.post(
            "/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        report_tasks.pop()()
        ai_tasks.pop()()
        failed = await client.get(f"/api/trading/reports/{created.json()['report_id']}")
        agent.error = None
        retried = await client.post(f"/api/trading/reports/{created.json()['report_id']}/retry-ai", json={})
        ai_tasks.pop()()
        ready = await client.get(f"/api/trading/reports/{created.json()['report_id']}")
    assert failed.json()["snapshot_status"] == "ready"
    assert failed.json()["ai_status"] == "failed"
    assert failed.json()["error"] == {"code": "MODEL_NOT_READY", "message": "模型服务尚未就绪"}
    assert retried.status_code == 202
    assert retried.json()["report_id"] == created.json()["report_id"]
    assert retried.json()["snapshot_id"] == created.json()["snapshot_id"]
    assert retried.json()["report_version"] == 1
    assert ready.json()["ai_status"] == "ready"


def test_old_ai_lease_cannot_persist_after_retry(make_isolated_database):
    store = TradingStore(make_isolated_database())
    account = store.create_account({"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "1"})
    job, _ = store.get_or_create_review_job(
        {
            "account_id": account["account_id"],
            "period_kind": "week",
            "period_start": "2026-01-05",
            "period_end": "2026-01-09",
            "input_digest": "digest-ai-lease",
            "snapshot_payload": {
                "deterministic_report": {"schema_version": "deterministic_trading_review.v1"}
            },
        }
    )
    deterministic = store.claim_review_job(job["review_job_id"], "deterministic-owner")
    store.complete_review_job(
        job["review_job_id"],
        execution_id="deterministic-owner",
        lease_epoch=deterministic["lease_epoch"],
        payload=deterministic["snapshot_payload"],
        data_quality="ok",
        request_ai=True,
    )
    old = store.claim_ai_review_job(job["review_job_id"], "old-ai-owner")
    store.fail_ai_review_job(
        job["review_job_id"],
        execution_id="old-ai-owner",
        lease_epoch=old["ai_lease_epoch"],
        error={"code": "TIMEOUT", "message": "超时", "retryable": True},
    )
    store.retry_ai_review_job(job["review_job_id"])
    store.claim_ai_review_job(job["review_job_id"], "new-ai-owner")
    with pytest.raises(ReviewLeaseConflict):
        store.complete_ai_review_job(
            job["review_job_id"],
            execution_id="old-ai-owner",
            lease_epoch=old["ai_lease_epoch"],
            draft=load("valid-draft.json"),
            trace={},
        )
