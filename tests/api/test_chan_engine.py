from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from app.domain.chan_engine import CanonicalBar, ChanEngine


def bar(i: int, high: int, low: int) -> CanonicalBar:
    t = datetime(2024, 1, 1, tzinfo=UTC) + timedelta(days=i)
    return CanonicalBar(
        symbol="600000.SH",
        occurred_at=t,
        known_at=t,
        stable_through=t,
        open=Decimal(low),
        high=Decimal(high),
        low=Decimal(low),
        close=Decimal(high),
    )


def test_reducer_replay_equals_incremental_and_first_bars_are_contained():
    bars = [bar(0, 10, 1), bar(1, 9, 2), bar(2, 11, 0), bar(3, 12, -1)]
    replay = ChanEngine().replay(bars)
    incremental = ChanEngine()
    deltas = [incremental.ingest(item) for item in bars]
    assert incremental.snapshot() == replay
    assert all(isinstance(delta, dict) for delta in deltas)
    assert replay["bars"]


def test_duplicate_is_idempotent_and_older_bar_is_rejected():
    engine = ChanEngine()
    first = bar(0, 10, 1)
    engine.ingest(first)
    assert engine.ingest(first) == {"changed": False}
    with pytest.raises(ValueError, match="乱序"):
        engine.ingest(bar(-1, 9, 0))


def test_replay_equals_incremental_after_each_bar():
    bars = [bar(i, 10 + i, 1) for i in range(6)]
    incremental = ChanEngine()
    for index, item in enumerate(bars, start=1):
        incremental.ingest(item)
        assert incremental.snapshot() == ChanEngine().replay(bars[:index])


def test_snapshot_includes_empty_signal_keys_on_short_series():
    snapshot = ChanEngine().replay([bar(0, 10, 1), bar(1, 12, 3)])
    for key in ("segments", "segment_centers", "macd", "trend", "divergences", "signals"):
        assert key in snapshot


def _stroke(start: int, end: int, start_price: str, end_price: str) -> dict:
    occurred = datetime(2024, 1, 1, tzinfo=UTC) + timedelta(days=end)
    return {
        "direction": "up" if Decimal(end_price) > Decimal(start_price) else "down",
        "start_index": start,
        "end_index": end,
        "start_price": start_price,
        "end_price": end_price,
        "occurred_at": occurred,
        "known_at": occurred,
        "stable_through": occurred,
    }


def test_centers_are_sequential_and_do_not_emit_every_overlapping_triplet():
    from app.domain.chan_engine import build_centers

    strokes = [
        _stroke(0, 4, "10", "20"),
        _stroke(4, 8, "20", "12"),
        _stroke(8, 12, "12", "18"),
        _stroke(12, 16, "18", "14"),
        _stroke(16, 20, "19", "30"),
        _stroke(20, 24, "30", "22"),
        _stroke(24, 28, "22", "28"),
    ]

    centers = build_centers(strokes)

    assert [(item["start_index"], item["end_index"], item["lower"], item["upper"]) for item in centers] == [
        (0, 16, "12", "18"),
        (16, 28, "22", "28"),
    ]


def test_center_stops_at_the_forming_triplet_when_the_next_stroke_leaves():
    from app.domain.chan_engine import build_centers

    strokes = [
        _stroke(0, 4, "20", "12"),
        _stroke(4, 8, "12", "18"),
        _stroke(8, 12, "18", "10"),
        _stroke(12, 16, "10", "30"),
        _stroke(16, 20, "30", "14"),
        _stroke(20, 24, "14", "22"),
        _stroke(24, 28, "22", "16"),
    ]

    centers = build_centers(strokes)

    assert [(item["start_index"], item["end_index"], item["lower"], item["upper"]) for item in centers] == [
        (0, 12, "12", "18"),
        (12, 28, "14", "22"),
    ]


def test_inclusion_direction_updates_after_the_trend_reverses():
    bars = [
        bar(0, 10, 5),
        bar(1, 12, 7),
        bar(2, 11, 8),
        bar(3, 9, 4),
        bar(4, 8, 5),
    ]

    normalized = ChanEngine().replay(bars)["bars"]

    assert [(item["high"], item["low"]) for item in normalized] == [
        ("10", "5"),
        ("12", "8"),
        ("8", "4"),
    ]
