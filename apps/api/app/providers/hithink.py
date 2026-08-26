from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from .tushare import _CODE, MarketProviderError, TushareMarketProvider

SHANGHAI = ZoneInfo("Asia/Shanghai")
DEFAULT_BASE_URL = "https://fuyao.aicubes.cn"
_MAX_HISTORY_DAYS = 3650
_EXCHANGE = {"SH": "SSE", "SZ": "SZSE"}


class HithinkMarketProvider:
    source = "hithink"
    supports_minutes = False

    def __init__(
        self,
        api_key: str | None = None,
        client: httpx.Client | None = None,
        *,
        base_url: str | None = None,
        list_page_size: int = 1000,
    ) -> None:
        from .factory import resolve_hithink_api_key

        self.api_key = (api_key if api_key is not None else resolve_hithink_api_key()) or ""
        if not self.api_key:
            raise MarketProviderError("缺少同花顺金融数据 API Key")
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.list_page_size = list_page_size
        self.client = client or httpx.Client(
            base_url=self.base_url,
            timeout=30.0,
            headers={"X-api-key": self.api_key, "Accept": "application/json"},
        )

    def daily(
        self,
        code: str,
        *,
        as_of: date | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> list[dict[str, Any]]:
        code = TushareMarketProvider._validate_code(code)
        as_of = as_of or datetime.now(UTC).date()
        start_date = start_date or as_of - timedelta(days=365 * 5)
        end_date = min(end_date or as_of, as_of)
        if start_date > end_date:
            raise ValueError("start_date 不能晚于 end_date")
        items: list[dict[str, Any]] = []
        cursor = start_date
        while cursor <= end_date:
            chunk_end = min(cursor + timedelta(days=_MAX_HISTORY_DAYS - 1), end_date)
            items.extend(self._historical(code, cursor, chunk_end))
            cursor = chunk_end + timedelta(days=1)
        result = []
        seen: set[str] = set()
        for item in items:
            trade_date = _trade_date(item.get("date_ms"))
            if trade_date is None or trade_date < start_date or trade_date > end_date:
                continue
            key = trade_date.strftime("%Y%m%d")
            if key in seen:
                continue
            seen.add(key)
            volume = item.get("volume")
            row = {
                "ts_code": code,
                "trade_date": key,
                "open": item.get("open_price"),
                "high": item.get("high_price"),
                "low": item.get("low_price"),
                "close": item.get("close_price"),
                "vol": None if volume is None else float(volume) / 100,
            }
            for field in ("open", "high", "low", "close"):
                row[f"qfq_{field}"] = row[field]
            row["payload_hash"] = TushareMarketProvider._hash(row)
            result.append(row)
        result.sort(key=lambda item: item["trade_date"])
        return result

    def weekly(self, code: str, *, as_of: date | None = None) -> list[dict[str, Any]]:
        as_of = as_of or datetime.now(UTC).date()
        return self.weekly_from_daily(code, self.daily(code, as_of=as_of), as_of=as_of)

    def weekly_from_daily(
        self,
        code: str,
        rows: list[dict[str, Any]],
        *,
        as_of: date,
    ) -> list[dict[str, Any]]:
        return TushareMarketProvider(client=object()).weekly_from_daily(code, rows, as_of=as_of)

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
        return TushareMarketProvider(client=object()).monthly_from_daily(code, rows, as_of=as_of)

    def minutes(
        self,
        code: str,
        *,
        freq: str,
        as_of: date,
        start_date: date,
        end_date: date,
    ) -> list[dict[str, Any]]:
        TushareMarketProvider._validate_code(code)
        raise MarketProviderError("同花顺数据源不提供分钟K线")

    def trade_cal(self, *, start_date: date, end_date: date, exchange: str = "SSE") -> list[dict[str, Any]]:
        payload = self._get("/api/a-share/calendar/trading-days")
        rows = []
        for item in payload.get("item") or []:
            raw = str(item.get("date") or "")
            if len(raw) != 8:
                continue
            day = date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
            if start_date <= day <= end_date:
                rows.append({"cal_date": raw, "is_open": 1})
        return sorted(rows, key=lambda row: row["cal_date"])

    def stock_basic(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            payload = self._get(
                "/api/meta/tickers/list",
                {
                    "asset_type": "a-share",
                    "exchange": "SH,SZ",
                    "limit": self.list_page_size,
                    "offset": offset,
                },
            )
            page = list(payload.get("item") or [])
            for item in page:
                mapped = _ticker_row(item)
                if mapped is not None:
                    rows.append(mapped)
            if len(page) < self.list_page_size:
                break
            offset += self.list_page_size
            if offset > 100_000:
                break
        return rows

    def search_tickers(self, query: str, *, limit: int = 8) -> list[dict[str, str]]:
        q = query.strip()
        if not q:
            return []
        payload = self._get(
            "/api/meta/tickers/search",
            {"q": q, "asset_type": "a-share", "limit": min(max(limit, 1), 50)},
        )
        result = []
        for item in payload.get("item") or []:
            mapped = _ticker_row(item)
            if mapped is None:
                continue
            result.append({"symbol": mapped["ts_code"], "name": mapped["name"], "cnspell": mapped["cnspell"]})
            if len(result) >= limit:
                break
        return result

    def _historical(self, code: str, start_date: date, end_date: date) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        offset = 0
        last_stamp = None
        while True:
            payload = self._get(
                "/api/a-share/prices/historical",
                {
                    "thscode": code,
                    "interval": "1d",
                    "start": _start_ms(start_date),
                    "end": _end_ms(end_date),
                    "adjust": "forward",
                    "offset": offset,
                },
            )
            page = list(payload.get("item") or [])
            if not page:
                break
            stamp = page[-1].get("date_ms")
            if stamp == last_stamp:
                break
            last_stamp = stamp
            items.extend(page)
            if len(page) < 1000:
                break
            offset += len(page)
            if offset > 20_000:
                break
        return items

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        try:
            response = self.client.get(url, params=params, headers={"X-api-key": self.api_key})
            payload = response.json()
        except Exception as exc:
            raise MarketProviderError("同花顺数据服务调用失败") from exc
        if not isinstance(payload, dict):
            raise MarketProviderError("同花顺数据服务调用失败")
        code = payload.get("code")
        if code == 3001:
            return {"item": []}
        if code != 0:
            raise MarketProviderError("同花顺数据服务调用失败")
        data = payload.get("data")
        return data if isinstance(data, dict) else {"item": []}


def _ticker_row(item: dict[str, Any]) -> dict[str, str] | None:
    ts_code = str(item.get("thscode") or "").upper()
    if not _CODE.fullmatch(ts_code):
        return None
    exchange = str(item.get("exchange") or ts_code.split(".", 1)[-1]).upper()
    return {
        "ts_code": ts_code,
        "symbol": str(item.get("ticker") or ts_code.split(".", 1)[0]),
        "name": str(item.get("name") or ts_code),
        "cnspell": str(item.get("cnspell") or "").lower(),
        "exchange": _EXCHANGE.get(exchange, exchange),
        "list_status": "L",
    }


def _trade_date(value: Any) -> date | None:
    if value is None:
        return None
    stamp = datetime.fromtimestamp(int(value) / 1000, tz=SHANGHAI)
    return stamp.date()


def _start_ms(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=SHANGHAI).timestamp() * 1000)


def _end_ms(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, 23, 59, 59, 999000, tzinfo=SHANGHAI).timestamp() * 1000)
