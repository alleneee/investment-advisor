# 交易日记与周期复盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建单账户逐笔成交日记、每日收盘检查，以及可追溯的周、月、季、年确定性复盘和受约束 Pi 总结。

**Architecture:** Python FastAPI 是账户账本、持仓 reducer、估值指标和报告快照的
唯一事实源；Node sidecar 只接收严格脱敏的统计 DTO，并仅允许
`emit_trading_review`。React 新增交易日记和复盘中心两个入口，复用现有 K 线、
成交量和缠论图表，在固化图表数据上叠加真实成交。

**Tech Stack:** Python 3.12、FastAPI、Pydantic v2、SQLite、Decimal、pytest、
Node 22、TypeScript、Pi Coding Agent、React 19、ECharts 5、Vitest。

---

## 实施说明

- 规格来源：`docs/superpowers/specs/2026-08-17-trading-journal-review-design.md`。
- 领域词汇：`CONTEXT.md`。
- 当前目录不是 Git 仓库，无法创建 worktree 或提交。每个任务仍保留条件式 commit
  步骤；执行时若 `git rev-parse --is-inside-work-tree` 失败，只记录验证结果并跳过
  commit，禁止擅自初始化仓库。
- 所有功能严格按 TDD：先运行失败测试，再写最小实现，再运行定向与回归测试。
- Python 财务事实全程使用 `Decimal` 和规范化十进制字符串，禁止 `float` 进入账本、
  快照和公共 API。
- 不修改现有投资报告的四工具状态机和 `ReportDraftV2` 契约。

## 文件结构

### Python 后端

- `apps/api/app/trading/contracts.py`：枚举、Pydantic 请求响应和稳定错误码。
- `apps/api/app/trading/reducer.py`：纯成交 reducer、移动加权成本和交易周期。
- `apps/api/app/trading/metrics.py`：资金流中性净值、回撤、理由表现和样本门槛。
- `apps/api/app/trading/store.py`：交易表、revision、幂等、快照、任务和租约事务。
- `apps/api/app/trading/service.py`：账本写入、历史重放、估值依赖和每日工作流。
- `apps/api/app/trading/reporting.py`：周期固化、报告任务、Pi 客户端和水合。
- `apps/api/app/trading/api.py`：`/api/trading` 公共 HTTP 边界。
- `apps/api/app/db.py`：只新增共享的公开事务上下文，不放交易业务方法。
- `apps/api/app/main.py`：组装并注入交易模块。

### Node sidecar

- `packages/contracts/src/trading-review.ts`：模型输入、输出、JSON Schema 和校验器。
- `packages/contracts/src/index.ts`：只重导出交易复盘契约。
- `apps/agent-runtime/src/trading-review-session.ts`：仅 emit 工具的 Pi 会话。
- `apps/agent-runtime/src/trading-review-generator.ts`：单次生成、一次纠错和时限控制。
- `apps/agent-runtime/src/server.ts`：增加独立交易复盘执行路由。

### React 前端

- `apps/web/src/trading-types.ts`：交易账户、成交、日复盘和周期报告 DTO。
- `apps/web/src/trading-api.ts`：严格运行时适配和 HTTP 调用。
- `apps/web/src/TradeJournalPage.tsx`：每日收盘工作流。
- `apps/web/src/ReviewCenterPage.tsx`：周期复盘、版本和重试。
- `apps/web/src/TradingReviewChart.tsx`：权益、回撤和真实买卖点图表组合。
- `apps/web/src/trading-review-chart-option.ts`：纯 ECharts option 构造。
- `apps/web/src/App.tsx`：只增加两个路由入口和页面装配。
- `apps/web/src/styles.css`：沿用深色研究终端并补窄屏布局。

## Task 1：纯成交 reducer 与交易周期

**Files:**

- Create: `apps/api/app/trading/__init__.py`
- Create: `apps/api/app/trading/contracts.py`
- Create: `apps/api/app/trading/reducer.py`
- Test: `tests/api/test_trading_reducer.py`

- [ ] **Step 1: 写失败测试覆盖移动加权成本和完整周期**

```python
def test_split_buys_and_sells_close_one_cycle() -> None:
    result = replay_ledger(
        initial_cash=Decimal("100000"),
        events=fixed_execution_fixture(),
    )
    assert result.cash == Decimal("101980")
    assert result.positions == {}
    assert result.realized_by_execution == [Decimal("1990"), Decimal("-10")]
    assert result.cycles[0].net_pnl == Decimal("1980")
    assert result.cycles[0].cycle_return_rate == Decimal("1980") / Decimal("22010")
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `uv run --offline pytest -q tests/api/test_trading_reducer.py`

Expected: collection 失败，提示 `app.trading.reducer` 不存在。

- [ ] **Step 3: 实现最小纯 reducer**

```python
@dataclass(frozen=True)
class LedgerEvent:
    event_id: str
    occurred_at: datetime
    created_at: datetime
    kind: Literal["deposit", "withdrawal", "buy", "sell"]
    symbol: str | None
    amount: Decimal
    quantity: int
    fee: Decimal
    primary_reason: str | None


def cycle_return_rate(cycle: ClosedCycle) -> Decimal:
    return cycle.net_pnl / (cycle.gross_buy_amount + cycle.buy_fees)


