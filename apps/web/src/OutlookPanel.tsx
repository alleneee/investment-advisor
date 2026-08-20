import type { InvestmentReportJob, InvestmentReportStatus, InvestmentScenario, ReferenceFact } from "./types";

interface OutlookPanelProps {
  job: InvestmentReportJob | null;
  pendingStatus?: InvestmentReportStatus | null;
  busy?: boolean;
  requestError?: string | null;
  onGenerate: () => void;
  onRetry: () => void;
}

const DISCLAIMER = "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。";

export function OutlookPanel({
  job,
  pendingStatus = null,
  busy = false,
  requestError = null,
  onGenerate,
  onRetry,
}: OutlookPanelProps) {
  const status = job?.status ?? pendingStatus;
  return <section className="outlook-panel" aria-labelledby="outlook-heading">
    <div className="outlook-header">
      <div>
        <span className="evidence-kicker">PI AI · CONDITIONAL OUTLOOK</span>
        <h3 id="outlook-heading">Pi AI 三情景走势报告</h3>
      </div>
      {job?.report && <div className="outlook-meta"><span>GENERATED</span><time dateTime={job.report.generatedAt}>{job.report.generatedAt}</time><strong>待审阅 · {job.report.review.status}</strong></div>}
    </div>
    {!status && <div className="outlook-idle">
      <div><strong>尚未生成 Pi AI 走势报告</strong><p>按当前股票与周期固化输入后，生成偏强、基准、偏弱三种条件化情景。</p></div>
      <button type="button" className="outlook-action" disabled={busy} onClick={onGenerate}>{busy ? "正在创建…" : "生成 Pi AI 走势报告"}</button>
    </div>}
    {requestError && !status && <div className="outlook-error" role="alert">{requestError}</div>}
    {status === "queued" && <ReportProgress label="报告已排队" detail="等待 Pi AI 运行资源" />}
    {status === "running" && <ReportProgress label="Pi AI 正在生成三情景报告" detail="结构与资讯正在整理" />}
    {status === "failed" && <div className="outlook-failed" role="alert">
      <div><span>{job?.error?.code ?? "REPORT_FAILED"}</span><strong>{job?.error?.message ?? "Pi AI 报告生成失败"}</strong></div>
      {job?.error?.retryable && <button type="button" disabled={busy} onClick={onRetry}>{busy ? "正在重试…" : "重试 Pi AI 报告"}</button>}
    </div>}
    {status === "completed" && job?.report && <div className="outlook-report">
      <div className="outlook-summary"><span>{directionLabel(job.report.outlook.direction)} · {confidenceLabel(job.report.outlook.confidence)}</span><h4>{job.report.title}</h4><p>{job.report.executiveSummary}</p><blockquote>{job.report.outlook.thesis}</blockquote></div>
      <div className="scenario-grid">{job.report.outlook.scenarios.map((scenario) => <ScenarioCard scenario={scenario} key={scenario.case} />)}</div>
      <div className="outlook-risk-section"><span className="outlook-subheading">风险边界</span><div className="risk-list">{job.report.risks.map((risk, index) => <p key={`${risk.narrative}-${index}`}>{risk.narrative}</p>)}</div></div>
      <p className="outlook-disclaimer">{DISCLAIMER}</p>
    </div>}
  </section>;
}

function ReportProgress({ label, detail }: { label: string; detail: string }) {
  return <div className="outlook-progress" role="status"><span className="outlook-progress-mark" /><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function ScenarioCard({ scenario }: { scenario: InvestmentScenario }) {
  return <article className={`scenario-card scenario-${scenario.case}`}>
    <div className="scenario-heading"><span>{scenarioIndex(scenario.case)}</span><h4>{scenarioLabel(scenario.case)}</h4></div>
    <p>{scenario.narrative}</p>
    <dl className="scenario-conditions">
      <div><dt>触发</dt><dd>{conditionLabel(scenario.trigger.operator)} · {scenario.trigger.fact.label} / {formatFactValue(scenario.trigger.fact)}</dd></div>
      <div><dt>失效</dt><dd>{conditionLabel(scenario.invalidation.operator)} · {scenario.invalidation.fact.label} / {formatFactValue(scenario.invalidation.fact)}</dd></div>
    </dl>
  </article>;
}

function formatFactValue(fact: ReferenceFact): string {
  if (fact.value == null) return "—";
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}

function scenarioLabel(value: InvestmentScenario["case"]): string {
  return { bullish: "偏强", base: "基准", bearish: "偏弱" }[value];
}

function scenarioIndex(value: InvestmentScenario["case"]): string {
  return { bullish: "A", base: "B", bearish: "C" }[value];
}

function directionLabel(value: NonNullable<InvestmentReportJob["report"]>["outlook"]["direction"]): string {
  return { bullish: "方向偏强", sideways: "区间观察", bearish: "方向偏弱", uncertain: "方向待确认" }[value];
}

function confidenceLabel(value: NonNullable<InvestmentReportJob["report"]>["outlook"]["confidence"]): string {
  return { low: "低置信度", medium: "中置信度", high: "高置信度" }[value];
}

function conditionLabel(value: InvestmentScenario["trigger"]["operator"]): string {
  return {
    break_above: "向上突破",
    hold_above: "保持上方",
    break_below: "向下跌破",
    hold_below: "保持下方",
    structure_confirmed: "结构确认",
    structure_invalidated: "结构失效",
  }[value];
}
