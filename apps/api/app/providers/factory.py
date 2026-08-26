from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .hithink import DEFAULT_BASE_URL, HithinkMarketProvider
from .tushare import MarketProviderError, TushareMarketProvider


def credential_paths() -> list[Path]:
    config_home = Path(os.getenv("XDG_CONFIG_HOME") or Path.home() / ".config")
    return [
        Path.home() / "Library/Application Support/hithink-finance/credentials.env",
        config_home / "hithink-finance" / "credentials.env",
        Path(os.getenv("APPDATA") or "") / "hithink-finance" / "credentials.env",
    ]


def resolve_hithink_api_key() -> str | None:
    for name in ("HITHINK_FINANCE_API_KEY", "FUYAO_API_KEY", "FUYAO_TOKEN"):
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    for path in credential_paths():
        parsed = _read_env_file(path)
        for name in ("HITHINK_FINANCE_API_KEY", "FUYAO_API_KEY", "FUYAO_TOKEN"):
            value = parsed.get(name)
            if value:
                return value
    return None


def create_market_provider(*, client: Any | None = None) -> Any:
    requested = (os.getenv("MARKET_PROVIDER") or "auto").strip().lower()
    if requested not in {"auto", "hithink", "tushare"}:
        raise MarketProviderError("MARKET_PROVIDER 仅支持 auto、hithink 或 tushare")
    hithink_key = resolve_hithink_api_key()
    if requested == "tushare":
        return TushareMarketProvider()
    if requested == "hithink" or (requested == "auto" and hithink_key):
        primary = HithinkMarketProvider(
            api_key=hithink_key,
            client=client,
            base_url=os.getenv("HITHINK_FINANCE_API_URL") or DEFAULT_BASE_URL,
        )
        minutes = _try_tushare()
        if minutes is None:
            return primary
        return CompositeMarketProvider(primary, minutes)
    return TushareMarketProvider()


class CompositeMarketProvider:
    def __init__(self, primary: Any, minutes_provider: Any) -> None:
        self.primary = primary
        self.minutes_provider = minutes_provider
        self.source = getattr(primary, "source", "hithink")
        self.supports_minutes = True

    def daily(self, *args: Any, **kwargs: Any) -> Any:
        return self.primary.daily(*args, **kwargs)

    def weekly(self, *args: Any, **kwargs: Any) -> Any:
        return self.primary.weekly(*args, **kwargs)

    def weekly_from_daily(self, *args: Any, **kwargs: Any) -> Any:
        return self.primary.weekly_from_daily(*args, **kwargs)

    def monthly(self, *args: Any, **kwargs: Any) -> Any:
        return self.primary.monthly(*args, **kwargs)

    def monthly_from_daily(self, *args: Any, **kwargs: Any) -> Any:
        return self.primary.monthly_from_daily(*args, **kwargs)

    def trade_cal(self, *args: Any, **kwargs: Any) -> Any:
        calendar = getattr(self.minutes_provider, "trade_cal", None)
        if calendar is not None:
            try:
                return calendar(*args, **kwargs)
            except MarketProviderError:
                pass
        return self.primary.trade_cal(*args, **kwargs)

    def stock_basic(self) -> Any:
        return self.primary.stock_basic()

    def search_tickers(self, query: str, *, limit: int = 8) -> Any:
        searcher = getattr(self.primary, "search_tickers", None)
        if searcher is None:
            return []
        return searcher(query, limit=limit)

    def minutes(self, *args: Any, **kwargs: Any) -> Any:
        return self.minutes_provider.minutes(*args, **kwargs)


def _try_tushare() -> TushareMarketProvider | None:
    try:
        return TushareMarketProvider()
    except MarketProviderError:
        return None


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        cleaned = value.strip().strip("'").strip('"')
        if name.strip() and cleaned:
            result[name.strip()] = cleaned
    return result
