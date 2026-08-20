import { describe, expect, it } from "vitest";
import { buildTradingReviewChartOption } from "./trading-review-chart-option";
import type { TradingChartBundle, TradingReviewDeterministicReport } from "./trading-types";

const bundle: TradingChartBundle = {
  symbol: "002940.SZ",
  name: "昂利康",
  adjustment: "none",
  marketSnapshotId: "market-1",
  chanAnalysisId: "chan-1",
  chanEngineVersion: "chan.v1",
  bars: [
    { tradeDate: "2026-08-13", occurredAt: "2026-08-13T00:00:00+08:00", open: "20", high: "21", low: "19", close: "20.5", volume: "10000" },
    { tradeDate: "2026-08-14", occurredAt: "2026-08-14T00:00:00+08:00", open: "20.5", high: "22", low: "20", close: "21.5", volume: "12000" },
  ],
  strokes: [{ direction: "up", startAt: "2026-08-13T00:00:00+08:00", endAt: "2026-08-14T00:00:00+08:00", startPrice: "19", endPrice: "22", state: "confirmed" }],
  centers: [{ startAt: "2026-08-13T00:00:00+08:00", endAt: "2026-08-14T00:00:00+08:00", lower: "20", upper: "21" }],
  executions: [{ executionId: "execution-1", tradeDate: "2026-08-13", executedAt: "2026-08-13T14:30:00+08:00", side: "buy", price: "20.15", quantity: 100, fee: "5.00", primaryReason: "pullback_confirmation" }],
  quality: { warnings: [] },
};

const report: TradingReviewDeterministicReport = {
  schemaVersion: "deterministic_trading_review.v1",
  sample: { tradingDayCount: 2, executionCount: 1, closedCycleCount: 0, overallConclusionAllowed: false },
  metrics: {
    periodRealizedPnl: "0", closedCyclePnl: "0",
    accountAdjustedReturnRate: { value: "0.01", unavailableReason: null },
    periodMaxDrawdownRate: { value: "-0.02", unavailableReason: null },
    winRate: { value: null, unavailableReason: "样本不足" },
    averageWinLossRatio: { value: null, unavailableReason: "样本不足" },
    profitFactor: { value: null, unavailableReason: "样本不足" },
    medianHoldingDays: { value: null, unavailableReason: "样本不足" },
    medianCapitalEfficiency: { value: null, unavailableReason: "样本不足" },
    disciplineAdherenceRate: { value: null, unavailableReason: "样本不足" },
  },
  equityCurve: [
    { date: "2026-08-13", equity: "100000", nav: { value: "1", unavailableReason: null }, drawdownRate: { value: "0", unavailableReason: null } },
    { date: "2026-08-14", equity: "101000", nav: { value: "1.01", unavailableReason: null }, drawdownRate: { value: "-0.02", unavailableReason: null } },
  ],
  executionReasonFacts: [],
  reasonPerformance: [],
  cycleCases: [],
  comparison: null,
  comparisonUnavailableReason: "no_previous_period",
  chartBundles: [bundle],
  quality: { warnings: [] },
};

describe("交易复盘图表 option", () => {
  it("把权益、回撤、未复权 K 线、成交量、缠论结构和真实买卖点放进同一份固化图表", () => {
    const option = buildTradingReviewChartOption(report, bundle);
    const series = option.series as Array<Record<string, unknown>>;

    expect(series.find((item) => item.name === "账户权益")).toMatchObject({ type: "line", xAxisIndex: 0 });
    expect(series.find((item) => item.name === "回撤")).toMatchObject({ type: "line", xAxisIndex: 0 });
    expect(series.find((item) => item.name === "未复权 K 线")).toMatchObject({ type: "candlestick", xAxisIndex: 1, yAxisIndex: 1 });
    expect(series.find((item) => item.name === "成交量")).toMatchObject({ type: "bar", xAxisIndex: 2, yAxisIndex: 2 });
    expect(series.find((item) => item.name === "实际买入")).toMatchObject({ type: "scatter", xAxisIndex: 1, yAxisIndex: 1 });
    expect((option.dataZoom as Array<{ xAxisIndex: number[] }>).map((item) => item.xAxisIndex)).toEqual([[1, 2], [1, 2]]);
  });

  it("在买卖点提示里保留历史时间、数量、手续费和理由，不输出交易建议", () => {
    const option = buildTradingReviewChartOption(report, bundle);
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const text = formatter([{ seriesName: "实际买入", data: { execution: bundle.executions[0] } }]);

    expect(text).toContain("2026-08-13T14:30:00+08:00");
    expect(text).toContain("数量 100");
    expect(text).toContain("手续费 5.00");
    expect(text).toContain("回踩确认");
    expect(text).not.toMatch(/建议|应该/);
  });
});
