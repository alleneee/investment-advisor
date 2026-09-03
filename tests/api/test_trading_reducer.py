from datetime import datetime
from decimal import Decimal, localcontext

import pytest
from app.trading.contracts import LedgerEvent, decimal_value
from app.trading.reducer import (
    InsufficientCashError,
    InsufficientPositionError,
    InvalidLedgerEventError,
    canonical_decimal_text,
    money_text,
    replay_ledger,
)


def _event(
    event_id: str,
    occurred_at: str,
    kind: str,
    *,
    amount: str,
    quantity: int = 0,
    fee: str = "0",
    created_at: str | None = None,
    symbol: str | None = "600000.SH",
    primary_reason: str | None = "other",
) -> LedgerEvent:
    return LedgerEvent(
        event_id=event_id,
        occurred_at=datetime.fromisoformat(occurred_at),
        created_at=datetime.fromisoformat(created_at or occurred_at),
        kind=kind,
        symbol=symbol,
        amount=Decimal(amount),
        quantity=quantity,
        fee=Decimal(fee),
        primary_reason=primary_reason,
    )


def test_split_buys_and_sells_close_one_cycle() -> None:
    result = replay_ledger(
        initial_cash=Decimal(100000),
        events=[
            _event("buy-1", "2026-01-05T09:30:00", "buy", amount="10", quantity=1000, fee="5"),
            _event("buy-2", "2026-01-06T09:30:00", "buy", amount="12", quantity=1000, fee="5"),
            _event("sell-1", "2026-01-08T09:30:00", "sell", amount="13", quantity=1000, fee="5"),
            _event("sell-2", "2026-01-09T09:30:00", "sell", amount="11", quantity=1000, fee="5"),
        ],
    )

    assert result.cash == Decimal(101980)
    assert result.positions == {}
    assert result.realized_by_execution == [Decimal(1990), Decimal(-10)]
    assert result.cycles[0].net_pnl == Decimal(1980)
    assert result.cycles[0].gross_buy_amount == Decimal(22000)
    assert result.cycles[0].buy_fees == Decimal(10)
    assert result.cycles[0].cycle_return_rate == Decimal(1980) / Decimal(22010)


def test_selling_more_than_position_fails_without_a_partial_result() -> None:
    events = [
        _event("buy", "2026-01-05T09:30:00", "buy", amount="10", quantity=100),
        _event("sell", "2026-01-06T09:30:00", "sell", amount="10", quantity=101),
    ]

    with pytest.raises(InsufficientPositionError) as error:
        replay_ledger(Decimal(1000), events)

    assert error.value.code == "INSUFFICIENT_POSITION"
    assert error.value.available_quantity == 100


def test_insufficient_position_hints_alias_symbol_with_same_prefix() -> None:
    events = [
        _event("buy", "2026-01-05T09:30:00", "buy", amount="10", quantity=100, symbol="002309.SZ"),
        _event("sell", "2026-01-06T09:30:00", "sell", amount="10", quantity=50, symbol="002309"),
    ]

    with pytest.raises(InsufficientPositionError) as error:
        replay_ledger(Decimal(1000), events)

    assert error.value.available_quantity == 0
    assert error.value.aliases == (("002309.SZ", 100),)
    assert "002309.SZ 现有 100 股" in str(error.value)


def test_buying_more_than_cash_fails() -> None:
    event = _event("buy", "2026-01-05T09:30:00", "buy", amount="10", quantity=101)

    with pytest.raises(InsufficientCashError) as error:
        replay_ledger(Decimal(1000), [event])

    assert error.value.code == "INSUFFICIENT_CASH"


def test_full_withdrawal_is_allowed_but_excess_withdrawal_fails() -> None:
    withdrawal = _event(
        "withdrawal",
        "2026-01-05T09:30:00",
        "withdrawal",
        amount="1000",
        symbol=None,
        primary_reason=None,
    )
    assert replay_ledger(Decimal(1000), [withdrawal]).cash == Decimal(0)

    excess = _event(
        "excess-withdrawal",
        "2026-01-05T09:30:00",
        "withdrawal",
        amount="1000.01",
        symbol=None,
        primary_reason=None,
    )
    with pytest.raises(InsufficientCashError):
        replay_ledger(Decimal(1000), [excess])


