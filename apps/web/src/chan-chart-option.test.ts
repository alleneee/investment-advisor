import { describe, expect, it } from "vitest";
import { buildChanChartOption } from "./chan-chart-option";
import type { ChanChartData, Timeframe } from "./types";

function chartData(count = 900, timeframe: Timeframe = "1d"): ChanChartData {
  const bars = Array.from({ length: count }, (_, index) => {
    const occurredAt = new Date(Date.UTC(2021, 0, index + 1)).toISOString();
    return { occurredAt, open: 10 + index, close: 11 + index, low: 9 + index, high: 12 + index, volume: 100 + index };
  });
  return {
    timeframe,
    bars,
    strokes: [
      { direction: "up", startAt: bars[0].occurredAt, endAt: bars[1].occurredAt, startPrice: 9, endPrice: 13, state: "confirmed" },
      { direction: "down", startAt: bars[1].occurredAt, endAt: bars[2].occurredAt, startPrice: 13, endPrice: 10, state: "provisional" },
    ],
    centers: [
      { startAt: bars[0].occurredAt, endAt: bars[2].occurredAt, lower: 10, upper: 12 },
    ],
  };
}

describe("Chan chart option", () => {
  it("renders real candlesticks, strokes, centers, and both zoom controls", () => {
    const option = buildChanChartOption(chartData());
    const series = option.series as Array<Record<string, unknown>>;
    const candle = series[0];
    const confirmed = series[1];
    const provisional = series[2];
    const centers = series[3];

    expect(candle.type).toBe("candlestick");
    expect((candle.data as number[][])[0]).toEqual([10, 11, 9, 12]);
    expect(candle.itemStyle).toMatchObject({ color: "#67baa1", color0: "#e56548" });
    expect(confirmed).toMatchObject({ type: "line", lineStyle: { color: "#67baa1", type: "solid" } });
    expect(provisional).toMatchObject({ type: "line", lineStyle: { color: "#e56548", type: "dashed" } });
    expect(centers.markArea).toMatchObject({
      itemStyle: { color: "rgba(228, 161, 95, 0.14)", borderColor: "#e4a15f" },
    });
    expect((option.dataZoom as Array<{ type: string }>).map((item) => item.type)).toEqual(["inside", "slider"]);
  });

  it("adds a linked volume grid with direction-colored bars", () => {
    const input = chartData(3);
    input.bars[1] = { ...input.bars[1], open: 12, close: 11, volume: 240 };
    input.bars[2] = { ...input.bars[2], volume: null };
    const option = buildChanChartOption(input);
    const series = option.series as Array<Record<string, unknown>>;
    const volume = series.find((item) => item.name === "成交量") as Record<string, unknown>;
    const dateValues = input.bars.map((bar) => bar.occurredAt);

    expect(volume).toBeDefined();
    const volumeData = volume.data as Array<{ value: number | null; itemStyle: { color: string } }>;
    expect(volume).toMatchObject({ name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1 });
    expect(volumeData).toEqual([
      { value: 100, itemStyle: { color: "#67baa1" } },
      { value: 240, itemStyle: { color: "#e56548" } },
      { value: null, itemStyle: { color: "#67baa1" } },
    ]);
    expect(option.grid).toHaveLength(2);
    expect(option.xAxis).toHaveLength(2);
    expect(option.yAxis).toHaveLength(2);
    expect((option.xAxis as Array<{ data: string[] }>).map((axis) => axis.data)).toEqual([dateValues, dateValues]);
    expect((option.dataZoom as Array<{ xAxisIndex: number[] }>).map((item) => item.xAxisIndex)).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(option.axisPointer).toMatchObject({ link: [{ xAxisIndex: "all" }] });
    for (const item of series.filter((candidate) => candidate.name !== "成交量")) {
      expect(item).toMatchObject({ xAxisIndex: 0, yAxisIndex: 0 });
    }
  });

  it("defaults to roughly six months for daily and weekly data", () => {
    const daily = buildChanChartOption(chartData(900, "1d"));
    const weekly = buildChanChartOption(chartData(260, "1w"));

    expect((daily.dataZoom as Array<{ start: number }>)[0].start).toBeCloseTo((900 - 126) / 9, 4);
    expect((weekly.dataZoom as Array<{ start: number }>)[0].start).toBeCloseTo(((260 - 26) / 260) * 100, 4);
  });

  it("formats OHLC and structure evidence in tooltips", () => {
    const input = chartData(3);
    const option = buildChanChartOption(input);
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const text = formatter([
      { axisValue: input.bars[0].occurredAt, seriesType: "candlestick", seriesName: "前复权 K 线", data: [0, 0, 0, 0] },
      { axisValue: input.bars[0].occurredAt, seriesType: "line", seriesName: "已确认笔 1", data: [input.bars[0].occurredAt, 9] },
    ]);
    const centerSeries = (option.series as Array<Record<string, unknown>>)[3];
    const markArea = centerSeries.markArea as { data: Array<Array<{ name?: string }>> };

    expect(text).toContain("2021-01-01");
    expect(text).toContain("开 10");
    expect(text).toContain("高 12");
    expect(text).toContain("成交量 100 手");
    expect(text).toContain("已确认笔 1");
    expect(markArea.data[0][0].name).toContain("笔中枢 10–12");
  });

  it("shows missing volume as a dash instead of zero", () => {
    const input = chartData(3);
    input.bars[1] = { ...input.bars[1], volume: null };
    const option = buildChanChartOption(input);
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const text = formatter([
      { axisValue: input.bars[1].occurredAt, seriesType: "bar", seriesName: "成交量", data: { value: null } },
    ]);

    expect(text).toContain("成交量 —");
    expect(text).not.toContain("成交量 0");
  });

  it("ignores the category index added to candlestick tooltip data", () => {
    const input = chartData(3);
    const option = buildChanChartOption(input);
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const text = formatter([
      {
        axisValue: input.bars[0].occurredAt,
        seriesType: "candlestick",
        seriesName: "前复权 K 线",
        data: [237, 37.56, 39.68, 35.2, 41.87],
      },
    ]);

    expect(text).toContain("开 10");
    expect(text).toContain("高 12");
    expect(text).toContain("低 9");
    expect(text).toContain("收 11");
    expect(text).not.toContain("开 237");
  });
});
