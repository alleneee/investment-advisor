# 报告 PDF 与长图导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从批次页明确进入对客报告，并在分享页下载包含完整报告和缠论图表的 PNG 长图。

**Architecture:** 批次页只增加指向现有分享路由的入口，所有导出集中在
`SharedReportPage`。分享页使用 `html-to-image.toBlob` 将报告根节点转换为 PNG，
通过原生对象 URL 下载，不新增后端接口或文件保存服务。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、html-to-image、CSS、Vite、GitNexus

---

## 文件结构

- `apps/web/package.json`：声明 `html-to-image` 运行时依赖。
- `apps/web/package-lock.json`：锁定依赖版本与完整性。
- `apps/web/src/SharedReportPage.tsx`：持有报告节点引用，执行 PNG Blob 生成与下载。
- `apps/web/src/SharedReportPage.test.tsx`：覆盖 PDF、PNG、处理中和失败行为。
- `apps/web/src/OutlookPanel.tsx`：在已有分享操作区增加“打开对客报告”链接。
- `apps/web/src/OutlookPanel.test.tsx`：验证入口地址和新标签页属性。
- `apps/web/src/styles.css`：定义两个导出按钮、错误态和打开报告链接样式。
- `README.md`：说明功能入口与导出格式。

## 工作区约束

当前 `apps/web/src/styles.css` 包含与本功能无关的未提交修改，`App.tsx`、
`App.test.tsx` 和交易复盘文件也有其他工作。执行时必须：

- 在当前工作区直接追加，不能切换、清理或重置分支。
- 不修改 `App.tsx`、`App.test.tsx` 和交易复盘文件。
- 修改前保存计划内文件基线，完成后用基线隔离本次差异。
- 暂存 `styles.css` 时只选择本功能新增的导出样式，不能带入已有记录页样式修改。

### Task 0: 保存基线并安装图片导出依赖

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/package-lock.json`
- Snapshot: `.superpowers/baselines/2026-08-24-report-export/`

- [ ] **Step 1: 刷新 GitNexus 索引**

Run:

```bash
npx gitnexus status
npx gitnexus analyze
npx gitnexus status
```

Expected: 最后一次状态显示索引对应当前提交，不再是 stale。

- [ ] **Step 2: 确认基线目录不存在**

Run:

```bash
test ! -e .superpowers/baselines/2026-08-24-report-export
```

Expected: 退出码为 0；若目录存在，停止并检查，不能覆盖未知内容。

- [ ] **Step 3: 保存计划内文件当前版本**

Run:

```bash
mkdir -p .superpowers/baselines/2026-08-24-report-export/apps/web/src
cp apps/web/src/SharedReportPage.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/SharedReportPage.tsx
cp apps/web/src/SharedReportPage.test.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/SharedReportPage.test.tsx
cp apps/web/src/OutlookPanel.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/OutlookPanel.tsx
cp apps/web/src/OutlookPanel.test.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/OutlookPanel.test.tsx
cp apps/web/src/App.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/App.tsx
cp apps/web/src/App.test.tsx \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/App.test.tsx
cp apps/web/src/styles.css \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/styles.css
cp apps/web/package.json \
  .superpowers/baselines/2026-08-24-report-export/apps/web/package.json
cp apps/web/package-lock.json \
  .superpowers/baselines/2026-08-24-report-export/apps/web/package-lock.json
