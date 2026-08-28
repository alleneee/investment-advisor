import { describe, expect, it } from "vitest";
import { buildBsChartOption } from "./bs-chart-option";
import type { BsChart, BsChartExecution, ChartMark, ChartMarkType, TradingChartBar } from "./trading-types";

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

function execution(overrides: Partial<BsChartExecution> = {}): BsChartExecution {
  return {
    executionId: "execution-1",
    symbol: "600000.SH",
    occurredAt: "2026-08-10T10:00:00+08:00",
    barOccurredAt: "2026-08-10T00:00:00+08:00",
    side: "buy",
    price: "10.5",
    quantity: 100,
    fee: "0",
    primaryReason: "pullback_confirmation",
    ...overrides,
  };
}

function mark(overrides: Partial<ChartMark> = {}): ChartMark {
  return {
    markId: "mark-1",
    accountId: "account-1",
    symbol: "600000.SH",
    occurredAt: "2026-08-10T00:00:00+08:00",
    typeId: "type-buy",
    comment: "理想买",
    revision: 1,
    createdAt: "2026-08-10T10:00:00+08:00",
    updatedAt: "2026-08-10T10:00:00+08:00",
    ...overrides,
  };
}

function markType(overrides: Partial<ChartMarkType> = {}): ChartMarkType {
  return {
    typeId: "type-buy",
    accountId: "account-1",
    code: "ideal_buy",
    label: "理想买",
    letter: "买",
    color: "#f6465d",
    preset: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00+08:00",
    ...overrides,
  };
}

function chart(overrides: Partial<BsChart> = {}): BsChart {
  return {
    symbol: "600000.SH",
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [
      bar({ tradeDate: "2026-07-01", occurredAt: "2026-07-01T00:00:00+08:00", close: "9.5" }),
      bar(),
      bar({ tradeDate: "2026-08-11", occurredAt: "2026-08-11T00:00:00+08:00", open: "10.5", high: "12", low: "10", close: "11.5", volume: "1200" }),
    ],
    executions: [
      execution(),
      execution({
        executionId: "execution-2",
        side: "sell",
        price: "11.2",
        occurredAt: "2026-08-11T14:00:00+08:00",
        barOccurredAt: "2026-08-11T00:00:00+08:00",
        primaryReason: "take_profit",
      }),
    ],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "ok", warnings: [] },
    ...overrides,
  };
}

function seriesOf(option: ReturnType<typeof buildBsChartOption>): Array<Record<string, unknown>> {
  return option.series as Array<Record<string, unknown>>;
}

function seriesNamed(option: ReturnType<typeof buildBsChartOption>, name: string): Record<string, unknown> {
  const found = seriesOf(option).find((item) => item.name === name);
  if (!found) throw new Error(`missing series ${name}`);
  return found;
}

const types: ChartMarkType[] = [
  markType(),
  markType({ typeId: "type-review", code: "review", label: "复盘点", letter: "复", color: "#9b8cff", enabled: false }),
];

