# Pi Subagents 投研报告并行分析设计

## 背景

当前投研报告由 Python 固化行情、缠论和资讯事实，Node sidecar 在
`emit_research_report` 阶段调用一个受约束的 Pi session 生成 Report V2。模型不能
访问 Tushare、数据库、文件系统或 shell，最终事实和引用仍由 Python 校验和水合。

本设计在不改变上述事实边界的前提下，引入 Pi subagents 的独立进程与并行调度
模式。三个固定子 Agent 分别分析行情、缠论和资讯，主 Agent 只汇总经过校验的结果。

## 目标

- 固定并行运行行情、缠论和资讯三个子 Agent。
- 每个子 Agent 使用独立 Pi 进程和独立上下文。
- 子 Agent 只读取 Python 已固化、经过裁剪的证据，不调用任何数据源。
- 主 Agent 只接收合法子分析和 canonical reference registry。
- 任一子 Agent 最终失败时不生成不完整 AI 报告。
- 保持现有 Report V2、Python lease、重试、免责声明和事实水合语义。
- 前端只展示三个角色的执行状态和安全错误摘要。

## 非目标

- 不允许主 Agent 动态创建、命名或选择子 Agent。
- 不加载用户级或项目级 `.pi/agents`。
- 不开放通用 `subagent`、read、bash、write、edit、skills 或 context 工具。
- 不让子 Agent 请求 Tushare、资讯站点、Python RPC 或数据库。
- 不把交易日记、账户、成交、备注或绝对盈亏引入投研报告。
- 不在首版把 subagents 接入交易复盘报告。
- 不在前端展示 prompt、思考过程、内部引用 ID 或完整子 Agent 输出。

## 方案选择

### 方案一：直接加载示例插件

原版插件允许模型传入任意 agent、task、cwd，并可发现用户级或项目级 Agent。示例
Agent 还可能获得文件和 shell 工具。虽然改动最少，但不满足当前投研系统的权限和
事实边界，因此不采用。

### 方案二：受控适配插件的子进程调度，采用

保留独立 Pi 子进程、隔离上下文、并行调度、abort、输出上限和 usage 汇总能力。
Node 服务在模型调用之外固定启动三个角色，角色、输入、提示词、模型、并发数和
输出 schema 全由服务端定义。主 Agent 无权改变委派计划。

### 方案三：三个进程内 Pi session

实现和部署更简单，但失去独立进程隔离，也没有实际接入 Pi subagents 的核心执行
模型，因此不采用。

## 总体架构

```text
Python frozen AdvisorRun artifacts
                |
                v
Node FixedSubagentCoordinator
                |
                +-- market-analyst --------+
                +-- chan-analyst ----------+ parallel
                +-- information-analyst ---+
                                           |
                                           v
                              validate three analyses
                                           |
                                           v
                               parent Pi report session
                                           |
                                           v
                               emit_research_report
                                           |
                                           v
                           Python canonical validation
```

现有四步状态机不变。只有状态机进入 `emit_research_report` 时才启动 coordinator。
`fetch_market_snapshot`、`run_chan_analysis` 和 `collect_information_evidence` 继续只由
Python 确定性 RPC 完成。

## 固定角色

### market-analyst

只接收固化行情 observations、成交量事实和 `market`、`price_level` 类型引用。
负责总结量价状态、边界和行情风险。

### chan-analyst

只接收已确认的分型、笔、中枢、结构状态和 `structure` 类型引用。负责总结当前结构、
确认条件和结构失效风险。

### information-analyst

只接收既有安全裁剪后的新闻、互动问答、热度和资讯质量事实，以及 `news`、`irm`、
`hot`、`information_quality` 类型引用。负责总结信息共识、冲突和时效风险。

角色名、系统提示和任务模板是代码内固定常量。HTTP 请求和主 Agent 都不能覆盖。

## 子 Agent 输入契约

```ts
interface SubagentTaskV1 {
  schema_version: "subagent_task.v1";
  role: "market" | "chan" | "information";
  as_of: string;
  timeframe: "1d" | "1w";
  evidence: Array<{
    ref: string;
    kind:
      | "market"
      | "price_level"
      | "structure"
      | "news"
      | "irm"
      | "hot"
      | "information_quality";
    label: string;
    value: string;
    observed_at?: string;
  }>;
}
```

每个角色只能接收其允许的 kind。输入从现有 safe artifacts 和 canonical registry
投影生成，不直接序列化完整 `AdvisorRun.artifacts`。输入不得包含 URL、凭据、文件
路径、数据库 ID、账户信息或原始 Provider 响应。

`report_id`、`run_id`、session ID 和业务 row ID 只用于父进程审计，不进入模型
prompt。

