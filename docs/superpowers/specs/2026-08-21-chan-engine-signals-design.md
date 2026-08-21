# 缠论引擎信号栈设计

## 背景

ChanEngine 目前只覆盖包含处理、分型、严格笔和顺序笔中枢。对客研报和
对己归因都已经能诚实回答「情景兑现了没有」「买点在中枢什么位置」，但
分辨率停在「笔」。P1 的第一份 spec 只做引擎信号栈：在严格笔之上补出
线段、走势类型、MACD 背驰和一二三类买卖点，并用 30 分钟线作为日线一类
买卖点的次级别确认。

图表标注和回测框架不在本 spec。它们依赖本 spec 产出的可回放事实，另开
后续 spec。

改 `ChanEngine` 的直接调用方是 `analysis.py`、`reporting.py`、
`trading/attribution.py`、`trading/metrics.py`、`domain/report_outcome.py`。
风险为中等。本 spec 要求旧 snapshot 键只增不改，避免这些调用方因字段消失
而断裂。

## 目标

- 删除按数量拼接的 `frozen_confirmed`，每次 `ingest` / `replay` 都对已摄入
  K 线做全量重算；`replay(bars)` 与逐根 `ingest` 的最终 snapshot 仍相等。
- 按缠中说禅第 67、68、71 课的操作化读法划分线段：特征序列、标准特征序列、
  缺口破坏与分型破坏。
- 用本级别线段中枢判定走势类型（盘整 / 上涨趋势 / 下跌趋势）。
- 用固化前复权收盘本地计算 MACD，比较离开段柱面积判定趋势背驰。
- 一类买卖点只来自趋势背驰，且必须有次级别确认：日线的次级别是 30 分钟，
  周线的次级别是已有日线。
- 30 分钟行情提前分批拉入 PostgreSQL；分析路径只读缓存，不现场请求 Tushare。
- 30 分钟线不开放图表、独立分析接口或投研报告。
- 新结构以事实进入引用注册表；模型只能引用，不能编造买卖点或背驰数字。
- 引擎版本升为 `chan-engine.v1.2`。报告 `input_digest` 已包含引擎版本，
  旧报告保持固化，不重算。

## 非目标

- 不开放 `timeframe=30m` 的分析、图表或报告接口。
- 不拉 5 分钟线，不把 30 分钟再拆出更次一级。
- 不把买卖点画到 ECharts（下一份 spec）。
- 不搭回测框架（下一份 spec）。
- 不接指数、板块、港股或基金。
- 不把盘整背驰升成一类买卖点。
- 不在分析路径现场补拉 30 分钟。
- 不由模型生成价格、面积、买卖点坐标或确认状态。

## 方案选择

### 方案 A：编排器 + 纯函数层，采用

`ChanEngine._reduce` 只编排。线段、MACD、走势、背驰、买卖点和次级别确认
都是对 snapshot 片段的纯函数，各自带独立测试。旧键 `bars` / `fractals` /
`strokes` / `confirmed` / `provisional` / `centers` 保留。新键只追加。

30 分钟复用 `market_history_snapshots`，`timeframe` 取 `30m`。预拉命令按
日期分片写入；`MarketAnalysisService.analyze` 只读缓存。

### 方案 B：另开 ChanSignalEngine

`ChanEngine` 完全不动，信号层吃现成笔快照。隔离更好，但分析、注册表、
digest 要维护两套生命周期，一类确认还要在外侧拼日线与 30 分钟。不采用。

### 方案 C：全部写进 `chan_engine.py`

实现最快，文件会从 321 行涨到难以单测的体量，也违背已经拆出
`build_centers` 的方向。不采用。

## 总体架构

```text
日线/周线 K 线（已有缓存）
        |
        v
ChanEngine.replay          30 分钟 K 线（预拉缓存，只读）
  包含 → 分型 → 严格笔            |
  顺序笔中枢                      v
  线段 → 线段中枢            ChanEngine.replay（同一套函数）
  MACD → 走势类型 → 背驰          |
  二类/三类（本级别能验的）        |
        |                        |
        +---- confirm_class1 ----+
                    |
                    v
        snapshot + 引用注册表新事实
```

`engine_version` 固定为 `chan-engine.v1.2`。

