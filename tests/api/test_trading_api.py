import asyncio
from threading import Event

import pytest
from app.db import Database
from app.main import create_app
from app.trading.service import TradingService
from app.trading.store import TradingStore
from httpx import ASGITransport, AsyncClient


def _account() -> dict:
    return {"name": "主账户", "activated_on": "2026-01-01", "initial_capital": "100000"}


def _execution(key: str = "11111111-1111-4111-8111-111111111111", **changes) -> dict:
    value = {
        "symbol": "600000.SH",
        "name": "浦发银行",
        "executed_at": "2026-01-10T09:30:00+08:00",
        "side": "buy",
        "price": "10.50",
        "quantity": 100,
        "fee": "5.00",
        "primary_reason": "pullback_confirmation",
        "tags": ["计划内"],
        "note": "首仓",
        "client_idempotency_key": key,
    }
    return value | changes


def _cash_flow(key: str = "22222222-2222-4222-8222-222222222222", **changes) -> dict:
    value = {
        "occurred_at": "2026-01-10T09:30:00+08:00",
        "kind": "deposit",
        "amount": "25",
        "note": "周末入金",
        "client_idempotency_key": key,
    }
    return value | changes


@pytest.mark.anyio
async def test_creates_and_reads_the_single_trading_account() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post(
            "/api/trading/account",
            json={
                **_account(),
            },
        )
        current = await client.get("/api/trading/account")

    assert created.status_code == 201
    assert created.json()["initial_capital"] == "100000.00"
    assert created.json()["cash"] == "100000"
    assert current.json() == created.json()


@pytest.mark.anyio
async def test_rejects_a_second_trading_account() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        duplicate = await client.post("/api/trading/account", json=_account())

    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "ACCOUNT_ALREADY_EXISTS"


@pytest.mark.anyio
async def test_calendar_month_counts_executions_and_reviews_by_trade_date() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first = await client.post("/api/trading/executions", json=_execution())
        second = await client.post(
            "/api/trading/executions",
            json=_execution("33333333-3333-4333-8333-333333333333", executed_at="2026-01-12T10:00:00+08:00"),
        )
        review = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json={
                "status": "draft",
                "invalidation_condition": "跌破日内低点",
                "next_day_plan": "观察",
                "emotion": "calm",
                "discipline_followed": None,
                "note": "首仓",
            },
        )
        calendar = await client.get("/api/trading/calendar", params={"month": "2026-01"})
        invalid = await client.get("/api/trading/calendar", params={"month": "2026-13"})

    assert first.status_code == 201
    assert second.status_code == 201
    assert review.status_code == 200
    assert calendar.status_code == 200
    body = calendar.json()
    assert body["month"] == "2026-01"
    by_date = {item["date"]: item for item in body["days"]}
    assert by_date["2026-01-10"]["execution_count"] == 1
    assert by_date["2026-01-12"]["execution_count"] == 1
    assert by_date["2026-01-11"]["execution_count"] == 0
    assert by_date["2026-01-10"]["review_status"] == "draft"
    assert by_date["2026-01-12"]["review_status"] is None
    assert by_date["2026-01-10"]["is_open"] is False
    assert by_date["2026-01-12"]["is_open"] is True
    assert len(body["days"]) == 31
    assert invalid.status_code == 400


@pytest.mark.anyio
async def test_execution_is_normalized_idempotent_and_rejects_an_inconsistent_key() -> None:
    app = create_app(database=Database())
    payload = _execution()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        created = await client.post("/api/trading/executions", json=payload)
        replay = await client.post(
            "/api/trading/executions", json=payload | {"executed_at": "2026-01-10T01:30:00Z"}
        )
        core_conflict = await client.post("/api/trading/executions", json=payload | {"price": "10.51"})
        conflict = await client.post("/api/trading/executions", json=payload | {"note": "不同说明"})

    assert created.status_code == 201
    assert created.json()["executed_at"] == "2026-01-10T09:30:00+08:00"
    assert replay.status_code == 200
    assert replay.json() == created.json()
    assert core_conflict.status_code == 409
    assert core_conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


