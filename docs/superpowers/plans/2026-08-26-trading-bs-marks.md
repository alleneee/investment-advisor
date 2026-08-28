# 周期复盘个股 BS 点分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在周期复盘中提供同花顺式个股 BS 分析：盈亏块、日线/30 分钟未复权 K 线、实盘 B/S、可叠多条的手标与自定义类型、成交量与 MACD 副图。

**Architecture:** 成交仍走账本。新建账户级图标注记层（类型 + 评论，按 `occurred_at` 投影到日线/30 分钟）。周期窗口只负责盈亏块与成功率。个股图实时拉未复权行情并调用 `compute_macd`，不写入确定性报告快照。复盘主区用 BS 分析替换现有权益+缠论大图。

**Tech Stack:** Python 3.12、FastAPI、Pydantic v2、PostgreSQL、Decimal、pytest、React 19、TypeScript、ECharts 5、Vitest

---

## 规格

- `docs/superpowers/specs/2026-08-26-trading-bs-marks-design.md`
- 领域词汇：`CONTEXT.md`（成交、交易周期、周期复盘）

## 文件结构

- 修改 `apps/api/app/domain/chan_macd.py`：`compute_macd` 增加等长 `dif`/`dea`。
- 修改 `tests/api/test_chan_macd.py`：未就绪空数组、就绪等长、histogram 回归。
- 修改 `apps/api/app/trading/store.py`：`chart_mark_types`、`chart_marks` 表与 CRUD。
- 新建 `apps/api/app/trading/bs_analysis.py`：摘要统计、时间投影、个股图载荷。
- 新建 `tests/api/test_trading_bs_analysis.py`：统计、投影、MACD 挂载、柱校验。
- 新建 `tests/api/test_trading_chart_marks.py`：类型/手标存储与冲突。
- 修改 `apps/api/app/trading/service.py`：委托 BS 与手标用例。
- 修改 `apps/api/app/trading/api.py`：`/bs-summary`、`/bs-chart`、手标与类型路由。
- 修改 `tests/api/test_trading_api.py`：HTTP 契约。
- 修改 `apps/web/src/trading-types.ts`、`trading-api.ts`、对应测试、`createMockTradingApi`。
- 新建 `apps/web/src/bs-chart-option.ts`、`bs-chart-option.test.ts`、`BsChart.tsx`、`BsChart.test.tsx`。
- 新建 `apps/web/src/BsAnalysisPanel.tsx`、`BsAnalysisPanel.test.tsx`。
- 修改 `apps/web/src/ReviewCenterPage.tsx` 与测试：主图改为 BS 分析。
- 修改 `apps/web/src/styles.css`、`README.md`。

## 工作区约束

- 修改函数/类/方法前运行 `npx gitnexus impact -r investment-advisor <symbol> --direction upstream`；HIGH/CRITICAL 先报告用户。
- 提交前 `npx gitnexus detect-changes --scope staged -r investment-advisor`。
- 只 `git add` 本任务列出的路径，禁止 `git add .`。
- 财务与价格继续用 `Decimal` 和十进制字符串，禁止 `float` 进 API。
- 手标 `comment` 超 1000 字一律拒绝，不截断。
- 自建类型请求只含 `label`、`letter`（1–2 个字符）、`color`；`code` 与 `type_id` 由服务端生成。
- 表 DDL 继续用现有 `TradingStore` 的 `CREATE TABLE IF NOT EXISTS` 风格（与当前 SQLite/PostgreSQL 兼容层一致）。
- 30 分钟窗口按 spec：以 `period_end` 为终点向前约 25 个交易日；长周期（季/年）30 分钟图只覆盖该窗口与复盘期的交集，日线仍覆盖完整周期加前文。
- 不修改投资报告状态机、Pi sidecar、确定性报告 `chartBundles` 的生成契约。

---

### Task 1: `compute_macd` 输出 DIF/DEA

**Files:**

- Modify: `tests/api/test_chan_macd.py`
- Modify: `apps/api/app/domain/chan_macd.py`

- [ ] **Step 1: 影响分析**

```bash
npx gitnexus impact -r investment-advisor compute_macd --direction upstream --include-tests
```

