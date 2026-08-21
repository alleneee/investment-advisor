from __future__ import annotations

import json
import os
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from psycopg import errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class DatabaseBusyError(RuntimeError):
    code = "DATABASE_BUSY"


class NestedTransactionError(RuntimeError):
    code = "NESTED_TRANSACTION"


_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS watchlist(symbol TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, symbols TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, status TEXT NOT NULL, report_id TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, report_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS advisor_states(
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    lease_epoch INTEGER NOT NULL,
    artifacts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_history_snapshots(
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    adjustment TEXT NOT NULL,
    as_of TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY(symbol, timeframe, adjustment, as_of, start_date, end_date)
);
CREATE TABLE IF NOT EXISTS external_information_cache(
    cache_key TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY(cache_key, source)
);
CREATE TABLE IF NOT EXISTS investment_report_jobs(
    report_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    input_digest TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    as_of TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    lease_epoch INTEGER NOT NULL,
    frozen_input TEXT NOT NULL,
    result TEXT,
    error TEXT,
    execution_id TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    published_at TEXT,
    share_token TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS report_outcomes(
    report_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    as_of TEXT NOT NULL,
    status TEXT NOT NULL,
    realized_case TEXT,
    bar_count INTEGER NOT NULL,
    window_end TEXT,
    payload TEXT NOT NULL,
    evaluated_at TEXT NOT NULL
);
"""

# 已有数据库补列：与 TradingStore 一致，用 information_schema 判断后幂等 ALTER。
_COLUMN_MIGRATIONS = {
    "investment_report_jobs": {
        "review_status": "TEXT NOT NULL DEFAULT 'pending'",
        "reviewed_at": "TEXT",
        "published_at": "TEXT",
        "share_token": "TEXT UNIQUE",
        "lease_expires_at": "TEXT",
    },
}

# 同一 schema 内的并发建表用统一 advisory lock 序列化，避免 IF NOT EXISTS 竞态。
_DDL_LOCK_KEY = 873201
# immediate 写事务的全局锁：复刻 SQLite BEGIN IMMEDIATE 的单写者语义，
# 幂等 get-or-create 与 revision 推进依赖写事务串行化。读路径仍走 MVCC 不受影响。
_WRITE_LOCK_KEY = 873202


class Database:
    """PostgreSQL 存储。conninfo 缺省时读取 DATABASE_URL，缺失则启动失败。"""

    def __init__(self, conninfo: str | None = None) -> None:
        value = conninfo or os.getenv("DATABASE_URL")
        if not value:
            raise RuntimeError("缺少 DATABASE_URL：必须配置 PostgreSQL 连接串，不支持内存数据库")
        self.conninfo = value
        self._transaction_state = threading.local()
        self.pool = ConnectionPool(
            value,
            min_size=1,
            max_size=10,
            open=True,
            kwargs={"row_factory": dict_row},
        )
        self.init()

    def init(self) -> None:
        with self.pool.connection() as conn:
            conn.execute(f"SELECT pg_advisory_xact_lock({_DDL_LOCK_KEY})")
            conn.execute(_SCHEMA_DDL)
            for table, columns in _COLUMN_MIGRATIONS.items():
                existing = {
                    row["column_name"]
                    for row in conn.execute(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND table_name = %s",
                        (table,),
                    )
                }
                for name, definition in columns.items():
                    if name not in existing:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
            conn.execute(
                "UPDATE investment_report_jobs SET lease_expires_at = updated_at "
                "WHERE status = 'running' AND lease_expires_at IS NULL"
            )

    def close(self) -> None:
        self.pool.close()

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[psycopg.Connection]:
        self._assert_no_nested_transaction()
        try:
            with self.pool.connection() as conn:
                if immediate:
                    conn.execute(f"SELECT pg_advisory_xact_lock({_WRITE_LOCK_KEY})")
                self._transaction_state.active = True
                self._transaction_state.conn = conn
                try:
                    yield conn
                finally:
                    self._transaction_state.active = False
                    self._transaction_state.conn = None
        except (errors.LockNotAvailable, errors.DeadlockDetected, errors.SerializationFailure) as exc:
            raise DatabaseBusyError("数据库写事务繁忙") from exc

    @contextmanager
    def read(self) -> Iterator[psycopg.Connection]:
        # 事务内的读取必须复用事务连接，才能看到未提交数据（与旧单连接语义一致）。
        current = getattr(self._transaction_state, "conn", None)
        if current is not None:
            yield current
            return
        with self.pool.connection() as conn:
            yield conn

    def execute_script(self, script: str) -> None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            conn.execute(f"SELECT pg_advisory_xact_lock({_DDL_LOCK_KEY})")
            conn.execute(script)

    def _assert_no_nested_transaction(self) -> None:
        if getattr(self._transaction_state, "active", False):
            raise NestedTransactionError("事务内不能调用数据库公共写方法")

    def add_watch(self, symbol: str) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            if conn.execute("SELECT 1 FROM watchlist WHERE symbol = %s", (symbol,)).fetchone():
                return {"symbol": symbol}
            count_row = conn.execute("SELECT COUNT(*) AS n FROM watchlist").fetchone()
            if count_row["n"] >= 50:
                raise ValueError("watchlist 最多 50 只股票")
            conn.execute("INSERT INTO watchlist VALUES (%s, %s)", (symbol, self._now()))
        return {"symbol": symbol}

    def list_watch(self) -> list[dict[str, Any]]:
        with self.pool.connection() as conn:
            return [
                dict(row)
                for row in conn.execute("SELECT symbol, created_at FROM watchlist ORDER BY created_at")
            ]

    def remove_watch(self, symbol: str) -> bool:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            result = conn.execute("DELETE FROM watchlist WHERE symbol = %s", (symbol,))
        return result.rowcount > 0

    def get_market_history(
        self,
        symbol: str,
        timeframe: str,
        adjustment: str,
        as_of: str,
        start_date: str,
        end_date: str,
    ) -> list[dict[str, Any]] | None:
        with self.pool.connection() as conn:
            row = conn.execute(
                """
                SELECT payload FROM market_history_snapshots
                WHERE symbol = %s AND timeframe = %s AND adjustment = %s
                  AND as_of = %s AND start_date = %s AND end_date = %s
                """,
                (symbol, timeframe, adjustment, as_of, start_date, end_date),
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def save_market_history(
        self,
        symbol: str,
        timeframe: str,
        adjustment: str,
        as_of: str,
        start_date: str,
        end_date: str,
        rows: list[dict[str, Any]],
    ) -> None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO market_history_snapshots
                    (symbol, timeframe, adjustment, as_of, start_date, end_date, payload, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(symbol, timeframe, adjustment, as_of, start_date, end_date)
                DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
                """,
                (
                    symbol,
                    timeframe,
                    adjustment,
                    as_of,
                    start_date,
                    end_date,
                    json.dumps(rows, ensure_ascii=False, default=str),
                    self._now(),
                ),
            )

    def get_external_information_cache(
        self,
        cache_key: str,
        source: str,
        *,
        now: datetime,
    ) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute(
                """
                SELECT payload, fetched_at, expires_at
                FROM external_information_cache
                WHERE cache_key = %s AND source = %s
                """,
                (cache_key, source),
            ).fetchone()
        if row is None:
            return None
        expires_at = datetime.fromisoformat(row["expires_at"])
        return {
            "payload": json.loads(row["payload"]),
            "fetched_at": row["fetched_at"],
            "expires_at": row["expires_at"],
            "expired": now >= expires_at,
        }

    def save_external_information_cache(
        self,
        cache_key: str,
        source: str,
        payload: list[dict[str, Any]],
        fetched_at: datetime,
        expires_at: datetime,
    ) -> None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO external_information_cache
                    (cache_key, source, payload, fetched_at, expires_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT(cache_key, source)
                DO UPDATE SET
                    payload = excluded.payload,
                    fetched_at = excluded.fetched_at,
                    expires_at = excluded.expires_at
                """,
                (
                    cache_key,
                    source,
                    json.dumps(payload, ensure_ascii=False),
                    fetched_at.isoformat(),
                    expires_at.isoformat(),
                ),
            )

    def get_or_create_investment_report_job(
        self,
        input_digest: str,
        frozen_input: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> tuple[dict[str, Any], bool]:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        # 并发创建相同 digest 时，先到者插入成功，后到者撞唯一约束后重读既有任务。
        for _ in range(2):
            try:
                with self.pool.connection() as conn:
                    row = conn.execute(
                        "SELECT * FROM investment_report_jobs WHERE input_digest = %s FOR UPDATE",
                        (input_digest,),
                    ).fetchone()
                    if row is not None:
                        if row["status"] == "failed":
                            lease_epoch = int(row["lease_epoch"]) + 1
                            attempt_count = int(row["attempt_count"]) + 1
                            updated = conn.execute(
                                """
                                UPDATE investment_report_jobs
                                SET status = 'queued', attempt_count = %s, lease_epoch = %s, error = NULL,
                                    execution_id = NULL, lease_expires_at = NULL, updated_at = %s,
                                    started_at = NULL, completed_at = NULL
                                WHERE report_id = %s AND status = 'failed'
                                """,
                                (attempt_count, lease_epoch, timestamp, row["report_id"]),
                            )
                            if updated.rowcount != 1:
                                raise ValueError("报告任务不可重新排队")
                            conn.execute(
                                "UPDATE advisor_states SET lease_epoch = %s WHERE run_id = %s",
                                (lease_epoch, row["run_id"]),
                            )
                            refreshed = conn.execute(
                                "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                                (row["report_id"],),
                            ).fetchone()
                            return self._investment_job(refreshed), True
                        job = self._investment_job(row)
                        job["cached"] = row["status"] == "completed"
                        return job, False

                    report_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
                    encoded_input = json.dumps(frozen_input, ensure_ascii=False, default=str)
                    conn.execute(
                        """
                        INSERT INTO investment_report_jobs(
                            report_id, run_id, input_digest, symbol, timeframe, as_of, status,
                            attempt_count, lease_epoch, frozen_input, result, error, execution_id,
                            created_at, updated_at, started_at, completed_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, 'queued', 1, 1, %s, NULL, NULL, NULL, %s, %s, NULL, NULL)
                        """,
                        (
                            report_id,
                            run_id,
                            input_digest,
                            frozen_input["symbol"],
                            frozen_input["timeframe"],
                            frozen_input["as_of"],
                            encoded_input,
                            timestamp,
                            timestamp,
                        ),
                    )
                    artifacts = self._initial_report_artifacts(frozen_input, report_id)
                    conn.execute(
                        "INSERT INTO advisor_states VALUES (%s, 'QUEUED', 0, 1, %s)",
                        (run_id, json.dumps(artifacts, ensure_ascii=False, default=str)),
                    )
                    row = conn.execute(
                        "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                        (report_id,),
                    ).fetchone()
                    return self._investment_job(row), True
            except errors.UniqueViolation:
                continue
        raise DatabaseBusyError("报告任务创建冲突")

    def get_investment_report_job(
        self,
        report_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                (report_id,),
            ).fetchone()
            return self._investment_job(row) if row is not None else None

    def claim_investment_report_job(
        self,
        report_id: str,
        execution_id: str,
        *,
        now: datetime | None = None,
        lease_seconds: int = 300,
    ) -> dict[str, Any]:
        if lease_seconds <= 0:
            raise ValueError("lease_seconds 必须大于 0")
        self._assert_no_nested_transaction()
        current = now or datetime.now(UTC)
        timestamp = current.isoformat()
        lease_expires_at = (current + timedelta(seconds=lease_seconds)).isoformat()
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s FOR UPDATE",
                (report_id,),
            ).fetchone()
            if row is None:
                raise ValueError("报告任务不可执行")
            takeover = row["status"] == "running" and row.get("lease_expires_at") is not None and row["lease_expires_at"] <= timestamp
            if row["status"] != "queued" and not takeover:
                raise ValueError("报告任务不可执行")
            current_epoch = int(row["lease_epoch"])
            next_epoch = current_epoch + 1 if takeover else current_epoch
            result = conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'running', execution_id = %s, lease_epoch = %s,
                    lease_expires_at = %s, started_at = %s, updated_at = %s
                WHERE report_id = %s AND lease_epoch = %s
                    AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= %s))
                """,
                (
                    execution_id,
                    next_epoch,
                    lease_expires_at,
                    timestamp,
                    timestamp,
                    report_id,
                    current_epoch,
                    timestamp,
                ),
            )
            if result.rowcount != 1:
                raise ValueError("报告任务不可执行")
            if takeover:
                conn.execute(
                    "UPDATE advisor_states SET lease_epoch = %s WHERE run_id = %s",
                    (next_epoch, row["run_id"]),
                )
            row = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                (report_id,),
            ).fetchone()
            return self._investment_job(row)

    def list_recoverable_investment_report_jobs(
        self,
        *,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self.pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM investment_report_jobs
                WHERE status = 'queued'
                   OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= %s)
                ORDER BY created_at, report_id
                """,
                (timestamp,),
            ).fetchall()
        return [self._investment_job(row) for row in rows]

    def retry_investment_report_job(
        self,
        report_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s FOR UPDATE",
                (report_id,),
            ).fetchone()
            if row is None:
                raise KeyError("报告任务不存在")
            error = json.loads(row["error"]) if row["error"] else {}
            if row["status"] != "failed" or error.get("retryable") is not True:
                raise ValueError("报告任务不可重试")
            lease_epoch = int(row["lease_epoch"]) + 1
            attempt_count = int(row["attempt_count"]) + 1
            updated = conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'queued', attempt_count = %s, lease_epoch = %s, error = NULL,
                    execution_id = NULL, lease_expires_at = NULL, updated_at = %s,
                    started_at = NULL, completed_at = NULL
                WHERE report_id = %s AND status = 'failed'
                """,
                (attempt_count, lease_epoch, timestamp, report_id),
            )
            if updated.rowcount != 1:
                raise ValueError("报告任务不可重试")
            conn.execute(
                "UPDATE advisor_states SET lease_epoch = %s WHERE run_id = %s",
                (lease_epoch, row["run_id"]),
            )
            refreshed = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                (report_id,),
            ).fetchone()
            return self._investment_job(refreshed)

    def validate_investment_report_execution(
        self,
        run_id: str,
        lease_epoch: int,
        execution_id: str | None = None,
    ) -> bool:
        with self.pool.connection() as conn:
            row = conn.execute(
                """
                SELECT status, lease_epoch, execution_id
                FROM investment_report_jobs
                WHERE run_id = %s
                """,
                (run_id,),
            ).fetchone()
        if row is None:
            return False
        if row["status"] != "running" or int(row["lease_epoch"]) != int(lease_epoch):
            raise ValueError("报告任务执行权已失效")
        if execution_id is not None and row["execution_id"] != execution_id:
            raise ValueError("报告任务 execution 冲突")
        return True

    def complete_investment_report_job(
        self,
        report_id: str,
        lease_epoch: int,
        result: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> None:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self.pool.connection() as conn:
            updated = conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'completed', result = %s, error = NULL, lease_expires_at = NULL,
                    updated_at = %s, completed_at = %s
                WHERE report_id = %s AND status = 'running' AND lease_epoch = %s
                """,
                (json.dumps(result, ensure_ascii=False, default=str), timestamp, timestamp, report_id, lease_epoch),
            )
            if updated.rowcount != 1:
                raise ValueError("报告任务 lease 已失效")

    def fail_investment_report_job(
        self,
        report_id: str,
        lease_epoch: int,
        error: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> None:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self.pool.connection() as conn:
            updated = conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'failed', error = %s, lease_expires_at = NULL,
                    updated_at = %s, completed_at = %s
                WHERE report_id = %s AND status = 'running' AND lease_epoch = %s
                """,
                (json.dumps(error, ensure_ascii=False), timestamp, timestamp, report_id, lease_epoch),
            )
            if updated.rowcount != 1:
                raise ValueError("报告任务 lease 已失效")

    @staticmethod
    def _investment_job(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "report_id": row["report_id"],
            "run_id": row["run_id"],
            "input_digest": row["input_digest"],
            "symbol": row["symbol"],
            "timeframe": row["timeframe"],
            "as_of": row["as_of"],
            "status": row["status"],
            "attempt_count": row["attempt_count"],
            "lease_epoch": row["lease_epoch"],
            "frozen_input": json.loads(row["frozen_input"]),
            "result": json.loads(row["result"]) if row["result"] else None,
            "error": json.loads(row["error"]) if row["error"] else None,
            "execution_id": row["execution_id"],
            "lease_expires_at": row.get("lease_expires_at"),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
            "cached": row["status"] == "completed",
            "review_status": row.get("review_status") or "pending",
            "reviewed_at": row.get("reviewed_at"),
            "published_at": row.get("published_at"),
            "share_token": row.get("share_token"),
        }

    @staticmethod
    def _initial_report_artifacts(frozen_input: dict[str, Any], report_id: str) -> dict[str, Any]:
        return {
            "symbol": frozen_input["symbol"],
            "timeframe": frozen_input["timeframe"],
            "as_of": frozen_input["as_of"],
            "report_id": report_id,
            "frozen_market_snapshot": frozen_input["market_snapshot"],
            "frozen_chan_analysis": frozen_input["chan_analysis"],
            "information_snapshot": frozen_input["information_snapshot"],
            "reference_registry": frozen_input["reference_registry"],
        }

    def create_batch(self, symbols: list[str]) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        now, batch_id, run_id, report_id = self._now(), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        report = {
            "id": report_id,
            "status": "queued",
            "symbols": symbols,
            "items": [{"symbol": symbol, "status": "queued", "bars": []} for symbol in symbols],
        }
        run = {"id": run_id, "batch_id": batch_id, "status": "queued", "report_id": report_id, "result": {"symbols": symbols}}
        with self.pool.connection() as conn:
            conn.execute("INSERT INTO batches VALUES (%s, %s, %s, %s, %s)", (batch_id, json.dumps(symbols), "queued", now, run_id))
            conn.execute("INSERT INTO runs VALUES (%s, %s, %s, %s, %s)", (run_id, batch_id, "queued", report_id, json.dumps(run["result"])))
            conn.execute("INSERT INTO reports VALUES (%s, %s, %s)", (report_id, run_id, json.dumps(report)))
            conn.execute(
                "INSERT INTO advisor_states VALUES (%s, %s, %s, %s, %s)",
                (run_id, "QUEUED", 0, 1, json.dumps({"symbols": symbols, "symbol": symbols[0], "report_id": report_id})),
            )
        return {"id": batch_id, "run_id": run_id, "status": "queued"}

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute("SELECT * FROM batches WHERE id = %s", (batch_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["symbols"] = json.loads(result["symbols"])
        return result

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = %s", (run_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["result"] = json.loads(result["result"])
        return result

    def get_report(self, report_id: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute("SELECT payload FROM reports WHERE id = %s", (report_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def add_review(self, report_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        """记录一次审阅决定；对 V2 报告同时推进其审阅状态（发布门）。"""
        self._assert_no_nested_transaction()
        review = {"id": str(uuid.uuid4()), "report_id": report_id, **payload, "created_at": self._now()}
        decision = str(payload.get("decision") or "")
        with self.pool.connection() as conn:
            job = conn.execute(
                "SELECT status, published_at FROM investment_report_jobs WHERE report_id = %s FOR UPDATE",
                (report_id,),
            ).fetchone()
            if job is None and not conn.execute(
                "SELECT 1 FROM reports WHERE id = %s", (report_id,)
            ).fetchone():
                return None
            if job is not None:
                if job["status"] != "completed":
                    raise ValueError("只有已完成的报告可以审阅")
                # 发布是对客交付动作：已发布报告不能再翻转审阅结论，
                # 否则 review_status=rejected 的报告会继续留在已发布列表上。
                if job["published_at"]:
                    raise ValueError("已发布的报告不可再次审阅")
                if decision in ("accepted", "rejected"):
                    conn.execute(
                        "UPDATE investment_report_jobs SET review_status = %s, reviewed_at = %s "
                        "WHERE report_id = %s",
                        (decision, review["created_at"], report_id),
                    )
            conn.execute("INSERT INTO reviews VALUES (%s, %s, %s, %s)", (review["id"], report_id, json.dumps(review), review["created_at"]))
        return review

    def publish_investment_report(
        self,
        report_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """发布已通过审阅的报告；重复发布保持原发布时间。"""
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s FOR UPDATE",
                (report_id,),
            ).fetchone()
            if row is None:
                raise KeyError("报告任务不存在")
            if row["status"] != "completed":
                raise ValueError("只有已完成的报告可以发布")
            if (row.get("review_status") or "pending") != "accepted":
                raise ValueError("报告需通过审阅后才能发布")
            if row.get("published_at"):
                return self._investment_job(row)
            conn.execute(
                "UPDATE investment_report_jobs SET published_at = %s WHERE report_id = %s",
                (timestamp, report_id),
            )
            refreshed = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = %s",
                (report_id,),
            ).fetchone()
            return self._investment_job(refreshed)

    def list_published_reports(self) -> list[dict[str, Any]]:
        with self.pool.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM investment_report_jobs WHERE published_at IS NOT NULL "
                "ORDER BY published_at DESC"
            ).fetchall()
        return [self._investment_job(row) for row in rows]

    def list_investment_report_jobs(
        self,
        *,
        timeframe: str | None = None,
        as_of: str | None = None,
        latest_per_symbol: bool = True,
    ) -> list[dict[str, Any]]:
        clauses = []
        params: list[Any] = []
        if timeframe:
            clauses.append("timeframe = %s")
            params.append(timeframe)
        if as_of:
            clauses.append("as_of = %s")
            params.append(as_of)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        query = (
            f"""
                SELECT DISTINCT ON (symbol) *
                FROM investment_report_jobs
                {where}
                ORDER BY symbol, updated_at DESC
            """
            if latest_per_symbol
            else f"""
                SELECT *
                FROM investment_report_jobs
                {where}
                ORDER BY updated_at DESC
            """
        )
        with self.pool.connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._investment_job(row) for row in rows]

    def create_report_share(self, report_id: str) -> tuple[dict[str, Any], bool]:
        """为已发布报告签发分享 token；重复调用幂等返回同一个 token。"""
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT report_id, status, published_at, share_token "
                "FROM investment_report_jobs WHERE report_id = %s FOR UPDATE",
                (report_id,),
            ).fetchone()
            if row is None:
                raise KeyError("报告任务不存在")
            if row["status"] != "completed" or not row["published_at"]:
                raise ValueError("只有已发布的报告可以分享")
            if row["share_token"]:
                return {"report_id": report_id, "share_token": row["share_token"]}, False
            token = str(uuid.uuid4())
            conn.execute(
                "UPDATE investment_report_jobs SET share_token = %s WHERE report_id = %s",
                (token, report_id),
            )
            return {"report_id": report_id, "share_token": token}, True

    def revoke_report_share(self, report_id: str) -> None:
        """撤销分享：置空 token，报告不存在或未分享时同样静默成功（幂等）。"""
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            conn.execute(
                "UPDATE investment_report_jobs SET share_token = NULL WHERE report_id = %s",
                (report_id,),
            )

    def get_report_by_share_token(self, share_token: str) -> dict[str, Any] | None:
        """按分享 token 取报告任务；只命中仍处于已发布状态的报告。"""
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM investment_report_jobs "
                "WHERE share_token = %s AND published_at IS NOT NULL AND status = 'completed'",
                (share_token,),
            ).fetchone()
        return self._investment_job(row) if row else None

    def save_report_outcome(self, report_id: str, outcome: dict[str, Any]) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            if conn.execute(
                "SELECT 1 FROM investment_report_jobs WHERE report_id = %s", (report_id,)
            ).fetchone() is None:
                raise KeyError("报告任务不存在")
            window = outcome.get("window") if isinstance(outcome.get("window"), dict) else {}
            conn.execute(
                """
                INSERT INTO report_outcomes(
                    report_id, symbol, as_of, status, realized_case, bar_count, window_end,
                    payload, evaluated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(report_id) DO UPDATE SET
                    status = excluded.status,
                    realized_case = excluded.realized_case,
                    bar_count = excluded.bar_count,
                    window_end = excluded.window_end,
                    payload = excluded.payload,
                    evaluated_at = excluded.evaluated_at
                """,
                (
                    report_id,
                    str(outcome.get("symbol") or ""),
                    str(outcome.get("as_of") or ""),
                    str(outcome.get("status") or "pending"),
                    outcome.get("realized_case"),
                    int(window.get("bar_count") or 0),
                    window.get("end"),
                    json.dumps(outcome, ensure_ascii=False, default=str),
                    str(outcome.get("evaluated_at") or self._now()),
                ),
            )
        return outcome

    def get_report_outcome(self, report_id: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT payload FROM report_outcomes WHERE report_id = %s", (report_id,)
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_report_outcomes(self, *, published_only: bool = False) -> list[dict[str, Any]]:
        """兑现结果列表；``published_only`` 只保留已发布报告，用于对客 track record。"""
        query = (
            "SELECT outcomes.payload FROM report_outcomes AS outcomes "
            "JOIN investment_report_jobs AS jobs ON jobs.report_id = outcomes.report_id "
            "WHERE jobs.published_at IS NOT NULL "
            "ORDER BY outcomes.evaluated_at DESC"
            if published_only
            else "SELECT payload FROM report_outcomes ORDER BY evaluated_at DESC"
        )
        with self.pool.connection() as conn:
            rows = conn.execute(query).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def list_reviews(
        self,
        report_id: str | None = None,
        *,
        published_only: bool = False,
    ) -> list[dict[str, Any]]:
        query = "SELECT reviews.payload FROM reviews"
        params: tuple[Any, ...] = ()
        conditions: list[str] = []
        if published_only:
            query += " JOIN investment_report_jobs AS jobs ON jobs.report_id = reviews.report_id"
            conditions.append("jobs.published_at IS NOT NULL")
        if report_id is not None:
            conditions.append("reviews.report_id = %s")
            params = (report_id,)
        if conditions:
            query += f" WHERE {' AND '.join(conditions)}"
        query += " ORDER BY reviews.created_at"
        with self.pool.connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def get_advisor_state(self, run_id: str) -> dict[str, Any] | None:
        with self.pool.connection() as conn:
            row = conn.execute("SELECT * FROM advisor_states WHERE run_id = %s", (run_id,)).fetchone()
        if row is None:
            return None
        return {
            "run_id": row["run_id"],
            "state": row["state"],
            "state_version": row["state_version"],
            "lease_epoch": row["lease_epoch"],
            "artifacts": json.loads(row["artifacts"]),
        }

    def save_advisor_state(self, state: dict[str, Any]) -> None:
        self._assert_no_nested_transaction()
        run_id = str(state["run_id"])
        with self.pool.connection() as conn:
            current = conn.execute(
                "SELECT state, state_version, lease_epoch, artifacts FROM advisor_states WHERE run_id = %s FOR UPDATE",
                (run_id,),
            ).fetchone()
            if current is None:
                raise KeyError("advisor run 不存在")
            investment_job = conn.execute(
                """
                SELECT status, lease_epoch
                FROM investment_report_jobs
                WHERE run_id = %s
                """,
                (run_id,),
            ).fetchone()
            if investment_job is not None and (
                investment_job["status"] != "running"
                or int(state["lease_epoch"]) != int(investment_job["lease_epoch"])
            ):
                raise ValueError("报告任务执行权已失效")
            if int(state["lease_epoch"]) != int(current["lease_epoch"]):
                raise ValueError("lease epoch 冲突")
            version = int(state["state_version"])
            current_version = int(current["state_version"])
            artifacts = state.get("artifacts", {})
            if version == current_version:
                if state["state"] == current["state"] and artifacts == json.loads(current["artifacts"]):
                    return
                raise ValueError("state version 冲突")
            if version != current_version + 1:
                raise ValueError("state version 冲突")
            conn.execute(
                "UPDATE advisor_states SET state = %s, state_version = %s, artifacts = %s WHERE run_id = %s",
                (state["state"], version, json.dumps(artifacts), run_id),
            )

    def update_report_payload(self, report_id: str, payload: dict[str, Any]) -> None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            conn.execute(
                "UPDATE reports SET payload = %s WHERE id = %s",
                (json.dumps(payload, ensure_ascii=False), report_id),
            )

    def update_run_status(self, run_id: str, status: str) -> None:
        self._assert_no_nested_transaction()
        with self.pool.connection() as conn:
            run = conn.execute("SELECT batch_id FROM runs WHERE id = %s", (run_id,)).fetchone()
            if run is None:
                raise KeyError("run 不存在")
            conn.execute("UPDATE runs SET status = %s WHERE id = %s", (status, run_id))
            conn.execute("UPDATE batches SET status = %s WHERE id = %s", (status, run["batch_id"]))
