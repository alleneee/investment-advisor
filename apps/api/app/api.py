from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .analysis import MarketAnalysisService
from .db import Database
from .information import StockInformationService
from .providers.a_stock_data import normalize_symbol_code
from .providers.tushare import MarketProviderError, TushareMarketProvider
from .reporting import InvestmentReportService, information_reference, validate_report_draft_v2


class WatchItem(BaseModel):
    symbol: str = Field(min_length=9, max_length=9)


class BatchRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=50)


class CreateReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timeframe: Literal["1d", "1w"]


class RetryReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


def create_router(
    db: Database,
    market_service: MarketAnalysisService | None = None,
    information_service: StockInformationService | None = None,
    report_service: InvestmentReportService | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/watchlist")
    def list_watchlist() -> list[dict]:
        return db.list_watch()

    @router.post("/watchlist", status_code=status.HTTP_201_CREATED)
    def add_watchlist(item: WatchItem) -> dict:
        try:
            return db.add_watch(item.symbol)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.delete("/watchlist/{symbol}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_watchlist(symbol: str) -> None:
        db.remove_watch(symbol)

    @router.delete("/watchlist", status_code=status.HTTP_204_NO_CONTENT)
    def delete_watchlist_body(item: WatchItem) -> None:
        db.remove_watch(item.symbol)

    @router.get("/market/{symbol}/analysis")
    def market_analysis(
        symbol: str,
        as_of: date | None = None,
        timeframe: Literal["1d", "1w"] = "1d",
    ) -> dict:
        service = market_service
        try:
            if service is None:
                service = MarketAnalysisService(TushareMarketProvider(), history_store=db)
            return service.analyze(
                symbol,
                as_of=as_of or datetime.now(UTC).date(),
                timeframe=timeframe,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except MarketProviderError as exc:
            raise HTTPException(503, str(exc)) from exc

    @router.get("/market/{symbol}/information")
    def market_information(symbol: str, limit: int = Query(default=20, ge=1, le=20)) -> dict:
        try:
            normalize_symbol_code(symbol)
            if information_service is None:
                raise HTTPException(503, "information service 未配置")
            return information_service.get_information(symbol, limit=limit)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post("/market/{symbol}/reports", status_code=status.HTTP_202_ACCEPTED)
    def create_investment_report(
        symbol: str,
        payload: CreateReportRequest,
        response: Response,
    ) -> dict[str, Any]:
        if report_service is None:
            raise HTTPException(503, "report service 未配置")
        try:
            normalize_symbol_code(symbol)
            job, _ = report_service.create(symbol, payload.timeframe)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except MarketProviderError as exc:
            raise HTTPException(503, str(exc)) from exc
        if job["status"] == "completed":
            response.status_code = status.HTTP_200_OK
        return {
            "report_id": job["report_id"],
            "status": job["status"],
            "cached": job["status"] == "completed",
        }

    @router.post("/batches", status_code=status.HTTP_201_CREATED)
    def create_batch(request: BatchRequest) -> dict:
        return db.create_batch(request.symbols)

    @router.get("/batches/{batch_id}")
    def get_batch(batch_id: str) -> dict:
        value = db.get_batch(batch_id)
        if value is None:
            raise HTTPException(404, "batch 不存在")
        return value

    @router.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict:
        value = db.get_run(run_id)
        if value is None:
            raise HTTPException(404, "run 不存在")
        return value

    @router.get("/reports/{report_id}")
    def get_report(report_id: str) -> dict:
        if report_service is not None:
            job = report_service.get(report_id)
            if job is not None:
                return _report_job_envelope(job)
        value = db.get_report(report_id)
        if value is None:
            raise HTTPException(404, "report 不存在")
        return value

    @router.post("/reports/{report_id}/retry", status_code=status.HTTP_202_ACCEPTED)
    def retry_report(report_id: str, payload: RetryReportRequest | None = None) -> dict[str, Any]:
        if report_service is None:
            raise HTTPException(503, "report service 未配置")
        try:
            job = report_service.retry(report_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {
            "report_id": job["report_id"],
            "status": job["status"],
            "cached": False,
        }

    @router.post("/reports/{report_id}/reviews", status_code=status.HTTP_201_CREATED)
    def review_report(report_id: str, payload: dict) -> dict:
        value = db.add_review(report_id, payload)
        if value is None:
            raise HTTPException(404, "report 不存在")
        return value

    return router


def _report_job_envelope(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "report_id": job["report_id"],
        "status": job["status"],
        "symbol": job["symbol"],
        "timeframe": job["timeframe"],
        "as_of": job["as_of"],
        "input_digest": job["input_digest"],
        "attempt_count": job["attempt_count"],
        "updated_at": job["updated_at"],
        "report": job["result"],
        "error": job["error"],
    }


def create_internal_router(
    db: Database,
    market_service: MarketAnalysisService | None = None,
    token: str | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/internal/v1")
    allowed_tools = {
        "fetch_market_snapshot",
        "run_chan_analysis",
        "collect_information_evidence",
        "emit_research_report",
    }

    def authorize(request: Request) -> None:
        if not token or request.headers.get("authorization") != f"Bearer {token}":
            raise HTTPException(401, "unauthorized")

    def get_state(run_id: str) -> dict[str, Any]:
        state = db.get_advisor_state(run_id)
        if state is None:
            raise HTTPException(404, "advisor run 不存在")
        return state

    def check_envelope(state: dict[str, Any], payload: dict[str, Any]) -> None:
        if int(payload.get("lease_epoch", -1)) != int(state["lease_epoch"]):
            raise HTTPException(409, "lease epoch 冲突")
        if int(payload.get("expected_state_version", -1)) != int(state["state_version"]):
            raise HTTPException(409, "state version 冲突")

    def check_execution(
        run_id: str,
        payload: dict[str, Any],
        *,
        require_execution_id: bool,
    ) -> None:
        try:
            db.validate_investment_report_execution(
                run_id,
                int(payload.get("lease_epoch", -1)),
                str(payload.get("execution_id", "")) if require_execution_id else None,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    def service() -> MarketAnalysisService:
        if market_service is not None:
            return market_service
        try:
            return MarketAnalysisService(TushareMarketProvider(), history_store=db)
        except MarketProviderError as exc:
            raise HTTPException(503, str(exc)) from exc

    @router.get("/agent-runs/{run_id}/state")
    def read_state(run_id: str, request: Request) -> dict[str, Any]:
        authorize(request)
        return get_state(run_id)

    @router.post("/agent-runs/{run_id}/state")
    def write_state(run_id: str, payload: dict[str, Any], request: Request) -> dict[str, bool]:
        authorize(request)
        if payload.get("run_id") != run_id:
            raise HTTPException(422, "run_id 不匹配")
        check_execution(run_id, payload, require_execution_id=False)
        try:
            db.save_advisor_state(payload)
            if db.get_run(run_id) is not None:
                db.update_run_status(
                    run_id,
                    "completed"
                    if payload.get("state") == "COMPLETED"
                    else str(payload.get("state", "queued")).lower(),
                )
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"ok": True}

    @router.post("/tools/{tool}")
    def run_tool(tool: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
        authorize(request)
        if tool not in allowed_tools:
            raise HTTPException(404, "tool 不存在")
        run_id = str(payload.get("run_id", ""))
        check_execution(run_id, payload, require_execution_id=True)
        state = get_state(run_id)
        check_envelope(state, payload)
        current = state.get("artifacts", {})
        if tool == "fetch_market_snapshot":
            snapshot = current.get("frozen_market_snapshot")
            if not isinstance(snapshot, dict) or not snapshot.get("snapshot_id"):
                raise HTTPException(409, "固化 market snapshot 缺失")
            facts = snapshot.get("facts") if isinstance(snapshot.get("facts"), list) else []
            return {
                **payload,
                "snapshot_id": snapshot["snapshot_id"],
                "as_of": str(current.get("as_of") or ""),
                "observations": [
                    {"instrument_ref": current["symbol"], "metric": fact["id"], "value": str(fact["value"])}
                    for fact in facts
                    if isinstance(fact, dict) and "id" in fact and "value" in fact
                ],
            }
        if tool == "run_chan_analysis":
            market = current.get("market")
            if not isinstance(market, dict) or not market.get("snapshot_id"):
                raise HTTPException(409, "market snapshot 尚未提交")
            analysis = current.get("frozen_chan_analysis")
            if not isinstance(analysis, dict) or not analysis.get("analysis_id"):
                raise HTTPException(409, "固化 chan analysis 缺失")
            snapshot = analysis.get("snapshot") if isinstance(analysis.get("snapshot"), dict) else {}
            return {
                **payload,
                "analysis_id": analysis["analysis_id"],
                "signal_summary": (
                    f"confirmed={len(snapshot.get('confirmed', []))}; "
                    f"provisional={len(snapshot.get('provisional', []))}; "
                    f"centers={len(snapshot.get('centers', []))}"
                ),
                "evidence_refs": [market["snapshot_id"]],
            }
        if tool.startswith("collect_"):
            chan = current.get("chan")
            if not isinstance(chan, dict) or not chan.get("analysis_id"):
                raise HTTPException(409, "chan analysis 尚未提交")
            kind = tool.removeprefix("collect_").removesuffix("_evidence")
            evidence_id = f"{kind}-{run_id}"
            if tool == "collect_information_evidence":
                snapshot = current.get("information_snapshot")
                claims = _information_claims(snapshot if isinstance(snapshot, dict) else {})
                return {
                    **payload,
                    "kind": kind,
                    "evidence_id": evidence_id,
                    "claims": claims,
                }
            return {
                **payload,
                "kind": kind,
                "evidence_id": evidence_id,
                "claims": [{
                    "claim": f"Tushare {kind} 附加证据接口在当前运行中未固化，主结论不使用该类事实。",
                    "source_ref": f"tushare-{kind}-{run_id}",
                }],
            }
        if tool == "emit_research_report":
            report = payload.get("report")
            if not isinstance(report, dict) or report.get("run_id") != run_id:
                raise HTTPException(422, "报告草稿无效")
            registry = current.get("reference_registry")
            if not isinstance(registry, dict):
                raise HTTPException(409, "引用注册表缺失")
            try:
                validate_report_draft_v2(report, registry, run_id)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            return report
        raise HTTPException(500, "tool dispatch error")

    return router


def _information_claims(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    claims: list[dict[str, str]] = []
    news = snapshot.get("news")
    if isinstance(news, list):
        for item in (value for value in news if isinstance(value, dict)):
            claim = "；".join(
                value for value in (
                    str(item.get("published_at") or ""),
                    str(item.get("title") or ""),
                    str(item.get("summary") or ""),
                ) if value
            )
            claims.append({"claim": claim[:400], "source_ref": information_reference("news", item)})
            if sum(value["source_ref"].startswith("news.") for value in claims) == 5:
                break

    messages = snapshot.get("messages")
    if isinstance(messages, list):
        answered = (
            value for value in messages
            if isinstance(value, dict) and value.get("answer")
        )
        for item in answered:
            claim = "；".join(
                value for value in (
                    str(item.get("published_at") or ""),
                    f"问：{item.get('question') or ''}",
                    f"答：{item.get('answer') or ''}",
                    f"回复人：{item.get('answerer')}" if item.get("answerer") else "",
                ) if value
            )
            claims.append({"claim": claim[:400], "source_ref": information_reference("irm", item)})
            if sum(value["source_ref"].startswith("irm.") for value in claims) == 3:
                break

    sentiment = snapshot.get("sentiment")
    if isinstance(sentiment, dict):
        rank_values = {
            key: sentiment.get(key)
            for key in ("hot_rank", "heat", "rank_change", "observed_at")
            if sentiment.get(key) is not None
        }
        if any(key in rank_values for key in ("hot_rank", "heat", "rank_change")):
            rank_claim = (
                f"热榜排名 {sentiment.get('hot_rank')}；热度 {sentiment.get('heat')}；"
                f"排名变化 {sentiment.get('rank_change')}；观测时间 {sentiment.get('observed_at')}"
            )
            claims.append({"claim": rank_claim[:400], "source_ref": information_reference("hot", rank_values)})
        concepts = sentiment.get("concepts") if isinstance(sentiment.get("concepts"), list) else []
        if concepts or sentiment.get("tag"):
            concept_values = {"concepts": concepts, "tag": sentiment.get("tag")}
            concept_claim = f"关联概念 {'、'.join(map(str, concepts))}；标签 {sentiment.get('tag')}"
            claims.append({"claim": concept_claim[:400], "source_ref": information_reference("hot", concept_values)})

    if claims:
        return claims[:10]
    quality = snapshot.get("quality") if isinstance(snapshot.get("quality"), dict) else {}
    status_value = str(quality.get("status") or "unavailable")
    warnings = quality.get("warnings") if isinstance(quality.get("warnings"), list) else []
    warning_text = "；".join(str(value) for value in warnings)
    claim = f"资讯快照质量为 {status_value}"
    if warning_text:
        claim = f"{claim}；{warning_text}"
    return [{"claim": claim[:400], "source_ref": "information.quality"}]
