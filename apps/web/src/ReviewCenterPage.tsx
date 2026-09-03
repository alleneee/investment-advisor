import { useEffect, useMemo, useState } from "react";
import { attributionCategoryLabels, attributionReasonLabels, reasonLabels } from "./trading-api";
import type { TradingApi } from "./trading-api";
import { DataTable } from "./ui/DataTable";
import { EmptyState } from "./ui/EmptyState";
import { formatMoney, formatRate, formatSignedMoney, signedTone } from "./ui/formatDisplay";
import { Panel } from "./ui/Panel";
import { SegmentedControl } from "./ui/SegmentedControl";
import { SplitPane } from "./ui/SplitPane";
import type {
  ReviewPeriodKind,
  StructureAttribution,
  StructureAttributionExecution,
  TradingReviewDeterministicReport,
  TradingReviewReport,
} from "./trading-types";

interface ReviewCenterPageProps {
  api: TradingApi;
  today?: string;
  periodKind?: ReviewPeriodKind;
  periodStart?: string;
  periodEnd?: string;
  hidePeriodControls?: boolean;
  autoCreate?: boolean;
}

const periods: Array<{ kind: ReviewPeriodKind; label: string }> = [
  { kind: "week", label: "周报" },
  { kind: "month", label: "月报" },
  { kind: "quarter", label: "季报" },
  { kind: "year", label: "年报" },
];

