import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createMockApi, normalizeSymbol, type WorkbenchApi } from "./api";
import { ChanChart } from "./ChanChart";
import { OutlookPanel } from "./OutlookPanel";
import { SharedReportPage } from "./SharedReportPage";
import { StockInformationPanel } from "./StockInformationPanel";
import { TradeJournalPage } from "./TradeJournalPage";
import {
  activeCenter,
  centerPositionLabel,
  centerPositionTone,
  deriveQuote,
  formatTradeDate,
  quoteTone,
  signedAmount,
  signedPercent,
} from "./quote";
import { createMockTradingApi, type TradingApi } from "./trading-api";
import { Atmosphere } from "./ui/Atmosphere";
import { EmptyState } from "./ui/EmptyState";
import { type MetricTone } from "./ui/formatDisplay";
import { Icon } from "./ui/Icon";
import { KpiStrip } from "./ui/KpiStrip";
import { MetricTile } from "./ui/MetricTile";
import { Notice } from "./ui/Notice";
import { Panel } from "./ui/Panel";
import { QuoteBand } from "./ui/QuoteBand";
import { SplitPane } from "./ui/SplitPane";
import { StatusChip } from "./ui/StatusChip";
import { ArrowUpRight, LayoutDashboard, NotebookPen, Plus, Terminal, X } from "lucide-react";
import type {
  InvestmentReportJob,
  InvestmentReportStatus,
  Report,
  RunProgress,
  StockInformation,
  StockSuggestion,
  Timeframe,
  WatchItem,
} from "./types";
import "./styles.css";

interface AppProps {
  api?: WorkbenchApi;
  tradingApi?: TradingApi;
  initialError?: string;
}

type WorkbenchView = "batch" | "journal";

function viewFromHash(): WorkbenchView {
  if (window.location.hash === "#/journal" || window.location.hash === "#/reviews") return "journal";
  return "batch";
}

