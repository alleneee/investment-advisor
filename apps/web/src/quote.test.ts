import { expect, it } from "vitest";
import { activeCenter, deriveQuote, formatCompact, formatTradeDate, strokeSummary } from "./quote";
import type { ChanChartData, ChartBar, ChartCenter, ChartStroke } from "./types";

function bar(day: number, open: number, close: number, low: number, high: number, volume: number | null = 1000): ChartBar {
  return { occurredAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`, open, close, low, high, volume };
}

function chart(partial: Partial<ChanChartData> = {}): ChanChartData {
  return { timeframe: "1d", bars: [], strokes: [], centers: [], ...partial };
}

function center(lower: number, upper: number, endDay = 21): ChartCenter {
  return { startAt: "2026-08-01T00:00:00Z", endAt: `2026-08-${endDay}T00:00:00Z`, lower, upper };
}

function stroke(direction: "up" | "down", state: "confirmed" | "provisional"): ChartStroke {
  return { direction, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-21T00:00:00Z", startPrice: 10, endPrice: 12, state };
}

it("derives the latest close, change and amplitude from the final two bars", () => {
  const quote = deriveQuote(chart({ bars: [bar(20, 40, 42, 39, 43), bar(21, 42, 44.1, 41.5, 44.8, 1500)] }));

  expect(quote).not.toBeNull();
  expect(quote!.last).toBe(44.1);
  expect(quote!.prevClose).toBe(42);
  expect(quote!.change).toBeCloseTo(2.1, 10);
  expect(quote!.changeRate).toBeCloseTo(0.05, 10);
  expect(quote!.amplitude).toBeCloseTo(3.3 / 42, 10);
  expect(quote!.volume).toBe(1500);
  expect(quote!.barCount).toBe(2);
});

it("returns null when there is no bar to quote", () => {
  expect(deriveQuote(chart())).toBeNull();
});

it("leaves change unavailable rather than guessing when only one bar exists", () => {
  const quote = deriveQuote(chart({ bars: [bar(21, 10, 11, 9, 12)] }));

  expect(quote!.last).toBe(11);
  expect(quote!.prevClose).toBeNull();
  expect(quote!.change).toBeNull();
  expect(quote!.changeRate).toBeNull();
  expect(quote!.amplitude).toBeNull();
});

it("keeps change absolute but rate unavailable when the previous close is zero", () => {
  const quote = deriveQuote(chart({ bars: [bar(20, 0, 0, 0, 0), bar(21, 1, 2, 1, 2)] }));

  expect(quote!.change).toBe(2);
  expect(quote!.changeRate).toBeNull();
  expect(quote!.amplitude).toBeNull();
});

it("places the latest close inside the newest center that still contains it", () => {
  const data = chart({ bars: [bar(21, 11, 12, 10, 13)], centers: [center(30, 34, 10), center(10, 14)] });

  expect(activeCenter(data)).toEqual({ lower: 10, upper: 14, position: "inside" });
});

it("reports the newest center as reference when the price has left every center", () => {
  const above = chart({ bars: [bar(21, 15, 16, 15, 17)], centers: [center(10, 14)] });
  const below = chart({ bars: [bar(21, 8, 7, 6, 9)], centers: [center(10, 14)] });

  expect(activeCenter(above)).toEqual({ lower: 10, upper: 14, position: "above" });
  expect(activeCenter(below)).toEqual({ lower: 10, upper: 14, position: "below" });
});

it("has no active center without centers or bars", () => {
  expect(activeCenter(chart({ bars: [bar(21, 11, 12, 10, 13)] }))).toBeNull();
  expect(activeCenter(chart({ centers: [center(10, 14)] }))).toBeNull();
});

it("counts confirmed and forming strokes and reports the last direction", () => {
  const data = chart({ strokes: [stroke("up", "confirmed"), stroke("down", "confirmed"), stroke("up", "provisional")] });

  expect(strokeSummary(data)).toEqual({ confirmed: 2, provisional: 1, lastDirection: "up" });
});

it("reports no direction when there is no stroke", () => {
  expect(strokeSummary(chart())).toEqual({ confirmed: 0, provisional: 0, lastDirection: null });
});

it("compacts large volumes onto 万 and 亿 units", () => {
  expect(formatCompact(1500)).toBe("1500");
  expect(formatCompact(23456)).toBe("2.35万");
  expect(formatCompact(987654321)).toBe("9.88亿");
  expect(formatCompact(null)).toBe("—");
});

it("dashes compact trade dates and leaves already formatted ones alone", () => {
  expect(formatTradeDate("20260821")).toBe("2026-08-21");
  expect(formatTradeDate("2026-08-11")).toBe("2026-08-11");
  expect(formatTradeDate("")).toBe("—");
  expect(formatTradeDate("not-a-date")).toBe("not-a-date");
});
