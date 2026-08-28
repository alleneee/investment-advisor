import { useEffect, useLayoutEffect, useRef } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { barIndexForOccurredAt } from "./bs-chart-option";
import { MacdHistogramPrimitive } from "./bs-chart-macd";
import { barPaneReadout, barTime, barTimeFromClick, buildBsChartModel, formatPaneValue, macdPriceRange } from "./bs-chart-model";
import type { BsChart as BsChartData, ChartMark, ChartMarkType } from "./trading-types";
import {
  WORKBENCH_CANDLE_SERIES,
  WORKBENCH_DEA,
  WORKBENCH_DIF,
  WORKBENCH_MUTED,
  workbenchChartOptions,
} from "./workbench-chart";

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
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const difRef = useRef<ISeriesApi<"Line"> | null>(null);
  const deaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const histogramRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdSticksRef = useRef<MacdHistogramPrimitive | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const volumeValueRef = useRef<HTMLSpanElement>(null);
  const difValueRef = useRef<HTMLSpanElement>(null);
  const deaValueRef = useRef<HTMLSpanElement>(null);
  const histogramValueRef = useRef<HTMLSpanElement>(null);
  const onSelectBarRef = useRef(onSelectBar);
  const chartDataRef = useRef(chart);
  const hasBars = chart.bars.length > 0;
  onSelectBarRef.current = onSelectBar;
  chartDataRef.current = chart;

  function applyPaneReadout(occurredAt: string | null) {
    const readout = occurredAt ? barPaneReadout(chartDataRef.current, occurredAt) : null;
    if (volumeValueRef.current) volumeValueRef.current.textContent = formatPaneValue(readout?.volume);
    if (difValueRef.current) difValueRef.current.textContent = formatPaneValue(readout?.dif);
    if (deaValueRef.current) deaValueRef.current.textContent = formatPaneValue(readout?.dea);
    if (histogramValueRef.current) histogramValueRef.current.textContent = formatPaneValue(readout?.histogram);
  }
  const applyPaneReadoutRef = useRef(applyPaneReadout);
  applyPaneReadoutRef.current = applyPaneReadout;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasBars) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
      candlestickRef.current = null;
      volumeRef.current = null;
      difRef.current = null;
      deaRef.current = null;
      histogramRef.current = null;
      macdSticksRef.current = null;
      markersRef.current = null;
      return;
    }
    const instance = createChart(container, workbenchChartOptions({
      width: container.clientWidth || 800,
      height: container.clientHeight || 460,
      timeVisible: chart.timeframe === "30m",
      rightOffset: 0,
      fixRightEdge: true,
    }));
    const candlestick = instance.addSeries(CandlestickSeries, WORKBENCH_CANDLE_SERIES);
    const volumePane = instance.addPane(true);
    const volume = volumePane.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const macdPane = instance.addPane(true);
    const histogram = macdPane.addSeries(HistogramSeries, {
      base: 0,
      visible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const dif = macdPane.addSeries(LineSeries, {
      color: WORKBENCH_DIF,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const dea = macdPane.addSeries(LineSeries, {
      color: WORKBENCH_DEA,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const macdSticks = new MacdHistogramPrimitive();
    dif.attachPrimitive(macdSticks);
    dif.createPriceLine({
      price: 0,
      color: WORKBENCH_MUTED,
      lineWidth: 1,
      axisLabelVisible: false,
      title: "",
    });
    instance.panes()[0]?.setStretchFactor(4);
    volumePane.setStretchFactor(1);
    macdPane.setStretchFactor(1.4);
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 460;
    instance.resize(width, height + 1, true);
    instance.resize(width, height, true);
    container.dataset.paneCount = String(instance.panes().length);
    const markers = createSeriesMarkers(candlestick, []);
    const handleClick = (param: MouseEventParams<Time>) => {
      const time = param.point
        ? instance.timeScale().coordinateToTime(param.point.x) ?? param.time
        : param.time;
      if (time === undefined || time === null) return;
      const occurredAt = barTimeFromClick(time, chartDataRef.current);
      if (occurredAt) {
        applyPaneReadoutRef.current(occurredAt);
        onSelectBarRef.current?.(occurredAt);
      }
    };
    instance.subscribeClick(handleClick);
    const handleMove = (param: MouseEventParams<Time>) => {
      const time = param.point
        ? instance.timeScale().coordinateToTime(param.point.x) ?? param.time
        : param.time;
      if (time === undefined || time === null) return;
      const occurredAt = barTimeFromClick(time, chartDataRef.current);
      if (occurredAt) applyPaneReadoutRef.current(occurredAt);
    };
    instance.subscribeCrosshairMove(handleMove);
    const observer = new ResizeObserver(() => instance.resize(container.clientWidth, container.clientHeight));
    observer.observe(container);
    chartRef.current = instance;
    candlestickRef.current = candlestick;
    volumeRef.current = volume;
    difRef.current = dif;
    deaRef.current = dea;
    histogramRef.current = histogram;
    macdSticksRef.current = macdSticks;
    markersRef.current = markers;
    observerRef.current = observer;
    return () => {
      instance.unsubscribeClick(handleClick);
      instance.unsubscribeCrosshairMove(handleMove);
      observer.disconnect();
      instance.remove();
      if (chartRef.current === instance) chartRef.current = null;
      if (candlestickRef.current === candlestick) candlestickRef.current = null;
      if (volumeRef.current === volume) volumeRef.current = null;
      if (difRef.current === dif) difRef.current = null;
      if (deaRef.current === dea) deaRef.current = null;
      if (histogramRef.current === histogram) histogramRef.current = null;
      if (macdSticksRef.current === macdSticks) macdSticksRef.current = null;
      if (markersRef.current === markers) markersRef.current = null;
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [hasBars, chart.timeframe]);

  useEffect(() => {
    if (!hasBars) return;
    const model = buildBsChartModel(chart, marks, types, periodStart, periodEnd);
    candlestickRef.current?.setData(model.candlesticks);
    volumeRef.current?.setData(model.volume);
    difRef.current?.setData(model.dif);
    deaRef.current?.setData(model.dea);
    histogramRef.current?.setData(model.histogram);
    macdSticksRef.current?.setData(model.histogram);
    const range = macdPriceRange(model.histogram, model.dif, model.dea);
    if (range) {
      const scale = difRef.current?.priceScale();
      scale?.setAutoScale(false);
      scale?.setVisibleRange(range);
    }
    markersRef.current?.setMarkers(model.markers);
    chartRef.current?.timeScale().setVisibleLogicalRange(model.visibleRange);
  }, [chart, hasBars, marks, periodEnd, periodStart, types]);

  useLayoutEffect(() => {
    if (!hasBars) return;
    applyPaneReadout(highlightOccurredAt ?? chart.bars.at(-1)?.occurredAt ?? null);
  }, [chart, hasBars, highlightOccurredAt]);

  useEffect(() => {
    const instance = chartRef.current;
    const series = candlestickRef.current;
    if (!instance || !series || !hasBars || !highlightOccurredAt) return;
    const dataIndex = barIndexForOccurredAt(chart, highlightOccurredAt);
    const bar = chart.bars[dataIndex];
    if (!bar) return;
    instance.setCrosshairPosition(Number(bar.close), barTime(bar, chart.timeframe), series);
    applyPaneReadout(highlightOccurredAt);
  }, [chart, hasBars, highlightOccurredAt]);

  if (!hasBars) return <div className="chart-empty">行情不可用</div>;

  return <div className="bs-chart-shell">
    {chart.macd.ready ? null : <div className="bs-chart-macd-status">MACD 未就绪</div>}
    <div className="chan-chart-legend" aria-label="BS 图例">
      <span><i className="legend-volume" />成交量</span>
      <span>B 实盘买</span>
      <span>S 实盘卖</span>
    </div>
    <div
      ref={containerRef}
      className="bs-chart"
      role="img"
      aria-label={`${chart.symbol} ${chart.timeframe === "1d" ? "日线" : "30分钟"} BS点分析图`}
    />
    <div className="bs-volume-legend" aria-label="成交量读数">
      成交量 <span ref={volumeValueRef}>—</span>
    </div>
    <div className="bs-macd-legend" aria-label="MACD 图例">
      <span style={{ color: WORKBENCH_DIF }}>DIF <span ref={difValueRef}>—</span></span>
      <span style={{ color: WORKBENCH_DEA }}>DEA <span ref={deaValueRef}>—</span></span>
      <span className="bs-macd-legend-hist"><i className="legend-macd" />MACD柱 <span ref={histogramValueRef}>—</span></span>
    </div>
  </div>;
}
