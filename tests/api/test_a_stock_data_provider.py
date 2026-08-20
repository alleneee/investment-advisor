import json

import httpx
import pytest
from app.providers.a_stock_data import (
    AStockDataProvider,
    EastmoneyRateLimiter,
    InformationSourceError,
    normalize_symbol_code,
)


def test_normalize_symbol_code_accepts_canonical_a_share_codes():
    assert normalize_symbol_code("600000") == "600000"
    assert normalize_symbol_code("600000.SH") == "600000"
    assert normalize_symbol_code("000001.SZ") == "000001"
    assert normalize_symbol_code("300750.SZ") == "300750"


@pytest.mark.parametrize("code", ["600000.SZ", "000001.SH", "00700.HK", "60000"])
def test_normalize_symbol_code_rejects_noncanonical_or_wrong_market_codes(code):
    with pytest.raises(ValueError):
        normalize_symbol_code(code)


def test_eastmoney_news_uses_required_jsonp_contract_and_normalizes_rows():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            text=(
                'jQuery_news({"result":{"cmsArticleWebOld":[{'
                '"title":"<em>平安银行</em>公告",'
                '"content":"<p>业绩<strong>增长</strong></p>",'
                '"date":"2024-08-01 12:30:00",'
                '"mediaName":"测试媒体",'
                '"url":"https://example.test/news/1"}]}});'
            ),
        )

    provider = AStockDataProvider(client=httpx.Client(transport=httpx.MockTransport(handler)))

    rows = provider.eastmoney_news("000001.SZ")

    assert len(calls) == 1
    request = calls[0]
    assert str(request.url).split("?")[0] == "https://search-api-web.eastmoney.com/search/jsonp"
    params = dict(request.url.params)
    assert params["cb"] == "jQuery_news"
    assert params["keyword"] == "000001"
    assert params["type"] == "[cmsArticleWebOld]"
    assert json.loads(params["param"]) == {
        "cmsArticleWebOld": {"pageIndex": 1, "pageSize": 20},
        "keyword": "000001",
        "type": ["cmsArticleWebOld"],
    }
    assert request.headers["referer"] == "https://so.eastmoney.com/"
    assert request.headers["user-agent"].startswith("Mozilla/5.0")
    assert rows == [
        {
            "id": "eastmoney:000001:2024-08-01T12:30:00+08:00:cf636e66b5f1",
            "source": "eastmoney",
            "code": "000001",
            "title": "平安银行公告",
            "content": "业绩增长",
            "published_at": "2024-08-01T12:30:00+08:00",
            "media_name": "测试媒体",
            "url": "https://example.test/news/1",
        }
    ]


def test_eastmoney_news_preserves_an_explicit_source_offset():
    provider = AStockDataProvider(
        client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    text=(
                        'jQuery_news({"result":{"cmsArticleWebOld":[{'
                        '"title":"公告","content":"正文",'
                        '"date":"2024-08-01T12:30:00+00:00"}]}});'
                    ),
                )
            )
        )
    )

    assert provider.eastmoney_news("000001")[0]["published_at"] == "2024-08-01T12:30:00+00:00"


def test_eastmoney_news_requires_the_requested_result_node():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='jQuery_news({"result":{"passportWeb":[]}});')

    provider = AStockDataProvider(client=httpx.Client(transport=httpx.MockTransport(handler)))

    with pytest.raises(InformationSourceError, match="cmsArticleWebOld"):
        provider.eastmoney_news("000001")


def test_eastmoney_rate_limit_is_shared_and_includes_injected_jitter():
    now = [100.0]
    delays: list[float] = []

    def clock() -> float:
        return now[0]

    def sleeper(delay: float) -> None:
        delays.append(delay)
        now[0] += delay

    limiter = EastmoneyRateLimiter(clock=clock, sleeper=sleeper, jitter=lambda: 0.25)
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, text='jQuery_news({"result":{"cmsArticleWebOld":[]}});'))
    )
    first = AStockDataProvider(client=client, limiter=limiter)
    second = AStockDataProvider(client=client, limiter=limiter)

    assert first.eastmoney_news("000001") == []
    assert second.eastmoney_news("000001") == []
    assert delays == [1.25]


def test_eastmoney_default_limiter_is_shared_by_all_providers():
    assert AStockDataProvider()._limiter is AStockDataProvider(client=httpx.Client())._limiter


def test_eastmoney_time_control_requires_an_explicit_limiter():
    with pytest.raises(TypeError):
        AStockDataProvider(clock=lambda: 100.0)


