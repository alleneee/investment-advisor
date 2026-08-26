export const BUY_REASON_CODES = [
  'structure_breakout',
  'pullback_confirmation',
  'trend_continuation',
  'reversal_expectation',
  'event_driven',
  'valuation_recovery',
  'oversold_rebound',
  'planned_add',
  'other',
] as const;

export const SELL_REASON_CODES = [
  'stop_loss',
  'take_profit',
  'structure_invalidated',
  'target_reached',
  'planned_reduce',
  'thesis_invalidated',
  'capital_reallocation',
  'discipline_violation',
  'other',
] as const;

export const ACCOUNT_METRIC_REFS = [
  'account.adjusted_return_rate',
  'account.period_max_drawdown_rate',
  'account.win_rate',
  'account.average_win_loss_ratio',
  'account.profit_factor',
  'account.median_holding_days',
  'account.median_capital_efficiency',
  'discipline.adherence_rate',
] as const;

const REASON_METRIC_SUFFIXES = ['sample_count', 'win_rate', 'average_cycle_return_rate'] as const;

export const REASON_METRIC_REFS = [
  ...BUY_REASON_CODES.flatMap((reason) => REASON_METRIC_SUFFIXES.map((suffix) => `reason.buy.${reason}.${suffix}`)),
  ...SELL_REASON_CODES.flatMap((reason) => REASON_METRIC_SUFFIXES.map((suffix) => `reason.sell.${reason}.${suffix}`)),
] as const;

export const COMPARISON_METRIC_REFS = ACCOUNT_METRIC_REFS.map((ref) => `comparison.${ref}`) as readonly `comparison.${AccountMetricRef}`[];

export const QUALITY_METRIC_REFS = [
  'quality.partial_period',
  'quality.missing_close_price',
  'quality.insufficient_sample',
] as const;

export const TRADING_REVIEW_METRIC_REFS = [
  ...ACCOUNT_METRIC_REFS,
  ...REASON_METRIC_REFS,
  ...COMPARISON_METRIC_REFS,
  ...QUALITY_METRIC_REFS,
] as const;

export const QUALITY_WARNING_CODES = [
  'partial_period',
  'missing_close_price',
  'insufficient_overall_sample',
  'insufficient_reason_sample',
  'missing_daily_review',
] as const;

export type BuyReasonCode = typeof BUY_REASON_CODES[number];
export type SellReasonCode = typeof SELL_REASON_CODES[number];
export type AccountMetricRef = typeof ACCOUNT_METRIC_REFS[number];
export type ReasonMetricRef = typeof REASON_METRIC_REFS[number];
export type ComparisonMetricRef = `comparison.${AccountMetricRef}`;
export type QualityMetricRef = typeof QUALITY_METRIC_REFS[number];
export type TradingReviewMetricRef = AccountMetricRef | ReasonMetricRef | ComparisonMetricRef | QualityMetricRef;
export type QualityWarningCode = typeof QUALITY_WARNING_CODES[number];

export interface TradingReviewModelInputV1 {
  schema_version: 'trading_review_model_input.v1';
  period: {
    kind: 'week' | 'month' | 'quarter' | 'year';
    trading_day_count: number;
    partial_period: boolean;
  };
  sample: {
    closed_cycle_count: number;
    overall_conclusion_allowed: boolean;
  };
  metrics: {
    account_adjusted_return_rate: number | null;
    period_max_drawdown_rate: number | null;
    win_rate: number | null;
    average_win_loss_ratio: number | null;
    profit_factor: number | null;
    median_holding_days: number | null;
    median_capital_efficiency: number | null;
    discipline_adherence_rate: number | null;
  };
  reason_groups: Array<{
    side: 'buy' | 'sell';
    reason_code: BuyReasonCode | SellReasonCode;
    sample_count: number;
    conclusion_allowed: boolean;
    win_rate: number | null;
    average_cycle_return_rate: number | null;
  }>;
  metric_registry: Array<{
    ref: TradingReviewMetricRef;
    value: number | boolean | null;
    conclusion_allowed: boolean;
  }>;
  cases: Array<{
    case_label: 'case_a' | 'case_b';
    cycle_return_rate: number;
    holding_days: number;
    buy_reason_code: BuyReasonCode;
    sell_reason_code: SellReasonCode;
    discipline_followed: boolean | null;
  }>;
  comparison: Array<{
    metric_ref: AccountMetricRef;
    delta: number | null;
  }> | null;
  quality_warnings: QualityWarningCode[];
}

