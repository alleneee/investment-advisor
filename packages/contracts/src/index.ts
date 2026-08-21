export enum AdvisorRunState {
  QUEUED = 'QUEUED',
  MARKET_READY = 'MARKET_READY',
  CHAN_READY = 'CHAN_READY',
  EVIDENCE_READY = 'EVIDENCE_READY',
  COMPLETED = 'COMPLETED',
}

export const TOOL_NAMES = [
  'fetch_market_snapshot',
  'run_chan_analysis',
  'collect_information_evidence',
  'emit_research_report',
] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type EvidenceKind = 'fundamental' | 'information' | 'capital' | 'theme';

export interface AdvisorRun {
  run_id: string;
  state: AdvisorRunState;
  state_version: number;
  lease_epoch: number;
  artifacts?: Record<string, unknown>;
}

export interface ToolEnvelope {
  run_id: string;
  execution_id: string;
  lease_epoch: number;
  expected_state_version: number;
  idempotency_key: string;
}

export interface EvidenceClaim {
  claim: string;
  source_ref: string;
}

export interface EvidenceResult extends ToolEnvelope {
  kind: EvidenceKind;
  evidence_id: string;
  claims: EvidenceClaim[];
}
export type FundamentalEvidenceResult = EvidenceResult & { kind: 'fundamental' };
export type InformationEvidenceResult = EvidenceResult & { kind: 'information' };
export type CapitalEvidenceResult = EvidenceResult & { kind: 'capital' };
export type ThemeEvidenceResult = EvidenceResult & { kind: 'theme' };

export interface MarketSnapshotResult extends ToolEnvelope {
  snapshot_id: string;
  as_of: string;
  observations: Array<{ instrument_ref: string; metric: string; value: string }>;
}

export interface ChanAnalysisResult extends ToolEnvelope {
  analysis_id: string;
  signal_summary: string;
  evidence_refs: string[];
}

export interface ReportDraftV1 {
  version: 'ReportDraftV1';
  run_id: string;
  title: string;
  summary: string;
  sections: Array<{ heading: string; body: string }>;
  evidence_refs: string[];
}

export type ReferenceKind = 'market' | 'price_level' | 'structure' | 'news' | 'irm' | 'hot' | 'information_quality';

export interface ReferenceRegistryEntry {
  ref: string;
  kind: ReferenceKind;
  label: string;
  value: string | number | boolean | null;
  unit?: string;
  occurred_at?: string;
  url?: string;
}

export type ReferenceRegistry = Record<string, ReferenceRegistryEntry>;
export type ConditionOperator = 'break_above' | 'hold_above' | 'break_below' | 'hold_below' | 'structure_confirmed' | 'structure_invalidated';

export interface ConditionRef {
  operator: ConditionOperator;
  fact_ref: string;
}

export interface ReportScenarioV2 {
  case: 'bullish' | 'base' | 'bearish';
  narrative: string;
  trigger: ConditionRef;
  invalidation: ConditionRef;
  evidence_refs: string[];
}

export interface ReportDraftV2 {
  version: 'ReportDraftV2';
  run_id: string;
  title: string;
  executive_summary: string;
  outlook: {
    horizon: '5-20-trading-days';
    direction: 'bullish' | 'sideways' | 'bearish' | 'uncertain';
    confidence: 'low' | 'medium' | 'high';
    thesis: string;
    scenarios: [ReportScenarioV2, ReportScenarioV2, ReportScenarioV2];
  };
  risks: Array<{ narrative: string; evidence_refs: string[] }>;
  evidence_refs: string[];
}

export const REPORT_DRAFT_V1_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'run_id', 'title', 'summary', 'sections', 'evidence_refs'],
  properties: {
    version: { const: 'ReportDraftV1' },
    run_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['heading', 'body'],
        properties: { heading: { type: 'string' }, body: { type: 'string' } },
      },
    },
    evidence_refs: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } },
  },
} as const;

