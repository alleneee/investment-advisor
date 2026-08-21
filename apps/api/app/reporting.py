from __future__ import annotations

import copy
import hashlib
import json
import re
import threading
import unicodedata
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import psycopg

from .domain.chan_engine import center_containing_price
from .domain.report_outcome import condition_resolved_at_anchor

SHANGHAI = ZoneInfo("Asia/Shanghai")
REPORT_SCHEMA_VERSION = "investment_report.v2"
PROMPT_VERSION = "pi-advisor.v2.1"
DIGEST_FIELDS = (
    "symbol",
    "timeframe",
    "as_of",
    "market_snapshot_id",
    "chan_analysis_id",
    "information_snapshot_id",
    "chan_engine_version",
    "report_schema_version",
    "prompt_version",
    "provider",
    "model",
)
REFERENCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
# 固化日收盘：价格类条件的锚点，用来拒收在报告写出来时就已经被解决的条件。
ANCHOR_REFERENCE = "market.latest_close"
# 近端价格水平取最近这么多根固化 K 线，给模型贴近现价、不会在固化日就已越线的选择。
RECENT_LEVEL_BARS = 60
PRICE_OPERATORS = {"break_above", "hold_above", "break_below", "hold_below"}
STRUCTURE_OPERATORS = {"structure_confirmed", "structure_invalidated"}
# 同一事实上互为逻辑补集的算子：一旦触发成立，失效条件在数学上永远无法成立。
COMPLEMENT_OPERATORS = {
    "hold_above": "break_below",
    "break_below": "hold_above",
    "hold_below": "break_above",
    "break_above": "hold_below",
}
REFERENCE_KINDS = {
    "market",
    "price_level",
    "structure",
    "news",
    "irm",
    "hot",
    "information_quality",
}
FORBIDDEN_SEMANTICS = re.compile(
    r"买入|卖出|做多|做空|仓位|止损|目标价|收益率|回报率|保证收益|承诺收益|"
    r"收益承诺|收益翻倍|当前价格|股价|价格为|price|buy|sell|position|"
    r"stop[- ]?loss|target price|return",
    re.IGNORECASE,
)


class AgentRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


class AgentRuntimeClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def execute(
        self,
        *,
        run_id: str,
        execution_id: str,
        lease_epoch: int,
        expected_state_version: int,
    ) -> dict[str, Any]:
        try:
            response = httpx.post(
                f"{self.base_url}/internal/v1/agent-runs/{run_id}:execute",
                json={
                    "execution_id": execution_id,
                    "lease_epoch": lease_epoch,
                    "expected_state_version": expected_state_version,
                },
                headers={"Authorization": f"Bearer {self.token}"} if self.token else {},
                timeout=245.0,
            )
        except httpx.TimeoutException as exc:
            raise AgentRuntimeError("TIMEOUT", "报告生成请求超时", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise AgentRuntimeError("PROVIDER_ERROR", "报告生成服务不可用", retryable=True) from exc
        if response.is_success:
            body = response.json()
            if not isinstance(body, dict):
                raise AgentRuntimeError("INTERNAL_ERROR", "报告生成服务返回无效结果", retryable=False)
            return body
        body = _safe_json(response)
        error = body.get("error") if isinstance(body.get("error"), dict) else {}
        code = str(error.get("code") or "INTERNAL_ERROR")
        allowed_messages = {
            "INVALID_REQUEST": "报告生成请求无效",
            "MODEL_NOT_READY": "模型服务尚未就绪",
            "PROVIDER_ERROR": "上游服务调用失败",
            "INVALID_MODEL_OUTPUT": "模型报告无效",
            "TIMEOUT": "报告生成请求超时",
            "INTERNAL_ERROR": "报告生成服务内部错误",
            "UNAUTHORIZED": "报告生成服务鉴权失败",
        }
        retryable = bool(error.get("retryable", response.status_code >= 500))
        raise AgentRuntimeError(
            code if code in allowed_messages else "INTERNAL_ERROR",
            allowed_messages.get(code, "报告生成服务内部错误"),
            retryable=retryable,
        )


class InvestmentReportService:
    def __init__(
        self,
        database: Any,
        market_service: Any,
        information_service: Any,
        agent_runtime_client: Any,
        scheduler: Callable[[Callable[[], None]], None] | None = None,
        clock: Callable[[], datetime] | None = None,
        provider: str = "new-api",
        model: str = "glm-5.2",
    ) -> None:
        self.database = database
        self.market_service = market_service
        self.information_service = information_service
        self.agent_runtime_client = agent_runtime_client
        self.scheduler = scheduler or self._thread_scheduler
        self.clock = clock or (lambda: datetime.now(UTC))
        self.provider = provider
        self.model = model

    def create(self, symbol: str, timeframe: str) -> tuple[dict[str, Any], bool]:
        current = self._now()
        as_of = current.date()
        analysis = self.market_service.analyze(symbol, as_of=as_of, timeframe=timeframe)
        # 资讯必须固化到同一个 as_of，否则历史报告会引用固化日之后的新闻（前视偏差）。
        information = self.information_service.get_information(symbol, limit=20, as_of=as_of)
        market = analysis["market_snapshot"]
        chan = analysis["chan_analysis"]
        frozen = {
            "symbol": symbol,
            "timeframe": timeframe,
            "as_of": as_of.isoformat(),
            "market_snapshot": market,
            "chan_analysis": chan,
            "information_snapshot": information,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "prompt_version": PROMPT_VERSION,
            "provider": self.provider,
            "model": self.model,
        }
        frozen["reference_registry"] = build_reference_registry(frozen)
        digest = build_input_digest(
            {
                "symbol": symbol,
                "timeframe": timeframe,
                "as_of": as_of.isoformat(),
                "market_snapshot_id": market["snapshot_id"],
                "chan_analysis_id": chan["analysis_id"],
                "information_snapshot_id": information["snapshot_id"],
                "chan_engine_version": chan["engine_version"],
                "report_schema_version": REPORT_SCHEMA_VERSION,
                "prompt_version": PROMPT_VERSION,
                "provider": self.provider,
                "model": self.model,
            }
        )
        job, owner = self.database.get_or_create_investment_report_job(digest, frozen, now=current)
        if owner:
            self._schedule(job["report_id"])
        return job, owner

    def get(self, report_id: str) -> dict[str, Any] | None:
        return self.database.get_investment_report_job(report_id, now=self._now())

    def retry(self, report_id: str) -> dict[str, Any]:
        job = self.database.retry_investment_report_job(report_id, now=self._now())
        self._schedule(report_id)
        return job

    def _schedule(self, report_id: str) -> None:
        self.scheduler(lambda: self._run(report_id))

    def recover_pending(self) -> None:
        for job in self.database.list_recoverable_investment_report_jobs(now=self._now()):
            self._schedule(job["report_id"])

    def _run(self, report_id: str) -> None:
        execution_id = f"report-{uuid.uuid4()}"
        try:
            job = self.database.claim_investment_report_job(
                report_id,
                execution_id,
                now=self._now(),
            )
        except ValueError:
            return
        try:
            state = self.database.get_advisor_state(job["run_id"])
            if state is None:
                raise AgentRuntimeError(
                    "INTERNAL_ERROR",
                    "报告运行状态不存在",
                    retryable=False,
                )
            response = self.agent_runtime_client.execute(
                run_id=job["run_id"],
                execution_id=execution_id,
                lease_epoch=job["lease_epoch"],
                expected_state_version=state["state_version"],
            )
            draft = response.get("report") if isinstance(response, dict) else None
            if not isinstance(draft, dict) and isinstance(response, dict):
                artifacts = response.get("artifacts")
                if isinstance(artifacts, dict):
                    draft = artifacts.get("report")
            if not isinstance(draft, dict):
                persisted = self.database.get_advisor_state(job["run_id"])
                artifacts = persisted.get("artifacts") if isinstance(persisted, dict) else None
                if isinstance(artifacts, dict):
                    draft = artifacts.get("report")
            if not isinstance(draft, dict):
                raise AgentRuntimeError(
                    "INVALID_MODEL_OUTPUT",
                    "模型报告无效",
                    retryable=False,
                )
            validate_report_draft_v2(
                draft,
                job["frozen_input"]["reference_registry"],
                job["run_id"],
            )
            hydrated = hydrate_report(
                report_id,
                draft,
                job["frozen_input"],
                generated_at=self._now().isoformat(),
            )
            self.database.complete_investment_report_job(
                report_id,
                job["lease_epoch"],
                hydrated,
                now=self._now(),
            )
        except AgentRuntimeError as exc:
            self._fail(report_id, job["lease_epoch"], exc.as_dict())
        except ValueError:
            self._fail(
                report_id,
                job["lease_epoch"],
                AgentRuntimeError(
                    "INVALID_MODEL_OUTPUT",
                    "模型报告无效",
                    retryable=False,
                ).as_dict(),
            )
        except (KeyError, RuntimeError, TypeError, httpx.HTTPError, psycopg.Error):
            self._fail(
                report_id,
                job["lease_epoch"],
                AgentRuntimeError(
                    "INTERNAL_ERROR",
                    "报告生成失败",
                    retryable=True,
                ).as_dict(),
            )

    def _fail(self, report_id: str, lease_epoch: int, error: dict[str, Any]) -> None:
        try:
            self.database.fail_investment_report_job(
                report_id,
                lease_epoch,
                error,
                now=self._now(),
            )
        except ValueError:
            pass

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None:
            raise ValueError("report clock 必须返回带时区的 datetime")
        return value.astimezone(SHANGHAI)

    @staticmethod
    def _thread_scheduler(task: Callable[[], None]) -> None:
        threading.Thread(target=task, daemon=True).start()


def build_input_digest(value: dict[str, Any]) -> str:
    missing = [field for field in DIGEST_FIELDS if field not in value]
    if missing:
        raise ValueError(f"报告输入缺少字段: {', '.join(missing)}")
    canonical = {field: value[field] for field in DIGEST_FIELDS}
    payload = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def information_reference(prefix: str, value: dict[str, Any]) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    digest = hashlib.sha256(f"{prefix}:{serialized}".encode()).hexdigest()[:24]
    return f"{prefix}.{digest}"


def build_reference_registry(frozen_input: dict[str, Any]) -> dict[str, dict[str, Any]]:
    market = frozen_input.get("market_snapshot")
    chan = frozen_input.get("chan_analysis")
    information = frozen_input.get("information_snapshot")
    if not isinstance(market, dict) or not isinstance(chan, dict) or not isinstance(information, dict):
        raise TypeError("固化输入缺少行情、缠论或资讯快照")
    bars = market.get("bars") if isinstance(market.get("bars"), list) else []
    valid_bars = [bar for bar in bars if isinstance(bar, dict)]
    latest = valid_bars[-1] if valid_bars else {}
    latest_close = _decimal_or_none(latest.get("close"))
    recent_bars = valid_bars[-RECENT_LEVEL_BARS:]
    recent_span = _recent_span_label(frozen_input.get("timeframe"))
    registry: dict[str, dict[str, Any]] = {}
    _add_reference(
        registry,
        "market.window",
        "market",
        "固化行情窗口",
        json.dumps(market.get("window", {}), ensure_ascii=False, sort_keys=True, default=str),
    )
    _add_reference(
        registry,
        ANCHOR_REFERENCE,
        "price_level",
        "最新固化收盘",
        latest.get("close"),
        occurred_at=_string_or_none(latest.get("occurred_at")),
    )
    # 固化窗口是五年，窗口极值离现价可能很远；标签写明真实跨度，并把 occurred_at
    # 指向极值实际发生的那根 K 线，避免模型误当成近期高低点使用。
    _add_extreme_reference(registry, "market.recent_high", "五年窗口最高价", valid_bars, "high", highest=True)
    _add_extreme_reference(registry, "market.recent_low", "五年窗口最低价", valid_bars, "low", highest=False)
    _add_extreme_reference(
        registry, "market.recent_high_60", f"近六十{recent_span}最高价", recent_bars, "high", highest=True
    )
    _add_extreme_reference(
        registry, "market.recent_low_60", f"近六十{recent_span}最低价", recent_bars, "low", highest=False
    )

    snapshot = chan.get("snapshot") if isinstance(chan.get("snapshot"), dict) else {}
    structure_value = (
        f"confirmed={len(_list(snapshot.get('confirmed')))};"
        f"provisional={len(_list(snapshot.get('provisional')))};"
        f"centers={len(_list(snapshot.get('centers')))}"
    )
    _add_reference(
        registry,
        "chan.structure",
        "structure",
        "缠论结构状态",
        structure_value,
        occurred_at=_string_or_none(snapshot.get("occurred_at")),
    )
    centers = [value for value in _list(snapshot.get("centers")) if isinstance(value, dict)]
    center = center_containing_price(centers, latest_close)
    if center is not None:
        _add_reference(
            registry,
            "chan.center.upper",
            "price_level",
            "现价所在中枢上沿",
            center.get("upper"),
            occurred_at=_string_or_none(center.get("occurred_at")),
        )
        _add_reference(
            registry,
            "chan.center.lower",
            "price_level",
            "现价所在中枢下沿",
            center.get("lower"),
            occurred_at=_string_or_none(center.get("occurred_at")),
        )

    for item in (value for value in _list(information.get("news")) if isinstance(value, dict)):
        ref = information_reference("news", item)
        _add_reference(
            registry,
            ref,
            "news",
            str(item.get("title") or "资讯"),
            str(item.get("summary") or ""),
            occurred_at=_string_or_none(item.get("published_at")),
            url=_string_or_none(item.get("url")),
        )
    for item in (value for value in _list(information.get("messages")) if isinstance(value, dict) and value.get("answer")):
        ref = information_reference("irm", item)
        _add_reference(
            registry,
            ref,
            "irm",
            str(item.get("question") or "互动问答"),
            str(item.get("answer") or ""),
            occurred_at=_string_or_none(item.get("published_at")),
        )
    sentiment = information.get("sentiment") if isinstance(information.get("sentiment"), dict) else {}
    rank_values = {
        key: _string_or_none(sentiment.get(key))
        if key == "observed_at"
        else sentiment.get(key)
        for key in ("hot_rank", "heat", "rank_change", "observed_at")
        if sentiment.get(key) is not None
    }
    if any(key in rank_values for key in ("hot_rank", "heat", "rank_change")):
        ref = information_reference("hot", rank_values)
        _add_reference(
            registry,
            ref,
            "hot",
            "同花顺热榜",
            json.dumps(rank_values, ensure_ascii=False, sort_keys=True),
            occurred_at=_string_or_none(sentiment.get("observed_at")),
        )
    concepts = sentiment.get("concepts") if isinstance(sentiment.get("concepts"), list) else []
    if concepts or sentiment.get("tag"):
        concept_values = {"concepts": concepts, "tag": sentiment.get("tag")}
        ref = information_reference("hot", concept_values)
        _add_reference(
            registry,
            ref,
            "hot",
            "同花顺概念标签",
            json.dumps(concept_values, ensure_ascii=False, sort_keys=True),
            occurred_at=_string_or_none(sentiment.get("observed_at")),
        )
    if not any(entry["kind"] in {"news", "irm", "hot"} for entry in registry.values()):
        quality = information.get("quality") if isinstance(information.get("quality"), dict) else {}
        _add_reference(
            registry,
            "information.quality",
            "information_quality",
            "资讯快照质量",
            str(quality.get("status") or "unavailable"),
        )
    return registry


def validate_report_draft_v2(
    report: dict[str, Any],
    registry: dict[str, dict[str, Any]],
    run_id: str,
) -> None:
    errors: list[str] = []
    if not isinstance(report, dict):
        raise _report_validation_error("report type")
    _exact(
        report,
        {"version", "run_id", "title", "executive_summary", "outlook", "risks", "evidence_refs"},
        "report",
        errors,
    )
    if report.get("version") != "ReportDraftV2":
        errors.append("version")
    if (
        not isinstance(report.get("run_id"), str)
        or not REFERENCE_ID.fullmatch(report["run_id"])
        or report["run_id"] != run_id
    ):
        errors.append("run_id")
    _validate_narrative(report.get("title"), "title", errors)
    _validate_narrative(report.get("executive_summary"), "executive_summary", errors)
    _validate_registry(registry, errors)
    top_refs = _validate_refs(report.get("evidence_refs"), registry, "evidence_refs", errors)
    if not _coverage(top_refs):
        errors.append("evidence coverage")

    narrative_refs: list[str] = []
    anchor = _anchor_close(registry)
    outlook = report.get("outlook")
    if not isinstance(outlook, dict):
        errors.append("outlook")
    else:
        _exact(outlook, {"horizon", "direction", "confidence", "thesis", "scenarios"}, "outlook", errors)
        if outlook.get("horizon") != "5-20-trading-days":
            errors.append("horizon")
        if outlook.get("direction") not in ["bullish", "sideways", "bearish", "uncertain"]:
            errors.append("direction")
        if outlook.get("confidence") not in ["low", "medium", "high"]:
            errors.append("confidence")
        _validate_narrative(outlook.get("thesis"), "outlook.thesis", errors)
        scenarios = outlook.get("scenarios")
        if not isinstance(scenarios, list) or len(scenarios) != 3:
            errors.append("scenarios")
        else:
            cases: list[Any] = []
            for index, scenario in enumerate(scenarios):
                if not isinstance(scenario, dict):
                    errors.append(f"scenario.{index}")
                    continue
                _exact(scenario, {"case", "narrative", "trigger", "invalidation", "evidence_refs"}, f"scenario.{index}", errors)
                cases.append(scenario.get("case"))
                _validate_narrative(
                    scenario.get("narrative"), f"scenario.{index}.narrative", errors
                )
                _validate_condition(scenario.get("trigger"), registry, errors)
                _validate_condition(scenario.get("invalidation"), registry, errors)
                _validate_condition_pair(
                    scenario.get("trigger"), scenario.get("invalidation"), index, errors
                )
                for name in ("trigger", "invalidation"):
                    _validate_condition_anchor(
                        scenario.get(name), registry, anchor, index, name, errors
                    )
                narrative_refs.extend(
                    _validate_refs(scenario.get("evidence_refs"), registry, f"scenario.{index}.evidence_refs", errors)
                )
            if not all(cases.count(value) == 1 for value in ("bullish", "base", "bearish")):
                errors.append("scenario cases")
    risks = report.get("risks")
    if not isinstance(risks, list):
        errors.append("risks")
    else:
        for index, risk in enumerate(risks):
            if not isinstance(risk, dict):
                errors.append(f"risk.{index}")
                continue
            _exact(risk, {"narrative", "evidence_refs"}, f"risk.{index}", errors)
            _validate_narrative(risk.get("narrative"), f"risk.{index}.narrative", errors)
            narrative_refs.extend(
                _validate_refs(risk.get("evidence_refs"), registry, f"risk.{index}.evidence_refs", errors)
            )
    if not _coverage(narrative_refs):
        errors.append("narrative coverage")
    if errors:
        raise ValueError(f"报告草稿无效: {', '.join(errors)}")


def hydrate_report(
    report_id: str,
    draft: dict[str, Any],
    frozen_input: dict[str, Any],
    *,
    generated_at: str,
) -> dict[str, Any]:
    registry = frozen_input.get("reference_registry")
    if not isinstance(registry, dict):
        raise TypeError("固化输入缺少引用注册表")
    validate_report_draft_v2(draft, registry, str(draft.get("run_id") or ""))
    outlook = copy.deepcopy(draft["outlook"])
    for scenario in outlook["scenarios"]:
        scenario["trigger"]["fact"] = copy.deepcopy(registry[scenario["trigger"]["fact_ref"]])
        scenario["invalidation"]["fact"] = copy.deepcopy(registry[scenario["invalidation"]["fact_ref"]])
        scenario["evidence"] = [copy.deepcopy(registry[ref]) for ref in scenario["evidence_refs"]]
    risks = copy.deepcopy(draft["risks"])
    for risk in risks:
        risk["evidence"] = [copy.deepcopy(registry[ref]) for ref in risk["evidence_refs"]]
    return {
        "id": report_id,
        "schema_version": REPORT_SCHEMA_VERSION,
        "run_id": draft["run_id"],
        "symbol": frozen_input["symbol"],
        "timeframe": frozen_input["timeframe"],
        "as_of": frozen_input["as_of"],
        "generated_at": generated_at,
        "title": draft["title"],
        "executive_summary": draft["executive_summary"],
        "market_snapshot": copy.deepcopy(frozen_input["market_snapshot"]),
        "chan_analysis": copy.deepcopy(frozen_input["chan_analysis"]),
        "information_snapshot": copy.deepcopy(frozen_input["information_snapshot"]),
        "draft": copy.deepcopy(draft),
        "reference_registry": copy.deepcopy(registry),
        "outlook": outlook,
        "risks": risks,
        "evidence_refs": copy.deepcopy(draft["evidence_refs"]),
        "evidence": [copy.deepcopy(registry[ref]) for ref in draft["evidence_refs"]],
        "disclaimer": "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
        "review": {"status": "pending"},
    }


def _add_reference(
    registry: dict[str, dict[str, Any]],
    ref: str,
    kind: str,
    label: str,
    value: Any,
    *,
    occurred_at: str | None = None,
    url: str | None = None,
) -> None:
    entry = {"ref": ref, "kind": kind, "label": label, "value": _json_value(value)}
    if occurred_at is not None:
        entry["occurred_at"] = occurred_at
    if url is not None:
        entry["url"] = url
    registry[ref] = entry


def _add_extreme_reference(
    registry: dict[str, dict[str, Any]],
    ref: str,
    label: str,
    bars: list[dict[str, Any]],
    field: str,
    *,
    highest: bool,
) -> None:
    """暴露一段 K 线的极值水平，occurred_at 指向极值真正发生的那根 K 线。"""
    bar = _extreme_bar(bars, field, highest=highest)
    _add_reference(
        registry,
        ref,
        "price_level",
        label,
        bar.get(field) if bar is not None else None,
        occurred_at=_string_or_none(bar.get("occurred_at")) if bar is not None else None,
    )


def _extreme_bar(bars: list[dict[str, Any]], field: str, *, highest: bool) -> dict[str, Any] | None:
    numeric = [
        (bar, value)
        for bar, value in ((bar, _decimal_or_none(bar.get(field))) for bar in bars)
        if value is not None
    ]
    if not numeric:
        return None
    picker = max if highest else min
    return picker(numeric, key=lambda item: item[1])[0]


def _recent_span_label(timeframe: Any) -> str:
    """近端水平的跨度单位：日线按交易日计，周线按周计。"""
    return "周" if str(timeframe) == "1w" else "个交易日"


def _json_value(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value) if value is not None else None


def _exact(value: dict[str, Any], allowed: set[str], name: str, errors: list[str]) -> None:
    if set(value) != allowed:
        errors.append(f"{name} properties")


def _validate_registry(registry: dict[str, dict[str, Any]], errors: list[str]) -> None:
    required = {"ref", "kind", "label", "value"}
    optional = {"unit", "occurred_at", "url"}
    for ref, entry in registry.items():
        if not REFERENCE_ID.fullmatch(ref) or not isinstance(entry, dict):
            errors.append("registry")
            continue
        keys = set(entry)
        if not required.issubset(keys) or not keys.issubset(required | optional):
            errors.append(f"registry.{ref}.properties")
        kind = entry.get("kind")
        if entry.get("ref") != ref or not isinstance(kind, str) or kind not in REFERENCE_KINDS:
            errors.append(f"registry.{ref}")
        if not isinstance(entry.get("label"), str):
            errors.append(f"registry.{ref}.label")
        value = entry.get("value")
        if value is not None and type(value) not in {str, int, float, bool}:
            errors.append(f"registry.{ref}.value")
        for name in optional:
            if name in entry and not isinstance(entry[name], str):
                errors.append(f"registry.{ref}.{name}")


def _validate_refs(
    value: Any,
    registry: dict[str, dict[str, Any]],
    name: str,
    errors: list[str],
) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(ref, str) or ref not in registry for ref in value):
        errors.append(name)
        return []
    if any(not REFERENCE_ID.fullmatch(ref) for ref in value):
        errors.append(f"{name} id")
    if len(value) != len(set(value)):
        errors.append(f"{name} duplicates")
    return value


