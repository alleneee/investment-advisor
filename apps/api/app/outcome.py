"""情景兑现评估服务：取回展望窗口的真实行情并固化评估结果。"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from .domain.report_outcome import (
    HORIZON_MAX_BARS,
    conditions_resolved_at_anchor,
    evaluate_report_outcome,
    rebase_window_bars,
    summarize_quality,
)
from .providers.tushare import MarketProviderError, TushareMarketProvider

# 兑现窗口按交易语义取数：北京时间清晨若用 UTC 日期会落到前一天，少取一根最新 K 线。
SHANGHAI = ZoneInfo("Asia/Shanghai")
QualityScope = Literal["published", "all"]


class ReportOutcomeError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ReportOutcomeService:
    def __init__(
        self,
        database: Any,
        market_provider: Any | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.market_provider = market_provider
        self.clock = clock or (lambda: datetime.now(UTC))

    def get(self, report_id: str) -> dict[str, Any] | None:
        return self.database.get_report_outcome(report_id)

    def quality(self, *, scope: QualityScope = "published") -> dict[str, Any]:
        """质量看板。默认只统计已发布报告，被驳回的报告不进对客 track record。

        ``scope="all"`` 是内部复盘视角，包含尚未发布与已驳回的报告。
        """
        published_only = scope != "all"
        return {
            "scope": scope,
            **summarize_quality(
                self.database.list_reviews(published_only=published_only),
                self.database.list_report_outcomes(published_only=published_only),
            ),
        }

    def evaluate(self, report_id: str) -> dict[str, Any]:
        job = self.database.get_investment_report_job(report_id, now=self._now())
        if job is None:
            raise ReportOutcomeError("REPORT_NOT_FOUND", "报告不存在")
        report = job.get("result")
        if job["status"] != "completed" or not isinstance(report, dict):
            raise ReportOutcomeError("REPORT_NOT_COMPLETED", "只有已完成的报告可以评估兑现")

        anchor_date, anchor_close = self._anchor(report)
        if anchor_date is None or anchor_close is None:
            raise ReportOutcomeError("ANCHOR_NOT_AVAILABLE", "报告缺少可校准的行情锚点")

        rows = self._window_rows(str(report.get("symbol") or ""), anchor_date)
        bars, warnings = rebase_window_bars(rows, anchor_trade_date=anchor_date, anchor_close=anchor_close)
        resolved = conditions_resolved_at_anchor(report, anchor_close)
        if resolved:
            warnings = [*warnings, f"条件在固化日已成立或已失效，判定缺少区分力：{'、'.join(resolved)}"]
        outcome = evaluate_report_outcome(
            report,
            bars,
            evaluated_at=self._now().isoformat(),
            window_quality={"warnings": warnings},
        )
        self.database.save_report_outcome(report_id, outcome)
        return outcome

    def _window_rows(self, symbol: str, anchor_date: str) -> list[dict[str, Any]]:
        today = self._now().astimezone(SHANGHAI).date()
        anchor = _parse_trade_date(anchor_date)
        if anchor is None:
            raise ReportOutcomeError("ANCHOR_NOT_AVAILABLE", "报告锚定交易日无效")
        cache_key = (symbol, "1d", "qfq", today.isoformat(), anchor.isoformat(), today.isoformat())
        cached = self.database.get_market_history(*cache_key)
        if cached is not None:
            return cached
        try:
            rows = self._provider().daily(symbol, as_of=today, start_date=anchor, end_date=today)
        except (MarketProviderError, ValueError) as exc:
            raise ReportOutcomeError("MARKET_DATA_UNAVAILABLE", "展望窗口行情不可用") from exc
        if rows:
            self.database.save_market_history(*cache_key, rows)
        return rows

    def _provider(self) -> Any:
        if self.market_provider is None:
            try:
                self.market_provider = TushareMarketProvider()
            except MarketProviderError as exc:
                raise ReportOutcomeError("MARKET_DATA_UNAVAILABLE", "行情服务未配置") from exc
        return self.market_provider

    @staticmethod
    def _anchor(report: dict[str, Any]) -> tuple[str | None, Any]:
        """报告固化窗口的最后一个交易日及其前复权收盘，用作复权基准锚点。"""
        market = report.get("market_snapshot") if isinstance(report.get("market_snapshot"), dict) else {}
        window = market.get("window") if isinstance(market.get("window"), dict) else {}
        bars = [bar for bar in (market.get("bars") or []) if isinstance(bar, dict)]
        anchor_date = window.get("end")
        anchor_close = bars[-1].get("close") if bars else None
        if anchor_close is None:
            registry = report.get("reference_registry") if isinstance(report.get("reference_registry"), dict) else {}
            latest = registry.get("market.latest_close") if isinstance(registry.get("market.latest_close"), dict) else {}
            anchor_close = latest.get("value")
        return (str(anchor_date) if anchor_date else None), anchor_close

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None:
            raise ValueError("outcome clock 必须返回带时区的 datetime")
        return value


def _parse_trade_date(value: str) -> date | None:
    text = str(value)
    try:
        if len(text) == 8 and text.isdigit():
            return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:]}")
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


__all__ = ["HORIZON_MAX_BARS", "ReportOutcomeError", "ReportOutcomeService"]
