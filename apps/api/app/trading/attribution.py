"""成交 × 缠论结构位置归因。

归因口径：
- 时点结构：对每笔成交，只用该股票截至成交日（含当日）的日线 K 线增量重放
  ChanEngine，禁止使用成交日之后才形成的结构（无前视）。
- 活跃中枢：成交日快照 ``centers`` 中 ``end_index`` 最大的中枢（并列时取
  ``start_index`` 更大者）。顺序笔中枢下这就是当时仍在延伸的最新中枢。
- 复权换算：成交价是真实历史价（未复权），缓存行情的 ``qfq_close`` 以取数窗口
  最后一日为基准；换算 ``成交价_qfq = 成交价 × qfq_close(成交日) / close(成交日)``，
  再与中枢 ``[lower, upper]`` 比较。
- 类别边界：中枢区间按闭区间处理——``成交价_qfq > upper`` 为 above_center、
  ``< lower`` 为 below_center、等于上沿或下沿都算 inside_center。
- 聚合：归因单位是交易周期，每个周期按其首笔买入成交（``start_event_id``）的
  结构位置归类；开放周期单独计数、不参与胜率。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Any, Literal
from zoneinfo import ZoneInfo

from ..domain.chan_engine import CanonicalBar, ChanEngine
from .reducer import ClosedCycle, canonical_decimal_text, money_text

SHANGHAI = ZoneInfo("Asia/Shanghai")
MARKET_WINDOW_DAYS = 365 * 5
ADJUSTED_PRICE_QUANTUM = Decimal("0.000001")

AttributionCategory = Literal[
    "above_center", "inside_center", "below_center", "no_center", "unclassified"
]
CATEGORIES: tuple[AttributionCategory, ...] = (
    "above_center",
    "inside_center",
    "below_center",
    "no_center",
    "unclassified",
)
UnclassifiedReason = Literal[
    "missing_market_data",
    "missing_bar_on_execution_date",
    "adjustment_unavailable",
]


@dataclass(frozen=True, slots=True)
class ExecutionAttribution:
    execution_id: str
    symbol: str
    trade_date: date
    executed_at: str
    side: str
    price: Decimal
    quantity: int
    adjusted_price: Decimal | None
    center_lower: Decimal | None
    center_upper: Decimal | None
    category: AttributionCategory
    reason: UnclassifiedReason | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "symbol": self.symbol,
            "trade_date": self.trade_date.isoformat(),
            "executed_at": self.executed_at,
            "side": self.side,
            "price": canonical_decimal_text(self.price),
            "quantity": self.quantity,
            "adjusted_price": None
            if self.adjusted_price is None
            else canonical_decimal_text(
                self.adjusted_price.quantize(ADJUSTED_PRICE_QUANTUM, rounding=ROUND_HALF_UP)
            ),
            "center_lower": None if self.center_lower is None else canonical_decimal_text(self.center_lower),
            "center_upper": None if self.center_upper is None else canonical_decimal_text(self.center_upper),
            "category": self.category,
            "reason": self.reason,
        }


def _decimal(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _business_date(value: Any) -> date:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            return value.date()
        return value.astimezone(SHANGHAI).date()
    if isinstance(value, date):
        return value
    text = str(value)
    if len(text) == 8 and text.isdigit():
        return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:]}")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return date.fromisoformat(text[:10])
    return _business_date(parsed)


def adjusted_execution_price(price: Decimal, *, raw_close: Decimal, qfq_close: Decimal) -> Decimal:
    """把真实成交价换算到缓存行情的前复权基准。"""
    if raw_close == 0:
        raise ValueError("成交日原始收盘价为 0，无法换算复权基准")
    with localcontext() as context:
        context.prec = 28
        return price * qfq_close / raw_close


def active_center(centers: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """成交时点最近仍在延伸的笔中枢：end_index 最大者，并列取 start_index 更大者。"""
    if not centers:
        return None
    return max(centers, key=lambda item: (int(item["end_index"]), int(item["start_index"])))


def classify_price(adjusted_price: Decimal, center: Mapping[str, Any]) -> AttributionCategory:
    lower, upper = _decimal(center["lower"]), _decimal(center["upper"])
    if adjusted_price > upper:
        return "above_center"
    if adjusted_price < lower:
        return "below_center"
    return "inside_center"


def _bar(symbol: str, row: Mapping[str, Any]) -> CanonicalBar:
    def price(name: str) -> Any:
        value = row.get(f"qfq_{name}")
        return row.get(name) if value is None else value

    trade_date = _business_date(row["trade_date"])
    occurred_at = datetime.combine(trade_date, datetime.min.time(), tzinfo=SHANGHAI)
    return CanonicalBar(
        symbol=symbol,
        occurred_at=occurred_at,
        known_at=occurred_at,
        stable_through=occurred_at,
        open=price("open"),
        high=price("high"),
        low=price("low"),
        close=price("close"),
        volume=row.get("vol"),
    )


def _centers_by_date(
    symbol: str, rows: Sequence[Mapping[str, Any]], needed_dates: set[date]
) -> dict[date, list[Mapping[str, Any]]]:
    """一次增量重放，捕获每个成交日（含当日）时点的中枢列表。

    ChanEngine.replay 本身就是逐根 ingest，因此在第 n 根 K 线后捕获的快照与
    对前缀切片重放的结果一致，且只需一次全窗口重放。
    """
    if not needed_dates:
        return {}
    bars = sorted(
        (_bar(symbol, row) for row in rows if row.get("close") is not None),
        key=lambda bar: bar.occurred_at,
    )
    last_needed = max(needed_dates)
    engine = ChanEngine()
    result: dict[date, list[Mapping[str, Any]]] = {}
    for bar in bars:
        bar_date = bar.occurred_at.date()
        if bar_date > last_needed:
            break
        engine.ingest(bar)
        if bar_date in needed_dates:
            result[bar_date] = list(engine.snapshot()["centers"])
    return result


def attribute_executions(
    executions: Sequence[Mapping[str, Any]],
    market_rows_by_symbol: Mapping[str, Sequence[Mapping[str, Any]] | None],
) -> list[ExecutionAttribution]:
    """对每笔成交给出成交时点的缠论结构位置（纯函数，无 I/O）。"""
    by_symbol: dict[str, list[Mapping[str, Any]]] = {}
    for row in executions:
        by_symbol.setdefault(str(row["symbol"]), []).append(row)

    result: list[ExecutionAttribution] = []
    for symbol, symbol_executions in by_symbol.items():
        rows = market_rows_by_symbol.get(symbol) or []
        row_by_date = {_business_date(row["trade_date"]): row for row in rows}
        execution_dates = {
            _business_date(row.get("occurred_at", row.get("executed_at")))
            for row in symbol_executions
        }
        centers_by_date = _centers_by_date(symbol, rows, execution_dates & set(row_by_date))
        for row in symbol_executions:
            result.append(
                _attribute_one(symbol, row, row_by_date, centers_by_date, has_market_data=bool(rows))
            )
    return sorted(result, key=lambda item: (item.trade_date, item.executed_at, item.execution_id))


def _attribute_one(
    symbol: str,
    row: Mapping[str, Any],
    row_by_date: Mapping[date, Mapping[str, Any]],
    centers_by_date: Mapping[date, Sequence[Mapping[str, Any]]],
    *,
    has_market_data: bool,
) -> ExecutionAttribution:
    occurred_at = str(row.get("occurred_at", row.get("executed_at")))
    trade_date = _business_date(occurred_at)
    price = _decimal(row["price"])
    base = {
        "execution_id": str(row.get("execution_id", row.get("event_id", ""))),
        "symbol": symbol,
        "trade_date": trade_date,
        "executed_at": occurred_at,
        "side": str(row["side"]),
        "price": price,
        "quantity": int(row["quantity"]),
    }
    if not has_market_data:
        return ExecutionAttribution(
            **base, adjusted_price=None, center_lower=None, center_upper=None,
            category="unclassified", reason="missing_market_data",
        )
    bar_row = row_by_date.get(trade_date)
    if bar_row is None:
        return ExecutionAttribution(
            **base, adjusted_price=None, center_lower=None, center_upper=None,
            category="unclassified", reason="missing_bar_on_execution_date",
        )
    raw_close = bar_row.get("close")
    qfq_close = bar_row.get("qfq_close", raw_close)
    if raw_close is None or qfq_close is None or _decimal(raw_close) == 0:
        return ExecutionAttribution(
            **base, adjusted_price=None, center_lower=None, center_upper=None,
            category="unclassified", reason="adjustment_unavailable",
        )
    adjusted = adjusted_execution_price(
        price, raw_close=_decimal(raw_close), qfq_close=_decimal(qfq_close)
    )
    center = active_center(centers_by_date.get(trade_date, ()))
    if center is None:
        return ExecutionAttribution(
            **base, adjusted_price=adjusted, center_lower=None, center_upper=None,
            category="no_center", reason=None,
        )
    return ExecutionAttribution(
        **base,
        adjusted_price=adjusted,
        center_lower=_decimal(center["lower"]),
        center_upper=_decimal(center["upper"]),
        category=classify_price(adjusted, center),
        reason=None,
    )


def summarize_cycles(
    cycles: Sequence[ClosedCycle],
    attribution_by_execution_id: Mapping[str, ExecutionAttribution],
    *,
    period_start: date | None = None,
    period_end: date | None = None,
) -> list[dict[str, Any]]:
    """按类别聚合交易周期；周期类别取其首笔买入成交的结构位置。"""
    closed_by_category: dict[AttributionCategory, list[ClosedCycle]] = {key: [] for key in CATEGORIES}
    open_by_category: dict[AttributionCategory, int] = {key: 0 for key in CATEGORIES}
    for cycle in cycles:
        first_buy = attribution_by_execution_id.get(cycle.start_event_id)
        if first_buy is None:
            continue
        if not _within(first_buy.trade_date, period_start, period_end):
            continue
        if cycle.closed:
            closed_by_category[first_buy.category].append(cycle)
        else:
            open_by_category[first_buy.category] += 1
    result: list[dict[str, Any]] = []
    for category in CATEGORIES:
        closed = closed_by_category[category]
        won = sum(1 for cycle in closed if cycle.net_pnl > 0)
        total_pnl = sum((cycle.net_pnl for cycle in closed), Decimal(0))
        result.append(
            {
                "category": category,
                "closed_cycles": len(closed),
                "open_cycles": open_by_category[category],
                "won": won,
                "win_rate": canonical_decimal_text(Decimal(won) / len(closed)) if closed else None,
                "total_pnl": canonical_decimal_text(total_pnl),
                "avg_pnl": money_text(total_pnl / len(closed)) if closed else None,
            }
        )
    return result


def _within(value: date, period_start: date | None, period_end: date | None) -> bool:
    if period_start is not None and value < period_start:
        return False
    return not (period_end is not None and value > period_end)


def build_structure_attribution(
    *,
    executions: Sequence[Mapping[str, Any]],
    cycles: Sequence[ClosedCycle],
    market_rows_by_symbol: Mapping[str, Sequence[Mapping[str, Any]] | None],
    period_start: date | None = None,
    period_end: date | None = None,
) -> dict[str, Any]:
    """结构位置归因结果（纯函数）：类别聚合、逐笔明细与质量说明。"""
    attributions = attribute_executions(executions, market_rows_by_symbol)
    by_execution_id = {item.execution_id: item for item in attributions}
    scoped = [item for item in attributions if _within(item.trade_date, period_start, period_end)]
    missing_symbols = sorted(
        symbol for symbol, rows in market_rows_by_symbol.items() if not rows
    )
    return {
        "summary": summarize_cycles(
            cycles, by_execution_id, period_start=period_start, period_end=period_end
        ),
        "executions": [item.as_dict() for item in scoped],
        "quality": {
            "unclassified_executions": [
                {
                    "execution_id": item.execution_id,
                    "symbol": item.symbol,
                    "trade_date": item.trade_date.isoformat(),
                    "reason": item.reason,
                }
                for item in scoped
                if item.category == "unclassified"
            ],
            "symbols_missing_market_data": missing_symbols,
        },
    }


def market_window(as_of: date) -> tuple[date, date]:
    """与 MarketAnalysisService.analyze 相同的五年取数窗口。"""
    return as_of - timedelta(days=MARKET_WINDOW_DAYS), as_of


class StructureAttributionService:
    """端点服务：读取账本、拉取/缓存行情，再交给纯函数归因。"""

    def __init__(self, store: Any, *, market_provider: Any | None = None) -> None:
        self.store = store
        self.database = store.database
        self.market_provider = market_provider

    def attribution(
        self, *, period_start: date | None = None, period_end: date | None = None
    ) -> dict[str, Any]:
        from .metrics import replay_rows
        from .service import InvalidTradingRequestError, TradingNotFoundError

        if period_start is not None and period_end is not None and period_start > period_end:
            raise InvalidTradingRequestError("period_start 不能晚于 period_end")
        account = self.store.get_account()
        if account is None:
            raise TradingNotFoundError("交易账户不存在")
        executions = self.store.list_executions(account["account_id"])
        cash_flows = self.store.list_cash_flows(account["account_id"])
        ledger = replay_rows(account["initial_capital"], executions, cash_flows)
        as_of_by_symbol: dict[str, date] = {}
        for row in executions:
            symbol = str(row["symbol"])
            trade_date = _business_date(row["occurred_at"])
            if symbol not in as_of_by_symbol or trade_date > as_of_by_symbol[symbol]:
                as_of_by_symbol[symbol] = trade_date
        market_rows_by_symbol = {
            symbol: self._market_rows(symbol, as_of)
            for symbol, as_of in as_of_by_symbol.items()
        }
        return build_structure_attribution(
            executions=executions,
            cycles=ledger.result.cycles,
            market_rows_by_symbol=market_rows_by_symbol,
            period_start=period_start,
            period_end=period_end,
        )

    def _market_rows(self, symbol: str, as_of: date) -> list[dict[str, Any]] | None:
        """优先读 market_history_snapshots 缓存，未命中再经 provider 实拉并落缓存。"""
        start_date, end_date = market_window(as_of)
        cache_key = (
            symbol,
            "1d",
            "qfq",
            as_of.isoformat(),
            start_date.isoformat(),
            end_date.isoformat(),
        )
        rows = self.database.get_market_history(*cache_key)
        if rows is not None:
            return rows
        provider = self._provider()
        if provider is None:
            return None
        try:
            rows = provider.daily(symbol, as_of=as_of, start_date=start_date)
        except (RuntimeError, TypeError, ValueError):
            return None
        if rows:
            self.database.save_market_history(*cache_key, rows)
        return rows or None

    def _provider(self) -> Any | None:
        if self.market_provider is not None:
            return self.market_provider
        try:
            from ..providers.tushare import TushareMarketProvider

            self.market_provider = TushareMarketProvider()
        except (RuntimeError, TypeError, ValueError):
            return None
        return self.market_provider


__all__ = [
    "CATEGORIES",
    "AttributionCategory",
    "ExecutionAttribution",
    "StructureAttributionService",
    "active_center",
    "adjusted_execution_price",
    "attribute_executions",
    "build_structure_attribution",
    "classify_price",
    "market_window",
    "summarize_cycles",
]
