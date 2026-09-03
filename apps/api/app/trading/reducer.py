from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, Overflow, localcontext

from .contracts import (
    MAX_DECIMAL_ADJUSTED,
    InvalidLedgerEventError,
    LedgerEvent,
    TradingReducerError,
    decimal_value,
)
from .symbols import trading_symbol_prefix

MONEY_QUANTUM = Decimal("0.01")
MIN_DECIMAL_PRECISION = 28
CONTEXT_EXPONENT_MARGIN = 16


def _configure_context(
    context,
    precision: int,
    *,
    exponent_margin: int = CONTEXT_EXPONENT_MARGIN,
) -> None:
    context.prec = precision
    context.Emax = MAX_DECIMAL_ADJUSTED + exponent_margin
    context.Emin = -(MAX_DECIMAL_ADJUSTED + exponent_margin)


def _value_precision(value: Decimal) -> int:
    digits = len(value.as_tuple().digits)
    return max(digits, value.adjusted() + 1)


def _integer_decimal_digits_upper_bound(value: int) -> int:
    magnitude = abs(value)
    if magnitude == 0:
        return 1
    bits = magnitude.bit_length()
    return (bits * 30_103 + 99_999) // 100_000 + 1


def _stable_precision(*values: Decimal) -> int:
    return max(MIN_DECIMAL_PRECISION, max((_value_precision(value) for value in values), default=0) + 8)


def _stable_divide(numerator: Decimal, denominator: Decimal) -> Decimal:
    with localcontext() as context:
        _configure_context(context, _stable_precision(numerator, denominator))
        return numerator / denominator


def _stable_sum(*values: Decimal) -> Decimal:
    with localcontext() as context:
        _configure_context(context, _stable_precision(*values))
        total = Decimal(0)
        for value in values:
            total += value
        return total


