import { useEffect, useRef } from "react";
import { BarChart, CandlestickChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
} from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { buildChanChartOption } from "./chan-chart-option";
import type { ChanChartData } from "./types";

use([
  BarChart,
  CandlestickChart,
  LineChart,
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export function ChanChart({ symbol, data }: { symbol: string; data: ChanChartData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const printImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data.bars.length) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }
    const chart = chartRef.current ?? init(container, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildChanChartOption(data), { notMerge: true });
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver(() => chartRef.current?.resize());
      observerRef.current.observe(container);
    }
  }, [data]);

  // 打印时 canvas 尺寸不会随打印版面重排，改为临时插入等比静态图，打印后移除。
  useEffect(() => {
    const swapInPrintImage = () => {
      const chart = chartRef.current;
      const shell = shellRef.current;
      if (!chart || !shell || printImageRef.current) return;
      const image = document.createElement("img");
      image.className = "chan-chart-print-image";
      image.alt = "缠论结构图（打印版）";
      image.src = chart.getDataURL({
        pixelRatio: 2,
        backgroundColor: "#081924",
        excludeComponents: ["dataZoom"],
      });
      shell.appendChild(image);
      printImageRef.current = image;
    };
    const removePrintImage = () => {
      printImageRef.current?.remove();
      printImageRef.current = null;
    };
    window.addEventListener("beforeprint", swapInPrintImage);
    window.addEventListener("afterprint", removePrintImage);
    return () => {
      removePrintImage();
      window.removeEventListener("beforeprint", swapInPrintImage);
      window.removeEventListener("afterprint", removePrintImage);
    };
  }, []);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  if (!data.bars.length) return <div className="chart-empty">当前周期暂无可绘制行情</div>;

  return <div className="chan-chart-shell" ref={shellRef}>
    <div className="chan-chart-legend" aria-label="缠论图例">
      <span><i className="legend-confirmed" />已确认笔</span>
      <span><i className="legend-provisional" />形成中笔</span>
      <span><i className="legend-center" />笔中枢</span>
      <span><i className="legend-volume" />成交量</span>
    </div>
    <div
      ref={containerRef}
      className="chan-chart"
      role="img"
      aria-label={`${symbol} ${data.timeframe === "1d" ? "日线" : "周线"}缠论及成交量图`}
    />
  </div>;
}
