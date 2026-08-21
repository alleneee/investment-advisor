# Pi Subagents 投研报告并行分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为投研报告增加三个固定、无业务工具的 Pi 子 Agent，并行分析行情、缠论和
资讯后，由独立主 Pi session 汇总生成 Report V2。

**Architecture:** Python 继续固化所有 canonical 事实和引用；Node 在最终 emit 阶段
通过受控 coordinator 启动三个独立 headless Pi worker。worker 只输出枚举判断和
既有引用，全部通过共享 schema 校验后才进入每报告新建的父 session；Python
lease、execution owner 和数据库仍是最终权威。

**Tech Stack:** TypeScript、Node.js `child_process`、Pi SDK、手写 JSON Schema、
FastAPI、PostgreSQL、React、Vitest、pytest、httpx。

---

## 开始前约束

- 当前工作区包含其他未提交改动。Task 0 没有建立用户确认的基线提交前，禁止开始
  任何实现任务和功能提交。
- 每个任务只能 `git add` 该任务列出的文件，禁止 `git add .`。按路径 add 不能隔离
  同一文件里的旧改动，因此所有目标文件必须先包含在 Task 0 基线中。
- 每次修改函数、类或方法前，先运行：

```bash
npx gitnexus impact <symbol> -r investment-advisor
```

- 如果 GitNexus 返回 HIGH 或 CRITICAL，先报告 blast radius，不直接修改。
- 各 Task 列出的 impact 命令是最低集合；实现过程中发现还需修改其他既有 symbol 时，
  必须先补该 symbol 的 impact，不能用文件级推断代替。
- 每个任务严格执行 RED、GREEN、回归、staged 影响检查、提交。
- 子 Agent 实现不能加载 `/Users/niko/pi` 的用户级 agent 配置，也不能依赖全局
  `pi` 命令。

每个任务提交前统一执行：

```bash
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
```

输出必须只包含该任务预期文件和流程。发现夹带或意外流程时停止提交。

## 文件职责

### 新建文件

- `packages/contracts/src/subagent.ts`：共享 task、analysis、worker 协议、trace 类型、
  JSON Schema 和 validator。
- `packages/contracts/src/subagent.test.ts`：共享契约边界测试。
- `tests/fixtures/subagent/valid-market-task.json`：合法行情任务。
- `tests/fixtures/subagent/valid-chan-task.json`：合法缠论任务。
- `tests/fixtures/subagent/valid-information-task.json`：合法资讯任务。
- `tests/fixtures/subagent/valid-worker-request.json`：合法 worker 协议请求。
- `tests/fixtures/subagent/valid-analysis.json`：合法枚举分析。
- `tests/fixtures/subagent/invalid-cases.json`：跨角色引用、额外字段和边界反例。
- `apps/agent-runtime/src/pi-model-runtime.ts`：父 session 与 worker 共用的 Provider、
  GLM 和 forced tool choice 配置。
- `apps/agent-runtime/src/subagent-session.ts`：只允许
  `emit_subagent_analysis` 的单次 Pi session。
- `apps/agent-runtime/src/subagent-session.test.ts`：工具和 prompt 边界。
- `apps/agent-runtime/src/subagent-worker.ts`：headless stdin/stdout worker 入口。
- `apps/agent-runtime/src/subagent-worker.test.ts`：开发和生产 worker 协议测试。
- `apps/agent-runtime/src/subagent-semaphore.ts`：进程内 FIFO、abort-aware semaphore。
- `apps/agent-runtime/src/subagent-semaphore.test.ts`：公平性和 permit 释放测试。
- `apps/agent-runtime/src/subagent-process.ts`：spawn、环境白名单、byte limit、kill。
- `apps/agent-runtime/src/subagent-process.test.ts`：进程边界测试。
- `apps/agent-runtime/src/subagent-coordinator.ts`：固定三角色并行和单角色重试。
- `apps/agent-runtime/src/subagent-coordinator.test.ts`：并发、重试、预算、owner 测试。
- `apps/agent-runtime/src/report-generator.ts`：coordinator 与每报告父 session 编排。
- `apps/agent-runtime/src/report-generator.test.ts`：父 session 隔离与失败短路测试。
- `tsconfig.agent-build.json`：可 emit 的 Node 生产构建配置。
- `tests/integration/subagent_provider_entry.ts`：deterministic
  OpenAI-compatible SSE Provider。
- `tests/integration/test_subagent_report_flow.py`：真实 Python、Node、三个 worker、父
  session 集成测试。

### 修改文件

- `packages/contracts/src/index.ts`：导出 subagent contracts。
- `apps/api/app/reporting.py`：扩展 canonical refs、digest/version、内部响应解析和安全
  trace。
- `apps/api/app/db.py`：trace/analysis 列、execution owner 围栏和原子终态。
- `apps/api/app/api.py`：owner-check RPC 和 public subagents envelope。
- `tests/api/test_reporting.py`：registry、digest、持久化、retry 测试。
- `tests/api/test_internal_rpc.py`：owner-check 和旧 owner 测试。
- `tests/api/test_api.py`：public DTO 和历史兼容测试。
- `apps/agent-runtime/src/pi-session.ts`：改用共用模型配置并创建单次父 session。
- `apps/agent-runtime/src/orchestrator.ts`：注入 `ReportGeneratorPort` 和 signal。
- `apps/agent-runtime/src/rpc.ts`：owner-check RPC。
- `apps/agent-runtime/src/runtime-fakes.ts`：新接口 fake。
- `apps/agent-runtime/src/server.ts`：exact request、abort、typed response、readiness。
- 对应 Node 测试文件：适配新接口与响应。
- `apps/web/src/types.ts`：public subagent 状态。
- `apps/web/src/api.ts`：exact adapter。
- `apps/web/src/OutlookPanel.tsx`：三个固定角色状态。
- 对应 Web 测试文件：状态、历史兼容和隐私断言。
- `package.json`：agent build 脚本。
- `tsconfig.json`：保持开发 typecheck 覆盖新文件。
- `README.md`：配置、进程模型、预算和验证命令。

---

