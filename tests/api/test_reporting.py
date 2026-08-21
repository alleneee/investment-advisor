import copy
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from threading import Barrier

import psycopg
import pytest
from app.db import Database
from app.reporting import (
    PROMPT_VERSION,
    build_input_digest,
    build_reference_registry,
    hydrate_report,
    information_reference,
    validate_report_draft_v2,
)

DIGEST_INPUT = {
    "symbol": "002940.SZ",
    "timeframe": "1w",
    "as_of": "2026-08-13",
    "market_snapshot_id": "market-stable",
    "chan_analysis_id": "chan-stable",
    "information_snapshot_id": "information-stable",
    "chan_engine_version": "chan-engine.v1",
    "report_schema_version": "investment_report.v2",
    "prompt_version": PROMPT_VERSION,
    "provider": "new-api",
    "model": "glm-5.2",
}


def frozen_input():
    information = {
        "symbol": "002940.SZ",
        "snapshot_id": "information-stable",
        "generated_at": "2026-08-13T09:00:00+08:00",
        "news": [
            {
                "id": "news-1",
                "title": "公司发布经营进展",
                "summary": "经营保持稳定",
                "published_at": "2026-08-13T08:00:00+08:00",
                "source": "东财",
                "url": "https://example.com/news/1",
            }
        ],
        "messages": [
            {
                "id": "irm-1",
                "question": "产能进展如何",
                "answer": "按计划推进",
                "answerer": "证券部",
                "published_at": "2026-08-12T16:00:00+08:00",
                "source": "cninfo",
            }
        ],
        "sentiment": {
            "hot_rank": 8,
            "heat": 9123,
            "rank_change": 2,
            "concepts": ["医药"],
            "tag": "热股",
            "observed_at": "2026-08-13T09:00:00+08:00",
        },
        "quality": {"status": "ok", "warnings": [], "sources": {}},
    }
    market = {
        "snapshot_id": "market-stable",
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
            {"id": "latest_trade_date", "label": "最新交易日", "value": "20260807"},
            {"id": "latest_qfq_close", "label": "最新前复权收盘", "value": 20.6},
        ],
        "quality": {"status": "degraded", "warnings": ["样本较少"]},
    }
    chan = {
        "analysis_id": "chan-stable",
        "engine_version": "chan-engine.v1",
        "timeframe": "1w",
        "snapshot": {
            "bars": market["bars"],
            "fractals": [],
            "strokes": [],
            "confirmed": [],
            "provisional": [],
            "centers": [
                {
                    "start_index": 0,
                    "end_index": 0,
                    "lower": "19.80",
                    "upper": "21.00",
                    "occurred_at": "2026-08-07T00:00:00+00:00",
                }
            ],
            "occurred_at": "2026-08-07T00:00:00+00:00",
            "known_at": "2026-08-07T00:00:00+00:00",
            "stable_through": "2026-08-07T00:00:00+00:00",
            "gaps": [],
        },
    }
    result = {
        "symbol": "002940.SZ",
        "timeframe": "1w",
        "as_of": "2026-08-13",
        "market_snapshot": market,
        "chan_analysis": chan,
        "information_snapshot": information,
        "report_schema_version": "investment_report.v2",
        "prompt_version": PROMPT_VERSION,
        "provider": "new-api",
        "model": "glm-5.2",
    }
    result["reference_registry"] = build_reference_registry(result)
    return result


def valid_draft(run_id, frozen):
    registry = frozen["reference_registry"]
    news_ref = next(ref for ref in registry if ref.startswith("news."))
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


def test_input_digest_is_canonical_and_covers_every_declared_field():
    expected = build_input_digest(DIGEST_INPUT)
    assert build_input_digest(dict(reversed(list(DIGEST_INPUT.items())))) == expected
    assert len(expected) == 64

    for field in DIGEST_INPUT:
        changed = copy.deepcopy(DIGEST_INPUT)
        changed[field] = f"different-{field}"
        assert build_input_digest(changed) != expected, field


