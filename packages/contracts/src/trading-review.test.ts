import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACCOUNT_METRIC_REFS,
  TRADING_REVIEW_DRAFT_JSON_SCHEMA,
  TRADING_REVIEW_METRIC_REFS,
  TRADING_REVIEW_MODEL_INPUT_JSON_SCHEMA,
  validateTradingReviewDraft,
  validateTradingReviewModelInput,
  type TradingReviewDraftV1,
  type TradingReviewModelInputV1,
} from './trading-review.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/trading-review/${name}`, import.meta.url), 'utf8'));
const validInput = (): TradingReviewModelInputV1 => structuredClone(fixture('valid-model-input.json')) as TradingReviewModelInputV1;
const validDraft = (): TradingReviewDraftV1 => structuredClone(fixture('valid-draft.json')) as TradingReviewDraftV1;

function setPath(value: unknown, path: string, replacement: unknown): void {
  const parts = path.split('.');
  let cursor = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  cursor[parts.at(-1)!] = replacement;
}

function setNumericPath(input: TradingReviewModelInputV1, path: string, replacement: number | null): void {
  setPath(input, path, replacement);
  const metricRefs: Record<string, string> = {
    account_adjusted_return_rate: 'account.adjusted_return_rate',
    period_max_drawdown_rate: 'account.period_max_drawdown_rate',
    win_rate: 'account.win_rate',
    average_win_loss_ratio: 'account.average_win_loss_ratio',
    profit_factor: 'account.profit_factor',
    median_holding_days: 'account.median_holding_days',
    median_capital_efficiency: 'account.median_capital_efficiency',
    discipline_adherence_rate: 'discipline.adherence_rate',
  };
  let ref: string | undefined;
  if (path.startsWith('metrics.')) ref = metricRefs[path.split('.')[1]];
  if (path.startsWith('reason_groups.0.')) ref = `reason.buy.pullback_confirmation.${path.split('.')[2]}`;
  if (path === 'comparison.0.delta') ref = 'comparison.account.adjusted_return_rate';
  const entry = input.metric_registry.find((item) => item.ref === ref);
  if (entry) {
    entry.value = replacement;
    if (replacement === null) entry.conclusion_allowed = false;
  }
}

test('accepts the shared exact model input and draft fixtures', () => {
  const input = validInput();
  assert.deepEqual(validateTradingReviewModelInput(input), { ok: true });
  assert.deepEqual(validateTradingReviewDraft(validDraft(), input), { ok: true });
  assert.equal(TRADING_REVIEW_MODEL_INPUT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(TRADING_REVIEW_DRAFT_JSON_SCHEMA.additionalProperties, false);
});

test('expands every metric reference into a finite runtime enum', () => {
  assert.equal(ACCOUNT_METRIC_REFS.length, 8);
  assert.equal(TRADING_REVIEW_METRIC_REFS.includes('reason.buy.other.win_rate'), true);
  assert.equal(TRADING_REVIEW_METRIC_REFS.includes('reason.sell.other.average_cycle_return_rate'), true);
  assert.equal(TRADING_REVIEW_METRIC_REFS.includes('comparison.account.profit_factor'), true);
  const registryRef = TRADING_REVIEW_MODEL_INPUT_JSON_SCHEMA.properties.metric_registry.items.properties.ref;
  assert.deepEqual(registryRef.enum, TRADING_REVIEW_METRIC_REFS);
});

test('rejects every shared invalid model input case', () => {
  const cases = fixture('invalid-cases.json') as { model_input: Array<{ name: string; path: string; value: unknown }> };
  for (const item of cases.model_input) {
    const input = validInput();
    setPath(input, item.path, item.value);
    assert.equal(validateTradingReviewModelInput(input).ok, false, item.name);
  }
});

test('rejects every shared invalid draft case', () => {
  const cases = fixture('invalid-cases.json') as { draft: Array<{ name: string; path: string; value: unknown }> };
  for (const item of cases.draft) {
    const draft = validDraft();
    setPath(draft, item.path, item.value);
    assert.equal(validateTradingReviewDraft(draft, validInput()).ok, false, item.name);
  }
});

test('enforces every shared numeric bound including non-finite values', () => {
  const bounds = fixture('numeric-bounds.json') as Array<{ path: string; minimum: number | null; maximum: number | null; integer: boolean; nullable: boolean }>;
  for (const bound of bounds) {
    const valid = validInput();
    if (bound.minimum !== null) setNumericPath(valid, bound.path, bound.minimum);
    else setNumericPath(valid, bound.path, -1.5);
    assert.equal(validateTradingReviewModelInput(valid).ok, true, `${bound.path} accepts boundary`);

    if (bound.maximum !== null) {
      const above = validInput();
      setNumericPath(above, bound.path, bound.maximum + 0.01);
      assert.equal(validateTradingReviewModelInput(above).ok, false, `${bound.path} rejects above maximum`);
    }
    if (bound.minimum !== null) {
      const below = validInput();
      setNumericPath(below, bound.path, bound.minimum - 0.01);
      assert.equal(validateTradingReviewModelInput(below).ok, false, `${bound.path} rejects below minimum`);
    }
    if (bound.integer) {
      const fractional = validInput();
      setNumericPath(fractional, bound.path, 1.5);
      assert.equal(validateTradingReviewModelInput(fractional).ok, false, `${bound.path} rejects fractions`);
    }
    for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const invalid = validInput();
      setNumericPath(invalid, bound.path, nonFinite);
      assert.equal(validateTradingReviewModelInput(invalid).ok, false, `${bound.path} rejects non-finite values`);
    }
    if (bound.nullable) {
      const nullable = validInput();
      setNumericPath(nullable, bound.path, null);
      assert.equal(validateTradingReviewModelInput(nullable).ok, true, `${bound.path} accepts null`);
    }
  }
});