### Task 0: 建立用户确认的干净基线

**Files:**

- 不修改业务文件。
- 只在用户确认后提交已经存在的工作区改动。

- [ ] **Step 1: 检查 GitNexus 索引**

```bash
npx gitnexus status
```

Expected: 索引 fresh。若 stale，运行：

```bash
npx gitnexus analyze --index-only --name investment-advisor
```

- [ ] **Step 2: 完整展示当前工作区基线候选**

```bash
git status --short
git diff --stat
git diff --name-status
git ls-files --others --exclude-standard
```

Expected: 明确区分业务实现、测试、文档和本地工具文件，不隐藏任何未跟踪文件。

- [ ] **Step 3: 运行当前基线门禁**

```bash
uv run --offline pytest -q
npm test
npx tsc --noEmit
npm --prefix apps/web test -- --run
npm --prefix apps/web run typecheck
```

Expected: PASS；既有无关 lint 告警单独列出。

- [ ] **Step 4: 请求用户确认基线文件清单**

向用户展示准备纳入基线的精确文件列表。没有用户明确批准时停止，不执行 `git add`、
commit、stash、reset 或 worktree 迁移。

- [ ] **Step 5: 仅按批准清单建立基线提交**

```bash
git add -- <用户批准的精确路径列表>
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "chore: checkpoint investment advisor baseline"
git rev-parse HEAD
```

Expected: 记录输出为 `<Task-0-baseline-commit>`。提交后所有 Task 1 至 Task 10 的目标
文件都必须 clean；否则停止实施并重新请求用户处理剩余重叠改动。

---

### Task 1: 建立共享 Subagent 契约

**Files:**

- Create: `packages/contracts/src/subagent.ts`
- Create: `packages/contracts/src/subagent.test.ts`
- Create: `tests/fixtures/subagent/valid-market-task.json`
- Create: `tests/fixtures/subagent/valid-chan-task.json`
- Create: `tests/fixtures/subagent/valid-information-task.json`
- Create: `tests/fixtures/subagent/valid-worker-request.json`
- Create: `tests/fixtures/subagent/valid-analysis.json`
- Create: `tests/fixtures/subagent/invalid-cases.json`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: 对导出符号做影响分析**

Run:

```bash
npx gitnexus impact validateReportDraftV2 -r investment-advisor
```

Expected: 记录 contracts 的现有直接消费者；本任务只新增导出，不修改 Report V2。

- [ ] **Step 2: 写共享契约 RED 测试**

测试至少包含：

```ts
test('market analysis rejects chan categories and unknown refs', () => {
  const result = validateSubagentAnalysis(invalid, validMarketTask);
  assert.equal(result.ok, false);
});

test('worker protocol requires one exact discriminated result', () => {
  assert.equal(validateWorkerResult(extraField).ok, false);
});
```

逐项覆盖：role/category/kind/namespace 矩阵、UUID、ref pattern、日期、条数、
`uniqueItems`、额外字段、安全整数、`SubagentTraceV1`、worker envelope、内部
`AgentRunSuccessV2/AgentRunFailureV2` 和全部合法 fixture。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
node --import tsx --test packages/contracts/src/subagent.test.ts
```

Expected: FAIL，`subagent.ts` 和 validator 尚不存在。

- [ ] **Step 4: 实现最小共享契约**

核心公开接口必须与规格一致：

```ts
export type SubagentRole = 'market' | 'chan' | 'information';

export interface SubagentTaskV1 {
  schema_version: 'subagent_task.v1';
  role: SubagentRole;
  as_of: string;
  timeframe: '1d' | '1w';
  evidence: SubagentEvidence[];
}

export interface SubagentAnalysisV1 {
  schema_version: 'subagent_analysis.v1';
  role: SubagentRole;
  stance: 'supportive' | 'neutral' | 'adverse' | 'mixed' | 'uncertain';
  confidence: 'high' | 'medium' | 'low';
  observations: SubagentObservation[];
  risk_flags: SubagentRiskFlag[];
}
```

使用手写 JSON Schema，不新增 TypeBox 直接依赖。实现
`SUBAGENT_TASK_JSON_SCHEMA`、`SUBAGENT_ANALYSIS_JSON_SCHEMA`、trace、worker
request/success/failure、内部 agent-run success/failure schema，以及：

```ts
validateSubagentTask(value: unknown): ValidationResult;
validateSubagentAnalysis(
  value: unknown,
  task: SubagentTaskV1,
): ValidationResult;
validateWorkerRequest(value: unknown): ValidationResult;
validateWorkerResult(value: unknown): ValidationResult;
```

- [ ] **Step 5: 运行契约测试和 TypeScript 检查**

Run:

```bash
node --import tsx --test packages/contracts/src/subagent.test.ts
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交 Task 1**

```bash
git add packages/contracts/src/subagent.ts \
  packages/contracts/src/subagent.test.ts \
  packages/contracts/src/index.ts \
  tests/fixtures/subagent
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: add fixed subagent contracts"
```

---

### Task 2: 扩展 Python Canonical Registry 和输入版本

**Files:**

- Modify: `apps/api/app/reporting.py`
- Modify: `tests/api/test_reporting.py`
- Modify: `tests/api/test_internal_rpc.py`

- [ ] **Step 1: 对 registry 和 digest 做影响分析**

Run:

```bash
npx gitnexus impact build_reference_registry -r investment-advisor
npx gitnexus impact build_input_digest -r investment-advisor
```

Expected: 如果任一结果为 HIGH，先报告受影响的报告创建、缓存和内部 RPC 流程。

- [ ] **Step 2: 写 registry 和缓存失效 RED 测试**

新增测试断言：

```python
registry = build_reference_registry(frozen_input)
assert registry["market.volume.latest"]["kind"] == "market"
assert registry["chan.fractals.confirmed"]["kind"] == "structure"
assert len(json.loads(registry["chan.fractals.confirmed"]["value"])) <= 20
assert frozen_input["subagent_plan_version"] == SUBAGENT_PLAN_VERSION
```