def test_prompt_version_invalidates_pre_iso_reference_jobs():
    previous = {**DIGEST_INPUT, "prompt_version": "pi-advisor.v2"}

    assert PROMPT_VERSION == "pi-advisor.v2.1"
    assert build_input_digest(DIGEST_INPUT) != build_input_digest(previous)


def _bar(index, *, high, low, close):
    occurred_at = f"{(date(2026, 1, 1) + timedelta(days=index)).isoformat()}T00:00:00+00:00"
    return {
        "symbol": "002940.SZ",
        "occurred_at": occurred_at,
        "known_at": occurred_at,
        "stable_through": occurred_at,
        "open": close,
        "high": high,
        "low": low,
        "close": close,
        "volume": "1000",
        "payload_hash": None,
    }


def long_window_frozen(centers=None):
    """七十根 K 线：五年极值落在最早一根，近六十根另有自己的高低点。"""
    bars = [
        _bar(0, high="99.00", low="1.00", close="50.00"),
        *(_bar(index, high="30.00", low="28.00", close="29.00") for index in range(1, 10)),
        *(_bar(index, high="25.00", low="18.00", close="20.00") for index in range(10, 69)),
        _bar(69, high="21.00", low="19.00", close="20.60"),
    ]
    frozen = frozen_input()
    frozen["timeframe"] = "1d"
    frozen["market_snapshot"]["bars"] = bars
    frozen["chan_analysis"]["snapshot"]["bars"] = bars
    frozen["chan_analysis"]["snapshot"]["centers"] = (
        [{"start_index": 0, "end_index": 1, "lower": "19.80", "upper": "21.00", "occurred_at": "2026-03-11T00:00:00+00:00"}]
        if centers is None
        else centers
    )
    frozen["reference_registry"] = build_reference_registry(frozen)
    return frozen


def test_reference_registry_has_typed_market_chan_and_information_entries():
    frozen = frozen_input()
    registry = frozen["reference_registry"]
    news = frozen["information_snapshot"]["news"][0]

    assert registry["market.latest_close"]["kind"] == "price_level"
    assert registry["market.recent_high"]["value"] == "21.00"
    assert registry["chan.structure"]["kind"] == "structure"
    assert registry[information_reference("news", news)]["kind"] == "news"
    assert "information.quality" not in registry


def test_reference_registry_serializes_temporal_values_as_iso_8601():
    frozen = frozen_input()
    frozen["market_snapshot"]["bars"][0]["occurred_at"] = datetime(
        2026, 8, 7, tzinfo=UTC
    )
    frozen["chan_analysis"]["snapshot"]["occurred_at"] = date(2026, 8, 7)
    frozen["chan_analysis"]["snapshot"]["centers"][0]["occurred_at"] = datetime(
        2026, 8, 7, 9, 30, tzinfo=UTC
    )
    frozen["information_snapshot"]["news"][0]["published_at"] = date(2026, 8, 13)
    frozen["information_snapshot"]["sentiment"]["observed_at"] = date(2026, 8, 13)

    registry = build_reference_registry(frozen)
    news_ref = information_reference("news", frozen["information_snapshot"]["news"][0])
    irm_ref = information_reference("irm", frozen["information_snapshot"]["messages"][0])
    hot_entries = [entry for entry in registry.values() if entry["kind"] == "hot"]

    assert registry["market.latest_close"]["occurred_at"] == "2026-08-07T00:00:00+00:00"
    assert registry["market.recent_high"]["occurred_at"] == "2026-08-07T00:00:00+00:00"
    assert registry["market.recent_low"]["occurred_at"] == "2026-08-07T00:00:00+00:00"
    assert registry["chan.structure"]["occurred_at"] == "2026-08-07"
    assert registry["chan.center.upper"]["occurred_at"] == "2026-08-07T09:30:00+00:00"
    assert registry["chan.center.lower"]["occurred_at"] == "2026-08-07T09:30:00+00:00"
    assert registry[news_ref]["occurred_at"] == "2026-08-13"
    assert registry[irm_ref]["occurred_at"] == "2026-08-12T16:00:00+08:00"
    assert hot_entries
    assert all(entry["occurred_at"] == "2026-08-13" for entry in hot_entries)


