import { useEffect, useState } from "react";
import { buyReasons, reasonLabels, sellReasons } from "./trading-api";
import type { TradingApi } from "./trading-api";
import { EmptyState } from "./ui/EmptyState";
import { formatMoney, formatRate, formatSignedMoney, signedTone } from "./ui/formatDisplay";
import { KpiStrip } from "./ui/KpiStrip";
import { MetricTile } from "./ui/MetricTile";
import { Panel } from "./ui/Panel";
import { SplitPane } from "./ui/SplitPane";
import type {
  CashFlow,
  CashFlowKind,
  DailyReview,
  DailyReviewStatus,
  TradingAccount,
  TradingExecution,
  TradingReasonCode,
  TradingSide,
} from "./trading-types";

interface TradeJournalPageProps {
  api: TradingApi;
  today?: string;
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

export function TradeJournalPage({ api, today = currentShanghaiDate() }: TradeJournalPageProps) {
  const [account, setAccount] = useState<TradingAccount | null | undefined>(undefined);
  const [name, setName] = useState("主账户");
  const [activatedOn, setActivatedOn] = useState(today);
  const [initialCapital, setInitialCapital] = useState("100000.00");
  const [tradeDate, setTradeDate] = useState(today);
  const [executions, setExecutions] = useState<TradingExecution[] | undefined>(undefined);
  const [cashFlows, setCashFlows] = useState<CashFlow[] | undefined>(undefined);
  const [dailyReview, setDailyReview] = useState<DailyReview | null | undefined>(undefined);
  const [dayRevision, setDayRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingExecution, setSavingExecution] = useState(false);
  const [savingCashFlow, setSavingCashFlow] = useState(false);
  const [savingReview, setSavingReview] = useState<DailyReviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executionForm, setExecutionForm] = useState<ExecutionForm>(() => defaultExecutionForm(today));
  const [cashFlowForm, setCashFlowForm] = useState<CashFlowForm>(() => defaultCashFlowForm(today));
  const [dailyReviewForm, setDailyReviewForm] = useState<DailyReviewForm>(defaultDailyReviewForm);