cp README.md .superpowers/baselines/2026-08-24-report-export/README.md
```

Expected: 10 个基线文件存在，`.superpowers/` 仍被 Git 忽略。

- [ ] **Step 4: 安装固定版本依赖**

Run:

```bash
npm --prefix apps/web install --save-exact html-to-image
npm --prefix apps/web ls html-to-image
```

Expected: 安装成功，`apps/web/package.json` 与 `apps/web/package-lock.json` 只新增
`html-to-image`。

- [ ] **Step 5: 检查依赖差异**

Run:

```bash
git diff --check -- apps/web/package.json apps/web/package-lock.json
git diff -- apps/web/package.json apps/web/package-lock.json
```

Expected: 无格式错误，无其他依赖漂移。

- [ ] **Step 6: 提交依赖变更**

Run:

```bash
git add apps/web/package.json apps/web/package-lock.json
npx gitnexus detect-changes -r investment-advisor -s staged
git diff --cached --check
git commit -m "build(web): add report image export dependency"
```

Expected: 提交只包含两个依赖文件，GitNexus 不报告 HIGH 或 CRITICAL 风险。

### Task 1: 分享页长图下载

**Files:**

- Modify: `apps/web/src/SharedReportPage.test.tsx:1-160`
- Modify: `apps/web/src/SharedReportPage.tsx:1-137`

- [ ] **Step 1: 再次执行组件影响分析**

Run:

```bash
npx gitnexus analyze
npx gitnexus impact SharedReportPage --direction upstream -r investment-advisor
```

Expected: 风险为 LOW；若为 HIGH 或 CRITICAL，停止并向用户报告。

- [ ] **Step 2: 写入长图成功与处理中测试**

在 `SharedReportPage.test.tsx` 顶部创建 hoisted mock，并扩展现有 `afterEach`：

```tsx
const imageMocks = vi.hoisted(() => ({ toBlob: vi.fn() }));

