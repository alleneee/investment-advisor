import type { EChartsOption } from "echarts";
import type { BsChart, BsChartExecution, ChartMark, ChartMarkType, TradingChartBar } from "./trading-types";

const UP = "#f6465d";
const DOWN = "#0ecb81";
const SELL = "#4a90e2";
const ACCENT = "#3de530";
const MUTED = "#bbcbb2";
const DIF_COLOR = "#e5e2e1";
const DEA_COLOR = "#f5a623";

interface TooltipParam {
  axisValue?: string;
  seriesName?: string;
  data?: unknown;
}

export function buildBsChartOption(
  chart: BsChart,
  marks: ChartMark[],
  types: ChartMarkType[],
  periodStart: string,
  periodEnd: string,
): EChartsOption {
  const categories = chart.bars.map((bar) => categoryOf(bar, chart.timeframe));
  const typeById = new Map(types.map((item) => [item.typeId, item]));
  const buys = chart.executions.filter((item) => item.side === "buy");
  const sells = chart.executions.filter((item) => item.side === "sell");
  const markPoints = marks.flatMap((item) => {
    const type = typeById.get(item.typeId);
    const bar = barForMark(chart, item);
    if (!type || !bar) return [];
    return [{
      value: [categoryOf(bar, chart.timeframe), numberOrNull(bar.high)],
      letter: type.letter,
      itemStyle: { color: type.color },
      label: { color: type.color },
      mark: item,
    }];
  });
  const macdReady = chart.macd.ready
    && chart.macd.dif.length === chart.bars.length
    && chart.macd.dea.length === chart.bars.length
    && chart.macd.histogram.length === chart.bars.length;
  const { start, end } = zoomWindow(categories, periodStart, periodEnd);

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: [
      { left: 54, right: 20, top: 24, height: "48%" },
      { left: 54, right: 20, top: "56%", height: "12%" },
      { left: 54, right: 20, top: "72%", height: "14%" },
    ],
    axisPointer: { link: [{ xAxisIndex: [0, 1, 2] }] },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", lineStyle: { color: ACCENT } },
      backgroundColor: "rgba(32, 31, 31, 0.96)",
      borderColor: "#3d4b37",
      textStyle: { color: "#e5e2e1", fontSize: 10 },
      formatter: (params: unknown) => formatTooltip(params, chart, marks, types),
    },
    xAxis: [
      axis(categories, 0, false),
      axis(categories, 1, false),
      axis(categories, 2, true),
    ],
    yAxis: [
      valueAxis(0),
      valueAxis(1),
      valueAxis(2),
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1, 2], start, end },
      { type: "slider", xAxisIndex: [0, 1, 2], start, end, height: 16, bottom: 14, borderColor: "#2a2a2a", backgroundColor: "#131313", fillerColor: "rgba(61, 229, 48, 0.16)", handleStyle: { color: ACCENT, borderColor: ACCENT }, textStyle: { color: MUTED, fontSize: 8 } },
    ],
    series: [
      {
        name: "未复权 K 线",
        type: "candlestick",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: chart.bars.map((bar) => [numberOrNull(bar.open), numberOrNull(bar.close), numberOrNull(bar.low), numberOrNull(bar.high)]),
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
        z: 2,
      },
      markerSeries("实际买入", chart, buys, UP, 0),
      markerSeries("实际卖出", chart, sells, SELL, 180),
      {
        name: "手标",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: markPoints,
        symbol: "circle",
        symbolSize: 1,
        label: {
          show: true,
          formatter: (params: { data?: { letter?: string } }) => params.data?.letter ?? "",
          fontSize: 10,
          fontWeight: 700,
          position: "top",
        },
        z: 9,
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: chart.bars.map((bar) => ({ value: numberOrNull(bar.volume), itemStyle: { color: directionColor(bar) } })),
        z: 1,
      },
      {
        name: "DIF",
        type: "line",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: macdReady ? chart.macd.dif.map(numberOrNull) : [],
        symbol: "none",
        lineStyle: { color: DIF_COLOR, width: 1 },
        z: 3,
      },
      {
        name: "DEA",
        type: "line",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: macdReady ? chart.macd.dea.map(numberOrNull) : [],
        symbol: "none",
        lineStyle: { color: DEA_COLOR, width: 1 },
        z: 3,
      },
      {
        name: "MACD",
        type: "bar",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: macdReady
          ? chart.macd.histogram.map((value) => {
            const number = numberOrNull(value);
            return { value: number, itemStyle: { color: number !== null && number >= 0 ? UP : DOWN } };
          })
          : [],
        z: 1,
      },
    ] as unknown as EChartsOption["series"],
  };
}

export function barIndexForOccurredAt(chart: BsChart, occurredAt: string): number {
  const exact = chart.bars.findIndex((bar) => bar.occurredAt === occurredAt);
  if (exact >= 0) return exact;
  const date = occurredAt.slice(0, 10);
  if (chart.timeframe === "1d") {
    return chart.bars.findIndex((bar) => bar.tradeDate === date || bar.occurredAt.slice(0, 10) === date);
  }
  let last = -1;
  chart.bars.forEach((bar, index) => {
    if (bar.occurredAt.slice(0, 10) === date) last = index;
  });
  return last;
}

export function barOccurredAtFromClick(value: unknown, chart: BsChart): string | null {
  if (typeof value !== "object" || value === null) return null;
  const params = value as { componentType?: string; seriesType?: string; dataIndex?: number; data?: unknown };
  if (params.componentType && params.componentType !== "series") return null;
  if (typeof params.dataIndex === "number" && (params.seriesType === "candlestick" || params.seriesType === "bar" || params.seriesType === "line")) {
    return chart.bars[params.dataIndex]?.occurredAt ?? null;
  }
  const execution = executionFrom(params.data);
  if (execution) {
    const bar = chart.bars.find((item) => item.occurredAt === execution.barOccurredAt);
    return bar?.occurredAt ?? execution.barOccurredAt;
  }
  const mark = markFrom(params.data);
  if (mark) return barForMark(chart, mark)?.occurredAt ?? mark.occurredAt;
  return null;
}

