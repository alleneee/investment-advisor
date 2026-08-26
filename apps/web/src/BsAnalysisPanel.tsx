import { useEffect, useState, type FormEvent } from "react";
import { BsChart } from "./BsChart";
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
  const [typeId, setTypeId] = useState("");
  const [comment, setComment] = useState("");
  const [showNewType, setShowNewType] = useState(false);
  const [newType, setNewType] = useState({ label: "", letter: "", color: "#9b8cff" });
  const [error, setError] = useState<string | null>(null);

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
          setShowNewType(false);
        }
        setError(null);
      } catch (reason) {
        if (active) setError(messageOf(reason));
      }
    })();
    return () => { active = false; };
  }, [api, periodEnd, periodStart, selectedSymbol, timeframe]);

  const selected = summary?.symbols.find((item) => item.symbol === selectedSymbol) ?? null;
  const enabledTypes = types.filter((item) => item.enabled);

  function resetMarkForm() {
    setSelectedBar(null);
    setHighlightOccurredAt(null);
    setShowNewType(false);
  }

  function selectSymbol(item: BsSymbolSummary) {
    setSelectedSymbol(item.symbol);
    setTab("analysis");
    setTimeframe("1d");
    resetMarkForm();
    setComment("");
  }

  function changeTimeframe(next: BsTimeframe) {
    if (next === timeframe) return;
    setTimeframe(next);
    resetMarkForm();
  }

  function onSelectBar(occurredAt: string) {
    setSelectedBar(occurredAt);
    setHighlightOccurredAt(occurredAt);
    setTypeId((current) => (
      current && enabledTypes.some((item) => item.typeId === current)
        ? current
        : enabledTypes[0]?.typeId ?? ""
    ));
  }

  async function saveMark(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedBar || !typeId) return;
    try {
      const mark = await api.createChartMark({
        symbol: selected.symbol,
        occurredAt: selectedBar,
        typeId,
        comment,
        timeframe,
      });
      setMarks((current) => [...current, mark]);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function createType() {
    try {
      const created = await api.createChartMarkType({
        label: newType.label,
        letter: newType.letter,
        color: newType.color,
      });
      setTypes((current) => [...current, created]);
      setTypeId(created.typeId);
      setShowNewType(false);
      setNewType({ label: "", letter: "", color: "#9b8cff" });
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  return <Panel title="个股 BS 分析" heading="h3" className="bs-analysis-panel">
    {error && <p className="journal-error" role="alert">{error}</p>}
    {summary && summary.symbols.length === 0 && <EmptyState title="本周期没有成交股票。" />}
    {summary && summary.symbols.length > 0 && <div className="bs-pnl-tiles" aria-label="个股盈亏">
      {summary.symbols.map((item) => {
        const tone = signedTone(item.realizedPnl);
        return <button
          key={item.symbol}
          type="button"
          className={`bs-pnl-tile tone-${tone}`}
          aria-pressed={selected?.symbol === item.symbol}
          style={{ flexGrow: tileWeight(item.realizedPnl), background: tileBackground(tone) }}
          onClick={() => selectSymbol(item)}
        >
          <span>{item.name}</span>
          <small>{item.symbol}</small>
          <strong>{formatSignedMoney(item.realizedPnl)}</strong>
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
      {selectedBar && <form className="bs-mark-picker" aria-label="图标注记" onSubmit={(event) => void saveMark(event)}>
        <div className="bs-type-picker" role="group" aria-label="点位类型">
          {enabledTypes.map((item) => <button key={item.typeId} type="button" aria-pressed={typeId === item.typeId} onClick={() => setTypeId(item.typeId)}>{item.label}</button>)}
        </div>
        <label>评论<input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} /></label>
        <div className="journal-actions">
          <button className="primary-button" type="submit">保存</button>
          <button className="secondary-button" type="button" onClick={() => setShowNewType(true)}>+ 新类型</button>
        </div>
        {showNewType && <div className="bs-new-type">
          <label>名称<input value={newType.label} onChange={(event) => setNewType((current) => ({ ...current, label: event.target.value }))} /></label>
          <label>字母<input value={newType.letter} maxLength={2} onChange={(event) => setNewType((current) => ({ ...current, letter: event.target.value }))} /></label>
          <label>颜色<input value={newType.color} onChange={(event) => setNewType((current) => ({ ...current, color: event.target.value }))} /></label>
          <button className="secondary-button" type="button" onClick={() => void createType()}>创建类型</button>
        </div>}
      </form>}
    </div>}
  </Panel>;
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
