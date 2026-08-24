import type {
  CandlestickData,
  HistogramData,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  WhitespaceData,
} from "lightweight-charts";
import type { ChanChartData, StructureState } from "./types";

const UP = "#f6465d";
const DOWN = "#0ecb81";
const ACCENT = "#7ee0c8";
const MUTED = "#8a9b96";

export interface OverlayStroke {
  startAt: string;
  endAt: string;
  startPrice: number;
  endPrice: number;
  state: StructureState;
}

export interface OverlayCenter {
  startAt: string;
  endAt: string;
  lower: number;
  upper: number;
}

export interface ChanChartModel {
  candlesticks: CandlestickData<string>[];
  volume: Array<HistogramData<string> | WhitespaceData<string>>;
  strokes: OverlayStroke[];
  centers: OverlayCenter[];
  visibleRange: { from: number; to: number };
}

export function buildChanChartModel(data: ChanChartData): ChanChartModel {
  const visibleCount = data.timeframe === "1d" ? 126 : 26;
  return {
    candlesticks: data.bars.map((bar) => ({
      time: bar.occurredAt.slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })),
    volume: data.bars.map((bar) => bar.volume === null
      ? { time: bar.occurredAt.slice(0, 10) }
      : {
          time: bar.occurredAt.slice(0, 10),
          value: bar.volume,
          color: bar.close >= bar.open ? UP : DOWN,
        }),
    strokes: data.strokes.map((stroke) => ({
      startAt: stroke.startAt.slice(0, 10),
      endAt: stroke.endAt.slice(0, 10),
      startPrice: stroke.startPrice,
      endPrice: stroke.endPrice,
      state: stroke.state,
    })),
    centers: data.centers.map((center) => ({
      startAt: center.startAt.slice(0, 10),
      endAt: center.endAt.slice(0, 10),
      lower: center.lower,
      upper: center.upper,
    })),
    visibleRange: {
      from: Math.max(0, data.bars.length - visibleCount),
      to: Math.max(0, data.bars.length - 1),
    },
  };
}

export function formatChanTooltip(data: ChanChartData, date: string): string {
  const bar = data.bars.find((item) => item.occurredAt.slice(0, 10) === date);
  if (!bar) return "";
  const lines = [
    date,
    `开 ${bar.open}　高 ${bar.high}　低 ${bar.low}　收 ${bar.close}`,
    `成交量 ${bar.volume === null ? "—" : `${bar.volume} 手`}`,
  ];
  const labels = new Set<string>();
  for (const stroke of data.strokes) {
    if (stroke.startAt.slice(0, 10) === date || stroke.endAt.slice(0, 10) === date) {
      labels.add(stroke.state === "confirmed" ? "已确认笔" : "形成中笔");
    }
  }
  for (const center of data.centers) {
    const startAt = center.startAt.slice(0, 10);
    const endAt = center.endAt.slice(0, 10);
    if (startAt <= date && date <= endAt) labels.add(`笔中枢 ${center.lower}–${center.upper}`);
  }
  return [...lines, ...labels].join("\n");
}

export class ChanOverlayPrimitive implements ISeriesPrimitive<Time> {
  private strokes: OverlayStroke[];
  private centers: OverlayCenter[];
  private chart: SeriesAttachedParameter<Time>["chart"] | null = null;
  private series: SeriesAttachedParameter<Time>["series"] | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(strokes: OverlayStroke[], centers: OverlayCenter[]) {
    this.strokes = strokes;
    this.centers = centers;
    this.views = [{
      zOrder: () => "top",
      renderer: () => ({ draw: (target) => this.draw(target) }),
    }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  setData(strokes: OverlayStroke[], centers: OverlayCenter[]): void {
    this.strokes = strokes;
    this.centers = centers;
    this.requestUpdate?.();
  }

  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio, verticalPixelRatio } = scope;
      context.save();
      for (const center of this.centers) {
        const startX = timeScale.timeToCoordinate(center.startAt);
        const endX = timeScale.timeToCoordinate(center.endAt);
        const upperY = series.priceToCoordinate(center.upper);
        const lowerY = series.priceToCoordinate(center.lower);
        if (startX === null || endX === null || upperY === null || lowerY === null) continue;
        const x = Math.min(startX, endX) * horizontalPixelRatio;
        const y = Math.min(upperY, lowerY) * verticalPixelRatio;
        const width = Math.max(1, Math.abs(endX - startX) * horizontalPixelRatio);
        const height = Math.max(1, Math.abs(lowerY - upperY) * verticalPixelRatio);
        context.fillStyle = "rgba(138, 155, 150, 0.14)";
        context.fillRect(x, y, width, height);
        context.strokeStyle = MUTED;
        context.lineWidth = Math.max(1, horizontalPixelRatio);
        context.strokeRect(x, y, width, height);
      }
      context.strokeStyle = ACCENT;
      for (const stroke of this.strokes) {
        const startX = timeScale.timeToCoordinate(stroke.startAt);
        const endX = timeScale.timeToCoordinate(stroke.endAt);
        const startY = series.priceToCoordinate(stroke.startPrice);
        const endY = series.priceToCoordinate(stroke.endPrice);
        if (startX === null || endX === null || startY === null || endY === null) continue;
        context.beginPath();
        context.setLineDash(stroke.state === "confirmed" ? [] : [8, 6]);
        context.lineWidth = (stroke.state === "confirmed" ? 1.8 : 2.2) * horizontalPixelRatio;
        context.moveTo(startX * horizontalPixelRatio, startY * verticalPixelRatio);
        context.lineTo(endX * horizontalPixelRatio, endY * verticalPixelRatio);
        context.stroke();
      }
      context.restore();
    });
  }
}
