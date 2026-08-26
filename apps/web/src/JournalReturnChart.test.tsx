import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JournalReturnChart } from "./JournalReturnChart";
import type { TradingPeriodSummary } from "./trading-types";

const mocks = vi.hoisted(() => {
  const chart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
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

function summary(returnCurve: TradingPeriodSummary["returnCurve"]): TradingPeriodSummary {
  return {
    start: "2026-08-01",
    end: "2026-08-31",
    maxDrawdown: null,
    returnCurve,
  };
}

function point(date: string, value: string | null): TradingPeriodSummary["returnCurve"][number] {
  return {
    date,
    cumulativeReturnRate: {
      value,
      unavailableReason: value === null ? "valuation_unavailable" : null,
    },
  };
}

describe("JournalReturnChart", () => {
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

  it("收益摘要尚未返回时显示读取状态且不初始化图表", () => {
    render(<JournalReturnChart periodKind="month" summary={undefined} />);

    expect(screen.getByText("正在读取收益曲线…")).toBeInTheDocument();
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("收益曲线没有有限数值时显示空状态且不初始化图表", () => {
    render(<JournalReturnChart
      periodKind="week"
      summary={summary([
        point("2026-08-24", null),
        point("2026-08-25", "NaN"),
        point("2026-08-26", "Infinity"),
      ])}
    />);

    expect(screen.getByText("该周期暂无可用收益数据")).toBeInTheDocument();
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("单个有效点显示格式化零收益并设置图表 option", () => {
    const periodSummary = summary([point("2026-08-26", "0")]);

    render(<JournalReturnChart periodKind="month" summary={periodSummary} />);

    expect(screen.getByText("本月累计收益")).toBeInTheDocument();
    expect(screen.getByText("0.00%", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "本月累计收益曲线" })).toBeInTheDocument();
    expect(mocks.chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        xAxis: expect.objectContaining({ data: ["2026-08-26"] }),
      }),
      { notMerge: true },
    );
  });

  it.each([
    ["正收益", "0.0123", "1.23%", "tone-gain"],
    ["负收益", "-0.0123", "-1.23%", "tone-loss"],
  ])("%s使用对应 tone", (_label, value, text, tone) => {
    render(<JournalReturnChart periodKind="quarter" summary={summary([point("2026-08-26", value)])} />);

    expect(screen.getByText(text, { selector: "strong" })).toHaveClass(tone);
  });

  it("零收益不使用 gain 或 loss tone", () => {
    render(<JournalReturnChart periodKind="year" summary={summary([point("2026-08-26", "0")])} />);

    const value = screen.getByText("0.00%", { selector: "strong" });
    expect(value).not.toHaveClass("tone-gain");
    expect(value).not.toHaveClass("tone-loss");
  });

  it("最后日期不可用时用最后一个有效值显示标题与 tone", () => {
    render(<JournalReturnChart
      periodKind="week"
      summary={summary([
        point("2026-08-24", "-0.0245"),
        point("2026-08-25", null),
      ])}
    />);

    expect(screen.getByText("本周累计收益")).toBeInTheDocument();
    expect(screen.getByText("-2.45%", { selector: "strong" })).toHaveClass("tone-loss");
  });

  it("有效曲线更新时复用图表实例和尺寸观察器", () => {
    const { rerender } = render(
      <JournalReturnChart periodKind="month" summary={summary([point("2026-08-25", "0.01")])} />,
    );

    rerender(
      <JournalReturnChart
        periodKind="month"
        summary={summary([
          point("2026-08-25", "0.01"),
          point("2026-08-26", "0.02"),
        ])}
      />,
    );

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.chart.setOption).toHaveBeenCalledTimes(2);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.chart.dispose).not.toHaveBeenCalled();
  });

  it("用关联的语义数据表描述每个收益日期", () => {
    render(<JournalReturnChart
      periodKind="month"
      summary={summary([
        point("2026-08-25", "0.0123"),
        point("2026-08-26", null),
      ])}
    />);

    const chart = screen.getByRole("img", { name: "本月累计收益曲线" });
    const table = screen.getByRole("table", { name: "本月累计收益数据" });
    expect(table).toHaveTextContent("2026-08-25");
    expect(table).toHaveTextContent("1.23%");
    expect(table).toHaveTextContent("2026-08-26");
    expect(table).toHaveTextContent("valuation_unavailable");
    expect(chart).toHaveAttribute("aria-describedby", table.id);
  });

  it("尺寸变化时调整图表，卸载时断开观察并销毁实例", () => {
    const { unmount } = render(
      <JournalReturnChart periodKind="month" summary={summary([point("2026-08-26", "0.01")])} />,
    );
    const container = screen.getByRole("img", { name: "本月累计收益曲线" });

    expect(mocks.observe).toHaveBeenCalledWith(container);
    mocks.resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.chart.resize).toHaveBeenCalledOnce();

    unmount();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.dispose).toHaveBeenCalledOnce();
  });

  it("有效曲线变为空时断开观察并销毁图表实例", () => {
    const { rerender } = render(
      <JournalReturnChart periodKind="month" summary={summary([point("2026-08-26", "0.01")])} />,
    );

    rerender(<JournalReturnChart periodKind="month" summary={summary([point("2026-08-26", null)])} />);

    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.chart.dispose).toHaveBeenCalledOnce();
    expect(screen.getByText("该周期暂无可用收益数据")).toBeInTheDocument();
  });
});