def test_reference_registry_labels_the_five_year_extremes_and_dates_them_to_their_own_bar():
    registry = long_window_frozen()["reference_registry"]

    assert registry["market.recent_high"]["value"] == "99.00"
    assert registry["market.recent_high"]["label"] == "五年窗口最高价"
    assert registry["market.recent_high"]["occurred_at"] == "2026-01-01T00:00:00+00:00"
    assert registry["market.recent_low"]["value"] == "1.00"
    assert registry["market.recent_low"]["label"] == "五年窗口最低价"
    assert registry["market.recent_low"]["occurred_at"] == "2026-01-01T00:00:00+00:00"
    # 极值的时间必须是极值那根 K 线，而不是最新那根。
    assert registry["market.latest_close"]["occurred_at"] == "2026-03-11T00:00:00+00:00"


def test_reference_registry_adds_recent_sixty_bar_levels_that_straddle_the_anchor_close():
    frozen = long_window_frozen()
    registry = frozen["reference_registry"]
    anchor = Decimal(registry["market.latest_close"]["value"])

    # 近六十根只覆盖 index 10 之后，被排除的 index 1 到 9（高点 30.00）不参与。
    assert registry["market.recent_high_60"]["value"] == "25.00"
    assert registry["market.recent_high_60"]["label"] == "近六十个交易日最高价"
    assert registry["market.recent_high_60"]["occurred_at"] == "2026-01-11T00:00:00+00:00"
    assert registry["market.recent_low_60"]["value"] == "18.00"
    assert registry["market.recent_low_60"]["label"] == "近六十个交易日最低价"
    # 关键收益：近端水平夹住固化收盘，向上突破与向下跌破都还没有被解决。
    assert Decimal(registry["market.recent_low_60"]["value"]) < anchor
    assert anchor < Decimal(registry["market.recent_high_60"]["value"])


def test_reference_registry_labels_recent_levels_by_the_frozen_timeframe():
    frozen = long_window_frozen()
    frozen["timeframe"] = "1w"

    registry = build_reference_registry(frozen)

    assert registry["market.recent_high_60"]["label"] == "近六十周最高价"
    assert registry["market.recent_low_60"]["label"] == "近六十周最低价"


def test_reference_registry_exposes_only_the_center_that_still_contains_the_close():
    stale = {
        "start_index": 2,
        "end_index": 3,
        "lower": "3.96",
        "upper": "5.34",
        "occurred_at": "2026-02-01T00:00:00+00:00",
    }
    holding = {
        "start_index": 0,
        "end_index": 1,
        "lower": "19.80",
        "upper": "21.00",
        "occurred_at": "2026-01-20T00:00:00+00:00",
    }

    registry = long_window_frozen(centers=[holding, stale])["reference_registry"]

    # centers[-1] 早已被价格甩开；从后往前回退到仍然包含现价的那个中枢。
    assert registry["chan.center.upper"]["value"] == "21.00"
    assert registry["chan.center.lower"]["value"] == "19.80"
    assert registry["chan.center.upper"]["label"] == "现价所在中枢上沿"
    assert registry["chan.center.upper"]["occurred_at"] == "2026-01-20T00:00:00+00:00"


def test_reference_registry_omits_both_center_bounds_when_no_center_contains_the_close():
    stale = [
        {"start_index": 0, "end_index": 1, "lower": "3.96", "upper": "5.34", "occurred_at": "2026-02-01T00:00:00+00:00"},
        {"start_index": 2, "end_index": 3, "lower": "40.00", "upper": "45.00", "occurred_at": "2026-02-10T00:00:00+00:00"},
    ]

    registry = long_window_frozen(centers=stale)["reference_registry"]

    assert "chan.center.upper" not in registry
    assert "chan.center.lower" not in registry
    # 缠论结构无条件暴露，省略中枢不会破坏证据覆盖校验。
    assert registry["chan.structure"]["kind"] == "structure"