export interface TradingReviewNarrativeEvidence {
  narrative: string;
  metric_refs: TradingReviewMetricRef[];
}

export interface TradingReviewDraftV1 {
  schema_version: 'trading_review_draft.v1';
  title: '周期交易复盘';
  profit_sources: TradingReviewNarrativeEvidence[];
  loss_patterns: TradingReviewNarrativeEvidence[];
  discipline_review: TradingReviewNarrativeEvidence;
  limitations: string[];
  next_period_experiment: {
    hypothesis: string;
    action: string;
    measurement: string;
    success_criterion: string;
    metric_refs: TradingReviewMetricRef[];
  };
}

const finiteNumberSchema = { type: 'number' } as const;
const nullableNumberSchema = { type: ['number', 'null'] } as const;
const boundedNullableNumberSchema = (minimum?: number, maximum?: number) => ({
  type: ['number', 'null'],
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});

const MODEL_METRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'account_adjusted_return_rate',
    'period_max_drawdown_rate',
    'win_rate',
    'average_win_loss_ratio',
    'profit_factor',
    'median_holding_days',
    'median_capital_efficiency',
    'discipline_adherence_rate',
  ],
  properties: {
    account_adjusted_return_rate: boundedNullableNumberSchema(-1),
    period_max_drawdown_rate: boundedNullableNumberSchema(0, 1),
    win_rate: boundedNullableNumberSchema(0, 1),
    average_win_loss_ratio: boundedNullableNumberSchema(0),
    profit_factor: boundedNullableNumberSchema(0),
    median_holding_days: boundedNullableNumberSchema(1),
    median_capital_efficiency: nullableNumberSchema,
    discipline_adherence_rate: boundedNullableNumberSchema(0, 1),
  },
} as const;

const NARRATIVE_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'metric_refs'],
  properties: {
    narrative: { type: 'string', minLength: 1 },
    metric_refs: { type: 'array', uniqueItems: true, items: { enum: TRADING_REVIEW_METRIC_REFS } },
  },
} as const;

export const TRADING_REVIEW_MODEL_INPUT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'period', 'sample', 'metrics', 'reason_groups', 'metric_registry', 'cases', 'comparison', 'quality_warnings'],
  properties: {
    schema_version: { const: 'trading_review_model_input.v1' },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'trading_day_count', 'partial_period'],
      properties: {
        kind: { enum: ['week', 'month', 'quarter', 'year'] },
        trading_day_count: { type: 'integer', minimum: 0 },
        partial_period: { type: 'boolean' },
      },
    },
    sample: {
      type: 'object',
      additionalProperties: false,
      required: ['closed_cycle_count', 'overall_conclusion_allowed'],
      properties: {
        closed_cycle_count: { type: 'integer', minimum: 0 },
        overall_conclusion_allowed: { type: 'boolean' },
      },
    },
    metrics: MODEL_METRICS_SCHEMA,
    reason_groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['side', 'reason_code', 'sample_count', 'conclusion_allowed', 'win_rate', 'average_cycle_return_rate'],
        properties: {
          side: { enum: ['buy', 'sell'] },
          reason_code: { enum: [...BUY_REASON_CODES, ...SELL_REASON_CODES] },
          sample_count: { type: 'integer', minimum: 0 },
          conclusion_allowed: { type: 'boolean' },
          win_rate: boundedNullableNumberSchema(0, 1),
          average_cycle_return_rate: nullableNumberSchema,
        },
      },
    },
    metric_registry: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'value', 'conclusion_allowed'],
        properties: {
          ref: { enum: TRADING_REVIEW_METRIC_REFS },
          value: { type: ['number', 'boolean', 'null'] },
          conclusion_allowed: { type: 'boolean' },
        },
      },
    },
    cases: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['case_label', 'cycle_return_rate', 'holding_days', 'buy_reason_code', 'sell_reason_code', 'discipline_followed'],
        properties: {
          case_label: { enum: ['case_a', 'case_b'] },
          cycle_return_rate: finiteNumberSchema,
          holding_days: { type: 'number', minimum: 1 },
          buy_reason_code: { enum: BUY_REASON_CODES },
          sell_reason_code: { enum: SELL_REASON_CODES },
          discipline_followed: { type: ['boolean', 'null'] },
        },
      },
    },
    comparison: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          minItems: ACCOUNT_METRIC_REFS.length,
          maxItems: ACCOUNT_METRIC_REFS.length,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['metric_ref', 'delta'],
            properties: {
              metric_ref: { enum: ACCOUNT_METRIC_REFS },
              delta: nullableNumberSchema,
            },
          },
        },
      ],
    },
    quality_warnings: { type: 'array', uniqueItems: true, items: { enum: QUALITY_WARNING_CODES } },
  },
} as const;

