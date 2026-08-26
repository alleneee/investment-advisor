import { useEffect, useRef } from "react";
import { BarChart, CandlestickChart, LineChart, ScatterChart } from "echarts/charts";
import { AxisPointerComponent, DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { barIndexForOccurredAt, barOccurredAtFromClick, buildBsChartOption } from "./bs-chart-option";
import type { BsChart as BsChartData, ChartMark, ChartMarkType } from "./trading-types";

use([BarChart, CandlestickChart, LineChart, ScatterChart, AxisPointerComponent, DataZoomComponent, GridComponent, TooltipComponent, CanvasRenderer]);

export function BsChart({
  chart,
  marks,
  types,
  periodStart,
  periodEnd,
  highlightOccurredAt,
  onSelectBar,
}: {
  chart: BsChartData;
  marks: ChartMark[];
  types: ChartMarkType[];
  periodStart: string;
  periodEnd: string;
  highlightOccurredAt: string | null;
  onSelectBar?: (occurredAt: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const onSelectBarRef = useRef(onSelectBar);
  const hasBars = chart.bars.length > 0;
  onSelectBarRef.current = onSelectBar;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasBars) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }
    const instance = chartRef.current ?? init(container, undefined, { renderer: "canvas" });
    chartRef.current = instance;
    instance.setOption(buildBsChartOption(chart, marks, types, periodStart, periodEnd), { notMerge: true });
    instance.off("click");
    instance.on("click", (params) => {
      const occurredAt = barOccurredAtFromClick(params, chart);
      if (occurredAt) onSelectBarRef.current?.(occurredAt);
    });
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver(() => chartRef.current?.resize());
      observerRef.current.observe(container);
    }
  }, [chart, hasBars, marks, periodEnd, periodStart, types]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance || !hasBars || !highlightOccurredAt) return;
    const dataIndex = barIndexForOccurredAt(chart, highlightOccurredAt);
    if (dataIndex < 0) return;
    instance.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex });
    instance.dispatchAction({ type: "updateAxisPointer", seriesIndex: 0, dataIndex });
  }, [chart, hasBars, highlightOccurredAt, marks, periodEnd, periodStart, types]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  if (!hasBars) return <div className="chart-empty">行情不可用</div>;

  return <div className="bs-chart-shell">
    {chart.macd.ready ? null : <div className="bs-chart-macd-status">MACD 未就绪</div>}
    <div
      ref={containerRef}
      className="bs-chart"
      role="img"
      aria-label={`${chart.symbol} ${chart.timeframe === "1d" ? "日线" : "30分钟"} BS点分析图`}
    />
  </div>;
}
