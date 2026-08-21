"""对客研报的情景兑现评估。

报告的每个情景都带有 ``trigger`` 和 ``invalidation`` 两个条件，条件由算子和
指向引用注册表的 ``fact_ref`` 组成，价格类事实带确定性数值。本模块在报告展望
窗口结束后，用真实行情逐条判定这些条件是否命中，并裁决哪个情景兑现。

评估保持与项目其他部分一致的确定性原则：只用固化事实和真实行情判定，无法判定
时显式返回原因，不用推测值填充。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from .chan_engine import center_containing_price

OUTCOME_SCHEMA_VERSION = "report_outcome.v1"

# 展望期固定为 5-20 个交易日：满 5 根可给出中途结论，满 20 根为完整窗口。
HORIZON_MIN_BARS = 5
HORIZON_MAX_BARS = 20

BREAK_OPERATORS = {"break_above", "break_below"}
HOLD_OPERATORS = {"hold_above", "hold_below"}
STRUCTURE_OPERATORS = {"structure_confirmed", "structure_invalidated"}

OutcomeStatus = Literal["pending", "realized", "none_realized", "ambiguous", "inconclusive"]
UnevaluableReason = Literal[
    "window_not_ready",
    "fact_value_not_numeric",
    "structure_condition_not_replayable",
    "unknown_operator",
]
# 裁决所用规则，写入结果供客户侧追溯为什么某个情景让位或为什么无定论。
AdjudicationRule = Literal[
    "window_pending",
    "single_candidate",
    "active_breakout_precedence",
    "multiple_active_breakouts",
    "passive_only",
    "no_candidate",
]


def evaluate_condition(
    condition: Mapping[str, Any],
    bars: Sequence[Mapping[str, Any]],
    *,
    structure_center: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """判定单个条件在窗口行情内是否命中。

    ``bars`` 必须已经换算到报告固化时的前复权基准，且按交易日升序排列。
    结构类条件用报告固化时仍包含收盘的中枢回放：窗口收盘仍在区间内为确认，
    第一次越出为失效。缺少可回放中枢时仍返回 ``structure_condition_not_replayable``。
    """
    operator = condition.get("operator")
    fact = condition.get("fact") if isinstance(condition.get("fact"), Mapping) else {}
    fact_ref = str(condition.get("fact_ref") or "")
    base = {"operator": operator, "fact_ref": fact_ref}

    if operator in STRUCTURE_OPERATORS:
        return _evaluate_structure(base, str(operator), bars, structure_center)
    if operator not in BREAK_OPERATORS and operator not in HOLD_OPERATORS:
        return _unevaluable(base, "unknown_operator")

    level = _decimal_or_none(fact.get("value"))
    if level is None:
        return _unevaluable(base, "fact_value_not_numeric")
    base["level"] = str(level)

    closes = [(str(bar.get("trade_date") or ""), _decimal_or_none(bar.get("close"))) for bar in bars]
    usable = [(day, close) for day, close in closes if close is not None]
    if len(usable) < HORIZON_MIN_BARS:
        return _unevaluable(base, "window_not_ready")

    if operator in BREAK_OPERATORS:
        crossed = (
            (day for day, close in usable if close > level)
            if operator == "break_above"
            else (day for day, close in usable if close < level)
        )
        decisive_date = next(crossed, None)
        return {**base, "hit": decisive_date is not None, "decisive_date": decisive_date, "unevaluable_reason": None}

    violated = (
        (day for day, close in usable if close < level)
        if operator == "hold_above"
        else (day for day, close in usable if close > level)
    )
    decisive_date = next(violated, None)
    return {**base, "hit": decisive_date is None, "decisive_date": decisive_date, "unevaluable_reason": None}


def evaluate_report_outcome(
    report: Mapping[str, Any],
    bars: Sequence[Mapping[str, Any]],
    *,
    evaluated_at: str,
    window_quality: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """评估整份报告的三个情景，并裁决兑现结果。"""
    outlook = report.get("outlook") if isinstance(report.get("outlook"), Mapping) else {}
    scenarios = outlook.get("scenarios") if isinstance(outlook.get("scenarios"), list) else []
    window = list(bars)[:HORIZON_MAX_BARS]

    frozen_center = _frozen_structure_center(report)
    results = [
        {
            "case": scenario.get("case"),
            "trigger": evaluate_condition(
                _condition(scenario, "trigger"), window, structure_center=frozen_center
            ),
            "invalidation": evaluate_condition(
                _condition(scenario, "invalidation"), window, structure_center=frozen_center
            ),
        }
        for scenario in scenarios
        if isinstance(scenario, Mapping)
    ]

    verdict = adjudicate(results, bar_count=len(window))
    quality = dict(window_quality or {})
    warnings = list(quality.get("warnings") or [])
    if len(window) < HORIZON_MAX_BARS:
        warnings.append("展望窗口尚未走满二十个交易日")
    unevaluable = sorted({
        reason
        for result in results
        for reason in (
            result["trigger"].get("unevaluable_reason"),
            result["invalidation"].get("unevaluable_reason"),
        )
        if reason
    })
    if unevaluable:
        warnings.append(f"存在无法判定的条件：{'、'.join(unevaluable)}")

    return {
        "schema_version": OUTCOME_SCHEMA_VERSION,
        "report_id": report.get("id"),
        "symbol": report.get("symbol"),
        "as_of": report.get("as_of"),
        "evaluated_at": evaluated_at,
        "window": {
            "start": window[0].get("trade_date") if window else None,
            "end": window[-1].get("trade_date") if window else None,
            "bar_count": len(window),
            "required_bars": HORIZON_MAX_BARS,
        },
        "scenarios": results,
        "quality": {
            "status": quality.get("status") or ("ok" if not warnings else "degraded"),
            "warnings": warnings,
        },
        **verdict,
    }


def adjudicate(
    results: Sequence[Mapping[str, Any]],
    *,
    bar_count: int,
) -> dict[str, Any]:
    """裁决哪个情景兑现。

    默认规则（保守口径）：触发条件命中且失效条件未命中，才算该情景兑现；
    恰好一个情景满足才给出结论，多个满足记为 ambiguous，都不满足记为
    none_realized，条件无法判定且没有任何情景兑现时记为 inconclusive。

    多个情景同时满足时再看触发算子的性质：``break_*`` 是窗口内真实发生的越线
    事件（主动突破），``hold_*`` 只要求收盘不越界（被动保持），后者在单边行情
    里与前者天然并存。恰好一个主动突破时判它兑现，被动保持型让位；双向都发生
    突破，或候选全是被动保持型，都仍然记为 ambiguous。``realized_cases`` 始终
    保留全部候选，``adjudication`` 记录本次用的规则。
    """
    if bar_count < HORIZON_MIN_BARS:
        return _verdict("pending", None, [], "window_pending")

    candidates = [
        result
        for result in results
        if result["trigger"].get("hit") is True and result["invalidation"].get("hit") is not True
    ]
    realized = [str(result.get("case")) for result in candidates]
    has_unevaluable = any(
        result["trigger"].get("hit") is None or result["invalidation"].get("hit") is None
        for result in results
    )

    if len(realized) == 1:
        return _verdict("realized", realized[0], realized, "single_candidate")
    if len(realized) > 1:
        active = [
            str(result.get("case"))
            for result in candidates
            if result["trigger"].get("operator") in BREAK_OPERATORS
        ]
        if len(active) == 1:
            return _verdict("realized", active[0], realized, "active_breakout_precedence")
        rule = "multiple_active_breakouts" if active else "passive_only"
        return _verdict("ambiguous", None, realized, rule)
    if has_unevaluable:
        return _verdict("inconclusive", None, [], "no_candidate")
    return _verdict("none_realized", None, [], "no_candidate")


def condition_resolved_at_anchor(operator: Any, anchor_close: Any, level: Any) -> bool:
    """判断价格类条件在报告固化收盘上是否已经被解决。

    ``break_*`` 已经越线、``hold_*`` 已被违反，两者都意味着条件在写下报告的那一
    刻就已成交：事后评估必然在展望窗口第一根 K 线报命中，情景没有预测力。结构类
    算子与无法解析为数值的水平一律返回 ``False``，交给各自的类型校验处理。

    这是「固化日已解决」的唯一事实源。撰写期的拒收校验共用它：Python 侧由
    ``app.reporting.validate_report_draft_v2`` 直接调用；Node 侧在
    ``packages/contracts/src/index.ts`` 的 ``ANCHOR_RESOLVED`` 重实现同一规则
    （两端各自独立校验是本项目一贯风格）。
    """
    decided = _ANCHOR_RESOLVED.get(str(operator))
    anchor = _decimal_or_none(anchor_close)
    threshold = _decimal_or_none(level)
    if decided is None or anchor is None or threshold is None:
        return False
    return decided(anchor, threshold)


def conditions_resolved_at_anchor(
    report: Mapping[str, Any],
    anchor_close: Any,
) -> list[str]:
    """找出在报告固化日就已经成立（突破类）或已经失效（保持类）的条件。

    这类条件在展望窗口第一根 K 线上必然命中，兑现判定对它们没有区分力：情景
    看似兑现，实际只是复述固化当天已经发生的事实。返回 ``case.condition``
    形式的标识，供质量告警显式披露。

    撰写期已经由 ``validate_report_draft_v2`` 拒收这类条件，本函数是存量报告的
    兜底诊断，两者共用 ``condition_resolved_at_anchor`` 的判据。
    """
    outlook = report.get("outlook") if isinstance(report.get("outlook"), Mapping) else {}
    scenarios = outlook.get("scenarios") if isinstance(outlook.get("scenarios"), list) else []
    resolved: list[str] = []
    for scenario in (value for value in scenarios if isinstance(value, Mapping)):
        for name in ("trigger", "invalidation"):
            condition = _condition(scenario, name)
            fact = condition.get("fact") if isinstance(condition.get("fact"), Mapping) else {}
            if condition_resolved_at_anchor(condition.get("operator"), anchor_close, fact.get("value")):
                resolved.append(f"{scenario.get('case')}.{name}")
    return resolved


def rebase_window_bars(
    bars: Sequence[Mapping[str, Any]],
    *,
    anchor_trade_date: str,
    anchor_close: Any,
) -> tuple[list[dict[str, Any]], list[str]]:
    """把窗口行情换算到报告固化时的前复权基准。

    Provider 的前复权以所取窗口最后一个交易日为基准，事后重新取数会换基准；
    若期间有分红或拆股，直接比较固化价格水平就会失真。锚定日（报告最后一根
    K 线）在两次计算中对应同一支付事实，用它的比值即可整体换算。
    """
    anchor_expected = _decimal_or_none(anchor_close)
    anchor_row = next(
        (bar for bar in bars if str(bar.get("trade_date") or "") == str(anchor_trade_date)),
        None,
    )
    anchor_actual = _decimal_or_none((anchor_row or {}).get("qfq_close", (anchor_row or {}).get("close")))

    forward = [bar for bar in bars if str(bar.get("trade_date") or "") > str(anchor_trade_date)]
    if anchor_expected is None or anchor_actual is None or anchor_actual == 0:
        return (
            [_close_row(bar, _decimal_or_none(bar.get("qfq_close", bar.get("close")))) for bar in forward],
            ["缺少前复权锚定价，兑现判定使用未校准价格"],
        )

    ratio = anchor_expected / anchor_actual
    rebased = [
        _close_row(bar, _scaled(_decimal_or_none(bar.get("qfq_close", bar.get("close"))), ratio))
        for bar in forward
    ]
    warnings = [] if ratio == 1 else ["窗口内发生复权因子变化，已按报告固化基准换算"]
    return rebased, warnings


def summarize_quality(reviews: Sequence[Mapping[str, Any]], outcomes: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """汇总审阅通过率与情景兑现率，作为对客研报的 track record。

    兑现率给出两个口径，避免只看乐观的那个：
    ``realized_rate_over_conclusive`` 的分母是有明确结论的样本（realized 加
    none_realized），排除了 ambiguous 与 inconclusive；
    ``realized_rate_over_evaluated`` 的分母是全部已评估样本，把无定论的样本也
    算作"没兑现"，是更保守、也更接近客户体感的口径。样本不足时都返回 ``None``。
    """
    decisions = [str(item.get("decision") or "") for item in reviews]
    accepted = decisions.count("accepted")
    rejected = decisions.count("rejected")
    decided = accepted + rejected

    statuses = [str(item.get("status") or "") for item in outcomes]
    realized = [str(item.get("realized_case") or "") for item in outcomes if item.get("status") == "realized"]
    conclusive = statuses.count("realized") + statuses.count("none_realized")

    return {
        "review": {
            "accepted": accepted,
            "rejected": rejected,
            "decided": decided,
            "accept_rate": _rate(accepted, decided),
        },
        "outcome": {
            "evaluated": len(outcomes),
            "conclusive": conclusive,
            "realized": statuses.count("realized"),
            "none_realized": statuses.count("none_realized"),
            "ambiguous": statuses.count("ambiguous"),
            "inconclusive": statuses.count("inconclusive"),
            "pending": statuses.count("pending"),
            "realized_rate_over_conclusive": _rate(statuses.count("realized"), conclusive),
            "realized_rate_over_evaluated": _rate(statuses.count("realized"), len(outcomes)),
            "by_case": {
                case: realized.count(case) for case in ("bullish", "base", "bearish") if realized.count(case)
            },
        },
    }


# 固化收盘落在哪一侧就意味着条件已被解决：break_* 已经越线，hold_* 已被违反。
# 注意 hold_above 在固化日收盘正好位于水平上方是正常且必要的，只有已经跌破才无效。
_ANCHOR_RESOLVED = {
    "break_above": lambda anchor, level: anchor > level,
    "break_below": lambda anchor, level: anchor < level,
    "hold_above": lambda anchor, level: anchor < level,
    "hold_below": lambda anchor, level: anchor > level,
}


def _verdict(
    status: OutcomeStatus,
    realized_case: str | None,
    realized_cases: list[str],
    adjudication: AdjudicationRule,
) -> dict[str, Any]:
    return {
        "status": status,
        "realized_case": realized_case,
        "realized_cases": realized_cases,
        "adjudication": adjudication,
    }


def _condition(scenario: Mapping[str, Any], name: str) -> dict[str, Any]:
    value = scenario.get(name)
    return dict(value) if isinstance(value, Mapping) else {}


def _evaluate_structure(
    base: Mapping[str, Any],
    operator: str,
    bars: Sequence[Mapping[str, Any]],
    center: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(center, Mapping):
        return _unevaluable(base, "structure_condition_not_replayable")
    lower = _decimal_or_none(center.get("lower"))
    upper = _decimal_or_none(center.get("upper"))
    if lower is None or upper is None or lower > upper:
        return _unevaluable(base, "structure_condition_not_replayable")

    closes = [(str(bar.get("trade_date") or ""), _decimal_or_none(bar.get("close"))) for bar in bars]
    usable = [(day, close) for day, close in closes if close is not None]
    if len(usable) < HORIZON_MIN_BARS:
        return _unevaluable(base, "window_not_ready")

    outside = next((day for day, close in usable if close < lower or close > upper), None)
    if operator == "structure_invalidated":
        return {**base, "hit": outside is not None, "decisive_date": outside, "unevaluable_reason": None}
    return {**base, "hit": outside is None, "decisive_date": outside, "unevaluable_reason": None}


def _frozen_structure_center(report: Mapping[str, Any]) -> dict[str, Any] | None:
    market = report.get("market_snapshot") if isinstance(report.get("market_snapshot"), Mapping) else {}
    bars = [bar for bar in (market.get("bars") or []) if isinstance(bar, Mapping)]
    close = _decimal_or_none(bars[-1].get("close")) if bars else None
    chan = report.get("chan_analysis") if isinstance(report.get("chan_analysis"), Mapping) else {}
    snapshot = chan.get("snapshot") if isinstance(chan.get("snapshot"), Mapping) else {}
    centers = [item for item in (snapshot.get("centers") or []) if isinstance(item, Mapping)]
    return center_containing_price(list(centers), close)


def _unevaluable(base: Mapping[str, Any], reason: UnevaluableReason) -> dict[str, Any]:
    return {**base, "hit": None, "decisive_date": None, "unevaluable_reason": reason}


def _close_row(bar: Mapping[str, Any], close: Decimal | None) -> dict[str, Any]:
    return {"trade_date": str(bar.get("trade_date") or ""), "close": None if close is None else str(close)}


def _scaled(value: Decimal | None, ratio: Decimal) -> Decimal | None:
    return None if value is None else value * ratio


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None


def _rate(numerator: int, denominator: int) -> str | None:
    if denominator <= 0:
        return None
    return str((Decimal(numerator) / Decimal(denominator)).quantize(Decimal("0.0001")))


__all__ = [
    "HORIZON_MAX_BARS",
    "HORIZON_MIN_BARS",
    "OUTCOME_SCHEMA_VERSION",
    "adjudicate",
    "condition_resolved_at_anchor",
    "conditions_resolved_at_anchor",
    "evaluate_condition",
    "evaluate_report_outcome",
    "rebase_window_bars",
    "summarize_quality",
]