@pytest.mark.anyio
async def test_cash_flow_idempotency_compares_the_complete_request() -> None:
    app = create_app(database=Database())
    payload = _cash_flow()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        created = await client.post("/api/trading/cash-flows", json=payload)
        replay = await client.post(
            "/api/trading/cash-flows", json=payload | {"occurred_at": "2026-01-10T01:30:00Z"}
        )
        amount_conflict = await client.post("/api/trading/cash-flows", json=payload | {"amount": "26"})
        note_conflict = await client.post("/api/trading/cash-flows", json=payload | {"note": "不同备注"})

    assert created.status_code == 201
    assert replay.status_code == 200
    assert replay.json() == created.json()
    assert amount_conflict.status_code == 409
    assert amount_conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert note_conflict.status_code == 409
    assert note_conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


@pytest.mark.anyio
async def test_concurrent_same_execution_key_with_different_requests_conflicts() -> None:
    app = create_app(database=Database())
    payload = _execution()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first, second = await asyncio.gather(
            client.post("/api/trading/executions", json=payload),
            client.post("/api/trading/executions", json=payload | {"quantity": 101}),
        )

    assert sorted(response.status_code for response in (first, second)) == [201, 409]
    conflict = next(response for response in (first, second) if response.status_code == 409)
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


@pytest.mark.anyio
async def test_concurrent_equivalent_execution_requests_create_once_and_replay_once() -> None:
    app = create_app(database=Database())
    payload = _execution()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first, second = await asyncio.gather(
            client.post("/api/trading/executions", json=payload),
            client.post(
                "/api/trading/executions",
                json=payload | {"executed_at": "2026-01-10T01:30:00Z", "price": "10.5"},
            ),
        )

    assert sorted(response.status_code for response in (first, second)) == [200, 201]
    assert first.json() == second.json()


@pytest.mark.anyio
async def test_execution_replay_never_observes_a_main_record_without_details(monkeypatch) -> None:
    app = create_app(database=Database())
    payload = _execution()
    entered, replay_ready, release = Event(), Event(), Event()
    original_create = TradingStore.create_execution
    original_response = TradingService._execution_response

    def paused_create(self, *args, **kwargs):
        row = original_create(self, *args, **kwargs)
        if not entered.is_set():
            entered.set()
            assert release.wait(timeout=1)
        return row

    def paused_response(self, *args, **kwargs):
        result = original_response(self, *args, **kwargs)
        if entered.is_set() and not replay_ready.is_set():
            replay_ready.set()
            assert release.wait(timeout=1)
        return result

    monkeypatch.setattr(TradingStore, "create_execution", paused_create)
    monkeypatch.setattr(TradingService, "_execution_response", paused_response)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first_task = asyncio.create_task(client.post("/api/trading/executions", json=payload))
        assert await asyncio.to_thread(entered.wait, 1)
        replay_task = asyncio.create_task(
            client.post("/api/trading/executions", json=payload | {"executed_at": "2026-01-10T01:30:00Z"})
        )
        await asyncio.sleep(0)
        assert await asyncio.to_thread(replay_ready.wait, 1)
        release.set()
        first, replay = await asyncio.gather(first_task, replay_task)

    assert sorted(response.status_code for response in (first, replay)) == [200, 201]
    assert first.json() == replay.json()
    assert replay.json()["name"] == "浦发银行"
    assert replay.json()["tags"] == ["计划内"]
    assert replay.json()["note"] == "首仓"


@pytest.mark.anyio
async def test_cash_flow_replay_never_observes_a_main_record_without_details(monkeypatch) -> None:
    app = create_app(database=Database())
    payload = _cash_flow()
    entered, replay_ready, release = Event(), Event(), Event()
    original_create = TradingStore.create_cash_flow
    original_response = TradingService._cash_flow_response

    def paused_create(self, *args, **kwargs):
        row = original_create(self, *args, **kwargs)
        if not entered.is_set():
            entered.set()
            assert release.wait(timeout=1)
        return row

    def paused_response(self, *args, **kwargs):
        result = original_response(self, *args, **kwargs)
        if entered.is_set() and not replay_ready.is_set():
            replay_ready.set()
            assert release.wait(timeout=1)
        return result

    monkeypatch.setattr(TradingStore, "create_cash_flow", paused_create)
    monkeypatch.setattr(TradingService, "_cash_flow_response", paused_response)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first_task = asyncio.create_task(client.post("/api/trading/cash-flows", json=payload))
        assert await asyncio.to_thread(entered.wait, 1)
        replay_task = asyncio.create_task(
            client.post("/api/trading/cash-flows", json=payload | {"occurred_at": "2026-01-10T01:30:00Z"})
        )
        await asyncio.sleep(0)
        assert await asyncio.to_thread(replay_ready.wait, 1)
        release.set()
        first, replay = await asyncio.gather(first_task, replay_task)

    assert sorted(response.status_code for response in (first, replay)) == [200, 201]
    assert first.json() == replay.json()
    assert replay.json()["note"] == "周末入金"


