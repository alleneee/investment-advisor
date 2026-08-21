from __future__ import annotations

from datetime import UTC, datetime

import psycopg
import pytest
from app.db import Database
from app.domain.report_outcome import (
    adjudicate,
    evaluate_condition,
    evaluate_report_outcome,
    rebase_window_bars,
    summarize_quality,
)
from app.outcome import ReportOutcomeError, ReportOutcomeService

NOW = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)


def _bars(closes: list[str], *, start_day: int = 12) -> list[dict]:
    return [
        {"trade_date": f"202601{start_day + index:02d}", "close": close}
        for index, close in enumerate(closes)
    ]


def _condition(operator: str, value: str | None, *, kind: str = "price_level") -> dict:
    return {
        "operator": operator,
        "fact_ref": "market.recent_high",
        "fact": {"ref": "market.recent_high", "kind": kind, "label": "固化窗口高点", "value": value},
    }


def test_break_above_reports_first_crossing_day():
    result = evaluate_condition(_condition("break_above", "10"), _bars(["9", "9.5", "10", "10.5", "9.8"]))

    assert result["hit"] is True
    assert result["decisive_date"] == "20260115"
    assert result["level"] == "10"
    assert result["unevaluable_reason"] is None


def test_break_above_is_not_hit_when_level_only_touched():
    result = evaluate_condition(_condition("break_above", "10"), _bars(["9", "9.5", "10", "9.9", "9.8"]))

    assert result["hit"] is False
    assert result["decisive_date"] is None


def test_hold_above_fails_on_first_violation():
    result = evaluate_condition(_condition("hold_above", "10"), _bars(["10", "10.2", "9.9", "10.5", "11"]))

    assert result["hit"] is False
    assert result["decisive_date"] == "20260114"


def test_hold_above_holds_when_every_close_stays_at_or_above_level():
    result = evaluate_condition(_condition("hold_above", "10"), _bars(["10", "10.2", "10", "10.5", "11"]))

    assert result["hit"] is True
    assert result["decisive_date"] is None


def test_break_below_and_hold_below_use_opposite_comparisons():
    broke = evaluate_condition(_condition("break_below", "10"), _bars(["10", "10", "9.5", "10", "10"]))
    held = evaluate_condition(_condition("hold_below", "10"), _bars(["9", "9.5", "9.8", "9.9", "10"]))

    assert broke["hit"] is True
    assert broke["decisive_date"] == "20260114"
    assert held["hit"] is True


def test_structure_condition_is_explicitly_unevaluable_instead_of_guessed():
    result = evaluate_condition(
        _condition("structure_confirmed", "confirmed=5;provisional=1;centers=2", kind="structure"),
        _bars(["10", "11", "12", "13", "14"]),
    )

    assert result["hit"] is None
    assert result["unevaluable_reason"] == "structure_condition_not_replayable"


def test_structure_confirmed_holds_while_closes_stay_inside_the_frozen_center():
    center = {"lower": "9.5", "upper": "11.5"}
    confirmed = evaluate_condition(
        _condition("structure_confirmed", "confirmed=1;provisional=0;centers=1", kind="structure"),
        _bars(["10", "10.2", "11", "10.8", "10.1"]),
        structure_center=center,
    )
    invalidated = evaluate_condition(
        _condition("structure_invalidated", "confirmed=1;provisional=0;centers=1", kind="structure"),
        _bars(["10", "10.2", "11", "10.8", "10.1"]),
        structure_center=center,
    )

    assert confirmed["hit"] is True
    assert confirmed["unevaluable_reason"] is None
    assert invalidated["hit"] is False
    assert invalidated["decisive_date"] is None


def test_structure_invalidated_hits_on_the_first_close_outside_the_frozen_center():
    center = {"lower": "9.5", "upper": "11.5"}
    result = evaluate_condition(
        _condition("structure_invalidated", "confirmed=1;provisional=0;centers=1", kind="structure"),
        _bars(["10", "10.2", "11.6", "10.8", "10.1"]),
        structure_center=center,
    )
    confirmed = evaluate_condition(
        _condition("structure_confirmed", "confirmed=1;provisional=0;centers=1", kind="structure"),
        _bars(["10", "10.2", "11.6", "10.8", "10.1"]),
        structure_center=center,
    )

    assert result["hit"] is True
    assert result["decisive_date"] == "20260114"
    assert confirmed["hit"] is False
    assert confirmed["decisive_date"] == "20260114"


