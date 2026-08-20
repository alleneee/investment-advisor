from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from .contracts import LedgerEvent, TradingReducerError
from .metrics import AccountValuationService
from .reducer import (
    InsufficientCashError,
    InsufficientPositionError,
    canonical_decimal_text,
    replay_ledger,
)
from .store import (
    AccountAlreadyExists,
    AccountNotFound,
    IdempotencyConflict,
    RevisionConflict,
    TradingStore,
    TradingStoreError,
)


class TradingServiceError(ValueError):
    code = "TRADING_SERVICE_ERROR"
    status_code = 400

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class TradingNotFoundError(TradingServiceError):
    code = "ACCOUNT_NOT_FOUND"
    status_code = 404


class TradingConflictError(TradingServiceError):
    status_code = 409


class InvalidTradingRequestError(TradingServiceError):
    code = "INVALID_REQUEST"


class TradingService:
    def __init__(
        self,
        store: TradingStore,
        *,
        market_provider: Any | None = None,
        calendar_provider: Any | None = None,
        clock: Any | None = None,
    ) -> None:
        self.store = store
        self.database = store.database
        self.valuation = AccountValuationService(
            self.database,
            market_provider=market_provider,
            calendar_provider=calendar_provider,
            clock=clock,
        )

    def create_account(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        try:
            account = self.store.create_account(payload)
        except AccountAlreadyExists as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._account_summary(account)

    def account(self) -> dict[str, Any]:
        account = self.store.get_account()
        if account is None:
            raise TradingNotFoundError("交易账户不存在")
        return self._account_summary(account)

    def create_execution(self, payload: Mapping[str, Any], details: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
        account = self._account()
        request = {"account_id": account["account_id"], **payload}
        existing = self._find_by_key(self.store.list_executions(account["account_id"], include_deleted=True), request)
        digest = self._execution_request_digest(request, details)
        request["_service_request_digest"] = digest
        if existing is None:
            self._validate_ledger(account, self._execution_event(request), replace_execution=None)
        try:
            row, created = self.store.create_execution(
                request,
                details=details,
                return_outcome=True,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, self._execution_event(request)
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except (AccountNotFound, TradingStoreError) as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._execution_response(row), created

    def list_executions(
        self, *, on: date | None, start: date | None, end: date | None, symbol: str | None
    ) -> list[dict[str, Any]]:
        account = self._account()
        self._validate_range(on, start, end)
        rows = self.store.list_executions(account["account_id"])
        return [
            self._execution_response(row)
            for row in rows
            if self._in_range(row["occurred_at"], on, start, end)
            and (symbol is None or row["symbol"] == symbol)
        ]

    def update_execution(
        self, execution_id: str, payload: Mapping[str, Any], details: Mapping[str, Any], revision: int
    ) -> dict[str, Any]:
        account = self._account()
        rows = self.store.list_executions(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "execution_id", execution_id)
        self._require_current(existing, revision, "成交")
        request = {"account_id": account["account_id"], **payload}
        digest = self._execution_request_digest(request, details)
        request["_service_request_digest"] = digest
        candidate = self._execution_event(
            request, event_id=execution_id, created_at=existing["created_at"]
        )
        self._validate_ledger(account, candidate, replace_execution=execution_id)
        try:
            row = self.store.update_execution(
                execution_id,
                request,
                details=details,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection,
                    account,
                    candidate,
                    replace_execution=execution_id,
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._execution_response(row)

    def delete_execution(self, execution_id: str, revision: int) -> None:
        account = self._account()
        rows = self.store.list_executions(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "execution_id", execution_id)
        self._require_current(existing, revision, "成交")
        self._validate_ledger(account, None, replace_execution=execution_id)
        try:
            self.store.delete_execution(
                execution_id,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, None, replace_execution=execution_id
                ),
            )
        except RevisionConflict as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def create_cash_flow(self, payload: Mapping[str, Any], *, note: str) -> tuple[dict[str, Any], bool]:
        account = self._account()
        request = {"account_id": account["account_id"], **payload}
        existing = self._find_by_key(self.store.list_cash_flows(account["account_id"], include_deleted=True), request)
        digest = self._cash_flow_request_digest(request, note)
        request["_service_request_digest"] = digest
        if existing is None:
            self._validate_ledger(account, self._cash_flow_event(request), replace_cash_flow=None)
        try:
            row, created = self.store.create_cash_flow(
                request,
                details={"note": note},
                return_outcome=True,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, self._cash_flow_event(request)
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except (AccountNotFound, TradingStoreError) as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._cash_flow_response(row), created

    def list_cash_flows(self, *, on: date | None, start: date | None, end: date | None) -> list[dict[str, Any]]:
        account = self._account()
        self._validate_range(on, start, end)
        return [
            self._cash_flow_response(row)
            for row in self.store.list_cash_flows(account["account_id"])
            if self._in_range(row["occurred_at"], on, start, end)
        ]

    def update_cash_flow(
        self, cash_flow_id: str, payload: Mapping[str, Any], *, note: str, revision: int
    ) -> dict[str, Any]:
        account = self._account()
        rows = self.store.list_cash_flows(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "cash_flow_id", cash_flow_id)
        self._require_current(existing, revision, "现金流")
        request = {"account_id": account["account_id"], **payload}
        digest = self._cash_flow_request_digest(request, note)
        request["_service_request_digest"] = digest
        candidate = self._cash_flow_event(
            request, event_id=cash_flow_id, created_at=existing["created_at"]
        )
        self._validate_ledger(account, candidate, replace_cash_flow=cash_flow_id)
        try:
            row = self.store.update_cash_flow(
                cash_flow_id,
                request,
                details={"note": note},
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection,
                    account,
                    candidate,
                    replace_cash_flow=cash_flow_id,
                ),
            )
        except (IdempotencyConflict, RevisionConflict) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc
        except TradingStoreError as exc:
            raise InvalidTradingRequestError(str(exc)) from exc
        return self._cash_flow_response(row)

    def delete_cash_flow(self, cash_flow_id: str, revision: int) -> None:
        account = self._account()
        rows = self.store.list_cash_flows(account["account_id"], include_deleted=True)
        existing = self._find_by_id(rows, "cash_flow_id", cash_flow_id)
        self._require_current(existing, revision, "现金流")
        self._validate_ledger(account, None, replace_cash_flow=cash_flow_id)
        try:
            self.store.delete_cash_flow(
                cash_flow_id,
                expected_revision=revision,
                validation=lambda connection: self._validate_ledger_in(
                    connection, account, None, replace_cash_flow=cash_flow_id
                ),
            )
        except RevisionConflict as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def put_daily_review(self, trade_date: date, payload: Mapping[str, Any]) -> dict[str, Any]:
        account = self._account()
        expected_revision = payload["revision"]
        body = {key: value for key, value in payload.items() if key != "revision"}
        now = datetime.now(UTC).isoformat()
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM daily_reviews WHERE account_id = ? AND trade_date = ?",
                (account["account_id"], trade_date.isoformat()),
            ).fetchone()
            if row is None:
                if expected_revision is not None:
                    raise TradingConflictError("每日收盘复盘 revision 已过期", code="REVISION_CONFLICT")
                review_id, revision = str(uuid.uuid4()), 1
                connection.execute(
                    """
                    INSERT INTO daily_reviews(
                        daily_review_id, account_id, trade_date, payload, revision, is_deleted, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (review_id, account["account_id"], trade_date.isoformat(), json.dumps(body, ensure_ascii=False), revision, now, now),
                )
            else:
                if expected_revision != int(row["revision"]):
                    raise TradingConflictError("每日收盘复盘 revision 已过期", code="REVISION_CONFLICT")
                review_id, revision = row["daily_review_id"], int(row["revision"]) + 1
                connection.execute(
                    """
                    UPDATE daily_reviews SET payload = ?, revision = ?, is_deleted = 0, updated_at = ?
                    WHERE daily_review_id = ? AND revision = ?
                    """,
                    (json.dumps(body, ensure_ascii=False), revision, now, review_id, expected_revision),
                )
            updated = connection.execute(
                """
                UPDATE trading_meta SET daily_review_revision = daily_review_revision + 1
                WHERE account_id = ?
                """,
                (account["account_id"],),
            )
            if updated.rowcount != 1:
                raise TradingNotFoundError("交易账户不存在")
            daily_revision = connection.execute(
                "SELECT daily_review_revision FROM trading_meta WHERE account_id = ?",
                (account["account_id"],),
            ).fetchone()[0]
            connection.execute(
                """
                UPDATE trading_review_snapshots SET is_outdated = 1
                WHERE account_id = ? AND period_start <= ? AND period_end >= ?
                    AND daily_review_revision < ?
                """,
                (account["account_id"], trade_date.isoformat(), trade_date.isoformat(), daily_revision),
            )
        return {"daily_review_id": review_id, "trade_date": trade_date.isoformat(), **body, "revision": revision,
                "daily_review_revision": daily_revision}

    def get_daily_review(self, trade_date: date) -> dict[str, Any]:
        account = self._account()
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT review.*, meta.daily_review_revision FROM daily_reviews AS review
                JOIN trading_meta AS meta ON meta.account_id = review.account_id
                WHERE review.account_id = ? AND review.trade_date = ? AND review.is_deleted = 0
                """,
                (account["account_id"], trade_date.isoformat()),
            ).fetchone()
        if row is None:
            raise TradingNotFoundError("每日收盘复盘不存在")
        return {
            "daily_review_id": row["daily_review_id"],
            "trade_date": row["trade_date"],
            **json.loads(row["payload"]),
            "revision": row["revision"],
            "daily_review_revision": row["daily_review_revision"],
        }

    def _account(self) -> dict[str, Any]:
        account = self.store.get_account()
        if account is None:
            raise TradingNotFoundError("交易账户不存在")
        return account

    def _account_summary(self, account: dict[str, Any]) -> dict[str, Any]:
        return self.valuation.account_summary(
            account,
            self.store.list_executions(account["account_id"]),
            self.store.list_cash_flows(account["account_id"]),
        )

    def refresh_market_prices(self) -> int:
        account = self._account()
        result = self._replay(account)
        account_id = account["account_id"]
        valuation_dates = {self.valuation._now().date()}
        symbols = set(result.positions)
        with self.database.read() as connection:
            cached_rows = connection.execute(
                "SELECT symbol, valuation_date FROM trading_market_prices WHERE account_id = ?",
                (account_id,),
            ).fetchall()
            snapshot_ranges = connection.execute(
                """
                SELECT period_start, period_end
                FROM trading_review_snapshots
                WHERE account_id = ?
                """,
                (account_id,),
            ).fetchall()
        for row in cached_rows:
            symbols.add(str(row["symbol"]))
            valuation_dates.add(date.fromisoformat(str(row["valuation_date"])[:10]))
        for row in snapshot_ranges:
            start_date = date.fromisoformat(str(row["period_start"])[:10])
            end_date = date.fromisoformat(str(row["period_end"])[:10])
            valuation_dates.update(self.valuation._calendar_dates(start_date, end_date))
        return self.valuation.refresh_market_prices(
            account_id,
            sorted(symbols),
            sorted(valuation_dates),
        )

    def _replay(
        self,
        account: Mapping[str, Any],
        *,
        replacement: LedgerEvent | None = None,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ):
        return self._replay_events(
            account,
            self._ledger_events(account["account_id"]),
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _replay_events(
        self,
        account: Mapping[str, Any],
        events: list[LedgerEvent],
        *,
        replacement: LedgerEvent | None = None,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ):
        filtered = [
            event for event in events
            if event.event_id not in {replace_execution, replace_cash_flow}
        ]
        if replacement is not None:
            filtered.append(replacement)
        try:
            return replay_ledger(Decimal(account["initial_capital"]), filtered)
        except (InsufficientCashError, InsufficientPositionError, TradingReducerError) as exc:
            raise TradingConflictError(str(exc), code=exc.code) from exc

    def _validate_ledger(self, account: Mapping[str, Any], replacement: LedgerEvent | None,
                         *, replace_execution: str | None = None, replace_cash_flow: str | None = None) -> None:
        self._replay(
            account,
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _validate_ledger_in(
        self,
        connection: sqlite3.Connection,
        account: Mapping[str, Any],
        replacement: LedgerEvent | None,
        *,
        replace_execution: str | None = None,
        replace_cash_flow: str | None = None,
    ) -> None:
        self._replay_events(
            account,
            self._ledger_events_in(connection, account["account_id"]),
            replacement=replacement,
            replace_execution=replace_execution,
            replace_cash_flow=replace_cash_flow,
        )

    def _ledger_events(self, account_id: str) -> list[LedgerEvent]:
        events = []
        for row in self.store.list_cash_flows(account_id):
            events.append(self._cash_flow_event(row, event_id=row["cash_flow_id"], created_at=row["created_at"]))
        for row in self.store.list_executions(account_id):
            events.append(self._execution_event(row, event_id=row["execution_id"], created_at=row["created_at"]))
        return events

    def _ledger_events_in(self, connection: sqlite3.Connection, account_id: str) -> list[LedgerEvent]:
        events = []
        for row in connection.execute(
            "SELECT * FROM cash_flows WHERE account_id = ? AND is_deleted = 0", (account_id,)
        ).fetchall():
            events.append(self._cash_flow_event(row, event_id=row["cash_flow_id"], created_at=row["created_at"]))
        for row in connection.execute(
            "SELECT * FROM trade_executions WHERE account_id = ? AND is_deleted = 0", (account_id,)
        ).fetchall():
            events.append(self._execution_event(row, event_id=row["execution_id"], created_at=row["created_at"]))
        return events

    @staticmethod
    def _execution_event(request: Mapping[str, Any], *, event_id: str | None = None,
                         created_at: str | None = None) -> LedgerEvent:
        return LedgerEvent(
            event_id=event_id or str(uuid.uuid4()),
            occurred_at=datetime.fromisoformat(str(request["occurred_at"])),
            created_at=datetime.fromisoformat(created_at) if created_at else datetime.now(UTC),
            kind=request["side"],
            symbol=str(request["symbol"]),
            amount=Decimal(str(request["price"])),
            quantity=int(request["quantity"]),
            fee=Decimal(str(request["fee"])),
            primary_reason=str(request["primary_reason"]),
        )

    @staticmethod
    def _cash_flow_event(request: Mapping[str, Any], *, event_id: str | None = None,
                         created_at: str | None = None) -> LedgerEvent:
        return LedgerEvent(
            event_id=event_id or str(uuid.uuid4()),
            occurred_at=datetime.fromisoformat(str(request["occurred_at"])),
            created_at=datetime.fromisoformat(created_at) if created_at else datetime.now(UTC),
            kind=request["kind"],
            symbol=None,
            amount=Decimal(str(request["amount"])),
        )

    @staticmethod
    def _find_by_key(rows: list[dict[str, Any]], request: Mapping[str, Any]) -> dict[str, Any] | None:
        return next((row for row in rows if row["client_idempotency_key"] == request["client_idempotency_key"]), None)

    @staticmethod
    def _find_by_id(rows: list[dict[str, Any]], field: str, value: str) -> dict[str, Any] | None:
        return next((row for row in rows if row[field] == value), None)

    @staticmethod
    def _require_current(row: dict[str, Any] | None, revision: int, label: str) -> None:
        if row is None:
            raise TradingNotFoundError(f"{label}不存在")
        if row["is_deleted"] or row["revision"] != revision:
            raise TradingConflictError(f"{label} revision 已过期", code="REVISION_CONFLICT")

    @staticmethod
    def _details_digest(value: Mapping[str, Any]) -> str:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()

    @classmethod
    def _execution_request_digest(cls, request: Mapping[str, Any], details: Mapping[str, Any]) -> str:
        return cls._details_digest(
            {
                "account_id": request["account_id"],
                "client_idempotency_key": request["client_idempotency_key"],
                "symbol": request["symbol"],
                "side": request["side"],
                "price": canonical_decimal_text(request["price"]),
                "quantity": request["quantity"],
                "fee": canonical_decimal_text(request["fee"]),
                "primary_reason": request["primary_reason"],
                "occurred_at": cls._normalized_time(request["occurred_at"]),
                **details,
            }
        )

    @classmethod
    def _cash_flow_request_digest(cls, request: Mapping[str, Any], note: str) -> str:
        return cls._details_digest(
            {
                "account_id": request["account_id"],
                "client_idempotency_key": request["client_idempotency_key"],
                "kind": request["kind"],
                "amount": canonical_decimal_text(request["amount"]),
                "occurred_at": cls._normalized_time(request["occurred_at"]),
                "note": note,
            }
        )

    @staticmethod
    def _normalized_time(value: Any) -> str:
        return datetime.fromisoformat(str(value)).astimezone(ZoneInfo("Asia/Shanghai")).isoformat()

    def _execution_response(self, row: Mapping[str, Any]) -> dict[str, Any]:
        with self.database.read() as connection:
            details = connection.execute(
                "SELECT name, tags, note FROM trading_execution_details WHERE execution_id = ?", (row["execution_id"],)
            ).fetchone()
        return {
            "execution_id": row["execution_id"], "symbol": row["symbol"],
            "name": details["name"] if details else "", "executed_at": row["occurred_at"],
            "side": row["side"], "price": row["price"], "quantity": row["quantity"], "fee": row["fee"],
            "primary_reason": row["primary_reason"],
            "tags": json.loads(details["tags"]) if details else [], "note": details["note"] if details else "",
            "client_idempotency_key": row["client_idempotency_key"], "revision": row["revision"],
            "ledger_revision": row["ledger_revision"],
        }

    def _cash_flow_response(self, row: Mapping[str, Any]) -> dict[str, Any]:
        with self.database.read() as connection:
            details = connection.execute(
                "SELECT note FROM trading_cash_flow_details WHERE cash_flow_id = ?", (row["cash_flow_id"],)
            ).fetchone()
        return {
            "cash_flow_id": row["cash_flow_id"], "occurred_at": row["occurred_at"], "kind": row["kind"],
            "amount": row["amount"], "note": details["note"] if details else "",
            "client_idempotency_key": row["client_idempotency_key"], "revision": row["revision"],
            "ledger_revision": row["ledger_revision"],
        }

    @staticmethod
    def _validate_range(on: date | None, start: date | None, end: date | None) -> None:
        if on is not None and (start is not None or end is not None):
            raise InvalidTradingRequestError("date 不能与 start/end 同时使用")
        if on is None and (start is None or end is None):
            raise InvalidTradingRequestError("必须提供 date 或成对的 start/end")
        if start is not None and end is not None and start > end:
            raise InvalidTradingRequestError("start 不能晚于 end")

    @staticmethod
    def _in_range(value: str, on: date | None, start: date | None, end: date | None) -> bool:
        occurred_on = date.fromisoformat(value[:10])
        return occurred_on == on if on else start <= occurred_on <= end


def error_status(error: TradingServiceError) -> int:
    return error.status_code


def error_code(error: TradingServiceError) -> str:
    return getattr(error, "code", "TRADING_SERVICE_ERROR")
