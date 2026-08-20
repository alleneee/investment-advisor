from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any


class MarketProviderError(RuntimeError):
    pass


_CODE = re.compile(r"^(?P<num>(?:600|601|603|605|688)\d{3}\.SH|(?:000|001|002|003|300|301)\d{3}\.SZ)$")


class TushareMarketProvider:
    def __init__(
        self,
        client: Any | None = None,
        token: str | None = None,
        api_url: str | None = None,
    ) -> None:
        self.token = token or os.getenv("TUSHARE_TOKEN")
        api_url = api_url or os.getenv("TUSHARE_API_URL")
        if client is None and not self.token:
            raise MarketProviderError("缺少 TUSHARE_TOKEN")
        if client is None:
            try:
                import tushare as ts  # type: ignore
            except ImportError as exc:
                raise MarketProviderError("未安装 tushare") from exc
            self.client = ts.pro_api(self.token)
            if api_url:
                self.client._DataApi__http_url = api_url
        else:
            self.client = client

    @staticmethod
    def _validate_code(code: str) -> str:
        if not isinstance(code, str) or not _CODE.fullmatch(code):
            raise ValueError("仅支持沪深个股代码，如 600000.SH")
        return code

    @staticmethod
    def _hash(row: dict[str, Any]) -> str:
        payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode()).hexdigest()

    def _call(self, method: str, **kwargs: Any) -> list[dict[str, Any]]:
        try:
            result = getattr(self.client, method)(**kwargs)
            if hasattr(result, "to_dict"):
                result = result.to_dict("records")
            return [dict(item) for item in (result or [])]
        except Exception as exc:
            raise MarketProviderError("Tushare 数据服务调用失败") from exc

    def daily(
        self,
        code: str,
        *,
        as_of: date | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> list[dict[str, Any]]:
        code = self._validate_code(code)
        as_of = as_of or datetime.now(UTC).date()
        start_date = start_date or as_of - timedelta(days=365 * 5)
        end_date = min(end_date or as_of, as_of)
        if start_date > end_date:
            raise ValueError("start_date 不能晚于 end_date")
        query_start = start_date.strftime("%Y%m%d")
        query_end = end_date.strftime("%Y%m%d")
        rows = self._call("daily", ts_code=code, start_date=query_start, end_date=query_end)
        factors = self._call("adj_factor", ts_code=code, start_date=query_start, end_date=query_end)
        factor_map = {str(row["trade_date"]): Decimal(str(row["adj_factor"])) for row in factors if row.get("adj_factor") is not None}
        eligible = [
            row
            for row in rows
            if row.get("trade_date") and start_date <= self._parse_date(row["trade_date"]) <= end_date
        ]
        if not eligible:
            return []
        latest_date = max(self._parse_date(row["trade_date"]) for row in eligible)
        factor_as_of = factor_map.get(latest_date.strftime("%Y%m%d"))
        if factor_as_of is None:
            available = [(self._parse_date(key), value) for key, value in factor_map.items() if self._parse_date(key) <= latest_date]
            factor_as_of = max(available, default=(latest_date, Decimal(1)))[1]
        result = []
        for row in sorted(eligible, key=lambda item: item.get("trade_date", "")):
            factor = factor_map.get(str(row.get("trade_date")), factor_as_of)
            normalized = dict(row)
            for field in ("open", "high", "low", "close"):
                if row.get(field) is not None:
                    normalized[f"qfq_{field}"] = float(Decimal(str(row[field])) * factor / factor_as_of)
            normalized["payload_hash"] = self._hash(normalized)
            result.append(normalized)
        return result

    def trade_cal(self, *, start_date: date, end_date: date, exchange: str = "SSE") -> list[dict[str, Any]]:
        rows = self._call("trade_cal", exchange=exchange, start_date=start_date.strftime("%Y%m%d"), end_date=end_date.strftime("%Y%m%d"))
        return sorted(rows, key=lambda row: row.get("cal_date", ""))

    def weekly(self, code: str, *, as_of: date | None = None) -> list[dict[str, Any]]:
        as_of = as_of or datetime.now(UTC).date()
        rows = self.daily(code, as_of=as_of)
        if not rows:
            return []
        first_day = min(self._parse_date(row["trade_date"]) for row in rows)
        last_day = max(self._parse_date(row["trade_date"]) for row in rows)
        calendar = self.trade_cal(
            start_date=first_day - timedelta(days=first_day.weekday()),
            end_date=last_day + timedelta(days=6 - last_day.weekday()),
        )
        open_days = {
            self._parse_date(item["cal_date"])
            for item in calendar
            if item.get("is_open") in (1, "1", True)
        }
        return self._aggregate_weekly(code, rows, as_of, open_days)

    def weekly_from_daily(
        self,
        code: str,
        rows: list[dict[str, Any]],
        *,
        as_of: date,
    ) -> list[dict[str, Any]]:
        return self._aggregate_weekly(self._validate_code(code), rows, as_of, None)

    def _aggregate_weekly(
        self,
        code: str,
        rows: list[dict[str, Any]],
        as_of: date,
        open_days: set[date] | None,
    ) -> list[dict[str, Any]]:
        grouped: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for row in rows:
            day = self._parse_date(row["trade_date"])
            monday = day - timedelta(days=day.weekday())
            grouped.setdefault((monday.year, monday.timetuple().tm_yday), []).append(row)
        result = []
        for _, grouped_items in sorted(grouped.items()):
            items = sorted(grouped_items, key=lambda item: item["trade_date"])
            days = [self._parse_date(item["trade_date"]) for item in items]
            monday = min(days) - timedelta(days=min(days).weekday())
            if max(days) > as_of or as_of < monday + timedelta(days=7):
                continue
            week_open_days = {
                day for day in open_days or set() if monday <= day <= monday + timedelta(days=6)
            }
            if open_days is not None and week_open_days and max(week_open_days) > as_of:
                continue
            weekly_row = {
                "ts_code": items[-1].get("ts_code", code), "trade_date": max(days).strftime("%Y%m%d"),
                "open": items[0].get("qfq_open", items[0].get("open")),
                "high": max(item.get("qfq_high", item.get("high")) for item in items),
                "low": min(item.get("qfq_low", item.get("low")) for item in items),
                "close": items[-1].get("qfq_close", items[-1].get("close")),
                "vol": sum(item.get("vol", 0) or 0 for item in items),
            }
            weekly_row.update({f"qfq_{field}": weekly_row[field] for field in ("open", "high", "low", "close")})
            weekly_row["payload_hash"] = self._hash(weekly_row)
            result.append(weekly_row)
        return result

    @staticmethod
    def _parse_date(value: Any) -> date:
        if isinstance(value, date):
            return value
        text = str(value)
        return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:8]}") if len(text) == 8 else date.fromisoformat(text)