export const TRADING_REVIEW_DRAFT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'title', 'profit_sources', 'loss_patterns', 'discipline_review', 'limitations', 'next_period_experiment'],
  properties: {
    schema_version: { const: 'trading_review_draft.v1' },
    title: { const: '周期交易复盘' },
    profit_sources: { type: 'array', items: NARRATIVE_EVIDENCE_SCHEMA },
    loss_patterns: { type: 'array', items: NARRATIVE_EVIDENCE_SCHEMA },
    discipline_review: NARRATIVE_EVIDENCE_SCHEMA,
    limitations: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    next_period_experiment: {
      type: 'object',
      additionalProperties: false,
      required: ['hypothesis', 'action', 'measurement', 'success_criterion', 'metric_refs'],
      properties: {
        hypothesis: { type: 'string', minLength: 1 },
        action: { type: 'string', minLength: 1 },
        measurement: { type: 'string', minLength: 1 },
        success_criterion: { type: 'string', minLength: 1 },
        metric_refs: { type: 'array', uniqueItems: true, items: { enum: TRADING_REVIEW_METRIC_REFS } },
      },
    },
  },
} as const;

type ValidationResult = { ok: true } | { ok: false; errors: string[] };
type UnknownRecord = Record<string, unknown>;

const BUY_REASON_SET = new Set<string>(BUY_REASON_CODES);
const SELL_REASON_SET = new Set<string>(SELL_REASON_CODES);
const ACCOUNT_METRIC_SET = new Set<string>(ACCOUNT_METRIC_REFS);
const TRADING_REVIEW_METRIC_SET = new Set<string>(TRADING_REVIEW_METRIC_REFS);
const QUALITY_WARNING_SET = new Set<string>(QUALITY_WARNING_CODES);
const FORBIDDEN_NARRATIVE = /(?:建议|应当|应该|立即|直接)(?:买入|卖出)|(?:买入|卖出)(?:该股|股票)|仓位(?:比例)?|止损价|目标价|保证收益|承诺收益|收益翻倍|稳赚|必然(?:上涨|下跌)|确定(?:上涨|下跌|走势)|(?:buy|sell)\s+(?:this|the)\s+stock|position\s+size|stop[- ]?loss\s+price|target\s+price|guaranteed\s+return/iu;
const UNICODE_NUMBER = /\p{N}/u;

function exactObject(value: unknown, keys: readonly string[], errors: string[], path: string): value is UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) errors.push(`${path} has invalid properties`);
  return true;
}