def test_registry_without_centers_still_supports_a_valid_three_scenario_draft():
    frozen = long_window_frozen(centers=[])
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][0]["trigger"] = {
        "operator": "break_above",
        "fact_ref": "market.recent_high_60",
    }
    report["outlook"]["scenarios"][2]["trigger"] = {
        "operator": "break_below",
        "fact_ref": "market.recent_low_60",
    }
    report["outlook"]["scenarios"][2]["invalidation"] = {
        "operator": "break_above",
        "fact_ref": "market.recent_high_60",
    }

    validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_reference_registry_uses_quality_only_when_information_has_no_facts():
    frozen = frozen_input()
    frozen["information_snapshot"]["news"] = []
    frozen["information_snapshot"]["messages"] = [
        {"question": "尚未回复", "answer": None, "published_at": "2026-08-13T00:00:00+08:00"}
    ]
    frozen["information_snapshot"]["sentiment"] = {
        "hot_rank": None,
        "heat": None,
        "rank_change": None,
        "concepts": [],
        "tag": None,
        "observed_at": None,
    }

    registry = build_reference_registry(frozen)

    assert "information.quality" in registry
    assert not any(ref.startswith(("news.", "irm.", "hot.")) for ref in registry)


def test_report_job_get_or_create_is_atomic_and_has_one_execution_owner(tmp_path):
    database = Database()
    frozen = frozen_input()
    digest = build_input_digest(DIGEST_INPUT)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda _: database.get_or_create_investment_report_job(digest, frozen),
                range(16),
            )
        )

    report_ids = {job["report_id"] for job, _ in results}
    run_ids = {job["run_id"] for job, _ in results}
    assert len(report_ids) == 1
    assert len(run_ids) == 1
    assert sum(owner for _, owner in results) == 1
    assert database.get_advisor_state(run_ids.pop())["artifacts"]["as_of"] == "2026-08-13"


def test_report_job_get_or_create_is_atomic_across_connections(tmp_path):
    str(tmp_path / "jobs.sqlite")
    Database()
    barrier = Barrier(8)
    frozen = frozen_input()
    digest = build_input_digest(DIGEST_INPUT)

    def create_from_independent_connection():
        database = Database()
        barrier.wait()
        return database.get_or_create_investment_report_job(digest, frozen)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: create_from_independent_connection(), range(8)))

    assert len({job["report_id"] for job, _ in results}) == 1
    assert len({job["run_id"] for job, _ in results}) == 1
    assert sum(owner for _, owner in results) == 1


def test_report_job_reuses_queued_running_and_completed_digest(tmp_path):
    database = Database()
    frozen = frozen_input()
    digest = build_input_digest(DIGEST_INPUT)
    created, owner = database.get_or_create_investment_report_job(digest, frozen)
    assert owner is True

    queued, queued_owner = database.get_or_create_investment_report_job(digest, frozen)
    assert queued["report_id"] == created["report_id"]
    assert queued_owner is False

    running = database.claim_investment_report_job(created["report_id"], "execution-1")
    assert running["status"] == "running"
    reused, reused_owner = database.get_or_create_investment_report_job(digest, frozen)
    assert reused["status"] == "running"
    assert reused_owner is False

    database.complete_investment_report_job(
        created["report_id"],
        created["lease_epoch"],
        {"schema_version": "investment_report.v2"},
    )
    completed, completed_owner = database.get_or_create_investment_report_job(digest, frozen)
    assert completed["status"] == "completed"
    assert completed["cached"] is True
    assert completed_owner is False


