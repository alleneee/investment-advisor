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

### Canonical registry 扩展

现有 registry 不足以支撑三个角色。Python 必须在固化输入阶段新增稳定引用，Node
不得从 safe artifact 临时生成 canonical ref：

- 行情：`market.change.latest`、`market.volume.latest`、
  `market.volume.average_20`、`market.volume.ratio_20`。
- 缠论：`chan.fractals.confirmed`、`chan.strokes.confirmed`、
  `chan.centers.active`、`chan.structure`。
- 中枢上下沿继续使用 `chan.center.upper` 和 `chan.center.lower`，虽然 kind 是
  `price_level`，但 namespace 属于 chan。
- 资讯继续使用现有 `news.*`、`irm.*`、`hot.*` 和 `information.quality*`。

聚合结构引用的 value 由 Python 根据固化 snapshot 生成 canonical JSON；稳定 ref
不包含运行时间，输入变化由现有 snapshot digest 和 report input digest 管理。

角色白名单同时检查 kind 和 namespace：

- market：允许 `market`、`price_level`，ref 必须是 `market.*`。
- chan：允许 `structure`、`price_level`，ref 必须是 `chan.*`。
- information：允许 `news`、`irm`、`hot`、`information_quality`，ref 必须是
  `news.*`、`irm.*`、`hot.*` 或 `information.quality*`。

## 子 Agent 输出契约

子 Agent 不输出自由文本。它只能给既有引用打上服务端定义的枚举判断：

```ts
type SubagentCategory =
  | "market_trend"
  | "market_momentum"
  | "volume_confirmation"
  | "boundary_proximity"
  | "volatility_risk"
  | "chan_structure_phase"
  | "chan_center_position"
  | "chan_breakout_state"
  | "chan_reversal_risk"
  | "information_tone"
  | "information_attention"
  | "information_quality"
  | "information_conflict";

interface SubagentAnalysisV1 {
  schema_version: "subagent_analysis.v1";
  role: "market" | "chan" | "information";
  stance: "supportive" | "neutral" | "adverse" | "mixed" | "uncertain";
  confidence: "high" | "medium" | "low";
  observations: Array<{
    category: SubagentCategory;
    direction: "positive" | "neutral" | "negative" | "mixed" | "unknown";
    evidence_refs: string[];
  }>;
  risk_flags: Array<{
    category: SubagentCategory;
    severity: "high" | "medium" | "low";
    evidence_refs: string[];
  }>;
}
```

每个子进程只注册 `emit_subagent_analysis`。模型必须通过该工具提交完整输出，不能用
普通文本作为成功结果。服务端使用固定中文模板把枚举和引用转换为供主 Agent 阅读的
分析视图；模板不生成新事实，只描述“哪些既有证据被哪个角色判为哪种方向”。

校验规则：

- 对象必须 exact，拒绝额外字段。
- `role` 必须与父进程启动的角色一致。
- 至少一条 observation，observation 和 risk flag 数量设固定上限。
- role、category、kind 和 ref namespace 必须满足固定兼容矩阵。
- 所有引用必须属于该角色输入的引用子集。
- 引用不得重复，空引用的 observation 或 risk flag 无效。
- 不存在模型自由文本，因此模型不能新增价格、日期、事件、政策或其他市场事实。
- 不生成 fallback，不用未校验普通文本替代工具输出。

category 与 role 的矩阵为：

- market：`market_trend`、`market_momentum`、`volume_confirmation`、
  `boundary_proximity`、`volatility_risk`。
- chan：`chan_structure_phase`、`chan_center_position`、`chan_breakout_state`、
  `chan_reversal_risk`。
- information：`information_tone`、`information_attention`、
  `information_quality`、`information_conflict`。

## 主 Agent 输入

三个输出全部通过校验后，父进程用固定服务端模板把它们转换为 `analyst_views`，再
加入现有安全报告 prompt。
主 Agent 同时保留经过裁剪的 canonical reference registry，用于选择最终情景条件和
证据引用。

子 Agent 的 claim 只是带引用的分析意见，不成为新的 canonical fact。最终
ReportDraftV2 仍只能引用 Python registry 中已有 ref，Node 和 Python 现有 V2 校验
继续作为最终权威。

主 Agent 仍然只注册 `emit_research_report`，不能调用 `subagent` 或
`emit_subagent_analysis`。

### Node 生成接口

