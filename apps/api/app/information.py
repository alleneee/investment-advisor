from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Callable
from concurrent.futures import Future
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, ClassVar
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from .providers.a_stock_data import InformationSourceError, normalize_symbol_code

# 资讯的时间语义跟随交易语义：按东八区判断某条资讯是否落在 as_of 当日结束之前。
SHANGHAI = ZoneInfo("Asia/Shanghai")
# 同花顺热榜是时点快照、没有历史序列，历史 as_of 无法重建，只能显式标为不可用。
HOT_LIST_NOT_REPLAYABLE = "同花顺热榜只有实时快照、没有历史序列，历史时点的情绪面无法重建，已置为不可用"


class StockInformationService:
    _SOURCE_TTLS: ClassVar[dict[str, timedelta]] = {
        "eastmoney_news": timedelta(minutes=30),
        "cninfo_irm": timedelta(hours=6),
        "ths_hot_list": timedelta(minutes=5),
    }

    def __init__(self, provider: Any, store: Any, clock: Callable[[], datetime] | None = None) -> None:
        self.provider = provider
        self.store = store
        self.clock = clock or (lambda: datetime.now(UTC))
        self._flight_lock = threading.Lock()
        self._flights: dict[tuple[str, str], Future[dict[str, Any]]] = {}

    def get_information(
        self,
        symbol: str,
        *,
        limit: int = 20,
        as_of: date | None = None,
    ) -> dict[str, Any]:
        """按需固化到历史时点的资讯快照。

        ``as_of`` 为 ``None`` 时行为与实时查询完全一致。给出历史日期时，新闻与
        互动问答按发布时间不晚于该日东八区结束时刻过滤；热榜没有历史序列，直接
        标为不可用而不是拿今天的快照冒充历史。
        """
        if limit < 1 or limit > 20:
            raise ValueError("limit 必须在 1 到 20 之间")
        code = normalize_symbol_code(symbol)
        normalized_symbol = f"{code}.{'SH' if code.startswith('6') else 'SZ'}"
        generated_at = self._aware_now()
        cutoff = _day_end(as_of) if as_of is not None else None
        historical = as_of is not None and as_of < generated_at.astimezone(SHANGHAI).date()
        news_source = self._load_source(
            "eastmoney_news",
            code,
            lambda: self.provider.eastmoney_news(code, page_size=20),
        )
        irm_source = self._load_source(
            "cninfo_irm",
            code,
            lambda: self.provider.cninfo_questions(code, page_size=20),
        )
        hot_source = (
            self._source_result([], "unavailable", None)
            if historical
            else self._load_source("ths_hot_list", "market", self.provider.ths_hot_list)
        )
        news = _published_until(self._news(news_source["payload"], code), cutoff)
        messages = _published_until(self._messages(irm_source["payload"], code), cutoff)
        sentiment = self._sentiment(hot_source, code)
        source_results = {
            "eastmoney_news": news_source,
            "cninfo_irm": irm_source,
            "ths_hot_list": hot_source,
        }
        quality = self._quality(
            source_results,
            extra_warnings=[HOT_LIST_NOT_REPLAYABLE] if historical else [],
        )
        sentiment_facts = {key: value for key, value in sentiment.items() if key != "observed_at"}
        snapshot_payload = {
            "symbol": normalized_symbol,
            "news": news,
            "messages": messages,
            "sentiment": sentiment_facts,
        }
        digest = hashlib.sha256(
            json.dumps(snapshot_payload, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        return {
            "symbol": normalized_symbol,
            "snapshot_id": f"information-{digest}",
            "generated_at": generated_at.isoformat(),
            "news": news[:limit],
            "messages": messages[:limit],
            "sentiment": sentiment,
            "quality": quality,
        }

    def _load_source(
        self,
        source: str,
        cache_key: str,
        fetch: Callable[[], list[dict[str, Any]]],
    ) -> dict[str, Any]:
        now = self._aware_now()
        cached = self.store.get_external_information_cache(cache_key, source, now=now)
        if cached is not None and not cached["expired"]:
            return self._source_result(cached["payload"], "cached", cached["fetched_at"])

        flight_key = (source, cache_key)
        with self._flight_lock:
            flight = self._flights.get(flight_key)
            leader = flight is None
            if leader:
                flight = Future()
                self._flights[flight_key] = flight
        if not leader:
            result = flight.result()
            refreshed = self.store.get_external_information_cache(cache_key, source, now=self._aware_now())
            if result["status"] == "fresh" and refreshed is not None and not refreshed["expired"]:
                return self._source_result(refreshed["payload"], "cached", refreshed["fetched_at"])
            return result

        try:
            current = self.store.get_external_information_cache(cache_key, source, now=self._aware_now())
            if current is not None and not current["expired"]:
                result = self._source_result(current["payload"], "cached", current["fetched_at"])
            else:
                try:
                    payload = fetch()
                except InformationSourceError:
                    result = (
                        self._source_result(current["payload"], "stale", current["fetched_at"])
                        if current is not None
                        else self._source_result([], "unavailable", None)
                    )
                else:
                    fetched_at = self._aware_now()
                    self.store.save_external_information_cache(
                        cache_key,
                        source,
                        payload,
                        fetched_at,
                        fetched_at + self._SOURCE_TTLS[source],
                    )
                    result = self._source_result(payload, "fresh", fetched_at.isoformat())
            flight.set_result(result)
            return result
        except BaseException as exc:
            flight.set_exception(exc)
            raise
        finally:
            with self._flight_lock:
                if self._flights.get(flight_key) is flight:
                    del self._flights[flight_key]

    @staticmethod
    def _source_result(payload: list[dict[str, Any]], status: str, fetched_at: str | None) -> dict[str, Any]:
        return {"payload": payload, "status": status, "fetched_at": fetched_at}

    @staticmethod
    def _news(rows: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[tuple[str, ...]] = set()
        for row in sorted(rows, key=lambda item: _occurred_at(item.get("published_at")), reverse=True):
            url = row.get("url") if isinstance(row.get("url"), str) else None
            normalized_url = _normalized_url(url) if url else None
            title = str(row.get("title") or "")
            published_at = str(row.get("published_at") or "")
            key = ("url", normalized_url) if normalized_url else ("content", title, published_at)
            if key in seen:
                continue
            seen.add(key)
            identifier = row.get("id") or _digest("news", code, published_at, title)
            result.append(
                {
                    "id": str(identifier),
                    "title": title,
                    "summary": str(row.get("content") or ""),
                    "published_at": published_at,
                    "source": str(row.get("media_name") or row.get("source") or "eastmoney"),
                    "url": url,
                }
            )
        return result

    @staticmethod
    def _messages(rows: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for row in sorted(rows, key=lambda item: _occurred_at(item.get("published_at")), reverse=True):
            question = str(row.get("question") or "")
            published_at = str(row.get("published_at") or "")
            key = (question, published_at)
            if key in seen:
                continue
            seen.add(key)
            identifier = row.get("id") or _digest("irm", code, published_at, question)
            result.append(
                {
                    "id": str(identifier),
                    "question": question,
                    "answer": row.get("answer"),
                    "answerer": row.get("answerer"),
                    "published_at": published_at,
                    "source": str(row.get("source") or "cninfo"),
                }
            )
        return result

    @staticmethod
    def _sentiment(source: dict[str, Any], code: str) -> dict[str, Any]:
        row = next((item for item in source["payload"] if str(item.get("code")) == code), None)
        return {
            "hot_rank": row.get("rank") if row else None,
            "heat": row.get("heat") if row else None,
            "rank_change": row.get("rank_chg") if row else None,
            "concepts": row.get("concepts") or [] if row else [],
            "tag": row.get("tag") if row else None,
            "observed_at": source["fetched_at"],
        }

    @staticmethod
    def _quality(
        sources: dict[str, dict[str, Any]],
        extra_warnings: list[str] | None = None,
    ) -> dict[str, Any]:
        statuses = [source["status"] for source in sources.values()]
        if all(status == "unavailable" for status in statuses):
            status = "unavailable"
        elif any(source_status in {"stale", "unavailable"} for source_status in statuses):
            status = "degraded"
        else:
            status = "ok"
        warnings = [
            *(
                f"{source} 数据源状态为 {result['status']}"
                for source, result in sources.items()
                if result["status"] in {"stale", "unavailable"}
            ),
            *(extra_warnings or []),
        ]
        return {
            "status": status,
            "warnings": warnings,
            "sources": {
                source: {"status": result["status"], "fetched_at": result["fetched_at"]}
                for source, result in sources.items()
            },
        }

    def _aware_now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None:
            raise ValueError("clock 必须返回带时区的 datetime")
        return value


def _published_at(value: Any) -> datetime | None:
    """解析发布时间；缺少时区信息时按东八区处理（交易语义）。"""
    try:
        moment = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=SHANGHAI)


def _occurred_at(value: Any) -> datetime:
    return _published_at(value) or datetime.min.replace(tzinfo=UTC)


def _day_end(value: date) -> datetime:
    return datetime.combine(value, time.max, tzinfo=SHANGHAI)


def _published_until(
    items: list[dict[str, Any]],
    cutoff: datetime | None,
) -> list[dict[str, Any]]:
    """历史快照只保留发布时间可核验、且不晚于截止时刻的条目。

    无法解析发布时间的条目无法证明属于历史，按"不用推测值填充"的一贯口径剔除。
    """
    if cutoff is None:
        return items
    return [
        item
        for item in items
        if (moment := _published_at(item.get("published_at"))) is not None and moment <= cutoff
    ]


def _normalized_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, ""))


def _digest(prefix: str, *values: str) -> str:
    content = ":".join(values)
    return f"{prefix}-{hashlib.sha256(content.encode()).hexdigest()[:24]}"