export function ReviewCenterPage({
  api,
  today = currentShanghaiDate(),
  periodKind: lockedKind,
  periodStart: lockedStart,
  periodEnd: lockedEnd,
  hidePeriodControls = false,
  autoCreate = false,
}: ReviewCenterPageProps) {
  const unlockedInitial = useMemo(() => periodBounds("week", today), [today]);
  const [freeKind, setFreeKind] = useState<ReviewPeriodKind>("week");
  const [freeStart, setFreeStart] = useState(unlockedInitial.start);
  const [freeEnd, setFreeEnd] = useState(unlockedInitial.end);
  const periodKind = lockedKind ?? freeKind;
  const periodStart = lockedStart ?? freeStart;
  const periodEnd = lockedEnd ?? freeEnd;
  const [report, setReport] = useState<TradingReviewReport | null>(null);
  const [history, setHistory] = useState<TradingReviewReport[]>([]);
  const [busy, setBusy] = useState<"preview" | "create" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<{ reportId: string; message: string } | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);

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
    let timer: ReturnType<typeof setTimeout>;
    const reportId = report.reportId;
    setPollError(null);
    async function poll() {
      try {
        const next = await api.getReviewReport(reportId);
        if (!active) return;
        setReport(next);
        setHistory((items) => upsertReport(items, next));
        if (next.snapshotStatus === "pending" || next.snapshotStatus === "running") timer = setTimeout(() => void poll(), 2000);
      } catch (reason) {
        if (active) setPollError({ reportId, message: messageOf(reason) });
      }
    }
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, pollEpoch, report?.reportId, report?.snapshotStatus]);

  function selectPeriod(kind: ReviewPeriodKind) {
    setFreeKind(kind);
    const bounds = periodBounds(kind, today);
    setFreeStart(bounds.start);
    setFreeEnd(bounds.end);
    setReport(null);
    setError(null);
  }

  async function preview() {
    if (busy !== null) return;
    setBusy("preview");
    setError(null);
    try {
      const next = await api.getReviewPreview(periodKind, periodStart, periodEnd);
      setReport(next);
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
    } catch (reason) {
      setError(`报告未保存：${messageOf(reason)}。请重试生成，或查看期间预览。`);
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
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!autoCreate) return;
    void create();
  }, [autoCreate]);

  const deterministic = report?.deterministicReport ?? null;
  const showGenerated = !hidePeriodControls || report != null;

  return <section className="review-center-page" aria-label="复盘中心">
    <Panel title="周期复盘">
      {!hidePeriodControls && <SegmentedControl className="review-period-switch" role="group" aria-label="复盘周期">
        {periods.map((period) => <button key={period.kind} type="button" aria-pressed={periodKind === period.kind} onClick={() => selectPeriod(period.kind)}>{period.label}</button>)}
      </SegmentedControl>}
      <div className={`review-date-form${hidePeriodControls ? " is-locked" : ""}`}>
        {hidePeriodControls
          ? <p className="journal-muted">{periodStart} 至 {periodEnd}</p>
          : <>
            <label>周期开始<input type="date" value={periodStart} onChange={(event) => setFreeStart(event.target.value)} /></label>
            <label>周期结束<input type="date" value={periodEnd} onChange={(event) => setFreeEnd(event.target.value)} /></label>
          </>}
        <button className="secondary-button" type="button" onClick={() => void preview()} disabled={busy !== null}>{busy === "preview" ? "正在预览…" : "查看期间预览"}</button>
        <button className="primary-button" type="button" onClick={() => void create()} disabled={busy !== null}>{busy === "create" ? "正在生成…" : "生成确定性复盘"}</button>
      </div>
      {error && <p className="journal-error" role="alert">{error}</p>}
    </Panel>
    {deterministic && <MetricBand report={deterministic} />}
    {showGenerated && <SplitPane
      left={<Panel title="报告版本" heading="h2" aria-label="报告版本历史">
        {history.length ? <div className="review-history-list">{history.map((item) => <button type="button" key={item.reportId} className={`review-history-item${report?.reportId === item.reportId ? " selected" : ""}`} onClick={() => setReport(item)}><span>V{item.reportVersion}</span><strong>{statusLabel(item.snapshotStatus)}</strong><small>{item.periodStart} 至 {item.periodEnd}{item.isOutdated ? " · 已过期" : ""}</small></button>)}</div> : <EmptyState title="该周期还没有固化报告。" />}
      </Panel>}
      right={deterministic ? <section className="review-result" aria-label="确定性复盘结果">
        <div className="section-heading"><h2>确定性复盘结果</h2><ReportFlags report={report!} /></div>
        {report?.isOutdated && <p className="review-warning">当前展示的是旧快照；账本、日复盘或行情已经变化，请重新生成新版本。</p>}
        {report?.partialPeriod && <p className="review-warning">本周期尚不完整，以下内容只作进行中记录，不和完整周期做结论比较。</p>}
        <ReasonMatrix report={deterministic} />
        <CycleCases report={deterministic} />
        <Comparison report={deterministic} />
      </section> : <EmptyState title="该周期还没有固化报告。" />}
    />}
    {report && <ReviewState report={report} onRetry={() => void retry()} retrying={busy === "retry"} />}
    {pollError?.reportId === report?.reportId && pollError && <div><p className="journal-error" role="alert">报告状态查询中断：{pollError.message}</p><button className="secondary-button" type="button" onClick={() => setPollEpoch((value) => value + 1)}>恢复查询</button></div>}
    {deterministic && <Panel title="Pi 复盘总结" heading="h3">
      {report?.aiStatus === "not_requested" ? <p><strong>Pi 总结尚未请求</strong><span>本版先展示可审计的确定性统计，不用模型替代交易事实。</span></p> : <p><strong>{aiStatusLabel(report!.aiStatus)}</strong><span>交易复盘文字状态独立于确定性快照；当前页面只展示服务端返回的真实状态。</span></p>}
    </Panel>}
    {showGenerated && <StructureAttributionSection api={api} />}
  </section>;
}

