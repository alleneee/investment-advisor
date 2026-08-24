# 今日批次页面 UI 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `#/batch` 改造成已确认的分析驾驶舱布局，并让新闻和互动问答默认各显示 4 条且可独立展开。

**Architecture:** 保留 `Workbench` 的数据流和现有 UI 基础组件，只调整今日批次的
JSX 组合与作用域样式。资讯折叠状态封装在 `StockInformationPanel` 内，以当前股票
代码为重置边界，不触碰 API 或服务状态。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、CSS、Vite、GitNexus

---

## 文件结构

- `apps/web/src/App.tsx`：只调整今日批次的组件组合，形成左侧自选与进度、右侧结构报告。
- `apps/web/src/App.test.tsx`：验证今日批次的驾驶舱分栏语义，不改业务行为测试。
- `apps/web/src/StockInformationPanel.tsx`：封装新闻和互动问答的独立展开状态。
- `apps/web/src/StockInformationPanel.test.tsx`：覆盖默认 4 条、独立展开、收起、无按钮和切股重置。
- `apps/web/src/styles.css`：增加仅作用于批次页的布局、资讯按钮和响应式规则。
- `README.md`：补充批次页驾驶舱和资讯折叠的使用说明。

## 工作区约束

`apps/web/src/App.tsx` 和 `apps/web/src/styles.css` 已有用户的未提交改动。
执行时必须在当前工作区上最小追加，不能还原、覆盖或提交这些既有改动。
`StockInformationPanel` 及其测试当前是干净文件，可以单独形成提交；涉及脏文件的
后续任务只保留未提交改动并清晰报告。

### Task 0: 保存当前工作区基线

**Files:**

- Snapshot: `.superpowers/baselines/2026-08-24-batch-ui/`

- [ ] **Step 1: 确认基线目录不存在**

Run:

```bash
test ! -e .superpowers/baselines/2026-08-24-batch-ui
```

Expected: 退出码为 0。若目录已存在，停止并检查内容，不能覆盖未知基线。

- [ ] **Step 2: 复制计划内文件的当前版本**

Run:

```bash
mkdir -p .superpowers/baselines/2026-08-24-batch-ui/apps/web/src
cp apps/web/src/App.tsx \
  .superpowers/baselines/2026-08-24-batch-ui/apps/web/src/App.tsx
cp apps/web/src/App.test.tsx \
  .superpowers/baselines/2026-08-24-batch-ui/apps/web/src/App.test.tsx
cp apps/web/src/StockInformationPanel.tsx \
  .superpowers/baselines/2026-08-24-batch-ui/apps/web/src/StockInformationPanel.tsx
cp apps/web/src/StockInformationPanel.test.tsx \
  .superpowers/baselines/2026-08-24-batch-ui/apps/web/src/StockInformationPanel.test.tsx
cp apps/web/src/styles.css \
  .superpowers/baselines/2026-08-24-batch-ui/apps/web/src/styles.css
cp README.md .superpowers/baselines/2026-08-24-batch-ui/README.md
```

Expected: 6 个快照文件存在，`.superpowers/` 仍被 `.gitignore` 忽略。后续用
`git diff --no-index` 比较这些快照，准确隔离本次改动与既有脏工作区。

### Task 1: 资讯默认折叠与独立展开

**Files:**

- Modify: `apps/web/src/StockInformationPanel.tsx:1-89`
- Modify: `apps/web/src/StockInformationPanel.test.tsx:1-94`

- [ ] **Step 1: 执行组件影响分析**

Run:

```bash
npx gitnexus impact -r investment-advisor StockInformationPanel \
  -d upstream --depth 3 --include-tests
```

Expected: 直接影响仅限 `App`、`StockInformationPanel.test.tsx` 和前端渲染流程；若结果为 HIGH 或 CRITICAL，停止并向用户报告。

- [ ] **Step 2: 写入长资讯测试数据辅助函数**

在 `StockInformationPanel.test.tsx` 新增独立辅助函数，不改现有 `information()`：