  useEffect(() => {
    let active = true;
    void api.getAccount().then((value) => {
      if (active) setAccount(value);
    }).catch((reason: unknown) => {
      if (active) {
        setError(messageOf(reason));
        setAccount(null);
      }
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (account === null || account === undefined) return;
    let active = true;
    setExecutions(undefined);
    setCashFlows(undefined);
    setDailyReview(undefined);
    void Promise.all([
      api.listExecutions(tradeDate),
      api.listCashFlows(tradeDate),
      api.getDailyReview(tradeDate),
    ]).then(([nextExecutions, nextCashFlows, nextReview]) => {
      if (!active) return;
      setExecutions(nextExecutions);
      setCashFlows(nextCashFlows);
      setDailyReview(nextReview);
      setDailyReviewForm(nextReview ? formFromDailyReview(nextReview) : defaultDailyReviewForm());
    }).catch((reason: unknown) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [account, api, dayRevision, tradeDate]);

  useEffect(() => {
    setExecutionForm((current) => ({ ...current, executedAt: `${tradeDate}T15:00` }));
    setCashFlowForm((current) => ({ ...current, occurredAt: `${tradeDate}T15:00` }));
  }, [tradeDate]);

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
        symbol: executionForm.symbol.trim().toUpperCase(),
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
    if (savingReview !== null) return;
    if (status === "completed" && dailyReviewForm.disciplineFollowed === "") {
      setError("完成当日复盘前，请明确是否遵守计划。");
      return;
    }
    setSavingReview(status);
    setError(null);
    try {
      const saved = await api.saveDailyReview(tradeDate, {
        status,
        invalidationCondition: dailyReviewForm.invalidationCondition.trim(),
        nextDayPlan: dailyReviewForm.nextDayPlan.trim(),
        emotion: dailyReviewForm.emotion,
        disciplineFollowed: dailyReviewForm.disciplineFollowed === "" ? null : dailyReviewForm.disciplineFollowed === "true",
        note: dailyReviewForm.note.trim(),
        revision: dailyReview?.revision ?? null,
      });
      setDailyReview(saved);
      setDailyReviewForm(formFromDailyReview(saved));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSavingReview(null);
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

  if (account === undefined) return <section className="journal-loading">正在读取交易账户…</section>;

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
  return <section className="trade-journal-page" aria-label="交易日记">
    <div className="journal-page-heading">
      <h2>每日交易日记</h2>
      <label className="journal-date">交易日期<input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} /></label>
    </div>
    {error && <p className="journal-error" role="alert">{error}</p>}
    <KpiStrip>
      <MetricTile label="总权益" value={displayMoney(account.totalEquity)} />
      <MetricTile label="可用现金" value={displayMoney(account.cash)} />
      <MetricTile label="持仓市值" value={displayMoney(account.positionMarketValue)} />
      <MetricTile label="当日盈亏" value={pnl == null ? "—" : formatSignedMoney(pnl)} tone={pnl == null ? "neutral" : signedTone(pnl)} />
      <MetricTile label="成立以来回撤" value={account.sinceInceptionDrawdown == null ? "—" : formatRate(account.sinceInceptionDrawdown)} tone="risk" />
    </KpiStrip>
    <SplitPane
      left={<Panel title="今日流水" heading="h3" aria-label="今日流水">
        {executions === undefined ? <p className="journal-muted">正在读取成交…</p> : executions.length === 0 ? <p className="journal-muted">今天还没有成交记录。</p> : <ul className="journal-list">
          {executions.map((execution) => <li key={execution.executionId}>
            <div><strong>{execution.side === "buy" ? "买入" : "卖出"} <span>{execution.symbol}</span></strong><span>{execution.name || "未填写名称"} · {formatMoney(execution.price)} × {execution.quantity}</span><small>{reasonLabels[execution.primaryReason]}{execution.tags.length ? ` · ${execution.tags.join(" / ")}` : ""}</small></div>
            <button className="secondary-button" type="button" onClick={() => void deleteExecution(execution)}>删除</button>
          </li>)}
        </ul>}
      </Panel>}
      right={<>
      <form className="ui-panel execution-entry" onSubmit={(event) => void saveExecution(event)}>
        <h3>成交录入</h3>
        <div className="journal-form-grid">
          <label>股票代码<input required value={executionForm.symbol} onChange={(event) => setExecutionForm((current) => ({ ...current, symbol: event.target.value }))} placeholder="002940.SZ" /></label>
          <label>股票名称<input value={executionForm.name} onChange={(event) => setExecutionForm((current) => ({ ...current, name: event.target.value }))} placeholder="昂利康" /></label>
          <label>成交时间<input required type="datetime-local" value={executionForm.executedAt} onChange={(event) => setExecutionForm((current) => ({ ...current, executedAt: event.target.value }))} /></label>
          <label>方向<select aria-label="方向" value={executionForm.side} onChange={(event) => {
            const side = event.target.value as TradingSide;
            setExecutionForm((current) => ({ ...current, side, primaryReason: side === "buy" ? buyReasons[1] : sellReasons[0] }));
          }}><option value="buy">买入</option><option value="sell">卖出</option></select></label>
          <label>成交价格<input required inputMode="decimal" value={executionForm.price} onChange={(event) => setExecutionForm((current) => ({ ...current, price: event.target.value }))} /></label>
          <label>成交股数<input required inputMode="numeric" value={executionForm.quantity} onChange={(event) => setExecutionForm((current) => ({ ...current, quantity: event.target.value }))} /></label>
          <label>手续费<input required inputMode="decimal" value={executionForm.fee} onChange={(event) => setExecutionForm((current) => ({ ...current, fee: event.target.value }))} /></label>
          <label>主要理由<select value={executionForm.primaryReason} onChange={(event) => setExecutionForm((current) => ({ ...current, primaryReason: event.target.value as TradingReasonCode }))}>{reasons.map((reason) => <option key={reason} value={reason}>{reasonLabels[reason]}</option>)}</select></label>
          <label>辅助标签<input value={executionForm.tags} onChange={(event) => setExecutionForm((current) => ({ ...current, tags: event.target.value }))} placeholder="计划内, 波段" /></label>
          <label className="journal-span-two">成交备注<textarea value={executionForm.note} onChange={(event) => setExecutionForm((current) => ({ ...current, note: event.target.value }))} /></label>
        </div>
        <button className="primary-button" type="submit" disabled={savingExecution}>{savingExecution ? "正在保存…" : "保存成交"}</button>
      </form>
      <form className="ui-panel cash-flow-entry" onSubmit={(event) => void saveCashFlow(event)}>
        <h3>资金流水</h3>
        <div className="journal-form-grid">
          <label>资金时间<input required type="datetime-local" value={cashFlowForm.occurredAt} onChange={(event) => setCashFlowForm((current) => ({ ...current, occurredAt: event.target.value }))} /></label>
          <label>资金类型<select value={cashFlowForm.kind} onChange={(event) => setCashFlowForm((current) => ({ ...current, kind: event.target.value as CashFlowKind }))}><option value="deposit">入金</option><option value="withdrawal">出金</option></select></label>
          <label>资金金额<input required inputMode="decimal" value={cashFlowForm.amount} onChange={(event) => setCashFlowForm((current) => ({ ...current, amount: event.target.value }))} /></label>
          <label className="journal-span-two">资金备注<textarea value={cashFlowForm.note} onChange={(event) => setCashFlowForm((current) => ({ ...current, note: event.target.value }))} /></label>
        </div>
        <button className="secondary-button" type="submit" disabled={savingCashFlow}>{savingCashFlow ? "正在保存…" : "保存资金流水"}</button>
        {cashFlows !== undefined && cashFlows.length > 0 && <ul className="journal-list compact-list">{cashFlows.map((cashFlow) => <li key={cashFlow.cashFlowId}><div><strong>{cashFlow.kind === "deposit" ? "入金" : "出金"} {formatMoney(cashFlow.amount)}</strong><span>{cashFlow.note || "无备注"}</span></div><button className="secondary-button" type="button" onClick={() => void deleteCashFlow(cashFlow)}>删除</button></li>)}</ul>}
      </form>
      </>}
    />
      <Panel title="收盘检查" heading="h3" aria-label="收盘检查">
        <div className="journal-form-grid">
          <label className="journal-span-two">失效条件<textarea value={dailyReviewForm.invalidationCondition} onChange={(event) => setDailyReviewForm((current) => ({ ...current, invalidationCondition: event.target.value }))} placeholder="今天持仓逻辑在什么条件下失效？" /></label>
          <label className="journal-span-two">次日计划<textarea value={dailyReviewForm.nextDayPlan} onChange={(event) => setDailyReviewForm((current) => ({ ...current, nextDayPlan: event.target.value }))} placeholder="下一交易日只观察和执行什么？" /></label>
          <label>当日情绪<select value={dailyReviewForm.emotion} onChange={(event) => setDailyReviewForm((current) => ({ ...current, emotion: event.target.value as DailyReview["emotion"] }))}><option value="calm">平静</option><option value="confident">自信</option><option value="anxious">焦虑</option><option value="impulsive">冲动</option><option value="frustrated">挫败</option><option value="other">其他</option></select></label>
          <label>是否遵守计划<select aria-label="是否遵守计划" value={dailyReviewForm.disciplineFollowed} onChange={(event) => setDailyReviewForm((current) => ({ ...current, disciplineFollowed: event.target.value as DailyReviewForm["disciplineFollowed"] }))}><option value="">草稿中暂不判断</option><option value="true">遵守</option><option value="false">未遵守</option></select></label>
          <label className="journal-span-two">日记备注<textarea value={dailyReviewForm.note} onChange={(event) => setDailyReviewForm((current) => ({ ...current, note: event.target.value }))} /></label>
        </div>
        <div className="journal-actions"><button className="secondary-button" type="button" onClick={() => void saveDailyReview("draft")} disabled={savingReview !== null}>{savingReview === "draft" ? "正在保存…" : "保存收盘草稿"}</button><button className="primary-button" type="button" onClick={() => void saveDailyReview("completed")} disabled={savingReview !== null}>{savingReview === "completed" ? "正在完成…" : "完成当日复盘"}</button></div>
        {dailyReview?.status === "completed" && <p className="journal-complete">该日复盘已完成。</p>}
      </Panel>
  </section>;
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

function currentShanghaiDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败，请检查本机服务。";
}