def _validate_condition(value: Any, registry: dict[str, dict[str, Any]], errors: list[str]) -> None:
    if not isinstance(value, dict) or set(value) != {"operator", "fact_ref"}:
        errors.append("condition")
        return
    operator = value.get("operator")
    ref = value.get("fact_ref")
    if not isinstance(ref, str) or not REFERENCE_ID.fullmatch(ref):
        errors.append("condition fact_ref")
        return
    entry = registry.get(ref) if isinstance(ref, str) else None
    if isinstance(operator, str) and operator in PRICE_OPERATORS:
        expected = "price_level"
    elif isinstance(operator, str) and operator in STRUCTURE_OPERATORS:
        expected = "structure"
    else:
        errors.append("condition operator")
        return
    if not isinstance(entry, dict) or entry.get("kind") != expected:
        errors.append("condition fact kind")


def _anchor_close(registry: dict[str, dict[str, Any]]) -> Any:
    """固化日收盘价，取自引用注册表本身，不改校验函数签名。

    注册表缺少 ``market.latest_close``、类型不对或值不是数值时返回 ``None``，
    此时跳过锚点校验：精简夹具的注册表允许没有锚点，缺锚点不应导致拒收。
    """
    entry = registry.get(ANCHOR_REFERENCE) if isinstance(registry, dict) else None
    if not isinstance(entry, dict) or entry.get("kind") != "price_level":
        return None
    return entry.get("value")