def test_non_numeric_level_and_short_window_are_unevaluable():
    non_numeric = evaluate_condition(_condition("break_above", "近期高点"), _bars(["10", "11", "12", "13", "14"]))
    short_window = evaluate_condition(_condition("break_above", "10"), _bars(["10", "11"]))

    assert non_numeric["unevaluable_reason"] == "fact_value_not_numeric"
    assert short_window["unevaluable_reason"] == "window_not_ready"


def _outcome(operator: str, hit: bool | None) -> dict:
    return {"operator": operator, "hit": hit}


def test_adjudicate_requires_trigger_hit_without_invalidation():
    results = [
        {"case": "bullish", "trigger": _outcome("break_above", True), "invalidation": _outcome("break_below", False)},
        {"case": "base", "trigger": _outcome("hold_below", False), "invalidation": _outcome("break_below", False)},
        {"case": "bearish", "trigger": _outcome("break_below", True), "invalidation": _outcome("hold_above", True)},
    ]

    verdict = adjudicate(results, bar_count=20)

    assert verdict["status"] == "realized"
    assert verdict["realized_case"] == "bullish"
    assert verdict["adjudication"] == "single_candidate"


def test_adjudicate_marks_multiple_winners_ambiguous_and_none_as_not_realized():
    ambiguous = adjudicate(
        [
            {"case": "bullish", "trigger": _outcome("break_above", True), "invalidation": _outcome("break_below", False)},
            {"case": "bearish", "trigger": _outcome("break_below", True), "invalidation": _outcome("break_above", False)},
        ],
        bar_count=20,
    )
    none_realized = adjudicate(
        [{"case": "base", "trigger": _outcome("hold_below", False), "invalidation": _outcome("break_below", False)}],
        bar_count=20,
    )
    inconclusive = adjudicate(
        [{"case": "base", "trigger": _outcome("structure_confirmed", None), "invalidation": _outcome("break_below", False)}],
        bar_count=20,
    )
    pending = adjudicate(
        [{"case": "base", "trigger": _outcome("hold_below", True), "invalidation": _outcome("break_below", False)}],
        bar_count=3,
    )

    assert ambiguous["status"] == "ambiguous"
    assert sorted(ambiguous["realized_cases"]) == ["bearish", "bullish"]
    assert ambiguous["adjudication"] == "multiple_active_breakouts"
    assert none_realized["status"] == "none_realized"
    assert none_realized["adjudication"] == "no_candidate"
    assert inconclusive["status"] == "inconclusive"
    assert inconclusive["adjudication"] == "no_candidate"
    assert pending["status"] == "pending"
    assert pending["adjudication"] == "window_pending"


def test_adjudicate_lets_the_only_active_breakout_outrank_a_passive_hold():
    # 真实场景（002940.SZ）：窗口内未上破前高，震荡情景的“收盘不越过前高”被动
    # 成立；同时向下跌破前低，看空情景主动兑现。主动突破优先，震荡情景让位。
    verdict = adjudicate(
        [
            {"case": "bullish", "trigger": _outcome("break_above", False), "invalidation": _outcome("break_below", True)},
            {"case": "base", "trigger": _outcome("hold_below", True), "invalidation": _outcome("break_below", False)},
            {"case": "bearish", "trigger": _outcome("break_below", True), "invalidation": _outcome("hold_above", False)},
        ],
        bar_count=20,
    )

    assert verdict["status"] == "realized"
    assert verdict["realized_case"] == "bearish"
    assert verdict["adjudication"] == "active_breakout_precedence"
    # 让位的候选仍然保留，便于客户侧追溯为什么震荡情景没有被判为兑现。
    assert verdict["realized_cases"] == ["base", "bearish"]


def test_adjudicate_keeps_two_way_breakouts_ambiguous_without_picking_the_earliest():
    verdict = adjudicate(
        [
            {"case": "bullish", "trigger": _outcome("break_above", True), "invalidation": _outcome("hold_below", False)},
            {"case": "base", "trigger": _outcome("hold_below", True), "invalidation": _outcome("break_below", False)},
            {"case": "bearish", "trigger": _outcome("break_below", True), "invalidation": _outcome("hold_above", False)},
        ],
        bar_count=20,
    )

    assert verdict["status"] == "ambiguous"
    assert verdict["realized_case"] is None
    assert verdict["adjudication"] == "multiple_active_breakouts"
    assert verdict["realized_cases"] == ["bullish", "base", "bearish"]


