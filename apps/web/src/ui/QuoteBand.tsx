import {
  activeCenter,
  centerPositionLabel,
  centerPositionTone,
  deriveQuote,
  formatCompact,
  percent,
  quoteTone,
  signedAmount,
  signedPercent,
  strokeSummary,
} from "../quote";
import type { ChanChartData } from "../types";
import type { MetricTone } from "./formatDisplay";

/**
 * 报告卡顶部的盘口条：把固化 K 线里的价格事实提到最显眼的位置。
 * 所有数字都由 ChanChartData 推导，不额外请求，也不做任何预测。
 */
export function QuoteBand({ chart }: { chart: ChanChartData }) {
  const quote = deriveQuote(chart);
  if (quote == null) return null;
  const center = activeCenter(chart);
  const strokes = strokeSummary(chart);
  const tone = quoteTone(quote.changeRate);

  return (
    <div className="quote-band">
      <div className="quote-lead">
        <strong className={`quote-price ui-metric-value tone-${tone}`} aria-label="最新收盘">
          {quote.last.toFixed(2)}
        </strong>
        <div className="quote-delta">
          <span className={`quote-rate tone-${tone}`} aria-label="涨跌幅">{signedPercent(quote.changeRate)}</span>
          <span className={`quote-change tone-${tone}`} aria-label="涨跌额">{signedAmount(quote.change)}</span>
        </div>
      </div>
      <dl className="quote-metrics">
        <Metric label="今开" value={quote.open.toFixed(2)} />
        <Metric label="最高" value={quote.high.toFixed(2)} />
        <Metric label="最低" value={quote.low.toFixed(2)} />
        <Metric label="振幅" value={percent(quote.amplitude)} />
        <Metric label="成交量" value={formatCompact(quote.volume)} />
        <Metric
          label="笔中枢"
          value={center ? `${center.lower.toFixed(2)}–${center.upper.toFixed(2)}` : "—"}
          wide
        />
        <Metric
          label="中枢位置"
          value={center ? centerPositionLabel(center.position) : "—"}
          tone={center ? centerPositionTone(center.position) : "neutral"}
        />
        <Metric label="已确认笔" value={String(strokes.confirmed)} />
        <Metric label="形成中笔" value={String(strokes.provisional)} tone={strokes.provisional ? "risk" : "neutral"} />
      </dl>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
  wide = false,
}: {
  label: string;
  value: string;
  tone?: MetricTone;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "quote-metric quote-metric-wide" : "quote-metric"}>
      <dt>{label}</dt>
      <dd className={`tone-${tone}`} aria-label={label}>{value}</dd>
    </div>
  );
}
