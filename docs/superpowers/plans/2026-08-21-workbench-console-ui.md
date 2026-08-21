# 工作台控制台 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作台五页和分享页改成同一套画布控制台：Lucide 图标、KPI + 双栏、红涨绿跌、可读数字，不改 API。

**Architecture:** `apps/web/src/ui/` 提供格式化、图标、KPI、Panel、SplitPane 和氛围层；各页只改拼装和 class。ECharts 只换色常量。`App.tsx` 数据逻辑不动。

**Tech Stack:** React 19、TypeScript、Vite 6、Vitest、Testing Library、lucide-react、ECharts 5、CSS 变量。

---

## 实施说明

- 规格：`docs/superpowers/specs/2026-08-21-workbench-console-ui-design.md`。
- TDD：每个行为先写失败测试，再写最小实现。CSS/氛围用现有页面测试 + 浏览器核对。
- 不改后端、hash、金额 JSON 精度。禁止把账本字段转成 `number` 做运算。
- 禁止 emoji 和用 `↗` `×` `!` 当图标。流水「价格 × 股数」的乘号保留。
- 提交只包含该任务文件，不要夹带仓库里未完成的 P2 改动。
- @superpowers:test-driven-development @superpowers:verification-before-completion

## 文件结构

- Create: `apps/web/src/ui/formatDisplay.ts` — `formatMoney` / `formatSignedMoney` / `formatRate` / `signedTone`
- Create: `apps/web/src/ui/formatDisplay.test.ts`
- Create: `apps/web/src/ui/Icon.tsx` — Lucide 统一出口
- Create: `apps/web/src/ui/Icon.test.tsx`
- Create: `apps/web/src/ui/MetricTile.tsx`、`KpiStrip.tsx`、`StatusChip.tsx` 及测试
- Create: `apps/web/src/ui/Panel.tsx`、`SplitPane.tsx`、`SegmentedControl.tsx`、`DataTable.tsx`、`EmptyState.tsx`、`Notice.tsx`
- Create: `apps/web/src/ui/Atmosphere.tsx`、`atmosphere-grain.png`
- Modify: `apps/web/package.json` — 增加 `lucide-react`
- Modify: `apps/web/src/styles.css` — 令牌、字体、`.ui-*`、壳、日记/复盘、reduced-motion
- Modify: `apps/web/src/TradeJournalPage.tsx`、`ReviewCenterPage.tsx`、`App.tsx`、`OutlookPanel.tsx`、`StockInformationPanel.tsx`、`SharedReportPage.tsx`
- Modify: `apps/web/src/chan-chart-option.ts`、`trading-review-chart-option.ts` 及对应测试
- Modify: `apps/web/src/TradeJournalPage.test.tsx`、`App.test.tsx`、图表测试中的可见金额/图标断言

色常量（ECharts 不能读 CSS 变量，源码写死与 spec 相同的 hex）：

```ts
const UP = "#f6465d";
const DOWN = "#0ecb81";
const ACCENT = "#7ee0c8";
const MUTED = "#8a9b96";
const RISK = "#f0b429";
```

---

### Task 1: formatDisplay

**Files:**

- Create: `apps/web/src/ui/formatDisplay.ts`
- Test: `apps/web/src/ui/formatDisplay.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { formatMoney, formatRate, formatSignedMoney, signedTone } from "./formatDisplay";

describe("formatDisplay", () => {
  it("groups only the integer side of decimal money text", () => {
    expect(formatMoney("100000.00")).toBe("100,000.00");
    expect(formatMoney("-350.50")).toBe("-350.50");
    expect(formatMoney("not-a-price")).toBe("not-a-price");
  });

  it("adds a plus to positive pnl and leaves zero unsigned", () => {
    expect(formatSignedMoney("350.50")).toBe("+350.50");
    expect(formatSignedMoney("-1280.00")).toBe("-1,280.00");
    expect(formatSignedMoney("0.00")).toBe("0.00");
  });

  it("formats 0-1 rates like the current UI", () => {
    expect(formatRate("1")).toBe("100.00%");
    expect(formatRate("-0.012")).toBe("-1.20%");
    expect(formatRate("0.0198")).toBe("1.98%");
    expect(formatRate("nope")).toBe("nope");
  });

  it("maps signed text to A-share tones", () => {
    expect(signedTone("350.50")).toBe("up");
    expect(signedTone("-1")).toBe("down");
    expect(signedTone("0.00")).toBe("neutral");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm --prefix apps/web test -- --run src/ui/formatDisplay.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现**

```ts
export type MetricTone = "up" | "down" | "risk" | "neutral";