def test_failed_report_job_is_atomically_requeued_for_same_digest(tmp_path):
    database = Database()
    frozen = frozen_input()
    digest = build_input_digest(DIGEST_INPUT)
    created, _ = database.get_or_create_investment_report_job(digest, frozen)
    database.claim_investment_report_job(created["report_id"], "execution-1")
    database.fail_investment_report_job(
        created["report_id"],
        created["lease_epoch"],
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda _: database.get_or_create_investment_report_job(digest, frozen),
                range(16),
            )
        )

    assert sum(owner for _, owner in results) == 1
    requeued = results[0][0]
    assert requeued["status"] == "queued"
    assert requeued["attempt_count"] == 2
    assert requeued["lease_epoch"] == 2
    assert database.get_advisor_state(requeued["run_id"])["lease_epoch"] == 2


def test_failed_digest_is_requeued_by_one_owner_across_connections(tmp_path):
    str(tmp_path / "jobs.sqlite")
    database = Database()
    frozen = frozen_input()
    digest = build_input_digest(DIGEST_INPUT)
    created, _ = database.get_or_create_investment_report_job(digest, frozen)
    database.claim_investment_report_job(created["report_id"], "execution-1")
    database.fail_investment_report_job(
        created["report_id"],
        1,
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )
    barrier = Barrier(8)

    def requeue_from_independent_connection():
        connection = Database()
        barrier.wait()
        return connection.get_or_create_investment_report_job(digest, frozen)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: requeue_from_independent_connection(), range(8)))

    assert sum(owner for _, owner in results) == 1
    assert {job["lease_epoch"] for job, _ in results} == {2}


def test_explicit_retry_has_one_winner_across_connections(tmp_path):
    str(tmp_path / "jobs.sqlite")
    database = Database()
    frozen = frozen_input()
    created, _ = database.get_or_create_investment_report_job(
        build_input_digest(DIGEST_INPUT), frozen
    )
    database.claim_investment_report_job(created["report_id"], "execution-1")
    database.fail_investment_report_job(
        created["report_id"],
        1,
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )
    barrier = Barrier(8)

    def retry_from_independent_connection():
        connection = Database()
        barrier.wait()
        return connection.retry_investment_report_job(created["report_id"])

    successes = []
    failures = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(retry_from_independent_connection) for _ in range(8)]
        for future in as_completed(futures):
            try:
                successes.append(future.result())
            except ValueError as exc:
                failures.append(exc)

    assert len(successes) == 1
    assert len(failures) == 7
    assert successes[0]["lease_epoch"] == 2


def test_same_version_state_save_is_only_idempotent_for_identical_content():
    database = Database()
    frozen = frozen_input()
    created, _ = database.get_or_create_investment_report_job(
        build_input_digest(DIGEST_INPUT), frozen
    )
    database.claim_investment_report_job(created["report_id"], "execution-1")
    state = database.get_advisor_state(created["run_id"])
    database.save_advisor_state(copy.deepcopy(state))
    changed = copy.deepcopy(state)
    changed["state"] = "MARKET_READY"

    with pytest.raises(ValueError, match="state version 冲突"):
        database.save_advisor_state(changed)


@pytest.mark.parametrize("retry_mode", ["explicit", "same_digest"])
def test_retry_preserves_partial_authoritative_advisor_state(tmp_path, retry_mode):
    database = Database()
    frozen = frozen_input()
    created, _ = database.get_or_create_investment_report_job(
        build_input_digest(DIGEST_INPUT),
        frozen,
    )
    database.claim_investment_report_job(created["report_id"], "execution-1")
    first = database.get_advisor_state(created["run_id"])
    first["state"] = "MARKET_READY"
    first["state_version"] = 1
    first["artifacts"]["market"] = {"snapshot_id": "market-progress"}
    database.save_advisor_state(first)
    second = database.get_advisor_state(created["run_id"])
    second["state"] = "CHAN_READY"
    second["state_version"] = 2
    second["artifacts"]["chan"] = {"analysis_id": "chan-progress"}
    database.save_advisor_state(second)
    database.fail_investment_report_job(
        created["report_id"],
        created["lease_epoch"],
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )

    if retry_mode == "explicit":
        retried = database.retry_investment_report_job(created["report_id"])
    else:
        retried, owner = database.get_or_create_investment_report_job(
            build_input_digest(DIGEST_INPUT),
            frozen,
        )
        assert owner is True
    resumed = database.get_advisor_state(created["run_id"])

    assert retried["lease_epoch"] == 2
    assert resumed["lease_epoch"] == 2
    assert resumed["state"] == "CHAN_READY"
    assert resumed["state_version"] == 2
    assert resumed["artifacts"]["market"] == {"snapshot_id": "market-progress"}
    assert resumed["artifacts"]["chan"] == {"analysis_id": "chan-progress"}


