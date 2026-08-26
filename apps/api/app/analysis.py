from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from .domain.chan_engine import CanonicalBar, ChanEngine
from .providers.tushare import MarketProviderError

Timeframe = Literal["1d", "1w"]


class MarketAnalysisService:
    def __init__(self, provider: Any, history_store: Any | None = None) -> None:
        self.provider = provider
        self.history_store = history_store

    def analyze(self, symbol: str, *, as_of: date, timeframe: Timeframe = "1d") -> dict[str, Any]:
        start_date = as_of - timedelta(days=365 * 5)
        adjustment = "qfq"
        cache_key = (
            symbol,
            timeframe,
            adjustment,
            as_of.isoformat(),
            start_date.isoformat(),
            as_of.isoformat(),
        )
        rows = self.history_store.get_market_history(*cache_key) if self.history_store else None
        if rows is None:
            if timeframe == "1d":
                rows = self.provider.daily(symbol, as_of=as_of, start_date=start_date)
            elif self.history_store:
                daily_key = (
                    symbol,
                    "1d",
                    adjustment,
                    as_of.isoformat(),
                    start_date.isoformat(),
                    as_of.isoformat(),
                )
                daily_rows = self.history_store.get_market_history(*daily_key)
                if daily_rows is None:
                    daily_rows = self.provider.daily(symbol, as_of=as_of, start_date=start_date)
                    if daily_rows:
                        self.history_store.save_market_history(*daily_key, daily_rows)
                rows = self.provider.weekly_from_daily(symbol, daily_rows, as_of=as_of)
            else:
                rows = self.provider.weekly(symbol, as_of=as_of)
            if rows and self.history_store:
                self.history_store.save_market_history(*cache_key, rows)
        if not rows:
            raise MarketProviderError("行情数据源未返回指定日期前的行情")
        bars = [self._bar(symbol, row) for row in rows]
        bars.sort(key=lambda item: item.occurred_at)
        snapshot = ChanEngine().replay(bars)
        warnings = self._quality_warnings(rows, timeframe)
        payload = {
            "symbol": symbol,
            "as_of": as_of.isoformat(),
            "timeframe": timeframe,
            "adjustment": adjustment,
            "rows": rows,
        }
        snapshot_id = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode()
        ).hexdigest()
        return {
            "market_snapshot": {
                "snapshot_id": snapshot_id,
                "source": getattr(self.provider, "source", "tushare"),
                "adjustment": adjustment,
                "bars": [bar.as_dict() for bar in bars],
                "window": {
                    "start": rows[0]["trade_date"],
                    "end": rows[-1]["trade_date"],
                    "bar_count": len(rows),
                },
                "facts": self._facts(rows),
                "quality": {"status": "degraded" if warnings else "ok", "warnings": warnings},
            },
            "chan_analysis": {
                "analysis_id": f"chan-{snapshot_id[:24]}",
                "engine_version": "chan-engine.v1.2",
                "timeframe": timeframe,
                "snapshot": snapshot,
            },
        }

    @staticmethod
    def _bar(symbol: str, row: dict[str, Any]) -> CanonicalBar:
        occurred_at = datetime.strptime(str(row["trade_date"]), "%Y%m%d").replace(tzinfo=UTC)

        def price(name: str) -> Any:
            return row.get(f"qfq_{name}", row.get(name))

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
            payload_hash=row.get("payload_hash"),
        )

    @staticmethod
    def _quality_warnings(rows: list[dict[str, Any]], timeframe: Timeframe) -> list[str]:
        warnings: list[str] = []
        if len(rows) < (200 if timeframe == "1d" else 40):
            warnings.append("行情窗口少于建议样本量")
        if any(row.get("qfq_close") is None for row in rows):
            warnings.append("部分 K 线缺少前复权收盘价，已回退原始收盘价")
        return warnings

    @staticmethod
    def _facts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        latest = rows[-1]
        return [
            {"id": "bar_count", "label": "K 线数量", "value": len(rows), "unit": "bars"},
            {"id": "latest_trade_date", "label": "最新交易日", "value": str(latest["trade_date"])},
            {
                "id": "latest_qfq_close",
                "label": "最新前复权收盘",
                "value": latest.get("qfq_close", latest.get("close")),
            },
        ]
