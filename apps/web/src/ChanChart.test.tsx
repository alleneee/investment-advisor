import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChanChart } from "./ChanChart";
import type { ChanChartData } from "./types";

const mocks = vi.hoisted(() => {
  const registeredModules: unknown[] = [];
  return {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    init: vi.fn(),
    use: vi.fn((modules: unknown[]) => registeredModules.push(...modules)),
    observe: vi.fn(),
    disconnect: vi.fn(),
    resizeCallback: null as ResizeObserverCallback | null,
    barChart: {},
    registeredModules,
  };
});

vi.mock("echarts/core", () => ({ init: mocks.init, use: mocks.use }));
vi.mock("echarts/charts", () => ({ BarChart: mocks.barChart, CandlestickChart: {}, LineChart: {} }));
vi.mock("echarts/components", () => ({
  DataZoomComponent: {},
  GridComponent: {},
  MarkAreaComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

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
    mocks.init.mockReturnValue({ setOption: mocks.setOption, resize: mocks.resize, dispose: mocks.dispose });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { mocks.resizeCallback = callback; }
      observe = mocks.observe;
      disconnect = mocks.disconnect;
      unobserve = vi.fn();
    });
  });

  it("initializes, replaces series on update, resizes, and disposes", () => {
    const { rerender, unmount } = render(<ChanChart symbol="600000.SH" data={data(3)} />);

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.setOption).toHaveBeenLastCalledWith(expect.any(Object), { notMerge: true });
    expect(screen.getByText("已确认笔")).toBeInTheDocument();
    expect(screen.getByText("形成中笔")).toBeInTheDocument();
    expect(screen.getByText("笔中枢")).toBeInTheDocument();

    rerender(<ChanChart symbol="600000.SH" data={data(1)} />);
    expect(mocks.init).toHaveBeenCalledOnce();
    const secondOption = mocks.setOption.mock.calls.at(-1)?.[0] as { series: unknown[] };
    expect(secondOption.series).toHaveLength(4);

    mocks.resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.resize).toHaveBeenCalledOnce();

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("shows an explicit empty state without initializing ECharts", () => {
    render(<ChanChart symbol="600000.SH" data={{ ...data(0), bars: [] }} />);

    expect(screen.getByText("当前周期暂无可绘制行情")).toBeInTheDocument();
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("cleans up and reinitializes when data becomes empty and returns", () => {
    const { rerender, unmount } = render(<ChanChart symbol="600000.SH" data={data()} />);
    const firstContainer = screen.getByRole("img");

    expect(mocks.observe).toHaveBeenNthCalledWith(1, firstContainer);

    rerender(<ChanChart symbol="600000.SH" data={{ ...data(), bars: [] }} />);
    expect(screen.getByText("当前周期暂无可绘制行情")).toBeInTheDocument();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();

    rerender(<ChanChart symbol="600000.SH" data={data()} />);
    const secondContainer = screen.getByRole("img");

    expect(secondContainer).not.toBe(firstContainer);
    expect(mocks.init).toHaveBeenCalledTimes(2);
    expect(mocks.init).toHaveBeenNthCalledWith(2, secondContainer, undefined, { renderer: "canvas" });
    expect(mocks.observe).toHaveBeenCalledTimes(2);
    expect(mocks.observe).toHaveBeenNthCalledWith(2, secondContainer);

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  });

  it("registers the ECharts bar chart module", () => {
    expect(mocks.registeredModules).toContain(mocks.barChart);
  });

  it("shows volume in the chart legend", () => {
    render(<ChanChart symbol="600000.SH" data={data()} />);

    expect(screen.getByText("成交量")).toBeInTheDocument();
  });

  it("names the graphic as a Chan and volume chart", () => {
    render(<ChanChart symbol="600000.SH" data={data()} />);

    expect(screen.getByRole("img", { name: "600000.SH 日线缠论及成交量图" })).toBeInTheDocument();
  });
});
