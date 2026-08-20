# 完整投顾报告设计

## 背景

当前页面把 Tushare 行情和 ChanEngine 结构结果展示为“结构报告”，但该区域
实际上只有 K 线、缠论结构事实和固定说明。图表数据已经包含成交量，前端尚未
绘制；资讯证据仍是占位；Pi 生成的报告也没有接入当前股票页面。

本设计把“报告”统一定义为同一股票、同一数据截止时点下的完整研究视图：
K 线与成交量、缠论结构、相关新闻与公司消息，以及 Pi Agent 基于这些固化证据
生成的后续走势情景分析。

## 目标

- 在 K 线下方增加同步缩放的成交量副图。
- 使用 `a-stock-data` 已验证的数据契约获取个股新闻、互动问答和热榜事实。
- 将资讯按来源写入本地 SQLite；有效缓存直接查库，上游失败时允许返回旧缓存。
- 在当前股票页面展示相关新闻、公司互动消息和可验证的热榜状态。
- 将同一份资讯快照复用为 Pi 的 `information` 证据，不重复请求上游。
- 让 Pi 输出短期后续走势的三情景分析，并标出依据、触发条件和失效条件。
- 保证行情、价格、时间、缠论结构和新闻事实不由模型生成。

## 非目标

- 不训练价格预测模型，不承诺未来收益或确定涨跌。
- 不输出买入、卖出、仓位、止损或目标价指令。
- 不增加分钟线、港股、基金、指数或全市场新闻流。
- 不接入需要登录态、验证码或浏览器自动化的数据源。
- 不重构现有 ChanEngine，也不增加线段、背驰和一二三买卖点。

## 方案选择

采用“确定性事实底座 + 受约束 AI 情景分析”。

1. Python 拉取并固化行情、缠论结构和资讯事实。
2. React 独立展示图表和原始资讯，资讯失败不影响图表。
3. Pi 只能引用 Python 返回的证据标识，生成上涨、基准和下跌三种情景。
4. 页面把三部分组合为一份完整报告。

未采用自由文本预测，因为模型可能伪造价格、新闻或确定性结论。未采用独立量化
预测模型，因为当前没有训练集、回测基线和模型监控，超出本次功能范围。

## 完整报告结构

完整报告按以下顺序展示：

1. 股票、截止日期、数据质量和报告生成状态。
2. K 线、成交量、确认笔、形成中笔和笔中枢。
3. 已确认结构事实摘要。
4. 相关新闻、互动问答和热榜事实。
5. Pi 生成的后续走势判断与三情景分析。
6. 证据来源、生成时间、审阅状态和固定免责声明。

“后续走势”固定指未来 5 至 20 个交易日的结构情景，不表示收益承诺。

## 成交量图表

后端契约保持不变，继续使用 `market_snapshot.bars[].volume`。Tushare
`daily.vol` 的单位为手，周线成交量为该周日线成交量之和。

ECharts 改为上下两组网格：

- 主网格展示 K 线、笔和笔中枢。
- 副网格展示成交量柱。
- 两组类目轴共享相同日期数组。
- 内部缩放和底部滑块同时控制两组横轴。
- 量柱按当日收盘价与开盘价使用涨跌色，并降低透明度。
- Tooltip 通过日期回查原始 K 线，展示开、高、低、收和成交量。
- 成交量为 `null` 时展示 `—`，不伪造为零。

## 资讯数据源

`a-stock-data` 是开发时使用的数据技能，不是生产 SDK。运行时代码只移植本次
需要的公开接口契约，并使用项目已有的 `httpx`：

- 东财个股新闻：标题、摘要、发布时间、来源和原文链接。
- 巨潮互动易：投资者问题、公司回复、回复人和时间。
- 同花顺小时热榜：当前股票的排名、热度、排名变化和概念标签。

股票代码进入 Provider 前统一转换为六位纯数字。后端不使用标题关键词计算
“利好”或“利空”；舆情只保存热度和公司回复等可验证事实。

所有东财请求使用进程级共享锁串行执行，请求之间至少间隔一秒并加入轻微抖动。
同花顺热榜是全市场结果，只拉取一份共享快照后按股票过滤。

## 资讯缓存

新增来源级 SQLite 缓存：

```sql
CREATE TABLE external_information_cache(
    cache_key TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY(cache_key, source)
);
```

缓存策略：

- 东财个股新闻：按股票缓存 30 分钟。
- 巨潮互动易：按股票缓存 6 小时。
- 同花顺小时热榜：全市场共享缓存 5 分钟。
- 每个来源固定拉取最多 20 条并缓存完整结果；接口 `limit` 只负责响应切片，
  不进入缓存键。
- 同一个 `(source, cache_key)` 使用进程内 single-flight 锁，页面与 Agent 并发读取
  只允许一个请求刷新上游。