def canonical_decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text if text and text != "-0" else "0"
```

排序固定为 `occurred_at`、现金流优先级、不可变 `created_at`、`event_id`。部分卖出
按高精度剩余成本比例结转，最后清仓消费全部剩余成本。
货币输出统一用 `Decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`。

- [ ] **Step 4: 增加边界测试并运行 RED**

覆盖卖超持仓、买超现金、完整出金、同时间多笔成交、同时间现金流与成交混排、
循环小数成本、跨月部分卖出，以及 `money_text` 的 `ROUND_HALF_UP` 边界
`0.005 -> 0.01`、`1.005 -> 1.01`、`-0.005 -> -0.01`。

Run: `uv run --offline pytest -q tests/api/test_trading_reducer.py -k edge`

Expected: FAIL，至少一个边界尚未实现。

- [ ] **Step 5: 实现事务前校验结果**

reducer 抛稳定领域异常，但不接触数据库。

- [ ] **Step 6: 运行定向测试和 lint**

Run: `uv run --offline pytest -q tests/api/test_trading_reducer.py`

Expected: PASS。

Run: `uv run --offline ruff check apps/api/app/trading tests/api/test_trading_reducer.py`

Expected: `All checks passed!`

- [ ] **Step 7: 条件式 commit**

```bash
git add apps/api/app/trading/__init__.py apps/api/app/trading/contracts.py
git add apps/api/app/trading/reducer.py tests/api/test_trading_reducer.py
git commit -m "feat: add deterministic trading ledger reducer"
```

若当前仍非 Git 仓库，跳过且记录 Task 1 验证命令。

## Task 2：SQLite 账本、revision 与幂等

**Files:**

- Create: `apps/api/app/trading/store.py`
- Modify: `apps/api/app/db.py`
- Test: `tests/api/test_trading_store.py`

- [ ] **Step 1: 写失败测试覆盖跨连接并发和 revision fence**

```python
def test_same_key_with_different_digest_conflicts(tmp_path: Path) -> None:
    store = trading_store(tmp_path)
    store.create_execution(request("key-1", price="10.00"))
    with pytest.raises(IdempotencyConflict):
        store.create_execution(request("key-1", price="10.01"))


def test_equivalent_decimal_text_replays_same_request(tmp_path: Path) -> None:
    store = trading_store(tmp_path)
    first = store.create_execution(request("key-2", price="10.0"))
    replay = store.create_execution(request("key-2", price="10.00"))
    assert replay == first
    assert store.ledger_revision == first.ledger_revision


def test_two_connections_create_only_one_account(tmp_path: Path) -> None:
    first, second = two_stores(tmp_path)
    assert exactly_one_succeeds_concurrently(first.create_account, second.create_account)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `uv run --offline pytest -q tests/api/test_trading_store.py`

Expected: FAIL，缺少 `TradingStore` 和 schema。

- [ ] **Step 3: 给 Database 增加公开事务上下文**

```python
@contextmanager
def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
    with self._lock:
        self.conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield self.conn
            self.conn.commit()
        except BaseException:
            self.conn.rollback()
            raise
```

不改写现有方法，只供新交易模块使用。

- [ ] **Step 4: 创建交易 schema 和 CAS 方法**

至少创建：`trading_account`、`cash_flows`、`trade_executions`、`daily_reviews`、
`trading_market_prices`、`trading_review_jobs`、`trading_review_snapshots`、
`trading_meta`。金额保存 TEXT，删除使用 tombstone；`ledger_revision`、
`daily_review_revision`、`market_revision` 单调递增。

- [ ] **Step 5: 先补四类历史 mutation RED 测试并运行**

Run: `uv run --offline pytest -q tests/api/test_trading_store.py -k 'late or outdated'`

Expected: FAIL，迟到新增成交、迟到新增现金流、PATCH 或 DELETE 至少一类未使后续快照
过期。

- [ ] **Step 6: 实现幂等摘要与历史失效**

同键同摘要返回原行；同键不同摘要返回 `IDEMPOTENCY_CONFLICT`。迟到新增、PATCH、
DELETE 任一成交或现金流 mutation 都计算 `affected_from`，在同一
`BEGIN IMMEDIATE` 中重放，并把 `period_end >= affected_from` 的旧 revision 快照
标为过期。

请求摘要、价格持久化和非货币响应都先使用
`canonical_decimal_text(Decimal(value))`；货币响应另用固定两位 `money_text`。
`10.0` 与 `10.00` 必须命中同一幂等摘要。完成后重跑 Step 5 至 PASS。

- [ ] **Step 7: 运行并发测试和全后端回归**

Run: `uv run --offline pytest -q tests/api/test_trading_store.py`

Expected: PASS，包括两个独立 `Database(path)` 连接只有一个 winner。

Run: `uv run --offline pytest -q tests/api`

Expected: 现有测试和新增测试全部 PASS。

- [ ] **Step 8: 条件式 commit**

```bash
git add apps/api/app/db.py apps/api/app/trading/store.py tests/api/test_trading_store.py
git commit -m "feat: persist revisioned trading ledger"
```

## Task 3：账户、现金流、成交和每日复盘 API

**Files:**

- Create: `apps/api/app/trading/service.py`
- Create: `apps/api/app/trading/api.py`
- Modify: `apps/api/app/main.py`
- Test: `tests/api/test_trading_api.py`

- [ ] **Step 1: 写账户和成交 HTTP RED 测试**

覆盖单账户、十进制字符串、买卖理由 side 兼容、同键幂等、负现金、负持仓、范围查询、
PATCH revision 和 DELETE `If-Match`。显式提交 JSON number、科学计数法和非有限文本，
断言 `/api/trading` 返回 `400 INVALID_REQUEST`；同时断言旧 `/api/market` 的 Pydantic
错误响应保持现状。用 `+08:00` 与其他 offset 表示同一 instant，断言规范化到
`ZoneInfo("Asia/Shanghai")` 后排序键和 `trade_date` 相同。

Run: `uv run --offline pytest -q tests/api/test_trading_api.py -k 'account or execution'`

Expected: 404，路由不存在。

再写现金流 RED：POST 同摘要幂等、范围 GET、PATCH、DELETE、超额出金、完整出金与
周末入金。

Run: `uv run --offline pytest -q tests/api/test_trading_api.py -k cash_flow`

