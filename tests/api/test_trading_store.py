from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from threading import Barrier, Event

import pytest
from app.db import Database, DatabaseBusyError, NestedTransactionError
from app.trading.store import (
    AccountAlreadyExists,
    AccountNotFound,
    IdempotencyConflict,
    RevisionConflict,
    TradingStore,
    TradingStoreError,
)


def _store(path: Path) -> TradingStore:
    return TradingStore(Database(str(path)))


def _account(store: TradingStore) -> dict:
    return store.create_account(
        {
            "name": "主账户",
            "activated_on": "2026-01-01",
            "initial_capital": Decimal(100000),
        }
    )


def _execution(
    account_id: str,
    key: str,
    *,
    price: str | Decimal = "10.00",
    occurred_at: str = "2026-01-10T09:30:00+08:00",
    quantity: int = 100,
    fee: str | Decimal = "0",
) -> dict:
    return {
        "account_id": account_id,
        "client_idempotency_key": key,
        "occurred_at": occurred_at,
        "symbol": "600000.SH",
        "side": "buy",
        "price": price,
        "quantity": quantity,
        "fee": fee,
        "primary_reason": "other",
    }


def _cash_flow(
    account_id: str,
    key: str,
    *,
    amount: str | Decimal = "1000",
    occurred_at: str = "2026-01-10T09:30:00+08:00",
) -> dict:
    return {
        "account_id": account_id,
        "client_idempotency_key": key,
        "occurred_at": occurred_at,
        "kind": "deposit",
        "amount": amount,
    }


def _snapshot(store: TradingStore, account_id: str, period_end: str) -> dict:
    return store.create_review_snapshot(
        {
            "account_id": account_id,
            "period_kind": "month",
            "period_start": "2026-01-01",
            "period_end": period_end,
            "input_digest": f"digest-{period_end}",
        }
    )


def test_same_key_with_different_canonical_execution_digest_conflicts(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    store.create_execution(_execution(account["account_id"], "same-key", price="10.00"))

    with pytest.raises(IdempotencyConflict) as error:
        store.create_execution(_execution(account["account_id"], "same-key", price="10.01"))

    assert error.value.code == "IDEMPOTENCY_CONFLICT"


def test_equivalent_decimal_execution_replays_original_without_new_ledger_revision(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    first = store.create_execution(_execution(account["account_id"], "same-key", price=Decimal("10.0")))
    replay = store.create_execution(_execution(account["account_id"], "same-key", price="10.00"))

    assert replay == first
    assert store.ledger_revision(account["account_id"]) == first["ledger_revision"]
    assert first["price"] == "10"


def test_two_independent_connections_create_one_account_and_map_loser_to_domain_conflict(
    tmp_path: Path,
) -> None:
    path = tmp_path / "ledger.sqlite"
    first, second = _store(path), _store(path)

    barrier = Barrier(2)

    def create(store: TradingStore) -> str:
        barrier.wait()
        try:
            _account(store)
        except AccountAlreadyExists:
            return "conflict"
        return "created"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(create, (first, second)))

    assert sorted(results) == ["conflict", "created"]


def test_store_persists_inputs_that_would_make_reducer_cash_or_position_invalid(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    buy = store.create_execution(
        _execution(account["account_id"], "over-cash", price="100000", quantity=2)
    )
    sell = store.create_execution(
        _execution(account["account_id"], "over-position", price="1", quantity=3)
        | {"side": "sell"}
    )

    assert buy["execution_id"]
    assert sell["execution_id"]
    assert [row["execution_id"] for row in store.list_executions(account["account_id"])] == [
        buy["execution_id"],
        sell["execution_id"],
    ]


@pytest.mark.parametrize("mutation", ["late_execution", "late_cash_flow", "patch", "delete"])
def test_historical_ledger_mutation_marks_affected_and_later_snapshots_outdated(
    tmp_path: Path, mutation: str
) -> None:
    store = _store(tmp_path / f"{mutation}.sqlite")
    account = _account(store)
    account_id = account["account_id"]

    if mutation == "late_execution":
        early = _snapshot(store, account_id, "2026-01-04")
        affected = _snapshot(store, account_id, "2026-01-05")
        later = _snapshot(store, account_id, "2026-01-31")
        store.create_execution(_execution(account_id, "late-execution", occurred_at="2026-01-05T09:30:00+08:00"))
    elif mutation == "late_cash_flow":
        early = _snapshot(store, account_id, "2026-01-04")
        affected = _snapshot(store, account_id, "2026-01-05")
        later = _snapshot(store, account_id, "2026-01-31")
        store.create_cash_flow(_cash_flow(account_id, "late-cash", occurred_at="2026-01-05T09:30:00+08:00"))
    else:
        execution = store.create_execution(_execution(account_id, "current", occurred_at="2026-01-05T09:30:00+08:00"))
        early = _snapshot(store, account_id, "2026-01-04")
        affected = _snapshot(store, account_id, "2026-01-05")
        later = _snapshot(store, account_id, "2026-01-31")
        if mutation == "patch":
            store.update_execution(
                execution["execution_id"],
                _execution(account_id, "current", occurred_at="2026-01-05T09:30:00+08:00"),
                expected_revision=execution["revision"],
            )
        else:
            store.delete_execution(execution["execution_id"], expected_revision=execution["revision"])

    assert store.get_review_snapshot(early["snapshot_id"])["is_outdated"] is False
    assert store.get_review_snapshot(affected["snapshot_id"])["is_outdated"] is True
    assert store.get_review_snapshot(later["snapshot_id"])["is_outdated"] is True


def test_tombstone_delete_advances_revision_and_rejects_stale_if_match(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    execution = store.create_execution(_execution(account["account_id"], "delete-me"))
    deleted = store.delete_execution(execution["execution_id"], expected_revision=execution["revision"])

    assert deleted["is_deleted"] is True
    assert deleted["revision"] == execution["revision"] + 1
    assert store.list_executions(account["account_id"]) == []
    assert store.list_executions(account["account_id"], include_deleted=True)[0]["is_deleted"] is True
    with pytest.raises(RevisionConflict) as error:
        store.delete_execution(execution["execution_id"], expected_revision=execution["revision"])
    assert error.value.code == "REVISION_CONFLICT"


def test_database_transaction_rolls_back_and_immediate_cross_connection_is_domain_safe(
    tmp_path: Path,
) -> None:
    path = tmp_path / "ledger.sqlite"
    first, second = Database(str(path)), Database(str(path))
    with pytest.raises(RuntimeError), first.transaction(immediate=True) as connection:
        connection.execute("CREATE TABLE rollback_probe(value TEXT)")
        connection.execute("INSERT INTO rollback_probe VALUES ('discard')")
        raise RuntimeError("rollback")
    assert first.conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'"
    ).fetchone() is None

    first_store, second_store = TradingStore(first), TradingStore(second)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda store: _create_or_conflict(store), (first_store, second_store)))
    assert sorted(results) == ["conflict", "created"]


