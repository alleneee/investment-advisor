# CZSC 0.9 其他能力复用评估

## 结论

除 K 线可视化、包含关系、分型、笔和中枢之外，CZSC 0.9.68 对本项目最有价值的
不是更多现成信号，而是三套工程能力：

1. K 线质量检查清单。
2. 多周期信号编排和逐根回放方式。
3. 笔力度、形态与来源追踪。

推荐按以下顺序采用：

| 优先级 | 能力 | 采用方式 | 结论 |
| --- | --- | --- | --- |
| P0 | K 线数据质量 | 重写为本项目的结构化门禁 | 现在做 |
| P0 | 笔力度和形态指标 | 移植纯公式，改成 `Decimal` 和无量纲指标 | 现在做 |
| P0 | 信号逐根回放与触发复核 | 固定 CZSC 版本作为离线对照器 | 现在做 |
| P1 | 多周期聚合和调度 | 借鉴职责，不复用可变运行时 | 信号栈建设时做 |
| P1 | 信号注册和版本管理 | 改成类型化注册表和稳定事实 ID | 信号栈建设时做 |
| P2 | `Factor` / `Event` | 只用于离线策略研究 DSL | 信号稳定后评估 |
| P2 | 绩效与权重回测 | 只用于模拟策略，不替换真实交易复盘 | 信号稳定后评估 |
| 不建议 | `Position`、磁盘缓存、连接器、Redis、OSS | 不接入 | 与当前产品边界冲突 |

生产环境不应直接安装或导入完整 `czsc==0.9.68`。CZSC 顶层会导入
`rs_czsc`，并加载交易、Redis、数据服务和可视化等大量能力；其依赖和可变状态均
超出当前分析链需要。[顶层导入][czsc-init] [依赖清单][requirements]

## 研究基线

本文只研究 CZSC `0.9.68`，固定提交为
[`3dfa3db215b9c01ae53251743704eef25814512c`][czsc-tree]。外部结论来自该提交的
一手源码和测试，不引用持续变化的 `master`。

本项目的权威链路仍是：

```text
Tushare 前复权行情
  -> market_history_snapshots
  -> CanonicalBar
  -> ChanEngine
  -> 冻结分析快照和事实引用
  -> React 图表与投研报告
```

当前边界决定了复用方式：

- `CanonicalBar` 和交易复盘使用 `Decimal`；CZSC 对象使用 `float` 和可变 `cache`。
- `MarketAnalysisService` 当前只检查样本量和前复权收盘缺失，数据质量门禁仍较薄。
- 日线和周线已经固化，30 分钟预拉、线段、MACD 和类型化信号仍在设计阶段。
- 真实交易复盘已经计算资金流中性收益、周期最大回撤、利润因子、胜率、持有交易日、
  理由表现和纪律执行率，不需要用 CZSC 回测替换。

相关本地实现为 `apps/api/app/domain/chan_engine.py`、
`apps/api/app/analysis.py`、`apps/api/app/db.py`、
`apps/api/app/trading/metrics.py` 和
`docs/superpowers/specs/2026-08-21-chan-engine-signals-design.md`。

## P0：现在值得做

### K 线数据质量门禁

CZSC 的 `kline_quality.py` 把检查拆成八类：缺失值、字段类型、时间顺序、OHLC
合理性、成交量与成交额、证券代码、重复记录和异常涨跌幅。
[质量检查源码][kline-quality]

值得复用的是检查目录，不是源码实现。0.9.68 的实现有以下硬问题：

- 主函数先按时间排序，再调用时间顺序检查，无法发现原始输入乱序。
- 类型检查要求 pandas `float`，会错误排斥本项目的 `Decimal`。
- 函数会修改输入的 `dt` 列，并直接打印问题行，不适合作为 API 事实。
- 固定 20% 涨跌阈值不理解复权、除权、停牌和不同涨跌幅制度。
- 官方测试只有一次无断言调用，不能视为成熟门禁。
  [质量检查测试][test-kline-quality]

最小改造路径：

1. 在排序和转型前校验原始行，禁止静默修复。
2. 输入类型直接使用现有行情字典和 `Decimal`，不增加 pandas 依赖。
3. 返回稳定结构：`code`、`severity`、`row_key`、`field`、`actual`。
4. `fatal` 至少覆盖缺字段、重复时间、乱序、非正价格和 OHLC 不变量破坏。
5. `warning` 覆盖交易日缺口、零成交量、异常跳变和前复权字段回退。
6. 把质量结果和输入摘要一起写入 `market_snapshot.quality`；有致命问题时不进入
   `ChanEngine`。

