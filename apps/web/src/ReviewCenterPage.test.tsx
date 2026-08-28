import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewCenterPage } from "./ReviewCenterPage";
import type { TradingApi } from "./trading-api";
import type { BsChart, BsSymbolSummary, ChartMark, ChartMarkType, StructureAttribution, TradingReviewReport } from "./trading-types";

const report: TradingReviewReport = {
  reportId: "report-1",
  snapshotId: "snapshot-1",
  reportVersion: 1,
  supersedesSnapshotId: null,
  accountId: "account-1",
  periodKind: "week",
  periodStart: "2026-08-10",
  periodEnd: "2026-08-16",
  dataAsOf: "2026-08-16T15:00:00+08:00",
  inputDigest: "digest-1",
  ledgerRevision: 2,
  dailyReviewRevision: 1,
  marketRevision: 3,
  marketWatermark: "market-1",
  attempt: 1,
  snapshotStatus: "ready",
  dataQuality: "ok",
  aiStatus: "not_requested",
  isOutdated: false,
  partialPeriod: false,
  retryable: false,
  deterministicReport: {
    schemaVersion: "deterministic_trading_review.v1",
    sample: { tradingDayCount: 5, executionCount: 2, closedCycleCount: 1, overallConclusionAllowed: false },
    metrics: {
      periodRealizedPnl: "1980.00", closedCyclePnl: "1980.00",
      accountAdjustedReturnRate: { value: "0.0198", unavailableReason: null },
      periodMaxDrawdownRate: { value: "-0.012", unavailableReason: null },
      winRate: { value: null, unavailableReason: "样本不足" },
      averageWinLossRatio: { value: null, unavailableReason: "样本不足" },
      profitFactor: { value: null, unavailableReason: "样本不足" },
      medianHoldingDays: { value: "3", unavailableReason: null },
      medianCapitalEfficiency: { value: null, unavailableReason: "样本不足" },
      disciplineAdherenceRate: { value: "1", unavailableReason: null },
    },
    equityCurve: [],
    executionReasonFacts: [{ side: "buy", reasonCode: "pullback_confirmation", executionCount: 1, quantity: 100, grossAmount: "2000" }],
    reasonPerformance: [],
    cycleCases: [{ cycleId: "cycle-1", symbol: "002940.SZ", name: "昂利康", startedAt: "2026-08-10T10:00:00+08:00", endedAt: "2026-08-14T14:00:00+08:00", netPnl: "1980", cycleReturnRate: "0.09", holdingDays: 3, buyReasonCode: "pullback_confirmation", sellReasonCode: "take_profit", disciplineFollowed: true }],
    comparison: null,
    comparisonUnavailableReason: "no_previous_period",
    chartBundles: [{ symbol: "002940.SZ", name: "昂利康", adjustment: "none", marketSnapshotId: "market-1", chanAnalysisId: "chan-1", chanEngineVersion: "chan.v1", bars: [], strokes: [], centers: [], executions: [], quality: { warnings: [] } }],
    quality: { warnings: [] },
  },
  aiReview: null,
  error: null,
};

const attribution: StructureAttribution = {
  summary: [
    { category: "above_center", closedCycles: 2, openCycles: 0, won: 1, winRate: "0.5", totalPnl: "120", avgPnl: "60.00" },
    { category: "inside_center", closedCycles: 0, openCycles: 1, won: 0, winRate: null, totalPnl: "0", avgPnl: null },
    { category: "below_center", closedCycles: 0, openCycles: 0, won: 0, winRate: null, totalPnl: "0", avgPnl: null },
    { category: "no_center", closedCycles: 0, openCycles: 0, won: 0, winRate: null, totalPnl: "0", avgPnl: null },
    { category: "unclassified", closedCycles: 0, openCycles: 0, won: 0, winRate: null, totalPnl: "0", avgPnl: null },
  ],
  executions: [
    { executionId: "execution-1", symbol: "600156.SH", tradeDate: "2026-08-11", executedAt: "2026-08-11T10:00:00+08:00", side: "buy", price: "21.6", quantity: 100, adjustedPrice: "10.8", centerLower: "7.5", centerUpper: "10.8", category: "inside_center", reason: null },
    { executionId: "execution-2", symbol: "600156.SH", tradeDate: "2026-08-12", executedAt: "2026-08-12T10:00:00+08:00", side: "buy", price: "11", quantity: 100, adjustedPrice: null, centerLower: null, centerUpper: null, category: "unclassified", reason: "missing_bar_on_execution_date" },
  ],
  quality: { unclassifiedExecutions: [{ executionId: "execution-2", symbol: "600156.SH", tradeDate: "2026-08-12", reason: "missing_bar_on_execution_date" }], symbolsMissingMarketData: [] },
};