Expected: 调用方含缠论背驰。本任务只追加 `dif`/`dea` 键，不改 `histogram` 垫值与 `ready` 判定。若风险 HIGH/CRITICAL，先向用户报告。

- [ ] **Step 2: 写失败测试**

在 `test_macd_not_ready_before_warmup` 增加 `dif`/`dea` 为空列表。新增：

```python
def test_macd_ready_returns_dif_dea_same_length_as_histogram() -> None:
    closes = [Decimal(x) for x in ("10", "11", "12", "11", "13") + ("12",) * 40]
    result = compute_macd(closes)
    assert result["ready"] is True
    assert len(result["dif"]) == len(closes)
    assert len(result["dea"]) == len(closes)
    assert len(result["histogram"]) == len(closes)
    last_dif = Decimal(result["dif"][-1])
    last_dea = Decimal(result["dea"][-1])
    assert Decimal(result["histogram"][-1]) == 2 * (last_dif - last_dea)
```

- [ ] **Step 3: 跑测试确认失败**

```bash
uv run --offline pytest -q tests/api/test_chan_macd.py -q
```

Expected: FAIL，未就绪响应缺 `dif`/`dea`。

- [ ] **Step 4: 最小实现**

`ready=false` 返回 `{"ready": False, "warmup_bars": SLOW, "histogram": [], "dif": [], "dea": []}`。
`ready=true` 在现有 `dif`/`dea` 局部变量上 `str(...)` 后一并返回。热身垫值算法不动。

- [ ] **Step 5: 回归**

```bash
uv run --offline pytest -q tests/api/test_chan_macd.py tests/api/test_chan_engine.py tests/api/test_chan_signals.py
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add tests/api/test_chan_macd.py apps/api/app/domain/chan_macd.py
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(chan): return MACD dif and dea alongside histogram"
```

---

### Task 2: 手标类型与手标存储

**Files:**

- Modify: `apps/api/app/trading/store.py`
- Create: `tests/api/test_trading_chart_marks.py`

- [ ] **Step 1: 影响分析**

```bash
npx gitnexus impact -r investment-advisor _init_schema --direction upstream --include-tests
```

Expected: `TradingStore` 初始化。只追加表，不改现有表列。

- [ ] **Step 2: 写失败测试**

`tests/api/test_trading_chart_marks.py` 用 `Database()` + `TradingStore` 建账户后：

1. `ensure_preset_mark_types` 后列出 5 个预置（`ideal_buy` 等，颜色与 spec 一致）。
2. 创建自建类型只传 `label`/`letter`/`color`；返回含服务端 `code`、`type_id`、`preset=false`。`letter` 长度不是 1–2 则失败。同账户 `label` 或 `letter` 冲突抛错，code=`DUPLICATE_TYPE`。
3. 删除预置抛错 `MARK_TYPE_PRESET`。
4. 创建手标；同一 `(symbol, occurred_at, type_id)` 允许第二条。
5. 有引用时删自建类型抛错 `MARK_TYPE_IN_USE`；删光手标后可删类型。
6. `revision` 不匹配更新/删除抛 `REVISION_CONFLICT`。

- [ ] **Step 3: 跑测试确认失败**

```bash
uv run --offline pytest -q tests/api/test_trading_chart_marks.py
```

Expected: FAIL，缺表或方法。

- [ ] **Step 4: 建表与 CRUD**

在 `_init_schema` 追加：

```sql
CREATE TABLE IF NOT EXISTS chart_mark_types(
    type_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    letter TEXT NOT NULL,
    color TEXT NOT NULL,
    preset INTEGER NOT NULL CHECK(preset IN (0, 1)),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(account_id, code),
    UNIQUE(account_id, label),
    UNIQUE(account_id, letter),
    FOREIGN KEY(account_id) REFERENCES trading_account(account_id)
);
CREATE TABLE IF NOT EXISTS chart_marks(
    mark_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    type_id TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(account_id) REFERENCES trading_account(account_id),
    FOREIGN KEY(type_id) REFERENCES chart_mark_types(type_id)
);
CREATE INDEX IF NOT EXISTS chart_marks_symbol_time
    ON chart_marks(account_id, symbol, occurred_at);
```