## 快照契约

`ChanEngine.snapshot()` 在现有键之外追加：

```python
{
  "segments": [Segment, ...],
  "segment_centers": [Center, ...],
  "macd": {
    "ready": bool,
    "warmup_bars": 26,
    "histogram": ["0.12", ...],   # 与 snapshot.bars 等长；未就绪则为 []
  },
  "trend": {
    "type": "uptrend" | "downtrend" | "consolidation" | "unavailable",
    "center_count": int,
    "unavailable_reason": str | None,
  },
  "divergences": [Divergence, ...],
  "signals": [Signal, ...],
}
```

旧键语义：

- `confirmed` = 全量重算后的 `strokes[:-1]`
- `provisional` = 全量重算后的 `strokes[-1:]`
- 删除 `_frozen_confirmed` 字段及其按数量拼接逻辑
- `test_confirmed_output_is_not_rewritten_by_future_append` 改为断言
  「全量 replay 等于逐根 ingest」，不再要求 confirmed 前缀永不改变

价格、时间、面积一律用字符串小数，与现有笔/中枢一致。

### Segment

```python
{
  "direction": "up" | "down",
  "start_stroke": int,          # 指向 snapshot.strokes
  "end_stroke": int,
  "start_index": int,           # 结构 K 线索引，便于复用 build_centers
  "end_index": int,
  "start_price": str,
  "end_price": str,
  "occurred_at": datetime,
  "known_at": datetime,
  "stable_through": datetime,
  "status": "confirmed" | "provisional",
  "break_kind": "gap" | "fractal" | None,   # 未破坏则为 None
}
```

最后一段在输入结束时未被破坏则为 `provisional`。笔数不足 3 的尝试不输出。

### Divergence

```python
{
  "kind": "trend" | "consolidation",
  "direction": "top" | "bottom",
  "from_segment": int,
  "to_segment": int,
  "price_extreme": str,
  "previous_price_extreme": str,
  "area": str,
  "previous_area": str,
  "status": "confirmed" | "unevaluable",
  "unevaluable_reason": str | None,
}
```

`kind=consolidation` 只记账，不生成一类买卖点。

### Signal

```python
{
  "klass": "class1" | "class2" | "class3",
  "side": "buy" | "sell",
  "occurred_at": datetime,
  "price": str,
  "status": "confirmed" | "provisional" | "unevaluable",
  "reason": str | None,
  "divergence_index": int | None,
  "sublevel": {
    "timeframe": "30m" | "1d",
    "status": "confirmed" | "provisional" | "unavailable",
    "reason": str | None,
    "window_start": datetime | None,
    "window_end": datetime | None,
  } | None,
}
```

一类的 `sublevel` 必填。二类若依赖次级别回抽则同样填写。三类
`sublevel` 为 `None`。

一类的 `price` / `occurred_at` 取本级别离开段终点（最后一笔的
`end_price` / `occurred_at`），不取次级别确认事件。注册表用这个时间判断
「是否仍属于最后离开段」。二类取次级别第一段反向已确认线段的终点。
三类取本级别回抽线段终点。

`reason` 使用固定枚举，不使用自由文本：

- `class1_sublevel_market_not_ready`
- `class1_sublevel_structure_incomplete`
- `macd_not_ready`
- `class2_pullback_incomplete`

`insufficient_centers` 只出现在 `trend.unavailable_reason`，不是 `Signal.reason`。

## 冻结修复

`ChanEngine.ingest` 不再把上一根的 `confirmed` 按长度拼到新笔序列上。
`_reduce` 始终用当前 `_input` 全量计算分型、笔、中枢，再算新层。

`ingest` 去重从线性扫描改为 `(symbol, occurred_at)` 字典。重复且内容相同
仍返回 `{"changed": False}`；内容冲突仍抛 `ValueError`。乱序仍拒绝。
这是 30 分钟约一万根回放的前提，日线五年一千二百根也受益。

## 线段（第 67 / 68 / 71 课的操作化）

输入是 `strokes`（含最后一笔形成中笔）。输出是 `segments`。

### 特征序列

- 向上线段的特征序列元素 = 该尝试区间内的向下笔
- 向下线段的特征序列元素 = 该尝试区间内的向上笔
- 每个元素的高 = `max(start_price, end_price)`，低 = `min(start_price, end_price)`

