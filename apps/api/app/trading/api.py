from __future__ import annotations

import re
import sqlite3
from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    PositiveInt,
    StrictBool,
    field_validator,
    model_validator,
)

from .reporting import TradingReportService
from .service import TradingService, TradingServiceError, error_code, error_status
from .store import TradingStore

DECIMAL_TEXT = re.compile(r"^(?:0|[1-9]\d*)(?:\.\d+)?$")
BUY_REASONS = {
    "structure_breakout", "pullback_confirmation", "trend_continuation", "reversal_expectation",
    "event_driven", "valuation_recovery", "oversold_rebound", "planned_add", "other",
}
SELL_REASONS = {
    "stop_loss", "take_profit", "structure_invalidated", "target_reached", "planned_reduce",
    "thesis_invalidated", "capital_reallocation", "discipline_violation", "other",
}


class TradingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                return _error_response(status.HTTP_400_BAD_REQUEST, "INVALID_REQUEST", "请求参数无效")
            except TradingServiceError as exc:
                return _error_response(
                    error_status(exc),
                    error_code(exc),
                    str(exc),
                    retryable=bool(getattr(exc, "retryable", False)),
                )
            except (
                ArithmeticError,
                AttributeError,
                KeyError,
                LookupError,
                OSError,
                RuntimeError,
                sqlite3.Error,
                TypeError,
                ValueError,
            ):
                return _error_response(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "交易服务内部错误",
                    retryable=True,
                )

        return wrapped


def _error_response(status_code: int, code: str, message: str, *, retryable: bool = False) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"status": "failed", "error": {"code": code, "message": message}, "retryable": retryable},
    )


class ExactModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DecimalTextModel(ExactModel):
    @field_validator("initial_capital", "price", "fee", "amount", mode="before", check_fields=False)
    @classmethod
    def require_decimal_text(cls, value: object) -> str:
        if not isinstance(value, str) or DECIMAL_TEXT.fullmatch(value) is None:
            raise ValueError("必须是规范十进制文本")
        return value

    @field_validator("initial_capital", "price", "amount", check_fields=False)
    @classmethod
    def require_positive_decimal(cls, value: str) -> str:
        if Decimal(value) <= 0:
            raise ValueError("必须大于 0")
        return value


class CreateAccountRequest(DecimalTextModel):
    name: str = Field(min_length=1)
    activated_on: date
    initial_capital: str


class ExecutionFields(DecimalTextModel):
    symbol: str = Field(min_length=1)
    name: str = Field(min_length=1)
    executed_at: AwareDatetime
    side: Literal["buy", "sell"]
    price: str
    quantity: PositiveInt
    fee: str
    primary_reason: str
    tags: list[str] = Field(max_length=10)
    note: str = Field(max_length=1000)
    client_idempotency_key: UUID

    @model_validator(mode="after")
    def require_reason_for_side(self):
        allowed = BUY_REASONS if self.side == "buy" else SELL_REASONS
        if self.primary_reason not in allowed:
            raise ValueError("primary_reason 与 side 不匹配")
        return self


class CreateExecutionRequest(ExecutionFields):
    pass


class UpdateExecutionRequest(ExecutionFields):
    revision: PositiveInt


class CashFlowFields(DecimalTextModel):
    occurred_at: AwareDatetime
    kind: Literal["deposit", "withdrawal"]
    amount: str
    note: str = Field(max_length=1000)
    client_idempotency_key: UUID


class CreateCashFlowRequest(CashFlowFields):
    pass


class UpdateCashFlowRequest(CashFlowFields):
    revision: PositiveInt


class PutDailyReviewRequest(ExactModel):
    revision: int | None = Field(ge=1, default=None)
    status: Literal["draft", "completed"]
    invalidation_condition: str
    next_day_plan: str
    emotion: Literal["calm", "confident", "anxious", "impulsive", "frustrated", "other"]
    discipline_followed: StrictBool | None
    note: str

    @model_validator(mode="after")
    def require_completed_discipline(self):
        if self.status == "completed" and self.discipline_followed is None:
            raise ValueError("completed 每日收盘复盘必须填写 discipline_followed")
        return self


class TradingReportRequest(ExactModel):
    period_kind: Literal["week", "month", "quarter", "year"]
    period_start: date
    period_end: date