```tsx
function longInformation(symbol = "002940.SZ"): StockInformation {
  const value = information();
  value.symbol = symbol;
  value.news = Array.from({ length: 6 }, (_, index) => ({
    id: `news-${index + 1}`,
    title: `公司新闻 ${index + 1}`,
    summary: `新闻摘要 ${index + 1}`,
    publishedAt: `2026-08-${String(13 - index).padStart(2, "0")}T08:00:00+08:00`,
    source: "东财",
    url: `https://example.com/news/${index + 1}`,
  }));
  value.messages = Array.from({ length: 6 }, (_, index) => ({
    id: `irm-${index + 1}`,
    question: `互动问题 ${index + 1}`,
    answer: `互动答复 ${index + 1}`,
    answerer: "证券部",
    publishedAt: `2026-08-${String(13 - index).padStart(2, "0")}T16:00:00+08:00`,
    source: "cninfo",
  }));
  return value;
}
```

- [ ] **Step 3: 写入默认折叠和独立展开测试**

导入 `userEvent`，新增测试：

```tsx
it("shows four items and expands each column independently", async () => {
  const user = userEvent.setup();
  render(<StockInformationPanel information={longInformation()} />);

  expect(screen.getByRole("heading", { name: "公司新闻 4" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "公司新闻 5" })).not.toBeInTheDocument();
  expect(screen.getByText("互动问题 4")).toBeInTheDocument();
  expect(screen.queryByText("互动问题 5")).not.toBeInTheDocument();
  expect(screen.getAllByText("04 / 06")).toHaveLength(2);

  const newsToggle = screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" });
  expect(newsToggle).toHaveAttribute("aria-expanded", "false");
  await user.click(newsToggle);

  expect(screen.getByRole("heading", { name: "公司新闻 6" })).toBeInTheDocument();
  expect(screen.queryByText("互动问题 5")).not.toBeInTheDocument();
  expect(newsToggle).toHaveAttribute("aria-expanded", "true");
});
```

- [ ] **Step 4: 写入收起、短列表和切股重置测试**

新增三个断言场景：

```tsx
it("collapses an expanded column", async () => {
  const user = userEvent.setup();
  render(<StockInformationPanel information={longInformation()} />);
  await user.click(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" }));
  await user.click(screen.getByRole("button", { name: "收起全部问答" }));
  expect(screen.queryByText("互动问题 5")).not.toBeInTheDocument();
});

it("does not show expand controls for short lists", () => {
  render(<StockInformationPanel information={information()} />);
  expect(screen.queryByRole("button", { name: /展开全部/ })).not.toBeInTheDocument();
});

it("resets expanded columns when the selected symbol changes", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <StockInformationPanel information={longInformation()} />,
  );
  await user.click(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" }));
  rerender(<StockInformationPanel information={longInformation("000858.SZ")} />);
  expect(screen.queryByRole("heading", { name: "公司新闻 5" })).not.toBeInTheDocument();
});
```

- [ ] **Step 5: 运行测试并确认失败**

Run:

```bash
npm --prefix apps/web test -- StockInformationPanel.test.tsx
```

Expected: FAIL，因为组件仍渲染全部条目，也没有展开按钮。

- [ ] **Step 6: 实现最小折叠状态**

在 `StockInformationPanel.tsx` 导入 Hook，并新增常量与状态：

```tsx
import { useEffect, useState } from "react";

const DEFAULT_VISIBLE_ITEMS = 4;

export function StockInformationPanel({
  information,
  loading = false,
  error = null,
}: StockInformationPanelProps) {
  const [showAllNews, setShowAllNews] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);

  useEffect(() => {
    setShowAllNews(false);
    setShowAllMessages(false);
  }, [information?.symbol]);

  const visibleNews = information?.news.slice(
    0,
    showAllNews ? information.news.length : DEFAULT_VISIBLE_ITEMS,
  ) ?? [];
  const visibleMessages = information?.messages.slice(
    0,
    showAllMessages ? information.messages.length : DEFAULT_VISIBLE_ITEMS,
  ) ?? [];
```

用 `visibleNews` 和 `visibleMessages` 渲染列表。新闻标题计数使用
`${visibleNews.length} / ${information.news.length}`，问答标题计数使用
`${visibleMessages.length} / ${information.messages.length}`，两个数字都补齐为两位，
例如 `04 / 06`。仅在总数大于 4 时渲染按钮：

```tsx
<button
  type="button"
  className="information-toggle"
  aria-expanded={showAllNews}
  onClick={() => setShowAllNews((value) => !value)}
>
  {showAllNews
    ? "收起全部新闻"
    : `展开全部新闻（还有 ${information.news.length - DEFAULT_VISIBLE_ITEMS} 条）`}
</button>
```

互动问答使用相同结构和独立状态，文案为“展开全部问答”和“收起全部问答”。

- [ ] **Step 7: 运行资讯组件测试**

Run:

```bash
npm --prefix apps/web test -- StockInformationPanel.test.tsx
```

Expected: PASS，原有安全外链、空态和降级测试同时通过。

- [ ] **Step 8: 暂存干净文件并执行提交前影响分析**

Run:

```bash
git add apps/web/src/StockInformationPanel.tsx \
  apps/web/src/StockInformationPanel.test.tsx
