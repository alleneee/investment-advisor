import type {
  ChanChartData,
  ChartBar,
  ChartCenter,
  ChartStroke,
  InformationSourceQuality,
  InvestmentConfidence,
  InvestmentDirection,
  InvestmentReport,
  InvestmentReportError,
  InvestmentReportJob,
  InvestmentReportRequest,
  InvestmentReportStatus,
  InvestmentRisk,
  InvestmentScenario,
  ReferenceFact,
  Report,
  ReportConditionOutcome,
  ReportOutcome,
  ReportPublication,
  ReportReviewDecision,
  ReportQualityDashboard,
  ReportReviewStatus,
  ReportScenarioOutcome,
  ReportShare,
  RunProgress,
  SharedReport,
  SharedReportOutcome,
  StockInformation,
  StockSuggestion,
  StructureFact,
  Timeframe,
  WatchItem,
} from "./types";

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = Math.min(Math.max(limit, 1), items.length || 1);
  await Promise.all(Array.from({ length: items.length ? workers : 0 }, () => worker()));
  return results;
}

export interface WorkbenchApi {
  getWatchlist(): Promise<WatchItem[]>;
  addWatchlist(symbol: string): Promise<WatchItem>;
  removeWatchlist(symbol: string): Promise<void>;
  searchStocks(query: string): Promise<StockSuggestion[]>;
  createBatch(): Promise<{ id: string }>;
  getProgress(): Promise<RunProgress[]>;
  getReport(symbol: string, timeframe: Timeframe): Promise<Report>;
  getInformation(symbol: string): Promise<StockInformation>;
  createInvestmentReport(symbol: string, timeframe: Timeframe): Promise<InvestmentReportRequest>;
  getInvestmentReport(reportId: string): Promise<InvestmentReportJob>;
  retryInvestmentReport(reportId: string): Promise<InvestmentReportRequest>;
  reviewInvestmentReport(reportId: string, decision: ReportReviewDecision, note?: string): Promise<void>;
  publishInvestmentReport(reportId: string): Promise<ReportPublication>;
  evaluateInvestmentReportOutcome(reportId: string): Promise<ReportOutcome>;
  createInvestmentReportShare(reportId: string): Promise<ReportShare>;
  revokeInvestmentReportShare(reportId: string): Promise<void>;
  getSharedReport(shareToken: string): Promise<SharedReport>;
  listInvestmentReportJobs(options?: { latestPerSymbol?: boolean; timeframe?: string }): Promise<InvestmentReportJob[]>;
  getReportQuality(scope?: "published" | "all"): Promise<ReportQualityDashboard>;
}

export interface MarketAnalysisResponse {
  market_snapshot: {
    snapshot_id: string;
    source: string;
    adjustment: string;
    bars: Array<{
      occurred_at: unknown;
      open: unknown;
      close: unknown;
      low: unknown;
      high: unknown;
      volume?: unknown;
    }>;
    window: { start: string; end: string; bar_count: number };
    facts: Array<{ id: string; label: string; value: string | number; unit?: string }>;
    quality: { status: "ok" | "degraded"; warnings: string[] };
  };
  chan_analysis: {
    analysis_id: string;
    engine_version: string;
    timeframe: string;
    snapshot: {
      bars: Array<{ occurred_at: unknown }>;
      strokes: Array<Record<string, unknown>>;
      confirmed: Array<Record<string, unknown>>;
      provisional: Array<Record<string, unknown>>;
      centers: Array<Record<string, unknown>>;
      segments?: Array<Record<string, unknown>>;
      segment_centers?: Array<Record<string, unknown>>;
    };
  };
}

export class ApiError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = "ApiError";
  }
}

const mockReport: Report = {
  symbol: "600519.SH",
  name: "贵州茅台",
  asOf: "2026-08-11",
  timeframe: "1d",
  chart: {
    timeframe: "1d",
    bars: [
      { occurredAt: "2026-08-08T00:00:00Z", open: 1280, close: 1310, low: 1270, high: 1320, volume: 100 },
      { occurredAt: "2026-08-11T00:00:00Z", open: 1310, close: 1338, low: 1298, high: 1352, volume: 120 },
    ],
    strokes: [
      { direction: "up", startAt: "2026-08-08T00:00:00Z", endAt: "2026-08-11T00:00:00Z", startPrice: 1280, endPrice: 1352, state: "confirmed" },
    ],
    centers: [],
  },
  headline: "日线处于结构观察区，等待确认前缀延伸",
  conclusion: "当前只陈述已确认结构与触发条件，不构成买卖建议。形成中笔不进入主结论。",
  structure: [
    { id: "stroke-18", kind: "stroke", state: "confirmed", label: "向上笔", value: "1280.00 → 1352.00" },
    { id: "center-04", kind: "center", state: "confirmed", label: "笔中枢", value: "1298.00 — 1330.00" },
    { id: "stroke-19", kind: "stroke", state: "provisional", label: "向下笔（形成中）", value: "1352.00 → 1338.00" },
  ],
  quality: "degraded",
  qualityNote: "Tushare 行情完整；研报元数据暂缺，报告仅使用已固化证据。",
  sources: ["Tushare daily + adj_factor", "Tushare trade_cal", "本地 ChanEngine v1"],
  review: "未审阅",
};

const mockInformation: StockInformation = {
  symbol: "600519.SH",
  snapshotId: "information-demo",
  generatedAt: "2026-08-11T18:00:00+08:00",
  news: [{
    id: "news-demo",
    title: "公司经营信息保持稳定",
    summary: "公开信息显示经营节奏延续，具体影响仍需结合结构确认。",
    publishedAt: "2026-08-11T16:30:00+08:00",
    source: "东财",
    url: "https://example.com/news/demo",
  }],
  messages: [{
    id: "irm-demo",
    question: "近期经营计划是否按期推进？",
    answer: "相关计划正按既定安排推进。",
    answerer: "证券部",
    publishedAt: "2026-08-11T15:00:00+08:00",
    source: "cninfo",
  }],
  sentiment: {
    hotRank: 8,
    heat: 9123,
    rankChange: 2,
    concepts: ["白酒", "消费"],
    tag: "热股",
    observedAt: "2026-08-11T18:00:00+08:00",
  },
  quality: {
    status: "ok",
    warnings: [],
    sources: {
      eastmoneyNews: { status: "fresh", fetchedAt: "2026-08-11T18:00:00+08:00" },
      cninfoIrm: { status: "cached", fetchedAt: "2026-08-11T17:00:00+08:00" },
      thsHotList: { status: "fresh", fetchedAt: "2026-08-11T18:00:00+08:00" },
    },
  },
};

