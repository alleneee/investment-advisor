import { describe, expect, it, vi } from "vitest";
import {
  buildChanChartModel,
  ChanOverlayPrimitive,
  formatChanTooltip,
} from "./chan-chart-option";
import type { ChanChartData, Timeframe } from "./types";

function chartData(count = 900, timeframe: Timeframe = "1d"): ChanChartData {
  const bars = Array.from({ length: count }, (_, index) => {
    const occurredAt = new Date(Date.UTC(2021, 0, index + 1)).toISOString();
    return {
      occurredAt,
      open: 10 + index,
      close: 11 + index,
      low: 9 + index,
      high: 12 + index,
      volume: 100 + index,
    };
  });
  return {
    timeframe,
    bars,
    strokes: [
      {
        direction: "up",
        startAt: bars[0].occurredAt,
        endAt: bars[1].occurredAt,
        startPrice: 9,
        endPrice: 13,
        state: "confirmed",
      },
      {
        direction: "down",
        startAt: bars[1].occurredAt,
        endAt: bars[2].occurredAt,
        startPrice: 13,
        endPrice: 10,
        state: "provisional",
      },
    ],
    centers: [
      {
        startAt: bars[0].occurredAt,
        endAt: bars[2].occurredAt,
        lower: 10,
        upper: 12,
      },
    ],
  };
}

describe("Lightweight Chan chart model", () => {
  it("maps candlesticks, volume, strokes, centers, and the initial range", () => {
    const input = chartData();
    input.bars[1] = { ...input.bars[1], open: 12, close: 11, volume: 240 };
    input.bars[2] = { ...input.bars[2], volume: null };

    const model = buildChanChartModel(input);

    expect(model.candlesticks[0]).toEqual({
      time: "2021-01-01",
      open: 10,
      high: 12,
      low: 9,
      close: 11,
    });
    expect(model.volume.slice(0, 3)).toEqual([
      { time: "2021-01-01", value: 100, color: "#f6465d" },
      { time: "2021-01-02", value: 240, color: "#0ecb81" },
      { time: "2021-01-03" },
    ]);
    expect(model.strokes).toEqual([
      {
        startAt: "2021-01-01",
        endAt: "2021-01-02",
        startPrice: 9,
        endPrice: 13,
        state: "confirmed",
      },
      {
        startAt: "2021-01-02",
        endAt: "2021-01-03",
        startPrice: 13,
        endPrice: 10,
        state: "provisional",
      },
    ]);
    expect(model.centers).toEqual([
      { startAt: "2021-01-01", endAt: "2021-01-03", lower: 10, upper: 12 },
    ]);
    expect(model.segmentCenters).toEqual([]);
    expect(model.visibleRange).toEqual({ from: 774, to: 899 });
  });

  it("draws stroke centers even when a historical segment center exists", () => {
    const input = chartData(3);
    input.segmentCenters = [{
      startAt: input.bars[0].occurredAt,
      endAt: input.bars[2].occurredAt,
      lower: 8,
      upper: 14,
    }];

    const model = buildChanChartModel(input);

    expect(model.centers).toEqual([
      { startAt: "2021-01-01", endAt: "2021-01-03", lower: 10, upper: 12 },
    ]);
    expect(model.segmentCenters).toEqual([
      { startAt: "2021-01-01", endAt: "2021-01-03", lower: 8, upper: 14 },
    ]);
  });

  it("defaults to roughly six months for weekly data", () => {
    expect(buildChanChartModel(chartData(260, "1w")).visibleRange).toEqual({ from: 234, to: 259 });
  });

  it("formats OHLC, missing volume, strokes, and centers for the crosshair", () => {
    const input = chartData(3);
    input.bars[1] = { ...input.bars[1], volume: null };

    expect(formatChanTooltip(input, "2021-01-01")).toContain("成交量 100 手");
    const text = formatChanTooltip(input, "2021-01-02");
    expect(text).toContain("2021-01-02");
    expect(text).toContain("开 11");
    expect(text).toContain("高 13");
    expect(text).toContain("成交量 —");
    expect(text).toContain("形成中笔");
    expect(text).toContain("笔中枢 10–12");
    input.segmentCenters = [{ startAt: input.bars[0].occurredAt, endAt: input.bars[2].occurredAt, lower: 8, upper: 14 }];
    expect(formatChanTooltip(input, "2021-01-02")).toContain("线段中枢 8–14");
  });
});

describe("ChanOverlayPrimitive", () => {
  it("draws stroke centers in front of segment centers, plus confirmed and provisional strokes", () => {
    const input = chartData(3);
    input.segmentCenters = [{ startAt: input.bars[0].occurredAt, endAt: input.bars[2].occurredAt, lower: 8, upper: 14 }];
    const model = buildChanChartModel(input);
    const primitive = new ChanOverlayPrimitive(model.strokes, model.centers, model.segments, model.segmentCenters);
    const requestUpdate = vi.fn();
    const fillRect = vi.fn();
    const strokeRect = vi.fn();
    const stroke = vi.fn();
    const setLineDash = vi.fn();
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillRect,
      strokeRect,
      stroke,
      setLineDash,
      save: vi.fn(),
      restore: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const chart = {
      timeScale: () => ({
        timeToCoordinate: (time: string) => ({
          "2021-01-01": 10,
          "2021-01-02": 20,
          "2021-01-03": 30,
        })[time] ?? null,
      }),
    };
    const series = { priceToCoordinate: (price: number) => 200 - price * 10 };
    primitive.attached?.({ chart, series, requestUpdate } as never);
    primitive.updateAllViews?.();
    const renderer = primitive.paneViews?.()[0]?.renderer();
    renderer?.draw({
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context,
        horizontalPixelRatio: 2,
        verticalPixelRatio: 2,
      }),
    } as never);

    expect(fillRect).toHaveBeenCalledTimes(2);
    expect(stroke).toHaveBeenCalledTimes(2);
    expect(setLineDash).toHaveBeenCalledWith([]);
    expect(setLineDash).toHaveBeenCalledWith([8, 6]);

    primitive.setData([], []);
    expect(requestUpdate).toHaveBeenCalledOnce();
  });
});