`ensure_preset_mark_types(account_id)` 幂等插入五类。手标 `comment` 默认 `''`，长于 1000 在 service/API 拒绝。自建 `code` 用稳定短码（例如 `custom_` + 小写字母数字），不让客户端传入。

- [ ] **Step 5: 测试通过并提交**

```bash
uv run --offline pytest -q tests/api/test_trading_chart_marks.py
git add apps/api/app/trading/store.py tests/api/test_trading_chart_marks.py
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(trading): persist chart mark types and marks"
```

---

### Task 3: 盈亏摘要与时间投影纯函数

**Files:**

- Create: `apps/api/app/trading/bs_analysis.py`
- Create: `tests/api/test_trading_bs_analysis.py`

- [ ] **Step 1: 写失败测试**

覆盖：

1. 两只股票卖出已实现盈亏切开后之和等于账户 `period_realized_pnl`；只有买入、实现为 0 的股票仍出现在 `symbols`。
2. 开放周期不计入 `closed_cycle_count`/`win_rate`；无闭合周期时 `win_rate.value is None` 且 `unavailable_reason == "no_closed_cycle"`。
3. `median_holding_days` 用现有持有交易日规则（含首尾交易日）。
4. 手标投影：
   - 30 分 `occurred_at` 全等 → 该 30 分柱；日线 → 当天日 K。
   - 日线午夜时点 → 30 分钟图落到**当天最后一根** 30 分柱，不复制到全天。
   - 当天无 30 分柱 → 30 分钟图不画，日线仍画。
5. 成交 30 分钟覆盖：第 i 根 `(t[i-1], t[i]]`，第一根 `(t[0]-30min, t[0]]`。