function mockInvestmentJob(reportId: string, symbol: string, timeframe: Timeframe): InvestmentReportJob {
  const structure: ReferenceFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "结构观察区" };
  const news: ReferenceFact = { ref: "news.demo", kind: "news", label: "经营信息", value: "经营节奏延续", url: "https://example.com/news/demo" };
  const cases = ["bullish", "base", "bearish"] as const;
  const narratives = ["结构确认后观察偏强情景。", "结构延续时保持基准观察。", "结构失效后观察偏弱情景。"];
  const scenarios: InvestmentScenario[] = cases.map((scenarioCase, index) => ({
    case: scenarioCase,
    narrative: narratives[index],
    trigger: { operator: "structure_confirmed", factRef: structure.ref, fact: structure },
    invalidation: { operator: "structure_invalidated", factRef: structure.ref, fact: structure },
    evidenceRefs: [structure.ref, news.ref],
    evidence: [structure, news],
  }));
  return {
    reportId,
    status: "completed",
    symbol,
    timeframe,
    asOf: "2026-08-11",
    inputDigest: `mock-${symbol}-${timeframe}`,
    attemptCount: 1,
    updatedAt: "2026-08-11T18:06:00+08:00",
    report: {
      id: reportId,
      schemaVersion: "investment_report.v2",
      runId: "run-demo",
      symbol,
      timeframe,
      asOf: "2026-08-11",
      generatedAt: "2026-08-11T18:05:00+08:00",
      title: "Pi AI 三情景走势报告",
      executiveSummary: "以结构事实与资讯证据构建条件化情景，不给出确定涨跌承诺。",
      references: { [structure.ref]: structure, [news.ref]: news },
      outlook: {
        horizon: "5-20-trading-days",
        direction: "uncertain",
        confidence: "medium",
        thesis: "以后续结构确认与失效条件作为情景切换依据。",
        scenarios,
      },
      risks: [{ narrative: "外部资讯可能存在时效差异。", evidenceRefs: [news.ref], evidence: [news] }],
      evidenceRefs: [structure.ref, news.ref],
      evidence: [structure, news],
      disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
      review: { status: "pending" },
    },
    error: null,
    reviewStatus: "pending",
    reviewedAt: null,
    publishedAt: null,
    shareToken: null,
    outcome: null,
  };
}

export function createMockApi(initialError?: string): WorkbenchApi {
  let watchlist: WatchItem[] = [
    { symbol: "600519.SH", name: "贵州茅台", market: "SH" },
    { symbol: "000858.SZ", name: "五粮液", market: "SZ" },
  ];
  const mockReviews = new Map<string, ReportReviewStatus>();
  const mockPublications = new Map<string, string>();
  const mockShares = new Map<string, string>();
  const universe: StockSuggestion[] = [
    { symbol: "600519.SH", name: "贵州茅台", cnspell: "gzmt" },
    { symbol: "000858.SZ", name: "五粮液", cnspell: "wly" },
    { symbol: "601318.SH", name: "中国平安", cnspell: "zgpa" },
    { symbol: "000333.SZ", name: "美的集团", cnspell: "mdjt" },
    { symbol: "600036.SH", name: "招商银行", cnspell: "zsyh" },
    { symbol: "002940.SZ", name: "昂利康", cnspell: "alk" },
    { symbol: "300750.SZ", name: "宁德时代", cnspell: "ndsd" },
  ];
  return {
    async getWatchlist() {
      return watchlist;
    },
    async searchStocks(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return universe.filter((item) => (
        item.name.includes(query.trim())
        || item.symbol.toLowerCase().includes(q)
        || item.cnspell.startsWith(q)
      )).slice(0, 8);
    },
    async addWatchlist(symbol) {
      if (initialError) throw new ApiError(initialError, 503);
      if (watchlist.length >= 50) throw new ApiError("自选池最多 50 只股票", 409);
      const normalized = symbol.includes(".") ? symbol : normalizeSymbol(symbol);
      const known = universe.find((item) => item.symbol === normalized);
      const item = { symbol: normalized, name: known?.name ?? normalized, market: normalized.endsWith(".SH") ? "SH" : "SZ" as "SH" | "SZ" };
      watchlist = [...watchlist, item];
      return item;
    },
    async removeWatchlist(symbol) {
      watchlist = watchlist.filter((item) => item.symbol !== symbol);
    },
    async createBatch() {
      if (initialError) throw new ApiError(initialError, 503);
      return { id: "batch-demo" };
    },
    async getProgress() {
      return [
        { symbol: "600519.SH", name: "贵州茅台", stage: "缠论分析", state: "running" },
        { symbol: "000858.SZ", name: "五粮液", stage: "证据整理", state: "completed" },
        { symbol: "601318.SH", name: "中国平安", stage: "排队", state: "queued" },
        { symbol: "000333.SZ", name: "美的集团", stage: "报告生成", state: "degraded" },
        { symbol: "600036.SH", name: "招商银行", stage: "完成", state: "completed" },
        { symbol: "300750.SZ", name: "宁德时代", stage: "完成", state: "completed" },
      ];
    },
    async getReport(symbol, timeframe) {
      return {
        ...mockReport,
        symbol,
        name: symbol,
        timeframe,
        chart: { ...mockReport.chart, timeframe },
      };
    },
    async getInformation(symbol) {
      return { ...mockInformation, symbol };
    },
    async createInvestmentReport(symbol, timeframe) {
      return { reportId: `report-${symbol}-${timeframe}`, status: "completed", cached: true };
    },
    async getInvestmentReport(reportId) {
      const [, symbol = "600519.SH", timeframe = "1d"] = reportId.match(/^report-(.+)-(1d|1w)$/) ?? [];
      const job = mockInvestmentJob(reportId, symbol, timeframe === "1w" ? "1w" : "1d");
      return {
        ...job,
        reviewStatus: mockReviews.get(reportId) ?? "pending",
        publishedAt: mockPublications.get(reportId) ?? null,
        shareToken: mockShares.get(reportId) ?? null,
      };
    },
    async retryInvestmentReport(reportId) {
      return { reportId, status: "queued", cached: false };
    },
    async reviewInvestmentReport(reportId, decision) {
      mockReviews.set(reportId, decision);
    },
    async publishInvestmentReport(reportId) {
      if (mockReviews.get(reportId) !== "accepted") throw new ApiError("报告需通过审阅后才能发布", 409);
      const publishedAt = "2026-08-12T09:00:00+08:00";
      mockPublications.set(reportId, publishedAt);
      return { reportId, reviewStatus: "accepted", publishedAt };
    },
    async evaluateInvestmentReportOutcome(reportId) {
      return {
        reportId,
        symbol: "600519.SH",
        asOf: "2026-08-11",
        evaluatedAt: "2026-09-10T09:00:00+08:00",
        status: "realized",
        adjudication: "single_candidate",
        realizedCase: "base",
        realizedCases: ["base"],
        window: { start: "20260812", end: "20260909", barCount: 20, requiredBars: 20 },
        scenarios: [],
        quality: { status: "ok", warnings: [] },
      };
    },
    async createInvestmentReportShare(reportId) {
      if (!mockPublications.has(reportId)) throw new ApiError("只有已发布的报告可以分享", 409);
      const shareToken = mockShares.get(reportId) ?? `share-${reportId}`;
      mockShares.set(reportId, shareToken);
      return { reportId, shareToken, shareUrlPath: `#/share/${shareToken}` };
    },
    async revokeInvestmentReportShare(reportId) {
      mockShares.delete(reportId);
    },
    async getSharedReport(shareToken) {
      const shared = [...mockShares.entries()].find(([, token]) => token === shareToken);
      const reportId = shared?.[0] ?? (shareToken === "demo" ? "report-600519.SH-1d" : null);
      if (!reportId) throw new ApiError("分享链接无效或已撤销", 404);
      const [, symbol = "600519.SH", timeframe = "1d"] = reportId.match(/^report-(.+)-(1d|1w)$/) ?? [];
      const job = mockInvestmentJob(reportId, symbol, timeframe === "1w" ? "1w" : "1d");
      const report = job.report!;
      return {
        symbol: report.symbol,
        timeframe: report.timeframe,
        asOf: report.asOf,
        generatedAt: report.generatedAt,
        publishedAt: mockPublications.get(reportId) ?? "2026-08-12T09:00:00+08:00",
        title: report.title,
        executiveSummary: report.executiveSummary,
        outlook: report.outlook,
        risks: report.risks,
        evidence: report.evidence,
        disclaimer: report.disclaimer,
        chart: { ...mockReport.chart, timeframe: report.timeframe },
        quality: { status: "ok", warnings: [] },
        outcome: {
          status: "realized",
          realizedCase: "base",
          evaluatedAt: "2026-09-10T09:00:00+08:00",
          window: { start: "20260812", end: "20260909", barCount: 20, requiredBars: 20 },
          quality: { status: "ok", warnings: [] },
        },
      };
    },
    async listInvestmentReportJobs() {
      const job = mockInvestmentJob("report-600519.SH-1d", "600519.SH", "1d");
      return [{
        ...job,
        reviewStatus: "accepted",
        publishedAt: "2026-08-12T09:00:00+08:00",
        outcome: {
          reportId: job.reportId,
          symbol: job.symbol,
          asOf: job.asOf,
          evaluatedAt: "2026-09-10T09:00:00+08:00",
          status: "realized",
          adjudication: "single_candidate",
          realizedCase: "base",
          realizedCases: ["base"],
          window: { start: "20260812", end: "20260909", barCount: 20, requiredBars: 20 },
          scenarios: [],
          quality: { status: "ok", warnings: [] },
        },
      }];
    },
    async getReportQuality(scope = "all") {
      return {
        scope,
        review: { accepted: 2, rejected: 1, decided: 3, acceptRate: "0.6667" },
        outcome: {
          evaluated: 4,
          conclusive: 2,
          realized: 1,
          noneRealized: 1,
          ambiguous: 1,
          inconclusive: 0,
          pending: 1,
          realizedRateOverConclusive: "0.5000",
          realizedRateOverEvaluated: "0.2500",
          byCase: { base: 1 },
        },
      };
    },
  };
}

