import type { ChanChartData } from "./types";

export type CenterPosition = "above" | "inside" | "below";
export type QuoteTone = "up" | "down" | "neutral";

export interface QuoteSummary {
  last: number;
  open: number;
  high: number;
  low: number;
  /** 前一根收盘。只有一根 K 线时为 null，不用当根开盘冒充。 */
  prevClose: number | null;
  change: number | null;
  changeRate: number | null;
  amplitude: number | null;
  volume: number | null;
  barCount: number;
}

export interface ActiveCenter {
  lower: number;
  upper: number;
  position: CenterPosition;
}

export interface StrokeSummary {
  confirmed: number;
  provisional: number;
  lastDirection: "up" | "down" | null;
}

/** 从固化 K 线推导盘口摘要。无法确定的字段返回 null，不用推测值填充。 */
export function deriveQuote(chart: ChanChartData): QuoteSummary | null {
  const bars = chart.bars;
  if (bars.length === 0) return null;
  const latest = bars[bars.length - 1];
  const prevClose = bars.length > 1 ? bars[bars.length - 2].close : null;
  const comparable = prevClose != null && prevClose !== 0;
  return {
    last: latest.close,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    prevClose,
    change: prevClose == null ? null : latest.close - prevClose,
    changeRate: comparable ? (latest.close - prevClose) / prevClose : null,
    amplitude: comparable ? (latest.high - latest.low) / prevClose : null,
    volume: latest.volume,
    barCount: bars.length,
  };
}

/**
 * 找出与最新收盘相关的中枢：优先取仍然包含收盘的最新中枢，
 * 否则用最新中枢作为参照并标出收盘在其上方还是下方。
 */
export function activeCenter(chart: ChanChartData): ActiveCenter | null {
  const bars = chart.bars;
  if (bars.length === 0 || chart.centers.length === 0) return null;
  const price = bars[bars.length - 1].close;
  for (let index = chart.centers.length - 1; index >= 0; index -= 1) {
    const item = chart.centers[index];
    if (price >= item.lower && price <= item.upper) {
      return { lower: item.lower, upper: item.upper, position: "inside" };
    }
  }
  const newest = chart.centers[chart.centers.length - 1];
  return {
    lower: newest.lower,
    upper: newest.upper,
    position: price > newest.upper ? "above" : "below",
  };
}

export function strokeSummary(chart: ChanChartData): StrokeSummary {
  const strokes = chart.strokes;
  return {
    confirmed: strokes.filter((item) => item.state === "confirmed").length,
    provisional: strokes.filter((item) => item.state === "provisional").length,
    lastDirection: strokes.length ? strokes[strokes.length - 1].direction : null,
  };
}

/** 成交量按万 / 亿收敛，保留两位小数；缺失显示破折号而不是 0。 */
export function formatCompact(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return String(value);
}

/** 涨跌幅带符号百分比。不可判定时给破折号，不写 0.00%。 */
export function signedPercent(value: number | null): string {
  if (value == null) return "—";
  const percent = (value * 100).toFixed(2);
  return value > 0 ? `+${percent}%` : `${percent}%`;
}

export function signedAmount(value: number | null): string {
  if (value == null) return "—";
  const fixed = value.toFixed(2);
  return value > 0 ? `+${fixed}` : fixed;
}

export function percent(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

/** 红涨绿跌：与 styles.css 的 --up / --down 令牌一致。 */
export function quoteTone(changeRate: number | null): QuoteTone {
  if (changeRate == null || changeRate === 0) return "neutral";
  return changeRate > 0 ? "up" : "down";
}

export function centerPositionLabel(position: CenterPosition): string {
  return { above: "上方", inside: "区间内", below: "下方" }[position];
}

export function centerPositionTone(position: CenterPosition): QuoteTone {
  if (position === "above") return "up";
  if (position === "below") return "down";
  return "neutral";
}

/** Tushare 的固化日是 YYYYMMDD，展示时补上分隔符；已带分隔符或非日期原样返回。 */
export function formatTradeDate(value: string): string {
  if (!value) return "—";
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value;
}