def create_trading_router(
    store: TradingStore,
    *,
    market_provider: object | None = None,
    calendar_provider: object | None = None,
    clock: object | None = None,
    report_scheduler: object | None = None,
) -> APIRouter:
    service = TradingService(
        store,
        market_provider=market_provider,
        calendar_provider=calendar_provider,
        clock=clock,
    )
    report_service = TradingReportService(
        store,
        market_provider=market_provider,
        calendar_provider=calendar_provider,
        scheduler=report_scheduler,
        clock=clock,
    )
    router = APIRouter(prefix="/api/trading", route_class=TradingRoute)

    @router.get("/account")
    def get_account() -> dict:
        return service.account()

    @router.post("/account", status_code=status.HTTP_201_CREATED)
    def create_account(payload: CreateAccountRequest) -> dict:
        return service.create_account(payload.model_dump(mode="json"))

    @router.post("/executions", status_code=status.HTTP_201_CREATED)
    def create_execution(payload: CreateExecutionRequest, response: Response) -> dict:
        row, created = service.create_execution(_execution_payload(payload), _execution_details(payload))
        if not created:
            response.status_code = status.HTTP_200_OK
        return row

    @router.get("/executions")
    def list_executions(
        date: date | None = None,
        start: date | None = None,
        end: date | None = None,
        symbol: str | None = None,
    ) -> list[dict]:
        return service.list_executions(on=date, start=start, end=end, symbol=symbol)

    @router.patch("/executions/{execution_id}")
    def update_execution(execution_id: str, payload: UpdateExecutionRequest) -> dict:
        return service.update_execution(
            execution_id, _execution_payload(payload), _execution_details(payload), payload.revision
        )

    @router.delete("/executions/{execution_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_execution(
        execution_id: str, if_match: Annotated[str | None, Header(alias="If-Match")] = None
    ) -> None:
        service.delete_execution(execution_id, _if_match_revision(if_match))

    @router.post("/cash-flows", status_code=status.HTTP_201_CREATED)
    def create_cash_flow(payload: CreateCashFlowRequest, response: Response) -> dict:
        row, created = service.create_cash_flow(_cash_flow_payload(payload), note=payload.note)
        if not created:
            response.status_code = status.HTTP_200_OK
        return row

    @router.get("/cash-flows")
    def list_cash_flows(
        date: date | None = None, start: date | None = None, end: date | None = None
    ) -> list[dict]:
        return service.list_cash_flows(on=date, start=start, end=end)

    @router.patch("/cash-flows/{cash_flow_id}")
    def update_cash_flow(cash_flow_id: str, payload: UpdateCashFlowRequest) -> dict:
        return service.update_cash_flow(
            cash_flow_id, _cash_flow_payload(payload), note=payload.note, revision=payload.revision
        )

    @router.delete("/cash-flows/{cash_flow_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_cash_flow(
        cash_flow_id: str, if_match: Annotated[str | None, Header(alias="If-Match")] = None
    ) -> None:
        service.delete_cash_flow(cash_flow_id, _if_match_revision(if_match))

    @router.get("/daily-reviews/{trade_date}")
    def get_daily_review(trade_date: date) -> dict:
        return service.get_daily_review(trade_date)

    @router.put("/daily-reviews/{trade_date}")
    def put_daily_review(trade_date: date, payload: PutDailyReviewRequest) -> dict:
        return service.put_daily_review(trade_date, payload.model_dump(mode="json"))

    @router.get("/reviews/preview")
    def preview_review(
        period_kind: Literal["week", "month", "quarter", "year"],
        start: date,
        end: date,
    ) -> dict:
        return report_service.preview(period_kind, start, end)

    @router.post("/reports")
    def create_review_report(payload: TradingReportRequest, response: Response) -> dict:
        result, created = report_service.create(payload.period_kind, payload.period_start, payload.period_end)
        response.status_code = status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK
        return result

    @router.get("/reports")
    def list_review_reports(
        period_kind: Literal["week", "month", "quarter", "year"],
        period_start: date,
        period_end: date,
    ) -> list[dict]:
        return report_service.list(period_kind, period_start, period_end)

    @router.get("/reports/{report_id}")
    def get_review_report(report_id: str) -> dict:
        return report_service.get(report_id)

    @router.post("/reports/{report_id}/retry")
    def retry_review_report(report_id: str, response: Response) -> dict:
        result, _ = report_service.retry(report_id)
        response.status_code = status.HTTP_202_ACCEPTED
        return result

    return router


def _execution_payload(payload: ExecutionFields) -> dict:
    value = payload.model_dump(mode="json", exclude={"name", "tags", "note", "revision"})
    value["occurred_at"] = value.pop("executed_at")
    return value


def _execution_details(payload: ExecutionFields) -> dict:
    return {"name": payload.name, "tags": payload.tags, "note": payload.note}


def _cash_flow_payload(payload: CashFlowFields) -> dict:
    return payload.model_dump(mode="json", exclude={"note", "revision"})


def _if_match_revision(value: str | None) -> int:
    if value is None:
        raise TradingServiceError("If-Match 必填", code="INVALID_REQUEST")
    try:
        revision = int(value.strip('"'))
    except ValueError as exc:
        raise TradingServiceError("If-Match 必须是正整数", code="INVALID_REQUEST") from exc
    if revision <= 0:
        raise TradingServiceError("If-Match 必须是正整数", code="INVALID_REQUEST")
    return revision
