export type TradingSide = "buy" | "sell";
export type CashFlowKind = "deposit" | "withdrawal";
export type ReviewPeriodKind = "week" | "month" | "quarter" | "year";
export type DailyReviewStatus = "draft" | "completed";
export type TradingDataQuality = "ok" | "degraded" | "unavailable";
export type TradingSnapshotStatus = "pending" | "running" | "ready" | "failed";
export type TradingAiStatus = "not_requested" | "pending" | "running" | "ready" | "failed";

export type BuyReasonCode =
  | "structure_breakout"
  | "pullback_confirmation"
  | "trend_continuation"
  | "reversal_expectation"
  | "event_driven"
  | "valuation_recovery"
  | "oversold_rebound"
  | "planned_add"
  | "other";

export type SellReasonCode =
  | "stop_loss"
  | "take_profit"
  | "structure_invalidated"
  | "target_reached"
  | "planned_reduce"
  | "thesis_invalidated"
  | "capital_reallocation"
  | "discipline_violation"
  | "other";

export type TradingReasonCode = BuyReasonCode | SellReasonCode;

export interface TradingAccount {
  accountId: string;
  name: string;
  activatedOn: string;
  initialCapital: string;
  ledgerRevision: number;
  cash: string;
  positionMarketValue: string | null;
  totalEquity: string | null;
  valuationDate: string | null;
  dailyPnl: string | null;
  sinceInceptionDrawdown: string | null;
  dataQuality: TradingDataQuality;
  dataQualityWarnings: string[];
}

export interface TradingExecution {
  executionId: string;
  symbol: string;
  name: string;
  executedAt: string;
  side: TradingSide;
  price: string;
  quantity: number;
  fee: string;
  primaryReason: TradingReasonCode;
  tags: string[];
  note: string;
  clientIdempotencyKey: string;
  revision: number;
  ledgerRevision: number;
}

export interface CashFlow {
  cashFlowId: string;
  occurredAt: string;
  kind: CashFlowKind;
  amount: string;
  note: string;
  clientIdempotencyKey: string;
  revision: number;
  ledgerRevision: number;
}

export interface DailyReview {
  dailyReviewId: string;
  tradeDate: string;
  status: DailyReviewStatus;
  invalidationCondition: string;
  nextDayPlan: string;
  emotion: "calm" | "confident" | "anxious" | "impulsive" | "frustrated" | "other";
  disciplineFollowed: boolean | null;
  note: string;
  revision: number;
  dailyReviewRevision: number;
}

export interface TradingCalendarDay {
  date: string;
  executionCount: number;
  dailyPnl: string | null;
  reviewStatus: DailyReviewStatus | null;
  isOpen: boolean;
}

export interface TradingCalendarMonth {
  month: string;
  netPnl: string | null;
  maxDrawdown: string | null;
  days: TradingCalendarDay[];
}

export interface TradingPeriodSummary {
  start: string;
  end: string;
  maxDrawdown: string | null;
  returnCurve: Array<{
    date: string;
    cumulativeReturnRate: NullableDecimalMetric;
  }>;
}

export interface NullableDecimalMetric {
  value: string | null;
  unavailableReason: string | null;
}

export interface TradingReasonFact {
  side: TradingSide;
  reasonCode: TradingReasonCode;
  executionCount: number;
  quantity: number;
  grossAmount: string;
}

export interface TradingReasonPerformance {
  side: TradingSide;
  reasonCode: TradingReasonCode;
  sampleCount: number;
  conclusionAllowed: boolean;
  winRate: NullableDecimalMetric;
  netPnl: string;
  averageCycleReturnRate: NullableDecimalMetric;
  medianHoldingDays: NullableDecimalMetric;
  maxCycleProfit: NullableDecimalMetric;
  maxCycleLoss: NullableDecimalMetric;
}

export interface TradingCycleCase {
  cycleId: string;
  symbol: string;
  name: string;
  startedAt: string;
  endedAt: string;
  netPnl: string;
  cycleReturnRate: string;
  holdingDays: number;
  buyReasonCode: BuyReasonCode;
  sellReasonCode: SellReasonCode;
  disciplineFollowed: boolean | null;
}

export interface TradingChartBar {
  tradeDate: string;
  occurredAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
}

export interface TradingChartStroke {
  direction: "up" | "down";
  startAt: string;
  endAt: string;
  startPrice: string;
  endPrice: string;
  state: "confirmed" | "provisional";
}

export interface TradingChartCenter {
  startAt: string;
  endAt: string;
  lower: string;
  upper: string;
}

export interface TradingChartExecution {
  executionId: string;
  tradeDate: string;
  executedAt: string;
  side: TradingSide;
  price: string;
  quantity: number;
  fee: string;
  primaryReason: TradingReasonCode;
}

export interface TradingChartBundle {
  symbol: string;
  name: string;
  adjustment: "none";
  marketSnapshotId: string;
  chanAnalysisId: string;
  chanEngineVersion: string;
  bars: TradingChartBar[];
  strokes: TradingChartStroke[];
  centers: TradingChartCenter[];
  executions: TradingChartExecution[];
  quality: { warnings: string[] };
}