现有跨报告缓存的 `LazyPiSession` 不再作为生产报告生成器。每份报告必须创建一个新
的内存父 session，避免历史上下文、共享 draft 捕获变量和并发 prompt 竞态。

```ts
interface SubagentCoordinatorPort {
  run(
    input: CoordinatorInput,
    signal: AbortSignal,
  ): Promise<{
    analyses: SubagentAnalysisV1[];
    traces: SubagentTraceV1[];
  }>;
}

interface ReportGeneratorPort {
  generate(
    state: AdvisorRun,
    signal: AbortSignal,
  ): Promise<{
    report: ReportDraftV2;
    subagents: SubagentTraceV1[];
    analyses: SubagentAnalysisV1[];
  }>;
}
```

`AdvisorOrchestrator` 在最终工具阶段调用 `ReportGeneratorPort`。生成器先调用固定
coordinator，再通过 session factory 创建全新父 session。`PiSessionPort` 不再承担
跨报告缓存；测试 fake 也通过 `ReportGeneratorPort` 注入。

成功后 orchestrator 将 report 交给现有 `emit_research_report` RPC，并把安全 trace
带到 HTTP 响应。analysis 不混入 `AdvisorRun.artifacts.report` 或对外 hydrated
report。

### 共用模型运行时

主 session 和子 worker 必须复用同一个配置模块，而不是复制两套 Provider 逻辑：

- New API base URL 规范化。
- custom provider 和 model 注册。
- GLM-5 thinking disabled 与 `reasoning_effort:none`。
- 按工具名参数化的 forced tool choice extension。
- constrained JSON Schema sampling。
- compaction、Pi retry 和 Provider retry 关闭策略。

现有只识别 `emit_research_report` 的兼容函数改为接收目标工具名；父 session 传
`emit_research_report`，worker 传 `emit_subagent_analysis`。

## 子进程协议与权限

项目内新增 headless worker 入口。coordinator 使用 `child_process.spawn` 调用
`process.execPath` 的绝对路径，不依赖全局 `pi` 命令，也不读取用户目录配置。

开发态与生产态使用明确入口：

- 开发态通过 `import.meta.url` 解析相邻 `.ts` worker，并只增加项目本地解析出的
  `--import tsx`；禁止转发父进程 `process.execArgv`。
- 新增 agent runtime emit build 和独立 build tsconfig。生产 worker 编译为与
  coordinator 相邻的 `.js`，通过 `import.meta.url` 解析。
- readiness 在启动前验证对应入口存在且可由当前 Node runtime 加载；开发测试覆盖
  `.ts + tsx`，生产测试先 build 再直接启动 `.js`。
- 不继承 `NODE_OPTIONS`、`PATH` 或 `HOME`。Node executable 使用已解析绝对路径，
  worker 的依赖按模块位置解析。

协议使用 exact JSON：

```ts
interface WorkerRequestV1 {
  schema_version: "subagent_worker_request.v1";
  request_id: string;
  task: SubagentTaskV1;
}

interface WorkerSuccessV1 {
  schema_version: "subagent_worker_result.v1";
  request_id: string;
  status: "completed";
  analysis: SubagentAnalysisV1;
  trace: {
    session_id: string;
    input_tokens: number;
    output_tokens: number;
  };
}

interface WorkerFailureV1 {
  schema_version: "subagent_worker_result.v1";
  request_id: string;
  status: "failed";
  error: {
    code: "INVALID_INPUT" | "INVALID_OUTPUT" | "PROVIDER_ERROR" | "TIMEOUT" | "INTERNAL_ERROR";
    retryable: boolean;
  };
}
```

父进程向 stdin 写入一个 JSON 对象后立即关闭 stdin。stdout 是唯一协议通道，worker
禁止向 stdout 写日志；父进程按原始 byte 增量计数，超限立即终止进程。stderr 必须
持续 drain 以避免管道阻塞，但只在内存保留固定小上限并且永不进入 HTTP、业务库或
普通日志。非 JSON stdout、额外消息、request ID 不一致、超限输出或非零退出都视为
失败。session ID 和 usage 只能取 worker 内真实 Pi session 结果，父进程不能推测。

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

这里的权限边界是“模型没有文件、shell、业务网络或 RPC 工具”，不是 OS sandbox。
worker 进程仍能加载自身 Node 模块、持有模型 API key，并能访问配置的模型 Provider；
容器级只读文件系统和 egress allowlist 仍由部署环境负责。