另外覆盖规格中的全部新增 refs、每类最多 20 项的确定性裁剪、单 value 最多 2,000
Unicode code point，以及 `observed_at` 不晚于上海日终。同一旧输入在版本提升后产生
新 digest，排序不同但事实相同的结构输入得到相同 canonical value。final-report
registry 必须保留现有 URL 元数据供 Python 水合；子 Agent 的 URL 和证券代码净化放在
Task 6 的 Node 投影层。

- [ ] **Step 3: 运行测试确认 RED**

```bash
uv run --offline pytest -q \
  tests/api/test_reporting.py -k 'subagent or volume or canonical'
```

Expected: FAIL，缺少新 refs 和版本字段。

- [ ] **Step 4: 实现 registry 扩展和确定性裁剪**

在 `reporting.py` 增加：

```python
PROMPT_VERSION = "pi-advisor.v3"
SUBAGENT_PLAN_VERSION = "fixed-three.v1"
```

将 `subagent_plan_version` 纳入 `DIGEST_FIELDS` 和 frozen input。新增 helper 只保留字段
白名单，按 `known_at`、`occurred_at`、稳定 ID 排序，截取最后 20 项，然后用
`sort_keys=True` 生成 canonical JSON。不得在 Node 生成这些 ref。

- [ ] **Step 5: 运行 Python 定向回归**

```bash
uv run --offline pytest -q tests/api/test_reporting.py tests/api/test_internal_rpc.py
uv run --offline ruff check apps/api/app/reporting.py \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py
```

Expected: PASS。

- [ ] **Step 6: 提交 Task 2**

```bash
git add apps/api/app/reporting.py \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: add canonical subagent evidence"
```

---

### Task 3: 抽取共用 Pi 模型运行时并移除父 Session 单例

**Files:**

- Create: `apps/agent-runtime/src/pi-model-runtime.ts`
- Create: `apps/agent-runtime/src/pi-model-runtime.test.ts`
- Modify: `apps/agent-runtime/src/pi-session.ts`
- Modify: `apps/agent-runtime/src/pi-session.test.ts`

- [ ] **Step 1: 做影响分析**

```bash
npx gitnexus impact createPiSession -r investment-advisor
npx gitnexus impact forceReportToolChoicePayload -r investment-advisor
npx gitnexus impact LazyPiSession -r investment-advisor
```

- [ ] **Step 2: 写参数化工具和 Session 隔离 RED 测试**

```ts
assert.equal(
  forceToolChoicePayload(payload, 'emit_subagent_analysis').tool_choice,
  'required',
);

test('report session factory creates a fresh session per report', async () => {
  const first = await factory.create();
  const second = await factory.create();
  assert.notEqual(first, second);
});
```

覆盖 New API URL 规范化、GLM thinking disabled、父工具和子工具 constrained schema、
retry/compaction 关闭。

- [ ] **Step 3: 运行测试确认 RED**

```bash
node --import tsx --test \
  apps/agent-runtime/src/pi-model-runtime.test.ts \
  apps/agent-runtime/src/pi-session.test.ts
```

Expected: FAIL，当前兼容层只识别 `emit_research_report` 且 `LazyPiSession` 复用实例。

- [ ] **Step 4: 实现共用模块**

提供：

```ts
export async function createRestrictedModelServices(
  env: Record<string, string | undefined>,
): Promise<RestrictedModelServices>;

export function forceToolChoicePayload(
  payload: unknown,
  toolName: string,
): unknown;

export function forceToolChoiceExtension(
  toolName: string,
): ExtensionFactory;
```

`pi-session.ts` 改为 `ReportSessionFactory`，每次 `create()` 使用新的
`SessionManager.inMemory()`、独立 draft capture 和新的 AgentSession。返回 handle：

```ts
interface ReportSessionHandle {
  run(input: ParentReportInput, signal: AbortSignal): Promise<ReportDraftV2>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
```

共享只读 model services 可以缓存，但 session 和 draft 变量不能缓存。Task 3 暂时
保留 `LazyPiSession` 兼容适配器供当前 server 编译；兼容器每次 `run()` 都创建并销毁
一个新 handle，不再缓存 session。Task 7 完成 `ReportGeneratorPort` 接线后再删除该
兼容器和 server 的旧 import。

- [ ] **Step 5: 运行 Node 回归**

```bash
node --import tsx --test \
  apps/agent-runtime/src/pi-model-runtime.test.ts \
  apps/agent-runtime/src/pi-session.test.ts
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交 Task 3**

```bash
git add apps/agent-runtime/src/pi-model-runtime.ts \
  apps/agent-runtime/src/pi-model-runtime.test.ts \
  apps/agent-runtime/src/pi-session.ts \
  apps/agent-runtime/src/pi-session.test.ts
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "refactor: isolate report pi sessions"
```

---

### Task 4: 实现受约束 Headless Subagent Worker

**Files:**

- Create: `apps/agent-runtime/src/subagent-session.ts`
- Create: `apps/agent-runtime/src/subagent-session.test.ts`
- Create: `apps/agent-runtime/src/subagent-worker.ts`
- Create: `apps/agent-runtime/src/subagent-worker.test.ts`
- Create: `tsconfig.agent-build.json`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: 写只允许 emit 工具的 RED 测试**

```ts
test('subagent session exposes only emit_subagent_analysis', () => {
  const config = buildSubagentSessionConfig();
  assert.deepEqual(config.tools, ['emit_subagent_analysis']);
  assert.equal(config.noExtensions, true);
  assert.equal(config.noSkills, true);
});
```

再写 worker 协议测试：一个 stdin JSON、一个 stdout JSON、stderr 不进入 payload、
invalid input 返回 failed payload 且 exit code 为 0。

- [ ] **Step 2: 运行测试确认 RED**

```bash
node --import tsx --test \
  apps/agent-runtime/src/subagent-session.test.ts \
  apps/agent-runtime/src/subagent-worker.test.ts
