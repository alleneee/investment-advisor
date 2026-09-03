import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ClipboardCheck, History, List, PlusSquare, Save, Wallet, X, type LucideIcon } from "lucide-react";
import { BsAnalysisPanel } from "./BsAnalysisPanel";
import { JournalMonthPicker } from "./JournalMonthPicker";
import { JournalReturnChart } from "./JournalReturnChart";
import { ReviewCenterPage } from "./ReviewCenterPage";
import { buyReasons, reasonLabels, sellReasons } from "./trading-api";
import type { TradingApi } from "./trading-api";
import { normalizeTradingSymbol } from "./trading-symbol";
import { EmptyState } from "./ui/EmptyState";
import { formatMoney, formatRate, formatSignedMoney } from "./ui/formatDisplay";
import { Icon } from "./ui/Icon";
import { Panel } from "./ui/Panel";
import type { StockSuggestion } from "./types";
import type {
  CashFlow,
  CashFlowKind,
  DailyReview,
  DailyReviewStatus,
  TradingAccount,
  TradingCalendarDay,
  TradingCalendarMonth,
  TradingExecution,
  TradingPeriodSummary,
  TradingReasonCode,
  TradingSide,
} from "./trading-types";

export type JournalView = "month" | "week" | "list" | "quarter" | "year";

const journalViews: Array<{ id: JournalView; label: string }> = [
  { id: "month", label: "月视图" },
  { id: "week", label: "周视图" },
  { id: "quarter", label: "季报" },
  { id: "year", label: "年报" },
];

interface TradeJournalPageProps {
  api: TradingApi;
  today?: string;
  initialView?: JournalView;
  searchStocks?: (query: string) => Promise<StockSuggestion[]>;
}

interface ExecutionForm {
  symbol: string;
  name: string;
  executedAt: string;
  side: TradingSide;
  price: string;
  quantity: string;
  fee: string;
  primaryReason: TradingReasonCode;
  tags: string;
  note: string;
}

interface CashFlowForm {
  occurredAt: string;
  kind: CashFlowKind;
  amount: string;
  note: string;
}

interface DailyReviewForm {
  invalidationCondition: string;
  nextDayPlan: string;
  emotion: DailyReview["emotion"];
  disciplineFollowed: "" | "true" | "false";
  note: string;
}

interface DailyReviewDraft {
  form: DailyReviewForm;
  review: DailyReview | null | undefined;
  dirty: boolean;
  saving: DailyReviewStatus | null;
  error: string | null;
}

interface PeriodSummaryResult {
  summary: TradingPeriodSummary;
  dayRevision: number;
}

interface PeriodSummaryFailure {
  message: string;
  start: string;
  end: string;
  dayRevision: number;
}

