# 缠论引擎信号栈实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在严格笔之上补出线段、走势类型、MACD 背驰和一二三类买卖点，
日线一类用缓存的 30 分钟次级别确认，分析路径不现场拉分钟线。

**Architecture:** `ChanEngine._reduce` 只编排。线段、MACD、走势、背驰、
确认都是 domain 纯函数。旧 snapshot 键只增不改。30 分钟预拉写入下载分片，
成功后再物化与日线相同窗口函数的分析窗；`analyze` 只精确命中分析窗。
一类确认按上海日历日 `[D0, D1]` 切片后再 `replay`。

**Tech Stack:** Python 3.13、pytest、psycopg3、Tushare `stk_mins`、
现有 FastAPI 分析/注册表管线。

**Spec:** `docs/superpowers/specs/2026-08-21-chan-engine-signals-design.md`

**Skills:** @superpowers:test-driven-development @gitnexus-impact-analysis

改 `ChanEngine` 前先跑 `gitnexus_impact({target: "ChanEngine", direction: "upstream"})`。
直接调用方：`analysis.py`、`reporting.py`、`trading/attribution.py`、
`trading/metrics.py`、`domain/report_outcome.py`。旧键不得删除。

---

## 文件结构

- 修改 `apps/api/app/domain/chan_engine.py`：删除 `_frozen_confirmed`；
  按 `(symbol, occurred_at)` 去重；`_reduce` 追加新键并编排纯函数。
- 修改 `tests/api/test_chan_engine.py`：冻结改为 replay==ingest；去重仍幂等。
- 创建 `apps/api/app/domain/chan_macd.py`：本地 MACD 与柱面积。
- 创建 `tests/api/test_chan_macd.py`
- 创建 `apps/api/app/domain/chan_segments.py`：特征序列、标准特征序列、破坏、线段。
- 创建 `tests/api/test_chan_segments.py`
- 创建 `apps/api/app/domain/chan_signals.py`：走势、背驰、本级别三类。
- 创建 `tests/api/test_chan_signals.py`
- 创建 `apps/api/app/domain/chan_confirm.py`：一类/二类次级别确认。
- 创建 `tests/api/test_chan_confirm.py`
- 修改 `apps/api/app/providers/tushare.py`：新增 `minutes30`。
- 修改 `tests/api/test_tushare_provider.py`
- 创建 `apps/api/app/market_prefetch.py`：分片预拉 + 物化分析窗。
- 创建 `tests/api/test_market_prefetch.py`
- 修改 `apps/api/app/analysis.py`：引擎版本 `chan-engine.v1.2`；读 30m 分析窗；
  用 `trade_time`（上海时区 bar 结束时间）转 UTC，**禁止**复用日线 `_bar`
  （它把 `trade_date` 写成 00:00 UTC）；不调用 `minutes30`；周线用已有日线缓存确认。
- 修改 `tests/api/test_analysis.py`：版本、「analyze 不拉分钟线」、30m 窗口确认、
  周线→日线确认。
- 修改 `apps/api/app/reporting.py`：注册表新引用、`PROMPT_VERSION=pi-advisor.v2.2`。
- 修改 `apps/api/app/api.py`：`run_chan_analysis` 的 `signal_summary` 加上
  `trend=` / `class1=`。
- 修改 `tests/api/test_reporting.py`、`tests/api/test_api.py`
- 修改 `apps/api/app/trading/metrics.py`：`chan_engine_version` 与分析对齐。
- 修改 `apps/agent-runtime/src/pi-session.ts`：提示词只增加「不得编造买卖点」。
- 修改 `CONTEXT.md`、`README.md`

前端 `ChanChart` / `api.ts` 图表契约本计划不改。

---

### Task 1：删除 freeze，全量重算

**Files:**

- Modify: `tests/api/test_chan_engine.py`
- Modify: `apps/api/app/domain/chan_engine.py`

- [ ] **Step 1：改失败测试**

把 `test_confirmed_output_is_not_rewritten_by_future_append` 换成：

```python
def test_replay_equals_incremental_after_each_bar():
    bars = [bar(i, 10 + i, 1) for i in range(6)]
    incremental = ChanEngine()
    for index, item in enumerate(bars, start=1):
        incremental.ingest(item)
        assert incremental.snapshot() == ChanEngine().replay(bars[:index])
```

保留 `test_duplicate_is_idempotent_and_older_bar_is_rejected`。