function shareTokenFromHash(): string | null {
  const match = /^#\/share\/([^/?#]+)/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function App({ api, tradingApi, initialError }: AppProps) {
  const service = useMemo(() => api ?? createMockApi(initialError), [api, initialError]);
  const tradingService = useMemo(() => tradingApi ?? createMockTradingApi(), [tradingApi]);
  const [shareToken, setShareToken] = useState<string | null>(shareTokenFromHash);
  if (import.meta.env.PROD && api == null) {
    return <Notice title="未配置 API 地址" detail="请设置 VITE_API_BASE_URL 后重新启动前端，当前不会使用内置假数据。" />;
  }

  useEffect(() => {
    const sync = () => setShareToken(shareTokenFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // 分享路由是纯对客形态：不挂工作台，也不发起任何工作台数据请求。
  if (shareToken != null) return <SharedReportPage token={shareToken} api={service} />;
  return <Workbench service={service} tradingService={tradingService} />;
}

function Workbench({ service, tradingService }: { service: WorkbenchApi; tradingService: TradingApi }) {
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [progress, setProgress] = useState<RunProgress[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [code, setCode] = useState("");
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [chartNotice, setChartNotice] = useState<string | null>(null);
  const [currentSymbol, setCurrentSymbol] = useState<string | null>(null);
  const [loadingTimeframe, setLoadingTimeframe] = useState<Timeframe | null>(null);
  const [information, setInformation] = useState<StockInformation | null>(null);
  const [informationLoading, setInformationLoading] = useState(false);
  const [informationError, setInformationError] = useState<string | null>(null);
  const [outlookJob, setOutlookJob] = useState<InvestmentReportJob | null>(null);
  const [outlookPendingStatus, setOutlookPendingStatus] = useState<InvestmentReportStatus | null>(null);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [outlookError, setOutlookError] = useState<string | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<WorkbenchView>(viewFromHash);
  const [routeHash, setRouteHash] = useState(window.location.hash);
  const reportCache = useRef(new Map<string, Report>());
  const reportRequests = useRef(new Map<string, Promise<Report>>());
  const currentRequest = useRef<string | null>(null);
  const informationCache = useRef(new Map<string, StockInformation>());
  const informationRequests = useRef(new Map<string, Promise<StockInformation>>());
  const currentInformationRequest = useRef<string | null>(null);
  const outlookCache = useRef(new Map<string, InvestmentReportJob>());
  const outlookLatestDigest = useRef(new Map<string, string>());
  const outlookRuns = useRef(new Map<string, { reportId: string; status: InvestmentReportStatus }>());
  const currentOutlookSelection = useRef<{ key: string; symbol: string; timeframe: Timeframe } | null>(null);
  const outlookTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outlookPollToken = useRef(0);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchPollToken = useRef(0);
  const hydratedBatchReports = useRef(new Set<string>());
  const outlookMutationPending = useRef(false);
  const deliveryPending = useRef(false);
  const mounted = useRef(false);
  const lifecycleToken = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const token = ++lifecycleToken.current;
    void service.getWatchlist().then((items) => {
      if (!mounted.current || lifecycleToken.current !== token) return;
      setWatchlist(items);
      if (items.length) {
        selectSymbol(items[0].symbol, true);
      }
    }).catch((error: unknown) => {
      if (mounted.current && lifecycleToken.current === token) setNotice(errorMessage(error));
    });
    void service.getProgress().then((items) => {
      if (mounted.current && lifecycleToken.current === token) setProgress(items);
    }).catch((error: unknown) => {
      if (mounted.current && lifecycleToken.current === token) setNotice(errorMessage(error));
    });
    return () => {
      mounted.current = false;
      lifecycleToken.current += 1;
      currentOutlookSelection.current = null;
      outlookMutationPending.current = false;
      stopOutlookPolling();
      stopBatchPolling();
    };
  }, [service]);

  useEffect(() => {
    const syncView = () => {
      setView(viewFromHash());
      setRouteHash(window.location.hash);
    };
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  useEffect(() => {
    if (currentSymbol == null || watchlist.some((item) => item.symbol === currentSymbol)) return;
    if (watchlist.length) {
      selectSymbol(watchlist[0].symbol, true);
      return;
    }
    clearCurrentSelection();
  }, [currentSymbol, watchlist]);

  const completed = useMemo(() => progress.filter((item) => item.state === "completed").length, [progress]);
  const runningCount = useMemo(() => progress.filter((item) => item.state === "running").length, [progress]);
  const runningLabel = progress.length ? `运行中 · ${completed} / ${progress.length}` : "暂无运行";
  const batchChip = batchStatus(progress);
  // 顶部 KPI 条优先展示当前标的的行情事实；没有报告时才退回批次计数。
  const quote = useMemo(() => (report ? deriveQuote(report.chart) : null), [report]);
  const quoteCenter = useMemo(() => (report ? activeCenter(report.chart) : null), [report]);

  async function loadReport(symbol: string, timeframe: Timeframe, clear = false) {
    const key = `${symbol}:${timeframe}`;
    currentRequest.current = key;
    setChartNotice(null);
    const cached = reportCache.current.get(key);
    if (cached) {
      setReport(cached);
      setLoadingTimeframe(null);
      showOutlookSelection(symbol, timeframe);
      return;
    }
    if (clear) setReport(null);
    setLoadingTimeframe(timeframe);
    let pending = reportRequests.current.get(key);
    if (!pending) {
      pending = service.getReport(symbol, timeframe);
      reportRequests.current.set(key, pending);
    }
    try {
      const next = await pending;
      reportCache.current.set(key, next);
      if (currentRequest.current !== key) return;
      setReport(next);
      setNotice(null);
      showOutlookSelection(symbol, timeframe);
    } catch (error) {
      if (currentRequest.current !== key) return;
      if (timeframe === "1w" && report) {
        setChartNotice("周线加载失败，请重试。");
        showOutlookSelection(report.symbol, report.timeframe);
      }
      else setNotice(errorMessage(error));
    } finally {
      if (reportRequests.current.get(key) === pending) reportRequests.current.delete(key);
      if (currentRequest.current === key) setLoadingTimeframe(null);
    }
  }

  async function loadInformation(symbol: string, clear = false) {
    currentInformationRequest.current = symbol;
    setInformationError(null);
    const cached = informationCache.current.get(symbol);
    if (cached) {
      setInformation(cached);
      setInformationLoading(false);
      return;
    }
    if (clear) setInformation(null);
    setInformationLoading(true);
    let pending = informationRequests.current.get(symbol);
    if (!pending) {
      pending = service.getInformation(symbol);
      informationRequests.current.set(symbol, pending);
    }
    try {
      const next = await pending;
      informationCache.current.set(symbol, next);
      if (currentInformationRequest.current !== symbol) return;
      setInformation(next);
    } catch (error) {
      if (currentInformationRequest.current !== symbol) return;
      setInformationError(errorMessage(error));
    } finally {
      if (informationRequests.current.get(symbol) === pending) informationRequests.current.delete(symbol);
      if (currentInformationRequest.current === symbol) setInformationLoading(false);
    }
  }

  function selectSymbol(symbol: string, clear = false) {
    if (!clear && currentSymbol === symbol) return;
    setCurrentSymbol(symbol);
    currentInformationRequest.current = symbol;
    resetOutlookSelection();
    void loadReport(symbol, "1d", true);
    void loadInformation(symbol, true);
  }

  function showOutlookSelection(symbol: string, timeframe: Timeframe) {
    stopOutlookPolling();
    const key = `${symbol}:${timeframe}`;
    currentOutlookSelection.current = { key, symbol, timeframe };
    setOutlookError(null);
    const digest = outlookLatestDigest.current.get(key);
    const cached = digest ? outlookCache.current.get(`${key}:${digest}`) ?? null : null;
    const activeRun = outlookRuns.current.get(key);
    const activeRunIsNewer = activeRun != null
      && (cached == null || activeRun.reportId !== cached.reportId || activeRun.status !== cached.status);
    const selectedCache = activeRunIsNewer ? null : cached;
    setOutlookJob(selectedCache);
    if (selectedCache?.status === "completed" || selectedCache?.status === "failed") {
      setOutlookPendingStatus(null);
      return;
    }
    const status = activeRunIsNewer ? activeRun.status : selectedCache?.status ?? activeRun?.status ?? null;
    setOutlookPendingStatus(status);
    if (activeRun && status) {
      if (status === "queued" || status === "running") beginOutlookPolling(activeRun.reportId, key);
      else void fetchOutlookNow(activeRun.reportId, key);
    }
  }

  function resetOutlookSelection() {
    stopOutlookPolling();
    currentOutlookSelection.current = null;
    setOutlookJob(null);
    setOutlookPendingStatus(null);
    setOutlookError(null);
  }

  function clearCurrentSelection() {
    currentRequest.current = null;
    currentInformationRequest.current = null;
    setCurrentSymbol(null);
    setReport(null);
    setLoadingTimeframe(null);
    setChartNotice(null);
    setInformation(null);
    setInformationLoading(false);
    setInformationError(null);
    setNotice(null);
    resetOutlookSelection();
  }

  function stopOutlookPolling() {
    if (outlookTimer.current) clearTimeout(outlookTimer.current);
    outlookTimer.current = null;
    outlookPollToken.current += 1;
  }

  function beginOutlookPolling(reportId: string, selectionKey: string) {
    stopOutlookPolling();
    const token = outlookPollToken.current;
    scheduleOutlookPoll(reportId, selectionKey, token);
  }

  function scheduleOutlookPoll(reportId: string, selectionKey: string, token: number) {
    outlookTimer.current = setTimeout(() => {
      outlookTimer.current = null;
      void pollOutlook(reportId, selectionKey, token);
    }, 2000);
  }

  function fetchOutlookNow(reportId: string, selectionKey: string) {
    const token = outlookPollToken.current;
    return pollOutlook(reportId, selectionKey, token);
  }

  async function pollOutlook(reportId: string, selectionKey: string, token: number) {
    try {
      const job = await service.getInvestmentReport(reportId);
      if (outlookPollToken.current !== token || currentOutlookSelection.current?.key !== selectionKey) return;
      cacheOutlookJob(selectionKey, job);
      setOutlookJob(job);
      if (job.status === "queued" || job.status === "running") {
        setOutlookPendingStatus(job.status);
        scheduleOutlookPoll(reportId, selectionKey, token);
      } else {
        setOutlookPendingStatus(null);
      }
    } catch (error) {
      if (outlookPollToken.current !== token || currentOutlookSelection.current?.key !== selectionKey) return;
      setOutlookPendingStatus(null);
      setOutlookError(errorMessage(error));
    }
  }

  function cacheOutlookJob(selectionKey: string, job: InvestmentReportJob) {
    const cacheKey = `${selectionKey}:${job.inputDigest}`;
    outlookCache.current.set(cacheKey, job);
    outlookLatestDigest.current.set(selectionKey, job.inputDigest);
    outlookRuns.current.set(selectionKey, { reportId: job.reportId, status: job.status });
  }

  function stopBatchPolling() {
    if (batchTimer.current) clearTimeout(batchTimer.current);
    batchTimer.current = null;
    batchPollToken.current += 1;
  }

  function scheduleBatchPoll(token: number) {
    batchTimer.current = setTimeout(() => {
      batchTimer.current = null;
      void refreshBatchProgress(token);
    }, 2000);
  }

  async function refreshBatchProgress(token: number) {
    try {
      const items = await service.getProgress();
      if (!mounted.current || batchPollToken.current !== token) return;
      setProgress(items);
      for (const item of items) {
        if (item.state !== "completed" || !item.reportId || hydratedBatchReports.current.has(item.reportId)) continue;
        hydratedBatchReports.current.add(item.reportId);
        void hydrateBatchReport(item, token);
      }
      if (items.some((item) => item.state === "queued" || item.state === "running")) scheduleBatchPoll(token);
    } catch (error) {
      if (!mounted.current || batchPollToken.current !== token) return;
      setNotice(errorMessage(error));
      scheduleBatchPoll(token);
    }
  }

  async function hydrateBatchReport(item: RunProgress, token: number) {
    if (!item.reportId) return;
    try {
      const job = await service.getInvestmentReport(item.reportId);
      if (!mounted.current || batchPollToken.current !== token) return;
      const selectionKey = `${item.symbol}:1d`;
      cacheOutlookJob(selectionKey, job);
      if (currentOutlookSelection.current?.key === selectionKey) {
        setOutlookJob(job);
        setOutlookPendingStatus(null);
        setOutlookError(null);
      }
    } catch (error) {
      hydratedBatchReports.current.delete(item.reportId);
      if (mounted.current && batchPollToken.current === token) setNotice(errorMessage(error));
    }
  }

  async function createOutlook() {
    const selection = currentOutlookSelection.current;
    if (!selection || outlookMutationPending.current) return;
    const mutationToken = lifecycleToken.current;
    outlookMutationPending.current = true;
    setOutlookBusy(true);
    setOutlookError(null);
    try {
      const created = await service.createInvestmentReport(selection.symbol, selection.timeframe);
      if (!mounted.current || lifecycleToken.current !== mutationToken) return;
      outlookRuns.current.set(selection.key, { reportId: created.reportId, status: created.status });
      if (currentOutlookSelection.current?.key !== selection.key) return;
      setOutlookJob(null);
      setOutlookPendingStatus(created.status);
      if (created.status === "completed") {
        const token = outlookPollToken.current;
        await pollOutlook(created.reportId, selection.key, token);
      } else if (created.status === "queued" || created.status === "running") {
        beginOutlookPolling(created.reportId, selection.key);
      }
    } catch (error) {
      if (mounted.current && lifecycleToken.current === mutationToken && currentOutlookSelection.current?.key === selection.key) {
        setOutlookError(errorMessage(error));
      }
    } finally {
      if (mounted.current && lifecycleToken.current === mutationToken) {
        outlookMutationPending.current = false;
        setOutlookBusy(false);
      }
    }
  }

  async function retryOutlook() {
    const selection = currentOutlookSelection.current;
    const failed = outlookJob;
    if (!selection || failed?.status !== "failed" || outlookMutationPending.current) return;
    const mutationToken = lifecycleToken.current;
    outlookMutationPending.current = true;
    setOutlookBusy(true);
    setOutlookError(null);
    try {
      const retried = await service.retryInvestmentReport(failed.reportId);
      if (!mounted.current || lifecycleToken.current !== mutationToken) return;
      outlookRuns.current.set(selection.key, { reportId: retried.reportId, status: retried.status });
      if (currentOutlookSelection.current?.key !== selection.key) return;
      setOutlookJob(null);
      setOutlookPendingStatus(retried.status);
      if (retried.status === "completed") {
        const token = outlookPollToken.current;
        await pollOutlook(retried.reportId, selection.key, token);
      } else if (retried.status === "queued" || retried.status === "running") {
        beginOutlookPolling(retried.reportId, selection.key);
      }
    } catch (error) {
      if (mounted.current && lifecycleToken.current === mutationToken && currentOutlookSelection.current?.key === selection.key) {
        setOutlookError(errorMessage(error));
      }
    } finally {
      if (mounted.current && lifecycleToken.current === mutationToken) {
        outlookMutationPending.current = false;
        setOutlookBusy(false);
      }
    }
  }

  // 审阅、发布与兑现评估共用同一条收尾路径：动作成功后重新拉取任务，
  // 让审阅状态、发布时间和兑现结论都以服务端为准。
  async function runDeliveryAction(action: (reportId: string) => Promise<unknown>) {
    const selection = currentOutlookSelection.current;
    const job = outlookJob;
    if (!selection || job?.status !== "completed" || deliveryPending.current) return;
    const mutationToken = lifecycleToken.current;
    deliveryPending.current = true;
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      await action(job.reportId);
      if (!mounted.current || lifecycleToken.current !== mutationToken) return;
      const refreshed = await service.getInvestmentReport(job.reportId);
      if (!mounted.current || lifecycleToken.current !== mutationToken) return;
      if (currentOutlookSelection.current?.key !== selection.key) return;
      cacheOutlookJob(selection.key, refreshed);
      setOutlookJob(refreshed);
    } catch (error) {
      if (mounted.current && lifecycleToken.current === mutationToken && currentOutlookSelection.current?.key === selection.key) {
        setDeliveryError(errorMessage(error));
      }
    } finally {
      if (mounted.current && lifecycleToken.current === mutationToken) {
        deliveryPending.current = false;
        setDeliveryBusy(false);
      }
    }
  }

  useEffect(() => {
    const query = code.trim();
    if (!query) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void service.searchStocks(query).then((rows) => {
        if (!cancelled) setSuggestions(rows);
      }).catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, service]);

  async function commitWatchItem(candidate: { symbol: string; name: string }) {
    if (watchlist.some((item) => item.symbol === candidate.symbol)) throw new ApiError("股票已在自选池", 409);
    const saved = await service.addWatchlist(candidate.symbol);
    const item = { ...saved, name: candidate.name || saved.name };
    setWatchlist((items) => [...items, item]);
    setCode("");
    setSuggestions([]);
    setNotice(null);
    selectSymbol(item.symbol);
  }

  async function resolveWatchQuery(raw: string): Promise<{ symbol: string; name: string }> {
    const symbol = parseWatchCode(raw);
    if (symbol) {
      const known = suggestions.find((item) => item.symbol === symbol);
      if (known) return { symbol, name: known.name };
      const match = (await service.searchStocks(symbol)).find((item) => item.symbol === symbol);
      return { symbol, name: match?.name ?? symbol };
    }
    const hits = suggestions.length ? suggestions : await service.searchStocks(raw);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new ApiError("未找到匹配股票", 404);
    throw new ApiError("请从候选列表中选择一只股票", 422);
  }

  async function addSymbol() {
    const raw = code.trim();
    if (!raw) return;
    try {
      await commitWatchItem(await resolveWatchQuery(raw));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function addSuggestion(item: StockSuggestion) {
    try {
      await commitWatchItem(item);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function removeSymbol(symbol: string) {
    await service.removeWatchlist(symbol);
    setWatchlist((items) => items.filter((item) => item.symbol !== symbol));
  }

  async function createBatch() {
    stopBatchPolling();
    const token = batchPollToken.current;
    hydratedBatchReports.current.clear();
    setProgress(watchlist.map((item) => ({ ...item, stage: "排队", state: "queued" })));
    setBusy(true);
    try {
      await service.createBatch();
      if (!mounted.current || batchPollToken.current !== token) return;
      setNotice(null);
      await refreshBatchProgress(token);
    } catch (error) {
      if (mounted.current && batchPollToken.current === token) setNotice(errorMessage(error));
    } finally {
      if (mounted.current && batchPollToken.current === token) setBusy(false);
    }
  }

  return (
    <div className={`app-shell${view === "journal" ? " ledger-shell" : ""}`}>
      <Atmosphere />
      <aside className="rail">
        <div className="brand-mark" aria-label="结构投研台">
          <Icon icon={Terminal} size={28} />
          CHAN
        </div>
        <div className="rail-caption">结构投研台</div>
        <nav aria-label="主导航">
          <a href="#/batch" className={`nav-item${view === "batch" ? " active" : ""}`} aria-current={view === "batch" ? "page" : undefined} onClick={() => setView("batch")}><Icon icon={LayoutDashboard} />今日批次 <span className="nav-count">{progress.length.toString().padStart(2, "0")}</span></a>
          <a href="#/journal" className={`nav-item${view === "journal" ? " active" : ""}`} aria-current={view === "journal" ? "page" : undefined} onClick={() => setView("journal")}><Icon icon={NotebookPen} />交易日记</a>
        </nav>
        <div className="rail-footer"><span className="rail-status"><i aria-hidden="true" />系统：运行中</span></div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div>
            <div className="eyebrow">{viewEyebrow(view)}</div>
            {view === "batch" ? <h1>收盘后的结构，<em>现在</em>可见。</h1> : <h1>交易日记</h1>}
          </div>
          {view === "batch" && <button className="primary-button" onClick={createBatch} disabled={busy}>
            {busy ? "正在创建…" : "生成本批报告"}<Icon icon={ArrowUpRight} />
          </button>}
        </header>

        {notice && <Notice title="数据服务暂不可用" detail={notice} />}

        {view === "batch" && <div className="batch-page"><KpiStrip>
          {quote
            ? <>
              <MetricTile
                label={`最新收盘 · ${report?.symbol ?? ""}`}
                value={quote.last.toFixed(2)}
                tone={quoteTone(quote.changeRate)}
                detail={`AS OF ${report ? formatTradeDate(report.asOf) : "—"}`}
              />
              <MetricTile
                label="涨跌幅"
                value={signedPercent(quote.changeRate)}
                tone={quoteTone(quote.changeRate)}
                detail={`涨跌额 ${signedAmount(quote.change)}`}
              />
              <MetricTile
                label="中枢位置"
                value={quoteCenter ? centerPositionLabel(quoteCenter.position) : "无中枢"}
                tone={quoteCenter ? centerPositionTone(quoteCenter.position) : "neutral"}
                detail={quoteCenter ? `${quoteCenter.lower.toFixed(2)} – ${quoteCenter.upper.toFixed(2)}` : "现价未落在任何笔中枢"}
              />
              <MetricTile
                label="本批状态"
                value={<StatusChip tone={batchChip.tone} label={batchChip.label} />}
                detail={`自选 ${watchlist.length} · 完成 ${completed} · 运行 ${runningCount}`}
              />
            </>
            : <>
              <MetricTile label="自选" value={String(watchlist.length).padStart(2, "0")} />
              <MetricTile label="已完成" value={String(completed).padStart(2, "0")} />
              <MetricTile label="运行中" value={String(runningCount).padStart(2, "0")} />
              <MetricTile label="本批状态" value={<StatusChip tone={batchChip.tone} label={batchChip.label} />} />
            </>}
        </KpiStrip>
        <div className="batch-cockpit">
        <SplitPane
          left={<>
          <Panel title="自选池" className="watchlist-panel">
            <div className="watch-suggest">
            <div className="watch-input"><label htmlFor="watch-code">添加股票</label><input id="watch-code" role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls="watch-suggestions" value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addSymbol(); }} placeholder="名称、代码或拼音" /><button onClick={() => void addSymbol()}><Icon icon={Plus} />加入自选</button></div>
            {suggestions.length > 0 && <ul id="watch-suggestions" className="watch-suggest-list" role="listbox" aria-label="股票候选">{suggestions.map((item) => <li key={item.symbol}><button type="button" role="option" aria-selected="false" onClick={() => void addSuggestion(item)}><strong>{item.name}</strong><span>{item.symbol}</span></button></li>)}</ul>}
            </div>
            <div className="watch-items">{watchlist.length ? watchlist.map((item, index) => <div className={`watch-row${currentSymbol === item.symbol ? " selected" : ""}`} key={item.symbol}><button type="button" className="watch-select" aria-label={`选择 ${item.name} ${item.symbol}`} aria-pressed={currentSymbol === item.symbol} onClick={() => selectSymbol(item.symbol)}><span className="row-number">{String(index + 1).padStart(2, "0")}</span><span className="market-dot" data-market={item.market} /><span className="watch-name"><strong>{item.name}</strong><small>{item.symbol}</small></span></button><button type="button" className="icon-button" aria-label={`移除 ${item.symbol}`} onClick={() => void removeSymbol(item.symbol)}><Icon icon={X} /></button></div>) : <EmptyState title="自选池还是空的。" />}</div>
          </Panel>
          <Panel title="本批进度" className="pulse-panel">
            <span className="live-pill"><i />LIVE</span>
            <div className="progress-summary"><strong>{runningLabel}</strong><span>盘后手动触发</span></div>
            <div className="progress-track"><div style={{ width: `${progress.length ? Math.max(16, (completed / progress.length) * 100) : 0}%` }} /></div>
            <div className="run-list">{progress.slice(0, 6).map((item) => <div className="run-row" key={item.symbol}><span className={`status-dot ${item.state}`} /><strong>{item.symbol}</strong><span>{item.stage}</span><small>{stateLabel(item.state)}</small></div>)}</div>
          </Panel>
          </>}
          right={<>
          <Panel title="结构报告" className="report-section">
            {report && <ReportView
              report={report}
              loadingTimeframe={loadingTimeframe}
              chartNotice={chartNotice}
              onTimeframeChange={(timeframe) => {
                if (currentSymbol) {
                  resetOutlookSelection();
                  void loadReport(currentSymbol, timeframe);
                }
              }}
            />}
            {!report && loadingTimeframe && <div className="report-loading">正在加载结构报告…</div>}
            {!report && !loadingTimeframe && <EmptyState title="还没有结构报告。" />}
          </Panel>
          <section className="outlook-section" aria-label="三情景走势报告">
            <OutlookPanel
              job={outlookJob}
              pendingStatus={outlookPendingStatus}
              busy={outlookBusy}
              requestError={outlookError}
              onGenerate={() => void createOutlook()}
              onRetry={() => void retryOutlook()}
              deliveryBusy={deliveryBusy}
              deliveryError={deliveryError}
              onReview={(decision) => void runDeliveryAction((reportId) => service.reviewInvestmentReport(reportId, decision))}
              onPublish={() => void runDeliveryAction((reportId) => service.publishInvestmentReport(reportId))}
              onEvaluateOutcome={() => void runDeliveryAction((reportId) => service.evaluateInvestmentReportOutcome(reportId))}
              onCreateShare={() => void runDeliveryAction((reportId) => service.createInvestmentReportShare(reportId))}
              onRevokeShare={() => void runDeliveryAction((reportId) => service.revokeInvestmentReportShare(reportId))}
            />
          </section>
          <section className="evidence-section">
            <div className="section-heading"><h2>资讯与市场热度</h2><div className="data-line"><span className={`status-dot ${informationError ? "degraded" : "completed"}`} />EASTMONEY · CNINFO · THS</div></div>
            <StockInformationPanel information={information} loading={informationLoading} error={informationError} />
          </section>
          </>}
        />
        </div></div>}

        {view === "journal" && <TradeJournalPage key={routeHash === "#/reviews" ? "week" : "month"} api={tradingService} initialView={routeHash === "#/reviews" ? "week" : "month"} />}
      </main>
    </div>
  );
}

function ReportView({
  report,
  loadingTimeframe,
  chartNotice,
  onTimeframeChange,
}: {
  report: Report;
  loadingTimeframe?: Timeframe | null;
  chartNotice?: string | null;
  onTimeframeChange?: (timeframe: Timeframe) => void;
}) {
  const market = report.symbol.endsWith(".SZ") ? "SZ" : "SH";
  return <article className="report-card">
    <div className="report-header"><div><div className="report-symbol"><span className="market-chip">{market}</span>{report.symbol} <span>{report.name}</span></div><h3>{report.headline}</h3></div><div className="report-header-actions">{onTimeframeChange && <div className="timeframe-switch" aria-label="图表周期"><button type="button" aria-pressed={report.timeframe === "1d"} onClick={() => onTimeframeChange("1d")}>日线</button><button type="button" aria-label={loadingTimeframe === "1w" ? "周线加载中" : "周线"} aria-pressed={report.timeframe === "1w"} disabled={loadingTimeframe === "1w"} onClick={() => onTimeframeChange("1w")}>{loadingTimeframe === "1w" ? "加载中…" : "周线"}</button></div>}<div className="report-meta"><span>AS OF</span><strong>{formatTradeDate(report.asOf)}</strong><span className={`quality-tag ${report.quality}`}>{report.quality === "ok" ? "数据完整" : "部分降级"}</span></div></div></div>
    <QuoteBand chart={report.chart} />
    <div className="report-body"><div className="chart-pane">{chartNotice && <div className="chart-notice" role="status">{chartNotice}</div>}<ChanChart symbol={report.symbol} data={report.chart} /></div></div>
    <div className="report-footer"><div className="sources"><span>来源</span>{report.sources.map((source) => <span className="source-chip" key={source}>{source}</span>)}</div><div className="review-state">审阅状态：<strong>{report.review}</strong></div><div className="quality-note">{report.qualityNote}</div></div>
  </article>;
}

function parseWatchCode(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ)$/.test(trimmed)) {
    try {
      return normalizeSymbol(trimmed.slice(0, 6));
    } catch {
      return null;
    }
  }
  try {
    return normalizeSymbol(value);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "请求失败，请检查本机服务是否已启动。";
}

function stateLabel(state: RunProgress["state"]): string {
  return { queued: "排队", running: "进行中", completed: "完成", degraded: "降级", failed: "失败" }[state];
}

function batchStatus(progress: RunProgress[]): { label: string; tone: MetricTone } {
  if (!progress.length) return { label: "无批次", tone: "neutral" };
  if (progress.some((item) => item.state === "failed")) return { label: "失败", tone: "down" };
  if (progress.some((item) => item.state === "degraded")) return { label: "降级", tone: "risk" };
  if (progress.some((item) => item.state === "running" || item.state === "queued")) return { label: "进行中", tone: "risk" };
  return { label: "完成", tone: "up" };
}

function viewEyebrow(view: WorkbenchView): string {
  return {
    batch: "A-SHARE STRUCTURAL RESEARCH · 2026.08.11",
    journal: "TRADING JOURNAL · DAILY CLOSE",
  }[view];
}
