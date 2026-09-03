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
  | "searchStocks"
>;

function auxiliaryApi(): AuxiliaryApi {
  return {
    async searchStocks() { return []; },
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

function completedProgress(...rows: Array<{ symbol: string; name: string }>) {
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    reportId: `report-${row.symbol}-1d`,
    stage: "完成" as const,
    state: "completed" as const,
  }));
}

function maotaiWuliangWatchlist() {
  return [
    { symbol: "600519.SH", name: "贵州茅台", market: "SH" as const },
    { symbol: "000858.SZ", name: "五粮液", market: "SZ" as const },
  ];
}

function apiWith(getReport: WorkbenchApi["getReport"]): WorkbenchApi {
  return {
    ...auxiliaryApi(),
    async getWatchlist() { return [{ symbol: "600519.SH", name: "贵州茅台", market: "SH" }]; },
    async addWatchlist(symbol) { return { symbol, name: symbol, market: symbol.endsWith(".SH") ? "SH" : "SZ" }; },
    async removeWatchlist() {},
    async createBatch() { return { id: "batch" }; },
    async getProgress() { return completedProgress({ symbol: "600519.SH", name: "贵州茅台" }); },
    getReport,
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function goToPool(user: User) {
  await user.click(await screen.findByRole("button", { name: /查询候选/ }));
}

async function viewReport(user: User, name = "贵州茅台", symbol = "600519.SH") {
  const label = `查看 ${name} ${symbol} 报告`;
  if (!screen.queryByRole("button", { name: label })) {
    await user.click(screen.getByRole("button", { name: /观察进度/ }));
  }
  await user.click(await screen.findByRole("button", { name: label }));
}

async function openMaotaiReport() {
  if (!screen.queryByRole("button", { name: "查看 贵州茅台 600519.SH 报告" })) {
    const progressButton = await screen.findByRole("button", { name: /观察进度/ });
    await waitFor(() => expect(progressButton).toBeEnabled());
    fireEvent.click(progressButton);
  }
  const button = await screen.findByRole("button", { name: "查看 贵州茅台 600519.SH 报告" });
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
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
  it("walks the batch page as search, pool, progress, then report", async () => {
    const user = userEvent.setup();
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const getProgress = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        symbol: "600519.SH",
        name: "贵州茅台",
        reportId: "report-600519.SH-1d",
        stage: "完成",
        state: "completed" as const,
      }]);
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      async getWatchlist() { return []; },
      getProgress,
      async searchStocks() { return [{ symbol: "600519.SH", name: "贵州茅台", cnspell: "gzmt" }]; },
    };
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "候选池" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "本批进度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("添加股票"), "茅台");
    await user.click(await screen.findByRole("option", { name: /贵州茅台/ }));
    expect(await screen.findByText("贵州茅台")).toBeInTheDocument();
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /生成本批报告/ }));
    expect(await screen.findByRole("heading", { name: "本批进度" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "候选池" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看 贵州茅台 600519.SH 报告" }));
    expect(await screen.findByRole("heading", { name: "结构报告" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("600519.SH", "1d");
  });

  it("navigates the remaining workbench pages without archive sidebars", async () => {
    const user = userEvent.setup();
    render(<App />);

    const batch = screen.getByRole("link", { name: /今日批次/ });
    expect(batch).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "数据快照" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /研究记录/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "本批进度" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "批次步骤" })).toBeInTheDocument();
  });

  it("opens the batch view when retired archive hashes are loaded", async () => {
    window.location.hash = "#/records";
    const { unmount } = render(<App />);
    expect(await screen.findByRole("heading", { name: "本批进度" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /今日批次/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("heading", { name: "研究记录" })).not.toBeInTheDocument();
    unmount();

    window.location.hash = "#/snapshots";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "本批进度" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "数据快照" })).not.toBeInTheDocument();
  });

  it("does not show a workbench outage notice when the journal is open", async () => {
    window.location.hash = "#/journal";
    const getWatchlist = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const getProgress = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<App api={{ ...apiWith(async () => makeReport("600519.SH")), getWatchlist, getProgress }} />);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("数据服务暂不可用")).not.toBeInTheDocument();
  });

  it("does not load the watchlist chart report while the trading journal is open", async () => {
    window.location.hash = "#/journal";
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    render(<App api={{ ...apiWith(getReport), getInformation }} />);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(getReport).not.toHaveBeenCalled();
    expect(getInformation).not.toHaveBeenCalled();
  });

  it("loads the watchlist report when returning from the journal to the batch view", async () => {
    window.location.hash = "#/journal";
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    const user = userEvent.setup();
    render(<App api={apiWith(getReport)} />);
    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    expect(getReport).not.toHaveBeenCalled();

    await user.click(screen.getByRole("link", { name: /今日批次/ }));
    expect(await screen.findByRole("heading", { name: "候选池" })).toBeInTheDocument();
    expect(getReport).not.toHaveBeenCalled();
    await viewReport(user);
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("600519.SH", "1d");
  });

  it("exposes the independent trading journal instead of reusing research records", async () => {
    const user = userEvent.setup();
    render(<App />);

    const journal = screen.getByRole("link", { name: "交易日记" });
    await user.click(journal);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    expect(journal).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/journal");
    expect(screen.queryByRole("link", { name: "复盘中心" })).not.toBeInTheDocument();
  });

  it("opens the trading journal review view from the retired #/reviews hash", async () => {
    window.location.hash = "#/reviews";
    render(<App />);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "交易日记" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "复盘中心" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "复盘中心" })).not.toBeInTheDocument();
  });

  it("keeps sidebar labels on the same left edge whether or not they have a count", async () => {
    const moduleName = "node:fs";
    const { readFileSync } = await import(moduleName);
    const processModuleName = "node:process";
    const { cwd } = await import(processModuleName);
    const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8") as string;
    const navItem = styles.match(/\.nav-item \{([^}]*)\}/)?.[1] ?? "";
    const navCount = styles.match(/\.nav-count \{([^}]*)\}/)?.[1] ?? "";
    expect(navItem).toMatch(/justify-content:\s*flex-start/);
    expect(navCount).toMatch(/margin-left:\s*auto/);

    render(<App />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: /今日批次/ }).querySelector(".nav-count")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "交易日记" }).querySelector(".nav-count")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "复盘中心" })).toBeNull();
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

    await screen.findByText("运行中 · 3 / 6");
    await goToPool(user);
    expect((await screen.findAllByText("600519.SH")).length).toBeGreaterThanOrEqual(1);
    await user.type(screen.getByLabelText("添加股票"), "601318");
    await user.click(screen.getByRole("button", { name: "加入候选" }));
    expect(screen.getByRole("button", { name: "移除 601318.SH" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除 601318.SH" }));
    expect(screen.queryByRole("button", { name: "移除 601318.SH" })).not.toBeInTheDocument();
  });

  it("suggests listed stocks by name and adds the selected match", async () => {
    const user = userEvent.setup();
    const added: string[] = [];
    const api: WorkbenchApi = {
      ...auxiliaryApi(),
      async searchStocks(query) {
        return query.includes("茅台") ? [{ symbol: "600519.SH", name: "贵州茅台", cnspell: "gzmt" }] : [];
      },
      async getWatchlist() { return []; },
      async addWatchlist(symbol) {
        added.push(symbol);
        return { symbol, name: symbol, market: "SH" };
      },
      async removeWatchlist() {},
      async createBatch() { return { id: "batch" }; },
      async getProgress() { return []; },
      async getReport() { return makeReport("600519.SH"); },
    };
    render(<App api={api} />);

    await user.type(screen.getByLabelText("添加股票"), "茅台");
    await user.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    expect(added).toEqual(["600519.SH"]);
    expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    expect(screen.getByText("600519.SH")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 600519.SH" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "股票候选" })).not.toBeInTheDocument();
  });

  it("adds a unique name match from the join button", async () => {
    const user = userEvent.setup();
    const api: WorkbenchApi = {
      ...auxiliaryApi(),
      async searchStocks(query) {
        return query.includes("五粮") ? [{ symbol: "000858.SZ", name: "五粮液", cnspell: "wly" }] : [];
      },
      async getWatchlist() { return []; },
      async addWatchlist(symbol) { return { symbol, name: symbol, market: "SZ" }; },
      async removeWatchlist() {},
      async createBatch() { return { id: "batch" }; },
      async getProgress() { return []; },
      async getReport(symbol) { return makeReport(symbol); },
    };
    render(<App api={api} />);

    await user.type(screen.getByLabelText("添加股票"), "五粮");
    await screen.findByRole("option", { name: /五粮液/ });
    await user.click(screen.getByRole("button", { name: "加入候选" }));

    expect(screen.getByText("五粮液")).toBeInTheDocument();
    expect(screen.getByText("000858.SZ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 000858.SZ" })).toBeInTheDocument();
  });

  it("does not load a report when a stock is added to the candidate pool", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(getReport),
      async getProgress() { return []; },
    }} />);
    expect(await screen.findByRole("heading", { name: "候选池" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("添加股票"), "002940");
    await user.click(screen.getByRole("button", { name: "加入候选" }));

    expect(await screen.findByRole("button", { name: "移除 002940.SZ" })).toBeInTheDocument();
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();
  });

  it("does not load a report from the watchlist until the user opens it from progress", async () => {
    let releaseWatchlist!: () => void;
    const watchlistGate = new Promise<void>((resolve) => { releaseWatchlist = resolve; });
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    render(<App api={{
      ...apiWith(getReport),
      async getWatchlist() {
        await watchlistGate;
        return [{ symbol: "002940.SZ", name: "昂利康", market: "SZ" }];
      },
      async getProgress() {
        return completedProgress({ symbol: "002940.SZ", name: "昂利康" });
      },
    }} />);

    releaseWatchlist();

    expect(await screen.findByRole("heading", { name: "候选池" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /观察进度/ })).toBeEnabled();
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "报告 002940.SZ 1d" })).not.toBeInTheDocument();
  });

  it("requests the report with an explicit symbol and timeframe after the user opens it", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe));
    const user = userEvent.setup();
    render(<App api={apiWith(getReport)} />);

    await viewReport(user);
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("600519.SH", "1d");
  });

  it("reads completed and degraded reports continuously while preserving the selected timeframe", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(getReport),
      createInvestmentReport,
      async getProgress() {
        return [
          ...completedProgress({ symbol: "600519.SH", name: "贵州茅台" }),
          { symbol: "000858.SZ", name: "五粮液", stage: "降级", state: "degraded" },
          { symbol: "000001.SZ", name: "平安银行", stage: "生成失败", state: "failed" },
          { symbol: "002940.SZ", name: "昂利康", stage: "报告生成", state: "running" },
        ];
      },
    }} />);
    await viewReport(user);
    await user.click(screen.getByRole("button", { name: "周线" }));
    await screen.findByRole("heading", { name: "报告 600519.SH 1w" });
    const selector = screen.getByRole("combobox", { name: "切换报告股票" });

    expect(within(selector).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("status", { name: "报告序号" })).toHaveTextContent("1 / 2");
    expect(screen.getByRole("button", { name: "上一只" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下一只" }));
    expect(await screen.findByRole("heading", { name: "报告 000858.SZ 1w" })).toBeInTheDocument();
    expect(selector).toHaveValue("000858.SZ");
    expect(screen.getByRole("status", { name: "报告序号" })).toHaveTextContent("2 / 2");
    expect(screen.getByRole("button", { name: "下一只" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "上一只" }));
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1w" })).toBeInTheDocument();
    await user.selectOptions(selector, "000858.SZ");
    expect(await screen.findByRole("heading", { name: "报告 000858.SZ 1w" })).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledTimes(3);
    expect(createInvestmentReport).not.toHaveBeenCalled();
  });

  it("preserves weekly selection during rapid report navigation and ignores the previous stock response", async () => {
    const previousReport = deferred<Report>();
    const rows = [...maotaiWuliangWatchlist(), { symbol: "000001.SZ", name: "平安银行", market: "SZ" as const }];
    const getReport = vi.fn((symbol: string, timeframe: Timeframe) => symbol === "000858.SZ"
      ? previousReport.promise
      : Promise.resolve(makeReport(symbol, timeframe, true)));
    const user = userEvent.setup();
    render(<App api={{ ...apiWith(getReport), async getProgress() { return completedProgress(...rows); } }} />);
    await viewReport(user);
    await user.click(screen.getByRole("button", { name: "周线" }));
    await screen.findByRole("heading", { name: "报告 600519.SH 1w" });
    await user.click(screen.getByRole("button", { name: "下一只" }));
    expect(screen.getByText("正在加载结构报告…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一只" }));

    expect(await screen.findByRole("heading", { name: "报告 000001.SZ 1w" })).toBeInTheDocument();
    await act(async () => previousReport.resolve(makeReport("000858.SZ", "1w", true)));
    expect(screen.getByRole("heading", { name: "报告 000001.SZ 1w" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报告 000858.SZ 1w" })).not.toBeInTheDocument();
    expect(getReport).toHaveBeenLastCalledWith("000001.SZ", "1w");
  });

  it("reports a weekly loading failure for the new stock without restoring the previous selection", async () => {
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(async (symbol, timeframe) => {
        if (symbol === "000858.SZ") throw new ApiError("五粮液周线不可用", 503);
        return makeReport(symbol, timeframe, true);
      }),
      createInvestmentReport,
      async getProgress() { return completedProgress(...maotaiWuliangWatchlist()); },
    }} />);
    await viewReport(user);
    await user.click(screen.getByRole("button", { name: "周线" }));
    await screen.findByRole("heading", { name: "报告 600519.SH 1w" });
    await user.click(screen.getByRole("button", { name: "下一只" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("五粮液周线不可用");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("五粮液");
    expect(screen.queryByRole("img", { name: "600519.SH 图表" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(createInvestmentReport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "上一只" }));
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1w" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables report navigation for a single result and when the current batch becomes empty", async () => {
    const getProgress = vi.fn()
      .mockResolvedValueOnce(completedProgress({ symbol: "600519.SH", name: "贵州茅台" }))
      .mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App api={{ ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)), getProgress }} />);
    await viewReport(user);
    expect(screen.getByRole("button", { name: "上一只" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一只" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "切换报告股票" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "报告序号" })).toHaveTextContent("1 / 1");

    await user.click(screen.getByRole("link", { name: "交易日记" }));
    await user.click(screen.getByRole("link", { name: /今日批次/ }));
    await waitFor(() => expect(screen.getByRole("status", { name: "报告序号" })).toHaveTextContent("0 / 0"));
    expect(screen.getByRole("button", { name: "上一只" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一只" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "切换报告股票" })).toHaveTextContent("暂无可读报告");
    expect(screen.getByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
  });

  it("uses the current candidate count and removes simulated navigation metadata", async () => {
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(async (symbol) => makeReport(symbol)),
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() { return []; },
    }} />);
    const link = screen.getByRole("link", { name: /今日批次/ });
    await waitFor(() => expect(link).toHaveTextContent("02"));
    await user.click(screen.getByRole("button", { name: "移除 000858.SZ" }));
    expect(link).toHaveTextContent("01");
    expect(screen.queryByText("系统：运行中")).not.toBeInTheDocument();
    expect(screen.queryByText(/2026\.08\.11/)).not.toBeInTheDocument();
  });

  it("switches timeframes and reuses cached reports", async () => {
    const calls: string[] = [];
    const api = apiWith(async (symbol, timeframe) => {
      calls.push(`${symbol}:${timeframe}`);
      return makeReport(symbol, timeframe, true);
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);
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
    await viewReport(user);
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
    await viewReport(user);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    expect(await screen.findByText("周线加载失败，请重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日线" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "周线" }));

    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1w" })).toBeInTheDocument();
    expect(weeklyAttempts).toBe(2);
  });

  it("does not keep showing the previous report after opening another completed stock", async () => {
    const nextReport = deferred<Report>();
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => symbol === "000858.SZ"
        ? nextReport.promise
        : makeReport(symbol, timeframe, true)),
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);
    await screen.findByRole("heading", { name: "报告 600519.SH 1d" });

    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await viewReport(user, "五粮液", "000858.SZ");

    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
    expect(screen.getByText("正在加载结构报告…")).toBeInTheDocument();
    nextReport.resolve(makeReport("000858.SZ", "1d", true));
    expect(await screen.findByRole("heading", { name: "报告 000858.SZ 1d" })).toBeInTheDocument();
  });

  it("does not let a late previous-stock response replace the opened report", async () => {
    const oldReport = deferred<Report>();
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => symbol === "600519.SH"
        ? oldReport.promise
        : makeReport(symbol, timeframe, true)),
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);

    await viewReport(user);
    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await viewReport(user, "五粮液", "000858.SZ");
    await screen.findByRole("heading", { name: "报告 000858.SZ 1d" });
    oldReport.resolve(makeReport("600519.SH", "1d", true));

    await waitFor(() => expect(screen.getByRole("heading", { name: "报告 000858.SZ 1d" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
  });

  it("shows the existing service error when the opened daily report fails", async () => {
    const user = userEvent.setup();
    render(<App api={apiWith(async () => { throw new ApiError("Tushare 不可用", 503); })} />);
    await viewReport(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("数据服务暂不可用");
  });

  it("shows an explicit chart state for an empty market response", async () => {
    const user = userEvent.setup();
    render(<App api={apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe))} />);
    await viewReport(user);

    expect(await screen.findByText("当前周期暂无可绘制行情")).toBeInTheDocument();
  });

  it("shows progress without the structure report until the user opens it", async () => {
    render(<App />);
    expect(await screen.findByText("运行中 · 3 / 6")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "600519.SH 图表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();
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
    expect(screen.getByText("全部完成 · 1 / 1")).toBeInTheDocument();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构报告" })).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "查看 贵州茅台 600519.SH 报告" }));
    expect(await screen.findByRole("heading", { name: "报告 600519.SH 1d" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "本批 AI 报告" })).toBeInTheDocument();
  });

  it("resumes an existing batch after loading and stops polling after completion", async () => {
    const getProgress = vi.fn()
      .mockResolvedValueOnce([{ symbol: "600519.SH", name: "贵州茅台", stage: "报告生成", state: "running" }])
      .mockResolvedValue(completedProgress({ symbol: "600519.SH", name: "贵州茅台" }));
    const createBatch = vi.fn();
    vi.useFakeTimers();
    render(<App api={{ ...apiWith(async (symbol) => makeReport(symbol)), getProgress, createBatch }} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("LIVE")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("全部完成 · 1 / 1")).toBeInTheDocument();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    expect(createBatch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getProgress).toHaveBeenCalledTimes(2);
  });

  it("keeps completed batch reports available during a connection failure and resumes querying", async () => {
    const completed = { symbol: "600519.SH", name: "贵州茅台", stage: "完成", state: "completed" as const };
    const running = { symbol: "000858.SZ", name: "五粮液", stage: "报告生成", state: "running" as const };
    const getProgress = vi.fn()
      .mockResolvedValueOnce([completed, running])
      .mockRejectedValueOnce(new ApiError("进度服务暂时断开", 503))
      .mockResolvedValue([completed, { ...running, stage: "完成", state: "completed" }]);
    const createBatch = vi.fn();
    vi.useFakeTimers();
    render(<App api={{ ...apiWith(async (symbol) => makeReport(symbol)), getProgress, createBatch }} />);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });

    expect(screen.getByRole("alert")).toHaveTextContent("进度服务暂时断开");
    expect(screen.getByRole("button", { name: "查看 贵州茅台 600519.SH 报告" })).toBeEnabled();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getProgress).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "恢复批次查询" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("全部完成 · 2 / 2")).toBeInTheDocument();
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("keeps a pending batch creation connected after visiting the journal", async () => {
    const creation = deferred<{ id: string }>();
    const getProgress = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(completedProgress({ symbol: "600519.SH", name: "贵州茅台" }));
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(async (symbol) => makeReport(symbol)),
      getProgress,
      createBatch: () => creation.promise,
    }} />);
    await user.click(await screen.findByRole("button", { name: /生成本批报告/ }));
    await user.click(screen.getByRole("link", { name: "交易日记" }));
    await user.click(screen.getByRole("link", { name: /今日批次/ }));
    await act(async () => creation.resolve({ id: "created-batch" }));

    expect(await screen.findByRole("button", { name: /生成本批报告/ })).toBeEnabled();
    expect(screen.getByText("全部完成 · 1 / 1")).toBeInTheDocument();
  });

  it("labels a finished batch with failed reports as partially failed", async () => {
    const user = userEvent.setup();
    render(<App api={{
      ...apiWith(async (symbol) => makeReport(symbol)),
      async getProgress() {
        return [
          { symbol: "600519.SH", name: "贵州茅台", stage: "完成", state: "completed" },
          { symbol: "000858.SZ", name: "五粮液", stage: "生成失败", state: "failed" },
        ];
      },
    }} />);
    await user.click(await screen.findByRole("button", { name: /观察进度/ }));

    expect(screen.getByText("部分失败 · 1 / 2")).toBeInTheDocument();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
  });

  it("shows the selected stock above the report and presents each quote only once", async () => {
    const user = userEvent.setup();
    render(<App api={apiWith(async (symbol, timeframe) => ({ ...makeReport(symbol, timeframe, true), name: "贵州茅台" }))} />);
    await viewReport(user);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("贵州茅台");
    expect(screen.queryByText("收盘后的结构，")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("最新收盘")).toHaveLength(1);
    expect(screen.queryByText("最新收盘 · 600519.SH")).not.toBeInTheDocument();
    expect(screen.queryByText("候选")).not.toBeInTheDocument();
  });

  it("uses the progress stock name when the report payload only names its symbol", async () => {
    const user = userEvent.setup();
    render(<App api={apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true))} />);
    await viewReport(user);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("贵州茅台 · 结构研报");
  });

  it("does not let a late batch report replace a newer AI request or its recovery id", async () => {
    const oldBatchReport = deferred<InvestmentReportJob>();
    const newJob = { ...makeInvestmentJob("completed", "600519.SH", "1d", "new-digest", "新 AI 报告"), reportId: "report-new" };
    const currentReportQuery = vi.fn().mockRejectedValueOnce(new ApiError("新报告查询中断", 503)).mockResolvedValue(newJob);
    const getInvestmentReport = vi.fn((reportId: string) => reportId === "report-old" ? oldBatchReport.promise : currentReportQuery());
    vi.useFakeTimers();
    render(<App api={{
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      getProgress: async () => [
        { symbol: "600519.SH", name: "贵州茅台", reportId: "report-old", stage: "完成", state: "completed" },
        { symbol: "000858.SZ", name: "五粮液", stage: "生成", state: "running" },
      ],
      createInvestmentReport: async () => ({ reportId: "report-new", status: "queued", cached: false }),
      getInvestmentReport,
    }} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看 贵州茅台 600519.SH 报告" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getInvestmentReport).toHaveBeenCalledWith("report-old");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" })); });
    await act(async () => oldBatchReport.resolve({ ...makeInvestmentJob("completed", "600519.SH", "1d", "old-digest", "旧批次 AI 报告"), reportId: "report-old" }));
    expect(screen.queryByRole("heading", { name: "旧批次 AI 报告" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert")).toHaveTextContent("新报告查询中断");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "恢复报告查询" })); });
    expect(getInvestmentReport).toHaveBeenLastCalledWith("report-new");
    expect(screen.getByRole("heading", { name: "新 AI 报告" })).toBeInTheDocument();
  });

  it("allows an explicitly created batch to replace an earlier manual AI report", async () => {
    const user = userEvent.setup();
    const getProgress = vi.fn()
      .mockResolvedValueOnce(completedProgress({ symbol: "600519.SH", name: "贵州茅台" }))
      .mockResolvedValue([{ symbol: "600519.SH", name: "贵州茅台", reportId: "new-batch-report", stage: "完成", state: "completed" }]);
    render(<App api={{
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      getProgress,
      createInvestmentReport: async () => ({ reportId: "manual-report", status: "completed", cached: false }),
      getInvestmentReport: async (reportId) => ({ ...makeInvestmentJob("completed", "600519.SH", "1d", reportId, reportId === "manual-report" ? "之前手动 AI 报告" : "最新批次 AI 报告"), reportId }),
    }} />);
    await viewReport(user);
    await user.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(await screen.findByRole("heading", { name: "之前手动 AI 报告" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await user.click(screen.getByRole("button", { name: /生成本批报告/ }));
    await viewReport(user);
    expect(await screen.findByRole("heading", { name: "最新批次 AI 报告" })).toBeInTheDocument();
  });

  it("shows a Chinese API error state", async () => {
    const user = userEvent.setup();
    render(<App initialError="Tushare token 未配置" />);
    await user.click(screen.getByRole("button", { name: /生成本批报告/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tushare token 未配置");
    expect(screen.getByRole("button", { name: "恢复批次查询" })).toBeEnabled();
  });

  it("loads the initial structure and information in parallel without generating AI", async () => {
    const reportResult = deferred<Report>();
    const informationResult = deferred<StockInformation>();
    const getReport = vi.fn(() => reportResult.promise);
    const getInformation = vi.fn(() => informationResult.promise);
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const api = { ...apiWith(getReport), getInformation, createInvestmentReport };

    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);

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
    await viewReport(user);
    await screen.findByRole("heading", { name: "资讯 600519.SH" });

    await user.click(screen.getByRole("button", { name: "周线" }));
    await screen.findByRole("heading", { name: "报告 600519.SH 1w" });

    expect(getInformation).toHaveBeenCalledOnce();
  });

  it("opens another completed stock report from progress without loading from the pool", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      getInformation,
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "候选池" })).toBeInTheDocument();
    expect(getReport).not.toHaveBeenCalled();
    await viewReport(user, "五粮液", "000858.SZ");
    await screen.findByRole("heading", { name: "资讯 000858.SZ" });
    const reportCalls = getReport.mock.calls.length;
    const informationCalls = getInformation.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await goToPool(user);
    await user.click(screen.getByRole("button", { name: "移除 600519.SH" }));
    expect(getReport).toHaveBeenCalledTimes(reportCalls);
    expect(getInformation).toHaveBeenCalledTimes(informationCalls);
  });

  it("keeps a completed report available after the stock is removed from the pool", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const getInformation = vi.fn(async (symbol: string) => makeInformation(symbol));
    const getInvestmentReport = vi.fn(async () => makeInvestmentJob("completed", "600519.SH", "1d", "digest-removed", "待删除股票 AI 报告"));
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      getInformation,
      createInvestmentReport: vi.fn(async () => ({ reportId: "report-600519.SH-1d", status: "completed" as const, cached: true })),
      getInvestmentReport,
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);
    await user.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    expect(await screen.findByRole("heading", { name: "待删除股票 AI 报告" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await goToPool(user);
    await user.click(screen.getByRole("button", { name: "移除 600519.SH" }));
    await viewReport(user, "五粮液", "000858.SZ");

    expect(await screen.findByRole("heading", { name: "报告 000858.SZ 1d" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "资讯 000858.SZ" })).toBeInTheDocument();
    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "待删除股票 AI 报告" })).not.toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith("000858.SZ", "1d");
    expect(getInformation).toHaveBeenCalledWith("000858.SZ");
  });

  it("clears the selection and pending local state after removing the final stock", async () => {
    const getReport = vi.fn(async (symbol: string, timeframe: Timeframe) => makeReport(symbol, timeframe, true));
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const api: WorkbenchApi = {
      ...apiWith(getReport),
      createInvestmentReport,
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await goToPool(user);
    await user.click(await screen.findByRole("button", { name: "移除 600519.SH" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "移除 600519.SH" })).not.toBeInTheDocument());
    expect(createInvestmentReport).not.toHaveBeenCalled();
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "报告 600519.SH 1d" })).not.toBeInTheDocument();
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
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /查询候选/ }));
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
    expect(createInvestmentReport).not.toHaveBeenCalled();
  });

  it("discards late information from the previously selected stock", async () => {
    const oldInformation = deferred<StockInformation>();
    const api: WorkbenchApi = {
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
      async getInformation(symbol) {
        return symbol === "600519.SH" ? oldInformation.promise : makeInformation(symbol, "五粮液新资讯");
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);
    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await viewReport(user, "五粮液", "000858.SZ");
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
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);

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
    await viewReport(user);
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
    await openMaotaiReport();
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

  it("recovers an interrupted AI query with the existing report without generating again", async () => {
    const createInvestmentReport = vi.fn(auxiliaryApi().createInvestmentReport);
    const retryInvestmentReport = vi.fn(auxiliaryApi().retryInvestmentReport);
    const getInvestmentReport = vi.fn()
      .mockResolvedValueOnce(makeInvestmentJob("running"))
      .mockRejectedValueOnce(new ApiError("报告状态连接中断", 503))
      .mockResolvedValueOnce(makeInvestmentJob("completed"));
    render(<App api={{
      ...apiWith(async (symbol, timeframe) => makeReport(symbol, timeframe, true)),
      createInvestmentReport,
      retryInvestmentReport,
      getInvestmentReport,
    }} />);
    await openMaotaiReport();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "生成 Pi AI 走势报告" }));
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(4000); });

    expect(screen.getByRole("alert")).toHaveTextContent("报告状态连接中断");
    expect(screen.queryByText("Pi AI 正在生成三情景报告")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getInvestmentReport).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "恢复报告查询" }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("heading", { name: "AI 报告 600519.SH 1d" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getInvestmentReport).toHaveBeenLastCalledWith("report-600519.SH-1d");
    expect(createInvestmentReport).toHaveBeenCalledOnce();
    expect(retryInvestmentReport).not.toHaveBeenCalled();
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
    await openMaotaiReport();
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
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    render(<App api={api} />);
    await openMaotaiReport();
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("alert")).toHaveTextContent("报告生成超时");
    fireEvent.click(screen.getByRole("button", { name: "重试 Pi AI 报告" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "返回进度" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 五粮液 000858.SZ 报告" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "返回进度" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 贵州茅台 600519.SH 报告" }));
    await act(async () => { await Promise.resolve(); });

    expect(within(screen.getByRole("region", { name: "Pi AI 三情景走势报告" })).getByRole("status")).toHaveTextContent("报告已排队");
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
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    render(<App api={api} />);
    await openMaotaiReport();
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    vi.useFakeTimers();

    fireEvent.click(generate);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
    expect(getInvestmentReport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "返回进度" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 五粮液 000858.SZ 报告" }));
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
    await openMaotaiReport();
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
    const { unmount } = render(<App api={api} />);
    await openMaotaiReport();
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    const { unmount } = render(<App api={api} />);
    await openMaotaiReport();
    const generate = await screen.findByRole("button", { name: "生成 Pi AI 走势报告" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      async getWatchlist() { return maotaiWuliangWatchlist(); },
      async getProgress() {
        return completedProgress(
          { symbol: "600519.SH", name: "贵州茅台" },
          { symbol: "000858.SZ", name: "五粮液" },
        );
      },
    };
    const user = userEvent.setup();
    render(<App api={api} />);
    await viewReport(user);
    await user.click(await screen.findByRole("button", { name: "生成 Pi AI 走势报告" }));
    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await viewReport(user, "五粮液", "000858.SZ");

    await act(async () => creation.resolve({ reportId: "report-600519.SH-1d", status: "completed", cached: true }));
    expect(screen.getByText("尚未生成 Pi AI 走势报告")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回进度" }));
    await viewReport(user);

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
      return styles.split(marker).slice(1).map((source) => {
        const open = source.indexOf("{");
        let depth = 0;
        for (let index = open; index < source.length; index += 1) {
          if (source[index] === "{") depth += 1;
          if (source[index] === "}") depth -= 1;
          if (depth === 0) return marker + source.slice(0, index + 1);
        }
        return "";
      }).join("\n");
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
    expectDeclarations(declarations(/\.batch-cockpit\s+\.run-list\s*\{([^}]*)\}/), [
      /display:\s*flex/,
      /flex-direction:\s*column/,
      /width:\s*100%/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.run-row\s*\{([^}]*)\}/), [
      /display:\s*flex/,
      /align-items:\s*center/,
      /gap:\s*14px/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.report-section\s*\{([^}]*)\}/), [
      /margin-top:\s*0/,
    ]);
    expectDeclarations(declarations(/\.batch-cockpit\s+\.evidence-section,\s*\.batch-cockpit\s+\.outlook-section\s*\{([^}]*)\}/), [/margin-top:\s*0/]);
    expectDeclarations(declarations(/\.batch-cockpit\s+:is\(\.information-panel,\s*\.outlook-panel\)\s*\{([^}]*)\}/), [/margin-top:\s*0/]);
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
    expect(selectorsForFontSize(14)).toHaveLength(bodySelectors.length);
    expect(selectorsForFontSize(14)).toEqual(expect.arrayContaining(bodySelectors));
    expect(selectorsForFontSize(12)).toHaveLength(labelSelectors.length);
    expect(selectorsForFontSize(12)).toEqual(expect.arrayContaining(labelSelectors));
    expectDeclarations(declarations(/\.batch-page\s+\.market-chip\s*\{([^}]*)\}/), [/font-size:\s*11px\s*!important/]);

    expectDeclarations(declarations(/\.information-toggle\s*\{([^}]*)\}/), [
      /width:\s*100%/,
      /margin-top:\s*14px/,
      /padding:\s*9px\s+11px/,
      /border:\s*1px\s+solid\s+var\(--border\)/,
      /border-radius:\s*var\(--radius-control\)/,
      /background:\s*transparent/,
      /color:\s*var\(--muted\)/,
      /font-size:\s*13px/,
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
      /border-top:\s*1px\s+solid\s+var\(--border\)/,
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
