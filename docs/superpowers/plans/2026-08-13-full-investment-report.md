# 完整投顾报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建包含成交量缠论图、A 股新闻与舆情、Pi 三情景走势分析的可缓存完整报告。

**Architecture:** Python 负责 Tushare 行情、ChanEngine、a-stock-data 资讯契约、
SQLite 快照和报告 job；Node 仅按 Python 固化的引用注册表生成并校验
`ReportDraftV2`；React 分别加载行情、资讯与 AI 报告并组合展示。资讯和行情独立
降级，模型不能生成价格、新闻事实或交易指令。

**Tech Stack:** Python 3.13、FastAPI、SQLite、httpx、pytest、TypeScript、
Pi SDK、Node HTTP、React 19、ECharts 5.6、Vitest。

---

## 文件结构

- `apps/web/src/chan-chart-option.ts`：纯函数生成双网格 K 线与成交量配置。
- `apps/web/src/ChanChart.tsx`：注册 ECharts bar 能力并管理图表生命周期。
- `apps/api/app/providers/a_stock_data.py`：东财新闻、巨潮互动易、同花顺热榜 HTTP 契约与解析。
- `apps/api/app/information.py`：来源缓存、single-flight、归一化、质量降级与引用快照。
- `apps/api/app/db.py`：资讯缓存和 `investment_report.v2` job 的 SQLite 权威状态。
- `apps/api/app/reporting.py`：报告输入固化、引用注册表、digest、sidecar 调用和水合。
- `packages/contracts/src/index.ts`：新增 `ReportDraftV2` 和引用/ConditionRef 校验，保留 V1。
- `apps/agent-runtime/src/orchestrator.ts`：新报告只收集 market、chan、
  information 后 emit V2。
- `apps/agent-runtime/src/pi-session.ts`：为 Pi 暴露 V2 schema，生产缺配置明确失败。
- `apps/web/src/StockInformationPanel.tsx`：新闻、互动问答、热榜独立状态组件。
- `apps/web/src/OutlookPanel.tsx`：AI 三情景、证据和重试组件。
- `apps/web/src/App.tsx`：独立缓存、迟到响应保护、股票切换和完整报告组合。

## 执行依赖与并行边界

按 `Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 →
Task 8` 串行实施。当前目录不是 Git 仓库，无法用 worktree 隔离；实现 agent 不得
并行修改共享工作区。

- Task 3 依赖 Task 2 的 Provider 契约。
- Task 5 依赖 Task 3 的资讯快照和 Task 4 的 V2 合约。
- Task 6 依赖 Task 3、4、5 的完整 HTTP 闭环。
- Task 7 依赖 Task 1、3、5，且会再次修改 `styles.css`、`api.py` 对应的前端契约。
- 只读规格审查和代码质量审查可以并发，但实现任务必须串行。

### Task 1: 成交量副图

**Files:**

- Modify: `apps/web/src/chan-chart-option.test.ts`
- Modify: `apps/web/src/chan-chart-option.ts`
- Modify: `apps/web/src/ChanChart.test.tsx`
- Modify: `apps/web/src/ChanChart.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写双网格和成交量序列失败测试**

测试按 `name` 查找 `成交量` series，断言 `type: "bar"`、`xAxisIndex: 1`、
`yAxisIndex: 1`，两组 `dataZoom.xAxisIndex` 均为 `[0, 1]`，量柱颜色由开收价决定。

- [ ] **Step 2: 运行失败测试**

Run: `npm --prefix apps/web test -- --run src/chan-chart-option.test.ts --reporter=dot`

Expected: FAIL，当前配置没有成交量 bar 和第二组坐标轴。

- [ ] **Step 3: 最小实现双网格配置**

主图绑定索引 0，量图绑定索引 1；两个横轴使用相同日期；tooltip 从
`ChanChartData.bars` 回查 OHLCV，`null` volume 显示 `—`，单位显示“手”。

- [ ] **Step 4: 写 BarChart 注册失败测试**

断言 ECharts 注册表包含 `BarChart`，DOM 图例包含“成交量”，无障碍名称包含
“缠论及成交量图”。

- [ ] **Step 5: 运行组件失败测试**

Run: `npm --prefix apps/web test -- --run src/ChanChart.test.tsx --reporter=dot`

Expected: FAIL，当前组件没有注册 `BarChart`。

- [ ] **Step 6: 最小实现组件注册和图表高度**

注册 `BarChart`，增加成交量图例与无障碍文案；只调整容纳双网格所需的高度和
响应式尺寸。

- [ ] **Step 7: 运行定向测试确认通过**

Run:

```bash
npm --prefix apps/web test -- --run \
  src/chan-chart-option.test.ts src/ChanChart.test.tsx --reporter=dot