- [ ] **Step 2：运行，确认旧断言或 freeze 行为让新测试失败或红**

```bash
uv run --offline pytest -q tests/api/test_chan_engine.py
```

`replay` 本身就是循环 `ingest`，这条测试在仍保留 freeze 时也可能绿。
**无论红绿，Step 3 都必须删掉 `_frozen_confirmed`。** 不要因为测试已绿就跳过。

- [ ] **Step 3：最小实现**

删除 `_frozen_confirmed` 字段、`ingest`/`replay` 里对它的读写，以及
`_reduce` 里按数量拼接的分支。`confirmed = strokes[:-1]`，
`provisional = strokes[-1:]`。

去重改为：

```python
self._keys = {(item.symbol, item.occurred_at) for item in self._input}
# ingest 用 dict 或 set 判断 key，不再 for existing in self._input
```

`replay` 必须同时清空 `_keys`。

- [ ] **Step 4：测试全绿**

```bash
uv run --offline pytest -q tests/api/test_chan_engine.py
```

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_engine.py apps/api/app/domain/chan_engine.py
git commit -m "fix: recompute chan snapshots instead of freezing stroke prefixes"
```

---

### Task 2：本地 MACD

**Files:**

- Create: `tests/api/test_chan_macd.py`
- Create: `apps/api/app/domain/chan_macd.py`

- [ ] **Step 1：失败测试**

```python
from decimal import Decimal
from app.domain.chan_macd import compute_macd, histogram_area

def test_macd_not_ready_before_warmup():
    result = compute_macd([Decimal(i) for i in range(1, 30)])
    assert result["ready"] is False
    assert result["histogram"] == []

def test_macd_histogram_matches_hand_seeded_ema():
    closes = [Decimal(x) for x in ("10", "11", "12", "11", "13") + ("12",) * 40]
    result = compute_macd(closes)
    assert result["ready"] is True
    assert len(result["histogram"]) == len(closes)
    assert all(isinstance(item, str) for item in result["histogram"])

def test_histogram_area_sums_same_sign_bars_only():
    area = histogram_area(["1.0", "-0.5", "2.0"], sign=1)
    assert Decimal(area) == Decimal("3.0")
```

种子规则按 spec：前 N 根 SMA，之后 EMA。快 12、慢 26、信号 9，
柱 = `2 * (DIF - DEA)`。根数 < 35 时 `ready=false`。

- [ ] **Step 2：运行确认 ImportError / 未就绪失败**

```bash
uv run --offline pytest -q tests/api/test_chan_macd.py
```

- [ ] **Step 3：最小实现 `compute_macd` / `histogram_area`**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_macd.py apps/api/app/domain/chan_macd.py
git commit -m "feat: compute MACD histograms from frozen qfq closes"
```

---

### Task 3：特征序列与线段破坏

**Files:**

- Create: `tests/api/test_chan_segments.py`
- Create: `apps/api/app/domain/chan_segments.py`

复用 `tests/api/test_chan_engine.py` 的 `_stroke` 形状（`direction` /
`start_index` / `end_index` / `start_price` / `end_price` / 三个时间）。

- [ ] **Step 1：失败测试（先这四个，不要一次写完所有线段用例）**

```python
from app.domain.chan_segments import build_feature_sequence, standardize_feature_sequence, build_segments

def test_up_segment_feature_sequence_uses_down_strokes_only():
    strokes = [
        _stroke(0, 4, "10", "20"),   # up
        _stroke(4, 8, "20", "12"),   # down
        _stroke(8, 12, "12", "18"),  # up
        _stroke(12, 16, "18", "14"), # down
    ]
    features = build_feature_sequence(strokes, direction="up")
    assert [item["low"] for item in features] == ["12", "14"]

def test_standard_feature_sequence_merges_inclusion():
    raw = [{"high": "20", "low": "10"}, {"high": "18", "low": "12"}, {"high": "22", "low": "11"}]
    standard = standardize_feature_sequence(raw)
    assert len(standard) < len(raw)

def test_gap_break_confirms_segment():
    # 构造：向上尝试段的标准特征序列第 4 个元素与第 3 个无重叠
    segments = build_segments(_gap_break_strokes())
    assert segments[0]["status"] == "confirmed"
    assert segments[0]["break_kind"] == "gap"

def test_unbroken_tail_is_provisional():
    segments = build_segments(_three_stroke_unbroken())
    assert segments[-1]["status"] == "provisional"
    assert segments[-1]["break_kind"] is None

def test_ambiguous_partition_is_omitted():
    assert build_segments(_ambiguous_strokes()) == []
```

