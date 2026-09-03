import { describe, expect, it } from "vitest";
import { normalizeTradingSymbol } from "./trading-symbol";

describe("normalizeTradingSymbol", () => {
  it("completes a six-digit SME code to SZ", () => {
    expect(normalizeTradingSymbol("002309")).toBe("002309.SZ");
    expect(normalizeTradingSymbol(" 002309.sz ")).toBe("002309.SZ");
  });

  it("completes a six-digit Shanghai code to SH", () => {
    expect(normalizeTradingSymbol("600156")).toBe("600156.SH");
  });
});
