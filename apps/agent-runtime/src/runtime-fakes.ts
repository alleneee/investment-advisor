import type { AdvisorRun, ChanAnalysisResult, InformationEvidenceResult, MarketSnapshotResult, ReferenceRegistry, ReferenceRegistryEntry, ReportDraftV2, ToolEnvelope } from '../../../packages/contracts/src/index.js';
import type { PythonRpcPort } from './rpc.js';

export interface RpcCall { tool: string; input: unknown }

export class FakePythonRpc implements PythonRpcPort {
  readonly calls: RpcCall[] = [];
  private readonly states = new Map<string, AdvisorRun>();
  seed(state: AdvisorRun) { this.states.set(state.run_id, structuredClone(state)); }
  async getState(runId: string) { const state = this.states.get(runId); if (!state) throw new Error('run not found'); return structuredClone(state); }
  async saveState(state: AdvisorRun) { this.states.set(state.run_id, structuredClone(state)); }
  private record(tool: string, input: unknown) { this.calls.push({ tool, input }); }
  async fetch_market_snapshot(input: ToolEnvelope): Promise<MarketSnapshotResult> { this.record('fetch_market_snapshot', input); return { ...input, snapshot_id: 'market-1', as_of: '2026-08-12T00:00:00Z', observations: [] }; }
  async run_chan_analysis(input: ToolEnvelope): Promise<ChanAnalysisResult> { this.record('run_chan_analysis', input); return { ...input, analysis_id: 'chan-1', signal_summary: 'neutral observation', evidence_refs: ['market-1'] }; }
  async collect_information_evidence(input: ToolEnvelope): Promise<InformationEvidenceResult> {
    this.record('collect_information_evidence', input);
    return { ...input, kind: 'information', evidence_id: 'information-1', claims: [{ claim: 'information observation', source_ref: 'news.latest' }] };
  }
  async emit_research_report(input: ToolEnvelope & { report: ReportDraftV2 }) { this.record('emit_research_report', input); return input.report; }
}

// 突破类条件必须落在固化收盘尚未越过的一侧，否则服务端按"固化日已解决"拒收整份报告。
// 取最高的价格水平做向上突破、最低的做向下跌破，只要现价在两者之间就一定未被解决。
function extremePriceRef(entries: ReferenceRegistryEntry[], highest: boolean): string | undefined {
  const numeric = entries.flatMap((entry) => {
    const value = typeof entry.value === 'number' ? entry.value
      : typeof entry.value === 'string' && entry.value.trim() !== '' ? Number(entry.value) : Number.NaN;
    return Number.isFinite(value) ? [{ ref: entry.ref, value }] : [];
  });
  if (numeric.length === 0) return undefined;
  return numeric.reduce((best, item) => ((highest ? item.value > best.value : item.value < best.value) ? item : best)).ref;
}

export class FakeSession {
  readonly turns: unknown[] = [];
  async run(input: unknown): Promise<ReportDraftV2 | undefined> {
    this.turns.push(structuredClone(input));
    if (!input || typeof input !== 'object' || !('tool' in input) || input.tool !== 'emit_research_report' || !('state' in input)) return undefined;
    const state = input.state as AdvisorRun;
    const registry = (state.artifacts?.reference_registry ?? {}) as ReferenceRegistry;
    const marketRef = Object.values(registry).find((entry) => entry.kind === 'market')?.ref;
    const priceLevels = Object.values(registry).filter((entry) => entry.kind === 'price_level');
    const priceRefs = priceLevels.map((entry) => entry.ref);
    const upperRef = extremePriceRef(priceLevels, true) ?? priceRefs[0];
    const lowerRef = extremePriceRef(priceLevels, false) ?? priceRefs[1];
    const structureRef = Object.values(registry).find((entry) => entry.kind === 'structure')?.ref;
    const informationRef = Object.values(registry).find((entry) => ['news', 'irm', 'hot', 'information_quality'].includes(entry.kind))?.ref;
    if (!marketRef || priceRefs.length < 2 || !structureRef || !informationRef) return undefined;
    const evidence_refs = [marketRef, structureRef, informationRef];
    return {
      version: 'ReportDraftV2', run_id: state.run_id, title: '证据研究摘要', executive_summary: '结构与信息仍需持续观察',
      outlook: {
        horizon: '5-20-trading-days', direction: 'sideways', confidence: 'medium', thesis: '多类证据暂未形成一致方向',
        scenarios: [
          { case: 'bullish', narrative: '上方结构得到确认', trigger: { operator: 'break_above', fact_ref: upperRef }, invalidation: { operator: 'structure_invalidated', fact_ref: structureRef }, evidence_refs },
          { case: 'base', narrative: '结构保持震荡', trigger: { operator: 'structure_confirmed', fact_ref: structureRef }, invalidation: { operator: 'break_below', fact_ref: lowerRef }, evidence_refs },
          { case: 'bearish', narrative: '下方结构转弱', trigger: { operator: 'break_below', fact_ref: lowerRef }, invalidation: { operator: 'structure_confirmed', fact_ref: structureRef }, evidence_refs },
        ],
      },
      risks: [{ narrative: '信息质量可能变化', evidence_refs }], evidence_refs,
    };
  }
}
