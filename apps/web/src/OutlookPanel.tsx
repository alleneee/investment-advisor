import { useEffect, useState } from "react";
import type {
  InvestmentConfidence,
  InvestmentDirection,
  InvestmentReportJob,
  InvestmentReportStatus,
  InvestmentScenario,
  InvestmentScenarioCase,
  ReferenceFact,
  ReportCondition,
  ReportOutcome,
  ReportOutcomeStatus,
  ReportReviewDecision,
} from "./types";

interface OutlookPanelProps {
  job: InvestmentReportJob | null;
  pendingStatus?: InvestmentReportStatus | null;
  busy?: boolean;
  requestError?: string | null;
  deliveryBusy?: boolean;
  deliveryError?: string | null;
  onGenerate: () => void;
  onRetry: () => void;
  onReview?: (decision: ReportReviewDecision) => void;
  onPublish?: () => void;
  onEvaluateOutcome?: () => void;
  onCreateShare?: () => void;
  onRevokeShare?: () => void;
}

const DISCLAIMER = "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。";

export function OutlookPanel({
  job,
  pendingStatus = null,
  busy = false,
  requestError = null,
  deliveryBusy = false,
  deliveryError = null,
  onGenerate,
  onRetry,
  onReview,
  onPublish,
  onEvaluateOutcome,
  onCreateShare,
  onRevokeShare,
}: OutlookPanelProps) {
  const status = job?.status ?? pendingStatus;
  return <section className="outlook-panel" aria-labelledby="outlook-heading">
    <div className="outlook-header">
      <div>
        <span className="evidence-kicker">PI AI · CONDITIONAL OUTLOOK</span>
        <h3 id="outlook-heading">Pi AI 三情景走势报告</h3>
      </div>
      {job?.report && <div className="outlook-meta"><span>GENERATED</span><time dateTime={job.report.generatedAt}>{job.report.generatedAt}</time><strong>{reviewLabel(job.reviewStatus)}</strong></div>}
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
      <DeliverySection
        job={job}
        busy={deliveryBusy}
        error={deliveryError}
        onReview={onReview}
        onPublish={onPublish}
        onEvaluateOutcome={onEvaluateOutcome}
        onCreateShare={onCreateShare}
        onRevokeShare={onRevokeShare}
      />
    </div>}
  </section>;
}

function DeliverySection({
  job,
  busy,
  error,
  onReview,
  onPublish,
  onEvaluateOutcome,
  onCreateShare,
  onRevokeShare,
}: {
  job: InvestmentReportJob;
  busy: boolean;
  error: string | null;
  onReview?: (decision: ReportReviewDecision) => void;
  onPublish?: () => void;
  onEvaluateOutcome?: () => void;
  onCreateShare?: () => void;
  onRevokeShare?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [job.shareToken]);
  if (!onReview && !onPublish && !onEvaluateOutcome) return null;
  const published = Boolean(job.publishedAt);
  return <div className="outlook-delivery" aria-labelledby="delivery-heading">
    <span className="outlook-subheading" id="delivery-heading">对客交付</span>
    <dl className="delivery-status">
      <div><dt>审阅</dt><dd>{reviewLabel(job.reviewStatus)}</dd></div>
      <div><dt>发布</dt><dd>{published ? <time dateTime={job.publishedAt ?? undefined}>{job.publishedAt}</time> : "尚未发布"}</dd></div>
    </dl>
    <div className="delivery-actions">
      {onReview && job.reviewStatus !== "accepted" && <button type="button" disabled={busy} onClick={() => onReview("accepted")}>通过审阅</button>}
      {onReview && job.reviewStatus !== "rejected" && <button type="button" disabled={busy} onClick={() => onReview("rejected")}>驳回</button>}
      {onPublish && job.reviewStatus === "accepted" && !published && <button type="button" disabled={busy} onClick={onPublish}>发布给客户</button>}
      {onEvaluateOutcome && <button type="button" disabled={busy} onClick={onEvaluateOutcome}>{job.outcome ? "重新评估兑现" : "评估情景兑现"}</button>}
    </div>
    {published && (onCreateShare || onRevokeShare) && <div className="delivery-share">
      <span className="outlook-subheading">分享链接</span>
      {job.shareToken
        ? <>
          <p className="share-link-text">{shareUrl(job.shareToken)}</p>
          <div className="delivery-actions">
            <a className="delivery-action-link" href={shareUrl(job.shareToken)} target="_blank" rel="noreferrer">打开对客报告</a>
            <button
              type="button"
              disabled={busy}
              onClick={() => void copyShareLink(job.shareToken as string, () => setCopied(true))}
            >{copied ? "已复制" : "复制链接"}</button>
            {onRevokeShare && <button type="button" disabled={busy} onClick={onRevokeShare}>撤销分享</button>}
          </div>
        </>
        : onCreateShare && <div className="delivery-actions">
          <button type="button" disabled={busy} onClick={onCreateShare}>生成分享链接</button>
        </div>}
    </div>}
    {error && <p className="delivery-error" role="alert">{error}</p>}
    {job.outcome && <OutcomeSummary outcome={job.outcome} />}
  </div>;
}