const REFERENCE_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } as const;
const CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operator', 'fact_ref'],
  properties: {
    operator: { enum: ['break_above', 'hold_above', 'break_below', 'hold_below', 'structure_confirmed', 'structure_invalidated'] },
    fact_ref: REFERENCE_SCHEMA,
  },
} as const;
const SCENARIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['case', 'narrative', 'trigger', 'invalidation', 'evidence_refs'],
  properties: {
    case: { enum: ['bullish', 'base', 'bearish'] },
    narrative: { type: 'string', minLength: 1 },
    trigger: CONDITION_SCHEMA,
    invalidation: CONDITION_SCHEMA,
    evidence_refs: { type: 'array', items: REFERENCE_SCHEMA },
  },
} as const;

export const REPORT_DRAFT_V2_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'run_id', 'title', 'executive_summary', 'outlook', 'risks', 'evidence_refs'],
  properties: {
    version: { const: 'ReportDraftV2' },
    run_id: REFERENCE_SCHEMA,
    title: { type: 'string', minLength: 1 },
    executive_summary: { type: 'string', minLength: 1 },
    outlook: {
      type: 'object',
      additionalProperties: false,
      required: ['horizon', 'direction', 'confidence', 'thesis', 'scenarios'],
      properties: {
        horizon: { const: '5-20-trading-days' },
        direction: { enum: ['bullish', 'sideways', 'bearish', 'uncertain'] },
        confidence: { enum: ['low', 'medium', 'high'] },
        thesis: { type: 'string', minLength: 1 },
        scenarios: { type: 'array', minItems: 3, maxItems: 3, items: SCENARIO_SCHEMA },
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['narrative', 'evidence_refs'],
        properties: {
          narrative: { type: 'string', minLength: 1 },
          evidence_refs: { type: 'array', items: REFERENCE_SCHEMA },
        },
      },
    },
    evidence_refs: { type: 'array', items: REFERENCE_SCHEMA },
  },
} as const;

export const ADVISOR_RUN_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['run_id', 'state', 'state_version', 'lease_epoch'],
  properties: {
    run_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    state: { enum: Object.values(AdvisorRunState) },
    state_version: { type: 'integer', minimum: 0 },
    lease_epoch: { type: 'integer', minimum: 0 },
    artifacts: { type: 'object' },
  },
} as const;

export const EVIDENCE_RESULT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'run_id', 'execution_id', 'lease_epoch', 'expected_state_version', 'idempotency_key', 'evidence_id', 'claims'],
  properties: {
    kind: { enum: ['fundamental', 'information', 'capital', 'theme'] },
    run_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    execution_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    lease_epoch: { type: 'integer', minimum: 0 },
    expected_state_version: { type: 'integer', minimum: 0 },
    idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    evidence_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    claims: { type: 'array' },
  },
} as const;

const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_SEMANTICS = /(买入|卖出|做多|做空|仓位|止损|目标价|收益率|回报率|保证收益|承诺收益|收益承诺|收益翻倍|当前价格|股价|价格为|price|buy|sell|position|stop[- ]?loss|target price|return)/iu;
const ARABIC_DIGIT = /\p{N}/u;
const PRICE_LEVEL_OPERATORS = new Set<ConditionOperator>(['break_above', 'hold_above', 'break_below', 'hold_below']);
const STRUCTURE_OPERATORS = new Set<ConditionOperator>(['structure_confirmed', 'structure_invalidated']);
// 同一事实上互为逻辑补集的算子：一旦触发成立，失效条件在数学上永远无法成立。
const COMPLEMENT_OPERATORS: Partial<Record<string, ConditionOperator>> = {
  hold_above: 'break_below',
  break_below: 'hold_above',
  hold_below: 'break_above',
  break_above: 'hold_below',
};
// 固化日收盘的引用：价格类条件的锚点。
const ANCHOR_REFERENCE = 'market.latest_close';
// 固化收盘落在哪一侧就意味着条件已经被解决：break_* 已经越线，hold_* 已被违反。
// 这类条件在展望窗口第一根 K 线上必然命中，只是复述既成事实，没有预测力。
// 注意 hold_above 在固化日收盘正好位于水平上方是正常且必要的，只有已跌破才无效。
// 与 apps/api/app/domain/report_outcome.py 的 condition_resolved_at_anchor 同一判据。
const ANCHOR_RESOLVED: Partial<Record<string, (anchor: number, level: number) => boolean>> = {
  break_above: (anchor, level) => anchor > level,
  break_below: (anchor, level) => anchor < level,
  hold_above: (anchor, level) => anchor < level,
  hold_below: (anchor, level) => anchor > level,
};

