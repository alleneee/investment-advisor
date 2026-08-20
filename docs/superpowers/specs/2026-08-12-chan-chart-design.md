# 真实缠论图表设计

## 背景

当前结构报告左侧的图形是静态 CSS 占位，不使用 Tushare 行情或
ChanEngine 输出。后端分析接口已返回包含处理后的结构 K 线、笔和笔中枢，
但没有返回供图表使用的原始前复权 K 线；前端还会把结构裁剪成最近几条文本。

本设计将占位图替换为真实的单图叠加缠论图表。

## 目标

- 在同一价格坐标系展示前复权 K 线、已确认笔、形成中笔和笔中枢。
- 支持日线与周线切换，默认展示日线。
- 默认展示最近六个月，并允许缩放查看完整五年数据。
- 保留当前报告卡双栏布局和视觉风格。
- 保持 Tushare 和 ChanEngine 的确定性数据边界不变。

## 非目标

- 不增加线段、递归中枢、背驰或一二三买卖点。
- 不增加分钟线、指数、基金或港股。
- 不重构研究记录、数据快照或批次流程。
- 不由模型生成任何价格、坐标或结构事实。

## 方案选择

采用单图叠加方案：K 线作为底图，笔作为折线，中枢作为半透明价格区间。

未采用上下双窗，因为价格与结构需要来回对照。未采用全宽研究工作台，
因为它会扩大为页面级重构，超出本次目标。

## 数据流

1. 后端在 `market_snapshot.bars` 返回排序后的原始前复权 OHLC，
   `chan_analysis.snapshot.bars` 继续作为包含处理后的结构 K 线。
2. `WorkbenchApi.getReport(symbol, timeframe)` 显式请求指定标的和周期。
3. 日线使用 `timeframe=1d`，周线使用 `timeframe=1w`。
4. `api.ts` 使用结构 K 线把笔和中枢索引转换为日期坐标，再生成
   强类型的 `ChanChartData`。
5. `App` 按标的和周期缓存报告，避免重复请求。
6. `ReportView` 展示周期切换，并将当前报告的图表数据交给
   `ChanChart`。
7. `ChanChart` 通过纯函数生成 ECharts 配置并管理实例生命周期。

首版只在初始自选股首项和新增成功后改变当前标的，不增加已有自选股点击切换。
缓存键为 `[symbol, timeframe]`。每次加载都携带请求键；只有响应键仍与当前请求一致
时才能更新页面，避免旧标的或旧周期的迟到响应覆盖当前报告。

切换周期时，已有缓存立即显示；没有缓存时保留当前图表并显示加载状态。

## 前端数据契约

```ts
export type Timeframe = "1d" | "1w";

export interface ChartBar {
  occurredAt: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume: number | null;
}

export interface ChartStroke {
  direction: "up" | "down";
  startAt: string;
  endAt: string;
  startPrice: number;
  endPrice: number;
  state: "confirmed" | "provisional";
}

export interface ChartCenter {
  startAt: string;
  endAt: string;
  lower: number;
  upper: number;
}

export interface ChanChartData {
  timeframe: Timeframe;
  bars: ChartBar[];
  strokes: ChartStroke[];
  centers: ChartCenter[];
}
```

`Report` 增加 `timeframe` 和 `chart`。价格字符串只在 API 适配层转换一次。

`snapshot.strokes` 和 `snapshot.centers` 的索引只属于
`chan_analysis.snapshot.bars`，不能直接索引 `market_snapshot.bars`。适配层先从结构
K 线取得端点 `occurred_at`，再将日期坐标叠加到原始前复权 K 线时间轴。

原始 K 线只要存在非有限 OHLC、日期重复或日期未升序，就拒绝整个图表响应，
不能删除中间 K 线后继续绘图。单个笔或中枢存在越界索引、非有限价格、
反向日期或 `lower >= upper` 时只忽略该结构对象；其他对象仍使用日期坐标，
不会发生索引漂移。

## 图表渲染