export function formatMoney(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return match[3] == null ? `${match[1]}${grouped}` : `${match[1]}${grouped}.${match[3]}`;
}

export function formatSignedMoney(text: string): string {
  const formatted = formatMoney(text);
  if (formatted === text && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return text;
  if (/^-?0+(?:\.0+)?$/.test(text)) return formatMoney(text.replace(/^-/, ""));
  return text.startsWith("-") ? formatted : `+${formatted}`;
}

export function formatRate(text: string): string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  return `${(value * 100).toFixed(2)}%`;
}

export function signedTone(text: string): MetricTone {
  if (/^-?0+(?:\.0+)?$/.test(text)) return "neutral";
  return text.startsWith("-") ? "down" : "up";
}
```

- [ ] **Step 4: 再跑测试通过**

Run: `npm --prefix apps/web test -- --run src/ui/formatDisplay.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/formatDisplay.ts apps/web/src/ui/formatDisplay.test.ts
git commit -m "feat: add workbench display formatters"
```

---

### Task 2: Lucide Icon

**Files:**

- Modify: `apps/web/package.json`（`npm --prefix apps/web install lucide-react@0.469.0`）
- Create: `apps/web/src/ui/Icon.tsx`
- Test: `apps/web/src/ui/Icon.test.tsx`

- [ ] **Step 1: 安装依赖后写失败测试**

```ts
import { render } from "@testing-library/react";
import { Plus } from "lucide-react";
import { Icon } from "./Icon";

it("renders a lucide svg and hides it from the name when labelled by text", () => {
  const { container } = render(<button type="button">加入<Icon icon={Plus} /></button>);
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});
```

- [ ] **Step 2: 确认失败**

Run: `npm --prefix apps/web test -- --run src/ui/Icon.test.tsx`

Expected: FAIL，`Icon` 不存在。

- [ ] **Step 3: 实现**

```tsx
import type { LucideIcon } from "lucide-react";

export function Icon({ icon: Glyph, size = 18 }: { icon: LucideIcon; size?: number }) {
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" />;
}
```

独立图标按钮的 `aria-label` 写在调用方 `<button>` 上，不写在 `Icon` 里。

- [ ] **Step 4: 测试通过并 commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/ui/Icon.tsx apps/web/src/ui/Icon.test.tsx
git commit -m "feat: wrap lucide icons for the workbench"
```

---

### Task 3: MetricTile、StatusChip、KpiStrip

**Files:**

- Create: `apps/web/src/ui/MetricTile.tsx`、`StatusChip.tsx`、`KpiStrip.tsx`
- Test: `apps/web/src/ui/MetricTile.test.tsx`

- [ ] **Step 1: 失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import { KpiStrip } from "./KpiStrip";
import { MetricTile } from "./MetricTile";
import { StatusChip } from "./StatusChip";

it("colors pnl red for gains and green for losses", () => {
  const { rerender } = render(<MetricTile label="当日盈亏" value="+350.50" tone="up" />);
  expect(screen.getByText("+350.50").className).toMatch(/tone-up/);
  rerender(<MetricTile label="当日盈亏" value="-1,280.00" tone="down" />);
  expect(screen.getByText("-1,280.00").className).toMatch(/tone-down/);
  rerender(<MetricTile label="回撤" value="-3.25%" tone="risk" detail="成立以来" />);
  expect(screen.getByText("-3.25%").className).toMatch(/tone-risk/);
  expect(screen.getByText("成立以来")).toBeInTheDocument();
});

