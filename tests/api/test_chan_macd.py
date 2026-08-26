from decimal import Decimal

from app.domain.chan_macd import compute_macd, histogram_area


def test_macd_not_ready_before_warmup():
    result = compute_macd([Decimal(i) for i in range(1, 30)])
    assert result["ready"] is False
    assert result["histogram"] == []
    assert result["dif"] == []
    assert result["dea"] == []
    assert result["warmup_bars"] == 26


def test_macd_histogram_matches_hand_seeded_ema():
    closes = [Decimal(x) for x in ("10", "11", "12", "11", "13") + ("12",) * 40]
    result = compute_macd(closes)
    assert result["ready"] is True
    assert len(result["histogram"]) == len(closes)
    assert all(isinstance(item, str) for item in result["histogram"])
    Decimal(result["histogram"][-1])


def test_macd_ready_returns_dif_dea_same_length_as_histogram() -> None:
    closes = [Decimal(x) for x in ("10", "11", "12", "11", "13") + ("12",) * 40]
    result = compute_macd(closes)
    assert result["ready"] is True
    assert len(result["dif"]) == len(closes)
    assert len(result["dea"]) == len(closes)
    assert len(result["histogram"]) == len(closes)
    last_dif = Decimal(result["dif"][-1])
    last_dea = Decimal(result["dea"][-1])
    assert Decimal(result["histogram"][-1]) == 2 * (last_dif - last_dea)


def test_histogram_area_sums_same_sign_bars_only():
    area = histogram_area(["1.0", "-0.5", "2.0"], sign=1)
    assert Decimal(area) == Decimal("3.0")
    assert Decimal(histogram_area(["1.0", "-0.5", "2.0"], sign=-1)) == Decimal("-0.5")
