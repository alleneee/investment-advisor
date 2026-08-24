import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkbenchApi } from "./api";
import { App } from "./App";
import type {
  ChanChartData,
  InvestmentReport,
  InvestmentReportJob,
  ReferenceFact,
  Report,
  StockInformation,
  Timeframe,
} from "./types";

vi.mock("./ChanChart", () => ({
  ChanChart: ({ symbol, data }: { symbol: string; data: ChanChartData }) => data.bars.length
    ? <div role="img" aria-label={`${symbol} 图表`} />
    : <div>当前周期暂无可绘制行情</div>,
}));

function emptyChart(timeframe: Timeframe = "1d") {
  return { timeframe, bars: [], strokes: [], centers: [] };
}

function makeReport(symbol: string, timeframe: Timeframe = "1d", withBar = false): Report {
  return {
    symbol,
    name: symbol,
    asOf: "2026-08-11",
    timeframe,
    chart: {
      ...emptyChart(timeframe),
      bars: withBar
        ? [{ occurredAt: "2026-08-11T00:00:00Z", open: 10, close: 11, low: 9, high: 12, volume: 100 }]
        : [],
    },
    headline: `报告 ${symbol} ${timeframe}`,
    conclusion: "结构事实",
    structure: [],
    quality: "ok",
    qualityNote: "行情窗口完整。",
    sources: ["Tushare"],
    review: "未审阅",
  };
}

function makeInformation(symbol: string, title = `资讯 ${symbol}`): StockInformation {
  return {
    symbol,
    snapshotId: `information-${symbol}`,
    generatedAt: "2026-08-13T09:00:00+08:00",
    news: [{ id: `news-${symbol}`, title, summary: "资讯摘要", publishedAt: "2026-08-13T08:00:00+08:00", source: "东财", url: null }],
    messages: [],
    sentiment: { hotRank: null, heat: null, rankChange: null, concepts: [], tag: null, observedAt: null },
    quality: {
      status: "ok",
      warnings: [],
      sources: {
        eastmoneyNews: { status: "fresh", fetchedAt: "2026-08-13T09:00:00+08:00" },
        cninfoIrm: { status: "fresh", fetchedAt: "2026-08-13T09:00:00+08:00" },
        thsHotList: { status: "fresh", fetchedAt: "2026-08-13T09:00:00+08:00" },
      },
    },
  };
}

function makeInvestmentReport(symbol: string, timeframe: Timeframe, title = `AI 报告 ${symbol} ${timeframe}`): InvestmentReport {
  const structure: ReferenceFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "结构观察" };
  return {
    id: `report-${symbol}-${timeframe}`,
    schemaVersion: "investment_report.v2",
    runId: `run-${symbol}-${timeframe}`,
    symbol,
    timeframe,
    asOf: "2026-08-13",
    generatedAt: "2026-08-13T09:05:00+08:00",
    title,
    executiveSummary: "条件化走势摘要。",
    references: { [structure.ref]: structure },
    outlook: {
      horizon: "5-20-trading-days",
      direction: "uncertain",
      confidence: "medium",
      thesis: "等待结构条件确认。",
      scenarios: (["bullish", "base", "bearish"] as const).map((scenarioCase) => ({
        case: scenarioCase,
        narrative: `${scenarioCase} 条件情景。`,
        trigger: { operator: "structure_confirmed", factRef: structure.ref, fact: structure },
        invalidation: { operator: "structure_invalidated", factRef: structure.ref, fact: structure },
        evidenceRefs: [structure.ref],
        evidence: [structure],
      })),
    },
    risks: [],
    evidenceRefs: [structure.ref],
    evidence: [structure],
    disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
    review: { status: "pending" },
  };
}

function makeInvestmentJob(
  status: InvestmentReportJob["status"],
  symbol = "600519.SH",
  timeframe: Timeframe = "1d",
  digest = `digest-${symbol}-${timeframe}`,
  title?: string,
): InvestmentReportJob {
  return {
    reportId: `report-${symbol}-${timeframe}`,
    status,
    symbol,
    timeframe,
    asOf: "2026-08-13",
    inputDigest: digest,
    attemptCount: 1,
    updatedAt: "2026-08-13T09:06:00+08:00",
    report: status === "completed" ? makeInvestmentReport(symbol, timeframe, title) : null,
    error: status === "failed" ? { code: "TIMEOUT", message: "报告生成超时", retryable: true } : null,
    reviewStatus: "pending",
    reviewedAt: null,
    publishedAt: null,
    shareToken: null,
    outcome: null,
  };
}

type AuxiliaryApi = Pick<
  WorkbenchApi,
  | "getInformation"
  | "createInvestmentReport"
  | "getInvestmentReport"
  | "retryInvestmentReport"
  | "reviewInvestmentReport"
  | "publishInvestmentReport"
  | "evaluateInvestmentReportOutcome"
  | "createInvestmentReportShare"
  | "revokeInvestmentReportShare"
  | "getSharedReport"
  | "listInvestmentReportJobs"
  | "getReportQuality"
>;