def test_adjudicate_keeps_passive_only_candidates_ambiguous():
    verdict = adjudicate(
        [
            {"case": "base", "trigger": _outcome("hold_below", True), "invalidation": _outcome("break_below", False)},
            {"case": "bearish", "trigger": _outcome("hold_above", True), "invalidation": _outcome("break_above", False)},
        ],
        bar_count=20,
    )

    assert verdict["status"] == "ambiguous"
    assert verdict["adjudication"] == "passive_only"
    assert verdict["realized_cases"] == ["base", "bearish"]


def test_rebase_converts_window_to_report_adjustment_base():
    # 报告固化时锚定日收盘为 10；事后重取因分红换基准，同一天变成 8，比值 1.25。
    rows = [
        {"trade_date": "20260109", "qfq_close": "8", "close": "10"},
        {"trade_date": "20260112", "qfq_close": "8.8", "close": "11"},
        {"trade_date": "20260113", "qfq_close": "9.6", "close": "12"},
    ]

    bars, warnings = rebase_window_bars(rows, anchor_trade_date="20260109", anchor_close="10")

    assert [bar["trade_date"] for bar in bars] == ["20260112", "20260113"]
    assert [bar["close"] for bar in bars] == ["11.000", "12.000"]
    assert warnings == ["窗口内发生复权因子变化，已按报告固化基准换算"]


def test_rebase_without_factor_change_keeps_prices_and_drops_anchor():
    rows = [
        {"trade_date": "20260109", "qfq_close": "10", "close": "10"},
        {"trade_date": "20260112", "qfq_close": "11", "close": "11"},
    ]

    bars, warnings = rebase_window_bars(rows, anchor_trade_date="20260109", anchor_close="10")

    assert bars == [{"trade_date": "20260112", "close": "11"}]
    assert warnings == []


def test_rebase_without_anchor_row_warns_about_uncalibrated_prices():
    rows = [{"trade_date": "20260112", "qfq_close": "11", "close": "11"}]

    bars, warnings = rebase_window_bars(rows, anchor_trade_date="20260109", anchor_close="10")

    assert bars == [{"trade_date": "20260112", "close": "11"}]
    assert warnings == ["缺少前复权锚定价，兑现判定使用未校准价格"]


def _report(**overrides) -> dict:
    report = {
        "id": "report-1",
        "symbol": "002940.SZ",
        "as_of": "2026-01-09",
        "market_snapshot": {
            "window": {"start": "20260101", "end": "20260109", "bar_count": 5},
            "bars": [{"occurred_at": "2026-01-09T00:00:00+00:00", "close": "10"}],
        },
        "reference_registry": {
            "market.latest_close": {
                "ref": "market.latest_close",
                "kind": "price_level",
                "label": "最新固化收盘",
                "value": "10",
            }
        },
        "outlook": {
            "scenarios": [
                {"case": "bullish", **_scenario("break_above", "10.4", "break_below", "9.0")},
                # 震荡情景以“不越过高点”为触发，避免与看多情景同时成立。
                {"case": "base", **_scenario("hold_below", "10.4", "break_below", "8.0")},
                {"case": "bearish", **_scenario("break_below", "9.0", "break_above", "10.4")},
            ]
        },
    }
    report.update(overrides)
    return report


def _scenario(trigger_op: str, trigger_level: str, invalid_op: str, invalid_level: str) -> dict:
    return {
        "trigger": {
            "operator": trigger_op,
            "fact_ref": "market.recent_high",
            "fact": {"ref": "market.recent_high", "kind": "price_level", "label": "高点", "value": trigger_level},
        },
        "invalidation": {
            "operator": invalid_op,
            "fact_ref": "market.recent_low",
            "fact": {"ref": "market.recent_low", "kind": "price_level", "label": "低点", "value": invalid_level},
        },
    }


