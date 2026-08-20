import {
  AdvisorRunState, TOOL_NAMES, type AdvisorRun, type ReferenceRegistry, type ReportDraftV2, type ToolEnvelope, type ToolName,
  validateReportDraftV2,
} from '../../../packages/contracts/src/index.js';
import type { PythonRpcPort } from './rpc.js';
import { isReportDraftV2Candidate } from './pi-session.js';

export interface PiSessionPort { run(input: unknown): Promise<unknown> }
export interface ExecuteInput { run_id: string; execution_id: string; lease_epoch: number; expected_state_version?: number; max_turns?: number }
export interface ExecuteResult extends AdvisorRun { report?: ReportDraftV2 }
export interface OrchestratorOptions { max_turns?: number; max_valid_calls?: number; max_invalid_calls?: number; max_duration_ms?: number }

export class InvalidToolCallError extends Error { constructor(message: string) { super(message); this.name = 'InvalidToolCallError'; } }
export class InvalidModelOutputError extends InvalidToolCallError { constructor(message = 'model returned an invalid report') { super(message); this.name = 'InvalidModelOutputError'; } }
export class BudgetExceededError extends Error {
  readonly reason: 'wall-clock' | 'budget';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
    this.reason = message === 'wall-clock budget exhausted' ? 'wall-clock' : 'budget';
  }
}
export class LeaseConflictError extends Error { constructor(message: string) { super(message); this.name = 'LeaseConflictError'; } }

type CallInput = ToolEnvelope & { tool: ToolName; report?: ReportDraftV2 };
interface IdempotencyRecord {
  result: unknown;
  lease_epoch: number;
  expected_state_version: number;
  resulting_state_version: number;
  tool: ToolName;
  execution_id: string;
}

interface ExecutionBudget {
  turns: number;
  validCalls: number;
  invalidCalls: number;
  maxTurns: number;
  deadlineAt?: number;
}

export class AdvisorOrchestrator {
  private readonly idempotent = new Map<string, IdempotencyRecord>();
  private readonly options: Required<OrchestratorOptions>;

  constructor(private readonly rpc: PythonRpcPort, private readonly session: PiSessionPort, options: OrchestratorOptions = {}) {
    this.options = { max_turns: options.max_turns ?? 8, max_valid_calls: options.max_valid_calls ?? 7, max_invalid_calls: options.max_invalid_calls ?? 2, max_duration_ms: options.max_duration_ms ?? 240_000 };
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const startedAt = Date.now();
    const budget: ExecutionBudget = {
      turns: 0,
      validCalls: 0,
      invalidCalls: 0,
      maxTurns: input.max_turns ?? this.options.max_turns,
      deadlineAt: startedAt + this.options.max_duration_ms,
    };
    if (budget.maxTurns < 1) throw new BudgetExceededError('turn budget exhausted');
    let state = await this.rpc.getState(input.run_id);
    this.assertLease(state, input.lease_epoch);
    if (input.expected_state_version !== undefined && state.state_version !== input.expected_state_version) throw new LeaseConflictError(`state version conflict: expected ${input.expected_state_version}, got ${state.state_version}`);
    if (state.state === AdvisorRunState.COMPLETED) return state as ExecuteResult;
    while (state.state !== AdvisorRunState.COMPLETED) {
      this.checkDeadline(budget);
      this.checkCallBudget(budget, 'execution');
      const tool = this.nextTool(state);
      let report: ReportDraftV2 | undefined;
      if (tool === 'emit_research_report') {
        const draft = await this.session.run({ tool, state });
        this.checkDeadline(budget);
        if (!isReportDraftV2Candidate(draft)) throw new InvalidModelOutputError();
        report = draft;
      }
      const envelope: CallInput = {
        run_id: input.run_id,
        execution_id: input.execution_id,
        lease_epoch: input.lease_epoch,
        expected_state_version: state.state_version,
        idempotency_key: `${input.execution_id}:${state.state_version}:${tool}`,
        tool,
        ...(report ? { report } : {}),
      };
      const result = await this.callToolWithBudget(envelope, budget);
      state = await this.rpc.getState(input.run_id);
      if (tool === 'emit_research_report') (state as ExecuteResult).report = result as ReportDraftV2;
    }
    return state as ExecuteResult;
  }

  async callTool(input: CallInput): Promise<unknown> {
    return this.callToolWithBudget(input, this.createStandaloneBudget());
  }

