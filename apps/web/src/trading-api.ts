import { ApiError } from "./api";
import type {
  CashFlow,
  CreateCashFlowRequest,
  CreateTradingAccountRequest,
  CreateTradingExecutionRequest,
  DailyReview,
  ReviewPeriodKind,
  SaveDailyReviewRequest,
  TradingAccount,
  TradingAiStatus,
  TradingChartBundle,
  TradingDataQuality,
  TradingExecution,
  TradingReasonCode,
  TradingReviewDeterministicReport,
  TradingReviewReport,
  TradingSnapshotStatus,
} from "./trading-types";

export { ApiError } from "./api";

export interface TradingApi {
  getAccount(): Promise<TradingAccount | null>;
  createAccount(request: CreateTradingAccountRequest): Promise<TradingAccount>;
  listExecutions(tradeDate: string): Promise<TradingExecution[]>;
  createExecution(request: CreateTradingExecutionRequest): Promise<TradingExecution>;
  updateExecution(executionId: string, request: CreateTradingExecutionRequest, revision: number): Promise<TradingExecution>;
  deleteExecution(executionId: string, revision: number): Promise<void>;
  listCashFlows(tradeDate: string): Promise<CashFlow[]>;
  createCashFlow(request: CreateCashFlowRequest): Promise<CashFlow>;
  deleteCashFlow(cashFlowId: string, revision: number): Promise<void>;
  getDailyReview(tradeDate: string): Promise<DailyReview | null>;
  saveDailyReview(tradeDate: string, request: SaveDailyReviewRequest): Promise<DailyReview>;
  getReviewPreview(periodKind: ReviewPeriodKind, start: string, end: string): Promise<TradingReviewReport>;
  createReviewReport(periodKind: ReviewPeriodKind, start: string, end: string): Promise<TradingReviewReport>;
  listReviewReports(periodKind: ReviewPeriodKind, start: string, end: string): Promise<TradingReviewReport[]>;
  getReviewReport(reportId: string): Promise<TradingReviewReport>;
  retryReviewReport(reportId: string): Promise<TradingReviewReport>;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PERIODS = ["week", "month", "quarter", "year"] as const;
const SIDES = ["buy", "sell"] as const;
const DATA_QUALITIES = ["ok", "degraded", "unavailable"] as const;
const SNAPSHOT_STATUSES = ["pending", "running", "ready", "failed"] as const;
const AI_STATUSES = ["not_requested", "pending", "running", "ready", "failed"] as const;
const BUY_REASONS = ["structure_breakout", "pullback_confirmation", "trend_continuation", "reversal_expectation", "event_driven", "valuation_recovery", "oversold_rebound", "planned_add", "other"] as const;
const SELL_REASONS = ["stop_loss", "take_profit", "structure_invalidated", "target_reached", "planned_reduce", "thesis_invalidated", "capital_reallocation", "discipline_violation", "other"] as const;
const REASONS = [...BUY_REASONS, ...SELL_REASONS] as const;

export const buyReasons = BUY_REASONS;
export const sellReasons = SELL_REASONS;

export const reasonLabels: Record<TradingReasonCode, string> = {
  structure_breakout: "结构突破",
  pullback_confirmation: "回踩确认",
  trend_continuation: "趋势延续",
  reversal_expectation: "反转预期",
  event_driven: "事件驱动",
  valuation_recovery: "估值修复",
  oversold_rebound: "超跌反弹",
  planned_add: "计划加仓",
  other: "其他",
  stop_loss: "止损",
  take_profit: "止盈",
  structure_invalidated: "结构失效",
  target_reached: "目标达成",
  planned_reduce: "计划减仓",
  thesis_invalidated: "逻辑失效",
  capital_reallocation: "资金调配",
  discipline_violation: "纪律违规",
};

export function createTradingApi(baseUrl: string): TradingApi {
  const root = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      let message = `API 请求失败（${response.status}）`;
      try {
        message = backendErrorMessage(await response.json(), message);
      } catch {}
      throw new ApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    async getAccount() {
      try {
        return toAccount(await request<unknown>("/api/trading/account"));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async createAccount(payload) {
      return toAccount(await request<unknown>("/api/trading/account", {
        method: "POST",
        body: JSON.stringify({
          name: payload.name,
          activated_on: payload.activatedOn,
          initial_capital: payload.initialCapital,
        }),
      }));
    },
    async listExecutions(tradeDate) {
      const value = await request<unknown>(`/api/trading/executions?date=${encodeURIComponent(tradeDate)}`);
      return array(value, "成交列表").map((item, index) => toExecution(item, `成交 ${index + 1}`));
    },
    async createExecution(payload) {
      return toExecution(await request<unknown>("/api/trading/executions", {
        method: "POST",
        body: JSON.stringify(executionPayload(payload)),
      }), "成交");
    },
    async updateExecution(executionId, payload, revision) {
      return toExecution(await request<unknown>(`/api/trading/executions/${encodeURIComponent(executionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...executionPayload(payload), revision }),
      }), "成交");
    },
    async deleteExecution(executionId, revision) {
      await request<void>(`/api/trading/executions/${encodeURIComponent(executionId)}`, {
        method: "DELETE",
        headers: { "If-Match": String(revision) },
      });
    },
    async listCashFlows(tradeDate) {
      const value = await request<unknown>(`/api/trading/cash-flows?date=${encodeURIComponent(tradeDate)}`);
      return array(value, "资金流水").map((item, index) => toCashFlow(item, `资金流水 ${index + 1}`));
    },
    async createCashFlow(payload) {
      return toCashFlow(await request<unknown>("/api/trading/cash-flows", {
        method: "POST",
        body: JSON.stringify({
          occurred_at: payload.occurredAt,
          kind: payload.kind,
          amount: payload.amount,
          note: payload.note,
          client_idempotency_key: payload.clientIdempotencyKey,
        }),
      }), "资金流水");
    },
    async deleteCashFlow(cashFlowId, revision) {
      await request<void>(`/api/trading/cash-flows/${encodeURIComponent(cashFlowId)}`, {
        method: "DELETE",
        headers: { "If-Match": String(revision) },
      });
    },
    async getDailyReview(tradeDate) {
      try {
        return toDailyReview(await request<unknown>(`/api/trading/daily-reviews/${encodeURIComponent(tradeDate)}`));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async saveDailyReview(tradeDate, payload) {
      return toDailyReview(await request<unknown>(`/api/trading/daily-reviews/${encodeURIComponent(tradeDate)}`, {
        method: "PUT",
        body: JSON.stringify({
          revision: payload.revision,
          status: payload.status,
          invalidation_condition: payload.invalidationCondition,
          next_day_plan: payload.nextDayPlan,
          emotion: payload.emotion,
          discipline_followed: payload.disciplineFollowed,
          note: payload.note,
        }),
      }));
    },
    async getReviewPreview(periodKind, start, end) {
      return toReviewReport(await request<unknown>(`/api/trading/reviews/preview?period_kind=${periodKind}&start=${start}&end=${end}`));
    },
    async createReviewReport(periodKind, start, end) {
      return toReviewReport(await request<unknown>("/api/trading/reports", {
        method: "POST",
        body: JSON.stringify({ period_kind: periodKind, period_start: start, period_end: end }),
      }));
    },
    async listReviewReports(periodKind, start, end) {
      const value = await request<unknown>(`/api/trading/reports?period_kind=${periodKind}&period_start=${start}&period_end=${end}`);
      return array(value, "报告历史").map((item, index) => toReviewReport(item, `报告历史 ${index + 1}`));
    },
    async getReviewReport(reportId) {
      return toReviewReport(await request<unknown>(`/api/trading/reports/${encodeURIComponent(reportId)}`));
    },
    async retryReviewReport(reportId) {
      return toReviewReport(await request<unknown>(`/api/trading/reports/${encodeURIComponent(reportId)}/retry`, {
        method: "POST",
        body: "{}",
      }));
    },
  };
}

export function createMockTradingApi(): TradingApi {
  let account: TradingAccount | null = null;
  let executions: TradingExecution[] = [];
  let cashFlows: CashFlow[] = [];
  const dailyReviews = new Map<string, DailyReview>();
  const unavailable = () => Promise.reject(new ApiError("本地演示模式不生成周期复盘，请连接 API 服务。", 503));

  return {
    async getAccount() { return account; },
    async createAccount(request) {
      account = {
        accountId: "mock-account",
        name: request.name,
        activatedOn: request.activatedOn,
        initialCapital: request.initialCapital,
        ledgerRevision: 0,
        cash: request.initialCapital,
        positionMarketValue: "0",
        totalEquity: request.initialCapital,
        valuationDate: null,
        dailyPnl: null,
        sinceInceptionDrawdown: null,
        dataQuality: "unavailable",
        dataQualityWarnings: ["本地演示模式不含收盘价估值。"],
      };
      return account;
    },
    async listExecutions(tradeDate) { return executions.filter((item) => item.executedAt.startsWith(tradeDate)); },
    async createExecution(request) {
      const execution: TradingExecution = { executionId: `mock-execution-${executions.length + 1}`, revision: 1, ledgerRevision: executions.length + 1, ...request };
      executions = [...executions, execution];
      return execution;
    },
    async updateExecution(executionId, request, revision) {
      const index = executions.findIndex((item) => item.executionId === executionId);
      if (index < 0 || executions[index].revision !== revision) throw new ApiError("成交记录版本冲突", 409);
      const next = { executionId, revision: revision + 1, ledgerRevision: executions[index].ledgerRevision + 1, ...request };
      executions = executions.map((item, itemIndex) => itemIndex === index ? next : item);
      return next;
    },
    async deleteExecution(executionId, revision) {
      const target = executions.find((item) => item.executionId === executionId);
      if (!target || target.revision !== revision) throw new ApiError("成交记录版本冲突", 409);
      executions = executions.filter((item) => item.executionId !== executionId);
    },
    async listCashFlows(tradeDate) { return cashFlows.filter((item) => item.occurredAt.startsWith(tradeDate)); },
    async createCashFlow(request) {
      const cashFlow: CashFlow = { cashFlowId: `mock-cash-${cashFlows.length + 1}`, revision: 1, ledgerRevision: cashFlows.length + 1, ...request };
      cashFlows = [...cashFlows, cashFlow];
      return cashFlow;
    },
    async deleteCashFlow(cashFlowId, revision) {
      const target = cashFlows.find((item) => item.cashFlowId === cashFlowId);
      if (!target || target.revision !== revision) throw new ApiError("资金流水版本冲突", 409);
      cashFlows = cashFlows.filter((item) => item.cashFlowId !== cashFlowId);
    },
    async getDailyReview(tradeDate) { return dailyReviews.get(tradeDate) ?? null; },
    async saveDailyReview(tradeDate, request) {
      const existing = dailyReviews.get(tradeDate);
      if (existing && request.revision !== existing.revision) throw new ApiError("每日复盘版本冲突", 409);
      const next: DailyReview = {
        dailyReviewId: existing?.dailyReviewId ?? `mock-daily-${tradeDate}`,
        tradeDate,
        status: request.status,
        invalidationCondition: request.invalidationCondition,
        nextDayPlan: request.nextDayPlan,
        emotion: request.emotion,
        disciplineFollowed: request.disciplineFollowed,
        note: request.note,
        revision: (existing?.revision ?? 0) + 1,
        dailyReviewRevision: (existing?.dailyReviewRevision ?? 0) + 1,
      };
      dailyReviews.set(tradeDate, next);
      return next;
    },
    getReviewPreview: unavailable,
    createReviewReport: unavailable,
    async listReviewReports() { return []; },
    getReviewReport: unavailable,
    retryReviewReport: unavailable,
  };
}

function executionPayload(payload: CreateTradingExecutionRequest) {
  return {
    symbol: payload.symbol,
    name: payload.name,
    executed_at: payload.executedAt,
    side: payload.side,
    price: payload.price,
    quantity: payload.quantity,
    fee: payload.fee,
    primary_reason: payload.primaryReason,
    tags: payload.tags,
    note: payload.note,
    client_idempotency_key: payload.clientIdempotencyKey,
  };
}

function toAccount(payload: unknown): TradingAccount {
  const value = exactRecord(payload, ["account_id", "name", "activated_on", "initial_capital", "ledger_revision", "cash", "position_market_value", "total_equity", "valuation_date", "daily_pnl", "since_inception_drawdown", "data_quality", "data_quality_warnings"], "交易账户");
  return {
    accountId: text(value.account_id, "账户编号"),
    name: text(value.name, "账户名称"),
    activatedOn: dateText(value.activated_on, "启用日期"),
    initialCapital: decimalText(value.initial_capital, "初始资金"),
    ledgerRevision: positiveInteger(value.ledger_revision, "账本版本", true),
    cash: decimalText(value.cash, "现金"),
    positionMarketValue: nullableDecimal(value.position_market_value, "持仓市值"),
    totalEquity: nullableDecimal(value.total_equity, "总权益"),
    valuationDate: nullableDate(value.valuation_date, "估值日期"),
    dailyPnl: nullableDecimal(value.daily_pnl, "当日盈亏"),
    sinceInceptionDrawdown: nullableDecimal(value.since_inception_drawdown, "成立以来回撤"),
    dataQuality: enumText(value.data_quality, DATA_QUALITIES, "数据质量"),
    dataQualityWarnings: stringArray(value.data_quality_warnings, "数据质量警告"),
  };
}

function toExecution(payload: unknown, name: string): TradingExecution {
  const value = exactRecord(payload, ["execution_id", "symbol", "name", "executed_at", "side", "price", "quantity", "fee", "primary_reason", "tags", "note", "client_idempotency_key", "revision", "ledger_revision"], name);
  const side = enumText(value.side, SIDES, `${name}方向`);
  const reason = enumText(value.primary_reason, REASONS, `${name}理由`);
  if (side === "buy" && !BUY_REASONS.includes(reason as typeof BUY_REASONS[number])) throw adapterError(`${name}买入理由无效`);
  if (side === "sell" && !SELL_REASONS.includes(reason as typeof SELL_REASONS[number])) throw adapterError(`${name}卖出理由无效`);
  return {
    executionId: text(value.execution_id, `${name}编号`),
    symbol: text(value.symbol, `${name}股票`),
    name: text(value.name, `${name}名称`, true),
    executedAt: dateTime(value.executed_at, `${name}时间`),
    side,
    price: decimalText(value.price, `${name}价格`),
    quantity: positiveInteger(value.quantity, `${name}股数`),
    fee: decimalText(value.fee, `${name}手续费`),
    primaryReason: reason,
    tags: stringArray(value.tags, `${name}标签`),
    note: text(value.note, `${name}备注`, true),
    clientIdempotencyKey: text(value.client_idempotency_key, `${name}幂等键`),
    revision: positiveInteger(value.revision, `${name}版本`),
    ledgerRevision: positiveInteger(value.ledger_revision, `${name}账本版本`, true),
  };
}

function toCashFlow(payload: unknown, name: string): CashFlow {
  const value = exactRecord(payload, ["cash_flow_id", "occurred_at", "kind", "amount", "note", "client_idempotency_key", "revision", "ledger_revision"], name);
  return {
    cashFlowId: text(value.cash_flow_id, `${name}编号`),
    occurredAt: dateTime(value.occurred_at, `${name}时间`),
    kind: enumText(value.kind, ["deposit", "withdrawal"] as const, `${name}类型`),
    amount: decimalText(value.amount, `${name}金额`),
    note: text(value.note, `${name}备注`, true),
    clientIdempotencyKey: text(value.client_idempotency_key, `${name}幂等键`),
    revision: positiveInteger(value.revision, `${name}版本`),
    ledgerRevision: positiveInteger(value.ledger_revision, `${name}账本版本`, true),
  };
}

function toDailyReview(payload: unknown): DailyReview {
  const value = exactRecord(payload, ["daily_review_id", "trade_date", "status", "invalidation_condition", "next_day_plan", "emotion", "discipline_followed", "note", "revision", "daily_review_revision"], "每日复盘");
  const status = enumText(value.status, ["draft", "completed"] as const, "每日复盘状态");
  const disciplineFollowed = nullableBoolean(value.discipline_followed, "是否遵守纪律");
  if (status === "completed" && disciplineFollowed === null) throw adapterError("已完成复盘必须包含纪律结果");
  return {
    dailyReviewId: text(value.daily_review_id, "每日复盘编号"),
    tradeDate: dateText(value.trade_date, "复盘日期"),
    status,
    invalidationCondition: text(value.invalidation_condition, "失效条件", true),
    nextDayPlan: text(value.next_day_plan, "次日计划", true),
    emotion: enumText(value.emotion, ["calm", "confident", "anxious", "impulsive", "frustrated", "other"] as const, "情绪"),
    disciplineFollowed,
    note: text(value.note, "复盘备注", true),
    revision: positiveInteger(value.revision, "复盘版本"),
    dailyReviewRevision: positiveInteger(value.daily_review_revision, "每日复盘水位", true),
  };
}

export function toReviewReport(payload: unknown, name = "交易复盘报告"): TradingReviewReport {
  const value = exactRecord(payload, ["report_id", "snapshot_id", "report_version", "supersedes_snapshot_id", "account_id", "period_kind", "period_start", "period_end", "data_as_of", "input_digest", "ledger_revision", "daily_review_revision", "market_revision", "market_watermark", "attempt", "snapshot_status", "data_quality", "ai_status", "is_outdated", "partial_period", "retryable", "deterministic_report", "ai_review", "error"], name);
  const snapshotStatus = enumText(value.snapshot_status, SNAPSHOT_STATUSES, "复盘快照状态");
  const deterministicReport = value.deterministic_report === null ? null : toDeterministicReport(value.deterministic_report);
  const error = value.error === null ? null : toError(value.error, "复盘错误");
  if ((snapshotStatus === "ready") !== (deterministicReport !== null)) throw adapterError("复盘快照与报告内容不一致");
  if (snapshotStatus !== "failed" && error !== null) throw adapterError("未失败快照不应携带错误");
  return {
    reportId: text(value.report_id, "复盘编号"),
    snapshotId: nullableText(value.snapshot_id, "快照编号"),
    reportVersion: positiveInteger(value.report_version, "报告版本"),
    supersedesSnapshotId: nullableText(value.supersedes_snapshot_id, "前序快照编号"),
    accountId: text(value.account_id, "报告账户编号"),
    periodKind: enumText(value.period_kind, PERIODS, "报告周期"),
    periodStart: dateText(value.period_start, "报告开始日期"),
    periodEnd: dateText(value.period_end, "报告结束日期"),
    dataAsOf: nullableDateTime(value.data_as_of, "报告截止时间"),
    inputDigest: text(value.input_digest, "报告摘要"),
    ledgerRevision: positiveInteger(value.ledger_revision, "账本水位", true),
    dailyReviewRevision: positiveInteger(value.daily_review_revision, "复盘水位", true),
    marketRevision: positiveInteger(value.market_revision, "行情水位", true),
    marketWatermark: nullableText(value.market_watermark, "行情水印"),
    attempt: positiveInteger(value.attempt, "报告尝试次数"),
    snapshotStatus,
    dataQuality: enumText(value.data_quality, DATA_QUALITIES, "报告数据质量"),
    aiStatus: enumText(value.ai_status, AI_STATUSES, "AI 状态"),
    isOutdated: booleanValue(value.is_outdated, "报告过期状态"),
    partialPeriod: booleanValue(value.partial_period, "部分周期状态"),
    retryable: booleanValue(value.retryable, "报告重试状态"),
    deterministicReport,
    aiReview: null,
    error,
  };
}

function toDeterministicReport(payload: unknown): TradingReviewDeterministicReport {
  const value = exactRecord(payload, ["schema_version", "sample", "metrics", "equity_curve", "execution_reason_facts", "reason_performance", "cycle_cases", "comparison", "comparison_unavailable_reason", "chart_bundles", "quality"], "确定性复盘");
  if (value.schema_version !== "deterministic_trading_review.v1") throw adapterError("确定性复盘版本无效");
  const sample = exactRecord(value.sample, ["trading_day_count", "execution_count", "closed_cycle_count", "overall_conclusion_allowed"], "复盘样本");
  const metrics = exactRecord(value.metrics, ["period_realized_pnl", "closed_cycle_pnl", "account_adjusted_return_rate", "period_max_drawdown_rate", "win_rate", "average_win_loss_ratio", "profit_factor", "median_holding_days", "median_capital_efficiency", "discipline_adherence_rate"], "复盘指标");
  const comparison = value.comparison === null ? null : toComparison(value.comparison);
  const comparisonUnavailableReason = nullableEnum(value.comparison_unavailable_reason, ["partial_period", "no_previous_period"] as const, "比较不可用原因");
  if ((comparison === null) !== (comparisonUnavailableReason !== null)) throw adapterError("复盘比较状态不一致");
  return {
    schemaVersion: "deterministic_trading_review.v1",
    sample: {
      tradingDayCount: nonNegativeInteger(sample.trading_day_count, "交易日数量"),
      executionCount: nonNegativeInteger(sample.execution_count, "成交数量"),
      closedCycleCount: nonNegativeInteger(sample.closed_cycle_count, "闭合周期数量"),
      overallConclusionAllowed: booleanValue(sample.overall_conclusion_allowed, "总体样本状态"),
    },
    metrics: {
      periodRealizedPnl: decimalText(metrics.period_realized_pnl, "报告期已实现盈亏"),
      closedCyclePnl: decimalText(metrics.closed_cycle_pnl, "闭合周期盈亏"),
      accountAdjustedReturnRate: toNullableMetric(metrics.account_adjusted_return_rate, "资金流调整收益率"),
      periodMaxDrawdownRate: toNullableMetric(metrics.period_max_drawdown_rate, "最大回撤"),
      winRate: toNullableMetric(metrics.win_rate, "胜率"),
      averageWinLossRatio: toNullableMetric(metrics.average_win_loss_ratio, "盈亏比"),
      profitFactor: toNullableMetric(metrics.profit_factor, "利润因子"),
      medianHoldingDays: toNullableMetric(metrics.median_holding_days, "持有交易日"),
      medianCapitalEfficiency: toNullableMetric(metrics.median_capital_efficiency, "资金效率"),
      disciplineAdherenceRate: toNullableMetric(metrics.discipline_adherence_rate, "纪律执行率"),
    },
    equityCurve: array(value.equity_curve, "权益曲线").map((item, index) => toEquityPoint(item, index)),
    executionReasonFacts: array(value.execution_reason_facts, "成交理由事实").map((item, index) => toReasonFact(item, index)),
    reasonPerformance: array(value.reason_performance, "理由表现").map((item, index) => toReasonPerformance(item, index)),
    cycleCases: array(value.cycle_cases, "交易周期").map((item, index) => toCycleCase(item, index)),
    comparison,
    comparisonUnavailableReason,
    chartBundles: array(value.chart_bundles, "交易图表").map((item, index) => toChartBundle(item, index)),
    quality: { warnings: stringArray(exactRecord(value.quality, ["warnings"], "复盘质量").warnings, "复盘质量警告") },
  };
}

function toNullableMetric(payload: unknown, name: string) {
  const value = exactRecord(payload, ["value", "unavailable_reason"], name);
  const metricValue = nullableDecimal(value.value, name);
  const unavailableReason = nullableText(value.unavailable_reason, `${name}不可用原因`);
  if ((metricValue === null) !== (unavailableReason !== null)) throw adapterError(`${name}状态不一致`);
  return { value: metricValue, unavailableReason };
}

function toEquityPoint(payload: unknown, index: number) {
  const value = exactRecord(payload, ["date", "equity", "nav", "drawdown_rate"], `权益点 ${index + 1}`);
  return {
    date: dateText(value.date, "权益日期"),
    equity: decimalText(value.equity, "权益金额"),
    nav: toNullableMetric(value.nav, "净值"),
    drawdownRate: toNullableMetric(value.drawdown_rate, "回撤"),
  };
}

function toReasonFact(payload: unknown, index: number) {
  const value = exactRecord(payload, ["side", "reason_code", "execution_count", "quantity", "gross_amount"], `理由事实 ${index + 1}`);
  return {
    side: enumText(value.side, SIDES, "理由方向"),
    reasonCode: enumText(value.reason_code, REASONS, "理由代码"),
    executionCount: nonNegativeInteger(value.execution_count, "成交次数"),
    quantity: nonNegativeInteger(value.quantity, "成交股数"),
    grossAmount: decimalText(value.gross_amount, "成交金额"),
  };
}

function toReasonPerformance(payload: unknown, index: number) {
  const value = exactRecord(payload, ["side", "reason_code", "sample_count", "conclusion_allowed", "win_rate", "net_pnl", "average_cycle_return_rate", "median_holding_days"], `理由表现 ${index + 1}`);
  return {
    side: enumText(value.side, SIDES, "理由表现方向"),
    reasonCode: enumText(value.reason_code, REASONS, "理由表现代码"),
    sampleCount: nonNegativeInteger(value.sample_count, "理由样本数"),
    conclusionAllowed: booleanValue(value.conclusion_allowed, "理由结论状态"),
    winRate: toNullableMetric(value.win_rate, "理由胜率"),
    netPnl: decimalText(value.net_pnl, "理由盈亏"),
    averageCycleReturnRate: toNullableMetric(value.average_cycle_return_rate, "理由收益率"),
    medianHoldingDays: toNullableMetric(value.median_holding_days, "理由持有日"),
  };
}

function toCycleCase(payload: unknown, index: number) {
  const value = exactRecord(payload, ["cycle_id", "symbol", "name", "started_at", "ended_at", "net_pnl", "cycle_return_rate", "holding_days", "buy_reason_code", "sell_reason_code", "discipline_followed"], `交易周期 ${index + 1}`);
  return {
    cycleId: text(value.cycle_id, "周期编号"),
    symbol: text(value.symbol, "周期股票"),
    name: text(value.name, "周期名称", true),
    startedAt: dateTime(value.started_at, "周期开始时间"),
    endedAt: dateTime(value.ended_at, "周期结束时间"),
    netPnl: decimalText(value.net_pnl, "周期盈亏"),
    cycleReturnRate: decimalText(value.cycle_return_rate, "周期收益率"),
    holdingDays: positiveInteger(value.holding_days, "周期持有日"),
    buyReasonCode: enumText(value.buy_reason_code, BUY_REASONS, "买入理由"),
    sellReasonCode: enumText(value.sell_reason_code, SELL_REASONS, "卖出理由"),
    disciplineFollowed: nullableBoolean(value.discipline_followed, "周期纪律"),
  };
}

function toComparison(payload: unknown) {
  const value = exactRecord(payload, ["previous_period", "metrics"], "前期比较");
  const previousPeriod = exactRecord(value.previous_period, ["kind", "start", "end"], "前期周期");
  return {
    previousPeriod: {
      kind: enumText(previousPeriod.kind, PERIODS, "前期周期类型"),
      start: dateText(previousPeriod.start, "前期开始日期"),
      end: dateText(previousPeriod.end, "前期结束日期"),
    },
    metrics: array(value.metrics, "比较指标").map((item, index) => {
      const metric = exactRecord(item, ["metric_ref", "current", "previous", "delta"], `比较指标 ${index + 1}`);
      return {
        metricRef: text(metric.metric_ref, "比较指标引用"),
        current: toNullableMetric(metric.current, "本期指标"),
        previous: toNullableMetric(metric.previous, "前期指标"),
        delta: toNullableMetric(metric.delta, "指标变化"),
      };
    }),
  };
}

function toChartBundle(payload: unknown, index: number): TradingChartBundle {
  const value = exactRecord(payload, ["symbol", "name", "adjustment", "market_snapshot_id", "chan_analysis_id", "chan_engine_version", "bars", "strokes", "centers", "executions", "quality"], `交易图表 ${index + 1}`);
  if (value.adjustment !== "none") throw adapterError("交易图表复权方式无效");
  const bars = array(value.bars, "交易图表 K 线").map((item, barIndex) => {
    const bar = exactRecord(item, ["trade_date", "occurred_at", "open", "high", "low", "close", "volume"], `K 线 ${barIndex + 1}`);
    return {
      tradeDate: dateText(bar.trade_date, "K线日期"),
      occurredAt: dateTime(bar.occurred_at, "K线发生时间"),
      open: decimalText(bar.open, "K线开盘价"),
      high: decimalText(bar.high, "K线最高价"),
      low: decimalText(bar.low, "K线最低价"),
      close: decimalText(bar.close, "K线收盘价"),
      volume: nullableDecimal(bar.volume, "K线成交量"),
    };
  });
  return {
    symbol: text(value.symbol, "图表股票"),
    name: text(value.name, "图表名称", true),
    adjustment: "none",
    marketSnapshotId: text(value.market_snapshot_id, "行情快照编号"),
    chanAnalysisId: text(value.chan_analysis_id, "缠论分析编号"),
    chanEngineVersion: text(value.chan_engine_version, "缠论版本"),
    bars,
    strokes: array(value.strokes, "图表笔").map((item, strokeIndex) => {
      const stroke = exactRecord(item, ["direction", "start_at", "end_at", "start_price", "end_price", "state"], `图表笔 ${strokeIndex + 1}`);
      return {
        direction: enumText(stroke.direction, ["up", "down"] as const, "笔方向"),
        startAt: dateTime(stroke.start_at, "笔开始时间"),
        endAt: dateTime(stroke.end_at, "笔结束时间"),
        startPrice: decimalText(stroke.start_price, "笔开始价格"),
        endPrice: decimalText(stroke.end_price, "笔结束价格"),
        state: enumText(stroke.state, ["confirmed", "provisional"] as const, "笔状态"),
      };
    }),
    centers: array(value.centers, "图表中枢").map((item, centerIndex) => {
      const center = exactRecord(item, ["start_at", "end_at", "lower", "upper"], `图表中枢 ${centerIndex + 1}`);
      return {
        startAt: dateTime(center.start_at, "中枢开始时间"),
        endAt: dateTime(center.end_at, "中枢结束时间"),
        lower: decimalText(center.lower, "中枢下沿"),
        upper: decimalText(center.upper, "中枢上沿"),
      };
    }),
    executions: array(value.executions, "图表成交").map((item, executionIndex) => {
      const execution = exactRecord(item, ["execution_id", "trade_date", "executed_at", "side", "price", "quantity", "fee", "primary_reason"], `图表成交 ${executionIndex + 1}`);
      return {
        executionId: text(execution.execution_id, "图表成交编号"),
        tradeDate: dateText(execution.trade_date, "图表成交日期"),
        executedAt: dateTime(execution.executed_at, "图表成交时间"),
        side: enumText(execution.side, SIDES, "图表成交方向"),
        price: decimalText(execution.price, "图表成交价格"),
        quantity: positiveInteger(execution.quantity, "图表成交股数"),
        fee: decimalText(execution.fee, "图表成交手续费"),
        primaryReason: enumText(execution.primary_reason, REASONS, "图表成交理由"),
      };
    }),
    quality: { warnings: stringArray(exactRecord(value.quality, ["warnings"], "图表质量").warnings, "图表质量警告") },
  };
}

function toError(payload: unknown, name: string) {
  const value = exactRecord(payload, ["code", "message"], name);
  return { code: text(value.code, `${name}代码`), message: text(value.message, `${name}信息`) };
}

function backendErrorMessage(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return fallback;
  if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) return payload.error.message;
  if (typeof payload.detail === "string" && payload.detail.trim()) return payload.detail;
  return fallback;
}

function exactRecord(payload: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const value = record(payload, name);
  const actual = Object.keys(value);
  if (keys.some((key) => !(key in value)) || actual.some((key) => !keys.includes(key))) throw adapterError(`${name}字段无效`);
  return value;
}

function record(payload: unknown, name: string): Record<string, unknown> {
  if (!isRecord(payload)) throw adapterError(`${name}格式无效`);
  return payload;
}

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function array(payload: unknown, name: string): unknown[] {
  if (!Array.isArray(payload)) throw adapterError(`${name}格式无效`);
  return payload;
}

function text(payload: unknown, name: string, allowEmpty = false): string {
  if (typeof payload !== "string" || (!allowEmpty && !payload.trim())) throw adapterError(`${name}无效`);
  return payload;
}

function nullableText(payload: unknown, name: string): string | null {
  return payload === null ? null : text(payload, name);
}

function decimalText(payload: unknown, name: string): string {
  const value = text(payload, name);
  if (!DECIMAL.test(value)) throw adapterError(`${name}无效`);
  return value;
}

function nullableDecimal(payload: unknown, name: string): string | null {
  return payload === null ? null : decimalText(payload, name);
}

function dateText(payload: unknown, name: string): string {
  const value = text(payload, name);
  if (!DATE.test(value)) throw adapterError(`${name}无效`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw adapterError(`${name}无效`);
  return value;
}

function nullableDate(payload: unknown, name: string): string | null {
  return payload === null ? null : dateText(payload, name);
}

function dateTime(payload: unknown, name: string): string {
  const value = text(payload, name);
  if (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) throw adapterError(`${name}无效`);
  return value;
}

function nullableDateTime(payload: unknown, name: string): string | null {
  return payload === null ? null : dateTime(payload, name);
}

function stringArray(payload: unknown, name: string): string[] {
  return array(payload, name).map((item) => text(item, name));
}

function enumText<const T extends string>(payload: unknown, allowed: readonly T[], name: string): T {
  if (typeof payload !== "string" || !allowed.includes(payload as T)) throw adapterError(`${name}无效`);
  return payload as T;
}

function nullableEnum<const T extends string>(payload: unknown, allowed: readonly T[], name: string): T | null {
  return payload === null ? null : enumText(payload, allowed, name);
}

function positiveInteger(payload: unknown, name: string, allowZero = false): number {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < (allowZero ? 0 : 1)) throw adapterError(`${name}无效`);
  return payload;
}

function nonNegativeInteger(payload: unknown, name: string): number {
  return positiveInteger(payload, name, true);
}

function booleanValue(payload: unknown, name: string): boolean {
  if (typeof payload !== "boolean") throw adapterError(`${name}无效`);
  return payload;
}

function nullableBoolean(payload: unknown, name: string): boolean | null {
  return payload === null ? null : booleanValue(payload, name);
}

function adapterError(message: string): ApiError {
  return new ApiError(message, 502);
}
