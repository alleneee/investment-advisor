import type { EChartsOption } from "echarts";
import type { ChanChartData } from "./types";

const CONFIRMED = "#67baa1";
const PROVISIONAL = "#e56548";
const CENTER = "#e4a15f";

interface TooltipParam {
  axisValue?: string;
  seriesType?: string;
  seriesName?: string;
  data?: unknown;
}

export function buildChanChartOption(data: ChanChartData): EChartsOption {
  const visibleCount = data.timeframe === "1d" ? 126 : 26;
  const start = data.bars.length
    ? Math.max(0, ((data.bars.length - visibleCount) / data.bars.length) * 100)
    : 0;
  const strokeSeries = data.strokes.map((stroke, index) => {
    const confirmed = stroke.state === "confirmed";
    return {
      name: `${confirmed ? "已确认笔" : "形成中笔"} ${index + 1}`,
      type: "line" as const,
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: [
        [stroke.startAt, stroke.startPrice],
        [stroke.endAt, stroke.endPrice],
      ],
      symbol: "none",
      silent: false,
      connectNulls: false,
      lineStyle: {
        color: confirmed ? CONFIRMED : PROVISIONAL,
        width: confirmed ? 1.8 : 2.2,
        type: confirmed ? "solid" as const : "dashed" as const,
      },
      z: confirmed ? 4 : 5,
    };
  });
  const centerData = data.centers.map((center): [
    { name: string; xAxis: string; yAxis: number },
    { xAxis: string; yAxis: number },
  ] => [
      {
        name: `笔中枢 ${center.lower}–${center.upper}`,
        xAxis: center.startAt,
        yAxis: center.lower,
      },
      { xAxis: center.endAt, yAxis: center.upper },
    ]);
  const dates = data.bars.map((bar) => bar.occurredAt);

  return {
    animation: false,
    backgroundColor: "transparent",
    grid: [
      { left: 54, right: 18, top: 25, height: "58%" },
      { left: 54, right: 18, top: "70%", height: "14%" },
    ],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", lineStyle: { color: "#46635f" } },
      backgroundColor: "rgba(5, 18, 26, 0.96)",
      borderColor: "#294a4c",
      textStyle: { color: "#dce8df", fontSize: 10 },
      formatter: (value: unknown) => formatTooltip(value, data.bars),
    },
    xAxis: [
      {
        type: "category",
        gridIndex: 0,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: "#294248" } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: "category",
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: "#294248" } },
        axisTick: { show: false },
        axisLabel: { color: "#66827c", fontSize: 9, formatter: (value: string) => value.slice(0, 10) },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: "value",
        gridIndex: 0,
        scale: true,
        position: "right",
        axisLabel: { color: "#66827c", fontSize: 9 },
        splitLine: { lineStyle: { color: "rgba(97, 144, 135, 0.11)" } },
      },
      {
        type: "value",
        gridIndex: 1,
        scale: true,
        position: "right",
        axisLabel: { color: "#66827c", fontSize: 9 },
        splitLine: { lineStyle: { color: "rgba(97, 144, 135, 0.08)" } },
      },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true },
      {
        type: "slider",
        xAxisIndex: [0, 1],
        start,
        end: 100,
        height: 16,
        bottom: 14,
        borderColor: "#294248",
        backgroundColor: "#07151e",
        fillerColor: "rgba(103, 186, 161, 0.16)",
        handleStyle: { color: CONFIRMED, borderColor: CONFIRMED },
        textStyle: { color: "#66827c", fontSize: 8 },
      },
    ],
    series: [
      {
        name: "前复权 K 线",
        type: "candlestick",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.bars.map((bar) => [bar.open, bar.close, bar.low, bar.high]),
        itemStyle: {
          color: CONFIRMED,
          color0: PROVISIONAL,
          borderColor: CONFIRMED,
          borderColor0: PROVISIONAL,
        },
        z: 2,
      },
      ...strokeSeries,
      {
        name: "笔中枢",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: [],
        symbol: "none",
        silent: false,
        markArea: {
          silent: false,
          itemStyle: {
            color: "rgba(228, 161, 95, 0.14)",
            borderColor: CENTER,
            borderWidth: 1,
          },
          label: { show: false },
          tooltip: { formatter: formatCenterTooltip },
          data: centerData,
        },
        z: 1,
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.bars.map((bar) => ({
          value: bar.volume,
          itemStyle: { color: bar.close >= bar.open ? CONFIRMED : PROVISIONAL },
        })),
        z: 1,
      },
    ],
  };
}

function formatTooltip(value: unknown, bars: ChanChartData["bars"]): string {
  const params = Array.isArray(value) ? value as TooltipParam[] : [value as TooltipParam];
  const date = params.find((item) => item.axisValue)?.axisValue ?? "";
  const lines = date ? [date.slice(0, 10)] : [];
  const bar = bars.find((item) => item.occurredAt === date);
  if (bar) {
    lines.push(`开 ${bar.open}　高 ${bar.high}　低 ${bar.low}　收 ${bar.close}`);
    lines.push(`成交量 ${bar.volume === null ? "—" : `${bar.volume} 手`}`);
  }
  for (const item of params) {
    if (item.seriesType === "line" && item.seriesName && item.seriesName !== "笔中枢") {
      lines.push(item.seriesName);
    }
  }
  return lines.join("<br/>");
}

function formatCenterTooltip(value: unknown): string {
  if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") return value.name;
  return "笔中枢";
}
