import test from 'node:test';
import assert from 'node:assert/strict';
import { AdvisorOrchestrator, InvalidToolCallError, BudgetExceededError, LeaseConflictError } from './orchestrator.js';
import { FakePythonRpc, FakeSession } from './runtime-fakes.js';
import { AdvisorRunState, type ReferenceRegistry, type ReportDraftV2 } from '../../../packages/contracts/src/index.js';

const referenceRegistry: ReferenceRegistry = {
  'market.close': { ref: 'market.close', kind: 'market', label: '市场概览', value: '震荡' },
  'market.resistance': { ref: 'market.resistance', kind: 'price_level', label: '压力位', value: 12.5 },
  'market.support': { ref: 'market.support', kind: 'price_level', label: '支撑位', value: 10.5 },
  'chan.structure': { ref: 'chan.structure', kind: 'structure', label: '缠论结构', value: '震荡' },
  'news.latest': { ref: 'news.latest', kind: 'news', label: '最新信息', value: '已核验' },
};

function report(runId = 'run-1'): ReportDraftV2 {
  const evidence_refs = ['market.close', 'chan.structure', 'news.latest'];
  return {
    version: 'ReportDraftV2', run_id: runId, title: '证据研究摘要', executive_summary: '结构与信息仍需持续观察',
    outlook: {
      horizon: '5-20-trading-days', direction: 'sideways', confidence: 'medium', thesis: '多类证据暂未形成一致方向',
      scenarios: [
        { case: 'bullish', narrative: '上方结构得到确认', trigger: { operator: 'break_above', fact_ref: 'market.resistance' }, invalidation: { operator: 'structure_invalidated', fact_ref: 'chan.structure' }, evidence_refs },
        { case: 'base', narrative: '结构保持震荡', trigger: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, invalidation: { operator: 'break_below', fact_ref: 'market.support' }, evidence_refs },
        { case: 'bearish', narrative: '下方结构转弱', trigger: { operator: 'break_below', fact_ref: 'market.support' }, invalidation: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, evidence_refs },
      ],
    },
    risks: [{ narrative: '信息质量可能变化', evidence_refs }], evidence_refs,
  };
}

function setup(runId = 'run-1') {
  const rpc = new FakePythonRpc();
  rpc.seed({
    run_id: runId, state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1,
    artifacts: { reference_registry: referenceRegistry, timeframe: '1w', as_of: '2026-08-12T00:00:00Z' },
  });
  return { rpc, orchestrator: new AdvisorOrchestrator(rpc, new FakeSession()) };
}

class DraftSession {
  readonly turns: unknown[] = [];
  constructor(private readonly draft: unknown = report()) {}
  async run(input: unknown) {
    this.turns.push(structuredClone(input));
    return input && typeof input === 'object' && 'tool' in input && input.tool === 'emit_research_report' ? this.draft : undefined;
  }
}

class EmptySession { async run() { return undefined; } }

class SlowDraftSession {
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return report('run-slow');
  }
}

class SlowFetchRpc extends FakePythonRpc {
  override async fetch_market_snapshot(input: Parameters<FakePythonRpc['fetch_market_snapshot']>[0]) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return super.fetch_market_snapshot(input);
  }
}

class ConcurrentDraftSession {
  private readonly delegate = new FakeSession();
  private arrivals = 0;
  private release!: () => void;
  private readonly barrier = new Promise<void>((resolve) => { this.release = resolve; });

  async run(input: unknown) {
    const draft = await this.delegate.run(input);
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.barrier;
    return draft;
  }
}

test('orchestrator executes exactly four tools in state order and completes with V2', async () => {
  const { rpc, orchestrator } = setup();
  const result = await orchestrator.execute({ run_id: 'run-1', execution_id: 'exec-1', lease_epoch: 1 });
  assert.equal(result.state, AdvisorRunState.COMPLETED);
  assert.equal(result.report?.version, 'ReportDraftV2');
  assert.deepEqual(rpc.calls.map((call) => call.tool), [
    'fetch_market_snapshot', 'run_chan_analysis', 'collect_information_evidence', 'emit_research_report',
  ]);
  assert.ok(result.artifacts?.market);
  assert.ok(result.artifacts?.chan);
  assert.ok((result.artifacts?.evidence as Record<string, unknown>).information);
  assert.ok(result.artifacts?.report);
});