def test_same_timestamp_cashflow_precedes_trade_and_trade_order_is_stable() -> None:
    occurred = "2026-01-05T09:30:00"
    events = [
        _event(
            "buy-b",
            occurred,
            "buy",
            amount="5",
            quantity=10,
            created_at="2026-01-05T09:30:01",
        ),
        _event(
            "deposit",
            occurred,
            "deposit",
            amount="100",
            created_at="2026-01-05T09:30:02",
            symbol=None,
            primary_reason=None,
        ),
        _event(
            "buy-a",
            occurred,
            "buy",
            amount="5",
            quantity=10,
            created_at="2026-01-05T09:30:01",
        ),
    ]

    result = replay_ledger(Decimal(0), events)

    assert result.cash == Decimal(0)
    assert result.positions["600000.SH"].quantity == 20
    assert result.positions["600000.SH"].cost == Decimal(100)


def test_partial_sale_keeps_high_precision_cost_and_final_sale_conserves_it() -> None:
    result = replay_ledger(
        Decimal(100),
        [
            _event("buy-a", "2026-01-05T09:30:00", "buy", amount="0.99", quantity=1),
            _event("buy-b", "2026-01-06T09:30:00", "buy", amount="0.005", quantity=2),
            _event("sell-a", "2026-02-03T09:30:00", "sell", amount="1", quantity=1),
            _event("sell-b", "2026-02-04T09:30:00", "sell", amount="1", quantity=2),
        ],
    )

    assert len(result.realized_by_execution[0].as_tuple().digits) >= 28
    assert sum(result.realized_by_execution, Decimal(0)) == Decimal(2)
    assert result.cycles[0].net_pnl == Decimal(2)


def test_cross_month_partial_sale_keeps_one_open_cycle_until_cleared() -> None:
    result = replay_ledger(
        Decimal(10000),
        [
            _event("buy", "2025-12-31T09:30:00", "buy", amount="10", quantity=100),
            _event("sell-a", "2026-01-05T09:30:00", "sell", amount="12", quantity=50),
        ],
    )

    assert len(result.cycles) == 1
    assert result.cycles[0].closed is False
    assert result.cycles[0].started_at.month == 12
    assert result.cycles[0].ended_at is None
    assert result.positions["600000.SH"].quantity == 50
    assert result.positions["600000.SH"].cost == Decimal(500)
    assert result.realized_by_execution == [Decimal(100)]


def test_decimal_text_and_money_text_are_canonical() -> None:
    assert canonical_decimal_text(Decimal("1E+3")) == "1000"
    assert canonical_decimal_text(Decimal("10.5000")) == "10.5"
    assert canonical_decimal_text(Decimal("-0")) == "0"
    assert money_text(Decimal("0.005")) == "0.01"
    assert money_text(Decimal("1.005")) == "1.01"
    assert money_text(Decimal("-0.005")) == "-0.01"


def test_sell_fee_cannot_make_cash_negative() -> None:
    events = [
        _event("buy", "2026-01-05T09:30:00", "buy", amount="1", quantity=1),
        _event("sell", "2026-01-06T09:30:00", "sell", amount="1", quantity=1, fee="2"),
    ]

    with pytest.raises(InsufficientCashError) as error:
        replay_ledger(Decimal(1), events)

    assert error.value.available_cash == Decimal(0)
    assert error.value.required_cash == Decimal(1)


def test_duplicate_event_ids_are_rejected_before_replay_ordering() -> None:
    event_a = _event("same-id", "2026-01-05T09:30:00", "buy", amount="1", quantity=1)
    event_b = _event("same-id", "2026-01-05T09:30:01", "buy", amount="1", quantity=1)

    with pytest.raises(InvalidLedgerEventError, match="event_id"):
        replay_ledger(Decimal(10), [event_b, event_a])


def test_money_text_handles_a_decimal_larger_than_default_context() -> None:
    assert money_text(Decimal("1E+100")) == "1" + "0" * 100 + ".00"


def test_decimal_precision_and_public_derived_values_ignore_external_context() -> None:
    precise_price = Decimal("1.23456789012345678901234567890123456789012345678901234567890")
    buy = _event("buy", "2026-01-05T09:30:00", "buy", amount=str(precise_price), quantity=3)
    sell = _event("sell", "2026-01-06T09:30:00", "sell", amount="2", quantity=3)

    with localcontext() as context:
        context.prec = 5
        low_position_result = replay_ledger(Decimal(100), [buy])
        low_cycle_result = replay_ledger(Decimal(100), [buy, sell])
        low_average_cost = low_position_result.positions["600000.SH"].average_cost
        low_return_rate = low_cycle_result.cycles[0].cycle_return_rate
    with localcontext() as context:
        context.prec = 50
        high_position_result = replay_ledger(Decimal(100), [buy])
        high_cycle_result = replay_ledger(Decimal(100), [buy, sell])
        high_average_cost = high_position_result.positions["600000.SH"].average_cost
        high_return_rate = high_cycle_result.cycles[0].cycle_return_rate

    assert low_average_cost == high_average_cost
    assert low_return_rate == high_return_rate
    assert str(low_return_rate).startswith("0.620")


