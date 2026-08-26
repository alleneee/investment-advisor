import type { EChartsOption } from "echarts";
import type { TradingPeriodSummary } from "./trading-types";

const UP = "#f6465d";
const DOWN = "#0ecb81";
const NEUTRAL = "#bbcbb2";
const AXIS = "#2a2a2a";

interface TooltipParam {
  axisValue?: unknown;
}

export function buildJournalReturnChartOption(curve: TradingPeriodSummary["returnCurve"]): EChartsOption {
  const dates = curve.map((point) => point.date);
  const values = curve.map((point) => numberOrNull(point.cumulativeReturnRate.value));
  const color = returnColor(values);

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: { left: 12, right: 12, top: 12, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      confine: true,
      formatter: (params: unknown) => formatTooltip(params, curve),
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: AXIS } },
      axisTick: { show: false },
      axisLabel: { color: NEUTRAL, formatter: (value: string) => value.slice(5) },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: NEUTRAL, formatter: formatPercent },
      splitLine: { lineStyle: { color: "rgba(53, 53, 52, 0.8)" } },
    },
    series: [
      {
        name: "累计收益",
        type: "line",
        data: values,
        connectNulls: false,
        showSymbol: true,
        showAllSymbol: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        z: 2,
      },
      {
        name: "0%",
        type: "line",
        data: dates.map(() => 0),
        silent: true,
        symbol: "none",
        lineStyle: { color: AXIS, width: 1, type: "dashed" },
        z: 1,
      },
    ],
  };
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function returnColor(values: Array<number | null>): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === null) continue;
    if (value === 0) return NEUTRAL;
    return value > 0 ? UP : DOWN;
  }
  return NEUTRAL;
}

function formatPercent(value: string | number): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : "—";
}

function formatTooltip(params: unknown, curve: TradingPeriodSummary["returnCurve"]): string {
  const values = Array.isArray(params) ? params : [params];
  const date = values.map(axisValueOf).find((value): value is string => value !== null) ?? "";
  const point = curve.find((item) => item.date === date);
  if (!point) return date;
  const metric = point.cumulativeReturnRate;
  if (metric.value === null) return `${date}\n${metric.unavailableReason ?? ""}`;
  return `${date}\n累计收益 ${formatPercent(metric.value)}`;
}

function axisValueOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const axisValue = (value as TooltipParam).axisValue;
  return typeof axisValue === "string" ? axisValue : null;
}
