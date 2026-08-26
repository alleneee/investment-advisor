import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BsChart } from "./BsChart";
import type { BsChart as BsChartData, ChartMark, ChartMarkType, TradingChartBar } from "./trading-types";

const mocks = vi.hoisted(() => {
  const chart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    dispatchAction: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    chart,
    init: vi.fn(() => chart),
    use: vi.fn(),
    observe: vi.fn(),
    disconnect: vi.fn(),
    resizeCallback: null as ResizeObserverCallback | null,
  };
});

vi.mock("echarts/core", () => ({
  init: mocks.init,
  use: mocks.use,
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
  highlightOccurredAt?: string | null;
  onSelectBar?: (occurredAt: string) => void;
} = {}) {
  return render(
    <BsChart
      chart={overrides.chart ?? chartData()}
      marks={marks}
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
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("有 K 线但 MACD 未就绪时绘制图表并显示 MACD 未就绪", () => {
    renderChart();

    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByText("MACD 未就绪")).toBeInTheDocument();
    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ grid: expect.any(Array) }),
      { notMerge: true },
    );
  });

  it("MACD 就绪时不显示未就绪文案", () => {
    renderChart({
      chart: chartData({
        macd: { ready: true, dif: ["0.1", "0.2"], dea: ["0.05", "0.1"], histogram: ["0.1", "0.2"] },
      }),
    });

    expect(screen.queryByText("MACD 未就绪")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("highlightOccurredAt 非空时对对应类目 dispatch highlight 与 updateAxisPointer", () => {
    renderChart({ highlightOccurredAt: "2026-08-11T00:00:00+08:00" });

    expect(mocks.chart.dispatchAction).toHaveBeenCalledWith({
      type: "highlight",
      seriesIndex: 0,
      dataIndex: 1,
    });
    expect(mocks.chart.dispatchAction).toHaveBeenCalledWith({
      type: "updateAxisPointer",
      seriesIndex: 0,
      dataIndex: 1,
    });
  });

  it("30 分钟图按柱时间 highlight", () => {
    renderChart({
      chart: chartData({
        timeframe: "30m",
        bars: [
          bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:00:00+08:00" }),
          bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:30:00+08:00" }),
        ],
      }),
      highlightOccurredAt: "2026-08-10T10:30:00+08:00",
    });

    expect(mocks.chart.dispatchAction).toHaveBeenCalledWith(expect.objectContaining({
      type: "updateAxisPointer",
      dataIndex: 1,
    }));
  });

  it("点击 K 线通过 onSelectBar 回传 occurredAt，不在 option 里发请求", () => {
    const onSelectBar = vi.fn();
    renderChart({ onSelectBar });
    const click = mocks.chart.on.mock.calls.find(([event]) => event === "click")?.[1] as ((params: unknown) => void) | undefined;

    click?.({ componentType: "series", seriesType: "candlestick", dataIndex: 1 });

    expect(onSelectBar).toHaveBeenCalledWith("2026-08-11T00:00:00+08:00");
    expect(JSON.stringify(mocks.chart.setOption.mock.calls[0]?.[0])).not.toMatch(/\/api\/trading\/chart-marks/);
  });

  it("尺寸变化时调整图表，卸载时断开观察并销毁实例", () => {
    const { unmount } = renderChart();
    const container = screen.getByRole("img");

    expect(mocks.observe).toHaveBeenCalledWith(container);
    mocks.resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.chart.resize).toHaveBeenCalledOnce();

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.dispose).toHaveBeenCalledOnce();
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
    expect(mocks.chart.dispose).toHaveBeenCalledOnce();
    expect(screen.getByText("行情不可用")).toBeInTheDocument();
  });
});