Expected: 404，现金流路由不存在。

- [ ] **Step 2: 实现 Pydantic exact DTO 和错误映射**

```python
DECIMAL_TEXT = re.compile(r"^(?:0|[1-9]\d*)(?:\.\d+)?$")


class CreateExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbol: str
    name: str
    executed_at: AwareDatetime
    side: Literal["buy", "sell"]
    price: str
    quantity: PositiveInt
    fee: str
    primary_reason: str
    tags: list[str] = Field(max_length=10)
    note: str = Field(max_length=1000)
    client_idempotency_key: UUID

    @field_validator("price", "fee", mode="before")
    @classmethod
    def require_decimal_text(cls, value: object) -> str:
        if not isinstance(value, str) or DECIMAL_TEXT.fullmatch(value) is None:
            raise ValueError("must be canonical decimal text")
        return value
```

服务层只在校验后执行 `Decimal(payload.price)`。为 `/api/trading` 配置独立
`APIRoute`，捕获 `RequestValidationError` 并映射固定 400 envelope；不得在 FastAPI app
上注册会改变旧路由的全局 validation handler。相同字符串先验校验器应用于
`initial_capital`、现金流 `amount`、成交 `price` 和 `fee`。所有领域异常使用相同安全
envelope。所有 aware datetime 在进入 reducer 前执行
`value.astimezone(ZoneInfo("Asia/Shanghai"))`，数据库只保存规范化时区值。

- [ ] **Step 3: 实现账户、现金流和成交路由**

范围成交查询支持 `date` 或成对 `start/end`，可选 `symbol`。PATCH 使用完整替换和
revision；DELETE 使用 `If-Match`。本任务账户响应只交付账本现金、revision 和基础
身份；持仓市值、总权益、估值日期、当日盈亏和回撤在 Task 4 接入行情后验收。
`create_app` 必须实例化 `TradingStore`、初始化 schema、构造 `TradingService` 并挂载
交易 router；测试只通过 `create_app(database=...)` 访问路由，不能手工挂载 router。

- [ ] **Step 4: 写并运行每日复盘 RED 测试**

覆盖 PUT 后 GET 恢复草稿、GET 不存在返回 404、完成状态纪律必填、刷新后 revision
可继续 PATCH，以及旧 revision 冲突。

Run: `uv run --offline pytest -q tests/api/test_trading_api.py -k daily_review`

Expected: FAIL，GET 路由不存在或完成状态仍接受 null。

- [ ] **Step 5: 实现每日复盘判别规则和 GET 路由**

`draft` 允许 `discipline_followed=null`；`completed` 必须是布尔值。重新打开或修改时
提升 `daily_review_revision` 并只使包含该日期的快照过期。

- [ ] **Step 6: 验证 API 与现有接口隔离**

Run: `uv run --offline pytest -q tests/api/test_trading_api.py tests/api/test_api.py`

Expected: PASS，现有 `/api/market`、watchlist 和投资报告响应不变。

- [ ] **Step 7: 条件式 commit**

```bash
git add apps/api/app/trading/contracts.py apps/api/app/trading/service.py
git add apps/api/app/trading/api.py apps/api/app/main.py tests/api/test_trading_api.py
git commit -m "feat: add daily trading journal api"
```

## Task 4：估值、资金流中性净值与复盘指标

**Files:**

- Create: `apps/api/app/trading/metrics.py`
- Modify: `apps/api/app/trading/service.py`
- Modify: `apps/api/app/main.py`
- Test: `tests/api/test_trading_metrics.py`
- Test: `tests/api/test_trading_api.py`

- [ ] **Step 1: 写资金流净值和回撤 RED 测试**

```python
def test_full_withdrawal_preserves_nav() -> None:
    points = build_nav(
        base_equity=Decimal("100000"),
        valuations=[valuation("2026-01-05", equity="0", external_flow="-100000")],
    )
    assert points[-1].return_rate == Decimal("0")
    assert points[-1].nav == Decimal("1")
    assert period_max_drawdown(points) == Decimal("0")
```

再覆盖启用日手续费、周末入金映射、零权益异常和报告期内峰值范围。

- [ ] **Step 2: 运行测试确认 RED**

Run: `uv run --offline pytest -q tests/api/test_trading_metrics.py`

Expected: FAIL，指标函数不存在。

- [ ] **Step 3: 实现 NullableDecimalMetric 和资金流中性公式**

```python
def nullable_metric(
    value: Decimal | None,
    reason: UnavailableReason | None,
) -> dict[str, str | None]:
    if (value is None) == (reason is None):
        raise ValueError("value and reason must be exclusive")
    return {"value": decimal_text(value), "unavailable_reason": reason}
```

使用首笔活动前 synthetic base；完整出金分母和期末权益都为零时收益为零并沿用净值。

- [ ] **Step 4: 写周期和理由指标 RED 测试并运行**

覆盖报告期逐次卖出盈亏、按清仓日纳入闭合周期、跨月守恒、总体样本 6 但单理由
样本 1、`conclusion_allowed=false` 不进入排名、同日开平仓持有 1 个交易日、跨周末和
休市日持有天数、理由分组持有天数中位数，以及清仓日已完成/草稿/缺失 DailyReview
对案例 `discipline_followed` 的映射。再覆盖周、月、季、年紧邻上一完整周期、账户在
上一周期尚未启用和当前 `partial_period` 的比较结果。

Run:

```bash
uv run --offline pytest -q tests/api/test_trading_metrics.py \
  -k 'cycle or reason or comparison or holding or discipline'
```

Expected: FAIL，周期或理由指标尚未实现。

- [ ] **Step 5: 实现报告期指标、周期指标和理由分组**