it("allows a status chip as a kpi value", () => {
  render(<KpiStrip><MetricTile label="本批状态" value={<StatusChip tone="risk" label="降级" />} /></KpiStrip>);
  expect(screen.getByText("降级")).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试失败**

Run: `npm --prefix apps/web test -- --run src/ui/MetricTile.test.tsx`

- [ ] **Step 3: 实现**

`MetricTile`：`label` 与值是兄弟节点（`<span>标签</span><strong class="ui-metric-value tone-*">`），这样 `App.test.tsx` 的 `getByText("FROZEN").nextElementSibling` 仍能读到 `01`。

`StatusChip`：`label` + `tone`（`up|down|risk|neutral`），class `ui-chip`。

`KpiStrip`：`<div className="ui-kpi" role="group">{children}</div>`。

先把色 class 写进 `styles.css` 末尾最小块，整页换肤放到 Task 5：

```css
.tone-up { color: #f6465d; }
.tone-down { color: #0ecb81; }
.tone-risk { color: #f0b429; }
.tone-neutral { color: #eef4f0; }
```

- [ ] **Step 4: 测试通过并 commit**

```bash
git commit -m "feat: add kpi tiles and status chips"
```

---

### Task 4: 布局零件

**Files:**

- Create: `apps/web/src/ui/Panel.tsx`、`SplitPane.tsx`、`SegmentedControl.tsx`、`DataTable.tsx`、`EmptyState.tsx`、`Notice.tsx`
- Test: `apps/web/src/ui/layout.test.tsx`（薄）

- [ ] **Step 1: 失败测试**

```tsx
it("keeps notice as an alert with a lucide icon instead of a bang", () => {
  render(<Notice title="数据服务暂不可用" detail="upstream" />);
  expect(screen.getByRole("alert")).toHaveTextContent("数据服务暂不可用");
  expect(screen.getByRole("alert").querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("alert").textContent).not.toContain("!");
});

it("renders empty copy and split children", () => {
  render(<SplitPane left={<Panel title="左">L</Panel>} right={<EmptyState title="该周期还没有固化报告。" />} />);
  expect(screen.getByText("左")).toBeInTheDocument();
  expect(screen.getByText("该周期还没有固化报告。")).toBeInTheDocument();
});
```

- [ ] **Step 2–4: 实现后通过**

- `Panel({ title, heading?, children, className, as })` — 默认 `<section className="ui-panel">`。
- `SplitPane({ left, right })` — `.ui-split`。
- `SegmentedControl` — 把现有 `aria-pressed` 按钮组包进 `.ui-segment`；**不要改按钮 name**。
- `DataTable` — 给 `<table>` 加 `className="ui-table"`，保留调用方 `aria-label`。
- `EmptyState({ title, action? })` — Lucide `Inbox` + 标题。
- `Notice({ title, detail })` — `role="alert"` class `notice`，`<Icon icon={AlertTriangle} />`。

`SegmentedControl` 若只是 class 包装，允许页面继续手写按钮组，只保证 class 为 `ui-segment`。

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add console layout primitives"
```

---

### Task 5: 令牌、字体、氛围层

**Files:**

- Create: `apps/web/src/ui/Atmosphere.tsx`
- Create: `apps/web/src/ui/atmosphere-grain.png`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.tsx`（只挂 Atmosphere，逻辑不动）

- [ ] **Step 1: 生成 grain 并写 Atmosphere**

```bash
python3 - <<'PY'
import pathlib, random, struct, zlib
random.seed(21)
def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
w = h = 128
raw = b"".join(b"\x00" + bytes(random.randint(70, 190) for _ in range(w)) for _ in range(h))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
pathlib.Path("apps/web/src/ui/atmosphere-grain.png").write_bytes(png)
PY
```

`Atmosphere.tsx`：`className="ui-atmosphere"`，`aria-hidden`，`pointer-events: none`。背景用 CSS 径向光 + `atmosphere-grain.png` 平铺。Canvas 微噪必须写成：

```ts
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
if (reduced || typeof window.matchMedia !== "function") return;
```

jsdom 没有 `matchMedia`。禁止直接 `window.matchMedia(...)`，否则 `App.test.tsx` 一挂 `Atmosphere` 就会抛。不要在 `test-setup.ts` 里为了过测试去 mock，除非以后有专门测 canvas 的用例。

在 `Workbench` 根节点内、`.rail` 前插入 `<Atmosphere />`。分享页不要挂。`.app-shell` / `.main-column` `position: relative; z-index: 1`。

- [ ] **Step 2: 替换 `styles.css` 顶部令牌和字体**

```css
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Syne:wght@600;700;800&display=swap");

:root {
  --bg: #05080c;
  --bg-elev: #0b1218;
  --surface: #101920cc;
  --border: rgba(214, 232, 222, 0.12);
  --text: #eef4f0;
  --muted: #8a9b96;
  --accent: #7ee0c8;
  --up: #f6465d;
  --down: #0ecb81;
  --risk: #f0b429;
  --radius-control: 2px;
  --radius-card: 18px;
  font-family: "IBM Plex Sans", "PingFang SC", "Noto Sans SC", sans-serif;
  color: var(--text);
  background: var(--bg);
}
```

然后：

- `body` / `.app-shell` 用 `var(--bg)`。删掉珊瑚主按钮阴影、01/02 当视觉主角（class 可留但默认隐藏 `.section-index`）。
- `.primary-button`：背景 `var(--accent)`，文字 `#05080c`，圆角 `var(--radius-control)`。
- `.ui-panel` 玻璃：`background: var(--surface); backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: var(--radius-card)`。
- `.ui-split`：`grid-template-columns: 0.9fr 1.3fr`；`@media (max-width: 1100px) { 1fr }`。
- `.ui-kpi`：`repeat(auto-fit, minmax(140px, 1fr))`；1100px 最多 3 列；700px 2 列。
- `h1`：`font-family: Syne`，可略 clip。
- `@media (prefers-reduced-motion: reduce)`：`*` 动画/transition 只保留 color。

不要一次性删除全部旧 class（页面还在用）；先让旧 class 也改引用变量，避免未改页面的一帧断裂。

- KPI 数字 32px / 标签 11px（覆盖旧 `.snapshot-card strong` 36px 宋体）。
- `@media (max-width: 520px)`：`h1` 缩小。加载骨架用 `.ui-skeleton`，不要 emoji。

- [ ] **Step 3: 现有前端测试应仍通过（本任务不改编排）**

Run: `npm --prefix apps/web test`

Expected: PASS。若 `Atmosphere` 抛 `matchMedia is not a function`，修可选链，不要改 App 测试、也不要把失败当成 CSS 特异性。

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add console canvas tokens and atmosphere"
```

---

### Task 6: 交易日记拼装

**Files:**

- Modify: `apps/web/src/TradeJournalPage.tsx`
- Modify: `apps/web/src/TradeJournalPage.test.tsx`

- [ ] **Step 1: 先改测试里的可见金额**

把 `expect(screen.getByText("100000.00"))` 改为 `getByText("100,000.00")`。其它查询（「创建交易账户」「每日交易日记」「创建并进入日记」、表格 `aria-label`）保持。

Run: `npm --prefix apps/web test -- --run src/TradeJournalPage.test.tsx`

Expected: FAIL on `100,000.00`。

- [ ] **Step 2: 按 spec 拼装**

无账户：`Panel` 里用真正的 `h2`「创建交易账户」（测试查 heading），不要 KPI。
`Panel` 的 `title` 必须渲染成 `h2`/`h3`，不能只是 div。

有账户：

1. 页头 `h2`「每日交易日记」+ 日期。
2. `KpiStrip`：总权益 `formatMoney`；现金/市值 `formatMoney`；当日盈亏 `formatSignedMoney` + `signedTone`；回撤 `formatRate` + `tone="risk"`。`null` 显示 `—`。
3. `SplitPane`：左持仓 `DataTable` `aria-label="持仓明细"`；右上成交录入，右下今日流水 **和资金流水表单**（字段顺序不变）。
4. 全宽收盘检查。
5. 去掉 `SectionHeading` 的 01/02 装饰；「每日交易日记」「当前持仓」等必须仍是 heading。
6. 删除 `×` 类图标按钮（日记删除用现有「删除」文字按钮即可）。
7. 持仓表、流水金额、资金金额都走 `formatMoney` / `formatSignedMoney`。`20.20` 不变；
   `100000.00` 才变成 `100,000.00`。乘号「价格 × 股数」保留。

- [ ] **Step 3: 测试通过**

Run: `npm --prefix apps/web test -- --run src/TradeJournalPage.test.tsx`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: restyle trade journal as kpi split console"
```

---

### Task 7: 复盘中心拼装

**Files:**

- Modify: `apps/web/src/ReviewCenterPage.tsx`
- Modify: `apps/web/src/ReviewCenterPage.test.tsx`（仅当可见金额/百分比断言失败时）

- [ ] **Step 1: 跑现有测试作基线**

Run: `npm --prefix apps/web test -- --run src/ReviewCenterPage.test.tsx`

Expected: PASS（查询的是标题和按钮名）。

- [ ] **Step 2: 拼装**

1. 周期按钮加 `ui-segment`，name 仍是「周报」等，`aria-pressed` 保留。
2. 有 `deterministicReport` 时 `KpiStrip` 六格，标签与 `MetricBand` 完全一致：
   - 报告期已实现盈亏、闭合周期盈亏 → `formatSignedMoney` + `signedTone`
   - 资金流调整收益率 → `formatRate` + `signedTone`（`0.0198` → `1.98%`，不是 `+0.0198`）
   - 周期最大回撤 → `formatRate` + `risk`
   - 胜率、纪律执行率 → `formatRate` + `neutral`
   - `unavailableReason` → `detail`；值为 `null` 时主值 `—`
3. 无报告：不渲染 KPI。
4. `SplitPane`：左版本列表；右图/理由/周期/比较。
5. 全宽归因、Pi 总结。无历史：`EmptyState` 文案「该周期还没有固化报告。」
6. 归因表、周期 `netPnl`、理由 `grossAmount` 走 `formatMoney` / `formatSignedMoney`；胜率走 `formatRate`。
7. 预览/生成按钮可加 Lucide，**可见文字不变**。

- [ ] **Step 3: 再跑复盘测试**

Run: `npm --prefix apps/web test -- --run src/ReviewCenterPage.test.tsx`

Expected: PASS。`50.00%`、`7.5 ~ 10.8` 等现有断言保持。

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: restyle review center metrics and split"
```

---

### Task 8: 批次壳、记录、快照

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`（只改会失败的字符断言，不改「运行中 · 3 / 6」「审阅通过率」「移除 601318.SH」）

- [ ] **Step 1: 导航与 Notice**

侧栏五项：`LayoutDashboard` / `ScrollText` / `Database` / `NotebookPen` / `ChartCandlestick` + 现有文字。选中态用 `--accent`。

所有 `role="alert"` 的服务错误改 `<Notice title="…" detail={…} />`（「数据服务暂不可用」「研究记录暂不可用」「数据快照暂不可用」）。生产态「未配置 API 地址」那块同样去掉 `!`、改用 `Notice`。

「生成本批报告」：去掉 `<span>↗</span>`，改为 `<Icon icon={ArrowUpRight} />`。测试用 `/生成本批报告/`，应仍通过。

移除按钮：`<button aria-label={\`移除 ${symbol}\`}><Icon icon={X} /></button>`。

加入自选：文字「加入自选」+ `Plus`。

- [ ] **Step 2: 批次 KPI + SplitPane**

```ts
function batchStatus(progress: RunProgress[]): { label: string; tone: MetricTone } {
  if (!progress.length) return { label: "无批次", tone: "neutral" };
  if (progress.some((item) => item.state === "failed")) return { label: "失败", tone: "down" };
  if (progress.some((item) => item.state === "degraded")) return { label: "降级", tone: "risk" };
  if (progress.some((item) => item.state === "running" || item.state === "queued")) return { label: "进行中", tone: "risk" };
  return { label: "完成", tone: "up" };
}
```

KPI：自选 `watchlist.length`；已完成 `state === "completed"`；运行中仅 `state === "running"`；第四格 `StatusChip` 用上面的本批状态。`report.quality` 仍只在结构报告卡片。

进度区 **保留**「运行中 · n / m」原文。

`SplitPane`：左自选；右进度 + 结构报告。无自选、无报告：右栏 `EmptyState`，不编造 headline。资讯和展望全宽。

- [ ] **Step 3: 研究记录 / 快照**

记录保留「质量看板」「运行归档」「审阅通过率」。四格：

- 审阅通过率 `formatRate(acceptRate)`，null →「样本不足」，detail `{accepted}/{decided} 已决定`
- 有结论兑现率 + `{realized}/{conclusive} 明确结论`
- 已评估兑现率 + `含冲突与无法判定，共 {evaluated} 份`
- 情景分布合计 `padStart(2, "0")`，detail `看多 n · 基准 n · 看空 n`

快照四格标签保持 WATCHLIST / FROZEN / AS-OF DAYS / LATEST AS OF。

- [ ] **Step 4: 跑 App 测试**

Run: `npm --prefix apps/web test -- --run src/App.test.tsx`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: restyle batch records and snapshots"
```

---

### Task 9: 展望、资讯、分享页

**Files:**

- Modify: `apps/web/src/OutlookPanel.tsx`、`StockInformationPanel.tsx`、`SharedReportPage.tsx` 及必要时对应测试

- [ ] **Step 1: 用 Panel 包现有区块，不改文案和按钮 name**

分享页：单栏，**不要** `<Atmosphere />`。屏幕用同一色板。打印规则保留白底、隐藏按钮；打印时 `.ui-atmosphere` 不存在即可。

- [ ] **Step 2: 跑相关测试**

Run: `npm --prefix apps/web test -- --run src/OutlookPanel.test.tsx src/StockInformationPanel.test.tsx src/SharedReportPage.test.tsx`

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: restyle outlook information and share page"
```

---

### Task 10: 图表颜色

**Files:**

- Modify: `apps/web/src/chan-chart-option.ts`、`chan-chart-option.test.ts`
- Modify: `apps/web/src/trading-review-chart-option.ts`、`trading-review-chart-option.test.ts`

- [ ] **Step 1: 先改测试期望（红涨绿跌；笔/中枢不用涨跌色）**

`chan-chart-option.test.ts`：

- K 线 `itemStyle.color` / `borderColor` = `#f6465d`（涨）
- `color0` / `borderColor0` = `#0ecb81`（跌）
- 已确认笔 line = `#7ee0c8`
- 形成中笔 line = `#7ee0c8` dashed（不要 `#f6465d`）
- 中枢 `borderColor` = `#8a9b96`，填充 `rgba(138, 155, 150, 0.14)`
- 成交量涨 `#f6465d`、跌 `#0ecb81`

`trading-review-chart-option.ts`：权益 `#7ee0c8`；回撤 `#f0b429`；买 `#f6465d`；卖 `#0ecb81`；笔 `#7ee0c8`；中枢 `#8a9b96`。

拆开常量：K 线/成交量用 `UP`/`DOWN`；笔用 `ACCENT`；中枢用 `MUTED`。禁止让笔/中枢继续引用 `UP`/`DOWN`。

同时改 `styles.css` 图例色，否则 HTML 图例仍是旧涨跌色：

- `.legend-confirmed`、`.legend-equity` → `#7ee0c8`
- `.legend-provisional` → `#7ee0c8`（虚线）
- `.legend-center` → `#8a9b96`
- `.legend-volume` 保持双色渐变，涨 `#f6465d`、跌 `#0ecb81`
- `.legend-buy` / `.legend-sell` 改三角形的 `border-*-color`，不是 `background`
- `.legend-drawdown` → `#f0b429`

不要 `replace_all` 源码里的旧 hex：按系列改。

- [ ] **Step 2: 跑测试失败后改实现常量**

Run: `npm --prefix apps/web test -- --run src/chan-chart-option.test.ts src/trading-review-chart-option.test.ts`

- [ ] **Step 3: 通过后 commit**

```bash
git commit -m "feat: align chart colors with red-up green-down"
```

---

### Task 11: 回归与浏览器

- [ ] **Step 1: 全量前端测试**

Run: `npm --prefix apps/web test`

Expected: 全绿。

- [ ] **Step 2: 类型与构建**

Run: `npm --prefix apps/web run typecheck && npm --prefix apps/web run build`

Expected: exit 0。

- [ ] **Step 3: 浏览器核对**

不要覆盖 `VITE_API_BASE_URL`。根目录 `.env` 与 README 默认是 `http://127.0.0.1:8000`。shell 里该变量可能为空（Vite 自己读 `envDir`）。探测用 `http://127.0.0.1:8000/api/trading/account`（或 `.env` 里已有的端口），应为 200 或 404，再开 `http://127.0.0.1:5173`。

- `#/batch` `#/records` `#/snapshots` `#/journal` `#/reviews`：KPI 可读、双栏、Lucide、无 emoji、grain 不挡点击。
- 日记红涨绿跌；无账户无假 KPI。
- 复盘六格；无报告无 KPI。
- 系统「减少动态效果」无位移循环。
- 窄视口双栏变单列。
- 分享打印预览白底。

- [ ] **Step 4: 若有修复则补测再提交，不要空 commit**
