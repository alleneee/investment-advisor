# 交易日记与周期复盘设计

## 背景

当前产品提供 A 股行情、成交量、缠论结构、资讯证据和 Pi 研究报告，但没有记录
用户真实交易的能力。用户需要在每日收盘后录入当天买卖成交、股数和理由，并在
周、月、季、年维度复盘哪些交易模式贡献盈利、哪些行为造成回撤，以及纪律执行
是否改善。

本设计新增独立的交易复盘模块。它以用户录入的真实成交和账户资金变化为事实源，
由 Python 确定性计算持仓、成本、完整交易周期和绩效指标，再由 Pi 对已经固化的
统计结果做受约束的文字解释。现有行情、缠论和投资报告契约保持不变。

## 目标

- 支持单账户的初始资金、入金和出金记录。
- 支持逐笔录入真实成交，包括时间、方向、价格、股数、手续费和理由。
- 支持每日收盘检查，包括止损条件、次日计划、情绪和纪律执行。
- 确定性重建持仓、移动加权成本和完整交易周期。
- 生成周、月、季、年复盘，比较盈利来源、亏损模式、最大回撤和操作纪律。
- 在 K 线、成交量和缠论结构上叠加用户真实买卖点。
- Pi 只解释已计算事实，不生成账户数值、交易事实或具体买卖指令。
- 历史成交修正后保留旧报告并生成可追溯的新版本。

## 非目标

- 不连接券商账户，不自动下单，不读取券商资产。
- 不提供个性化买卖、仓位、止损或目标价指令。
- 不以单只股票的未实现浮盈替代账户总权益和回撤计算。
- 不在第一版支持多账户、融资融券、期权、期货、港股或外币账户。
- 不把投资报告中的缠论信号自动视为用户的买入理由。
- 不建立策略回测、收益预测模型或社交交易排名。

## 方案选择

采用“逐笔成交账本 + 确定性复盘引擎 + 受约束 Pi 解释”的方案。

1. 用户逐笔记录真实成交和账户现金流。
2. Python 从成交账本重建持仓、成本、完整交易周期和日度权益。
3. 周期结束时固化该周期的数据与统计快照。
4. 页面立即展示确定性指标和图表。
5. Pi 只接收脱敏后的汇总统计，生成复盘叙述和下一周期的单项实验。

未采用手工录入每笔交易的最终盈亏，因为分批买入、分批卖出和手续费容易造成
统计不一致。未采用由模型直接阅读完整账本并计算指标，因为数值不可验证，也无法
可靠重放。

## 领域模型

### 交易账户

第一版只允许一个人民币现金账户。账户包含名称、初始资金、启用日期和当前状态。
初始资金只在创建时设置，后续资金变化通过现金流记录表达。

### 现金流

现金流只包含入金和出金。每条记录包含发生时间、金额和可选备注。现金流是外部
资金流，用于修正收益率和回撤，不计为交易盈亏。请求金额始终为正数，计算时入金
记为正数、出金记为负数；同一交易日的全部外部资金流统一视为当日投资收益发生前
进入账户。

账本按实际时间统一排序现金流和成交；完整排序键为 `occurred_at`、事件类型优先级
（现金流先于成交）、不可变 `created_at`、稳定事件 ID。相同时间的多笔成交按
`created_at` 和事件 ID 排序。
出金在其事件位置逐笔校验，不能使可用现金小于零。周末和节假日现金流立即改变账本
现金，但净值计算时归入下一个估值交易日的 `F[d]`；不存在下一个估值日时，进行中
预览只更新现金，正式报告等待下一个估值水位。

第一版不自动处理现金分红、红利税、利息、送股和拆并股。这些变化不能伪装成入金
或出金；账户存在无法由初始资金、现金流和成交解释的现金变化时，用户必须先修正
账本，否则正式复盘标记为 `failed`。公司行动支持留到后续独立契约。

### 成交

每条 `TradeExecution` 表示一次已经发生的真实成交，包含：

- 股票代码和名称。
- 成交时间，使用 Asia/Shanghai 时区。
- 方向，只允许买入或卖出。
- 成交价格、成交股数和手续费。
- 一个主要理由和零个或多个辅助标签。
- 可选复盘备注。
- 客户端幂等键和创建、更新时间。

价格必须大于零，股数必须为正整数，手续费不得为负。任何卖出都不能使该股票的
持仓数量小于零；任何买入都不能使现金余额小于零。校验按成交确定顺序逐笔执行，
失败时整次写入和重放回滚。

### 交易周期

`TradeCycle` 是从某只股票持仓由零变为正开始，到持仓再次回到零结束的一段完整
持仓过程。周期内可以包含多次买入和多次卖出。

交易周期不是独立录入对象，而是由确定性 reducer 从成交序列派生。它记录开始和
结束时间、累计买卖金额、手续费、已实现净盈亏、收益率、持有交易日、主要买入
理由、主要卖出理由和纪律结果。

交易周期收益率固定为：

```text
cycle_return_rate = cycle_net_pnl / (gross_buy_amount + buy_fees)
```

分母是该周期全部买入成交金额与买入手续费之和，不使用账户初始资金，也不因部分
卖出回款而缩小。该指标命名为 `cycle_return_rate`；账户资金流中性收益率命名为
`account_adjusted_return_rate`，两者不得复用字段。

仍有持仓的周期为开放周期。开放周期进入账户权益和最大回撤计算，但不进入已结束
交易的胜率、盈亏比和利润因子。

### 每日收盘复盘

`DailyReview` 以交易日为单位，包含：

- 当日复盘状态：草稿或已完成。
- 当前持仓的失效或止损条件。
- 次日计划。
- 情绪状态。
- 是否遵守交易计划。
- 可选复盘说明。

每日复盘允许重新打开编辑。修改每日复盘后，所有包含该交易日且引用旧复盘 revision
的周期报告都标记为数据已过期。

`status=completed` 时 `discipline_followed` 必须是布尔值；只有 `draft` 可以为
`null`。纪律执行率只以已完成每日复盘为分母，指标和引用统一命名为
`discipline_adherence_rate`。

### 周期复盘

`PeriodReview` 表示周、月、季或年范围内的一版固化复盘。它保存周期边界、统计
快照、数据质量、输入摘要、账本 revision、行情水位、报告版本、Pi 状态和生成时间，
不直接引用可变的实时表。

## 理由分类

每笔成交必须选择一个主要理由，可以补充多个辅助标签。周期报告只按主要理由聚合，
避免一笔成交被重复计入多个分类。

买入主要理由固定为：