`_gap_break_strokes` / `_three_stroke_unbroken` / `_ambiguous_strokes`
写在测试文件里，用字面价格钉死，不要从实现反推。

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_chan_segments.py
```

- [ ] **Step 3：实现 `build_feature_sequence`、`standardize_feature_sequence`、
  `build_segments`**

破坏规则按 spec：缺口与分型先到先得。无法唯一判定则 `[]`，不要标
provisional。再补分型破坏测试后实现顶/底分型。

- [ ] **Step 4：补分型破坏测试并绿**

```python
def test_fractal_break_confirms_up_segment_on_top_fractal():
    segments = build_segments(_fractal_break_strokes())
    assert segments[0]["break_kind"] == "fractal"
    assert segments[0]["direction"] == "up"
```

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_segments.py apps/api/app/domain/chan_segments.py
git commit -m "feat: partition strokes into textbook chan segments"
```

---

### Task 4：线段中枢接入 snapshot

**Files:**

- Modify: `apps/api/app/domain/chan_segments.py`
- Modify: `apps/api/app/domain/chan_engine.py`
- Modify: `tests/api/test_chan_engine.py`
- Modify: `tests/api/test_chan_segments.py`

- [ ] **Step 1：失败测试**

```python
def test_segment_centers_are_sequential():
    centers = build_segment_centers(_two_center_segments())
    assert len(centers) == 2
    assert centers[0]["end_index"] <= centers[1]["start_index"]

def test_snapshot_includes_empty_signal_keys_on_short_series():
    snapshot = ChanEngine().replay([bar(0, 10, 1), bar(1, 12, 3)])
    for key in ("segments", "segment_centers", "macd", "trend", "divergences", "signals"):
        assert key in snapshot
```

- [ ] **Step 2：运行确认失败**

- [ ] **Step 3：`build_segment_centers` 把线段收成 `build_centers` 所需形状后调用
  `build_centers`。`_reduce` 追加空/真实新键；MACD 用 `snapshot.bars` 的 close。
  `trend` 先给 `unavailable` / `insufficient_centers`，信号列表先 `[]`。**

引擎版本先不要在 `_reduce` 里写；版本在 `analysis.py`。

- [ ] **Step 4：测试全绿，含 Task 1 回归**

```bash
uv run --offline pytest -q tests/api/test_chan_engine.py tests/api/test_chan_segments.py
```

- [ ] **Step 5：Commit**

```bash
git add apps/api/app/domain/chan_engine.py apps/api/app/domain/chan_segments.py \
  tests/api/test_chan_engine.py tests/api/test_chan_segments.py
git commit -m "feat: expose sequential segment centers on chan snapshots"
```

---

### Task 5：走势类型与背驰

**Files:**

- Create: `tests/api/test_chan_signals.py`
- Create: `apps/api/app/domain/chan_signals.py`
- Modify: `apps/api/app/domain/chan_engine.py`

- [ ] **Step 1：失败测试**

```python
from app.domain.chan_signals import classify_trend, find_divergences

def test_two_rising_centers_are_uptrend():
    trend = classify_trend([
        {"lower": "10", "upper": "12", "occurred_at": t0},
        {"lower": "12", "upper": "15", "occurred_at": t1},
    ])
    assert trend == {"type": "uptrend", "center_count": 2, "unavailable_reason": None}

def test_non_monotonic_centers_are_consolidation_not_divergence():
    trend = classify_trend([
        {"lower": "10", "upper": "12", "occurred_at": t0},
        {"lower": "8", "upper": "11", "occurred_at": t1},
    ])
    assert trend["type"] == "consolidation"
    assert find_divergences(trend, segments, macd) == []

def test_trend_top_divergence_when_price_higher_area_not():
    divergences = find_divergences(uptrend, leaving_segments, ready_macd)
    assert divergences[0]["kind"] == "trend"
    assert divergences[0]["direction"] == "top"
    assert divergences[0]["status"] == "confirmed"

def test_single_center_records_consolidation_divergence_not_class1():
    divergences = find_divergences(one_center_trend, segments, ready_macd)
    assert divergences[0]["kind"] == "consolidation"
    signals = build_parent_signals(one_center_trend, divergences, segments)
    assert all(item["klass"] != "class1" for item in signals)
```