const profitSymbol: BsSymbolSummary = {
  symbol: "002041.SZ",
  name: "登海种业",
  realizedPnl: "4377.88",
  periodPnl: "4377.88",
  closedCycleCount: 2,
  medianHoldingDays: { value: "13", unavailableReason: null },
  winRate: { value: "1", unavailableReason: null },
};

const zeroSymbol: BsSymbolSummary = {
  symbol: "000001.SZ",
  name: "平安银行",
  realizedPnl: "0.00",
  periodPnl: "0.00",
  closedCycleCount: 0,
  medianHoldingDays: { value: null, unavailableReason: "no_closed_cycle" },
  winRate: { value: null, unavailableReason: "no_closed_cycle" },
};

const markTypes: ChartMarkType[] = [
  {
    typeId: "type-ideal-buy",
    accountId: "account-1",
    code: "ideal_buy",
    label: "理想买",
    letter: "买",
    color: "#f6465d",
    preset: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00+08:00",
  },
  {
    typeId: "type-disabled",
    accountId: "account-1",
    code: "old_high",
    label: "停用高点",
    letter: "旧",
    color: "#888888",
    preset: false,
    enabled: false,
    createdAt: "2026-08-01T00:00:00+08:00",
  },
];

const existingMark: ChartMark = {
  markId: "mark-disabled",
  accountId: "account-1",
  symbol: "002041.SZ",
  occurredAt: "2026-08-11T00:00:00+08:00",
  typeId: "type-disabled",
  comment: "旧高点",
  revision: 1,
  createdAt: "2026-08-11T10:00:00+08:00",
  updatedAt: "2026-08-11T10:00:00+08:00",
};

function dailyChart(symbol: string): BsChart {
  return {
    symbol,
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [
      {
        tradeDate: "2026-07-05",
        occurredAt: "2026-07-05T00:00:00+08:00",
        open: "10",
        high: "11",
        low: "9",
        close: "10.5",
        volume: "1000",
      },
      {
        tradeDate: "2026-08-16",
        occurredAt: "2026-08-16T00:00:00+08:00",
        open: "11",
        high: "13",
        low: "10.5",
        close: "12",
        volume: "1100",
      },
    ],
    executions: [],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "ok", warnings: [] },
  };
}

function apiForReview(overrides: Partial<TradingApi> = {}): TradingApi {
  return {
    getAccount: vi.fn(), createAccount: vi.fn(), listExecutions: vi.fn(), createExecution: vi.fn(), updateExecution: vi.fn(), deleteExecution: vi.fn(), listCashFlows: vi.fn(), createCashFlow: vi.fn(), deleteCashFlow: vi.fn(), getDailyReview: vi.fn(), saveDailyReview: vi.fn(), getCalendar: vi.fn(), getPeriodSummary: vi.fn(),
    getStructureAttribution: vi.fn(async () => attribution),
    getReviewPreview: vi.fn(async () => report),
    createReviewReport: vi.fn(async () => report),
    listReviewReports: vi.fn(async () => [report]),
    getReviewReport: vi.fn(async () => report),
    retryReviewReport: vi.fn(async () => report),
    getBsSummary: vi.fn(async (start: string, end: string) => ({ start, end, symbols: [profitSymbol, zeroSymbol] })),
    getBsChart: vi.fn(async (symbol: string, timeframe: "1d" | "30m") => (
      timeframe === "30m"
        ? {
          symbol,
          timeframe,
          available: false,
          adjustment: "none" as const,
          bars: [],
          executions: [],
          macd: { ready: false, dif: [], dea: [], histogram: [] },
          quality: { status: "unavailable" as const, warnings: ["stk_mins failed"] },
        }
        : dailyChart(symbol)
    )),
    listChartMarks: vi.fn(async () => [existingMark]),
    createChartMark: vi.fn(),
    updateChartMark: vi.fn(),
    deleteChartMark: vi.fn(),
    listChartMarkTypes: vi.fn(async () => markTypes),
    createChartMarkType: vi.fn(),
    updateChartMarkType: vi.fn(),
    deleteChartMarkType: vi.fn(),
    ...overrides,
  };
}