@pytest.mark.anyio
async def test_legacy_execution_replay_upgrades_digest_and_backfills_details() -> None:
    database = Database()
    app = create_app(database=database)
    store = TradingStore(database)
    payload = _execution()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        account_id = (await client.get("/api/trading/account")).json()["account_id"]
        legacy = store.create_execution(
            {
                "account_id": account_id,
                "client_idempotency_key": payload["client_idempotency_key"],
                "occurred_at": payload["executed_at"],
                "symbol": payload["symbol"],
                "side": payload["side"],
                "price": payload["price"],
                "quantity": payload["quantity"],
                "fee": payload["fee"],
                "primary_reason": payload["primary_reason"],
            }
        )
        replay = await client.post("/api/trading/executions", json=payload)
        repeated = await client.post("/api/trading/executions", json=payload)

    assert replay.status_code == repeated.status_code == 200
    assert replay.json()["execution_id"] == legacy["execution_id"]
    assert replay.json()["name"] == "浦发银行"
    assert replay.json()["tags"] == ["计划内"]
    assert replay.json()["note"] == "首仓"
    assert repeated.json() == replay.json()


@pytest.mark.anyio
async def test_legacy_cash_flow_replay_upgrades_digest_and_backfills_details() -> None:
    database = Database()
    app = create_app(database=database)
    store = TradingStore(database)
    payload = _cash_flow()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        account_id = (await client.get("/api/trading/account")).json()["account_id"]
        legacy = store.create_cash_flow(
            {
                "account_id": account_id,
                "client_idempotency_key": payload["client_idempotency_key"],
                "occurred_at": payload["occurred_at"],
                "kind": payload["kind"],
                "amount": payload["amount"],
            }
        )
        replay = await client.post("/api/trading/cash-flows", json=payload)
        repeated = await client.post("/api/trading/cash-flows", json=payload)

    assert replay.status_code == repeated.status_code == 200
    assert replay.json()["cash_flow_id"] == legacy["cash_flow_id"]
    assert replay.json()["note"] == "周末入金"
    assert repeated.json() == replay.json()


@pytest.mark.anyio
async def test_independent_connections_cannot_concurrently_overspend_cash(tmp_path) -> None:
    str(tmp_path / "trading.sqlite")
    first_app = create_app(database=Database())
    second_app = create_app(database=Database())
    first_payload = _execution(
        "99999999-9999-4999-8999-999999999999", price="60", quantity=1, fee="0"
    )
    second_payload = _execution(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", price="60", quantity=1, fee="0"
    )

    async with (
        AsyncClient(transport=ASGITransport(app=first_app), base_url="http://first") as first_client,
        AsyncClient(transport=ASGITransport(app=second_app), base_url="http://second") as second_client,
    ):
        assert (await first_client.post("/api/trading/account", json=_account() | {"initial_capital": "100"})).status_code == 201
        first, second = await asyncio.gather(
            first_client.post("/api/trading/executions", json=first_payload),
            second_client.post("/api/trading/executions", json=second_payload),
        )
        account = await first_client.get("/api/trading/account")

    assert sorted(response.status_code for response in (first, second)) == [201, 409]
    assert account.json()["cash"] == "40"


