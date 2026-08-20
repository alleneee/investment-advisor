# 真实缠论图表实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实前复权 K 线、确认笔、形成中笔和笔中枢替换静态占位图，
支持日周切换和六个月默认窗口。

**Architecture:** 后端在现有分析响应中补充未经过包含处理的前复权 K 线；
前端适配层将 ChanEngine 的结构索引转换为日期坐标。纯函数生成 ECharts
配置，独立 React 组件管理实例，`App` 使用显式标的和周期请求并按键缓存。

**Tech Stack:** Python 3.13、FastAPI、pytest、React 19、TypeScript 5.8、
ECharts 5.6、Vitest、Testing Library、Vite 6。

---

## 文件结构

- 修改 `apps/api/app/analysis.py`：在行情快照中返回原始前复权 K 线。
- 修改 `tests/api/test_analysis.py`：锁定原始 K 线与结构 K 线的区别。
- 修改 `tests/api/test_tushare_provider.py`：锁定日线与周线的五年查询窗口。
- 修改 `apps/web/src/types.ts`：增加周期与图表强类型。
- 修改 `apps/web/src/api.ts`：显式标的请求、数据校验和日期坐标映射。
- 创建 `apps/web/src/api.test.ts`：测试分析响应到报告的转换。
- 创建 `apps/web/src/chan-chart-option.ts`：纯函数生成 ECharts 配置。
- 创建 `apps/web/src/chan-chart-option.test.ts`：测试真实图形序列和默认窗口。
- 创建 `apps/web/src/ChanChart.tsx`：管理 ECharts 生命周期。
- 创建 `apps/web/src/ChanChart.test.tsx`：测试初始化、更新、缩放和释放。
- 修改 `apps/web/src/App.tsx`：报告缓存、日周切换、失败回退和真实图表布局。
- 修改 `apps/web/src/App.test.tsx`：测试显式请求、切换、缓存和乱序响应。
- 修改 `apps/web/src/styles.css`：真实图表容器、周期按钮、加载和错误样式。
- 修改 `README.md`：记录真实图表能力、交互和验证命令。

### Task 1：后端返回原始前复权 K 线

**Files:**

- Modify: `tests/api/test_analysis.py`
- Modify: `tests/api/test_tushare_provider.py`
- Modify: `apps/api/app/analysis.py`

- [ ] **Step 1：先写失败测试**

在现有接口测试中构造存在包含关系的三根 K 线，断言：

```python
assert len(payload["market_snapshot"]["bars"]) == 3
assert Decimal(payload["market_snapshot"]["bars"][0]["close"]) == Decimal("8")
assert len(payload["chan_analysis"]["snapshot"]["bars"]) < 3
```

在 provider 测试中记录 `daily` 和 `adj_factor` 的参数，断言日线请求开始日期为
`as_of - timedelta(days=365 * 5)`，结束日期为 `as_of`。周线调用必须复用相同日线
窗口，并仅在该窗口内聚合已结束周。

- [ ] **Step 2：运行测试并确认因缺少 `market_snapshot.bars` 失败**

Run:

```bash
uv run --offline pytest -q \
  tests/api/test_analysis.py tests/api/test_tushare_provider.py
```

- [ ] **Step 3：最小实现**

在 `MarketAnalysisService.analyze()` 中使用送入 ChanEngine 之前的已排序
`CanonicalBar` 列表：

```python
"bars": [bar.as_dict() for bar in bars],
```

不得改动 `chan_analysis.snapshot.bars`。

- [ ] **Step 4：运行后端定向测试**

Run:

```bash
uv run --offline pytest -q \
  tests/api/test_analysis.py tests/api/test_tushare_provider.py
```

