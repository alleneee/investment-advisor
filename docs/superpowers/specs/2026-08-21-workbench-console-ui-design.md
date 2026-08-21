# 工作台控制台 UI 设计

## 背景

工作台已有今日批次、研究记录、数据快照、交易日记、复盘中心和对外分享页。
视觉是深青底、宋体大标题、珊瑚主按钮、01/02 装饰编号、9–11px 正文。数字不够
跳，长页主次不清。按钮用 `↗`、`×` 等字符冒充图标。

用户要求整站更美观、数据更直观、结构划分更清楚，并达到 Awwwards / FWA /
CSS Design Awards 量级的视觉完成度：浏览器是一张完整画布，而不是后台表格皮肤。
已确认：覆盖全部工作台页面；信息架构为顶部 KPI 加左右双栏；盈亏为 A 股红涨绿跌；
抽出共用零件再拼装各页。

## 目标

- 五页工作台加分享页是同一件作品：色板、字体、图标、动效、氛围层统一。
- 关键数字一眼可读：大号等宽、千分位、带符号、红涨绿跌。
- 每页信息架构固定为：KPI → 左上下文 / 右主操作 → 全宽次要信息。数据区不实验化。
- 画布层（侧栏、页头、空态、氛围）允许先锋排版、物理感动效和渲染层。
- 图标只用来自 Lucide 的 SVG。界面零表情符号，也不用 `↗` `×` `!` 等字符代替图标。
- 不改变任何 API、账本、报告字段或金额精度。

## 非目标

- 不改后端、路由语义、hash（`#/batch|records|snapshots|journal|reviews|share/...`）。
- 不加功能：线段/背驰、登录、多账户、新图表指标。
- 不把金额字段转成 JavaScript `number`。
- 不做截图像素回归。
- 不把分享页改成工作台双栏；打印仍白底、无动画、无氛围层。
- 不把 `App.tsx` 的数据逻辑拆成新状态库。
- 不引入 Three.js / 全屏 WebGL 场景 / 粒子游戏。氛围层用 CSS + 一层轻量 Canvas 2D。
- 不为动效牺牲表单可用性或键盘操作。

## 方案选择

采用「画布壳 + 控制台零件 + 现有页面拼装」。

- 壳：全屏氛围、侧栏、页头巨型标题、Lucide 导航。
- 零件：KPI、Panel、SplitPane、表、空态。
- 数据区保持可读网格，不把成交表单拆成实验性瀑布流。

未采用只换皮：无法形成 KPI + 双栏，也达不到画布完成度。
未采用按页独立艺术站：会漂成五套风格，数据对不齐。
未采用全页 WebGL：挡操作、难测、打印失败。

## 视觉令牌

写在 `apps/web/src/styles.css` 的 `:root`，组件只引用变量。不要用 GitHub 默认蓝黑
冒充设计。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#05080c` | 画布底，略冷青 |
| `--bg-elev` | `#0b1218` | 侧栏、页头 |
| `--surface` | `#101920cc` | 玻璃卡片（可加 backdrop-filter） |
| `--border` | `rgba(214, 232, 222, 0.12)` | 1px 描边 |
| `--text` | `#eef4f0` | 主文字 |
| `--muted` | `#8a9b96` | 标签、说明 |
| `--accent` | `#7ee0c8` | 选中、焦点、非涨跌强调（不是盈亏绿） |
| `--up` | `#f6465d` | 涨、盈利、买入标记 |
| `--down` | `#0ecb81` | 跌、亏损、卖出标记 |
| `--risk` | `#f0b429` | 回撤、警告、降级 |
| `--radius` | `2px` 控件 / `18px` 卡片 | 锋利控件 + 软卡片 |

字体：

- 展示：`Syne`（页标题、空态大字，允许略挤、clip、letter-spacing 负值）。
- 界面：`IBM Plex Sans`。
- 数字：`IBM Plex Mono` + `font-variant-numeric: tabular-nums`。

KPI 值约 32px，次级 18px，正文 14px，标签 11px。对比度：正文对底 ≥ 4.5:1。

拿掉：Noto Serif SC 英雄句、珊瑚块状按钮、01/02 装饰编号、5px 偏移阴影、
`↗`/`×` 字符图标。

## 图标

依赖 `lucide-react`。只通过 `apps/web/src/ui/Icon.tsx` 使用：
`<Icon icon={Plus} />`，其中 `icon` 为 Lucide 组件。统一 `size={18}`、
`strokeWidth={1.75}`。旁边已有可见文字时 `aria-hidden`。独立图标按钮必须有
`aria-label`。

禁止：emoji、emoji 短代码、字体图标、按钮里的 `↗` `×` `!`。通知改用
`AlertTriangle`，移除改用 `X`，生成改用 `ArrowUpRight`，加入改用 `Plus`。

导航建议：批次 `LayoutDashboard`，记录 `ScrollText`，快照 `Database`，日记
`NotebookPen`，复盘 `ChartCandlestick`。

## 画布与动效

- `Atmosphere`：`position: fixed; inset: 0; pointer-events: none; z-index: 0`。
  CSS 径向光 + 一张提交进仓库的 grain 平铺图（`apps/web/src/ui/atmosphere-grain.png`）
  + 可选 Canvas 2D 微噪。不挡点击。内容层 `z-index: 1`。
  图只服务氛围，禁止人物、Logo、K 线截图。
- 页头标题允许超大、破网格、部分溢出；数据卡片仍对齐基线网格。
- 动效：入场 stagger（位移 8–16px + 透明度，200–400ms）、卡片 hover 轻微上浮、
  主按钮按压缩放。只用 CSS 或极小的 `element.animate`。禁止无限闪烁。
