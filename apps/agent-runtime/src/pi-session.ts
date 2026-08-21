import { AdvisorRunState, REPORT_DRAFT_V2_JSON_SCHEMA, type AdvisorRun, type ReferenceKind, type ReportDraftV2 } from '../../../packages/contracts/src/index.js';
import type { PiSessionPort } from './orchestrator.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface PiSessionConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  api?: 'openai-completions';
  sessionOptions: {
    thinkingLevel: 'off';
    noTools: 'builtin';
    tools: ['emit_research_report'];
    excludeTools: string[];
  };
}

interface CustomModelConfig {
  id: string;
  name: string;
  api: 'openai-completions';
  reasoning: true;
  thinkingLevelMap?: { off: 'none' };
  input: ['text'];
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  contextWindow: 128_000;
  maxTokens: 8_192;
  compat: {
    supportsDeveloperRole: false;
    maxTokensField: 'max_tokens';
    thinkingFormat?: 'zai';
  };
}

export const REPORT_TOOL_NAME = 'emit_research_report';

const REPORT_TOOL_PARAMETERS = REPORT_DRAFT_V2_JSON_SCHEMA;

function isGlm5Model(model: unknown): model is string {
  return typeof model === 'string' && /^glm-5(?:[._-]|$)/iu.test(model);
}

export function buildPiSessionConfig(env: Record<string, string | undefined> = process.env): PiSessionConfig {
  const provider = env.PI_PROVIDER;
  const model = env.PI_MODEL;
  const apiKey = env.PI_API_KEY;
  if (!provider) throw new Error('PI_PROVIDER is required');
  if (!model) throw new Error('PI_MODEL is required');
  if (!apiKey) throw new Error('PI_API_KEY is required');
  const baseUrl = env.PI_BASE_URL?.trim().replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '');
  return {
    provider,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl, api: 'openai-completions' as const } : {}),
    sessionOptions: {
      thinkingLevel: 'off',
      noTools: 'builtin',
      tools: [REPORT_TOOL_NAME],
      excludeTools: ['read', 'bash', 'write', 'edit', 'skills', 'context'],
    },
  };
}

export function buildCustomModelConfig(config: PiSessionConfig): CustomModelConfig {
  const isGlm = isGlm5Model(config.model);
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    reasoning: true,
    ...(isGlm ? { thinkingLevelMap: { off: 'none' as const } } : {}),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      ...(isGlm ? { thinkingFormat: 'zai' as const } : {}),
    },
  };
}