- `structure_breakout`：结构突破。
- `pullback_confirmation`：回踩确认。
- `trend_continuation`：趋势延续。
- `reversal_expectation`：反转预期。
- `event_driven`：事件驱动。
- `valuation_recovery`：估值修复。
- `oversold_rebound`：超跌反弹。
- `planned_add`：计划加仓。
- `other`：其他。

卖出主要理由固定为：

- `stop_loss`：止损。
- `take_profit`：止盈。
- `structure_invalidated`：结构失效。
- `target_reached`：目标达成。
- `planned_reduce`：计划减仓。
- `thesis_invalidated`：逻辑失效。
- `capital_reallocation`：资金调配。
- `discipline_violation`：纪律违规。
- `other`：其他。

分类使用稳定代码持久化，中文标签只负责展示。后续调整展示文案不能改变历史统计。

## 持仓与成本计算

所有成交按成交时间、创建时间和稳定标识排序。相同时间的成交仍具有确定顺序。

买入后使用移动加权平均成本：

```text
新持仓成本 = 旧持仓成本 + 买入金额 + 买入手续费
新单位成本 = 新持仓成本 / 新持仓股数
```

卖出时按卖出数量乘以当前单位成本结转成本：

```text
卖出净收入 = 卖出金额 - 卖出手续费
本次已实现盈亏 = 卖出净收入 - 结转成本
```

卖出不改变剩余持仓单位成本。持仓归零时关闭当前交易周期。历史成交新增、修改或
删除后，从受影响日期开始重放该股票的全部后续成交；若重放产生负持仓，整次修改
失败，原数据保持不变。

## 收盘价与账户权益

日度总权益按以下方式计算：

```text
总权益 = 可用现金 + 所有持仓数量 × 当日有效收盘价
```

可用现金由初始资金、入出金和全部成交现金变化确定。所有金额和价格使用
`Decimal`，数据库以十进制定点文本持久化，计算过程禁止二进制浮点。内部剩余成本
和成本分摊至少使用 28 位十进制精度，部分卖出时不量化中间成本；最后一次清仓直接
结转全部剩余成本，保证周期成本和盈亏守恒。只有 API 货币输出才按人民币分四舍五入，
单位成本和比率以规范化十进制字符串输出。

写入摘要和持久化前，所有输入先转换为 `Decimal` 再通过统一
`canonical_decimal_text` 去除无意义尾零和指数表示，因此 `10.0` 与 `10.00` 具有相同
语义摘要。人民币金额响应使用固定两位 `money_text`，价格、单位成本和比率使用无
指数的规范文本。人民币分量化统一使用
`Decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`；边界固定为
`0.005 -> 0.01`、`1.005 -> 1.01`、`-0.005 -> -0.01`。

账户估值只使用 Tushare `daily.close` 原始未复权收盘价，并在进入财务计算前通过
`Decimal(str(value))` 规范化；前复权价格不能与真实成交价混算。行情优先读取已经
缓存在本地 SQLite 的 Tushare 日线数据。某股票当日停牌或无收盘价时，使用不晚于该日的最后
一个有效收盘价，并把报告质量标记为 `degraded`。绝不把缺失价格当作零。

交易日边界使用中国交易日历和 Asia/Shanghai 时区。报告业务日期采用首尾均包含的
`[start_date, end_date]`；对应时间范围是开始日 `00:00:00+08:00` 至结束日下一天
`00:00:00+08:00` 之前。周报只包含该交易周的第一个到最后一个交易日。

所有带时区输入先转换为 Asia/Shanghai，再派生业务日期和排序键；不同 offset 表示
同一 instant 时必须得到相同结果。正式周期报告在周期最后一个交易日上海时间
`15:00:00` 前返回 `PERIOD_NOT_CLOSED`；当 `clock >= 15:00:00` 时进入最终行情水位
判断，尚未就绪返回 `MARKET_DATA_NOT_READY`。

### 资金流中性净值

收益率和回撤不能直接使用账户金额权益，否则纯入金或纯出金会被误判为投资表现。
系统同时维护金额权益曲线和资金流中性净值指数。设：

- `E[d]` 为交易日 `d` 收盘后的账户总权益。
- `F[d]` 为交易日 `d` 投资收益发生前的外部净现金流，入金为正、出金为负。
- `E[p]` 为上一个有效交易日收盘权益。

当 `E[p] + F[d] > 0` 时：

```text
daily_return[d] = E[d] / (E[p] + F[d]) - 1
nav[d] = nav[p] * (1 + daily_return[d])
```

账户启用时，在首笔成交、手续费或外部现金流发生前建立合成基线
`E[base]=initial_capital, nav[base]=1`。启用日收盘仍按日收益公式计算，不能把启用日
收盘净值强制设为 1，因此首日手续费和市场变化都会进入收益率。若前一日权益与当日
外部资金流之和等于零且期末权益也为零，则日收益率为 0，净值沿用前值，完整出金
不制造收益或回撤。若分母为零但期末权益不为零，返回 `zero_equity_baseline` 并阻止
正式报告；负分母在现金校验下不可达。
正式周期账户收益率为期末 `nav / 期初 nav - 1`，最大回撤和回撤曲线都基于 `nav`
计算；原始 `E[d]` 只作为金额权益曲线展示。

纯入金或纯出金且没有市场盈亏时，收益率和最大回撤都必须为零。例如期初权益
100,000 元，当日出金 50,000 元、期末权益 50,000 元，则
`50,000 / (100,000 + (-50,000)) - 1 = 0`。

## 确定性指标

### 账户结果

- 报告期已实现盈亏：按卖出成交日期确认的已实现盈亏之和，分批卖出也在发生期计入。
- 闭合周期净盈亏：清仓日期落在报告期内的完整交易周期净盈亏之和。
- 资金流调整后收益率：按资金流中性净值指数计算。
- 周期最大回撤：以报告期初净值基线和报告期内净值为范围，从该范围峰值到后续低点
  计算，包含未实现盈亏但不继承报告期开始前的峰值。
- 权益曲线：周期内每个交易日的总权益。
- 回撤曲线：资金流中性净值相对报告期内截至当日峰值的回撤比例。
- 当日盈亏：`E[d] - E[p] - F[d]`，即剔除当日外部净现金流后的权益金额变化。

账户摘要可以另行展示 `since_inception_drawdown`，它使用账户成立以来的净值峰值。
周期报告必须使用 `period_max_drawdown`，两个字段禁止互换。

### 交易质量