def test_transaction_hides_uncommitted_rows_from_other_thread_reads(tmp_path: Path) -> None:
    database = Database(str(tmp_path / "database.sqlite"))
    started = Event()

    def read_watchlist() -> list[dict]:
        started.set()
        return database.list_watch()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(RuntimeError), database.transaction() as connection:
            connection.execute("INSERT INTO watchlist VALUES ('600000.SH', '2026-01-01T00:00:00+00:00')")
            future = executor.submit(read_watchlist)
            assert started.wait(timeout=1)
            assert future.done() is False
            raise RuntimeError("rollback")
        assert future.result(timeout=1) == []


def test_existing_write_inside_transaction_fails_immediately_without_committing_outer_transaction(
    tmp_path: Path,
) -> None:
    database = Database(str(tmp_path / "database.sqlite"))

    with database.transaction() as connection:
        connection.execute("INSERT INTO watchlist VALUES ('600000.SH', '2026-01-01T00:00:00+00:00')")
        with pytest.raises(NestedTransactionError) as error:
            database.add_watch("000001.SZ")

    assert error.value.code == "NESTED_TRANSACTION"
    assert database.list_watch() == [{"symbol": "600000.SH", "created_at": "2026-01-01T00:00:00+00:00"}]


def test_busy_immediate_transaction_and_store_write_raise_domain_error_not_sqlite(
    tmp_path: Path,
) -> None:
    path = tmp_path / "ledger.sqlite"
    first, second = Database(str(path)), Database(str(path))
    second_store = TradingStore(second)
    second.conn.execute("PRAGMA busy_timeout = 1")

    with first.transaction(immediate=True):
        with pytest.raises(DatabaseBusyError) as transaction_error:
            _begin_immediate_transaction(second)
        with pytest.raises(DatabaseBusyError) as store_error:
            _account(second_store)

    assert transaction_error.value.code == "DATABASE_BUSY"
    assert store_error.value.code == "DATABASE_BUSY"


def _begin_immediate_transaction(database: Database) -> None:
    with database.transaction(immediate=True):
        pass