describe("BS 图 option", () => {
  it("用三个 grid 分别放 K 线、成交量和 MACD", () => {
    const option = buildBsChartOption(chart(), [], types, "2026-08-01", "2026-08-31");

    expect(option.grid).toHaveLength(3);
    expect(seriesNamed(option, "未复权 K 线")).toMatchObject({ type: "candlestick", xAxisIndex: 0, yAxisIndex: 0 });
    expect(seriesNamed(option, "成交量")).toMatchObject({ type: "bar", xAxisIndex: 1, yAxisIndex: 1 });
    expect(seriesNamed(option, "MACD")).toMatchObject({ type: "bar", xAxisIndex: 2, yAxisIndex: 2 });
    expect(seriesNamed(option, "DIF")).toMatchObject({ type: "line", xAxisIndex: 2, yAxisIndex: 2 });
    expect(seriesNamed(option, "DEA")).toMatchObject({ type: "line", xAxisIndex: 2, yAxisIndex: 2 });
  });

  it("实盘买卖 scatter 只来自 executions：买为红向上三角，卖为蓝向下三角", () => {
    const option = buildBsChartOption(chart(), [
      mark(),
      mark({ markId: "mark-2", typeId: "type-review", comment: "复盘" }),
    ], types, "2026-08-01", "2026-08-31");
    const buy = seriesNamed(option, "实际买入");
    const sell = seriesNamed(option, "实际卖出");

    expect(buy).toMatchObject({
      type: "scatter",
      xAxisIndex: 0,
      yAxisIndex: 0,
      symbol: "triangle",
      symbolRotate: 0,
      itemStyle: { color: "#f6465d" },
    });
    expect(sell).toMatchObject({
      type: "scatter",
      xAxisIndex: 0,
      yAxisIndex: 0,
      symbol: "triangle",
      symbolRotate: 180,
      itemStyle: { color: "#4a90e2" },
    });
    expect((buy.data as unknown[]).map((item) => (item as { execution: BsChartExecution }).execution.executionId)).toEqual(["execution-1"]);
    expect((sell.data as unknown[]).map((item) => (item as { execution: BsChartExecution }).execution.executionId)).toEqual(["execution-2"]);
    expect((buy.data as unknown[])).toHaveLength(1);
    expect((sell.data as unknown[])).toHaveLength(1);
  });

  it("手标用类型字母和颜色，同一根日 K 的多条都进入 series.data", () => {
    const option = buildBsChartOption(chart(), [
      mark(),
      mark({ markId: "mark-2", typeId: "type-review", comment: "复盘" }),
    ], types, "2026-08-01", "2026-08-31");
    const data = seriesNamed(option, "手标").data as Array<Record<string, unknown>>;

    expect(data).toHaveLength(2);
    expect(data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        letter: "买",
        itemStyle: expect.objectContaining({ color: "#f6465d" }),
      }),
      expect.objectContaining({
        letter: "复",
        itemStyle: expect.objectContaining({ color: "#9b8cff" }),
      }),
    ]));
    expect(new Set(data.map((item) => (item.value as unknown[])[0]))).toEqual(new Set(["2026-08-10"]));
  });

  it("MACD 未就绪时不发明柱，就绪后绘制与 K 线等长的序列", () => {
    const unread = buildBsChartOption(chart(), [], types, "2026-08-01", "2026-08-31");
    const unreadHistogram = (seriesNamed(unread, "MACD").data as unknown[]) ?? [];
    const unreadNumbers = unreadHistogram.flatMap((item) => {
      const value = typeof item === "object" && item !== null && "value" in item ? (item as { value: unknown }).value : item;
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });

    expect(unreadNumbers).toEqual([]);
    expect(unreadHistogram.every((item) => item == null || (typeof item === "object" && item !== null && (item as { value?: unknown }).value == null))).toBe(true);

    const ready = buildBsChartOption(chart({
      macd: { ready: true, dif: ["0.1", "0.2", "0.3"], dea: ["0.05", "0.1", "0.15"], histogram: ["0.1", "0.2", "0.3"] },
    }), [], types, "2026-08-01", "2026-08-31");

    expect((seriesNamed(ready, "MACD").data as unknown[])).toHaveLength(3);
    expect((seriesNamed(ready, "DIF").data as unknown[])).toEqual([0.1, 0.2, 0.3]);
    expect((seriesNamed(ready, "DEA").data as unknown[])).toEqual([0.05, 0.1, 0.15]);
  });

  it("dataZoom.start 对准 periodStart，找不到则从 0 开始", () => {
    const aligned = buildBsChartOption(chart(), [], types, "2026-08-01", "2026-08-31");
    const missing = buildBsChartOption(chart(), [], types, "2026-09-01", "2026-09-30");
    const zooms = aligned.dataZoom as Array<{ start: number; xAxisIndex: number[] }>;

    expect(zooms.map((item) => item.start)).toEqual([expect.closeTo(100 / 3), expect.closeTo(100 / 3)]);
    expect(zooms.map((item) => item.xAxisIndex)).toEqual([[0, 1, 2], [0, 1, 2]]);
    expect((missing.dataZoom as Array<{ start: number }>).map((item) => item.start)).toEqual([0, 0]);
  });
});