- 胜率：盈利的已结束交易周期数除以已结束交易周期总数。
- 平均盈亏比：平均盈利金额除以平均亏损绝对金额。
- 利润因子：盈利交易总额除以亏损交易总额绝对值。
- 持有交易日中位数。
- 资金效率：每个闭合周期的净收益率除以持有交易日；报告展示这些周期值的中位数，
  不把多个持仓的绝对金额相加为虚假的账户年化收益。
- 纪律执行率：标记为遵守计划的已完成每日复盘占比。

闭合周期的持有交易日按中国交易日历计算，首次建仓日和最终清仓日都计入；同日开仓
清仓为 1 个交易日，周末和休市日不计入。理由分组同样展示持有交易日中位数，不使用
平均数。交易案例的 `discipline_followed` 取最终清仓交易日已完成 DailyReview 的纪律
布尔值；该日复盘缺失或仍为草稿时返回 `null`。

除数为零时返回 `null` 和明确原因，不返回无穷大或伪造的零。总体和每个理由分组
分别返回 `sample_count` 与 `conclusion_allowed`。少于 5 个已结束交易周期的总体
或分组只展示事实，不进入理由排名，Pi 校验器拒绝对该样本输出有效或无效结论。

### 理由表现

理由展示拆成两层。逐笔理由事实表按报告期内发生的每笔成交统计成交次数、股数和
成交金额，只描述操作分布，不评价效果。闭合周期理由表现以清仓日期落在报告期内的
完整交易周期统计：

- 已结束交易周期数。
- 盈利周期数和胜率。
- 净已实现盈亏。
- 平均收益率。
- 持有交易日中位数。
- 最大单笔盈利和亏损。

一个交易周期存在多次同方向成交时，以首次建仓的主要买入理由作为“周期代表买入
理由”，以最终清仓的主要卖出理由作为“周期代表卖出理由”。中间加仓和减仓理由仍
完整保留在逐笔理由事实表，但不重复归因周期盈亏。辅助标签只用于筛选和样本查看。

报告期已实现盈亏与闭合周期指标必须分别守恒。例如 12 月买入 100 股，1 月卖出
50 股实现盈利 100 元，2 月卖出剩余 50 股实现亏损 100 元并清仓：1 月报告期已实现
盈亏为 100 元且闭合周期数为 0；2 月报告期已实现盈亏为 -100 元，闭合周期数为 1，
该闭合周期全生命周期净盈亏为 0。

## 报告周期

- 日复盘：用户每日填写，不生成正式 Pi 周期报告。
- 周报：交易周第一个交易日至最后一个交易日，最后一个交易日收盘后可生成。
- 月报：自然月，月末最后一个交易日收盘后可生成。
- 季报：自然季度，季度最后一个交易日收盘后可生成。
- 年报：自然年，年度最后一个交易日收盘后可生成。

尚未结束的周期可以查看“进行中预览”，只包含确定性统计，并明确标记为非正式
报告。正式报告不依赖常驻定时任务：用户在周期结束后首次打开复盘中心时，服务端
原子创建或复用对应报告任务；页面也提供手动生成和失败重试。

正式报告的期初基线是 `start_date` 前最后一个有效交易日的收盘账户权益和净值；
报告内成交、现金流和每日复盘使用首尾均包含的业务日期范围。跨期持仓在期初按当时
持仓和有效收盘价进入权益，卖出时按实际卖出日期确认报告期已实现盈亏。账户在周期
中启用时，报告从启用日开始并标记 `partial_period=true`，不能伪装成完整周期比较。

每份快照必须保存：

- `data_as_of`：本次固化账本与行情的截止时间。
- `ledger_revision`：成交和现金流账本的单调版本。
- `daily_review_revision`：每日复盘集合版本。
- `market_revision`：估值行情集合的单调版本。
- `market_watermark`：已采用的每只持仓股票、交易日和实际收盘价来源。

正式报告只有在周期最后一个交易日收盘后、交易日历已确认、账本已固化且所有持仓都
有当日或最近有效收盘价时可生成。使用最近有效价时允许生成，但数据质量为
`degraded`。春节等长假按交易日历确定周边界，月末、季末、年末没有交易日时使用
该自然周期内最后一个交易日。收盘后迟补成交或行情修正通过对应 revision 生成新版本。

同一账户、周期类型、起止日期、输入摘要、统计版本和提示词版本生成唯一
`input_digest`。摘要对规范化后的完整成交版本、现金流版本、每日复盘版本、实际采用
的原始收盘价、每只股票未复权 chart bundle 的行情与 Chan 摘要、周期边界、引擎版本
和提示词版本计算。正式报告还把上一同类周期的边界、账本与行情依赖摘要纳入当前
`input_digest`。相同摘要只生成一份报告；当前周期或上一比较周期的数据变化后形成新
摘要和新版本。

“上一同类周期”使用紧邻当前周期的完整周期：周报取前一个交易周，月报取前一个
自然月，季报取前一个自然季度，年报取前一个自然年。比较指标必须以当前报告相同的
账本、日复盘和行情 revision 重新计算，不能读取某份旧报告的陈旧数值。当前报告为
`partial_period`，或账户在上一周期尚未启用时，整个比较对象为 `null`。可比较时，
`delta = current.value - previous.value`；任一侧指标不可用时，delta 也不可用并沿用该
指标的有限不可用原因，不伪造为零。

## 报告内容

正式报告按以下顺序展示：

1. 周期边界、数据质量、样本数量和版本状态。
2. 资金流调整后收益率、报告期已实现盈亏、闭合周期净盈亏、最大回撤、利润因子和
   权益曲线。
3. 胜率、平均盈亏比、持有交易日、资金效率和纪律执行率。
4. 买入理由表现矩阵和卖出理由表现矩阵。
5. 最佳与最差已结束交易周期。
6. 交易周期图表。
7. Pi 复盘总结。
8. 与上一同类周期的比较。

不存在可比较的上一周期时，不显示伪造的增减值。`partial_period` 不能与完整周期
直接比较；界面明确区分 `partial_period` 与 `no_previous_period`。总体或某个理由分组
样本不足时，报告明确展示样本数量，不给相应排名结论。

## 买卖点图表

交易周期图表复用现有 K 线、成交量和缠论绘制组件，但使用独立的未复权日线图表
快照，使真实成交价格与纵轴一致。该图表不会修改现有投资研究报告使用的前复权数据。
Python 对同一组未复权 bars 运行现有 ChanEngine，固化为交易复盘专用 chart bundle。

- 买入点和卖出点使用不同形状与语义颜色。
- 标记纵轴使用实际成交价格；横轴把 `executed_at` 转为 Asia/Shanghai 交易日期并映射
  到对应日 K 类目，Tooltip 仍保留精确成交时间。同一交易日多笔成交共享类目位置。
