from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

BUY_REASONS = (
    "structure_breakout",
    "pullback_confirmation",
    "trend_continuation",
    "reversal_expectation",
    "event_driven",
    "valuation_recovery",
    "oversold_rebound",
    "planned_add",
    "other",
)
SELL_REASONS = (
    "stop_loss",
    "take_profit",
    "structure_invalidated",
    "target_reached",
    "planned_reduce",
    "thesis_invalidated",
    "capital_reallocation",
    "discipline_violation",
    "other",
)
ACCOUNT_METRIC_REFS = (
    "account.adjusted_return_rate",
    "account.period_max_drawdown_rate",
    "account.win_rate",
    "account.average_win_loss_ratio",
    "account.profit_factor",
    "account.median_holding_days",
    "account.median_capital_efficiency",
    "discipline.adherence_rate",
)
ACCOUNT_METRIC_FIELDS = dict(
    zip(
        ACCOUNT_METRIC_REFS,
        (
            "account_adjusted_return_rate",
            "period_max_drawdown_rate",
            "win_rate",
            "average_win_loss_ratio",
            "profit_factor",
            "median_holding_days",
            "median_capital_efficiency",
            "discipline_adherence_rate",
        ),
        strict=True,
    )
)
REASON_SUFFIXES = ("sample_count", "win_rate", "average_cycle_return_rate")
REASON_METRIC_REFS = tuple(
    f"reason.{side}.{reason}.{suffix}"
    for side, reasons in (("buy", BUY_REASONS), ("sell", SELL_REASONS))
    for reason in reasons
    for suffix in REASON_SUFFIXES
)
COMPARISON_METRIC_REFS = tuple(f"comparison.{ref}" for ref in ACCOUNT_METRIC_REFS)
QUALITY_METRIC_REFS = (
    "quality.partial_period",
    "quality.missing_close_price",
    "quality.insufficient_sample",
)
TRADING_REVIEW_METRIC_REFS = frozenset(
    (*ACCOUNT_METRIC_REFS, *REASON_METRIC_REFS, *COMPARISON_METRIC_REFS, *QUALITY_METRIC_REFS)
)
QUALITY_WARNINGS = frozenset(
    (
        "partial_period",
        "missing_close_price",
        "insufficient_overall_sample",
        "insufficient_reason_sample",
        "missing_daily_review",
    )
)
FORBIDDEN_NARRATIVE = re.compile(
    r"(?:建议|应当|应该|立即|直接)(?:买入|卖出)|(?:买入|卖出)(?:该股|股票)|"
    r"仓位(?:比例)?|止损价|目标价|保证收益|承诺收益|收益翻倍|稳赚|"
    r"必然(?:上涨|下跌)|确定(?:上涨|下跌|走势)|(?:buy|sell)\s+(?:this|the)\s+stock|"
    r"position\s+size|stop[- ]?loss\s+price|target\s+price|guaranteed\s+return",
    re.IGNORECASE,
)


class TradingReviewAgentError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


class TradingReviewAgentClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def execute(
        self,
        *,
        report_id: str,
        execution_id: str,
        lease_epoch: int,
        model_input: Mapping[str, Any],
    ) -> dict[str, Any]:
        try:
            response = httpx.post(
                f"{self.base_url}/internal/v1/trading-review-runs/{report_id}:execute",
                json={
                    "execution_id": execution_id,
                    "lease_epoch": lease_epoch,
                    "model_input": model_input,
                },
                headers={"Authorization": f"Bearer {self.token}"} if self.token else {},
                timeout=130.0,
            )
        except httpx.TimeoutException as exc:
            raise TradingReviewAgentError("TIMEOUT", "交易复盘生成请求超时", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise TradingReviewAgentError("PROVIDER_ERROR", "交易复盘生成服务不可用", retryable=True) from exc
        if response.is_success:
            try:
                body = response.json()
            except ValueError as exc:
                raise TradingReviewAgentError("INTERNAL_ERROR", "交易复盘生成服务返回无效结果", retryable=False) from exc
            if not isinstance(body, dict):
                raise TradingReviewAgentError("INTERNAL_ERROR", "交易复盘生成服务返回无效结果", retryable=False)
            return body
        try:
            body = response.json()
        except ValueError:
            body = {}
        error = body.get("error") if isinstance(body, Mapping) and isinstance(body.get("error"), Mapping) else {}
        code = str(error.get("code") or "INTERNAL_ERROR")
        messages = {
            "INVALID_REQUEST": "交易复盘生成请求无效",
            "MODEL_NOT_READY": "模型服务尚未就绪",
            "PROVIDER_ERROR": "上游模型服务调用失败",
            "INVALID_MODEL_OUTPUT": "模型复盘内容无效",
            "TIMEOUT": "交易复盘生成请求超时",
            "INTERNAL_ERROR": "交易复盘生成服务内部错误",
            "UNAUTHORIZED": "交易复盘生成服务鉴权失败",
        }
        raise TradingReviewAgentError(
            code if code in messages else "INTERNAL_ERROR",
            messages.get(code, messages["INTERNAL_ERROR"]),
            retryable=bool(error.get("retryable", response.status_code >= 500)),
        )


def _number(value: Any) -> float | None:
    if isinstance(value, Mapping):
        value = value.get("value")
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _metric_registry_entry(ref: str, value: Any, allowed: bool) -> dict[str, Any]:
    return {"ref": ref, "value": value, "conclusion_allowed": bool(allowed and value is not None)}


def build_trading_review_model_input(payload: Mapping[str, Any]) -> dict[str, Any]:
    report = payload.get("deterministic_report")
    if not isinstance(report, Mapping):
        raise TypeError("确定性复盘报告缺失")
    sample = report.get("sample") if isinstance(report.get("sample"), Mapping) else {}
    metrics = report.get("metrics") if isinstance(report.get("metrics"), Mapping) else {}
    overall_allowed = sample.get("overall_conclusion_allowed") is True
    metric_values = {
        ref: _number(metrics.get(field)) for ref, field in ACCOUNT_METRIC_FIELDS.items()
    }
    model_metrics = {
        field: metric_values[ref] for ref, field in ACCOUNT_METRIC_FIELDS.items()
    }
    reason_groups = []
    registry = [
        _metric_registry_entry(ref, metric_values[ref], overall_allowed)
        for ref in ACCOUNT_METRIC_REFS
    ]
    reason_rows = report.get("reason_performance")
    if isinstance(reason_rows, Sequence) and not isinstance(reason_rows, (str, bytes)):
        for row in reason_rows:
            if not isinstance(row, Mapping):
                continue
            side = row.get("side")
            reason = row.get("reason_code")
            if side == "buy" and reason not in BUY_REASONS or side == "sell" and reason not in SELL_REASONS:
                continue
            if side not in ("buy", "sell"):
                continue
            allowed = row.get("conclusion_allowed") is True
            group = {
                "side": side,
                "reason_code": reason,
                "sample_count": int(row.get("sample_count") or 0),
                "conclusion_allowed": allowed,
                "win_rate": _number(row.get("win_rate")),
                "average_cycle_return_rate": _number(row.get("average_cycle_return_rate")),
            }
            reason_groups.append(group)
            for suffix in REASON_SUFFIXES:
                registry.append(
                    _metric_registry_entry(
                        f"reason.{side}.{reason}.{suffix}", group[suffix], allowed
                    )
                )
    comparison = None
    comparison_payload = report.get("comparison")
    if isinstance(comparison_payload, Mapping) and payload.get("partial_period") is not True:
        rows = comparison_payload.get("metrics")
        if isinstance(rows, Sequence) and not isinstance(rows, (str, bytes)):
            by_ref = {
                str(row.get("metric_ref")): _number(row.get("delta"))
                for row in rows
                if isinstance(row, Mapping)
            }
            comparison = [{"metric_ref": ref, "delta": by_ref.get(ref)} for ref in ACCOUNT_METRIC_REFS]
            registry.extend(
                _metric_registry_entry(f"comparison.{item['metric_ref']}", item["delta"], overall_allowed)
                for item in comparison
            )
    raw_cases = report.get("cycle_cases")
    candidates = []
    if isinstance(raw_cases, Sequence) and not isinstance(raw_cases, (str, bytes)):
        for row in raw_cases:
            if not isinstance(row, Mapping):
                continue
            cycle_return = _number(row.get("cycle_return_rate"))
            holding_days = _number(row.get("holding_days"))
            buy_reason = row.get("buy_reason_code")
            sell_reason = row.get("sell_reason_code")
            if cycle_return is None or holding_days is None or holding_days < 1:
                continue
            if buy_reason not in BUY_REASONS or sell_reason not in SELL_REASONS:
                continue
            candidates.append(
                {
                    "cycle_return_rate": cycle_return,
                    "holding_days": holding_days,
                    "buy_reason_code": buy_reason,
                    "sell_reason_code": sell_reason,
                    "discipline_followed": row.get("discipline_followed")
                    if isinstance(row.get("discipline_followed"), bool)
                    else None,
                }
            )
    selected = []
    if candidates:
        ordered = sorted(candidates, key=lambda item: item["cycle_return_rate"])
        selected = [ordered[-1]]
        if len(ordered) > 1:
            selected.append(ordered[0])
    cases = [{"case_label": "case_a" if index == 0 else "case_b", **item} for index, item in enumerate(selected)]
    quality = report.get("quality") if isinstance(report.get("quality"), Mapping) else {}
    raw_warnings = quality.get("warnings") if isinstance(quality.get("warnings"), Sequence) else []
    warnings = sorted({str(item) for item in raw_warnings if str(item) in QUALITY_WARNINGS})
    partial = payload.get("partial_period") is True
    registry.extend(
        (
            {"ref": "quality.partial_period", "value": partial, "conclusion_allowed": False},
            {
                "ref": "quality.missing_close_price",
                "value": "missing_close_price" in warnings,
                "conclusion_allowed": False,
            },
            {
                "ref": "quality.insufficient_sample",
                "value": not overall_allowed,
                "conclusion_allowed": False,
            },
        )
    )
    return {
        "schema_version": "trading_review_model_input.v1",
        "period": {
            "kind": payload.get("period_kind"),
            "trading_day_count": int(sample.get("trading_day_count") or 0),
            "partial_period": partial,
        },
        "sample": {
            "closed_cycle_count": int(sample.get("closed_cycle_count") or 0),
            "overall_conclusion_allowed": overall_allowed,
        },
        "metrics": model_metrics,
        "reason_groups": reason_groups,
        "metric_registry": registry,
        "cases": cases,
        "comparison": comparison,
        "quality_warnings": warnings,
    }


def _exact(value: Any, keys: set[str], path: str, errors: list[str]) -> bool:
    if not isinstance(value, Mapping):
        errors.append(f"{path} 必须是对象")
        return False
    if set(value) != keys:
        errors.append(f"{path} 字段不合法")
    return True


def _finite(
    value: Any,
    path: str,
    errors: list[str],
    *,
    nullable: bool = False,
    integer: bool = False,
    minimum: float | None = None,
    maximum: float | None = None,
) -> None:
    if value is None and nullable:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        errors.append(f"{path} 必须是有限数值")
        return
    if integer and not isinstance(value, int):
        errors.append(f"{path} 必须是整数")
    if minimum is not None and value < minimum:
        errors.append(f"{path} 小于最小值")
    if maximum is not None and value > maximum:
        errors.append(f"{path} 大于最大值")


def _same_metric_value(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left is right
    if left is None or right is None:
        return left is None and right is None
    return isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right


def _expected_metric_registry(value: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    sample = value.get("sample") if isinstance(value.get("sample"), Mapping) else {}
    metrics = value.get("metrics") if isinstance(value.get("metrics"), Mapping) else {}
    overall_allowed = sample.get("overall_conclusion_allowed") is True
    for ref, field in ACCOUNT_METRIC_FIELDS.items():
        metric_value = metrics.get(field)
        result[ref] = {
            "value": metric_value,
            "conclusion_allowed": overall_allowed and metric_value is not None,
        }
    groups = value.get("reason_groups")
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            side = group.get("side")
            reason = group.get("reason_code")
            if side not in ("buy", "sell") or not isinstance(reason, str):
                continue
            allowed = group.get("conclusion_allowed") is True
            for suffix in REASON_SUFFIXES:
                metric_value = group.get(suffix)
                result[f"reason.{side}.{reason}.{suffix}"] = {
                    "value": metric_value,
                    "conclusion_allowed": allowed and metric_value is not None,
                }
    comparison = value.get("comparison")
    if isinstance(comparison, list):
        for item in comparison:
            if not isinstance(item, Mapping) or not isinstance(item.get("metric_ref"), str):
                continue
            metric_value = item.get("delta")
            result[f"comparison.{item['metric_ref']}"] = {
                "value": metric_value,
                "conclusion_allowed": overall_allowed and metric_value is not None,
            }
    period = value.get("period") if isinstance(value.get("period"), Mapping) else {}
    warnings = value.get("quality_warnings") if isinstance(value.get("quality_warnings"), list) else []
    result.update(
        {
            "quality.partial_period": {
                "value": period.get("partial_period"),
                "conclusion_allowed": False,
            },
            "quality.missing_close_price": {
                "value": "missing_close_price" in warnings,
                "conclusion_allowed": False,
            },
            "quality.insufficient_sample": {
                "value": not overall_allowed,
                "conclusion_allowed": False,
            },
        }
    )
    return result


def validate_trading_review_model_input(value: Any) -> list[str]:
    errors: list[str] = []
    root = {
        "schema_version",
        "period",
        "sample",
        "metrics",
        "reason_groups",
        "metric_registry",
        "cases",
        "comparison",
        "quality_warnings",
    }
    if not _exact(value, root, "input", errors):
        return errors
    if value.get("schema_version") != "trading_review_model_input.v1":
        errors.append("schema_version 不合法")
    period = value.get("period")
    if _exact(period, {"kind", "trading_day_count", "partial_period"}, "period", errors):
        if period.get("kind") not in ("week", "month", "quarter", "year"):
            errors.append("period.kind 不合法")
        _finite(period.get("trading_day_count"), "period.trading_day_count", errors, integer=True, minimum=0)
        if not isinstance(period.get("partial_period"), bool):
            errors.append("period.partial_period 不合法")
    sample = value.get("sample")
    if _exact(sample, {"closed_cycle_count", "overall_conclusion_allowed"}, "sample", errors):
        _finite(sample.get("closed_cycle_count"), "sample.closed_cycle_count", errors, integer=True, minimum=0)
        if not isinstance(sample.get("overall_conclusion_allowed"), bool):
            errors.append("sample.overall_conclusion_allowed 不合法")
    metric_bounds = {
        "account_adjusted_return_rate": (-1, None),
        "period_max_drawdown_rate": (0, 1),
        "win_rate": (0, 1),
        "average_win_loss_ratio": (0, None),
        "profit_factor": (0, None),
        "median_holding_days": (1, None),
        "median_capital_efficiency": (None, None),
        "discipline_adherence_rate": (0, 1),
    }
    metrics = value.get("metrics")
    if _exact(metrics, set(metric_bounds), "metrics", errors):
        for field, (minimum, maximum) in metric_bounds.items():
            _finite(metrics.get(field), f"metrics.{field}", errors, nullable=True, minimum=minimum, maximum=maximum)
    groups = value.get("reason_groups")
    if not isinstance(groups, list):
        errors.append("reason_groups 必须是数组")
        groups = []
    group_identities = set()
    for index, group in enumerate(groups):
        keys = {"side", "reason_code", "sample_count", "conclusion_allowed", "win_rate", "average_cycle_return_rate"}
        if not _exact(group, keys, f"reason_groups.{index}", errors):
            continue
        reasons = BUY_REASONS if group.get("side") == "buy" else SELL_REASONS if group.get("side") == "sell" else ()
        if group.get("reason_code") not in reasons:
            errors.append(f"reason_groups.{index}.reason_code 与 side 不匹配")
        identity = (group.get("side"), group.get("reason_code"))
        if identity in group_identities:
            errors.append(f"reason_groups.{index} 重复")
        group_identities.add(identity)
        _finite(group.get("sample_count"), f"reason_groups.{index}.sample_count", errors, integer=True, minimum=0)
        if not isinstance(group.get("conclusion_allowed"), bool):
            errors.append(f"reason_groups.{index}.conclusion_allowed 不合法")
        _finite(group.get("win_rate"), f"reason_groups.{index}.win_rate", errors, nullable=True, minimum=0, maximum=1)
        _finite(group.get("average_cycle_return_rate"), f"reason_groups.{index}.average_cycle_return_rate", errors, nullable=True)
    comparison = value.get("comparison")
    if comparison is not None:
        if not isinstance(comparison, list) or len(comparison) != len(ACCOUNT_METRIC_REFS):
            errors.append("comparison 必须按固定顺序包含全部指标")
        else:
            for index, (item, ref) in enumerate(zip(comparison, ACCOUNT_METRIC_REFS, strict=True)):
                if _exact(item, {"metric_ref", "delta"}, f"comparison.{index}", errors):
                    if item.get("metric_ref") != ref:
                        errors.append(f"comparison.{index}.metric_ref 顺序不合法")
                    _finite(item.get("delta"), f"comparison.{index}.delta", errors, nullable=True)
    cases = value.get("cases")
    if not isinstance(cases, list) or len(cases) > 2:
        errors.append("cases 不合法")
        cases = []
    labels = set()
    for index, case in enumerate(cases):
        keys = {"case_label", "cycle_return_rate", "holding_days", "buy_reason_code", "sell_reason_code", "discipline_followed"}
        if not _exact(case, keys, f"cases.{index}", errors):
            continue
        if case.get("case_label") not in ("case_a", "case_b") or case.get("case_label") in labels:
            errors.append(f"cases.{index}.case_label 不合法")
        labels.add(case.get("case_label"))
        _finite(case.get("cycle_return_rate"), f"cases.{index}.cycle_return_rate", errors)
        _finite(case.get("holding_days"), f"cases.{index}.holding_days", errors, minimum=1)
        if case.get("buy_reason_code") not in BUY_REASONS or case.get("sell_reason_code") not in SELL_REASONS:
            errors.append(f"cases.{index} 理由不合法")
        if case.get("discipline_followed") is not None and not isinstance(case.get("discipline_followed"), bool):
            errors.append(f"cases.{index}.discipline_followed 不合法")
    warnings = value.get("quality_warnings")
    if not isinstance(warnings, list) or len(set(warnings)) != len(warnings) or any(item not in QUALITY_WARNINGS for item in warnings):
        errors.append("quality_warnings 不合法")
    registry = value.get("metric_registry")
    if not isinstance(registry, list):
        errors.append("metric_registry 必须是数组")
    else:
        expected_registry = _expected_metric_registry(value)
        seen = set()
        for index, item in enumerate(registry):
            if not _exact(item, {"ref", "value", "conclusion_allowed"}, f"metric_registry.{index}", errors):
                continue
            ref = item.get("ref")
            if ref not in TRADING_REVIEW_METRIC_REFS or ref not in expected_registry or ref in seen:
                errors.append(f"metric_registry.{index}.ref 不合法")
            seen.add(ref)
            if not isinstance(item.get("conclusion_allowed"), bool):
                errors.append(f"metric_registry.{index}.conclusion_allowed 不合法")
            item_value = item.get("value")
            if item_value is not None and not isinstance(item_value, bool):
                _finite(item_value, f"metric_registry.{index}.value", errors)
            expected = expected_registry.get(ref)
            if expected and (
                not _same_metric_value(item_value, expected["value"])
                or item.get("conclusion_allowed") is not expected["conclusion_allowed"]
            ):
                errors.append(f"metric_registry.{index} 与源指标矛盾")
    return errors


def _narrative(value: Any, path: str, errors: list[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{path} 必须是非空字符串")
    elif FORBIDDEN_NARRATIVE.search(value) or any(
        unicodedata.category(character).startswith("N") for character in value
    ):
        errors.append(f"{path} 包含禁止语义或数字")


def validate_trading_review_draft(value: Any, model_input: Mapping[str, Any]) -> list[str]:
    errors = validate_trading_review_model_input(model_input)
    if errors:
        return [f"input: {error}" for error in errors]
    keys = {"schema_version", "title", "profit_sources", "loss_patterns", "discipline_review", "limitations", "next_period_experiment"}
    if not _exact(value, keys, "draft", errors):
        return errors
    if value.get("schema_version") != "trading_review_draft.v1" or value.get("title") != "周期交易复盘":
        errors.append("draft 版本或标题不合法")
    registry = {
        item["ref"]: item["conclusion_allowed"]
        for item in model_input["metric_registry"]
        if isinstance(item, Mapping) and isinstance(item.get("ref"), str)
    }

    def refs(items: Any, path: str) -> None:
        if not isinstance(items, list) or len(set(items)) != len(items):
            errors.append(f"{path} 不合法")
            return
        if any(ref not in registry or registry.get(ref) is not True for ref in items):
            errors.append(f"{path} 包含未知或不可下结论的引用")

    def evidence(item: Any, path: str) -> None:
        if not _exact(item, {"narrative", "metric_refs"}, path, errors):
            return
        _narrative(item.get("narrative"), f"{path}.narrative", errors)
        refs(item.get("metric_refs"), f"{path}.metric_refs")

    for field in ("profit_sources", "loss_patterns"):
        items = value.get(field)
        if not isinstance(items, list):
            errors.append(f"{field} 必须是数组")
        else:
            for index, item in enumerate(items):
                evidence(item, f"{field}.{index}")
    evidence(value.get("discipline_review"), "discipline_review")
    limitations = value.get("limitations")
    if not isinstance(limitations, list) or not limitations:
        errors.append("limitations 必须是非空数组")
    else:
        for index, item in enumerate(limitations):
            _narrative(item, f"limitations.{index}", errors)
    experiment = value.get("next_period_experiment")
    experiment_keys = {"hypothesis", "action", "measurement", "success_criterion", "metric_refs"}
    if _exact(experiment, experiment_keys, "next_period_experiment", errors):
        for field in ("hypothesis", "action", "measurement", "success_criterion"):
            _narrative(experiment.get(field), f"next_period_experiment.{field}", errors)
        refs(experiment.get("metric_refs"), "next_period_experiment.metric_refs")
    return errors


__all__ = [
    "TradingReviewAgentClient",
    "TradingReviewAgentError",
    "build_trading_review_model_input",
    "validate_trading_review_draft",
    "validate_trading_review_model_input",
]