function auxiliaryApi(): AuxiliaryApi {
  return {
    async getInformation(symbol) { return makeInformation(symbol); },
    async createInvestmentReport(symbol, timeframe) { return { reportId: `report-${symbol}-${timeframe}`, status: "queued", cached: false }; },
    async getInvestmentReport(reportId) {
      const match = /^report-(.+)-(1d|1w)$/.exec(reportId);
      return makeInvestmentJob("completed", match?.[1] ?? "600519.SH", match?.[2] === "1w" ? "1w" : "1d");
    },
    async retryInvestmentReport(reportId) { return { reportId, status: "queued", cached: false }; },
    async reviewInvestmentReport() {},
    async publishInvestmentReport(reportId) {
      return { reportId, reviewStatus: "accepted", publishedAt: "2026-08-13T10:00:00+08:00" };
    },
    async evaluateInvestmentReportOutcome(reportId) {
      return {
        reportId,
        symbol: "600519.SH",
        asOf: "2026-08-13",
        evaluatedAt: "2026-09-13T09:00:00+08:00",
        status: "realized",
        adjudication: "single_candidate",
        realizedCase: "base",
        realizedCases: ["base"],
        window: { start: "20260814", end: "20260911", barCount: 20, requiredBars: 20 },
        scenarios: [],
        quality: { status: "ok", warnings: [] },
      };
    },
    async createInvestmentReportShare(reportId) {
      return { reportId, shareToken: "token-1", shareUrlPath: "#/share/token-1" };
    },
    async revokeInvestmentReportShare() {},
    async listInvestmentReportJobs() { return []; },
    async getReportQuality() {
      return {
        scope: "all" as const,
        review: { accepted: 0, rejected: 0, decided: 0, acceptRate: null },
        outcome: {
          evaluated: 0, conclusive: 0, realized: 0, noneRealized: 0, ambiguous: 0,
          inconclusive: 0, pending: 0, realizedRateOverConclusive: null, realizedRateOverEvaluated: null, byCase: {},
        },
      };
    },
    async getSharedReport(shareToken) {
      const report = makeInvestmentReport("600519.SH", "1d");
      return {
        symbol: report.symbol,
        timeframe: report.timeframe,
        asOf: report.asOf,
        generatedAt: report.generatedAt,
        publishedAt: "2026-08-13T10:00:00+08:00",
        title: `分享报告 ${shareToken}`,
        executiveSummary: report.executiveSummary,
        outlook: report.outlook,
        risks: report.risks,
        evidence: report.evidence,
        disclaimer: report.disclaimer,
        chart: {
          timeframe: report.timeframe,
          bars: [{ occurredAt: "2026-08-11T00:00:00Z", open: 10, close: 11, low: 9, high: 12, volume: 100 }],
          strokes: [],
          centers: [],
        },
        quality: { status: "ok", warnings: [] },
        outcome: null,
      };
    },
  };
}