### Task 2：建立前端图表数据契约和安全适配

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/api.test.ts`

- [ ] **Step 1：为转换函数写失败测试**

测试夹具必须同时包含原始 K 线、包含处理后的结构 K 线、确认笔、形成中笔和
中枢。断言：

```ts
expect(report.chart.bars).toHaveLength(3);
expect(report.chart.bars[0].volume).toBe(80);
expect(report.chart.strokes[0]).toMatchObject({
  startAt: "2024-08-01T00:00:00Z",
  endAt: "2024-08-05T00:00:00Z",
  state: "confirmed",
});
expect(report.chart.centers[0]).toMatchObject({
  startAt: "2024-08-01T00:00:00Z",
  endAt: "2024-08-05T00:00:00Z",
});
```

另写以下失败用例：

- 原始 K 线存在非有限 OHLC 时抛出 `ApiError`。
- 原始 K 线的数字字符串成交量转换为 `number`，缺失成交量保持 `null`。
- 原始 K 线日期重复或未严格升序时抛出 `ApiError`。
- 结构索引越界时只过滤该对象，不改变其他对象日期。
- 结构价格非有限或端点日期反向时只过滤该对象。
- 中枢 `lower >= upper` 时只过滤该中枢。

- [ ] **Step 2：运行测试并确认因类型和转换缺失失败**

Run: `npm --prefix apps/web test -- src/api.test.ts`

- [ ] **Step 3：增加类型和转换**

增加 `Timeframe`、`ChartBar`、`ChartStroke`、`ChartCenter`、
`ChanChartData`，并让 `Report` 包含 `timeframe` 与 `chart`。

将 `WorkbenchApi.getReport` 收紧为：

```ts
getReport(symbol: string, timeframe: Timeframe): Promise<Report>;
```

导出 `toReport(symbol, timeframe, payload)` 供真实转换测试使用。原始 K 线必须
严格校验有限 OHLC、唯一且升序日期；结构对象用结构 K 线索引转换日期，单个
无效结构对象过滤。`volume` 存在时必须转换为有限 `number`，缺失时为 `null`。

同步机械更新现有 `App.tsx` 调用和 `App.test.tsx` 报告夹具，使其传入明确标的、
默认日线并补齐必填图表字段；此步不实现缓存、周期按钮或乱序响应行为。

- [ ] **Step 4：运行适配测试**

Run: `npm --prefix apps/web test -- src/api.test.ts`

Run: `npm --prefix apps/web run typecheck`

### Task 3：以纯函数生成 ECharts 配置

**Files:**

- Create: `apps/web/src/chan-chart-option.test.ts`
- Create: `apps/web/src/chan-chart-option.ts`

- [ ] **Step 1：写失败测试**

断言配置包含：

- `candlestick` 序列，数据顺序为 `[open, close, low, high]`。
- 已确认笔实线、形成中笔虚线。
- 中枢 `markArea` 使用日期和上下沿。
- `inside` 与 `slider` 两种 `dataZoom`。
- 900 根日线默认约显示最后 126 根，260 根周线默认约显示最后 26 根。
- Tooltip 配置能够展示日期、OHLC、笔状态和中枢范围。
- K 线涨跌色、两类笔颜色、中枢半透明填充和边框与设计规范一致。

- [ ] **Step 2：运行测试并确认模块缺失**

Run: `npm --prefix apps/web test -- src/chan-chart-option.test.ts`

- [ ] **Step 3：最小实现配置生成器**

`buildChanChartOption(data)` 不访问 DOM。每一笔生成一条两点 `line` 序列，
所有有效中枢放在独立辅助序列的 `markArea.data`。Tooltip formatter 根据系列类型
展示 OHLC、笔状态或中枢范围。关闭动画以保证报告视图稳定。

- [ ] **Step 4：运行配置测试**

Run: `npm --prefix apps/web test -- src/chan-chart-option.test.ts`

### Task 4：实现 ECharts React 组件

**Files:**

- Create: `apps/web/src/ChanChart.test.tsx`
- Create: `apps/web/src/ChanChart.tsx`

- [ ] **Step 1：写组件失败测试**

Mock `echarts/core`，断言：

- 有数据时初始化并设置配置。
- 数据更新时复用实例。
- 从多笔报告更新为少笔报告时不残留旧系列。
- `ResizeObserver` 触发 `resize()`。
- 卸载时 `disconnect()` 并 `dispose()`。
- 空 K 线显示“当前周期暂无可绘制行情”。
- DOM 图例包含“已确认笔”“形成中笔”“笔中枢”。

- [ ] **Step 2：运行测试并确认组件缺失**

Run: `npm --prefix apps/web test -- src/ChanChart.test.tsx`

- [ ] **Step 3：实现组件**

按需注册 `CandlestickChart`、`LineChart`、`TooltipComponent`、
`DataZoomComponent`、`GridComponent`、`MarkAreaComponent` 和
`CanvasRenderer`。组件通过 ref 初始化，配置变化调用
`setOption(option, { notMerge: true })`，卸载释放实例。图例使用 React DOM，明确展示
“已确认笔”“形成中笔”“笔中枢”。

- [ ] **Step 4：运行组件测试**

Run: `npm --prefix apps/web test -- src/ChanChart.test.tsx`

### Task 5：接入报告、周期切换与缓存

**Files:**

- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1：更新夹具并写失败测试**

所有 `WorkbenchApi` 夹具使用 `getReport(symbol, timeframe)`。新增测试：

- 初始首项显式请求 `600519.SH, 1d`。
- 点击周线请求 `600519.SH, 1w`，成功后切换报告和选中态。
- 再次切换已加载周期不重复请求。
- 周线失败时仍显示日线，再次点击周线会真正重试。
- 周线加载中继续展示日线，日线保持选中，周线按钮显示加载中。
- 首次日线加载失败显示现有“数据服务暂不可用”提示。
- 切回日线后，迟到的周线响应不能覆盖日线。
- 新增标的后立即清空旧标的报告，再请求该标的日线。
- 旧标的迟到响应不能覆盖新标的报告。
- 空 K 线报告集成显示明确空状态。

- [ ] **Step 2：运行应用测试并确认新行为缺失**

Run: `npm --prefix apps/web test -- src/App.test.tsx`

- [ ] **Step 3：实现状态机和布局**

`App` 持有 `currentSymbol`、报告缓存、当前请求键和加载周期。报告选中态只读取
`report.timeframe`。周线失败显示图表局部错误，不改变日线报告。用 `ChanChart`
替换 `chart-mock`，保留右侧结构摘要。

- [ ] **Step 4：运行应用测试**

Run: `npm --prefix apps/web test -- src/App.test.tsx`

### Task 6：文档、回归和真实浏览器验收

**Files:**

- Modify: `README.md`

- [ ] **Step 1：更新 README**

说明日线/周线、真实前复权 K 线、确认/形成中笔、中枢、默认六个月和完整五年
缩放。同步当前测试命令，不写固定测试数量。

- [ ] **Step 2：运行完整自动化验证**

```bash
uv run --offline pytest -q tests/api
uv run --offline ruff check apps/api tests/api
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-12-chan-chart-design.md \
  docs/superpowers/plans/2026-08-12-chan-chart.md
```

- [ ] **Step 3：使用昂利康做真实浏览器验收**

确认项目根 `.env` 已提供 `TUSHARE_TOKEN`、`TUSHARE_API_URL` 和
`VITE_API_BASE_URL=http://127.0.0.1:8000`，然后分别启动：

```bash
uv run --env-file .env uvicorn app.main:app --app-dir apps/api \
  --host 127.0.0.1 --port 8000
npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5173
```

若自选池没有昂利康，通过页面输入 `002940` 并点击“加入自选”。

在 `http://127.0.0.1:5173/#/batch` 验证：

- 网络请求包含 `002940.SZ` 的 `1d` 和按需 `1w`，状态均为 200。
- 图表区域存在 ECharts Canvas，不存在 `chart-mock` 和固定价格标签。
- 默认窗口约六个月，底部滑块可缩放到完整五年。
- 确认笔、形成中笔和中枢样式可区分。
- 悬停能够看到日期、OHLC、笔状态和中枢范围。
- 图表展示数量与当次接口有效结构数量一致。
- 控制台没有项目业务错误。

- [ ] **Step 4：检查服务仍可访问**

Run:

```bash
curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/
curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/docs
```