@pytest.mark.anyio
async def test_independent_connections_cannot_concurrently_overwithdraw(tmp_path) -> None:
    str(tmp_path / "trading.sqlite")
    first_app = create_app(database=Database())
    second_app = create_app(database=Database())
    first_payload = _cash_flow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind="withdrawal", amount="60")
    second_payload = _cash_flow("cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind="withdrawal", amount="60")

    async with (
        AsyncClient(transport=ASGITransport(app=first_app), base_url="http://first") as first_client,
        AsyncClient(transport=ASGITransport(app=second_app), base_url="http://second") as second_client,
    ):
        assert (await first_client.post("/api/trading/account", json=_account() | {"initial_capital": "100"})).status_code == 201
        first, second = await asyncio.gather(
            first_client.post("/api/trading/cash-flows", json=first_payload),
            second_client.post("/api/trading/cash-flows", json=second_payload),
        )
        account = await first_client.get("/api/trading/account")

    assert sorted(response.status_code for response in (first, second)) == [201, 409]
    assert account.json()["cash"] == "40"


@pytest.mark.anyio
async def test_independent_connections_cannot_concurrently_make_cash_flow_patches_invalid(tmp_path) -> None:
    str(tmp_path / "trading.sqlite")
    first_app = create_app(database=Database())
    second_app = create_app(database=Database())
    first_deposit = _cash_flow("dddddddd-dddd-4ddd-8ddd-dddddddddddd", amount="100")
    second_deposit = _cash_flow("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", amount="100")

    async with (
        AsyncClient(transport=ASGITransport(app=first_app), base_url="http://first") as first_client,
        AsyncClient(transport=ASGITransport(app=second_app), base_url="http://second") as second_client,
    ):
        assert (await first_client.post("/api/trading/account", json=_account() | {"initial_capital": "1"})).status_code == 201
        first_created = await first_client.post("/api/trading/cash-flows", json=first_deposit)
        second_created = await first_client.post("/api/trading/cash-flows", json=second_deposit)
        assert (await first_client.post("/api/trading/executions", json=_execution(
            "ffffffff-ffff-4fff-8fff-ffffffffffff", price="80", quantity=1, fee="0"
        ))).status_code == 201
        first, second = await asyncio.gather(
            first_client.patch(
                f"/api/trading/cash-flows/{first_created.json()['cash_flow_id']}",
                json=first_deposit | {"amount": "10", "revision": first_created.json()["revision"]},
            ),
            second_client.patch(
                f"/api/trading/cash-flows/{second_created.json()['cash_flow_id']}",
                json=second_deposit | {"amount": "10", "revision": second_created.json()["revision"]},
            ),
        )
        account = await first_client.get("/api/trading/account")

    assert sorted(response.status_code for response in (first, second)) == [200, 409]
    assert account.json()["cash"] == "31"


@pytest.mark.anyio
async def test_independent_connections_cannot_concurrently_delete_cash_flow_support(tmp_path) -> None:
    str(tmp_path / "trading.sqlite")
    first_app = create_app(database=Database())
    second_app = create_app(database=Database())
    first_deposit = _cash_flow("12121212-1212-4121-8121-121212121212", amount="100")
    second_deposit = _cash_flow("13131313-1313-4131-8131-131313131313", amount="100")

    async with (
        AsyncClient(transport=ASGITransport(app=first_app), base_url="http://first") as first_client,
        AsyncClient(transport=ASGITransport(app=second_app), base_url="http://second") as second_client,
    ):
        assert (await first_client.post("/api/trading/account", json=_account() | {"initial_capital": "1"})).status_code == 201
        first_created = await first_client.post("/api/trading/cash-flows", json=first_deposit)
        second_created = await first_client.post("/api/trading/cash-flows", json=second_deposit)
        assert (await first_client.post("/api/trading/executions", json=_execution(
            "14141414-1414-4141-8141-141414141414", price="80", quantity=1, fee="0"
        ))).status_code == 201
        first, second = await asyncio.gather(
            first_client.delete(
                f"/api/trading/cash-flows/{first_created.json()['cash_flow_id']}",
                headers={"If-Match": str(first_created.json()["revision"])},
            ),
            second_client.delete(
                f"/api/trading/cash-flows/{second_created.json()['cash_flow_id']}",
                headers={"If-Match": str(second_created.json()["revision"])},
            ),
        )
        account = await first_client.get("/api/trading/account")

    assert sorted(response.status_code for response in (first, second)) == [204, 409]
    assert account.json()["cash"] == "21"


@pytest.mark.anyio
async def test_execution_patch_preserves_original_created_order_for_the_same_instant() -> None:
    app = create_app(database=Database())
    buy = _execution(
        "15151515-1515-4151-8151-151515151515", price="100", quantity=1, fee="0"
    )
    sell = _execution(
        "16161616-1616-4161-8161-161616161616",
        side="sell",
        price="100",
        quantity=1,
        fee="0",
        primary_reason="stop_loss",
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account() | {"initial_capital": "100"})).status_code == 201
        created_buy = await client.post("/api/trading/executions", json=buy)
        assert (await client.post("/api/trading/executions", json=sell)).status_code == 201
        patched = await client.patch(
            f"/api/trading/executions/{created_buy.json()['execution_id']}",
            json=buy | {"note": "修订说明", "revision": created_buy.json()["revision"]},
        )

    assert patched.status_code == 200
    assert patched.json()["note"] == "修订说明"


