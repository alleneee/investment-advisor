from __future__ import annotations

import threading
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from .providers.tushare import MarketProviderError

_MAX_LIMIT = 20
_CACHE_KEY = "market"
_TTL = timedelta(hours=24)


class StockUniverseService:
    def __init__(
        self,
        store: Any,
        provider: Any | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
        ttl: timedelta | None = None,
    ) -> None:
        self.store = store
        self._provider = provider
        self.clock = clock or (lambda: datetime.now(UTC))
        self.ttl = ttl or _TTL
        self._lock = threading.Lock()

    def search(self, query: str, *, limit: int = 8) -> list[dict[str, Any]]:
        q = query.strip()
        if not q:
            return []
        try:
            matches = match_stocks(self._universe(), q, limit=limit)
        except MarketProviderError:
            searcher = getattr(self._get_provider(), "search_tickers", None)
            if searcher is None:
                raise
            return list(searcher(q, limit=limit))
        if matches:
            return matches
        searcher = getattr(self._get_provider(), "search_tickers", None)
        if searcher is None:
            return []
        return list(searcher(q, limit=limit))

    def names_for(self, symbols: Sequence[str]) -> dict[str, str]:
        wanted = [symbol for symbol in symbols if symbol]
        if not wanted:
            return {}
        try:
            rows = self._universe()
        except MarketProviderError:
            return {}
        by_code = {
            str(row.get("ts_code") or "").upper(): str(row.get("name") or "")
            for row in rows
        }
        return {
            symbol: by_code[symbol]
            for symbol in wanted
            if by_code.get(symbol)
        }

    def _get_provider(self) -> Any:
        if self._provider is None:
            from .providers.factory import create_market_provider

            self._provider = create_market_provider()
        return self._provider

    def _cache_source(self) -> str:
        return f"{getattr(self._get_provider(), 'source', 'tushare')}_stock_basic"

    def _now(self) -> datetime:
        return self.clock()

    def _universe(self) -> list[dict[str, Any]]:
        now = self._now()
        source = self._cache_source()
        cached = self.store.get_external_information_cache(_CACHE_KEY, source, now=now)
        if cached is not None and not cached["expired"]:
            return list(cached["payload"])
        with self._lock:
            cached = self.store.get_external_information_cache(_CACHE_KEY, source, now=self._now())
            if cached is not None and not cached["expired"]:
                return list(cached["payload"])
            try:
                rows = self._get_provider().stock_basic()
            except MarketProviderError:
                if cached is not None:
                    return list(cached["payload"])
                raise
            fetched_at = self._now()
            self.store.save_external_information_cache(
                _CACHE_KEY,
                source,
                rows,
                fetched_at,
                fetched_at + self.ttl,
            )
            return list(rows)


def match_stocks(
    rows: Sequence[Mapping[str, Any]],
    query: str,
    *,
    limit: int = 8,
) -> list[dict[str, Any]]:
    q = query.strip()
    if not q or limit <= 0:
        return []
    q_lower = q.lower()
    q_upper = q.upper()
    code_q = q_upper.removesuffix(".SH").removesuffix(".SZ")
    scored: list[tuple[int, str, dict[str, str]]] = []
    for row in rows:
        ts_code = str(row.get("ts_code") or "").upper()
        if not ts_code:
            continue
        name = str(row.get("name") or ts_code)
        symbol = str(row.get("symbol") or ts_code.split(".", 1)[0])
        cnspell = str(row.get("cnspell") or "").lower()
        score = _score(q, q_lower, q_upper, code_q, name, symbol, ts_code, cnspell)
        if score is None:
            continue
        scored.append(
            (
                score,
                ts_code,
                {"symbol": ts_code, "name": name, "cnspell": cnspell},
            )
        )
    scored.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in scored[: min(limit, _MAX_LIMIT)]]


def _score(
    q: str,
    q_lower: str,
    q_upper: str,
    code_q: str,
    name: str,
    symbol: str,
    ts_code: str,
    cnspell: str,
) -> int | None:
    if name == q:
        return 0
    if ts_code == q_upper or symbol == code_q:
        return 1
    if name.startswith(q):
        return 2
    if ts_code.startswith(q_upper) or symbol.startswith(code_q):
        return 3
    if cnspell.startswith(q_lower):
        return 4
    if q in name:
        return 5
    if len(q_lower) >= 2 and q_lower in cnspell:
        return 6
    return None
