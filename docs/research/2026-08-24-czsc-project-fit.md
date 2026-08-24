# CZSC 对本项目的适用性研究

## 结论

CZSC 对本项目有明显帮助，但当前最合适的定位是：

1. 作为缠论算法的离线对照实现和测试样本来源。
2. 作为多周期编排、信号注册和研究回放的设计参考。
3. 作为内部调试图，而不是生产 React 图表组件。

不建议现在把 CZSC 直接替换进生产分析链路。两套引擎在数值类型、K 线更新、
笔确认、中枢划分、时间可用性和输出契约上都不兼容。直接替换会改变历史报告，
也会破坏本项目已有的可冻结、可引用事实链。

本结论基于 2026-08-24 检查的 CZSC `master`，源码提交为
[`701e480`](https://github.com/waditu/czsc/tree/701e480a545004f945bb1721e510ae610ad90c4c)。

## 本项目当前基线

本项目已经有一条完整、轻量的生产链路：

```text
Tushare 前复权行情
  -> CanonicalBar
  -> ChanEngine
  -> market_snapshot / chan_analysis
  -> React API 适配
  -> ECharts K 线、笔、中枢和成交量
```

当前 `ChanEngine` 已实现包含处理、分型、严格笔、顺序笔中枢、确认中笔、缺口和
`occurred_at` / `known_at` / `stable_through` 时间语义。价格使用 `Decimal`，报告还
通过 `snapshot_id`、引擎版本和输入摘要冻结分析事实。

当前未实现的能力是线段、线段中枢、走势类型、MACD 背驰、一二三类买卖点和
次级别确认。这些能力目前只存在于设计文档中，不能当作已交付功能。

相关实现：

- `apps/api/app/domain/chan_engine.py`
- `apps/api/app/analysis.py`
- `apps/web/src/api.ts`
- `apps/web/src/ChanChart.tsx`
- `apps/web/src/chan-chart-option.ts`
- `docs/superpowers/specs/2026-08-21-chan-engine-signals-design.md`

## CZSC 当前提供什么

CZSC 1.x 是 Rust 核心加 Python 门面的完整量化研究框架。核心公开对象包括
`RawBar`、`NewBar`、`FX`、`BI`、`ZS`、`CZSC`、`BarGenerator`、
`CzscSignals` 和 `CzscTrader`。它还提供大量信号函数、策略研究、回放、参数
优化、行情连接器和 HTML 可视化。

值得注意的当前事实：

- `CZSC` 支持逐根更新 K 线，内部维护去包含 K 线和笔列表。
- `zs_list` 已在当前 `master` 暴露，但它是从已完成笔动态计算出来的。
- 核心没有独立的缠论线段类型或线段列表。
- `plot_czsc`、`plot_czsc_trader` 和 `plot_czsc_signals` 输出自包含 HTML。
- `plot_czsc` 当前绘制 K 线、均线、分型、笔、成交量和 MACD，不绘制 `zs_list`。
- Python 包通过 PyO3 使用 Rust 扩展，同时带入 pandas、NumPy、PyArrow、Polars、
  SciPy、statsmodels、wbt 和 Plotly 等依赖。

来源：

- [CZSC README](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/README.md)
- [公开 API](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/docs/public_api.md)
- [CZSC 核心对象](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/crates/czsc-core/src/analyze/mod.rs)
- [中枢序列算法](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/crates/czsc-core/src/analyze/utils.rs)
- [lightweight-charts 数据适配](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/czsc/utils/plotting/lightweight/_data.py)
- [Python 依赖与许可证](https://github.com/waditu/czsc/blob/701e480a545004f945bb1721e510ae610ad90c4c/pyproject.toml)

## 能力对照

| 能力 | 本项目 | CZSC 能提供的帮助 | 建议 |
| --- | --- | --- | --- |
| 包含、分型、笔 | 已有最小实现 | 成熟实现、边界案例、性能基准 | 离线差分测试 |
| 笔中枢 | 已有顺序中枢 | `ZS` 和 `zs_list` 可作语义对照 | 对照，不直接替换 |
| 线段 | 仅有设计 | 核心没有独立线段模型 | 仍需自行实现 |
| MACD 背驰 | 仅有设计 | 有多种 MACD 背驰信号 | 候选规则和测试样本 |
| 一二三类买卖点 | 仅有设计 | 有多种辅助信号，口径并不统一 | 研究参考，不作事实源 |
| 多周期联立 | 日、周已接入，30 分钟待建设 | CZSC 的多周期编排较成熟 | 重点参考 |
| K 线质量检查 | 本项目较少 | 有顺序、重复、价格、成交量等检查 | 可拆思路复用 |
| 可视化 | React + ECharts，已画笔中枢 | 自包含 HTML，带分型、笔、MACD、信号 | 仅作内部调试图 |
| 数据连接器 | 已有 Tushare 和冻结快照 | Tushare、TQSDK、CCXT、本地数据 | 当前不接入 |
| 回放、回测、优化 | 尚未建设 | 完整研究和回放入口 | 信号稳定后再评估 |

## 最有价值的三种用法

### 1. 建立离线差分测试

这是当前收益最高、风险最低的用法。

对同一份固定前复权 K 线，同时运行本项目 `ChanEngine` 和 CZSC，比较：

- 去包含 K 线数量和端点。
- 分型时间、类型和价格。
- 已完成笔的起止时间、方向和价格。
- 有效中枢的开始、结束、上下沿。

差分结果不能简单要求完全相等。CZSC 使用 `f64`，本项目使用 `Decimal`；两者的
笔最小长度、最后一笔确认和中枢分组也可能不同。正确做法是把差异分类为
“本项目缺陷”“CZSC 口径差异”“需求明确选择”，再固化成回归样本。

这种用法不需要把 CZSC 放进生产依赖，只需要放进独立研究或测试环境。

### 2. 参考多周期和信号注册架构

本项目下一阶段需要日线、周线和 30 分钟次级别确认。CZSC 的
`BarGenerator -> CzscSignals -> CzscTrader` 已经给出一套清楚的职责划分：

- 基础周期只输入一次。
- 高级别 K 线由合成器维护。
- 信号声明自己依赖的周期。
- 多周期对象统一编排各级别分析结果。

这套分层值得参考，但本项目仍应保留现有的“30 分钟预拉入库、分析只读缓存、
报告输入冻结”约束。CZSC 的实时合成器不能替代本项目的数据可追溯契约。

### 3. 用 HTML 图做算法调试

`plot_czsc` 可以快速生成分型、笔、成交量和 MACD 调试图；
`plot_czsc_signals` 还能叠加信号触发点。它适合：

- 开发者核对某个差分样本。
- 评审信号参数和触发位置。
- 生成一次性的研究附件。

它不适合替换当前 `ChanChart`：输出是完整 HTML，而不是 React 组件；数据来自
CZSC 自己的结构对象；当前还不画中枢。若嵌入生产页面，只能通过 iframe 或
重新拆数据协议，会形成第二套图表运行时和第二套结构口径。

## 不能直接替换的硬边界

### 数据与时间契约不同

CZSC `RawBar` 使用 `f64`、UTC 时间、递增 `id`、成交额等字段。本项目
`CanonicalBar` 使用 `Decimal`，并显式携带 `occurred_at`、`known_at`、
`stable_through` 和 `payload_hash`。CZSC 没有对应的事实可用时间契约。

### 增量更新语义不同

CZSC 对相同时间的最新 K 线允许覆盖更新。本项目对同一证券、同一时间的不同内容
直接报错，只允许完全相同输入幂等重放。这个差异会影响实时 K 线、历史修订和报告
复现，不能靠简单字段映射消除。

### 笔和中枢语义不同

CZSC 允许配置最小笔长，并会限制保留的最大笔数。其 `zs_list` 会先把笔连续分组
成 `ZS`，调用方还需要通过 `is_valid` 判断有效中枢。本项目只输出满足三笔重叠的
顺序中枢，并使用自己的延伸与离开规则。直接替换会改变中枢数量和区间。

### 输出与报告契约不同

本项目的结构快照被 API、报告生成、归因、指标、引用注册表和前端共同消费。
`engine_version` 与输入摘要还决定报告是否可复现。即使 CZSC 算法更完整，也不能
在不升引擎版本、不双跑对比、不迁移历史契约的情况下直接接管输出。

### 下一阶段需求并未被完整覆盖

CZSC 有大量基于笔、均线和 MACD 的买卖点辅助信号，但核心没有本项目设计要求的
“特征序列线段 -> 线段中枢 -> 走势类型 -> 趋势背驰 -> 次级别确认”完整事实链。
因此它能提供规则候选和样本，不能替代下一阶段的领域实现。

## 推荐采用顺序

### P0：现在做

1. 固定 3 到 5 组真实前复权行情样本，覆盖包含、跳空、最后一笔变化和多个中枢。
2. 在独立研究脚本中把 `CanonicalBar` 映射到 CZSC `RawBar`。
3. 输出分型、笔、有效中枢差分，不改生产依赖和生产接口。
4. 用 CZSC HTML 图辅助人工复核差异。

### P1：实现信号栈时做

1. 参考 CZSC 的多周期合成和信号注册边界。
2. 为每一种 MACD 背驰和买卖点口径选取少量 CZSC 信号做对照。
3. 坚持本项目设计的纯函数快照、次级别确认和时间可用性字段。
4. 不复制“220+ 信号”规模，只引入报告明确需要、能被测试和引用的信号。

### P2：信号稳定后再评估

评估 CZSC 的回放、研究和权重回测是否能作为离线研究工具。生产报告和交易归因
仍使用本项目冻结的事实快照，避免研究结果与线上事实源混用。

## 最终建议

采用 CZSC，但采用方式是“旁路对照 + 设计借鉴 + 内部调试”，不是“生产替换”。

如果未来决定让 CZSC 成为权威引擎，应新建独立引擎适配层，执行双跑、差分、历史
回填和引擎版本升级；不要在现有 `ChanEngine` 内部直接导入 CZSC 并替换结果。
