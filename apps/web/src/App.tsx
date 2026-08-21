import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createMockApi, normalizeSymbol, type WorkbenchApi } from "./api";
import { ChanChart } from "./ChanChart";
import { OutlookPanel } from "./OutlookPanel";
import { ReviewCenterPage } from "./ReviewCenterPage";
import { SharedReportPage } from "./SharedReportPage";
import { StockInformationPanel } from "./StockInformationPanel";
import { TradeJournalPage } from "./TradeJournalPage";
import { createMockTradingApi, type TradingApi } from "./trading-api";
import type {
  InvestmentReportJob,
  InvestmentReportStatus,
  Report,
  RunProgress,
  StockInformation,
  Timeframe,
  WatchItem,
} from "./types";
import "./styles.css";

interface AppProps {
  api?: WorkbenchApi;
  tradingApi?: TradingApi;
  initialError?: string;
}

type WorkbenchView = "batch" | "records" | "snapshots" | "journal" | "reviews";

function viewFromHash(): WorkbenchView {
  if (window.location.hash === "#/records") return "records";
  if (window.location.hash === "#/snapshots") return "snapshots";
  if (window.location.hash === "#/journal") return "journal";
  if (window.location.hash === "#/reviews") return "reviews";
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
    const syncView = () => setView(viewFromHash());
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
  const runningLabel = progress.length ? `运行中 · ${completed} / ${progress.length}` : "暂无运行";

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

  async function addSymbol() {
    try {
      const normalized = normalizeSymbol(code);
      if (watchlist.some((item) => item.symbol === normalized)) throw new ApiError("股票已在自选池", 409);
      const item = await service.addWatchlist(normalized);
      setWatchlist((items) => [...items, item]);
      setCode("");
      setNotice(null);
      selectSymbol(item.symbol);
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
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-mark" aria-label="结构投研台">CH<span>AN</span></div>
        <div className="rail-caption">结构投研台</div>
        <nav aria-label="主导航">
          <a href="#/batch" className={`nav-item${view === "batch" ? " active" : ""}`} aria-current={view === "batch" ? "page" : undefined} onClick={() => setView("batch")}>今日批次 <span>{progress.length.toString().padStart(2, "0")}</span></a>
          <a href="#/records" className={`nav-item${view === "records" ? " active" : ""}`} aria-current={view === "records" ? "page" : undefined} onClick={() => setView("records")}>研究记录 <span>{completed.toString().padStart(2, "0")}</span></a>
          <a href="#/snapshots" className={`nav-item${view === "snapshots" ? " active" : ""}`} aria-current={view === "snapshots" ? "page" : undefined} onClick={() => setView("snapshots")}>数据快照</a>
          <a href="#/journal" className={`nav-item${view === "journal" ? " active" : ""}`} aria-current={view === "journal" ? "page" : undefined} onClick={() => setView("journal")}>交易日记</a>
          <a href="#/reviews" className={`nav-item${view === "reviews" ? " active" : ""}`} aria-current={view === "reviews" ? "page" : undefined} onClick={() => setView("reviews")}>复盘中心</a>
        </nav>
        <div className="rail-footer">LOCAL / INTERNAL<br /><span>v0.1 · TUSHARE CORE</span></div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div>
            <div className="eyebrow">{viewEyebrow(view)}</div>
            {view === "batch" ? <h1>收盘后的结构，<em>现在</em>可见。</h1> : <h1>{view === "records" ? "研究记录" : view === "snapshots" ? "数据快照" : view === "journal" ? "交易日记" : "复盘中心"}</h1>}
          </div>
          {view === "batch" && <button className="primary-button" onClick={createBatch} disabled={busy}>
            {busy ? "正在创建…" : "生成本批报告"}<span>↗</span>
          </button>}
        </header>

        {notice && <div className="notice" role="alert"><span>!</span><div><strong>数据服务暂不可用</strong><br />{notice}</div></div>}

        {view === "batch" && <><section className="dashboard-grid">
          <section className="panel watchlist-panel">
            <div className="panel-heading"><div><span className="section-index">01</span><h2>自选池</h2></div><span className="count-badge">{watchlist.length.toString().padStart(2, "0")} / 50</span></div>
            <div className="watch-input"><label htmlFor="watch-code">股票代码</label><input id="watch-code" value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addSymbol(); }} placeholder="例如 600519" /><button onClick={() => void addSymbol()}>加入自选</button></div>
            <div className="watch-items">{watchlist.map((item, index) => <div className={`watch-row${currentSymbol === item.symbol ? " selected" : ""}`} key={item.symbol}><button type="button" className="watch-select" aria-label={`选择 ${item.symbol} ${item.name}`} aria-pressed={currentSymbol === item.symbol} onClick={() => selectSymbol(item.symbol)}><span className="row-number">{String(index + 1).padStart(2, "0")}</span><span className="market-dot" data-market={item.market} /><span className="watch-name"><strong>{item.symbol}</strong><small>{item.name}</small></span></button><button type="button" className="icon-button" aria-label={`移除 ${item.symbol}`} onClick={() => void removeSymbol(item.symbol)}>×</button></div>)}</div>
          </section>

          <section className="panel pulse-panel">
            <div className="panel-heading"><div><span className="section-index">02</span><h2>本批进度</h2></div><span className="live-pill"><i />LIVE</span></div>
            <div className="progress-summary"><strong>{runningLabel}</strong><span>盘后手动触发</span></div>
            <div className="progress-track"><div style={{ width: `${progress.length ? Math.max(16, (completed / progress.length) * 100) : 0}%` }} /></div>
            <div className="run-list">{progress.slice(0, 6).map((item) => <div className="run-row" key={item.symbol}><span className={`status-dot ${item.state}`} /><strong>{item.symbol}</strong><span>{item.stage}</span><small>{stateLabel(item.state)}</small></div>)}</div>
          </section>
        </section>

        <section className="report-section">
          <div className="section-heading"><div><span className="section-index">03</span><h2>结构报告</h2></div><div className="data-line"><span className="status-dot completed" />TUSHARE · QFQ · DAILY + WEEKLY</div></div>
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
        </section>

        <section className="evidence-section">
          <div className="section-heading"><div><span className="section-index">04</span><h2>资讯与市场热度</h2></div><div className="data-line"><span className={`status-dot ${informationError ? "degraded" : "completed"}`} />EASTMONEY · CNINFO · THS</div></div>
          <StockInformationPanel information={information} loading={informationLoading} error={informationError} />
        </section>

        <section className="outlook-section">
          <div className="section-heading"><div><span className="section-index">05</span><h2>AI 条件展望</h2></div><div className="data-line"><span className={`status-dot ${outlookJob?.status === "failed" ? "degraded" : outlookJob?.status === "running" || outlookPendingStatus === "running" ? "running" : "completed"}`} />PI AGENT · INVESTMENT REPORT V2</div></div>
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
        </section></>}

        {view === "records" && <ResearchRecords progress={progress} report={report} />}
        {view === "snapshots" && <DataSnapshots watchlist={watchlist} report={report} />}
        {view === "journal" && <TradeJournalPage api={tradingService} />}
        {view === "reviews" && <ReviewCenterPage api={tradingService} />}
      </main>
    </div>
  );
}

