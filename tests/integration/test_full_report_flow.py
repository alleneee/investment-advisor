from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from app.db import Database
from app.main import create_app

PROJECT_ROOT = Path(__file__).resolve().parents[2]
NODE_ENTRY = PROJECT_ROOT / "tests" / "integration" / "agent_runtime_entry.ts"
TOOL_ORDER = [
    "fetch_market_snapshot",
    "run_chan_analysis",
    "collect_information_evidence",
    "emit_research_report",
]


class StableMarketService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def analyze(self, symbol: str, *, as_of: Any, timeframe: str) -> dict[str, Any]:
        self.calls.append((symbol, as_of.isoformat(), timeframe))
        bars = [
            {
                "symbol": symbol,
                "occurred_at": "2026-08-07T00:00:00+00:00",
                "known_at": "2026-08-07T00:00:00+00:00",
                "stable_through": "2026-08-07T00:00:00+00:00",
                "open": "20.10",
                "high": "21.00",
                "low": "19.80",
                "close": "20.60",
                "volume": "1200",
                "payload_hash": None,
            },
            {
                "symbol": symbol,
                "occurred_at": "2026-08-13T00:00:00+00:00",
                "known_at": "2026-08-13T00:00:00+00:00",
                "stable_through": "2026-08-13T00:00:00+00:00",
                "open": "20.60",
                "high": "21.40",
                "low": "20.20",
                "close": "21.10",
                "volume": "1600",
                "payload_hash": None,
            },
        ]
        market = {
            "snapshot_id": "market-weekly-stable",
            "source": "test-market",
            "adjustment": "qfq",
            "timeframe": timeframe,
            "window": {"start": "20260803", "end": "20260813", "bar_count": len(bars)},
            "bars": bars,
            "facts": [
                {"id": "bar_count", "label": "K 线数量", "value": len(bars), "unit": "bars"},
                {"id": "latest_trade_date", "label": "最新交易日", "value": "20260813"},
                {"id": "latest_qfq_close", "label": "最新前复权收盘", "value": 21.1},
            ],
            "quality": {"status": "ok", "warnings": []},
        }
        chan = {
            "analysis_id": "chan-weekly-stable",
            "engine_version": "chan-engine.v1",
            "timeframe": timeframe,
            "snapshot": {
                "bars": bars,
                "fractals": [],
                "strokes": [],
                "confirmed": [],
                "provisional": [],
                "centers": [
                    {
                        "start_index": 0,
                        "end_index": 1,
                        "lower": "20.20",
                        "upper": "21.00",
                        "occurred_at": "2026-08-13T00:00:00+00:00",
                    }
                ],
                "occurred_at": "2026-08-13T00:00:00+00:00",
                "known_at": "2026-08-13T00:00:00+00:00",
                "stable_through": "2026-08-13T00:00:00+00:00",
                "gaps": [],
            },
        }
        return {"market_snapshot": market, "chan_analysis": chan}


class StableInformationService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def get_information(self, symbol: str, *, limit: int = 20) -> dict[str, Any]:
        self.calls.append((symbol, limit))
        return {
            "symbol": symbol,
            "snapshot_id": "information-stable",
            "generated_at": "2026-08-13T09:00:00+08:00",
            "news": [
                {
                    "id": "news-stable",
                    "title": "公司披露经营进展",
                    "summary": "经营节奏保持稳定",
                    "published_at": "2026-08-13T08:00:00+08:00",
                    "source": "东财",
                    "url": "https://example.com/news/stable",
                }
            ],
            "messages": [
                {
                    "id": "irm-stable",
                    "question": "产能进展如何",
                    "answer": "相关项目按计划推进",
                    "answerer": "证券部",
                    "published_at": "2026-08-12T16:00:00+08:00",
                    "source": "cninfo",
                }
            ],
            "sentiment": {
                "hot_rank": 8,
                "heat": 9123,
                "rank_change": 2,
                "concepts": ["医药"],
                "tag": "热股",
                "observed_at": "2026-08-13T09:00:00+08:00",
            },
            "quality": {"status": "ok", "warnings": [], "sources": {}},
        }


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_ready(url: str, process: subprocess.Popen[str] | None = None) -> None:
    deadline = time.monotonic() + 15
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            stdout, stderr = process.communicate(timeout=1)
            raise AssertionError(
                f"Node sidecar 提前退出：{process.returncode}\nstdout:\n{stdout}\nstderr:\n{stderr}"
            )
        try:
            response = httpx.get(url, timeout=0.5)
            if response.status_code == 200:
                return
        except httpx.HTTPError as exc:
            last_error = exc
        time.sleep(0.05)
    raise AssertionError(f"服务未就绪：{url}；最后错误：{last_error}")


@contextmanager
def _uvicorn_server(app: Any, port: int) -> Iterator[None]:
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    failure: BaseException | None = None
    try:
        _wait_ready(f"http://127.0.0.1:{port}/api/watchlist")
        yield
    except BaseException as exc:
        failure = exc
        raise
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        if thread.is_alive():
            if failure is not None:
                failure.add_note("Uvicorn 线程未正常退出")
            else:
                raise AssertionError("Uvicorn 线程未正常退出")