这项能力适合放在 `MarketAnalysisService` 形成 `CanonicalBar` 之前，也适合复用到
交易复盘的图表行情入口。它直接提升报告事实可靠性，优先级高于新增信号数量。

### 笔力度、形态和来源追踪

CZSC 的 `BI` 不只保存起止点，还提供以下派生属性：

- 价差力度 `power_price`、成交量力度 `power_volume`、涨跌幅 `change`。
- 原始 K 线数、无包含 K 线数、内部分型和近似次级别笔。
- 顺畅度 `SNR`、线性拟合 `R2`、斜率、加速度、斜边长度和角度。

这些属性在 [`objects.py`][objects-bi] 中按需计算，`calculate_bi_info` 还示范了如何
把笔特征整理为研究表。[笔特征表][bi-info]

本项目最值得先加的不是全部指标，而是四项可解释事实：

| 指标 | 用途 | 最小改造 |
| --- | --- | --- |
| 价格变化率 | 比较相邻同向笔力度 | 用端点价格计算 `Decimal` 比率 |
| 有效 K 线数 | 说明结构持续长度 | 使用 `start_index` / `end_index` |
| 成交量合计 | 给背驰提供量能旁证 | 明确首尾是否计入并处理缺失量 |
| 归一化顺畅度 | 区分单向推进和来回震荡 | 对零波动单独返回 `unevaluable` |

`slope`、`acceleration` 和 `angle` 受股票价格尺度和周期长度影响，不应直接跨股票、
跨周期比较。若后续采用，应先除以起点价或波动尺度；CZSC 的角度把价格单位和 K 线
数量直接放在同一勾股关系中，只适合单样本展示，不适合成为生产信号。

最小改造路径是为现有 `stroke` 追加内部派生字段，并保留来源索引。价格、比率和量能
继续使用规范十进制字符串；不移植 `RawBar.cache`、NumPy 拟合或 CZSC 可变对象。

### 信号逐根回放与触发复核

`generate_czsc_signals` 会先用历史 K 线预热 `BarGenerator`，随后逐根更新各周期和
信号，输出每根 K 线时点的信号快照。[逐根信号生成][traders-base]
`check_signals_acc` 会隔一段时间保存同类信号的 HTML 触发快照，适合人工检查信号
出现位置。[信号触发检查][traders-base]

需要明确：`check_signals_acc` 名称中虽然有 `acc`，但它没有计算命中率、精确率、
收益或未来结果，只是在触发点生成快照。不能把它的输出称为“信号准确率”。

本项目应把这套思路改成两层：

1. **结构回放**：按 `as_of` 逐根产生冻结事实，断言当时只使用
   `known_at <= as_of` 的数据。
2. **事后评价**：在独立表中把触发事实与后续窗口结果关联，禁止把未来结果回写到
   原始信号快照。

CZSC 固定版本可以在测试或研究环境直接运行，作为差分对照和人工图形复核工具；
生产环境只保存本项目的类型化信号。若直接复制官方测试数据或源码片段，必须保留
Apache-2.0 许可和归属。[许可证][license]

## P1：信号栈建设时做

### 多周期聚合与调度

`BarGenerator` 从一个基础周期向上聚合多个周期。高级别 K 线未结束时替换最后一根，
周期结束后再追加新 K 线；`CzscSignals` 为每个周期维护独立 `CZSC` 实例，并在一次
基础周期更新后统一计算信号。[多周期合成][bar-generator]
[多周期信号编排][traders-base]

这套职责划分值得借鉴：

```text
基础行情输入一次
  -> 周期边界与完成状态
  -> 每周期独立结构快照
  -> 信号声明自己依赖的周期
  -> 协调器只组合已固化事实
```

源码不能直接复用，原因是：

- 分钟周期依赖包内静态 `minutes_split.feather` 和 pandas。
- 未完成高级别 K 线会原地替换，重复基础 K 线只记录警告后忽略。
- 周线结束时间偏向日历周五，本项目周线使用实际已完成交易日。
- 它没有 `known_at`、`stable_through`、快照 ID 和输入摘要。

最小改造路径：

1. 保持设计文档确定的 30 分钟行情预拉入库，分析请求不现场补拉。
2. 单独实现纯函数 `bucket_end` 和 `aggregate_completed_bars`，返回
   `complete` / `partial` 状态。
3. 周期边界使用项目已有交易日历，并以固定测试覆盖午休、节假日、周末和未完成
   交易日。
4. 多周期协调器只接收快照 ID，不共享可变 K 线列表。
5. 日线一类信号读取 30 分钟固化快照，周线一类信号读取日线固化快照。

