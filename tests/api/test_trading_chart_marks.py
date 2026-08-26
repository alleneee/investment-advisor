from __future__ import annotations

from decimal import Decimal

import pytest
from app.db import Database
from app.trading.store import (
    DuplicateMarkType,
    MarkTypeInUse,
    MarkTypePreset,
    RevisionConflict,
    TradingStore,
    TradingStoreError,
)

PRESET_MARK_TYPES = (
    {"code": "ideal_buy", "label": "理想买", "letter": "买", "color": "#f6465d"},
    {"code": "ideal_sell", "label": "理想卖", "letter": "卖", "color": "#4a90e2"},
    {"code": "high", "label": "高点", "letter": "高", "color": "#f5a623"},
    {"code": "low", "label": "低点", "letter": "低", "color": "#7ed321"},
    {"code": "review", "label": "复盘点", "letter": "复", "color": "#9b8cff"},
)


def _store() -> TradingStore:
    return TradingStore(Database())


def _account(store: TradingStore) -> dict:
    return store.create_account(
        {
            "name": "主账户",
            "activated_on": "2026-01-01",
            "initial_capital": Decimal(100000),
        }
    )


def _custom_type(
    account_id: str,
    *,
    label: str = "突破",
    letter: str = "突",
    color: str = "#123456",
) -> dict:
    return {
        "account_id": account_id,
        "label": label,
        "letter": letter,
        "color": color,
    }


def _mark(
    account_id: str,
    type_id: str,
    *,
    symbol: str = "600000.SH",
    occurred_at: str = "2026-01-10T00:00:00+08:00",
    comment: str = "",
) -> dict:
    return {
        "account_id": account_id,
        "symbol": symbol,
        "occurred_at": occurred_at,
        "type_id": type_id,
        "comment": comment,
    }


def test_ensure_preset_mark_types_is_idempotent() -> None:
    store = _store()
    account = _account(store)
    account_id = account["account_id"]

    store.ensure_preset_mark_types(account_id)
    store.ensure_preset_mark_types(account_id)
    types = store.list_chart_mark_types(account_id)

    assert len(types) == 5
    by_code = {row["code"]: row for row in types}
    assert set(by_code) == {item["code"] for item in PRESET_MARK_TYPES}
    for expected in PRESET_MARK_TYPES:
        row = by_code[expected["code"]]
        assert row["label"] == expected["label"]
        assert row["letter"] == expected["letter"]
        assert row["color"] == expected["color"]
        assert row["preset"] is True
        assert row["enabled"] is True
        assert row["account_id"] == account_id
        assert row["type_id"]


def test_create_custom_mark_type_generates_code_and_rejects_invalid_or_duplicate() -> None:
    store = _store()
    account_id = _account(store)["account_id"]
    store.ensure_preset_mark_types(account_id)

    created = store.create_chart_mark_type(_custom_type(account_id))

    assert created["preset"] is False
    assert created["enabled"] is True
    assert created["type_id"]
    assert created["label"] == "突破"
    assert created["letter"] == "突"
    assert created["color"] == "#123456"
    assert created["code"].startswith("custom_")
    assert created["code"][7:].isalnum()
    assert created["code"] == created["code"].lower()
    assert "code" not in _custom_type(account_id)

    with pytest.raises(TradingStoreError):
        store.create_chart_mark_type(_custom_type(account_id, label="空字母", letter=""))
    with pytest.raises(TradingStoreError):
        store.create_chart_mark_type(_custom_type(account_id, label="过长", letter="abc"))

    with pytest.raises(DuplicateMarkType) as duplicate_label:
        store.create_chart_mark_type(_custom_type(account_id, label="突破", letter="另"))
    assert duplicate_label.value.code == "DUPLICATE_TYPE"

    with pytest.raises(DuplicateMarkType) as duplicate_letter:
        store.create_chart_mark_type(_custom_type(account_id, label="其他", letter="突"))
    assert duplicate_letter.value.code == "DUPLICATE_TYPE"


def test_delete_preset_mark_type_rejected() -> None:
    store = _store()
    account_id = _account(store)["account_id"]
    store.ensure_preset_mark_types(account_id)
    preset = next(row for row in store.list_chart_mark_types(account_id) if row["code"] == "review")

    with pytest.raises(MarkTypePreset) as error:
        store.delete_chart_mark_type(preset["type_id"])

    assert error.value.code == "MARK_TYPE_PRESET"
    assert any(row["code"] == "review" for row in store.list_chart_mark_types(account_id))


def test_duplicate_mark_same_symbol_time_type_allowed() -> None:
    store = _store()
    account_id = _account(store)["account_id"]
    store.ensure_preset_mark_types(account_id)
    type_id = next(row["type_id"] for row in store.list_chart_mark_types(account_id) if row["code"] == "high")

    first = store.create_chart_mark(_mark(account_id, type_id, comment="一"))
    second = store.create_chart_mark(_mark(account_id, type_id, comment="二"))

    assert first["mark_id"] != second["mark_id"]
    assert first["symbol"] == second["symbol"] == "600000.SH"
    assert first["occurred_at"] == second["occurred_at"]
    assert first["type_id"] == second["type_id"] == type_id
    marks = store.list_chart_marks(account_id)
    assert {row["mark_id"] for row in marks} == {first["mark_id"], second["mark_id"]}


def test_delete_custom_type_rejected_while_marks_reference_it() -> None:
    store = _store()
    account_id = _account(store)["account_id"]
    custom = store.create_chart_mark_type(_custom_type(account_id))
    mark = store.create_chart_mark(_mark(account_id, custom["type_id"]))

    with pytest.raises(MarkTypeInUse) as error:
        store.delete_chart_mark_type(custom["type_id"])
    assert error.value.code == "MARK_TYPE_IN_USE"

    store.delete_chart_mark(mark["mark_id"], expected_revision=mark["revision"])
    store.delete_chart_mark_type(custom["type_id"])

    assert store.list_chart_marks(account_id) == []
    assert all(row["type_id"] != custom["type_id"] for row in store.list_chart_mark_types(account_id))


def test_update_and_delete_mark_wrong_revision_conflicts() -> None:
    store = _store()
    account_id = _account(store)["account_id"]
    store.ensure_preset_mark_types(account_id)
    type_id = next(row["type_id"] for row in store.list_chart_mark_types(account_id) if row["code"] == "low")
    mark = store.create_chart_mark(_mark(account_id, type_id, comment="原评论"))

    with pytest.raises(RevisionConflict) as update_error:
        store.update_chart_mark(
            mark["mark_id"],
            {"comment": "新评论"},
            expected_revision=mark["revision"] + 1,
        )
    assert update_error.value.code == "REVISION_CONFLICT"

    with pytest.raises(RevisionConflict) as delete_error:
        store.delete_chart_mark(mark["mark_id"], expected_revision=0)
    assert delete_error.value.code == "REVISION_CONFLICT"

    updated = store.update_chart_mark(
        mark["mark_id"],
        {"comment": "新评论"},
        expected_revision=mark["revision"],
    )
    assert updated["comment"] == "新评论"
    assert updated["revision"] == mark["revision"] + 1
    assert store.list_chart_marks(account_id)[0]["comment"] == "新评论"