function ResearchRecords({ progress, report }: { progress: RunProgress[]; report: Report | null }) {
  return <section className="view-section" aria-label="研究记录列表">
    <div className="section-heading"><div><span className="section-index">01</span><h2>运行归档</h2></div><span className="count-badge">{progress.length.toString().padStart(2, "0")} RECORDS</span></div>
    <div className="record-list">
      {progress.length ? progress.map((item, index) => <article className="record-row" key={`${item.symbol}-${index}`}><span className={`status-dot ${item.state}`} /><div><strong>{item.symbol}</strong><small>{item.name}</small></div><span>{item.stage}</span><small>{stateLabel(item.state)}</small></article>) : <div className="empty-state">尚无研究运行记录</div>}
    </div>
    {report && <div className="record-report"><div className="section-heading"><div><span className="section-index">02</span><h2>最近报告</h2></div><span className={`quality-tag ${report.quality}`}>{report.quality === "ok" ? "数据完整" : "部分降级"}</span></div><ReportView report={report} /></div>}
  </section>;
}

function DataSnapshots({ watchlist, report }: { watchlist: WatchItem[]; report: Report | null }) {
  const confirmed = report?.structure.filter((item) => item.state === "confirmed").length ?? 0;
  const provisional = report?.structure.filter((item) => item.state === "provisional").length ?? 0;
  return <section className="view-section" aria-label="数据快照详情">
    <div className="snapshot-grid">
      <article className="snapshot-card"><span>WATCHLIST</span><strong>{watchlist.length.toString().padStart(2, "0")}</strong><small>当前监控标的</small></article>
      <article className="snapshot-card"><span>CONFIRMED</span><strong>{confirmed.toString().padStart(2, "0")}</strong><small>已确认结构事实</small></article>
      <article className="snapshot-card"><span>PROVISIONAL</span><strong>{provisional.toString().padStart(2, "0")}</strong><small>形成中结构事实</small></article>
      <article className="snapshot-card"><span>AS OF</span><strong className="snapshot-date">{report?.asOf ?? "—"}</strong><small>{report?.quality === "ok" ? "数据完整" : "部分降级"}</small></article>
    </div>
    <div className="snapshot-details">
      <div className="section-heading"><div><span className="section-index">01</span><h2>证据来源</h2></div><span className="data-line"><span className="status-dot completed" />IMMUTABLE INPUTS</span></div>
      <div className="source-list">{report?.sources.map((source, index) => <div className="source-row" key={source}><span>{String(index + 1).padStart(2, "0")}</span><strong>{source}</strong></div>) ?? <div className="empty-state">尚无已固化数据快照</div>}</div>
      {report && <p className="snapshot-note">{report.qualityNote}</p>}
    </div>
  </section>;
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
    <div className="report-header"><div><div className="report-symbol"><span className="market-chip">{market}</span>{report.symbol} <span>{report.name}</span></div><h3>{report.headline}</h3></div><div className="report-header-actions">{onTimeframeChange && <div className="timeframe-switch" aria-label="图表周期"><button type="button" aria-pressed={report.timeframe === "1d"} onClick={() => onTimeframeChange("1d")}>日线</button><button type="button" aria-label={loadingTimeframe === "1w" ? "周线加载中" : "周线"} aria-pressed={report.timeframe === "1w"} disabled={loadingTimeframe === "1w"} onClick={() => onTimeframeChange("1w")}>{loadingTimeframe === "1w" ? "加载中…" : "周线"}</button></div>}<div className="report-meta"><span>AS OF</span><strong>{report.asOf}</strong><span className={`quality-tag ${report.quality}`}>{report.quality === "ok" ? "数据完整" : "部分降级"}</span></div></div></div>
    <div className="report-body"><div className="chart-pane">{chartNotice && <div className="chart-notice" role="status">{chartNotice}</div>}<ChanChart symbol={report.symbol} data={report.chart} /></div></div>
    <div className="report-footer"><div className="sources"><span>来源</span>{report.sources.map((source) => <span className="source-chip" key={source}>{source}</span>)}</div><div className="review-state">审阅状态：<strong>{report.review}</strong></div><div className="quality-note">{report.qualityNote}</div></div>
  </article>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "请求失败，请检查本机服务是否已启动。";
}

function stateLabel(state: RunProgress["state"]): string {
  return { queued: "排队", running: "进行中", completed: "完成", degraded: "降级", failed: "失败" }[state];
}

function viewEyebrow(view: WorkbenchView): string {
  return {
    batch: "A-SHARE STRUCTURAL RESEARCH · 2026.08.11",
    records: "RESEARCH ARCHIVE · DETERMINISTIC RUNS",
    snapshots: "EVIDENCE SNAPSHOTS · TRACEABLE INPUTS",
    journal: "TRADING JOURNAL · DAILY CLOSE",
    reviews: "TRADING REVIEW · DETERMINISTIC SNAPSHOTS",
  }[view];
}
