import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { WORKBENCH_DOWN, WORKBENCH_UP } from "./workbench-chart";

export function macdStickWidth(barSpacing: number): number {
  if (!Number.isFinite(barSpacing) || barSpacing <= 0) return 1;
  return Math.max(1, barSpacing * 0.48);
}

export class MacdHistogramPrimitive implements ISeriesPrimitive<Time> {
  private items: Array<{ time: Time; value: number }> = [];
  private chart: SeriesAttachedParameter<Time>["chart"] | null = null;
  private series: SeriesAttachedParameter<Time>["series"] | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor() {
    this.views = [{
      zOrder: () => "normal",
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

  setData(items: Array<{ time: Time; value: number }>): void {
    this.items = items;
    this.requestUpdate?.();
  }

  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || this.items.length === 0) return;
    const timeScale = chart.timeScale();
    const zeroY = series.priceToCoordinate(0);
    if (zeroY === null) return;
    const barWidth = macdStickWidth(timeScale.options().barSpacing);
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      const width = Math.max(1, Math.round(barWidth * horizontalPixelRatio));
      const base = zeroY * verticalPixelRatio;
      for (const item of this.items) {
        const x = timeScale.timeToCoordinate(item.time);
        const y = series.priceToCoordinate(item.value);
        if (x === null || y === null) continue;
        const left = Math.round(x * horizontalPixelRatio - width / 2);
        const yPix = y * verticalPixelRatio;
        context.fillStyle = item.value >= 0 ? WORKBENCH_UP : WORKBENCH_DOWN;
        context.fillRect(left, Math.min(base, yPix), width, Math.max(1, Math.abs(base - yPix)));
      }
    });
  }
}