def test_failed_investment_job_rejects_direct_advisor_state_write():
    database = Database()
    frozen = frozen_input()
    created, _ = database.get_or_create_investment_report_job(
        build_input_digest(DIGEST_INPUT), frozen
    )
    database.claim_investment_report_job(created["report_id"], "execution-1")
    state = database.get_advisor_state(created["run_id"])
    database.fail_investment_report_job(
        created["report_id"],
        1,
        {"code": "TIMEOUT", "message": "请求超时", "retryable": True},
    )
    state["state"] = "MARKET_READY"
    state["state_version"] = 1

    with pytest.raises(ValueError, match="报告任务执行权已失效"):
        database.save_advisor_state(state)


def test_interrupted_running_job_is_failed_during_read(tmp_path):
    now = datetime(2026, 8, 13, 10, tzinfo=UTC)
    database = Database()
    frozen = frozen_input()
    created, _ = database.get_or_create_investment_report_job(
        build_input_digest(DIGEST_INPUT),
        frozen,
        now=now - timedelta(minutes=6),
    )
    database.claim_investment_report_job(
        created["report_id"],
        "execution-1",
        now=now - timedelta(minutes=6),
    )

    recovered = database.get_investment_report_job(created["report_id"], now=now)

    assert recovered["status"] == "failed"
    assert recovered["error"] == {
        "code": "INTERRUPTED",
        "message": "报告生成进程已中断",
        "retryable": True,
    }


def test_v2_validation_rejects_unknown_reference_and_operator_kind():
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][0]["trigger"] = {
        "operator": "break_above",
        "fact_ref": "chan.structure",
    }
    report["risks"][0]["evidence_refs"] = ["unknown.ref"]

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


