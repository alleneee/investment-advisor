import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TradingReviewModelInputV1 } from '../../../packages/contracts/src/index.js';
import {
  buildTradingReviewPrompt,
  buildTradingReviewSessionConfig,
  createTradingReviewTool,
  forceTradingReviewToolChoicePayload,
  TRADING_REVIEW_TOOL_NAME,
} from './trading-review-session.js';

const input = JSON.parse(readFileSync(new URL('../../../tests/fixtures/trading-review/valid-model-input.json', import.meta.url), 'utf8')) as TradingReviewModelInputV1;
const draft = JSON.parse(readFileSync(new URL('../../../tests/fixtures/trading-review/valid-draft.json', import.meta.url), 'utf8'));

test('trading review session allows only emit_trading_review', () => {
  const config = buildTradingReviewSessionConfig({ PI_PROVIDER: 'provider', PI_MODEL: 'glm-5.2', PI_API_KEY: 'key' });
  assert.deepEqual(config.sessionOptions, {
    thinkingLevel: 'off',
    noTools: 'builtin',
    tools: [TRADING_REVIEW_TOOL_NAME],
    excludeTools: ['read', 'bash', 'write', 'edit', 'skills', 'context'],
  });
  const tool = createTradingReviewTool(input, () => undefined);
  assert.equal(tool.name, 'emit_trading_review');
  assert.deepEqual(tool.constrainedSampling, { type: 'json_schema', strict: 'prefer' });
});

test('trading review prompt contains only the strict privacy-minimized model input', () => {
  const unsafe = {
    ...structuredClone(input),
    account_id: 'account-secret',
    symbol: '002940.SZ',
    price: '18.35',
    quantity: 1000,
    note: '原始备注不能进入模型',
    source_row_id: 'execution-stable-id',
    url: 'https://secret.example/raw',
  } as unknown as TradingReviewModelInputV1;
  const prompt = buildTradingReviewPrompt('report-1', unsafe);
  assert.match(prompt, /trading_review_model_input\.v1|account\.adjusted_return_rate/);
  assert.doesNotMatch(prompt, /account-secret|002940|18\.35|1000|原始备注|execution-stable-id|secret\.example/);
});

test('trading review tool captures only a draft valid for the current registry', async () => {
  let captured: unknown;
  const tool = createTradingReviewTool(input, (value) => { captured = value; });
  const result = await tool.execute('call-1', draft);
  assert.deepEqual(captured, draft);
  assert.equal(result.terminate, true);
  await assert.rejects(() => tool.execute('call-2', { ...draft, title: '任意标题' }), /invalid trading review draft/);
});

test('GLM trading review requests disable thinking and require the emit tool', () => {
  const payload = {
    model: 'glm-5.2',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: TRADING_REVIEW_TOOL_NAME, strict: true } }],
  };
  assert.deepEqual(forceTradingReviewToolChoicePayload(payload), {
    ...payload,
    thinking: { type: 'disabled' },
    reasoning_effort: 'none',
    tool_choice: 'required',
  });
});