### 标准特征序列

对特征序列做包含处理，规则与现有 K 线包含相同：

- 尚未确定方向时，合并取更高高、更低低
- 向上包含：高取高、低取高
- 向下包含：高取低、低取低
- 方向由相邻未包含元素的高低比较决定

包含后的序列称为标准特征序列。

### 线段成立与破坏

从第一笔起尝试生长一段。一段至少 3 笔。破坏二选一，先到先得：

1. **缺口破坏**：标准特征序列至少 3 个元素后，下一元素与前一元素无重叠
   （`high < prev_low` 或 `low > prev_high`）。
2. **分型破坏**：标准特征序列出现与线段方向相反的分型。分型定义与现有
   K 线分型相同：中间元素的高和低都高于两侧为顶，都低于两侧为底。
   向上线段被顶分型破坏，向下线段被底分型破坏。

破坏成立后，该段 `status=confirmed`，`break_kind` 为 `gap` 或 `fractal`，
并从破坏点按原文接法开始下一段（破坏分型的特征元素对应的笔作为新段的
前笔，具体索引由测试夹具钉死，避免实现时两可）。

输入结束仍未破坏的最后一段为 `provisional`，`break_kind=None`。

无法唯一判定时不输出该段，也不标 `provisional`。
`provisional` 只表示「输入结束时尚未破坏」。禁止用启发式补线段。

### 线段中枢

`build_centers(segment_strokes)`，其中每段先收成与笔相同的
`start_index` / `end_index` / `start_price` / `end_price` 形状。
顺序消费，离开后再找下一个，不滑窗重叠。结果写入 `segment_centers`。

## 走势类型

只看本级别 `segment_centers`：

| 中枢数量 | `trend.type` | 说明 |
|----------|--------------|------|
| 0 | `unavailable` | `insufficient_centers` |
| 1 | `consolidation` | 盘整 |
| ≥2 且依次上移 | `uptrend` | 后一个 `lower >=` 前一个 `lower` 且 `upper >=` 前一个 `upper`，至少一处严格大于 |
| ≥2 且依次下移 | `downtrend` | 对称 |
| ≥2 但不单调 | `consolidation` | 取最后那个中枢视为当前盘整，不把整段叫趋势 |

「上移 / 下移」不允许用中点近似，必须用区间端点。

## MACD

纯函数，输入为与 `snapshot.bars` 对齐的前复权收盘字符串序列。

- 参数固定：快 12、慢 26、信号 9
- 种子：前 N 根的简单平均，之后才是 EMA
- `DIF = EMA12 - EMA26`
- `DEA = EMA(DIF, 9)`
- 柱 = `2 * (DIF - DEA)`
- 根数 < 26 + 9 时 `macd.ready=false`，`histogram=[]`，所有面积类判定
  `unevaluable` / `macd_not_ready`

不调用 Tushare 或其他外部 MACD。

## 背驰

只在 `trend.type` 为 `uptrend` 或 `downtrend` 时比较**趋势背驰**：

- 离开段 = 最后一个线段中枢之后、同趋势方向的线段序列，价格极值取其高/低
- 前一段 = 倒数第二个中枢之后、进入最后一个中枢之前的同向离开
- 面积 = 只累加**同向离开段自身**时间范围内的同号 MACD 柱（上涨比红柱，
  下跌比绿柱）。中间反向段的柱不计入，也不把两段之间的闭包整段拿来积分。
- 顶背驰：后段价格更高，面积不更高
- 底背驰：后段价格更低，面积不更低
- 价格创新高/低但 MACD 未就绪：`unevaluable`

盘整背驰：仅当 `trend.center_count == 1` 时记账。`trend.type` 因
「≥2 且不单调」落成 `consolidation` 时不算盘整背驰。比较该中枢两侧同向
离开段的价格与面积。`kind=consolidation`，**不**生成一类信号。

## 买卖点

### 一类

- 上涨趋势顶背驰 → `class1` / `sell`
- 下跌趋势底背驰 → `class1` / `buy`
- 盘整背驰不是一类
- 必须次级别确认，不能把本级别背驰直接标 `confirmed`

次级别映射：