```

Expected: PASS。

### Task 2: a-stock-data 资讯 Provider

**Files:**

- Create: `tests/api/test_a_stock_data_provider.py`
- Create: `apps/api/app/providers/a_stock_data.py`

- [ ] **Step 1: 写代码规范化和东财 JSONP 解析失败测试**

测试 `.SH/.SZ` 转六位代码、正常 `cmsArticleWebOld` 映射、缺失预期节点抛
`InformationSourceError`、HTML 摘要清理和稳定 ID。

- [ ] **Step 2: 运行失败测试**

Run: `uv run --offline pytest -q tests/api/test_a_stock_data_provider.py`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现东财新闻 Provider**

使用注入的 `httpx.Client`，统一 UA；所有东财调用经共享串行限流器，间隔至少
1 秒并允许测试注入 clock/sleeper/jitter。

- [ ] **Step 4: 写巨潮两步查询和同花顺热榜过滤失败测试**

覆盖 org_id 查询、互动问答映射、未回复条目、热榜按纯代码过滤、异常结构。

- [ ] **Step 5: 运行新增 Provider 测试确认失败**

Run: `uv run --offline pytest -q tests/api/test_a_stock_data_provider.py`

Expected: FAIL，巨潮和同花顺方法不存在或未实现。

- [ ] **Step 6: 最小实现巨潮与同花顺来源**

只实现测试要求的两步巨潮查询、热榜列表解析和个股过滤；异常结构统一抛
`InformationSourceError`。

- [ ] **Step 7: 运行 Provider 测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_a_stock_data_provider.py`

Expected: PASS，测试不访问真实网络。

### Task 3: 资讯 SQLite 缓存与公共接口

**Files:**

- Create: `tests/api/test_information.py`
- Create: `apps/api/app/information.py`
- Modify: `apps/api/app/db.py`
- Modify: `apps/api/app/api.py`
- Modify: `apps/api/app/main.py`
- Modify: `tests/api/test_api.py`
- Modify: `tests/api/test_internal_rpc.py`

- [ ] **Step 1: 写来源级缓存失败测试**

覆盖首次拉取、SQLite 重连命中、过期刷新和刷新失败返回 stale。分别断言新闻
30 分钟、互动问答 6 小时、热榜 5 分钟 TTL；同 key 并发只调用上游一次；异常
响应不写缓存；结果按时间倒序并去重；固定缓存完整 20 条后，`limit=5` 与
`limit=20` 共用同一缓存。

- [ ] **Step 2: 运行失败测试**

Run: `uv run --offline pytest -q tests/api/test_information.py`

Expected: FAIL，数据库和服务方法不存在。

- [ ] **Step 3: 实现缓存表和 `StockInformationService`**

实现 `(source, cache_key)` single-flight；热榜使用共享 `cache_key="market"`；来源
错误独立降级；生成 `snapshot_id` 和每源状态。

- [ ] **Step 4: 运行缓存测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_information.py`

Expected: PASS，且并发测试确认单次上游调用。

- [ ] **Step 5: 写公共接口失败测试**

断言 `GET /api/market/002940.SZ/information?limit=10` 的完整 DTO、非法代码 422、
部分失败仍 200、全部失败为 `unavailable`。

- [ ] **Step 6: 运行公共接口测试确认失败**

Run: `uv run --offline pytest -q tests/api/test_api.py -k information`

Expected: FAIL，路由尚不存在。

- [ ] **Step 7: 实现依赖注入和公共接口**

`create_app` 只创建一个共享 information service；资讯端点不调用行情服务。

- [ ] **Step 8: 运行公共接口测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_api.py -k information`

Expected: PASS。

- [ ] **Step 9: 写真实 information evidence 失败测试**