def test_multiple_symbols_and_input_order_produce_the_same_result() -> None:
    events = [
        _event("b", "2026-01-05T09:30:00", "buy", amount="10", quantity=2),
        _event("deposit", "2026-01-05T09:30:00", "deposit", amount="100", symbol=None, primary_reason=None),
        _event("a-buy", "2026-01-05T09:31:00", "buy", amount="5", quantity=4, symbol="000001.SZ"),
        _event("a-sell", "2026-01-06T09:31:00", "sell", amount="6", quantity=4, symbol="000001.SZ"),
        _event("b-sell", "2026-01-06T09:30:00", "sell", amount="11", quantity=2),
    ]

    first = replay_ledger(Decimal(0), events)
    second = replay_ledger(Decimal(0), list(reversed(events)))

    assert first.cash == second.cash == Decimal(106)
    assert first.positions == second.positions == {}
    assert first.realized_by_execution == second.realized_by_execution == [Decimal(2), Decimal(4)]
    assert first.cycles == second.cycles


def test_decimal_input_exponent_has_a_defined_supported_limit() -> None:
    assert decimal_value(Decimal("1E+100"), field="value") == Decimal("1E+100")
    with pytest.raises(InvalidLedgerEventError):
        decimal_value(Decimal("1E+1000001"), field="value")
    with pytest.raises(InvalidLedgerEventError):
        money_text(Decimal("1E+1000001"))


@pytest.mark.parametrize(
    ("event_id", "symbol"),
    [(1, "600000.SH"), ("event", 600000), ("", "600000.SH"), ("event", "")],
)
def test_event_id_and_trade_symbol_must_be_non_empty_strings(event_id: object, symbol: object) -> None:
    with pytest.raises(InvalidLedgerEventError):
        LedgerEvent(
            event_id=event_id,
            occurred_at=datetime.fromisoformat("2026-01-05T09:30:00"),
            created_at=datetime.fromisoformat("2026-01-05T09:30:00"),
            kind="buy",
            symbol=symbol,
            amount=Decimal(1),
            quantity=1,
        )


def test_scientific_notation_initial_cash_and_boundary_buy_are_conserved() -> None:
    boundary_cash = Decimal("1E+1000000")
    withdrawal = _event(
        "withdrawal-one",
        "2026-01-05T09:30:00",
        "withdrawal",
        amount="1",
        symbol=None,
        primary_reason=None,
    )
    withdrawn = replay_ledger(boundary_cash, [withdrawal])
    with localcontext() as context:
        context.prec = 1_000_020
        context.Emax = 1_000_016
        context.Emin = -1_000_016
        assert withdrawn.cash + Decimal(1) == boundary_cash

    buy = _event("boundary-buy", "2026-01-05T09:30:00", "buy", amount="1E+1000000", quantity=1)
    bought = replay_ledger(boundary_cash, [buy])
    assert bought.cash == Decimal(0)


def test_money_text_supports_the_declared_upper_boundary() -> None:
    rendered = money_text(Decimal("1E+1000000"))

    assert len(rendered) == 1_000_004
    assert rendered.endswith("000.00")


def test_arithmetic_beyond_the_declared_decimal_boundary_is_a_domain_error() -> None:
    event = _event(
        "overflow-buy",
        "2026-01-05T09:30:00",
        "buy",
        amount="9.99E+1000000",
        quantity=2,
    )

    with pytest.raises(InvalidLedgerEventError):
        replay_ledger(Decimal("1E+1000000"), [event])


def test_large_quantity_boundary_overflow_is_a_domain_error() -> None:
    event = _event(
        "large-quantity-overflow",
        "2026-01-05T09:30:00",
        "buy",
        amount="9.99E+1000000",
        quantity=10**17,
    )

    with pytest.raises(InvalidLedgerEventError):
        replay_ledger(Decimal("1E+1000000"), [event])


def test_huge_quantity_does_not_leak_integer_string_conversion_error() -> None:
    event = _event(
        "huge-quantity",
        "2026-01-05T09:30:00",
        "buy",
        amount="9.99E+1000000",
        quantity=10**5000,
    )

    with pytest.raises(InvalidLedgerEventError):
        replay_ledger(Decimal(1), [event])