面积只累加同向离开段自身时间范围内的同号柱。MACD 未就绪则 divergence
`unevaluable` / 不在这里写 `Signal.reason`。

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_chan_signals.py
```

- [ ] **Step 3：实现 `classify_trend`、`find_divergences`、`build_parent_signals`
  （本级别三类先空着或只拒绝一类）。`_reduce` 接入这两步。**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_signals.py apps/api/app/domain/chan_signals.py \
  apps/api/app/domain/chan_engine.py
git commit -m "feat: classify chan trends and MACD divergences"
```

---

### Task 6：本级别三类买卖点

**Files:**

- Modify: `tests/api/test_chan_signals.py`
- Modify: `apps/api/app/domain/chan_signals.py`

- [ ] **Step 1：失败测试**

```python
def test_class3_buy_when_pullback_stays_above_center():
    signals = build_parent_signals(trend, divergences, segments)
    class3 = [item for item in signals if item["klass"] == "class3"]
    assert class3[0]["side"] == "buy"
    assert class3[0]["status"] in {"confirmed", "provisional"}
    assert class3[0]["sublevel"] is None

def test_class3_omitted_when_pullback_reenters_center():
    signals = build_parent_signals(trend, divergences, reentry_segments)
    assert [item for item in signals if item["klass"] == "class3"] == []
```

`price` / `occurred_at` 取本级别回抽线段终点。回抽线段未确认则
`provisional`。

- [ ] **Step 2：运行确认失败**

- [ ] **Step 3：最小实现三类；不要在本任务做一类确认**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_signals.py apps/api/app/domain/chan_signals.py
git commit -m "feat: emit class-3 signals from segment-center pullbacks"
```

---

### Task 7：Tushare 30 分钟取数

**Files:**

- Modify: `tests/api/test_tushare_provider.py`
- Modify: `apps/api/app/providers/tushare.py`

- [ ] **Step 1：失败测试**

给 `FakeClient` 增加 `stk_mins`，记录 kwargs，返回两根 30 分钟 bar
（`trade_time` 为 `2024-08-02 10:00:00` / `10:30:00`，OHLC + vol）。
`adj_factor` 已有当日因子。

```python
def test_minutes30_rebases_with_same_day_daily_factor(monkeypatch):
    monkeypatch.setenv("TUSHARE_TOKEN", "secret")
    client = FakeClient()
    provider = TushareMarketProvider(client=client)
    rows = provider.minutes30("600000.SH", as_of=date(2024, 8, 2),
                              start_date=date(2024, 8, 2), end_date=date(2024, 8, 2))
    assert client.calls[-1][0] == "stk_mins"
    assert client.calls[-1][1]["freq"] == "30min"
    assert "qfq_close" in rows[0]
    assert rows[0]["trade_time"]

def test_minutes30_does_not_fill_missing_day_factor_from_neighbor():
    client = FakeClient()
    client.adj_factor = lambda **kwargs: [{"trade_date": "20240801", "adj_factor": 2}]
    rows = TushareMarketProvider(client=client).minutes30(
        "600000.SH", as_of=date(2024, 8, 2), start_date=date(2024, 8, 2), end_date=date(2024, 8, 2)
    )
    assert rows[0]["close"] == rows[0]["qfq_close"]
    assert "missing_day_adj_factor" in rows[0]["quality"]["warnings"]

def test_minutes30_hides_upstream_errors():
    with pytest.raises(MarketProviderError):
        TushareMarketProvider(client=FailingMinsClient()).minutes30(...)
```

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_tushare_provider.py
```

- [ ] **Step 3：实现 `minutes30`。权限/上游失败走现有 `_call` →
  `MarketProviderError`。空结果只有上游真的返回空列表时才允许。
  provider 返回原始行 + `trade_time` + qfq 字段，不在这里造 `CanonicalBar`。**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_tushare_provider.py apps/api/app/providers/tushare.py
