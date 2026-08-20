from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Lock, get_ident

import pytest
from app.db import Database
from app.information import StockInformationService
from app.providers.a_stock_data import InformationSourceError

NOW = datetime(2026, 8, 13, 9, 0, tzinfo=UTC)


class MutableClock:
    def __init__(self, value: datetime = NOW) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


class FakeInformationProvider:
    def __init__(self) -> None:
        self.calls = {"news": 0, "irm": 0, "hot": 0}
        self.failures: set[str] = set()
        self.news = [
            {
                "id": "eastmoney:002940:1",
                "title": "新闻一",
                "content": "新闻摘要",
                "published_at": "2026-08-13T08:00:00+08:00",
                "source": "eastmoney",
                "media_name": "东财",
                "url": "https://example.com/one",
            }
        ]
        self.messages = [
            {
                "id": "cninfo:002940:1",
                "question": "问题一",
                "answer": "回答一",
                "answerer": "证券部",
                "published_at": "2026-08-12T16:00:00+08:00",
                "source": "cninfo",
            }
        ]
        self.hot = [
            {
                "code": "002940",
                "rank": 8,
                "heat": 9123,
                "rank_chg": 2,
                "concepts": ["机器人"],
                "tag": "热股",
            },
            {"code": "600000", "rank": 20, "heat": 1000, "rank_chg": -1},
        ]

    def eastmoney_news(self, symbol: str, *, page_size: int = 20):
        self.calls["news"] += 1
        assert page_size == 20
        if "news" in self.failures:
            raise InformationSourceError("news failed")
        return list(self.news)

    def cninfo_questions(self, symbol: str, *, page_size: int = 20):
        self.calls["irm"] += 1
        assert page_size == 20
        if "irm" in self.failures:
            raise InformationSourceError("irm failed")
        return list(self.messages)

    def ths_hot_list(self):
        self.calls["hot"] += 1
        if "hot" in self.failures:
            raise InformationSourceError("hot failed")
        return list(self.hot)


class CoordinatedMissStore:
    def __init__(self, database, parties):
        self.database = database
        self.barrier = Barrier(parties)
        self.lock = Lock()
        self.first_read_threads = set()

    def get_external_information_cache(self, cache_key, source, *, now):
        cached = self.database.get_external_information_cache(cache_key, source, now=now)
        if (cache_key, source) != ("002940", "eastmoney_news"):
            return cached
        thread_id = get_ident()
        with self.lock:
            first_read = thread_id not in self.first_read_threads
            if first_read:
                self.first_read_threads.add(thread_id)
        if first_read:
            assert cached is None
            self.barrier.wait(timeout=5)
        return cached

    def save_external_information_cache(
        self,
        cache_key,
        source,
        payload,
        fetched_at,
        expires_at,
    ):
        self.database.save_external_information_cache(
            cache_key,
            source,
            payload,
            fetched_at,
            expires_at,
        )


def make_service(tmp_path, provider=None, clock=None):
    provider = provider or FakeInformationProvider()
    clock = clock or MutableClock()
    database = Database(str(tmp_path / "information.sqlite3"))
    return StockInformationService(provider, database, clock=clock), provider, database, clock


@pytest.mark.parametrize(
    ("source", "key", "ttl"),
    [
        ("eastmoney_news", "002940", timedelta(minutes=30)),
        ("cninfo_irm", "002940", timedelta(hours=6)),
        ("ths_hot_list", "market", timedelta(minutes=5)),
    ],
)
def test_database_cache_uses_exact_ttl_boundary(tmp_path, source, key, ttl):
    database = Database(str(tmp_path / "ttl.sqlite3"))
    database.save_external_information_cache(key, source, [{"value": "中文"}], NOW, NOW + ttl)

    before = database.get_external_information_cache(key, source, now=NOW + ttl - timedelta(microseconds=1))
    boundary = database.get_external_information_cache(key, source, now=NOW + ttl)

    assert before == {
        "payload": [{"value": "中文"}],
        "fetched_at": NOW.isoformat(),
        "expires_at": (NOW + ttl).isoformat(),
        "expired": False,
    }
    assert boundary["expired"] is True


def test_first_fetch_then_ttl_hit_uses_sqlite_after_reconnect(tmp_path):
    service, provider, database, clock = make_service(tmp_path)
    first = service.get_information("002940.SZ", limit=20)
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}
    assert first["quality"]["status"] == "ok"
    assert {item["status"] for item in first["quality"]["sources"].values()} == {"fresh"}

    second = service.get_information("002940.SZ", limit=20)
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}
    assert {item["status"] for item in second["quality"]["sources"].values()} == {"cached"}
    assert second["snapshot_id"] == first["snapshot_id"]

    database.conn.close()
    reconnected = Database(database.path)
    reconnected_service = StockInformationService(provider, reconnected, clock=clock)
    third = reconnected_service.get_information("002940.SZ")
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}
    assert third["news"] == first["news"]


def test_expired_sources_refresh_at_their_own_ttl(tmp_path):
    service, provider, _, clock = make_service(tmp_path)
    service.get_information("002940.SZ")

    clock.value = NOW + timedelta(minutes=5)
    service.get_information("002940.SZ")
    assert provider.calls == {"news": 1, "irm": 1, "hot": 2}

    clock.value = NOW + timedelta(minutes=30)
    service.get_information("002940.SZ")
    assert provider.calls == {"news": 2, "irm": 1, "hot": 3}

    clock.value = NOW + timedelta(hours=6)
    service.get_information("002940.SZ")
    assert provider.calls == {"news": 3, "irm": 2, "hot": 4}


