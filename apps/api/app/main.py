from __future__ import annotations

import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .analysis import MarketAnalysisService
from .api import create_internal_router, create_router
from .chan_review import ChanReviewService
from .db import Database
from .information import StockInformationService
from .outcome import ReportOutcomeService
from .providers.a_stock_data import AStockDataProvider
from .providers.factory import create_market_provider
from .reporting import AgentRuntimeClient, InvestmentReportService
from .stock_universe import StockUniverseService
from .trading.api import create_trading_router
from .trading.store import TradingStore


class _LazyChanReviewService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def review(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return ChanReviewService(create_market_provider(), self.database).review(*args, **kwargs)


class _LazyMarketAnalysisService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def analyze(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return MarketAnalysisService(create_market_provider(), history_store=self.database).analyze(
            *args,
            **kwargs,
        )


def create_app(
    database: Database | None = None,
    market_service: MarketAnalysisService | None = None,
    information_service: StockInformationService | None = None,
    agent_runtime_client: Any | None = None,
    report_scheduler: Callable[[Callable[[], None]], None] | None = None,
    report_clock: Callable[[], datetime] | None = None,
    trading_store: TradingStore | None = None,
    trading_market_provider: Any | None = None,
    trading_calendar_provider: Any | None = None,
    trading_clock: Callable[[], datetime] | None = None,
    trading_report_scheduler: Callable[[Callable[[], None]], None] | None = None,
    outcome_market_provider: Any | None = None,
    outcome_clock: Callable[[], datetime] | None = None,
    stock_universe_service: Any | None = None,
    chan_review_service: Any | None = None,
) -> FastAPI:
    db = database or Database()
    information = information_service or StockInformationService(AStockDataProvider(), db)
    stocks = stock_universe_service or StockUniverseService(db)
    reviews = chan_review_service or _LazyChanReviewService(db)
    reports = InvestmentReportService(
        db,
        market_service or _LazyMarketAnalysisService(db),
        information,
        agent_runtime_client
        or AgentRuntimeClient(
            os.getenv("AGENT_RUNTIME_URL", "http://127.0.0.1:8081"),
            os.getenv("INTERNAL_AGENT_TOKEN"),
        ),
        scheduler=report_scheduler,
        clock=report_clock,
        provider=os.getenv("PI_PROVIDER", "new-api"),
        model=os.getenv("PI_MODEL", "glm-5.2"),
    )
    trading = trading_store or TradingStore(db)
    outcomes = ReportOutcomeService(db, outcome_market_provider, clock=outcome_clock)

    @asynccontextmanager
    async def app_lifespan(_: FastAPI):
        db.init()
        yield

    instance = FastAPI(title="Chan Market API", lifespan=app_lifespan)
    
    cors_origins = os.getenv("CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
    instance.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    @instance.get("/health")
    def health_check():
        return {"status": "ok", "timestamp": datetime.now(UTC).isoformat()}
    
    instance.include_router(
        create_router(db, market_service, information, reports, outcomes, stocks, reviews)
    )
    instance.include_router(
        create_trading_router(
            trading,
            market_provider=trading_market_provider,
            calendar_provider=trading_calendar_provider,
            clock=trading_clock,
            report_scheduler=trading_report_scheduler,
        )
    )
    instance.include_router(create_internal_router(db, market_service, os.getenv("INTERNAL_AGENT_TOKEN")))
    return instance