- 同一时间或同一价格的多笔成交允许聚合显示，但 Tooltip 必须列出每笔股数、价格、
  手续费和主要理由。
- 标记只表示历史操作，不使用“建议买入”或“建议卖出”文案。
- 每个股票生成独立 chart bundle；多股票报告不把价格尺度混在一张图中。
- 图表周期随复盘样本范围确定，不重新计算或修改历史成交。
- 缺少行情时仍展示成交列表，并在图表区标记数据降级。

## Pi 复盘边界

交易复盘使用独立于投资研究报告的工具和输出契约。sidecar 为该会话只注册
`emit_trading_review`，不注册行情、网络、文件、shell 或投资报告工具。Pi 不能读取
完整账户流水、绝对账户余额、用户原始备注或外部 URL。

送入 Pi 的内容限于：

- 周期和样本数量。
- 收益率、回撤、胜率、盈亏比、利润因子和持有时长等汇总指标。
- 买入和卖出理由的聚合表现。
- 脱敏后的最佳、最差交易案例摘要。
- 纪律执行统计和数据质量告警。
- 上一同类周期的可比指标。

送入模型的请求使用 exact schema，只允许以下类型：

```ts
type BuyReasonCode =
  | "structure_breakout"
  | "pullback_confirmation"
  | "trend_continuation"
  | "reversal_expectation"
  | "event_driven"
  | "valuation_recovery"
  | "oversold_rebound"
  | "planned_add"
  | "other";

type SellReasonCode =
  | "stop_loss"
  | "take_profit"
  | "structure_invalidated"
  | "target_reached"
  | "planned_reduce"
  | "thesis_invalidated"
  | "capital_reallocation"
  | "discipline_violation"
  | "other";

type AccountMetricRef =
  | "account.adjusted_return_rate"
  | "account.period_max_drawdown_rate"
  | "account.win_rate"
  | "account.average_win_loss_ratio"
  | "account.profit_factor"
  | "account.median_holding_days"
  | "account.median_capital_efficiency"
  | "discipline.adherence_rate";

type MetricRef =
  | AccountMetricRef
  | `reason.buy.${BuyReasonCode}.sample_count`
  | `reason.buy.${BuyReasonCode}.win_rate`
  | `reason.buy.${BuyReasonCode}.average_cycle_return_rate`
  | `reason.sell.${SellReasonCode}.sample_count`
  | `reason.sell.${SellReasonCode}.win_rate`
  | `reason.sell.${SellReasonCode}.average_cycle_return_rate`
  | `comparison.${AccountMetricRef}`
  | "quality.partial_period"
  | "quality.missing_close_price"
  | "quality.insufficient_sample";

type QualityWarningCode =
  | "partial_period"
  | "missing_close_price"
  | "insufficient_overall_sample"
  | "insufficient_reason_sample"
  | "missing_daily_review";

interface TradingReviewModelInputV1 {
  schema_version: "trading_review_model_input.v1";
  period: {
    kind: "week" | "month" | "quarter" | "year";
    trading_day_count: number;
    partial_period: boolean;
  };
  sample: {
    closed_cycle_count: number;
    overall_conclusion_allowed: boolean;
  };
  metrics: {
    account_adjusted_return_rate: number | null;
    period_max_drawdown_rate: number | null;
    win_rate: number | null;
    average_win_loss_ratio: number | null;
    profit_factor: number | null;
    median_holding_days: number | null;
    median_capital_efficiency: number | null;
    discipline_adherence_rate: number | null;
  };
  reason_groups: Array<{
    side: "buy" | "sell";
    reason_code: BuyReasonCode | SellReasonCode;
    sample_count: number;
    conclusion_allowed: boolean;
    win_rate: number | null;
    average_cycle_return_rate: number | null;
  }>;
  metric_registry: Array<{
    ref: MetricRef;
    value: number | boolean | null;
    conclusion_allowed: boolean;
  }>;
  cases: Array<{
    case_label: "case_a" | "case_b";
    cycle_return_rate: number;
    holding_days: number;
    buy_reason_code: BuyReasonCode;
    sell_reason_code: SellReasonCode;
    discipline_followed: boolean | null;
  }>;
  comparison: Array<{
    metric_ref: AccountMetricRef;
    delta: number | null;
  }> | null;
  quality_warnings: QualityWarningCode[];
}
```

业务 API 和固化快照中的货币、比率、净值都使用规范化十进制字符串。构造模型输入时，
Python 只把白名单内的比率字符串做有限数值转换，并拒绝非有限值或越界值；模型输入
中的 `number` 不是业务事实源，也不能回写覆盖固化数值。

模型数值边界固定为：

| 字段 | 约束 |
| --- | --- |
| `sample.*_count`、`trading_day_count` | 大于等于 0 的整数 |
| `account_adjusted_return_rate` | 有限且大于等于 -1 |
| `period_max_drawdown_rate` | 0 至 1，含边界 |
| `win_rate`、`discipline_adherence_rate` | 0 至 1，含边界 |
| `average_win_loss_ratio`、`profit_factor` | 有限且大于等于 0 |
| `median_holding_days`、案例 `holding_days` | 有限且大于等于 1 |
| `median_capital_efficiency` | 任意有限数值 |
| 理由和案例 `cycle_return_rate` | 任意有限数值 |
| comparison `delta` | 任意有限数值 |

Python 和 Node 的测试读取同一份数值边界 fixture，逐字段验证最小值、最大值、越界值、
`NaN` 和无穷值；不能各自只抽测一个合法样例。

模型输入明确排除股票代码和名称、账户标识、稳定源行 ID、精确成交时间、价格、股数、
手续费、余额、绝对盈亏金额、自由文本备注和 URL。理由代码、指标引用、比较项、案例
标签和质量告警在运行时 JSON Schema 中展开为有限枚举；不能仅依赖 TypeScript 模板
字符串。`side=buy` 只能搭配买入理由，`side=sell` 只能搭配卖出理由。发送前 Python
和 Node 都执行 exact schema 校验；测试向每个开放字符串位置注入股票代码、原始备注
和稳定 ID，并断言最终请求被拒绝。

Pi 输出固定包含：

- 盈利主要来源。
- 亏损与回撤模式。
- 纪律偏差。
- 数据局限。
- 下一周期只执行一个、可衡量的改进实验。

输出工具只接受：