## 并发和预算

- 每份报告固定提交三个角色；没有全局竞争时三个 worker 并行 spawn。
- 每个子 Agent 单次超时 45 秒。
- 每个子 Agent 最多两次尝试。
- 只重试失败角色，已成功结果不重复调用。
- 主 Agent 汇总超时 60 秒。
- Node 请求总截止 180 秒。
- 单个 task 输入上限 128 KiB。
- 单个子 Agent 输出上限 16 KiB。
- Node 进程内全局子 Agent 并发上限默认 6，通过
  `PI_SUBAGENT_MAX_CONCURRENCY` 配置。
- HTTP 请求不得覆盖任何预算。

semaphore 在同一个 Node 进程的多个报告之间共享，使用 FIFO waiter。多副本部署的
总上限是“副本数乘以单进程上限”，首版不实现分布式配额；部署层必须据此设置副本
数和 Provider 限流。abort waiter 会立即从队列移除，每次 retry 重新获取 permit，
进程 close 或 error 后只释放一次 permit。

180 秒从 Node 收到请求时开始，包含四个 Python RPC、semaphore 等待、子 Agent
重试、lease owner 检查、kill grace 和主 Agent 汇总。每次子调用的实际 timeout 是
`min(45 秒, remaining)`，主汇总是 `min(60 秒, remaining)`；剩余预算不足时不得继续
spawn 或重试。Python 客户端 245 秒 timeout 保留为 65 秒外围余量，Python lease
300 秒保留为 120 秒接管余量。

### Abort 和 owner 检查

- Node server 为每个执行请求创建 `AbortController`，监听 request aborted、socket
  close 和服务关闭。
- signal 贯穿 orchestrator、FIFO semaphore、worker、retry delay 和父 Pi session。
- 父 Pi session 在 abort 或 timeout 时调用 `session.abort()`，随后 dispose。
- coordinator 运行期间每 10 秒调用轻量 owner-check RPC，校验 run ID、execution ID
  和 lease epoch；不匹配时 abort 全部子进程。
- worker 收到 abort 后先发送 `SIGTERM`，等待真实 `close` 事件；5 秒宽限后仍未 close
  才发送 `SIGKILL`。不能使用 `proc.killed` 判断进程是否已经退出。
- 所有 request listener、timer、owner-check、waiter 和 semaphore permit 都在
  success、error、close 与 abort 路径释放。

owner-check 使用新的内部接口：

```text
GET /internal/v1/agent-runs/{run_id}/owner
  ?execution_id={execution_id}&lease_epoch={lease_epoch}
```

它使用现有内部 Bearer token，只读取 `investment_report_jobs` 的 running owner，成功
返回 `{valid:true,state_version,checked_at}`；job 非 running、execution ID 或 lease
不匹配时返回 409。响应不包含 artifacts。Node 在启动 coordinator 前、轮询期间、
启动父 session 前和 emit RPC 前都执行检查。

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
  attempt_count: 0 | 1 | 2;
  session_id?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  error_code?: string;
}
```

成功时必须将通过校验的 `SubagentAnalysisV1` 与最终报告 job 一起保存，用于报告重放
和审计。不得持久化 prompt、模型思考、未校验输出、Provider 原始 body、stderr、API
key 或完整原始 evidence。

`investment_report_jobs` 增加独立 `subagent_trace` 和内部
`subagent_analyses` JSONB 列。它们不能写入 hydrated report 的 `result` 字段。
complete 或 fail 必须在同一数据库事务里写终态、trace 和 analysis；终态更新条件
必须同时匹配 `status='running'`、`lease_epoch` 和 `execution_id`。retry、requeue 和
新 owner 接管会清空旧 trace 和 analysis，避免把旧尝试显示成当前运行结果。

Python 业务数据库仍是报告状态和审计事实源；Pi session 文件或子进程 stdout 不是
恢复依据。

## HTTP 和错误契约

现有 `POST /internal/v1/agent-runs/{run_id}:execute` 路径保持不变，响应固定为：

请求体 exact 为 `{execution_id, lease_epoch, expected_state_version}`，拒绝额外字段。
现有 `max_turns` HTTP 覆盖入口移除，所有模型、并发和预算只读服务端配置。

```ts
interface AgentRunSuccessV2 {
  status: "completed";
  run_id: string;
  execution_id: string;
  lease_epoch: number;
  report: ReportDraftV2;
  subagents: SubagentTraceV1[];
}

