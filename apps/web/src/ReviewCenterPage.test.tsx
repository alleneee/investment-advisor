import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewCenterPage } from "./ReviewCenterPage";
import type { TradingApi } from "./trading-api";
import type { TradingReviewReport } from "./trading-types";

vi.mock("./TradingReviewChart", () => ({
  TradingReviewChart: ({ bundle }: { bundle: { symbol: string } }) => <div role="img" aria-label={`${bundle.symbol} 交易复盘图`} />,
}));

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

function apiForReview(overrides: Partial<TradingApi> = {}): TradingApi {
  return {
    getAccount: vi.fn(), createAccount: vi.fn(), listExecutions: vi.fn(), createExecution: vi.fn(), updateExecution: vi.fn(), deleteExecution: vi.fn(), listCashFlows: vi.fn(), createCashFlow: vi.fn(), deleteCashFlow: vi.fn(), getDailyReview: vi.fn(), saveDailyReview: vi.fn(),
    getReviewPreview: vi.fn(async () => report),
    createReviewReport: vi.fn(async () => report),
    listReviewReports: vi.fn(async () => [report]),
    getReviewReport: vi.fn(async () => report),
    retryReviewReport: vi.fn(async () => report),
    ...overrides,
  };
}

describe("复盘中心", () => {
  it("选择完整周期后展示固化的确定性指标、理由事实、交易周期和历史买卖点", async () => {
    const user = userEvent.setup();
    const api = apiForReview();
    render(<ReviewCenterPage api={api} today="2026-08-18" />);

    expect(screen.getByRole("button", { name: "周报" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "生成确定性复盘" }));

    await waitFor(() => expect(api.createReviewReport).toHaveBeenCalledWith("week", "2026-08-10", "2026-08-16"));
    expect(await screen.findByRole("heading", { name: "确定性复盘结果" })).toBeInTheDocument();
    expect(screen.getByText("报告期已实现盈亏")).toBeInTheDocument();
    expect(screen.getByText("买卖理由表现")).toBeInTheDocument();
    expect(screen.getByText("交易周期")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "002940.SZ 交易复盘图" })).toBeInTheDocument();
    expect(screen.getByText("Pi 总结尚未请求")).toBeInTheDocument();
  });
});