```ts
interface TradingReviewDraftV1 {
  schema_version: "trading_review_draft.v1";
  title: "周期交易复盘";
  profit_sources: Array<{ narrative: string; metric_refs: MetricRef[] }>;
  loss_patterns: Array<{ narrative: string; metric_refs: MetricRef[] }>;
  discipline_review: { narrative: string; metric_refs: MetricRef[] };
  limitations: string[];
  next_period_experiment: {
    hypothesis: string;
    action: string;
    measurement: string;
    success_criterion: string;
    metric_refs: MetricRef[];
  };
}
```

Python 为模型输入中的每个指标和理由分组建立临时 `metric_ref`。Node 和 Python 都
校验引用属于本次输入，且 `conclusion_allowed=false` 的分组不能出现在盈利来源、
亏损模式或实验结论中。服务端固定标题、周期、数值、图表和免责声明，模型只生成
上述叙述字段。

Pi 不得输出具体股票的买卖指令、仓位比例、止损价、目标价、收益承诺或确定走势。
Python 对输出结构、引用和禁投顾语义做最终校验。Pi 失败时报告状态标记为
`ai_status=failed`，确定性统计和图表仍然可用。Pi 重试必须复用同一个确定性快照，
不能产生新的业务报告版本。

## 数据存储

新增独立数据表：

```text
trading_account
cash_flows
trade_executions
daily_reviews
trading_review_jobs
trading_review_snapshots
```

`trading_review_snapshots` 保存固化输入、确定性统计、Pi 草稿、水合结果、
`input_digest`、契约版本和提示词版本。快照还保存规范化完整输入、源行 ID 与 revision、
实际采用的收盘价、引擎版本、`supersedes_snapshot_id` 和全部数据水位。旧快照不可
原地覆盖。

成交和现金流共享单调递增的 `ledger_revision`；更新和删除都创建新 revision，删除
使用 tombstone，不能物理抹掉旧快照所需的历史。每日复盘和估值行情分别使用独立
`daily_review_revision` 与 `market_revision`。

存储约束固定为：

- `trading_account` 最多存在一个 active 账户。
- 金额和价格为十进制定点文本，股数为整数，禁止 SQLite `REAL` 参与财务计算。
- 成交幂等键唯一范围为 `(account_id, client_idempotency_key)`。
- 现金流幂等键唯一范围为 `(account_id, client_idempotency_key)`。
- 每日复盘唯一范围为 `(account_id, trade_date)`。
- 快照摘要唯一范围为 `(account_id, period_kind, input_digest)`。
- 更新和删除必须携带当前 `revision`；条件写失败返回 `409 REVISION_CONFLICT`。
- 报告任务通过事务和唯一摘要原子 get-or-create，只允许一个执行 owner。

成交和现金流都持久化规范化请求摘要。同一幂等键和相同摘要返回原对象且不提升
revision；同一幂等键对应不同摘要返回 `409 IDEMPOTENCY_CONFLICT`，不能静默吞掉
新的请求内容。

用户修改或删除历史成交后：

1. 在同一事务中校验并保存新账本状态。
2. 从受影响日期重放持仓和交易周期。
3. 提升 `ledger_revision`。
4. 将 `period_end` 不早于最早受影响日期且引用旧账本 revision 的所有报告标记为
   `outdated`，即使报告期本身不包含被修改日期；`data_as_of` 只表示固化时间，不能
   代替派生依赖范围。
5. 保留旧报告用于追溯。
6. 用户再次生成时创建新摘要和新版本。

现金流修改影响该日期及之后的所有账户权益，因此使用相同规则使后续快照失效。
每日复盘修改只使包含该交易日且引用旧复盘 revision 的快照失效。

每个估值日都保存 `(symbol, valuation_date, source_trade_date, close, bar_digest)`
依赖。行情刷新发现历史价格变化，或某估值日出现了原先缺失而使用最近有效价的新
bar 时，提升 `market_revision`，重算候选依赖摘要；依赖摘要变化的旧快照标记为
`outdated`。最近有效价被连续沿用的每个估值日都是独立依赖，不能只使来源交易日
所在报告过期。

交易模块 `bar_digest` 只对规范化后的 raw
`trade_date/open/high/low/close/vol` 计算，明确排除 `qfq_*`、复权因子和现有 provider
整行 `payload_hash`。仅复权字段变化不能提升交易复盘 `market_revision`；raw OHLCV
变化必须提升水位。

## 最小 HTTP 契约

所有写接口使用 JSON，时间必须为带时区 ISO-8601，业务日期必须为 `YYYY-MM-DD`。
响应拒绝额外字段。核心接口为：

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /api/trading/account` | 读取单账户与当前摘要 | `200` |
| `POST /api/trading/account` | 创建唯一账户和初始资金 | `201` |
| `POST /api/trading/cash-flows` | 新增入金或出金 | `201` 或幂等 `200` |
| `GET /api/trading/cash-flows?start=&end=` | 读取日期范围内现金流 | `200` |
| `PATCH /api/trading/cash-flows/{id}` | 按 revision 修正现金流 | `200` |
| `DELETE /api/trading/cash-flows/{id}` | 按 revision 写入删除 tombstone | `204` |
| `POST /api/trading/executions` | 新增真实成交 | `201` 或幂等 `200` |
| `PATCH /api/trading/executions/{id}` | 按 revision 修正成交 | `200` |
| `DELETE /api/trading/executions/{id}` | 按 revision 写入删除 tombstone | `204` |
| `GET /api/trading/executions` | 按单日或日期范围读取流水 | `200` |
| `GET /api/trading/daily-reviews/{date}` | 读取当日日复盘和 revision | `200` 或 `404` |
| `PUT /api/trading/daily-reviews/{date}` | 创建或按 revision 更新日复盘 | `200` |
| `GET /api/trading/reviews/preview` | 读取进行中确定性预览 | `200` |
| `POST /api/trading/reports` | 原子创建或复用正式周期报告 | `202` 或复用 `200` |
| `GET /api/trading/reports` | 按周期读取报告版本历史 | `200` |
| `GET /api/trading/reports/{id}` | 查询固化报告和生成状态 | `200` |
| `POST /api/trading/reports/{id}/retry` | 重试确定性快照生成 | `202` |
| `POST /api/trading/reports/{id}/retry-ai` | 对同一快照重试 Pi | `202` |

创建成交的最小请求为：

```json
{
  "symbol": "002940.SZ",
  "name": "昂利康",
  "executed_at": "2026-08-17T14:52:00+08:00",
  "side": "buy",
  "price": "18.35",
  "quantity": 1000,
  "fee": "5.00",
  "primary_reason": "pullback_confirmation",
  "tags": [],
  "note": "",
  "client_idempotency_key": "client-generated-uuid"
}
```

预览接口要求 `period_kind`、`start` 和 `end` 三个查询参数。
成交查询支持单个 `date`，或必成对出现的 `start`、`end`，并允许可选 `symbol`；范围
接口一次返回报告范围内的全部成交，前端不能按交易日循环请求。报告历史接口要求
`period_kind`、`period_start` 和 `period_end`，按 `report_version` 倒序返回全部版本。

确定性重试只允许 `snapshot_status=failed`。若账本、复盘和行情水位未变化，同一任务
以 `attempt+1` 执行 `failed -> pending -> running -> ready|failed`；若任一水位变化，
服务端创建新的报告 ID、输入摘要和 successor 快照，并通过 `supersedes_snapshot_id`
关联旧版本。租约和 execution owner 每次重试更新，旧 owner 的迟到写入必须被拒绝。

账户、现金流和每日复盘写入契约为：

```ts
interface CreateTradingAccountRequest {
  name: string;
  activated_on: string;
  initial_capital: string;
}

