from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from .domain.chan_engine import CanonicalBar, ChanEngine
from .providers.tushare import MarketProviderError

SHANGHAI = ZoneInfo("Asia/Shanghai")
REVIEW_FRAMES = ("1M", "1w", "1d", "60m", "30m", "15m")
CHART_BARS = {"1M": 72, "1w": 120, "1d": 110, "60m": 110, "30m": 120, "15m": 150}
MINUTE_LOOKBACK_DAYS = {"60m": 40, "30m": 25, "15m": 20}


class ChanReviewService:
    def __init__(self, provider: Any, history_store: Any | None = None) -> None:
        self.provider = provider
        self.history_store = history_store

    def review(self, symbol: str, *, as_of: date, name: str | None = None) -> dict[str, Any]:
        frames: dict[str, Any] = {}
        daily_rows = self._load_rows(symbol, "1d", as_of, None)
        for timeframe in REVIEW_FRAMES:
            try:
                rows = daily_rows if timeframe == "1d" else self._load_rows(symbol, timeframe, as_of, daily_rows)
                frames[timeframe] = self._frame(symbol, timeframe, as_of, rows)
            except (MarketProviderError, ValueError) as exc:
                frames[timeframe] = {
                    "timeframe": timeframe,
                    "available": False,
                    "adjustment": "qfq",
                    "source": getattr(self.provider, "source", "tushare"),
                    "quality": {"status": "unavailable", "warnings": [str(exc)]},
                    "bars": [],
                    "snapshot": None,
                }
        return {
            "symbol": symbol,
            "name": name or symbol,
            "as_of": as_of.isoformat(),
            "adjustment": "qfq",
            "source": getattr(self.provider, "source", "tushare"),
            "engine_version": "chan-engine.v1.2",
            "frames": frames,
        }

    def _load_rows(
        self,
        symbol: str,
        timeframe: str,
        as_of: date,
        daily_rows: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        start_date, end_date = self._window(timeframe, as_of)
        cache_key = (symbol, timeframe, "qfq", as_of.isoformat(), start_date.isoformat(), end_date.isoformat())
        cached = self.history_store.get_market_history(*cache_key) if self.history_store else None
        if cached is not None:
            return cached
        if timeframe == "1d":
            rows = self.provider.daily(symbol, as_of=as_of, start_date=start_date, end_date=end_date)
        elif timeframe == "1w":
            source = daily_rows if daily_rows is not None else self._load_rows(symbol, "1d", as_of, None)
            rows = self.provider.weekly_from_daily(symbol, source, as_of=as_of)
        elif timeframe == "1M":
            source = daily_rows if daily_rows is not None else self._load_rows(symbol, "1d", as_of, None)
            rows = self.provider.monthly_from_daily(symbol, source, as_of=as_of)
        else:
            rows = self.provider.minutes(symbol, freq=timeframe, as_of=as_of, start_date=start_date, end_date=end_date)
        if rows and self.history_store:
            self.history_store.save_market_history(*cache_key, rows)
        return rows

    def _frame(self, symbol: str, timeframe: str, as_of: date, rows: list[dict[str, Any]]) -> dict[str, Any]:
        warnings = _quality_warnings(rows, timeframe)
        if not rows:
            return {
                "timeframe": timeframe,
                "available": False,
                "adjustment": "qfq",
                "source": getattr(self.provider, "source", "tushare"),
                "quality": {"status": "unavailable", "warnings": warnings or ["该周期没有可用K线"]},
                "bars": [],
                "snapshot": None,
            }
        bars = [_canonical_bar(symbol, row, timeframe) for row in rows]
        bars.sort(key=lambda item: item.occurred_at)
        snapshot = ChanEngine().replay(bars)
        keep = CHART_BARS[timeframe]
        chart_bars = [bar.as_dict() for bar in bars[-keep:]]
        return {
            "timeframe": timeframe,
            "available": True,
            "adjustment": "qfq",
            "source": getattr(self.provider, "source", "tushare"),
            "window": {
                "start": _row_date(rows[0]),
                "end": _row_date(rows[-1]),
                "bar_count": len(rows),
            },
            "quality": {"status": "degraded" if warnings else "ok", "warnings": warnings},
            "bars": chart_bars,
            "snapshot": snapshot,
        }

    @staticmethod
    def _window(timeframe: str, as_of: date) -> tuple[date, date]:
        if timeframe in {"1d", "1w", "1M"}:
            return as_of - timedelta(days=365 * 5), as_of
        return as_of - timedelta(days=MINUTE_LOOKBACK_DAYS[timeframe]), as_of


def _canonical_bar(symbol: str, row: dict[str, Any], timeframe: str) -> CanonicalBar:
    if timeframe in {"15m", "30m", "60m"}:
        occurred = datetime.fromisoformat(str(row["trade_time"]))
        if occurred.tzinfo is None:
            occurred = occurred.replace(tzinfo=UTC)
    else:
        day = str(row["trade_date"])
        occurred = datetime(int(day[:4]), int(day[4:6]), int(day[6:8]), tzinfo=UTC)
    open_, high, low, close = (
        _price(row, "open"),
        _price(row, "high"),
        _price(row, "low"),
        _price(row, "close"),
    )
    return CanonicalBar(
        symbol=symbol,
        occurred_at=occurred,
        known_at=occurred,
        stable_through=occurred,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=None if row.get("vol") is None else Decimal(str(row.get("vol"))),
        payload_hash=row.get("payload_hash"),
    )


def _price(row: dict[str, Any], field: str) -> Decimal:
    value = row.get(f"qfq_{field}", row.get(field))
    return Decimal(str(value))


def _row_date(row: dict[str, Any]) -> str:
    if row.get("trade_date"):
        return str(row["trade_date"])
    return str(row.get("trade_time", ""))[:10].replace("-", "")


def _quality_warnings(rows: list[dict[str, Any]], timeframe: str) -> list[str]:
    warnings: list[str] = []
    previous: datetime | None = None
    seen: set[str] = set()
    for row in rows:
        stamp = str(row.get("trade_time") or row.get("trade_date") or "")
        if stamp in seen:
            warnings.append("存在重复时间戳")
            break
        seen.add(stamp)
        try:
            high = Decimal(str(row.get("qfq_high", row.get("high"))))
            low = Decimal(str(row.get("qfq_low", row.get("low"))))
            close = Decimal(str(row.get("qfq_close", row.get("close"))))
        except Exception:
            warnings.append("存在无法解析的价格")
            break
        if high < low:
            warnings.append("存在最低价高于最高价的K线")
            break
        if close <= 0 or high <= 0 or low <= 0:
            warnings.append("存在非正价格")
            break
        if "qfq_close" not in row and timeframe in {"15m", "30m", "60m"}:
            warnings.append("部分分钟K线缺少当日复权因子，已回退未复权价格")
            break
    min_bars = 40 if timeframe in {"1M", "1w"} else 80
    if len(rows) < min_bars:
        warnings.append(f"{timeframe} 样本不足 {min_bars} 根")
    return warnings