export function TradeJournalPage({ api, today = currentShanghaiDate(), initialView = "month", searchStocks }: TradeJournalPageProps) {
  const [account, setAccount] = useState<TradingAccount | null | undefined>(undefined);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const [name, setName] = useState("主账户");
  const [activatedOn, setActivatedOn] = useState(today);
  const [initialCapital, setInitialCapital] = useState("100000.00");
  const [tradeDate, setTradeDate] = useState(today);
  const [dayDetailOpen, setDayDetailOpen] = useState(false);
  const [journalView, setJournalView] = useState<JournalView>(initialView);
  const [entryTarget, setEntryTarget] = useState<"execution" | "review" | null>(null);
  const executionEntryRef = useRef<HTMLFormElement>(null);
  const dailyCloseRef = useRef<HTMLElement>(null);
  const dayDetailRef = useRef<HTMLElement>(null);
  const dayDetailTriggerRef = useRef<HTMLElement | null>(null);
  const calendarLayoutRef = useRef<HTMLDivElement>(null);
  const journalNavigationRef = useRef<HTMLElement>(null);
  const [openReviewKey, setOpenReviewKey] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<TradingCalendarMonth | undefined>(undefined);
  const [periodSummaryResult, setPeriodSummaryResult] = useState<PeriodSummaryResult | undefined>(undefined);
  const [periodSummaryFailure, setPeriodSummaryFailure] = useState<PeriodSummaryFailure | undefined>(undefined);
  const [periodSummaryEpoch, setPeriodSummaryEpoch] = useState(0);
  const [executions, setExecutions] = useState<TradingExecution[] | undefined>(undefined);
  const [cashFlows, setCashFlows] = useState<CashFlow[] | undefined>(undefined);
  const [dayError, setDayError] = useState<string | null>(null);
  const [dayLoadedDate, setDayLoadedDate] = useState<string | null>(null);
  const [dayRevision, setDayRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingExecution, setSavingExecution] = useState(false);
  const [savingCashFlow, setSavingCashFlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionForm, setExecutionForm] = useState<ExecutionForm>(() => defaultExecutionForm(today));
  const [symbolSuggestions, setSymbolSuggestions] = useState<StockSuggestion[]>([]);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [cashFlowForm, setCashFlowForm] = useState<CashFlowForm>(() => defaultCashFlowForm(today));
  const [cashFlowOpen, setCashFlowOpen] = useState(false);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, DailyReviewDraft>>({});
  const reviewSaveRequests = useRef(new Set<string>());
  const currentDraft = reviewDrafts[tradeDate];
  const dailyReviewForm = currentDraft?.form ?? defaultDailyReviewForm();
  const dailyReview = currentDraft?.review;
  const savingReview = currentDraft?.saving ?? null;

  useEffect(() => {
    let active = true;
    setAccountError(null);
    void api.getAccount().then((value) => {
      if (active) setAccount(value);
    }).catch((reason: unknown) => {
      if (active) setAccountError(messageOf(reason));
    });
    return () => { active = false; };
  }, [accountEpoch, api]);

  useEffect(() => {
    if (account === null || account === undefined) return;
    let active = true;
    setExecutions(undefined);
    setCashFlows(undefined);
    setDayError(null);
    setDayLoadedDate(null);
    void Promise.all([
      api.listExecutions(tradeDate),
      api.listCashFlows(tradeDate),
      api.getDailyReview(tradeDate),
    ]).then(([nextExecutions, nextCashFlows, nextReview]) => {
      if (!active) return;
      setExecutions(nextExecutions);
      setCashFlows(nextCashFlows);
      setDayLoadedDate(tradeDate);
      setReviewDrafts((current) => {
        const draft = current[tradeDate];
        if (draft?.dirty || draft?.saving) {
          return draft.review !== undefined ? current : { ...current, [tradeDate]: { ...draft, review: nextReview } };
        }
        if (draft?.review && draft.review.revision > (nextReview?.revision ?? 0)) return current;
        return { ...current, [tradeDate]: { form: nextReview ? formFromDailyReview(nextReview) : defaultDailyReviewForm(), review: nextReview, dirty: false, saving: null, error: null } };
      });
    }).catch((reason: unknown) => {
      if (active) setDayError(messageOf(reason));
    });
    return () => { active = false; };
  }, [account, api, dayRevision, tradeDate]);

  function updateDailyReviewForm(update: (current: DailyReviewForm) => DailyReviewForm) {
    setReviewDrafts((current) => {
      const draft = current[tradeDate];
      return {
        ...current,
        [tradeDate]: {
          form: update(draft?.form ?? defaultDailyReviewForm()),
          review: draft?.review,
          dirty: true,
          saving: draft?.saving ?? null,
          error: null,
        },
      };
    });
  }

  useEffect(() => {
    setExecutionForm((current) => ({ ...current, executedAt: `${tradeDate}T15:00` }));
    setCashFlowForm((current) => ({ ...current, occurredAt: `${tradeDate}T15:00` }));
  }, [tradeDate]);

  const calendarMonth = tradeDate.slice(0, 7);
  const reviewKind = journalView === "list" ? null : journalView;
  const reviewBounds = reviewKind ? reviewPeriodBounds(reviewKind, tradeDate) : null;
  const periodStart = reviewBounds?.start;
  const periodEnd = reviewBounds?.end;

  useEffect(() => {
    if (account === null || account === undefined) return;
    let active = true;
    void api.getCalendar(calendarMonth).then((value) => {
      if (active) setCalendar(value);
    }).catch((reason: unknown) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [account, api, calendarMonth, dayRevision]);

  useEffect(() => {
    if (account === null || account === undefined) return;
    if (periodStart === undefined || periodEnd === undefined) return;
    let active = true;
    const requestRevision = dayRevision;
    const start = periodStart;
    const end = periodEnd;
    setPeriodSummaryResult(undefined);
    setPeriodSummaryFailure(undefined);
    void (async () => {
      const load = () => api.getPeriodSummary(start, end);
      try {
        let value;
        try {
          value = await load();
        } catch {
          value = await load();
        }
        if (!active) return;
        setPeriodSummaryResult({ summary: value, dayRevision: requestRevision });
      } catch (reason) {
        if (!active) return;
        const message = messageOf(reason);
        setPeriodSummaryFailure({ message, start, end, dayRevision: requestRevision });
        setError(message);
      }
    })();
    return () => { active = false; };
  }, [account, api, dayRevision, periodEnd, periodStart, periodSummaryEpoch]);

  async function createAccount() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createAccount({ name, activatedOn, initialCapital });
      setAccount(created);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  function selectJournalView(view: JournalView) {
    if (view === journalView) return;
    setPeriodSummaryResult(undefined);
    setPeriodSummaryFailure(undefined);
    setDayDetailOpen(false);
    setJournalView(view);
  }

  function selectCalendarDay(date: string) {
    dayDetailTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTradeDate(date);
    setDayDetailOpen(true);
  }

  function openJournalEntry(target: "execution" | "review") {
    selectJournalView("list");
    setEntryTarget(target);
  }

  function jumpToMonth(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const day = Math.min(Number(tradeDate.slice(8)), daysInMonth(month));
    setDayDetailOpen(false);
    setTradeDate(`${month}-${String(day).padStart(2, "0")}`);
  }

  function shiftCalendar(direction: -1 | 1) {
    setDayDetailOpen(false);
    setTradeDate(moveCalendar(tradeDate, journalView, direction));
  }

  useEffect(() => {
    if (!dayDetailOpen) return;
    const dialog = dayDetailRef.current;
    if (!dialog) return;
    const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const first = dialog.querySelector<HTMLElement>(focusableSelector);
    (first ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDayDetailOpen(false);
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      const first = focusable[0] ?? dialog;
      const last = focusable.at(-1) ?? dialog;
      if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const trigger = dayDetailTriggerRef.current;
      const returnTarget = trigger?.isConnected ? trigger
        : calendarLayoutRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${tradeDate}"]`)
          ?? journalNavigationRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      returnTarget?.focus();
    };
  }, [dayDetailOpen]);

  useEffect(() => {
    if (journalView !== "list" || entryTarget === null) return;
    const target = entryTarget === "execution" ? executionEntryRef.current : dailyCloseRef.current;
    if (!target) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
    setEntryTarget(null);
  }, [entryTarget, journalView]);

  useEffect(() => {
    if (!searchStocks) return;
    const query = symbolQuery.trim();
    if (!query) {
      setSymbolSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchStocks(query).then((rows) => {
        if (cancelled) return;
        setSymbolSuggestions(rows);
        if (rows.length === 1) {
          const [only] = rows;
          setExecutionForm((current) => (
            normalizeTradingSymbol(current.symbol) === only.symbol && !current.name
              ? { ...current, name: only.name }
              : current
          ));
        }
      }).catch(() => {
        if (!cancelled) setSymbolSuggestions([]);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [symbolQuery, searchStocks]);

  function chooseSymbolSuggestion(item: StockSuggestion) {
    setExecutionForm((current) => ({ ...current, symbol: item.symbol, name: item.name }));
    setSymbolQuery("");
    setSymbolSuggestions([]);
    setSymbolPickerOpen(false);
  }

  async function saveExecution(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingExecution) return;
    const quantity = Number(executionForm.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setError("成交股数必须是正整数。");
      return;
    }
    setSavingExecution(true);
    setError(null);
    try {
      const saved = await api.createExecution({
        symbol: normalizeTradingSymbol(executionForm.symbol),
        name: executionForm.name.trim(),
        executedAt: shanghaiDateTime(executionForm.executedAt),
        side: executionForm.side,
        price: executionForm.price.trim(),
        quantity,
        fee: executionForm.fee.trim(),
        primaryReason: executionForm.primaryReason,
        tags: splitTags(executionForm.tags),
        note: executionForm.note.trim(),
        clientIdempotencyKey: idempotencyKey(),
      });
      setExecutions((items) => replaceExecution(items, saved));
      setExecutionForm((current) => ({ ...defaultExecutionForm(tradeDate, current.side), symbol: "", name: "", tags: "", note: "" }));
      setSymbolQuery("");
      setSymbolSuggestions([]);
      setSymbolPickerOpen(false);
      setDayRevision((value) => value + 1);
      const refreshedAccount = await api.getAccount();
      if (refreshedAccount) setAccount(refreshedAccount);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSavingExecution(false);
    }
  }

  async function saveCashFlow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingCashFlow) return;
    setSavingCashFlow(true);
    setError(null);
    try {
      const saved = await api.createCashFlow({
        occurredAt: shanghaiDateTime(cashFlowForm.occurredAt),
        kind: cashFlowForm.kind,
        amount: cashFlowForm.amount.trim(),
        note: cashFlowForm.note.trim(),
        clientIdempotencyKey: idempotencyKey(),
      });
      setCashFlows((items) => replaceCashFlow(items, saved));
      setCashFlowForm(defaultCashFlowForm(tradeDate));
      setDayRevision((value) => value + 1);
      const refreshedAccount = await api.getAccount();
      if (refreshedAccount) setAccount(refreshedAccount);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSavingCashFlow(false);
    }
  }

  async function saveDailyReview(status: DailyReviewStatus) {
    if (reviewSaveRequests.current.has(tradeDate) || dayLoadedDate !== tradeDate || !currentDraft) return;
    if (status === "completed" && dailyReviewForm.disciplineFollowed === "") {
      setReviewDrafts((current) => ({ ...current, [tradeDate]: { ...current[tradeDate], error: "完成当日复盘前，请明确是否遵守计划。" } }));
      return;
    }
    const date = tradeDate;
    const submittedForm = dailyReviewForm;
    reviewSaveRequests.current.add(date);
    setReviewDrafts((current) => ({ ...current, [date]: { ...current[date], saving: status, error: null } }));
    try {
      const saved = await api.saveDailyReview(date, {
        status,
        invalidationCondition: dailyReviewForm.invalidationCondition.trim(),
        nextDayPlan: dailyReviewForm.nextDayPlan.trim(),
        emotion: dailyReviewForm.emotion,
        disciplineFollowed: dailyReviewForm.disciplineFollowed === "" ? null : dailyReviewForm.disciplineFollowed === "true",
        note: dailyReviewForm.note.trim(),
        revision: dailyReview?.revision ?? null,
      });
      setReviewDrafts((current) => {
        const draft = current[date];
        const edited = draft.form !== submittedForm;
        return { ...current, [date]: { ...draft, review: saved, form: edited ? draft.form : formFromDailyReview(saved), dirty: edited, saving: null, error: null } };
      });
    } catch (reason) {
      setReviewDrafts((current) => ({ ...current, [date]: { ...current[date], saving: null, error: messageOf(reason) } }));
    } finally {
      reviewSaveRequests.current.delete(date);
    }
  }

  async function deleteExecution(execution: TradingExecution) {
    if (!window.confirm(`确认删除 ${execution.symbol} 的这笔成交？`)) return;
    setError(null);
    try {
      await api.deleteExecution(execution.executionId, execution.revision);
      setExecutions((items) => items?.filter((item) => item.executionId !== execution.executionId) ?? []);
      setDayRevision((value) => value + 1);
      const refreshedAccount = await api.getAccount();
      if (refreshedAccount) setAccount(refreshedAccount);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function deleteCashFlow(cashFlow: CashFlow) {
    if (!window.confirm("确认删除这笔资金流水？")) return;
    setError(null);
    try {
      await api.deleteCashFlow(cashFlow.cashFlowId, cashFlow.revision);
      setCashFlows((items) => items?.filter((item) => item.cashFlowId !== cashFlow.cashFlowId) ?? []);
      setDayRevision((value) => value + 1);
      const refreshedAccount = await api.getAccount();
      if (refreshedAccount) setAccount(refreshedAccount);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  if (account === undefined) return accountError
    ? <Panel title="交易账户暂不可用"><p className="journal-error" role="alert">{accountError}</p><button className="secondary-button" type="button" onClick={() => setAccountEpoch((value) => value + 1)}>重新加载账户</button></Panel>
    : <section className="journal-loading" role="status">正在读取交易账户…</section>;

  if (account === null) {
    return <Panel title="创建交易账户" className="journal-onboarding" aria-label="创建交易账户">
      <EmptyState title="建立一个本地人民币现金账户，再开始记录真实成交和收盘复盘。" />
      <div className="journal-form-grid">
        <label>账户名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>启用日期<input type="date" value={activatedOn} onChange={(event) => setActivatedOn(event.target.value)} /></label>
        <label>初始资金<input inputMode="decimal" value={initialCapital} onChange={(event) => setInitialCapital(event.target.value)} /></label>
      </div>
      {error && <p className="journal-error" role="alert">{error}</p>}
      <button className="primary-button" type="button" onClick={() => void createAccount()} disabled={busy}>{busy ? "正在创建…" : "创建并进入日记"}</button>
    </Panel>;
  }

  const reasons = executionForm.side === "buy" ? buyReasons : sellReasons;
  const pnl = account.dailyPnl;
  const reviewDone = dailyReview?.status === "completed";
  const selectedDay = calendar?.month === calendarMonth ? calendar.days.find((item) => item.date === tradeDate) : undefined;
  const monthPnl = calendar?.month === calendarMonth ? calendar.netPnl : null;
  const monthDrawdown = calendar?.month === calendarMonth ? calendar.maxDrawdown : null;
  const showCalendar = journalView === "month" || journalView === "week";
  const showReview = journalView !== "list";
  const currentPeriodSummary = periodSummaryResult && reviewBounds
    && periodSummaryResult.dayRevision === dayRevision
    && periodSummaryResult.summary.start === reviewBounds.start
    && periodSummaryResult.summary.end === reviewBounds.end
    ? periodSummaryResult.summary
    : undefined;
  const currentPeriodSummaryError = periodSummaryFailure && reviewBounds
    && periodSummaryFailure.dayRevision === dayRevision
    && periodSummaryFailure.start === reviewBounds.start
    && periodSummaryFailure.end === reviewBounds.end
    ? periodSummaryFailure.message
    : null;
  const drawdownLabel = drawdownLabelFor(journalView);
  const drawdown = journalView === "list"
    ? account.sinceInceptionDrawdown
    : journalView === "month"
      ? monthDrawdown
      : currentPeriodSummary
        ? currentPeriodSummary.maxDrawdown
        : null;
  const reviewKey = reviewKind && reviewBounds ? `${reviewKind}:${reviewBounds.start}:${reviewBounds.end}` : null;
  const periodReviewOpen = reviewKey != null && openReviewKey === reviewKey;
  const dayErrorNotice = dayError && <div><p className="journal-error" role="alert">当日数据加载失败：{dayError}</p><button className="secondary-button" type="button" onClick={() => setDayRevision((value) => value + 1)}>重新加载当日数据</button></div>;

  return <section className="trade-journal-page" aria-label="交易日记">
    <div className="journal-page-heading">
      <div>
        <p className="journal-kicker">{journalView === "list" ? "记账与日复盘" : showCalendar ? "交易日历" : "周期报告"}</p>
        <div className="journal-title-row">
          {showCalendar ? <JournalMonthPicker value={calendarMonth} label={journalHeading(journalView, tradeDate)} onChange={jumpToMonth} /> : <h2>{journalHeading(journalView, tradeDate)}</h2>}
          {showCalendar && <div className="journal-title-navigation" role="group" aria-label="日历翻页">
            <button className="journal-calendar-chevron" type="button" aria-label={calendarNavLabel(journalView, -1)} onClick={() => shiftCalendar(-1)}><Icon icon={ChevronLeft} size={18} /></button>
            <button className="journal-calendar-chevron" type="button" aria-label={calendarNavLabel(journalView, 1)} onClick={() => shiftCalendar(1)}><Icon icon={ChevronRight} size={18} /></button>
            <button className="journal-today" type="button" onClick={() => { setDayDetailOpen(false); setTradeDate(today); }}>今天</button>
          </div>}
        </div>
        <p className="journal-lede">{journalView === "list" ? "记录成交与资金流水，完成当日复盘。" : showCalendar ? "按日查看成交笔数、当日盈亏和复盘状态。" : "汇总周期表现，回看交易与计划执行。"}</p>
      </div>
      <div className="journal-heading-actions">
      {journalView === "list" ? <label className="journal-date">交易日期<input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} /></label> : showCalendar ? <div className="journal-calendar-net">
        <span>月度净盈亏</span>
        <strong className={pnlToneClass(monthPnl)}>{monthPnl == null ? "—" : formatSignedMoney(monthPnl)}</strong>
      </div> : <div className="journal-calendar-nav">
        <button className="journal-calendar-chevron" type="button" aria-label={calendarNavLabel(journalView, -1)} onClick={() => shiftCalendar(-1)}>
          <Icon icon={ChevronLeft} size={18} />
        </button>
        <div className="journal-calendar-net">
          <span>复盘区间</span>
          <strong>{reviewBounds ? `${reviewBounds.start} – ${reviewBounds.end}` : "—"}</strong>
        </div>
        <button className="journal-calendar-chevron" type="button" aria-label={calendarNavLabel(journalView, 1)} onClick={() => shiftCalendar(1)}>
          <Icon icon={ChevronRight} size={18} />
        </button>
      </div>}
      <div className="journal-quick-actions">
        <button className="primary-button" type="button" onClick={() => openJournalEntry("execution")}>记一笔</button>
        <button className="secondary-button" type="button" onClick={() => openJournalEntry("review")}>写复盘</button>
      </div>
      </div>
    </div>
    <nav ref={journalNavigationRef} className="journal-primary-nav" aria-label="交易日记导航">
      <button type="button" aria-pressed={showCalendar} onClick={() => selectJournalView(showCalendar ? journalView : "month")}>交易日历</button>
      <button type="button" aria-pressed={journalView === "list"} onClick={() => selectJournalView("list")}>记账与日复盘</button>
      <button type="button" aria-pressed={!showCalendar && journalView !== "list"} onClick={() => selectJournalView(journalView === "year" ? "year" : "quarter")}>周期报告</button>
    </nav>
    {journalView !== "list" && <div className="journal-toolbar">
      <div className="journal-view-switch journal-secondary-switch" role="group" aria-label={showCalendar ? "日历显示方式" : "报告周期"}>
        {journalViews.filter((view) => showCalendar ? view.id === "month" || view.id === "week" : view.id === "quarter" || view.id === "year").map((view) => (
          <button key={view.id} type="button" aria-pressed={journalView === view.id} onClick={() => selectJournalView(view.id)}>
            {view.label}
          </button>
        ))}
      </div>
      {showCalendar && <div className="journal-calendar-legend" aria-hidden="true">
        <span className="is-gain">盈利</span>
        <span className="is-loss">亏损</span>
        <span>无成交</span>
      </div>}
    </div>}
    {error && <p className="journal-error" role="alert">{error}</p>}
    {!dayDetailOpen && dayErrorNotice}
    <div className="journal-metrics" role="group" aria-label="账户概览">
      <article><span>总权益 (CNY)</span><strong>{displayMoney(account.totalEquity)}</strong></article>
      <article><span>可用现金</span><strong>{displayMoney(account.cash)}</strong></article>
      <article><span>持仓市值</span><strong>{displayMoney(account.positionMarketValue)}</strong></article>
      <article>
        <span>当日盈亏</span>
        <div className="journal-metric-row">
          <strong className={pnlToneClass(pnl)}>{pnl == null ? "—" : formatSignedMoney(pnl)}</strong>
          <small>{pnlPercent(pnl, account.totalEquity)}</small>
        </div>
      </article>
      <article>
        <span>{drawdownLabel}</span>
        <strong className="tone-drawdown">{drawdown == null ? "—" : formatRate(drawdown)}</strong>
      </article>
    </div>
    {showCalendar && <div ref={calendarLayoutRef} className="journal-calendar-layout">
      {calendar === undefined || calendar.month !== calendarMonth ? <p className="journal-muted">正在读取交易日历…</p> : <CalendarGrid
        month={calendar.month}
        days={calendar.days}
        selectedDate={tradeDate}
        highlightDate={dayDetailOpen ? tradeDate : null}
        view={journalView === "week" ? "week" : "month"}
        onSelect={selectCalendarDay}
      />}
      {dayDetailOpen && <div className="journal-day-detail-backdrop" onClick={() => setDayDetailOpen(false)}>
        <aside
          ref={dayDetailRef}
          tabIndex={-1}
          className="journal-calendar-sidebar"
          role="dialog"
          aria-modal="true"
          aria-label="当日明细"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="journal-calendar-sidebar-head">
            <h3>{longDateTitle(tradeDate)}</h3>
            <div className="journal-day-detail-head-actions">
              <span className={`journal-status${reviewDone ? " done" : ""}`}>{reviewStatusLabel(selectedDay?.reviewStatus ?? dailyReview?.status ?? null)}</span>
              <button className="journal-day-detail-close" type="button" aria-label="关闭当日明细" onClick={() => setDayDetailOpen(false)}>
                <Icon icon={X} size={16} />
              </button>
            </div>
          </div>
          {dayErrorNotice}
          <div className="journal-calendar-sidebar-pnl">
            <strong className={pnlToneClass(selectedDay?.dailyPnl ?? null)}>{selectedDay?.dailyPnl == null ? "—" : formatSignedMoney(selectedDay.dailyPnl)}</strong>
            <span>当日盈亏</span>
          </div>
          <div className="journal-calendar-stats">
            <div><span>成交笔数</span><strong>{selectedDay?.executionCount ?? executions?.length ?? 0}</strong></div>
            <div><span>资金流水</span><strong>{cashFlows?.length ?? "—"}</strong></div>
          </div>
          <section className="journal-calendar-notes">
            <h4>当日成交</h4>
            {executions === undefined ? <p className="journal-muted">{dayError ? "成交暂不可用。" : "正在读取成交…"}</p> : executions.length === 0 ? <p className="journal-muted">当日没有成交。</p> : <ul className="journal-list compact-list">
              {executions.map((execution) => <li key={execution.executionId}>
                <div>
                  <strong>{execution.side === "buy" ? "买入" : "卖出"} <span>{execution.symbol}</span></strong>
                  <span>{execution.name || "未填写名称"} · {formatMoney(execution.price)} × {execution.quantity}</span>
                </div>
              </li>)}
            </ul>}
          </section>
          <section className="journal-calendar-notes">
            <h4>复盘摘记</h4>
            {dayLoadedDate !== tradeDate ? <p className="journal-muted">{dayError ? "复盘暂不可用。" : "正在读取复盘…"}</p> : dailyReview == null ? <p className="journal-muted">当日尚未写复盘。</p> : <>
              {dailyReview.note && <p>{dailyReview.note}</p>}
              {dailyReview.nextDayPlan && <p>次日计划：{dailyReview.nextDayPlan}</p>}
              {dailyReview.invalidationCondition && <p>失效条件：{dailyReview.invalidationCondition}</p>}
              {!dailyReview.note && !dailyReview.nextDayPlan && !dailyReview.invalidationCondition && <p className="journal-muted">复盘已保存，暂无文字摘记。</p>}
            </>}
          </section>
          <div className="journal-detail-actions">
            <button className="primary-button" type="button" onClick={() => openJournalEntry("execution")}>记一笔</button>
            <button className="secondary-button" type="button" onClick={() => openJournalEntry("review")}>写复盘</button>
          </div>
        </aside>
      </div>}
    </div>}
    {journalView === "list" && <>
    <div className="journal-workspace">
      <section className="journal-card journal-ledger" aria-label="今日交易">
        <CardTitle icon={List}>今日交易</CardTitle>
        {executions === undefined ? <p className="journal-muted">{dayError ? "成交暂不可用。" : "正在读取成交…"}</p> : executions.length === 0 ? <div className="journal-empty">
          <Icon icon={History} size={40} />
          <p>今日没有交易记录。</p>
        </div> : <ul className="journal-list">
          {executions.map((execution) => <li key={execution.executionId}>
            <div>
              <strong>{execution.side === "buy" ? "买入" : "卖出"} <span>{execution.symbol}</span></strong>
              <span>{execution.name || "未填写名称"} · {formatMoney(execution.price)} × {execution.quantity}</span>
              <small>{reasonLabels[execution.primaryReason]}{execution.tags.length ? ` · ${execution.tags.join(" / ")}` : ""}</small>
            </div>
            <button className="secondary-button" type="button" onClick={() => void deleteExecution(execution)}>删除</button>
          </li>)}
        </ul>}
      </section>
      <form ref={executionEntryRef} tabIndex={-1} aria-label="成交录入" className="journal-card execution-entry" onSubmit={(event) => void saveExecution(event)}>
        <CardTitle icon={PlusSquare}>成交录入</CardTitle>
        <div className="journal-form-grid">
          <Field label="代码">
            <div className="journal-symbol-field">
              <input
                required
                value={executionForm.symbol}
                onChange={(event) => {
                  const value = event.target.value;
                  setExecutionForm((current) => ({ ...current, symbol: value }));
                  setSymbolQuery(value);
                  setSymbolPickerOpen(true);
                }}
                onFocus={() => setSymbolPickerOpen(true)}
                onBlur={() => window.setTimeout(() => setSymbolPickerOpen(false), 150)}
                placeholder="输入代码或名称，如 002309 / 中利集团"
                autoComplete="off"
                role="combobox"
                aria-expanded={symbolPickerOpen && symbolSuggestions.length > 0}
                aria-controls="journal-symbol-suggestions"
              />
              {searchStocks && symbolPickerOpen && symbolSuggestions.length > 0 && (
                <ul className="journal-symbol-suggestions" id="journal-symbol-suggestions" role="listbox" aria-label="股票候选">
                  {symbolSuggestions.map((item) => (
                    <li key={item.symbol}>
                      <button type="button" role="option" aria-selected={executionForm.symbol.toUpperCase() === item.symbol} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSymbolSuggestion(item)}>
                        <span className="journal-symbol-suggestion-name">{item.name}</span>
                        <span className="journal-symbol-suggestion-code">{item.symbol}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>
          <Field label="资产名称"><input value={executionForm.name} onChange={(event) => setExecutionForm((current) => ({ ...current, name: event.target.value }))} placeholder="选择候选后自动填写，也可手填" /></Field>
          <Field label="成交时间"><input required type="datetime-local" value={executionForm.executedAt} onChange={(event) => setExecutionForm((current) => ({ ...current, executedAt: event.target.value }))} /></Field>
          <Field label="方向"><select aria-label="方向" value={executionForm.side} onChange={(event) => {
            const side = event.target.value as TradingSide;
            setExecutionForm((current) => ({ ...current, side, primaryReason: side === "buy" ? buyReasons[1] : sellReasons[0] }));
          }}><option value="buy">买入 (做多)</option><option value="sell">卖出</option></select></Field>
          <Field label="成交价"><input required inputMode="decimal" value={executionForm.price} onChange={(event) => setExecutionForm((current) => ({ ...current, price: event.target.value }))} placeholder="0.00" /></Field>
          <Field label="份额/数量"><input required inputMode="numeric" value={executionForm.quantity} onChange={(event) => setExecutionForm((current) => ({ ...current, quantity: event.target.value }))} /></Field>
          <Field label="费用/佣金"><input required inputMode="decimal" value={executionForm.fee} onChange={(event) => setExecutionForm((current) => ({ ...current, fee: event.target.value }))} /></Field>
          <Field label="主要理由"><select value={executionForm.primaryReason} onChange={(event) => setExecutionForm((current) => ({ ...current, primaryReason: event.target.value as TradingReasonCode }))}>{reasons.map((reason) => <option key={reason} value={reason}>{reasonLabels[reason]}</option>)}</select></Field>
          <Field label="附加标签 (以逗号分隔)" className="journal-span-two"><input value={executionForm.tags} onChange={(event) => setExecutionForm((current) => ({ ...current, tags: event.target.value }))} placeholder="日内, 波段, 剥头皮..." /></Field>
          <Field label="成交备注" className="journal-span-two"><textarea value={executionForm.note} onChange={(event) => setExecutionForm((current) => ({ ...current, note: event.target.value }))} placeholder="输入有关成交设置的详情..." rows={3} /></Field>
        </div>
        <div className="journal-entry-actions">
          <button className="primary-button journal-save" type="submit" disabled={savingExecution}><Icon icon={Save} size={16} />{savingExecution ? "正在保存…" : "保存交易记录"}</button>
          {!cashFlowOpen && !(cashFlows !== undefined && cashFlows.length > 0) && <button className="secondary-button journal-ghost" type="button" onClick={() => setCashFlowOpen(true)}>＋ 记一笔资金流水</button>}
        </div>
      </form>
      {(cashFlowOpen || (cashFlows !== undefined && cashFlows.length > 0)) && <form className="journal-card cash-flow-entry" onSubmit={(event) => void saveCashFlow(event)}>
        <div className="journal-card-heading">
          <CardTitle icon={Wallet}>资金流水</CardTitle>
          {cashFlowOpen
            ? <button className="secondary-button journal-ghost" type="button" onClick={() => setCashFlowOpen(false)}>收起</button>
            : <button className="secondary-button journal-ghost" type="button" onClick={() => setCashFlowOpen(true)}>记一笔转入/转出</button>}
        </div>
        {cashFlows !== undefined && cashFlows.length > 0 && <ul className="journal-list compact-list">{cashFlows.map((cashFlow) => <li key={cashFlow.cashFlowId}><div><strong>{cashFlow.kind === "deposit" ? "入金" : "出金"} {formatMoney(cashFlow.amount)}</strong><span>{cashFlow.note || "无备注"}</span></div><button className="secondary-button" type="button" onClick={() => void deleteCashFlow(cashFlow)}>删除</button></li>)}</ul>}
        {cashFlowOpen && <>
          <div className="journal-stack">
            <Field label="交易时间"><input required type="datetime-local" value={cashFlowForm.occurredAt} onChange={(event) => setCashFlowForm((current) => ({ ...current, occurredAt: event.target.value }))} /></Field>
            <Field label="资金类型"><select value={cashFlowForm.kind} onChange={(event) => setCashFlowForm((current) => ({ ...current, kind: event.target.value as CashFlowKind }))}><option value="deposit">入金</option><option value="withdrawal">出金</option></select></Field>
            <Field label="金额 (CNY)"><input required inputMode="decimal" value={cashFlowForm.amount} onChange={(event) => setCashFlowForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" /></Field>
            <Field label="流水备注"><textarea value={cashFlowForm.note} onChange={(event) => setCashFlowForm((current) => ({ ...current, note: event.target.value }))} rows={4} /></Field>
          </div>
          <button className="secondary-button journal-ghost" type="submit" disabled={savingCashFlow}>{savingCashFlow ? "正在保存…" : "记录资金流水"}</button>
        </>}
      </form>}
    </div>
    <section ref={dailyCloseRef} tabIndex={-1} className="journal-card daily-close" aria-label="收盘检查">
      <div className="journal-card-heading">
        <CardTitle icon={ClipboardCheck}>收盘检查</CardTitle>
        <span className={`journal-status${reviewDone ? " done" : ""}`}>{reviewDone ? "已完成" : "未完成"}</span>
      </div>
      <p className="journal-muted" role="status" aria-label="复盘保存状态">{savingReview !== null ? "正在保存…" : currentDraft?.dirty ? "有未保存修改" : dayLoadedDate !== tradeDate ? dayError ? "复盘加载失败" : "正在读取复盘…" : dailyReview ? "已保存" : "尚未保存"}</p>
      {currentDraft?.error && <p className="journal-error" role="alert">{currentDraft.error}</p>}
      <div className="journal-close-grid">
        <Field label="失败条件/市场失效"><textarea disabled={dailyReview === undefined} value={dailyReviewForm.invalidationCondition} onChange={(event) => updateDailyReviewForm((current) => ({ ...current, invalidationCondition: event.target.value }))} placeholder="在什么情况下今天的逻辑设置失效了？" /></Field>
        <Field label="明日计划"><textarea disabled={dailyReview === undefined} value={dailyReviewForm.nextDayPlan} onChange={(event) => updateDailyReviewForm((current) => ({ ...current, nextDayPlan: event.target.value }))} placeholder="下个交易日您将重点关注哪些特定资产和策略？" /></Field>
        <div className="journal-close-selects">
          <Field label="情绪状态(交易中)"><select disabled={dailyReview === undefined} value={dailyReviewForm.emotion} onChange={(event) => updateDailyReviewForm((current) => ({ ...current, emotion: event.target.value as DailyReview["emotion"] }))}><option value="calm">冷静专注</option><option value="confident">自信</option><option value="anxious">焦虑/过度交易</option><option value="impulsive">冲动</option><option value="frustrated">沮丧/上头</option><option value="other">其他</option></select></Field>
          <Field label="计划执行"><select disabled={dailyReview === undefined} aria-label="是否遵守计划" value={dailyReviewForm.disciplineFollowed} onChange={(event) => updateDailyReviewForm((current) => ({ ...current, disciplineFollowed: event.target.value as DailyReviewForm["disciplineFollowed"] }))}><option value="">草稿中暂不判断</option><option value="true">严格执行计划</option><option value="false">未遵守计划</option></select></Field>
        </div>
        <Field label="常规日志备注"><textarea disabled={dailyReview === undefined} value={dailyReviewForm.note} onChange={(event) => updateDailyReviewForm((current) => ({ ...current, note: event.target.value }))} placeholder="任何其他想法、截图链接或宏观观察..." /></Field>
      </div>
      <div className="journal-actions">
        <button className="secondary-button" type="button" onClick={() => void saveDailyReview("draft")} disabled={savingReview !== null || dayLoadedDate !== tradeDate}>{savingReview === "draft" ? "正在保存…" : "保存草稿"}</button>
        <button className="primary-button" type="button" onClick={() => void saveDailyReview("completed")} disabled={savingReview !== null || dayLoadedDate !== tradeDate}>{savingReview === "completed" ? "正在完成…" : "完成收盘检查"}</button>
      </div>
    </section>
    </>}
    {showReview && reviewKind && (currentPeriodSummaryError
      ? <section className="journal-return-card">
        <header><h3>{periodReturnTitle(journalView)}</h3></header>
        <p className="journal-muted">收益曲线暂不可用。</p>
        <button className="secondary-button" type="button" onClick={() => setPeriodSummaryEpoch((current) => current + 1)}>重新加载</button>
      </section>
      : <JournalReturnChart periodKind={reviewKind} summary={currentPeriodSummary} />)}
    {showReview && reviewKind && reviewBounds && <BsAnalysisPanel
      key={`bs-${reviewKey}`}
      api={api}
      periodStart={reviewBounds.start}
      periodEnd={reviewBounds.end}
    />}
    {showReview && !showCalendar && !periodReviewOpen && <EmptyState title="根据本周期成交记录生成复盘报告。" />}
    {showReview && !periodReviewOpen && reviewKey && <button className="primary-button" type="button" onClick={() => setOpenReviewKey(reviewKey)}>
      {reviewActionLabel(journalView)}
    </button>}
    {showReview && periodReviewOpen && reviewKind && reviewBounds && <ReviewCenterPage
      key={reviewKey}
      api={api}
      today={today}
      periodKind={reviewKind}
      periodStart={reviewBounds.start}
      periodEnd={reviewBounds.end}
      hidePeriodControls
      autoCreate
    />}
  </section>;
}

function CardTitle({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <h3 className="journal-card-title"><Icon icon={icon} size={20} />{children}</h3>;
}

const WEEKDAYS = ["一", "二", "三", "四", "五"];

interface CalendarCell {
  date: string;
  inMonth: boolean;
  open: boolean;
  executionCount: number;
  dailyPnl: string | null;
  reviewStatus: DailyReviewStatus | null;
}

function CalendarGrid({
  month,
  days,
  selectedDate,
  highlightDate,
  view,
  onSelect,
}: {
  month: string;
  days: TradingCalendarDay[];
  selectedDate: string;
  highlightDate: string | null;
  view: "month" | "week";
  onSelect: (date: string) => void;
}) {
  const cells = view === "week" ? weekCells(selectedDate, days, month) : monthCells(month, days);
  return <div className="journal-calendar" role="grid" aria-label={view === "week" ? "交易周历" : "交易月历"}>
    <div className="journal-calendar-weekdays">{WEEKDAYS.map((label) => <span key={label}>{label}</span>)}</div>
    <div className={`journal-calendar-grid${view === "week" ? " is-week" : ""}`}>
      {cells.map((cell) => {
        if (!cell.open) return <div key={cell.date} className="journal-calendar-day is-closed" aria-hidden="true" />;
        const tone = calendarTone(cell);
        const highlighted = cell.date === highlightDate;
        return <button
          key={cell.date}
          type="button"
          className={["journal-calendar-day", tone, cell.inMonth ? "" : "is-outside", highlighted ? "is-selected" : ""].filter(Boolean).join(" ")}
          aria-pressed={highlighted}
          aria-label={calendarDayLabel(cell)}
          data-date={cell.date}
          onClick={() => onSelect(cell.date)}
        >
          <span className="journal-calendar-day-number">{Number(cell.date.slice(8))}</span>
          {cell.dailyPnl != null && <span className={`journal-calendar-day-pnl ${pnlToneClass(cell.dailyPnl)}`.trim()}>{formatSignedMoney(cell.dailyPnl)}</span>}
          {cell.executionCount > 0 && <span className="journal-calendar-day-count">{cell.executionCount} 笔</span>}
        </button>;
      })}
    </div>
  </div>;
}

function monthCells(month: string, days: TradingCalendarDay[]): CalendarCell[] {
  const byDate = new Map(days.map((item) => [item.date, item]));
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const start = addDays(first, -mondayIndex(first));
  const end = addDays(addDays(last, -mondayIndex(last)), 4);
  const cells: CalendarCell[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    if (mondayIndex(cursor) >= 5) continue;
    cells.push(toCell(cursor, byDate, first, last));
  }
  return cells;
}

function weekCells(selectedDate: string, days: TradingCalendarDay[], month: string): CalendarCell[] {
  const byDate = new Map(days.map((item) => [item.date, item]));
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const start = addDays(selectedDate, -mondayIndex(selectedDate));
  return Array.from({ length: 5 }, (_, index) => toCell(addDays(start, index), byDate, first, last));
}

function toCell(date: string, byDate: Map<string, TradingCalendarDay>, first: string, last: string): CalendarCell {
  const item = byDate.get(date);
  return {
    date,
    inMonth: date >= first && date <= last,
    open: item?.isOpen ?? mondayIndex(date) < 5,
    executionCount: item?.executionCount ?? 0,
    dailyPnl: item?.dailyPnl ?? null,
    reviewStatus: item?.reviewStatus ?? null,
  };
}

function calendarDayLabel(cell: CalendarCell): string {
  const parts = [longDateTitle(cell.date)];
  parts.push(cell.executionCount > 0 ? `${cell.executionCount} 笔成交` : "无成交");
  if (cell.dailyPnl != null) parts.push(`盈亏 ${formatSignedMoney(cell.dailyPnl)}`);
  if (cell.reviewStatus === "draft") parts.push("复盘草稿");
  if (cell.reviewStatus === "completed") parts.push("已复盘");
  return parts.join("，");
}

function calendarTone(cell: CalendarCell): string {
  if (cell.dailyPnl != null && !/^-?0+(?:\.0+)?$/.test(cell.dailyPnl)) {
    return cell.dailyPnl.startsWith("-") ? "is-loss" : "is-gain";
  }
  return cell.executionCount > 0 ? "has-trades" : "";
}

function reviewStatusLabel(status: DailyReviewStatus | null): string {
  if (status === "completed") return "已复盘";
  if (status === "draft") return "草稿";
  return "未复盘";
}

function monthTitle(month: string): string {
  return `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
}

function longDateTitle(iso: string): string {
  return `${iso.slice(0, 4)}年${Number(iso.slice(5, 7))}月${Number(iso.slice(8))}日`;
}

function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
}

function mondayIndex(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function shiftMonth(iso: string, delta: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1 + delta, 1));
  const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  cursor.setUTCDate(Math.min(day, last));
  return cursor.toISOString().slice(0, 10);
}

function moveCalendar(iso: string, view: JournalView, direction: -1 | 1): string {
  if (view === "week") return addDays(iso, direction * 7);
  if (view === "quarter") return shiftMonth(iso, direction * 3);
  if (view === "year") return shiftMonth(iso, direction * 12);
  return shiftMonth(iso, direction);
}

function calendarNavLabel(view: JournalView, direction: -1 | 1): string {
  const previous = direction === -1;
  if (view === "week") return previous ? "上一周" : "下一周";
  if (view === "quarter") return previous ? "上一季度" : "下一季度";
  if (view === "year") return previous ? "上一年" : "下一年";
  return previous ? "上个月" : "下个月";
}

function journalHeading(view: JournalView, date: string): string {
  if (view === "list") return "每日交易日志";
  if (view === "year") return `${date.slice(0, 4)}年`;
  if (view === "quarter") {
    const quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3);
    return `${date.slice(0, 4)}年第${["一", "二", "三", "四"][quarter]}季度`;
  }
  return monthTitle(date.slice(0, 7));
}

function drawdownLabelFor(view: JournalView): string {
  if (view === "week") return "本周最大回撤";
  if (view === "month") return "本月最大回撤";
  if (view === "quarter") return "本季最大回撤";
  if (view === "year") return "本年最大回撤";
  return "最大回撤";
}

function periodReturnTitle(view: JournalView): string {
  if (view === "week") return "本周累计收益";
  if (view === "month") return "本月累计收益";
  if (view === "quarter") return "本季累计收益";
  if (view === "year") return "本年累计收益";
  return "累计收益";
}

function reviewActionLabel(view: JournalView): string {
  if (view === "week") return "生成本周复盘";
  if (view === "quarter") return "生成本季复盘";
  if (view === "year") return "生成本年复盘";
  return "生成本月复盘";
}

function reviewPeriodBounds(kind: Exclude<JournalView, "list">, day: string): { start: string; end: string } {
  if (kind === "week") {
    const start = addDays(day, -mondayIndex(day));
    return { start, end: addDays(start, 4) }; // 服务端按当周首尾交易日校验，无节假日即周一到周五
  }
  if (kind === "month") {
    const month = day.slice(0, 7);
    return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
  }
  if (kind === "quarter") {
    const quarter = Math.floor((Number(day.slice(5, 7)) - 1) / 3);
    const year = day.slice(0, 4);
    const startMonth = `${year}-${String(quarter * 3 + 1).padStart(2, "0")}`;
    const endMonth = `${year}-${String(quarter * 3 + 3).padStart(2, "0")}`;
    return { start: `${startMonth}-01`, end: `${endMonth}-${String(daysInMonth(endMonth)).padStart(2, "0")}` };
  }
  const year = day.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={["journal-field", className].filter(Boolean).join(" ")}><span>{label}</span>{children}</label>;
}

function defaultExecutionForm(date: string, side: TradingSide = "buy"): ExecutionForm {
  return { symbol: "", name: "", executedAt: `${date}T15:00`, side, price: "", quantity: "100", fee: "0", primaryReason: side === "buy" ? buyReasons[1] : sellReasons[0], tags: "", note: "" };
}

function defaultCashFlowForm(date: string): CashFlowForm {
  return { occurredAt: `${date}T15:00`, kind: "deposit", amount: "", note: "" };
}

function defaultDailyReviewForm(): DailyReviewForm {
  return { invalidationCondition: "", nextDayPlan: "", emotion: "calm", disciplineFollowed: "", note: "" };
}

function formFromDailyReview(review: DailyReview): DailyReviewForm {
  return { invalidationCondition: review.invalidationCondition, nextDayPlan: review.nextDayPlan, emotion: review.emotion, disciplineFollowed: review.disciplineFollowed === null ? "" : String(review.disciplineFollowed) as "true" | "false", note: review.note };
}

function replaceExecution(items: TradingExecution[] | undefined, saved: TradingExecution): TradingExecution[] {
  const withoutSaved = (items ?? []).filter((item) => item.executionId !== saved.executionId);
  return [...withoutSaved, saved].sort((left, right) => right.executedAt.localeCompare(left.executedAt));
}

function replaceCashFlow(items: CashFlow[] | undefined, saved: CashFlow): CashFlow[] {
  const withoutSaved = (items ?? []).filter((item) => item.cashFlowId !== saved.cashFlowId);
  return [...withoutSaved, saved].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function shanghaiDateTime(value: string): string {
  return `${value.length === 16 ? `${value}:00` : value}+08:00`;
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `journal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function displayMoney(value: string | null): string {
  return value == null ? "—" : formatMoney(value);
}

function pnlPercent(pnl: string | null, equity: string | null): string {
  if (pnl == null || equity == null) return "—";
  const profit = Number(pnl);
  const total = Number(equity);
  const base = total - profit;
  if (!Number.isFinite(profit) || !Number.isFinite(base) || base === 0) return "0.00%";
  return `${((profit / Math.abs(base)) * 100).toFixed(2)}%`;
}

function pnlToneClass(pnl: string | null): string {
  if (pnl == null || /^-?0+(?:\.0+)?$/.test(pnl)) return "";
  return pnl.startsWith("-") ? "tone-loss" : "tone-gain";
}

function currentShanghaiDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败，请检查本机服务。";
}