async function generateReview(overrides: Partial<TradingApi> = {}) {
  const user = userEvent.setup();
  const api = apiForReview(overrides);
  render(<ReviewCenterPage api={api} today="2026-08-18" />);
  await user.click(screen.getByRole("button", { name: "生成确定性复盘" }));
  expect(await screen.findByRole("heading", { name: "确定性复盘结果" })).toBeInTheDocument();
  return { api, user };
}

describe("复盘中心", () => {
  it("选择完整周期后展示账户指标带、理由事实和交易周期，不再画旧复盘图", async () => {
    const { api } = await generateReview();

    await waitFor(() => expect(api.createReviewReport).toHaveBeenCalledWith("week", "2026-08-10", "2026-08-16"));
    const metrics = screen.getByRole("group", { name: "周期指标" });
    expect(metrics).toHaveTextContent("报告期已实现盈亏");
    expect(metrics).toHaveTextContent("胜率");
    expect(screen.getByText("买卖理由表现")).toBeInTheDocument();
    expect(screen.getByText("交易周期")).toBeInTheDocument();
    expect(screen.queryByText("权益、回撤与真实买卖点")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /交易复盘图/ })).not.toBeInTheDocument();
    expect(screen.getByText("Pi 总结尚未请求")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "个股 BS 分析" })).not.toBeInTheDocument();
  });

  it("展示结构位置归因：类别聚合、样本不足文案与逐笔明细", async () => {
    const api = apiForReview();
    render(<ReviewCenterPage api={api} today="2026-08-18" />);

    expect(await screen.findByRole("heading", { name: "结构位置归因" })).toBeInTheDocument();
    await waitFor(() => expect(api.getStructureAttribution).toHaveBeenCalled());
    const summaryTable = await screen.findByRole("table", { name: "买点结构类别聚合" });
    expect(summaryTable).toHaveTextContent("中枢上方买入");
    expect(summaryTable).toHaveTextContent("50.00%");
    expect(summaryTable).toHaveTextContent("中枢内买入");
    expect(summaryTable).toHaveTextContent("样本不足");
    const detailTable = screen.getByRole("table", { name: "逐笔成交归因明细" });
    expect(detailTable).toHaveTextContent("7.5 ~ 10.8");
    expect(detailTable).toHaveTextContent("10.8");
    expect(detailTable).toHaveTextContent("无法归因（成交日无 K 线）");
  });

  it("锁定周期后隐藏周期切换，并按传入区间生成复盘", async () => {
    const user = userEvent.setup();
    const api = apiForReview();
    render(
      <ReviewCenterPage
        api={api}
        today="2026-08-18"
        periodKind="month"
        periodStart="2026-08-01"
        periodEnd="2026-08-31"
        hidePeriodControls
      />,
    );

    expect(screen.queryByRole("button", { name: "周报" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "月报" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("周期开始")).not.toBeInTheDocument();
    expect(screen.getByText("2026-08-01 至 2026-08-31")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报告版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构位置归因" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成确定性复盘" }));
    await waitFor(() => expect(api.createReviewReport).toHaveBeenCalledWith("month", "2026-08-01", "2026-08-31"));
    expect(await screen.findByRole("heading", { name: "确定性复盘结果" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "报告版本" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "结构位置归因" })).toBeInTheDocument();
  });
});
