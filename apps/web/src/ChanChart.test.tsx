import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChanChart } from "./ChanChart";
import type { ChanChartData } from "./types";

const mocks = vi.hoisted(() => {
  const candlestickSeries = {
    setData: vi.fn(),
    attachPrimitive: vi.fn(),
    priceToCoordinate: vi.fn(),
  };
  const volumeSeries = { setData: vi.fn() };
  const timeScale = { setVisibleLogicalRange: vi.fn(), timeToCoordinate: vi.fn() };
  const panes = [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }];
  const chart = {
    addSeries: vi.fn(),
    addPane: vi.fn(),
    panes: vi.fn(() => panes),
    timeScale: vi.fn(() => timeScale),
    resize: vi.fn(),
    remove: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    takeScreenshot: vi.fn(),
  };
  return {
    candlestickDefinition: {},
    histogramDefinition: {},
    candlestickSeries,
    volumeSeries,
    timeScale,
    panes,
    chart,
    createChart: vi.fn(() => chart),
    observe: vi.fn(),
    disconnect: vi.fn(),
    resizeCallback: null as ResizeObserverCallback | null,
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: mocks.candlestickDefinition,
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  HistogramSeries: mocks.histogramDefinition,
  createChart: mocks.createChart,
}));

function data(strokeCount = 2): ChanChartData {
  const bars = [
    { occurredAt: "2024-08-01T00:00:00Z", open: 10, close: 11, low: 9, high: 12, volume: 100 },
    { occurredAt: "2024-08-02T00:00:00Z", open: 11, close: 12, low: 10, high: 13, volume: 120 },
  ];
  return {
    timeframe: "1d",
    bars,
    strokes: Array.from({ length: strokeCount }, (_, index) => ({
      direction: index % 2 ? "down" as const : "up" as const,
      startAt: bars[0].occurredAt,
      endAt: bars[1].occurredAt,
      startPrice: 9,
      endPrice: 13,
      state: index === strokeCount - 1 ? "provisional" as const : "confirmed" as const,
    })),
    centers: [{ startAt: bars[0].occurredAt, endAt: bars[1].occurredAt, lower: 10, upper: 12 }],
  };
}

describe("ChanChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chart.addSeries
      .mockReturnValueOnce(mocks.candlestickSeries)
      .mockReturnValueOnce(mocks.volumeSeries);
    mocks.chart.takeScreenshot.mockReturnValue({ toDataURL: vi.fn(() => "data:image/png;base64,chart") });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { mocks.resizeCallback = callback; }
      observe = mocks.observe;
      disconnect = mocks.disconnect;
      unobserve = vi.fn();
    });
  });

  it("creates one chart and updates native series without recreating it", () => {
    const { rerender, unmount } = render(<ChanChart symbol="600000.SH" data={data(3)} />);

    expect(mocks.createChart).toHaveBeenCalledOnce();
    expect(mocks.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      mocks.candlestickDefinition,
      expect.objectContaining({ upColor: "#f6465d", downColor: "#0ecb81" }),
      0,
    );
    expect(mocks.chart.addSeries).toHaveBeenNthCalledWith(
      2,
      mocks.histogramDefinition,
      expect.objectContaining({ priceFormat: { type: "volume" } }),
      1,
    );
    expect(mocks.candlestickSeries.attachPrimitive).toHaveBeenCalledOnce();
    expect(mocks.candlestickSeries.setData).toHaveBeenCalledOnce();
    expect(mocks.volumeSeries.setData).toHaveBeenCalledOnce();
    expect(mocks.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 0, to: 1 });

    rerender(<ChanChart symbol="600000.SH" data={data(1)} />);
    expect(mocks.createChart).toHaveBeenCalledOnce();
    expect(mocks.candlestickSeries.setData).toHaveBeenCalledTimes(2);
    expect(mocks.volumeSeries.setData).toHaveBeenCalledTimes(2);

    mocks.resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.chart.resize).toHaveBeenCalledOnce();

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.remove).toHaveBeenCalledOnce();
  });

  it("shows an explicit empty state without initializing a chart", () => {
    render(<ChanChart symbol="600000.SH" data={{ ...data(0), bars: [] }} />);

    expect(screen.getByText("当前周期暂无可绘制行情")).toBeInTheDocument();
    expect(mocks.createChart).not.toHaveBeenCalled();
  });

  it("cleans up and reinitializes when data becomes empty and returns", () => {
    const { rerender, unmount } = render(<ChanChart symbol="600000.SH" data={data()} />);
    const firstContainer = screen.getByRole("img");

    expect(mocks.observe).toHaveBeenNthCalledWith(1, firstContainer);

    rerender(<ChanChart symbol="600000.SH" data={{ ...data(), bars: [] }} />);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.remove).toHaveBeenCalledOnce();

    mocks.chart.addSeries
      .mockReturnValueOnce(mocks.candlestickSeries)
      .mockReturnValueOnce(mocks.volumeSeries);
    rerender(<ChanChart symbol="600000.SH" data={data()} />);
    const secondContainer = screen.getByRole("img");

    expect(secondContainer).not.toBe(firstContainer);
    expect(mocks.createChart).toHaveBeenCalledTimes(2);
    expect(mocks.observe).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("creates a printable image from the chart canvas", () => {
    const { container } = render(<ChanChart symbol="600000.SH" data={data()} />);

    fireEvent(window, new Event("beforeprint"));

    const image = container.querySelector<HTMLImageElement>(".chan-chart-print-image");
    expect(mocks.chart.takeScreenshot).toHaveBeenCalledWith(true, false);
    expect(image?.src).toBe("data:image/png;base64,chart");

    fireEvent(window, new Event("afterprint"));
    expect(container.querySelector(".chan-chart-print-image")).toBeNull();
  });

  it("keeps the chart legend and accessible name", () => {
    render(<ChanChart symbol="600000.SH" data={data()} />);

    expect(screen.getByText("已确认笔")).toBeInTheDocument();
    expect(screen.getByText("形成中笔")).toBeInTheDocument();
    expect(screen.getByText("笔中枢")).toBeInTheDocument();
    expect(screen.getByText("成交量")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "600000.SH 日线缠论及成交量图" })).toBeInTheDocument();
  });
});