interface CreateCashFlowRequest {
  occurred_at: string;
  kind: "deposit" | "withdrawal";
  amount: string;
  note: string;
  client_idempotency_key: string;
}

interface PutDailyReviewRequest {
  revision: number | null;
  status: "draft" | "completed";
  invalidation_condition: string;
  next_day_plan: string;
  emotion: "calm" | "confident" | "anxious" | "impulsive" | "frustrated" | "other";
  discipline_followed: boolean | null;
  note: string;
}
```

每日复盘校验使用带判别的联合规则：`draft` 可令 `discipline_followed=null`，
`completed` 必须令其为 `true` 或 `false`。

`CreateCashFlowRequest.amount` 必须是大于零的十进制字符串，正负方向只由 `kind`
决定。现金流 PATCH 使用完整替换字段和当前 revision，DELETE 使用 `If-Match`，与成交
采用相同的 revision、tombstone 和后续快照失效规则。

财务请求字段只接受符合规范格式的 JSON string；JSON number、科学计数法、`NaN`、
`Infinity` 和非规范小数都返回交易模块专用的 `400 INVALID_REQUEST`。该错误适配只
作用于 `/api/trading`，现有市场和投资报告接口的 FastAPI 校验行为保持不变。

账户响应固定包含 `account_id`、名称、启用日期、初始资金、当前 `ledger_revision`、
现金、持仓市值、总权益、估值日期、按 `E[d]-E[p]-F[d]` 计算的 `daily_pnl`、
`since_inception_drawdown` 和数据质量。成交响应
除回显规范化成交外必须包含
`execution_id`、`revision`、`ledger_revision`、本次已实现盈亏和成交后的持仓数量、
单位成本。财务数值一律使用十进制字符串返回。

报告查询外壳固定为：

```ts
interface TradingReviewReportResponse {
  report_id: string;
  snapshot_id: string | null;
  report_version: number;
  supersedes_snapshot_id: string | null;
  account_id: string;
  period_kind: "week" | "month" | "quarter" | "year";
  period_start: string;
  period_end: string;
  data_as_of: string | null;
  input_digest: string;
  ledger_revision: number;
  daily_review_revision: number;
  market_revision: number;
  market_watermark: string | null;
  attempt: number;
  snapshot_status: "pending" | "running" | "ready" | "failed";
  data_quality: "ok" | "degraded" | "unavailable";
  ai_status: "not_requested" | "pending" | "running" | "ready" | "failed";
  is_outdated: boolean;
  partial_period: boolean;
  retryable: boolean;
  deterministic_report: DeterministicTradingReviewV1 | null;
  ai_review: TradingReviewDraftV1 | null;
  error: { code: string; message: string } | null;
}

type UnavailableReason =
  | "no_sample"
  | "no_winning_cycle"
  | "no_losing_cycle"
  | "zero_denominator"
  | "zero_equity_baseline";

type ComparisonUnavailableReason = "partial_period" | "no_previous_period";

interface NullableDecimalMetric {
  value: string | null;
  unavailable_reason: UnavailableReason | null;
}