vi.mock("html-to-image", () => ({ toBlob: imageMocks.toBlob }));
```

```tsx
afterEach(() => {
  imageMocks.toBlob.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

新增测试，使用一个未立即完成的 Promise 验证按钮状态，再解析 Blob 并验证下载：

```tsx
it("downloads the complete report as a PNG image", async () => {
  const user = userEvent.setup();
  let resolveImage: ((blob: Blob | null) => void) | undefined;
  imageMocks.toBlob.mockReturnValue(new Promise((resolve) => {
    resolveImage = resolve;
  }));
  const createObjectURL = vi.fn(() => "blob:report-image");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<SharedReportPage
    token="token-1"
    api={apiWith(async () => sharedReport())}
  />);

  await user.click(await screen.findByRole("button", { name: "导出长图" }));
  expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled();

  resolveImage?.(new Blob(["image"], { type: "image/png" }));
  await screen.findByRole("button", { name: "导出长图" });

  expect(imageMocks.toBlob).toHaveBeenCalledWith(
    expect.objectContaining({ className: "share-report" }),
    expect.objectContaining({
      backgroundColor: "#101920",
      cacheBust: true,
      pixelRatio: 2,
    }),
  );
  const options = imageMocks.toBlob.mock.calls[0][1];
  const actions = screen.getByRole("button", { name: "导出 PDF" })
    .closest("[data-export-ignore]");
  expect(options?.filter?.(actions as HTMLElement)).toBe(false);
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledOnce();
  const anchor = click.mock.instances[0] as HTMLAnchorElement;
  expect(anchor.download).toBe("002940.SZ-2026-08-13-研究报告.png");
  await vi.waitFor(() => {
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report-image");
  });
});
```

- [ ] **Step 3: 写入失败测试**

```tsx
it("shows a clear error when image export fails", async () => {
  const user = userEvent.setup();
  imageMocks.toBlob.mockResolvedValue(null);
  render(<SharedReportPage
    token="token-1"
    api={apiWith(async () => sharedReport())}
  />);

  await user.click(await screen.findByRole("button", { name: "导出长图" }));

  expect(await screen.findByRole("alert"))
    .toHaveTextContent("长图导出失败，请稍后重试。");
});
```

- [ ] **Step 4: 运行测试并确认 RED**

Run:

```bash
npm --prefix apps/web test -- SharedReportPage.test.tsx
```

Expected: FAIL，因为“导出长图”按钮和导出逻辑尚不存在；不是模块导入或测试环境错误。

- [ ] **Step 5: 实现最小长图下载**

在 `SharedReportPage.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { toBlob } from "html-to-image";

const IMAGE_EXPORT_ERROR = "长图导出失败，请稍后重试。";

export function SharedReportPage({ token, api }: SharedReportPageProps) {
  const reportRef = useRef<HTMLElement>(null);
  const [exportingImage, setExportingImage] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportLongImage() {
    const node = reportRef.current;
    if (!node || exportingImage || report == null) return;
    setExportingImage(true);
    setExportError(null);
    try {
      const blob = await toBlob(node, {
        backgroundColor: "#101920",
        cacheBust: true,
        pixelRatio: 2,
        filter: (child) => !(child instanceof HTMLElement && child.hasAttribute("data-export-ignore")),
      });
      if (!blob) throw new Error(IMAGE_EXPORT_ERROR);
      downloadBlob(blob, `${report.symbol}-${report.asOf}-研究报告.png`);
    } catch {
      setExportError(IMAGE_EXPORT_ERROR);
    } finally {
      setExportingImage(false);
    }
  }
```

报告节点与操作区改为：

```tsx
<article ref={reportRef} className="share-report" aria-label="对客研究报告">
  <header className="share-header">
    <div className="share-header-top">
      <span className="share-kicker">结构投研 · 对客研究报告</span>
      <div className="share-export-tools" data-export-ignore="true">
        <div className="share-export-actions">
          <button type="button" className="share-export-button" onClick={() => window.print()}>
            导出 PDF
          </button>
          <button
            type="button"
            className="share-export-button share-export-image-button"
            disabled={exportingImage}
            onClick={() => void exportLongImage()}
          >{exportingImage ? "正在导出…" : "导出长图"}</button>
        </div>
        {exportError && <p className="share-export-error" role="alert">{exportError}</p>}
      </div>
    </div>
```

在文件末尾增加原生下载辅助函数：

```tsx
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
```

- [ ] **Step 6: 运行测试并确认 GREEN**

Run:

```bash
npm --prefix apps/web test -- SharedReportPage.test.tsx
```

Expected: SharedReportPage 全部测试通过，PDF 既有测试仍通过。

- [ ] **Step 7: 提交分享页行为**

Run:

```bash
git add apps/web/src/SharedReportPage.tsx apps/web/src/SharedReportPage.test.tsx
npx gitnexus detect-changes -r investment-advisor -s staged
git diff --cached --check
git commit -m "feat(web): export shared report as long image"
```

Expected: 提交只包含分享页组件和测试，影响风险不是 HIGH 或 CRITICAL。

### Task 2: 批次页打开报告入口

**Files:**

- Modify: `apps/web/src/OutlookPanel.test.tsx:230-290`
- Modify: `apps/web/src/OutlookPanel.tsx:125-150`

- [ ] **Step 1: 执行组件影响分析**

Run:

```bash
npx gitnexus analyze
npx gitnexus impact DeliverySection --direction upstream -r investment-advisor
```

Expected: 只影响 `OutlookPanel` 内的对客交付渲染与对应测试；若风险为 HIGH 或
CRITICAL，停止并报告。

- [ ] **Step 2: 扩展分享测试**

在已有 `creates, copies, and revokes the share link for a published report` 测试中，
渲染 `shareToken` 后增加：

```tsx
const reportLink = screen.getByRole("link", { name: "打开对客报告" });
expect(reportLink).toHaveAttribute("href", expect.stringContaining("#/share/token-1"));
expect(reportLink).toHaveAttribute("target", "_blank");
expect(reportLink).toHaveAttribute("rel", "noreferrer");
```

在没有分享令牌的断言中增加：

```tsx
expect(screen.queryByRole("link", { name: "打开对客报告" })).not.toBeInTheDocument();
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
npm --prefix apps/web test -- OutlookPanel.test.tsx
```

Expected: FAIL，因为链接尚不存在。

- [ ] **Step 4: 实现最小入口**

在已有 `job.shareToken` 的 `.delivery-actions` 中，放在“复制链接”之前：

```tsx
<a
  className="delivery-action-link"
  href={shareUrl(job.shareToken)}
  target="_blank"
  rel="noreferrer"
>打开对客报告</a>
```

- [ ] **Step 5: 运行测试并确认 GREEN**

Run:

```bash
npm --prefix apps/web test -- OutlookPanel.test.tsx
```

Expected: OutlookPanel 全部测试通过，复制和撤销行为不变。

- [ ] **Step 6: 提交批次页入口**

Run:

```bash
git add apps/web/src/OutlookPanel.tsx apps/web/src/OutlookPanel.test.tsx
npx gitnexus detect-changes -r investment-advisor -s staged
git diff --cached --check
git commit -m "feat(web): expose shared report entry"
```

Expected: 提交只包含对客交付组件和测试，影响风险不是 HIGH 或 CRITICAL。

### Task 3: 导出样式与 README

**Files:**

- Modify: `apps/web/src/styles.css:399-406,494-560`
- Modify: `README.md:136-147`

- [ ] **Step 1: 增加打开报告链接样式**

在 `.delivery-actions` 规则附近增加：

```css
.delivery-actions .delivery-action-link {
  display: inline-flex;
  align-items: center;
  padding: 8px 15px;
  border: 1px solid rgba(103, 186, 161, .3);
  color: #8fc4b2;
  font-size: 9px;
  letter-spacing: .06em;
  text-decoration: none;
}
.delivery-actions .delivery-action-link:hover {
  border-color: rgba(103, 186, 161, .55);
  color: #a9d6c6;
}
```

- [ ] **Step 2: 替换分享页单按钮样式**

将 `.share-print-button` 规则替换为：

```css
.share-export-tools {
  display: grid;
  justify-items: end;
  gap: 8px;
}
.share-export-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.share-export-button {
  border: 1px solid rgba(228, 161, 95, .42);
  padding: 10px 14px;
  background: rgba(228, 161, 95, .08);
  color: #e4a15f;
  font-size: 10px;
  letter-spacing: .05em;
}
.share-export-button:hover:not(:disabled) {
  background: #e4a15f;
  color: #07131e;
}
.share-export-button:disabled {
  opacity: .5;
  cursor: wait;
}
.share-export-image-button {
  border-color: rgba(103, 186, 161, .42);
  background: rgba(103, 186, 161, .08);
  color: #8fc4b2;
}
.share-export-image-button:hover:not(:disabled) {
  background: #67baa1;
  color: #07131e;
}
.share-export-error {
  margin: 0;
  color: #d08a6f;
  font-size: 9px;
  line-height: 1.5;
  text-align: right;
}
```

移动端规则补充 `.share-export-tools { justify-items: start; }`。打印规则把
`.share-print-button` 改为 `.share-export-tools`，保证整个操作区不进入 PDF。

- [ ] **Step 3: 更新 README**

在今日批次说明后增加：

```markdown
报告通过审阅并发布后，“对客交付”区域会生成分享链接。点击“打开对客报告”进入
独立分享页，可从页头导出 PDF，或下载包含完整报告和缠论图表的 PNG 长图；导出文件
不会包含操作按钮。
```

- [ ] **Step 4: 检查本次样式差异没有覆盖既有改动**

Run:

```bash
git diff --no-index \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/styles.css \
  apps/web/src/styles.css || true
git diff --no-index \
  .superpowers/baselines/2026-08-24-report-export/README.md README.md || true
```

Expected: 只出现导出按钮、打开报告链接、移动端和打印隐藏规则，以及 README 新段落。

- [ ] **Step 5: 运行文档检查**

Run:

```bash
npx markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-24-report-long-image-export-design.md \
  docs/superpowers/plans/2026-08-24-report-long-image-export.md
```

Expected: 0 issues。

- [ ] **Step 6: 仅暂存本功能样式和 README**

Run:

```bash
git add README.md
git add -p apps/web/src/styles.css
git diff --cached -- apps/web/src/styles.css README.md
```

Expected: 对 `styles.css` 已有记录页改动选择 `n`，只对导出相关 hunks 选择 `y`；
暂存区不包含其他功能改动。

- [ ] **Step 7: 提交样式和文档**

Run:

```bash
npx gitnexus analyze
npx gitnexus detect-changes -r investment-advisor -s staged
git diff --cached --check
git commit -m "docs(web): document report export entry"
```

Expected: 提交只包含本功能样式与 README，原有 `styles.css` 修改仍留在工作区。

### Task 4: 完整验证与浏览器验收

**Files:**

- Verify: `apps/web/src/SharedReportPage.tsx`
- Verify: `apps/web/src/OutlookPanel.tsx`
- Verify: `apps/web/src/styles.css`

- [ ] **Step 1: 运行前端定向测试**

Run:

```bash
npm --prefix apps/web test -- SharedReportPage.test.tsx \
  OutlookPanel.test.tsx ChanChart.test.tsx App.test.tsx
```

Expected: 相关测试全部通过，无错误和警告。

- [ ] **Step 2: 运行完整前端测试、类型检查和构建**

Run:

```bash
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Expected: 三条命令退出码均为 0。

- [ ] **Step 3: 启动隔离的 mock 前端**

Run:

```bash
VITE_API_BASE_URL= npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5176
```

Expected: Vite 启动成功；若端口占用，使用命令输出中的实际端口。

- [ ] **Step 4: 从批次页完成真实入口闭环**

使用 `agent-browser` 打开批次页，并在内置 mock 数据上依次生成、审阅、发布和创建
分享链接：

```bash
agent-browser --session report-export open 'http://127.0.0.1:{port}/#/batch'
agent-browser --session report-export find role button click \
  --name '生成 Pi AI 走势报告'
agent-browser --session report-export wait 500
agent-browser --session report-export find role button click --name '通过审阅'
agent-browser --session report-export wait 300
agent-browser --session report-export find role button click --name '发布给客户'
agent-browser --session report-export wait 300
agent-browser --session report-export find role button click --name '生成分享链接'
agent-browser --session report-export wait 300
agent-browser --session report-export eval \
  'document.querySelector("a.delivery-action-link").target = "_self"'
agent-browser --session report-export find role link click --name '打开对客报告'
agent-browser --session report-export wait 500
agent-browser --session report-export snapshot -i
agent-browser --session report-export console
agent-browser --session report-export errors
```

Expected: 浏览器通过真实入口进入 `#/share/share-report-...`，顶部同时存在“导出
PDF”和“导出长图”，控制台无新增错误。测试中只把链接的 `target` 临时改为
`_self`，用于让新路由复用当前标签页的内存 mock API；链接自身的 `_blank` 属性由
自动化测试验证，生产环境的后端分享状态不受此限制。

- [ ] **Step 5: 下载并视觉检查长图**

Run:

```bash
mkdir -p tmp/report-export
agent-browser --session report-export download \
  'button.share-export-image-button' tmp/report-export/shared-report.png
file tmp/report-export/shared-report.png
sips -g pixelWidth -g pixelHeight tmp/report-export/shared-report.png
```

随后使用 `view_image` 打开绝对路径
`/Users/niko/Documents/Codex/2026-08-12/pi-agent/tmp/report-export/shared-report.png`，
检查报告从标题到免责声明完整、图表存在、按钮未出现、无截断或明显错位。

Expected: PNG 可打开，宽度约为报告 DOM 的两倍，内容完整。

- [ ] **Step 6: 验证移动端按钮布局**

Run:

```bash
agent-browser --session report-export set viewport 390 844
agent-browser --session report-export snapshot -i
agent-browser --session report-export screenshot --full \
  tmp/report-export/shared-report-mobile.png
agent-browser --session report-export eval \
  '({clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth})'
```

使用 `view_image` 打开绝对路径
`/Users/niko/Documents/Codex/2026-08-12/pi-agent/tmp/report-export/shared-report-mobile.png`。

Expected: 两个按钮都可见且可点击，没有遮挡标题；`clientWidth` 与 `scrollWidth`
相等，没有横向溢出。

- [ ] **Step 7: 回归 PDF**

Run:

```bash
agent-browser --session report-export set viewport 1280 900
agent-browser --session report-export pdf tmp/report-export/shared-report.pdf
pdfinfo tmp/report-export/shared-report.pdf
pdftotext -layout tmp/report-export/shared-report.pdf \
  tmp/report-export/shared-report.txt
pdfimages -list tmp/report-export/shared-report.pdf
pdftoppm -png -r 150 tmp/report-export/shared-report.pdf \
  tmp/report-export/shared-report-page
```

逐页使用 `view_image` 检查 `shared-report-page-*.png`。

Expected: PDF 仍包含完整报告与图表，且两个导出按钮均被隐藏。

- [ ] **Step 8: 执行最终影响分析**

Run:

```bash
npx gitnexus analyze
npx gitnexus detect-changes -r investment-advisor -s compare -b HEAD~4
git diff HEAD~4..HEAD --check
```

Expected: 四个功能提交的影响范围只包含分享报告、对客交付入口、依赖和样式；风险
不是 HIGH 或 CRITICAL。工作区原有未提交修改不参与此比较。

- [ ] **Step 9: 检查工作区边界**

Run:

```bash
git status --short
git diff --no-index \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/App.tsx \
  apps/web/src/App.tsx || true
git diff --no-index \
  .superpowers/baselines/2026-08-24-report-export/apps/web/src/App.test.tsx \
  apps/web/src/App.test.tsx || true
```

Expected: `App.tsx` 和 `App.test.tsx` 与基线一致，已有交易复盘改动保持原样。