test('requires comparison metrics in fixed complete order or null', () => {
  const input = validInput();
  input.comparison = null;
  input.metric_registry = input.metric_registry.filter((item) => !item.ref.startsWith('comparison.'));
  assert.deepEqual(validateTradingReviewModelInput(input), { ok: true });

  const incomplete = validInput();
  incomplete.comparison = incomplete.comparison!.slice(1);
  assert.equal(validateTradingReviewModelInput(incomplete).ok, false);

  const reordered = validInput();
  [reordered.comparison![0], reordered.comparison![1]] = [reordered.comparison![1], reordered.comparison![0]];
  assert.equal(validateTradingReviewModelInput(reordered).ok, false);
});

test('rejects registry conclusion flags that contradict the model sample', () => {
  const overall = validInput();
  overall.sample.overall_conclusion_allowed = false;
  assert.equal(validateTradingReviewModelInput(overall).ok, false);

  const reason = validInput();
  reason.reason_groups[0].conclusion_allowed = false;
  assert.equal(validateTradingReviewModelInput(reason).ok, false);
});

test('allows a limitations-only draft when no metric permits a conclusion', () => {
  const sparse = validInput();
  sparse.sample.overall_conclusion_allowed = false;
  sparse.metrics = Object.fromEntries(Object.keys(sparse.metrics).map((key) => [key, null])) as typeof sparse.metrics;
  sparse.reason_groups = sparse.reason_groups.map((group) => ({
    ...group,
    sample_count: 0,
    conclusion_allowed: false,
    win_rate: null,
    average_cycle_return_rate: null,
  }));
  sparse.comparison = null;
  sparse.metric_registry = [
    { ref: 'quality.partial_period', value: false, conclusion_allowed: false },
    { ref: 'quality.missing_close_price', value: false, conclusion_allowed: false },
    { ref: 'quality.insufficient_sample', value: true, conclusion_allowed: false },
  ];
  const limited = validDraft();
  limited.profit_sources = [];
  limited.loss_patterns = [];
  limited.discipline_review.metric_refs = [];
  limited.next_period_experiment.metric_refs = [];
  assert.deepEqual(validateTradingReviewModelInput(sparse), { ok: true });
  assert.deepEqual(validateTradingReviewDraft(limited, sparse), { ok: true });
});