`collect_information_evidence` 只读取 run 固化的资讯快照，claims 使用
`news.*`、`irm.*`、`hot.*` 稳定引用；不重新请求上游。构造超过上限的长资讯，
断言最多输出 5 条新闻、3 条已回复问答、2 条热榜事实，总计不超过 10 条，每条
claim 不超过 400 个 Unicode code point；完整快照不得被截断或覆盖。

- [ ] **Step 10: 运行 evidence 测试确认失败**

Run: `uv run --offline pytest -q tests/api/test_internal_rpc.py -k information`

Expected: FAIL，内部工具仍返回占位证据。

- [ ] **Step 11: 最小实现 information evidence**

从 advisor run 已固化的 `information_snapshot` 构建 claims；禁止调用
`StockInformationService.fetch()` 或任意上游 Provider。

- [ ] **Step 12: 运行后端定向测试确认通过**

Run:

```bash
uv run --offline pytest -q \
  tests/api/test_information.py tests/api/test_api.py \
  tests/api/test_internal_rpc.py
```

Expected: PASS。

### Task 4: ReportDraftV2 合约与 Pi 状态机

**Files:**

- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/agent-runtime/src/orchestrator.test.ts`
- Modify: `apps/agent-runtime/src/orchestrator.ts`
- Modify: `apps/agent-runtime/src/rpc.ts`
- Modify: `apps/agent-runtime/src/runtime-fakes.ts`
- Modify: `apps/agent-runtime/src/pi-session.test.ts`
- Modify: `apps/agent-runtime/src/pi-session.ts`
- Modify: `apps/agent-runtime/src/server.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`

- [ ] **Step 1: 写 V2 schema 与引用注册表失败测试**

覆盖三情景各一次、顶层与场景引用存在、数字价格文本拒绝、交易语义拒绝、
`break_above + price_level` 接受、`break_above + structure` 拒绝，以及 V1 仍可读。
顶层 `evidence_refs` 与场景/风险引用并集都必须覆盖 `market.*`、`chan.*` 和至少
一个 `news.*`、`irm.*`、`hot.*`；资讯为空时必须引用 `information.quality`。

- [ ] **Step 2: 运行合约失败测试**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: FAIL，V2 类型和校验不存在。

- [ ] **Step 3: 实现 `ReportDraftV2` 和双重可复用校验函数**

保留 V1 的类型、schema 和 validator；新增 V2 schema，不改旧 JSON。

- [ ] **Step 4: 运行合约测试确认通过**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: PASS。

- [ ] **Step 5: 写精简状态机与 RPC 类型失败测试**

断言工具顺序只包含 market、chan、information、emit；known refs 来自 registry；
emit 只接受 V2；周线/as_of 从 run artifact 透传。Fake Python RPC 只实现新四步，
`emit_research_report` 参数和返回值均为 V2。

- [ ] **Step 6: 运行状态机测试确认失败**

Run: `npm test -- apps/agent-runtime/src/orchestrator.test.ts packages/contracts/src/index.test.ts`

Expected: FAIL，状态机和 RPC/fake 仍依赖四类旧 evidence 与 V1。

- [ ] **Step 7: 最小实现状态机、RPC 和 fake 变更**

移除新工作流对 fundamental/capital/theme 的强制步骤；`PythonRpcPort`、
`PythonRpcClient`、`FakePythonRpc` 和测试 session 全部使用 V2 与 registry refs。

- [ ] **Step 8: 运行状态机测试确认通过**

Run: `npm test -- apps/agent-runtime/src/orchestrator.test.ts packages/contracts/src/index.test.ts`

Expected: PASS。

- [ ] **Step 9: 写生产 Pi 未配置、认证与 typed error 失败测试**

断言未注入 session 且缺环境变量时 ready=503、执行为 `MODEL_NOT_READY`；
FakeSession 只在测试显式传入。覆盖 `INVALID_REQUEST`、`MODEL_NOT_READY`、
`PROVIDER_ERROR`、`INVALID_MODEL_OUTPUT`、`TIMEOUT`、`INTERNAL_ERROR` 的 HTTP
状态、`code` 和 `retryable`；无 Bearer 或错误 Bearer 返回 401；响应不得包含
API key、Provider 原始 body、prompt 或堆栈。

- [ ] **Step 10: 运行 sidecar 测试确认失败**

Run: `npm test -- apps/agent-runtime/src/pi-session.test.ts apps/agent-runtime/src/server.test.ts`

Expected: FAIL，当前 ready 永远 200 且错误统一为 409。

- [ ] **Step 11: 实现 sidecar readiness/error 与 V2 tool schema**

Pi 自定义工具参数使用 V2 schema；生产默认不创建 FakeSession；错误只返回安全
摘要和 typed code。

- [ ] **Step 12: 运行 sidecar 测试确认通过**

Run: `npm test -- apps/agent-runtime/src/pi-session.test.ts apps/agent-runtime/src/server.test.ts`

Expected: PASS。

### Task 5: Python 报告 job、sidecar client 与重试

**Files:**

- Create: `tests/api/test_reporting.py`
- Create: `apps/api/app/reporting.py`
- Modify: `apps/api/app/db.py`
- Modify: `apps/api/app/api.py`
- Modify: `apps/api/app/main.py`
- Modify: `tests/api/test_api.py`
- Modify: `tests/api/test_internal_rpc.py`

- [ ] **Step 1: 写 digest 与原子 job 失败测试**

相同 canonical 输入得到相同 SHA-256。对 canonical JSON 的每一个字段分别只改
一个值并断言 digest 改变：`symbol`、`timeframe`、`as_of`、
`market_snapshot_id`、`chan_analysis_id`、`information_snapshot_id`、
`chan_engine_version`、`report_schema_version`、`prompt_version`、`provider`、
`model`。并发 get-or-create 只生成一个 run/report 且只有一个调用获得后台执行权。
覆盖相同
completed digest 返回 `cached=true`，相同 queued/running digest 复用 job，普通
创建接口遇到 failed digest 时原子重新排队。

- [ ] **Step 2: 运行失败测试**

Run: `uv run --offline pytest -q tests/api/test_reporting.py`

Expected: FAIL，reporting service 与新表不存在。

- [ ] **Step 3: 实现 job 表、固化输入和引用注册表**

创建时保存 `symbol/timeframe/as_of/market/chan/information/registry`；数据库对
`input_digest` 唯一；状态为 queued/running/completed/failed。

- [ ] **Step 4: 运行 job 与 digest 测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_reporting.py -k "digest or job"`