export function createHttpApi(baseUrl: string): WorkbenchApi {
  const root = baseUrl.replace(/\/$/, "");
  let activeBatchReports = new Map<string, {
    symbol: string;
    name: string;
    reportId: string;
    status: InvestmentReportStatus;
  }>();
  let activeSymbol = "600519.SH";

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      let message = `API 请求失败（${response.status}）`;
      try {
        message = backendErrorMessage(await response.json(), message);
      } catch {}
      throw new ApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    async getWatchlist() {
      const rows = await request<Array<{ symbol: string; name?: string }>>("/api/watchlist");
      const result = rows.map(toWatchItem);
      if (result[0]) activeSymbol = result[0].symbol;
      return result;
    },
    async searchStocks(query) {
      const rows = await request<Array<{ symbol: string; name?: string; cnspell?: string }>>(
        `/api/stocks?q=${encodeURIComponent(query)}`,
      );
      if (!Array.isArray(rows)) throw adapterError("股票搜索结果无效");
      return rows.map((row) => ({
        symbol: row.symbol,
        name: row.name ?? row.symbol,
        cnspell: row.cnspell ?? "",
      }));
    },
    async addWatchlist(symbol) {
      const row = await request<{ symbol: string; name?: string }>("/api/watchlist", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
      activeSymbol = row.symbol;
      return toWatchItem(row);
    },
    async removeWatchlist(symbol) {
      await request<void>(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" });
      if (activeSymbol === symbol) activeSymbol = "600519.SH";
    },
    async createBatch() {
      const rows = await this.getWatchlist();
      if (!rows.length) throw new ApiError("自选池为空，无法生成本批报告", 409);
      const created = await mapPool(rows, 2, async (item) => {
        const payload = await request<unknown>(`/api/market/${encodeURIComponent(item.symbol)}/reports`, {
          method: "POST",
          body: JSON.stringify({ timeframe: "1d" }),
        });
        return { item, report: toInvestmentReportRequest(payload) };
      });
      activeBatchReports = new Map(created.map(({ item, report }) => [item.symbol, {
        symbol: item.symbol,
        name: item.name,
        reportId: report.reportId,
        status: report.status,
      }]));
      return { id: created[0].report.reportId };
    },
    async getProgress() {
      if (!activeBatchReports.size) {
        const [watchlist, jobs] = await Promise.all([
          this.getWatchlist(),
          request<unknown[]>("/api/reports/jobs?timeframe=1d"),
        ]);
        const bySymbol = new Map(watchlist.map((item) => [item.symbol, item]));
        activeBatchReports = new Map(
          jobs.flatMap((row) => {
            const job = toInvestmentReportJob(row);
            const item = bySymbol.get(job.symbol);
            if (!item) return [];
            return [[job.symbol, {
              symbol: job.symbol,
              name: item.name,
              reportId: job.reportId,
              status: job.status,
            }]];
          }),
        );
      }
      if (!activeBatchReports.size) return [];
      const refreshed = await mapPool([...activeBatchReports.values()], 2, async (run) => {
        if (run.status === "completed" || run.status === "failed") return run;
        const payload = await request<unknown>(`/api/reports/${encodeURIComponent(run.reportId)}`);
        const job = toInvestmentReportJob(payload);
        return { ...run, status: job.status };
      });
      activeBatchReports = new Map(refreshed.map((run) => [run.symbol, run]));
      return refreshed.map(toBatchProgress);
    },
    async getReport(symbol, timeframe) {
      const payload = await request<MarketAnalysisResponse>(
        `/api/market/${encodeURIComponent(symbol)}/analysis?timeframe=${timeframe}`,
      );
      return toReport(symbol, timeframe, payload);
    },
    async getInformation(symbol) {
      const payload = await request<unknown>(`/api/market/${encodeURIComponent(symbol)}/information`);
      return toStockInformation(payload);
    },
    async createInvestmentReport(symbol, timeframe) {
      const payload = await request<unknown>(`/api/market/${encodeURIComponent(symbol)}/reports`, {
        method: "POST",
        body: JSON.stringify({ timeframe }),
      });
      return toInvestmentReportRequest(payload);
    },
    async getInvestmentReport(reportId) {
      const payload = await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}`);
      return toInvestmentReportJob(payload);
    },
    async retryInvestmentReport(reportId) {
      const payload = await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}/retry`, {
        method: "POST",
        body: "{}",
      });
      return toInvestmentReportRequest(payload);
    },
    async reviewInvestmentReport(reportId, decision, note) {
      await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}/reviews`, {
        method: "POST",
        body: JSON.stringify(note ? { decision, note } : { decision }),
      });
    },
    async publishInvestmentReport(reportId) {
      const payload = await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}/publish`, {
        method: "POST",
        body: "{}",
      });
      return toReportPublication(payload);
    },
    async evaluateInvestmentReportOutcome(reportId) {
      const payload = await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}/outcome`, {
        method: "POST",
      });
      return toReportOutcome(payload);
    },
    async createInvestmentReportShare(reportId) {
      const payload = await request<unknown>(`/api/reports/${encodeURIComponent(reportId)}/share`, {
        method: "POST",
      });
      return toReportShare(payload);
    },
    async revokeInvestmentReportShare(reportId) {
      await request<void>(`/api/reports/${encodeURIComponent(reportId)}/share`, { method: "DELETE" });
    },
    async getSharedReport(shareToken) {
      const payload = await request<unknown>(`/api/shared/${encodeURIComponent(shareToken)}`);
      return toSharedReport(payload);
    },
    async listInvestmentReportJobs(options) {
      const query = new URLSearchParams();
      if (options?.timeframe) query.set("timeframe", options.timeframe);
      query.set("latest_per_symbol", options?.latestPerSymbol === false ? "false" : "true");
      const rows = await request<unknown[]>(`/api/reports/jobs?${query.toString()}`);
      return array(rows, "报告任务列表").map((row) => toInvestmentReportJob(row));
    },
    async getReportQuality(scope = "published") {
      const query = scope === "all" ? "?scope=all" : "";
      return toReportQuality(await request<unknown>(`/api/reports/quality${query}`));
    },
  };
}

function toBatchProgress(run: {
  symbol: string;
  name: string;
  reportId: string;
  status: InvestmentReportStatus;
}): RunProgress {
  const display = {
    queued: { stage: "排队", state: "queued" as const },
    running: { stage: "报告生成", state: "running" as const },
    completed: { stage: "完成", state: "completed" as const },
    failed: { stage: "生成失败", state: "failed" as const },
  }[run.status];
  return { symbol: run.symbol, name: run.name, reportId: run.reportId, ...display };
}

const REPORT_STATUSES = ["queued", "running", "completed", "failed"] as const;
const SOURCE_STATUSES = ["fresh", "cached", "stale", "unavailable"] as const;
const QUALITY_STATUSES = ["ok", "degraded", "unavailable"] as const;
const REFERENCE_KINDS = ["market", "price_level", "structure", "news", "irm", "hot", "information_quality"] as const;
const SCENARIO_CASES = ["bullish", "base", "bearish"] as const;
const DIRECTIONS = ["bullish", "sideways", "bearish", "uncertain"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const CONDITION_OPERATORS = ["break_above", "hold_above", "break_below", "hold_below", "structure_confirmed", "structure_invalidated"] as const;
const REVIEW_STATUSES = ["pending", "accepted", "rejected"] as const;
const OUTCOME_STATUSES = ["pending", "realized", "none_realized", "ambiguous", "inconclusive"] as const;
const OUTCOME_ADJUDICATIONS = [
  "window_pending", "single_candidate", "active_breakout_precedence",
  "multiple_active_breakouts", "passive_only", "no_candidate",
] as const;
const INVESTMENT_REPORT_DISCLAIMER = "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export function toStockInformation(payload: unknown): StockInformation {
  const value = exactRecord(payload, ["symbol", "snapshot_id", "generated_at", "news", "messages", "sentiment", "quality"], "资讯");
  const sentiment = exactRecord(value.sentiment, ["hot_rank", "heat", "rank_change", "concepts", "tag", "observed_at"], "热榜");
  const quality = exactRecord(value.quality, ["status", "warnings", "sources"], "资讯质量");
  const sources = exactRecord(quality.sources, ["eastmoney_news", "cninfo_irm", "ths_hot_list"], "资讯来源");
  return {
    symbol: text(value.symbol, "资讯股票"),
    snapshotId: text(value.snapshot_id, "资讯快照"),
    generatedAt: requiredDate(value.generated_at, "资讯生成时间"),
    news: array(value.news, "新闻").map((item, index) => toNews(item, index)),
    messages: array(value.messages, "互动问答").map((item, index) => toMessage(item, index)),
    sentiment: {
      hotRank: nullableNumber(sentiment.hot_rank, "热榜排名"),
      heat: nullableNumber(sentiment.heat, "热度"),
      rankChange: nullableNumber(sentiment.rank_change, "热榜排名变化"),
      concepts: stringArray(sentiment.concepts, "关联概念"),
      tag: nullableText(sentiment.tag, "热榜标签"),
      observedAt: nullableDate(sentiment.observed_at, "热榜观测时间"),
    },
    quality: {
      status: enumText(quality.status, QUALITY_STATUSES, "资讯质量状态"),
      warnings: stringArray(quality.warnings, "资讯质量警告"),
      sources: {
        eastmoneyNews: toSourceQuality(sources.eastmoney_news, "东财新闻"),
        cninfoIrm: toSourceQuality(sources.cninfo_irm, "互动易"),
        thsHotList: toSourceQuality(sources.ths_hot_list, "同花顺热榜"),
      },
    },
  };
}

export function toInvestmentReportRequest(payload: unknown): InvestmentReportRequest {
  const value = exactRecord(payload, ["report_id", "status", "cached"], "报告请求");
  return {
    reportId: text(value.report_id, "报告编号"),
    status: enumText(value.status, REPORT_STATUSES, "报告状态"),
    cached: booleanValue(value.cached, "报告缓存状态"),
  };
}

export function toReportPublication(payload: unknown): ReportPublication {
  const value = exactRecord(payload, ["report_id", "review_status", "published_at"], "报告发布");
  return {
    reportId: text(value.report_id, "报告编号"),
    reviewStatus: enumText(value.review_status, REVIEW_STATUSES, "报告审阅状态"),
    publishedAt: requiredDate(value.published_at, "报告发布时间"),
  };
}

export function toReportShare(payload: unknown): ReportShare {
  const value = exactRecord(payload, ["report_id", "share_token", "share_url_path"], "分享链接");
  const shareToken = text(value.share_token, "分享令牌");
  const shareUrlPath = text(value.share_url_path, "分享路径");
  if (shareUrlPath !== `#/share/${shareToken}`) throw adapterError("分享路径无效");
  return {
    reportId: text(value.report_id, "报告编号"),
    shareToken,
    shareUrlPath,
  };
}