function StructureAttributionSection({ api }: { api: TradingApi }) {
  const [attribution, setAttribution] = useState<StructureAttribution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getStructureAttribution().then((next) => {
      if (active) setAttribution(next);
    }).catch((reason: unknown) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [api]);

  return <Panel title="结构位置归因" heading="h3" className="structure-attribution" aria-label="结构位置归因">
    <p className="journal-muted">每个交易周期按其首笔买入成交时点的缠论结构位置归类；成交价先换算到行情前复权基准再与中枢比较；开放周期不参与胜率。</p>
    {error && <p className="journal-error" role="alert">{error}</p>}
    {attribution && <>
      <DataTable className="attribution-table" aria-label="买点结构类别聚合">
        <thead><tr><th>类别</th><th>已结周期</th><th>开放周期</th><th>盈利周期</th><th>胜率</th><th>合计盈亏</th><th>平均盈亏</th></tr></thead>
        <tbody>
          {attribution.summary.map((row) => <tr key={row.category}>
            <th scope="row">{attributionCategoryLabels[row.category]}</th>
            <td>{row.closedCycles}</td>
            <td>{row.openCycles}</td>
            <td>{row.won}</td>
            <td>{row.winRate === null ? "样本不足" : formatRate(row.winRate)}</td>
            <td>{formatMoney(row.totalPnl)}</td>
            <td>{row.avgPnl == null ? "—" : formatMoney(row.avgPnl)}</td>
          </tr>)}
        </tbody>
      </DataTable>
      {attribution.quality.symbolsMissingMarketData.length > 0 && <p className="review-warning">以下股票行情缺失，相关成交无法归因：{attribution.quality.symbolsMissingMarketData.join("、")}</p>}
      {attribution.executions.length ? <DataTable className="attribution-table attribution-detail" aria-label="逐笔成交归因明细">
        <thead><tr><th>成交日</th><th>股票</th><th>方向</th><th>成交价</th><th>换算价</th><th>中枢区间</th><th>类别</th></tr></thead>
        <tbody>
          {attribution.executions.map((row) => <tr key={row.executionId}>
            <td>{row.tradeDate}</td>
            <td>{row.symbol}</td>
            <td>{row.side === "buy" ? "买入" : "卖出"}</td>
            <td>{formatMoney(row.price)}</td>
            <td>{row.adjustedPrice == null ? "—" : formatMoney(row.adjustedPrice)}</td>
            <td>{row.centerLower !== null && row.centerUpper !== null ? `${row.centerLower} ~ ${row.centerUpper}` : "—"}</td>
            <td>{attributionLabel(row)}</td>
          </tr>)}
        </tbody>
      </DataTable> : <p className="journal-muted">还没有可归因的成交。</p>}
    </>}
  </Panel>;
}

function attributionLabel(row: StructureAttributionExecution): string {
  if (row.category === "unclassified" && row.reason !== null) return `${attributionCategoryLabels.unclassified}（${attributionReasonLabels[row.reason]}）`;
  return attributionCategoryLabels[row.category];
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
  return <div className="review-metric-band" role="group" aria-label="周期指标">
    <article>
      <span>报告期已实现盈亏</span>
      <strong className={`ui-metric-value tone-${signedTone(metrics.periodRealizedPnl)}`}>{formatSignedMoney(metrics.periodRealizedPnl)}</strong>
    </article>
    <article>
      <span>闭合周期盈亏</span>
      <strong className={`ui-metric-value tone-${signedTone(metrics.closedCyclePnl)}`}>{formatSignedMoney(metrics.closedCyclePnl)}</strong>
    </article>
    <article>
      <span>资金流调整收益率</span>
      <strong className={`ui-metric-value tone-${metrics.accountAdjustedReturnRate.value == null ? "neutral" : signedTone(metrics.accountAdjustedReturnRate.value)}`}>{metrics.accountAdjustedReturnRate.value == null ? "—" : formatRate(metrics.accountAdjustedReturnRate.value)}</strong>
      {metrics.accountAdjustedReturnRate.unavailableReason ? <small>{metrics.accountAdjustedReturnRate.unavailableReason}</small> : null}
    </article>
    <article>
      <span>周期最大回撤</span>
      <strong className="ui-metric-value tone-risk">{metrics.periodMaxDrawdownRate.value == null ? "—" : formatRate(metrics.periodMaxDrawdownRate.value)}</strong>
      {metrics.periodMaxDrawdownRate.unavailableReason ? <small>{metrics.periodMaxDrawdownRate.unavailableReason}</small> : null}
    </article>
    <article>
      <span>胜率</span>
      <strong className="ui-metric-value">{metrics.winRate.value == null ? "—" : formatRate(metrics.winRate.value)}</strong>
      {metrics.winRate.unavailableReason ? <small>{metrics.winRate.unavailableReason}</small> : null}
    </article>
    <article>
      <span>纪律执行率</span>
      <strong className="ui-metric-value">{metrics.disciplineAdherenceRate.value == null ? "—" : formatRate(metrics.disciplineAdherenceRate.value)}</strong>
      {metrics.disciplineAdherenceRate.unavailableReason ? <small>{metrics.disciplineAdherenceRate.unavailableReason}</small> : null}
    </article>
  </div>;
}