- `@media (prefers-reduced-motion: reduce)`：取消位移和 canvas 动画，只保留透明度切色。
- 图片素材：仅上述 grain。不配人物、不配股票摄影、不接运行时生图。

## 展示格式

新增 `apps/web/src/ui/formatDisplay.ts`，只用于 UI：

- 千分位只加在小数点左侧，保留原小数部分；失败则原样显示。
- 带符号盈亏：正数前加 `+`，负数保留 `-`，零不带符号。
- `tone`：`up` 红、`down` 绿、`risk` 橙、`neutral` 主文字。
- 当日盈亏、周期盈亏、闭合周期盈亏：正 `up`，负 `down`，零 `neutral`。
- 最大回撤、成立以来回撤：`risk`。
- 胜率、纪律率、现金、权益、股数：`neutral`，除非字段本身是带符号盈亏。
- `null` / 不可用：`—`，`neutral`，不编造 `0`。

接口 JSON 仍用原字符串。测试若断言金额可见文本，改为格式化后的文本。

## 共用零件

目录：`apps/web/src/ui/`。只建这些：

| 零件 | 职责 |
|---|---|
| `Icon` | Lucide 统一出口 |
| `Atmosphere` | 全站画布层 |
| `MetricTile` | 标签 + 大数字 + `tone` |
| `KpiStrip` | 一排 MetricTile |
| `Panel` | 玻璃卡片 |
| `SplitPane` | 左约 0.9fr / 右约 1.3fr，≤1100px 单列 |
| `SegmentedControl` | `aria-pressed` 段控 |
| `DataTable` | 表样式 |
| `EmptyState` | 短句 + Lucide + 可选下一步 |
| `StatusChip` | 质量/任务状态 |

`Notice` 保留 `role="alert"`，改色板，左侧 Lucide `AlertTriangle`，不要感叹号字符。

零件测试（薄）：`MetricTile` 色；`formatDisplay`。不测像素、不测 canvas 帧。
流水文案里的乘号「价格 × 股数」是数学符号，保留，不算图标替代。

## 页面拼装

保留现有标题文字、按钮名称、`aria-label`、表格 `aria-label`，除非金额千分位或
图标替换（可见名称不变，例如「移除 600519.SH」仍在 `aria-label`）。

### 交易日记

1. 展示标题「每日交易日记」+ 日期。
2. `KpiStrip`：总权益、可用现金、持仓市值、当日盈亏、成立以来回撤。
3. `SplitPane`：左持仓表；右成交录入、今日流水、资金流水。
4. 全宽收盘检查。
5. 无账户：创建表单进 `Panel` + `EmptyState` 说明，不显示假 KPI。

### 复盘中心

1. 周期 `SegmentedControl`、日期、预览/生成（Lucide 辅图标，文字保留）。
2. 有确定性结果时 `KpiStrip`：已实现盈亏、闭合周期盈亏、最大回撤、胜率、纪律。
   无报告不渲染 KPI。
3. `SplitPane`：左版本；右图、理由、周期、比较。
4. 全宽归因、Pi 总结。
5. 无历史：`EmptyState`「该周期还没有固化报告。」

### 今日批次

1. `KpiStrip`：自选只数、已完成、运行中、数据质量（`StatusChip`）。
2. `SplitPane`：左自选；右进度 + 结构图。
3. 全宽资讯、AI 展望。
4. 无自选/无报告：`EmptyState`，不编造结论。
5. 「生成本批报告」去掉 `↗`，改 `ArrowUpRight`。

### 研究记录 / 数据快照

现有计数进 `KpiStrip` / `MetricTile`，列表进 `DataTable`/`Panel`。口径不变。

### 分享页

单栏。屏幕用同一色板和字体，不要 Atmosphere 动画。打印白底、隐藏按钮、无 grain。

## 图表

不改计算，只改颜色与图例，与 `--up` / `--down` / `--risk` 对齐。K 线涨红跌绿；
买入红、卖出绿；回撤橙。

## 状态

- 加载：KPI/表骨架屏，不要 emoji。busy 文案保持「正在创建…」等。
- 错误：顶部 `Notice`；表单内 `role="alert"`。
- 空：`EmptyState`。账户存在且无成交的归因五类全 0 仍可显示。

## 响应式

- `≤1100px`：`SplitPane` 单列，KPI 每行最多 3 格。
- `≤700px`：KPI 每行 2 格；侧栏沿用现有窄屏。
- `≤520px`：表单单列。展示标题缩小，不新做 App 导航。

## 文件

- 新增 `lucide-react` 依赖。
- 新增 `apps/web/src/ui/*`（零件、`formatDisplay.ts`、`Atmosphere`）。
- `styles.css` 的 Google fonts 改为 Syne + IBM Plex Sans + IBM Plex Mono。
- 改 `styles.css`：令牌、画布、动效、`prefers-reduced-motion`。
- 改 `App.tsx`、`TradeJournalPage.tsx`、`ReviewCenterPage.tsx`、`OutlookPanel.tsx`、
  `StockInformationPanel.tsx`、`SharedReportPage.tsx` 的拼装与图标，不改数据获取。
- 改 `chan-chart-option.ts`、`trading-review-chart-option.ts` 颜色。
- 现有测试保持查询方式；更新对 `↗`/`×` 或金额原文的断言。
- 新增 ui 单测仅覆盖 tone、格式化、Icon 渲染 SVG。

## 验证

- `npm --prefix apps/web test` 全绿。
- `npm --prefix apps/web run build` 通过。
- 浏览器五页：KPI 可读、双栏成立、红涨绿跌、Lucide 图标、无 emoji、氛围不挡点击。
- 打开系统「减少动态效果」：无位移循环。
- 窄视口：双栏变单列，主按钮可点。
- 分享打印预览：白底、无氛围、无动画。
