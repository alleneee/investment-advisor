from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import uvicorn
from app.db import Database
from app.main import create_app

PROJECT_ROOT = Path(__file__).resolve().parents[2]
NODE_ENTRY = PROJECT_ROOT / "tests" / "integration" / "trading_review_runtime_entry.ts"
SHANGHAI = ZoneInfo("Asia/Shanghai")


class Calendar:
    def __init__(self) -> None:
        self.days = ("2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09")

    def trade_cal(self, *, start_date, end_date):
        return [
            {"cal_date": day.replace("-", ""), "is_open": 1}
            for day in self.days
            if start_date.isoformat() <= day <= end_date.isoformat()
        ]


class Market:
    def daily(self, symbol, *, start_date, end_date, as_of=None):
        closes = {"2026-01-05": "20", "2026-01-06": "20.5", "2026-01-07": "21", "2026-01-08": "22", "2026-01-09": "22"}
        return [
            {
                "ts_code": symbol,
                "trade_date": day.replace("-", ""),
                "open": close,
                "high": str(float(close) + 1),
                "low": str(float(close) - 1),
                "close": close,
                "vol": "1000",
            }
            for day, close in closes.items()
            if start_date.isoformat() <= day <= end_date.isoformat()
        ]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_ready(url: str, process: subprocess.Popen[str] | None = None) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            stdout, stderr = process.communicate(timeout=1)
            raise AssertionError(f"Node sidecar 提前退出：{stdout}\n{stderr}")
        try:
            if httpx.get(url, timeout=0.5).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.05)
    raise AssertionError(f"服务未就绪：{url}")


@contextmanager
def uvicorn_server(app: Any, port: int) -> Iterator[None]:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        wait_ready(f"http://127.0.0.1:{port}/api/watchlist")
        yield
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        assert not thread.is_alive()


@contextmanager
def node_sidecar(port: int, token: str, audit_path: Path) -> Iterator[None]:
    process = subprocess.Popen(
        ["node", "--import", "tsx", str(NODE_ENTRY)],
        cwd=PROJECT_ROOT,
        env={**os.environ, "PORT": str(port), "INTERNAL_AGENT_TOKEN": token, "TRADING_REVIEW_AUDIT_PATH": str(audit_path)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_ready(f"http://127.0.0.1:{port}/health/ready", process)
        yield
    finally:
        if process.poll() is None:
            process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        assert process.returncode in {0, -15}, f"{stdout}\n{stderr}"


def poll_ready(base_url: str, report_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 15
    last = None
    while time.monotonic() < deadline:
        response = httpx.get(f"{base_url}/api/trading/reports/{report_id}", timeout=2)
        assert response.status_code == 200, response.text
        last = response.json()
        if last["snapshot_status"] == "ready" and last["ai_status"] == "ready":
            return last
        if last["snapshot_status"] == "failed" or last["ai_status"] == "failed":
            raise AssertionError(last)
        time.sleep(0.05)
    raise AssertionError(f"交易复盘未完成：{last}")


def test_trading_review_crosses_real_python_and_node_http_boundaries(tmp_path, monkeypatch):
    python_port = free_port()
    node_port = free_port()
    python_url = f"http://127.0.0.1:{python_port}"
    token = "trading-review-integration-token"
    audit_path = tmp_path / "trading-review-audit.jsonl"
    monkeypatch.setenv("AGENT_RUNTIME_URL", f"http://127.0.0.1:{node_port}")
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", token)
    app = create_app(
        database=Database(),
        trading_market_provider=Market(),
        trading_calendar_provider=Calendar(),
        trading_clock=lambda: datetime(2026, 1, 9, 15, 0, tzinfo=SHANGHAI),
    )

    with uvicorn_server(app, python_port), node_sidecar(node_port, token, audit_path):
        account = httpx.post(
            f"{python_url}/api/trading/account",
            json={"name": "主账户", "activated_on": "2026-01-05", "initial_capital": "100000"},
        )
        assert account.status_code == 201, account.text
        executions = [
            {"executed_at": "2026-01-05T10:00:00+08:00", "side": "buy", "price": "20", "primary_reason": "pullback_confirmation", "key": "11111111-1111-4111-8111-111111111111"},
            {"executed_at": "2026-01-08T14:00:00+08:00", "side": "sell", "price": "22", "primary_reason": "take_profit", "key": "22222222-2222-4222-8222-222222222222"},
        ]
        created_executions = []
        for item in executions:
            response = httpx.post(
                f"{python_url}/api/trading/executions",
                json={
                    "symbol": "600000.SH",
                    "name": "浦发银行",
                    "executed_at": item["executed_at"],
                    "side": item["side"],
                    "price": item["price"],
                    "quantity": 1000,
                    "fee": "10",
                    "primary_reason": item["primary_reason"],
                    "tags": ["计划内"],
                    "note": "这段私密备注不能进入模型",
                    "client_idempotency_key": item["key"],
                },
            )
            assert response.status_code == 201, response.text
            created_executions.append(response.json())
        review = httpx.put(
            f"{python_url}/api/trading/daily-reviews/2026-01-09",
            json={"revision": None, "status": "completed", "invalidation_condition": "结构失效", "next_day_plan": "保持纪律", "emotion": "calm", "discipline_followed": True, "note": "收盘复盘私密内容"},
        )
        assert review.status_code == 200, review.text
        created = httpx.post(
            f"{python_url}/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        assert created.status_code == 202, created.text
        report = poll_ready(python_url, created.json()["report_id"])

        account_after = httpx.get(f"{python_url}/api/trading/account").json()
        assert account_after["cash"] == "101980"
        deterministic = report["deterministic_report"]
        assert deterministic["metrics"]["period_realized_pnl"] == "1980"
        assert deterministic["metrics"]["account_adjusted_return_rate"]["value"] == "0.0198"
        chart_executions = deterministic["chart_bundles"][0]["executions"]
        assert [item["execution_id"] for item in chart_executions] == [item["execution_id"] for item in created_executions]
        assert report["ai_review"]["title"] == "周期交易复盘"

        repeated = httpx.post(
            f"{python_url}/api/trading/reports",
            json={"period_kind": "week", "period_start": "2026-01-05", "period_end": "2026-01-09"},
        )
        assert repeated.status_code == 200
        assert repeated.json()["report_id"] == report["report_id"]

    audit = json.loads(audit_path.read_text())
    encoded = json.dumps(audit, ensure_ascii=False)
    assert set(audit["model_input"]) == {"schema_version", "period", "sample", "metrics", "reason_groups", "metric_registry", "cases", "comparison", "quality_warnings"}
    for private_value in ("600000.SH", "浦发银行", "这段私密备注不能进入模型", "收盘复盘私密内容", "client_idempotency_key", "quantity"):
        assert private_value not in encoded
