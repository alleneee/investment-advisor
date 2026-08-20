import { useEffect, useMemo, useState } from "react";
import { reasonLabels } from "./trading-api";
import type { TradingApi } from "./trading-api";
import { TradingReviewChart } from "./TradingReviewChart";
import type { ReviewPeriodKind, TradingReviewDeterministicReport, TradingReviewReport } from "./trading-types";

interface ReviewCenterPageProps {
  api: TradingApi;
  today?: string;
}

const periods: Array<{ kind: ReviewPeriodKind; label: string }> = [
  { kind: "week", label: "周报" },
  { kind: "month", label: "月报" },
  { kind: "quarter", label: "季报" },
  { kind: "year", label: "年报" },
];

export function ReviewCenterPage({ api, today = currentShanghaiDate() }: ReviewCenterPageProps) {
  const [periodKind, setPeriodKind] = useState<ReviewPeriodKind>("week");
  const initialBounds = useMemo(() => periodBounds("week", today), [today]);
  const [periodStart, setPeriodStart] = useState(initialBounds.start);
  const [periodEnd, setPeriodEnd] = useState(initialBounds.end);
  const [report, setReport] = useState<TradingReviewReport | null>(null);
  const [history, setHistory] = useState<TradingReviewReport[]>([]);
  const [busy, setBusy] = useState<"preview" | "create" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartIndex, setChartIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void api.listReviewReports(periodKind, periodStart, periodEnd).then((items) => {
      if (active) setHistory(items);
    }).catch((reason: unknown) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [api, periodEnd, periodKind, periodStart]);

  useEffect(() => {
    if (report?.snapshotStatus !== "pending" && report?.snapshotStatus !== "running") return;
    let active = true;
    const timer = setTimeout(() => {
      void api.getReviewReport(report.reportId).then((next) => {
        if (active) setReport(next);
      }).catch((reason: unknown) => {
        if (active) setError(messageOf(reason));
      });
    }, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, report?.reportId, report?.snapshotStatus]);

  function selectPeriod(kind: ReviewPeriodKind) {
    setPeriodKind(kind);
    const bounds = periodBounds(kind, today);
    setPeriodStart(bounds.start);
    setPeriodEnd(bounds.end);
    setReport(null);
    setChartIndex(0);
    setError(null);
  }

  async function preview() {
    if (busy !== null) return;
    setBusy("preview");
    setError(null);
    try {
      const next = await api.getReviewPreview(periodKind, periodStart, periodEnd);
      setReport(next);
      setChartIndex(0);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (busy !== null) return;
    setBusy("create");
    setError(null);
    try {
      const next = await api.createReviewReport(periodKind, periodStart, periodEnd);
      setReport(next);
      setHistory((items) => upsertReport(items, next));
      setChartIndex(0);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    if (!report || busy !== null) return;
    setBusy("retry");
    setError(null);
    try {
      const next = await api.retryReviewReport(report.reportId);
      setReport(next);
      setHistory((items) => upsertReport(items, next));
      setChartIndex(0);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  const deterministic = report?.deterministicReport ?? null;
  const selectedBundle = deterministic?.chartBundles[chartIndex] ?? deterministic?.chartBundles[0] ?? null;

  return <section className="review-center-page" aria-label="复盘中心">
    <section className="review-controls journal-card">
      <div className="review-controls-heading"><div><span className="section-index">01</span><h2>周期复盘</h2></div><span>所有结果来自固化账本、日复盘和行情快照</span></div>
      <div className="review-period-switch" role="group" aria-label="复盘周期">
        {periods.map((period) => <button key={period.kind} type="button" aria-pressed={periodKind === period.kind} onClick={() => selectPeriod(period.kind)}>{period.label}</button>)}
      </div>
      <div className="review-date-form">
        <label>周期开始<input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label>
        <label>周期结束<input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label>
        <button className="secondary-button" type="button" onClick={() => void preview()} disabled={busy !== null}>{busy === "preview" ? "正在预览…" : "查看期间预览"}</button>
        <button className="primary-button" type="button" onClick={() => void create()} disabled={busy !== null}>{busy === "create" ? "正在生成…" : "生成确定性复盘"}</button>
      </div>
      {error && <p className="journal-error" role="alert">{error}</p>}
    </section>

    <section className="review-history" aria-label="报告版本历史">
      <div className="section-heading"><div><span className="section-index">02</span><h2>报告版本</h2></div><span className="count-badge">{history.length.toString().padStart(2, "0")} SNAPSHOTS</span></div>
      {history.length ? <div className="review-history-list">{history.map((item) => <button type="button" key={item.reportId} className={`review-history-item${report?.reportId === item.reportId ? " selected" : ""}`} onClick={() => { setReport(item); setChartIndex(0); }}><span>V{item.reportVersion}</span><strong>{statusLabel(item.snapshotStatus)}</strong><small>{item.periodStart} 至 {item.periodEnd}{item.isOutdated ? " · 已过期" : ""}</small></button>)}</div> : <p className="journal-muted">该周期还没有固化报告。</p>}
    </section>

    {report && <ReviewState report={report} onRetry={() => void retry()} retrying={busy === "retry"} />}
    {deterministic && <section className="review-result" aria-label="确定性复盘结果">
      <div className="section-heading"><div><span className="section-index">03</span><h2>确定性复盘结果</h2></div><ReportFlags report={report!} /></div>
      {report?.isOutdated && <p className="review-warning">当前展示的是旧快照；账本、日复盘或行情已经变化，请重新生成新版本。</p>}
      {report?.partialPeriod && <p className="review-warning">本周期尚不完整，以下内容只作进行中记录，不和完整周期做结论比较。</p>}
      <MetricBand report={deterministic} />
      <ReasonMatrix report={deterministic} />
      <CycleCases report={deterministic} />
      <section className="journal-card review-chart-panel">
        <div className="journal-card-heading"><span className="section-index">04</span><h3>权益、回撤与真实买卖点</h3></div>
        {deterministic.chartBundles.length > 1 && <div className="bundle-switch" aria-label="图表标的">{deterministic.chartBundles.map((bundle, index) => <button type="button" key={bundle.symbol} aria-pressed={selectedBundle?.symbol === bundle.symbol} onClick={() => setChartIndex(index)}>{bundle.symbol}</button>)}</div>}
        {selectedBundle ? <TradingReviewChart report={deterministic} bundle={selectedBundle} /> : <p className="journal-muted">当前周期没有固化行情图表。</p>}
      </section>
      <Comparison report={deterministic} />
      <section className="journal-card review-ai-status">
        <div className="journal-card-heading"><span className="section-index">05</span><h3>Pi 复盘总结</h3></div>
        {report?.aiStatus === "not_requested" ? <p><strong>Pi 总结尚未请求</strong><span>本版先展示可审计的确定性统计，不用模型替代交易事实。</span></p> : <p><strong>{aiStatusLabel(report!.aiStatus)}</strong><span>交易复盘文字状态独立于确定性快照；当前页面只展示服务端返回的真实状态。</span></p>}
      </section>
    </section>}
  </section>;
}

function ReviewState({ report, onRetry, retrying }: { report: TradingReviewReport; onRetry: () => void; retrying: boolean }) {
  if (report.snapshotStatus === "ready") return null;
  if (report.snapshotStatus === "failed") return <section className="review-state-card failed"><strong>确定性复盘生成失败</strong><p>{report.error?.message ?? "服务没有返回可显示的错误详情。"}</p>{report.retryable && <button className="primary-button" type="button" onClick={onRetry} disabled={retrying}>{retrying ? "正在重试…" : "重试确定性复盘"}</button>}</section>;
  return <section className="review-state-card"><strong>{report.snapshotStatus === "pending" ? "复盘任务已排队" : "正在构建确定性复盘"}</strong><p>账本、日复盘和行情会被固化为一个可追溯快照，完成后页面自动刷新。</p></section>;
}

function ReportFlags({ report }: { report: TradingReviewReport }) {
  return <div className="review-flags"><span className={`quality-tag ${report.dataQuality === "ok" ? "" : "degraded"}`}>{report.dataQuality === "ok" ? "数据完整" : "数据降级"}</span><span className="quality-tag">{report.partialPeriod ? "进行中预览" : "完整周期"}</span></div>;
}

function MetricBand({ report }: { report: TradingReviewDeterministicReport }) {
  const metrics = report.metrics;
  return <section className="review-metric-band" aria-label="核心指标">
    <Metric label="报告期已实现盈亏" value={metrics.periodRealizedPnl} />
    <Metric label="闭合周期盈亏" value={metrics.closedCyclePnl} />
    <Metric label="资金流调整收益率" value={metrics.accountAdjustedReturnRate.value} percentage unavailable={metrics.accountAdjustedReturnRate.unavailableReason} />
    <Metric label="周期最大回撤" value={metrics.periodMaxDrawdownRate.value} percentage unavailable={metrics.periodMaxDrawdownRate.unavailableReason} />
    <Metric label="胜率" value={metrics.winRate.value} percentage unavailable={metrics.winRate.unavailableReason} />
    <Metric label="纪律执行率" value={metrics.disciplineAdherenceRate.value} percentage unavailable={metrics.disciplineAdherenceRate.unavailableReason} />
  </section>;
}

function Metric({ label, value, percentage = false, unavailable }: { label: string; value: string | null; percentage?: boolean; unavailable?: string | null }) {
  return <article><span>{label}</span><strong>{value === null ? "—" : percentage ? percentageText(value) : value}</strong>{unavailable && <small>{unavailable}</small>}</article>;
}

function ReasonMatrix({ report }: { report: TradingReviewDeterministicReport }) {
  return <section className="journal-card reason-matrix"><div className="journal-card-heading"><span className="section-index">06</span><h3>买卖理由表现</h3></div>{report.executionReasonFacts.length || report.reasonPerformance.length ? <div className="reason-grid">{report.executionReasonFacts.map((fact) => <article key={`${fact.side}-${fact.reasonCode}`}><span>{fact.side === "buy" ? "买入" : "卖出"}</span><strong>{reasonLabels[fact.reasonCode]}</strong><small>{fact.executionCount} 笔 · {fact.quantity} 股 · {fact.grossAmount}</small></article>)}{report.reasonPerformance.map((performance) => <article key={`${performance.side}-${performance.reasonCode}`}><span>{performance.side === "buy" ? "买入" : "卖出"}</span><strong>{reasonLabels[performance.reasonCode]}</strong><small>{performance.conclusionAllowed ? `样本 ${performance.sampleCount} · 净盈亏 ${performance.netPnl}` : `样本 ${performance.sampleCount}，仅展示事实`}</small></article>)}</div> : <p className="journal-muted">本周期没有足以归类的交易理由事实。</p>}</section>;
}

function CycleCases({ report }: { report: TradingReviewDeterministicReport }) {
  return <section className="journal-card cycle-cases"><div className="journal-card-heading"><span className="section-index">07</span><h3>交易周期</h3></div>{report.cycleCases.length ? <div className="cycle-list">{report.cycleCases.map((cycle) => <article key={cycle.cycleId}><div><strong>{cycle.symbol}</strong><span>{cycle.name} · {cycle.holdingDays} 个交易日</span></div><div><span>{reasonLabels[cycle.buyReasonCode]} → {reasonLabels[cycle.sellReasonCode]}</span><strong>{cycle.netPnl}</strong></div></article>)}</div> : <p className="journal-muted">本周期还没有闭合交易周期。</p>}</section>;
}

function Comparison({ report }: { report: TradingReviewDeterministicReport }) {
  if (report.comparison === null) return <section className="journal-card comparison-panel"><div className="journal-card-heading"><span className="section-index">08</span><h3>同类周期比较</h3></div><p className="journal-muted">{report.comparisonUnavailableReason === "partial_period" ? "当前周期尚未完整，暂不比较。" : "没有可比较的上一同类完整周期。"}</p></section>;
  return <section className="journal-card comparison-panel"><div className="journal-card-heading"><span className="section-index">08</span><h3>同类周期比较</h3></div><p className="comparison-period">对比 {report.comparison.previousPeriod.start} 至 {report.comparison.previousPeriod.end}</p><div className="comparison-list">{report.comparison.metrics.map((metric) => <div key={metric.metricRef}><span>{metric.metricRef}</span><strong>{metric.current.value ?? "—"}</strong><small>前期 {metric.previous.value ?? "—"} · 变化 {metric.delta.value ?? "—"}</small></div>)}</div></section>;
}

function upsertReport(items: TradingReviewReport[], report: TradingReviewReport): TradingReviewReport[] {
  return [report, ...items.filter((item) => item.reportId !== report.reportId)];
}

function periodBounds(kind: ReviewPeriodKind, today: string): { start: string; end: string } {
  const current = dateOf(today);
  if (kind === "week") {
    const day = current.getUTCDay() || 7;
    const currentMonday = addDays(current, 1 - day);
    return { start: dateText(addDays(currentMonday, -7)), end: dateText(addDays(currentMonday, -1)) };
  }
  if (kind === "month") {
    const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    return { start: dateText(start), end: dateText(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0))) };
  }
  if (kind === "quarter") {
    const currentQuarter = Math.floor(current.getUTCMonth() / 3);
    const startMonth = (currentQuarter + 3) % 4 * 3;
    const year = currentQuarter === 0 ? current.getUTCFullYear() - 1 : current.getUTCFullYear();
    return { start: dateText(new Date(Date.UTC(year, startMonth, 1))), end: dateText(new Date(Date.UTC(year, startMonth + 3, 0))) };
  }
  const year = current.getUTCFullYear() - 1;
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function dateOf(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function dateText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function percentageText(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : value;
}

function statusLabel(status: TradingReviewReport["snapshotStatus"]): string {
  return { pending: "排队", running: "生成中", ready: "已完成", failed: "失败" }[status];
}

function aiStatusLabel(status: TradingReviewReport["aiStatus"]): string {
  return { pending: "Pi 总结排队中", running: "Pi 总结生成中", ready: "Pi 总结已完成", failed: "Pi 总结失败", not_requested: "Pi 总结尚未请求" }[status];
}

function currentShanghaiDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败，请检查本机服务。";
}
