import { describe, expect, it } from "vitest";
import { macdStickWidth } from "./bs-chart-macd";

describe("macdStickWidth", () => {
  it("grows with bar spacing so zoomed charts do not leave huge gaps", () => {
    expect(macdStickWidth(6)).toBeCloseTo(2.88);
    expect(macdStickWidth(50)).toBeCloseTo(24);
  });
});