@contextmanager
def _node_sidecar(port: int, python_url: str, token: str, audit_path: Path) -> Iterator[None]:
    environment = {
        **os.environ,
        "PORT": str(port),
        "PYTHON_API_BASE_URL": python_url,
        "INTERNAL_AGENT_TOKEN": token,
        "TOOL_AUDIT_PATH": str(audit_path),
    }
    process = subprocess.Popen(
        ["node", "--import", "tsx", str(NODE_ENTRY)],
        cwd=PROJECT_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    failure: BaseException | None = None
    try:
        _wait_ready(f"http://127.0.0.1:{port}/health/ready", process)
        yield
    except BaseException as exc:
        failure = exc
        raise
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
        output = f"Node sidecar 退出码：{process.returncode}\nstdout:\n{stdout}\nstderr:\n{stderr}"
        if failure is not None:
            failure.add_note(output)
        elif process.returncode not in {0, -15}:
            raise AssertionError(output)


def _poll_completed(base_url: str, report_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 15
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        response = httpx.get(f"{base_url}/api/reports/{report_id}", timeout=1)
        assert response.status_code == 200, response.text
        last = response.json()
        if last["status"] == "completed":
            return last
        if last["status"] == "failed":
            raise AssertionError(f"报告生成失败：{last['error']}")
        time.sleep(0.05)
    raise AssertionError(f"报告未在超时前完成：{last}")


def _read_audit(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [json.loads(line)["tool"] for line in path.read_text().splitlines() if line]


def _covers_required_sources(refs: list[str]) -> bool:
    return (
        any(ref.startswith("market.") for ref in refs)
        and any(ref.startswith("chan.") for ref in refs)
        and any(ref.startswith(("news.", "irm.", "hot.", "information.quality")) for ref in refs)
    )


def test_full_report_crosses_real_python_and_node_http_boundaries(tmp_path, monkeypatch):
    python_port = _free_port()
    node_port = _free_port()
    python_url = f"http://127.0.0.1:{python_port}"
    token = "integration-internal-token"
    audit_path = tmp_path / "tool-audit.jsonl"
    database = Database(str(tmp_path / "report.sqlite"))
    market = StableMarketService()
    information = StableInformationService()
    fixed_now = datetime(2026, 8, 13, 10, 30, tzinfo=UTC)

    monkeypatch.setenv("AGENT_RUNTIME_URL", f"http://127.0.0.1:{node_port}")
    monkeypatch.setenv("INTERNAL_AGENT_TOKEN", token)
    monkeypatch.setenv("PI_PROVIDER", "new-api")
    monkeypatch.setenv("PI_MODEL", "glm-5.2")
    app = create_app(
        database=database,
        market_service=market,
        information_service=information,
        report_clock=lambda: fixed_now,
    )

    with (
        _uvicorn_server(app, python_port),
        _node_sidecar(node_port, python_url, token, audit_path),
    ):
        created = httpx.post(
            f"{python_url}/api/market/002940.SZ/reports",
            json={"timeframe": "1w"},
            timeout=2,
        )
        assert created.status_code == 202, created.text
        assert created.json()["status"] == "queued"
        assert created.json()["cached"] is False
        report_id = created.json()["report_id"]

        completed = _poll_completed(python_url, report_id)
        report = completed["report"]
        assert _read_audit(audit_path) == TOOL_ORDER
        assert completed["timeframe"] == "1w"
        assert completed["as_of"] == "2026-08-13"
        assert report["timeframe"] == "1w"
        assert report["as_of"] == "2026-08-13"
        assert report["market_snapshot"]["timeframe"] == "1w"
        assert all(
            bar["occurred_at"][:10] <= report["as_of"] for bar in report["market_snapshot"]["bars"]
        )
        assert report["chan_analysis"]["timeframe"] == "1w"
        assert report["information_snapshot"]["snapshot_id"] == "information-stable"
        assert len(report["outlook"]["scenarios"]) == 3
        assert {scenario["case"] for scenario in report["outlook"]["scenarios"]} == {
            "bullish",
            "base",
            "bearish",
        }
        assert report["draft"]["version"] == "ReportDraftV2"
        assert report["reference_registry"]
        assert _covers_required_sources(report["evidence_refs"])
        scenario_and_risk_refs = [
            ref
            for item in [*report["outlook"]["scenarios"], *report["risks"]]
            for ref in item["evidence_refs"]
        ]
        assert _covers_required_sources(scenario_and_risk_refs)

        job = database.get_investment_report_job(report_id)
        assert job is not None
        assert job["result"]["draft"]["version"] == "ReportDraftV2"
        assert len(job["result"]["outlook"]["scenarios"]) == 3
        assert _covers_required_sources(job["result"]["evidence_refs"])
        state = database.get_advisor_state(job["run_id"])
        assert state is not None
        assert state["state"] == "COMPLETED"
        assert state["state_version"] == 4
        assert state["artifacts"]["market"]["as_of"] == "2026-08-13"
        assert state["artifacts"]["chan"]["analysis_id"] == "chan-weekly-stable"
        assert state["artifacts"]["evidence"]["information"]["claims"]
        assert state["artifacts"]["report"]["version"] == "ReportDraftV2"
        assert state["artifacts"]["frozen_market_snapshot"]["timeframe"] == "1w"
        assert state["artifacts"]["frozen_chan_analysis"]["timeframe"] == "1w"
        assert state["artifacts"]["information_snapshot"]["snapshot_id"] == ("information-stable")

        repeated = httpx.post(
            f"{python_url}/api/market/002940.SZ/reports",
            json={"timeframe": "1w"},
            timeout=2,
        )
        assert repeated.status_code == 200, repeated.text
        assert repeated.json() == {
            "report_id": report_id,
            "status": "completed",
            "cached": True,
        }
        time.sleep(0.2)
        assert _read_audit(audit_path) == TOOL_ORDER

    assert market.calls == [
        ("002940.SZ", "2026-08-13", "1w"),
        ("002940.SZ", "2026-08-13", "1w"),
    ]
    assert information.calls == [("002940.SZ", 20), ("002940.SZ", 20)]