分别计算逐次卖出的 `period_realized_pnl` 和按清仓日纳入的 `closed_cycle_pnl`。
总体与每个理由分组独立计算 `sample_count`、`conclusion_allowed`，小于 5 禁止排名。
持有交易日按中国交易日历首尾包含计算，同日为 1；总体和理由分组均使用中位数。
案例纪律只读取清仓日已完成 DailyReview。上一同类周期指标使用相同 revision 重新计算，
delta 为当前减前期；任一侧指标不可用时返回对应 `NullableDecimalMetric`，部分周期或无
上一周期时返回固定比较不可用原因。

- [ ] **Step 6: 写行情 revision RED 测试并运行**

Run: `uv run --offline pytest -q tests/api/test_trading_metrics.py -k market_revision`

Expected: FAIL，raw 价格依赖和 revision 尚未实现。

- [ ] **Step 7: 实现行情依赖 revision**

通过注入的 Tushare provider 拉取缺失范围并写 `trading_market_prices`。账户估值严格
使用 `daily.close` 原始未复权值，经 `Decimal(str(value))` 转换；`qfq_close` 只属于
现有投资研究图表，禁止进入账户估值。每个估值日保存
`(symbol, valuation_date, source_trade_date, close, bar_digest)`；缓存命中不请求上游，
强制刷新发现依赖摘要变化时提升 `market_revision` 并使相关快照过期。

`bar_digest` 只哈希规范化 raw `trade_date/open/high/low/close/vol`，禁止复用 provider
整行 `payload_hash`。测试仅修改 `qfq_*` 时 revision 不变，修改 raw OHLCV 时提升水位。

- [ ] **Step 8: 写 raw chart bundle RED 测试并运行**

覆盖多股票、成交交易日映射、成交量、raw bars、同一 raw bars 计算的 Chan 结构、缺
行情降级，以及 bundle digest 进入 market watermark。

Run: `uv run --offline pytest -q tests/api/test_trading_metrics.py -k chart_bundle`

Expected: FAIL，尚未生成 `chart_bundles`。

- [ ] **Step 9: 实现 raw chart bundle**

实现每只股票一个未复权 bundle。日线 marker 的横轴类目使用上海时区 `trade_date`，
tooltip 数据保留原始 `executed_at`。

- [ ] **Step 10: 在 create_app 装配估值依赖并完成账户摘要**

给 `create_app` 增加可注入的 `trading_store`、`trading_market_provider`、
`trading_calendar_provider` 和 `trading_clock`。生产默认 provider 延迟到首次交易估值
请求创建，import/create_app 不发网络。使用 fake provider 的 `create_app()` HTTP 测试
断言账户响应包含持仓市值、总权益、估值日期、`daily_pnl` 和成立以来回撤。纯入金、
部分出金、完整出金与周末映射场景精确断言 `daily_pnl == "0.00"`；无现金流且权益从
`100000.00` 变为 `101000.00` 时断言 `daily_pnl == "1000.00"`。

- [ ] **Step 11: 运行精确夹具和回归**

Run: `uv run --offline pytest -q tests/api/test_trading_metrics.py`

Expected: 固定夹具账户收益率 `0.0198`、周期收益率
`1980 / 22010`、跨月守恒和样本门槛全部 PASS。

- [ ] **Step 12: 条件式 commit**

```bash
git add apps/api/app/trading/metrics.py apps/api/app/trading/service.py
git add apps/api/app/main.py tests/api/test_trading_metrics.py tests/api/test_trading_api.py
git commit -m "feat: calculate cash-flow-neutral review metrics"
```

## Task 5：周期快照、版本历史与确定性报告 API

**Files:**

- Create: `apps/api/app/trading/reporting.py`
- Modify: `apps/api/app/trading/api.py`
- Modify: `apps/api/app/trading/store.py`
- Modify: `apps/api/app/main.py`
- Test: `tests/api/test_trading_reporting.py`

- [ ] **Step 1: 写周期资格和摘要复用 RED 测试**

覆盖春节交易周、自然月末、跨年持仓、周期中启用账户、进行中预览、相同 digest 复用、
并发单 owner 和旧版本列表。上海时间 `14:59:59` 返回 `PERIOD_NOT_CLOSED`；精确到
`15:00:00` 即进入行情水位判断，最终 raw 行情未落库返回
`MARKET_DATA_NOT_READY`；行情水位就绪后才允许正式报告。上一比较周期任一账本、
日复盘或 raw 行情 revision 变化必须使当前 digest 变化。

- [ ] **Step 2: 运行测试确认 RED**

Run: `uv run --offline pytest -q tests/api/test_trading_reporting.py`

Expected: FAIL，周期报告 service、job 或路由不存在。

- [ ] **Step 3: 实现规范化 input digest 和不可变快照**

digest 必须包含完整源 revision、实际采用价格依赖、周期边界、统计引擎版本和提示词
版本。每只股票的 raw `chart_bundles`、market/chan digest 和成交 marker 也进入摘要。
上一同类周期的边界及其账本、日复盘、行情依赖摘要也进入当前 digest。快照保存
`report_version`、`supersedes_snapshot_id` 和完整水位。

- [ ] **Step 4: 实现正交状态和任务租约**

```python
snapshot_status = Literal["pending", "running", "ready", "failed"]
data_quality = Literal["ok", "degraded", "unavailable"]
ai_status = Literal["not_requested", "pending", "running", "ready", "failed"]
```

确定性快照 ready 后立即可读。失败重试在水位不变时增加 attempt；水位变化时创建
successor。所有迟到写入按 lease 和 execution owner 拒绝。

- [ ] **Step 5: 实现预览、创建、查询、版本列表和 retry 路由**

报告查询必须回填完整 `DeterministicTradingReviewV1`，包括 `comparison`、
`comparison_unavailable_reason` 和 `chart_bundles`；年报不得由前端逐日补拉成交。