export function buildReportPrompt(input: { tool: string; state: AdvisorRun }): string {
  const registry = buildSafeReferenceRegistry(input.state.artifacts?.reference_registry);
  const safeArtifacts = buildSafePromptArtifacts(input.state.artifacts, registry);
  const informationReferences = new Set(
    safeArtifacts.evidence?.information.claims.map((claim) => claim.source_ref) ?? [],
  );
  const allowedReferences = sanitizePromptValue(Object.values(registry)
    .filter((entry) => entry.ref.startsWith('market.') || entry.ref.startsWith('chan.') || informationReferences.has(entry.ref))
    .map((entry) => ({ ref: entry.ref, label: entry.label, kind: entry.kind })));
  return [
    '你是受约束的研究报告撰写器。',
    `当前允许的工具：${REPORT_TOOL_NAME}。`,
    '只在当前工具等于 emit_research_report 时调用该工具；不要调用任何其他工具。',
    `run_id 必须严格使用：${input.state.run_id}。`,
    `允许的引用（ref、label、kind）：${JSON.stringify(allowedReferences)}。`,
    '不要新增事实、价格、日期或证据引用；所有 fact_ref 和 evidence_refs 只能从允许引用中选择。',
    '顶层 evidence_refs 与全部情景加风险的引用并集，都必须覆盖 market、chan、information 三类证据。',
    '标题必须严格等于“结构与资讯证据展望”。',
    'title、executive_summary、outlook.thesis、每个 scenario.narrative、每个 risk.narrative 都不得出现任何 Unicode 数字字符，包括阿拉伯数字、全角数字和其他文字体系数字。',
    '这些叙述字段禁止出现证券代码、日期、期限、百分比、数值或序号；只能通过 fact_ref 和 evidence_refs 引用既有事实。',
    '必须各生成一个看多、基准、看空情景。条件只使用 fact_ref，不得自带模型生成数字。',
    '同一情景的触发条件与失效条件若引用同一事实，不得互为逻辑补集，也不得使用相同算子；否则触发一旦成立，失效条件永远无法成立，该情景无法被否证。',
    '基准（震荡）情景的失效条件必须指向相反方向的边界：触发为收盘不越过上边界时，失效应为向下突破下边界；这样一旦走出单边行情，基准情景会被正确否证，与看多、看空情景互斥。',
    '触发条件与失效条件都必须在固化时点尚未被解决：向上突破只能指向最新固化收盘尚未越过的水平，向下跌破只能指向最新固化收盘尚未跌破的水平，保持上方只能指向最新固化收盘仍在其上方的水平，保持下方只能指向最新固化收盘仍在其下方的水平。',
    '不得引用已被突破或已被跌破的水平：这样的条件在展望窗口第一根 K 线上就已经成立，情景只是复述既成事实，没有预测力，服务端会拒收整份报告。',
    '允许引用里没有中枢上沿与下沿时，说明最新固化收盘已经离开全部中枢区间；此时必须改用允许引用中的近端高低价水平当边界，绝不能凭印象写出不在允许引用里的 ref。',
    '报告文本中禁止出现这些词，即使是在否定句或风险提示中也不要出现：买入、卖出、做多、做空、仓位、止损、目标价、收益率、回报率、当前价格、股价、价格为、price、buy、sell、position、stop-loss、target price、return。',
    '不要解释交易限制，不要写免责声明；服务端会统一添加免责声明。',
    '报告必须保持中性研究语气，并在工具参数中提交完整 ReportDraftV2。',
    `当前状态：${JSON.stringify(sanitizePromptValue({ run_id: input.state.run_id, state: input.state.state, artifacts: safeArtifacts }))}`,
  ].join('\n');
}

type PromptInformationClaim = { claim: string; source_ref: string };

interface SafeReferenceEntry {
  ref: string;
  kind: ReferenceKind;
  label: string;
}

type SafeReferenceRegistry = Record<string, SafeReferenceEntry>;

const REFERENCE_KINDS = new Set<ReferenceKind>([
  'market', 'price_level', 'structure', 'news', 'irm', 'hot', 'information_quality',
]);

interface SafeInformationArtifact {
  kind?: string;
  evidence_id?: string;
  claims: PromptInformationClaim[];
}

interface SafePromptArtifacts {
  market?: {
    snapshot_id?: string;
    as_of?: string;
    observations: Array<{ instrument_ref: string; metric: string; value: string }>;
  };
  chan?: {
    analysis_id?: string;
    signal_summary?: string;
    evidence_refs: string[];
  };
  evidence?: {
    information: SafeInformationArtifact;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildSafeReferenceRegistry(value: unknown): SafeReferenceRegistry {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (!isObject(candidate)) return [];
    const ref = optionalString(candidate.ref);
    const label = optionalString(candidate.label);
    const kind = optionalString(candidate.kind);
    if (ref !== key || !label || !kind || !REFERENCE_KINDS.has(kind as ReferenceKind)) return [];
    return [[key, { ref, label, kind: kind as ReferenceKind }]];
  }));
}

function buildSafePromptArtifacts(artifacts: AdvisorRun['artifacts'], registry: SafeReferenceRegistry): SafePromptArtifacts {
  if (!isObject(artifacts)) return {};
  const market = buildSafeMarketArtifact(artifacts.market);
  const chan = buildSafeChanArtifact(artifacts.chan);
  const evidence = buildSafeInformationEvidence(artifacts.evidence, registry);
  return {
    ...(market ? { market } : {}),
    ...(chan ? { chan } : {}),
    ...(evidence ? { evidence: { information: evidence } } : {}),
  };
}

function buildSafeMarketArtifact(value: unknown): SafePromptArtifacts['market'] {
  if (!isObject(value)) return undefined;
  const observations = Array.isArray(value.observations)
    ? value.observations.flatMap((observation) => {
      if (!isObject(observation)) return [];
      const instrument_ref = optionalString(observation.instrument_ref);
      const metric = optionalString(observation.metric);
      const observationValue = optionalString(observation.value);
      return instrument_ref && metric && observationValue !== undefined
        ? [{ instrument_ref, metric, value: observationValue }]
        : [];
    })
    : [];
  return {
    ...(optionalString(value.snapshot_id) ? { snapshot_id: optionalString(value.snapshot_id) } : {}),
    ...(optionalString(value.as_of) ? { as_of: optionalString(value.as_of) } : {}),
    observations,
  };
}