使用项目现有的 ECharts 5.6，并按需注册以下能力：

- `CandlestickChart` 展示前复权 OHLC。
- `LineChart` 展示笔。
- `MarkAreaComponent` 展示笔中枢。
- `TooltipComponent` 展示日期、OHLC 和结构状态。
- `DataZoomComponent` 提供内部缩放和底部滑块。
- `GridComponent` 提供类目轴和价格轴的笛卡尔坐标系。
- `CanvasRenderer` 负责渲染。

图例由 React DOM 渲染，不注册 ECharts `LegendComponent`。

颜色与现有页面一致：

- 上涨 K 线和已确认笔使用青绿色。
- 下跌 K 线与形成中笔使用橙红色。
- 笔中枢使用琥珀色半透明矩形和细边框。
- 形成中笔使用虚线，已确认笔使用实线。

默认 `dataZoom.start` 根据总 K 线数量动态计算：日线保留约 126 个交易日，
周线保留约 26 周，但滑块始终覆盖完整数据。

## 组件边界

### `api.ts`

声明完整后端快照结构，校验原始 K 线，并将结构索引转换为日期坐标，
生成报告与图表数据。

### `chan-chart-option.ts`

提供无副作用的 `buildChanChartOption(data)`。该函数负责时间轴、K 线序列、
确认笔、形成中笔、中枢和缩放窗口，不访问 DOM。

### `ChanChart.tsx`

负责初始化 ECharts、设置配置、监听容器尺寸变化和销毁实例。
没有数据时展示明确空状态，不渲染静态假图。

### `App.tsx`

持有明确的 `currentSymbol`，负责请求键、周期加载状态和 `[symbol, timeframe]`
报告缓存。新增标的成功后切换到该标的并加载日线。迟到响应只有请求键仍匹配时
才能写入状态。

## 错误处理

- 日线首次加载失败：使用现有“数据服务暂不可用”提示。
- 周线按需加载期间：周期选中态仍以当前已展示报告的 `timeframe` 为准，
  周线按钮显示加载中。
- 周线按需加载失败：不写缓存，选中态仍为日线，在图表区域显示安全错误摘要，
  周线按钮可再次点击重试。
- 图表数据为空：显示“当前周期暂无可绘制行情”。
- 原始 K 线无效：拒绝图表响应，不允许通过过滤改变时间轴。
- 单个结构对象无效：忽略该对象，其他对象使用日期坐标继续展示。
- 组件卸载：断开尺寸观察器并释放 ECharts 实例。

## 测试策略

按测试优先顺序实施：

1. 后端响应测试验证原始前复权 K 线和结构 K 线分别存在，且日线、周线窗口
   都覆盖预期五年范围。
2. API 适配测试验证结构索引映射到正确日期；中间原始 K 线无效时拒绝响应，
   结构对象越界时不会造成其他对象坐标漂移。
3. 配置生成测试验证 candlestick、两类笔、markArea 和 dataZoom。
4. 组件测试验证 ECharts 初始化、更新、调整尺寸和释放。
5. 应用测试验证显式标的请求、日周切换、缓存、乱序响应丢弃、
   新增标的清理当前视图、失败选中态、失败后重试和空数据。
6. 完整运行前端测试、类型检查和生产构建。
7. 使用昂利康 `002940.SZ` 在浏览器验证日线和周线请求、真实 Canvas、
   默认六个月窗口、缩放、提示框和控制台。

## 验收标准

- 页面不存在 `chart-mock` 静态占位和固定价格标签。
- 昂利康图表使用接口返回的真实 OHLC；图表笔数等于本次响应中
  `confirmed + provisional` 的数量，中枢数量等于本次响应的有效中枢数量。
- 图表具有真实 ECharts Canvas，日线和周线可切换。
- 默认显示最近六个月，用户可缩放至完整五年。
- 确认笔、形成中笔和中枢具有可区分的样式。
- 周线加载失败不会清空已经显示的日线报告。
- 所有自动化检查和生产构建通过。
