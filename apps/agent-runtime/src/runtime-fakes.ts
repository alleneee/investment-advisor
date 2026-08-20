import type { AdvisorRun, ChanAnalysisResult, InformationEvidenceResult, MarketSnapshotResult, ReferenceRegistry, ReportDraftV2, ToolEnvelope } from '../../../packages/contracts/src/index.js';
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

export class FakeSession {
  readonly turns: unknown[] = [];
  async run(input: unknown): Promise<ReportDraftV2 | undefined> {
    this.turns.push(structuredClone(input));
    if (!input || typeof input !== 'object' || !('tool' in input) || input.tool !== 'emit_research_report' || !('state' in input)) return undefined;
    const state = input.state as AdvisorRun;
    const registry = (state.artifacts?.reference_registry ?? {}) as ReferenceRegistry;
    const marketRef = Object.values(registry).find((entry) => entry.kind === 'market')?.ref;
    const priceRefs = Object.values(registry).filter((entry) => entry.kind === 'price_level').map((entry) => entry.ref);
    const structureRef = Object.values(registry).find((entry) => entry.kind === 'structure')?.ref;
    const informationRef = Object.values(registry).find((entry) => ['news', 'irm', 'hot', 'information_quality'].includes(entry.kind))?.ref;
    if (!marketRef || priceRefs.length < 2 || !structureRef || !informationRef) return undefined;
    const evidence_refs = [marketRef, structureRef, informationRef];
    return {
      version: 'ReportDraftV2', run_id: state.run_id, title: '证据研究摘要', executive_summary: '结构与信息仍需持续观察',
      outlook: {
        horizon: '5-20-trading-days', direction: 'sideways', confidence: 'medium', thesis: '多类证据暂未形成一致方向',
        scenarios: [
          { case: 'bullish', narrative: '上方结构得到确认', trigger: { operator: 'break_above', fact_ref: priceRefs[0] }, invalidation: { operator: 'structure_invalidated', fact_ref: structureRef }, evidence_refs },
          { case: 'base', narrative: '结构保持震荡', trigger: { operator: 'structure_confirmed', fact_ref: structureRef }, invalidation: { operator: 'break_below', fact_ref: priceRefs[1] }, evidence_refs },
          { case: 'bearish', narrative: '下方结构转弱', trigger: { operator: 'break_below', fact_ref: priceRefs[1] }, invalidation: { operator: 'structure_confirmed', fact_ref: structureRef }, evidence_refs },
        ],
      },
      risks: [{ narrative: '信息质量可能变化', evidence_refs }], evidence_refs,
    };
  }
}
