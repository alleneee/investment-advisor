import type { CandlestickData, HistogramData, SeriesMarker, Time, UTCTimestamp, WhitespaceData } from "lightweight-charts";
import type { BsChart, ChartMark, ChartMarkType, TradingChartBar } from "./trading-types";
import { WORKBENCH_DOWN, WORKBENCH_SELL, WORKBENCH_UP } from "./workbench-chart";
import { barIndexForOccurredAt } from "./bs-chart-option";

export interface BsChartModel {
  candlesticks: CandlestickData<Time>[];
  volume: Array<HistogramData<Time> | WhitespaceData<Time>>;
  dif: Array<{ time: Time; value: number }>;
  dea: Array<{ time: Time; value: number }>;
  histogram: HistogramData<Time>[];
  markers: SeriesMarker<Time>[];
  visibleRange: { from: number; to: number };
  macdReady: boolean;
}

export function barTime(bar: TradingChartBar, timeframe: BsChart["timeframe"]): Time {
  if (timeframe === "1d") return bar.tradeDate;
  return Math.floor(new Date(bar.occurredAt).getTime() / 1000) as UTCTimestamp;
}

export function buildBsChartModel(
  chart: BsChart,
  marks: ChartMark[],
  types: ChartMarkType[],
  periodStart: string,
  periodEnd: string,
): BsChartModel {
  const typeById = new Map(types.map((item) => [item.typeId, item]));
  const macdReady = chart.macd.ready
    && chart.macd.dif.length === chart.bars.length
    && chart.macd.dea.length === chart.bars.length
    && chart.macd.histogram.length === chart.bars.length;
  const times = chart.bars.map((bar) => barTime(bar, chart.timeframe));
  const markers: SeriesMarker<Time>[] = [];
  for (const item of chart.executions) {
    const index = barIndexForOccurredAt(chart, item.barOccurredAt);
    const time = times[index];
    if (time === undefined) continue;
    markers.push(item.side === "buy"
      ? { time, position: "belowBar", color: WORKBENCH_UP, shape: "arrowUp", text: "B" }
      : { time, position: "aboveBar", color: WORKBENCH_SELL, shape: "arrowDown", text: "S" });
  }
  for (const item of marks) {
    const type = typeById.get(item.typeId);
    const index = barIndexForOccurredAt(chart, item.occurredAt);
    const time = times[index];
    if (!type || time === undefined) continue;
    markers.push({ time, position: "aboveBar", color: type.color, shape: "circle", text: type.letter });
  }
  return {
    candlesticks: chart.bars.map((bar, index) => ({
      time: times[index],
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
    })),
    volume: chart.bars.map((bar, index) => bar.volume == null
      ? { time: times[index] }
      : {
          time: times[index],
          value: Number(bar.volume),
          color: Number(bar.close) >= Number(bar.open) ? WORKBENCH_UP : WORKBENCH_DOWN,
        }),
    dif: macdReady
      ? chart.macd.dif.map((value, index) => ({ time: times[index], value: Number(value) }))
      : [],
    dea: macdReady
      ? chart.macd.dea.map((value, index) => ({ time: times[index], value: Number(value) }))
      : [],
    histogram: macdReady
      ? chart.macd.histogram.map((value, index) => {
        const number = Number(value);
        return {
          time: times[index],
          value: number,
          color: number >= 0 ? "rgba(246, 70, 93, 0.45)" : "rgba(14, 203, 129, 0.45)",
        };
      })
      : [],
    markers,
    visibleRange: visibleRangeForPeriod(chart.bars, periodStart, periodEnd),
    macdReady,
  };
}

export function barPaneReadout(chart: BsChart, occurredAt: string) {
  const index = barIndexForOccurredAt(chart, occurredAt);
  const bar = chart.bars[index];
  if (!bar) return null;
  const ready = chart.macd.ready
    && chart.macd.dif.length === chart.bars.length
    && chart.macd.dea.length === chart.bars.length
    && chart.macd.histogram.length === chart.bars.length;
  return {
    volume: bar.volume,
    dif: ready ? chart.macd.dif[index] ?? null : null,
    dea: ready ? chart.macd.dea[index] ?? null : null,
    histogram: ready ? chart.macd.histogram[index] ?? null : null,
  };
}

export function macdPriceRange(
  histogram: Array<{ value: number }>,
  dif: Array<{ value: number }>,
  dea: Array<{ value: number }>,
): { from: number; to: number } | null {
  let max = 0;
  for (const item of [...histogram, ...dif, ...dea]) {
    if (Number.isFinite(item.value)) max = Math.max(max, Math.abs(item.value));
  }
  if (max === 0) return null;
  return { from: -(max * 1.2), to: max * 1.2 };
}

export function formatPaneValue(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return String(Number(n.toFixed(4)));
}

export function barTimeFromClick(time: Time, chart: BsChart): string | null {
  if (typeof time === "string") {
    const bar = chart.bars.find((item) => item.tradeDate === time || item.occurredAt.slice(0, 10) === time);
    return bar?.occurredAt ?? null;
  }
  const unix = typeof time === "number" ? time : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  let nearest: { occurredAt: string; delta: number } | null = null;
  for (const bar of chart.bars) {
    const barUnix = Math.floor(new Date(bar.occurredAt).getTime() / 1000);
    const delta = Math.abs(barUnix - unix);
    if (nearest == null || delta < nearest.delta) nearest = { occurredAt: bar.occurredAt, delta };
  }
  return nearest && nearest.delta <= 60 ? nearest.occurredAt : nearest?.occurredAt ?? null;
}

function visibleRangeForPeriod(bars: TradingChartBar[], periodStart: string, periodEnd: string): { from: number; to: number } {
  if (bars.length === 0) return { from: 0, to: 0 };
  const startDate = periodStart.slice(0, 10);
  const endDate = periodEnd.slice(0, 10);
  let from = bars.findIndex((bar) => bar.tradeDate >= startDate);
  if (from < 0) from = 0;
  let to = bars.length - 1;
  for (let index = 0; index < bars.length; index += 1) {
    if (bars[index].tradeDate <= endDate) to = index;
  }
  return { from, to: Math.max(from, to) };
}