```

Expected: FAIL，新文件不存在。

- [ ] **Step 3: 实现 Subagent Pi session**

系统提示必须固定角色和枚举输出，不包含动态 task 文本：

```ts
const tool = createSubagentAnalysisTool(role, task, capture);
await session.prompt(buildSubagentPrompt(task));
```

`buildSubagentPrompt` 只序列化通过共享 validator 的 `SubagentTaskV1`。工具参数使用
共享 JSON Schema，执行后再次调用 `validateSubagentAnalysis(params, task)`。
成功 trace 必须读取真实 Pi `session.sessionId` 和
`session.getSessionStats().tokens.input/output`；不得生成 UUID 或零值占位。

- [ ] **Step 4: 实现 worker 入口和生产 build**

worker 从 stdin 最多读取 128 KiB，验证 request，创建一次 session，stdout 只写一个
JSON result。增加：

```json
{
  "scripts": {
    "agent:build": "tsc -p tsconfig.agent-build.json"
  }
}
```

`tsconfig.agent-build.json` 使用 `rootDir: "."`，include runtime、contracts 和所需
共享源码，输出到 `dist/agent-runtime`，保留 NodeNext module 语义。生产 worker 的
真实路径是：

```text
dist/agent-runtime/apps/agent-runtime/src/subagent-worker.js
```

- [ ] **Step 5: 验证源码和编译产物入口**

```bash
npm run agent:build
node --import tsx --test apps/agent-runtime/src/subagent-worker.test.ts
node dist/agent-runtime/apps/agent-runtime/src/subagent-worker.js <<<'{}'
```

Expected: 测试 PASS；生产入口可加载并对非法请求返回 exact failed 协议 JSON。连接
Provider 的生产成功 smoke 留到 Task 10。

- [ ] **Step 6: 提交 Task 4**

```bash
git add apps/agent-runtime/src/subagent-session.ts \
  apps/agent-runtime/src/subagent-session.test.ts \
  apps/agent-runtime/src/subagent-worker.ts \
  apps/agent-runtime/src/subagent-worker.test.ts \
  tsconfig.agent-build.json tsconfig.json package.json
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: add restricted subagent worker"
```

---

### Task 5: 实现 FIFO Semaphore 和安全子进程 Runner

**Files:**

- Create: `apps/agent-runtime/src/subagent-semaphore.ts`
- Create: `apps/agent-runtime/src/subagent-semaphore.test.ts`
- Create: `apps/agent-runtime/src/subagent-process.ts`
- Create: `apps/agent-runtime/src/subagent-process.test.ts`

- [ ] **Step 1: 写 semaphore RED 测试**

覆盖 FIFO、等待中 abort 移除、close/error/abort 只释放一次、两个报告共享上限：

```ts
assert.deepEqual(startOrder, ['first', 'second', 'third']);
assert.equal(semaphore.active, 0);
assert.equal(semaphore.waiting, 0);
```

- [ ] **Step 2: 写进程 runner RED 测试**

用测试 worker 覆盖：

- 环境只包含 `PI_PROVIDER`、`PI_MODEL`、`PI_API_KEY`、`PI_BASE_URL`。
- 不包含 `HOME`、`PATH`、`NODE_OPTIONS`、Tushare、数据库和内部 token。
- stdout 超过 16 KiB 立即终止。
- stderr 持续 drain，不能阻塞。
- abort 后 SIGTERM，5 秒未 close 才 SIGKILL。
- exit code 与 payload 不匹配时返回 `INVALID_PROTOCOL`。
- 可选只读 `ProcessLifecycleObserver` 只能观察 spawn/close 的 child PID、PPID、role 和
  时间；不改变协议、env、stdout 或错误映射，observer 自身异常不能影响生产执行。

- [ ] **Step 3: 运行测试确认 RED**

```bash
node --import tsx --test \
  apps/agent-runtime/src/subagent-semaphore.test.ts \
  apps/agent-runtime/src/subagent-process.test.ts
```

Expected: FAIL。

- [ ] **Step 4: 实现最小 FIFO semaphore**

接口保持小而确定：

```ts
interface Permit { release(): void }

class FifoSemaphore {
  acquire(signal: AbortSignal): Promise<Permit>;
}
```

permit 的 `release()` 必须幂等；abort listener 在 resolve 或 reject 后删除。

- [ ] **Step 5: 实现安全 runner**

开发态只传绝对 `tsx` loader argv，生产态通过 `import.meta.url` 解析相邻 `.js`。
不要转发 `process.execArgv`。使用 `process.execPath` 绝对路径和显式 env 对象。
runner 接受可选 `ProcessLifecycleObserver`，默认不配置；Task 10 的 integration composition
可用它把生命周期事件写入测试临时 JSONL，生产 composition 不传 observer。

- [ ] **Step 6: 运行测试和类型检查**

```bash
node --import tsx --test \
  apps/agent-runtime/src/subagent-semaphore.test.ts \
  apps/agent-runtime/src/subagent-process.test.ts
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 7: 提交 Task 5**

```bash
git add apps/agent-runtime/src/subagent-semaphore.ts \
  apps/agent-runtime/src/subagent-semaphore.test.ts \
  apps/agent-runtime/src/subagent-process.ts \
  apps/agent-runtime/src/subagent-process.test.ts
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: add bounded subagent process runner"
```

---

### Task 6: 实现固定三角色 Coordinator 和父报告 Generator

**Files:**

- Create: `apps/agent-runtime/src/subagent-coordinator.ts`
- Create: `apps/agent-runtime/src/subagent-coordinator.test.ts`
- Create: `apps/agent-runtime/src/report-generator.ts`
- Create: `apps/agent-runtime/src/report-generator.test.ts`
- Modify: `apps/agent-runtime/src/rpc.ts`
- Modify: `apps/agent-runtime/src/runtime-fakes.ts`

- [ ] **Step 1: 对 Python RPC client 做影响分析**

```bash
npx gitnexus impact PythonRpcClient -r investment-advisor
```

- [ ] **Step 2: 写三个角色并行和单角色重试 RED 测试**

用 barrier 保证三个任务均已提交：

```ts
assert.deepEqual(started.sort(), ['chan', 'information', 'market']);
assert.deepEqual(attempts, { market: 1, chan: 2, information: 1 });
```

覆盖任一角色两次失败时父 session 调用为零，partial analyses 和三条 trace 保留。

