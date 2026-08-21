import { describe, expect, it } from "vitest";
import { formatMoney, formatRate, formatSignedMoney, signedTone } from "./formatDisplay";

describe("formatDisplay", () => {
  it("groups only the integer side of decimal money text", () => {
    expect(formatMoney("100000.00")).toBe("100,000.00");
    expect(formatMoney("-350.50")).toBe("-350.50");
    expect(formatMoney("not-a-price")).toBe("not-a-price");
  });

  it("adds a plus to positive pnl and leaves zero unsigned", () => {
    expect(formatSignedMoney("350.50")).toBe("+350.50");
    expect(formatSignedMoney("-1280.00")).toBe("-1,280.00");
    expect(formatSignedMoney("0.00")).toBe("0.00");
  });

  it("formats 0-1 rates like the current UI", () => {
    expect(formatRate("1")).toBe("100.00%");
    expect(formatRate("-0.012")).toBe("-1.20%");
    expect(formatRate("0.0198")).toBe("1.98%");
    expect(formatRate("nope")).toBe("nope");
  });

  it("maps signed text to A-share tones", () => {
    expect(signedTone("350.50")).toBe("up");
    expect(signedTone("-1")).toBe("down");
    expect(signedTone("0.00")).toBe("neutral");
  });
});