def test_report_outcome_replays_structure_from_the_frozen_center_holding_close():
    report = _report(
        chan_analysis={
            "snapshot": {
                "centers": [
                    {"start_index": 0, "end_index": 4, "lower": "9.5", "upper": "11.5"},
                    {"start_index": 6, "end_index": 10, "lower": "40", "upper": "45"},
                ]
            }
        },
        outlook={
            "scenarios": [
                {
                    "case": "bullish",
                    **_scenario("break_above", "12", "break_below", "9"),
                },
                {
                    "case": "base",
                    "trigger": {
                        "operator": "structure_confirmed",
                        "fact_ref": "chan.structure",
                        "fact": {
                            "ref": "chan.structure",
                            "kind": "structure",
                            "label": "结构",
                            "value": "confirmed=1",
                        },
                    },
                    "invalidation": {
                        "operator": "structure_invalidated",
                        "fact_ref": "chan.structure",
                        "fact": {
                            "ref": "chan.structure",
                            "kind": "structure",
                            "label": "结构",
                            "value": "confirmed=1",
                        },
                    },
                },
                {
                    "case": "bearish",
                    **_scenario("break_below", "9", "break_above", "12"),
                },
            ]
        },
    )

    held = evaluate_report_outcome(report, _bars(["10.1", "10.2", "10.4", "10.3", "10.0"]), evaluated_at=NOW.isoformat())
    broken = evaluate_report_outcome(report, _bars(["10.1", "10.2", "11.6", "10.3", "10.0"]), evaluated_at=NOW.isoformat())

    assert held["status"] == "realized"
    assert held["realized_case"] == "base"
    assert held["scenarios"][1]["trigger"]["hit"] is True
    assert broken["scenarios"][1]["invalidation"]["hit"] is True
    assert broken["scenarios"][1]["invalidation"]["decisive_date"] == "20260114"


def test_report_outcome_realizes_bullish_case_and_reports_window():
    bars = _bars(["10.1", "10.2", "10.5", "10.6", "10.7"])

    outcome = evaluate_report_outcome(_report(), bars, evaluated_at=NOW.isoformat())

    assert outcome["status"] == "realized"
    assert outcome["realized_case"] == "bullish"
    assert outcome["window"] == {
        "start": "20260112",
        "end": "20260116",
        "bar_count": 5,
        "required_bars": 20,
    }
    assert outcome["adjudication"] == "single_candidate"
    assert outcome["quality"]["status"] == "degraded"
    assert "展望窗口尚未走满二十个交易日" in outcome["quality"]["warnings"]


def test_report_outcome_awards_the_active_breakout_when_the_range_case_also_holds():
    # 收盘始终没有越过前高，震荡情景被动成立；同时跌破前低，看空情景主动兑现。
    bars = _bars(["9.5", "9.2", "8.8", "8.6", "8.5"])

    outcome = evaluate_report_outcome(_report(), bars, evaluated_at=NOW.isoformat())

    assert outcome["status"] == "realized"
    assert outcome["realized_case"] == "bearish"
    assert outcome["realized_cases"] == ["base", "bearish"]
    assert outcome["adjudication"] == "active_breakout_precedence"


def test_report_outcome_is_pending_before_minimum_window():
    outcome = evaluate_report_outcome(_report(), _bars(["10.1", "10.2"]), evaluated_at=NOW.isoformat())

    assert outcome["status"] == "pending"
    assert outcome["realized_case"] is None
    assert outcome["adjudication"] == "window_pending"


def test_report_outcome_caps_window_at_twenty_bars():
    bars = [{"trade_date": f"2026{index:04d}", "close": "9.5"} for index in range(1, 31)]

    outcome = evaluate_report_outcome(_report(), bars, evaluated_at=NOW.isoformat())

    assert outcome["window"]["bar_count"] == 20
    assert outcome["quality"]["warnings"] == []


def test_summarize_quality_reports_accept_and_realized_rates():
    summary = summarize_quality(
        [{"decision": "accepted"}, {"decision": "accepted"}, {"decision": "rejected"}],
        [
            {"status": "realized", "realized_case": "bullish"},
            {"status": "none_realized"},
            {"status": "ambiguous"},
            {"status": "pending"},
        ],
    )

    assert summary["review"] == {
        "accepted": 2,
        "rejected": 1,
        "decided": 3,
        "accept_rate": "0.6667",
    }
    # 排除 ambiguous 与 pending 后分母是 2，看起来兑现一半；把全部已评估样本算进
    # 分母只有四分之一，后者才是客户体感的口径。
    assert summary["outcome"]["realized_rate_over_conclusive"] == "0.5000"
    assert summary["outcome"]["realized_rate_over_evaluated"] == "0.2500"
    assert summary["outcome"]["by_case"] == {"bullish": 1}