| 本级别 | 次级别 | 来源 |
|--------|--------|------|
| `1d` | `30m` | 预拉缓存 |
| `1w` | `1d` | 已有日线缓存 |

`confirm_class1(parent, child_bars) -> Signal`（含 `status`、`reason`、
`sublevel`，不是只返回 status 枚举）：

次级别**先按本级别离开段切片再 `replay`**，禁止先全量回放再挑窗口内事件。
两者线段不同，确认条件会对不上。

窗口按**交易日包含**，不比较 raw UTC 时间戳。日线 `occurred_at` 是
「交易日 00:00 UTC」，30 分钟是「bar 结束时间（上海时区转 UTC）」；
若按 `occurred_at <= T1` 比较，离开段最后一天 01:30–07:00 UTC 的 30 分钟
K 线会被丢掉，而一类确认最常出现在离开段末尾。

1. 离开段的交易日闭区间为 `[D0, D1]`：`D0` 是本级别离开段第一笔起点的
   上海日历日，`D1` 是最后一笔终点的上海日历日。周线离开段的 `D1` 取该
   周最后一个已完成交易日，不是周一。
2. 取次级别 K 线：其上海日历日 ∈ `[D0, D1]`，再向前多取 120 根（或不足则
   全取）只作引擎预热。预热区只排除「完成日早于 D0」的线段；起点在预热、
   终点落在 `[D0, D1]` 的线段算确认事件。
3. 对这批 K 线 `ChanEngine.replay`。
4. 确认事件的上海日历日必须 ∈ `[D0, D1]`：出现与本级别相反方向的
   **已确认**线段，或次级别自身的反向趋势背驰。
   「反向趋势背驰」指次级别 `trend.type` 与本级别离开方向相反，且该背驰
   `direction` 对本级别是反转（本级别向上离开对应次级别 `bottom`，
   本级别向下离开对应次级别 `top`）。
5. `sublevel.window_start` / `window_end` 记 `D0` / `D1` 的日期，不记
   日线 00:00 UTC。

状态：

- 次级别行情缺失，或切片后可用 K 线为空：`unevaluable` /
  `class1_sublevel_market_not_ready`
- 切片已回放，但 `[D0, D1]` 内没有合格确认事件：`provisional` /
  `class1_sublevel_structure_incomplete`
- `[D0, D1]` 内出现合格确认事件：`confirmed`

### 二类

一类（`confirmed` 或 `provisional`）出现之后，在同一离开段窗口内，次级别
第一段与一类反向的**已确认**线段，其极值不破一类价。

- 没有一类：不输出二类
- 次级别缺失或切片为空：`unevaluable` / `class1_sublevel_market_not_ready`
- 窗口内还没有这段反向已确认线段：`provisional` / `class2_pullback_incomplete`
- 该线段已确认且极值不破一类价：`confirmed`
- 该线段已确认但破了极值：不输出二类

### 三类

只看本级别线段中枢，不要求次级别。

离开中枢后的第一段回抽，收盘极值不回到 `[lower, upper]`（闭区间，与现有
中枢包含价格的口径一致）。回抽线段已确认则 `confirmed`，否则
`provisional`。回抽已回到区间则不输出三类。

## 30 分钟数据

### 取数

`TushareMarketProvider` 新增 `minutes30(code, *, as_of, start_date, end_date)`，
调用 Tushare `stk_mins`，`freq="30min"`。权限不足或上游失败抛出已有的
`MarketProviderError`，不返回空列表冒充「这段没有分钟线」。

前复权：用**当日**日线 `adj_factor`，再按 `as_of` 当日因子把全窗口换算到
与日线相同的基准。分钟线没有独立复权因子。某日缺少日线因子时，该日分钟线
整批标质量警告，价格回退未复权并写入 `payload` 的 quality，不能用邻日因子
偷偷填。

`CanonicalBar.occurred_at` 取该 30 分钟 bar 的结束时间，时区为
`Asia/Shanghai`，再转 UTC 保存，与现有日线「交易日 00:00 UTC」的约定不同，
但 `known_at` / `stable_through` 仍等于 `occurred_at`。

### 缓存

