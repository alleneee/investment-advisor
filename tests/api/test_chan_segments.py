from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.domain.chan_segments import (
    build_feature_sequence,
    build_segment_centers,
    build_segments,
    standardize_feature_sequence,
)


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


def _three_stroke_unbroken() -> list[dict]:
    return [
        _stroke(0, 4, "10", "20"),
        _stroke(4, 8, "20", "12"),
        _stroke(8, 12, "12", "18"),
    ]


def _gap_break_strokes() -> list[dict]:
    return [
        _stroke(0, 4, "10", "30"),
        _stroke(4, 8, "30", "20"),
        _stroke(8, 12, "20", "28"),
        _stroke(12, 16, "28", "18"),
        _stroke(16, 20, "18", "26"),
        _stroke(20, 24, "26", "16"),
        _stroke(24, 28, "16", "22"),
        _stroke(28, 32, "8", "2"),
    ]


def _fractal_break_strokes() -> list[dict]:
    return [
        _stroke(0, 4, "10", "22"),
        _stroke(4, 8, "22", "12"),
        _stroke(8, 12, "12", "26"),
        _stroke(12, 16, "26", "16"),
        _stroke(16, 20, "16", "24"),
        _stroke(20, 24, "21", "13"),
    ]


def test_up_segment_feature_sequence_uses_down_strokes_only():
    strokes = [
        _stroke(0, 4, "10", "20"),
        _stroke(4, 8, "20", "12"),
        _stroke(8, 12, "12", "18"),
        _stroke(12, 16, "18", "14"),
    ]
    features = build_feature_sequence(strokes, direction="up")
    assert [item["low"] for item in features] == ["12", "14"]


def test_standard_feature_sequence_merges_inclusion():
    raw = [{"high": "20", "low": "10"}, {"high": "18", "low": "12"}, {"high": "22", "low": "11"}]
    standard = standardize_feature_sequence(raw)
    assert len(standard) < len(raw)


def test_gap_break_confirms_segment():
    segments = build_segments(_gap_break_strokes())
    assert segments[0]["status"] == "confirmed"
    assert segments[0]["break_kind"] == "gap"
    assert segments[0]["direction"] == "up"
    assert segments[0]["end_stroke"] == 6


def test_unbroken_tail_is_provisional():
    segments = build_segments(_three_stroke_unbroken())
    assert segments[-1]["status"] == "provisional"
    assert segments[-1]["break_kind"] is None


def test_ambiguous_partition_is_omitted():
    assert build_segments([_stroke(0, 4, "10", "20"), _stroke(4, 8, "20", "12")]) == []


def test_fractal_break_confirms_up_segment_on_top_fractal():
    segments = build_segments(_fractal_break_strokes())
    assert segments[0]["break_kind"] == "fractal"
    assert segments[0]["direction"] == "up"
    assert segments[0]["status"] == "confirmed"


def test_segment_centers_are_sequential():
    segments = [
        {
            "direction": "up",
            "start_stroke": 0,
            "end_stroke": 2,
            "start_index": 0,
            "end_index": 12,
            "start_price": "10",
            "end_price": "18",
            "occurred_at": datetime(2024, 1, 13, tzinfo=UTC),
            "known_at": datetime(2024, 1, 13, tzinfo=UTC),
            "stable_through": datetime(2024, 1, 13, tzinfo=UTC),
            "status": "confirmed",
            "break_kind": "gap",
        },
        {
            "direction": "down",
            "start_stroke": 2,
            "end_stroke": 5,
            "start_index": 12,
            "end_index": 24,
            "start_price": "18",
            "end_price": "8",
            "occurred_at": datetime(2024, 1, 25, tzinfo=UTC),
            "known_at": datetime(2024, 1, 25, tzinfo=UTC),
            "stable_through": datetime(2024, 1, 25, tzinfo=UTC),
            "status": "confirmed",
            "break_kind": "fractal",
        },
        {
            "direction": "up",
            "start_stroke": 5,
            "end_stroke": 8,
            "start_index": 24,
            "end_index": 36,
            "start_price": "8",
            "end_price": "16",
            "occurred_at": datetime(2024, 2, 6, tzinfo=UTC),
            "known_at": datetime(2024, 2, 6, tzinfo=UTC),
            "stable_through": datetime(2024, 2, 6, tzinfo=UTC),
            "status": "provisional",
            "break_kind": None,
        },
    ]
    centers = build_segment_centers(segments)
    assert len(centers) == 1
    assert Decimal(centers[0]["lower"]) < Decimal(centers[0]["upper"])