### 信号注册与版本管理

CZSC 0.9.68 有 244 个以日期版本结尾的信号函数，例如
`zdy_macd_V230518`。`signals_config` 记录函数名、周期和参数；
`SignalsParser` 再从函数文档字符串和下划线信号文本反解配置。
[信号解析器][sig-parse]

可以借鉴的只有两个原则：

1. 同一业务信号的新旧口径并存，旧报告不被新实现重算。
2. 周期依赖和参数是显式配置，不藏在模型提示词或页面逻辑中。

不应复用的部分是动态任意导入、文档字符串正则解析和七段下划线字符串协议。
`Signal`、`Factor`、`Event` 都依赖字符串拆分，字段中出现下划线就会破坏协议，且
无法自然携带来源事实、可用时间和未就绪原因。[信号对象][objects-signals]

本项目的最小注册表应包含：

```text
signal_id
signal_version
engine_version
required_timeframes
parameter_schema
evaluator
output_schema
```

每个输出仍使用信号栈设计中的类型化 `Signal`，并追加来源结构索引、
`occurred_at`、`known_at`、`stable_through`。注册配置规范化后参与报告
`input_digest`，禁止通过字符串函数名从外部请求动态导入代码。

## P2：信号稳定后再评估

### `Factor`、`Event` 和 `Position`

CZSC 的组合层次很清楚：

```text
Signal
  -> Factor：all / any / not
  -> Event：公共条件 + 任一 Factor + 操作类型
  -> Position：事件驱动的持仓状态机
```

`Factor` 和 `Event` 支持序列化，并用规则内容哈希生成短标识；`Position` 继续处理
开多、开空、平仓、同向开仓间隔、超时、止损和是否允许 T+0。
[因子与事件][objects-events] [仓位状态机][objects-position]

`Factor` / `Event` 的布尔组合适合将来作为离线研究 DSL，但必须改成类型化 AST，
并记录规则版本、参数、事实依赖和匹配解释。它不能先于底层信号事实稳定，否则只是
把不稳定信号组合成更复杂的不稳定规则。

`Position` 当前不应接入。本项目的交易模块记录用户真实成交，产品非目标也明确不
自动下单；把 CZSC 的模拟仓位状态混入真实账本，会造成“策略应有持仓”和“用户实际
持仓”两个事实源。若以后建设模拟盘，应使用独立账户、独立账本和独立 API。

### 绩效与回测

CZSC 提供三层研究工具：

- `PairsPerformance` 按标的、方向和时间聚合交易对，计算胜率、盈亏比、持有时长和
  盈亏平衡点。[交易对绩效][performance]
- Python `WeightBacktest` 从 `dt`、`symbol`、`weight`、`price` 计算换手、手续费、
  日收益、基准和开平交易。[权重回测][weight-backtest]
- `DummyBacktest` 缓存逐根信号，再批量生成模拟持仓和交易对。
  [批量回测][dummy-backtest]

这些能力只适合未来评价“结构信号或规则是否具有统计价值”。不能用于替换当前真实
交易复盘：本项目已经以 `Decimal` 和真实成交重放资金、成本、资金流中性净值、
回撤、理由和纪律；CZSC 回测使用 pandas/float、模拟权重和简化手续费口径，两者
回答的问题不同。

还要注意 0.9.68 的 Python `daily_performance` 已标记废弃，建议改用
`rs_czsc`；顶层 `WeightBacktest` 也来自 `rs_czsc`，说明其生产回测边界在该版本
已经迁移。[Python 绩效函数][stats] [顶层导入][czsc-init]

最小改造路径：

1. 先定义独立的 `SignalObservation` 和 `SimulatedPosition`，不复用真实交易表。
2. 固定成交价格时点、复权口径、手续费、滑点和不可交易条件。
3. 用滚动时间切分，禁止同一窗口既选参数又报绩效。
4. 先输出触发次数、覆盖率、方向正确率和费用后收益，再考虑 Factor 组合。
5. CZSC 指标只能作为候选定义，最终实现继续使用本项目十进制和空值原因契约。

## 不建议接入

### 磁盘缓存

CZSC `DiskCache` 支持 pickle、JSON、CSV、Excel、Feather 和 Parquet，装饰器把函数
源码、参数字符串和函数名拼接后生成八位 MD5 键。[磁盘缓存][cache]

它不适合本项目生产环境：

- pickle 使用 `dill`，不应加载不可信缓存。
- 八位缓存键、参数 `repr` 和源码文本不是稳定业务摘要。
- 没有原子写、文件锁、并发控制、数据来源和引擎版本。
- TTL 基于文件时间，缓存清理还提供整目录递归删除。