@pytest.mark.parametrize("entry", ["execution", "cash_flow"])
def test_offset_equivalent_occurrence_replays_same_idempotency_request(
    tmp_path: Path, entry: str
) -> None:
    store = _store(tmp_path / f"{entry}.sqlite")
    account = _account(store)
    account_id = account["account_id"]
    if entry == "execution":
        first = store.create_execution(
            _execution(account_id, "offset-key", occurred_at="2026-01-10T09:30:00+08:00")
        )
        replay = store.create_execution(
            _execution(account_id, "offset-key", occurred_at="2026-01-10T01:30:00Z")
        )
    else:
        first = store.create_cash_flow(
            _cash_flow(account_id, "offset-key", occurred_at="2026-01-10T09:30:00+08:00")
        )
        replay = store.create_cash_flow(
            _cash_flow(account_id, "offset-key", occurred_at="2026-01-10T01:30:00Z")
        )

    assert replay == first
    assert first["occurred_at"] == "2026-01-10T09:30:00+08:00"


@pytest.mark.parametrize("entry", ["execution", "cash_flow"])
def test_utc_occurrence_uses_shanghai_next_day_for_snapshot_invalidation(
    tmp_path: Path, entry: str
) -> None:
    store = _store(tmp_path / f"{entry}.sqlite")
    account = _account(store)
    account_id = account["account_id"]
    before = _snapshot(store, account_id, "2026-01-10")
    affected = _snapshot(store, account_id, "2026-01-11")
    if entry == "execution":
        row = store.create_execution(
            _execution(account_id, "next-day", occurred_at="2026-01-10T16:30:00Z")
        )
    else:
        row = store.create_cash_flow(
            _cash_flow(account_id, "next-day", occurred_at="2026-01-10T16:30:00Z")
        )

    assert row["occurred_at"] == "2026-01-11T00:30:00+08:00"
    assert store.get_review_snapshot(before["snapshot_id"])["is_outdated"] is False
    assert store.get_review_snapshot(affected["snapshot_id"])["is_outdated"] is True


@pytest.mark.parametrize("entry", ["execution", "cash_flow"])
def test_naive_occurrence_is_rejected(tmp_path: Path, entry: str) -> None:
    store = _store(tmp_path / f"{entry}.sqlite")
    account = _account(store)
    request = (
        _execution(account["account_id"], "naive", occurred_at="2026-01-10T09:30:00")
        if entry == "execution"
        else _cash_flow(account["account_id"], "naive", occurred_at="2026-01-10T09:30:00")
    )

    with pytest.raises(TradingStoreError, match="时区"):
        if entry == "execution":
            store.create_execution(request)
        else:
            store.create_cash_flow(request)


