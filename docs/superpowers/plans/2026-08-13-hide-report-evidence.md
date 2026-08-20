# Hide Report Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 隐藏结构报告结论区和 AI 报告证据标签，同时保留图表、条件、风险及后台证据链。

**Architecture:** 只修改 React 展示树和对应布局，不改 API DTO、缓存或服务端契约。结构报告改为图表单列；AI 报告移除证据组件，只保留独立风险区。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、CSS

---

## Task 1: 隐藏结构结论区

**Files:**

- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写失败测试**

在 App 结构报告测试中断言 `.report-copy` 不存在，同时断言缠论图表仍存在。删除批次页
依赖结构事实列表的“形成中/已确认”旧断言，并在数据快照视图断言结构计数仍保留。
读取 `styles.css` 并断言 `.report-body` 为单列、`.chart-pane` 无右边框，防止桌面端留下空列。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm --prefix apps/web test -- --run src/App.test.tsx --reporter=dot`

Expected: FAIL，原因是 `.report-copy` 仍在 DOM。

- [ ] **Step 3: 写最小实现**

从 `ReportView` 删除 `.report-copy` 渲染；将 `.report-body` 改为单列，并移除图表右边框。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `npm --prefix apps/web test -- --run src/App.test.tsx --reporter=dot`

Expected: PASS。

## Task 2: 隐藏 AI 报告证据展示

**Files:**

- Modify: `apps/web/src/OutlookPanel.test.tsx`
- Modify: `apps/web/src/OutlookPanel.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写失败测试**

在 completed 报告测试中断言 `.scenario-evidence` 和 `.outlook-evidence-section` 不存在；继续断言三个情景、触发、失效、风险边界和免责声明存在。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm --prefix apps/web test -- --run src/OutlookPanel.test.tsx --reporter=dot`

Expected: FAIL，原因是证据容器仍在 DOM。

- [ ] **Step 3: 写最小实现**

删除情景证据行和顶层引用证据列表；将风险渲染为独立
`.outlook-risk-section`；删除不再使用的 `EvidenceFact` 和 URL 处理函数，
保留 `ReferenceFact` 类型供触发与失效条件格式化使用；将运行文案改为
“结构与资讯正在整理”。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `npm --prefix apps/web test -- --run src/OutlookPanel.test.tsx --reporter=dot`

Expected: PASS。

## Task 3: 文档与整体验收

**Files:**

- Modify: `README.md`

- [ ] **Step 1: 更新 README**

说明结构结论和报告证据明细仅进入 Report V2，不在工作台重复展示。

- [ ] **Step 2: 运行完整验证**

Run: `npm --prefix apps/web test -- --run`

Expected: 全部测试通过。

Run: `npm --prefix apps/web run typecheck`

Expected: TypeScript 无错误。

Run: `npm --prefix apps/web run build`

Expected: 构建成功。

Run:

```bash
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-13-hide-report-evidence-design.md \
  docs/superpowers/plans/2026-08-13-hide-report-evidence.md
```

Expected: 0 issues。

- [ ] **Step 3: 浏览器验收**

在 `http://127.0.0.1:5173/#/batch` 验证图表横跨报告正文全宽、正文为单列且
无右边框；资讯区、三情景和风险仍可见，结构结论与证据标签不可见。

当前工作区不是 Git 仓库，因此本计划不包含提交步骤。