不要在这些测试里打 HTTP。

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run --offline pytest -q tests/api/test_trading_bs_analysis.py
```

- [ ] **Step 3: 实现纯函数**

`bs_analysis.py` 导出：

- `symbol_bs_summary(executions, ledger, names, period_start, period_end, trading_days) -> list[dict]`
- `project_marks(marks, daily_bars, minute_bars) -> {daily: ..., minute: ...}`
- `project_executions(executions, daily_bars, minute_bars)`

复用 `replay_rows`、`realized_by_event_id`、`ClosedCycle.holding` 口径与 `metrics._cycle_case` 的持有日计算，不要复制一套盈亏公式。金额用 `canonical_decimal_text` / `money_text`。

- [ ] **Step 4: 测试通过并提交**

```bash
uv run --offline pytest -q tests/api/test_trading_bs_analysis.py tests/api/test_trading_metrics.py
git add apps/api/app/trading/bs_analysis.py tests/api/test_trading_bs_analysis.py
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(trading): compute BS summary and mark projections"
```

---

### Task 4: 个股未复权图 + MACD + 柱存在校验

**Files:**

- Modify: `apps/api/app/trading/bs_analysis.py`
- Modify: `tests/api/test_trading_bs_analysis.py`
- Modify: `apps/api/app/trading/service.py`（仅增加薄封装，行情获取放 bs_analysis 或 service 私有方法）

- [ ] **Step 1: 影响分析**

```bash
npx gitnexus impact -r investment-advisor _provider_daily --direction upstream
npx gitnexus impact -r investment-advisor _raw_bar --direction upstream
```

Expected: 复用，不改签名。若必须改 `_raw_bar`，停止并报告。

- [ ] **Step 2: 写失败测试**

用假 provider：

- 日线 `available=true`，`adjustment=="none"`，`macd.ready` 在 <35 根时为 false 且 `dif/dea/histogram==[]`。
- ≥35 根时 `macd` 三列与 `bars` 等长。
- 返回体必须含 `executions`：由 `project_executions` 投影到当前 timeframe 的柱（含 `execution_id`、`side`、`price`、`occurred_at`/`trade_date`）。无成交时为 `[]`，键不能缺。
- 30 分钟 provider 抛错 → `available=false`，`bars=[]`，`executions=[]`，`quality.status=="unavailable"`，不抛给调用方。
- `assert_bar_exists(bars, occurred_at)`：日线用等值；30 分钟用等值；缺失 → 错误码 `BAR_NOT_FOUND`。

日线窗口：`period_end` 向前至少覆盖周期开始，再加约 180 个日历日前文。30 分钟：`period_end` 向前 25 个交易日（可用 `timedelta(days=40)` 日历近似，再按交易日过滤，与 `MINUTE_LOOKBACK_DAYS["30m"]` 对齐）。

- [ ] **Step 3: 实现 `build_bs_chart`**

日线：优先 `store.list_market_bars`，缺则 `_provider_daily` + `_raw_bar`（与报告图同一未复权路径）。
30 分钟：`provider.minutes(..., freq="30m")`，把 `trade_time` 规范成带 `+08:00` 的 `occurred_at`；**不要**走缠论复盘的 `qfq` 缓存键。
MACD：对返回 bars 的 close 调 `compute_macd`。
把周期内该股成交传入 `project_executions`，按当前 `timeframe` 的柱写入载荷 `executions`。

- [ ] **Step 4: 测试通过并提交**

```bash
uv run --offline pytest -q tests/api/test_trading_bs_analysis.py
git add apps/api/app/trading/bs_analysis.py apps/api/app/trading/service.py tests/api/test_trading_bs_analysis.py
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(trading): load unadjusted BS charts with MACD"
```

---

### Task 5: HTTP API

**Files:**

- Modify: `apps/api/app/trading/api.py`
- Modify: `apps/api/app/trading/service.py`
- Modify: `tests/api/test_trading_api.py`

- [ ] **Step 1: 影响分析**

```bash
npx gitnexus impact -r investment-advisor create_trading_router --direction upstream
```

- [ ] **Step 2: 写失败的 HTTP 测试**

沿用 `test_trading_api.py` 的 `create_app` + 账户 + 成交夹具：

1. `GET /api/trading/bs-summary?start=&end=` 返回本周期有成交股票；零实现股票仍在列表，`realized_pnl` 为 `"0.00"` 或规范 `"0"`（与 `money_text` 一致，测试钉死后端实际函数）。
2. `GET /api/trading/chart-mark-types` 自动种子 5 个预置。
   `POST /api/trading/chart-mark-types` 体只有 `{label, letter, color}`；201 响应含 `type_id`、`code`、`preset: false`。`letter` 为 `""` 或 3 个字符 → 400。
3. `POST /api/trading/chart-marks` 无对应柱 → 400 `BAR_NOT_FOUND`。
4. 先 stub/fake 一根日线柱再 POST 成功；`GET` 用覆盖图表窗口的 `start`/`end` 能读到周期前文的点。
5. `DELETE` 预置类型 → 400 `MARK_TYPE_PRESET`。
6. `GET /api/trading/bs-chart?symbol=&timeframe=30m&start=&end=` 在无 minutes 的测试 provider 下 200 且 `available=false`。

Pydantic：`CreateChartMarkRequest` extra forbid；`comment` max 1000；`timeframe` 仅 `1d`|`30m`（只用于验柱）。

错误码映射进现有 `TradingServiceError.code`：`DUPLICATE_TYPE`、`MARK_TYPE_IN_USE`、`MARK_TYPE_PRESET`、`BAR_NOT_FOUND` 均为 400；`REVISION_CONFLICT` 409。

- [ ] **Step 3: 实现路由**

`GET/POST/PATCH/DELETE` 路径与 spec 一致。`bs-summary` 在无账户时与其它交易 GET 一样 404。创建手标前 `ensure_preset_mark_types`。

- [ ] **Step 4: 测试通过并提交**

```bash
uv run --offline pytest -q tests/api/test_trading_api.py tests/api/test_trading_chart_marks.py tests/api/test_trading_bs_analysis.py
git add apps/api/app/trading/api.py apps/api/app/trading/service.py tests/api/test_trading_api.py
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(trading): expose BS analysis and chart-mark HTTP APIs"
```

---

### Task 6: 前端契约

**Files:**

- Modify: `apps/web/src/trading-types.ts`
- Modify: `apps/web/src/trading-api.ts`
- Modify: `apps/web/src/trading-api.test.ts`
- Modify: `apps/web/src/ReviewCenterPage.test.tsx`（`apiForReview` 补新方法，先保持页面测试绿）

- [ ] **Step 1: 写失败的适配器测试**

严格解析：

- `BsSummary.symbols[].realizedPnl` 十进制字符串；`winRate` 为 `NullableDecimalMetric`。
- `BsChart.adjustment === "none"`；必须有 `executions` 数组；`macd.dif/dea/histogram` 要么空要么与 `bars.length` 相等。
- 缺 `executions` 键的响应必须抛 `ApiError`。
- `ChartMark.occurredAt` 过现有 `DATE_TIME`；`comment` 字符串。
- 未知字段或缺字段抛 `ApiError`。
- `createMockTradingApi` 实现新方法，避免 App 在无后端时崩溃。

- [ ] **Step 2: 实现类型与 `TradingApi` 方法**

`getBsSummary`、`getBsChart`、`listChartMarks`、`createChartMark`、`updateChartMark`、`deleteChartMark`、`listChartMarkTypes`、`createChartMarkType`、`updateChartMarkType`、`deleteChartMarkType`。
`listChartMarks` 必须把图表实际 `bars` 窗口传给 `start`/`end`。

- [ ] **Step 3: 测试通过并提交**

```bash
npm --prefix apps/web test -- --run src/trading-api.test.ts src/ReviewCenterPage.test.tsx
git add apps/web/src/trading-types.ts apps/web/src/trading-api.ts apps/web/src/trading-api.test.ts apps/web/src/ReviewCenterPage.test.tsx
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(web): add BS analysis API types and adapters"
```

---

### Task 7: BS 图 ECharts 配置

**Files:**

- Create: `apps/web/src/bs-chart-option.ts`
- Create: `apps/web/src/bs-chart-option.test.ts`
- Create: `apps/web/src/BsChart.tsx`
- Create: `apps/web/src/BsChart.test.tsx`

- [ ] **Step 1: 写失败测试**

`buildBsChartOption(chart, marks, types, periodStart, periodEnd)`：

- 三个 grid：K 线、成交量、MACD。
- scatter：实盘买 `#f6465d` 向上三角，卖 `#4a90e2` 向下三角；数据来自 `chart.executions`，不是手标。
- 手标用类型 `letter`+`color`；同一根日 K 多条都在 `series.data` 里。
- `macd.ready===false` 时 MACD series 为空或全 null，不发明柱。
- `dataZoom.start` 对准 `periodStart`（找不到则 0）。
- 零盈亏不在这个文件处理。

