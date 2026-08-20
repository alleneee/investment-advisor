from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from html import unescape
from time import monotonic, sleep
from typing import Any

import httpx


class InformationSourceError(RuntimeError):
    pass


_SYMBOL = re.compile(r"^(?P<code>\d{6})(?:\.(?P<market>SH|SZ))?$")
_TAG = re.compile(r"<[^>]+>")
_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
_CHINA_TZ = timezone(timedelta(hours=8))


def normalize_symbol_code(symbol: str) -> str:
    if not isinstance(symbol, str):
        raise TypeError("仅支持规范的 A 股六码或六码.市场代码")
    matched = _SYMBOL.fullmatch(symbol)
    if matched is None:
        raise ValueError("仅支持规范的 A 股六码或六码.市场代码")
    code = matched["code"]
    market = matched["market"]
    required_market = "SH" if code.startswith("6") else "SZ" if code.startswith(("0", "3")) else None
    if required_market is None or market not in (None, required_market):
        raise ValueError("代码与沪深市场不匹配")
    return code


class EastmoneyRateLimiter:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
        jitter: Callable[[], float] | None = None,
    ) -> None:
        self._clock = clock
        self._sleeper = sleeper
        self._jitter = jitter or (lambda: 0.0)
        self._lock = threading.Lock()
        self._next_request_at: float | None = None

    def request(self, operation: Callable[[], httpx.Response]) -> httpx.Response:
        with self._lock:
            now = self._clock()
            if self._next_request_at is not None:
                delay = self._next_request_at - now
                if delay > 0:
                    self._sleeper(delay)
            try:
                return operation()
            finally:
                self._next_request_at = self._clock() + 1.0 + self._jitter()


_DEFAULT_EASTMONEY_LIMITER = EastmoneyRateLimiter()