export function validateReferenceId(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_ID.test(value);
}

export function createEvidenceResult(input: EvidenceResult): EvidenceResult {
  if (!validateReferenceId(input.run_id) || !validateReferenceId(input.execution_id) || !validateReferenceId(input.evidence_id)) throw new Error('invalid reference id');
  if (!validateReferenceId(input.idempotency_key)) throw new Error('invalid idempotency key');
  if (!(['fundamental', 'information', 'capital', 'theme'] as string[]).includes(input.kind)) throw new Error('invalid evidence kind');
  if (!Number.isInteger(input.lease_epoch) || input.lease_epoch < 0 || !Number.isInteger(input.expected_state_version) || input.expected_state_version < 0) throw new Error('invalid state metadata');
  if (!input.claims.every((claim) => validateReferenceId(claim.source_ref))) throw new Error('invalid source reference');
  return structuredClone(input);
}

export function validateReportDraft(report: unknown, knownReferences: Set<string>): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!report || typeof report !== 'object') return { ok: false, errors: ['report must be an object'] };
  const candidate = report as Partial<ReportDraftV1>;
  const allowed = new Set(['version', 'run_id', 'title', 'summary', 'sections', 'evidence_refs']);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) errors.push(`additional property is not allowed: ${key}`);
  if (candidate.version !== 'ReportDraftV1') errors.push('version must be ReportDraftV1');
  if (!validateReferenceId(candidate.run_id)) errors.push('invalid run_id');
  if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.some((ref) => !validateReferenceId(ref) || !knownReferences.has(ref))) errors.push('unknown or invalid evidence reference');
  if (!Array.isArray(candidate.sections) || candidate.sections.some((section) => !section || typeof section !== 'object' || Object.keys(section).some((key) => key !== 'heading' && key !== 'body'))) errors.push('invalid section shape');
  const text = [candidate.title, candidate.summary, ...(candidate.sections ?? []).flatMap((section) => [section.heading, section.body])].filter((item): item is string => typeof item === 'string').join('\n');
  if (FORBIDDEN_SEMANTICS.test(text)) errors.push('forbidden price or trade semantics');
  return errors.length ? { ok: false, errors } : { ok: true };
}

type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function exactObject(value: unknown, required: readonly string[], errors: string[], name: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
    return false;
  }
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key))) errors.push(`${name} has invalid properties`);
  return true;
}

function validateRefs(value: unknown, registry: ReferenceRegistry, errors: string[], name: string): string[] {
  if (!Array.isArray(value) || value.some((ref) => !validateReferenceId(ref) || !registry[ref])) {
    errors.push(`${name} contains unknown or invalid references`);
    return [];
  }
  if (new Set(value).size !== value.length) errors.push(`${name} contains duplicate references`);
  return value as string[];
}

function hasEvidenceCoverage(refs: string[]): boolean {
  return refs.some((ref) => ref.startsWith('market.'))
    && refs.some((ref) => ref.startsWith('chan.'))
    && refs.some((ref) => /^(news\.|irm\.|hot\.|information\.quality(?:\.|$))/u.test(ref));
}

