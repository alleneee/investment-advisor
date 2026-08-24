import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { QuoteBand } from "./QuoteBand";
import type { ChanChartData } from "../types";

function chart(partial: Partial<ChanChartData> = {}): ChanChartData {
  return { timeframe: "1d", bars: [], strokes: [], centers: [], ...partial };
}

const rising = chart({
  bars: [
    { occurredAt: "2026-08-20T00:00:00Z", open: 40, close: 42, low: 39, high: 43, volume: 1000 },
    { occurredAt: "2026-08-21T00:00:00Z", open: 42, close: 44.1, low: 41.5, high: 44.8, volume: 23456 },
  ],
  centers: [{ startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-19T00:00:00Z", lower: 38, upper: 43 }],
  strokes: [
    { direction: "up", startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-20T00:00:00Z", startPrice: 38, endPrice: 43, state: "confirmed" },
    { direction: "up", startAt: "2026-08-20T00:00:00Z", endAt: "2026-08-21T00:00:00Z", startPrice: 43, endPrice: 44.8, state: "provisional" },
  ],
});

it("leads with the latest close and a signed change rate toned red for a rise", () => {
  render(<QuoteBand chart={rising} />);

  const price = screen.getByLabelText("最新收盘");
  expect(price).toHaveTextContent("44.10");
  expect(price).toHaveClass("tone-up");
  expect(screen.getByLabelText("涨跌幅")).toHaveTextContent("+5.00%");
  expect(screen.getByLabelText("涨跌额")).toHaveTextContent("+2.10");
});

it("tones a decline green and keeps the sign explicit", () => {
  const falling = chart({
    bars: [
      { occurredAt: "2026-08-20T00:00:00Z", open: 40, close: 50, low: 39, high: 51, volume: 10 },
      { occurredAt: "2026-08-21T00:00:00Z", open: 49, close: 45, low: 44, high: 49, volume: 10 },
    ],
  });

  render(<QuoteBand chart={falling} />);

  expect(screen.getByLabelText("最新收盘")).toHaveClass("tone-down");
  expect(screen.getByLabelText("涨跌幅")).toHaveTextContent("-10.00%");
});

it("surfaces open, high, low, amplitude and compacted volume as secondary metrics", () => {
  render(<QuoteBand chart={rising} />);

  expect(screen.getByLabelText("今开")).toHaveTextContent("42.00");
  expect(screen.getByLabelText("最高")).toHaveTextContent("44.80");
  expect(screen.getByLabelText("最低")).toHaveTextContent("41.50");
  expect(screen.getByLabelText("振幅")).toHaveTextContent("7.86%");
  expect(screen.getByLabelText("成交量")).toHaveTextContent("2.35万");
});

it("shows the reference center range and where the close sits against it", () => {
  render(<QuoteBand chart={rising} />);

  const band = screen.getByLabelText("笔中枢");
  expect(band).toHaveTextContent("38.00–43.00");
  expect(screen.getByLabelText("中枢位置")).toHaveTextContent("上方");
});

it("counts confirmed and forming strokes", () => {
  render(<QuoteBand chart={rising} />);

  expect(screen.getByLabelText("已确认笔")).toHaveTextContent("1");
  expect(screen.getByLabelText("形成中笔")).toHaveTextContent("1");
});

it("renders nothing when there is no bar to quote", () => {
  const { container } = render(<QuoteBand chart={chart()} />);

  expect(container.firstChild).toBeNull();
});

it("marks change unavailable instead of printing a fake zero", () => {
  const single = chart({ bars: [{ occurredAt: "2026-08-21T00:00:00Z", open: 10, close: 11, low: 9, high: 12, volume: null }] });

  render(<QuoteBand chart={single} />);

  expect(screen.getByLabelText("涨跌幅")).toHaveTextContent("—");
  expect(screen.getByLabelText("最新收盘")).not.toHaveClass("tone-up");
  expect(screen.getByLabelText("成交量")).toHaveTextContent("—");
});