export interface TradingReviewDeterministicReport {
  schemaVersion: "deterministic_trading_review.v1";
  sample: {
    tradingDayCount: number;
    executionCount: number;
    closedCycleCount: number;
    overallConclusionAllowed: boolean;
  };
  metrics: {
    periodRealizedPnl: string;
    closedCyclePnl: string;
    accountAdjustedReturnRate: NullableDecimalMetric;
    periodMaxDrawdownRate: NullableDecimalMetric;
    winRate: NullableDecimalMetric;
    averageWinLossRatio: NullableDecimalMetric;
    profitFactor: NullableDecimalMetric;
    medianHoldingDays: NullableDecimalMetric;
    medianCapitalEfficiency: NullableDecimalMetric;
    disciplineAdherenceRate: NullableDecimalMetric;
  };
  equityCurve: Array<{
    date: string;
    equity: string;
    nav: NullableDecimalMetric;
    drawdownRate: NullableDecimalMetric;
  }>;
  executionReasonFacts: TradingReasonFact[];
  reasonPerformance: TradingReasonPerformance[];
  cycleCases: TradingCycleCase[];
  comparison: {
    previousPeriod: { kind: ReviewPeriodKind; start: string; end: string };
    metrics: Array<{
      metricRef: string;
      current: NullableDecimalMetric;
      previous: NullableDecimalMetric;
      delta: NullableDecimalMetric;
    }>;
  } | null;
  comparisonUnavailableReason: "partial_period" | "no_previous_period" | null;
  chartBundles: TradingChartBundle[];
  quality: { warnings: string[] };
}

export interface TradingReviewReport {
  reportId: string;
  snapshotId: string | null;
  reportVersion: number;
  supersedesSnapshotId: string | null;
  accountId: string;
  periodKind: ReviewPeriodKind;
  periodStart: string;
  periodEnd: string;
  dataAsOf: string | null;
  inputDigest: string;
  ledgerRevision: number;
  dailyReviewRevision: number;
  marketRevision: number;
  marketWatermark: string | null;
  attempt: number;
  snapshotStatus: TradingSnapshotStatus;
  dataQuality: TradingDataQuality;
  aiStatus: TradingAiStatus;
  isOutdated: boolean;
  partialPeriod: boolean;
  retryable: boolean;
  deterministicReport: TradingReviewDeterministicReport | null;
  aiReview: null;
  error: { code: string; message: string } | null;
}

export type StructureAttributionCategory =
  | "above_center"
  | "inside_center"
  | "below_center"
  | "no_center"
  | "unclassified";

export type StructureAttributionReason =
  | "missing_market_data"
  | "missing_bar_on_execution_date"
  | "adjustment_unavailable";

export interface StructureAttributionSummary {
  category: StructureAttributionCategory;
  closedCycles: number;
  openCycles: number;
  won: number;
  winRate: string | null;
  totalPnl: string;
  avgPnl: string | null;
}

export interface StructureAttributionExecution {
  executionId: string;
  symbol: string;
  tradeDate: string;
  executedAt: string;
  side: TradingSide;
  price: string;
  quantity: number;
  adjustedPrice: string | null;
  centerLower: string | null;
  centerUpper: string | null;
  category: StructureAttributionCategory;
  reason: StructureAttributionReason | null;
}

export interface StructureAttributionQuality {
  unclassifiedExecutions: Array<{
    executionId: string;
    symbol: string;
    tradeDate: string;
    reason: StructureAttributionReason;
  }>;
  symbolsMissingMarketData: string[];
}

export interface StructureAttribution {
  summary: StructureAttributionSummary[];
  executions: StructureAttributionExecution[];
  quality: StructureAttributionQuality;
}

export interface CreateTradingAccountRequest {
  name: string;
  activatedOn: string;
  initialCapital: string;
}

export interface CreateTradingExecutionRequest {
  symbol: string;
  name: string;
  executedAt: string;
  side: TradingSide;
  price: string;
  quantity: number;
  fee: string;
  primaryReason: TradingReasonCode;
  tags: string[];
  note: string;
  clientIdempotencyKey: string;
}

export interface CreateCashFlowRequest {
  occurredAt: string;
  kind: CashFlowKind;
  amount: string;
  note: string;
  clientIdempotencyKey: string;
}

export interface SaveDailyReviewRequest {
  status: DailyReviewStatus;
  invalidationCondition: string;
  nextDayPlan: string;
  emotion: DailyReview["emotion"];
  disciplineFollowed: boolean | null;
  note: string;
  revision: number | null;
}

export type BsTimeframe = "1d" | "30m";

export interface BsSymbolSummary {
  symbol: string;
  name: string;
  realizedPnl: string;
  periodPnl: string;
  closedCycleCount: number;
  medianHoldingDays: NullableDecimalMetric;
  winRate: NullableDecimalMetric;
}

export interface BsSummary {
  start: string;
  end: string;
  symbols: BsSymbolSummary[];
}

export interface BsChartExecution {
  executionId: string;
  symbol: string;
  occurredAt: string;
  barOccurredAt: string;
  side: TradingSide;
  price: string;
  quantity: number;
  fee: string;
  primaryReason: TradingReasonCode;
}

export interface BsMacd {
  ready: boolean;
  dif: string[];
  dea: string[];
  histogram: string[];
  warmupBars?: number;
}

export interface BsChart {
  symbol: string;
  timeframe: BsTimeframe;
  available: boolean;
  adjustment: "none";
  bars: TradingChartBar[];
  executions: BsChartExecution[];
  macd: BsMacd;
  quality: { status: TradingDataQuality; warnings: string[] };
}

export interface ChartMark {
  markId: string;
  accountId: string;
  symbol: string;
  occurredAt: string;
  typeId: string;
  comment: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChartMarkType {
  typeId: string;
  accountId: string;
  code: string;
  label: string;
  letter: string;
  color: string;
  preset: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface CreateChartMarkRequest {
  symbol: string;
  occurredAt: string;
  typeId: string;
  comment: string;
  timeframe: BsTimeframe;
}

export interface UpdateChartMarkRequest {
  typeId?: string;
  comment?: string;
}

export interface CreateChartMarkTypeRequest {
  label: string;
  letter: string;
  color: string;
}

export interface UpdateChartMarkTypeRequest {
  label?: string;
  letter?: string;
  color?: string;
  enabled?: boolean;
}
