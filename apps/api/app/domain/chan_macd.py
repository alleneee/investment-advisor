from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Any

FAST = 12
SLOW = 26
SIGNAL = 9
WARMUP = SLOW + SIGNAL


def compute_macd(closes: Sequence[Decimal]) -> dict[str, Any]:
    values = [value if isinstance(value, Decimal) else Decimal(str(value)) for value in closes]
    if len(values) < WARMUP:
        return {"ready": False, "warmup_bars": SLOW, "histogram": [], "dif": [], "dea": []}
    ema12 = _ema(values, FAST)
    ema26 = _ema(values, SLOW)
    dif = [fast - slow for fast, slow in zip(ema12, ema26, strict=True)]
    dea = _ema(dif, SIGNAL)
    histogram = [str(2 * (left - right)) for left, right in zip(dif, dea, strict=True)]
    return {
        "ready": True,
        "warmup_bars": SLOW,
        "histogram": histogram,
        "dif": [str(value) for value in dif],
        "dea": [str(value) for value in dea],
    }


def histogram_area(histogram: Sequence[str], *, sign: int, start: int = 0, end: int | None = None) -> str:
    total = Decimal(0)
    stop = len(histogram) if end is None else end
    for item in histogram[start:stop]:
        value = Decimal(item)
        if (sign > 0 and value > 0) or (sign < 0 and value < 0):
            total += value
    return str(total)


def _ema(values: Sequence[Decimal], period: int) -> list[Decimal]:
    if len(values) < period:
        raise ValueError("序列短于 EMA 周期")
    seed = sum(values[:period], Decimal(0)) / period
    result = [Decimal(0)] * len(values)
    result[period - 1] = seed
    multiplier = Decimal(2) / (period + 1)
    previous = seed
    for index in range(period, len(values)):
        previous = (values[index] - previous) * multiplier + previous
        result[index] = previous
    for index in range(period - 1):
        result[index] = result[period - 1]
    return result