## 子 Agent 输出契约

```ts
interface SubagentAnalysisV1 {
  schema_version: "subagent_analysis.v1";
  role: "market" | "chan" | "information";
  summary: string;
  findings: Array<{
    claim: string;
    evidence_refs: string[];
  }>;
  risks: Array<{
    text: string;
    evidence_refs: string[];
  }>;
  confidence: "high" | "medium" | "low";
}
```

每个子进程只注册 `emit_subagent_analysis`。模型必须通过该工具提交完整输出，不能用
普通文本作为成功结果。

校验规则：

- 对象必须 exact，拒绝额外字段。
- `role` 必须与父进程启动的角色一致。
- 至少一条 finding，finding 和 risk 数量设固定上限。
- 所有引用必须属于该角色输入的引用子集。
- 引用不得重复，空引用的 finding 或 risk 无效。
- 叙述拒绝 URL、证券代码、交易指令、收益承诺和 Unicode 数字。
- 子分析不能新增价格、日期、百分比或其他市场事实。
- 不生成 fallback，不用未校验普通文本替代工具输出。

## 主 Agent 输入

三个输出全部通过校验后，父进程把它们作为 `analyst_views` 加入现有安全报告 prompt。
主 Agent 同时保留经过裁剪的 canonical reference registry，用于选择最终情景条件和
证据引用。

子 Agent 的 claim 只是带引用的分析意见，不成为新的 canonical fact。最终
ReportDraftV2 仍只能引用 Python registry 中已有 ref，Node 和 Python 现有 V2 校验
继续作为最终权威。

主 Agent 仍然只注册 `emit_research_report`，不能调用 `subagent` 或
`emit_subagent_analysis`。

## 子进程协议与权限

项目内新增 headless worker 入口。coordinator 使用 `child_process.spawn` 调用当前
Node executable 和项目 worker，不依赖全局 `pi` 命令，也不读取用户目录配置。

父进程通过 stdin 发送一份有大小上限的 JSON task，子进程通过 stdout 返回一份
有大小上限的 JSON result。非 JSON stdout、额外消息、超限输出或非零退出都视为
失败。Provider stderr 不进入 HTTP、业务数据库或普通日志。

子进程环境使用显式白名单，仅包含运行 Node 和模型 Provider 必需的配置：

- `PI_PROVIDER`
- `PI_MODEL`
- `PI_API_KEY`
- `PI_BASE_URL`
- 必需的 Node 运行参数

不传 `TUSHARE_TOKEN`、`TUSHARE_API_URL`、`DATABASE_URL`、
`INTERNAL_AGENT_TOKEN`、`PYTHON_API_BASE_URL` 或其他宿主环境变量。HTTP 不能覆盖
Provider、模型、提示词、角色、cwd 或工具。

worker 使用 `DefaultResourceLoader` 关闭 extensions、skills、prompt templates、
themes 和 context files，使用内存 session，关闭 compaction、Pi retry 和 Provider
retry。GLM-5.2 继续应用当前 Z.AI thinking disabled、`reasoning_effort:none` 和强制
工具调用兼容层。

## 并发和预算

- 每份报告固定三个角色并行执行。
- 每个子 Agent 单次超时 45 秒。
- 每个子 Agent 最多两次尝试。
- 只重试失败角色，已成功结果不重复调用。
- 主 Agent 汇总超时 60 秒。
- Node 请求总截止 180 秒。
- 单个 task 输入上限 128 KiB。
- 单个子 Agent 输出上限 16 KiB。
- 全局子 Agent 并发上限默认 6，通过 `PI_SUBAGENT_MAX_CONCURRENCY` 配置。
- HTTP 请求不得覆盖任何预算。

全局 semaphore 在多个报告之间共享。等待 semaphore 的时间计入总截止。用户取消、
HTTP 断开、总预算耗尽或 lease 失效时，父进程向所有存活子进程发送终止信号；宽限
期后仍未退出则强制结束。

## 状态、重试和恢复

三个子 Agent 同时启动。某个角色出现临时 Provider 错误、超时、进程异常或非法输出
时，只重试该角色一次。第二次仍失败时：

- 不启动主 Agent。
- Node 返回 typed、安全、可重试错误和子 Agent trace。
- Python 将 AI 报告 job 标记为 failed，确定性行情、缠论图表和资讯保持可读。
- 用户通过现有报告 retry 接口重试 AI 生成。

重试沿用同一 Python 固化快照、引用注册表和 input digest，不重新请求 Tushare、
缠论引擎或资讯源。Python lease epoch、execution owner 和 state version 继续作为最终
写入围栏，旧请求迟到完成不能覆盖新 owner。