def _validate_condition_anchor(
    value: Any,
    registry: dict[str, dict[str, Any]],
    anchor: Any,
    index: int,
    name: str,
    errors: list[str],
) -> None:
    """拒收在报告固化时点就已经被解决的价格条件。

    固化日收盘已经越过 break 水平、或已经跌破（越过）hold 水平的条件，在展望
    窗口第一根 K 线上必然命中：这是复述既成事实，不是预测。判据与
    ``app.domain.report_outcome.condition_resolved_at_anchor`` 同一事实源。
    """
    if anchor is None or not isinstance(value, dict):
        return
    ref = value.get("fact_ref")
    entry = registry.get(ref) if isinstance(ref, str) else None
    level = entry.get("value") if isinstance(entry, dict) else None
    if condition_resolved_at_anchor(value.get("operator"), anchor, level):
        errors.append(f"scenario.{index}.{name} resolved at anchor close")


def _validate_condition_pair(trigger: Any, invalidation: Any, index: int, errors: list[str]) -> None:
    """同一事实上的触发与失效条件不得同义反复，否则情景无法被否证。"""
    if not isinstance(trigger, dict) or not isinstance(invalidation, dict):
        return
    trigger_operator = trigger.get("operator")
    invalidation_operator = invalidation.get("operator")
    if not isinstance(trigger_operator, str) or not isinstance(invalidation_operator, str):
        return
    ref = trigger.get("fact_ref")
    if not isinstance(ref, str) or ref != invalidation.get("fact_ref"):
        return
    if (
        trigger_operator == invalidation_operator
        or COMPLEMENT_OPERATORS.get(trigger_operator) == invalidation_operator
    ):
        errors.append(f"scenario.{index} tautological condition pair")


def _coverage(refs: list[str]) -> bool:
    return (
        any(ref.startswith("market.") for ref in refs)
        and any(ref.startswith("chan.") for ref in refs)
        and any(
            ref.startswith(("news.", "irm.", "hot.")) or ref == "information.quality"
            for ref in refs
        )
    )


def _validate_narrative(value: Any, name: str, errors: list[str]) -> None:
    if not isinstance(value, str) or not value:
        errors.append(f"{name} type")
        return
    if FORBIDDEN_SEMANTICS.search(value) or any(
        unicodedata.category(character).startswith("N") for character in value
    ):
        errors.append(f"{name} semantics")


def _safe_json(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _report_validation_error(detail: str) -> ValueError:
    return ValueError(f"报告草稿无效: {detail}")