export function toSharedReport(payload: unknown): SharedReport {
  const value = exactRecord(payload, [
    "symbol", "timeframe", "as_of", "generated_at", "published_at", "title",
    "executive_summary", "outlook", "risks", "evidence", "disclaimer",
    "market_snapshot", "chan_analysis", "outcome",
  ], "分享报告");
  const market = exactRecord(value.market_snapshot, ["bars", "window", "quality"], "分享行情快照");
  const chan = exactRecord(value.chan_analysis, ["timeframe", "snapshot"], "分享缠论分析");
  const marketQuality = exactRecord(market.quality, ["status", "warnings"], "分享行情质量");
  const snapshot = record(chan.snapshot, "分享缠论快照");
  const timeframe = enumText(value.timeframe, ["1d", "1w"] as const, "分享报告周期");
  const disclaimer = text(value.disclaimer, "分享报告免责声明");
  if (disclaimer !== INVESTMENT_REPORT_DISCLAIMER) throw adapterError("分享报告免责声明无效");
  const bars = toChartBars(
    array(market.bars, "分享行情K线") as MarketAnalysisResponse["market_snapshot"]["bars"],
  );
  const structureDates = array(snapshot.bars ?? [], "分享结构K线")
    .map((bar) => validDate(isRecord(bar) ? bar.occurred_at : null));
  const structures = (name: string) =>
    array(snapshot[name] ?? [], `分享结构 ${name}`).filter(isRecord);
  return {
    symbol: text(value.symbol, "分享报告股票"),
    timeframe,
    asOf: requiredDate(value.as_of, "分享报告数据日期"),
    generatedAt: requiredDate(value.generated_at, "分享报告生成时间"),
    publishedAt: requiredDate(value.published_at, "分享报告发布时间"),
    title: text(value.title, "分享报告标题"),
    executiveSummary: text(value.executive_summary, "分享报告摘要"),
    outlook: toSharedOutlook(value.outlook),
    risks: array(value.risks, "分享报告风险").map((item, index) => toSharedRisk(item, index)),
    evidence: array(value.evidence, "分享报告证据")
      .map((item, index) => toReferenceFact(item, `分享报告证据 ${index + 1}`)),
    disclaimer: INVESTMENT_REPORT_DISCLAIMER,
    chart: {
      timeframe,
      bars,
      strokes: [
        ...structures("confirmed").flatMap((stroke) => toStroke(stroke, "confirmed", structureDates)),
        ...structures("provisional").flatMap((stroke) => toStroke(stroke, "provisional", structureDates)),
      ],
      centers: structures("centers").flatMap((center) => toCenter(center, structureDates)),
    },
    quality: {
      status: enumText(marketQuality.status, ["ok", "degraded"] as const, "分享行情质量状态"),
      warnings: stringArray(marketQuality.warnings, "分享行情质量警告"),
    },
    outcome: toSharedOutcome(value.outcome),
  };
}