npx gitnexus detect-changes -r investment-advisor -s staged
```

Expected: 暂存内容只涉及 `StockInformationPanel` 和相应测试，风险不是 HIGH 或
CRITICAL。若风险达到 HIGH 或 CRITICAL，停止并向用户报告。

- [ ] **Step 9: 提交干净文件的独立改动**

Run:

```bash
git commit -m "feat: collapse batch information feeds"
```

Expected: 提交只包含上述两个文件。

### Task 2: 分析驾驶舱组件组合

**Files:**

- Modify: `apps/web/src/App.tsx:562-648`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: 执行工作台影响分析并报告范围**

Run:

```bash
npx gitnexus impact -r investment-advisor Workbench \
  -d upstream --depth 3 --include-tests
```

Expected: 直接调用者是 `App`，受影响流程集中在工作台渲染和
`App.test.tsx`。若结果为 HIGH 或 CRITICAL，先警告用户再继续。

- [ ] **Step 2: 写入驾驶舱结构测试**

在 `App.test.tsx` 增加 `within` 导入，并新增测试：

```tsx
it("places batch context beside the main report", async () => {
  render(<App />);
  await screen.findByRole("heading", { name: "结构报告" });

  const cockpit = document.querySelector(".batch-cockpit");
  expect(cockpit).not.toBeNull();
  const panes = cockpit?.querySelectorAll(":scope > .ui-split > .ui-split-pane");
  expect(panes).toHaveLength(2);
  expect(within(panes![0] as HTMLElement).getByRole("heading", { name: "自选池" })).toBeInTheDocument();
  expect(within(panes![0] as HTMLElement).getByRole("heading", { name: "本批进度" })).toBeInTheDocument();
  expect(within(panes![1] as HTMLElement).getByRole("heading", { name: "结构报告" })).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行结构测试并确认失败**

Run:

```bash
npm --prefix apps/web test -- App.test.tsx -t "places batch context"
```

Expected: FAIL，因为页面还没有 `.batch-cockpit`，进度仍位于右列。

- [ ] **Step 4: 最小调整今日批次 JSX**

将今日批次 Fragment 改为作用域容器：

```tsx
{view === "batch" && <div className="batch-page">
  <KpiStrip>{/* 保留现有四项 KPI */}</KpiStrip>
  <div className="batch-cockpit">
    <SplitPane
      left={<>
        <Panel title="自选池" className="watchlist-panel">{/* 保留现有内容 */}</Panel>
        <Panel title="本批进度" className="pulse-panel">{/* 保留现有内容 */}</Panel>
      </>}
      right={<Panel title="结构报告" className="report-section">{/* 保留现有内容 */}</Panel>}
    />
  </div>
  {/* 保留资讯与 AI 展望 */}
</div>}
```

不得修改任何处理函数、状态、请求、轮询、报告选择或按钮行为。

- [ ] **Step 5: 运行 App 定向测试**

Run:

```bash
npm --prefix apps/web test -- App.test.tsx -t "places batch context"
```

Expected: PASS。

### Task 3: 批次页视觉层级与响应式

**Files:**

- Modify: `apps/web/src/styles.css:50-56, 142-175, 317-359, 407-408`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: 写入批次页作用域样式契约测试**

在 `App.test.tsx` 读取 `styles.css` 的现有样式测试附近增加断言：

```tsx
it("defines the batch cockpit breakpoints", async () => {
  const moduleName = "node:fs";
  const { readFileSync } = await import(moduleName);
  const processModuleName = "node:process";
  const { cwd } = await import(processModuleName);
  const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8") as string;

  expect(styles).toMatch(/\.batch-cockpit\s+\.ui-split\s*\{[^}]*grid-template-columns:\s*minmax\(260px,/);
  expect(styles).toMatch(/\.batch-cockpit\s+\.watch-input\s+input\s*\{[^}]*min-width:\s*0/);
  expect(styles).toMatch(/\.batch-cockpit\s+\.run-list\s*\{[^}]*grid-template-columns:\s*1fr/);
  expect(styles).toMatch(/@media\s*\(max-width:\s*1100px\)[\s\S]*\.batch-cockpit\s+\.ui-split\s*\{[^}]*grid-template-columns:\s*1fr/);
  expect(styles).toMatch(/\.batch-cockpit\s+\.report-section\s*\{[^}]*margin-top:\s*0/);
  expect(styles).toMatch(
    /\.batch-page\s+\.outlook-header\s*\{[^}]*padding:\s*20px 24px/,
  );
  expect(styles).toMatch(/\.batch-page :is\([\s\S]*\.risk-list p[\s\S]*font-size:\s*12px/);
  expect(styles).toMatch(/\.batch-page :is\([\s\S]*\.outlook-subheading[\s\S]*font-size:\s*10px/);
  expect(styles).toMatch(/\.batch-page\s+\.market-chip\s*\{[^}]*font-size:\s*10px\s*!important/);
  expect(styles).toMatch(/\.information-toggle\s*\{/);
});
```

- [ ] **Step 2: 运行样式契约测试并确认失败**

Run:

```bash
npm --prefix apps/web test -- App.test.tsx -t "defines the batch cockpit"
```

Expected: FAIL，因为批次页作用域样式尚未存在。

- [ ] **Step 3: 写入桌面驾驶舱与紧凑节奏样式**

在 `styles.css` 增加：

```css
.batch-cockpit { margin-top: 12px; }
.batch-cockpit .ui-split {
  grid-template-columns: minmax(260px, .62fr) minmax(0, 1.5fr);
  gap: 12px;
}
.batch-cockpit .ui-split-pane { gap: 12px; }
.batch-cockpit .watch-input input { min-width: 0; }
.batch-cockpit .watch-input button { flex-shrink: 0; }
.batch-cockpit .watch-name {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.batch-cockpit .watch-name :is(strong, small) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-cockpit .run-list { grid-template-columns: 1fr; }
.batch-cockpit .run-row {
  grid-template-columns: 8px minmax(72px, 84px) minmax(0, 1fr) auto;
}
.batch-cockpit .report-section {
  min-height: 100%;
  margin-top: 0;
}
.batch-page .evidence-section,
.batch-page .outlook-section { margin-top: 44px; }
.batch-page .outlook-header { padding: 20px 24px; }
.batch-page :is(.outlook-idle, .outlook-failed, .outlook-progress) {
  padding: 22px 24px;
}
.batch-page :is(
  .outlook-summary,
  .outlook-risk-section,
  .outlook-disclaimer,
  .outlook-delivery
) {
  padding-right: 24px;
  padding-left: 24px;
}
```

同时将批次页正文统一到至少 12px，标签统一到至少 10px，不影响其他页面：

```css
.batch-page :is(
  .news-item p,
  .message-item p,
  .information-column-empty,
  .evidence-loading,
  .information-empty,
  .evidence-local-error,
  .information-quality,
  .chart-notice,
  .chart-empty,
  .report-loading,
  .outlook-idle p,
  .outlook-error,
  .outlook-summary p,
  .outlook-summary blockquote,
  .scenario-card > p,
  .scenario-conditions dd,
  .risk-list p,
  .outlook-disclaimer,
  .delivery-status dd,
  .delivery-error,
  .delivery-warnings
) { font-size: 12px; }

.batch-page :is(
  .evidence-kicker,
  .evidence-timestamp,
  .information-column-heading,
  .information-column-heading small,
  .information-meta,
  .message-item > small,
  .run-row small,
  .report-meta,
  .timeframe-switch button,
  .chan-chart-legend,
  .report-footer,
  .sentiment-rank span,
  .sentiment-card dt,
  .sentiment-card dd,
  .concept-list span,
  .sentiment-time,
  .outlook-meta,
  .outlook-meta strong,
  .outlook-action,
  .outlook-failed button,
  .outlook-progress small,
  .outlook-failed span,
  .outlook-summary > span,
  .scenario-heading span,
  .scenario-conditions dt,
  .outlook-subheading,
  .delivery-status dt,
  .delivery-actions button
) { font-size: 10px; }

.batch-page .market-chip { font-size: 10px !important; }
```

- [ ] **Step 4: 写入资讯展开按钮样式**

```css
.information-toggle {
  width: 100%;
  margin-top: 14px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--muted);
  font-size: 10px;
}
.information-toggle:hover,
.information-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent);
}
```

- [ ] **Step 5: 写入 1100px 与 900px 响应式规则**

```css
@media (max-width: 1100px) {
  .batch-cockpit .ui-split { grid-template-columns: 1fr; }
  .batch-page .information-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .batch-page .message-column { border-right: 0; }
  .batch-page .sentiment-column {
    grid-column: 1 / -1;
    border-top: 1px solid rgba(213, 228, 218, .09);
  }
}

@media (max-width: 900px) {
  .batch-page .information-grid { grid-template-columns: 1fr; }
  .batch-page .information-column {
    grid-column: auto;
    border-right: 0;
  }
}
```

保留现有 520px 导航和表单规则，不做全站响应式重写。

- [ ] **Step 6: 运行 App 测试与类型检查**

Run:

```bash
npm --prefix apps/web test -- App.test.tsx
npm --prefix apps/web run typecheck
```

Expected: PASS。

### Task 4: README 与定向回归

**Files:**

- Modify: `README.md:131-145`

- [ ] **Step 1: 更新批次页使用说明**

在默认地址和批次操作说明后补充：

```markdown
今日批次桌面端将自选池和本批进度集中在左侧，结构报告位于右侧主分析区。
公司新闻与互动问答默认各显示前 4 条，点击栏目底部按钮可展开或收起全部资讯。
```

- [ ] **Step 2: 运行前端完整验证**

Run:

```bash
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Expected: Vitest 全部通过，TypeScript 无错误，Vite 构建成功。

- [ ] **Step 3: 运行 Markdown 验证**

Run:

```bash
npx markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-24-batch-page-ui-design.md \
  docs/superpowers/plans/2026-08-24-batch-page-ui.md
```

Expected: `Summary: 0 issues`。

### Task 5: 浏览器打磨与影响核验

**Files:**

- Verify: `http://127.0.0.1:5173/#/batch`

- [ ] **Step 1: 确认 Vite 开发服务器可用**

Run:

```bash
curl --fail --silent --output /dev/null http://127.0.0.1:5173/
```

Expected: 退出码为 0。若服务未启动，在独立终端运行：

```bash
npm --prefix apps/web run dev -- --host 127.0.0.1
```

- [ ] **Step 2: 刷新本地批次页并检查桌面布局**

使用浏览器刷新页面，确认：

- 左列只有自选池和本批进度。
- 右列只有结构报告。
- KPI 与驾驶舱间距紧凑且清楚。
- 新闻和问答默认各最多 4 条。
- 展开和收起按钮可用，市场热度不随之改变。

- [ ] **Step 3: 检查 1100px、900px 和 520px 附近布局**

使用浏览器 viewport 能力分别检查：

- 1120px 下左列输入、移除按钮和每条运行记录都完整可见。
- 1080px 下驾驶舱变为单列。
- 900px 以下资讯变为单列。
- 520px 下没有横向滚动，导航和表单仍可操作。

- [ ] **Step 4: 检查控制台与交互语义**

确认控制台无新增错误；展开按钮的可访问名称和 `aria-expanded` 与状态一致。
读取批次页所有正文和标签的计算样式，确认正文没有小于 12px，标签没有小于
10px 的结果。

- [ ] **Step 5: 运行 GitNexus 变更影响分析**

Run:

```bash
npx gitnexus detect-changes -r investment-advisor -s unstaged
```

Expected: Task 1 已在提交前通过 staged 分析。当前 unstaged 分析会把既有脏工作区
一起纳入，可能继续报告 HIGH，不得把该总风险误报为本次新增风险。结合 Task 0 的
基线差异，只提取本次涉及的 `Workbench`、相应测试和前端渲染流程；API、交易复盘
等既有影响必须单独列为实施前已存在。

- [ ] **Step 6: 最终检查工作区边界**

Run:

```bash
batch_ui_baseline=.superpowers/baselines/2026-08-24-batch-ui
check_batch_ui_diff() {
  git diff --no-index "$1" "$2"
  batch_ui_diff_status=$?
  test "$batch_ui_diff_status" -le 1
}
git status --short
check_batch_ui_diff \
  "$batch_ui_baseline/apps/web/src/App.tsx" \
  apps/web/src/App.tsx
check_batch_ui_diff \
  "$batch_ui_baseline/apps/web/src/App.test.tsx" \
  apps/web/src/App.test.tsx
check_batch_ui_diff \
  "$batch_ui_baseline/apps/web/src/StockInformationPanel.tsx" \
  apps/web/src/StockInformationPanel.tsx
check_batch_ui_diff \
  "$batch_ui_baseline/apps/web/src/StockInformationPanel.test.tsx" \
  apps/web/src/StockInformationPanel.test.tsx
check_batch_ui_diff \
  "$batch_ui_baseline/apps/web/src/styles.css" \
  apps/web/src/styles.css
check_batch_ui_diff \
  "$batch_ui_baseline/README.md" \
  README.md
```

Expected: `git diff --no-index` 只显示本次计划内补丁。`git status` 仍会显示实施前
已有的无关修改和未跟踪文件；不得 add、提交、删除或整理它们。
保留忽略目录中的基线快照到最终交付，方便用户复核；本任务不删除该目录。