复用 `market_history_snapshots`，`timeframe="30m"`，`adjustment="qfq"`。
主键已经包含 `symbol, timeframe, adjustment, as_of, start_date, end_date`。
现有 `get_market_history` 是精确命中，不会自动拼接分片。

因此缓存分两层，职责不能混：

1. **下载分片**：`start_date`/`end_date` 跨度不超过 20 个交易日，只用于
   断点续拉，分析路径不读这些键。
2. **分析窗**：一轮预拉在全部分片成功后，再物化一条分析窗。`as_of` /
   `start_date` / `end_date` **必须与同一次日线分析使用的窗口函数完全相同**
   （现有 `as_of - 365 * 5` 到 `as_of`），禁止另写一套 `as_of-5y`。
   分析只精确读这一条。任一下载分片失败则不更新分析窗，旧分析窗保持不动。

### 预拉

独立命令：

```bash
uv run python -m app.market_prefetch \
  --symbol 002940.SZ --timeframe 30m --as_of 2026-08-21
```

`--as_of` 必填。前复权基准绑在这个日期上；不写则拒绝运行。今日预拉与
历史 `as_of` 分析不是同一缓存键。

- 按不超过 20 个交易日一片请求 `stk_mins`
- 一片成功才写下载分片，失败不覆盖该分片
- 全部分片成功后才重写分析窗
- 幂等：分析窗 payload hash 不变则视为命中
- 不在 FastAPI `analyze` 或报告任务里触发预拉

### 分析路径

`MarketAnalysisService.analyze` 对日线：

1. 照常回放日线
2. 用与日线相同的 `as_of` / 五年窗精确读取 `30m` 分析窗
3. 命中则把分析窗 K 线交给 `confirm_class1`；函数内部再按离开段切片回放，
   不在分析服务里先全量回放 30 分钟结构
4. 未命中不请求 Tushare，一类 / 依赖次级别的二类记
   `class1_sublevel_market_not_ready`

周线分析读已有日线缓存作为次级别，规则相同。

30 分钟回放失败（脏数据、乱序）不得让日线分析失败：日线 snapshot 仍返回，
信号层降级，质量警告写入 `chan_analysis` 的 quality。

## 引用注册表

`build_reference_registry` 只追加仍「可用」的事实。一类 / 二类 / 三类各只
暴露**最后一条**满足以下全部条件的信号：

- `status` 为 `provisional` 或 `confirmed`（`unevaluable` 不进注册表）
- 仍属于当前走势的最后离开段（`occurred_at` 不早于最后一个线段中枢的
  `occurred_at`；没有线段中枢则不暴露买卖点）
- 未被之后的反向已确认线段作废

不把五年前已失效的一类买卖点送给模型。

新增引用（名称固定）：

- `chan.trend.type`
- `chan.segment.last.direction`
- `chan.segment.last.end_price`
- `chan.segment_center.upper` / `chan.segment_center.lower`
  （仅当存在仍含现价的线段中枢）
- `chan.divergence.last.kind` / `direction` / `area` / `previous_area`
- `chan.signal.class1.side` / `status` / `price` / `occurred_at`
- `chan.signal.class2.side` / `status` / `price`
- `chan.signal.class3.side` / `status` / `price`

叙述字段仍然禁止数字和交易词汇。买卖点的价格与时间只能出现在水合后的
条件/注册表，不出现在情景正文。

`signal_summary` 从三个计数改为包含：

`confirmed=…; provisional=…; centers=…; trend=uptrend; class1=sell:provisional`

仍然是确定性字符串，不是模型生成。

`PROMPT_VERSION` 升为 `pi-advisor.v2.2`，提示词只增加「可以引用上述结构
事实，不得编造未出现的买卖点」。四步状态机不变。

## 模块边界

| 模块 | 职责 |
|------|------|
| `chan_engine.py` | 编排 `_reduce`；去重；删除 freeze；调用下层 |
| `chan_segments.py` | `build_segments` / 特征序列 / 标准特征序列 / 破坏 |
| `chan_macd.py` | `compute_macd` / `histogram_area` |
| `chan_signals.py` | 走势类型、背驰、本级别二三类 |
| `chan_confirm.py` | `confirm_class1` / 二类次级别回抽 |
| `providers/tushare.py` | `minutes30` |
| `analysis.py` | 读 30m 缓存、降级、写入 `chan_analysis` |
| `reporting.py` | 注册表新引用与 `signal_summary` |
| `market_prefetch.py` | 分片预拉命令 |
| `CONTEXT.md` | 补线段、走势类型、背驰、买卖点、次级别确认词汇 |