function markerSeries(name: string, chart: BsChart, executions: BsChartExecution[], color: string, rotate: number) {
  return {
    name,
    type: "scatter" as const,
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: executions.flatMap((item) => {
      const bar = chart.bars.find((candidate) => candidate.occurredAt === item.barOccurredAt);
      if (!bar) return [];
      return [{ value: [categoryOf(bar, chart.timeframe), numberOrNull(item.price)], execution: item }];
    }),
    symbol: "triangle",
    symbolRotate: rotate,
    symbolSize: 11,
    itemStyle: { color },
    z: 8,
  };
}

function axis(data: string[], gridIndex: number, labels: boolean) {
  return {
    type: "category" as const,
    gridIndex,
    data,
    boundaryGap: true,
    axisLine: { lineStyle: { color: "#2a2a2a" } },
    axisTick: { show: false },
    axisLabel: { show: labels, color: MUTED, fontSize: 8, formatter: formatAxisLabel },
    splitLine: { show: false },
  };
}

function valueAxis(gridIndex: number) {
  return { type: "value" as const, gridIndex, scale: true, position: "right" as const, axisLabel: { color: MUTED, fontSize: 8 }, splitLine: { lineStyle: { color: "rgba(53, 53, 52, 0.8)" } } };
}

function formatTooltip(value: unknown, chart: BsChart, marks: ChartMark[], types: ChartMarkType[]): string {
  const params = Array.isArray(value) ? value as TooltipParam[] : [value as TooltipParam];
  const execution = params.map((item) => executionFrom(item.data)).find((item): item is BsChartExecution => item !== null);
  const mark = params.map((item) => markFrom(item.data)).find((item): item is ChartMark => item !== null);
  const category = params.find((item) => item.axisValue)?.axisValue ?? "";
  const bar = chart.bars.find((item) => categoryOf(item, chart.timeframe) === category);
  const lines = category ? [category] : [];
  if (bar) lines.push(`开 ${bar.open}　高 ${bar.high}　低 ${bar.low}　收 ${bar.close}`, `成交量 ${bar.volume ?? "—"}`);
  if (execution) lines.push(`${execution.side === "buy" ? "买入" : "卖出"} ${execution.price}　数量 ${execution.quantity}`);
  if (mark) {
    const type = types.find((item) => item.typeId === mark.typeId);
    lines.push(`${type?.letter ?? ""} ${mark.comment}`.trim());
  }
  if (chart.macd.ready && bar) {
    const index = chart.bars.indexOf(bar);
    const dif = chart.macd.dif[index];
    const dea = chart.macd.dea[index];
    const histogram = chart.macd.histogram[index];
    if (dif !== undefined) lines.push(`DIF ${dif}　DEA ${dea}　MACD ${histogram}`);
  }
  return lines.join("<br/>");
}

function executionFrom(value: unknown): BsChartExecution | null {
  if (typeof value !== "object" || value === null || !("execution" in value)) return null;
  const execution = value.execution;
  return typeof execution === "object" && execution !== null ? execution as BsChartExecution : null;
}

function markFrom(value: unknown): ChartMark | null {
  if (typeof value !== "object" || value === null || !("mark" in value)) return null;
  const mark = value.mark;
  return typeof mark === "object" && mark !== null ? mark as ChartMark : null;
}

function barForMark(chart: BsChart, mark: ChartMark): TradingChartBar | undefined {
  const exact = chart.bars.find((bar) => bar.occurredAt === mark.occurredAt);
  if (exact) return exact;
  const date = mark.occurredAt.slice(0, 10);
  if (chart.timeframe === "1d") {
    return chart.bars.find((bar) => bar.tradeDate === date || bar.occurredAt.slice(0, 10) === date);
  }
  let last: TradingChartBar | undefined;
  for (const bar of chart.bars) {
    if (bar.occurredAt.slice(0, 10) === date) last = bar;
  }
  return last;
}

function categoryOf(bar: TradingChartBar, timeframe: BsChart["timeframe"]): string {
  return timeframe === "1d" ? bar.tradeDate : bar.occurredAt;
}

function zoomWindow(categories: string[], periodStart: string, periodEnd: string): { start: number; end: number } {
  if (categories.length === 0) return { start: 0, end: 100 };
  const startDate = periodStart.slice(0, 10);
  const endDate = periodEnd.slice(0, 10);
  const startIndex = categories.findIndex((item) => item.slice(0, 10) >= startDate);
  const start = startIndex <= 0 ? 0 : (startIndex / categories.length) * 100;
  let endIndex = -1;
  for (let index = 0; index < categories.length; index += 1) {
    if (categories[index].slice(0, 10) <= endDate) endIndex = index;
  }
  const end = endIndex < 0 || endIndex >= categories.length - 1 ? 100 : ((endIndex + 1) / categories.length) * 100;
  return { start, end: Math.max(start, end) === 0 ? 100 : Math.max(start, end) };
}

function formatAxisLabel(value: string): string {
  if (value.length <= 10) return value.slice(5, 10);
  const date = value.slice(5, 10);
  const time = value.slice(11, 16);
  return time && time !== "00:00" ? `${date} ${time}` : date;
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function directionColor(bar: TradingChartBar): string {
  const open = numberOrNull(bar.open);
  const close = numberOrNull(bar.close);
  return open !== null && close !== null && close >= open ? UP : DOWN;
}
