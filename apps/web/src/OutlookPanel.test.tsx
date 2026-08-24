import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OutlookPanel } from "./OutlookPanel";
import type { InvestmentReport, InvestmentReportJob, InvestmentReportStatus, ReferenceFact } from "./types";

function investmentReport(): InvestmentReport {
  const close: ReferenceFact = { ref: "market.latest_close", kind: "price_level", label: "最新收盘", value: 20.6, unit: "CNY" };
  const structure: ReferenceFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "中枢震荡" };
  const news: ReferenceFact = { ref: "news.latest", kind: "news", label: "公司经营进展", value: "经营保持稳定", url: "https://example.com/news/1" };
  return {
    id: "report-1",
    schemaVersion: "investment_report.v2",
    runId: "run-1",
    symbol: "002940.SZ",
    timeframe: "1w",
    asOf: "2026-08-13",
    generatedAt: "2026-08-13T09:05:00+08:00",
    title: "结构与资讯综合研判",
    executiveSummary: "结构处于等待确认阶段。",
    references: { [close.ref]: close, [structure.ref]: structure, [news.ref]: news },
    outlook: {
      horizon: "5-20-trading-days",
      direction: "uncertain",
      confidence: "medium",
      thesis: "以后续结构确认与失效条件切换情景。",
      scenarios: [
        ["bullish", "结构确认后观察偏强情景。"],
        ["base", "中枢约束下保持基准观察。"],
        ["bearish", "结构失效后观察偏弱情景。"],
      ].map(([scenarioCase, narrative]) => ({
        case: scenarioCase as "bullish" | "base" | "bearish",
        narrative,
        trigger: { operator: "structure_confirmed", factRef: structure.ref, fact: structure },
        invalidation: { operator: "structure_invalidated", factRef: structure.ref, fact: structure },
        evidenceRefs: [structure.ref, news.ref],
        evidence: [structure, news],
      })),
    },
    risks: [{ narrative: "资讯存在时效差异。", evidenceRefs: [news.ref], evidence: [news] }],
    evidenceRefs: [close.ref, structure.ref, news.ref],
    evidence: [close, structure, news],
    disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
    review: { status: "pending" },
  };
}

function job(
  status: InvestmentReportStatus,
  overrides: Partial<InvestmentReportJob> = {},
): InvestmentReportJob {
  return {
    reportId: "report-1",
    status,
    symbol: "002940.SZ",
    timeframe: "1w",
    asOf: "2026-08-13",
    inputDigest: "digest-1",
    attemptCount: 1,
    updatedAt: "2026-08-13T09:06:00+08:00",
    report: status === "completed" ? investmentReport() : null,
    error: status === "failed" ? { code: "TIMEOUT", message: "报告生成超时", retryable: true } : null,
    reviewStatus: "pending",
    reviewedAt: null,
    publishedAt: null,
    shareToken: null,
    outcome: null,
    ...overrides,
  };
}

