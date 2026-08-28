from __future__ import annotations

import hashlib
import json
import os
import re
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
_MINUTE_FREQ = {"15m": "15min", "30m": "30min", "60m": "60min"}


class MarketProviderError(RuntimeError):
    pass


_CODE = re.compile(r"^(?P<num>(?:600|601|603|605|688)\d{3}\.SH|(?:000|001|002|003|300|301)\d{3}\.SZ)$")


class TushareMarketProvider:
    source = "tushare"
    supports_minutes = True

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

    def stock_basic(self) -> list[dict[str, Any]]:
        rows = self._call(
            "stock_basic",
            list_status="L",
            fields="ts_code,symbol,name,cnspell,exchange,list_status",
        )
        result = []
        for row in rows:
            ts_code = str(row.get("ts_code") or "").upper()
            if not _CODE.fullmatch(ts_code):
                continue
            result.append(
                {
                    "ts_code": ts_code,
                    "symbol": str(row.get("symbol") or ts_code.split(".", 1)[0]),
                    "name": str(row.get("name") or ts_code),
                    "cnspell": str(row.get("cnspell") or "").lower(),
                    "exchange": str(row.get("exchange") or ""),
                    "list_status": str(row.get("list_status") or "L"),
                }
            )
        return result

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

    def monthly(self, code: str, *, as_of: date | None = None) -> list[dict[str, Any]]:
        as_of = as_of or datetime.now(UTC).date()
        return self.monthly_from_daily(code, self.daily(code, as_of=as_of), as_of=as_of)

    def monthly_from_daily(
        self,
        code: str,
        rows: list[dict[str, Any]],
        *,
        as_of: date,
    ) -> list[dict[str, Any]]:
        code = self._validate_code(code)
        grouped: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for row in rows:
            day = self._parse_date(row["trade_date"])
            grouped.setdefault((day.year, day.month), []).append(row)
        result = []
        for year, month in sorted(grouped):
            last_day = date(year, month, monthrange(year, month)[1])
            if as_of < last_day:
                continue
            items = sorted(grouped[(year, month)], key=lambda item: item["trade_date"])
            monthly_row = {
                "ts_code": items[-1].get("ts_code", code),
                "trade_date": max(self._parse_date(item["trade_date"]) for item in items).strftime("%Y%m%d"),
                "open": items[0].get("qfq_open", items[0].get("open")),
                "high": max(item.get("qfq_high", item.get("high")) for item in items),
                "low": min(item.get("qfq_low", item.get("low")) for item in items),
                "close": items[-1].get("qfq_close", items[-1].get("close")),
                "vol": sum(item.get("vol", 0) or 0 for item in items),
            }
            monthly_row.update({f"qfq_{field}": monthly_row[field] for field in ("open", "high", "low", "close")})
            monthly_row["payload_hash"] = self._hash(monthly_row)
            result.append(monthly_row)
        return result

    def minutes(
        self,
        code: str,
        *,
        freq: str,
        as_of: date,
        start_date: date,
        end_date: date,
    ) -> list[dict[str, Any]]:
        code = self._validate_code(code)
        tushare_freq = _MINUTE_FREQ.get(freq)
        if tushare_freq is None:
            raise ValueError("仅支持 15m/30m/60m 分钟周期")
        end_date = min(end_date, as_of)
        if start_date > end_date:
            raise ValueError("start_date 不能晚于 end_date")
        rows = self._call(
            "stk_mins",
            ts_code=code,
            freq=tushare_freq,
            start_date=f"{start_date.isoformat()} 09:30:00",
            end_date=f"{end_date.isoformat()} 15:00:00",
        )
        factors = {
            str(item["trade_date"]): Decimal(str(item["adj_factor"]))
            for item in self._call("adj_factor", ts_code=code, start_date=start_date.strftime("%Y%m%d"), end_date=end_date.strftime("%Y%m%d"))
            if item.get("adj_factor") is not None
        }
        as_of_factor = factors.get(as_of.strftime("%Y%m%d"))
        result = []
        for row in rows:
            occurred = self._parse_minute(row.get("trade_time"))
            if occurred.date() > as_of:
                continue
            trade_date = occurred.date().strftime("%Y%m%d")
            normalized = {
                "ts_code": row.get("ts_code", code),
                "trade_time": occurred.isoformat(),
                "trade_date": trade_date,
                "open": row.get("open"),
                "high": row.get("high"),
                "low": row.get("low"),
                "close": row.get("close"),
                "vol": row.get("vol"),
            }
            factor = factors.get(trade_date)
            if factor is not None and as_of_factor is not None:
                for field in ("open", "high", "low", "close"):
                    if row.get(field) is not None:
                        normalized[f"qfq_{field}"] = float(Decimal(str(row[field])) * factor / as_of_factor)
            normalized["payload_hash"] = self._hash(normalized)
            result.append(normalized)
        return sorted(result, key=lambda item: item["trade_time"])

    @staticmethod
    def _parse_minute(value: Any) -> datetime:
        if isinstance(value, datetime):
            stamp = value
        else:
            stamp = datetime.fromisoformat(str(value).replace(" ", "T"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=SHANGHAI)
        return stamp.astimezone(UTC)

    @staticmethod
    def _parse_date(value: Any) -> date:
        if isinstance(value, date):
            return value
        text = str(value)
        return date.fromisoformat(f"{text[:4]}-{text[4:6]}-{text[6:8]}") if len(text) == 8 else date.fromisoformat(text)