- 未过期时只查 SQLite，不请求网络。
- 过期时尝试刷新；刷新失败且存在旧值时返回旧缓存并标记 `stale`。
- 单个来源失败时返回其他来源，整体质量标记 `degraded`。
- 全部来源失败且没有缓存时返回空列表和 `unavailable`，不影响行情接口。
- 响应缺少预期数据节点时视为来源异常，不能把风控页误判成空结果并缓存。

## 资讯接口

新增独立接口：

```http
GET /api/market/{symbol}/information?limit=20
```

核心响应：

```json
{
  "symbol": "002940.SZ",
  "snapshot_id": "information-...",
  "generated_at": "2026-08-12T09:00:00Z",
  "news": [
    {
      "id": "news-...",
      "title": "公告标题",
      "summary": "摘要",
      "published_at": "2026-08-12T08:30:00+08:00",
      "source": "来源名称",
      "url": "https://example.com/article"
    }
  ],
  "messages": [
    {
      "id": "irm-...",
      "question": "投资者问题",
      "answer": "公司回复",
      "answerer": "公司证券部",
      "published_at": "2026-08-11T16:00:00+08:00",
      "source": "cninfo"
    }
  ],
  "sentiment": {
    "hot_rank": null,
    "heat": null,
    "rank_change": null,
    "concepts": [],
    "observed_at": "2026-08-12T09:00:00+08:00"
  },
  "quality": {
    "status": "ok",
    "warnings": [],
    "sources": {
      "eastmoney_news": {
        "status": "fresh",
        "fetched_at": "2026-08-12T09:00:00+08:00"
      }
    }
  }
}
```

`quality.status` 只允许 `ok`、`degraded`、`unavailable`；每个来源状态只允许
`fresh`、`cached`、`stale`、`unavailable`。所有时间返回带时区的 ISO-8601。
新闻按发布时间倒序并按规范化 URL 或标题与时间去重；互动问答按发布时间倒序并
按问题与时间去重。稳定 `id` 由来源、股票、时间和内容摘要计算，不使用数组索引。
`limit` 取值为 1 至 20，默认 20。

资讯接口与 `/analysis` 并行请求。切换日线和周线不重新请求资讯；切换股票才读取
对应股票缓存。资讯加载失败只在资讯区域展示降级状态。

## Pi 证据与走势输出

当前报告工作流精简为四步：`fetch_market_snapshot`、`run_chan_analysis`、
`collect_information_evidence`、`emit_research_report`。本次不再强制生成
`fundamental`、`capital` 和 `theme` 三类占位证据；旧 `ReportDraftV1` 只保留
读取兼容，不进入新工作流。

run 创建时一次性固化 `symbol`、`timeframe`、`as_of`、完整行情分析结果和资讯
快照。后续四个内部工具只读取 run 中的固化输入，禁止重新使用 `now()` 拉取或把
周期硬编码为日线。因此日线报告只引用日线结构，周线报告只引用同一截止时点的
周线结构。

`collect_information_evidence` 读取 run 中已固化的资讯快照，不能重新请求上游。
送入模型的资讯证据最多 10 条：最多 5 条新闻、3 条已回复互动问答和 2 条热榜
事实；每条 `claim` 最多 400 个 Unicode code point。超长标题、摘要、问题和回复
在 Python 构造 claim 时截断，完整原文仍只保存在固化快照中，不进入模型上下文。

行情证据包含截止日期、窗口、最新收盘事实和数据质量；缠论证据包含确认笔、
形成中笔和中枢摘要。Pi 不直接访问 Tushare、新闻源、文件系统或网络工具。

Python 为本次 run 建立唯一的引用注册表。每条引用包含 `ref`、`kind`、`label`、
确定性 `value`、可选单位和发生时间：

- `market.*`：截止日期、最新收盘等行情事实。
- `chan.*`：最后确认笔、形成中笔、中枢上下沿等结构事实。
- `news.*`：新闻标题、摘要、来源和发布时间。
- `irm.*`：互动问答事实。
- `hot.*`：热榜排名、热度、排名变化和概念标签。

模型看到的是带 `ref` 的事实摘要；URL 不作为引用标识。Node 在提交时从当前 run
的 registry 构造 `knownReferences`，逐一校验所有场景和风险引用。最终报告再由
Python 按同一 registry 水合标签、数值、时间和原文链接。

`ReportDraftV2.evidence_refs` 必须至少包含一个 `market.*`、一个 `chan.*` 和一个
资讯引用。资讯引用只允许 `news.*`、`irm.*`、`hot.*`；当三个来源都没有事实时，
Python 注册一个 `information.quality` 降级事实，且 V2 必须引用它。场景与风险
引用的并集也必须覆盖相同三类，避免标题或摘要声称综合分析但正文只使用单一证据。

