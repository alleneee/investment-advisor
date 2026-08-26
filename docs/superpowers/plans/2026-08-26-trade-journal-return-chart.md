# 交易日记周期收益曲线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在交易日记的月、周、季、年视图中展示按资金流调整、以周期首个正净值点归零的累计收益曲线。

**Architecture:** 扩展现有周期摘要接口，在后端净值模块中生成归一化收益点；
前端适配同一契约，并以独立 ECharts 组件展示。`TradeJournalPage`
继续负责周期边界和请求生命周期，列表视图不请求周期摘要。

**Tech Stack:** Python 3.12、FastAPI、Decimal、React 19、TypeScript、ECharts 5、Vitest、pytest

---

## 文件结构

- 修改 `apps/api/app/trading/metrics.py`：提供纯函数 `period_return_curve`。
- 修改 `apps/api/app/trading/service.py`：周期摘要附带收益曲线。
- 修改 `tests/api/test_trading_metrics.py`：覆盖归一化、资金流和零净值边界。
- 修改 `apps/web/src/trading-types.ts`：声明周期收益点类型。
- 修改 `apps/web/src/trading-api.ts`：严格解析 `return_curve`。
- 修改 `apps/web/src/trading-api.test.ts`：验证适配器成功和失败路径。
- 新建 `apps/web/src/journal-return-chart-option.ts`：纯 ECharts 配置生成器。
- 新建 `apps/web/src/journal-return-chart-option.test.ts`：验证图表语义和配色。
- 新建 `apps/web/src/JournalReturnChart.tsx`：负责图表生命周期和展示状态。
- 新建 `apps/web/src/JournalReturnChart.test.tsx`：覆盖加载、空态和可绘制状态。
- 修改 `apps/web/src/TradeJournalPage.tsx`：请求并放置当前周期收益图。
- 修改 `apps/web/src/TradeJournalPage.test.tsx`：覆盖四个周期和列表排除规则。
- 修改 `apps/web/src/styles.css`：收益图卡片和窄屏样式。
- 修改 `README.md`：说明交易日记周期收益曲线。

## 工作区约束

目标文件已有用户未提交改动。实施时只追加本计划所需修改，不清理、不还原、不整体暂存这些文件。任务检查点运行测试和 `git diff`，但不提交业务改动；如用户后续要求提交，再使用交互式暂存精确选择本次补丁。

### Task 1：生成后端周期累计收益点

**Files:**

- Modify: `tests/api/test_trading_metrics.py`
- Modify: `apps/api/app/trading/metrics.py`

- [ ] **Step 1：对将修改的既有符号做影响分析**

Run:

```bash
npx gitnexus impact -r investment-advisor build_nav --direction upstream --include-tests
```

Expected: 输出调用者和风险等级；本任务不修改 `build_nav`，只确认新增函数复用的净值契约。若为 HIGH 或 CRITICAL，先向用户报告再继续。

- [ ] **Step 2：写归一化收益曲线失败测试**

在 `tests/api/test_trading_metrics.py` 导入 `period_return_curve`，新增测试，明确覆盖周期外点、基准前零净值、基准点、后续上涨、不可用点和基准后归零：

```python
def test_period_return_curve_normalizes_positive_nav_and_keeps_gaps() -> None:
    points = [
        NavPoint(
            date(2026, 1, 2), Decimal(0), Decimal(0), None, Decimal(0), None
        ),
        NavPoint(
            date(2026, 1, 5), Decimal(100), Decimal(100), None,
            Decimal(1), Decimal(0),
        ),
        NavPoint(
            date(2026, 1, 6), Decimal(110), Decimal(0), None,
            Decimal("1.1"), Decimal(0),
        ),
        NavPoint(
            date(2026, 1, 7), Decimal(110), Decimal(0), None, None, None,
            "zero_equity_baseline",
        ),
        NavPoint(date(2026, 1, 8), Decimal(0), Decimal(0), None, Decimal(0), Decimal(1)),
    ]

    assert period_return_curve(points, date(2026, 1, 2), date(2026, 1, 8)) == [
        {
            "date": "2026-01-02",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-05",
            "cumulative_return_rate": {"value": "0", "unavailable_reason": None},
        },
        {
            "date": "2026-01-06",
            "cumulative_return_rate": {"value": "0.1", "unavailable_reason": None},
        },
        {
            "date": "2026-01-07",
            "cumulative_return_rate": {
                "value": None,
                "unavailable_reason": "zero_equity_baseline",
            },
        },
        {
            "date": "2026-01-08",
            "cumulative_return_rate": {"value": "-1", "unavailable_reason": None},
        },
    ]
```