git commit -m "feat: fetch 30-minute bars rebased by daily adj factors"
```

---

### Task 8：预拉分片与分析窗

**Files:**

- Create: `tests/api/test_market_prefetch.py`
- Create: `apps/api/app/market_prefetch.py`

分析窗键必须与 `MarketAnalysisService.analyze` 日线 `cache_key` 相同：

```python
start_date = as_of - timedelta(days=365 * 5)
(symbol, "30m", "qfq", as_of.isoformat(), start_date.isoformat(), as_of.isoformat())
```

下载分片键用实际分片起止日，`as_of` 仍是命令行 `--as_of`。

- [ ] **Step 1：失败测试（用内存/隔离 Database fixture，假 provider）**

```python
def test_prefetch_requires_as_of():
    with pytest.raises(ValueError, match="as_of"):
        prefetch_minutes30(store, provider, symbol="600000.SH", as_of=None)

def test_failed_shard_does_not_rewrite_analysis_window(db):
    provider = FlakyMinsProvider(fail_on_shard=1)
    # 先写入旧分析窗
    db.save_market_history(*analysis_key, [{"old": True}])
    prefetch_minutes30(db, provider, symbol="600000.SH", as_of=date(2024, 8, 21))
    assert db.get_market_history(*analysis_key) == [{"old": True}]

def test_successful_prefetch_materializes_analysis_window(db):
    prefetch_minutes30(db, FakeMinsProvider(), symbol="600000.SH", as_of=date(2024, 8, 21))
    rows = db.get_market_history(*analysis_key)
    assert rows and "qfq_close" in rows[0]
```

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_market_prefetch.py
```

- [ ] **Step 3：实现 `prefetch_minutes30`。CLI：
  `python -m app.market_prefetch --symbol 002940.SZ --timeframe 30m --as_of 2026-08-21`。
  `--as_of` 缺失退出码非 0。分片 ≤20 个交易日。不在 analyze 里调用。**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_market_prefetch.py apps/api/app/market_prefetch.py
git commit -m "feat: prefetch 30-minute shards into a daily-aligned analysis window"
```

---

### Task 9：一类 / 二类次级别确认

**Files:**

- Create: `tests/api/test_chan_confirm.py`
- Create: `apps/api/app/domain/chan_confirm.py`
- Modify: `apps/api/app/domain/chan_signals.py`（一类候选从趋势背驰产出，
  status 先 `unevaluable`，由 confirm 改写）

- [ ] **Step 1：失败测试**

```python
from app.domain.chan_confirm import confirm_class1, confirm_class2

def test_class1_unevaluable_without_child_bars():
    signal = confirm_class1(parent_snapshot, [])
    assert signal["status"] == "unevaluable"
    assert signal["reason"] == "class1_sublevel_market_not_ready"

def test_class1_not_confirmed_by_structure_outside_departure_days():
    # 全量子级别有反向已确认线段，但完成日早于 D0
    signal = confirm_class1(parent_snapshot, child_bars_with_old_reversal)
    assert signal["status"] != "confirmed"

def test_class1_confirmed_when_reverse_segment_ends_on_departure_day():
    signal = confirm_class1(parent_snapshot, child_bars)
    assert signal["status"] == "confirmed"
    assert signal["sublevel"]["window_start"]  # 日期，不是 00:00 UTC
    assert signal["price"] == parent_departure_end_price

def test_warmup_segment_ending_on_d0_counts():
    # 起点在预热、终点日历日 == D0
    signal = confirm_class1(parent_snapshot, spanning_bars)
    assert signal["status"] == "confirmed"

def test_class2_confirmed_on_first_reverse_child_segment():
    signal = confirm_class2(class1_signal, parent_snapshot, child_bars)
    assert signal["klass"] == "class2"
    assert signal["status"] == "confirmed"

def test_class2_omitted_when_pullback_breaks_class1_extreme():
    assert confirm_class2(class1_signal, parent_snapshot, break_bars) is None

def test_class2_provisional_when_reverse_segment_unconfirmed():
    signal = confirm_class2(class1_signal, parent_snapshot, incomplete_bars)
    assert signal["status"] == "provisional"
    assert signal["reason"] == "class2_pullback_incomplete"
```

`confirm_class1` 返回完整 `Signal`（status / reason / sublevel / price /
occurred_at），不要只返回枚举。窗口用上海日历日。预热 120 根。
反向趋势背驰：本级别向上离开对应次级别 `direction=bottom`。

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_chan_confirm.py
```

- [ ] **Step 3：实现切片 + replay + 确认。禁止先全量 replay 再过滤事件。**

- [ ] **Step 4：测试全绿**

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_chan_confirm.py apps/api/app/domain/chan_confirm.py \
  apps/api/app/domain/chan_signals.py