新增 `ReportDraftV2`，不原地修改已有 `ReportDraftV1`：

```ts
interface ReportDraftV2 {
  version: "ReportDraftV2";
  run_id: string;
  title: string;
  executive_summary: string;
  outlook: Outlook;
  risks: Array<{ narrative: string; evidence_refs: string[] }>;
  evidence_refs: string[];
}

interface Outlook {
  horizon: "5-20-trading-days";
  direction: "bullish" | "sideways" | "bearish" | "uncertain";
  confidence: "low" | "medium" | "high";
  thesis: string;
  scenarios: [
    Scenario<"bullish">,
    Scenario<"base">,
    Scenario<"bearish">
  ];
}

interface Scenario<T> {
  case: T;
  narrative: string;
  trigger: ConditionRef;
  invalidation: ConditionRef;
  evidence_refs: string[];
}

interface ConditionRef {
  operator:
    | "break_above"
    | "hold_above"
    | "break_below"
    | "hold_below"
    | "structure_confirmed"
    | "structure_invalidated";
  fact_ref: string;
}
```

三种情景必须各出现一次。`trigger.fact_ref` 和 `invalidation.fact_ref` 只能引用
registry 中的 `price_level` 或 `structure` 事实；模型不能在叙述中输出数字价格。
服务端把操作符与事实水合为“上破笔中枢上沿 12.34”一类可验证条件。所有引用
必须属于当前 run。继续禁止交易指令、目标价和收益承诺，并附加固定免责声明。

操作符和事实类型使用固定兼容矩阵，并由 Node 提交校验与 Python 落库校验各执行
一次：

- `break_above`、`hold_above`、`break_below`、`hold_below` 只能引用
  `price_level`。
- `structure_confirmed`、`structure_invalidated` 只能引用 `structure`。
- 其他组合一律作为 `INVALID_MODEL_OUTPUT` 拒绝，不能降级为自由文本。

## 报告生成与读取

页面初次加载时直接展示行情、结构和资讯，不自动消耗模型调用。用户点击
“生成走势报告”后：

1. FastAPI 同步取得或读取当前股票、周期和截止时点的行情及资讯快照。
2. FastAPI 计算 `input_digest`，原子地创建单股票 run 与 report job。
3. `POST` 立即返回 `202`，FastAPI 后台任务通过内部凭据调用同步 Pi sidecar；
   浏览器不接触内部 token。
4. 后台任务把 job 从 `queued` 更新为 `running`，成功后写入完整报告并标记
   `completed`，失败时写安全错误和 `retryable` 后标记 `failed`。
5. 页面每两秒查询 `report_id`；进入 `completed` 或 `failed` 后停止。
6. 报告固化完整行情分析、资讯快照、引用注册表、AI 草稿和水合结果。

公共接口：

```http
POST /api/market/{symbol}/reports
GET /api/reports/{report_id}
POST /api/reports/{report_id}/retry
```

生成接口请求体只允许 `timeframe`。Provider、模型、API key、新闻源参数和内部
token 都不能由浏览器覆盖。首次创建和失败后重新生成返回：

```json
{
  "report_id": "...",
  "status": "queued",
  "cached": false
}
```

相同 `input_digest` 已为 `queued` 或 `running` 时复用同一 job 并返回 `202`；已为
`completed` 时返回 `200` 和 `cached: true`；已为 `failed` 时原子增加
`attempt_count`、`lease_epoch` 并重新排队。并发请求只能有一个调用获得执行权。

普通 `POST /api/market/{symbol}/reports` 总是针对当前快照创建或复用 digest；它不
负责恢复一个旧 job。`POST /api/reports/{report_id}/retry` 只接受状态为 `failed`
且 `error.retryable=true` 的报告，复用该 job 已固化的 `symbol`、`timeframe`、
`as_of`、行情快照、资讯快照、registry 和 `input_digest`，原子增加
`attempt_count`、`lease_epoch` 后返回 `202`。请求体为空，浏览器不能提交或覆盖
任何快照标识。这样即使资讯 TTL 已过期，重试也不会换成另一份输入。

`input_digest` 是以下 canonical JSON 的 SHA-256：`symbol`、`timeframe`、
`as_of`、`market_snapshot_id`、`chan_analysis_id`、`information_snapshot_id`、
`chan_engine_version`、`report_schema_version`、`prompt_version`、`provider` 和
`model`。数据库对 `input_digest` 建唯一约束。

FastAPI 使用 `AGENT_RUNTIME_URL` 和 `INTERNAL_AGENT_TOKEN` 调用 sidecar，单次
总超时 245 秒。后台任务的 `execution_id` 每次尝试不同；run 的
`expected_state_version` 取 SQLite 当前值。重试沿用同一 run 已提交状态，并通过
递增 `lease_epoch` 拒绝旧尝试的迟到请求。