test('concurrent executions on one orchestrator keep tool-call budgets isolated', async () => {
  const rpc = new FakePythonRpc();
  for (const runId of ['run-a', 'run-b']) {
    rpc.seed({
      run_id: runId, state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1,
      artifacts: { reference_registry: referenceRegistry, timeframe: '1w', as_of: '2026-08-12T00:00:00Z' },
    });
  }
  const orchestrator = new AdvisorOrchestrator(rpc, new ConcurrentDraftSession());

  const results = await Promise.all([
    orchestrator.execute({ run_id: 'run-a', execution_id: 'exec-a', lease_epoch: 1 }),
    orchestrator.execute({ run_id: 'run-b', execution_id: 'exec-b', lease_epoch: 1 }),
  ]);

  assert.deepEqual(results.map((result) => result.state), [AdvisorRunState.COMPLETED, AdvisorRunState.COMPLETED]);
  for (const runId of ['run-a', 'run-b']) {
    assert.deepEqual(
      rpc.calls
        .filter((call) => (call.input as { run_id: string }).run_id === runId)
        .map((call) => call.tool),
      ['fetch_market_snapshot', 'run_chan_analysis', 'collect_information_evidence', 'emit_research_report'],
    );
  }
});

test('emit receives the model V2 draft and session receives unmodified registry/timeframe/as_of', async () => {
  const { rpc } = setup();
  const session = new DraftSession();
  const result = await new AdvisorOrchestrator(rpc, session).execute({ run_id: 'run-1', execution_id: 'exec-1', lease_epoch: 1 });
  assert.equal(result.report?.title, '证据研究摘要');
  const emit = rpc.calls.find((call) => call.tool === 'emit_research_report');
  assert.deepEqual((emit?.input as { report: ReportDraftV2 }).report.evidence_refs, ['market.close', 'chan.structure', 'news.latest']);
  const finalTurn = session.turns.at(-1) as { state: { artifacts: Record<string, unknown> } };
  assert.deepEqual(finalTurn.state.artifacts.reference_registry, referenceRegistry);
  assert.equal(finalTurn.state.artifacts.timeframe, '1w');
  assert.equal(finalTurn.state.artifacts.as_of, '2026-08-12T00:00:00Z');
});

test('out-of-order calls and emit with missing artifacts are rejected', async () => {
  const { rpc, orchestrator } = setup();
  await assert.rejects(() => orchestrator.callTool({ run_id: 'run-1', execution_id: 'e', lease_epoch: 1, expected_state_version: 0, idempotency_key: 'x', tool: 'run_chan_analysis' }), InvalidToolCallError);
  rpc.seed({ run_id: 'run-empty', state: AdvisorRunState.EVIDENCE_READY, state_version: 3, lease_epoch: 1, artifacts: { reference_registry: referenceRegistry } });
  await assert.rejects(() => new AdvisorOrchestrator(rpc, new DraftSession(report('run-empty'))).execute({ run_id: 'run-empty', execution_id: 'e', lease_epoch: 1 }), InvalidToolCallError);
});

test('emit rejects unknown registry references and never builds a fallback report', async () => {
  const { rpc } = setup();
  const unknown = report();
  unknown.evidence_refs = ['market.close', 'chan.structure', 'news.unknown'];
  await assert.rejects(() => new AdvisorOrchestrator(rpc, new DraftSession(unknown)).execute({ run_id: 'run-1', execution_id: 'e', lease_epoch: 1 }), InvalidToolCallError);
  const second = setup('run-2');
  await assert.rejects(() => new AdvisorOrchestrator(second.rpc, new EmptySession()).execute({ run_id: 'run-2', execution_id: 'e', lease_epoch: 1 }), InvalidToolCallError);
  assert.equal(second.rpc.calls.some((call) => call.tool === 'emit_research_report'), false);
});

test('same idempotency key does not call Python RPC twice', async () => {
  const { rpc, orchestrator } = setup();
  const envelope = { run_id: 'run-1', execution_id: 'e', lease_epoch: 1, expected_state_version: 0, idempotency_key: 'idem', tool: 'fetch_market_snapshot' as const };
  await orchestrator.callTool(envelope);
  await orchestrator.callTool(envelope);
  assert.equal(rpc.calls.length, 1);
  assert.equal((await rpc.getState('run-1')).state_version, 1);
});

test('idempotency cache cannot bypass current lease or state-version validation', async () => {
  const { rpc, orchestrator } = setup();
  const envelope = { run_id: 'run-1', execution_id: 'e', lease_epoch: 1, expected_state_version: 0, idempotency_key: 'idem', tool: 'fetch_market_snapshot' as const };
  await orchestrator.callTool(envelope);
  rpc.seed({ run_id: 'run-1', state: AdvisorRunState.MARKET_READY, state_version: 1, lease_epoch: 2, artifacts: { reference_registry: referenceRegistry } });
  await assert.rejects(() => orchestrator.callTool(envelope), LeaseConflictError);
  rpc.seed({ run_id: 'run-1', state: AdvisorRunState.MARKET_READY, state_version: 2, lease_epoch: 1, artifacts: { reference_registry: referenceRegistry } });
  await assert.rejects(() => orchestrator.callTool(envelope), LeaseConflictError);
  assert.equal(rpc.calls.length, 1);
});