@pytest.mark.anyio
async def test_cash_flow_patch_preserves_original_created_order_for_the_same_instant() -> None:
    app = create_app(database=Database())
    deposit = _cash_flow("17171717-1717-4171-8171-171717171717", amount="100")
    withdrawal = _cash_flow(
        "18181818-1818-4181-8181-181818181818", kind="withdrawal", amount="100", note="出金"
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account() | {"initial_capital": "1"})).status_code == 201
        created_deposit = await client.post("/api/trading/cash-flows", json=deposit)
        assert (await client.post("/api/trading/cash-flows", json=withdrawal)).status_code == 201
        patched = await client.patch(
            f"/api/trading/cash-flows/{created_deposit.json()['cash_flow_id']}",
            json=deposit | {"note": "修订说明", "revision": created_deposit.json()["revision"]},
        )

    assert patched.status_code == 200
    assert patched.json()["note"] == "修订说明"


@pytest.mark.anyio
@pytest.mark.parametrize("value", [10, "1e2", "NaN", "Infinity", "-1", "01"])
async def test_trading_decimal_requests_require_positive_canonical_text(value) -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/trading/account", json=_account() | {"initial_capital": value})

    assert response.status_code == 400
    assert response.json() == {
        "status": "failed",
        "error": {"code": "INVALID_REQUEST", "message": "请求参数无效"},
        "retryable": False,
    }


@pytest.mark.anyio
async def test_trading_validation_is_exact_and_does_not_change_market_validation() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        extra = await client.post("/api/trading/account", json=_account() | {"unexpected": True})
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        invalid_reason = await client.post(
            "/api/trading/executions",
            json=_execution(primary_reason="stop_loss"),
        )
        market = await client.post(
            "/api/market/600000.SH/reports",
            json={"timeframe": "1d", "unexpected": True},
        )

    assert extra.status_code == 400
    assert invalid_reason.status_code == 400
    assert market.status_code == 422


@pytest.mark.anyio
async def test_cash_flow_range_patch_delete_and_cash_balance_validation() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account() | {"initial_capital": "100"})).status_code == 201
        deposit = await client.post("/api/trading/cash-flows", json=_cash_flow())
        listed = await client.get("/api/trading/cash-flows?start=2026-01-10&end=2026-01-10")
        updated = await client.patch(
            f"/api/trading/cash-flows/{deposit.json()['cash_flow_id']}",
            json=_cash_flow(amount="30", revision=deposit.json()["revision"]),
        )
        stale = await client.patch(
            f"/api/trading/cash-flows/{deposit.json()['cash_flow_id']}",
            json=_cash_flow(amount="31", revision=deposit.json()["revision"]),
        )
        full_withdrawal = await client.post(
            "/api/trading/cash-flows",
            json=_cash_flow(
                "33333333-3333-4333-8333-333333333333",
                kind="withdrawal",
                amount="130",
                note="全额出金",
            ),
        )
        excess = await client.post(
            "/api/trading/cash-flows",
            json=_cash_flow(
                "44444444-4444-4444-8444-444444444444",
                kind="withdrawal",
                amount="1",
                note="超额出金",
            ),
        )
        removable = await client.post(
            "/api/trading/cash-flows",
            json=_cash_flow(
                "55555555-5555-4555-8555-555555555555",
                amount="10",
                note="可删除入金",
            ),
        )
        deleted = await client.delete(
            f"/api/trading/cash-flows/{removable.json()['cash_flow_id']}",
            headers={"If-Match": str(removable.json()["revision"])},
        )

    assert deposit.status_code == 201
    assert listed.json()[0]["note"] == "周末入金"
    assert updated.status_code == 200
    assert stale.json()["error"]["code"] == "REVISION_CONFLICT"
    assert full_withdrawal.status_code == 201
    assert excess.status_code == 409
    assert excess.json()["error"]["code"] == "INSUFFICIENT_CASH"
    assert deleted.status_code == 204


