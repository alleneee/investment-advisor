from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Any, Literal

from .chan_engine import build_centers

Direction = Literal["up", "down"]


def build_feature_sequence(
    strokes: Sequence[MappingLike],
    *,
    direction: Direction,
) -> list[dict[str, str]]:
    wanted = "down" if direction == "up" else "up"
    features: list[dict[str, str]] = []
    for index, stroke in enumerate(strokes):
        if stroke["direction"] != wanted:
            continue
        high = max(Decimal(stroke["start_price"]), Decimal(stroke["end_price"]))
        low = min(Decimal(stroke["start_price"]), Decimal(stroke["end_price"]))
        features.append(
            {
                "high": str(high),
                "low": str(low),
                "stroke_index": str(index),
            }
        )
    return features


def standardize_feature_sequence(raw: Sequence[MappingLike]) -> list[dict[str, str]]:
    if not raw:
        return []
    result: list[dict[str, Decimal | str]] = [
        {
            "high": Decimal(raw[0]["high"]),
            "low": Decimal(raw[0]["low"]),
            "stroke_index": str(raw[0].get("stroke_index", "0")),
        }
    ]
    direction = 0
    for current in raw[1:]:
        high = Decimal(current["high"])
        low = Decimal(current["low"])
        previous = result[-1]
        prev_high = Decimal(previous["high"])
        prev_low = Decimal(previous["low"])
        contains = high <= prev_high and low >= prev_low
        contained = prev_high <= high and prev_low >= low
        stroke_index = str(current.get("stroke_index", previous["stroke_index"]))
        if not contains and not contained:
            direction = 1 if high > prev_high and low > prev_low else -1
            result.append({"high": high, "low": low, "stroke_index": stroke_index})
            continue
        if direction == 0:
            result[-1] = {
                "high": max(prev_high, high),
                "low": min(prev_low, low),
                "stroke_index": stroke_index,
            }
            continue
        if direction > 0:
            merged_high = max(prev_high, high)
            merged_low = max(prev_low, low)
        else:
            merged_high = min(prev_high, high)
            merged_low = min(prev_low, low)
        result[-1] = {"high": merged_high, "low": merged_low, "stroke_index": stroke_index}
    return [
        {"high": str(item["high"]), "low": str(item["low"]), "stroke_index": str(item["stroke_index"])}
        for item in result
    ]


def build_segments(strokes: Sequence[MappingLike]) -> list[dict[str, Any]]:
    if len(strokes) < 3:
        return []
    segments: list[dict[str, Any]] = []
    start = 0
    while start + 2 < len(strokes):
        direction = strokes[start]["direction"]
        if direction not in ("up", "down"):
            return []
        broken_at, break_kind = _first_break(strokes, start, direction)
        if broken_at is None:
            segments.append(_segment(strokes, start, len(strokes) - 1, direction, "provisional", None))
            break
        if broken_at - start < 2:
            start += 1
            continue
        segments.append(_segment(strokes, start, broken_at, direction, "confirmed", break_kind))
        start = broken_at + 1
    return segments


def build_segment_centers(segments: Sequence[MappingLike]) -> list[dict[str, Any]]:
    shaped = [
        {
            "start_index": item["start_index"],
            "end_index": item["end_index"],
            "start_price": item["start_price"],
            "end_price": item["end_price"],
            "occurred_at": item["occurred_at"],
            "known_at": item["known_at"],
            "stable_through": item["stable_through"],
        }
        for item in segments
    ]
    return build_centers(shaped)


def _first_break(
    strokes: Sequence[MappingLike],
    start: int,
    direction: Direction,
) -> tuple[int | None, str | None]:
    for end in range(start + 2, len(strokes)):
        window = strokes[start : end + 1]
        standard = standardize_feature_sequence(build_feature_sequence(window, direction=direction))
        kind = _break_kind(standard, direction)
        if kind is None:
            continue
        return end - 1, kind
    return None, None


def _break_kind(standard: Sequence[MappingLike], direction: Direction) -> str | None:
    if len(standard) >= 4:
        previous = standard[-2]
        last = standard[-1]
        prev_high, prev_low = Decimal(previous["high"]), Decimal(previous["low"])
        last_high, last_low = Decimal(last["high"]), Decimal(last["low"])
        if last_high < prev_low or last_low > prev_high:
            return "gap"
    if len(standard) >= 3:
        left, center, right = standard[-3], standard[-2], standard[-1]
        top = (
            Decimal(center["high"]) > Decimal(left["high"])
            and Decimal(center["high"]) > Decimal(right["high"])
            and Decimal(center["low"]) > Decimal(left["low"])
            and Decimal(center["low"]) > Decimal(right["low"])
        )
        bottom = (
            Decimal(center["high"]) < Decimal(left["high"])
            and Decimal(center["high"]) < Decimal(right["high"])
            and Decimal(center["low"]) < Decimal(left["low"])
            and Decimal(center["low"]) < Decimal(right["low"])
        )
        if direction == "up" and top:
            return "fractal"
        if direction == "down" and bottom:
            return "fractal"
    return None


def _segment(
    strokes: Sequence[MappingLike],
    start: int,
    end: int,
    direction: Direction,
    status: str,
    break_kind: str | None,
) -> dict[str, Any]:
    first, last = strokes[start], strokes[end]
    return {
        "direction": direction,
        "start_stroke": start,
        "end_stroke": end,
        "start_index": first["start_index"],
        "end_index": last["end_index"],
        "start_price": first["start_price"],
        "end_price": last["end_price"],
        "occurred_at": last["occurred_at"],
        "known_at": max(item["known_at"] for item in strokes[start : end + 1]),
        "stable_through": max(item["stable_through"] for item in strokes[start : end + 1]),
        "status": status,
        "break_kind": break_kind,
    }


MappingLike = dict[str, Any]