interface DeterministicTradingReviewV1 {
  schema_version: "deterministic_trading_review.v1";
  sample: {
    trading_day_count: number;
    execution_count: number;
    closed_cycle_count: number;
    overall_conclusion_allowed: boolean;
  };
  metrics: {
    period_realized_pnl: string;
    closed_cycle_pnl: string;
    account_adjusted_return_rate: NullableDecimalMetric;
    period_max_drawdown_rate: NullableDecimalMetric;
    win_rate: NullableDecimalMetric;
    average_win_loss_ratio: NullableDecimalMetric;
    profit_factor: NullableDecimalMetric;
    median_holding_days: NullableDecimalMetric;
    median_capital_efficiency: NullableDecimalMetric;
    discipline_adherence_rate: NullableDecimalMetric;
  };
  equity_curve: Array<{
    date: string;
    equity: string;
    nav: NullableDecimalMetric;
    drawdown_rate: NullableDecimalMetric;
  }>;
  execution_reason_facts: Array<{
    side: "buy" | "sell";
    reason_code: BuyReasonCode | SellReasonCode;
    execution_count: number;
    quantity: number;
    gross_amount: string;
  }>;
  reason_performance: Array<{
    side: "buy" | "sell";
    reason_code: BuyReasonCode | SellReasonCode;
    sample_count: number;
    conclusion_allowed: boolean;
    win_rate: NullableDecimalMetric;
    net_pnl: string;
    average_cycle_return_rate: NullableDecimalMetric;
    median_holding_days: NullableDecimalMetric;
  }>;
  cycle_cases: Array<{
    cycle_id: string;
    symbol: string;
    name: string;
    started_at: string;
    ended_at: string;
    net_pnl: string;
    cycle_return_rate: string;
    holding_days: number;
    buy_reason_code: BuyReasonCode;
    sell_reason_code: SellReasonCode;
    discipline_followed: boolean | null;
  }>;
  comparison: {
    previous_period: {
      kind: "week" | "month" | "quarter" | "year";
      start: string;
      end: string;
    };
    metrics: Array<{
      metric_ref: AccountMetricRef;
      current: NullableDecimalMetric;
      previous: NullableDecimalMetric;
      delta: NullableDecimalMetric;
    }>;
  } | null;
  comparison_unavailable_reason: ComparisonUnavailableReason | null;
  chart_bundles: Array<{
    symbol: string;
    name: string;
    adjustment: "none";
    market_snapshot_id: string;
    chan_analysis_id: string;
    chan_engine_version: string;
    bars: Array<{
      trade_date: string;
      occurred_at: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string | null;
    }>;
    strokes: Array<{
      direction: "up" | "down";
      start_at: string;
      end_at: string;
      start_price: string;
      end_price: string;
      state: "confirmed" | "provisional";
    }>;
    centers: Array<{
      start_at: string;
      end_at: string;
      lower: string;
      upper: string;
    }>;
    executions: Array<{
      execution_id: string;
      trade_date: string;
      executed_at: string;
      side: "buy" | "sell";
      price: string;
      quantity: number;
      fee: string;
      primary_reason: BuyReasonCode | SellReasonCode;
    }>;
    quality: { warnings: QualityWarningCode[] };
  }>;
  quality: { warnings: QualityWarningCode[] };
}
```

`snapshot_status=ready` 时 `deterministic_report` 必须存在；其他状态不得携带未完成的
部分快照。`ai_status=ready` 时 `ai_review` 必须存在；`failed` 时只能携带安全错误。
创建报告返回相同外壳，因此页面不需要猜测另一套状态模型。

`NullableDecimalMetric.value` 有值时 `unavailable_reason` 必须为 `null`；值为 `null`
时必须提供有限枚举原因。模型适配只读取 `value`，同时把原因映射为固定质量代码，
不能把数据库错误或自由文本送入模型。

`comparison` 有值时 `comparison_unavailable_reason` 必须为 `null`；`comparison` 为
`null` 时必须给出有限原因。比较数组按 `AccountMetricRef` 固定顺序完整返回，delta 的
可用性由 current 与 previous 决定。

更新请求必须包含当前 `revision` 和完整替换字段；删除请求通过 `If-Match` 传 revision。
报告创建请求固定为 `{period_kind, period_start, period_end}`，服务端校验周期边界和正式
资格，不接受客户端覆盖 `data_as_of`、revision、模型或提示词版本。

固定错误码包括：`INVALID_REQUEST`、`ACCOUNT_ALREADY_EXISTS`、`REVISION_CONFLICT`、
`IDEMPOTENCY_CONFLICT`、`INSUFFICIENT_CASH`、`INSUFFICIENT_POSITION`、
`PERIOD_NOT_CLOSED`、`MARKET_DATA_NOT_READY`、
`REPORT_BUSY`、`AI_NOT_READY` 和 `INTERNAL_ERROR`。负持仓冲突的安全响应额外包含
`symbol`、冲突业务日期和 `available_quantity`；现金不足响应额外包含冲突业务日期
和 `available_cash`。

错误响应统一为
`{status:"failed", error:{code:string,message:string}, retryable:boolean}`。字段校验返回
`400`，revision 或持仓冲突返回 `409`，未结束周期返回 `422`，上游暂不可用返回
`503`，内部超时返回 `504`。

## 服务边界

Python FastAPI 是账户、成交、复盘状态和统计快照的权威事实源。Node Pi sidecar
只负责受约束的文字生成，不维护账户状态。

前端新增两个一级入口：

- `交易日记`：日常录入成交、现金流和收盘检查。
- `复盘中心`：查看进行中预览和周、月、季、年正式复盘。

现有 `批量投顾`、`历史报告`、`数据快照`、行情、缠论和投资报告页面保持现有
契约与行为。

## 页面设计

### 交易日记

页面采用高密度深色研究终端布局，包含：

1. 账户摘要：总权益、现金、持仓市值、当日盈亏和成立以来当前回撤；该回撤与周期
   报告的 `period_max_drawdown` 分开命名。
2. 成交录入：股票、时间、方向、价格、股数、手续费、主要理由、辅助标签和备注。
3. 今日流水：按时间展示当天买卖，支持修正和删除。
4. 收盘检查：失效条件、次日计划、情绪和是否遵守计划。

提交按钮必须明确区分保存成交和完成当日复盘。删除成交需要二次确认，并在失败时
保留表单内容。

### 复盘中心

页面提供周、月、季、年切换，展示：

- 核心指标带。
- 权益与回撤曲线。
- 买入理由和卖出理由表现矩阵。
- 最佳、最差交易周期。
- K 线、成交量、缠论结构和真实买卖点。
- Pi 复盘总结和下一周期实验。

视觉沿用现有深色工业研究台：珊瑚色为主要强调色，无装饰渐变；正文使用无衬线
字体，数值使用等宽字体。桌面保持高信息密度，窄屏改为单列，不产生横向滚动。

## 状态与错误处理

周期复盘不使用一个互斥枚举压缩所有状态，而是拆为四个正交字段：

- `snapshot_status`：`pending | running | ready | failed`。
- `data_quality`：`ok | degraded | unavailable`。
- `ai_status`：`not_requested | pending | running | ready | failed`。
- `is_outdated`：布尔值。

确定性快照 `ready` 后立即可见，不依赖 Pi 是否完成。常见 UI 组合为：

| 快照 | 数据质量 | Pi | 过期 | UI 行为 |
| --- | --- | --- | --- | --- |
| `running` | 任意 | `not_requested` | `false` | 展示生成中，不展示旧数据为当前结果 |
| `ready` | `ok` | `ready` | `false` | 展示完整正式复盘 |
| `ready` | `degraded` | `failed` | `false` | 展示统计和降级说明，提供重试 Pi |
| `ready` | 任意 | 任意 | `true` | 只读展示旧版本并提示重新生成 |
| `failed` | `unavailable` | `not_requested` | 任意 | 展示安全错误和可重试条件 |

报告任务以租约和 execution owner 执行。租约超时后只有新 owner 可以恢复，旧 owner
的迟到写入返回冲突。并发创建同一摘要只产生一个任务。状态迁移为
`pending -> running -> ready|failed`；确定性重试在水位不变时允许
`failed -> pending` 并增加 attempt，水位变化时创建 successor。Pi 状态独立迁移为
`not_requested -> pending -> running -> ready|failed`。Pi 重试只改变 `ai_status`。

价格、股数、手续费或理由无效时返回字段级错误。卖出造成负持仓时返回冲突日期和
可卖股数，买入造成负现金时返回冲突日期和可用现金，均不保存部分结果。同一幂等键
只有在请求摘要相同时返回原对象，不同摘要返回冲突。报告失败必须保留安全摘要和
可重试标记，不返回模型原始响应、密钥或堆栈。

## 隐私与安全

- 账户绝对余额、原始成交账本和自由备注只存于 Python 本地数据库。
- Pi 输入不包含真实姓名、账户号、绝对余额、完整流水或原始备注。
- 内部工具继续使用服务间 token 和执行租约。
- 普通日志不记录成交备注、账户余额、模型提示词或凭据。
- 用户看到的 Pi 内容固定标记为复盘辅助，不构成投资建议。

## 测试与验收

### 确定性引擎

- 分批买入、分批卖出和多轮交易周期。
- 移动加权成本、买卖手续费和持仓归零。
- 入金、出金和资金流调整收益率。
- 完整出金保持净值、超额出金回滚、周末现金流映射到下一个估值日。
- 卖出超过持仓的事务回滚。
- 买入超过可用现金的事务回滚。
- 历史成交新增、修改、删除后的重放。
- 停牌或缺失收盘价的最近有效价格降级。
- 日度总权益和最大回撤。
- 金额分量化使用 `ROUND_HALF_UP`，覆盖 `0.005`、`1.005` 和 `-0.005`。
- 持有交易日首尾包含、同日为 1、周末和休市日排除；理由分组使用中位数。
- 交易案例纪律取清仓日已完成 DailyReview，缺失或草稿时为 `null`。
- 总体和每个理由分组少于 5 个已结束交易周期的数据不足规则。
- 纯入金、纯出金不改变资金流中性收益率和回撤。
- 报告期已实现盈亏与按清仓日纳入的闭合周期指标分别守恒。

### API 与持久化

- 成交字段校验、幂等键和并发重复提交。
- 相同幂等键不同请求摘要的冲突，以及现金流查询、修正和 tombstone 删除。
- 单账户约束和现金流校验。
- 日复盘草稿、完成、重新打开和历史修正。
- 已完成日复盘必须填写纪律布尔值，草稿允许为空。
- 周期边界、进行中预览和正式报告资格。
- `14:59:59` 未闭合，`15:00:00` 精确进入最终行情水位判断。
- 周、月、季、年上一同类完整周期比较、无前期和当前部分周期不可比较。
- 报告摘要复用、旧版本保留和过期标记。
- 上一比较周期的账本、日复盘或行情修正会改变当前报告摘要并产生新版本。
- 行情修正和最近有效价被新 bar 替代后的 `market_revision` 与快照失效。
- 跨月建仓清仓以及早期现金流修正使所有受影响的后续快照过期。
- `snapshot_status`、`data_quality`、`ai_status` 和 `is_outdated` 的组合与迁移。
- 确定性失败重试的 attempt、租约 fence 和水位变化 successor。
- 报告版本历史可发现，响应包含完整 revision 和 lineage。
- 每个空指标都携带有限枚举的 unavailable reason。
- Pi 输入的隐私过滤和失败降级。

### 前端

- 成交录入和买卖理由切换。
- 删除确认、失败保留表单和迟到请求隔离。
- 每日收盘工作流和完成状态。
- 周、月、季、年切换与进行中标识。
- 上一同类周期范围、当前值、前值和 delta，以及不可比较原因。
- 图表买卖点、数量和理由 Tooltip。
- 年报使用固化 `chart_bundles[].executions`，不按日循环请求。
- 320 像素窄屏无横向滚动。

### 端到端

使用固定行情和确定性 Pi 会话验证：

1. 创建单账户并记录初始资金。
2. 录入分批买入和分批卖出。
3. 完成每日收盘复盘。
4. 周期结束后生成周报。
5. 核对持仓、已实现盈亏、收益率、最大回撤和理由矩阵。
6. 核对 K 线买卖点与成交账本一致。
7. 核对相同输入复用同一报告。
8. 核对 Pi 不可用时确定性报告仍可查看。

### 固定计算夹具

以下夹具的金额都已包含手续费，必须得到精确结果：

1. 初始资金 100,000 元。
2. 1 月 5 日买入 1,000 股，单价 10 元，手续费 5 元。
3. 1 月 6 日买入 1,000 股，单价 12 元，手续费 5 元。
4. 移动加权总成本为 22,010 元，单位成本为 11.005 元。
5. 1 月 8 日卖出 1,000 股，单价 13 元，手续费 5 元，本次已实现盈亏为 1,990 元。
6. 1 月 9 日卖出 1,000 股，单价 11 元，手续费 5 元，本次已实现盈亏为 -10 元。
7. 清仓后该交易周期净盈亏为 1,980 元，账户现金和总权益为 101,980 元。
8. `cycle_return_rate = 1,980 / 22,010 = 0.08995910949568378009995456611...`。
9. 账户在首笔活动前以 100,000 元建立合成基线；无外部现金流且每日只在上述成交价
   估值时，`account_adjusted_return_rate` 为 1.98%，启用日 5 元手续费不能被吞掉。

另设纯现金流夹具：期初权益 100,000 元，当日仅出金 50,000 元，期末权益
50,000 元；资金流中性日收益率必须为 0，最大回撤必须为 0。

完整出金夹具：期初权益和现金均为 100,000 元，当日出金 100,000 元且期末权益为
0，日收益率必须为 0，净值沿用前值；出金 100,000.01 元必须以
`INSUFFICIENT_CASH` 整体回滚。周六入金归入下一个估值交易日的 `F[d]`，周末本身
不新增净值点。

跨期夹具：12 月买入 100 股，1 月卖出 50 股实现 100 元盈利，2 月卖出剩余 50 股
实现 100 元亏损并清仓。1 月的报告期已实现盈亏为 100 元且闭合周期数为 0；2 月的
报告期已实现盈亏为 -100 元、闭合周期数为 1、完整周期净盈亏为 0。修改 12 月买价
后，1 月和 2 月所有引用旧 `ledger_revision` 的快照都必须标记为过期。

样本门槛夹具：总体有 6 个闭合周期，但某个理由只有 1 个周期时，总体
`conclusion_allowed=true`，该理由分组 `conclusion_allowed=false`，且 Pi 输出不得
评价该理由有效性。

成本精度夹具使用 3 股与无法整除的成本，连续部分卖出时中间剩余成本不按分量舍入；
最后清仓必须结转全部剩余成本，并断言全部卖出结转成本之和严格等于全部买入成本与
买入手续费之和，货币输出再统一量化到分。

周期边界夹具至少包含春节长假周、月末开放持仓、跨年清仓和周期中启用账户；断言
业务日期首尾包含、期初净值基线、`partial_period` 和 `data_as_of` 的精确值。

## 实施边界

实施应保持垂直切片和最小改动：先完成账户、成交账本和确定性 reducer，再完成每日
收盘工作流，随后完成周期报告持久化和 Pi 契约，最后接入图表与页面。每个阶段先写
失败测试，再写最小实现，并在功能完成后更新 README 与运行 markdownlint。