@pytest.mark.anyio
async def test_execution_range_patch_delete_and_position_validation() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        created = await client.post("/api/trading/executions", json=_execution())
        listed = await client.get("/api/trading/executions?date=2026-01-10&symbol=600000.SH")
        updated = await client.patch(
            f"/api/trading/executions/{created.json()['execution_id']}",
            json=_execution(price="11", revision=created.json()["revision"]),
        )
        stale = await client.patch(
            f"/api/trading/executions/{created.json()['execution_id']}",
            json=_execution(price="12", revision=created.json()["revision"]),
        )
        oversold = await client.post(
            "/api/trading/executions",
            json=_execution(
                "66666666-6666-4666-8666-666666666666",
                side="sell",
                quantity=101,
                primary_reason="stop_loss",
            ),
        )
        deleted = await client.delete(
            f"/api/trading/executions/{created.json()['execution_id']}",
            headers={"If-Match": str(updated.json()["revision"])},
        )

    assert listed.json()[0]["execution_id"] == created.json()["execution_id"]
    assert updated.status_code == 200
    assert stale.json()["error"]["code"] == "REVISION_CONFLICT"
    assert oversold.status_code == 409
    assert oversold.json()["error"]["code"] == "INSUFFICIENT_POSITION"
    assert deleted.status_code == 204


@pytest.mark.anyio
async def test_execution_range_uses_shanghai_trade_date_and_normalized_sorting() -> None:
    app = create_app(database=Database())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        first = await client.post(
            "/api/trading/executions",
            json=_execution(
                "77777777-7777-4777-8777-777777777777",
                executed_at="2026-01-10T16:30:00Z",
            ),
        )
        second = await client.post(
            "/api/trading/executions",
            json=_execution(
                "88888888-8888-4888-8888-888888888888",
                executed_at="2026-01-11T01:00:00+08:00",
            ),
        )
        listed = await client.get("/api/trading/executions?date=2026-01-11")

    assert first.status_code == second.status_code == 201
    assert first.json()["executed_at"] == "2026-01-11T00:30:00+08:00"
    assert [row["execution_id"] for row in listed.json()] == [
        first.json()["execution_id"],
        second.json()["execution_id"],
    ]


@pytest.mark.anyio
async def test_daily_review_draft_completion_revision_and_targeted_snapshot_invalidation() -> None:
    database = Database()
    app = create_app(database=database)
    store = TradingStore(database)
    draft_payload = {
        "revision": None,
        "status": "draft",
        "invalidation_condition": "跌破前低",
        "next_day_plan": "观察成交量",
        "emotion": "calm",
        "discipline_followed": None,
        "note": "草稿",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/api/trading/account", json=_account())).status_code == 201
        account_id = (await client.get("/api/trading/account")).json()["account_id"]
        before = store.create_review_snapshot(
            {"account_id": account_id, "period_kind": "week", "period_start": "2026-01-01", "period_end": "2026-01-09", "input_digest": "before"}
        )
        contained = store.create_review_snapshot(
            {"account_id": account_id, "period_kind": "week", "period_start": "2026-01-10", "period_end": "2026-01-10", "input_digest": "contained"}
        )
        after = store.create_review_snapshot(
            {"account_id": account_id, "period_kind": "week", "period_start": "2026-01-11", "period_end": "2026-01-17", "input_digest": "after"}
        )
        absent = await client.get("/api/trading/daily-reviews/2026-01-10")
        draft = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json=draft_payload,
        )
        invalid_completed = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json=draft_payload | {"revision": draft.json()["revision"], "status": "completed"},
        )
        non_boolean_completed = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json=draft_payload | {
                "revision": draft.json()["revision"],
                "status": "completed",
                "discipline_followed": "true",
            },
        )
        completed = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json=draft_payload | {"revision": draft.json()["revision"], "status": "completed", "discipline_followed": True},
        )
        stale = await client.put(
            "/api/trading/daily-reviews/2026-01-10",
            json=draft_payload | {"revision": draft.json()["revision"]},
        )
        restored = await client.get("/api/trading/daily-reviews/2026-01-10")

    assert absent.status_code == 404
    assert draft.status_code == 200
    assert invalid_completed.status_code == 400
    assert non_boolean_completed.status_code == 400
    assert completed.json()["revision"] == 2
    assert completed.json()["daily_review_revision"] == 2
    assert stale.json()["error"]["code"] == "REVISION_CONFLICT"
    assert restored.json() == completed.json()
    assert store.get_review_snapshot(before["snapshot_id"])["is_outdated"] is False
    assert store.get_review_snapshot(contained["snapshot_id"])["is_outdated"] is True
    assert store.get_review_snapshot(after["snapshot_id"])["is_outdated"] is False