同时为父报告输入的数据流写 RED 测试：

- `buildFixedSubagentTasks(state)` 只能生成 market、chan、information 三个 exact task。
- `renderAnalystViews(analyses, tasks)` 要求三个角色全部存在并通过角色 task 校验。
- market/chan 只复制 schema 允许的字段和固定 refs，不携带 registry 的 URL、metadata
  或证券代码开放文本。
- information 先选 quality 最多 1 条，再选 hot 最多 2 条、IRM 最多 3 条、news 最多
  5 条，总数最多 11；各组按 `observed_at` 降序、ref 升序稳定排序。
- 投影拒绝 URL、任意 scheme、证券代码开放文本、错误 kind/namespace、超过条数和超过
  2,000 Unicode code point 的值；明确覆盖 2,000 接受、2,001 拒绝。
- 渲染后的观点只由 exhaustive enum-to-Chinese `Record`、角色、方向、置信度和 refs
  组成，不复制模型自由文本。

- [ ] **Step 3: 写 deadline 和 owner-check RED 测试**

覆盖：

- `deadline_at_ms` 是唯一截止时间。
- 每次 worker attempt 的预算严格为
  `Math.min(45_000, deadlineAtMs - Date.now() - 5_000)`。
- 上述预算小于或等于 0 时既不 acquire permit，也不 spawn；retry 也执行同一检查。
- 每 10 秒 owner-check；409 触发 abort。
- retry 重新获取 permit。
- 任意 Python RPC 挂起时，共享 deadline signal 能取消底层 fetch。

- [ ] **Step 4: 运行 RED 测试**

```bash
node --import tsx --test \
  apps/agent-runtime/src/subagent-coordinator.test.ts \
  apps/agent-runtime/src/report-generator.test.ts
```

Expected: FAIL。

- [ ] **Step 5: 增加 owner-check RPC**

为避免 Task 6 先破坏仍由旧 orchestrator 使用的接口，本任务先给所有既有
`PythonRpcPort` 方法增加尾部可选 `signal?: AbortSignal`，但
`PythonRpcClient` 收到 signal 时底层 fetch 必须原样使用。Task 7 完成所有生产调用点迁移
和测试后，再把这些 signal 改为必填。另增加唯一从一开始就必填 signal 的方法：

```ts
checkOwner(input: {
  run_id: string;
  execution_id: string;
  lease_epoch: number;
}, signal: AbortSignal): Promise<{
  valid: true;
  state_version: number;
  checked_at: string;
}>;
```

- [ ] **Step 6: 实现 coordinator**

只允许以下固定 map：

```ts
const ROLES = ['market', 'chan', 'information'] as const;
```

从 safe artifacts 和 registry 生成三个 task，先调用共享 validator，再并行提交 runner。
禁止接收 HTTP task、cwd、agentScope 或 prompt。

`report-generator.ts` 必须导出并单测两个纯函数：

```ts
export function buildFixedSubagentTasks(
  state: AdvisorRun,
): Record<SubagentRole, SubagentTaskV1>;

export function renderAnalystViews(
  analyses: Record<SubagentRole, SubagentAnalysisV1>,
  tasks: Record<SubagentRole, SubagentTaskV1>,
): AnalystViews;

export function buildParentReportState(
  state: AdvisorRun,
  tasks: Record<SubagentRole, SubagentTaskV1>,
): ParentReportState;
```

第一函数只从已经净化的 safe artifacts 和 canonical registry 白名单投影；不修改或删除
Python 最终报告水合所用的 registry。第二函数用 exhaustive `Record<enum, string>` 固定
模板渲染三个角色的 stance、confidence、observations 和 risk flags；未知枚举直接失败，
不能把分析结果当自由字符串插入父 prompt。

`ParentReportState` 是 exact 安全投影，字段固定为：

```ts
interface ParentReportState {
  run_id: string;
  report_id: string;
  as_of: string;
  timeframe: '1d' | '1w';
  reference_registry: Array<{
    ref: string;
    label: string;
    kind: ReferenceKind;
  }>;
}
```

`reference_registry` 按 ref 升序，ref 集合必须严格等于三个 task 已选 evidence refs 与
Python canonical registry 中允许父报告作为 condition 选择的全部确定性 `price_level`
候选 refs 的并集。该闭包必须在启动父 session 前完成，不能依赖尚未生成的 Report V2。
entry 只保留 ref、label、kind；禁止 URL、value、metadata。父 state 不包含 symbol、
instrument、完整 frozen artifacts、原始 registry 或 raw analyses。相关测试逐项断言字段
exact、并集无遗漏/无多余、没有非候选 ref，以及最终 Report V2 的
`fact_ref/evidence_refs` 全部是该闭包的子集。

固定错误映射：invalid task 为 `SUBAGENT_INVALID_INPUT`；两次 schema 失败为
`SUBAGENT_INVALID_OUTPUT`；Provider、进程异常或非法进程协议为
`SUBAGENT_PROVIDER_ERROR`；预算耗尽为 `SUBAGENT_TIMEOUT`；owner、request 或服务
取消为 `SUBAGENT_ABORTED`。错误必须携带 retryable、三角色 trace 和 partial enum
analyses。

- [ ] **Step 7: 实现 ReportGenerator**

`generate(input, signal)` 顺序固定：owner-check、构造三个 task、coordinator、验证三份
analysis、`renderAnalystViews`、owner-check、新建父 session、父 prompt、owner-check、
返回 report/trace/analyses。错误统一抛带 partial 结果的 `ReportGenerationError`。父
session 只能接收 exact：

```ts
interface ParentReportInput {
  tool: 'emit_research_report';
  state: ParentReportState;
  analyst_views: AnalystViews;
}
```

`analyst_views` 的 market、chan、information 三项均为 required；父 prompt 测试必须证明
三项和裁剪后的 `reference_registry` 全部实际出现，且 `AdvisorRun.artifacts` 中不新增或
回写 analyses。父 run 使用
`min(60s, remaining - 5s)`；timeout、owner 失效或 signal abort 后先调用 handle
`abort()`，再调用 `dispose()`，两者合计最多等待 5 秒。成功路径也必须 dispose。