@pytest.mark.parametrize(
    ("trigger_operator", "invalidation_operator"),
    [
        ("hold_below", "break_above"),
        ("break_above", "hold_below"),
        ("hold_above", "break_below"),
        ("break_below", "hold_above"),
        ("break_above", "break_above"),
    ],
)
def test_v2_validation_rejects_tautological_condition_pairs_on_one_fact(
    trigger_operator, invalidation_operator
):
    # 同一事实上互为补集或完全相同的条件对，触发一旦成立就永远无法被否证。
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    scenario = report["outlook"]["scenarios"][1]
    scenario["trigger"] = {"operator": trigger_operator, "fact_ref": "market.recent_high"}
    scenario["invalidation"] = {"operator": invalidation_operator, "fact_ref": "market.recent_high"}

    with pytest.raises(ValueError, match="scenario.1 tautological condition pair"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_v2_validation_allows_opposite_breakouts_on_one_fact_and_any_cross_fact_pair():
    frozen = frozen_input()
    same_fact = valid_draft("run-stable", frozen)
    # 同一水平上的双向突破只有在该水平正好等于固化收盘时才两侧都未被解决；换成任何
    # 其他水平，其中一侧在固化那天就已经越线，会被锚点校验拒收。
    same_fact["outlook"]["scenarios"][1]["trigger"] = {
        "operator": "break_above",
        "fact_ref": "market.latest_close",
    }
    same_fact["outlook"]["scenarios"][1]["invalidation"] = {
        "operator": "break_below",
        "fact_ref": "market.latest_close",
    }
    cross_fact = valid_draft("run-stable", frozen)
    cross_fact["outlook"]["scenarios"][1]["trigger"] = {
        "operator": "hold_below",
        "fact_ref": "market.recent_high",
    }
    cross_fact["outlook"]["scenarios"][1]["invalidation"] = {
        "operator": "break_below",
        "fact_ref": "market.recent_low",
    }

    validate_report_draft_v2(same_fact, frozen["reference_registry"], "run-stable")
    validate_report_draft_v2(cross_fact, frozen["reference_registry"], "run-stable")


@pytest.mark.parametrize(
    ("operator", "fact_ref"),
    [
        # 固化收盘 20.60，窗口高点 21.00、窗口低点 19.80。
        ("break_above", "market.recent_low"),
        ("break_below", "market.recent_high"),
        ("hold_above", "market.recent_high"),
        ("hold_below", "market.recent_low"),
    ],
)
def test_v2_validation_rejects_conditions_already_resolved_at_the_anchor_close(operator, fact_ref):
    # 报告写出来时就已经越线或已被违反的条件，事后必然在窗口第一根 K 线命中，
    # 不是预测。
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][1]["trigger"] = {"operator": operator, "fact_ref": fact_ref}

    with pytest.raises(ValueError, match="scenario.1.trigger resolved at anchor close"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


@pytest.mark.parametrize(
    ("operator", "fact_ref"),
    [
        ("break_above", "market.recent_high"),
        ("break_below", "market.recent_low"),
        # 固化收盘仍在低点上方，"保持上方"正常且必要，不算退化。
        ("hold_above", "market.recent_low"),
        ("hold_below", "market.recent_high"),
        # 水平正好等于固化收盘时两侧都还没有被解决。
        ("break_above", "market.latest_close"),
        ("break_below", "market.latest_close"),
        ("hold_above", "market.latest_close"),
        ("hold_below", "market.latest_close"),
    ],
)
def test_v2_validation_keeps_conditions_still_open_at_the_anchor_close(operator, fact_ref):
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][1]["trigger"] = {"operator": operator, "fact_ref": fact_ref}

    validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_v2_validation_rejects_a_resolved_invalidation_as_well_as_a_resolved_trigger():
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][1]["invalidation"] = {
        "operator": "hold_above",
        "fact_ref": "market.recent_high",
    }

    with pytest.raises(ValueError, match="scenario.1.invalidation resolved at anchor close"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_v2_validation_skips_the_anchor_check_when_the_registry_has_no_anchor():
    # 精简夹具的注册表可能没有 market.latest_close；缺锚点应跳过检查而不是拒收。
    frozen = frozen_input()
    registry = copy.deepcopy(frozen["reference_registry"])
    del registry["market.latest_close"]
    report = valid_draft("run-stable", frozen)
    for refs in (report["evidence_refs"], report["outlook"]["scenarios"][0]["evidence_refs"]):
        refs[refs.index("market.latest_close")] = "market.window"
    report["outlook"]["scenarios"][1]["trigger"] = {
        "operator": "break_below",
        "fact_ref": "market.recent_high",
    }

    validate_report_draft_v2(report, registry, "run-stable")


def test_v2_validation_skips_the_anchor_check_when_the_anchor_is_not_numeric():
    frozen = frozen_input()
    registry = copy.deepcopy(frozen["reference_registry"])
    registry["market.latest_close"]["value"] = "暂无收盘"
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][1]["trigger"] = {
        "operator": "break_below",
        "fact_ref": "market.recent_high",
    }

    validate_report_draft_v2(report, registry, "run-stable")


@pytest.mark.parametrize(
    ("location", "value"),
    [
        ("title", "建议买入"),
        ("executive_summary", "目标价值得关注"),
        ("thesis", "可以保证收益"),
        ("scenario", "预计上涨12.5"),
        ("risk", "全角数字１２也不允许"),
    ],
)
def test_v2_validation_rejects_trade_promises_and_all_unicode_numbers(location, value):
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    if location == "title":
        report["title"] = value
    elif location == "executive_summary":
        report["executive_summary"] = value
    elif location == "thesis":
        report["outlook"]["thesis"] = value
    elif location == "scenario":
        report["outlook"]["scenarios"][0]["narrative"] = value
    else:
        report["risks"][0]["narrative"] = value

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_v2_validation_allows_neutral_trading_day_research_language():
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["title"] = "未来交易日结构研究"
    report["outlook"]["thesis"] = "未来交易日继续观察结构确认条件。"

    validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


