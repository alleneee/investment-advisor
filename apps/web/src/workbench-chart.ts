import { ColorType, CrosshairMode, type DeepPartial, type ChartOptions } from "lightweight-charts";

export const WORKBENCH_UP = "#f6465d";
export const WORKBENCH_DOWN = "#0ecb81";
export const WORKBENCH_ACCENT = "#3de530";
export const WORKBENCH_MUTED = "#bbcbb2";
export const WORKBENCH_DIF = "#e5e2e1";
export const WORKBENCH_DEA = "#f5a623";
export const WORKBENCH_SELL = "#4a90e2";

export const WORKBENCH_CANDLE_SERIES = {
  upColor: WORKBENCH_UP,
  downColor: WORKBENCH_DOWN,
  borderUpColor: WORKBENCH_UP,
  borderDownColor: WORKBENCH_DOWN,
  wickUpColor: WORKBENCH_UP,
  wickDownColor: WORKBENCH_DOWN,
  priceLineVisible: false,
  lastValueVisible: false,
};

export function workbenchChartOptions(input: {
  width: number;
  height: number;
  timeVisible: boolean;
  rightOffset?: number;
  fixRightEdge?: boolean;
}): DeepPartial<ChartOptions> {
  return {
    width: input.width,
    height: input.height,
    layout: {
      background: { type: ColorType.Solid, color: "#131313" },
      textColor: WORKBENCH_MUTED,
      fontSize: 10,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      panes: {
        enableResize: false,
        separatorColor: "#2a2a2a",
        separatorHoverColor: "#2a2a2a",
      },
    },
    grid: {
      vertLines: { color: "rgba(53, 53, 52, 0.7)" },
      horzLines: { color: "rgba(53, 53, 52, 0.9)" },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: WORKBENCH_ACCENT, labelBackgroundColor: "#201f1f" },
      horzLine: { color: WORKBENCH_ACCENT, labelBackgroundColor: "#201f1f" },
    },
    rightPriceScale: { borderColor: "#2a2a2a" },
    timeScale: {
      borderColor: "#2a2a2a",
      timeVisible: input.timeVisible,
      secondsVisible: false,
      rightOffset: input.rightOffset ?? 2,
      fixRightEdge: input.fixRightEdge ?? false,
    },
    localization: { locale: "zh-CN" },
  };
}