def test_execution_patch_replaces_idempotency_key_and_new_key_replays(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    original_request = _execution(account["account_id"], "old-key")
    original = store.create_execution(original_request)
    replacement_request = _execution(account["account_id"], "new-key", price="11")

    updated = store.update_execution(
        original["execution_id"], replacement_request, expected_revision=original["revision"]
    )

    assert updated["client_idempotency_key"] == "new-key"
    assert store.create_execution(replacement_request) == updated
    replacement = store.create_execution(original_request)
    assert replacement["execution_id"] != original["execution_id"]


def test_cash_flow_patch_replaces_idempotency_key_and_new_key_replays(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    original_request = _cash_flow(account["account_id"], "old-key")
    original = store.create_cash_flow(original_request)
    replacement_request = _cash_flow(account["account_id"], "new-key", amount="2000")

    updated = store.update_cash_flow(
        original["cash_flow_id"], replacement_request, expected_revision=original["revision"]
    )

    assert updated["client_idempotency_key"] == "new-key"
    assert store.create_cash_flow(replacement_request) == updated
    replacement = store.create_cash_flow(original_request)
    assert replacement["cash_flow_id"] != original["cash_flow_id"]


@pytest.mark.parametrize("entry", ["execution", "cash_flow"])
def test_patch_to_existing_idempotency_key_conflicts_and_rolls_back(tmp_path: Path, entry: str) -> None:
    store = _store(tmp_path / f"{entry}.sqlite")
    account = _account(store)
    account_id = account["account_id"]
    if entry == "execution":
        original_request, duplicate_request = _execution(account_id, "old"), _execution(account_id, "taken")
        original = store.create_execution(original_request)
        store.create_execution(duplicate_request)
        update = store.update_execution
        row_id = original["execution_id"]
    else:
        original_request, duplicate_request = _cash_flow(account_id, "old"), _cash_flow(account_id, "taken")
        original = store.create_cash_flow(original_request)
        store.create_cash_flow(duplicate_request)
        update = store.update_cash_flow
        row_id = original["cash_flow_id"]

    ledger_revision = store.ledger_revision(account_id)
    with pytest.raises(IdempotencyConflict):
        update(row_id, duplicate_request, expected_revision=original["revision"])

    replay = (
        store.create_execution(original_request) if entry == "execution" else store.create_cash_flow(original_request)
    )
    assert replay["revision"] == original["revision"]
    assert replay["client_idempotency_key"] == "old"
    assert store.ledger_revision(account_id) == ledger_revision


@pytest.mark.parametrize("revision", ["daily_review_revision", "market_revision"])
def test_auxiliary_revision_change_outdates_snapshots_and_outdated_snapshot_cannot_revive(
    tmp_path: Path, revision: str
) -> None:
    store = _store(tmp_path / f"{revision}.sqlite")
    account = _account(store)
    snapshot = _snapshot(store, account["account_id"], "2026-01-31")
    advance = (
        store.advance_daily_review_revision
        if revision == "daily_review_revision"
        else store.advance_market_revision
    )

    assert advance(account["account_id"]) == 1
    assert store.get_review_snapshot(snapshot["snapshot_id"])["is_outdated"] is True
    with pytest.raises(RevisionConflict):
        store.set_snapshot_outdated(snapshot["snapshot_id"], False)


def test_store_returns_canonical_sub_cent_amounts_that_can_be_replayed(tmp_path: Path) -> None:
    store = _store(tmp_path / "ledger.sqlite")
    account = _account(store)
    execution_request = _execution(account["account_id"], "fractional-fee", fee="0.005")
    cash_flow_request = _cash_flow(account["account_id"], "fractional-amount", amount="0.005")

    execution = store.create_execution(execution_request)
    cash_flow = store.create_cash_flow(cash_flow_request)

    assert execution["fee"] == "0.005"
    assert cash_flow["amount"] == "0.005"
    execution_replay = store.create_execution(
        _execution(account["account_id"], "fractional-fee", fee=execution["fee"])
    )
    assert execution_replay["execution_id"] == execution["execution_id"]
    assert execution_replay["fee"] == execution["fee"]
    assert store.create_cash_flow(_cash_flow(account["account_id"], "fractional-amount", amount=cash_flow["amount"])) == cash_flow


def test_invalid_account_child_write_is_foreign_key_checked_and_domain_mapped(tmp_path: Path) -> None:
    database = Database(str(tmp_path / "ledger.sqlite"))
    store = TradingStore(database)

    assert database.conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    with pytest.raises(sqlite3.IntegrityError), database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO cash_flows(
                cash_flow_id, account_id, client_idempotency_key, request_digest, occurred_at, kind,
                amount, revision, is_deleted, created_at, updated_at
            ) VALUES ('missing', 'missing-account', 'key', 'digest', '2026-01-01T00:00:00+08:00',
                      'deposit', '1', 1, 0, 'now', 'now')
            """
        )
    with pytest.raises(AccountNotFound) as error:
        store.create_cash_flow(_cash_flow("missing-account", "mapped"))
    assert error.value.code == "ACCOUNT_NOT_FOUND"


@pytest.mark.parametrize("entry", ["execution", "cash_flow"])
def test_list_reads_rows_and_ledger_revision_under_one_read_lock(tmp_path: Path, entry: str) -> None:
    database = _InterleavingReadDatabase(str(tmp_path / f"{entry}.sqlite"))
    store = TradingStore(database)
    account = _account(store)
    account_id = account["account_id"]
    if entry == "execution":
        first = store.create_execution(_execution(account_id, "first"))
        write_second = lambda: store.create_execution(_execution(account_id, "second"))
        list_rows = store.list_executions
        row_id = "execution_id"
    else:
        first = store.create_cash_flow(_cash_flow(account_id, "first"))
        write_second = lambda: store.create_cash_flow(_cash_flow(account_id, "second"))
        list_rows = store.list_cash_flows
        row_id = "cash_flow_id"

    database.interleave_next_read = True
    with ThreadPoolExecutor(max_workers=1) as executor:
        write_future = executor.submit(_write_after_read_release, database, write_second)
        rows = list_rows(account_id)
        write_future.result(timeout=1)

    assert [row[row_id] for row in rows] == [first[row_id]]
    assert {row["ledger_revision"] for row in rows} == {first["ledger_revision"]}


def _write_after_read_release(database: _InterleavingReadDatabase, write) -> None:
    assert database.read_released.wait(timeout=1)
    write()
    database.writer_done.set()


class _InterleavingReadDatabase(Database):
    def __init__(self, path: str) -> None:
        super().__init__(path)
        self.interleave_next_read = False
        self.read_released = Event()
        self.writer_done = Event()

    @contextmanager
    def read(self):
        with super().read() as connection:
            yield connection
        if self.interleave_next_read:
            self.interleave_next_read = False
            self.read_released.set()
            assert self.writer_done.wait(timeout=1)


def _create_or_conflict(store: TradingStore) -> str:
    try:
        _account(store)
    except AccountAlreadyExists:
        return "conflict"
    return "created"