test('idempotency cache rejects a changed tool, execution, or expected version', async () => {
  const rpc = new FakePythonRpc();
  rpc.seed({ run_id: 'run-1', state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1, artifacts: { reference_registry: referenceRegistry } });
  const orchestrator = new AdvisorOrchestrator(rpc, new FakeSession(), { max_invalid_calls: 10 });
  const envelope = { run_id: 'run-1', execution_id: 'e', lease_epoch: 1, expected_state_version: 0, idempotency_key: 'idem', tool: 'fetch_market_snapshot' as const };
  await orchestrator.callTool(envelope);
  await assert.rejects(() => orchestrator.callTool({ ...envelope, tool: 'run_chan_analysis' }), InvalidToolCallError);
  await assert.rejects(() => orchestrator.callTool({ ...envelope, execution_id: 'other' }), InvalidToolCallError);
  await assert.rejects(() => orchestrator.callTool({ ...envelope, expected_state_version: 1 }), InvalidToolCallError);
  assert.equal(rpc.calls.length, 1);
});

test('wall-clock deadline after model output prevents report persistence', async () => {
  const rpc = new FakePythonRpc();
  rpc.seed({
    run_id: 'run-slow', state: AdvisorRunState.EVIDENCE_READY, state_version: 3, lease_epoch: 1,
    artifacts: {
      reference_registry: referenceRegistry,
      market: { snapshot_id: 'market-1' },
      chan: { analysis_id: 'chan-1' },
      evidence: { information: { evidence_id: 'information-1' } },
    },
  });
  const orchestrator = new AdvisorOrchestrator(rpc, new SlowDraftSession(), { max_duration_ms: 1 });
  await assert.rejects(() => orchestrator.execute({ run_id: 'run-slow', execution_id: 'e', lease_epoch: 1 }), BudgetExceededError);
  assert.equal((await rpc.getState('run-slow')).state, AdvisorRunState.EVIDENCE_READY);
  assert.equal(rpc.calls.some((call) => call.tool === 'emit_research_report'), false);
});

test('wall-clock deadline after RPC output prevents state persistence', async () => {
  const rpc = new SlowFetchRpc();
  rpc.seed({ run_id: 'run-slow-fetch', state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1, artifacts: { reference_registry: referenceRegistry } });
  const orchestrator = new AdvisorOrchestrator(rpc, new FakeSession(), { max_duration_ms: 1 });
  await assert.rejects(() => orchestrator.execute({ run_id: 'run-slow-fetch', execution_id: 'e', lease_epoch: 1 }), BudgetExceededError);
  assert.equal((await rpc.getState('run-slow-fetch')).state, AdvisorRunState.QUEUED);
});

test('budgets reject exhausted turns or a fourth valid call when limit is three', async () => {
  const { rpc, orchestrator } = setup();
  await assert.rejects(() => orchestrator.execute({ run_id: 'run-1', execution_id: 'e', lease_epoch: 1, max_turns: 0 }), BudgetExceededError);
  rpc.seed({ run_id: 'run-2', state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1, artifacts: { reference_registry: referenceRegistry } });
  await assert.rejects(() => new AdvisorOrchestrator(rpc, new FakeSession(), { max_valid_calls: 3 }).execute({ run_id: 'run-2', execution_id: 'e', lease_epoch: 1 }), BudgetExceededError);
});

test('recovery resumes from persisted state and rejects stale lease or state version', async () => {
  const { rpc } = setup();
  rpc.seed({ run_id: 'run-3', state: AdvisorRunState.MARKET_READY, state_version: 1, lease_epoch: 3, artifacts: { reference_registry: referenceRegistry, market: { snapshot_id: 'market-1' }, timeframe: '1w' } });
  const orchestrator = new AdvisorOrchestrator(rpc, new DraftSession(report('run-3')));
  const result = await orchestrator.execute({ run_id: 'run-3', execution_id: 'e', lease_epoch: 3, expected_state_version: 1 });
  assert.equal(result.state, AdvisorRunState.COMPLETED);
  assert.deepEqual(rpc.calls.map((call) => call.tool), ['run_chan_analysis', 'collect_information_evidence', 'emit_research_report']);
  await assert.rejects(() => orchestrator.execute({ run_id: 'run-3', execution_id: 'e2', lease_epoch: 2 }), LeaseConflictError);
  await assert.rejects(() => orchestrator.execute({ run_id: 'run-3', execution_id: 'e3', lease_epoch: 3, expected_state_version: 2 }), LeaseConflictError);
});