- [ ] **Step 6: 在 create_app 装配任务依赖**

给 `create_app` 增加 `trading_report_scheduler` 和报告 clock 注入；默认 scheduler 使用
现有后台线程模式。增加只调用 `create_app(database=..., trading_*=fake)` 的 HTTP 测试，
不能直接实例化 service 绕过生产装配。

- [ ] **Step 7: 运行 HTTP 状态矩阵测试**

Run: `uv run --offline pytest -q tests/api/test_trading_reporting.py`

Expected: pending/running/ready/failed、degraded、outdated 和 deterministic retry 全部
满足 exact envelope。

- [ ] **Step 8: 条件式 commit**

```bash
git add apps/api/app/trading/reporting.py apps/api/app/trading/api.py
git add apps/api/app/trading/store.py apps/api/app/main.py
git add tests/api/test_trading_reporting.py
git commit -m "feat: freeze versioned trading review reports"
```

## Task 6：共享 Trading Review TypeScript 契约

**Files:**

- Create: `packages/contracts/src/trading-review.ts`
- Create: `packages/contracts/src/trading-review.test.ts`
- Create: `tests/fixtures/trading-review/valid-model-input.json`
- Create: `tests/fixtures/trading-review/valid-draft.json`
- Create: `tests/fixtures/trading-review/invalid-cases.json`
- Create: `tests/fixtures/trading-review/numeric-bounds.json`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: 写 exact schema RED 测试**

拒绝额外字段、股票代码、任意 reason、任意 metric ref、自由 quality warning、
`conclusion_allowed=false` 分组引用和禁投顾叙述。
从 `numeric-bounds.json` 逐字段测试允许边界、越界、`NaN` 和无穷值。
比较项只允许确定性快照中可用的上一周期 delta；无比较时必须是 `null`。
fixture 必须包含理由和案例周期收益率 `-1.5` 的合法反例，证明高额手续费造成的损失
不被错误的 `minimum: -1` 拒绝。

Run: `node --import tsx --test packages/contracts/src/trading-review.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 2: 定义有限枚举和接口**

```ts
export type AccountMetricRef =
  | "account.adjusted_return_rate"
  | "account.period_max_drawdown_rate"
  | "account.win_rate"
  | "account.average_win_loss_ratio"
  | "account.profit_factor"
  | "account.median_holding_days"
  | "account.median_capital_efficiency"
  | "discipline.adherence_rate";

export type ReasonMetricRef =
  | `reason.buy.${BuyReasonCode}.sample_count`
  | `reason.buy.${BuyReasonCode}.win_rate`
  | `reason.buy.${BuyReasonCode}.average_cycle_return_rate`
  | `reason.sell.${SellReasonCode}.sample_count`
  | `reason.sell.${SellReasonCode}.win_rate`
  | `reason.sell.${SellReasonCode}.average_cycle_return_rate`;

export type ComparisonMetricRef = `comparison.${AccountMetricRef}`;

export type QualityMetricRef =
  | "quality.partial_period"
  | "quality.missing_close_price"
  | "quality.insufficient_sample";

export type TradingReviewMetricRef =
  | AccountMetricRef
  | ReasonMetricRef
  | ComparisonMetricRef
  | QualityMetricRef;

export interface TradingReviewDraftV1 {
  schema_version: "trading_review_draft.v1";
  title: "周期交易复盘";
  profit_sources: NarrativeEvidence[];
  loss_patterns: NarrativeEvidence[];
  discipline_review: NarrativeEvidence;
  limitations: string[];
  next_period_experiment: ReviewExperiment;
}
```

运行时 JSON Schema 必须展开所有 template union 为有限 enum，不能只依赖 TS 类型。
Node 和 Python 测试遍历所有展开后的 ref，而不是只验证单个 golden 样例。

- [ ] **Step 3: 实现双向校验器**

`validateTradingReviewModelInput` 校验无隐私开放字符串；
`validateTradingReviewDraft` 校验 refs 属于 registry、样本门槛和禁买卖指令语义。
Node 测试必须读取共享 golden fixtures；这些文件将在 Task 8 被 Python 校验器读取，
防止两端各自通过但契约不一致。

`numeric-bounds.json` 按规格逐字段保存：计数整数且 >=0；账户资金流调整收益率 >=-1；
回撤、胜率、纪律率在 [0,1]；盈亏比、利润因子 >=0；闭合案例和非空持有天数指标
必须 >=1，同日开平仓也不能产生 0；理由与案例周期收益率、资本效率和 comparison
delta 只要求 finite。Node JSON Schema 的 minimum/maximum 必须与该表逐项一致。

- [ ] **Step 4: 运行 Node 契约回归**

Run: `npm test`

Expected: 现有投资报告测试和新增交易复盘测试全部 PASS。

Run: `npx tsc --noEmit`

Expected: exit 0。

- [ ] **Step 5: 条件式 commit**

```bash
git add packages/contracts/src/trading-review.ts
git add packages/contracts/src/trading-review.test.ts packages/contracts/src/index.ts
git add tests/fixtures/trading-review
git commit -m "feat: add strict trading review contracts"
```

## Task 7：Pi 仅 emit 会话和 sidecar 执行路由

**Files:**

- Create: `apps/agent-runtime/src/trading-review-session.ts`
- Create: `apps/agent-runtime/src/trading-review-session.test.ts`
- Create: `apps/agent-runtime/src/trading-review-generator.ts`
- Create: `apps/agent-runtime/src/trading-review-generator.test.ts`
- Modify: `apps/agent-runtime/src/server.ts`
- Modify: `apps/agent-runtime/src/server.test.ts`

- [ ] **Step 1: 写工具白名单和 prompt 隐私 RED 测试**

捕获最终模型请求，断言只存在 `emit_trading_review`，没有 read/bash/write/edit、URL、
股票代码、价格、数量、余额、原始备注或稳定源行 ID。另用 barrier 同时生成两个不同
报告，断言 draft、usage 和 session ID 不串线。

- [ ] **Step 2: 运行会话测试确认 RED**

Run: `node --import tsx --test apps/agent-runtime/src/trading-review-session.test.ts`

Expected: FAIL，交易复盘 session 不存在。

- [ ] **Step 3: 实现交易复盘 Pi session**

复用现有 provider/model/new-api 配置和 GLM-5.2 thinking 兼容，但使用独立固定系统
提示、独立输出工具和关闭本地资源发现。每个报告创建独立 session 和 draft 闭包，
finally dispose；禁止共享 `latestDraft`。工具成功返回 `terminate:true`。

- [ ] **Step 4: 写 generator 预算 RED 测试并运行**

Run: `node --import tsx --test apps/agent-runtime/src/trading-review-generator.test.ts`

Expected: FAIL，生成器、超时和无 fallback 行为不存在。

- [ ] **Step 5: 实现单次生成器**

生成器先校验 `TradingReviewModelInputV1`，最多一次结构纠错，60 秒单次时限、125 秒
总时限。没有合法 emit 结果时返回 `INVALID_MODEL_OUTPUT`，禁止 fallback 假报告。

- [ ] **Step 6: 写 server 路由 RED 测试并运行**

Run:

```bash
node --import tsx --test \
  --test-name-pattern="trading review" \
  apps/agent-runtime/src/server.test.ts