成功子分析只在整次 Node 调用内复用。进程崩溃或用户重新发起 retry 时重新执行三个
角色，首版不实现跨请求的部分结果恢复，以免引入独立子任务租约和过期语义。

## 审计与持久化

每个角色只持久化安全 trace：

```ts
interface SubagentTraceV1 {
  role: "market" | "chan" | "information";
  status: "completed" | "failed" | "aborted";
  attempt_count: 1 | 2;
  session_id?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  error_code?: string;
}
```

成功时可以将通过校验的 `SubagentAnalysisV1` 与最终报告 job 一起保存，用于报告重放
和审计。不得持久化 prompt、模型思考、未校验输出、Provider 原始 body、stderr、API
key 或完整原始 evidence。

Python 业务数据库仍是报告状态和审计事实源；Pi session 文件或子进程 stdout 不是
恢复依据。

## HTTP 和错误契约

现有 `POST /internal/v1/agent-runs/{run_id}:execute` 保持不变。Node 成功响应增加
安全的 `subagents` trace；失败响应可以增加同一安全 trace，但不返回 prompt 或子
Agent 原文。

新增稳定错误码：

- `SUBAGENT_INVALID_INPUT`：父进程无法构造合法角色输入，不重试。
- `SUBAGENT_INVALID_OUTPUT`：两次输出均非法，可重试报告。
- `SUBAGENT_PROVIDER_ERROR`：Provider 或子进程失败，可重试。
- `SUBAGENT_TIMEOUT`：角色或总预算超时，可重试。
- `SUBAGENT_ABORTED`：请求取消或 lease 失效，按执行所有权处理。

Python 对外只返回安全中文摘要和顶层 `retryable`，不转发 Node 或 Provider 原始错误。

## 前端

AI 投研报告区域增加固定的三个角色状态，不允许动态 Agent 列表：

- 行情分析
- 缠论分析
- 资讯分析

AI job 运行时三个角色显示“并行分析中”。完成后显示“已完成”。失败时只标记失败
角色和安全错误摘要，并沿用现有重试按钮。

前端不展示内部引用 ID、子 Agent summary、findings、risks、prompt、思考过程、
session ID 或 token usage。最终用户仍只阅读现有三情景报告、触发条件、失效条件、
风险和免责声明。

## 测试

### Contracts

- 三种角色合法输入和输出。
- exact object、角色与 kind 矩阵、数量和文本边界。
- 未知引用、跨角色引用、重复引用、URL、数字、交易指令和收益承诺。

### Node coordinator

- barrier 证明三个角色确实并行启动。
- 单个失败角色重试时，成功角色调用次数保持一次。
- 任一角色最终失败时，主 Agent 调用次数为零。
- 全局并发上限在多个报告间生效。
- 输入和输出大小限制、单角色超时、总超时、abort 和强制结束。
- 子进程环境白名单，不泄露 Tushare、数据库和内部服务凭据。
- worker 只拥有 `emit_subagent_analysis`，主 Agent 只拥有
  `emit_research_report`。
- GLM-5.2 请求兼容字段和 constrained sampling 保持有效。

### Python

- 成功和失败 trace 持久化。
- 安全错误映射和 retryable。
- retry 沿用同一 frozen input，不重新调用行情和资讯 Provider。
- 旧 lease、旧 execution owner 和迟到 Node 响应被拒绝。

### Frontend

- 三个固定角色的 running、completed 和 failed 状态。
- 失败时显示安全摘要和重试入口。
- DOM 不包含引用 ID、子 Agent 输出、prompt、session ID 或 usage。
- 切换股票、周期或卸载组件后不接受迟到状态。

### Integration

提供一条真实双 HTTP 边界测试：Python 创建报告 job，Node coordinator 启动三个
独立 headless Pi worker，主 Agent 汇总，Python 完成 canonical 持久化。测试模型
使用确定性 session，但进程、并发、Bearer、租约、输出校验和持久化路径必须真实。

## 验收标准

- 单份投研报告产生且仅产生三个固定子 Agent 任务。
- 三个任务并行，主 Agent 在全部合法完成后才启动。
- 子 Agent 无数据源、网络工具、文件、shell、Python RPC 和业务写权限。
- 子 Agent 不能通过引用或文本新增事实。
- 单角色失败只重试自身；最终失败不生成缺证据报告。
- 多报告并发不超过全局子进程上限。
- 服务取消、超时和重启不会遗留长期运行的子进程或绕过 Python lease。
- 用户界面只显示角色状态和最终报告，不泄露内部证据与运行细节。
- 现有确定性报告、缠论图表、资讯、Report V2 和交易复盘功能保持兼容。
