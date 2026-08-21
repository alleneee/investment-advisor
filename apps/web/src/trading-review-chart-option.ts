import type { EChartsOption } from "echarts";
import { reasonLabels } from "./trading-api";
import type { TradingChartBundle, TradingChartExecution, TradingReviewDeterministicReport } from "./trading-types";

const UP = "#f6465d";
const DOWN = "#0ecb81";
const ACCENT = "#7ee0c8";
const MUTED = "#8a9b96";
const RISK = "#f0b429";

interface TooltipParam {
  axisValue?: string;
  seriesName?: string;
  data?: unknown;
}

export function buildTradingReviewChartOption(report: TradingReviewDeterministicReport, bundle: TradingChartBundle): EChartsOption {
  const equityDates = report.equityCurve.map((point) => point.date);
  const priceDates = bundle.bars.map((bar) => bar.tradeDate);
  const strokes = bundle.strokes.map((stroke, index) => ({
    name: `${stroke.state === "confirmed" ? "已确认笔" : "形成中笔"} ${index + 1}`,
    type: "line" as const,
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: [[tradeDateOf(stroke.startAt), numberOrNull(stroke.startPrice)], [tradeDateOf(stroke.endAt), numberOrNull(stroke.endPrice)]],
    symbol: "none",
    lineStyle: { color: ACCENT, width: stroke.state === "confirmed" ? 1.6 : 2, type: stroke.state === "confirmed" ? "solid" as const : "dashed" as const },
    z: 5,
  }));
  const centers = bundle.centers.map((center) => [
    { name: `笔中枢 ${center.lower}–${center.upper}`, xAxis: tradeDateOf(center.startAt), yAxis: numberOrNull(center.lower) },
    { xAxis: tradeDateOf(center.endAt), yAxis: numberOrNull(center.upper) },
  ]);
  const buys = bundle.executions.filter((item) => item.side === "buy");
  const sells = bundle.executions.filter((item) => item.side === "sell");

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: [
      { left: 54, right: 20, top: 24, height: "22%" },
      { left: 54, right: 20, top: "39%", height: "35%" },
      { left: 54, right: 20, top: "79%", height: "10%" },
    ],
    axisPointer: { link: [{ xAxisIndex: [1, 2] }] },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", lineStyle: { color: "#46635f" } },
      backgroundColor: "rgba(5, 18, 26, 0.96)",
      borderColor: "#294a4c",
      textStyle: { color: "#dce8df", fontSize: 10 },
      formatter: (params: unknown) => formatTooltip(params, report, bundle),
    },
    xAxis: [
      axis(equityDates, 0, true),
      axis(priceDates, 1, false),
      axis(priceDates, 2, true),
    ],
    yAxis: [
      valueAxis(0, "right"),
      valueAxis(1, "right"),
      valueAxis(2, "right"),
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [1, 2], start: zoomStart(priceDates.length), end: 100 },
      { type: "slider", xAxisIndex: [1, 2], start: zoomStart(priceDates.length), end: 100, height: 16, bottom: 14, borderColor: "#294248", backgroundColor: "#07151e", fillerColor: "rgba(126, 224, 200, 0.16)", handleStyle: { color: ACCENT, borderColor: ACCENT }, textStyle: { color: "#66827c", fontSize: 8 } },
    ],
    series: [
      {
        name: "账户权益",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: report.equityCurve.map((point) => numberOrNull(point.equity)),
        symbol: "none",
        lineStyle: { color: ACCENT, width: 1.8 },
        areaStyle: { color: "rgba(103, 186, 161, 0.08)" },
      },
      {
        name: "回撤",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: report.equityCurve.map((point) => numberOrNull(point.drawdownRate.value)),
        symbol: "none",
        lineStyle: { color: RISK, width: 1.2, type: "dashed" },
      },
      {
        name: "未复权 K 线",
        type: "candlestick",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: bundle.bars.map((bar) => [numberOrNull(bar.open), numberOrNull(bar.close), numberOrNull(bar.low), numberOrNull(bar.high)]),
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
        z: 2,
      },
      ...strokes,
      {
        name: "笔中枢",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: [],
        symbol: "none",
        markArea: { silent: true, itemStyle: { color: "rgba(138, 155, 150, 0.14)", borderColor: MUTED, borderWidth: 1 }, label: { show: false }, data: centers },
        z: 1,
      },
      markerSeries("实际买入", buys, UP),
      markerSeries("实际卖出", sells, DOWN),
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: bundle.bars.map((bar) => ({ value: numberOrNull(bar.volume), itemStyle: { color: directionColor(bar) } })),
        z: 1,
      },
    ] as unknown as EChartsOption["series"],
  };
}

function axis(data: string[], gridIndex: number, labels: boolean) {
  return { type: "category" as const, gridIndex, data, boundaryGap: true, axisLine: { lineStyle: { color: "#294248" } }, axisTick: { show: false }, axisLabel: { show: labels, color: "#66827c", fontSize: 8, formatter: (value: string) => value.slice(5, 10) }, splitLine: { show: false } };
}

function valueAxis(gridIndex: number, position: "right" | "left") {
  return { type: "value" as const, gridIndex, scale: true, position, axisLabel: { color: "#66827c", fontSize: 8 }, splitLine: { lineStyle: { color: "rgba(97, 144, 135, 0.11)" } } };
}

function markerSeries(name: string, executions: TradingChartExecution[], color: string) {
  return {
    name,
    type: "scatter" as const,
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: executions.map((execution) => ({ value: [execution.tradeDate, numberOrNull(execution.price)], execution })),
    symbol: name === "实际买入" ? "triangle" : "triangle",
    symbolRotate: name === "实际买入" ? 0 : 180,
    symbolSize: 11,
    itemStyle: { color },
    z: 8,
  };
}

function formatTooltip(value: unknown, report: TradingReviewDeterministicReport, bundle: TradingChartBundle): string {
  const params = Array.isArray(value) ? value as TooltipParam[] : [value as TooltipParam];
  const execution = params.map((item) => executionFrom(item.data)).find((item): item is TradingChartExecution => item !== null);
  if (execution) return [execution.executedAt, `${execution.side === "buy" ? "买入" : "卖出"} ${bundle.symbol}`, `价格 ${execution.price}　数量 ${execution.quantity}`, `手续费 ${execution.fee}`, reasonLabels[execution.primaryReason]].join("<br/>");
  const date = params.find((item) => item.axisValue)?.axisValue ?? "";
  const bar = bundle.bars.find((item) => item.tradeDate === date);
  const equity = report.equityCurve.find((item) => item.date === date);
  const lines = date ? [date] : [];
  if (equity) lines.push(`权益 ${equity.equity}`, `回撤 ${equity.drawdownRate.value ?? "—"}`);
  if (bar) lines.push(`开 ${bar.open}　高 ${bar.high}　低 ${bar.low}　收 ${bar.close}`, `成交量 ${bar.volume ?? "—"}`);
  return lines.join("<br/>");
}

function executionFrom(value: unknown): TradingChartExecution | null {
  if (typeof value !== "object" || value === null || !("execution" in value)) return null;
  const execution = value.execution;
  return typeof execution === "object" && execution !== null ? execution as TradingChartExecution : null;
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tradeDateOf(value: string): string {
  return value.slice(0, 10);
}

function zoomStart(count: number): number {
  return count > 126 ? ((count - 126) / count) * 100 : 0;
}

function directionColor(bar: TradingChartBundle["bars"][number]): string {
  const open = numberOrNull(bar.open);
  const close = numberOrNull(bar.close);
  return open !== null && close !== null && close >= open ? UP : DOWN;
}