- [ ] **Step 8: 运行定向和全量 Node 测试**

```bash
node --import tsx --test \
  apps/agent-runtime/src/subagent-coordinator.test.ts \
  apps/agent-runtime/src/report-generator.test.ts
npm test
npx tsc --noEmit
```

Expected: PASS。

- [ ] **Step 9: 提交 Task 6**

```bash
git add apps/agent-runtime/src/subagent-coordinator.ts \
  apps/agent-runtime/src/subagent-coordinator.test.ts \
  apps/agent-runtime/src/report-generator.ts \
  apps/agent-runtime/src/report-generator.test.ts \
  apps/agent-runtime/src/rpc.ts \
  apps/agent-runtime/src/runtime-fakes.ts
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: coordinate fixed report subagents"
```

---

### Task 7: 接入 Orchestrator、HTTP Abort 和 Typed Response

**Files:**

- Modify: `apps/agent-runtime/src/pi-session.ts`
- Modify: `apps/agent-runtime/src/pi-session.test.ts`
- Modify: `apps/agent-runtime/src/report-generator.ts`
- Modify: `apps/agent-runtime/src/report-generator.test.ts`
- Modify: `apps/agent-runtime/src/orchestrator.ts`
- Modify: `apps/agent-runtime/src/orchestrator.test.ts`
- Modify: `apps/agent-runtime/src/rpc.ts`
- Modify: `apps/agent-runtime/src/runtime-fakes.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Modify: `apps/agent-runtime/src/server.test.ts`
- Modify: `apps/agent-runtime/src/server-entry.ts`
- Modify: `tests/integration/agent_runtime_entry.ts`

- [ ] **Step 1: 做影响分析**

```bash
npx gitnexus impact AdvisorOrchestrator -r investment-advisor
npx gitnexus impact createServer -r investment-advisor
npx gitnexus impact createConfiguredServer -r investment-advisor
npx gitnexus impact LazyPiSession -r investment-advisor
```

Expected: 这是核心运行流；如果 HIGH 或 CRITICAL，先报告后再改。

- [ ] **Step 2: 写 orchestrator RED 测试**

断言最终阶段传入：

```ts
{
  state,
  execution_id: input.execution_id,
  lease_epoch: input.lease_epoch,
  deadline_at_ms: startedAt + 180_000,
}
```

并断言 report、trace、analyses 与 emit RPC 分离，父生成失败时不调用 emit。

- [ ] **Step 3: 写 server RED 测试**

覆盖：

- 请求体只允许 execution ID、lease epoch、expected state version。
- `max_turns` 和其他额外字段返回 400。
- 请求断开触发 AbortController。
- 执行后失败响应携带 owner、trace、partial analyses。
- 五个 `SUBAGENT_*` 错误码映射为固定状态、retryable 和安全 message。
- readiness 同时校验 token、模型配置和 worker 入口。
- 首个 Python RPC 永不返回时，180 秒 deadline 取消 fetch。
- 父 session 永不返回时，先 abort 再 dispose，合计宽限不超过 5 秒。
- server close 会取消全部活动请求。
- 两个并发 HTTP 报告共享同一个进程级 semaphore。
- `received_at_ms` 在读取 body 前记录；慢速 body 使总耗时超过 180 秒时取消读取且不进入
  orchestrator。
- 单个 child attempt 超过 45 秒会被终止；剩余总预算不能被 retry 重置。

- [ ] **Step 4: 运行测试确认 RED**

```bash
node --import tsx --test \
  apps/agent-runtime/src/orchestrator.test.ts \
  apps/agent-runtime/src/server.test.ts
