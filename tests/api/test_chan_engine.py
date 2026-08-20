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


def test_confirmed_output_is_not_rewritten_by_future_append():
    engine = ChanEngine()
    for item in [bar(0, 10, 1), bar(1, 12, 3), bar(2, 8, 0), bar(3, 9, 1), bar(4, 13, 2)]:
        engine.ingest(item)
    before = engine.snapshot()["confirmed"]
    engine.ingest(bar(5, 14, 4))
    assert engine.snapshot()["confirmed"] == before
