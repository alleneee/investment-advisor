from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class DatabaseBusyError(RuntimeError):
    code = "DATABASE_BUSY"


class NestedTransactionError(RuntimeError):
    code = "NESTED_TRANSACTION"


class Database:
    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        self._lock = threading.RLock()
        self._transaction_state = threading.local()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.init()

    def init(self) -> None:
        with self.conn:
            self.conn.executescript(
                """
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
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT
                );
                """
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        self._assert_no_nested_transaction()
        with self._lock:
            try:
                self.conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            except sqlite3.OperationalError as exc:
                self._raise_busy_error(exc)
            self._transaction_state.active = True
            try:
                yield self.conn
            except BaseException as exc:
                self.conn.rollback()
                if isinstance(exc, sqlite3.OperationalError):
                    self._raise_busy_error(exc)
                raise
            else:
                try:
                    self.conn.commit()
                except sqlite3.OperationalError as exc:
                    self.conn.rollback()
                    self._raise_busy_error(exc)
            finally:
                self._transaction_state.active = False

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self.conn

    def execute_script(self, script: str) -> None:
        self._assert_no_nested_transaction()
        with self._lock, self.conn:
            self.conn.executescript(script)

    def _assert_no_nested_transaction(self) -> None:
        if getattr(self._transaction_state, "active", False):
            raise NestedTransactionError("事务内不能调用数据库公共写方法")

    @staticmethod
    def _raise_busy_error(error: sqlite3.OperationalError) -> None:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise DatabaseBusyError("SQLite 写事务繁忙") from error
        raise error

    def add_watch(self, symbol: str) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        with self._lock, self.conn:
            if self.conn.execute("SELECT 1 FROM watchlist WHERE symbol = ?", (symbol,)).fetchone():
                return {"symbol": symbol}
            if self.conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0] >= 50:
                raise ValueError("watchlist 最多 50 只股票")
            self.conn.execute("INSERT INTO watchlist VALUES (?, ?)", (symbol, self._now()))
        return {"symbol": symbol}

    def list_watch(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                dict(row)
                for row in self.conn.execute("SELECT symbol, created_at FROM watchlist ORDER BY created_at")
            ]

    def remove_watch(self, symbol: str) -> bool:
        self._assert_no_nested_transaction()
        with self._lock, self.conn:
            result = self.conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol,))
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
        with self._lock:
            row = self.conn.execute(
                """
                SELECT payload FROM market_history_snapshots
                WHERE symbol = ? AND timeframe = ? AND adjustment = ?
                  AND as_of = ? AND start_date = ? AND end_date = ?
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
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO market_history_snapshots
                    (symbol, timeframe, adjustment, as_of, start_date, end_date, payload, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        with self._lock:
            row = self.conn.execute(
                """
                SELECT payload, fetched_at, expires_at
                FROM external_information_cache
                WHERE cache_key = ? AND source = ?
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
        with self._lock, self.conn:
            self.conn.execute(
                """
                INSERT INTO external_information_cache
                    (cache_key, source, payload, fetched_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
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
        with self._lock, self._immediate_transaction():
            row = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE input_digest = ?",
                (input_digest,),
            ).fetchone()
            if row is not None:
                if row["status"] == "failed":
                    lease_epoch = int(row["lease_epoch"]) + 1
                    attempt_count = int(row["attempt_count"]) + 1
                    updated = self.conn.execute(
                        """
                        UPDATE investment_report_jobs
                        SET status = 'queued', attempt_count = ?, lease_epoch = ?, error = NULL,
                            execution_id = NULL, updated_at = ?, started_at = NULL, completed_at = NULL
                        WHERE report_id = ? AND status = 'failed'
                        """,
                        (attempt_count, lease_epoch, timestamp, row["report_id"]),
                    )
                    if updated.rowcount != 1:
                        raise ValueError("报告任务不可重新排队")
                    self.conn.execute(
                        "UPDATE advisor_states SET lease_epoch = ? WHERE run_id = ?",
                        (lease_epoch, row["run_id"]),
                    )
                    refreshed = self.conn.execute(
                        "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                        (row["report_id"],),
                    ).fetchone()
                    return self._investment_job(refreshed), True
                job = self._investment_job(row)
                job["cached"] = row["status"] == "completed"
                return job, False

            report_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
            encoded_input = json.dumps(frozen_input, ensure_ascii=False, default=str)
            self.conn.execute(
                """
                INSERT INTO investment_report_jobs(
                    report_id, run_id, input_digest, symbol, timeframe, as_of, status,
                    attempt_count, lease_epoch, frozen_input, result, error, execution_id,
                    created_at, updated_at, started_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 1, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)
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
            self.conn.execute(
                "INSERT INTO advisor_states VALUES (?, 'QUEUED', 0, 1, ?)",
                (run_id, json.dumps(artifacts, ensure_ascii=False, default=str)),
            )
            row = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                (report_id,),
            ).fetchone()
            return self._investment_job(row), True

    def get_investment_report_job(
        self,
        report_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        self._assert_no_nested_transaction()
        current = now or datetime.now(UTC)
        interrupted_error = {
            "code": "INTERRUPTED",
            "message": "报告生成进程已中断",
            "retryable": True,
        }
        with self._lock, self._immediate_transaction():
            row = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                (report_id,),
            ).fetchone()
            if row is None:
                return None
            updated_at = datetime.fromisoformat(row["updated_at"])
            if row["status"] == "running" and current - updated_at > __import__("datetime").timedelta(seconds=300):
                self.conn.execute(
                    """
                    UPDATE investment_report_jobs
                    SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
                    WHERE report_id = ? AND status = 'running' AND updated_at = ?
                    """,
                    (
                        json.dumps(interrupted_error, ensure_ascii=False),
                        current.isoformat(),
                        current.isoformat(),
                        report_id,
                        row["updated_at"],
                    ),
                )
                row = self.conn.execute(
                    "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                    (report_id,),
                ).fetchone()
            return self._investment_job(row)

    def claim_investment_report_job(
        self,
        report_id: str,
        execution_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self._lock, self.conn:
            result = self.conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'running', execution_id = ?, started_at = ?, updated_at = ?
                WHERE report_id = ? AND status = 'queued'
                """,
                (execution_id, timestamp, timestamp, report_id),
            )
            if result.rowcount != 1:
                raise ValueError("报告任务不可执行")
            row = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                (report_id,),
            ).fetchone()
            return self._investment_job(row)

    def retry_investment_report_job(
        self,
        report_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        self._assert_no_nested_transaction()
        timestamp = (now or datetime.now(UTC)).isoformat()
        with self._lock, self._immediate_transaction():
            row = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                (report_id,),
            ).fetchone()
            if row is None:
                raise KeyError("报告任务不存在")
            error = json.loads(row["error"]) if row["error"] else {}
            if row["status"] != "failed" or error.get("retryable") is not True:
                raise ValueError("报告任务不可重试")
            lease_epoch = int(row["lease_epoch"]) + 1
            attempt_count = int(row["attempt_count"]) + 1
            updated = self.conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'queued', attempt_count = ?, lease_epoch = ?, error = NULL,
                    execution_id = NULL, updated_at = ?, started_at = NULL, completed_at = NULL
                WHERE report_id = ? AND status = 'failed'
                """,
                (attempt_count, lease_epoch, timestamp, report_id),
            )
            if updated.rowcount != 1:
                raise ValueError("报告任务不可重试")
            self.conn.execute(
                "UPDATE advisor_states SET lease_epoch = ? WHERE run_id = ?",
                (lease_epoch, row["run_id"]),
            )
            refreshed = self.conn.execute(
                "SELECT * FROM investment_report_jobs WHERE report_id = ?",
                (report_id,),
            ).fetchone()
            return self._investment_job(refreshed)

    def validate_investment_report_execution(
        self,
        run_id: str,
        lease_epoch: int,
        execution_id: str | None = None,
    ) -> bool:
        with self._lock:
            row = self.conn.execute(
                """
                SELECT status, lease_epoch, execution_id
                FROM investment_report_jobs
                WHERE run_id = ?
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
        with self._lock, self.conn:
            updated = self.conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'completed', result = ?, error = NULL, updated_at = ?, completed_at = ?
                WHERE report_id = ? AND status = 'running' AND lease_epoch = ?
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
        with self._lock, self.conn:
            updated = self.conn.execute(
                """
                UPDATE investment_report_jobs
                SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
                WHERE report_id = ? AND status = 'running' AND lease_epoch = ?
                """,
                (json.dumps(error, ensure_ascii=False), timestamp, timestamp, report_id, lease_epoch),
            )
            if updated.rowcount != 1:
                raise ValueError("报告任务 lease 已失效")

    @staticmethod
    def _investment_job(row: sqlite3.Row) -> dict[str, Any]:
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
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
            "cached": row["status"] == "completed",
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
        with self._lock, self.conn:
            self.conn.execute("INSERT INTO batches VALUES (?, ?, ?, ?, ?)", (batch_id, json.dumps(symbols), "queued", now, run_id))
            self.conn.execute("INSERT INTO runs VALUES (?, ?, ?, ?, ?)", (run_id, batch_id, "queued", report_id, json.dumps(run["result"])))
            self.conn.execute("INSERT INTO reports VALUES (?, ?, ?)", (report_id, run_id, json.dumps(report)))
            self.conn.execute(
                "INSERT INTO advisor_states VALUES (?, ?, ?, ?, ?)",
                (run_id, "QUEUED", 0, 1, json.dumps({"symbols": symbols, "symbol": symbols[0], "report_id": report_id})),
            )
        return {"id": batch_id, "run_id": run_id, "status": "queued"}

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["symbols"] = json.loads(result["symbols"])
        return result

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["result"] = json.loads(result["result"])
        return result

    def get_report(self, report_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT payload FROM reports WHERE id = ?", (report_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def add_review(self, report_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        self._assert_no_nested_transaction()
        review = {"id": str(uuid.uuid4()), "report_id": report_id, **payload, "created_at": self._now()}
        with self._lock, self.conn:
            if not self.conn.execute("SELECT 1 FROM reports WHERE id = ?", (report_id,)).fetchone():
                return None
            self.conn.execute("INSERT INTO reviews VALUES (?, ?, ?, ?)", (review["id"], report_id, json.dumps(review), review["created_at"]))
        return review

    def get_advisor_state(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM advisor_states WHERE run_id = ?", (run_id,)).fetchone()
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
        with self._lock, self._immediate_transaction():
            current = self.conn.execute(
                "SELECT state, state_version, lease_epoch, artifacts FROM advisor_states WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if current is None:
                raise KeyError("advisor run 不存在")
            investment_job = self.conn.execute(
                """
                SELECT status, lease_epoch
                FROM investment_report_jobs
                WHERE run_id = ?
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
            self.conn.execute(
                "UPDATE advisor_states SET state = ?, state_version = ?, artifacts = ? WHERE run_id = ?",
                (state["state"], version, json.dumps(artifacts), run_id),
            )

    @contextmanager
    def _immediate_transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.conn.rollback()
            raise
        else:
            self.conn.commit()

    def update_report_payload(self, report_id: str, payload: dict[str, Any]) -> None:
        self._assert_no_nested_transaction()
        with self._lock, self.conn:
            self.conn.execute(
                "UPDATE reports SET payload = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False), report_id),
            )

    def update_run_status(self, run_id: str, status: str) -> None:
        self._assert_no_nested_transaction()
        with self._lock, self.conn:
            run = self.conn.execute("SELECT batch_id FROM runs WHERE id = ?", (run_id,)).fetchone()
            if run is None:
                raise KeyError("run 不存在")
            self.conn.execute("UPDATE runs SET status = ? WHERE id = ?", (status, run_id))
            self.conn.execute("UPDATE batches SET status = ? WHERE id = ?", (status, run["batch_id"]))