Expected: PASS。

- [ ] **Step 5: 写 202、轮询、安全字段和 retry 失败测试**

覆盖创建返回 202、完成报告 DTO、错误 `{code,message,retryable}`、仅 retryable
失败可 `POST /api/reports/{id}/retry`、重试复用原快照并递增 lease。请求使用
Pydantic `extra="forbid"`，拒绝 provider、model、API key、token、snapshot_id、
as_of 等浏览器覆盖字段。

- [ ] **Step 6: 运行公共报告 API 测试确认失败**

Run: `uv run --offline pytest -q tests/api/test_api.py -k report`

Expected: FAIL，新创建和 retry 路由尚不存在或契约不符。

- [ ] **Step 7: 实现后台调用与公共 API**

注入 `AgentRuntimeClient` 便于测试；生产读取 `AGENT_RUNTIME_URL` 和内部 token；
HTTP 总超时固定 245 秒；后台任务在每次状态转换后落 SQLite；sidecar TIMEOUT
映射为安全的 `{code:"TIMEOUT",retryable:true}`。

- [ ] **Step 8: 运行公共报告 API 测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_api.py -k report`

Expected: PASS。

- [ ] **Step 9: 写固化输入内部 RPC 失败测试**

在 run 中固化 `timeframe="1w"`、固定 `as_of`、market snapshot 和 chan snapshot；
分别调用 `fetch_market_snapshot` 与 `run_chan_analysis`，断言返回完全来自固化输入，
market service/provider 调用数为零，不使用当前日期，也不硬编码 `1d`。同时覆盖
内部 RPC 缺 Bearer 和错误 Bearer 返回 401。

- [ ] **Step 10: 运行固化输入测试确认失败**

Run: `uv run --offline pytest -q tests/api/test_internal_rpc.py -k frozen`

Expected: FAIL，当前内部工具会按 `now()` 重新分析日线。

- [ ] **Step 11: 最小实现固化输入工具**

四个工具均只从 Python advisor state 读取已固化 artifact；任何 snapshot 缺失都以
409 拒绝，不回退到网络。

- [ ] **Step 12: 运行固化输入测试确认通过**

Run: `uv run --offline pytest -q tests/api/test_internal_rpc.py -k frozen`

Expected: PASS。

- [ ] **Step 13: 写恢复、水合、旧 lease 和 V1 兼容失败测试**

超过 300 秒 running 读为 `INTERRUPTED`；未知引用或错误 operator/fact kind 不能
落 completed；水合价格只来自 registry；旧 `lease_epoch` 的迟到 state/emit 写入
返回 409。用旧 SQLite fixture 初始化新表后，旧 `ReportDraftV1` 仍能通过公共
`GET /api/reports/{id}` 原样读取，新表初始化不得覆盖旧记录。

- [ ] **Step 14: 运行恢复与兼容测试确认失败**

Run:

```bash
uv run --offline pytest -q \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py \
  tests/api/test_api.py -k "interrupted or lease or hydrate or legacy"