function validateNarrative(value: unknown, errors: string[], name: string): void {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${name} must be a non-empty string`);
  else if (FORBIDDEN_SEMANTICS.test(value) || ARABIC_DIGIT.test(value)) errors.push(`${name} contains forbidden trade, target, return, or numeric price semantics`);
}

function validateCondition(value: unknown, registry: ReferenceRegistry, errors: string[], name: string): void {
  if (!exactObject(value, ['operator', 'fact_ref'], errors, name)) return;
  const operator = value.operator;
  const factRef = value.fact_ref;
  if (typeof operator !== 'string' || (!PRICE_LEVEL_OPERATORS.has(operator as ConditionOperator) && !STRUCTURE_OPERATORS.has(operator as ConditionOperator))) {
    errors.push(`${name} has invalid operator`);
    return;
  }
  if (!validateReferenceId(factRef) || !registry[factRef]) {
    errors.push(`${name} has unknown fact_ref`);
    return;
  }
  const expectedKind: ReferenceKind = PRICE_LEVEL_OPERATORS.has(operator as ConditionOperator) ? 'price_level' : 'structure';
  if (registry[factRef].kind !== expectedKind) errors.push(`${name} fact_ref must reference ${expectedKind}`);
}

function numericLevel(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 注册表缺少 market.latest_close、类型不对或值不是数值时返回 undefined，锚点校验整项跳过：
// 精简夹具的注册表允许没有锚点，缺锚点不应导致拒收。
function anchorClose(registry: ReferenceRegistry): number | undefined {
  const entry = registry[ANCHOR_REFERENCE];
  if (!entry || typeof entry !== 'object' || entry.kind !== 'price_level') return undefined;
  return numericLevel(entry.value);
}

function validateConditionAnchor(value: unknown, registry: ReferenceRegistry, anchor: number | undefined, errors: string[], name: string): void {
  if (anchor === undefined || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const condition = value as Partial<ConditionRef>;
  const resolved = ANCHOR_RESOLVED[String(condition.operator)];
  const level = typeof condition.fact_ref === 'string' ? numericLevel(registry[condition.fact_ref]?.value) : undefined;
  if (resolved && level !== undefined && resolved(anchor, level)) {
    errors.push(`${name} references a level already resolved at the anchor close`);
  }
}

function validateConditionPair(trigger: unknown, invalidation: unknown, errors: string[], name: string): void {
  const first = trigger as Partial<ConditionRef> | null;
  const second = invalidation as Partial<ConditionRef> | null;
  if (!first || !second || typeof first.operator !== 'string' || typeof second.operator !== 'string') return;
  if (typeof first.fact_ref !== 'string' || first.fact_ref !== second.fact_ref) return;
  if (first.operator === second.operator || COMPLEMENT_OPERATORS[first.operator] === second.operator) {
    errors.push(`${name} trigger and invalidation must not be identical or logical complements on the same fact_ref`);
  }
}

function validateRegistry(registry: ReferenceRegistry, errors: string[]): void {
  const allowedKinds = new Set<ReferenceKind>(['market', 'price_level', 'structure', 'news', 'irm', 'hot', 'information_quality']);
  for (const [key, candidate] of Object.entries(registry)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push(`registry.${key} must be an object`);
      continue;
    }
    const entry = candidate as ReferenceRegistryEntry;
    if (!exactObject(entry, ['ref', 'kind', 'label', 'value', ...(['unit', 'occurred_at', 'url'].filter((field) => field in entry))], errors, `registry.${key}`)) continue;
    if (!validateReferenceId(key) || entry.ref !== key) errors.push(`registry key must equal entry.ref: ${key}`);
    if (!allowedKinds.has(entry.kind as ReferenceKind)) errors.push(`registry.${key} has invalid kind`);
    if (typeof entry.label !== 'string' || !['string', 'number', 'boolean'].includes(typeof entry.value) && entry.value !== null) errors.push(`registry.${key} has invalid label or value`);
    for (const optional of ['unit', 'occurred_at', 'url'] as const) if (entry[optional] !== undefined && typeof entry[optional] !== 'string') errors.push(`registry.${key}.${optional} must be a string`);
  }
}

export function validateReportDraftV2(report: unknown, registry: ReferenceRegistry): ValidationResult {
  const errors: string[] = [];
  validateRegistry(registry, errors);
  if (!exactObject(report, ['version', 'run_id', 'title', 'executive_summary', 'outlook', 'risks', 'evidence_refs'], errors, 'report')) return { ok: false, errors };
  if (report.version !== 'ReportDraftV2') errors.push('version must be ReportDraftV2');
  if (!validateReferenceId(report.run_id)) errors.push('invalid run_id');
  validateNarrative(report.title, errors, 'title');
  validateNarrative(report.executive_summary, errors, 'executive_summary');
  const topRefs = validateRefs(report.evidence_refs, registry, errors, 'evidence_refs');
  if (!hasEvidenceCoverage(topRefs)) errors.push('evidence_refs must cover market, chan, and information evidence');

  const narrativeRefs: string[] = [];
  const anchor = anchorClose(registry);
  if (exactObject(report.outlook, ['horizon', 'direction', 'confidence', 'thesis', 'scenarios'], errors, 'outlook')) {
    if (report.outlook.horizon !== '5-20-trading-days') errors.push('invalid outlook horizon');
    if (!['bullish', 'sideways', 'bearish', 'uncertain'].includes(String(report.outlook.direction))) errors.push('invalid outlook direction');
    if (!['low', 'medium', 'high'].includes(String(report.outlook.confidence))) errors.push('invalid outlook confidence');
    validateNarrative(report.outlook.thesis, errors, 'outlook.thesis');
    if (!Array.isArray(report.outlook.scenarios) || report.outlook.scenarios.length !== 3) errors.push('outlook.scenarios must contain exactly three scenarios');
    else {
      const cases: unknown[] = [];
      report.outlook.scenarios.forEach((scenario, index) => {
        if (!exactObject(scenario, ['case', 'narrative', 'trigger', 'invalidation', 'evidence_refs'], errors, `scenario.${index}`)) return;
        cases.push(scenario.case);
        validateNarrative(scenario.narrative, errors, `scenario.${index}.narrative`);
        validateCondition(scenario.trigger, registry, errors, `scenario.${index}.trigger`);
        validateCondition(scenario.invalidation, registry, errors, `scenario.${index}.invalidation`);
        validateConditionPair(scenario.trigger, scenario.invalidation, errors, `scenario.${index}`);
        validateConditionAnchor(scenario.trigger, registry, anchor, errors, `scenario.${index}.trigger`);
        validateConditionAnchor(scenario.invalidation, registry, anchor, errors, `scenario.${index}.invalidation`);
        narrativeRefs.push(...validateRefs(scenario.evidence_refs, registry, errors, `scenario.${index}.evidence_refs`));
      });
      if (new Set(cases).size !== 3 || !['bullish', 'base', 'bearish'].every((item) => cases.includes(item))) errors.push('scenario cases must be bullish, base, and bearish exactly once');
    }
  }

  if (!Array.isArray(report.risks)) errors.push('risks must be an array');
  else report.risks.forEach((risk, index) => {
    if (!exactObject(risk, ['narrative', 'evidence_refs'], errors, `risk.${index}`)) return;
    validateNarrative(risk.narrative, errors, `risk.${index}.narrative`);
    narrativeRefs.push(...validateRefs(risk.evidence_refs, registry, errors, `risk.${index}.evidence_refs`));
  });
  if (!hasEvidenceCoverage(narrativeRefs)) errors.push('scenario and risk references must cover market, chan, and information evidence');
  return errors.length ? { ok: false, errors } : { ok: true };
}
