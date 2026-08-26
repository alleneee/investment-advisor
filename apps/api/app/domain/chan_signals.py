from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Any, Mapping

from .chan_macd import histogram_area


def classify_trend(centers: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not centers:
        return {"type": "unavailable", "center_count": 0, "unavailable_reason": "insufficient_centers"}
    if len(centers) == 1:
        return {"type": "consolidation", "center_count": 1, "unavailable_reason": None}
    rising = True
    falling = True
    strict_up = False
    strict_down = False
    for previous, current in zip(centers, centers[1:]):
        prev_low, prev_high = Decimal(previous["lower"]), Decimal(previous["upper"])
        low, high = Decimal(current["lower"]), Decimal(current["upper"])
        if low < prev_low or high < prev_high:
            rising = False
        if low > prev_low or high > prev_high:
            falling = False
        if low > prev_low or high > prev_high:
            strict_up = True
        if low < prev_low or high < prev_high:
            strict_down = True
    if rising and strict_up:
        return {"type": "uptrend", "center_count": len(centers), "unavailable_reason": None}
    if falling and strict_down:
        return {"type": "downtrend", "center_count": len(centers), "unavailable_reason": None}
    return {"type": "consolidation", "center_count": len(centers), "unavailable_reason": None}


def find_divergences(
    trend: Mapping[str, Any],
    segments: Sequence[Mapping[str, Any]],
    macd: Mapping[str, Any],
    bars: Sequence[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    centers_count = int(trend.get("center_count") or 0)
    trend_type = trend.get("type")
    if trend_type in ("uptrend", "downtrend"):
        return _trend_divergences(trend_type, segments, macd, bars or [])
    if trend_type == "consolidation" and centers_count == 1:
        return _consolidation_divergences(segments, macd, bars or [])
    return []


def build_parent_signals(
    trend: Mapping[str, Any],
    divergences: Sequence[Mapping[str, Any]],
    segments: Sequence[Mapping[str, Any]],
    segment_centers: Sequence[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []
    for index, item in enumerate(divergences):
        if item.get("kind") != "trend":
            continue
        if item.get("status") not in ("confirmed", "unevaluable"):
            continue
        klass = "class1"
        side = "sell" if item.get("direction") == "top" else "buy"
        status = "provisional" if item.get("status") == "confirmed" else "unevaluable"
        reason = None if status == "provisional" else "macd_not_ready"
        if item.get("status") == "unevaluable":
            status = "unevaluable"
            reason = "macd_not_ready"
        elif item.get("status") == "confirmed":
            status = "provisional"
            reason = "class1_sublevel_structure_incomplete"
        last = segments[item["to_segment"]] if item.get("to_segment") is not None and item["to_segment"] < len(segments) else None
        signals.append(
            {
                "klass": klass,
                "side": side,
                "occurred_at": None if last is None else last["occurred_at"],
                "price": None if last is None else last["end_price"],
                "status": status,
                "reason": reason,
                "divergence_index": index,
                "sublevel": {
                    "timeframe": "30m",
                    "status": "unavailable",
                    "reason": "class1_sublevel_market_not_ready",
                    "window_start": None,
                    "window_end": None,
                },
            }
        )
    signals.extend(_class3_signals(segments, segment_centers or []))
    return signals


def _class3_signals(
    segments: Sequence[Mapping[str, Any]],
    centers: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if not centers or len(segments) < 2:
        return []
    last_center = centers[-1]
    lower, upper = Decimal(last_center["lower"]), Decimal(last_center["upper"])
    after = [item for item in segments if item["occurred_at"] >= last_center["occurred_at"]]
    if len(after) < 2:
        return []
    leave, pullback = after[0], after[1]
    extreme = Decimal(pullback["end_price"])
    if lower <= extreme <= upper:
        return []
    side = "buy" if Decimal(leave["end_price"]) > upper else "sell"
    if side == "buy" and extreme <= upper:
        return []
    if side == "sell" and extreme >= lower:
        return []
    return [
        {
            "klass": "class3",
            "side": side,
            "occurred_at": pullback["occurred_at"],
            "price": pullback["end_price"],
            "status": "confirmed" if pullback.get("status") == "confirmed" else "provisional",
            "reason": None,
            "divergence_index": None,
            "sublevel": None,
        }
    ]


def _trend_divergences(
    trend_type: str,
    segments: Sequence[Mapping[str, Any]],
    macd: Mapping[str, Any],
    bars: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if len(segments) < 2:
        return []
    last, previous = segments[-1], segments[-2]
    if last["direction"] != previous["direction"]:
        return []
    if trend_type == "uptrend" and last["direction"] != "up":
        return []
    if trend_type == "downtrend" and last["direction"] != "down":
        return []
    last_extreme = Decimal(last["end_price"])
    prev_extreme = Decimal(previous["end_price"])
    ready = bool(macd.get("ready"))
    histogram = list(macd.get("histogram") or [])
    sign = 1 if last["direction"] == "up" else -1
    last_area = _segment_area(last, histogram, bars, sign) if ready else "0"
    prev_area = _segment_area(previous, histogram, bars, sign) if ready else "0"
    if trend_type == "uptrend":
        price_higher = last_extreme > prev_extreme
        area_not_higher = Decimal(last_area) <= Decimal(prev_area)
        matched = price_higher and area_not_higher
        direction = "top"
    else:
        price_lower = last_extreme < prev_extreme
        area_not_lower = Decimal(last_area) >= Decimal(prev_area)
        matched = price_lower and area_not_lower
        direction = "bottom"
    if not ready:
        return [_divergence("trend", direction, len(segments) - 2, len(segments) - 1, last_extreme, prev_extreme, last_area, prev_area, "unevaluable", "macd_not_ready")]
    if not matched:
        return []
    return [_divergence("trend", direction, len(segments) - 2, len(segments) - 1, last_extreme, prev_extreme, last_area, prev_area, "confirmed", None)]


def _consolidation_divergences(
    segments: Sequence[Mapping[str, Any]],
    macd: Mapping[str, Any],
    bars: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if len(segments) < 2:
        return []
    last, previous = segments[-1], segments[-2]
    if last["direction"] != previous["direction"]:
        return []
    ready = bool(macd.get("ready"))
    histogram = list(macd.get("histogram") or [])
    sign = 1 if last["direction"] == "up" else -1
    last_area = _segment_area(last, histogram, bars, sign) if ready else "0"
    prev_area = _segment_area(previous, histogram, bars, sign) if ready else "0"
    direction = "top" if last["direction"] == "up" else "bottom"
    status = "confirmed" if ready else "unevaluable"
    reason = None if ready else "macd_not_ready"
    return [
        _divergence(
            "consolidation",
            direction,
            len(segments) - 2,
            len(segments) - 1,
            Decimal(last["end_price"]),
            Decimal(previous["end_price"]),
            last_area,
            prev_area,
            status,
            reason,
        )
    ]


def _segment_area(
    segment: Mapping[str, Any],
    histogram: Sequence[str],
    bars: Sequence[Mapping[str, Any]],
    sign: int,
) -> str:
    if not histogram or not bars or len(histogram) != len(bars):
        return "0"
    start = segment["start_index"]
    end = segment["end_index"] + 1
    return histogram_area(histogram, sign=sign, start=max(0, int(start)), end=min(len(histogram), int(end)))


def _divergence(
    kind: str,
    direction: str,
    from_segment: int,
    to_segment: int,
    price_extreme: Decimal,
    previous_price_extreme: Decimal,
    area: str,
    previous_area: str,
    status: str,
    unevaluable_reason: str | None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "direction": direction,
        "from_segment": from_segment,
        "to_segment": to_segment,
        "price_extreme": str(price_extreme),
        "previous_price_extreme": str(previous_price_extreme),
        "area": area,
        "previous_area": previous_area,
        "status": status,
        "unevaluable_reason": unevaluable_reason,
    }