function buildSafeChanArtifact(value: unknown): SafePromptArtifacts['chan'] {
  if (!isObject(value)) return undefined;
  return {
    ...(optionalString(value.analysis_id) ? { analysis_id: optionalString(value.analysis_id) } : {}),
    ...(optionalString(value.signal_summary) ? { signal_summary: optionalString(value.signal_summary) } : {}),
    evidence_refs: Array.isArray(value.evidence_refs)
      ? value.evidence_refs.filter((ref): ref is string => typeof ref === 'string')
      : [],
  };
}

function buildSafeInformationEvidence(value: unknown, registry: SafeReferenceRegistry): SafeInformationArtifact | undefined {
  if (!isObject(value) || !isObject(value.information)) return undefined;
  return {
    ...(optionalString(value.information.kind) ? { kind: optionalString(value.information.kind) } : {}),
    ...(optionalString(value.information.evidence_id) ? { evidence_id: optionalString(value.information.evidence_id) } : {}),
    claims: selectInformationClaims(value.information.claims, registry),
  };
}

type InformationReferenceKind = 'news' | 'irm' | 'hot' | 'information_quality';

function informationReferenceKind(sourceRef: string): InformationReferenceKind | undefined {
  if (sourceRef.startsWith('news.')) return 'news';
  if (sourceRef.startsWith('irm.')) return 'irm';
  if (sourceRef.startsWith('hot.')) return 'hot';
  if (sourceRef === 'information.quality' || sourceRef.startsWith('information.quality.')) return 'information_quality';
  return undefined;
}

function selectInformationClaims(value: unknown, registry: SafeReferenceRegistry): PromptInformationClaim[] {
  if (!Array.isArray(value)) return [];
  const limits = { news: 5, irm: 3, hot: 2, information_quality: 1 };
  const counts = { news: 0, irm: 0, hot: 0, information_quality: 0 };
  const selected: PromptInformationClaim[] = [];
  for (const candidate of value) {
    if (selected.length >= 10) break;
    if (!isObject(candidate)) continue;
    const claim = optionalString(candidate.claim);
    const sourceRef = optionalString(candidate.source_ref);
    if (!claim || !sourceRef) continue;
    const kind = informationReferenceKind(sourceRef);
    if (!kind || registry[sourceRef]?.kind !== kind || Array.from(claim).length > 400 || counts[kind] >= limits[kind]) continue;
    counts[kind] += 1;
    selected.push({ claim, source_ref: sourceRef });
  }
  return selected;
}

function sanitizePromptValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/(?<![A-Za-z0-9+.-])(?:\/\/|www\.|[A-Za-z][A-Za-z0-9+.-]*:)[^\s"'<>]+/giu, '[omitted]');
  }
  if (Array.isArray(value)) return value.map(sanitizePromptValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'url').map(([key, item]) => [key, sanitizePromptValue(item)]));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isCondition(value: unknown): boolean {
  return hasExactKeys(value, ['operator', 'fact_ref']) && typeof value.operator === 'string' && typeof value.fact_ref === 'string';
}

function isRefs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((ref) => typeof ref === 'string');
}

export function isReportDraftV2Candidate(value: unknown): value is ReportDraftV2 {
  if (!hasExactKeys(value, ['version', 'run_id', 'title', 'executive_summary', 'outlook', 'risks', 'evidence_refs'])) return false;
  if (value.version !== 'ReportDraftV2' || typeof value.run_id !== 'string' || typeof value.title !== 'string' || typeof value.executive_summary !== 'string' || !isRefs(value.evidence_refs)) return false;
  if (!hasExactKeys(value.outlook, ['horizon', 'direction', 'confidence', 'thesis', 'scenarios'])) return false;
  if (value.outlook.horizon !== '5-20-trading-days' || typeof value.outlook.direction !== 'string' || typeof value.outlook.confidence !== 'string' || typeof value.outlook.thesis !== 'string' || !Array.isArray(value.outlook.scenarios) || value.outlook.scenarios.length !== 3) return false;
  if (!value.outlook.scenarios.every((scenario) => hasExactKeys(scenario, ['case', 'narrative', 'trigger', 'invalidation', 'evidence_refs']) && typeof scenario.case === 'string' && typeof scenario.narrative === 'string' && isCondition(scenario.trigger) && isCondition(scenario.invalidation) && isRefs(scenario.evidence_refs))) return false;
  return Array.isArray(value.risks) && value.risks.every((risk) => hasExactKeys(risk, ['narrative', 'evidence_refs']) && typeof risk.narrative === 'string' && isRefs(risk.evidence_refs));
}

