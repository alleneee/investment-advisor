import type {
  AdvisorRun, ChanAnalysisResult, InformationEvidenceResult, MarketSnapshotResult, ReportDraftV2, ToolEnvelope,
} from '../../../packages/contracts/src/index.js';

export class ProviderError extends Error {
  constructor(_message?: string) { super('upstream provider failed'); this.name = 'ProviderError'; }
}

export interface PythonRpcPort {
  getState(runId: string): Promise<AdvisorRun>;
  saveState(state: AdvisorRun): Promise<void>;
  fetch_market_snapshot(input: ToolEnvelope): Promise<MarketSnapshotResult>;
  run_chan_analysis(input: ToolEnvelope): Promise<ChanAnalysisResult>;
  collect_information_evidence(input: ToolEnvelope): Promise<InformationEvidenceResult>;
  emit_research_report(input: ToolEnvelope & { report: ReportDraftV2 }): Promise<ReportDraftV2>;
}

export class PythonRpcClient implements PythonRpcPort {
  constructor(private readonly baseUrl: string, private readonly token?: string) {}

  private async get<T>(method: string): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/v1/${method}`, {
      method: 'GET', headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    if (!response.ok) throw new ProviderError();
    return response.json() as Promise<T>;
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/v1/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new ProviderError();
    return response.json() as Promise<T>;
  }

  getState(runId: string) { return this.get<AdvisorRun>(`agent-runs/${encodeURIComponent(runId)}/state`); }
  saveState(state: AdvisorRun) { return this.call<void>(`agent-runs/${encodeURIComponent(state.run_id)}/state`, state); }
  fetch_market_snapshot(input: ToolEnvelope) { return this.call<MarketSnapshotResult>('tools/fetch_market_snapshot', input); }
  run_chan_analysis(input: ToolEnvelope) { return this.call<ChanAnalysisResult>('tools/run_chan_analysis', input); }
  collect_information_evidence(input: ToolEnvelope) { return this.call<InformationEvidenceResult>('tools/collect_information_evidence', input); }
  emit_research_report(input: ToolEnvelope & { report: ReportDraftV2 }) { return this.call<ReportDraftV2>('tools/emit_research_report', input); }
}