```

Expected: FAIL。

- [ ] **Step 5: 修改 orchestrator**

`execute` 接收唯一 deadline signal 和由 server 传入的 `deadline_at_ms`，把 signal 传给
全部 Python RPC 和最终 `ReportGeneratorPort.generate`。本任务把所有生产
`PythonRpcPort` 方法的 `signal` 从 Task 6 的可选迁移形态改为必填，并同步
`runtime-fakes.ts`、orchestrator 测试和 `tests/integration/agent_runtime_entry.ts` 的所有
调用点；编译中不得保留无 signal 的生产调用。删除公开 HTTP 对 `max_turns` 的覆盖能力；
测试辅助入口如需预算，直接构造 orchestrator options。

- [ ] **Step 6: 修改 server**

连接进入 handler 时、读取 body 之前先记录 `received_at_ms = Date.now()`，创建
AbortController 并启动唯一的 `deadline_at_ms = received_at_ms + 180_000` timer。body
读取必须检查同一个 signal 和 byte limit，超时后停止累积、drain 请求且不调用
orchestrator。随后监听 `request.aborted`，只在
`!response.writableEnded` 时响应 socket/response close。server 维护活动 controller
集合，close 时全部 abort 并清理 timer/listener。通用 body、auth 错误维持旧
envelope；执行开始后的错误使用 `AgentRunFailureV2`。同一个绝对 deadline 必须传入
orchestrator，不能在 body 读取完成后重新起算。

新增 `createConfiguredReportGenerator` 作为生产 composition root：进程级只创建一个
`FifoSemaphore`，从 `PI_SUBAGENT_MAX_CONCURRENCY` 解析正整数，默认 6；非法值令
readiness 失败。该实例注入所有报告 generator。完成接线后删除 Task 3 的
`LazyPiSession` 兼容器和 server 旧 import。

- [ ] **Step 7: 运行 Node 全量验证**

```bash
npm test
npx tsc --noEmit
npm run agent:build
```

Expected: PASS。

- [ ] **Step 8: 提交 Task 7**

```bash
git add apps/agent-runtime/src/orchestrator.ts \
  apps/agent-runtime/src/orchestrator.test.ts \
  apps/agent-runtime/src/pi-session.ts \
  apps/agent-runtime/src/pi-session.test.ts \
  apps/agent-runtime/src/report-generator.ts \
  apps/agent-runtime/src/report-generator.test.ts \
  apps/agent-runtime/src/rpc.ts \
  apps/agent-runtime/src/runtime-fakes.ts \
  apps/agent-runtime/src/server.ts \
  apps/agent-runtime/src/server.test.ts \
  apps/agent-runtime/src/server-entry.ts \
  tests/integration/agent_runtime_entry.ts
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: expose subagent report execution"
```

---

### Task 8: 持久化 Trace、Analysis 和 Execution Owner

**Files:**

- Modify: `apps/api/app/db.py`
- Modify: `apps/api/app/reporting.py`
- Modify: `apps/api/app/api.py`
- Modify: `tests/api/test_reporting.py`
- Modify: `tests/api/test_internal_rpc.py`
- Modify: `tests/api/test_api.py`
- Modify: `tests/api/test_report_job_worker.py`

- [ ] **Step 1: 做数据库和服务影响分析**

```bash
npx gitnexus impact complete_investment_report_job -r investment-advisor
npx gitnexus impact fail_investment_report_job -r investment-advisor
npx gitnexus impact retry_investment_report_job -r investment-advisor
npx gitnexus impact claim_investment_report_job -r investment-advisor
npx gitnexus impact InvestmentReportService -r investment-advisor
npx gitnexus impact create_internal_router -r investment-advisor
npx gitnexus impact _report_job_envelope -r investment-advisor
```

- [ ] **Step 2: 写 migration 和原子围栏 RED 测试**

断言：

```python
database.complete_investment_report_job(
    report_id,
    lease_epoch,
    execution_id="old-owner",
    result=result,
    subagent_trace=trace,
    subagent_analyses=analyses,
)
```

在当前 owner 已变化时抛冲突；成功时终态、trace、analyses 同时可读。fail 路径保存
partial analyses。retry、requeue、takeover 清空旧 trace/analyses。

- [ ] **Step 3: 写 owner-check 和 public envelope RED 测试**

覆盖：

- 正确 owner 返回 valid/state version。
- status、execution 或 lease 不匹配返回 409。
- 新版 queued 合成三个 pending，running 合成三个 running。
- terminal 使用真实 trace。
- 旧 frozen input 无版本时返回 `subagents:null`。
- public DTO 不包含 `subagent_analyses`、session ID、usage 或引用。
- Python 对成功和失败内部 envelope 做 exact 解析，拒绝额外字段和缺失角色。
- 五个 `SUBAGENT_*` 错误码逐个映射正确的安全中文、retryable、partial analyses 和
  三角色 trace，不允许静默补默认值。

- [ ] **Step 4: 运行 RED 测试**

```bash
uv run --offline pytest -q \
  tests/api/test_reporting.py \
  tests/api/test_internal_rpc.py \
  tests/api/test_api.py \
  tests/api/test_report_job_worker.py
```

Expected: FAIL。

- [ ] **Step 5: 实现数据库 migration 和事务方法**

给 `investment_report_jobs` 增加 nullable JSONB：

```sql
subagent_trace JSONB,
subagent_analyses JSONB
```

complete/fail 的 WHERE 必须包含：

```sql
status = 'running' AND lease_epoch = %s AND execution_id = %s
```

- [ ] **Step 6: 实现 Python client 和服务**

`AgentRuntimeError` 增加安全 `subagents`、`subagent_analyses`。Node 成功或失败后，
service 在同一数据库事务提交终态和内部数据；对外只通过 `_report_job_envelope`
转换 trace。

- [ ] **Step 7: 实现 owner-check 路由**

新增：

```text
GET /internal/v1/agent-runs/{run_id}/owner
```

使用现有内部 Bearer 和数据库 owner 校验，不返回 artifacts。

- [ ] **Step 8: 运行 Python 回归**

```bash
uv run --offline pytest -q tests/api
uv run --offline ruff check \
  apps/api/app/db.py apps/api/app/reporting.py apps/api/app/api.py \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py \
  tests/api/test_api.py tests/api/test_report_job_worker.py
```

Expected: PASS。

- [ ] **Step 9: 提交 Task 8**

```bash
git add apps/api/app/db.py apps/api/app/reporting.py apps/api/app/api.py \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py \
  tests/api/test_api.py tests/api/test_report_job_worker.py
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: persist report subagent audit"
```

---

### Task 9: 展示固定三个子 Agent 状态

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/api.test.ts`
- Modify: `apps/web/src/OutlookPanel.tsx`
- Modify: `apps/web/src/OutlookPanel.test.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 做前端影响分析**

```bash
npx gitnexus impact toInvestmentReportJob -r investment-advisor
npx gitnexus impact OutlookPanel -r investment-advisor
```

- [ ] **Step 2: 写 adapter RED 测试**

覆盖 exact fixed object：

```ts
expect(toInvestmentReportJob(raw).subagents).toEqual({
  market: { status: 'running', attemptCount: 0, error: null },
  chan: { status: 'running', attemptCount: 0, error: null },
  information: { status: 'running', attemptCount: 0, error: null },
});
```

拒绝动态角色、额外字段、非法 attempt、terminal 状态缺角色；允许历史
`subagents:null`。

- [ ] **Step 3: 写面板 RED 测试**

断言：

- running 显示行情分析、缠论分析、资讯分析三个固定标签。
- failed 只显示安全摘要和原有重试按钮。
- completed 不显示 refs、analysis、prompt、session 或 usage。
- `subagents:null` 不渲染角色区域。

- [ ] **Step 4: 运行测试确认 RED**

```bash
npm --prefix apps/web test -- --run \
  src/api.test.ts src/OutlookPanel.test.tsx src/App.test.tsx
```

Expected: FAIL。

- [ ] **Step 5: 实现类型、adapter 和 UI**

固定类型：

```ts
export interface InvestmentReportSubagents {
  market: PublicSubagentState;
  chan: PublicSubagentState;
  information: PublicSubagentState;
}
```

保持现有轮询、selection token 和缓存 key。只增加状态展示，不修改报告生成按钮和
Review V2 内容。

- [ ] **Step 6: 运行 Web 全量验证**

```bash
npm --prefix apps/web test -- --run
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Expected: PASS；build 只允许既有 chunk size warning。

