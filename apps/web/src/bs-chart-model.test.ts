import { describe, expect, it } from "vitest";
import { barPaneReadout, formatPaneValue, macdPriceRange } from "./bs-chart-model";
import type { BsChart, TradingChartBar } from "./trading-types";

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

function chart(overrides: Partial<BsChart> = {}): BsChart {
  return {
    symbol: "600000.SH",
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [
      bar(),
      bar({ tradeDate: "2026-08-11", occurredAt: "2026-08-11T00:00:00+08:00", volume: "1257447.74" }),
    ],
    executions: [],
    macd: {
      ready: true,
      dif: ["0.10", "0.16374"],
      dea: ["0.05", "0.10766"],
      histogram: ["0.10", "0.11215"],
    },
    quality: { status: "ok", warnings: [] },
    ...overrides,
  };
}

describe("barPaneReadout", () => {
  it("returns volume and MACD strings for the selected bar", () => {
    expect(barPaneReadout(chart(), "2026-08-11T00:00:00+08:00")).toEqual({
      volume: "1257447.74",
      dif: "0.16374",
      dea: "0.10766",
      histogram: "0.11215",
    });
  });

  it("omits MACD numbers when the series is not ready", () => {
    expect(barPaneReadout(chart({ macd: { ready: false, dif: [], dea: [], histogram: [] } }), "2026-08-10T00:00:00+08:00")).toEqual({
      volume: "1000",
      dif: null,
      dea: null,
      histogram: null,
    });
  });
});

describe("formatPaneValue", () => {
  it("keeps compact decimals for MACD and groups large volume", () => {
    expect(formatPaneValue("0.16374")).toBe("0.1637");
    expect(formatPaneValue("1257447.74")).toBe("1,257,447.74");
    expect(formatPaneValue(null)).toBe("—");
  });
});

describe("macdPriceRange", () => {
  it("centers the visible scale on zero like Tonghuashun MACD", () => {
    const range = macdPriceRange(
      [{ value: 0.2 }],
      [{ value: 0.5 }],
      [{ value: -0.1 }],
    );
    expect(range).not.toBeNull();
    expect(range?.from).toBeCloseTo(-0.6);
    expect(range?.to).toBeCloseTo(0.6);
  });
});
