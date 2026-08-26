import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TradingReviewDraftV1, TradingReviewModelInputV1 } from '../../../packages/contracts/src/index.js';
import {
  InvalidTradingReviewOutputError,
  TradingReviewGenerator,
  TradingReviewTimeoutError,
  type TradingReviewSessionPort,
} from './trading-review-generator.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/trading-review/${name}`, import.meta.url), 'utf8')) as T;
const input = (): TradingReviewModelInputV1 => structuredClone(fixture<TradingReviewModelInputV1>('valid-model-input.json'));
const draft = (): TradingReviewDraftV1 => structuredClone(fixture<TradingReviewDraftV1>('valid-draft.json'));

test('generator validates input before calling the model', async () => {
  let calls = 0;
  const session: TradingReviewSessionPort = { run: async () => { calls += 1; return { draft: draft(), session_id: 'session-1' }; } };
  await assert.rejects(() => new TradingReviewGenerator(session).generate('report-1', { ...input(), symbol: '002940.SZ' }), /invalid trading review input/);
  assert.equal(calls, 0);
});

test('generator retries one invalid draft with a fixed correction and has no fallback', async () => {
  const corrections: boolean[] = [];
  const session: TradingReviewSessionPort = {
    run: async (_reportId, _input, correction) => {
      corrections.push(correction);
      return corrections.length === 1
        ? { draft: { ...draft(), title: '非法标题' }, session_id: 'session-invalid' }
        : { draft: draft(), session_id: 'session-valid' };
    },
  };
  const result = await new TradingReviewGenerator(session).generate('report-1', input());
  assert.deepEqual(corrections, [false, true]);
  assert.equal(result.trace.attempt_count, 2);
  assert.equal(result.trace.session_id, 'session-valid');

  const alwaysInvalid: TradingReviewSessionPort = { run: async () => ({ draft: { ...draft(), title: '非法标题' }, session_id: 'invalid' }) };
  await assert.rejects(() => new TradingReviewGenerator(alwaysInvalid).generate('report-2', input()), InvalidTradingReviewOutputError);
});

test('generator enforces per-attempt and total wall-clock budgets', async () => {
  const session: TradingReviewSessionPort = { run: async () => new Promise(() => undefined) };
  await assert.rejects(
    () => new TradingReviewGenerator(session, { per_attempt_timeout_ms: 5, total_timeout_ms: 20 }).generate('report-timeout', input()),
    TradingReviewTimeoutError,
  );
});

test('concurrent reports keep draft, usage, and session identity isolated', async () => {
  const waiters = new Map<string, () => void>();
  let waiting = 0;
  const session: TradingReviewSessionPort = {
    run: async (reportId) => {
      waiting += 1;
      if (waiting < 2) await new Promise<void>((resolve) => waiters.set(reportId, resolve));
      else for (const resolve of waiters.values()) resolve();
      const value = draft();
      value.limitations = [`${reportId}样本有限`];
      return { draft: value, session_id: `session-${reportId}`, usage: { input_tokens: reportId === 'a' ? 10 : 20, output_tokens: 5 } };
    },
  };
  const generator = new TradingReviewGenerator(session);
  const [a, b] = await Promise.all([generator.generate('a', input()), generator.generate('b', input())]);
  assert.deepEqual(a.draft.limitations, ['a样本有限']);
  assert.deepEqual(b.draft.limitations, ['b样本有限']);
  assert.equal(a.trace.session_id, 'session-a');
  assert.equal(b.trace.session_id, 'session-b');
  assert.equal(a.trace.usage.input_tokens, 10);
  assert.equal(b.trace.usage.input_tokens, 20);
});