function finiteNumber(value: unknown, errors: string[], path: string, options: { nullable?: boolean; integer?: boolean; minimum?: number; maximum?: number } = {}): value is number | null {
  if (value === null && options.nullable) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be finite`);
    return false;
  }
  if (options.integer && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
  if (options.minimum !== undefined && value < options.minimum) errors.push(`${path} is below minimum`);
  if (options.maximum !== undefined && value > options.maximum) errors.push(`${path} is above maximum`);
  return true;
}

function booleanValue(value: unknown, errors: string[], path: string, nullable = false): value is boolean | null {
  if (value === null && nullable) return true;
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
  return typeof value === 'boolean';
}

function validateNarrative(value: unknown, errors: string[], path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
  else if (FORBIDDEN_NARRATIVE.test(value) || UNICODE_NUMBER.test(value)) errors.push(`${path} contains forbidden instruction, promise, or number`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || left === null && right === null;
}

function expectedRegistry(input: TradingReviewModelInputV1): Map<string, { value: number | boolean | null; conclusion_allowed: boolean }> {
  const result = new Map<string, { value: number | boolean | null; conclusion_allowed: boolean }>();
  const metricValues: Record<AccountMetricRef, number | null> = {
    'account.adjusted_return_rate': input.metrics.account_adjusted_return_rate,
    'account.period_max_drawdown_rate': input.metrics.period_max_drawdown_rate,
    'account.win_rate': input.metrics.win_rate,
    'account.average_win_loss_ratio': input.metrics.average_win_loss_ratio,
    'account.profit_factor': input.metrics.profit_factor,
    'account.median_holding_days': input.metrics.median_holding_days,
    'account.median_capital_efficiency': input.metrics.median_capital_efficiency,
    'discipline.adherence_rate': input.metrics.discipline_adherence_rate,
  };
  for (const ref of ACCOUNT_METRIC_REFS) result.set(ref, { value: metricValues[ref], conclusion_allowed: input.sample.overall_conclusion_allowed && metricValues[ref] !== null });
  for (const group of input.reason_groups) {
    result.set(`reason.${group.side}.${group.reason_code}.sample_count`, { value: group.sample_count, conclusion_allowed: group.conclusion_allowed });
    result.set(`reason.${group.side}.${group.reason_code}.win_rate`, { value: group.win_rate, conclusion_allowed: group.conclusion_allowed && group.win_rate !== null });
    result.set(`reason.${group.side}.${group.reason_code}.average_cycle_return_rate`, { value: group.average_cycle_return_rate, conclusion_allowed: group.conclusion_allowed && group.average_cycle_return_rate !== null });
  }
  for (const item of input.comparison ?? []) result.set(`comparison.${item.metric_ref}`, { value: item.delta, conclusion_allowed: input.sample.overall_conclusion_allowed && item.delta !== null });
  result.set('quality.partial_period', { value: input.period.partial_period, conclusion_allowed: false });
  result.set('quality.missing_close_price', { value: input.quality_warnings.includes('missing_close_price'), conclusion_allowed: false });
  result.set('quality.insufficient_sample', { value: !input.sample.overall_conclusion_allowed, conclusion_allowed: false });
  return result;
}

export function validateTradingReviewModelInput(value: unknown): ValidationResult {
  const errors: string[] = [];
  const rootKeys = ['schema_version', 'period', 'sample', 'metrics', 'reason_groups', 'metric_registry', 'cases', 'comparison', 'quality_warnings'];
  if (!exactObject(value, rootKeys, errors, 'input')) return { ok: false, errors };
  if (value.schema_version !== 'trading_review_model_input.v1') errors.push('invalid schema_version');

  if (exactObject(value.period, ['kind', 'trading_day_count', 'partial_period'], errors, 'period')) {
    if (!['week', 'month', 'quarter', 'year'].includes(String(value.period.kind))) errors.push('period.kind is invalid');
    finiteNumber(value.period.trading_day_count, errors, 'period.trading_day_count', { integer: true, minimum: 0 });
    booleanValue(value.period.partial_period, errors, 'period.partial_period');
  }

  if (exactObject(value.sample, ['closed_cycle_count', 'overall_conclusion_allowed'], errors, 'sample')) {
    finiteNumber(value.sample.closed_cycle_count, errors, 'sample.closed_cycle_count', { integer: true, minimum: 0 });
    booleanValue(value.sample.overall_conclusion_allowed, errors, 'sample.overall_conclusion_allowed');
  }

  const metricKeys = ['account_adjusted_return_rate', 'period_max_drawdown_rate', 'win_rate', 'average_win_loss_ratio', 'profit_factor', 'median_holding_days', 'median_capital_efficiency', 'discipline_adherence_rate'];
  if (exactObject(value.metrics, metricKeys, errors, 'metrics')) {
    finiteNumber(value.metrics.account_adjusted_return_rate, errors, 'metrics.account_adjusted_return_rate', { nullable: true, minimum: -1 });
    finiteNumber(value.metrics.period_max_drawdown_rate, errors, 'metrics.period_max_drawdown_rate', { nullable: true, minimum: 0, maximum: 1 });
    finiteNumber(value.metrics.win_rate, errors, 'metrics.win_rate', { nullable: true, minimum: 0, maximum: 1 });
    finiteNumber(value.metrics.average_win_loss_ratio, errors, 'metrics.average_win_loss_ratio', { nullable: true, minimum: 0 });
    finiteNumber(value.metrics.profit_factor, errors, 'metrics.profit_factor', { nullable: true, minimum: 0 });
    finiteNumber(value.metrics.median_holding_days, errors, 'metrics.median_holding_days', { nullable: true, minimum: 1 });
    finiteNumber(value.metrics.median_capital_efficiency, errors, 'metrics.median_capital_efficiency', { nullable: true });
    finiteNumber(value.metrics.discipline_adherence_rate, errors, 'metrics.discipline_adherence_rate', { nullable: true, minimum: 0, maximum: 1 });
  }

  if (!Array.isArray(value.reason_groups)) errors.push('reason_groups must be an array');
  else {
    const identities = new Set<string>();
    value.reason_groups.forEach((group, index) => {
      if (!exactObject(group, ['side', 'reason_code', 'sample_count', 'conclusion_allowed', 'win_rate', 'average_cycle_return_rate'], errors, `reason_groups.${index}`)) return;
      const side = String(group.side);
      const reason = String(group.reason_code);
      if (side !== 'buy' && side !== 'sell') errors.push(`reason_groups.${index}.side is invalid`);
      if (side === 'buy' && !BUY_REASON_SET.has(reason) || side === 'sell' && !SELL_REASON_SET.has(reason)) errors.push(`reason_groups.${index}.reason_code does not match side`);
      const identity = `${side}.${reason}`;
      if (identities.has(identity)) errors.push(`reason_groups.${index} is duplicated`);
      identities.add(identity);
      finiteNumber(group.sample_count, errors, `reason_groups.${index}.sample_count`, { integer: true, minimum: 0 });
      booleanValue(group.conclusion_allowed, errors, `reason_groups.${index}.conclusion_allowed`);
      finiteNumber(group.win_rate, errors, `reason_groups.${index}.win_rate`, { nullable: true, minimum: 0, maximum: 1 });
      finiteNumber(group.average_cycle_return_rate, errors, `reason_groups.${index}.average_cycle_return_rate`, { nullable: true });
    });
  }

  if (!Array.isArray(value.cases) || value.cases.length > 2) errors.push('cases must contain at most two cases');
  else {
    const labels = new Set<string>();
    value.cases.forEach((candidate, index) => {
      if (!exactObject(candidate, ['case_label', 'cycle_return_rate', 'holding_days', 'buy_reason_code', 'sell_reason_code', 'discipline_followed'], errors, `cases.${index}`)) return;
      if (!['case_a', 'case_b'].includes(String(candidate.case_label)) || labels.has(String(candidate.case_label))) errors.push(`cases.${index}.case_label is invalid`);
      labels.add(String(candidate.case_label));
      finiteNumber(candidate.cycle_return_rate, errors, `cases.${index}.cycle_return_rate`);
      finiteNumber(candidate.holding_days, errors, `cases.${index}.holding_days`, { minimum: 1 });
      if (!BUY_REASON_SET.has(String(candidate.buy_reason_code))) errors.push(`cases.${index}.buy_reason_code is invalid`);
      if (!SELL_REASON_SET.has(String(candidate.sell_reason_code))) errors.push(`cases.${index}.sell_reason_code is invalid`);
      booleanValue(candidate.discipline_followed, errors, `cases.${index}.discipline_followed`, true);
    });
  }

  if (value.comparison !== null) {
    if (!Array.isArray(value.comparison) || value.comparison.length !== ACCOUNT_METRIC_REFS.length) errors.push('comparison must contain every account metric in fixed order');
    else value.comparison.forEach((item, index) => {
      if (!exactObject(item, ['metric_ref', 'delta'], errors, `comparison.${index}`)) return;
      if (item.metric_ref !== ACCOUNT_METRIC_REFS[index]) errors.push(`comparison.${index}.metric_ref is out of order`);
      finiteNumber(item.delta, errors, `comparison.${index}.delta`, { nullable: true });
    });
  }

  if (!Array.isArray(value.quality_warnings)) errors.push('quality_warnings must be an array');
  else {
    if (new Set(value.quality_warnings).size !== value.quality_warnings.length) errors.push('quality_warnings contains duplicates');
    if (value.quality_warnings.some((item) => typeof item !== 'string' || !QUALITY_WARNING_SET.has(item))) errors.push('quality_warnings contains an unknown code');
  }

  const candidate = value as unknown as TradingReviewModelInputV1;
  if (!Array.isArray(value.metric_registry)) errors.push('metric_registry must be an array');
  else {
    const expected = expectedRegistry(candidate);
    const seen = new Set<string>();
    value.metric_registry.forEach((entry, index) => {
      if (!exactObject(entry, ['ref', 'value', 'conclusion_allowed'], errors, `metric_registry.${index}`)) return;
      const ref = String(entry.ref);
      if (!TRADING_REVIEW_METRIC_SET.has(ref) || !expected.has(ref)) errors.push(`metric_registry.${index}.ref is unavailable`);
      if (seen.has(ref)) errors.push(`metric_registry.${index}.ref is duplicated`);
      seen.add(ref);
      if (entry.value !== null && typeof entry.value !== 'boolean') finiteNumber(entry.value, errors, `metric_registry.${index}.value`);
      booleanValue(entry.conclusion_allowed, errors, `metric_registry.${index}.conclusion_allowed`);
      const expectedEntry = expected.get(ref);
      if (expectedEntry && (!sameValue(entry.value, expectedEntry.value) || entry.conclusion_allowed !== expectedEntry.conclusion_allowed)) errors.push(`metric_registry.${index} contradicts source metrics`);
    });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateDraftRefs(value: unknown, registry: Map<string, boolean>, errors: string[], path: string): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} contains duplicates`);
  for (const ref of value) {
    if (typeof ref !== 'string' || !TRADING_REVIEW_METRIC_SET.has(ref) || !registry.has(ref)) errors.push(`${path} contains an unknown reference`);
    else if (!registry.get(ref)) errors.push(`${path} contains a reference without conclusion permission`);
  }
}