本项目已有 PostgreSQL `market_history_snapshots`、快照键、`payload_hash`、
`snapshot_id` 和 `engine_version`，这些比 CZSC 文件缓存更适合可复现报告。最多借鉴
“实现版本必须参与缓存键”这一原则，不复用源码。

### 数据连接器、Redis 和服务层

0.9.68 同时包含通用 HTTP `DataClient`、聚宽连接器、Redis 权重客户端、OSS、飞书
和企业微信等外围能力。[数据客户端][data-client] [Redis 权重][redis-weights]

这些模块不会提升当前 Tushare 前复权行情与冻结快照链，反而会引入第二套凭据、缓存、
重试、心跳和数据语义。当前不接入任何一项；若未来要扩展行情源，应先定义统一
provider 契约和交叉源一致性测试，再独立评估单个连接器。

## 复用边界总表

| 能力 | 生产源码直接复用 | 只借鉴设计 | 不应接入 |
| --- | --- | --- | --- |
| K 线质量 | 否 | 检查分类与严重级别 | pandas 打印式实现 |
| 笔力度 | 仅移植简单公式 | 来源追踪和按需派生 | 可变 `cache`、尺度相关角度 |
| 逐根回放 | 否 | 预热、逐时点快照、触发复核 | 把触发快照称为准确率 |
| 多周期 | 否 | 单输入、多周期独立引擎、依赖声明 | 未完成 K 线原地覆盖 |
| 信号注册 | 否 | 版本并存、显式周期和参数 | 动态导入、文档正则、字符串协议 |
| Factor / Event | 否 | 类型化布尔规则 DSL | 直接驱动生产交易 |
| Position | 否 | 仅供未来模拟盘参考 | 混入真实交易账本 |
| 绩效 / 回测 | 否 | 指标候选和费用后评价流程 | 替换真实交易复盘 |
| 缓存 / 连接器 | 否 | 版本参与摘要 | CZSC 缓存、Redis、OSS 和数据服务 |

“直接复用”只保留一个例外：在隔离的测试或研究环境，固定提交运行 CZSC，作为差分
对照器并生成一次性调试快照。该环境不写生产数据库，输出也不进入报告事实链。

## 推荐落地顺序

### 第一阶段：质量和解释性

1. 建立结构化 K 线质量检查，覆盖分析入口和交易复盘图表入口。
2. 为 `stroke` 增加变化率、长度、量能和顺畅度，所有公式使用 `Decimal`。
3. 把指标注册进事实引用表，但不据此新增买卖信号。

### 第二阶段：多周期类型化信号

1. 按现有设计完成 30 分钟预拉和只读快照。
2. 建立类型化信号注册表和配置摘要。
3. 实现逐 `as_of` 回放，CZSC 只作离线触发位置对照。

### 第三阶段：研究评价

1. 信号事实稳定后建立独立模拟账本。
2. 先做单信号样本外评价，再评估 `Factor` / `Event` 组合。
3. 只有通过费用、滑点和不同市场阶段测试的规则，才有资格进入产品讨论。

## 最终判断

CZSC 0.9 对本项目最大的提升方向是“让数据更可信、结构更可解释、信号更可回放”，
不是“快速增加几百个信号”。

现在最值得做的是 K 线质量门禁和四个笔级解释指标；随后在 30 分钟信号栈建设中
借鉴多周期调度和版本化注册；Factor、Position、回测和连接器全部后置或不接入。
这样既能获得 CZSC 多年积累的研究方法，又不会破坏本项目唯一、冻结、可引用的事实链。

[bar-generator]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/bar_generator.py
[bi-info]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/bi_info.py
[cache]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/cache.py
[czsc-init]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/__init__.py
[czsc-tree]: https://github.com/waditu/czsc/tree/3dfa3db215b9c01ae53251743704eef25814512c
[data-client]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/data_client.py
[dummy-backtest]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/dummy.py
[kline-quality]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/kline_quality.py
[license]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/LICENSE
[objects-bi]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/objects.py
[objects-events]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/objects.py
[objects-position]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/objects.py
[objects-signals]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/objects.py
[performance]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/performance.py
[redis-weights]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/rwc.py
[requirements]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/requirements.txt
[sig-parse]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/sig_parse.py
[stats]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/utils/stats.py
[test-kline-quality]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/test/test_kline_quality.py
[traders-base]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/base.py
[weight-backtest]: https://github.com/waditu/czsc/blob/3dfa3db215b9c01ae53251743704eef25814512c/czsc/traders/weight_backtest.py