再新增全周期无正净值的测试，断言全部日期保留且全部为
`zero_equity_baseline`。

- [ ] **Step 3：运行测试并确认因缺少函数失败**

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py -k period_return_curve
```

Expected: FAIL，提示无法导入或找不到 `period_return_curve`。

- [ ] **Step 4：实现最小纯函数**

在 `window_max_drawdown` 附近新增：

```python
def period_return_curve(
    points: Sequence[NavPoint], start: date, end: date
) -> list[dict[str, Any]]:
    window = [point for point in points if start <= point.date <= end]
    base_index = next(
        (
            index
            for index, point in enumerate(window)
            if point.nav is not None and point.nav > 0
        ),
        None,
    )
    base_nav = None if base_index is None else window[base_index].nav
    result: list[dict[str, Any]] = []
    for index, point in enumerate(window):
        if base_nav is None or index < base_index or point.nav is None:
            metric = nullable_metric(
                None,
                point.unavailable_reason or "zero_equity_baseline",
            )
        else:
            metric = nullable_metric(point.nav / base_nav - Decimal(1), None)
        result.append(
            {
                "date": point.date.isoformat(),
                "cumulative_return_rate": metric,
            }
        )
    return result
```

把 `period_return_curve` 加入 `__all__`。若类型检查无法证明 `base_nav` 非空，仅在已建立分支内用局部变量收窄，不改为浮点数。

- [ ] **Step 5：运行定向测试和 Ruff**

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py -k period_return_curve
uv run --offline ruff check apps/api/app/trading/metrics.py tests/api/test_trading_metrics.py
```

Expected: 测试 PASS，Ruff 无错误。

### Task 2：扩展周期摘要 API

**Files:**

- Modify: `tests/api/test_trading_metrics.py`
- Modify: `apps/api/app/trading/service.py`

- [ ] **Step 1：运行 `period_summary` 上游影响分析**

Run:

```bash
npx gitnexus impact -r investment-advisor period_summary --direction upstream --include-tests
```

Expected: 识别 API 路由和前端调用者；若为 HIGH 或 CRITICAL，先向用户报告。

- [ ] **Step 2：扩展现有 API 失败测试**

在现有周期摘要集成测试中断言：

```python
curve = february_window.json()["return_curve"]
assert curve[0]["cumulative_return_rate"] == {
    "value": "0",
    "unavailable_reason": None,
}
assert [point["date"] for point in curve] == sorted(point["date"] for point in curve)
```

增加包含入金或出金的场景，断言资金流当天不会凭空改变累计收益率。

- [ ] **Step 3：运行 API 测试并确认缺字段失败**

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py \
  -k "period_summary or period_drawdown"
```

Expected: FAIL，响应中缺少 `return_curve`。

- [ ] **Step 4：让服务返回纯函数结果**

从 `metrics.py` 导入 `period_return_curve`，在 `TradingService.period_summary` 的返回值中增加：

```python
"return_curve": period_return_curve(nav, start, end),
```

不修改路由、查询参数和既有 `max_drawdown` 逻辑。

- [ ] **Step 5：运行后端定向回归**

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py
uv run --offline ruff check apps/api/app/trading/metrics.py \
  apps/api/app/trading/service.py tests/api/test_trading_metrics.py
```

Expected: 全部 PASS。

### Task 3：扩展前端周期摘要契约

**Files:**

- Modify: `apps/web/src/trading-types.ts`
- Modify: `apps/web/src/trading-api.ts`
- Modify: `apps/web/src/trading-api.test.ts`

- [ ] **Step 1：做前端契约影响分析**

Run:

```bash
npx gitnexus impact -r investment-advisor TradingPeriodSummary \
  --direction upstream --include-tests
npx gitnexus impact -r investment-advisor toPeriodSummary \
  --direction upstream --include-tests
```

Expected: 识别 `TradingApi`、交易日记和测试调用者；若风险为 HIGH 或 CRITICAL，先报告。

- [ ] **Step 2：写适配器失败测试**

给 `trading-api.test.ts` 增加成功响应：

```typescript
{
  start: "2026-08-01",
  end: "2026-08-31",
  max_drawdown: "0.0375",
  return_curve: [{
    date: "2026-08-03",
    cumulative_return_rate: { value: "0", unavailable_reason: null },
  }],
}
```

断言结果保留十进制字符串。再用
`{ value: null, unavailable_reason: null }` 断言适配器拒绝状态不一致的点。

- [ ] **Step 3：运行测试并确认精确字段校验失败**

Run:

```bash
npm --prefix apps/web test -- src/trading-api.test.ts
```

Expected: FAIL，旧适配器不接受 `return_curve`。

- [ ] **Step 4：声明并解析新类型**

在 `TradingPeriodSummary` 中增加：

```typescript
returnCurve: Array<{
  date: string;
  cumulativeReturnRate: NullableDecimalMetric;
}>;
```

`toPeriodSummary` 的精确字段列表加入 `return_curve`，并通过
`toNullableMetric` 解析每个点。校验日期位于 `start` 和 `end` 之间且按升序排列；重复或逆序日期返回适配错误。

同步更新 `createMockTradingApi` 和测试辅助 API 的周期摘要默认值为
`returnCurve: []`。

- [ ] **Step 5：运行适配器测试和类型检查**

Run:

```bash
npm --prefix apps/web test -- src/trading-api.test.ts
npm --prefix apps/web run typecheck
```

Expected: PASS。

### Task 4：实现纯收益图配置

**Files:**

- Create: `apps/web/src/journal-return-chart-option.ts`
- Create: `apps/web/src/journal-return-chart-option.test.ts`

- [ ] **Step 1：用 Context7 核对 ECharts 5 配置**

使用 `context7:context7-mcp` 查询 ECharts 5 的模块化 `LineChart`、类目轴、
轴触发 Tooltip、空值断线和 `setOption` 配置。只使用项目当前
`echarts@5.6.0` 支持的字段。

- [ ] **Step 2：写配置生成器失败测试**

测试至少断言：

- 横轴包含全部日期，包括不可用点。
- 收益序列保留 `null`，且 `connectNulls` 为 `false`。
- 零基准虚线序列与日期一一对应。
- 末值为正用 `#f6465d`，为负用 `#0ecb81`，为零用中性色。
- 曲线末尾为不可用点时，颜色仍取最后一个有效收益点。
- 纵轴和 Tooltip 把十进制比率格式化为百分比。
- 不可用日期的 Tooltip 展示不可用原因。

- [ ] **Step 3：运行测试并确认模块不存在**

Run:

```bash
npm --prefix apps/web test -- src/journal-return-chart-option.test.ts
```

Expected: FAIL，提示找不到配置模块。

- [ ] **Step 4：实现最小配置生成器**

导出：

```typescript
export function buildJournalReturnChartOption(
  curve: TradingPeriodSummary["returnCurve"],
): EChartsOption
```

使用一个实际收益折线序列和一个静默的 `0%` 虚线序列，不引入额外 ECharts
组件。数值仅用于图表显示时转为 `number`；API 和状态继续保存原始字符串。
Tooltip 根据 `axisValue` 回查原始点，显示日期、格式化收益率或不可用原因。

- [ ] **Step 5：运行配置测试**

Run:

```bash
npm --prefix apps/web test -- src/journal-return-chart-option.test.ts
```

Expected: PASS。

### Task 5：实现收益图组件及展示状态

**Files:**

- Create: `apps/web/src/JournalReturnChart.tsx`
- Create: `apps/web/src/JournalReturnChart.test.tsx`

- [ ] **Step 1：写组件失败测试**

模拟 `echarts/core` 的 `init`、`setOption`、`resize`、`dispose`，覆盖：

- `summary === undefined` 显示“正在读取收益曲线…”。
- 没有有效值显示“该周期暂无可用收益数据”。
- 单个有效点显示 `0.00%` 并调用 `setOption`。
- 正、负末值分别使用 `tone-gain`、`tone-loss`。
- 最后一个日期不可用时，标题仍显示最后一个有效收益值和对应颜色。
- 卸载时断开 `ResizeObserver` 并释放图表。

- [ ] **Step 2：运行组件测试并确认模块不存在**

Run:

```bash
npm --prefix apps/web test -- src/JournalReturnChart.test.tsx
```

Expected: FAIL，提示找不到组件。

- [ ] **Step 3：实现组件**

组件接口：

```typescript
interface JournalReturnChartProps {
  periodKind: "month" | "week" | "quarter" | "year";
  summary: TradingPeriodSummary | undefined;
}
```

注册 `LineChart`、`GridComponent`、`TooltipComponent` 和 `CanvasRenderer`。
沿用现有 `TradingReviewChart` 的 `useRef`、`ResizeObserver` 和卸载释放模式。
标题映射为“本月/本周/本季/本年累计收益”，末值使用 `formatRate`，图表容器的
`aria-label` 包含周期名称和“累计收益曲线”。

- [ ] **Step 4：运行组件测试和类型检查**

Run:

```bash
npm --prefix apps/web test -- src/JournalReturnChart.test.tsx
npm --prefix apps/web run typecheck
```

Expected: PASS。

### Task 6：接入交易日记四个周期视图

**Files:**

- Modify: `apps/web/src/TradeJournalPage.tsx`
- Modify: `apps/web/src/TradeJournalPage.test.tsx`

- [ ] **Step 1：运行页面影响分析并报告爆炸半径**

Run:

```bash
npx gitnexus impact -r investment-advisor TradeJournalPage \
  --direction upstream --include-tests
npx gitnexus context -r investment-advisor TradeJournalPage
```

Expected: 直接调用者主要为应用入口和页面测试。若风险为 HIGH 或 CRITICAL，必须先向用户警告。

- [ ] **Step 2：写页面集成失败测试**

模拟 `JournalReturnChart`，断言：

- 默认月视图调用 `getPeriodSummary("2026-08-01", "2026-08-31")`。
- 周、季、年分别使用既有周期边界。
- 前后翻页后请求新周期且不保留旧摘要。
- `initialView="list"` 不调用 `getPeriodSummary`，页面中无收益图。
- 图表位于月/周日历之后、周期复盘入口之前。

测试辅助 API 的摘要响应统一补充 `returnCurve`。

- [ ] **Step 3：运行页面测试并确认失败**

Run:

```bash
npm --prefix apps/web test -- src/TradeJournalPage.test.tsx
```

Expected: FAIL，月视图尚不请求摘要且页面没有收益图。

- [ ] **Step 4：修改请求生命周期**

把周期摘要 effect 的跳过条件从“列表或月”收窄为“仅列表”；依赖加入
`dayRevision`。每次请求前 `setPeriodSummary(undefined)`，继续使用 `active`
守卫忽略迟到响应。

只把开始、结束都匹配当前 `reviewBounds` 的摘要传给组件，防止周期切换瞬间显示旧数据。

- [ ] **Step 5：调整最小 JSX 顺序**

保持列表工作台和月周日历内容不变，把季年分支的复盘空状态从原三元表达式中拆出，然后按以下顺序渲染：

1. 月周日历或列表工作台。
2. 非列表视图的 `JournalReturnChart`。
3. 尚未打开时的周期复盘入口。
4. 已打开的 `ReviewCenterPage`。

- [ ] **Step 6：运行页面测试**

Run:

```bash
npm --prefix apps/web test -- src/TradeJournalPage.test.tsx
```

Expected: PASS。

### Task 7：样式、文档和整体验证

**Files:**

- Modify: `apps/web/src/styles.css`
- Modify: `README.md`

- [ ] **Step 1：添加收益图样式**

增加 `.journal-return-card`、`.journal-return-heading`、
`.journal-return-chart` 和空态样式。使用现有 ledger 变量、`--up`、`--down`，图表高度约 260px；窄屏只降低高度和标题字号，不改变信息顺序。

- [ ] **Step 2：更新 README**

在“交易日记与周期复盘”第一段后补充：月、周、季、年视图会直接请求当前周期摘要，并展示剔除资金流影响、以周期首个正净值点归零的累计收益曲线；列表视图不展示。

- [ ] **Step 3：运行前端定向测试与构建**

Run:

```bash
npm --prefix apps/web test -- src/trading-api.test.ts \
  src/journal-return-chart-option.test.ts \
  src/JournalReturnChart.test.tsx \
  src/TradeJournalPage.test.tsx
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Expected: 全部 PASS，构建成功。

- [ ] **Step 4：运行后端定向回归**

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py
uv run --offline ruff check apps/api/app/trading/metrics.py \
  apps/api/app/trading/service.py tests/api/test_trading_metrics.py
```

Expected: 全部 PASS。

- [ ] **Step 5：验证文档格式**

Run:

```bash
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-26-trade-journal-return-chart-design.md \
  docs/superpowers/plans/2026-08-26-trade-journal-return-chart.md
```

Expected: 0 issues。

- [ ] **Step 6：浏览器验收**

启动 API 和 Web，使用浏览器检查月、周、季、年四个视图及窄屏：曲线位置正确、周期切换不闪旧数据、正红负绿、Tooltip 和空态可读；列表视图不出现收益图。

- [ ] **Step 7：提交前范围检测**

Run:

```bash
npx gitnexus detect-changes -r investment-advisor
git diff --check
git status --short
```

Expected: 本次新增影响集中在周期摘要和交易日记收益图；既有脏工作区仍可能使 GitNexus 汇总为高风险，需把既有变化与本次变化分开报告。未经用户明确要求，不提交混有既有改动的目标文件。