  private async callToolWithBudget(input: CallInput, budget: ExecutionBudget): Promise<unknown> {
    const cacheKey = `${input.run_id}:${input.idempotency_key}`;
    const state = await this.rpc.getState(input.run_id);
    try {
      this.assertLease(state, input.lease_epoch);
      const cached = this.idempotent.get(cacheKey);
      if (cached !== undefined) {
        if (cached.lease_epoch !== input.lease_epoch
          || cached.expected_state_version !== input.expected_state_version
          || cached.tool !== input.tool
          || cached.execution_id !== input.execution_id) {
          throw new InvalidToolCallError('idempotency envelope does not match recorded call');
        }
        if (state.state_version !== cached.resulting_state_version) throw new LeaseConflictError(`state version conflict: expected ${cached.resulting_state_version}, got ${state.state_version}`);
        return cached.result;
      }
      if (state.state_version !== input.expected_state_version) throw new LeaseConflictError(`state version conflict: expected ${input.expected_state_version}, got ${state.state_version}`);
      if (!TOOL_NAMES.includes(input.tool)) throw new InvalidToolCallError(`tool is not allowlisted: ${input.tool}`);
      if (input.tool !== this.nextTool(state)) throw new InvalidToolCallError(`tool ${input.tool} is not valid in ${state.state}`);
      this.checkCallBudget(budget, 'call');
      budget.turns += 1;
      budget.validCalls += 1;
      const result = await this.dispatch(input);
      this.checkDeadline(budget);
      const next = this.advanceState(state, input.tool, result);
      await this.rpc.saveState(next);
      this.idempotent.set(cacheKey, {
        result,
        lease_epoch: input.lease_epoch,
        expected_state_version: input.expected_state_version,
        resulting_state_version: next.state_version,
        tool: input.tool,
        execution_id: input.execution_id,
      });
      return result;
    } catch (error) {
      if (error instanceof InvalidToolCallError) {
        budget.invalidCalls += 1;
        if (budget.invalidCalls > this.options.max_invalid_calls) throw new BudgetExceededError('invalid call budget exhausted');
      }
      throw error;
    }
  }

  private assertLease(state: AdvisorRun, leaseEpoch: number) {
    if (state.lease_epoch !== leaseEpoch) throw new LeaseConflictError(`lease epoch conflict: expected ${state.lease_epoch}, got ${leaseEpoch}`);
  }

  private createStandaloneBudget(): ExecutionBudget {
    return { turns: 0, validCalls: 0, invalidCalls: 0, maxTurns: this.options.max_turns };
  }

  private checkDeadline(budget: ExecutionBudget) {
    if (budget.deadlineAt !== undefined && Date.now() >= budget.deadlineAt) throw new BudgetExceededError('wall-clock budget exhausted');
  }

  private checkCallBudget(budget: ExecutionBudget, phase: 'execution' | 'call') {
    if (budget.turns >= budget.maxTurns) throw new BudgetExceededError(phase === 'execution' ? 'turn budget exhausted' : 'call budget exhausted');
    if (budget.validCalls >= this.options.max_valid_calls) throw new BudgetExceededError(phase === 'execution' ? 'valid call budget exhausted' : 'call budget exhausted');
  }

  private nextTool(state: AdvisorRun): ToolName {
    if (state.state === AdvisorRunState.QUEUED) return 'fetch_market_snapshot';
    if (state.state === AdvisorRunState.MARKET_READY) return 'run_chan_analysis';
    if (state.state === AdvisorRunState.CHAN_READY) return 'collect_information_evidence';
    if (state.state === AdvisorRunState.EVIDENCE_READY) return 'emit_research_report';
    throw new InvalidToolCallError('run is already completed');
  }

  private async dispatch(input: CallInput): Promise<unknown> {
    if (input.tool === 'fetch_market_snapshot') return this.rpc.fetch_market_snapshot(input);
    if (input.tool === 'run_chan_analysis') return this.rpc.run_chan_analysis(input);
    if (input.tool === 'collect_information_evidence') return this.rpc.collect_information_evidence(input);
    const current = await this.rpc.getState(input.run_id);
    const artifacts = current.artifacts ?? {};
    const market = artifacts.market;
    const chan = artifacts.chan;
    const evidence = artifacts.evidence;
    const registry = artifacts.reference_registry;
    if (!market || typeof market !== 'object' || !('snapshot_id' in market) || typeof market.snapshot_id !== 'string') throw new InvalidToolCallError('market snapshot is required before emit');
    if (!chan || typeof chan !== 'object' || !('analysis_id' in chan) || typeof chan.analysis_id !== 'string') throw new InvalidToolCallError('chan analysis is required before emit');
    if (!evidence || typeof evidence !== 'object' || !('information' in evidence) || !evidence.information) throw new InvalidToolCallError('information evidence is required before emit');
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new InvalidToolCallError('reference registry is required before emit');
    if (!input.report) throw new InvalidModelOutputError();
    if (input.report.run_id !== input.run_id) throw new InvalidModelOutputError('report run_id does not match execution run');
    const checked = validateReportDraftV2(input.report, registry as ReferenceRegistry);
    if (!checked.ok) throw new InvalidModelOutputError(checked.errors.join('; '));
    return this.rpc.emit_research_report({ ...input, report: input.report });
  }

  private advanceState(state: AdvisorRun, tool: ToolName, result: unknown): AdvisorRun {
    const artifacts = structuredClone(state.artifacts ?? {}) as Record<string, unknown>;
    if (tool === 'fetch_market_snapshot') artifacts.market = result;
    if (tool === 'run_chan_analysis') artifacts.chan = result;
    if (tool === 'collect_information_evidence') artifacts.evidence = { information: result };
    if (tool === 'emit_research_report') artifacts.report = result;
    const nextState = tool === 'fetch_market_snapshot' ? AdvisorRunState.MARKET_READY
      : tool === 'run_chan_analysis' ? AdvisorRunState.CHAN_READY
        : tool === 'collect_information_evidence' ? AdvisorRunState.EVIDENCE_READY
          : AdvisorRunState.COMPLETED;
    return { ...state, state: nextState, state_version: state.state_version + 1, artifacts };
  }
}