@pytest.mark.parametrize(
    "mutation", ["extra", "empty_title", "duplicate_ref", "bad_registry", "wrong_types"]
)
def test_v2_validation_enforces_exact_shapes_types_and_reference_ids(mutation):
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    registry = copy.deepcopy(frozen["reference_registry"])
    if mutation == "extra":
        report["unexpected"] = True
    elif mutation == "empty_title":
        report["title"] = ""
    elif mutation == "duplicate_ref":
        report["evidence_refs"].append(report["evidence_refs"][0])
    elif mutation == "bad_registry":
        registry["market.latest_close"]["unexpected"] = True
        registry["market.latest_close"]["value"] = []
    else:
        report["outlook"]["direction"] = []
        report["outlook"]["scenarios"][0]["case"] = []
        registry["market.latest_close"]["kind"] = []

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, registry, "run-stable")


@pytest.mark.parametrize("case", [1, None])
def test_v2_validation_rejects_non_string_scenario_case_without_crashing(case):
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["outlook"]["scenarios"][0]["case"] = case

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


@pytest.mark.parametrize(
    ("location", "value"),
    [
        ("direction", {}),
        ("confidence", []),
        ("case", {}),
        ("registry_kind", []),
        ("condition_operator", {}),
        ("condition_ref", []),
    ],
)
def test_v2_validation_handles_non_hashable_types_as_validation_errors(location, value):
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    registry = copy.deepcopy(frozen["reference_registry"])
    if location == "direction":
        report["outlook"]["direction"] = value
    elif location == "confidence":
        report["outlook"]["confidence"] = value
    elif location == "case":
        report["outlook"]["scenarios"][0]["case"] = value
    elif location == "registry_kind":
        registry["market.latest_close"]["kind"] = value
    elif location == "condition_operator":
        report["outlook"]["scenarios"][0]["trigger"]["operator"] = value
    else:
        report["outlook"]["scenarios"][0]["trigger"]["fact_ref"] = value

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, registry, "run-stable")


def test_v2_validation_rejects_quality_reference_when_real_information_exists():
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)
    report["evidence_refs"][-1] = "information.quality"

    with pytest.raises(ValueError, match="报告草稿无效"):
        validate_report_draft_v2(report, frozen["reference_registry"], "run-stable")


def test_hydrate_report_uses_only_registry_and_frozen_snapshots():
    frozen = frozen_input()
    report = valid_draft("run-stable", frozen)

    hydrated = hydrate_report(
        "report-stable",
        report,
        frozen,
        generated_at="2026-08-13T10:00:00+00:00",
    )

    trigger = hydrated["outlook"]["scenarios"][0]["trigger"]
    assert trigger["fact"] == frozen["reference_registry"]["market.recent_high"]
    assert hydrated["market_snapshot"] == frozen["market_snapshot"]
    assert hydrated["chan_analysis"] == frozen["chan_analysis"]
    assert hydrated["information_snapshot"] == frozen["information_snapshot"]
    assert hydrated["draft"] == report
    assert hydrated["reference_registry"] == frozen["reference_registry"]
    assert hydrated["disclaimer"]
    assert hydrated["review"] == {"status": "pending"}


def test_initializing_new_schema_preserves_legacy_report(isolated_database_schema):
    legacy = {"version": "ReportDraftV1", "run_id": "legacy-run", "title": "旧报告"}
    with psycopg.connect(isolated_database_schema, autocommit=True) as conn:
        conn.execute("CREATE TABLE reports(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL)")
        conn.execute(
            "INSERT INTO reports VALUES (%s, %s, %s)",
            ("legacy-report", "legacy-run", json.dumps(legacy)),
        )

    database = Database()

    assert database.get_report("legacy-report") == legacy
