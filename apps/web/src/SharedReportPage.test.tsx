import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkbenchApi } from "./api";
import { SharedReportPage } from "./SharedReportPage";
import type { ChanChartData, ReferenceFact, SharedReport } from "./types";

vi.mock("./ChanChart", () => ({
  ChanChart: ({ symbol, data }: { symbol: string; data: ChanChartData }) => data.bars.length
    ? <div role="img" aria-label={`${symbol} 图表`} />
    : <div>当前周期暂无可绘制行情</div>,
}));

function sharedReport(): SharedReport {
  const close: ReferenceFact = { ref: "market.latest_close", kind: "price_level", label: "最新收盘", value: 20.6, unit: "CNY" };
  const structure: ReferenceFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "中枢震荡" };
  const news: ReferenceFact = {
    ref: "news.latest",
    kind: "news",
    label: "公司经营进展",
    value: "经营保持稳定",
    url: "https://example.com/news/1",
    occurredAt: "2026-08-12T15:00:00+08:00",
  };
  return {
    symbol: "002940.SZ",
    timeframe: "1d",
    asOf: "2026-08-13",
    generatedAt: "2026-08-13T09:05:00+08:00",
    publishedAt: "2026-08-14T09:00:00+08:00",
    title: "结构与资讯综合研判",
    executiveSummary: "结构处于等待确认阶段。",
    outlook: {
      horizon: "5-20-trading-days",
      direction: "uncertain",
      confidence: "medium",
      thesis: "以后续结构确认与失效条件切换情景。",
      scenarios: [
        ["bullish", "结构确认后观察偏强情景。"] as const,
        ["base", "中枢约束下保持基准观察。"] as const,
        ["bearish", "结构失效后观察偏弱情景。"] as const,
      ].map(([scenarioCase, narrative]) => ({
        case: scenarioCase,
        narrative,
        trigger: { operator: "break_above" as const, factRef: close.ref, fact: close },
        invalidation: { operator: "structure_invalidated" as const, factRef: structure.ref, fact: structure },
        evidenceRefs: [close.ref, news.ref],
        evidence: [close, news],
      })),
    },
    risks: [{ narrative: "资讯存在时效差异。", evidenceRefs: [news.ref], evidence: [news] }],
    evidence: [close, structure, news],
    disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
    chart: {
      timeframe: "1d",
      bars: [{ occurredAt: "2026-08-12T00:00:00Z", open: 20.2, close: 20.6, low: 20.1, high: 21, volume: 100 }],
      strokes: [],
      centers: [],
    },
    quality: { status: "ok", warnings: [] },
    outcome: {
      status: "realized",
      realizedCase: "bullish",
      evaluatedAt: "2026-09-10T09:00:00+08:00",
      window: { start: "20260814", end: "20260909", barCount: 20, requiredBars: 20 },
      quality: { status: "degraded", warnings: ["展望窗口存在停牌交易日"] },
    },
  };
}

function apiWith(getSharedReport: WorkbenchApi["getSharedReport"]): WorkbenchApi {
  return { getSharedReport } as WorkbenchApi;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SharedReportPage", () => {
  it("renders the customer-facing report body from the share endpoint only", async () => {
    const getSharedReport = vi.fn(async () => sharedReport());
    render(<SharedReportPage token="token-1" api={apiWith(getSharedReport)} />);

    expect(await screen.findByRole("heading", { name: "结构与资讯综合研判" })).toBeInTheDocument();
    expect(getSharedReport).toHaveBeenCalledTimes(1);
    expect(getSharedReport).toHaveBeenCalledWith("token-1");
    expect(screen.getByText("002940.SZ")).toBeInTheDocument();
    expect(screen.getByText("日线")).toBeInTheDocument();
    // 数据截至与生成日期同为固化日：两处都以日期形式呈现。
    expect(screen.getAllByText("2026-08-13")).toHaveLength(2);
    expect(screen.getByText("方向待确认 · 中置信度")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "偏强情景" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "基准情景" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "偏弱情景" })).toBeInTheDocument();
    expect(screen.getAllByText("触发条件")).toHaveLength(3);
    expect(screen.getAllByText(/向上突破 · 最新收盘 \/ 20.6 CNY/)).toHaveLength(3);
    expect(screen.getByText("资讯存在时效差异。")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "公司经营进展" })).toHaveAttribute(
      "href",
      "https://example.com/news/1",
    );
    expect(screen.getByRole("img", { name: "002940.SZ 图表" })).toBeInTheDocument();

    expect(screen.getByText("偏强情景兑现")).toBeInTheDocument();
    expect(screen.getByText("20 / 20 个交易日")).toBeInTheDocument();
    expect(screen.getByText("展望窗口存在停牌交易日")).toBeInTheDocument();

    expect(screen.getByText("免责声明")).toBeInTheDocument();
    expect(screen.getByText("本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("exports via the browser print dialog", async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    render(<SharedReportPage token="token-1" api={apiWith(async () => sharedReport())} />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));

    expect(print).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("shows the loading state before the report arrives", () => {
    render(<SharedReportPage token="token-1" api={apiWith(() => new Promise(() => {}))} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载研究报告…");
  });

  it("shows a clear Chinese error page for revoked or unknown links", async () => {
    render(<SharedReportPage token="expired" api={apiWith(async () => {
      throw new ApiError("分享链接无效", 404);
    })} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法打开研究报告");
    expect(alert).toHaveTextContent("分享链接无效或已撤销，请与您的顾问确认最新链接。");
  });

  it("surfaces non-404 failures with their backend message", async () => {
    render(<SharedReportPage token="token-1" api={apiWith(async () => {
      throw new ApiError("API 请求失败（503）", 503);
    })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("API 请求失败（503）");
  });

  it("hides the outcome section until an evaluation exists", async () => {
    render(<SharedReportPage token="token-1" api={apiWith(async () => ({ ...sharedReport(), outcome: null }))} />);

    await screen.findByRole("heading", { name: "结构与资讯综合研判" });
    expect(screen.queryByText("情景兑现结果")).not.toBeInTheDocument();
  });
});