前端本 spec **不改** `ChanChart` 数据契约。多出来的 snapshot 字段对现有
适配层是未知键，必须忽略而不是报错。

## 错误处理

- 30 分钟权限不足：预拉命令失败并给出安全摘要；分析不受影响，信号降级。
- 30 分钟缓存缺失：分析成功，一类 / 二类 `unevaluable`。
- 30 分钟脏数据：日线分析成功，质量警告，次级别 `unavailable`。
- MACD 样本不足：背驰与一类 `unevaluable` / `macd_not_ready`。
- 线段无法唯一划分：不输出该段，不回退成「三笔同向即成段」。
- 旧报告：digest 含 `chan-engine.v1.1` 或更早，不重放到 v1.2。

## 测试策略

全部先写失败测试。夹具用构造 K 线，不打真实 Tushare。

1. 冻结：逐根 ingest 等于一次 `replay`；删除「confirmed 前缀永不改写」断言。
2. 去重：一万根量级的重复时间查找不得再走 O(n) 扫描（可用计时或直接断言
   使用键集合；优先断言行为：重复 ingest 仍幂等）。
3. 特征序列包含：给出三组相邻笔，断言标准特征序列高低。
4. 缺口破坏：构造无重叠的特征元素，断言一段 `confirmed` 且 `break_kind=gap`。
5. 分型破坏：构造顶/底分型，断言方向正确的破坏。
6. 未破坏尾段：`provisional`。
7. 线段中枢：顺序消费，两组不相交。
8. MACD：用手算的短序列钉死前几根柱值。
9. 趋势背驰：价格新高、面积不新高 → 顶背驰；反之底背驰。
10. 盘整背驰：仅 `center_count==1` 时有记录，不出现 `klass=class1`；
    ≥2 且不单调的 `consolidation` 不得记盘整背驰。
11. 一类：无 30 分钟 → `class1_sublevel_market_not_ready`；次级别反向线段
    未确认 → `provisional`；已确认 → `confirmed`；窗口必须落在离开段内。
12. 二类 / 三类：不破极值 / 不回中枢才输出。
13. 预拉：下载分片失败不改分析窗；分析只命中五年窗键；`analyze` 不调用
    `provider.minutes30`。
14. 一类确认：全量 30 分钟结构里存在反向线段、但离开段窗口内没有时，
    不得标 `confirmed`。
15. 注册表：新引用只在事实存在时出现；情景正文仍禁数字。
16. 回归现有笔、中枢、归因、兑现测试。

## 验收标准

- `ChanEngine().replay(bars) ==` 逐根 ingest 后的 snapshot。
- 旧 snapshot 键仍存在，归因和兑现测试不因缺键失败。
- 引擎版本为 `chan-engine.v1.2`。
- 日线分析在没有 30 分钟缓存时仍返回 200，一类为 `unevaluable`。
- 预拉写入后，同一 `as_of` 再分析可以把一类升为 `provisional` 或
  `confirmed`，且 `sublevel.window_*` 落在离开段内。
- 盘整背驰用例不产生一类信号。
- 前端现有图表测试无需修改即可通过。
- 不出现 `timeframe=30m` 的对外路由。

## 词汇

实施时写入 `CONTEXT.md`：

**线段**：至少三笔、由特征序列破坏确认的本级别结构。未破坏的最后一段是
形成中线段。_Avoid_: 笔、中枢

**走势类型**：由本级别线段中枢数量与位移判定的盘整或趋势。_Avoid_: 行情、形态

**背驰**：同向离开段的价格极值与 MACD 柱面积比较。趋势背驰才是一类候选。
_Avoid_: 顶底背离（口语）、MACD 金叉

**买卖点**：一类需次级别确认；二类是一类后的不破极值回抽；三类是中枢离开后
的不回抽。_Avoid_: 信号、策略点

**次级别确认**：日线看 30 分钟，周线看日线。缓存没有就明确不可用，不现场猜。
_Avoid_: 多周期共振
