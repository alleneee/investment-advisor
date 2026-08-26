import { useEffect, useId, useRef, type CSSProperties } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { buildJournalReturnChartOption } from "./journal-return-chart-option";
import type { ReviewPeriodKind, TradingPeriodSummary } from "./trading-types";
import { formatRate } from "./ui/formatDisplay";

const PERIOD_NAMES: Record<ReviewPeriodKind, string> = {
  month: "本月",
  week: "本周",
  quarter: "本季",
  year: "本年",
};

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export function JournalReturnChart({ periodKind, summary }: { periodKind: ReviewPeriodKind; summary: TradingPeriodSummary | undefined }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const descriptionId = useId();
  const lastValidPoint = summary ? [...summary.returnCurve].reverse().find((point) => {
    const value = point.cumulativeReturnRate.value;
    return value !== null && Number.isFinite(Number(value));
  }) : undefined;
  const hasDrawableData = lastValidPoint !== undefined;

  useEffect(() => {
    const container = containerRef.current;
    const currentChart = chartRef.current;
    const currentObserver = observerRef.current;
    if (!container || !hasDrawableData) {
      currentObserver?.disconnect();
      currentChart?.dispose();
      if (observerRef.current === currentObserver) observerRef.current = null;
      if (chartRef.current === currentChart) chartRef.current = null;
      return;
    }

    const chart = currentChart ?? init(container, undefined, { renderer: "canvas" });
    const observer = currentObserver ?? new ResizeObserver(() => chart.resize());
    chartRef.current = chart;
    observerRef.current = observer;
    if (!currentObserver) observer.observe(container);

    return () => {
      observer.disconnect();
      chart.dispose();
      if (observerRef.current === observer) observerRef.current = null;
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [hasDrawableData]);

  useEffect(() => {
    if (!summary || !hasDrawableData) return;
    chartRef.current?.setOption(buildJournalReturnChartOption(summary.returnCurve), { notMerge: true });
  }, [hasDrawableData, summary]);

  const periodName = PERIOD_NAMES[periodKind];
  const value = lastValidPoint?.cumulativeReturnRate.value ?? null;
  const numericValue = value === null ? null : Number(value);
  const tone = numericValue === null || numericValue === 0 ? undefined : numericValue > 0 ? "tone-gain" : "tone-loss";

  return <section className="journal-return-card">
    <header>
      <h3>{periodName}累计收益</h3>
      {value !== null ? <strong className={tone}>{formatRate(value)}</strong> : null}
    </header>
    {summary === undefined
      ? <p>正在读取收益曲线…</p>
      : lastValidPoint === undefined
        ? <p>该周期暂无可用收益数据</p>
        : <>
          <div
            ref={containerRef}
            className="journal-return-chart"
            role="img"
            aria-label={`${periodName}累计收益曲线`}
            aria-describedby={descriptionId}
          />
          <table id={descriptionId} style={VISUALLY_HIDDEN_STYLE}>
            <caption>{periodName}累计收益数据</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">累计收益</th>
              </tr>
            </thead>
            <tbody>
              {summary.returnCurve.map((point) => <tr key={point.date}>
                <th scope="row">{point.date}</th>
                <td>{point.cumulativeReturnRate.value === null
                  ? point.cumulativeReturnRate.unavailableReason ?? "不可用"
                  : formatRate(point.cumulativeReturnRate.value)}</td>
              </tr>)}
            </tbody>
          </table>
        </>}
  </section>;
}
