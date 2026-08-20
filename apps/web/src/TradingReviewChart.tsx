import { useEffect, useRef } from "react";
import { BarChart, CandlestickChart, LineChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, MarkAreaComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { buildTradingReviewChartOption } from "./trading-review-chart-option";
import type { TradingChartBundle, TradingReviewDeterministicReport } from "./trading-types";

use([BarChart, CandlestickChart, LineChart, ScatterChart, DataZoomComponent, GridComponent, MarkAreaComponent, TooltipComponent, CanvasRenderer]);

export function TradingReviewChart({ report, bundle }: { report: TradingReviewDeterministicReport; bundle: TradingChartBundle }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bundle.bars.length) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }
    const chart = chartRef.current ?? init(container, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildTradingReviewChartOption(report, bundle), { notMerge: true });
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver(() => chartRef.current?.resize());
      observerRef.current.observe(container);
    }
  }, [bundle, report]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  if (!bundle.bars.length) return <div className="chart-empty">该标的没有可绘制的固化行情。</div>;

  return <div className="trading-review-chart-shell">
    <div className="trading-review-chart-legend" aria-label="交易复盘图例">
      <span><i className="legend-equity" />账户权益</span>
      <span><i className="legend-drawdown" />回撤</span>
      <span><i className="legend-confirmed" />已确认笔</span>
      <span><i className="legend-volume" />成交量</span>
      <span><i className="legend-buy" />历史买入</span>
      <span><i className="legend-sell" />历史卖出</span>
    </div>
    <div ref={containerRef} className="trading-review-chart" role="img" aria-label={`${bundle.symbol} 历史买卖点、缠论、成交量、权益与回撤图`} />
  </div>;
}