export function forceReportToolChoicePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const request = payload as { model?: unknown; tools?: unknown };
  if (!Array.isArray(request.tools)) return payload;
  const hasReportTool = request.tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const functionDefinition = (tool as { function?: unknown }).function;
    return Boolean(
      functionDefinition
      && typeof functionDefinition === 'object'
      && (functionDefinition as { name?: unknown }).name === REPORT_TOOL_NAME,
    );
  });
  if (!hasReportTool) return payload;
  return {
    ...request,
    ...(isGlm5Model(request.model) ? {
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    } : {}),
    tool_choice: 'required',
  };
}

export function forceReportToolChoiceExtension(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => forceReportToolChoicePayload(event.payload));
}

export function createReportTool(onDraft: (draft: ReportDraftV2) => void) {
  return {
    name: REPORT_TOOL_NAME,
    label: '提交研究报告',
    description: '提交只包含研究叙述和既有证据引用的 ReportDraftV2。不得生成或修改市场事实。',
    promptSnippet: '提交受证据引用约束的研究报告草稿',
    promptGuidelines: ['只引用状态中存在的 evidence_id', '不生成交易指令或新的价格事实'],
    parameters: REPORT_TOOL_PARAMETERS,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' } as const,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: unknown) => {
      if (!isReportDraftV2Candidate(params)) throw new Error('invalid ReportDraftV2');
      onDraft(params);
      return {
        content: [{ type: 'text', text: '报告草稿已捕获，等待服务端校验。' }],
        details: { captured: true },
        terminate: true,
      };
    },
  };
}

export async function createPiSession(env: Record<string, string | undefined> = process.env): Promise<PiSessionPort> {
  const config = buildPiSessionConfig(env);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  if (config.baseUrl) {
    modelRuntime.registerProvider(config.provider, {
      name: config.provider,
      baseUrl: config.baseUrl,
      api: config.api,
      apiKey: config.apiKey,
      models: [buildCustomModelConfig(config)],
    });
  }
  await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey, { allowNetwork: false });
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) throw new Error(`PI_MODEL is not available: ${config.provider}/${config.model}`);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: config.provider,
    defaultModel: config.model,
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 60_000, maxRetryDelayMs: 0 } },
  }, { projectTrusted: false });
  let latestDraft: ReportDraftV2 | undefined;
  const tool = createReportTool((draft) => { latestDraft = structuredClone(draft); });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
    extensionFactories: config.baseUrl ? [forceReportToolChoiceExtension] : [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '你是受约束的研究报告撰写器。',
  });
  await resourceLoader.reload();
  const result = await createAgentSession({
    modelRuntime,
    model,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
    ...config.sessionOptions,
    customTools: [tool as never],
  });
  return {
    run: async (input: unknown) => {
      latestDraft = undefined;
      const state: AdvisorRun = input && typeof input === 'object' && 'state' in input
        ? (input.state as AdvisorRun)
        : { state: AdvisorRunState.QUEUED, state_version: 0, run_id: 'unknown', lease_epoch: 0 };
      const toolName = input && typeof input === 'object' && 'tool' in input
        ? String(input.tool)
        : '';
      if (toolName !== REPORT_TOOL_NAME) return undefined;
      await result.session.prompt(buildReportPrompt({ tool: toolName, state }));
      return latestDraft;
    },
  };
}

export class LazyPiSession implements PiSessionPort {
  private session?: Promise<PiSessionPort>;
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async run(input: unknown) {
    this.session ??= createPiSession(this.env);
    return (await this.session).run(input);
  }
}
