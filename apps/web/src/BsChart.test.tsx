import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BsChart } from "./BsChart";
import type { BsChart as BsChartData, ChartMark, ChartMarkType, TradingChartBar } from "./trading-types";

const mocks = vi.hoisted(() => {
  const candlestickSeries = { setData: vi.fn() };
  const volumeSeries = { setData: vi.fn() };
  const histogramSeries = { setData: vi.fn() };
  const priceScale = { setAutoScale: vi.fn(), setVisibleRange: vi.fn(), applyOptions: vi.fn() };
  const difSeries = { setData: vi.fn(), attachPrimitive: vi.fn(), createPriceLine: vi.fn(), priceScale: vi.fn(() => priceScale) };
  const deaSeries = { setData: vi.fn() };
  const markers = { setMarkers: vi.fn() };
  const timeScale = { setVisibleLogicalRange: vi.fn(), coordinateToTime: vi.fn() };
  const paneAddSeries = vi.fn();
  const extraPane = () => ({ setStretchFactor: vi.fn(), addSeries: paneAddSeries });
  const panes = [{ setStretchFactor: vi.fn() }, extraPane(), extraPane()];
  const chart = {
    addSeries: vi.fn(),
    addPane: vi.fn(() => extraPane()),
    panes: vi.fn(() => panes),
    timeScale: vi.fn(() => timeScale),
    resize: vi.fn(),
    remove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    setCrosshairPosition: vi.fn(),
  };
  return {
    candlestickDefinition: {},
    histogramDefinition: {},
    lineDefinition: {},
    candlestickSeries,
    volumeSeries,
    histogramSeries,
    priceScale,
    difSeries,
    deaSeries,
    markers,
    timeScale,
    paneAddSeries,
    panes,
    chart,
    createChart: vi.fn(() => chart),
    createSeriesMarkers: vi.fn(() => markers),
    observe: vi.fn(),
    disconnect: vi.fn(),
    resizeCallback: null as ResizeObserverCallback | null,
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: mocks.candlestickDefinition,
  HistogramSeries: mocks.histogramDefinition,
  LineSeries: mocks.lineDefinition,
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  createChart: mocks.createChart,
  createSeriesMarkers: mocks.createSeriesMarkers,
}));

function bar(overrides: Partial<TradingChartBar> = {}): TradingChartBar {
  return {
    tradeDate: "2026-08-10",
    occurredAt: "2026-08-10T00:00:00+08:00",
    open: "10",
    high: "11",
    low: "9",
    close: "10.5",
    volume: "1000",
    ...overrides,
  };
}

function chartData(overrides: Partial<BsChartData> = {}): BsChartData {
  return {
    symbol: "600000.SH",
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [
      bar(),
      bar({ tradeDate: "2026-08-11", occurredAt: "2026-08-11T00:00:00+08:00", open: "10.5", close: "11", high: "12", low: "10" }),
    ],
    executions: [],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "ok", warnings: [] },
    ...overrides,
  };
}

const types: ChartMarkType[] = [{
  typeId: "type-1",
  accountId: "account-1",
  code: "ideal_buy",
  label: "理想买",
  letter: "买",
  color: "#f6465d",
  preset: true,
  enabled: true,
  createdAt: "2026-08-01T00:00:00+08:00",
}];

const marks: ChartMark[] = [];

function renderChart(overrides: {
  chart?: BsChartData;
  marks?: ChartMark[];
  highlightOccurredAt?: string | null;
  onSelectBar?: (occurredAt: string) => void;
} = {}) {
  return render(
    <BsChart
      chart={overrides.chart ?? chartData()}
      marks={overrides.marks ?? marks}
      types={types}
      periodStart="2026-08-01"
      periodEnd="2026-08-31"
      highlightOccurredAt={overrides.highlightOccurredAt ?? null}
      onSelectBar={overrides.onSelectBar}
    />,
  );
}