describe("OutlookPanel", () => {
  it("does not generate until the user explicitly asks", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<OutlookPanel job={null} onGenerate={onGenerate} onRetry={vi.fn()} />);

    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    expect(onGenerate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("shows queued and running progress independently", () => {
    const { rerender } = render(<OutlookPanel job={job("queued")} onGenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText("报告已排队")).toBeInTheDocument();

    rerender(<OutlookPanel job={job("running")} onGenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText("Pi AI 正在生成三情景报告")).toBeInTheDocument();
    expect(screen.queryByText(/引用证据/)).not.toBeInTheDocument();
  });

  it("renders scenarios and risks without evidence labels or evidence details", () => {
    const { container } = render(<OutlookPanel job={job("completed")} onGenerate={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "偏强" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "基准" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "偏弱" })).toBeInTheDocument();
    expect(screen.getAllByText("触发")).toHaveLength(3);
    expect(screen.getAllByText("失效")).toHaveLength(3);
    expect(screen.getByText("风险边界")).toBeInTheDocument();
    expect(screen.getByText("资讯存在时效差异。")).toBeInTheDocument();
    expect(container.querySelector(".scenario-evidence")).not.toBeInTheDocument();
    expect(container.querySelector(".outlook-evidence-section")).not.toBeInTheDocument();
    expect(screen.queryByText("引用证据")).not.toBeInTheDocument();
    expect(screen.queryByText("公司经营进展")).not.toBeInTheDocument();
    expect(screen.getByText("2026-08-13T09:05:00+08:00")).toBeInTheDocument();
    expect(screen.getByText("待审阅")).toBeInTheDocument();
    expect(screen.getByText("本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。")).toBeInTheDocument();
  });

  it("offers the dedicated retry action after a retryable failure", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<OutlookPanel job={job("failed")} onGenerate={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("报告生成超时");
    await user.click(screen.getByRole("button", { name: "重试 Pi AI 报告" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("hides the delivery section when no delivery handlers are provided", () => {
    render(<OutlookPanel job={job("completed")} onGenerate={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.queryByText("对客交付")).not.toBeInTheDocument();
  });

  it("keeps publishing unavailable until the review is accepted", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onPublish = vi.fn();
    const { rerender } = render(<OutlookPanel
      job={job("completed")}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={onReview}
      onPublish={onPublish}
    />);

    expect(screen.getAllByText("待审阅").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "发布给客户" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "通过审阅" }));
    expect(onReview).toHaveBeenCalledWith("accepted");

    rerender(<OutlookPanel
      job={job("completed", { reviewStatus: "accepted" })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={onReview}
      onPublish={onPublish}
    />);

    expect(screen.getAllByText("已通过").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "发布给客户" }));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("shows the publication time and stops offering publish once published", () => {
    render(<OutlookPanel
      job={job("completed", { reviewStatus: "accepted", publishedAt: "2026-08-13T10:05:00+08:00" })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={vi.fn()}
      onPublish={vi.fn()}
    />);

    expect(screen.getByText("2026-08-13T10:05:00+08:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布给客户" })).not.toBeInTheDocument();
  });

  it("reports the realized scenario and window progress", async () => {
    const user = userEvent.setup();
    const onEvaluateOutcome = vi.fn();
    render(<OutlookPanel
      job={job("completed", {
        outcome: {
          reportId: "report-1",
          symbol: "002940.SZ",
          asOf: "2026-08-13",
          evaluatedAt: "2026-09-12T09:00:00+08:00",
          status: "realized",
          adjudication: "single_candidate",
          realizedCase: "bullish",
          realizedCases: ["bullish"],
          window: { start: "20260814", end: "20260911", barCount: 20, requiredBars: 20 },
          scenarios: [],
          quality: { status: "ok", warnings: [] },
        },
      })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onEvaluateOutcome={onEvaluateOutcome}
    />);

    expect(screen.getByText("偏强情景兑现")).toBeInTheDocument();
    expect(screen.getByText("20 / 20 个交易日")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新评估兑现" }));
    expect(onEvaluateOutcome).toHaveBeenCalledOnce();
  });

  it("states that a short window is not judged yet and surfaces its warnings", () => {
    render(<OutlookPanel
      job={job("completed", {
        outcome: {
          reportId: "report-1",
          symbol: "002940.SZ",
          asOf: "2026-08-13",
          evaluatedAt: "2026-08-20T09:00:00+08:00",
          status: "pending",
          adjudication: "window_pending",
          realizedCase: null,
          realizedCases: [],
          window: { start: "20260814", end: "20260818", barCount: 3, requiredBars: 20 },
          scenarios: [],
          quality: { status: "degraded", warnings: ["展望窗口尚未走满二十个交易日"] },
        },
      })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onEvaluateOutcome={vi.fn()}
    />);

    expect(screen.getByText("窗口尚未走满，暂不判定")).toBeInTheDocument();
    expect(screen.getByText("展望窗口尚未走满二十个交易日")).toBeInTheDocument();
  });

  it("keeps share controls hidden until the report is published", () => {
    render(<OutlookPanel
      job={job("completed", { reviewStatus: "accepted" })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={vi.fn()}
      onCreateShare={vi.fn()}
      onRevokeShare={vi.fn()}
    />);

    expect(screen.queryByText("分享链接")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成分享链接" })).not.toBeInTheDocument();
  });

  it("creates, copies, and revokes the share link for a published report", async () => {
    const user = userEvent.setup();
    const onCreateShare = vi.fn();
    const onRevokeShare = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const published = { reviewStatus: "accepted" as const, publishedAt: "2026-08-13T10:05:00+08:00" };
    const { rerender } = render(<OutlookPanel
      job={job("completed", published)}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={vi.fn()}
      onCreateShare={onCreateShare}
      onRevokeShare={onRevokeShare}
    />);

    expect(screen.queryByRole("link", { name: "打开对客报告" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成分享链接" }));
    expect(onCreateShare).toHaveBeenCalledOnce();

    rerender(<OutlookPanel
      job={job("completed", { ...published, shareToken: "token-1" })}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={vi.fn()}
      onCreateShare={onCreateShare}
      onRevokeShare={onRevokeShare}
    />);

    expect(screen.queryByRole("button", { name: "生成分享链接" })).not.toBeInTheDocument();
    expect(screen.getByText(/#\/share\/token-1$/)).toBeInTheDocument();
    const reportLink = screen.getByRole("link", { name: "打开对客报告" });
    expect(reportLink.getAttribute("href")).toContain("#/share/token-1");
    expect(reportLink).toHaveAttribute("target", "_blank");
    expect(reportLink).toHaveAttribute("rel", "noreferrer");

    await user.click(screen.getByRole("button", { name: "复制链接" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#/share/token-1"));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "撤销分享" }));
    expect(onRevokeShare).toHaveBeenCalledOnce();
  });

  it("surfaces a delivery failure without touching the report body", () => {
    render(<OutlookPanel
      job={job("completed")}
      onGenerate={vi.fn()}
      onRetry={vi.fn()}
      onReview={vi.fn()}
      deliveryError="报告需通过审阅后才能发布"
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("报告需通过审阅后才能发布");
    expect(screen.getByRole("heading", { name: "偏强" })).toBeInTheDocument();
  });
});