def test_cninfo_questions_looks_up_secid_and_sends_question_arguments_in_query_string():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("queryKeyboardInfo"):
            assert request.method == "POST"
            assert request.content == b"keyWord=000001"
            return httpx.Response(200, json={"data": [{"secid": "gssz0000001"}]})
        assert request.url.path.endswith("company/question")
        assert request.method == "POST"
        assert request.content == b""
        assert dict(request.url.params) == {
            "_t": "1",
            "stockcode": "000001",
            "code": "000001",
            "orgId": "gssz0000001",
            "secid": "gssz0000001",
            "pageSize": "20",
            "pageNum": "1",
            "keyWord": "",
            "startDay": "2024-07-01",
            "endDay": "2024-08-01",
        }
        return httpx.Response(
            200,
            json={
                "rows": [
                    {
                        "stockCode": "000001",
                        "companyShortName": "平安银行",
                        "mainContent": "<p>请问业绩如何？</p>",
                        "attachedContent": "<div>附件说明</div>",
                        "attachedAuthor": "董秘",
                        "pubDate": 1722470400000,
                    }
                ]
            },
        )

    provider = AStockDataProvider(client=httpx.Client(transport=httpx.MockTransport(handler)))

    rows = provider.cninfo_questions("000001", start_day="2024-07-01", end_day="2024-08-01")

    assert len(requests) == 2
    assert rows == [
        {
            "id": "cninfo:000001:2024-08-01T08:00:00+08:00:abf2fbe3442f",
            "source": "cninfo",
            "code": "000001",
            "company_short_name": "平安银行",
            "question": "请问业绩如何？",
            "answer": "附件说明",
            "answerer": "董秘",
            "published_at": "2024-08-01T08:00:00+08:00",
        }
    ]


def test_cninfo_questions_keeps_an_unanswered_question_distinct_from_answer():
    responses = iter(
        [
            {"data": [{"secid": "gssz0000001"}]},
            {
                "rows": [
                    {
                        "stockCode": "000001",
                        "companyShortName": "平安银行",
                        "mainContent": "<p>请问分红计划？</p>",
                        "attachedContent": None,
                        "attachedAuthor": None,
                        "pubDate": 1722470400000,
                    }
                ]
            },
        ]
    )
    provider = AStockDataProvider(
        client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=next(responses))))
    )

    row = provider.cninfo_questions("000001")[0]

    assert row["question"] == "请问分红计划？"
    assert row["answer"] is None
    assert row["answerer"] is None


def test_ths_hot_list_normalizes_all_items_from_one_response():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "data": {
                    "stock_list": [
                        {
                            "order": 1,
                            "code": "000001",
                            "name": "平安银行",
                            "rate": "2.34",
                            "rise_and_fall": "0.23",
                            "hot_rank_chg": "3",
                            "tag": {"concept_tag": ["银行"], "popularity_tag": ["热门"]},
                        },
                        {
                            "order": 2,
                            "code": "600000",
                            "name": "浦发银行",
                            "rate": "1.23",
                            "rise_and_fall": "0.11",
                            "hot_rank_chg": "-2",
                            "tag": {"concept_tag": ["金融"], "popularity_tag": ["关注"]},
                        },
                    ]
                }
            },
        )

    provider = AStockDataProvider(client=httpx.Client(transport=httpx.MockTransport(handler)))

    assert provider.ths_hot_list() == [
        {
            "rank": 1,
            "code": "000001",
            "name": "平安银行",
            "heat": "2.34",
            "pct": "0.23",
            "rank_chg": "3",
            "concepts": ["银行"],
            "tag": ["热门"],
        },
        {
            "rank": 2,
            "code": "600000",
            "name": "浦发银行",
            "heat": "1.23",
            "pct": "0.11",
            "rank_chg": "-2",
            "concepts": ["金融"],
            "tag": ["关注"],
        },
    ]
    assert len(calls) == 1


def test_ths_hot_rank_filters_the_normalized_hot_list_and_returns_none_when_absent():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert str(request.url).split("?")[0] == (
            "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock"
        )
        assert dict(request.url.params) == {
            "stock_type": "a",
            "type": "hour",
            "list_type": "normal",
        }
        return httpx.Response(
            200,
            json={
                "data": {
                    "stock_list": [
                        {
                            "order": 1,
                            "code": "000001",
                            "name": "平安银行",
                            "rate": "2.34",
                            "rise_and_fall": "0.23",
                            "hot_rank_chg": "3",
                            "tag": {"concept_tag": ["银行"], "popularity_tag": ["热门"]},
                        },
                        {"code": "600000"},
                    ]
                }
            },
        )

    provider = AStockDataProvider(client=httpx.Client(transport=httpx.MockTransport(handler)))

    assert provider.ths_hot_rank("000001.SZ") == {
        "rank": 1,
        "code": "000001",
        "name": "平安银行",
        "heat": "2.34",
        "pct": "0.23",
        "rank_chg": "3",
        "concepts": ["银行"],
        "tag": ["热门"],
    }
    assert provider.ths_hot_rank("300750") is None


def test_ths_hot_list_requires_data_stock_list_structure():
    provider = AStockDataProvider(
        client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"data": {}})))
    )

    with pytest.raises(InformationSourceError, match="stock_list"):
        provider.ths_hot_list()


@pytest.mark.parametrize("payload", [{"data": []}, {"data": None}])
def test_ths_hot_list_rejects_nonobject_data_nodes(payload):
    provider = AStockDataProvider(
        client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    )

    with pytest.raises(InformationSourceError, match="data.stock_list"):
        provider.ths_hot_list()