function toSharedOutlook(payload: unknown): SharedReport["outlook"] {
  const outlook = exactRecord(payload, ["horizon", "direction", "confidence", "thesis", "scenarios"], "分享报告展望");
  if (outlook.horizon !== "5-20-trading-days") throw adapterError("分享报告观察周期无效");
  const scenarios = array(outlook.scenarios, "分享报告情景").map((item, index) => toSharedScenario(item, index));
  if (scenarios.length !== 3 || SCENARIO_CASES.some((scenarioCase) => scenarios.filter((scenario) => scenario.case === scenarioCase).length !== 1)) {
    throw adapterError("分享报告必须包含唯一的三种情景");
  }
  return {
    horizon: "5-20-trading-days",
    direction: enumText(outlook.direction, DIRECTIONS, "分享报告方向"),
    confidence: enumText(outlook.confidence, CONFIDENCES, "分享报告置信度"),
    thesis: text(outlook.thesis, "分享报告主论点"),
    scenarios,
  };
}

function toSharedScenario(payload: unknown, index: number): InvestmentScenario {
  const value = exactRecord(payload, ["case", "narrative", "trigger", "invalidation", "evidence_refs", "evidence"], `分享情景 ${index + 1}`);
  const evidence = toSharedEvidence(value.evidence_refs, value.evidence, `分享情景 ${index + 1}证据`);
  return {
    case: enumText(value.case, SCENARIO_CASES, "分享情景类型"),
    narrative: text(value.narrative, "分享情景叙述"),
    trigger: toSharedCondition(value.trigger, `分享情景 ${index + 1}触发条件`),
    invalidation: toSharedCondition(value.invalidation, `分享情景 ${index + 1}失效条件`),
    evidenceRefs: evidence.refs,
    evidence: evidence.facts,
  };
}

function toSharedCondition(payload: unknown, name: string) {
  const value = exactRecord(payload, ["operator", "fact_ref", "fact"], name);
  const factRef = text(value.fact_ref, `${name}引用编号`);
  const fact = toReferenceFact(value.fact, `${name}引用事实`);
  if (fact.ref !== factRef) throw adapterError(`${name}引用不一致`);
  return {
    operator: enumText(value.operator, CONDITION_OPERATORS, `${name}操作符`),
    factRef,
    fact,
  };
}

function toSharedRisk(payload: unknown, index: number) {
  const value = exactRecord(payload, ["narrative", "evidence_refs", "evidence"], `分享风险 ${index + 1}`);
  const evidence = toSharedEvidence(value.evidence_refs, value.evidence, `分享风险 ${index + 1}证据`);
  return {
    narrative: text(value.narrative, "分享风险叙述"),
    evidenceRefs: evidence.refs,
    evidence: evidence.facts,
  };
}

// 净化视图不带引用注册表，只做证据自身一致性校验（编号与事实一一对应）。
function toSharedEvidence(
  refsPayload: unknown,
  factsPayload: unknown,
  name: string,
): { refs: string[]; facts: ReferenceFact[] } {
  const refs = stringArray(refsPayload, `${name}编号`);
  const facts = array(factsPayload, name).map((item) => toReferenceFact(item, name));
  if (refs.length !== new Set(refs).size
    || refs.length !== facts.length
    || refs.some((ref, index) => facts[index].ref !== ref)) {
    throw adapterError(`${name}与编号不一致`);
  }
  return { refs, facts };
}

function toSharedOutcome(payload: unknown): SharedReportOutcome | null {
  if (payload == null) return null;
  const value = exactRecord(payload, ["status", "realized_case", "evaluated_at", "window", "quality"], "分享兑现结果");
  const window = exactRecord(value.window, ["start", "end", "bar_count", "required_bars"], "分享兑现窗口");
  const quality = exactRecord(value.quality, ["status", "warnings"], "分享兑现质量");
  return {
    status: enumText(value.status, OUTCOME_STATUSES, "分享兑现状态"),
    realizedCase: value.realized_case == null
      ? null
      : enumText(value.realized_case, SCENARIO_CASES, "分享兑现情景"),
    evaluatedAt: requiredDate(value.evaluated_at, "分享兑现评估时间"),
    window: {
      start: nullableText(window.start, "分享兑现窗口起点"),
      end: nullableText(window.end, "分享兑现窗口终点"),
      barCount: nonNegativeInteger(window.bar_count, "分享兑现窗口交易日数"),
      requiredBars: nonNegativeInteger(window.required_bars, "分享兑现窗口所需交易日数"),
    },
    quality: {
      status: enumText(quality.status, QUALITY_STATUSES, "分享兑现质量状态"),
      warnings: stringArray(quality.warnings, "分享兑现质量警告"),
    },
  };
}

export function toReportQuality(payload: unknown): ReportQualityDashboard {
  const value = exactRecord(payload, ["scope", "review", "outcome"], "质量看板");
  const review = exactRecord(value.review, ["accepted", "rejected", "decided", "accept_rate"], "审阅质量");
  const outcome = exactRecord(value.outcome, [
    "evaluated", "conclusive", "realized", "none_realized", "ambiguous", "inconclusive",
    "pending", "realized_rate_over_conclusive", "realized_rate_over_evaluated", "by_case",
  ], "兑现质量汇总");
  const byCase = record(outcome.by_case, "兑现情景分布");
  const cases: ReportQualityDashboard["outcome"]["byCase"] = {};
  for (const [key, count] of Object.entries(byCase)) {
    cases[enumText(key, SCENARIO_CASES, "兑现情景")] = nonNegativeInteger(count, "兑现情景计数");
  }
  return {
    scope: enumText(value.scope, ["published", "all"] as const, "质量看板范围"),
    review: {
      accepted: nonNegativeInteger(review.accepted, "审阅通过数"),
      rejected: nonNegativeInteger(review.rejected, "审阅驳回数"),
      decided: nonNegativeInteger(review.decided, "审阅决定数"),
      acceptRate: review.accept_rate == null ? null : text(review.accept_rate, "审阅通过率"),
    },
    outcome: {
      evaluated: nonNegativeInteger(outcome.evaluated, "已评估样本"),
      conclusive: nonNegativeInteger(outcome.conclusive, "有结论样本"),
      realized: nonNegativeInteger(outcome.realized, "兑现样本"),
      noneRealized: nonNegativeInteger(outcome.none_realized, "未兑现样本"),
      ambiguous: nonNegativeInteger(outcome.ambiguous, "多情景冲突样本"),
      inconclusive: nonNegativeInteger(outcome.inconclusive, "无法判定样本"),
      pending: nonNegativeInteger(outcome.pending, "窗口未满样本"),
      realizedRateOverConclusive: outcome.realized_rate_over_conclusive == null
        ? null
        : text(outcome.realized_rate_over_conclusive, "有结论兑现率"),
      realizedRateOverEvaluated: outcome.realized_rate_over_evaluated == null
        ? null
        : text(outcome.realized_rate_over_evaluated, "已评估兑现率"),
      byCase: cases,
    },
  };
}

