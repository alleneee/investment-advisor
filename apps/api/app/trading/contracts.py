from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Literal

LedgerKind = Literal["deposit", "withdrawal", "buy", "sell"]
MAX_DECIMAL_ADJUSTED = 1_000_000


class TradingReducerError(ValueError):
    """账本重放失败。"""

    code = "TRADING_REDUCER_ERROR"


class InvalidLedgerEventError(TradingReducerError):
    code = "INVALID_LEDGER_EVENT"


def decimal_value(value: Decimal | int | str, *, field: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise TypeError(f"{field} 必须使用 Decimal、整数或十进制文本")
    if not isinstance(value, (Decimal, int, str)):
        raise TypeError(f"{field} 必须使用 Decimal、整数或十进制文本")
    try:
        result = value if isinstance(value, Decimal) else Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise InvalidLedgerEventError(f"{field} 不是有效十进制数") from exc
    if not result.is_finite():
        raise InvalidLedgerEventError(f"{field} 必须是有限十进制数")
    if abs(result.adjusted()) > MAX_DECIMAL_ADJUSTED:
        raise InvalidLedgerEventError(
            f"{field} 的指数超出支持范围 ±{MAX_DECIMAL_ADJUSTED}"
        )
    return result


@dataclass(frozen=True, slots=True)
class LedgerEvent:
    event_id: str
    occurred_at: datetime
    created_at: datetime
    kind: LedgerKind
    symbol: str | None
    amount: Decimal
    quantity: int = 0
    fee: Decimal = Decimal(0)
    primary_reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.event_id, str) or not self.event_id:
            raise InvalidLedgerEventError("event_id 不能为空")
        if not isinstance(self.occurred_at, datetime) or not isinstance(self.created_at, datetime):
            raise InvalidLedgerEventError("occurred_at 和 created_at 必须是 datetime")
        if self.kind not in ("deposit", "withdrawal", "buy", "sell"):
            raise InvalidLedgerEventError(f"不支持的账本事件类型: {self.kind}")
        if not isinstance(self.quantity, int) or isinstance(self.quantity, bool):
            raise InvalidLedgerEventError("quantity 必须是整数")
        amount = decimal_value(self.amount, field="amount")
        fee = decimal_value(self.fee, field="fee")
        if amount <= 0:
            raise InvalidLedgerEventError("amount 必须大于 0")
        if fee < 0:
            raise InvalidLedgerEventError("fee 不能为负数")
        if self.kind in ("deposit", "withdrawal"):
            if self.symbol is not None:
                raise InvalidLedgerEventError("现金流不能包含 symbol")
            if self.quantity != 0 or fee != 0:
                raise InvalidLedgerEventError("现金流的 quantity 和 fee 必须为 0")
        elif not isinstance(self.symbol, str) or not self.symbol:
            raise InvalidLedgerEventError("成交必须包含非空字符串 symbol")
        elif self.quantity <= 0:
            raise InvalidLedgerEventError("成交 quantity 必须大于 0")
        object.__setattr__(self, "amount", amount)
        object.__setattr__(self, "fee", fee)

    @property
    def price(self) -> Decimal:
        return self.amount