export function shareUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/share/${encodeURIComponent(token)}`;
}

async function copyShareLink(token: string, onCopied: () => void) {
  if (!navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(shareUrl(token));
    onCopied();
  } catch {
    // 剪贴板不可用时保持链接文本可见，用户可手动复制。
  }
}

function OutcomeSummary({ outcome }: { outcome: ReportOutcome }) {
  return <div className="delivery-outcome">
    <dl className="delivery-status">
      <div><dt>兑现结论</dt><dd>{outcomeStatusLabel(outcome.status, outcome.realizedCase)}</dd></div>
      <div><dt>观察窗口</dt><dd>{outcome.window.barCount} / {outcome.window.requiredBars} 个交易日</dd></div>
    </dl>
    {outcome.quality.warnings.length > 0 && <ul className="delivery-warnings">
      {outcome.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>}
  </div>;
}

function reviewLabel(value: InvestmentReportJob["reviewStatus"]): string {
  return { pending: "待审阅", accepted: "已通过", rejected: "已驳回" }[value];
}

export function outcomeStatusLabel(
  status: ReportOutcomeStatus,
  realizedCase: InvestmentScenarioCase | null,
): string {
  if (status === "realized" && realizedCase) {
    return `${scenarioLabel(realizedCase)}情景兑现`;
  }
  return {
    pending: "窗口尚未走满，暂不判定",
    realized: "已兑现",
    none_realized: "三个情景均未兑现",
    ambiguous: "多个情景同时成立，需人工复核",
    inconclusive: "存在无法判定的条件",
  }[status];
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

export function formatFactValue(fact: ReferenceFact): string {
  if (fact.value == null) return "—";
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}

export function scenarioLabel(value: InvestmentScenarioCase): string {
  return { bullish: "偏强", base: "基准", bearish: "偏弱" }[value];
}

export function scenarioIndex(value: InvestmentScenarioCase): string {
  return { bullish: "A", base: "B", bearish: "C" }[value];
}

export function directionLabel(value: InvestmentDirection): string {
  return { bullish: "方向偏强", sideways: "区间观察", bearish: "方向偏弱", uncertain: "方向待确认" }[value];
}

export function confidenceLabel(value: InvestmentConfidence): string {
  return { low: "低置信度", medium: "中置信度", high: "高置信度" }[value];
}

export function conditionLabel(value: ReportCondition["operator"]): string {
  return {
    break_above: "向上突破",
    hold_above: "保持上方",
    break_below: "向下跌破",
    hold_below: "保持下方",
    structure_confirmed: "结构确认",
    structure_invalidated: "结构失效",
  }[value];
}
