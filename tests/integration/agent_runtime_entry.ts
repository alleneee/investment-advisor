import { appendFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type {
  AdvisorRun,
  ChanAnalysisResult,
  InformationEvidenceResult,
  MarketSnapshotResult,
  ReportDraftV2,
  ToolEnvelope,
} from '../../packages/contracts/src/index.js';
import type { PiSessionPort } from '../../apps/agent-runtime/src/orchestrator.js';
import { PythonRpcClient, type PythonRpcPort } from '../../apps/agent-runtime/src/rpc.js';
import { createServer } from '../../apps/agent-runtime/src/server.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`integration entry environment is missing: ${name}`);
  return value;
}

const pythonUrl = requiredEnvironment('PYTHON_API_BASE_URL');
const token = requiredEnvironment('INTERNAL_AGENT_TOKEN');
const auditPath = requiredEnvironment('TOOL_AUDIT_PATH');
const port = Number(process.env.PORT);

if (!Number.isInteger(port) || port < 1) {
  throw new Error('integration entry port is invalid');
}

class AuditedPythonRpc implements PythonRpcPort {
  constructor(
    private readonly delegate: PythonRpcClient,
    private readonly auditPath: string,
  ) {}

  getState(runId: string): Promise<AdvisorRun> {
    return this.delegate.getState(runId);
  }

  saveState(state: AdvisorRun): Promise<void> {
    return this.delegate.saveState(state);
  }

  fetch_market_snapshot(input: ToolEnvelope): Promise<MarketSnapshotResult> {
    this.record('fetch_market_snapshot');
    return this.delegate.fetch_market_snapshot(input);
  }

  run_chan_analysis(input: ToolEnvelope): Promise<ChanAnalysisResult> {
    this.record('run_chan_analysis');
    return this.delegate.run_chan_analysis(input);
  }

  collect_information_evidence(input: ToolEnvelope): Promise<InformationEvidenceResult> {
    this.record('collect_information_evidence');
    return this.delegate.collect_information_evidence(input);
  }

  emit_research_report(
    input: ToolEnvelope & { report: ReportDraftV2 },
  ): Promise<ReportDraftV2> {
    this.record('emit_research_report');
    return this.delegate.emit_research_report(input);
  }

  private record(tool: string): void {
    appendFileSync(this.auditPath, `${JSON.stringify({ tool })}\n`, 'utf8');
  }
}

function firstInformationReference(registry: Record<string, unknown>): string {
  const informationRef = Object.keys(registry).find((ref) =>
    /^(news\.|irm\.|hot\.|information\.quality(?:\.|$))/u.test(ref),
  );
  if (!informationRef) throw new Error('information reference is missing');
  return informationRef;
}

const session: PiSessionPort = {
  async run(input: unknown): Promise<ReportDraftV2> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid session input');
    }
    const value = input as { tool?: unknown; state?: AdvisorRun };
    if (value.tool !== 'emit_research_report' || !value.state) {
      throw new Error('unexpected session call');
    }
    const registry = value.state.artifacts?.reference_registry;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new Error('reference registry is missing');
    }
    const informationRef = firstInformationReference(registry as Record<string, unknown>);
    return {
      version: 'ReportDraftV2',
      run_id: value.state.run_id,
      title: '结构资讯综合研判',
      executive_summary: '结构仍需确认，资讯事实为情景判断提供补充依据。',
      outlook: {
        horizon: '5-20-trading-days',
        direction: 'uncertain',
        confidence: 'medium',
        thesis: '后续走势取决于结构确认、关键位置约束与资讯持续性。',
        scenarios: [
          {
            case: 'bullish',
            narrative: '向上结构得到确认时，偏强情景逐步成立。',
            trigger: { operator: 'break_above', fact_ref: 'market.recent_high' },
            invalidation: { operator: 'break_below', fact_ref: 'market.recent_low' },
            evidence_refs: ['market.latest_close', 'chan.structure', informationRef],
          },
          {
            case: 'base',
            narrative: '结构尚未选择方向时，基准情景维持整理。',
            trigger: { operator: 'structure_confirmed', fact_ref: 'chan.structure' },
            invalidation: { operator: 'structure_invalidated', fact_ref: 'chan.structure' },
            evidence_refs: ['chan.structure'],
          },
          {
            case: 'bearish',
            narrative: '向下结构得到确认时，偏弱情景逐步成立。',
            trigger: { operator: 'break_below', fact_ref: 'market.recent_low' },
            invalidation: { operator: 'break_above', fact_ref: 'market.recent_high' },
            evidence_refs: ['market.recent_low'],
          },
        ],
      },
      risks: [
        {
          narrative: '资讯时效与结构演化可能形成偏差。',
          evidence_refs: [informationRef],
        },
      ],
      evidence_refs: ['market.latest_close', 'chan.structure', informationRef],
    };
  },
};

const rpc = new AuditedPythonRpc(new PythonRpcClient(pythonUrl, token), auditPath);
const server: Server = createServer({ rpc, session, token });
server.listen(port, '127.0.0.1');

function stop(): void {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