export function toReportOutcome(payload: unknown): ReportOutcome {
  const value = record(payload, "报告兑现结果");
  exactKeys(value, [
    "schema_version", "report_id", "symbol", "as_of", "evaluated_at", "window",
    "scenarios", "quality", "status", "realized_case", "realized_cases",
  ], ["adjudication"], "报告兑现结果");
  const window = exactRecord(value.window, ["start", "end", "bar_count", "required_bars"], "兑现窗口");
  const quality = exactRecord(value.quality, ["status", "warnings"], "兑现质量");
  return {
    reportId: text(value.report_id, "报告编号"),
    symbol: text(value.symbol, "报告股票"),
    asOf: requiredDate(value.as_of, "报告数据日期"),
    evaluatedAt: requiredDate(value.evaluated_at, "兑现评估时间"),
    status: enumText(value.status, OUTCOME_STATUSES, "兑现状态"),
    adjudication: enumText(
      value.adjudication == null ? inferredAdjudication(value) : value.adjudication,
      OUTCOME_ADJUDICATIONS,
      "兑现裁决规则",
    ),
    realizedCase: value.realized_case == null
      ? null
      : enumText(value.realized_case, SCENARIO_CASES, "兑现情景"),
    realizedCases: array(value.realized_cases, "兑现情景列表")
      .map((item) => enumText(item, SCENARIO_CASES, "兑现情景")),
    window: {
      start: nullableText(window.start, "兑现窗口起点"),
      end: nullableText(window.end, "兑现窗口终点"),
      barCount: nonNegativeInteger(window.bar_count, "兑现窗口交易日数"),
      requiredBars: nonNegativeInteger(window.required_bars, "兑现窗口所需交易日数"),
    },
    scenarios: array(value.scenarios, "兑现情景明细").map((item, index) => toScenarioOutcome(item, index)),
    quality: {
      status: enumText(quality.status, QUALITY_STATUSES, "兑现质量状态"),
      warnings: stringArray(quality.warnings, "兑现质量警告"),
    },
  };
}

function inferredAdjudication(value: Record<string, unknown>): string {
  if (value.status === "pending") return "window_pending";
  const realizedCases = Array.isArray(value.realized_cases) ? value.realized_cases : [];
  if (value.status === "realized") {
    return realizedCases.length > 1 ? "active_breakout_precedence" : "single_candidate";
  }
  if (value.status === "ambiguous") {
    const scenarios = Array.isArray(value.scenarios) ? value.scenarios : [];
    const hasActiveBreakout = scenarios.some((item) => {
      if (!isRecord(item) || !isRecord(item.trigger)) return false;
      if (item.trigger.hit !== true) return false;
      if (isRecord(item.invalidation) && item.invalidation.hit === true) return false;
      return item.trigger.operator === "break_above" || item.trigger.operator === "break_below";
    });
    return hasActiveBreakout ? "multiple_active_breakouts" : "passive_only";
  }
  return "no_candidate";
}

function toScenarioOutcome(payload: unknown, index: number): ReportScenarioOutcome {
  const value = exactRecord(payload, ["case", "trigger", "invalidation"], `兑现情景 ${index + 1}`);
  return {
    case: enumText(value.case, SCENARIO_CASES, "兑现情景类型"),
    trigger: toConditionOutcome(value.trigger, "触发条件"),
    invalidation: toConditionOutcome(value.invalidation, "失效条件"),
  };
}

function toConditionOutcome(payload: unknown, name: string): ReportConditionOutcome {
  const value = record(payload, name);
  // level 仅在事实为数值时出现，无法判定的条件不带该字段。
  exactKeys(value, ["operator", "fact_ref", "hit", "decisive_date", "unevaluable_reason"], ["level"], name);
  return {
    operator: enumText(value.operator, CONDITION_OPERATORS, `${name}算子`),
    factRef: text(value.fact_ref, `${name}事实引用`),
    level: value.level == null ? null : text(value.level, `${name}价格水平`),
    hit: value.hit == null ? null : booleanValue(value.hit, `${name}命中状态`),
    decisiveDate: nullableText(value.decisive_date, `${name}判定日`),
    unevaluableReason: nullableText(value.unevaluable_reason, `${name}无法判定原因`),
  };
}

export function toInvestmentReportJob(payload: unknown): InvestmentReportJob {
  const value = exactRecord(payload, [
    "report_id", "status", "symbol", "timeframe", "as_of", "input_digest",
    "attempt_count", "updated_at", "report", "error",
    "review_status", "reviewed_at", "published_at", "share_token", "outcome",
  ], "报告任务");
  const status = enumText(value.status, REPORT_STATUSES, "报告状态");
  const report = value.report == null ? null : toInvestmentReport(value.report);
  const error = value.error == null ? null : toInvestmentReportError(value.error);
  const validState = status === "completed"
    ? report != null && error == null
    : status === "failed"
      ? report == null && error != null
      : report == null && error == null;
  if (!validState) throw adapterError("报告任务状态与内容不一致");
  const reportId = text(value.report_id, "报告编号");
  const symbol = text(value.symbol, "报告股票");
  const timeframe = enumText(value.timeframe, ["1d", "1w"] as const, "报告周期");
  const asOf = requiredDate(value.as_of, "报告数据日期");
  if (report && (report.id !== reportId || report.symbol !== symbol || report.timeframe !== timeframe || report.asOf !== asOf)) {
    throw adapterError("报告任务与完整报告不一致");
  }
  return {
    reportId,
    status,
    symbol,
    timeframe,
    asOf,
    inputDigest: text(value.input_digest, "报告输入摘要"),
    attemptCount: nonNegativeInteger(value.attempt_count, "报告尝试次数"),
    updatedAt: requiredDate(value.updated_at, "报告更新时间"),
    report,
    error,
    reviewStatus: enumText(value.review_status, REVIEW_STATUSES, "报告审阅状态"),
    reviewedAt: nullableDate(value.reviewed_at, "报告审阅时间"),
    publishedAt: nullableDate(value.published_at, "报告发布时间"),
    shareToken: nullableText(value.share_token, "报告分享令牌"),
    outcome: value.outcome == null ? null : toReportOutcome(value.outcome),
  };
}

function toNews(payload: unknown, index: number) {
  const value = exactRecord(payload, ["id", "title", "summary", "published_at", "source", "url"], `新闻 ${index + 1}`);
  return {
    id: text(value.id, "新闻编号"),
    title: text(value.title, "新闻标题"),
    summary: text(value.summary, "新闻摘要", true),
    publishedAt: requiredDate(value.published_at, "新闻发布时间"),
    source: text(value.source, "新闻来源"),
    url: safeUrl(value.url),
  };
}

function toMessage(payload: unknown, index: number) {
  const value = exactRecord(payload, ["id", "question", "answer", "answerer", "published_at", "source"], `互动问答 ${index + 1}`);
  return {
    id: text(value.id, "问答编号"),
    question: text(value.question, "互动问题"),
    answer: nullableText(value.answer, "互动回答", true),
    answerer: nullableText(value.answerer, "回答方"),
    publishedAt: requiredDate(value.published_at, "互动发布时间"),
    source: text(value.source, "互动来源"),
  };
}

function toSourceQuality(payload: unknown, name: string): InformationSourceQuality {
  const value = exactRecord(payload, ["status", "fetched_at"], `${name}来源质量`);
  return {
    status: enumText(value.status, SOURCE_STATUSES, `${name}来源状态`),
    fetchedAt: nullableDate(value.fetched_at, `${name}抓取时间`),
  };
}