```

Expected: FAIL，新路由返回 404。

- [ ] **Step 7: 增加独立 HTTP 路由**

`POST /internal/v1/trading-review-runs/{report_id}:execute` 使用同一 Bearer token 和
512 KiB body limit。输入包含 execution/lease、严格 model input；响应只返回合法 draft
和安全 trace。现有 agent-runs 路由不变。

- [ ] **Step 8: 运行定向和全量 Node 测试**

Run: `node --import tsx --test apps/agent-runtime/src/trading-review-*.test.ts apps/agent-runtime/src/server.test.ts`

Expected: PASS。

Run: `npm test && npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 9: 条件式 commit**

```bash
git add apps/agent-runtime/src/trading-review-session.ts
git add apps/agent-runtime/src/trading-review-session.test.ts
git add apps/agent-runtime/src/trading-review-generator.ts
git add apps/agent-runtime/src/trading-review-generator.test.ts
git add apps/agent-runtime/src/server.ts apps/agent-runtime/src/server.test.ts
git commit -m "feat: generate constrained pi trading reviews"
```

## Task 8：Python Pi 桥接、输出校验与 AI 重试

**Files:**

- Modify: `apps/api/app/trading/reporting.py`
- Modify: `apps/api/app/trading/store.py`
- Modify: `apps/api/app/trading/api.py`
- Modify: `apps/api/app/main.py`
- Test: `tests/api/test_trading_ai_reporting.py`

- [ ] **Step 1: 写模型输入最小化 RED 测试**

固定账本含股票代码、精确价格、数量和备注，捕获 Python 发给 sidecar 的 JSON，断言
只包含比率、计数、有限理由代码、临时案例标签和质量代码。读取 Task 6 的共享 golden
fixtures，断言 Python 接受 Node 接受的合法输入/草稿，并拒绝同一组负例。
Python 测试遍历 `numeric-bounds.json`，逐字段断言与 Node 相同的 minimum、maximum 和
finite 规则，禁止只覆盖单条 happy path。
另断言确定性 `comparison.metrics` 按 `AccountMetricRef` 固定顺序映射：两侧都可用时
输出有限 delta，单项不可用时输出 `null`；`partial_period` 或 `no_previous_period` 时
整个 model comparison 为 `null`，任何情况都不得伪造零值。

- [ ] **Step 2: 运行 Python 桥接测试确认 RED**

Run: `uv run --offline pytest -q tests/api/test_trading_ai_reporting.py`

Expected: FAIL，client、Python 校验器和 AI 状态逻辑不存在。

- [ ] **Step 3: 实现 `TradingReviewAgentClient`**

沿用安全错误摘要和服务间 token；HTTP 不允许覆盖 provider/model。超时、Provider、
非法模型输出映射为固定 retryable error。

- [ ] **Step 4: 实现 Python 输出复验和水合**

Python 独立验证 exact keys、metric refs、样本门槛和禁投顾语义。数值、周期、图表和
免责声明从确定性快照回填，Pi 叙述不能覆盖业务事实。
上一周期比较只从固化 deterministic snapshot 映射，不允许 sidecar 计算或覆盖 delta。

- [ ] **Step 5: 实现独立 AI 状态和 retry-ai**

`snapshot_status=ready` 后启动 Pi；失败只令 `ai_status=failed`。`retry-ai` 复用同一
snapshot 和 digest，只更新 AI attempt/lease，不创建业务新版本。

- [ ] **Step 6: 在 create_app 装配 sidecar client**

给 `create_app` 增加可注入的 `trading_agent_runtime_client`。生产默认读取现有
`AGENT_RUNTIME_URL` 与 `INTERNAL_AGENT_TOKEN`，不新增 HTTP 可覆盖 provider/model。
使用只调用 `create_app()` 的测试确认真实路由拿到该 client。

- [ ] **Step 7: 运行失败降级与 fence 测试**

Run: `uv run --offline pytest -q tests/api/test_trading_ai_reporting.py`

Expected: Pi 未配置、超时、非法 refs、旧 lease 迟到写均被安全处理，确定性报告仍可读。

- [ ] **Step 8: 条件式 commit**

```bash
git add apps/api/app/trading/reporting.py apps/api/app/trading/store.py
git add apps/api/app/trading/api.py apps/api/app/main.py
git add tests/api/test_trading_ai_reporting.py
git commit -m "feat: connect trading reviews to pi sidecar"
```