describe("BsChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resizeCallback = null;
    mocks.chart.addSeries.mockReturnValueOnce(mocks.candlestickSeries);
    mocks.paneAddSeries
      .mockReturnValueOnce(mocks.volumeSeries)
      .mockReturnValueOnce(mocks.histogramSeries)
      .mockReturnValueOnce(mocks.difSeries)
      .mockReturnValueOnce(mocks.deaSeries);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { mocks.resizeCallback = callback; }
      observe = mocks.observe;
      disconnect = mocks.disconnect;
      unobserve = vi.fn();
    });
  });

  it("行情不可用且没有 K 线时显示空态且不初始化图表", () => {
    renderChart({
      chart: chartData({
        available: false,
        bars: [],
        quality: { status: "unavailable", warnings: ["stk_mins failed"] },
      }),
    });

    expect(screen.getByText("行情不可用")).toBeInTheDocument();
    expect(screen.queryByText("MACD 未就绪")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(mocks.createChart).not.toHaveBeenCalled();
  });

  it("有 K 线但 MACD 未就绪时绘制与结构报告相同的 lightweight-charts 蜡烛图", () => {
    renderChart();

    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByText("MACD 未就绪")).toBeInTheDocument();
    expect(mocks.createChart).toHaveBeenCalledOnce();
    expect(mocks.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      mocks.candlestickDefinition,
      expect.objectContaining({ upColor: "#f6465d", downColor: "#0ecb81" }),
    );
    expect(mocks.candlestickSeries.setData).toHaveBeenCalledOnce();
    expect(mocks.volumeSeries.setData).toHaveBeenCalledOnce();
  });

  it("贴齐最后一根 K 线，不按柱宽在右侧留空", () => {
    renderChart();

    expect(mocks.createChart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        timeScale: expect.objectContaining({ rightOffset: 0, fixRightEdge: true }),
      }),
    );
  });

  it("MACD 就绪时把 DIF、DEA 画进副图，图例标明 MACD 线", () => {
    renderChart({
      chart: chartData({
        macd: {
          ready: true,
          dif: ["0.10", "0.20"],
          dea: ["0.05", "0.10"],
          histogram: ["0.10", "0.20"],
        },
      }),
    });

    expect(screen.queryByText("MACD 未就绪")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("data-pane-count", "3");
    const macdLegend = screen.getByLabelText("MACD 图例");
    expect(macdLegend).toHaveTextContent("DIF");
    expect(macdLegend).toHaveTextContent("DEA");
    expect(macdLegend).toHaveTextContent("MACD柱");
    expect(screen.getByText("DIF")).toHaveStyle({ color: "#e5e2e1" });
    expect(screen.getByText("DEA")).toHaveStyle({ color: "#f5a623" });
    expect(mocks.paneAddSeries).toHaveBeenNthCalledWith(
      2,
      mocks.histogramDefinition,
      expect.objectContaining({ base: 0, visible: false }),
    );
    expect(mocks.difSeries.attachPrimitive).toHaveBeenCalledOnce();
    expect(mocks.difSeries.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 0 }));
    expect(mocks.priceScale.setVisibleRange).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.any(Number),
      to: expect.any(Number),
    }));
    const range = mocks.priceScale.setVisibleRange.mock.calls[0]?.[0] as { from: number; to: number };
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(0);
    expect(mocks.paneAddSeries).toHaveBeenNthCalledWith(
      3,
      mocks.lineDefinition,
      expect.objectContaining({ color: "#e5e2e1", lineWidth: 2 }),
    );
    expect(mocks.paneAddSeries).toHaveBeenNthCalledWith(
      4,
      mocks.lineDefinition,
      expect.objectContaining({ color: "#f5a623", lineWidth: 2 }),
    );
    expect(mocks.difSeries.setData).toHaveBeenCalledWith([
      { time: "2026-08-10", value: 0.1 },
      { time: "2026-08-11", value: 0.2 },
    ]);
    expect(mocks.deaSeries.setData).toHaveBeenCalledWith([
      { time: "2026-08-10", value: 0.05 },
      { time: "2026-08-11", value: 0.1 },
    ]);
    expect(mocks.histogramSeries.setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: "2026-08-10", value: 0.1 }),
      expect.objectContaining({ time: "2026-08-11", value: 0.2 }),
    ]);
  });

  it("十字线落到某根 K 线时成交量和 MACD 数值显示在对应副图左上", () => {
    renderChart({
      chart: chartData({
        bars: [
          bar({ volume: "1000" }),
          bar({
            tradeDate: "2026-08-11",
            occurredAt: "2026-08-11T00:00:00+08:00",
            volume: "1257447.74",
            close: "11",
          }),
        ],
        macd: {
          ready: true,
          dif: ["0.10", "0.1637"],
          dea: ["0.05", "0.1077"],
          histogram: ["0.10", "0.1121"],
        },
      }),
    });
    const move = mocks.chart.subscribeCrosshairMove.mock.calls[0]?.[0] as ((params: { time?: string }) => void) | undefined;

    move?.({ time: "2026-08-11" });

    expect(screen.getByLabelText("成交量读数")).toHaveTextContent("1,257,447.74");
    expect(screen.getByLabelText("MACD 图例")).toHaveTextContent("0.1637");
    expect(screen.getByLabelText("MACD 图例")).toHaveTextContent("0.1077");
    expect(screen.getByLabelText("MACD 图例")).toHaveTextContent("0.1121");
  });

  it("30 分钟图按柱时间 highlight", () => {
    renderChart({
      chart: chartData({
        timeframe: "30m",
        bars: [
          bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:00:00+08:00" }),
          bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:30:00+08:00", close: "11" }),
        ],
      }),
      highlightOccurredAt: "2026-08-10T10:30:00+08:00",
    });

    expect(mocks.chart.setCrosshairPosition).toHaveBeenCalledWith(
      11,
      Math.floor(new Date("2026-08-10T10:30:00+08:00").getTime() / 1000),
      mocks.candlestickSeries,
    );
  });

  it("点击 K 线通过 onSelectBar 回传 occurredAt", () => {
    const onSelectBar = vi.fn();
    renderChart({ onSelectBar });
    const click = mocks.chart.subscribeClick.mock.calls[0]?.[0] as ((params: { time?: string }) => void) | undefined;

    click?.({ time: "2026-08-11" });

    expect(onSelectBar).toHaveBeenCalledWith("2026-08-11T00:00:00+08:00");
  });

  it("十字线锁在一根柱上时，再点另一根用点击位置回传新柱", () => {
    const onSelectBar = vi.fn();
    mocks.timeScale.coordinateToTime.mockReturnValue("2026-08-11");
    renderChart({
      onSelectBar,
      highlightOccurredAt: "2026-08-10T00:00:00+08:00",
    });
    const click = mocks.chart.subscribeClick.mock.calls[0]?.[0] as ((params: { time?: string; point?: { x: number; y: number } }) => void) | undefined;

    click?.({ time: "2026-08-10", point: { x: 400, y: 40 } });

    expect(mocks.timeScale.coordinateToTime).toHaveBeenCalledWith(400);
    expect(onSelectBar).toHaveBeenCalledWith("2026-08-11T00:00:00+08:00");
  });

  it("尺寸变化时调整图表，卸载时断开观察并销毁实例", () => {
    const { unmount } = renderChart();
    const container = screen.getByRole("img");

    expect(mocks.observe).toHaveBeenCalledWith(container);
    mocks.chart.resize.mockClear();
    mocks.resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.chart.resize).toHaveBeenCalled();

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.remove).toHaveBeenCalledOnce();
  });

  it("有效行情变为不可用时断开观察并销毁图表实例", () => {
    const { rerender } = renderChart();

    rerender(
      <BsChart
        chart={chartData({ available: false, bars: [] })}
        marks={marks}
        types={types}
        periodStart="2026-08-01"
        periodEnd="2026-08-31"
        highlightOccurredAt={null}
      />,
    );

    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.remove).toHaveBeenCalledOnce();
    expect(screen.getByText("行情不可用")).toBeInTheDocument();
  });
});
