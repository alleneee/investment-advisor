"""沪深成交代码规范化：六位数字与 ts_code 视为同一标的。"""

from __future__ import annotations

import re

_BARE = re.compile(r"^\d{6}$")
_TS_CODE = re.compile(
    r"^(?:(?:600|601|603|605|688)\d{3}\.SH|(?:000|001|002|003|300|301)\d{3}\.SZ)$"
)


def normalize_trading_symbol(symbol: str) -> str:
    if not isinstance(symbol, str):
        raise TypeError("股票代码必须是字符串")
    text = symbol.strip().upper()
    if _BARE.fullmatch(text):
        if text.startswith(("600", "601", "603", "605", "688")):
            text = f"{text}.SH"
        elif text.startswith(("000", "001", "002", "003", "300", "301")):
            text = f"{text}.SZ"
    if not _TS_CODE.fullmatch(text):
        raise ValueError("股票代码必须是 002309.SZ / 600000.SH 这类沪深代码")
    return text


def trading_symbol_prefix(symbol: str) -> str:
    return symbol.split(".", 1)[0]
