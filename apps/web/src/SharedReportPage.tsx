import { toBlob } from "html-to-image";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ApiError, type WorkbenchApi } from "./api";
import { ChanChart } from "./ChanChart";
import {
  conditionLabel,
  confidenceLabel,
  directionLabel,
  formatFactValue,
  outcomeStatusLabel,
  scenarioIndex,
  scenarioLabel,
} from "./OutlookPanel";
import type { InvestmentScenario, SharedReport, SharedReportOutcome } from "./types";

interface SharedReportPageProps {
  token: string;
  api: WorkbenchApi;
}

const INVALID_LINK_MESSAGE = "分享链接无效或已撤销，请与您的顾问确认最新链接。";

export function SharedReportPage({ token, api }: SharedReportPageProps) {
  const reportRef = useRef<HTMLElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const chartRef = useRef<HTMLElement | null>(null);
  const scenariosRef = useRef<HTMLElement | null>(null);
  const risksRef = useRef<HTMLElement | null>(null);
  const evidenceRef = useRef<HTMLElement | null>(null);
  const outcomeRef = useRef<HTMLElement | null>(null);
  const exportGenerationRef = useRef(0);
  const [report, setReport] = useState<SharedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportingImage, setExportingImage] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    exportGenerationRef.current += 1;
    setLoading(true);
    setError(null);
    setReport(null);
    setExportError(null);
    setExportingImage(false);
    api.getSharedReport(token)
      .then((value) => {
        if (!active) return;
        setReport(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof ApiError && cause.status === 404
          ? INVALID_LINK_MESSAGE
          : cause instanceof ApiError
            ? cause.message
            : "报告加载失败，请稍后重试。");
        setLoading(false);
      });
    return () => {
      active = false;
      exportGenerationRef.current += 1;
    };
  }, [api, token]);

  async function exportLongImage() {
    if (exportingImage || reportRef.current == null || report == null) return;
    const generation = exportGenerationRef.current + 1;
    exportGenerationRef.current = generation;
    setExportingImage(true);
    setExportError(null);
    try {
      const blob = await toBlob(reportRef.current, {
        backgroundColor: "#131313",
        cacheBust: true,
        pixelRatio: 2,
        style: { margin: "0" },
        filter: (node) => !(node instanceof HTMLElement && node.hasAttribute("data-export-ignore")),
      });
      if (exportGenerationRef.current !== generation) return;
      if (blob == null) throw new Error();
      downloadBlob(blob, `${report.symbol}-${report.asOf}-研究报告.png`);
    } catch {
      if (exportGenerationRef.current === generation) {
        setExportError("长图导出失败，请稍后重试。");
      }
    } finally {
      if (exportGenerationRef.current === generation) {
        setExportingImage(false);
      }
    }
  }

  if (loading) {
    return <div className="share-page">
      <div className="share-state" role="status">正在加载研究报告…</div>
    </div>;
  }

  if (error != null || report == null) {
    return <div className="share-page">
      <div className="share-state share-error" role="alert">
        <strong>无法打开研究报告</strong>
        <p>{error ?? INVALID_LINK_MESSAGE}</p>
      </div>
    </div>;
  }

  return <div className="share-page">
    <article ref={reportRef} className="share-report" aria-label="对客研究报告">
      <header className="share-header">
        <div className="share-header-top">
          <span className="share-kicker">结构投研 · 对客研究报告</span>
          <div className="share-export-tools" data-export-ignore="true">
            <div className="share-export-actions">
              <button type="button" className="share-export-button" onClick={() => window.print()}>
                导出 PDF
              </button>
              <button
                type="button"
                className="share-export-button share-export-image-button"
                disabled={exportingImage}
                onClick={exportLongImage}
              >
                {exportingImage ? "正在导出…" : "导出长图"}
              </button>
            </div>
            {exportError && <p className="share-export-error" role="alert">{exportError}</p>}
          </div>
        </div>
        <h1>{report.title}</h1>
        <dl className="share-meta">
          <div><dt>标的</dt><dd>{report.symbol}</dd></div>
          <div><dt>周期</dt><dd>{report.timeframe === "1d" ? "日线" : "周线"}</dd></div>
          <div><dt>数据截至</dt><dd>{report.asOf}</dd></div>
          <div><dt>生成日期</dt><dd><time dateTime={report.generatedAt}>{dateOnly(report.generatedAt)}</time></dd></div>
          <div><dt>研判基调</dt><dd>{directionLabel(report.outlook.direction)} · {confidenceLabel(report.outlook.confidence)}</dd></div>
        </dl>
      </header>

      <nav className="share-reading-nav" aria-label="报告阅读导航" data-export-ignore="true">
        <button type="button" onClick={() => focusSection(summaryRef)}>摘要</button>
        <button type="button" onClick={() => focusSection(chartRef)}>结构图</button>
        <button type="button" onClick={() => focusSection(scenariosRef)}>情景</button>
        <button type="button" onClick={() => focusSection(risksRef)}>风险</button>
        <button type="button" onClick={() => focusSection(evidenceRef)}>证据</button>
        {report.outcome && <button type="button" onClick={() => focusSection(outcomeRef)}>兑现结果</button>}
      </nav>

      <section ref={summaryRef} tabIndex={-1} className="share-section" aria-label="报告摘要">
        <p className="share-summary">{report.executiveSummary}</p>
        <blockquote className="share-thesis">{report.outlook.thesis}</blockquote>
      </section>

      <section ref={chartRef} tabIndex={-1} className="share-section share-chart-section" aria-label="缠论结构图">
        <h2>缠论结构与固化行情</h2>
        <ChanChart symbol={report.symbol} data={report.chart} />
        {report.quality.warnings.length > 0 && <p className="share-quality-note">{report.quality.warnings.join("；")}</p>}
      </section>

      <section ref={scenariosRef} tabIndex={-1} className="share-section" aria-label="三情景展望">
        <h2>三情景展望（未来五到二十个交易日）</h2>
        <div className="share-scenarios">
          {report.outlook.scenarios.map((scenario) => <SharedScenarioCard scenario={scenario} key={scenario.case} />)}
        </div>
      </section>

      <section ref={risksRef} tabIndex={-1} className="share-section" aria-label="风险提示">
        <h2>风险提示</h2>
        {report.risks.length
          ? <ul className="share-risks">
            {report.risks.map((risk, index) => <li key={`${risk.narrative}-${index}`}>{risk.narrative}</li>)}
          </ul>
          : <p className="share-empty">本报告未列出额外风险条目。</p>}
      </section>

      <section ref={evidenceRef} tabIndex={-1} className="share-section" aria-label="证据来源">
        <h2>证据来源</h2>
        <ol className="share-evidence">
          {report.evidence.map((fact) => <li key={fact.ref}>
            <span className="share-evidence-label">
              {fact.url
                ? <a href={fact.url} target="_blank" rel="noreferrer">{fact.label}</a>
                : fact.label}
            </span>
            <span className="share-evidence-value">{formatFactValue(fact)}</span>
            {fact.occurredAt && <small>{dateOnly(fact.occurredAt)}</small>}
          </li>)}
        </ol>
      </section>

      {report.outcome && <SharedOutcomeSection outcome={report.outcome} sectionRef={outcomeRef} />}

      <footer className="share-disclaimer" role="note">
        <strong>免责声明</strong>
        <p>{report.disclaimer}</p>
      </footer>
    </article>
  </div>;
}