function apiWith(getReport: WorkbenchApi["getReport"]): WorkbenchApi {
  return {
    ...auxiliaryApi(),
    async getWatchlist() { return [{ symbol: "600519.SH", name: "贵州茅台", market: "SH" }]; },
    async addWatchlist(symbol) { return { symbol, name: symbol, market: symbol.endsWith(".SH") ? "SH" : "SZ" }; },
    async removeWatchlist() {},
    async createBatch() { return { id: "batch" }; },
    async getProgress() { return []; },
    getReport,
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "#/batch";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("research workbench", () => {
  it("organizes the batch view as a two-column analysis cockpit", async () => {
    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "自选池" });
    const batchPage = container.querySelector(".batch-page");
    const batchCockpit = batchPage?.querySelector(".batch-cockpit");
    const panes = batchCockpit?.querySelectorAll(":scope > .ui-split > .ui-split-pane") ?? [];

    expect(batchPage).toBeInTheDocument();
    expect(batchCockpit).toBeInTheDocument();
    expect(panes).toHaveLength(2);
    expect(within(panes[0] as HTMLElement).getByRole("heading", { name: "自选池" })).toBeInTheDocument();
    expect(within(panes[0] as HTMLElement).getByRole("heading", { name: "本批进度" })).toBeInTheDocument();
    expect(within(panes[1] as HTMLElement).getByRole("heading", { name: "结构报告" })).toBeInTheDocument();
    expect(within(panes[1] as HTMLElement).queryByRole("heading", { name: "本批进度" })).not.toBeInTheDocument();
  });

  it("navigates between batch, research records, and data snapshots", async () => {
    const user = userEvent.setup();
    render(<App />);

    const batch = screen.getByRole("link", { name: /今日批次/ });
    const records = screen.getByRole("link", { name: /研究记录/ });
    const snapshots = screen.getByRole("link", { name: "数据快照" });
    expect(batch).toHaveAttribute("aria-current", "page");

    await user.click(records);
    expect(screen.getByRole("heading", { name: "研究记录" })).toBeInTheDocument();
    expect(records).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/records");
    expect(await screen.findByRole("heading", { name: "质量看板" })).toBeInTheDocument();
    expect(screen.getByText("审阅通过率")).toBeInTheDocument();
    expect(screen.getByText("600519.SH")).toBeInTheDocument();
    expect(screen.getByText(/已通过 · 兑现 基准/)).toBeInTheDocument();

    await user.click(snapshots);
    expect(screen.getByRole("heading", { name: "数据快照" })).toBeInTheDocument();
    expect(snapshots).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/snapshots");
    expect(screen.getByText("FROZEN").nextElementSibling).toHaveTextContent("01");
    expect(await screen.findByText(/600519.SH · 2026-08-11 · 日线/)).toBeInTheDocument();

    await user.click(batch);
    expect(await screen.findByRole("heading", { name: "自选池" })).toBeInTheDocument();
    expect(batch).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/batch");
  });

  it("exposes the independent trading journal instead of reusing research records", async () => {
    const user = userEvent.setup();
    render(<App />);

    const journal = screen.getByRole("link", { name: "交易日记" });
    await user.click(journal);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    expect(journal).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/journal");

    const reviews = screen.getByRole("link", { name: "复盘中心" });
    await user.click(reviews);
    expect(await screen.findByRole("heading", { name: "周期复盘" })).toBeInTheDocument();
    expect(reviews).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/reviews");
  });

  it("renders the shared report page for #/share/{token} without workbench chrome", async () => {
    window.location.hash = "#/share/token-9";
    const getWatchlist = vi.fn(apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe)).getWatchlist);
    render(<App api={{ ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe)), getWatchlist }} />);

    expect(await screen.findByRole("heading", { name: "分享报告 token-9" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /今日批次/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 PDF" })).toBeInTheDocument();
    expect(screen.getByText("本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。")).toBeInTheDocument();
    expect(getWatchlist).not.toHaveBeenCalled();
  });

  it("shows a Chinese error page when the share link is invalid", async () => {
    window.location.hash = "#/share/expired-token";
    render(<App api={{
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe)),
      async getSharedReport() { throw new ApiError("分享链接无效", 404); },
    }} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法打开研究报告");
    expect(alert).toHaveTextContent("分享链接无效或已撤销，请与您的顾问确认最新链接。");
  });

  it("adds and removes watchlist symbols with a hard limit", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findAllByText("600519.SH")).length).toBeGreaterThanOrEqual(2);
    await screen.findByText("运行中 · 3 / 6");
    await user.type(screen.getByLabelText("股票代码"), "601318");
    await user.click(screen.getByRole("button", { name: "加入自选" }));
    expect(screen.getByRole("button", { name: "移除 601318.SH" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除 601318.SH" }));
    expect(screen.queryByRole("button", { name: "移除 601318.SH" })).not.toBeInTheDocument();
  });

  it("refreshes the report after adding a watchlist symbol", async () => {
    let activeSymbol = "600519.SH";
    const report = (): Report => ({
      symbol: activeSymbol,
      name: activeSymbol,
      asOf: "2026-08-11",
      timeframe: "1d",
      chart: emptyChart(),
      headline: `报告 ${activeSymbol}`,
      conclusion: "结构事实",
      structure: [],
      quality: "ok",
      qualityNote: "行情窗口完整。",
      sources: ["Tushare"],
      review: "未审阅",
    });
    const api: WorkbenchApi = {
      ...auxiliaryApi(),
      async getWatchlist() {
        return [{ symbol: "600519.SH", name: "600519.SH", market: "SH" }];
      },
      async addWatchlist(symbol) {
        activeSymbol = symbol;
        return { symbol, name: symbol, market: "SZ" };
      },
      async removeWatchlist() {},
      async createBatch() { return { id: "batch" }; },
      async getProgress() { return []; },
      async getReport() { return report(); },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "报告 600519.SH" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("股票代码"), "002940");
    await user.click(screen.getByRole("button", { name: "加入自选" }));

    expect(await screen.findByRole("heading", { name: "报告 002940.SZ" })).toBeInTheDocument();
    expect(screen.getByText("SZ", { selector: ".market-chip" })).toBeInTheDocument();
  });

  it("loads the report after resolving the initial watchlist", async () => {
    let activeSymbol = "600519.SH";
    let releaseWatchlist!: () => void;
    const watchlistGate = new Promise<void>((resolve) => { releaseWatchlist = resolve; });
    const api: WorkbenchApi = {
      ...auxiliaryApi(),
      async getWatchlist() {
        await watchlistGate;
        activeSymbol = "002940.SZ";
        return [{ symbol: activeSymbol, name: activeSymbol, market: "SZ" }];
      },
      async addWatchlist(symbol) { return { symbol, name: symbol, market: "SZ" }; },
      async removeWatchlist() {},
      async createBatch() { return { id: "batch" }; },
      async getProgress() { return []; },
      async getReport() {
        return {
          symbol: activeSymbol,
          name: activeSymbol,
          asOf: "2026-08-11",
          timeframe: "1d",
          chart: emptyChart(),
          headline: `报告 ${activeSymbol}`,
          conclusion: "结构事实",
          structure: [],
          quality: "ok",
          qualityNote: "行情窗口完整。",
          sources: ["Tushare"],
          review: "未审阅",
        };
      },
    };
    render(<App api={api} />);

    releaseWatchlist();

    expect(await screen.findByRole("heading", { name: "报告 002940.SZ" })).toBeInTheDocument();
  });

  it("requests the initial report with an explicit symbol and timeframe", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    render(<App api={apiWith(getReport)} />);

    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("600519.SH", "1d");
  });

  it("switches timeframes and reuses cached reports", async () => {
    const calls: string[] = [];
    const api = apiWith(async (symbol, timeframe) => {
      calls.push(`${symbol}:${timeframe}`);
      return makeReport(symbol, timeframe, true);
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1w" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "日线" }));
    await user.click(screen.getByRole("button", { name: "周线" }));

    expect(calls.filter((item) => item.endsWith(":1w"))).toHaveLength(1);
  });

  it("keeps daily selected while weekly is loading and ignores a late weekly response", async () => {
    const weekly = deferred<Report>();
    const api = apiWith(async (symbol, timeframe) => timeframe === "1w" ? weekly.promise : makeReport(symbol, timeframe, true));
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    expect(screen.getByRole("button", { name: "日线" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "周线加载中" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "日线" }));
    weekly.resolve(makeReport("600519.SH", "1w", true));
    await waitFor(() => expect(screen.getByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1w" })).not.toBeInTheDocument();
  });

  it("keeps daily after a weekly failure and retries on the next click", async () => {
    let weeklyAttempts = 0;
    const api = apiWith(async (symbol, timeframe) => {
      if (timeframe === "1w" && ++weeklyAttempts === 1) throw new ApiError("上游失败", 503);
      return makeReport(symbol, timeframe, true);
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    expect(await screen.findByText("周线加载失败，请重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日线" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "周线" }));

    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1w" })).toBeInTheDocument();
    expect(weeklyAttempts).toBe(2);
  });

  it("clears the old report while a newly added symbol loads", async () => {
    const nextReport = deferred<Report>();
    const api = apiWith(async (symbol, timeframe) => symbol === "002940.SZ"
      ? nextReport.promise
      : makeReport(symbol, timeframe, true));
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.type(screen.getByLabelText("股票代码"), "002940");
    await user.click(screen.getByRole("button", { name: "加入自选" }));

    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
    expect(screen.getByText("正在加载结构报告…")).toBeInTheDocument();
    nextReport.resolve(makeReport("002940.SZ", "1d", true));
    expect(await screen.findByRole("heading", { name: "报告 002940.SZ 1d" })).toBeInTheDocument();
  });

  it("does not let a late old-symbol response replace the new report", async () => {
    const oldReport = deferred<Report>();
    const api = apiWith(async (symbol, timeframe) => symbol === "600519.SH"
      ? oldReport.promise
      : makeReport(symbol, timeframe, true));
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.type(screen.getByLabelText("股票代码"), "002940");
    await user.click(screen.getByRole("button", { name: "加入自选" }));
    await screen.findByRole("heading", { name: "报告 002940.SZ 1d" });
    oldReport.resolve(makeReport("600519.SH", "1d", true));

    await waitFor(() => expect(screen.getByRole("heading", { name: "报告 002940.SZ 1d" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
  });

  it("shows the existing service error when the initial daily report fails", async () => {
    render(<App api={apiWith(async () => { throw new ApiError("Tushare 不可用", 503); })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("数据服务暂不可用");
  });

  it("shows an explicit chart state for an empty market response", async () => {
    render(<App api={apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe))} />);

    expect(await screen.findByText("当前周期暂无可绘制行情")).toBeInTheDocument();
  });

  it("shows progress without repeating the structure conclusion beside the chart", async () => {
    render(<App />);
    expect(await screen.findByText("运行中 · 3 / 6")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "600519.SH 图表" })).toBeInTheDocument();
    expect(document.querySelector(".report-copy")).not.toBeInTheDocument();
    expect(screen.queryByText(/结构结论 \/ DAILY/)).not.toBeInTheDocument();
  });

  it("declares a full-width chart layout without a right divider", async () => {
    const moduleName = "node:fs";
    const { readFileSync } = await import(moduleName);
    const processModuleName = "node:process";
    const { cwd } = await import(processModuleName);
    const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8") as string;

    expect(styles).toMatch(/\.report-body\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(styles).toMatch(/\.chart-pane\s*\{[^}]*border-right:\s*0/);
  });

  it("starts the full batch, polls it every 2000ms, and shows the completed report", async () => {
    const batchCreation = deferred<{ id: string }>();
    const createBatch = vi.fn(() => batchCreation.promise);
    const getProgress = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ symbol: "600519.SH", name: "贵州茅台", reportId: "report-600519.SH-1d", stage: "报告生成", state: "running" as const }])
      .mockResolvedValueOnce([{ symbol: "600519.SH", name: "贵州茅台", reportId: "report-600519.SH-1d", stage: "完成", state: "completed" as const }]);
    const getInvestmentReport = vi.fn(async () => makeInvestmentJob("completed", "600519.SH", "1d", "batch-digest", "本批 AI 报告"));
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createBatch,
      getProgress,
      getInvestmentReport,
    };
    render(<App api={api} />);
    const button = await screen.findByRole("button", { name: /生成本批报告/ });
    vi.useFakeTimers();

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(createBatch).toHaveBeenCalledOnce();
    expect(screen.getAllByText("排队").length).toBeGreaterThan(0);
    await act(async () => batchCreation.resolve({ id: "batch-report" }));
    expect(screen.getByText("报告生成")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(getProgress).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getProgress).toHaveBeenCalledTimes(3);
    expect(screen.getByText("运行中 · 1 / 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "本批 AI 报告" })).toBeInTheDocument();
  });

  it("shows a Chinese API error state", async () => {
    const user = userEvent.setup();
    render(<App initialError="Tushare token 未配置" />);
    await user.click(screen.getByRole("button", { name: /生成本批报告/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("数据服务暂不可用");
  });

  it("loads the initial structure and information in parallel without generating AI", async () => {
    const reportResult = deferred<Report>();
    const informationResult = deferred<StockInformation>();
    const getReport = vi.fn(() => reportResult.promise);
    const getInformation = vi.fn(() => informationResult.promise);
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const api = { ...apiWith(getReport), getInformation, createInvestmentReport };

    render(<App api={api} />);

    await waitFor(() => {
      expect(getReport).toHaveBeenCalledWith("600519.SH", "1d");
      expect(getInformation).toHaveBeenCalledWith("600519.SH");
    });
    expect(createInvestmentReport).not.toHaveBeenCalled();

    reportResult.resolve(makeReport("600519.SH", "1d", true));
    informationResult.resolve(makeInformation("600519.SH"));
    expect(await screen.findByRole("heading", { name: "资讯 600519.SH" })).toBeInTheDocument();
  });

  it("does not refetch stock information when only the chart timeframe changes", async () => {
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    const api = { ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)), getInformation };
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "资讯 600519.SH" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    await screen.findByRole("heading", { name: "报告 600519.SH 1w" });

    expect(getInformation).toHaveBeenCalledOnce();
  });

  it("selects existing watch rows and keeps remove clicks from selecting", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      getInformation,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);

    const first = await screen.findByRole("button", { name: "选择 600519.SH 贵州茅台" });
    const second = screen.getByRole("button", { name: "选择 000858.SZ 五粮液" });
    expect(first).toHaveAttribute("aria-pressed", "true");

    await user.click(second);
    expect(second).toHaveAttribute("aria-pressed", "true");
    await screen.findByRole("heading", { name: "资讯 000858.SZ" });
    const reportCalls = getReport.mock.calls.length;
    const informationCalls = getInformation.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "移除 600519.SH" }));
    expect(getReport).toHaveBeenCalledTimes(reportCalls);
    expect(getInformation).toHaveBeenCalledTimes(informationCalls);
  });

  it("selects the deterministic remaining stock after removing the current stock", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    const getInvestmentReport = vi.fn(async () => makeInvestmentJob("completed", "600519.SH", "1d", "digest-removed", "待删除股票 AI 报告"));
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      getInformation,
      createInvestmentReport: vi.fn(async () => ({ reportId: "report-600519.SH-1d", status: "completed" as const, cached: true })),
      getInvestmentReport,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(await screen.findByRole("heading", { name: "待删除股票 AI 报告" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除 600519.SH" }));

    const remaining = await screen.findByRole("button", { name: "选择 000858.SZ 五粮液" });
    expect(remaining).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("heading", { name: "报告 000858.SZ 1d" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "资讯 000858.SZ" })).toBeInTheDocument();
    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "待删除股票 AI 报告" })).not.toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("000858.SZ", "1d");
    expect(getInformation).toHaveBeenCalledWith("000858.SZ");
  });

  it("clears the selection and pending local state after removing the final stock", async () => {
    const reportResult = deferred<Report>();
    const informationResult = deferred<StockInformation>();
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const api: WorkbenchApi = {
      ...apiWith(() => reportResult.promise),
      getInformation: vi.fn(() => informationResult.promise),
      createInvestmentReport,
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    const remove = await screen.findByRole("button", { name: "移除 600519.SH" });
    expect(await screen.findByText("正在加载结构报告…")).toBeInTheDocument();
    expect(screen.getByText("正在加载资讯证据…")).toBeInTheDocument();

    await user.click(remove);

    await waitFor(() => expect(screen.queryByRole("button", { name: "移除 600519.SH" })).not.toBeInTheDocument());
    expect(screen.queryByText("正在加载结构报告…")).not.toBeInTheDocument();
    expect(screen.queryByText("正在加载资讯证据…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(createInvestmentReport).not.toHaveBeenCalled();

    await act(async () => {
      reportResult.resolve(makeReport("600519.SH", "1d", true));
      informationResult.reject(new ApiError("迟到的资讯错误", 503));
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
    expect(screen.queryByText("迟到的资讯错误")).not.toBeInTheDocument();
  });

  it("uses the latest watchlist when concurrent removals resolve out of order", async () => {
    const removeFirst = deferred<void>();
    const removeSecond = deferred<void>();
    const createInvestmentReport = vi.fn(async () => ({ reportId: "report-600519.SH-1d", status: "completed" as const, cached: true }));
    const removeWatchlist = vi.fn((symbol: string) => symbol === "600519.SH" ? removeFirst.promise : removeSecond.promise);
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createInvestmentReport,
      getInvestmentReport: vi.fn(async () => makeInvestmentJob("completed", "600519.SH", "1d", "digest-concurrent-remove", "并发删除前 AI 报告")),
      removeWatchlist,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(await screen.findByRole("heading", { name: "并发删除前 AI 报告" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除 600519.SH" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 000858.SZ" }));
    expect(removeWatchlist).toHaveBeenCalledTimes(2);
    await act(async () => removeSecond.resolve(undefined));
    expect(screen.queryByRole("button", { name: "移除 000858.SZ" })).not.toBeInTheDocument();
    await act(async () => removeFirst.resolve(undefined));

    await waitFor(() => expect(screen.queryByRole("button", { name: "移除 600519.SH" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "移除 000858.SZ" })).not.toBeInTheDocument();
    expect(document.querySelector(".watch-row.selected")).toBeNull();
    expect(screen.queryByRole("heading", { name: /报告 (600519\.SH|000858\.SZ) 1d/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /资讯 (600519\.SH|000858\.SZ)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "并发删除前 AI 报告" })).not.toBeInTheDocument();
    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(createInvestmentReport).toHaveBeenCalledOnce();
  });

  it("discards late information from the previously selected stock", async () => {
    const oldInformation = deferred<StockInformation>();
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
      async getInformation(symbol) {
        return symbol === "600519.SH" ? oldInformation.promise : makeInformation(symbol, "五粮液新资讯");
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    const second = await screen.findByRole("button", { name: "选择 000858.SZ 五粮液" });

    await user.click(second);
    expect(await screen.findByRole("heading", { name: "五粮液新资讯" })).toBeInTheDocument();
    oldInformation.resolve(makeInformation("600519.SH", "迟到的茅台资讯"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "五粮液新资讯" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "迟到的茅台资讯" })).not.toBeInTheDocument();
  });

  it("keeps the structure report visible when information loading fails", async () => {
    const api = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      async getInformation() { throw new ApiError("资讯服务不可用", 503); },
    };
    render(<App api={api} />);

    expect(await screen.findByRole("img", { name: "600519.SH 图表" })).toBeInTheDocument();
    expect(await screen.findByText("资讯服务不可用")).toBeInTheDocument();
    expect(screen.queryByText("数据服务暂不可用")).not.toBeInTheDocument();
  });

  it("creates only once while the explicit AI request is pending", async () => {
    const creation = deferred<{ reportId: string; status: "queued"; cached: boolean }>();
    const createInvestmentReport = vi.fn(() => creation.promise);
    const api = { ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)), createInvestmentReport };
    const user = userEvent.setup();
    render(<App api={api} />);
    const button = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });

    await user.click(button);
    await user.click(button);

    expect(createInvestmentReport).toHaveBeenCalledOnce();
    expect(createInvestmentReport).toHaveBeenCalledWith("600519.SH", "1d");
    await act(async () => creation.resolve({ reportId: "report-1", status: "queued", cached: false }));
  });

  it("polls queued AI reports strictly every 2000ms and stops when completed", async () => {
    const getInvestmentReport = vi.fn()
      .mockResolvedValueOnce(makeInvestmentJob("running"))
      .mockResolvedValueOnce(makeInvestmentJob("completed"));
    const api = { ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)), getInvestmentReport };
    render(<App api={api} />);
    const button = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(getInvestmentReport).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(getInvestmentReport).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getInvestmentReport).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "AI 报告 600519.SH 1d" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getInvestmentReport).toHaveBeenCalledTimes(2);
  });

  it("stops failed polling and retries only through the dedicated endpoint", async () => {
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const retryInvestmentReport = vi.fn(auxiliaryApi().retryInvestmentReport);
    const getInvestmentReport = vi.fn()
      .mockResolvedValueOnce(makeInvestmentJob("failed", "600519.SH", "1d", "digest-old"))
      .mockResolvedValueOnce(makeInvestmentJob("completed", "600519.SH", "1d", "digest-new", "新摘要报告"));
    const api = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createInvestmentReport,
      retryInvestmentReport,
      getInvestmentReport,
    };
    render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert")).toHaveTextContent("报告生成超时");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "重试 Pi AI 报告" }));
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(retryInvestmentReport).toHaveBeenCalledWith("report-600519.SH-1d");
    expect(createInvestmentReport).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "新摘要报告" })).toBeInTheDocument();
  });

  it("prefers a queued retry over an older failed cache after switching stocks", async () => {
    const getInvestmentReport = vi.fn()
      .mockResolvedValueOnce(makeInvestmentJob("failed", "600519.SH", "1d", "digest-old"))
      .mockResolvedValueOnce(makeInvestmentJob("completed", "600519.SH", "1d", "digest-new", "重试切回报告"));
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      getInvestmentReport,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert")).toHaveTextContent("报告生成超时");
    fireEvent.click(screen.getByRole("button", { name: "重试 Pi AI 报告" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "选择 000858.SZ 五粮液" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "选择 600519.SH 贵州茅台" }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("status")).toHaveTextContent("报告已排队");
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getInvestmentReport).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "重试切回报告" })).toBeInTheDocument();
  });

  it("prevents an old stock poll from updating the newly selected stock", async () => {
    const oldPoll = deferred<InvestmentReportJob>();
    const getInvestmentReport = vi.fn(() => oldPoll.promise);
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      getInvestmentReport,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "选择 000858.SZ 五粮液" }));
    oldPoll.resolve(makeInvestmentJob("completed", "600519.SH", "1d", "digest-old", "旧股票 AI 报告"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "旧股票 AI 报告" })).not.toBeInTheDocument();
  });

  it("invalidates the old AI poll as soon as a new timeframe is requested", async () => {
    const weeklyReport = deferred<Report>();
    const oldPoll = deferred<InvestmentReportJob>();
    const api = {
      ...apiWith(async (symbol, timeframe) => timeframe === "1w" ? weeklyReport.promise : makeReport(symbol, timeframe, true)),
      getInvestmentReport: vi.fn(() => oldPoll.promise),
    };
    render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    oldPoll.resolve(makeInvestmentJob("completed", "600519.SH", "1d", "digest-old", "旧周期 AI 报告"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "旧周期 AI 报告" })).not.toBeInTheDocument();
  });

  it("does not update state or start polling when a pending create resolves after unmount", async () => {
    const creation = deferred<{ reportId: string; status: "queued"; cached: boolean }>();
    const getInvestmentReport = vi.fn(async () => makeInvestmentJob("completed"));
    const api = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createInvestmentReport: vi.fn(() => creation.promise),
      getInvestmentReport,
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    unmount();
    await act(async () => creation.resolve({ reportId: "report-1", status: "queued", cached: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(getInvestmentReport).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not update state or restart polling when a pending retry resolves after unmount", async () => {
    const retry = deferred<{ reportId: string; status: "queued"; cached: boolean }>();
    const getInvestmentReport = vi.fn().mockResolvedValueOnce(makeInvestmentJob("failed"));
    const api = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      retryInvestmentReport: vi.fn(() => retry.promise),
      getInvestmentReport,
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<App api={api} />);
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.click(screen.getByRole("button", { name: "重试 Pi AI 报告" }));
    unmount();
    await act(async () => retry.resolve({ reportId: "report-600519.SH-1d", status: "queued", cached: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(getInvestmentReport).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("fetches a deferred completed create when returning to its original selection", async () => {
    const creation = deferred<{ reportId: string; status: "completed"; cached: boolean }>();
    const getInvestmentReport = vi.fn(async () => makeInvestmentJob("completed", "600519.SH", "1d", "digest-return", "切回后的完整报告"));
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createInvestmentReport: vi.fn(() => creation.promise),
      getInvestmentReport,
      async getWatchlist() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
          { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
        ];
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    await user.click(screen.getByRole("button", { name: "选择 000858.SZ 五粮液" }));

    await act(async () => creation.resolve({ reportId: "report-600519.SH-1d", status: "completed", cached: true }));
    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择 600519.SH 贵州茅台" }));

    expect(await screen.findByRole("heading", { name: "切回后的完整报告" })).toBeInTheDocument();
    expect(getInvestmentReport).toHaveBeenCalledWith("report-600519.SH-1d");
  });

  it("defines the batch cockpit visual hierarchy and responsive contracts", async () => {
    const moduleName = "node:fs";
    const { readFileSync } = await import(moduleName);
    const processModuleName = "node:process";
    const { cwd } = await import(processModuleName);
    const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8") as string;
    const declarations = (pattern: RegExp, source = styles) => source.match(pattern)?.[1] ?? "";
    const mediaBlock = (maxWidth: number) => {
      const marker = `@media (max-width: ${maxWidth}px)`;
      const start = styles.lastIndexOf(marker);
      if (start < 0) return "";
      const open = styles.indexOf("{", start);
      let depth = 0;
      for (let index = open; index < styles.length; index += 1) {
        if (styles[index] === "{") depth += 1;
        if (styles[index] === "}") depth -= 1;
        if (depth === 0) return styles.slice(start, index + 1);
      }
      return "";
    };
    const scopedFontRules = [...styles.matchAll(/\.batch-page\s+:is\(\s*([\s\S]*?)\s*\)\s*\{([^}]*)\}/g)];
    const selectorsForFontSize = (fontSize: number) => scopedFontRules
      .find(([, , rule]) => new RegExp(`font-size:\\s*${fontSize}px`).test(rule))?.[1]
      .split(",")
      .map((selector) => selector.trim()) ?? [];
    const expectDeclarations = (rule: string, expected: RegExp[]) => {
      for (const property of expected) expect(rule).toMatch(property);
    };

    expectDeclarations(declarations(/\.batch-cockpit\s*\{([^}]*)\}/), [/margin-top:\s*12px/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.ui-split\s*\{([^}]*)\}/), [
      /grid-template-columns:\s*minmax\(260px,\s*\.62fr\)\s+minmax\(0,\s*1\.5fr\)/,
      /gap:\s*12px/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.ui-split-pane\s*\{([^}]*)\}/), [/gap:\s*12px/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.watch-input\s+input\s*\{([^}]*)\}/), [/min-width:\s*0/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.watch-input\s+button\s*\{([^}]*)\}/), [/flex-shrink:\s*0/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.watch-name\s*\{([^}]*)\}/), [
      /min-width:\s*0/,
      /display:\s*grid/,
      /gap:\s*3px/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.watch-name\s+:is\(strong,\s*small\)\s*\{([^}]*)\}/), [
      /overflow:\s*hidden/,
      /text-overflow:\s*ellipsis/,
      /white-space:\s*nowrap/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.run-list\s*\{([^}]*)\}/), [/grid-template-columns:\s*1fr/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.run-row\s*\{([^}]*)\}/), [
      /grid-template-columns:\s*8px\s+minmax\(72px,\s*84px\)\s+minmax\(0,\s*1fr\)\s+auto/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.report-section\s*\{([^}]*)\}/), [
      /min-height:\s*100%/,
      /margin-top:\s*0/,
    ]);
    expect(styles).toMatch(/\.batch-page\s+\.evidence-section,\s*\.batch-page\s+\.outlook-section\s*\{[^}]*margin-top:\s*44px/);
    expectDeclarations(declarations(/\.batch-page\s+\.outlook-header\s*\{([^}]*)\}/), [/padding:\s*20px\s+24px/]);
    expectDeclarations(declarations(/\.batch-page\s+:is\(\.outlook-idle,\s*\.outlook-failed,\s*\.outlook-progress\)\s*\{([^}]*)\}/), [
      /padding:\s*22px\s+24px/,
    ]);
    expectDeclarations(declarations(/\.batch-page\s+:is\(\s*\.outlook-summary,\s*\.outlook-risk-section,\s*\.outlook-disclaimer,\s*\.outlook-delivery\s*\)\s*\{([^}]*)\}/), [
      /padding-right:\s*24px/,
      /padding-left:\s*24px/,
    ]);

    const bodySelectors = [
      ".news-item p",
      ".message-item p",
      ".information-column-empty",
      ".evidence-loading",
      ".information-empty",
      ".evidence-local-error",
      ".information-quality",
      ".chart-notice",
      ".chart-empty",
      ".report-loading",
      ".outlook-idle p",
      ".outlook-error",
      ".outlook-summary p",
      ".outlook-summary blockquote",
      ".scenario-card > p",
      ".scenario-conditions dd",
      ".risk-list p",
      ".outlook-disclaimer",
      ".delivery-status dd",
      ".delivery-error",
      ".delivery-warnings",
    ];
    const labelSelectors = [
      ".evidence-kicker",
      ".evidence-timestamp",
      ".information-column-heading",
      ".information-column-heading small",
      ".information-meta",
      ".message-item > small",
      ".run-row small",
      ".report-meta",
      ".timeframe-switch button",
      ".chan-chart-legend",
      ".report-footer",
      ".sentiment-rank span",
      ".sentiment-card dt",
      ".sentiment-card dd",
      ".concept-list span",
      ".sentiment-time",
      ".outlook-meta",
      ".outlook-meta strong",
      ".outlook-action",
      ".outlook-failed button",
      ".outlook-progress small",
      ".outlook-failed span",
      ".outlook-summary > span",
      ".scenario-heading span",
      ".scenario-conditions dt",
      ".outlook-subheading",
      ".delivery-status dt",
      ".delivery-actions button",
      ".delivery-action-link",
    ];
    expect(selectorsForFontSize(12)).toHaveLength(bodySelectors.length);
    expect(selectorsForFontSize(12)).toEqual(expect.arrayContaining(bodySelectors));
    expect(selectorsForFontSize(10)).toHaveLength(labelSelectors.length);
    expect(selectorsForFontSize(10)).toEqual(expect.arrayContaining(labelSelectors));
    expectDeclarations(declarations(/\.batch-page\s+\.market-chip\s*\{([^}]*)\}/), [/font-size:\s*10px\s*!important/]);

    expectDeclarations(declarations(/\.information-toggle\s*\{([^}]*)\}/), [
      /width:\s*100%/,
      /margin-top:\s*14px/,
      /padding:\s*9px\s+11px/,
      /border:\s*1px\s+solid\s+var\(--border\)/,
      /border-radius:\s*var\(--radius-control\)/,
      /background:\s*transparent/,
      /color:\s*var\(--muted\)/,
      /font-size:\s*10px/,
    ]);
    expectDeclarations(declarations(/\.information-toggle:hover,\s*\.information-toggle:focus-visible\s*\{([^}]*)\}/), [
      /border-color:\s*color-mix\(in srgb,\s*var\(--accent\)\s+45%,\s*transparent\)/,
      /color:\s*var\(--accent\)/,
    ]);

    const tablet = mediaBlock(1100);
    expect(tablet).toMatch(/\.batch-cockpit\s+\.ui-split\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(tablet).toMatch(/\.batch-page\s+\.information-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(tablet).toMatch(/\.batch-page\s+\.message-column\s*\{[^}]*border-right:\s*0/);
    expectDeclarations(declarations(/\.batch-page\s+\.sentiment-column\s*\{([^}]*)\}/, tablet), [
      /grid-column:\s*1\s*\/\s*-1/,
      /border-top:\s*1px\s+solid\s+rgba\(213,\s*228,\s*218,\s*\.09\)/,
    ]);

    const narrow = mediaBlock(900);
    expect(narrow).toMatch(/\.batch-page\s+\.information-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    expectDeclarations(declarations(/\.batch-page\s+\.information-column\s*\{([^}]*)\}/, narrow), [
      /grid-column:\s*auto/,
      /border-right:\s*0/,
    ]);
    expectDeclarations(declarations(/\.batch-page\s+\.sentiment-column\s*\{([^}]*)\}/, narrow), [
      /border-top:\s*0/,
    ]);
  });

  it("declares 320px containment rules for the rail, stock input, and AI action", async () => {
    const moduleName = "node:fs";
    const { readFileSync } = await import(moduleName);
    const processModuleName = "node:process";
    const { cwd } = await import(processModuleName);
    const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8") as string;
    const mobile = styles.slice(styles.indexOf("@media (max-width: 520px)"));

    expect(mobile).toMatch(/\.app-shell\s*\{[^}]*display:\s*block/);
    expect(mobile).toMatch(/\.rail\s*\{[^}]*width:\s*100%/);
    expect(mobile).toMatch(/\.main-column\s*\{[^}]*width:\s*100%/);
    expect(mobile).toMatch(/\.watch-input\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(mobile).toMatch(/\.watch-input input\s*\{[^}]*min-width:\s*0/);
    expect(mobile).toMatch(/\.outlook-idle[^}]*\{[^}]*flex-direction:\s*column/);
    expect(mobile).toMatch(/\.outlook-action[^}]*\{[^}]*width:\s*100%/);
  });
});