function validateNarrativeEvidence(value: unknown, registry: Map<string, boolean>, errors: string[], path: string): void {
  if (!exactObject(value, ['narrative', 'metric_refs'], errors, path)) return;
  validateNarrative(value.narrative, errors, `${path}.narrative`);
  validateDraftRefs(value.metric_refs, registry, errors, `${path}.metric_refs`);
}

export function validateTradingReviewDraft(value: unknown, input: TradingReviewModelInputV1): ValidationResult {
  const inputValidation = validateTradingReviewModelInput(input);
  if (!inputValidation.ok) return { ok: false, errors: inputValidation.errors.map((error) => `input: ${error}`) };
  const errors: string[] = [];
  const keys = ['schema_version', 'title', 'profit_sources', 'loss_patterns', 'discipline_review', 'limitations', 'next_period_experiment'];
  if (!exactObject(value, keys, errors, 'draft')) return { ok: false, errors };
  if (value.schema_version !== 'trading_review_draft.v1') errors.push('invalid draft schema_version');
  if (value.title !== '周期交易复盘') errors.push('title must be fixed');
  const registry = new Map(input.metric_registry.map((entry) => [entry.ref, entry.conclusion_allowed]));

  for (const field of ['profit_sources', 'loss_patterns'] as const) {
    const items = value[field];
    if (!Array.isArray(items)) errors.push(`${field} must be an array`);
    else items.forEach((item, index) => validateNarrativeEvidence(item, registry, errors, `${field}.${index}`));
  }
  validateNarrativeEvidence(value.discipline_review, registry, errors, 'discipline_review');

  if (!Array.isArray(value.limitations) || value.limitations.length === 0) errors.push('limitations must be a non-empty array');
  else value.limitations.forEach((item, index) => validateNarrative(item, errors, `limitations.${index}`));

  const experimentKeys = ['hypothesis', 'action', 'measurement', 'success_criterion', 'metric_refs'];
  if (exactObject(value.next_period_experiment, experimentKeys, errors, 'next_period_experiment')) {
    for (const field of ['hypothesis', 'action', 'measurement', 'success_criterion'] as const) validateNarrative(value.next_period_experiment[field], errors, `next_period_experiment.${field}`);
    validateDraftRefs(value.next_period_experiment.metric_refs, registry, errors, 'next_period_experiment.metric_refs');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