## Task 9：前端 DTO、严格适配和 API 客户端

**Files:**

- Create: `apps/web/src/trading-types.ts`
- Create: `apps/web/src/trading-api.ts`
- Create: `apps/web/src/trading-api.test.ts`
- Create: `apps/web/src/main.test.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: 写 adapter RED 测试**

覆盖十进制字符串、`NullableDecimalMetric`、正交状态、版本 lineage、`chart_bundles`、
上一同类周期的固定边界/current/previous/delta、比较不可用原因、错误 envelope、非法
ISO 日期、额外字段和 outer/inner identity。断言比较对象与不可用原因严格互斥，delta
不得由前端重算。

Run: `npm --prefix apps/web test -- --run src/trading-api.test.ts`

Expected: FAIL，交易 adapter 不存在。

- [ ] **Step 2: 定义前端领域类型**

前端保留后端十进制字符串，不在 adapter 中用 JS `number` 重算财务指标。图表边界才
显式转换价格并拒绝非有限值。

- [ ] **Step 3: 实现独立 `TradingApi`**

包含账户、现金流、成交 CRUD、每日复盘、预览、创建报告、报告历史、确定性 retry、
AI retry。不要继续扩大已达 900 行的 `api.ts`；该文件只负责导出/组装。

- [ ] **Step 4: 装配真实前端入口并先写 RED 测试**

`AppProps` 增加独立 `tradingApi`。`main.tsx` 用与 `WorkbenchApi` 相同的 base URL 创建
两者并同时传入 App；mock 模式也创建配套 TradingApi。`main.test.tsx` 捕获 render props，
断言 `#/journal` 与 `#/reviews` 获得真实 HTTP adapter。

Run: `npm --prefix apps/web test -- --run src/main.test.tsx`

Expected: FAIL，生产入口未传 `tradingApi`。完成最小装配后重跑至 PASS。

- [ ] **Step 5: 运行 adapter 与 typecheck**

Run: `npm --prefix apps/web test -- --run src/trading-api.test.ts`

Expected: PASS。

Run: `npm --prefix apps/web run typecheck`

Expected: exit 0。

- [ ] **Step 6: 条件式 commit**

```bash
git add apps/web/src/trading-types.ts apps/web/src/trading-api.ts
git add apps/web/src/trading-api.test.ts apps/web/src/main.test.tsx
git add apps/web/src/api.ts apps/web/src/main.tsx apps/web/src/App.tsx
git commit -m "feat: add trading journal web api"
```

## Task 10：交易日记每日收盘页面

**Files:**

- Create: `apps/web/src/TradeJournalPage.tsx`
- Create: `apps/web/src/TradeJournalPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写页面 RED 测试**

覆盖首次创建账户、买卖理由联动、保存成交、幂等忙碌态、修正/删除、现金流、
`completed` 纪律必填、失败后表单保留、刷新后 GET 恢复草稿与 revision、revision 冲突
和迟到响应隔离。

- [ ] **Step 2: 运行页面测试确认 RED**

Run: `npm --prefix apps/web test -- --run src/TradeJournalPage.test.tsx src/App.test.tsx`

Expected: FAIL，页面和路由不存在。

- [ ] **Step 3: 实现 `#/journal` 路由与账户摘要**

在 `WorkbenchView` 增加 `journal`，不改变现有三个入口。账户摘要显示总权益、现金、
持仓市值、当日盈亏和成立以来回撤。

- [ ] **Step 4: 实现成交表单和今日流水**

方向切换后只展示对应理由 enum；金额字段保持字符串。删除二次确认，PATCH 带 revision。

- [ ] **Step 5: 实现收盘检查**

草稿自动允许未填纪律，点击“完成今日复盘”前要求明确选择遵守或未遵守。保存与完成
使用不同按钮和状态文案。进入页面时 GET 当日日复盘，404 显示空草稿，已有记录使用
返回的 revision 继续保存。

- [ ] **Step 6: 完成窄屏样式和回归**

Run: `npm --prefix apps/web test -- --run src/TradeJournalPage.test.tsx src/App.test.tsx`

Expected: PASS。

Run: `npm --prefix apps/web run typecheck`

Expected: exit 0。

- [ ] **Step 7: 条件式 commit**

```bash
git add apps/web/src/TradeJournalPage.tsx apps/web/src/TradeJournalPage.test.tsx
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat: add daily close trading journal"
```

## Task 11：复盘中心、权益回撤和真实买卖点

**Files:**

- Create: `apps/web/src/ReviewCenterPage.tsx`
- Create: `apps/web/src/ReviewCenterPage.test.tsx`
- Create: `apps/web/src/TradingReviewChart.tsx`
- Create: `apps/web/src/TradingReviewChart.test.tsx`
- Create: `apps/web/src/trading-review-chart-option.ts`
- Create: `apps/web/src/trading-review-chart-option.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写周期和状态矩阵 RED 测试**

覆盖周/月/季/年、进行中预览、deterministic ready + AI failed、outdated、版本历史、
确定性 retry、AI retry、切周期迟到响应隔离，以及上一同类周期的边界、当前值、前值、
delta 和 `partial_period`/`no_previous_period` 空态。

- [ ] **Step 2: 运行复盘页面测试确认 RED**

Run: `npm --prefix apps/web test -- --run src/ReviewCenterPage.test.tsx`

Expected: FAIL，复盘中心不存在。

- [ ] **Step 3: 实现 `#/reviews` 和复盘主体**

确定性报告 ready 即展示，不等待 Pi。理由分组 `conclusion_allowed=false` 时只显示事实和
样本不足标签，不进入有效性排名。比较区只渲染后端固化值，不在浏览器计算 delta；
不可比较时展示对应固定原因，不显示伪造的升降值。