function focusSection(sectionRef: RefObject<HTMLElement | null>) {
  const section = sectionRef.current;
  if (!section) return;
  section.focus({ preventScroll: true });
  section.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function SharedScenarioCard({ scenario }: { scenario: InvestmentScenario }) {
  return <article className={`share-scenario scenario-${scenario.case}`}>
    <div className="share-scenario-heading">
      <span>{scenarioIndex(scenario.case)}</span>
      <h3>{scenarioLabel(scenario.case)}情景</h3>
    </div>
    <p>{scenario.narrative}</p>
    <dl className="share-conditions">
      <div>
        <dt>触发条件</dt>
        <dd>{conditionLabel(scenario.trigger.operator)} · {scenario.trigger.fact.label} / {formatFactValue(scenario.trigger.fact)}</dd>
      </div>
      <div>
        <dt>失效条件</dt>
        <dd>{conditionLabel(scenario.invalidation.operator)} · {scenario.invalidation.fact.label} / {formatFactValue(scenario.invalidation.fact)}</dd>
      </div>
    </dl>
  </article>;
}

function SharedOutcomeSection({ outcome, sectionRef }: { outcome: SharedReportOutcome; sectionRef: RefObject<HTMLElement | null> }) {
  return <section ref={sectionRef} tabIndex={-1} className="share-section share-outcome" aria-label="兑现结果">
    <h2>情景兑现结果</h2>
    <dl className="share-meta">
      <div><dt>兑现结论</dt><dd>{outcomeStatusLabel(outcome.status, outcome.realizedCase)}</dd></div>
      <div><dt>观察窗口</dt><dd>{outcome.window.barCount} / {outcome.window.requiredBars} 个交易日</dd></div>
      <div><dt>评估时间</dt><dd><time dateTime={outcome.evaluatedAt}>{dateOnly(outcome.evaluatedAt)}</time></dd></div>
    </dl>
    {outcome.quality.warnings.length > 0 && <ul className="share-warnings">
      {outcome.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>}
  </section>;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}