function ReasonMatrix({ report }: { report: TradingReviewDeterministicReport }) {
  return <Panel title="买卖理由表现" heading="h3" className="reason-matrix">{report.executionReasonFacts.length || report.reasonPerformance.length ? <div className="reason-grid">{report.executionReasonFacts.map((fact) => <article key={`${fact.side}-${fact.reasonCode}`}><span>{fact.side === "buy" ? "买入" : "卖出"}</span><strong>{reasonLabels[fact.reasonCode]}</strong><small>{fact.executionCount} 笔 · {fact.quantity} 股 · {formatMoney(fact.grossAmount)}</small></article>)}{report.reasonPerformance.map((performance) => <article key={`${performance.side}-${performance.reasonCode}`}><span>{performance.side === "buy" ? "买入" : "卖出"}</span><strong>{reasonLabels[performance.reasonCode]}</strong><small>{performance.conclusionAllowed ? `样本 ${performance.sampleCount} · 净盈亏 ${formatSignedMoney(performance.netPnl)}` : `样本 ${performance.sampleCount}，仅展示事实`}</small></article>)}</div> : <p className="journal-muted">本周期没有足以归类的交易理由事实。</p>}</Panel>;
}

function CycleCases({ report }: { report: TradingReviewDeterministicReport }) {
  return <Panel title="交易周期" heading="h3" className="cycle-cases">{report.cycleCases.length ? <div className="cycle-list">{report.cycleCases.map((cycle) => <article key={cycle.cycleId}><div><strong>{cycle.symbol}</strong><span>{cycle.name} · {cycle.holdingDays} 个交易日</span></div><div><span>{reasonLabels[cycle.buyReasonCode]} → {reasonLabels[cycle.sellReasonCode]}</span><strong>{formatSignedMoney(cycle.netPnl)}</strong></div></article>)}</div> : <p className="journal-muted">本周期还没有闭合交易周期。</p>}</Panel>;
}

function Comparison({ report }: { report: TradingReviewDeterministicReport }) {
  if (report.comparison === null) return <Panel title="同类周期比较" heading="h3" className="comparison-panel"><p className="journal-muted">{report.comparisonUnavailableReason === "partial_period" ? "当前周期尚未完整，暂不比较。" : "没有可比较的上一同类完整周期。"}</p></Panel>;
  return <Panel title="同类周期比较" heading="h3" className="comparison-panel"><p className="comparison-period">对比 {report.comparison.previousPeriod.start} 至 {report.comparison.previousPeriod.end}</p><div className="comparison-list">{report.comparison.metrics.map((metric) => <div key={metric.metricRef}><span>{metric.metricRef}</span><strong>{metric.current.value ?? "—"}</strong><small>前期 {metric.previous.value ?? "—"} · 变化 {metric.delta.value ?? "—"}</small></div>)}</div></Panel>;
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