function toInvestmentReport(payload: unknown): InvestmentReport {
  const value = exactRecord(payload, [
    "id", "schema_version", "run_id", "symbol", "timeframe", "as_of", "generated_at",
    "title", "executive_summary", "market_snapshot", "chan_analysis", "information_snapshot",
    "draft", "reference_registry", "outlook", "risks", "evidence_refs", "evidence",
    "disclaimer", "review",
  ], "完整投资报告");
  if (value.schema_version !== "investment_report.v2") throw adapterError("投资报告版本无效");
  record(value.market_snapshot, "行情快照");
  record(value.chan_analysis, "缠论分析");
  toStockInformation(value.information_snapshot);
  record(value.draft, "报告草稿");
  const references = toReferenceRegistry(value.reference_registry);
  const outlook = exactRecord(value.outlook, ["horizon", "direction", "confidence", "thesis", "scenarios"], "报告展望");
  if (outlook.horizon !== "5-20-trading-days") throw adapterError("报告观察周期无效");
  const scenarios = array(outlook.scenarios, "报告情景").map((item, index) => toScenario(item, index, references));
  if (scenarios.length !== 3 || SCENARIO_CASES.some((scenarioCase) => scenarios.filter((scenario) => scenario.case === scenarioCase).length !== 1)) {
    throw adapterError("报告必须包含唯一的三种情景");
  }
  const review = exactRecord(value.review, ["status"], "报告审阅状态");
  if (review.status !== "pending") throw adapterError("报告审阅状态无效");
  const evidence = toHydratedEvidence(value.evidence_refs, value.evidence, references, "报告证据");
  const disclaimer = text(value.disclaimer, "报告免责声明");
  if (disclaimer !== INVESTMENT_REPORT_DISCLAIMER) throw adapterError("报告免责声明无效");
  return {
    id: text(value.id, "投资报告编号"),
    schemaVersion: "investment_report.v2",
    runId: text(value.run_id, "报告运行编号"),
    symbol: text(value.symbol, "投资报告股票"),
    timeframe: enumText(value.timeframe, ["1d", "1w"] as const, "投资报告周期"),
    asOf: requiredDate(value.as_of, "投资报告数据日期"),
    generatedAt: requiredDate(value.generated_at, "投资报告生成时间"),
    title: text(value.title, "投资报告标题"),
    executiveSummary: text(value.executive_summary, "投资报告摘要"),
    references,
    outlook: {
      horizon: "5-20-trading-days",
      direction: enumText(outlook.direction, DIRECTIONS, "报告方向"),
      confidence: enumText(outlook.confidence, CONFIDENCES, "报告置信度"),
      thesis: text(outlook.thesis, "报告主论点"),
      scenarios,
    },
    risks: array(value.risks, "报告风险").map((item, index) => toRisk(item, index, references)),
    evidenceRefs: evidence.refs,
    evidence: evidence.facts,
    disclaimer: INVESTMENT_REPORT_DISCLAIMER,
    review: { status: "pending" },
  };
}

function toReferenceRegistry(payload: unknown): Record<string, ReferenceFact> {
  const value = record(payload, "引用注册表");
  const result: Record<string, ReferenceFact> = {};
  for (const [reference, factValue] of Object.entries(value)) {
    const fact = toReferenceFact(factValue, `引用 ${reference}`);
    if (fact.ref !== reference) throw adapterError("引用注册表编号不一致");
    result[reference] = fact;
  }
  return result;
}

function toReferenceFact(payload: unknown, name: string): ReferenceFact {
  const value = record(payload, name);
  exactKeys(value, ["ref", "kind", "label", "value"], ["unit", "occurred_at", "url"], name);
  const rawValue = value.value;
  if (rawValue !== null && typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
    throw adapterError(`${name}的值无效`);
  }
  if (typeof rawValue === "number" && !Number.isFinite(rawValue)) throw adapterError(`${name}的值无效`);
  const fact: ReferenceFact = {
    ref: text(value.ref, `${name}编号`),
    kind: enumText(value.kind, REFERENCE_KINDS, `${name}类型`),
    label: text(value.label, `${name}标签`),
    value: rawValue,
  };
  if ("unit" in value) fact.unit = text(value.unit, `${name}单位`);
  if ("occurred_at" in value) fact.occurredAt = requiredDate(value.occurred_at, `${name}发生时间`);
  if ("url" in value) fact.url = safeUrl(value.url);
  return fact;
}

function toScenario(payload: unknown, index: number, references: Record<string, ReferenceFact>): InvestmentScenario {
  const value = exactRecord(payload, ["case", "narrative", "trigger", "invalidation", "evidence_refs", "evidence"], `情景 ${index + 1}`);
  const evidence = toHydratedEvidence(value.evidence_refs, value.evidence, references, `情景 ${index + 1}证据`);
  return {
    case: enumText(value.case, SCENARIO_CASES, "情景类型"),
    narrative: text(value.narrative, "情景叙述"),
    trigger: toCondition(value.trigger, "情景触发条件", references),
    invalidation: toCondition(value.invalidation, "情景失效条件", references),
    evidenceRefs: evidence.refs,
    evidence: evidence.facts,
  };
}

function toCondition(payload: unknown, name: string, references: Record<string, ReferenceFact>) {
  const value = exactRecord(payload, ["operator", "fact_ref", "fact"], name);
  const factRef = text(value.fact_ref, `${name}引用编号`);
  const fact = toReferenceFact(value.fact, `${name}引用事实`);
  if (fact.ref !== factRef || !sameReferenceFact(references[factRef], fact)) throw adapterError(`${name}引用不一致`);
  return {
    operator: enumText(value.operator, CONDITION_OPERATORS, `${name}操作符`),
    factRef,
    fact,
  };
}

function toRisk(payload: unknown, index: number, references: Record<string, ReferenceFact>): InvestmentRisk {
  const value = exactRecord(payload, ["narrative", "evidence_refs", "evidence"], `风险 ${index + 1}`);
  const evidence = toHydratedEvidence(value.evidence_refs, value.evidence, references, `风险 ${index + 1}证据`);
  return {
    narrative: text(value.narrative, "风险叙述"),
    evidenceRefs: evidence.refs,
    evidence: evidence.facts,
  };
}

function toHydratedEvidence(
  refsPayload: unknown,
  factsPayload: unknown,
  references: Record<string, ReferenceFact>,
  name: string,
): { refs: string[]; facts: ReferenceFact[] } {
  const refs = stringArray(refsPayload, `${name}编号`);
  const facts = array(factsPayload, name).map((item) => toReferenceFact(item, name));
  if (refs.length !== new Set(refs).size
    || refs.length !== facts.length
    || refs.some((ref, index) => facts[index].ref !== ref || !sameReferenceFact(references[ref], facts[index]))) {
    throw adapterError(`${name}与引用注册表不一致`);
  }
  return { refs, facts };
}

function sameReferenceFact(expected: ReferenceFact | undefined, actual: ReferenceFact): boolean {
  return expected != null
    && expected.ref === actual.ref
    && expected.kind === actual.kind
    && expected.label === actual.label
    && expected.value === actual.value
    && expected.unit === actual.unit
    && expected.occurredAt === actual.occurredAt
    && expected.url === actual.url;
}

function toInvestmentReportError(payload: unknown): InvestmentReportError {
  const value = exactRecord(payload, ["code", "message", "retryable"], "报告错误");
  return {
    code: text(value.code, "报告错误码"),
    message: text(value.message, "报告错误信息"),
    retryable: booleanValue(value.retryable, "报告错误重试状态"),
  };
}

function backendErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.detail === "string" && payload.detail.trim()) return payload.detail;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) {
    return payload.error.message;
  }
  return fallback;
}

function exactRecord(payload: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const value = record(payload, name);
  exactKeys(value, keys, [], name);
  return value;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string) {
  const actual = Object.keys(value);
  if (required.some((key) => !(key in value)) || actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw adapterError(`${name}字段无效`);
  }
}

function record(payload: unknown, name: string): Record<string, unknown> {
  if (!isRecord(payload)) throw adapterError(`${name}格式无效`);
  return payload;
}

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function array(payload: unknown, name: string): unknown[] {
  if (!Array.isArray(payload)) throw adapterError(`${name}格式无效`);
  return payload;
}

function text(payload: unknown, name: string, empty = false): string {
  if (typeof payload !== "string" || (!empty && !payload.trim())) throw adapterError(`${name}无效`);
  return payload;
}

function nullableText(payload: unknown, name: string, empty = false): string | null {
  return payload == null ? null : text(payload, name, empty);
}