git commit -m "feat: confirm class-1 and class-2 with sliced sublevel replay"
```

---

### Task 10：分析路径只读 30m 缓存

**Files:**

- Modify: `tests/api/test_analysis.py`
- Modify: `apps/api/app/analysis.py`
- Modify: `apps/api/app/trading/metrics.py`（`chan_engine_version` → `v1.2`）

- [ ] **Step 1：失败测试**

把 `test_market_analysis_connects_tushare_to_chan_engine` 的
`engine_version` 断言改为 `chan-engine.v1.2`。

新增：

```python
def test_daily_analysis_does_not_call_minutes30(monkeypatch):
    client = FakeAnalysisClient()
    client.stk_mins = lambda **kwargs: (_ for _ in ()).throw(AssertionError("minutes30"))
    service = MarketAnalysisService(TushareMarketProvider(client=client))
    payload = service.analyze("600000.SH", as_of=date(2024, 8, 5), timeframe="1d")
    class1 = [item for item in payload["chan_analysis"]["snapshot"]["signals"]
              if item.get("klass") == "class1"]
    assert payload["chan_analysis"]["engine_version"] == "chan-engine.v1.2"
    if class1:
        assert class1[0]["reason"] == "class1_sublevel_market_not_ready"

def test_daily_analysis_confirms_from_cached_30m_window():
    as_of = date(2024, 8, 5)
    start = as_of - timedelta(days=365 * 5)
    store = FakeHistoryStore()
    store.save_market_history(
        "600000.SH", "30m", "qfq", as_of.isoformat(), start.isoformat(), as_of.isoformat(),
        [{
            "trade_time": "2024-08-05 15:00:00",
            "open": 10, "high": 11, "low": 9, "close": 10, "vol": 1,
            "qfq_open": 10, "qfq_high": 11, "qfq_low": 9, "qfq_close": 10,
        }],
    )
    service = MarketAnalysisService(TushareMarketProvider(client=FakeAnalysisClient()), history_store=store)
    payload = service.analyze("600000.SH", as_of=as_of, timeframe="1d")
    assert payload["chan_analysis"]["engine_version"] == "chan-engine.v1.2"

def test_minute_bar_uses_shanghai_close_not_utc_midnight():
    from app.analysis import MarketAnalysisService
    bar = MarketAnalysisService._minute_bar("600000.SH", {
        "trade_time": "2024-08-05 15:00:00",
        "qfq_open": 10, "qfq_high": 11, "qfq_low": 9, "qfq_close": 10,
    })
    assert bar.occurred_at.isoformat() == "2024-08-05T07:00:00+00:00"

def test_weekly_analysis_confirms_from_daily_cache_not_minutes30():
    client = FakeAnalysisClient()
    client.stk_mins = lambda **kwargs: (_ for _ in ()).throw(AssertionError("minutes30"))
    # history_store 放入与周线 as_of 对齐的 1d 缓存
    service = MarketAnalysisService(TushareMarketProvider(client=client), history_store=store)
    payload = service.analyze("600000.SH", as_of=date(2024, 8, 9), timeframe="1w")
    assert payload["chan_analysis"]["engine_version"] == "chan-engine.v1.2"
```

周线次级别是日线缓存，不是 30m，也不得调用 `minutes30`。

- [ ] **Step 2：运行确认版本断言失败**

```bash
uv run --offline pytest -q tests/api/test_analysis.py
```

- [ ] **Step 3：实现**

新增 `MarketAnalysisService._minute_bar`：解析 `trade_time` 为
`Asia/Shanghai`，转 UTC，写入 `occurred_at` / `known_at` / `stable_through`。
**禁止**对 30 分钟行调用现有 `_bar`。

`analyze(timeframe="1d")`：读与日线相同 `cache_key` 形状、`timeframe="30m"`
的分析窗 → `_minute_bar` 列表 → `confirm_class1` / `confirm_class2`。
未命中不调用 `provider.minutes30`。脏数据只降级信号，日线仍 200。

`analyze(timeframe="1w")`：次级别读已有 `timeframe="1d"` 缓存，用 `_bar`
转日线 CanonicalBar，走同一套 `confirm_*`。不得读 30m，不得调用
`minutes30`。

版本改为 `chan-engine.v1.2`。

- [ ] **Step 4：分析 + 归因/metrics 相关测试**

```bash
uv run --offline pytest -q tests/api/test_analysis.py tests/api/test_trading_metrics.py \
  tests/api/test_trading_attribution.py