`BsChart`：无 bars 且 `available===false` 显示「行情不可用」；MACD 未就绪显示「MACD 未就绪」；容器 `role="img"`。
接受 `highlightOccurredAt: string | null`：非空时 `dispatchAction` 把 axisPointer 移到对应类目（日线用日期，30 分钟用柱时间）；测试用 fake echarts 断言调用了 highlight/updateAxisPointer，不必真渲染 canvas。

- [ ] **Step 2: 实现 option 与组件**

生命周期照抄 `TradingReviewChart`（init/dispose/ResizeObserver）。点击 K 线通过 `onSelectBar(occurredAt)` 回调，不在 option 里直接 POST。
在 Task 7 落地 `highlightOccurredAt`，Task 8 只接线，不再改 `BsChart` 的公开 API。

- [ ] **Step 3: 测试通过并提交**

```bash
npm --prefix apps/web test -- --run src/bs-chart-option.test.ts src/BsChart.test.tsx
git add apps/web/src/bs-chart-option.ts apps/web/src/bs-chart-option.test.ts apps/web/src/BsChart.tsx apps/web/src/BsChart.test.tsx
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(web): render BS candlestick volume and MACD chart"
```

---

### Task 8: 复盘中心接入 BS 分析

**Files:**

- Create: `apps/web/src/BsAnalysisPanel.tsx`
- Create: `apps/web/src/BsAnalysisPanel.test.tsx`
- Modify: `apps/web/src/ReviewCenterPage.tsx`
- Modify: `apps/web/src/ReviewCenterPage.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 影响分析**

```bash
npx gitnexus impact -r investment-advisor ReviewCenterPage --direction upstream
```

- [ ] **Step 2: 写失败的页面测试**

确定性报告 ready 后：

1. **不再**出现「权益、回撤与真实买卖点」和旧 `aria-label` 里的缠论复盘图。账户指标带（已实现盈亏/胜率等 `MetricBand`）仍在盈亏块上方。
2. `getBsSummary.symbols=[]` 时盈亏块空态，不渲染假股票，也不请求/绘制个股图。
3. 有股票但尚未点选时不画个股图。
4. 出现盈亏块；`realizedPnl` 为 0 的块可见且中性（class 或 style 含 `#bbcbb2` / `tone-neutral`）。
5. 点一块进入个股：默认 BS 点分析、日线；可切 30 分钟；展示建清仓次数、平均持仓、成功率三个数（无闭合周期时成功率与均持仓为「—」，次数为 0）。
6. 可切交易记录列表（该股本周期成交）。点一行调用图表把十字线移到对应 K 线（测试可用 `scrollToBar`/`highlight` 回调），不打开成交编辑。
7. 点 K 线（通过 `BsChart` 测试回调或 panel 内对话框）可选预置类型、填评论、保存；同一根再存第二条仍显示两条。停用的类型不出现在选择器，已有手标仍按原字母颜色画。
8. 可「+ 新类型」，请求体只有名称、字母、颜色。
9. `getBsChart` 30 分钟 `available=false` 时展示不可用，日线请求不受影响。

