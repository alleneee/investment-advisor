from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

from app.db import Database

from .contracts import decimal_value
from .reducer import canonical_decimal_text, money_text

_PRESET_CHART_MARK_TYPES: tuple[tuple[str, str, str, str], ...] = (
    ("ideal_buy", "理想买", "买", "#f6465d"),
    ("ideal_sell", "理想卖", "卖", "#4a90e2"),
    ("high", "高点", "高", "#f5a623"),
    ("low", "低点", "低", "#7ed321"),
    ("review", "复盘点", "复", "#9b8cff"),
)


class TradingStoreError(ValueError):
    code = "TRADING_STORE_ERROR"


class AccountAlreadyExists(TradingStoreError):
    code = "ACCOUNT_ALREADY_EXISTS"


class AccountNotFound(TradingStoreError):
    code = "ACCOUNT_NOT_FOUND"


class RevisionConflict(TradingStoreError):
    code = "REVISION_CONFLICT"


class DuplicateMarkType(TradingStoreError):
    code = "DUPLICATE_TYPE"


class MarkTypePreset(TradingStoreError):
    code = "MARK_TYPE_PRESET"


class MarkTypeInUse(TradingStoreError):
    code = "MARK_TYPE_IN_USE"


class IdempotencyConflict(TradingStoreError):
    code = "IDEMPOTENCY_CONFLICT"


class ReviewJobNotFound(TradingStoreError):
    code = "REPORT_NOT_FOUND"


class ReviewLeaseConflict(TradingStoreError):
    code = "REPORT_LEASE_CONFLICT"


class ReviewNotRetryable(TradingStoreError):
    code = "REPORT_NOT_RETRYABLE"


class MarketRevisionConflict(TradingStoreError):
    code = "MARKET_REVISION_CONFLICT"


class ReviewRevisionConflict(TradingStoreError):
    code = "REPORT_INPUT_CHANGED"


class InvalidReviewPayload(TradingStoreError):
    code = "INVALID_REPORT_PAYLOAD"


def _market_dependency_key(symbol: Any, value: Any) -> tuple[str, str] | None:
    if not isinstance(symbol, str) or not symbol:
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return symbol, value.isoformat()
    text = str(value or "")
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        return symbol, date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return None