- [ ] **Step 4: 写纯 chart option RED 测试**

断言权益和回撤同步 tooltip；K 线保留成交量与缠论结构；真实买卖点按时间、价格、
方向叠加，tooltip 列出数量、手续费和主要理由。覆盖多股票独立 bundle、缺行情降级、
上海交易日期 category 映射和精确成交时间只出现在 tooltip。

- [ ] **Step 5: 运行 option 测试确认 RED**

Run: `npm --prefix apps/web test -- --run src/trading-review-chart-option.test.ts`

Expected: FAIL，option builder 不存在。

- [ ] **Step 6: 实现图表组合**

复用 `ChanChart` 的绘制语义和配色，但输入使用报告固化的未复权 `chart_bundles`，
不调用或修改 ChanEngine。买卖点的 category 使用 `trade_date`，纵轴使用真实价格，
tooltip 保留 `executed_at`。标记仅表示历史操作，aria 和 tooltip 不出现“建议买入/
卖出”。金额字符串在 option 边界安全转为有限数值。

- [ ] **Step 7: 运行前端全量验证**

Run: `npm --prefix apps/web test -- --run`

Expected: 全部 Vitest PASS。

Run: `npm --prefix apps/web run typecheck && npm --prefix apps/web run build`

Expected: exit 0；只允许既有 bundle size warning。

- [ ] **Step 8: 条件式 commit**

```bash
git add apps/web/src/ReviewCenterPage.tsx apps/web/src/ReviewCenterPage.test.tsx
git add apps/web/src/TradingReviewChart.tsx apps/web/src/TradingReviewChart.test.tsx
git add apps/web/src/trading-review-chart-option.ts
git add apps/web/src/trading-review-chart-option.test.ts
git add apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat: add periodic trading review center"
```

## Task 12：真实双 HTTP 闭环、README 和最终验收

**Files:**

- Create: `tests/integration/test_trading_review_flow.py`
- Create: `tests/integration/trading_review_runtime_entry.ts`
- Modify: `tsconfig.json`
- Modify: `README.md`

- [ ] **Step 1: 写端到端 RED 测试**

启动真实 Uvicorn、真实 Node HTTP server 和临时 SQLite。只 fake Tushare 上游与确定性
Pi session；必须经过正式 HTTP 客户端、Bearer、租约和持久化。
同时先把 `tests/integration/**/*.ts` 加入根 `tsconfig.json` 的 `include`，确保新 Node
集成入口受 strict TypeScript 检查。

- [ ] **Step 2: 运行集成测试确认 RED**

Run: `uv run --offline pytest -q tests/integration/test_trading_review_flow.py`

Expected: FAIL，Node entry 或交易报告闭环尚不存在。

- [ ] **Step 3: 覆盖完整用户路径**

创建账户，录入固定分批买卖，完成日复盘，生成周报，断言：

- 账户现金 `101980.00`。
- 报告期已实现盈亏 `1980.00`。
- 账户资金流调整后收益率 `0.0198`。
- 交易周期收益率等于 `1980 / 22010` 的规范化十进制结果。
- 买卖点与四条成交完全一致。
- 模型请求不含股票、价格、数量、余额和备注。
- 同 digest 返回同 report ID。
- Pi 失败时确定性报告仍为 ready。
- 两个报告并发执行时 session、draft、usage 和 report ID 不串线。
- Python 产出的 golden model input 被 Node 接受，Node draft 被 Python 接受。
- 可比较时上一周期边界和 delta 来自固化快照；首个周期返回 `no_previous_period`。

- [ ] **Step 4: 更新 README**

补充单账户初始化、每日收盘录入、理由枚举、报告周期、隐私边界、服务启动和昂利康
手工验收步骤。不得写入真实 token、模型 key 或私有 API 地址。

- [ ] **Step 5: 运行最终验证矩阵**

Run: `uv run --offline pytest -q tests/api tests/integration`

Expected: 全部 PASS。

Run: `uv run --offline ruff check apps/api tests/api tests/integration`

Expected: `All checks passed!`

Run: `npm test && npx tsc --noEmit`

Expected: PASS，且 `npx tsc --noEmit` 实际覆盖
`tests/integration/trading_review_runtime_entry.ts`。

Run:

```bash
npm --prefix apps/web test -- --run
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Expected: PASS。

Run:

```bash
npx --yes markdownlint-cli2 README.md \
  docs/superpowers/specs/2026-08-17-trading-journal-review-design.md \
  docs/superpowers/plans/2026-08-17-trading-journal-review.md \
  CONTEXT.md
```

Expected: `Summary: 0 issues`。

- [ ] **Step 6: 本地浏览器验收**

启动三服务，使用浏览器检查 `#/journal` 和 `#/reviews`。在 320×800 与桌面宽度验证：
无横向滚动、表单可提交、周/月/季/年切换、真实买卖点 tooltip、AI 失败降级和版本历史。

- [ ] **Step 7: 输出最终变更清单**

不执行宽范围 `git add apps packages tests`。若执行期间仓库已由用户初始化，只保留各
Task 的精确 commit；否则输出本计划实际文件清单和所有验证命令结果。

## 完成定义

- 所有固定财务夹具精确通过，没有二进制浮点尾差。
- 修改历史成交、现金流或行情后，受影响快照正确过期且旧版本仍可发现。
- 确定性报告不依赖 Pi 成功。
- Pi 最终请求没有股票标识、价格、数量、余额、绝对金额、备注、URL 或稳定行 ID。
- 周、月、季、年报告都能从一次固化快照展示指标、理由表现、权益回撤和真实买卖点。
- 现有行情、资讯、缠论和投资报告测试保持通过。
- README、规格、计划和领域词汇通过 markdownlint。