interface AgentRunFailureV2 {
  status: "failed";
  run_id: string;
  execution_id: string;
  lease_epoch: number;
  error: { code: string; message: string; retryable: boolean };
  subagents: SubagentTraceV1[];
}
```

`AgentRunFailureV2` 用于请求 envelope 已通过校验且执行已开始的失败。鉴权失败、请求体
超限或缺少 execution 字段时，继续返回当前不带 owner 的通用安全 error envelope。

Node 不返回 analysis 原文。Python `AgentRuntimeClient` 必须解析成功和失败 trace；异常
对象携带安全 trace，不能丢弃。业务 job 对外 envelope 单独暴露安全 `subagents`
状态，不把它塞进 report。Python complete/fail 在一次事务中同时保存终态和 trace。

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

外部 DTO 使用固定对象而不是动态数组：

```ts
type PublicSubagentState = {
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  attempt_count: 0 | 1 | 2;
  error?: { code: string; message: string };
};

type PublicSubagents = null | {
  market: PublicSubagentState;
  chan: PublicSubagentState;
  information: PublicSubagentState;
};
```

AI job 进入 running 时 Python 初始化三个角色为 running；终态用 Node trace 更新。失败
时只标记失败角色和安全错误摘要，并沿用现有重试按钮。旧报告没有 subagent trace 时
返回 `subagents:null` 并隐藏角色区域，不伪造“已完成”。

前端 exact adapter、types、mock 和测试必须同步加入 `subagents` 字段。切换股票、周期
或报告 ID 时继续使用现有 lifecycle token 丢弃迟到响应。

前端不展示内部引用 ID、子 Agent summary、findings、risks、prompt、思考过程、
session ID 或 token usage。最终用户仍只阅读现有三情景报告、触发条件、失效条件、
风险和免责声明。

实现时提升 `PROMPT_VERSION`，新增固定 `SUBAGENT_PLAN_VERSION`，两者都进入 report
input digest。这样旧 completed 缓存不会绕过三个子 Agent；历史报告仍可只读展示。

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
- 开发 `.ts + tsx` worker 和生产 build 后 `.js` worker 都可启动。
- owner-check、HTTP disconnect 和 timeout 都会终止 worker，且没有残留进程、timer、
  listener 或 semaphore permit。

### Python

- 成功和失败 trace 持久化。
- 安全错误映射和 retryable。
- retry 沿用同一 frozen input，不重新调用行情和资讯 Provider。
- 旧 lease、旧 execution owner 和迟到 Node 响应被拒绝。
- complete/fail 同时校验 execution ID，trace 和终态同事务提交。

### Frontend

- 三个固定角色的 pending、running、completed、failed 和 aborted 状态。
- 失败时显示安全摘要和重试入口。
- DOM 不包含引用 ID、子 Agent 输出、prompt、session ID 或 usage。
- 切换股票、周期或卸载组件后不接受迟到状态。
- 旧报告的 `subagents:null` 隐藏角色区域。

### Integration

提供一条真实双 HTTP 边界测试。测试启动本地 deterministic OpenAI-compatible SSE
Provider，coordinator 和 worker 都通过真实 Pi SDK 调用该 Provider；三个真实子进程
按工具 schema 返回 analysis，父 session 返回最终 report。Python、Node、Bearer、
lease、canonical validation、数据库写入和进程协议全部真实，不直接注入 fake
session。

另提供生产编译产物启动测试，以及 HTTP 断开后等待 kill grace 并断言没有残留子进程
的测试。

## 验收标准

- 单份投研报告产生且仅产生三个固定子 Agent 任务。
- 三个任务并行，主 Agent 在全部合法完成后才启动。
- 子 Agent 模型无数据源、业务网络、文件、shell、Python RPC 和业务写入工具；部署
  层继续负责 OS sandbox 与 egress allowlist。
- 子 Agent 只输出枚举和既有引用，不能通过自由文本新增事实。
- 单角色失败只重试自身；最终失败不生成缺证据报告。
- 多报告并发不超过全局子进程上限。
- 服务取消、超时和重启不会遗留长期运行的子进程或绕过 Python lease。
- 用户界面只显示角色状态和最终报告，不泄露内部证据与运行细节。
- 现有确定性报告、缠论图表、资讯、Report V2 和交易复盘功能保持兼容。