进程重启不会假装恢复后台线程。`running` 超过 300 秒仍未更新时由读取路径原子
标记为 `failed/INTERRUPTED/retryable=true`，用户再次点击后从 Python 权威状态
继续；Pi transcript 不作为恢复事实源。

`GET /api/reports/{report_id}` 在所有状态都返回同一个外壳：

```json
{
  "report_id": "...",
  "status": "queued|running|completed|failed",
  "symbol": "002940.SZ",
  "timeframe": "1d",
  "as_of": "2026-08-12",
  "input_digest": "...",
  "attempt_count": 1,
  "updated_at": "2026-08-12T09:00:00Z",
  "report": null,
  "error": null
}
```

`failed.error` 固定为 `{code,message,retryable}`。`completed.report` 固定包含：

- `schema_version: "investment_report.v2"`、标题、摘要和生成时间。
- 固化的 `market_snapshot`、`chan_analysis` 和 `information_snapshot`。
- 水合后的 `outlook`、三情景、风险和引用事实。
- 固定免责声明和审阅状态。

旧 `ReportDraftV1` 记录继续按原 DTO 读取；新工作流只写
`investment_report.v2`，不迁移或覆盖旧 JSON。

## 前端状态

- 行情报告缓存键为 `symbol:timeframe`。
- 资讯缓存键仅为 `symbol`。
- AI 报告缓存键为 `symbol:timeframe:input_digest`。
- 三类请求分别维护请求标识，迟到响应不能覆盖当前股票。
- 周期切换只刷新行情结构和对应 AI 报告，不重复抓取资讯。
- 点击自选池已有股票会切换当前报告；当前股票具有明确选中态。
- 新闻、互动消息和走势报告分别具有加载、空结果、降级和失败状态。

## 错误处理

- 行情或缠论失败：完整报告不能建立，保留现有全局错误提示。
- 单个资讯源失败：使用可用来源或旧缓存，图表继续展示。
- Pi 未配置或 Provider 失败：图表和资讯继续展示，走势区域允许重试。
- Pi 输出结构或引用非法：报告状态为失败，不展示未经校验的模型文本。
- 旧股票请求迟到：丢弃响应，不写当前页面状态。
- 外链只接受 `http` 和 `https`，并使用安全的新窗口属性。
- 生产 sidecar 未配置 Pi 时 `/health/ready` 返回 `503`，生成请求返回
  `MODEL_NOT_READY`；`FakeSession` 只能由测试显式注入，禁止生产自动降级为假报告。
- sidecar 错误统一映射为 `INVALID_REQUEST`、`MODEL_NOT_READY`、
  `PROVIDER_ERROR`、`INVALID_MODEL_OUTPUT`、`TIMEOUT` 或 `INTERNAL_ERROR`，并携带
  `retryable`；不得把所有失败都映射为 `409`。

## 测试策略

按测试优先顺序实施：

1. Provider 测试覆盖代码转换、东财 JSONP、巨潮响应、同花顺热榜过滤和异常结构。
2. 缓存测试覆盖首次拉取、TTL 命中、SQLite 重连、过期刷新、旧值降级和共享热榜。
3. API 测试覆盖正常、`degraded`、`unavailable`、非法股票和独立故障边界。
4. 内部 RPC 测试验证 `information` 证据来自固化资讯，引用满足现有正则。
5. 合约测试验证三情景唯一性、引用完整性和禁止交易语义。
6. 图表配置测试验证双网格、同步缩放、量柱颜色、单位和空成交量。
7. React 测试验证股票切换、资讯独立缓存、迟到响应、周期切换和走势报告状态。
8. 端到端测试覆盖 FastAPI 创建 job、sidecar 回调内部 RPC、SQLite 状态推进、
   同 digest 并发去重、失败落库、超时中断恢复和旧 V1 读取兼容。
9. 使用昂利康 `002940.SZ` 做真实接口与浏览器验收，检查量价对齐、新闻链接、
   互动消息、热榜状态和真实 Pi 输出。

## 验收标准

- 昂利康日线和周线图均展示与 K 线日期对齐的成交量副图。
- 切换周期时 K 线与成交量同步缩放，不残留旧序列。
- 同一缓存有效期内重复打开昂利康不重新请求对应资讯源。
- 资讯源部分失败不会清空图表或其他来源数据。
- 页面能展示昂利康相关新闻、互动消息和热榜事实；没有数据时明确显示空状态。
- Pi 报告同时引用行情/缠论和资讯证据，并展示未来 5 至 20 个交易日的上涨、
  基准、下跌三种情景。
- 模型无法提交未知引用、目标价、收益承诺或买卖指令。
- 报告保留固定免责声明，并可从 SQLite 重放。
- 后端测试、前端测试、Node 合约测试、类型检查、生产构建和浏览器验收全部通过。