@pytest.mark.parametrize("target_is_hot", [False, True])
def test_ths_refresh_time_does_not_change_fact_snapshot_identity(tmp_path, target_is_hot):
    provider = FakeInformationProvider()
    if not target_is_hot:
        provider.hot = [row for row in provider.hot if row["code"] != "002940"]
    service, _, _, clock = make_service(tmp_path, provider=provider)

    first = service.get_information("002940.SZ")
    clock.value = NOW + timedelta(minutes=5)
    second = service.get_information("002940.SZ")

    assert second["generated_at"] != first["generated_at"]
    assert second["sentiment"]["observed_at"] != first["sentiment"]["observed_at"]
    assert second["quality"]["sources"]["ths_hot_list"]["status"] == "fresh"
    assert second["snapshot_id"] == first["snapshot_id"]


def test_refresh_failure_returns_stale_but_failure_without_cache_is_unavailable(tmp_path):
    service, provider, _, clock = make_service(tmp_path)
    first = service.get_information("002940.SZ")
    provider.failures = {"news", "irm", "hot"}
    clock.value = NOW + timedelta(hours=7)

    stale = service.get_information("002940.SZ")
    assert stale["news"] == first["news"]
    assert stale["messages"] == first["messages"]
    assert stale["quality"]["status"] == "degraded"
    assert {item["status"] for item in stale["quality"]["sources"].values()} == {"stale"}

    fresh_database = Database(str(tmp_path / "empty.sqlite3"))
    unavailable = StockInformationService(provider, fresh_database, clock=clock).get_information("002940.SZ")
    assert unavailable["news"] == []
    assert unavailable["messages"] == []
    assert unavailable["sentiment"] == {
        "hot_rank": None,
        "heat": None,
        "rank_change": None,
        "concepts": [],
        "tag": None,
        "observed_at": None,
    }
    assert unavailable["quality"]["status"] == "unavailable"
    assert {item["status"] for item in unavailable["quality"]["sources"].values()} == {"unavailable"}
    assert fresh_database.get_external_information_cache("002940", "eastmoney_news", now=clock()) is None


def test_valid_empty_results_are_cached(tmp_path):
    provider = FakeInformationProvider()
    provider.news = []
    provider.messages = []
    provider.hot = []
    service, _, _, _ = make_service(tmp_path, provider=provider)

    first = service.get_information("002940.SZ")
    second = service.get_information("002940.SZ")

    assert first["quality"]["status"] == "ok"
    assert first["news"] == second["news"] == []
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}


def test_same_source_and_key_are_single_flight(tmp_path):
    provider = FakeInformationProvider()
    database = Database(str(tmp_path / "single-flight.sqlite3"))
    store = CoordinatedMissStore(database, parties=8)
    service = StockInformationService(provider, store, clock=MutableClock())

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: service.get_information("002940.SZ"), range(8)))

    assert len(store.first_read_threads) == 8
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}
    assert len({item["snapshot_id"] for item in results}) == 1


def test_ths_market_cache_is_shared_across_symbols(tmp_path):
    service, provider, _, _ = make_service(tmp_path)

    for symbol in ("002940.SZ", "600000.SH", "000001.SZ", "300750.SZ"):
        service.get_information(symbol)

    assert provider.calls["hot"] == 1


def test_source_exception_does_not_cache_fake_empty_result(tmp_path):
    service, provider, database, clock = make_service(tmp_path)
    provider.failures.add("news")

    service.get_information("002940.SZ")

    assert database.get_external_information_cache("002940", "eastmoney_news", now=clock()) is None


def test_news_and_messages_are_sorted_and_deduplicated(tmp_path):
    provider = FakeInformationProvider()
    provider.news = [
        {**provider.news[0], "id": "old", "published_at": "2026-08-11T08:00:00+08:00"},
        {**provider.news[0], "id": "duplicate", "title": "另一个标题"},
        {**provider.news[0], "id": "new", "url": None, "title": "无链接", "published_at": "2026-08-14T08:00:00+08:00"},
        {**provider.news[0], "id": "same-title-time", "url": "", "title": "无链接", "published_at": "2026-08-14T08:00:00+08:00"},
    ]
    provider.messages = [
        {**provider.messages[0], "id": "old", "published_at": "2026-08-11T16:00:00+08:00"},
        {**provider.messages[0], "id": "new", "question": "问题二", "published_at": "2026-08-13T16:00:00+08:00"},
        {**provider.messages[0], "id": "duplicate", "published_at": "2026-08-11T16:00:00+08:00"},
    ]
    service, _, _, _ = make_service(tmp_path, provider=provider)

    result = service.get_information("002940.SZ")

    assert [item["id"] for item in result["news"]] == ["new", "duplicate"]
    assert [item["id"] for item in result["messages"]] == ["new", "old"]


def test_cache_keeps_twenty_items_while_limit_only_slices_response(tmp_path):
    provider = FakeInformationProvider()
    provider.news = [
        {**provider.news[0], "id": f"news-{index}", "title": f"新闻 {index}", "url": f"https://example.com/{index}"}
        for index in range(20)
    ]
    provider.messages = [
        {**provider.messages[0], "id": f"irm-{index}", "question": f"问题 {index}"}
        for index in range(20)
    ]
    service, _, database, clock = make_service(tmp_path, provider=provider)

    limited = service.get_information("002940.SZ", limit=5)
    complete = service.get_information("002940.SZ", limit=20)
    cached = database.get_external_information_cache("002940", "eastmoney_news", now=clock())

    assert len(limited["news"]) == len(limited["messages"]) == 5
    assert len(complete["news"]) == len(complete["messages"]) == 20
    assert len(cached["payload"]) == 20
    assert provider.calls == {"news": 1, "irm": 1, "hot": 1}