```

Expected: FAIL，对应恢复或兼容路径尚未实现。

- [ ] **Step 15: 最小实现恢复、水合和 V1 兼容读取**

Python 再次执行 operator/fact kind 矩阵；报告只按 registry 水合；过期 running
原子转 failed；所有 state 写入校验当前 lease；旧 report payload 不迁移不覆盖。

- [ ] **Step 16: 运行后端定向测试确认通过**

Run:

```bash
uv run --offline pytest -q \
  tests/api/test_reporting.py tests/api/test_internal_rpc.py \
  tests/api/test_api.py
```

Expected: PASS。

### Task 6: 真实 HTTP 端到端闭环

**Files:**

- Create: `tests/integration/test_full_report_flow.py`
- Create: `tests/integration/agent_runtime_entry.ts`

- [ ] **Step 1: 写完整闭环失败测试**

测试用临时 SQLite 和注入的 fake market/information service 启动真实 FastAPI
HTTP server；另起 Node 子进程运行 `createServer`、真实 `PythonRpcClient` 和显式
deterministic test session。通过公共 HTTP 创建报告，并等待以下真实边界完成：

```text
POST FastAPI report job
  -> HTTP Node sidecar execute
  -> HTTP Python internal state/tools
  -> Node emit ReportDraftV2
  -> HTTP Python internal emit/state
  -> SQLite completed report
  -> GET FastAPI completed report
```

断言工具按四步顺序执行、周线/as_of 保持不变、最终三情景和引用已落 SQLite，
并明确断言最终顶层及场景/风险引用并集同时含 `market.*`、`chan.*` 和
`news.*`/`irm.*`/`hot.*` 资讯引用。相同 digest 第二次创建返回同一
`report_id`、`200`、`cached=true`。

- [ ] **Step 2: 运行集成测试确认失败**

Run: `uv run --offline pytest -q tests/integration/test_full_report_flow.py`

Expected: FAIL，测试入口或端到端编排尚未闭合。

- [ ] **Step 3: 只修复闭环所暴露的最小集成问题**

不得增加测试专用生产分支。Node test entry 显式注入 session；FastAPI 使用正式
public/internal routes、真实 HTTP 和临时 SQLite；凭据只通过子进程环境传递。

- [ ] **Step 4: 运行集成测试确认通过**

Run: `uv run --offline pytest -q tests/integration/test_full_report_flow.py`

Expected: PASS，子进程和端口在测试结束后全部释放。

### Task 7: 前端资讯与完整走势报告

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.test.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/StockInformationPanel.test.tsx`
- Create: `apps/web/src/StockInformationPanel.tsx`
- Create: `apps/web/src/OutlookPanel.test.tsx`
- Create: `apps/web/src/OutlookPanel.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写 API 映射失败测试**

覆盖资讯 DTO、恶意 URL 清空、无效时间拒绝、创建报告 202、报告轮询、retry。

- [ ] **Step 2: 运行失败测试**

Run: `npm --prefix apps/web test -- --run src/api.test.ts --reporter=dot`

Expected: FAIL，WorkbenchApi 缺少新方法和类型。

- [ ] **Step 3: 实现强类型 API 适配层**

新增 `getInformation`、`createInvestmentReport`、`getInvestmentReport`、
`retryInvestmentReport`，不把原始后端 dict 直接传到组件。

- [ ] **Step 4: 写两个面板失败测试**

资讯面板覆盖新闻/问答/热榜、空态、降级、外链安全；走势面板覆盖未生成、
queued/running、三情景、失败与可重试。完成态必须展示生成时间、引用证据、审阅
状态和固定免责声明。

- [ ] **Step 5: 运行面板测试确认失败**

Run:

```bash
npm --prefix apps/web test -- --run \
  src/StockInformationPanel.test.tsx src/OutlookPanel.test.tsx --reporter=dot
