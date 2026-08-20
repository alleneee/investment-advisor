from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal
from itertools import pairwise
from typing import Any


def _decimal(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


@dataclass(frozen=True, slots=True)
class CanonicalBar:
    symbol: str
    occurred_at: datetime
    known_at: datetime
    stable_through: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal | None = None
    payload_hash: str | None = None

    def __post_init__(self) -> None:
        for name in ("open", "high", "low", "close"):
            object.__setattr__(self, name, _decimal(getattr(self, name)))
        if self.volume is not None:
            object.__setattr__(self, "volume", _decimal(self.volume))
        if self.high < self.low:
            raise ValueError("high 不能低于 low")

    @classmethod
    def from_value(cls, value: CanonicalBar | dict[str, Any]) -> CanonicalBar:
        if isinstance(value, cls):
            return value
        payload = dict(value)
        for key in ("occurred_at", "known_at", "stable_through"):
            if isinstance(payload.get(key), str):
                payload[key] = datetime.fromisoformat(payload[key])
        if "stable_through" not in payload:
            payload["stable_through"] = payload["known_at"]
        return cls(**payload)

    def as_dict(self) -> dict[str, Any]:
        result = asdict(self)
        for key, value in result.items():
            if isinstance(value, Decimal):
                result[key] = str(value)
        return result


class ChanEngine:
    """Deterministic, stateful reducer for canonical bars and Chan structures."""

    def __init__(self) -> None:
        self._input: list[CanonicalBar] = []
        self._last_snapshot: dict[str, Any] | None = None
        self._frozen_confirmed: list[dict[str, Any]] = []

    def ingest(self, value: CanonicalBar | dict[str, Any]) -> dict[str, Any]:
        bar = CanonicalBar.from_value(value)
        key = (bar.symbol, bar.occurred_at)
        for existing in self._input:
            if (existing.symbol, existing.occurred_at) == key:
                if existing == bar:
                    return {"changed": False}
                raise ValueError("重复时间的 K 线内容不一致")
        if self._input and bar.occurred_at < self._input[-1].occurred_at:
            raise ValueError("乱序输入：occurred_at 必须单调递增")
        self._input.append(bar)
        snapshot = self._reduce()
        previous = self._last_snapshot
        self._last_snapshot = snapshot
        self._frozen_confirmed = list(snapshot["confirmed"])
        return {
            "changed": previous != snapshot,
            "added_occurred_at": bar.occurred_at,
            "snapshot": snapshot,
        }

    def replay(self, values: Iterable[CanonicalBar | dict[str, Any]]) -> dict[str, Any]:
        self._input = []
        self._last_snapshot = None
        self._frozen_confirmed = []
        for value in values:
            self.ingest(value)
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        if self._last_snapshot is None:
            self._last_snapshot = self._reduce()
        return self._last_snapshot

    def delta(self) -> dict[str, Any]:
        return self.snapshot()

    def reduce(self, values: Iterable[CanonicalBar | dict[str, Any]]) -> dict[str, Any]:
        return self.replay(values)

    def step(self, value: CanonicalBar | dict[str, Any]) -> dict[str, Any]:
        return self.ingest(value)

    def _reduce(self) -> dict[str, Any]:
        bars = self._normalize()
        fractals = self._fractals(bars)
        strokes = self._strokes(bars, fractals)
        centers = self._centers(strokes)
        if self._frozen_confirmed:
            confirmed = list(self._frozen_confirmed)
            if len(strokes) > len(confirmed):
                confirmed.extend(strokes[len(confirmed) : -1])
                provisional = strokes[-1:]
            else:
                provisional = []
            strokes = confirmed + provisional
        else:
            confirmed = strokes[:-1] if strokes else []
            provisional = strokes[-1:] if strokes else []
        times = [bar.occurred_at for bar in bars]
        return {
            "bars": [bar.as_dict() for bar in bars],
            "fractals": fractals,
            "strokes": strokes,
            "confirmed": confirmed,
            "provisional": provisional,
            "centers": centers,
            "occurred_at": max(times) if times else None,
            "known_at": max((bar.known_at for bar in bars), default=None),
            "stable_through": max((bar.stable_through for bar in bars), default=None),
            "gaps": self._gaps(bars),
        }

    @staticmethod
    def _normalize_input(bars: list[CanonicalBar]) -> list[CanonicalBar]:
        return bars

    def _normalize(self) -> list[CanonicalBar]:
        source = self._normalize_input(self._input)
        if not source:
            return []
        result: list[CanonicalBar] = [source[0]]
        direction = 0
        for current in source[1:]:
            previous = result[-1]
            contains = current.high <= previous.high and current.low >= previous.low
            contained = previous.high <= current.high and previous.low >= current.low
            if not contains and not contained:
                if direction == 0:
                    direction = 1 if current.high > previous.high and current.low > previous.low else -1
                result.append(current)
                continue
            if direction == 0:
                result[-1] = CanonicalBar(
                    symbol=current.symbol,
                    occurred_at=current.occurred_at,
                    known_at=current.known_at,
                    stable_through=current.stable_through,
                    open=current.open,
                    high=max(previous.high, current.high),
                    low=min(previous.low, current.low),
                    close=current.close,
                    volume=current.volume,
                    payload_hash=current.payload_hash,
                )
                continue
            if direction > 0:
                high = max(previous.high, current.high)
                low = max(previous.low, current.low)
            else:
                high = min(previous.high, current.high)
                low = min(previous.low, current.low)
            result[-1] = CanonicalBar(
                symbol=current.symbol,
                occurred_at=current.occurred_at,
                known_at=current.known_at,
                stable_through=current.stable_through,
                open=current.open,
                high=high,
                low=low,
                close=current.close,
                volume=current.volume,
                payload_hash=current.payload_hash,
            )
        return result

    @staticmethod
    def _gaps(bars: list[CanonicalBar]) -> list[dict[str, Any]]:
        gaps: list[dict[str, Any]] = []
        for previous, current in pairwise(bars):
            if previous.high < current.low or current.high < previous.low:
                gaps.append({
                    "from": previous.occurred_at,
                    "to": current.occurred_at,
                    "direction": "up" if previous.high < current.low else "down",
                })
        return gaps

    @staticmethod
    def _fractals(bars: list[CanonicalBar]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for index in range(1, len(bars) - 1):
            left, center, right = bars[index - 1 : index + 2]
            if center.high > left.high and center.high > right.high and center.low > left.low and center.low > right.low:
                result.append({"kind": "top", "index": index, "price": str(center.high), "occurred_at": center.occurred_at, "known_at": center.known_at, "stable_through": center.stable_through, "status": "confirmed" if index < len(bars) - 2 else "provisional"})
            elif center.low < left.low and center.low < right.low and center.high < left.high and center.high < right.high:
                result.append({"kind": "bottom", "index": index, "price": str(center.low), "occurred_at": center.occurred_at, "known_at": center.known_at, "stable_through": center.stable_through, "status": "confirmed" if index < len(bars) - 2 else "provisional"})
        return result

    @staticmethod
    def _strokes(bars: list[CanonicalBar], fractals: list[dict[str, Any]]) -> list[dict[str, Any]]:
        accepted: list[dict[str, Any]] = []
        for fractal in fractals:
            if not accepted:
                accepted.append(fractal)
                continue
            prior = accepted[-1]
            if prior["kind"] == fractal["kind"]:
                better = (Decimal(fractal["price"]) > Decimal(prior["price"])) if fractal["kind"] == "top" else (Decimal(fractal["price"]) < Decimal(prior["price"]))
                if better or Decimal(fractal["price"]) == Decimal(prior["price"]):
                    accepted[-1] = fractal
                continue
            if fractal["index"] - prior["index"] < 4:
                continue
            start = bars[prior["index"]]
            end = bars[fractal["index"]]
            interval = bars[prior["index"] : fractal["index"] + 1]
            if prior["kind"] == "bottom":
                prior_triple = bars[prior["index"] - 1 : prior["index"] + 2]
                current_triple = bars[fractal["index"] - 1 : fractal["index"] + 2]
                separated = (
                    start.low < min(item.low for item in current_triple)
                    and end.high > max(item.high for item in prior_triple)
                )
                extrema = start.low <= min(item.low for item in interval) and end.high >= max(item.high for item in interval)
            else:
                prior_triple = bars[prior["index"] - 1 : prior["index"] + 2]
                current_triple = bars[fractal["index"] - 1 : fractal["index"] + 2]
                separated = (
                    start.high > max(item.high for item in current_triple)
                    and end.low < min(item.low for item in prior_triple)
                )
                extrema = start.high >= max(item.high for item in interval) and end.low <= min(item.low for item in interval)
            if separated and extrema:
                accepted.append(fractal)
        strokes: list[dict[str, Any]] = []
        for first, second in pairwise(accepted):
            a, b = bars[first["index"]], bars[second["index"]]
            strokes.append({
                "direction": "up" if first["kind"] == "bottom" else "down",
                "start_index": first["index"], "end_index": second["index"],
                "start_price": str(a.low if first["kind"] == "bottom" else a.high),
                "end_price": str(b.high if second["kind"] == "top" else b.low),
                "occurred_at": second["occurred_at"],
                "known_at": max(a.known_at, b.known_at),
                "stable_through": max(a.stable_through, b.stable_through),
            })
        return strokes

    @staticmethod
    def _centers(strokes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        centers: list[dict[str, Any]] = []
        for index in range(len(strokes) - 2):
            window = strokes[index : index + 3]
            lows = [min(Decimal(item["start_price"]), Decimal(item["end_price"])) for item in window]
            highs = [max(Decimal(item["start_price"]), Decimal(item["end_price"])) for item in window]
            lower, upper = max(lows), min(highs)
            if lower < upper:
                center = {
                    "start_index": window[0]["start_index"], "end_index": window[-1]["end_index"],
                    "lower": str(lower), "upper": str(upper),
                    "occurred_at": window[-1]["occurred_at"],
                    "known_at": max(item["known_at"] for item in window),
                    "stable_through": max(item["stable_through"] for item in window),
                }
                for extension in strokes[index + 3 :]:
                    ext_low = min(Decimal(extension["start_price"]), Decimal(extension["end_price"]))
                    ext_high = max(Decimal(extension["start_price"]), Decimal(extension["end_price"]))
                    if ext_low < upper and ext_high > lower:
                        center["end_index"] = extension["end_index"]
                        center["occurred_at"] = extension["occurred_at"]
                        center["known_at"] = max(center["known_at"], extension["known_at"])
                        center["stable_through"] = max(center["stable_through"], extension["stable_through"])
                    else:
                        break
                centers.append(center)
        return centers