class AStockDataProvider:
    def __init__(
        self,
        client: httpx.Client | None = None,
        *,
        limiter: EastmoneyRateLimiter | None = None,
    ) -> None:
        self.client = client or httpx.Client(
            headers={"User-Agent": _USER_AGENT}
        )
        self._limiter = limiter or _DEFAULT_EASTMONEY_LIMITER

    def eastmoney_news(self, symbol: str, *, page_size: int = 20) -> list[dict[str, Any]]:
        code = normalize_symbol_code(symbol)
        query = {
            "keyword": code,
            "type": ["cmsArticleWebOld"],
            "cmsArticleWebOld": {"pageIndex": 1, "pageSize": page_size},
        }
        response = self._eastmoney_get(
            "https://search-api-web.eastmoney.com/search/jsonp",
            params={
                "cb": "jQuery_news",
                "param": json.dumps(query, ensure_ascii=False, separators=(",", ":")),
                "keyword": code,
                "type": "[cmsArticleWebOld]",
            },
            headers={"Referer": "https://so.eastmoney.com/"},
        )
        payload = self._parse_jsonp(response.text)
        try:
            rows = payload["result"]["cmsArticleWebOld"]
        except (KeyError, TypeError) as exc:
            raise InformationSourceError("东财响应缺少 cmsArticleWebOld") from exc
        if not isinstance(rows, list):
            raise InformationSourceError("东财 cmsArticleWebOld 不是列表")
        return sorted(
            (self._normalize_news_row(code, row) for row in rows),
            key=lambda row: row["published_at"],
            reverse=True,
        )

    def _eastmoney_get(self, url: str, **kwargs: Any) -> httpx.Response:
        kwargs["headers"] = {"User-Agent": _USER_AGENT, **kwargs.get("headers", {})}
        try:
            response = self._limiter.request(lambda: self.client.get(url, **kwargs))
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise InformationSourceError(f"东财请求失败: {exc}") from exc
        return response

    def cninfo_questions(
        self,
        symbol: str,
        *,
        page_size: int = 20,
        page_num: int = 1,
        keyword: str = "",
        start_day: str = "",
        end_day: str = "",
    ) -> list[dict[str, Any]]:
        code = normalize_symbol_code(symbol)
        lookup = self._request_json(
            "POST",
            "https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo",
            data={"keyWord": code},
        )
        try:
            secid = lookup["data"][0]["secid"]
        except (KeyError, IndexError, TypeError) as exc:
            raise InformationSourceError("巨潮响应缺少 secid") from exc
        if not isinstance(secid, str) or not secid:
            raise InformationSourceError("巨潮响应 secid 无效")
        payload = self._request_json(
            "POST",
            "https://irm.cninfo.com.cn/newircs/company/question",
            params={
                "_t": "1",
                "stockcode": code,
                "code": code,
                "orgId": secid,
                "secid": secid,
                "pageSize": page_size,
                "pageNum": page_num,
                "keyWord": keyword,
                "startDay": start_day,
                "endDay": end_day,
            },
        )
        rows = payload.get("rows") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise InformationSourceError("巨潮响应缺少 rows")
        return sorted(
            (self._normalize_cninfo_row(code, row) for row in rows),
            key=lambda row: row["published_at"],
            reverse=True,
        )

    def ths_hot_list(self) -> list[dict[str, Any]]:
        payload = self._request_json(
            "GET",
            "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock",
            params={"stock_type": "a", "type": "hour", "list_type": "normal"},
        )
        data = payload.get("data") if isinstance(payload, dict) else None
        rows = data.get("stock_list") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise InformationSourceError("同花顺响应缺少 data.stock_list")
        return [self._normalize_ths_row(row) for row in rows]

    def ths_hot_rank(self, symbol: str) -> dict[str, Any] | None:
        code = normalize_symbol_code(symbol)
        for row in self.ths_hot_list():
            if row["code"] == code:
                return row
        return None

    def _request_json(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        try:
            kwargs["headers"] = {"User-Agent": _USER_AGENT, **kwargs.get("headers", {})}
            response = self.client.request(method, url, **kwargs)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise InformationSourceError(f"信息源请求失败: {exc}") from exc
        if not isinstance(payload, dict):
            raise InformationSourceError("信息源响应根节点不是对象")
        return payload

    @staticmethod
    def _parse_jsonp(text: str) -> dict[str, Any]:
        start = text.find("(")
        end = text.rfind(")")
        if start < 0 or end <= start:
            raise InformationSourceError("东财响应不是有效 JSONP")
        try:
            payload = json.loads(text[start + 1 : end])
        except json.JSONDecodeError as exc:
            raise InformationSourceError("东财 JSONP 解析失败") from exc
        if not isinstance(payload, dict):
            raise InformationSourceError("东财 JSONP 根节点不是对象")
        return payload

    @staticmethod
    def _normalize_news_row(code: str, row: Any) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise InformationSourceError("东财资讯条目不是对象")
        occurred_at = _parse_datetime(row.get("date"))
        content = _clean_html(row.get("content"))
        source = "eastmoney"
        digest = _stable_digest(source, code, occurred_at.isoformat(), content)
        return {
            "id": f"{source}:{code}:{occurred_at.isoformat()}:{digest}",
            "source": source,
            "code": code,
            "title": _clean_html(row.get("title")),
            "content": content,
            "published_at": occurred_at.isoformat(),
            "media_name": row.get("mediaName"),
            "url": row.get("url"),
        }

    @staticmethod
    def _normalize_cninfo_row(code: str, row: Any) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise InformationSourceError("巨潮问答条目不是对象")
        occurred_at = _parse_milliseconds(row.get("pubDate"))
        question = _clean_html(row.get("mainContent"))
        answer = _clean_html(row.get("attachedContent")) or None
        source = "cninfo"
        digest = _stable_digest(source, code, occurred_at.isoformat(), question)
        return {
            "id": f"{source}:{code}:{occurred_at.isoformat()}:{digest}",
            "source": source,
            "code": code,
            "company_short_name": row.get("companyShortName"),
            "question": question,
            "answer": answer,
            "answerer": row.get("attachedAuthor"),
            "published_at": occurred_at.isoformat(),
        }

    @staticmethod
    def _normalize_ths_row(row: Any) -> dict[str, Any]:
        if not isinstance(row, dict):
            raise InformationSourceError("同花顺热榜条目不是对象")
        tags = row.get("tag") if isinstance(row.get("tag"), dict) else {}
        return {
            "rank": row.get("order"),
            "code": str(row.get("code")),
            "name": row.get("name"),
            "heat": row.get("rate"),
            "pct": row.get("rise_and_fall"),
            "rank_chg": row.get("hot_rank_chg"),
            "concepts": tags.get("concept_tag"),
            "tag": tags.get("popularity_tag"),
        }


def _clean_html(value: Any) -> str:
    return " ".join(unescape(_TAG.sub("", str(value or ""))).split())


def _parse_datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise InformationSourceError("数据源缺少发布时间")
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError as exc:
        raise InformationSourceError("数据源发布时间格式错误") from exc
    return parsed.replace(tzinfo=_CHINA_TZ) if parsed.tzinfo is None else parsed


def _parse_milliseconds(value: Any) -> datetime:
    if not isinstance(value, (int, float)):
        raise InformationSourceError("数据源缺少毫秒发布时间")
    return datetime.fromtimestamp(value / 1000, tz=_CHINA_TZ)


def _stable_digest(source: str, code: str, occurred_at: str, content: str) -> str:
    return hashlib.sha256(f"{source}:{code}:{occurred_at}:{content}".encode()).hexdigest()[:12]
