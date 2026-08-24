import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  buildChanChartModel,
  ChanOverlayPrimitive,
  formatChanTooltip,
} from "./chan-chart-option";
import type { ChanChartData } from "./types";

export function ChanChart({ symbol, data }: { symbol: string; data: ChanChartData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRef = useRef<ChanOverlayPrimitive | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const printImageRef = useRef<HTMLImageElement | null>(null);
  const dataRef = useRef(data);
  const hasData = data.bars.length > 0;
  dataRef.current = data;

  useEffect(() => {
    const container = containerRef.current;
    if (!hasData || !container) return;
    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 411,
      layout: {
        background: { type: ColorType.Solid, color: "#101920" },
        textColor: "#66827c",
        fontSize: 10,
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        panes: {
          enableResize: false,
          separatorColor: "#294248",
          separatorHoverColor: "#294248",
        },
      },
      grid: {
        vertLines: { color: "rgba(97, 144, 135, 0.07)" },
        horzLines: { color: "rgba(97, 144, 135, 0.11)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#46635f", labelBackgroundColor: "#294a4c" },
        horzLine: { color: "#46635f", labelBackgroundColor: "#294a4c" },
      },
      rightPriceScale: { borderColor: "#294248" },
      timeScale: {
        borderColor: "#294248",
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 2,
      },
      localization: { locale: "zh-CN" },
    });
    const candlestick = chart.addSeries(CandlestickSeries, {
      upColor: "#f6465d",
      downColor: "#0ecb81",
      borderUpColor: "#f6465d",
      borderDownColor: "#0ecb81",
      wickUpColor: "#f6465d",
      wickDownColor: "#0ecb81",
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0);
    chart.addPane();
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    }, 1);
    const panes = chart.panes();
    panes[0]?.setStretchFactor(4);
    panes[1]?.setStretchFactor(1);
    const overlay = new ChanOverlayPrimitive([], []);
    candlestick.attachPrimitive(overlay);
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || param.time === undefined || param.point === undefined) {
        if (tooltip) tooltip.hidden = true;
        return;
      }
      const date = typeof param.time === "string"
        ? param.time
        : typeof param.time === "number"
          ? new Date(param.time * 1000).toISOString().slice(0, 10)
          : `${param.time.year}-${String(param.time.month).padStart(2, "0")}-${String(param.time.day).padStart(2, "0")}`;
      const text = formatChanTooltip(dataRef.current, date);
      tooltip.textContent = text;
      tooltip.hidden = !text;
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);
    const observer = new ResizeObserver(() => chart.resize(container.clientWidth, container.clientHeight));
    observer.observe(container);
    chartRef.current = chart;
    candlestickRef.current = candlestick;
    volumeRef.current = volume;
    overlayRef.current = overlay;
    observerRef.current = observer;
    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      observer.disconnect();
      chart.remove();
      if (chartRef.current === chart) chartRef.current = null;
      if (candlestickRef.current === candlestick) candlestickRef.current = null;
      if (volumeRef.current === volume) volumeRef.current = null;
      if (overlayRef.current === overlay) overlayRef.current = null;
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [hasData]);

  useEffect(() => {
    if (!hasData) return;
    const model = buildChanChartModel(data);
    candlestickRef.current?.setData(model.candlesticks);
    volumeRef.current?.setData(model.volume);
    overlayRef.current?.setData(model.strokes, model.centers);
    chartRef.current?.timeScale().setVisibleLogicalRange(model.visibleRange);
  }, [data, hasData]);

  useEffect(() => {
    const swapInPrintImage = () => {
      const chart = chartRef.current;
      const shell = shellRef.current;
      if (!chart || !shell || printImageRef.current) return;
      const image = document.createElement("img");
      image.className = "chan-chart-print-image";
      image.alt = "缠论结构图（打印版）";
      image.src = chart.takeScreenshot(true, false).toDataURL("image/png");
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

  if (!hasData) return <div className="chart-empty">当前周期暂无可绘制行情</div>;

  return <div className="chan-chart-shell" ref={shellRef}>
    <div className="chan-chart-legend" aria-label="缠论图例">
      <span><i className="legend-confirmed" />已确认笔</span>
      <span><i className="legend-provisional" />形成中笔</span>
      <span><i className="legend-center" />笔中枢</span>
      <span><i className="legend-volume" />成交量</span>
    </div>
    <div ref={tooltipRef} className="chan-chart-tooltip" hidden />
    <div
      ref={containerRef}
      className="chan-chart"
      role="img"
      aria-label={`${symbol} ${data.timeframe === "1d" ? "日线" : "周线"}缠论及成交量图`}
    />
  </div>;
}