function enumText<const T extends string>(payload: unknown, allowed: readonly T[], name: string): T {
  if (typeof payload !== "string" || !allowed.some((value) => value === payload)) throw adapterError(`${name}无效`);
  return payload as T;
}

function stringArray(payload: unknown, name: string): string[] {
  return array(payload, name).map((item) => text(item, name));
}

function nullableNumber(payload: unknown, name: string): number | null {
  if (payload == null) return null;
  if (typeof payload !== "number" || !Number.isFinite(payload)) throw adapterError(`${name}无效`);
  return payload;
}

function nonNegativeInteger(payload: unknown, name: string): number {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) throw adapterError(`${name}无效`);
  return payload;
}

function booleanValue(payload: unknown, name: string): boolean {
  if (typeof payload !== "boolean") throw adapterError(`${name}无效`);
  return payload;
}

function requiredDate(payload: unknown, name: string): string {
  const value = text(payload, name);
  const match = DATE_ONLY.exec(value) ?? ISO_DATE_TIME.exec(value);
  if (!match || !validCalendarDate(match[1], match[2], match[3])) throw adapterError(`${name}无效`);
  if (match.length > 4) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const zone = match[8];
    if (hour > 23 || minute > 59 || second > 59 || !validTimezoneOffset(zone) || !Number.isFinite(Date.parse(value))) {
      throw adapterError(`${name}无效`);
    }
  }
  return value;
}

function validCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTimezoneOffset(value: string | undefined): boolean {
  if (value === "Z") return true;
  if (!value) return false;
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}

function nullableDate(payload: unknown, name: string): string | null {
  return payload == null ? null : requiredDate(payload, name);
}

function safeUrl(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload !== "string") throw adapterError("外部链接无效");
  try {
    const value = new URL(payload);
    return value.protocol === "http:" || value.protocol === "https:" ? value.href : null;
  } catch {
    return null;
  }
}

function adapterError(message: string): ApiError {
  return new ApiError(message, 502);
}

function toWatchItem(row: { symbol: string; name?: string }): WatchItem {
  const market = row.symbol.endsWith(".SH") ? "SH" : "SZ";
  return { symbol: row.symbol, name: row.name ?? row.symbol, market };
}

export function toReport(
  symbol: string,
  timeframe: Timeframe,
  payload: MarketAnalysisResponse,
): Report {
  const snapshot = payload.chan_analysis.snapshot;
  const bars = toChartBars(payload.market_snapshot.bars);
  const structureDates = snapshot.bars.map((bar) => validDate(bar.occurred_at));
  const confirmedStrokes = snapshot.confirmed.flatMap((stroke) => toStroke(stroke, "confirmed", structureDates));
  const provisionalStrokes = snapshot.provisional.flatMap((stroke) => toStroke(stroke, "provisional", structureDates));
  const centers = snapshot.centers.flatMap((center) => toCenter(center, structureDates));
  const segments = (snapshot.segments ?? []).flatMap((segment) => toStroke(segment, segment.status === "provisional" ? "provisional" : "confirmed", structureDates));
  const segmentCenters = (snapshot.segment_centers ?? []).flatMap((center) => toCenter(center, structureDates));
  const chart: ChanChartData = {
    timeframe,
    bars,
    strokes: [...confirmedStrokes, ...provisionalStrokes],
    centers,
    segments,
    segmentCenters,
  };
  const confirmed = confirmedStrokes.length;
  const provisional = provisionalStrokes.length;
  const structure: StructureFact[] = [
    ...centers.slice(-3).map((center, index) => ({
      id: `center-${index}`,
      kind: "center" as const,
      state: "confirmed" as const,
      label: "笔中枢",
      value: `${center.lower} — ${center.upper}`,
    })),
    ...confirmedStrokes.slice(-3).map((stroke, index) => ({
      id: `stroke-${index}`,
      kind: "stroke" as const,
      state: "confirmed" as const,
      label: stroke.direction === "up" ? "向上笔" : "向下笔",
      value: `${stroke.startPrice} → ${stroke.endPrice}`,
    })),
    ...provisionalStrokes.slice(-1).map((stroke, index) => ({
      id: `provisional-${index}`,
      kind: "stroke" as const,
      state: "provisional" as const,
      label: stroke.direction === "up" ? "向上笔（形成中）" : "向下笔（形成中）",
      value: `${stroke.startPrice} → ${stroke.endPrice}`,
    })),
  ];
  return {
    symbol,
    name: symbol,
    asOf: payload.market_snapshot.window.end,
    timeframe,
    chart,
    headline: `已确认 ${confirmed} 笔，${provisional ? "末笔仍在形成" : "结构前缀稳定"}`,
    conclusion: "报告只陈述 Tushare 固化行情与 ChanEngine 已确认结构，不构成买卖建议。",
    structure,
    quality: payload.market_snapshot.quality.status,
    qualityNote: payload.market_snapshot.quality.warnings.join("；") || "行情窗口完整。",
    sources: ["Tushare daily + adj_factor", "本地 ChanEngine v1"],
    review: "未审阅",
  };
}

function toChartBars(values: MarketAnalysisResponse["market_snapshot"]["bars"]): ChartBar[] {
  let previous = "";
  return values.map((bar) => {
    const occurredAt = validDate(bar.occurred_at);
    if (!occurredAt || occurredAt <= previous) throw new ApiError("行情图表时间轴无效", 502);
    previous = occurredAt;
    return {
      occurredAt,
      open: requiredNumber(bar.open),
      close: requiredNumber(bar.close),
      low: requiredNumber(bar.low),
      high: requiredNumber(bar.high),
      volume: bar.volume == null ? null : requiredNumber(bar.volume),
    };
  });
}

function toStroke(
  value: Record<string, unknown>,
  state: ChartStroke["state"],
  dates: Array<string | null>,
): ChartStroke[] {
  const startIndex = integer(value.start_index);
  const endIndex = integer(value.end_index);
  const startAt = startIndex == null ? null : dates[startIndex];
  const endAt = endIndex == null ? null : dates[endIndex];
  const startPrice = finiteNumber(value.start_price);
  const endPrice = finiteNumber(value.end_price);
  const direction = value.direction;
  if (!startAt || !endAt || startAt > endAt || startPrice == null || endPrice == null || (direction !== "up" && direction !== "down")) return [];
  return [{ direction, startAt, endAt, startPrice, endPrice, state }];
}

function toCenter(value: Record<string, unknown>, dates: Array<string | null>): ChartCenter[] {
  const startIndex = integer(value.start_index);
  const endIndex = integer(value.end_index);
  const startAt = startIndex == null ? null : dates[startIndex];
  const endAt = endIndex == null ? null : dates[endIndex];
  const lower = finiteNumber(value.lower);
  const upper = finiteNumber(value.upper);
  if (!startAt || !endAt || startAt > endAt || lower == null || upper == null || lower >= upper) return [];
  return [{ startAt, endAt, lower, upper }];
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function finiteNumber(value: unknown): number | null {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function requiredNumber(value: unknown): number {
  const result = finiteNumber(value);
  if (result == null) throw new ApiError("行情图表价格无效", 502);
  return result;
}

function integer(value: unknown): number | null {
  const result = finiteNumber(value);
  return result != null && Number.isInteger(result) && result >= 0 ? result : null;
}

export function normalizeSymbol(value: string): string {
  const raw = value.trim().toUpperCase().replace(/^SH|^SZ/, "");
  if (!/^\d{6}$/.test(raw)) throw new ApiError("请输入 6 位沪深股票代码", 422);
  const market = raw.startsWith("6") ? "SH" : raw.startsWith("0") || raw.startsWith("3") ? "SZ" : "";
  if (!market) throw new ApiError("首版仅支持沪深 A 股个股", 422);
  return `${raw}.${market}`;
}
