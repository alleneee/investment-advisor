import { describe, expect, it } from "vitest";
import { buildJournalReturnChartOption } from "./journal-return-chart-option";
import type { TradingPeriodSummary } from "./trading-types";

type Curve = TradingPeriodSummary["returnCurve"];

const curve: Curve = [
  { date: "2026-08-01", cumulativeReturnRate: { value: "0.0123", unavailableReason: null } },
  { date: "2026-08-04", cumulativeReturnRate: { value: null, unavailableReason: "valuation_unavailable" } },
  { date: "2026-08-05", cumulativeReturnRate: { value: "-0.0045", unavailableReason: null } },
];

function seriesOf(input: Curve): Array<Record<string, unknown>> {
  return buildJournalReturnChartOption(input).series as Array<Record<string, unknown>>;
}

describe("交易日记收益图 option", () => {
  it("在横轴保留全部日期，包括收益不可用的日期", () => {
    const option = buildJournalReturnChartOption(curve);

    expect(option.xAxis).toMatchObject({
      type: "category",
      data: ["2026-08-01", "2026-08-04", "2026-08-05"],
    });
  });

  it("实际收益折线保留 null 断点且不跨越断点连线", () => {
    const actual = seriesOf(curve)[0];

    expect(actual).toMatchObject({
      type: "line",
      data: [0.0123, null, -0.0045],
      connectNulls: false,
      showSymbol: true,
      showAllSymbol: true,
      symbol: "circle",
    });
  });

  it("提供与每个日期一一对应的静默 0% 虚线", () => {
    const baseline = seriesOf(curve)[1];

    expect(baseline).toMatchObject({
      type: "line",
      silent: true,
      data: [0, 0, 0],
      lineStyle: { type: "dashed" },
    });
  });

  it.each([
    ["正收益", "0.01", "#f6465d"],
    ["负收益", "-0.01", "#0ecb81"],
    ["零收益", "0", "#bbcbb2"],
  ])("最后一个有效值为%s时选择对应线色", (_label, value, color) => {
    const actual = seriesOf([
      { date: "2026-08-01", cumulativeReturnRate: { value, unavailableReason: null } },
    ])[0];

    expect(actual).toMatchObject({ lineStyle: { color } });
  });

  it("末尾不可用时仍按最后一个有效值选择线色", () => {
    const actual = seriesOf([
      { date: "2026-08-01", cumulativeReturnRate: { value: "-0.01", unavailableReason: null } },
      { date: "2026-08-04", cumulativeReturnRate: { value: null, unavailableReason: "valuation_unavailable" } },
    ])[0];

    expect(actual).toMatchObject({ lineStyle: { color: "#0ecb81" } });
  });

  it("把非有限绘图值转成 null，并把纵轴 decimal ratio 格式化为百分比", () => {
    const invalidCurve = [
      { date: "2026-08-01", cumulativeReturnRate: { value: "NaN", unavailableReason: null } },
    ] as Curve;
    const option = buildJournalReturnChartOption(invalidCurve);
    const yAxisFormatter = (option.yAxis as { axisLabel: { formatter: (value: number) => string } }).axisLabel.formatter;

    expect((option.series as Array<{ data: unknown[] }>)[0].data).toEqual([null]);
    expect(yAxisFormatter(0.0123)).toBe("1.23%");
    expect(yAxisFormatter(-0.0045)).toBe("-0.45%");
  });

  it("提示框按日期回查原始点并显示格式化收益或不可用原因", () => {
    const option = buildJournalReturnChartOption(curve);
    const tooltip = option.tooltip as { renderMode: string; formatter: (params: unknown) => string };

    expect(tooltip.renderMode).toBe("richText");
    expect(tooltip.formatter([{ axisValue: "2026-08-01" }])).toBe("2026-08-01\n累计收益 1.23%");
    expect(tooltip.formatter([{ axisValue: "2026-08-04" }])).toBe("2026-08-04\nvaluation_unavailable");
  });
});
