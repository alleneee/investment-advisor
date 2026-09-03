import { useEffect, useRef, useState, type FormEvent } from "react";
import { BsChart } from "./BsChart";
import { barIndexForOccurredAt } from "./bs-chart-option";
import type { TradingApi } from "./trading-api";
import type {
  BsChart as BsChartData,
  BsSummary,
  BsSymbolSummary,
  BsTimeframe,
  ChartMark,
  ChartMarkType,
} from "./trading-types";
import { DataTable } from "./ui/DataTable";
import { EmptyState } from "./ui/EmptyState";
import { formatMoney, formatRate, formatSignedMoney, signedTone } from "./ui/formatDisplay";
import { Panel } from "./ui/Panel";
import { SegmentedControl } from "./ui/SegmentedControl";

const EMPTY_TYPE_DRAFT = { label: "", letter: "", color: "#9b8cff" };

type MarkDraft = {
  typeId: string;
  comment: string;
  editingMarkId: string | null;
  deletingMarkId: string | null;
  showNewType: boolean;
  newType: typeof EMPTY_TYPE_DRAFT;
  saved: boolean;
  pending: "save" | "delete" | "type" | null;
  error: string | null;
  notice: string | null;
};

export function BsAnalysisPanel({
  api,
  periodStart,
  periodEnd,
}: {
  api: TradingApi;
  periodStart: string;
  periodEnd: string;
}) {
  const [summary, setSummary] = useState<BsSummary | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<"analysis" | "executions">("analysis");
  const [timeframe, setTimeframe] = useState<BsTimeframe>("1d");
  const [chart, setChart] = useState<BsChartData | null>(null);
  const [marks, setMarks] = useState<ChartMark[]>([]);
  const [types, setTypes] = useState<ChartMarkType[]>([]);
  const [highlightOccurredAt, setHighlightOccurredAt] = useState<string | null>(null);
  const [selectedBar, setSelectedBar] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, MarkDraft>>({});
  const mutationLocks = useRef(new Set<string>());
  const activeChartContext = useRef<{ api: TradingApi; scope: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chartScope = JSON.stringify([periodStart, periodEnd, selectedSymbol, timeframe]);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setSelectedSymbol(null);
    setChart(null);
    setMarks([]);
    setHighlightOccurredAt(null);
    setSelectedBar(null);
    setTab("analysis");
    setTimeframe("1d");
    void api.getBsSummary(periodStart, periodEnd).then((next) => {
      if (!active) return;
      setSummary(next);
      setError(null);
    }).catch((reason: unknown) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [api, periodEnd, periodStart]);

  useEffect(() => {
    activeChartContext.current = { api, scope: chartScope };
    if (!selectedSymbol) return;
    let active = true;
    setChart(null);
    void (async () => {
      try {
        const nextChart = await api.getBsChart(selectedSymbol, timeframe, periodStart, periodEnd);
        if (!active) return;
        const window = chartWindow(nextChart, periodStart, periodEnd);
        const [nextMarks, nextTypes] = await Promise.all([
          api.listChartMarks(selectedSymbol, window.start, window.end),
          api.listChartMarkTypes(),
        ]);
        if (!active) return;
        setChart(nextChart);
        setMarks(nextMarks);
        setTypes(nextTypes);
        if (!nextChart.available) {
          setSelectedBar(null);
          setHighlightOccurredAt(null);
        }
        setError(null);
      } catch (reason) {
        if (active) setError(messageOf(reason));
      }
    })();
    return () => {
      active = false;
      activeChartContext.current = null;
    };
  }, [api, chartScope, periodEnd, periodStart, selectedSymbol, timeframe]);

  const selected = summary?.symbols.find((item) => item.symbol === selectedSymbol) ?? null;
  const enabledTypes = types.filter((item) => item.enabled);
  const selectedBarIndex = chart && selectedBar ? barIndexForOccurredAt(chart, selectedBar) : -1;
  const selectedMarks = chart && selectedBarIndex >= 0
    ? marks.filter((item) => barIndexForOccurredAt(chart, item.occurredAt) === selectedBarIndex)
    : [];
  const draftKey = selectedSymbol && selectedBar ? JSON.stringify([selectedSymbol, timeframe, selectedBar]) : null;
  const emptyDraft: MarkDraft = {
    typeId: enabledTypes[0]?.typeId ?? "",
    comment: "",
    editingMarkId: null,
    deletingMarkId: null,
    showNewType: false,
    newType: EMPTY_TYPE_DRAFT,
    saved: false,
    pending: null,
    error: null,
    notice: null,
  };
  const draft = draftKey ? drafts[draftKey] ?? emptyDraft : emptyDraft;
  const { typeId, comment, editingMarkId, deletingMarkId, showNewType, newType, pending } = draft;
  const busy = pending !== null;

  function updateDraft(update: Partial<MarkDraft>, key = draftKey) {
    if (!key) return;
    setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? emptyDraft), ...update } }));
  }

  function resetMarkForm() {
    setSelectedBar(null);
    setHighlightOccurredAt(null);
  }

  function selectSymbol(item: BsSymbolSummary) {
    setSelectedSymbol(item.symbol);
    setTab("analysis");
    setTimeframe("1d");
    resetMarkForm();
  }

  function changeTimeframe(next: BsTimeframe) {
    if (next === timeframe) return;
    setTimeframe(next);
    resetMarkForm();
  }

  function onSelectBar(occurredAt: string) {
    setSelectedBar(occurredAt);
    setHighlightOccurredAt(occurredAt);
  }

  function selectType(nextTypeId: string) {
    if (busy) return;
    const existing = selectedMarks.filter((item) => item.typeId === nextTypeId).at(-1);
    updateDraft({
      typeId: nextTypeId,
      deletingMarkId: null,
      showNewType: false,
      saved: false,
      notice: null,
      ...(existing ? { editingMarkId: existing.markId, comment: existing.comment, saved: true } : {}),
    });
  }

  async function saveMark(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedBar || !typeId || !draftKey || mutationLocks.current.has(draftKey)) return;
    mutationLocks.current.add(draftKey);
    updateDraft({ pending: "save", error: null, notice: null });
    try {
      const editing = marks.find((item) => item.markId === editingMarkId)
        ?? selectedMarks.filter((item) => item.typeId === typeId).at(-1);
      const mark = editing
        ? await api.updateChartMark(editing.markId, typeId === editing.typeId ? { comment } : { typeId, comment }, editing.revision)
        : await api.createChartMark({ symbol: selected.symbol, occurredAt: selectedBar, typeId, comment, timeframe });
      if (activeChartContext.current?.api === api && activeChartContext.current.scope === chartScope) {
        setMarks((current) => current.some((item) => item.markId === mark.markId)
          ? current.map((item) => item.markId === mark.markId ? mark : item)
          : [...current, mark]);
      }
      updateDraft({
        editingMarkId: mark.markId,
        typeId: mark.typeId,
        comment: mark.comment,
        saved: true,
        error: null,
      });
    } catch (reason) {
      updateDraft({ error: messageOf(reason) });
    } finally {
      mutationLocks.current.delete(draftKey);
      updateDraft({ pending: null });
    }
  }

  function startEditMark(item: ChartMark) {
    if (busy) return;
    updateDraft({ editingMarkId: item.markId, deletingMarkId: null, showNewType: false, typeId: item.typeId, comment: item.comment, saved: true, error: null, notice: null });
  }

  function cancelEditMark() {
    if (busy) return;
    updateDraft({ editingMarkId: null, comment: "", typeId: enabledTypes[0]?.typeId ?? "", saved: false, error: null, notice: null });
  }

  async function deleteMark(item: ChartMark) {
    if (!draftKey || mutationLocks.current.has(draftKey)) return;
    mutationLocks.current.add(draftKey);
    updateDraft({ pending: "delete", error: null, notice: null });
    try {
      await api.deleteChartMark(item.markId, item.revision);
      if (activeChartContext.current?.api === api && activeChartContext.current.scope === chartScope) {
        setMarks((current) => current.filter((candidate) => candidate.markId !== item.markId));
      }
      updateDraft({
        deletingMarkId: null,
        error: null,
        notice: "已删除",
        ...(editingMarkId === item.markId ? { editingMarkId: null, comment: "", typeId: enabledTypes[0]?.typeId ?? "", saved: false } : {}),
      });
    } catch (reason) {
      updateDraft({ error: messageOf(reason) });
    } finally {
      mutationLocks.current.delete(draftKey);
      updateDraft({ pending: null });
    }
  }

  async function createType() {
    if (!draftKey || mutationLocks.current.has(draftKey)) return;
    mutationLocks.current.add(draftKey);
    updateDraft({ pending: "type", error: null, notice: null });
    try {
      const created = await api.createChartMarkType({
        label: newType.label,
        letter: newType.letter,
        color: newType.color,
      });
      if (activeChartContext.current?.api === api) {
        setTypes((current) => [...current.filter((item) => item.typeId !== created.typeId), created]);
      }
      updateDraft({ typeId: created.typeId, showNewType: false, newType: EMPTY_TYPE_DRAFT, saved: false, error: null, notice: "类型已保存" });
    } catch (reason) {
      updateDraft({ error: messageOf(reason) });
    } finally {
      mutationLocks.current.delete(draftKey);
      updateDraft({ pending: null });
    }
  }

  return <Panel title="个股 BS 分析" heading="h3" className="bs-analysis-panel">
    {error && <p className="journal-error" role="alert">{error}</p>}
    {summary && summary.symbols.length === 0 && <EmptyState title="本周期没有持仓或成交股票。" />}
    {summary && summary.symbols.length > 0 && <div className="bs-pnl-tiles" aria-label="个股盈亏">
      {summary.symbols.map((item) => {
        const tone = signedTone(item.periodPnl);
        return <button
          key={item.symbol}
          type="button"
          className={`bs-pnl-tile tone-${tone}`}
          aria-pressed={selected?.symbol === item.symbol}
          style={{ flexGrow: tileWeight(item.periodPnl), background: tileBackground(tone) }}
          onClick={() => selectSymbol(item)}
        >
          <span>{item.name}</span>
          <small>{item.symbol}</small>
          <strong>{formatSignedMoney(item.periodPnl)}</strong>
        </button>;
      })}
    </div>}
    {selected && <div className="bs-symbol-detail">
      <div className="bs-symbol-heading"><strong>{selected.name}</strong><span>{selected.symbol}</span></div>
      <div className="bs-symbol-toolbar">
        <SegmentedControl aria-label="个股视图">
          <button type="button" aria-pressed={tab === "analysis"} onClick={() => setTab("analysis")}>BS点分析</button>
          <button type="button" aria-pressed={tab === "executions"} onClick={() => setTab("executions")}>交易记录</button>
        </SegmentedControl>
        <SegmentedControl aria-label="K线周期">
          <button type="button" aria-pressed={timeframe === "1d"} onClick={() => changeTimeframe("1d")}>日线</button>
          <button type="button" aria-pressed={timeframe === "30m"} onClick={() => changeTimeframe("30m")}>30分钟</button>
        </SegmentedControl>
      </div>
      {chart && <BsChart
        chart={chart}
        marks={marks}
        types={types}
        periodStart={periodStart}
        periodEnd={periodEnd}
        highlightOccurredAt={highlightOccurredAt}
        onSelectBar={onSelectBar}
      />}
      {selectedBar && <form className="bs-mark-picker" aria-label="图标注记" onSubmit={(event) => void saveMark(event)}>
        <p className="bs-selected-bar">已选 K 线 {formatSelectedBar(selectedBar, timeframe)}</p>
        <p className="bs-mark-save-status" role="status">{busy ? pending === "delete" ? "正在删除分析…" : pending === "type" ? "正在创建类型…" : "正在保存分析…" : draft.saved ? "已保存" : "未保存"}{draft.notice && ` · ${draft.notice}`}</p>
        {draft.error && <p className="journal-error" role="alert">{draft.error}</p>}
        <div className="bs-type-picker" role="group" aria-label="点位类型">
          {enabledTypes.map((item) => <button key={item.typeId} type="button" disabled={busy} aria-pressed={typeId === item.typeId} onClick={() => selectType(item.typeId)}>{item.label}</button>)}
        </div>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => updateDraft({ showNewType: true })}>+ 新类型</button>
        {showNewType && <div className="bs-new-type">
          <label>名称<input value={newType.label} disabled={busy} onChange={(event) => updateDraft({ newType: { ...newType, label: event.target.value } })} /></label>
          <label>字母<input value={newType.letter} disabled={busy} maxLength={2} onChange={(event) => updateDraft({ newType: { ...newType, letter: event.target.value } })} /></label>
          <label>颜色<input value={newType.color} disabled={busy} onChange={(event) => updateDraft({ newType: { ...newType, color: event.target.value } })} /></label>
          <div className="bs-new-type-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void createType()}>{pending === "type" ? "创建中…" : "创建类型"}</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => updateDraft({ showNewType: false })}>取消</button>
          </div>
        </div>}
        <label>评论<textarea value={comment} disabled={busy} rows={3} onChange={(event) => updateDraft({ comment: event.target.value, saved: false, notice: null })} maxLength={1000} /></label>
        <div className="journal-actions">
          <button className="primary-button" type="submit" disabled={busy || !typeId}>{pending === "save" ? "保存中…" : editingMarkId ? "保存修改" : "新增分析"}</button>
          {editingMarkId && <button className="secondary-button" type="button" disabled={busy} onClick={cancelEditMark}>取消编辑</button>}
          <button className="secondary-button" type="button" onClick={resetMarkForm}>关闭</button>
        </div>
        <div className="bs-mark-list">
          <strong>当前 K 线的 BS 分析</strong>
          <ul aria-label="当前 K 线的 BS 分析">
            {selectedMarks.map((item) => {
              const itemType = types.find((candidate) => candidate.typeId === item.typeId);
              const itemName = item.comment || itemType?.label || "无评论";
              return <li key={item.markId}>
                <span className="bs-mark-type">{itemType?.label ?? "未知类型"}</span>
                <span className="bs-mark-comment">{item.comment || "无评论"}</span>
                <div className="bs-mark-actions">
                  <button className="secondary-button" type="button" disabled={busy} aria-label={`编辑分析 ${itemName}`} onClick={() => startEditMark(item)}>编辑</button>
                  {deletingMarkId === item.markId
                    ? <>
                        <button className="secondary-button bs-mark-delete-confirm" type="button" disabled={busy} aria-label={pending === "delete" ? "删除中…" : `确认删除 ${itemName}`} onClick={() => void deleteMark(item)}>{pending === "delete" ? "删除中…" : "确认删除"}</button>
                        <button className="secondary-button" type="button" disabled={busy} onClick={() => updateDraft({ deletingMarkId: null })}>取消</button>
                      </>
                    : <button className="secondary-button" type="button" disabled={busy} aria-label={`删除分析 ${itemName}`} onClick={() => updateDraft({ deletingMarkId: item.markId })}>删除</button>}
                </div>
              </li>;
            })}
          </ul>
        </div>
      </form>}
      {tab === "analysis" && <div className="bs-symbol-stats">
        <article><span>建清仓次数</span><strong>{selected.closedCycleCount}</strong></article>
        <article><span>平均持仓</span><strong>{selected.medianHoldingDays.value ?? "—"}</strong></article>
        <article><span>成功率</span><strong>{selected.winRate.value == null ? "—" : formatRate(selected.winRate.value)}</strong></article>
      </div>}
      {tab === "executions" && <DataTable className="bs-execution-table" aria-label="交易记录">
        <thead><tr><th>时间</th><th>方向</th><th>价格</th><th>数量</th></tr></thead>
        <tbody>
          {(chart?.executions ?? []).map((item) => <tr key={item.executionId} onClick={() => setHighlightOccurredAt(item.barOccurredAt)}>
            <td>{item.occurredAt}</td>
            <td>{item.side === "buy" ? "买入" : "卖出"}</td>
            <td>{formatMoney(item.price)}</td>
            <td>{item.quantity}</td>
          </tr>)}
        </tbody>
      </DataTable>}
    </div>}
  </Panel>;
}

function formatSelectedBar(occurredAt: string, timeframe: BsTimeframe): string {
  return timeframe === "1d" ? occurredAt.slice(0, 10) : occurredAt.slice(0, 16).replace("T", " ");
}

function tileWeight(pnl: string): number {
  const abs = Math.abs(Number(pnl));
  return Number.isFinite(abs) && abs > 0 ? abs : 1;
}

function tileBackground(tone: ReturnType<typeof signedTone>): string {
  if (tone === "up") return "#f6465d";
  if (tone === "down") return "#0ecb81";
  return "#bbcbb2";
}

function chartWindow(chart: BsChartData, periodStart: string, periodEnd: string): { start: string; end: string } {
  if (chart.bars.length === 0) return { start: periodStart, end: periodEnd };
  const first = chart.bars[0];
  const last = chart.bars[chart.bars.length - 1];
  return {
    start: first.tradeDate || first.occurredAt.slice(0, 10),
    end: last.tradeDate || last.occurredAt.slice(0, 10),
  };
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "请求失败，请检查本机服务。";
}
