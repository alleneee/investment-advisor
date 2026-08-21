"""为每个测试创建独立 PostgreSQL schema，替代旧的 SQLite :memory: 隔离。"""

from __future__ import annotations

import os
import uuid
from urllib.parse import quote

import psycopg
import pytest
from app.db import Database

BASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://niko@127.0.0.1:5432/chan_market"
)


@pytest.fixture(autouse=True)
def isolated_database_schema(monkeypatch: pytest.MonkeyPatch):
    schema = f"test_{uuid.uuid4().hex[:16]}"
    with psycopg.connect(BASE_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
    separator = "&" if "?" in BASE_URL else "?"
    url = f"{BASE_URL}{separator}options={quote(f'-csearch_path={schema}')}"
    monkeypatch.setenv("DATABASE_URL", url)

    instances: list[Database] = []
    original_init = Database.__init__

    def tracking_init(self: Database, conninfo: str | None = None) -> None:
        original_init(self, conninfo)
        instances.append(self)

    monkeypatch.setattr(Database, "__init__", tracking_init)
    yield url
    for database in instances:
        database.close()
    with psycopg.connect(BASE_URL, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


@pytest.fixture
def make_isolated_database():
    """构造指向全新独立 schema 的 Database，用于测试内需要空库的场景。"""
    created: list[tuple[str, Database]] = []

    def factory() -> Database:
        schema = f"test_{uuid.uuid4().hex[:16]}"
        with psycopg.connect(BASE_URL, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA "{schema}"')
        separator = "&" if "?" in BASE_URL else "?"
        url = f"{BASE_URL}{separator}options={quote(f'-csearch_path={schema}')}"
        database = Database(url)
        created.append((schema, database))
        return database

    yield factory
    for schema, database in created:
        database.close()
        with psycopg.connect(BASE_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