- [ ] **Step 7: 提交 Task 9**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/api.test.ts \
  apps/web/src/OutlookPanel.tsx apps/web/src/OutlookPanel.test.tsx \
  apps/web/src/App.test.tsx apps/web/src/styles.css
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "feat: show fixed report subagent status"
```

---

### Task 10: 完成真实 SSE 集成、生产入口和 README

**Files:**

- Create: `tests/integration/subagent_provider_entry.ts`
- Create: `tests/integration/test_subagent_report_flow.py`
- Modify: `tests/integration/agent_runtime_entry.ts`
- Modify: `README.md`

- [ ] **Step 1: 写真实进程集成 RED 测试**

测试必须启动：

1. PostgreSQL 测试数据库。
2. 真实 Uvicorn。
3. 本地 deterministic OpenAI-compatible SSE Provider。
4. 真实 Node sidecar。
5. 三个真实 worker 子进程。
6. 一个真实父 Pi session。

不允许直接向 coordinator 注入 fake session。Provider 按 tool schema 返回三个枚举
analysis 和最终 Report V2。

- [ ] **Step 2: 运行测试确认 RED**

```bash
uv run --offline pytest -q tests/integration/test_subagent_report_flow.py
```

Expected: FAIL，Provider entry 和新运行链尚未接通。

- [ ] **Step 3: 实现 deterministic SSE Provider**

Provider 根据请求 tools 中的目标函数名返回 OpenAI-compatible streaming tool call。
它只记录角色、开始时间、结束时间、工具名和返回 tool args，用于证明：

- 无竞争时三个任务时间窗口重叠。
- 父 session 在三者完成后开始。
- 父请求体包含 market、chan、information 三个已经渲染的 `analyst_views`，且三项都
  来自对应 worker 的枚举输出。
- 父请求体包含裁剪后的 ref/label/kind registry，最终 Report V2 的所有引用都属于该
  registry。
- 父请求体不包含未裁剪 registry、URL、value、metadata、证券代码开放文本、raw
  analyses 或未入选资讯。

Provider 不能观察客户端 OS PID。`tests/integration/agent_runtime_entry.ts` 只在测试
composition 中给真实 process runner 注入 Task 5 的只读 lifecycle observer，并把
spawn/close 的 child PID、PPID、role 和时间写入测试临时 JSONL。observer 不进入 worker
env、HTTP、数据库或普通日志。集成测试断言三个 PID 互不相同、PPID 都是 sidecar PID，
且测试结束后这些 PID 均不存在。

- [ ] **Step 4: 完成集成断言**

断言 Python 最终 job：

- status completed。
- Report V2 canonical validation 通过。
- 三个 public subagent 状态 completed。
- 数据库内部 trace 和 enum analyses 存在。
- SSE Provider 的请求审计证明父 prompt 实际消费三份观点，而不是只完成子进程后忽略
  输出。
- public JSON 不含 analyses、prompt、usage、session ID、Tushare token 或模型 key。
- retry 使用相同 frozen input，不重拉市场与资讯。

- [ ] **Step 5: 增加断开和生产构建测试**

先运行 `npm run agent:build`，从 `dist` 启动 sidecar 和 worker。另一个测试在三个 worker
运行时断开 HTTP，等待 kill grace 后断言 lifecycle observer 记录的 PID 均不存在；随后
立即运行第二份报告并证明三个 worker 都能重新取得 permits 并完成，以外部行为证明
semaphore 没有 active/waiting 泄漏，不直接读取 Node 进程内状态。

- [ ] **Step 6: 更新 README**

加入：

- 固定三个角色和无动态委派。
- `PI_SUBAGENT_MAX_CONCURRENCY=6`。
- 180/245/300 秒预算层级。
- 进程内全局并发，不是跨副本分布式配额。
- worker 无模型可调用的文件、shell 或业务网络工具，但不是 OS sandbox。
- build、启动和验证命令。

- [ ] **Step 7: 运行完整门禁**

```bash
uv run --offline pytest -q
uv run --offline ruff check apps/api tests/api tests/integration
npm test
npx tsc --noEmit
npm run agent:build
npm --prefix apps/web test -- --run
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-21-pi-subagents-investment-report-design.md \
  docs/superpowers/plans/2026-08-21-pi-subagents-investment-report.md
```

Expected: 全部 PASS；如全量 Ruff 只剩已知、与本功能无关的告警，单独列出并确保本次
文件 Ruff 全绿。

- [ ] **Step 8: 运行 GitNexus 变更检查**

```bash
npx gitnexus detect-changes --scope compare \
  --base-ref <Task-0-baseline-commit> \
  -r investment-advisor
```

Expected: 报告 Task 0 基线后的完整功能影响，包括报告生成、内部 RPC 和前端展示
流程；任何意外流程必须先处理。

- [ ] **Step 9: 提交 Task 10**

```bash
git add tests/integration/subagent_provider_entry.ts \
  tests/integration/test_subagent_report_flow.py \
  tests/integration/agent_runtime_entry.ts README.md
git diff --cached --name-status
git diff --cached
npx gitnexus detect-changes --scope staged -r investment-advisor
git commit -m "test: verify pi subagent report flow"
```

---

## 完成定义

- 三个固定角色同时提交；没有 semaphore 竞争时三个独立 Pi worker 并行运行。
- worker 只允许 `emit_subagent_analysis`，父 session 只允许
  `emit_research_report`。
- 子输出没有自由文本，只包含枚举、方向、置信度和已有 refs。
- 任何角色两次失败后不启动父 session，确定性数据仍可读且报告可重试。
- Node、Python、数据库和前端的 trace 契约完整，内部 analyses 不对外暴露。
- 终态写入同时校验 status、lease epoch 和 execution ID。
- abort、deadline 和 lease 失效不会遗留 worker、listener、timer 或 permit。
- 历史报告返回 `subagents:null`，新版 digest 不复用旧单 Agent 缓存。
- 开发 TypeScript 和生产 JavaScript worker 都通过测试。
- Python、Node、Web、真实集成、lint、typecheck、build、markdownlint 和 GitNexus
  检查完成。