def test_summarize_quality_evaluated_rate_stays_pessimistic_when_most_are_ambiguous():
    # 真实数据下 2/3 是 ambiguous，只看 conclusive 口径会显示 100% 兑现。
    summary = summarize_quality(
        [],
        [
            {"status": "realized", "realized_case": "bearish"},
            {"status": "ambiguous"},
            {"status": "ambiguous"},
        ],
    )

    assert summary["outcome"]["realized_rate_over_conclusive"] == "1.0000"
    assert summary["outcome"]["realized_rate_over_evaluated"] == "0.3333"


def test_summarize_quality_returns_none_rates_without_samples():
    summary = summarize_quality([], [])

    assert summary["review"]["accept_rate"] is None
    assert summary["outcome"]["realized_rate_over_conclusive"] is None
    assert summary["outcome"]["realized_rate_over_evaluated"] is None


class _StubDatabase:
    def __init__(self, job: dict | None) -> None:
        self.job = job
        self.saved: dict[str, dict] = {}

    def get_investment_report_job(self, report_id: str, *, now=None):
        return self.job

    def get_market_history(self, *args):
        return [
            {"trade_date": "20260109", "qfq_close": "10", "close": "10"},
            *[{"trade_date": f"202601{12 + index:02d}", "qfq_close": "10.5", "close": "10.5"} for index in range(5)],
        ]

    def save_market_history(self, *args):
        raise AssertionError("命中缓存时不应写回行情")

    def save_report_outcome(self, report_id: str, outcome: dict):
        self.saved[report_id] = outcome
        return outcome


def test_outcome_service_evaluates_and_persists_from_cached_window():
    database = _StubDatabase({"status": "completed", "result": _report()})
    service = ReportOutcomeService(database, clock=lambda: NOW)

    outcome = service.evaluate("report-1")

    assert outcome["status"] == "realized"
    assert outcome["realized_case"] == "bullish"
    assert database.saved["report-1"] is outcome


def test_legacy_report_schema_gains_review_and_publish_columns(isolated_database_schema):
    # 闭环上线前建的库没有审阅与发布列，启动时必须幂等补齐而不是重建表。
    with psycopg.connect(isolated_database_schema, autocommit=True) as conn:
        conn.execute(
            """
            CREATE TABLE investment_report_jobs(
                report_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL UNIQUE,
                input_digest TEXT NOT NULL UNIQUE,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                as_of TEXT NOT NULL,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL,
                lease_epoch INTEGER NOT NULL,
                frozen_input TEXT NOT NULL,
                result TEXT,
                error TEXT,
                execution_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO investment_report_jobs VALUES "
            "('legacy-report', 'legacy-run', 'legacy-digest', '002940.SZ', '1d', '2026-01-09', "
            "'completed', 1, 1, '{}', NULL, NULL, NULL, 'now', 'now', NULL, NULL)"
        )

    database = Database()

    with database.read() as connection:
        row = connection.execute(
            "SELECT review_status, reviewed_at, published_at FROM investment_report_jobs "
            "WHERE report_id = 'legacy-report'"
        ).fetchone()
        outcomes = connection.execute(
            "SELECT to_regclass(current_schema() || '.report_outcomes') AS table_name"
        ).fetchone()

    assert row == {"review_status": "pending", "reviewed_at": None, "published_at": None}
    assert outcomes["table_name"] is not None


def test_outcome_service_rejects_missing_and_unfinished_reports():
    missing = ReportOutcomeService(_StubDatabase(None), clock=lambda: NOW)
    running = ReportOutcomeService(
        _StubDatabase({"status": "running", "result": None}), clock=lambda: NOW
    )

    with pytest.raises(ReportOutcomeError) as missing_error:
        missing.evaluate("report-1")
    with pytest.raises(ReportOutcomeError) as running_error:
        running.evaluate("report-1")

    assert missing_error.value.code == "REPORT_NOT_FOUND"
    assert running_error.value.code == "REPORT_NOT_COMPLETED"