```

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_analysis.py apps/api/app/analysis.py \
  apps/api/app/trading/metrics.py
git commit -m "feat: confirm daily class-1 from cached 30-minute analysis windows"
```

---

### Task 11：注册表与提示词

**Files:**

- Modify: `tests/api/test_reporting.py`
- Modify: `tests/api/test_api.py`
- Modify: `apps/api/app/reporting.py`
- Modify: `apps/api/app/api.py`（`run_chan_analysis` 的 `signal_summary`）
- Modify: `apps/agent-runtime/src/pi-session.ts`
- Modify: `apps/agent-runtime/src/pi-session.test.ts`

- [ ] **Step 1：失败测试**

在已有 `frozen_input` 上补一段含 `trend` / `signals` 的 snapshot
（最后离开段内的 `class1` `provisional`）。断言注册表出现：

- `chan.trend.type`
- `chan.signal.class1.side` / `status` / `price`

断言五年前、或 `unevaluable`、或不属于最后离开段的一类**不**出现。
`signal_summary` 在 **`api.py` 的 `run_chan_analysis` 工具结果**里含
`trend=` 与 `class1=`（`reporting.py` 不拼这个字符串）。
`PROMPT_VERSION` 变为 `pi-advisor.v2.2`。

注册表测试除 class1 外，存在事实时还要出现 spec 列出的
`chan.segment.last.*` / `chan.segment_center.*` / `chan.divergence.last.*` /
class2 / class3。

情景正文仍禁止数字。现有 tautology / anchor 测试必须继续红/绿语义不变。

- [ ] **Step 2：运行确认失败**

```bash
uv run --offline pytest -q tests/api/test_reporting.py
```

- [ ] **Step 3：按 spec「最后一条仍属于最后离开段」追加引用。
  `api.py` `signal_summary` 改为
  `confirmed=…; provisional=…; centers=…; trend=…; class1=…`。
  提示词只加一句不得编造未出现的买卖点。四步状态机不动。
  30m 脏数据警告写入已有 `market_snapshot.quality`，不给 `chan_analysis`
  新增对外 quality 字段。**

- [ ] **Step 4：Python + Node session 测试**

```bash
uv run --offline pytest -q tests/api/test_reporting.py tests/api/test_api.py
npm test -- apps/agent-runtime/src/pi-session.test.ts
```

- [ ] **Step 5：Commit**

```bash
git add tests/api/test_reporting.py tests/api/test_api.py \
  apps/api/app/reporting.py apps/api/app/api.py \
  apps/agent-runtime/src/pi-session.ts apps/agent-runtime/src/pi-session.test.ts
git commit -m "feat: publish chan signal facts into the reference registry"
```

---

### Task 12：词汇、README 与全量回归

**Files:**

- Modify: `CONTEXT.md`
- Modify: `README.md`

- [ ] **Step 1：按 spec「词汇」四条写入 `CONTEXT.md`。README 目录补
  `chan_segments.py` / `chan_confirm.py` / `market_prefetch.py`，
  启动章节补 30 分钟预拉命令，写明分析不现场拉分钟线。不写 30m 对外路由。**

- [ ] **Step 2：全量回归**

```bash
uv run --offline pytest -q tests/api
npm test
npx tsc --noEmit
npm --prefix apps/web test -- --run --reporter=dot
```

前端图表测试应无需修改即过。若 `engine_version` 或 snapshot 多键导致失败，
只修断言，不改图表契约。

- [ ] **Step 3：Commit**

```bash
git add CONTEXT.md README.md
git commit -m "docs: describe chan signal stack and 30-minute prefetch"
```

---

## 验收对照

- [ ] `replay` 等于逐根 ingest
- [ ] 旧 snapshot 键仍在，归因/兑现测试不因缺键失败
- [ ] `engine_version == chan-engine.v1.2`
- [ ] 无 30m 缓存时日线分析 200，一类 `unevaluable`
- [ ] 分析窗命中后一类可为 `provisional`/`confirmed`，窗口是日期不是 00:00 UTC
- [ ] 离开段外的次级别反向线段不能确认一类
- [ ] 盘整背驰（含 ≥2 不单调）不产生一类
- [ ] 无 `timeframe=30m` 对外路由
- [ ] 前端现有图表测试通过