def _decoded_market_watermark(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return decoded if isinstance(decoded, Mapping) else None


def _watermark_has_market_dependencies(value: Any, changed: set[tuple[str, str]]) -> bool:
    watermark = _decoded_market_watermark(value)
    if watermark is None:
        return False
    for item in watermark.get("prices", ()) or ():
        if not isinstance(item, Mapping):
            continue
        dependency = _market_dependency_key(
            item.get("symbol"), item.get("valuation_date", item.get("trade_date"))
        )
        if dependency in changed:
            return True
    for bundle in watermark.get("bars", ()) or ():
        if not isinstance(bundle, Mapping):
            continue
        symbol = bundle.get("symbol")
        refs = bundle.get("refs", ()) or ()
        for ref in refs:
            if isinstance(ref, Mapping):
                value = ref.get("trade_date", ref.get("valuation_date", ref.get("date")))
            else:
                value = ref
            if _market_dependency_key(symbol, value) in changed:
                return True
        for value in bundle.get("trade_dates", ()) or ():
            if _market_dependency_key(symbol, value) in changed:
                return True
    return False


def outdate_market_snapshots_for_dependencies(
    connection: psycopg.Connection,
    account_id: str,
    changed: Sequence[tuple[str, str]],
    market_revision: int,
) -> None:
    changed_keys = {
        dependency
        for symbol, value in changed
        if (dependency := _market_dependency_key(symbol, value)) is not None
    }
    if not changed_keys:
        return
    rows = connection.execute(
        "SELECT snapshot_id, market_watermark, market_revision "
        "FROM trading_review_snapshots WHERE account_id = %s",
        (account_id,),
    ).fetchall()
    snapshot_ids = [
        row["snapshot_id"]
        for row in rows
        if int(row["market_revision"]) < market_revision
        and _watermark_has_market_dependencies(row["market_watermark"], changed_keys)
    ]
    if not snapshot_ids:
        return
    placeholders = ", ".join("%s" for _ in snapshot_ids)
    connection.execute(
        f"UPDATE trading_review_snapshots SET is_outdated = 1 "
        f"WHERE account_id = %s AND snapshot_id IN ({placeholders})",
        (account_id, *snapshot_ids),
    )


class TradingStore:
    def __init__(self, database: Database) -> None:
        self.database = database
        self._init_schema()

    def _init_schema(self) -> None:
        self.database.execute_script(
            """
                CREATE TABLE IF NOT EXISTS trading_account(
                    account_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    activated_on TEXT NOT NULL,
                    initial_capital TEXT NOT NULL,
                    is_active INTEGER NOT NULL CHECK(is_active IN (0, 1)),
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_trading_account
                    ON trading_account(is_active) WHERE is_active = 1;

                CREATE TABLE IF NOT EXISTS trading_meta(
                    account_id TEXT PRIMARY KEY,
                    ledger_revision INTEGER NOT NULL DEFAULT 0,
                    daily_review_revision INTEGER NOT NULL DEFAULT 0,
                    market_revision INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS cash_flows(
                    cash_flow_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    client_idempotency_key TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(account_id, client_idempotency_key),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS trade_executions(
                    execution_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    client_idempotency_key TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    price TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    fee TEXT NOT NULL,
                    primary_reason TEXT,
                    revision INTEGER NOT NULL,
                    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(account_id, client_idempotency_key),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS trading_execution_details(
                    execution_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    note TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    FOREIGN KEY(execution_id) REFERENCES trade_executions(execution_id)
                );
                CREATE TABLE IF NOT EXISTS trading_cash_flow_details(
                    cash_flow_id TEXT PRIMARY KEY,
                    note TEXT NOT NULL,
                    request_digest TEXT NOT NULL,
                    FOREIGN KEY(cash_flow_id) REFERENCES cash_flows(cash_flow_id)
                );

                CREATE TABLE IF NOT EXISTS daily_reviews(
                    daily_review_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    trade_date TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(account_id, trade_date),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS trading_market_prices(
                    account_id TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    valuation_date TEXT NOT NULL,
                    source_trade_date TEXT NOT NULL,
                    close TEXT NOT NULL,
                    bar_digest TEXT NOT NULL,
                    open TEXT,
                    high TEXT,
                    low TEXT,
                    volume TEXT,
                    chart_bar_digest TEXT,
                    revision INTEGER NOT NULL,
                    PRIMARY KEY(account_id, symbol, valuation_date),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS trading_review_jobs(
                    review_job_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    period_kind TEXT NOT NULL,
                    period_start TEXT,
                    period_end TEXT,
                    input_digest TEXT NOT NULL,
                    status TEXT NOT NULL,
                    snapshot_id TEXT,
                    report_version INTEGER NOT NULL DEFAULT 1,
                    supersedes_snapshot_id TEXT,
                    attempt INTEGER NOT NULL DEFAULT 1,
                    lease_epoch INTEGER NOT NULL DEFAULT 0,
                    lease_expires_at TEXT,
                    execution_id TEXT,
                    data_quality TEXT NOT NULL DEFAULT 'unavailable',
                    ai_status TEXT NOT NULL DEFAULT 'not_requested',
                    frozen_input TEXT NOT NULL DEFAULT '{}',
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(account_id, period_kind, input_digest),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );

                CREATE TABLE IF NOT EXISTS trading_review_snapshots(
                    snapshot_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    period_kind TEXT NOT NULL,
                    period_start TEXT NOT NULL,
                    period_end TEXT NOT NULL,
                    input_digest TEXT NOT NULL,
                    ledger_revision INTEGER NOT NULL,
                    daily_review_revision INTEGER NOT NULL,
                    market_revision INTEGER NOT NULL,
                    is_outdated INTEGER NOT NULL DEFAULT 0 CHECK(is_outdated IN (0, 1)),
                    report_version INTEGER NOT NULL DEFAULT 1,
                    supersedes_snapshot_id TEXT,
                    data_as_of TEXT,
                    market_watermark TEXT,
                    snapshot_status TEXT NOT NULL DEFAULT 'ready',
                    data_quality TEXT NOT NULL DEFAULT 'unavailable',
                    payload TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    UNIQUE(account_id, period_kind, input_digest),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );
                CREATE INDEX IF NOT EXISTS trading_snapshot_ledger_lookup
                    ON trading_review_snapshots(account_id, period_end, ledger_revision);
                CREATE INDEX IF NOT EXISTS trading_snapshot_daily_lookup
                    ON trading_review_snapshots(account_id, daily_review_revision);
                CREATE INDEX IF NOT EXISTS trading_snapshot_market_lookup
                    ON trading_review_snapshots(account_id, market_revision);
                CREATE INDEX IF NOT EXISTS trading_execution_list_order
                    ON trade_executions(account_id, is_deleted, occurred_at, created_at, execution_id);
                CREATE INDEX IF NOT EXISTS trading_cash_flow_list_order
                    ON cash_flows(account_id, is_deleted, occurred_at, created_at, cash_flow_id);

                CREATE TABLE IF NOT EXISTS chart_mark_types(
                    type_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    code TEXT NOT NULL,
                    label TEXT NOT NULL,
                    letter TEXT NOT NULL,
                    color TEXT NOT NULL,
                    preset INTEGER NOT NULL CHECK(preset IN (0, 1)),
                    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                    created_at TEXT NOT NULL,
                    UNIQUE(account_id, code),
                    UNIQUE(account_id, label),
                    UNIQUE(account_id, letter),
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
                );
                CREATE TABLE IF NOT EXISTS chart_marks(
                    mark_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    type_id TEXT NOT NULL,
                    comment TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(account_id) REFERENCES trading_account(account_id),
                    FOREIGN KEY(type_id) REFERENCES chart_mark_types(type_id)
                );
                CREATE INDEX IF NOT EXISTS chart_marks_symbol_time
                    ON chart_marks(account_id, symbol, occurred_at);
                """
        )
        self._migrate_review_schema()

    def _migrate_review_schema(self) -> None:
        migrations = {
                "trading_review_jobs": {
                "period_start": "TEXT",
                "period_end": "TEXT",
                "snapshot_id": "TEXT",
                "report_version": "INTEGER NOT NULL DEFAULT 1",
                "supersedes_snapshot_id": "TEXT",
                "attempt": "INTEGER NOT NULL DEFAULT 1",
                "lease_epoch": "INTEGER NOT NULL DEFAULT 0",
                "lease_expires_at": "TEXT",
                "execution_id": "TEXT",
                "data_quality": "TEXT NOT NULL DEFAULT 'unavailable'",
                "ai_status": "TEXT NOT NULL DEFAULT 'not_requested'",
                "frozen_input": "TEXT NOT NULL DEFAULT '{}'",
                "error": "TEXT",
            },
            "trading_market_prices": {
                "open": "TEXT",
                "high": "TEXT",
                "low": "TEXT",
                "volume": "TEXT",
                "chart_bar_digest": "TEXT",
            },
            "trading_review_snapshots": {
                "report_version": "INTEGER NOT NULL DEFAULT 1",
                "supersedes_snapshot_id": "TEXT",
                "data_as_of": "TEXT",
                "market_watermark": "TEXT",
                "snapshot_status": "TEXT NOT NULL DEFAULT 'ready'",
                "data_quality": "TEXT NOT NULL DEFAULT 'unavailable'",
                "payload": "TEXT NOT NULL DEFAULT '{}'",
            },
        }
        for table, columns in migrations.items():
            with self.database.read() as connection:
                existing = {
                    row["column_name"]
                    for row in connection.execute(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND table_name = %s",
                        (table,),
                    )
                }
            for name, definition in columns.items():
                if name not in existing:
                    self.database.execute_script(
                        f"ALTER TABLE {table} ADD COLUMN {name} {definition};"
                    )
        self.database.execute_script(
            """
            UPDATE trading_review_jobs
            SET lease_expires_at = updated_at
            WHERE status = 'running' AND lease_expires_at IS NULL;
            """
        )

    def create_account(self, request: Mapping[str, Any]) -> dict[str, Any]:
        name = self._text(request, "name")
        activated_on = self._date_text(request, "activated_on")
        initial_capital = canonical_decimal_text(decimal_value(request.get("initial_capital"), field="initial_capital"))
        if Decimal(initial_capital) < 0:
            raise TradingStoreError("initial_capital 不能为负数")
        account_id = str(uuid.uuid4())
        now = self._now()
        try:
            with self.database.transaction(immediate=True) as connection:
                if connection.execute(
                    "SELECT 1 FROM trading_account WHERE is_active = 1"
                ).fetchone() is not None:
                    raise AccountAlreadyExists("活跃交易账户已存在")
                connection.execute(
                    """
                    INSERT INTO trading_account(
                        account_id, name, activated_on, initial_capital, is_active, created_at
                    ) VALUES (%s, %s, %s, %s, 1, %s)
                    """,
                    (account_id, name, activated_on, initial_capital, now),
                )
                connection.execute("INSERT INTO trading_meta(account_id) VALUES (%s)", (account_id,))
        except psycopg.Error as exc:
            raise AccountAlreadyExists("活跃交易账户创建冲突") from exc
        return self.get_account(account_id)

    def get_account(self, account_id: str | None = None) -> dict[str, Any] | None:
        with self.database.read() as connection:
            if account_id is None:
                row = connection.execute(
                    "SELECT account_id FROM trading_account WHERE is_active = 1"
                ).fetchone()
                if row is None:
                    return None
                account_id = row["account_id"]
            row = connection.execute(
                """
                SELECT account.*, meta.ledger_revision, meta.daily_review_revision, meta.market_revision
                FROM trading_account AS account
                JOIN trading_meta AS meta ON meta.account_id = account.account_id
                WHERE account.account_id = %s
                """,
                (account_id,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["is_active"] = bool(result["is_active"])
        result["initial_capital"] = money_text(result["initial_capital"])
        return result

    def ledger_revision(self, account_id: str) -> int:
        return self._meta(account_id)["ledger_revision"]

    def advance_daily_review_revision(self, account_id: str) -> int:
        return self._advance_meta(account_id, "daily_review_revision")

    def advance_market_revision(self, account_id: str) -> int:
        return self._advance_meta(account_id, "market_revision")

    def list_market_bars(
        self,
        account_id: str,
        symbol: str,
        period_start: date,
        period_end: date,
    ) -> list[dict[str, Any]]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT valuation_date, open, high, low, close, volume
                FROM trading_market_prices
                WHERE account_id = %s AND symbol = %s
                    AND valuation_date BETWEEN %s AND %s
                    AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL
                    AND chart_bar_digest = bar_digest
                ORDER BY valuation_date
                """,
                (account_id, symbol, period_start.isoformat(), period_end.isoformat()),
            ).fetchall()
        return [
            {
                "trade_date": row["valuation_date"],
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume": row["volume"],
            }
            for row in rows
        ]

    def cache_market_bars(
        self,
        account_id: str,
        bars: Sequence[Mapping[str, Any]],
        *,
        expected_market_revision: int | None = None,
    ) -> int:
        normalized = [self._market_bar_row(row) for row in bars]
        with self.database.transaction(immediate=True) as connection:
            meta = self._meta_in(connection, account_id)
            revision = int(meta["market_revision"])
            if expected_market_revision is not None and revision != expected_market_revision:
                raise MarketRevisionConflict("行情 revision 已变化")
            changed = False
            changed_dependencies: list[tuple[str, str]] = []
            for row in normalized:
                existing = connection.execute(
                    """
                    SELECT source_trade_date, bar_digest
                    FROM trading_market_prices
                    WHERE account_id = %s AND symbol = %s AND valuation_date = %s
                    """,
                    (account_id, row["symbol"], row["trade_date"]),
                ).fetchone()
                if existing is None or existing["bar_digest"] != row["bar_digest"]:
                    changed = True
                    changed_dependencies.append((row["symbol"], row["trade_date"]))
            if changed:
                revision += 1
                connection.execute(
                    "UPDATE trading_meta SET market_revision = %s WHERE account_id = %s",
                    (revision, account_id),
                )
                outdate_market_snapshots_for_dependencies(
                    connection,
                    account_id,
                    changed_dependencies,
                    revision,
                )
            for row in normalized:
                connection.execute(
                    """
                    INSERT INTO trading_market_prices(
                        account_id, symbol, valuation_date, source_trade_date, close, bar_digest,
                        open, high, low, volume, chart_bar_digest, revision
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT(account_id, symbol, valuation_date) DO UPDATE SET
                        source_trade_date = excluded.source_trade_date,
                        close = excluded.close,
                        bar_digest = excluded.bar_digest,
                        open = excluded.open,
                        high = excluded.high,
                        low = excluded.low,
                        volume = excluded.volume,
                        chart_bar_digest = excluded.chart_bar_digest,
                        revision = excluded.revision
                    """,
                    (
                        account_id,
                        row["symbol"],
                        row["trade_date"],
                        row["trade_date"],
                        row["close"],
                        row["bar_digest"],
                        row["open"],
                        row["high"],
                        row["low"],
                        row["volume"],
                        row["bar_digest"],
                        revision,
                    ),
                )
        return revision

    def ensure_preset_mark_types(self, account_id: str) -> list[dict[str, Any]]:
        now = self._now()
        with self.database.transaction(immediate=True) as connection:
            self._meta_in(connection, account_id)
            for code, label, letter, color in _PRESET_CHART_MARK_TYPES:
                connection.execute(
                    """
                    INSERT INTO chart_mark_types(
                        type_id, account_id, code, label, letter, color, preset, enabled, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, 1, 1, %s)
                    ON CONFLICT (account_id, code) DO NOTHING
                    """,
                    (str(uuid.uuid4()), account_id, code, label, letter, color, now),
                )
        return self.list_chart_mark_types(account_id)

    def list_chart_mark_types(self, account_id: str) -> list[dict[str, Any]]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM chart_mark_types
                WHERE account_id = %s
                ORDER BY created_at, code, type_id
                """,
                (account_id,),
            ).fetchall()
        return [self._chart_mark_type_row(row) for row in rows]

    def create_chart_mark_type(self, request: Mapping[str, Any]) -> dict[str, Any]:
        account_id = self._text(request, "account_id")
        label = self._text(request, "label")
        letter = self._mark_type_letter(request)
        color = self._text(request, "color")
        type_id, code, now = str(uuid.uuid4()), self._custom_mark_type_code(), self._now()
        try:
            with self.database.transaction(immediate=True) as connection:
                self._meta_in(connection, account_id)
                connection.execute(
                    """
                    INSERT INTO chart_mark_types(
                        type_id, account_id, code, label, letter, color, preset, enabled, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, 0, 1, %s)
                    """,
                    (type_id, account_id, code, label, letter, color, now),
                )
                row = connection.execute(
                    "SELECT * FROM chart_mark_types WHERE type_id = %s", (type_id,)
                ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise DuplicateMarkType("点位类型名称或字母已存在") from exc
        return self._chart_mark_type_row(row)

    def update_chart_mark_type(self, type_id: str, request: Mapping[str, Any]) -> dict[str, Any]:
        try:
            with self.database.transaction(immediate=True) as connection:
                existing = connection.execute(
                    "SELECT * FROM chart_mark_types WHERE type_id = %s", (type_id,)
                ).fetchone()
                if existing is None:
                    raise TradingStoreError("点位类型不存在")
                label = self._text(request, "label") if "label" in request else existing["label"]
                letter = (
                    self._mark_type_letter(request) if "letter" in request else existing["letter"]
                )
                color = self._text(request, "color") if "color" in request else existing["color"]
                enabled = existing["enabled"]
                if "enabled" in request:
                    value = request["enabled"]
                    if not isinstance(value, bool) and value not in (0, 1):
                        raise TradingStoreError("enabled 必须是布尔值")
                    enabled = int(value)
                connection.execute(
                    """
                    UPDATE chart_mark_types
                    SET label = %s, letter = %s, color = %s, enabled = %s
                    WHERE type_id = %s
                    """,
                    (label, letter, color, enabled, type_id),
                )
                row = connection.execute(
                    "SELECT * FROM chart_mark_types WHERE type_id = %s", (type_id,)
                ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise DuplicateMarkType("点位类型名称或字母已存在") from exc
        return self._chart_mark_type_row(row)

    def delete_chart_mark_type(self, type_id: str) -> None:
        with self.database.transaction(immediate=True) as connection:
            existing = connection.execute(
                "SELECT * FROM chart_mark_types WHERE type_id = %s", (type_id,)
            ).fetchone()
            if existing is None:
                raise TradingStoreError("点位类型不存在")
            if existing["preset"]:
                raise MarkTypePreset("预置点位类型不能删除")
            referenced = connection.execute(
                "SELECT 1 FROM chart_marks WHERE type_id = %s", (type_id,)
            ).fetchone()
            if referenced is not None:
                raise MarkTypeInUse("点位类型仍被手标引用")
            connection.execute("DELETE FROM chart_mark_types WHERE type_id = %s", (type_id,))

    def list_chart_marks(self, account_id: str) -> list[dict[str, Any]]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM chart_marks
                WHERE account_id = %s
                ORDER BY occurred_at, created_at, mark_id
                """,
                (account_id,),
            ).fetchall()
        return [self._chart_mark_row(row) for row in rows]

    def create_chart_mark(self, request: Mapping[str, Any]) -> dict[str, Any]:
        account_id = self._text(request, "account_id")
        symbol = self._text(request, "symbol")
        type_id = self._text(request, "type_id")
        occurred_at, _ = self._normalized_occurred_at(self._text(request, "occurred_at"))
        comment = request.get("comment", "")
        if not isinstance(comment, str):
            raise TradingStoreError("comment 必须是字符串")
        mark_id, now = str(uuid.uuid4()), self._now()
        with self.database.transaction(immediate=True) as connection:
            self._meta_in(connection, account_id)
            mark_type = connection.execute(
                "SELECT type_id FROM chart_mark_types WHERE type_id = %s AND account_id = %s",
                (type_id, account_id),
            ).fetchone()
            if mark_type is None:
                raise TradingStoreError("点位类型不存在")
            connection.execute(
                """
                INSERT INTO chart_marks(
                    mark_id, account_id, symbol, occurred_at, type_id, comment, revision,
                    created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)
                """,
                (mark_id, account_id, symbol, occurred_at, type_id, comment, now, now),
            )
            row = connection.execute(
                "SELECT * FROM chart_marks WHERE mark_id = %s", (mark_id,)
            ).fetchone()
        return self._chart_mark_row(row)

    def update_chart_mark(
        self,
        mark_id: str,
        request: Mapping[str, Any],
        *,
        expected_revision: int,
    ) -> dict[str, Any]:
        with self.database.transaction(immediate=True) as connection:
            existing = self._chart_mark_for_update(connection, mark_id, expected_revision)
            comment = existing["comment"]
            if "comment" in request:
                if not isinstance(request["comment"], str):
                    raise TradingStoreError("comment 必须是字符串")
                comment = request["comment"]
            type_id = existing["type_id"]
            if "type_id" in request:
                type_id = self._text(request, "type_id")
                mark_type = connection.execute(
                    "SELECT type_id FROM chart_mark_types WHERE type_id = %s AND account_id = %s",
                    (type_id, existing["account_id"]),
                ).fetchone()
                if mark_type is None:
                    raise TradingStoreError("点位类型不存在")
            revision, now = int(existing["revision"]) + 1, self._now()
            updated = connection.execute(
                """
                UPDATE chart_marks
                SET type_id = %s, comment = %s, revision = %s, updated_at = %s
                WHERE mark_id = %s AND revision = %s
                """,
                (type_id, comment, revision, now, mark_id, expected_revision),
            )
            if updated.rowcount != 1:
                raise RevisionConflict("手标 revision 已过期")
            row = connection.execute(
                "SELECT * FROM chart_marks WHERE mark_id = %s", (mark_id,)
            ).fetchone()
        return self._chart_mark_row(row)

    def delete_chart_mark(self, mark_id: str, *, expected_revision: int) -> dict[str, Any]:
        with self.database.transaction(immediate=True) as connection:
            existing = self._chart_mark_for_update(connection, mark_id, expected_revision)
            deleted = connection.execute(
                "DELETE FROM chart_marks WHERE mark_id = %s AND revision = %s",
                (mark_id, expected_revision),
            )
            if deleted.rowcount != 1:
                raise RevisionConflict("手标 revision 已过期")
        return self._chart_mark_row(existing)

    def create_execution(
        self,
        request: Mapping[str, Any],
        *,
        details: Mapping[str, Any] | None = None,
        return_outcome: bool = False,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any] | tuple[dict[str, Any], bool]:
        value = self._execution_request(request)
        with self.database.transaction(immediate=True) as connection:
            existing = connection.execute(
                """
                SELECT * FROM trade_executions
                WHERE account_id = %s AND client_idempotency_key = %s
                """,
                (value["account_id"], value["client_idempotency_key"]),
            ).fetchone()
            if existing is not None:
                if existing["request_digest"] != value["request_digest"]:
                    if details is None or existing["request_digest"] != value["core_request_digest"]:
                        raise IdempotencyConflict("成交幂等键已被不同请求使用")
                    connection.execute(
                        "UPDATE trade_executions SET request_digest = %s WHERE execution_id = %s",
                        (value["request_digest"], existing["execution_id"]),
                    )
                if details is not None:
                    self._ensure_execution_details_in(
                        connection, existing["execution_id"], details, value["request_digest"]
                    )
                row = self._execution_row(
                    existing, self._meta_in(connection, value["account_id"])["ledger_revision"]
                )
                return (row, False) if return_outcome else row
            if validation is not None:
                validation(connection)
            ledger_revision = self._advance_meta_in(connection, value["account_id"], "ledger_revision")
            execution_id, now = str(uuid.uuid4()), self._now()
            connection.execute(
                """
                INSERT INTO trade_executions(
                    execution_id, account_id, client_idempotency_key, request_digest, occurred_at,
                    symbol, side, price, quantity, fee, primary_reason, revision, is_deleted,
                    created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, 0, %s, %s)
                """,
                (
                    execution_id,
                    value["account_id"],
                    value["client_idempotency_key"],
                    value["request_digest"],
                    value["occurred_at"],
                    value["symbol"],
                    value["side"],
                    value["price"],
                    value["quantity"],
                    value["fee"],
                    value["primary_reason"],
                    now,
                    now,
                ),
            )
            if details is not None:
                self._ensure_execution_details_in(
                    connection, execution_id, details, value["request_digest"]
                )
            self._outdate_ledger_snapshots_in(connection, value["account_id"], value["occurred_on"], ledger_revision)
            row = connection.execute(
                "SELECT * FROM trade_executions WHERE execution_id = %s", (execution_id,)
            ).fetchone()
            result = self._execution_row(row, ledger_revision)
            return (result, True) if return_outcome else result

    def list_executions(self, account_id: str, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        query = "SELECT * FROM trade_executions WHERE account_id = %s"
        if not include_deleted:
            query += " AND is_deleted = 0"
        query += " ORDER BY occurred_at, created_at, execution_id"
        with self.database.read() as connection:
            revision = self._meta_in(connection, account_id)["ledger_revision"]
            rows = connection.execute(query, (account_id,)).fetchall()
        return [self._execution_row(row, revision) for row in rows]

    def update_execution(
        self,
        execution_id: str,
        request: Mapping[str, Any],
        *,
        details: Mapping[str, Any] | None = None,
        expected_revision: int,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any]:
        value = self._execution_request(request)
        with self.database.transaction(immediate=True) as connection:
            existing = self._execution_for_update(connection, execution_id, expected_revision)
            if existing["account_id"] != value["account_id"]:
                raise RevisionConflict("成交账户不能变更")
            if connection.execute(
                """
                SELECT 1 FROM trade_executions
                WHERE account_id = %s AND client_idempotency_key = %s AND execution_id != %s
                """,
                (value["account_id"], value["client_idempotency_key"], execution_id),
            ).fetchone() is not None:
                raise IdempotencyConflict("成交幂等键已被其他成交使用")
            if validation is not None:
                validation(connection)
            affected_from = min(self._occurred_on(existing["occurred_at"]), value["occurred_on"])
            ledger_revision = self._advance_meta_in(connection, value["account_id"], "ledger_revision")
            revision, now = int(existing["revision"]) + 1, self._now()
            connection.execute(
                """
                UPDATE trade_executions
                SET client_idempotency_key = %s, request_digest = %s, occurred_at = %s, symbol = %s, side = %s,
                    price = %s, quantity = %s, fee = %s, primary_reason = %s, revision = %s, updated_at = %s
                WHERE execution_id = %s AND revision = %s AND is_deleted = 0
                """,
                (
                    value["client_idempotency_key"], value["request_digest"], value["occurred_at"],
                    value["symbol"], value["side"], value["price"], value["quantity"], value["fee"],
                    value["primary_reason"], revision, now, execution_id, expected_revision,
                ),
            )
            if details is not None:
                self._replace_execution_details_in(
                    connection, execution_id, details, value["request_digest"]
                )
            self._outdate_ledger_snapshots_in(connection, value["account_id"], affected_from, ledger_revision)
            row = connection.execute(
                "SELECT * FROM trade_executions WHERE execution_id = %s", (execution_id,)
            ).fetchone()
            return self._execution_row(row, ledger_revision)

    def delete_execution(
        self,
        execution_id: str,
        *,
        expected_revision: int,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any]:
        with self.database.transaction(immediate=True) as connection:
            existing = self._execution_for_update(connection, execution_id, expected_revision)
            if validation is not None:
                validation(connection)
            ledger_revision = self._advance_meta_in(connection, existing["account_id"], "ledger_revision")
            revision, now = int(existing["revision"]) + 1, self._now()
            connection.execute(
                """
                UPDATE trade_executions
                SET is_deleted = 1, revision = %s, updated_at = %s
                WHERE execution_id = %s AND revision = %s AND is_deleted = 0
                """,
                (revision, now, execution_id, expected_revision),
            )
            self._outdate_ledger_snapshots_in(
                connection, existing["account_id"], self._occurred_on(existing["occurred_at"]), ledger_revision
            )
            row = connection.execute(
                "SELECT * FROM trade_executions WHERE execution_id = %s", (execution_id,)
            ).fetchone()
            return self._execution_row(row, ledger_revision)

    def create_cash_flow(
        self,
        request: Mapping[str, Any],
        *,
        details: Mapping[str, Any] | None = None,
        return_outcome: bool = False,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any] | tuple[dict[str, Any], bool]:
        value = self._cash_flow_request(request)
        with self.database.transaction(immediate=True) as connection:
            existing = connection.execute(
                """
                SELECT * FROM cash_flows WHERE account_id = %s AND client_idempotency_key = %s
                """,
                (value["account_id"], value["client_idempotency_key"]),
            ).fetchone()
            if existing is not None:
                if existing["request_digest"] != value["request_digest"]:
                    if details is None or existing["request_digest"] != value["core_request_digest"]:
                        raise IdempotencyConflict("现金流幂等键已被不同请求使用")
                    connection.execute(
                        "UPDATE cash_flows SET request_digest = %s WHERE cash_flow_id = %s",
                        (value["request_digest"], existing["cash_flow_id"]),
                    )
                if details is not None:
                    self._ensure_cash_flow_details_in(
                        connection, existing["cash_flow_id"], details, value["request_digest"]
                    )
                row = self._cash_flow_row(
                    existing, self._meta_in(connection, value["account_id"])["ledger_revision"]
                )
                return (row, False) if return_outcome else row
            if validation is not None:
                validation(connection)
            ledger_revision = self._advance_meta_in(connection, value["account_id"], "ledger_revision")
            cash_flow_id, now = str(uuid.uuid4()), self._now()
            connection.execute(
                """
                INSERT INTO cash_flows(
                    cash_flow_id, account_id, client_idempotency_key, request_digest, occurred_at, kind,
                    amount, revision, is_deleted, created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, 1, 0, %s, %s)
                """,
                (
                    cash_flow_id, value["account_id"], value["client_idempotency_key"],
                    value["request_digest"], value["occurred_at"], value["kind"], value["amount"], now, now,
                ),
            )
            if details is not None:
                self._ensure_cash_flow_details_in(
                    connection, cash_flow_id, details, value["request_digest"]
                )
            self._outdate_ledger_snapshots_in(connection, value["account_id"], value["occurred_on"], ledger_revision)
            row = connection.execute("SELECT * FROM cash_flows WHERE cash_flow_id = %s", (cash_flow_id,)).fetchone()
            result = self._cash_flow_row(row, ledger_revision)
            return (result, True) if return_outcome else result

    def list_cash_flows(self, account_id: str, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        query = "SELECT * FROM cash_flows WHERE account_id = %s"
        if not include_deleted:
            query += " AND is_deleted = 0"
        query += " ORDER BY occurred_at, created_at, cash_flow_id"
        with self.database.read() as connection:
            revision = self._meta_in(connection, account_id)["ledger_revision"]
            rows = connection.execute(query, (account_id,)).fetchall()
        return [self._cash_flow_row(row, revision) for row in rows]

    def update_cash_flow(
        self,
        cash_flow_id: str,
        request: Mapping[str, Any],
        *,
        details: Mapping[str, Any] | None = None,
        expected_revision: int,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any]:
        value = self._cash_flow_request(request)
        with self.database.transaction(immediate=True) as connection:
            existing = self._cash_flow_for_update(connection, cash_flow_id, expected_revision)
            if existing["account_id"] != value["account_id"]:
                raise RevisionConflict("现金流账户不能变更")
            if connection.execute(
                """
                SELECT 1 FROM cash_flows
                WHERE account_id = %s AND client_idempotency_key = %s AND cash_flow_id != %s
                """,
                (value["account_id"], value["client_idempotency_key"], cash_flow_id),
            ).fetchone() is not None:
                raise IdempotencyConflict("现金流幂等键已被其他现金流使用")
            if validation is not None:
                validation(connection)
            affected_from = min(self._occurred_on(existing["occurred_at"]), value["occurred_on"])
            ledger_revision = self._advance_meta_in(connection, value["account_id"], "ledger_revision")
            revision, now = int(existing["revision"]) + 1, self._now()
            connection.execute(
                """
                UPDATE cash_flows
                SET client_idempotency_key = %s, request_digest = %s, occurred_at = %s, kind = %s, amount = %s,
                    revision = %s, updated_at = %s
                WHERE cash_flow_id = %s AND revision = %s AND is_deleted = 0
                """,
                (
                    value["client_idempotency_key"], value["request_digest"], value["occurred_at"],
                    value["kind"], value["amount"], revision, now, cash_flow_id, expected_revision,
                ),
            )
            if details is not None:
                self._replace_cash_flow_details_in(
                    connection, cash_flow_id, details, value["request_digest"]
                )
            self._outdate_ledger_snapshots_in(connection, value["account_id"], affected_from, ledger_revision)
            row = connection.execute("SELECT * FROM cash_flows WHERE cash_flow_id = %s", (cash_flow_id,)).fetchone()
            return self._cash_flow_row(row, ledger_revision)

    def delete_cash_flow(
        self,
        cash_flow_id: str,
        *,
        expected_revision: int,
        validation: Callable[[psycopg.Connection], None] | None = None,
    ) -> dict[str, Any]:
        with self.database.transaction(immediate=True) as connection:
            existing = self._cash_flow_for_update(connection, cash_flow_id, expected_revision)
            if validation is not None:
                validation(connection)
            ledger_revision = self._advance_meta_in(connection, existing["account_id"], "ledger_revision")
            revision, now = int(existing["revision"]) + 1, self._now()
            connection.execute(
                """
                UPDATE cash_flows SET is_deleted = 1, revision = %s, updated_at = %s
                WHERE cash_flow_id = %s AND revision = %s AND is_deleted = 0
                """,
                (revision, now, cash_flow_id, expected_revision),
            )
            self._outdate_ledger_snapshots_in(
                connection, existing["account_id"], self._occurred_on(existing["occurred_at"]), ledger_revision
            )
            row = connection.execute("SELECT * FROM cash_flows WHERE cash_flow_id = %s", (cash_flow_id,)).fetchone()
            return self._cash_flow_row(row, ledger_revision)

    def create_review_snapshot(self, request: Mapping[str, Any]) -> dict[str, Any]:
        account_id = self._text(request, "account_id")
        period_kind = self._text(request, "period_kind")
        period_start, period_end = self._date_text(request, "period_start"), self._date_text(request, "period_end")
        input_digest = self._text(request, "input_digest")
        market_watermark = request.get("market_watermark")
        if isinstance(market_watermark, Mapping):
            market_watermark = json.dumps(market_watermark, ensure_ascii=False, sort_keys=True)
        with self.database.transaction(immediate=True) as connection:
            meta = self._meta_in(connection, account_id)
            snapshot_id = str(uuid.uuid4())
            try:
                connection.execute(
                    """
                    INSERT INTO trading_review_snapshots(
                        snapshot_id, account_id, period_kind, period_start, period_end, input_digest,
                        ledger_revision, daily_review_revision, market_revision, is_outdated,
                        market_watermark, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s)
                    """,
                    (
                        snapshot_id, account_id, period_kind, period_start, period_end, input_digest,
                        meta["ledger_revision"], meta["daily_review_revision"], meta["market_revision"],
                        market_watermark, self._now(),
                    ),
                )
            except psycopg.errors.UniqueViolation as exc:
                raise IdempotencyConflict("复盘快照摘要已存在") from exc
            row = connection.execute(
                "SELECT * FROM trading_review_snapshots WHERE snapshot_id = %s", (snapshot_id,)
            ).fetchone()
            return self._snapshot_row(row)

    def get_review_snapshot(self, snapshot_id: str) -> dict[str, Any] | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_snapshots WHERE snapshot_id = %s", (snapshot_id,)
            ).fetchone()
        return self._snapshot_row(row) if row is not None else None

    def set_snapshot_outdated(self, snapshot_id: str, is_outdated: bool) -> None:
        if not is_outdated:
            raise RevisionConflict("失效快照不能直接恢复")
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "UPDATE trading_review_snapshots SET is_outdated = %s WHERE snapshot_id = %s",
                (int(is_outdated), snapshot_id),
            )

    def get_or_create_review_job(
        self,
        request: Mapping[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        account_id = self._text(request, "account_id")
        period_kind = self._text(request, "period_kind")
        period_start = self._date_text(request, "period_start")
        period_end = self._date_text(request, "period_end")
        input_digest = self._text(request, "input_digest")
        timestamp = str(request.get("created_at") or self._now())
        frozen_input = json.dumps(request.get("frozen_input", {}), ensure_ascii=False, default=str)
        data_as_of = request.get("data_as_of")
        market_watermark = request.get("market_watermark")
        if isinstance(market_watermark, Mapping):
            market_watermark = json.dumps(market_watermark, ensure_ascii=False, sort_keys=True)
        snapshot_payload = json.dumps(request.get("snapshot_payload", {}), ensure_ascii=False, default=str)
        data_quality = str(request.get("data_quality", "unavailable"))
        with self.database.transaction(immediate=True) as connection:
            meta = self._meta_in(connection, account_id)
            for field in ("ledger_revision", "daily_review_revision", "market_revision"):
                expected = request.get(field)
                if expected is not None and int(expected) != meta[field]:
                    raise ReviewRevisionConflict(f"报告生成期间 {field} 发生变化")
            existing = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE account_id = %s AND period_kind = %s AND input_digest = %s",
                (account_id, period_kind, input_digest),
            ).fetchone()
            if existing is not None:
                return self._review_job_row(existing), False
            previous = connection.execute(
                """
                SELECT snapshot_id, report_version FROM trading_review_snapshots
                WHERE account_id = %s AND period_kind = %s AND period_start = %s AND period_end = %s
                ORDER BY report_version DESC, created_at DESC LIMIT 1
                """,
                (account_id, period_kind, period_start, period_end),
            ).fetchone()
            report_version = int(previous["report_version"]) + 1 if previous else 1
            supersedes = previous["snapshot_id"] if previous else None
            job_id = str(uuid.uuid4())
            snapshot_id = str(uuid.uuid4())
            connection.execute(
                """
                INSERT INTO trading_review_snapshots(
                    snapshot_id, account_id, period_kind, period_start, period_end, input_digest,
                    ledger_revision, daily_review_revision, market_revision, is_outdated,
                    report_version, supersedes_snapshot_id, data_as_of, market_watermark,
                    snapshot_status, data_quality, payload, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, %s, 'pending', %s, %s, %s)
                """,
                (
                    snapshot_id, account_id, period_kind, period_start, period_end, input_digest,
                    int(request.get("ledger_revision", meta["ledger_revision"])),
                    int(request.get("daily_review_revision", meta["daily_review_revision"])),
                    int(request.get("market_revision", meta["market_revision"])), report_version,
                    supersedes, data_as_of, market_watermark, data_quality, snapshot_payload, timestamp,
                ),
            )
            connection.execute(
                """
                INSERT INTO trading_review_jobs(
                    review_job_id, account_id, period_kind, period_start, period_end, input_digest,
                    status, snapshot_id, report_version, supersedes_snapshot_id, attempt, lease_epoch,
                    lease_expires_at, execution_id, data_quality, ai_status, frozen_input, error,
                    created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s, 1, 1, NULL, NULL, %s, 'not_requested', %s, NULL, %s, %s)
                """,
                (
                    job_id, account_id, period_kind, period_start, period_end, input_digest,
                    snapshot_id, report_version, supersedes, data_quality, frozen_input, timestamp, timestamp,
                ),
            )
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (job_id,)
            ).fetchone()
            return self._review_job_row(row), True

    def get_review_job(self, review_job_id: str) -> dict[str, Any] | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
        return self._review_job_row(row) if row is not None else None

    def list_review_jobs(
        self,
        account_id: str,
        *,
        period_kind: str,
        period_start: str,
        period_end: str,
    ) -> list[dict[str, Any]]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM trading_review_jobs
                WHERE account_id = %s AND period_kind = %s AND period_start = %s AND period_end = %s
                ORDER BY report_version DESC, created_at DESC
                """,
                (account_id, period_kind, period_start, period_end),
            ).fetchall()
        return [self._review_job_row(row) for row in rows]

    def claim_review_job(
        self,
        review_job_id: str,
        execution_id: str,
        *,
        now: str | datetime | None = None,
        lease_seconds: int = 300,
    ) -> dict[str, Any]:
        if lease_seconds <= 0:
            raise TradingStoreError("lease_seconds 必须大于 0")
        timestamp = self._timestamp(now)
        expires_at = self._timestamp(
            datetime.fromisoformat(timestamp) + timedelta(seconds=lease_seconds)
        )
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            if row is None:
                raise ReviewJobNotFound("复盘报告不存在")
            status = str(row["status"])
            current_epoch = int(row["lease_epoch"])
            takeover = status == "running" and self._lease_expired(row["lease_expires_at"], timestamp)
            if status != "pending" and not takeover:
                raise ReviewLeaseConflict("复盘报告任务不可执行")
            next_epoch = current_epoch + 1 if takeover else current_epoch
            updated = connection.execute(
                """
                UPDATE trading_review_jobs
                SET status = 'running', execution_id = %s, lease_epoch = %s, lease_expires_at = %s, updated_at = %s
                WHERE review_job_id = %s AND lease_epoch = %s
                    AND (
                        status = 'pending'
                        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= %s)
                    )
                """,
                (
                    execution_id,
                    next_epoch,
                    expires_at,
                    timestamp,
                    review_job_id,
                    current_epoch,
                    timestamp,
                ),
            )
            if updated.rowcount != 1:
                raise ReviewLeaseConflict("复盘报告任务 lease 已失效")
            connection.execute(
                "UPDATE trading_review_snapshots SET snapshot_status = 'running' WHERE snapshot_id = %s",
                (row["snapshot_id"],),
            )
            result = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            return self._review_job_row(result)

    def complete_review_job(
        self,
        review_job_id: str,
        *,
        execution_id: str,
        lease_epoch: int,
        payload: Mapping[str, Any],
        data_quality: str,
        data_as_of: str | None = None,
        market_watermark: str | None = None,
        now: str | datetime | None = None,
    ) -> dict[str, Any]:
        timestamp = self._timestamp(now)
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            if row is None:
                raise ReviewJobNotFound("复盘报告不存在")
            if not row["snapshot_id"]:
                raise InvalidReviewPayload("复盘报告缺少快照")
            snapshot = connection.execute(
                "SELECT snapshot_id FROM trading_review_snapshots WHERE snapshot_id = %s",
                (row["snapshot_id"],),
            ).fetchone()
            if snapshot is None:
                raise InvalidReviewPayload("复盘报告快照不存在")
            if (
                row["status"] != "running"
                or int(row["lease_epoch"]) != lease_epoch
                or row["execution_id"] != execution_id
                or self._lease_expired(row["lease_expires_at"], timestamp)
            ):
                raise ReviewLeaseConflict("复盘报告任务 lease 已失效")
            self._validate_review_payload(payload)
            encoded = json.dumps(payload, ensure_ascii=False, default=str)
            updated = connection.execute(
                """
                UPDATE trading_review_jobs
                SET status = 'ready', data_quality = %s, error = NULL, updated_at = %s
                WHERE review_job_id = %s AND status = 'running' AND lease_epoch = %s AND execution_id = %s
                """,
                (data_quality, timestamp, review_job_id, lease_epoch, execution_id),
            )
            if updated.rowcount != 1:
                raise ReviewLeaseConflict("复盘报告任务 lease 已失效")
            connection.execute(
                """
                UPDATE trading_review_snapshots
                SET snapshot_status = 'ready', data_quality = %s, data_as_of = COALESCE(%s, data_as_of),
                    market_watermark = COALESCE(%s, market_watermark), payload = %s
                WHERE snapshot_id = %s
                """,
                (data_quality, data_as_of, market_watermark, encoded, row["snapshot_id"]),
            )
            result = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            return self._review_job_row(result)

    def fail_review_job(
        self,
        review_job_id: str,
        *,
        execution_id: str,
        lease_epoch: int,
        error: Mapping[str, Any],
        now: str | datetime | None = None,
    ) -> dict[str, Any]:
        timestamp = self._timestamp(now)
        encoded = json.dumps(dict(error), ensure_ascii=False, default=str)
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            if row is None:
                raise ReviewJobNotFound("复盘报告不存在")
            if (
                row["status"] != "running"
                or int(row["lease_epoch"]) != lease_epoch
                or row["execution_id"] != execution_id
                or self._lease_expired(row["lease_expires_at"], timestamp)
            ):
                raise ReviewLeaseConflict("复盘报告任务 lease 已失效")
            updated = connection.execute(
                """
                UPDATE trading_review_jobs
                SET status = 'failed', error = %s, updated_at = %s
                WHERE review_job_id = %s AND status = 'running' AND lease_epoch = %s AND execution_id = %s
                """,
                (encoded, timestamp, review_job_id, lease_epoch, execution_id),
            )
            if updated.rowcount != 1:
                raise ReviewLeaseConflict("复盘报告任务 lease 已失效")
            connection.execute(
                "UPDATE trading_review_snapshots SET snapshot_status = 'failed' WHERE snapshot_id = %s",
                (row["snapshot_id"],),
            )
            result = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            return self._review_job_row(result)

    def retry_review_job(self, review_job_id: str) -> dict[str, Any]:
        timestamp = self._now()
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            if row is None:
                raise ReviewJobNotFound("复盘报告不存在")
            if row["status"] != "failed":
                raise ReviewNotRetryable("只有 failed 报告可以重试")
            error = json.loads(row["error"] or "{}")
            if error.get("retryable", True) is not True:
                raise ReviewNotRetryable("复盘报告不可重试")
            updated = connection.execute(
                """
                UPDATE trading_review_jobs
                SET status = 'pending', attempt = attempt + 1, lease_epoch = lease_epoch + 1,
                    lease_expires_at = NULL, execution_id = NULL, error = NULL, updated_at = %s
                WHERE review_job_id = %s AND status = 'failed'
                """,
                (timestamp, review_job_id),
            )
            if updated.rowcount != 1:
                raise ReviewLeaseConflict("复盘报告重试冲突")
            connection.execute(
                "UPDATE trading_review_snapshots SET snapshot_status = 'pending' WHERE snapshot_id = %s",
                (row["snapshot_id"],),
            )
            result = connection.execute(
                "SELECT * FROM trading_review_jobs WHERE review_job_id = %s", (review_job_id,)
            ).fetchone()
            return self._review_job_row(result)

    def _advance_meta(self, account_id: str, field: str) -> int:
        with self.database.transaction(immediate=True) as connection:
            revision = self._advance_meta_in(connection, account_id, field)
            connection.execute(
                f"""
                UPDATE trading_review_snapshots
                SET is_outdated = 1
                WHERE account_id = %s AND {field} < %s
                """,
                (account_id, revision),
            )
            return revision

    @staticmethod
    def _validate_review_payload(payload: Mapping[str, Any]) -> None:
        if not isinstance(payload, Mapping) or not payload:
            raise InvalidReviewPayload("复盘报告 payload 不能为空")
        report = payload.get("deterministic_report")
        if not isinstance(report, Mapping) or not report:
            raise InvalidReviewPayload("复盘报告缺少 deterministic_report")
        if report.get("schema_version") != "deterministic_trading_review.v1":
            raise InvalidReviewPayload("复盘报告 schema_version 无效")

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _timestamp(value: str | datetime | None = None) -> str:
        if value is None:
            return TradingStore._now()
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC).isoformat()

    @staticmethod
    def _lease_expired(expires_at: str | None, timestamp: str) -> bool:
        if not expires_at:
            return False
        try:
            return datetime.fromisoformat(expires_at) <= datetime.fromisoformat(timestamp)
        except (TypeError, ValueError):
            return True

    @staticmethod
    def _text(request: Mapping[str, Any], field: str) -> str:
        value = request.get(field)
        if not isinstance(value, str) or not value:
            raise TradingStoreError(f"{field} 必须是非空字符串")
        return value

    @classmethod
    def _mark_type_letter(cls, request: Mapping[str, Any]) -> str:
        letter = cls._text(request, "letter")
        if len(letter) > 2:
            raise TradingStoreError("letter 必须是 1–2 个字符")
        return letter

    @staticmethod
    def _custom_mark_type_code() -> str:
        return f"custom_{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _detail_text(request: Mapping[str, Any], field: str) -> str:
        value = request.get(field)
        if not isinstance(value, str):
            raise TradingStoreError(f"{field} 必须是字符串")
        return value

    @classmethod
    def _date_text(cls, request: Mapping[str, Any], field: str) -> str:
        value = cls._text(request, field)
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError as exc:
            raise TradingStoreError(f"{field} 必须是 YYYY-MM-DD") from exc

    @staticmethod
    def _occurred_on(value: str) -> str:
        try:
            return datetime.fromisoformat(value).date().isoformat()
        except ValueError as exc:
            raise TradingStoreError("occurred_at 必须是 ISO-8601 时间") from exc

    @staticmethod
    def _normalized_occurred_at(value: str) -> tuple[str, str]:
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as exc:
            raise TradingStoreError("occurred_at 必须是 ISO-8601 时间") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise TradingStoreError("occurred_at 必须包含时区")
        normalized = parsed.astimezone(ZoneInfo("Asia/Shanghai"))
        return normalized.isoformat(), normalized.date().isoformat()

    def _execution_request(self, request: Mapping[str, Any]) -> dict[str, Any]:
        value = {
            "account_id": self._text(request, "account_id"),
            "client_idempotency_key": self._text(request, "client_idempotency_key"),
            "symbol": self._text(request, "symbol"),
            "side": self._text(request, "side"),
            "quantity": request.get("quantity"),
            "primary_reason": request.get("primary_reason"),
        }
        if value["side"] not in ("buy", "sell"):
            raise TradingStoreError("side 必须是 buy 或 sell")
        if not isinstance(value["quantity"], int) or isinstance(value["quantity"], bool) or value["quantity"] <= 0:
            raise TradingStoreError("quantity 必须是正整数")
        price = decimal_value(request.get("price"), field="price")
        fee = decimal_value(request.get("fee", "0"), field="fee")
        if price <= 0 or fee < 0:
            raise TradingStoreError("price 必须大于 0 且 fee 不能为负数")
        value["price"] = canonical_decimal_text(price)
        value["fee"] = canonical_decimal_text(fee)
        value["occurred_at"], value["occurred_on"] = self._normalized_occurred_at(
            self._text(request, "occurred_at")
        )
        value["core_request_digest"] = self._digest(value, exclude={"occurred_on", "request_digest"})
        value["request_digest"] = self._request_digest(request, value)
        return value

    def _cash_flow_request(self, request: Mapping[str, Any]) -> dict[str, Any]:
        value = {
            "account_id": self._text(request, "account_id"),
            "client_idempotency_key": self._text(request, "client_idempotency_key"),
            "kind": self._text(request, "kind"),
        }
        if value["kind"] not in ("deposit", "withdrawal"):
            raise TradingStoreError("kind 必须是 deposit 或 withdrawal")
        amount = decimal_value(request.get("amount"), field="amount")
        if amount <= 0:
            raise TradingStoreError("amount 必须大于 0")
        value["amount"] = canonical_decimal_text(amount)
        value["occurred_at"], value["occurred_on"] = self._normalized_occurred_at(
            self._text(request, "occurred_at")
        )
        value["core_request_digest"] = self._digest(value, exclude={"occurred_on", "request_digest"})
        value["request_digest"] = self._request_digest(request, value)
        return value

    @classmethod
    def _request_digest(cls, request: Mapping[str, Any], value: Mapping[str, Any]) -> str:
        digest = request.get("_service_request_digest")
        if isinstance(digest, str) and digest:
            return digest
        return str(value["core_request_digest"])

    @staticmethod
    def _ensure_execution_details_in(
        connection: psycopg.Connection,
        execution_id: str,
        details: Mapping[str, Any],
        request_digest: str,
    ) -> None:
        existing = connection.execute(
            "SELECT request_digest FROM trading_execution_details WHERE execution_id = %s", (execution_id,)
        ).fetchone()
        if existing is not None:
            if existing["request_digest"] != request_digest:
                raise IdempotencyConflict("成交幂等键详情与原请求不一致")
            return
        connection.execute(
            """
            INSERT INTO trading_execution_details(execution_id, name, tags, note, request_digest)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                execution_id,
                TradingStore._text(details, "name"),
                json.dumps(details.get("tags"), ensure_ascii=False),
                TradingStore._detail_text(details, "note"),
                request_digest,
            ),
        )

    @staticmethod
    def _ensure_cash_flow_details_in(
        connection: psycopg.Connection,
        cash_flow_id: str,
        details: Mapping[str, Any],
        request_digest: str,
    ) -> None:
        existing = connection.execute(
            "SELECT request_digest FROM trading_cash_flow_details WHERE cash_flow_id = %s", (cash_flow_id,)
        ).fetchone()
        if existing is not None:
            if existing["request_digest"] != request_digest:
                raise IdempotencyConflict("现金流幂等键详情与原请求不一致")
            return
        connection.execute(
            """
            INSERT INTO trading_cash_flow_details(cash_flow_id, note, request_digest)
            VALUES (%s, %s, %s)
            """,
            (cash_flow_id, TradingStore._detail_text(details, "note"), request_digest),
        )

    @staticmethod
    def _replace_execution_details_in(
        connection: psycopg.Connection,
        execution_id: str,
        details: Mapping[str, Any],
        request_digest: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO trading_execution_details(execution_id, name, tags, note, request_digest)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT(execution_id) DO UPDATE SET name = excluded.name, tags = excluded.tags,
                note = excluded.note, request_digest = excluded.request_digest
            """,
            (
                execution_id,
                TradingStore._text(details, "name"),
                json.dumps(details.get("tags"), ensure_ascii=False),
                TradingStore._detail_text(details, "note"),
                request_digest,
            ),
        )

    @staticmethod
    def _replace_cash_flow_details_in(
        connection: psycopg.Connection,
        cash_flow_id: str,
        details: Mapping[str, Any],
        request_digest: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO trading_cash_flow_details(cash_flow_id, note, request_digest)
            VALUES (%s, %s, %s)
            ON CONFLICT(cash_flow_id) DO UPDATE SET note = excluded.note,
                request_digest = excluded.request_digest
            """,
            (cash_flow_id, TradingStore._detail_text(details, "note"), request_digest),
        )

    @staticmethod
    def _digest(value: Mapping[str, Any], *, exclude: set[str]) -> str:
        payload = {key: item for key, item in value.items() if key not in exclude}
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    @classmethod
    def _market_bar_row(cls, row: Mapping[str, Any]) -> dict[str, Any]:
        symbol = row.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            raise TradingStoreError("行情 bar 缺少 symbol")
        trade_date = cls._market_date(row.get("trade_date"))
        normalized = {
            "symbol": symbol,
            "trade_date": trade_date,
            "open": cls._market_decimal(row.get("open"), "open"),
            "high": cls._market_decimal(row.get("high"), "high"),
            "low": cls._market_decimal(row.get("low"), "low"),
            "close": cls._market_decimal(row.get("close"), "close"),
            "volume": (
                None
                if row.get("volume", row.get("vol")) is None
                else cls._market_decimal(row.get("volume", row.get("vol")), "volume")
            ),
        }
        digest_payload = {
            "trade_date": trade_date,
            "open": normalized["open"],
            "high": normalized["high"],
            "low": normalized["low"],
            "close": normalized["close"],
            "vol": normalized["volume"],
        }
        normalized["bar_digest"] = hashlib.sha256(
            json.dumps(digest_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return normalized

    @staticmethod
    def _market_date(value: Any) -> str:
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        text = str(value or "")
        if len(text) == 8 and text.isdigit():
            text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
        try:
            return date.fromisoformat(text).isoformat()
        except ValueError as exc:
            raise TradingStoreError("行情 trade_date 必须是 YYYY-MM-DD") from exc

    @staticmethod
    def _market_decimal(value: Any, field: str) -> str:
        try:
            parsed = Decimal(str(value))
        except (TypeError, ValueError, ArithmeticError) as exc:
            raise TradingStoreError(f"行情 {field} 必须是有限十进制") from exc
        if not parsed.is_finite():
            raise TradingStoreError(f"行情 {field} 必须是有限十进制")
        return canonical_decimal_text(parsed)

    @staticmethod
    def _meta_in(connection: psycopg.Connection, account_id: str) -> dict[str, int]:
        row = connection.execute("SELECT * FROM trading_meta WHERE account_id = %s", (account_id,)).fetchone()
        if row is None:
            raise AccountNotFound("交易账户不存在")
        return {
            "ledger_revision": int(row["ledger_revision"]),
            "daily_review_revision": int(row["daily_review_revision"]),
            "market_revision": int(row["market_revision"]),
        }

    def _meta(self, account_id: str) -> dict[str, int]:
        with self.database.read() as connection:
            return self._meta_in(connection, account_id)

    @staticmethod
    def _advance_meta_in(connection: psycopg.Connection, account_id: str, field: str) -> int:
        if field not in {"ledger_revision", "daily_review_revision", "market_revision"}:
            raise ValueError("不支持的交易版本字段")
        updated = connection.execute(
            f"UPDATE trading_meta SET {field} = {field} + 1 WHERE account_id = %s", (account_id,)
        )
        if updated.rowcount != 1:
            raise AccountNotFound("交易账户不存在")
        return int(
            connection.execute(
                f"SELECT {field} FROM trading_meta WHERE account_id = %s", (account_id,)
            ).fetchone()[field]
        )

    @staticmethod
    def _outdate_ledger_snapshots_in(
        connection: psycopg.Connection, account_id: str, affected_from: str, ledger_revision: int
    ) -> None:
        connection.execute(
            """
            UPDATE trading_review_snapshots
            SET is_outdated = 1
            WHERE account_id = %s AND period_end >= %s AND ledger_revision < %s
            """,
            (account_id, affected_from, ledger_revision),
        )

    @staticmethod
    def _execution_for_update(
        connection: psycopg.Connection, execution_id: str, expected_revision: int
    ) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM trade_executions WHERE execution_id = %s", (execution_id,)
        ).fetchone()
        if row is None or row["is_deleted"] or int(row["revision"]) != expected_revision:
            raise RevisionConflict("成交 revision 已过期")
        return row

    @staticmethod
    def _cash_flow_for_update(
        connection: psycopg.Connection, cash_flow_id: str, expected_revision: int
    ) -> dict[str, Any]:
        row = connection.execute("SELECT * FROM cash_flows WHERE cash_flow_id = %s", (cash_flow_id,)).fetchone()
        if row is None or row["is_deleted"] or int(row["revision"]) != expected_revision:
            raise RevisionConflict("现金流 revision 已过期")
        return row

    @staticmethod
    def _chart_mark_for_update(
        connection: psycopg.Connection, mark_id: str, expected_revision: int
    ) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM chart_marks WHERE mark_id = %s", (mark_id,)
        ).fetchone()
        if row is None or int(row["revision"]) != expected_revision:
            raise RevisionConflict("手标 revision 已过期")
        return row

    @staticmethod
    def _chart_mark_type_row(row: Mapping[str, Any]) -> dict[str, Any]:
        result = dict(row)
        result["preset"] = bool(result["preset"])
        result["enabled"] = bool(result["enabled"])
        return result

    @staticmethod
    def _chart_mark_row(row: Mapping[str, Any]) -> dict[str, Any]:
        result = dict(row)
        result["revision"] = int(result["revision"])
        return result

    @staticmethod
    def _execution_row(row: dict[str, Any], ledger_revision: int) -> dict[str, Any]:
        result = dict(row)
        result["is_deleted"] = bool(result["is_deleted"])
        result["price"] = canonical_decimal_text(result["price"])
        result["fee"] = canonical_decimal_text(result["fee"])
        result["ledger_revision"] = ledger_revision
        return result

    @staticmethod
    def _cash_flow_row(row: dict[str, Any], ledger_revision: int) -> dict[str, Any]:
        result = dict(row)
        result["is_deleted"] = bool(result["is_deleted"])
        result["amount"] = canonical_decimal_text(result["amount"])
        result["ledger_revision"] = ledger_revision
        return result

    @staticmethod
    def _snapshot_row(row: dict[str, Any]) -> dict[str, Any]:
        result = dict(row)
        result["is_outdated"] = bool(result["is_outdated"])
        return result

    def _review_job_row(self, row: dict[str, Any] | None) -> dict[str, Any]:
        if row is None:
            raise ReviewJobNotFound("复盘报告不存在")
        result = dict(row)
        result["attempt"] = int(result.get("attempt") or 1)
        result["lease_epoch"] = int(result.get("lease_epoch") or 0)
        result["report_version"] = int(result.get("report_version") or 1)
        try:
            result["frozen_input"] = json.loads(result.get("frozen_input") or "{}")
        except (TypeError, json.JSONDecodeError):
            result["frozen_input"] = {}
        try:
            result["error"] = json.loads(result["error"]) if result.get("error") else None
        except (TypeError, json.JSONDecodeError):
            result["error"] = {"code": "INTERNAL_ERROR", "message": "报告任务错误状态无效", "retryable": False}
        with self.database.read() as connection:
            snapshot = connection.execute(
                "SELECT * FROM trading_review_snapshots WHERE snapshot_id = %s",
                (result.get("snapshot_id"),),
            ).fetchone()
        if snapshot is not None:
            result["snapshot"] = self._snapshot_row(snapshot)
            result["ledger_revision"] = int(snapshot["ledger_revision"])
            result["daily_review_revision"] = int(snapshot["daily_review_revision"])
            result["market_revision"] = int(snapshot["market_revision"])
            result["is_outdated"] = bool(snapshot["is_outdated"])
            result["data_as_of"] = snapshot["data_as_of"]
            result["market_watermark"] = snapshot["market_watermark"]
            result["data_quality"] = snapshot["data_quality"] or result.get("data_quality", "unavailable")
            result["snapshot_status"] = snapshot["snapshot_status"]
            try:
                result["snapshot_payload"] = json.loads(snapshot["payload"] or "{}")
            except (TypeError, json.JSONDecodeError):
                result["snapshot_payload"] = {}
        else:
            result.update({
                "ledger_revision": 0,
                "daily_review_revision": 0,
                "market_revision": 0,
                "is_outdated": False,
                "data_as_of": None,
                "market_watermark": None,
                "snapshot_status": result.get("status", "pending"),
                "snapshot_payload": {},
            })
        return result


__all__ = [
    "AccountAlreadyExists",
    "AccountNotFound",
    "DuplicateMarkType",
    "IdempotencyConflict",
    "InvalidReviewPayload",
    "MarkTypeInUse",
    "MarkTypePreset",
    "MarketRevisionConflict",
    "ReviewJobNotFound",
    "ReviewLeaseConflict",
    "ReviewNotRetryable",
    "ReviewRevisionConflict",
    "RevisionConflict",
    "TradingStore",
    "TradingStoreError",
]