def canonical_decimal_text(value: Decimal | int | str) -> str:
    decimal = decimal_value(value, field="value")
    text = format(decimal, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if not text or text == "-0" else text


def money_text(value: Decimal | int | str) -> str:
    decimal = decimal_value(value, field="value")
    precision = max(28, len(decimal.as_tuple().digits) + max(decimal.adjusted(), 0) + 10)
    with localcontext() as context:
        _configure_context(context, precision)
        try:
            quantized = decimal.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
        except (InvalidOperation, Overflow, ValueError) as exc:
            raise InvalidLedgerEventError("value 无法量化为金额文本") from exc
    if quantized == 0:
        quantized = abs(quantized)
    return format(quantized, ".2f")


class InsufficientCashError(TradingReducerError):
    code = "INSUFFICIENT_CASH"

    def __init__(self, event: LedgerEvent, available_cash: Decimal, required_cash: Decimal) -> None:
        self.event_id = event.event_id
        self.available_cash = available_cash
        self.required_cash = required_cash
        super().__init__(
            f"{event.event_id}: 可用现金 {canonical_decimal_text(available_cash)} "
            f"不足以支付 {canonical_decimal_text(required_cash)}"
        )


class InsufficientPositionError(TradingReducerError):
    code = "INSUFFICIENT_POSITION"

    def __init__(
        self,
        event: LedgerEvent,
        available_quantity: int,
        *,
        aliases: Sequence[tuple[str, int]] = (),
    ) -> None:
        self.event_id = event.event_id
        self.symbol = event.symbol
        self.available_quantity = available_quantity
        self.aliases = tuple(aliases)
        extra = ""
        if aliases:
            extra = "；" + "、".join(f"{symbol} 现有 {quantity} 股" for symbol, quantity in aliases)
        super().__init__(
            f"{event.event_id}: {event.symbol} 可卖 {available_quantity} 股，"
            f"不能卖出 {event.quantity} 股{extra}"
        )


@dataclass(frozen=True, slots=True)
class Position:
    symbol: str
    quantity: int
    cost: Decimal

    @property
    def remaining_cost(self) -> Decimal:
        return self.cost

    @property
    def average_cost(self) -> Decimal:
        return _stable_divide(self.cost, Decimal(self.quantity)) if self.quantity else Decimal(0)

    @property
    def unit_cost(self) -> Decimal:
        return self.average_cost


@dataclass(frozen=True, slots=True)
class ClosedCycle:
    symbol: str
    started_at: datetime
    ended_at: datetime | None
    start_event_id: str
    end_event_id: str | None
    gross_buy_amount: Decimal
    gross_sell_amount: Decimal
    buy_fees: Decimal
    sell_fees: Decimal
    net_pnl: Decimal
    primary_buy_reason: str | None
    primary_sell_reason: str | None
    closed: bool
    realized_by_execution: tuple[Decimal, ...] = field(default_factory=tuple)

    @property
    def cycle_net_pnl(self) -> Decimal:
        return self.net_pnl

    @property
    def cycle_return_rate(self) -> Decimal:
        denominator = _stable_sum(self.gross_buy_amount, self.buy_fees)
        return _stable_divide(self.net_pnl, denominator) if denominator else Decimal(0)

    @property
    def start_date(self):
        return self.started_at.date()

    @property
    def end_date(self):
        return self.ended_at.date() if self.ended_at else None


TradeCycle = ClosedCycle


@dataclass(frozen=True, slots=True)
class ReplayResult:
    cash: Decimal
    positions: dict[str, Position]
    realized_by_execution: list[Decimal]
    cycles: list[ClosedCycle]
    realized_by_event_id: dict[str, Decimal] = field(default_factory=dict)

    @property
    def closed_cycles(self) -> list[ClosedCycle]:
        return [cycle for cycle in self.cycles if cycle.closed]

    @property
    def open_cycles(self) -> list[ClosedCycle]:
        return [cycle for cycle in self.cycles if not cycle.closed]

    @property
    def realized_pnl_by_execution(self) -> list[Decimal]:
        return self.realized_by_execution


@dataclass
class _CycleState:
    symbol: str
    started_at: datetime
    start_event_id: str
    gross_buy_amount: Decimal = Decimal(0)
    gross_sell_amount: Decimal = Decimal(0)
    buy_fees: Decimal = Decimal(0)
    sell_fees: Decimal = Decimal(0)
    net_pnl: Decimal = Decimal(0)
    primary_buy_reason: str | None = None
    primary_sell_reason: str | None = None
    realized_by_execution: list[Decimal] = field(default_factory=list)
    ended_at: datetime | None = None
    end_event_id: str | None = None

    @property
    def closed(self) -> bool:
        return self.ended_at is not None

    def snapshot(self) -> ClosedCycle:
        return ClosedCycle(
            symbol=self.symbol,
            started_at=self.started_at,
            ended_at=self.ended_at,
            start_event_id=self.start_event_id,
            end_event_id=self.end_event_id,
            gross_buy_amount=self.gross_buy_amount,
            gross_sell_amount=self.gross_sell_amount,
            buy_fees=self.buy_fees,
            sell_fees=self.sell_fees,
            net_pnl=self.net_pnl,
            primary_buy_reason=self.primary_buy_reason,
            primary_sell_reason=self.primary_sell_reason,
            closed=self.closed,
            realized_by_execution=tuple(self.realized_by_execution),
        )


def _datetime_key(value: datetime) -> tuple[int, int, int, int, int, int, int]:
    normalized = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return (
        normalized.year,
        normalized.month,
        normalized.day,
        normalized.hour,
        normalized.minute,
        normalized.second,
        normalized.microsecond,
    )


def _event_sort_key(event: LedgerEvent) -> tuple[tuple[int, ...], int, tuple[int, ...], str]:
    cashflow_priority = 0 if event.kind in ("deposit", "withdrawal") else 1
    return (_datetime_key(event.occurred_at), cashflow_priority, _datetime_key(event.created_at), event.event_id)


def _as_position(symbol: str, quantity: int, cost: Decimal) -> Position:
    return Position(symbol=symbol, quantity=quantity, cost=cost)


def _checked_decimal(value: Decimal, *, field: str) -> Decimal:
    return decimal_value(value, field=field)


def replay_ledger(initial_cash: Decimal | int | str, events: Iterable[LedgerEvent]) -> ReplayResult:
    cash = decimal_value(initial_cash, field="initial_cash")
    if cash < 0:
        raise InvalidLedgerEventError("initial_cash 不能为负数")
    materialized = list(events)
    if not all(isinstance(event, LedgerEvent) for event in materialized):
        raise InvalidLedgerEventError("events 必须全部是 LedgerEvent")
    event_ids = [event.event_id for event in materialized]
    if len(event_ids) != len(set(event_ids)):
        raise InvalidLedgerEventError("event_id 必须在一次 replay 中唯一")

    quantity_precision = max(
        (_integer_decimal_digits_upper_bound(event.quantity) for event in materialized),
        default=1,
    )
    required_precision = max(
        MIN_DECIMAL_PRECISION,
        _value_precision(cash) + quantity_precision + 16,
        sum(
            _value_precision(value)
            for event in materialized
            for value in (event.amount, event.fee)
        )
        + quantity_precision
        + 16,
    )

    positions: dict[str, Position] = {}
    open_cycles: dict[str, _CycleState] = {}
    cycle_snapshots: list[ClosedCycle] = []
    realized_by_execution: list[Decimal] = []
    realized_by_event_id: dict[str, Decimal] = {}

    with localcontext() as context:
        _configure_context(
            context,
            required_precision,
            exponent_margin=quantity_precision + CONTEXT_EXPONENT_MARGIN,
        )
        for event in sorted(materialized, key=_event_sort_key):
            if event.kind == "deposit":
                cash = _checked_decimal(cash + event.amount, field="cash")
                continue
            if event.kind == "withdrawal":
                if cash < event.amount:
                    raise InsufficientCashError(event, cash, event.amount)
                cash = _checked_decimal(cash - event.amount, field="cash")
                continue

            assert event.symbol is not None
            position = positions.get(event.symbol)
            current_quantity = position.quantity if position else 0
            current_cost = position.cost if position else Decimal(0)

            if event.kind == "buy":
                total_cost = _checked_decimal(
                    event.amount * event.quantity + event.fee,
                    field="trade total cost",
                )
                if cash < total_cost:
                    raise InsufficientCashError(event, cash, total_cost)
                cash = _checked_decimal(cash - total_cost, field="cash")
                if current_quantity == 0:
                    cycle = _CycleState(
                        symbol=event.symbol,
                        started_at=event.occurred_at,
                        start_event_id=event.event_id,
                        primary_buy_reason=event.primary_reason,
                    )
                    open_cycles[event.symbol] = cycle
                else:
                    cycle = open_cycles[event.symbol]
                cycle.gross_buy_amount = _checked_decimal(
                    cycle.gross_buy_amount + event.amount * event.quantity,
                    field="cycle gross buy amount",
                )
                cycle.buy_fees = _checked_decimal(
                    cycle.buy_fees + event.fee,
                    field="cycle buy fees",
                )
                positions[event.symbol] = _as_position(
                    event.symbol,
                    current_quantity + event.quantity,
                    _checked_decimal(current_cost + total_cost, field="position cost"),
                )
                continue

            if current_quantity < event.quantity:
                aliases = [
                    (symbol, position.quantity)
                    for symbol, position in positions.items()
                    if (
                        trading_symbol_prefix(symbol) == trading_symbol_prefix(event.symbol)
                        and symbol != event.symbol
                        and position.quantity
                    )
                ]
                raise InsufficientPositionError(event, current_quantity, aliases=aliases)
            cycle = open_cycles.get(event.symbol)
            if cycle is None:
                raise InvalidLedgerEventError(f"{event.symbol} 没有开放交易周期")
            gross_amount = _checked_decimal(event.amount * event.quantity, field="trade amount")
            net_income = _checked_decimal(gross_amount - event.fee, field="trade net income")
            required_cash = max(Decimal(0), -net_income)
            if cash < required_cash:
                raise InsufficientCashError(event, cash, required_cash)
            if event.quantity == current_quantity:
                cost_basis = current_cost
            else:
                cost_basis = _checked_decimal(
                    current_cost * Decimal(event.quantity) / Decimal(current_quantity),
                    field="cost basis",
                )
            realized = _checked_decimal(net_income - cost_basis, field="realized pnl")
            cash = _checked_decimal(cash + net_income, field="cash")
            realized_by_execution.append(realized)
            realized_by_event_id[event.event_id] = realized
            cycle.realized_by_execution.append(realized)
            cycle.gross_sell_amount = _checked_decimal(
                cycle.gross_sell_amount + gross_amount,
                field="cycle gross sell amount",
            )
            cycle.sell_fees = _checked_decimal(
                cycle.sell_fees + event.fee,
                field="cycle sell fees",
            )
            cycle.net_pnl = _checked_decimal(cycle.net_pnl + realized, field="cycle net pnl")
            cycle.primary_sell_reason = event.primary_reason
            remaining_quantity = current_quantity - event.quantity
            if remaining_quantity:
                positions[event.symbol] = _as_position(
                    event.symbol,
                    remaining_quantity,
                    _checked_decimal(current_cost - cost_basis, field="position cost"),
                )
            else:
                positions.pop(event.symbol, None)
                cycle.ended_at = event.occurred_at
                cycle.end_event_id = event.event_id
                cycle_snapshots.append(cycle.snapshot())
                del open_cycles[event.symbol]

    cycle_snapshots.extend(cycle.snapshot() for cycle in open_cycles.values())
    cycle_snapshots.sort(key=lambda cycle: (_datetime_key(cycle.started_at), cycle.symbol))
    return ReplayResult(
        cash=cash,
        positions=positions,
        realized_by_execution=realized_by_execution,
        cycles=cycle_snapshots,
        realized_by_event_id=realized_by_event_id,
    )


reduce_ledger = replay_ledger
replay = replay_ledger


__all__ = [
    "ClosedCycle",
    "InsufficientCashError",
    "InsufficientPositionError",
    "Position",
    "ReplayResult",
    "TradeCycle",
    "TradingReducerError",
    "canonical_decimal_text",
    "money_text",
    "reduce_ledger",
    "replay",
    "replay_ledger",
]