`apiForReview` 补 fake：`getBsSummary` 返回夹具股票，`getBsChart`/`listChartMarks` 等。

- [ ] **Step 3: 实现 Panel 并替换主图**

`ReviewCenterPage` 在 `deterministic` 存在时保留现有 `MetricBand`，其下渲染 `BsAnalysisPanel`（传入 `periodStart/End`、`api`）。理由矩阵、周期列表、比较、结构归因保留。不要删除 `TradingReviewChart.tsx` 文件。
交易记录行点击时把已有 `highlightOccurredAt` 传给 `BsChart`，不再改它的公开 API。实盘 B/S scatter 只读 `chart.executions`，手标只读 `listChartMarks` 结果。停用类型第一版只需选择器过滤，不做单独停用界面。

盈亏块面积用 `|realizedPnl|`，零值最小宽度与盈利块下限相同。

- [ ] **Step 4: 测试通过并提交**

```bash
npm --prefix apps/web test -- --run src/ReviewCenterPage.test.tsx src/BsAnalysisPanel.test.tsx src/BsChart.test.tsx
npm --prefix apps/web run typecheck
git add apps/web/src/BsAnalysisPanel.tsx apps/web/src/BsAnalysisPanel.test.tsx apps/web/src/ReviewCenterPage.tsx apps/web/src/ReviewCenterPage.test.tsx apps/web/src/styles.css
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat(web): replace review chart with Tonghuashun-style BS analysis"
```

---

### Task 9: README 与回归

**Files:**

- Modify: `README.md`

- [ ] **Step 1: 在「Pi 安全边界」或交易复盘节补一段**

说明：周期复盘个股 BS 分析、手标不进账本、Pi 不读手标、30 分钟失败不影响日线。

- [ ] **Step 2: 全量回归**

```bash
uv run --offline pytest -q tests/api
npm test
npx tsc --noEmit
npm --prefix apps/web test -- --run
npm --prefix apps/web run typecheck
```

Expected: PASS。浏览器：`#/journal` 进复盘中心，生成/预览周期后点盈亏块，切换日线/30 分钟，钉一条理想买和一条复盘点，确认统计数字不因手标改变。

- [ ] **Step 3: 提交 README**

```bash
git add README.md
git commit -m "docs: describe trading BS analysis marks and MACD pane"
```

---

## 验证清单

- 盈亏块成员 = 本周期有成交的股票；块金额之和 = 账户本周期已实现盈亏。
- 手标增删不改变已实现盈亏、成功率、建清仓次数。
- 日线点在 30 分钟图只出现在当天最后一根 30 分 K。
- `compute_macd` 旧 histogram/面积测试仍绿。
- 30 分钟不可用 → HTTP 200 + 日线可用。
- 复盘页不再展示权益+缠论主图。