```

Expected: FAIL，组件尚不存在。

- [ ] **Step 6: 最小实现两个面板**

外链只允许 `http/https` 且使用 `target="_blank" rel="noreferrer"`；走势面板只
渲染后端水合 DTO，不解析模型原始文本。

- [ ] **Step 7: 运行面板测试确认通过**

Run:

```bash
npm --prefix apps/web test -- --run \
  src/StockInformationPanel.test.tsx src/OutlookPanel.test.tsx --reporter=dot
```

Expected: PASS。

- [ ] **Step 8: 写 App 独立缓存、轮询和股票切换失败测试**

覆盖初始并行加载、周期切换不抓资讯、已有股票可点击、迟到旧资讯丢弃、资讯失败
不遮断图表。断言页面初次加载绝不调用生成接口；点击后立即创建一次；使用 fake
timer 严格每两秒轮询；completed/failed 后停止；AI 缓存键包含后端返回的
`input_digest`；失败 retry 调专用接口；切股票后旧轮询不得更新新页面。

- [ ] **Step 9: 运行 App 测试确认失败**

Run: `npm --prefix apps/web test -- --run src/App.test.tsx --reporter=dot`

Expected: FAIL，App 尚无资讯、报告生成和轮询状态。

- [ ] **Step 10: 实现完整报告组合与响应式样式**

延续当前工业化/编辑台视觉：资讯作为结构报告下方独立证据区，走势情景用三列
但不使用红绿作为确定涨跌承诺；移动端变单列。

- [ ] **Step 11: 运行前端定向测试确认通过**

Run:

```bash
npm --prefix apps/web test -- --run \
  src/App.test.tsx src/api.test.ts \
  src/StockInformationPanel.test.tsx src/OutlookPanel.test.tsx --reporter=dot
```

Expected: PASS。

### Task 8: 集成、README 与真实验收

**Files:**

- Modify: `README.md`
- Test: `tests/api`
- Test: `packages/contracts/src`
- Test: `apps/agent-runtime/src`
- Test: `apps/web/src`

- [ ] **Step 1: 更新 README**

补充 a-stock-data 运行时边界、资讯来源/TTL、完整报告 API、`AGENT_RUNTIME_URL`、
成交量单位、Pi 报告 V2 与失败重试；删除“资讯仍为占位”限制。

- [ ] **Step 2: 跑所有静态检查和测试**

```bash
uv run --offline ruff check apps/api tests/api
uv run --offline pytest -q tests/api
npm test
npx tsc --noEmit
npm --prefix apps/web test -- --run --reporter=dot
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-12-full-investment-report-design.md \
  docs/superpowers/plans/2026-08-13-full-investment-report.md
```

Expected: 全部通过，控制台没有未处理 warning。

- [ ] **Step 3: 启动三服务并验证 health**

使用项目 `.env` 启动 FastAPI、Pi sidecar 和 Vite；确认 8000、8081、5173 健康。

- [ ] **Step 4: 用昂利康做真实接口验收**

确认 `002940.SZ` 的日/周成交量、新闻/问答/热榜、SQLite 二次命中和真实
`glm-5.2` 报告；若单个资讯源被限流，验证 stale/degraded 而不是伪空。

- [ ] **Step 5: 用浏览器验证完整页面**

检查 1440px、900px、520px；验证 K 线与量柱缩放对齐、新闻外链、股票切换、
三情景、失败重试、控制台和网络请求。

- [ ] **Step 6: 请求最终规格和代码质量审查**

所有 Critical/Important 问题修复并复审通过后才能报告完成。
