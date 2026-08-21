import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdvisorRunState,
  TOOL_NAMES,
  createEvidenceResult,
  validateReportDraft,
  validateReferenceId,
  REPORT_DRAFT_V1_JSON_SCHEMA,
  REPORT_DRAFT_V2_JSON_SCHEMA,
  validateReportDraftV2,
  type ConditionOperator,
  type ReferenceRegistry,
  type ReportDraftV2,
} from './index.js';

const registry: ReferenceRegistry = {
  'market.close': { ref: 'market.close', kind: 'market', label: '收盘概览', value: '震荡' },
  'market.resistance': { ref: 'market.resistance', kind: 'price_level', label: '压力位', value: 12.5, unit: 'CNY' },
  'market.support': { ref: 'market.support', kind: 'price_level', label: '支撑位', value: 10.5 },
  'chan.structure': { ref: 'chan.structure', kind: 'structure', label: '结构', value: '震荡' },
  'news.latest': { ref: 'news.latest', kind: 'news', label: '新闻', value: '信息已核验', url: 'https://example.com/news' },
  'irm.response': { ref: 'irm.response', kind: 'irm', label: '互动回复', value: true },
  'hot.topic': { ref: 'hot.topic', kind: 'hot', label: '热点', value: null },
  'information.quality': { ref: 'information.quality', kind: 'information_quality', label: '信息质量', value: '中' },
};

// 带固化收盘锚点的注册表：压力位在锚点上方、支撑位在锚点下方，两侧都还没有被解决。
const anchoredRegistry: ReferenceRegistry = {
  ...registry,
  'market.latest_close': { ref: 'market.latest_close', kind: 'price_level', label: '最新固化收盘', value: '11.5' },
};

function validV2(): ReportDraftV2 {
  return {
    version: 'ReportDraftV2',
    run_id: 'run-1',
    title: '证据研究摘要',
    executive_summary: '市场与结构证据显示仍需观察',
    outlook: {
      horizon: '5-20-trading-days',
      direction: 'sideways',
      confidence: 'medium',
      thesis: '结构与信息证据暂未形成一致方向',
      scenarios: [
        { case: 'bullish', narrative: '上方结构得到确认', trigger: { operator: 'break_above', fact_ref: 'market.resistance' }, invalidation: { operator: 'structure_invalidated', fact_ref: 'chan.structure' }, evidence_refs: ['market.close', 'chan.structure', 'news.latest'] },
        { case: 'base', narrative: '结构保持震荡', trigger: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, invalidation: { operator: 'break_below', fact_ref: 'market.support' }, evidence_refs: ['market.close', 'chan.structure', 'information.quality'] },
        { case: 'bearish', narrative: '下方结构转弱', trigger: { operator: 'break_below', fact_ref: 'market.support' }, invalidation: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, evidence_refs: ['market.close', 'chan.structure', 'irm.response'] },
      ],
    },
    risks: [{ narrative: '信息质量可能变化', evidence_refs: ['market.close', 'chan.structure', 'hot.topic'] }],
    evidence_refs: ['market.close', 'chan.structure', 'news.latest'],
  };
}

test('contracts expose the advisor state machine and four workflow tool names', () => {
  assert.deepEqual(Object.values(AdvisorRunState), [
    'QUEUED', 'MARKET_READY', 'CHAN_READY', 'EVIDENCE_READY', 'COMPLETED',
  ]);
  assert.deepEqual(TOOL_NAMES, [
    'fetch_market_snapshot', 'run_chan_analysis', 'collect_information_evidence', 'emit_research_report',
  ]);
});

test('reference ids are strict and evidence results preserve run identity', () => {
  assert.equal(validateReferenceId('ev-1:market'), true);
  assert.equal(validateReferenceId('../secret'), false);
  const result = createEvidenceResult({
    kind: 'fundamental', run_id: 'run-1', execution_id: 'exec-1', lease_epoch: 2,
    expected_state_version: 1, idempotency_key: 'idem-1', evidence_id: 'fund-1',
    claims: [{ claim: 'revenue grew', source_ref: 'source-1' }],
  });
  assert.equal(result.evidence_id, 'fund-1');
  assert.throws(() => createEvidenceResult({ ...result, evidence_id: '../bad' }));
});

test('report draft rejects price facts, trade semantics, and unknown references', () => {
  const valid = {
    version: 'ReportDraftV1',
    run_id: 'run-1',
    title: '研究摘要',
    summary: '基于证据的中性观察',
    sections: [{ heading: '基本面', body: '收入增长，仍需持续跟踪' }],
    evidence_refs: ['fund-1'],
  } as const;
  assert.equal(validateReportDraft(valid, new Set(['fund-1'])).ok, true);
  assert.equal(validateReportDraft({ ...valid, summary: '当前价格为 10 元，建议买入并设置止损' }, new Set(['fund-1'])).ok, false);
  assert.equal(validateReportDraft({ ...valid, evidence_refs: ['missing'] }, new Set(['fund-1'])).ok, false);
  assert.equal(validateReportDraft({ ...valid, buy: 'buy' } as unknown, new Set(['fund-1'])).ok, false);
});

test('report draft schema forbids additional properties and trade fields', () => {
  assert.equal(REPORT_DRAFT_V1_JSON_SCHEMA.additionalProperties, false);
  assert.equal((REPORT_DRAFT_V1_JSON_SCHEMA.properties as Record<string, unknown>).buy, undefined);
});

test('ReportDraftV2 accepts an exact three-scenario report backed by the registry', () => {
  assert.deepEqual(validateReportDraftV2(validV2(), registry), { ok: true });
  assert.equal(REPORT_DRAFT_V2_JSON_SCHEMA.additionalProperties, false);
  assert.equal(REPORT_DRAFT_V2_JSON_SCHEMA.properties.outlook.additionalProperties, false);
});

test('ReportDraftV2 rejects unknown refs, duplicate scenarios, and additional fields', () => {
  const unknown = validV2();
  unknown.evidence_refs = ['market.close', 'chan.structure', 'news.missing'];
  assert.equal(validateReportDraftV2(unknown, registry).ok, false);
  const duplicate = validV2();
  duplicate.outlook.scenarios[1].case = 'bullish';
  assert.equal(validateReportDraftV2(duplicate, registry).ok, false);
  assert.equal(validateReportDraftV2({ ...validV2(), extra: true }, registry).ok, false);
});

test('ReportDraftV2 enforces condition kinds and exact reference-registry keys', () => {
  const wrongKind = validV2();
  wrongKind.outlook.scenarios[0].trigger.fact_ref = 'chan.structure';
  assert.equal(validateReportDraftV2(wrongKind, registry).ok, false);
  const wrongRegistry = { ...registry, alias: registry['market.close'] };
  assert.equal(validateReportDraftV2(validV2(), wrongRegistry).ok, false);
  assert.equal(validateReportDraftV2({ ...validV2(), outlook: { ...validV2().outlook, scenarios: validV2().outlook.scenarios.map((scenario) => ({ ...scenario, trigger: { ...scenario.trigger, threshold: 12 } })) } }, registry).ok, false);
  assert.equal(validateReportDraftV2(validV2(), { ...registry, broken: null } as unknown as ReferenceRegistry).ok, false);
});

test('ReportDraftV2 rejects trigger and invalidation pairs that cannot be falsified', () => {
  const tautologies: Array<[ConditionOperator, ConditionOperator]> = [
    ['hold_below', 'break_above'],
    ['break_above', 'hold_below'],
    ['hold_above', 'break_below'],
    ['break_below', 'hold_above'],
    ['break_above', 'break_above'],
  ];
  for (const [trigger, invalidation] of tautologies) {
    const report = validV2();
    report.outlook.scenarios[1].trigger = { operator: trigger, fact_ref: 'market.resistance' };
    report.outlook.scenarios[1].invalidation = { operator: invalidation, fact_ref: 'market.resistance' };
    const result = validateReportDraftV2(report, registry);
    assert.equal(result.ok, false, `${trigger}/${invalidation}`);
    if (!result.ok) assert.match(result.errors.join('\n'), /scenario\.1 trigger and invalidation must not be identical or logical complements/);
  }
});

test('ReportDraftV2 keeps opposite breakouts on one fact and every cross-fact pair valid', () => {
  const oppositeBreakouts = validV2();
  oppositeBreakouts.outlook.scenarios[1].trigger = { operator: 'break_above', fact_ref: 'market.resistance' };
  oppositeBreakouts.outlook.scenarios[1].invalidation = { operator: 'break_below', fact_ref: 'market.resistance' };
  assert.deepEqual(validateReportDraftV2(oppositeBreakouts, registry), { ok: true });
  const crossFact = validV2();
  crossFact.outlook.scenarios[1].trigger = { operator: 'hold_below', fact_ref: 'market.resistance' };
  crossFact.outlook.scenarios[1].invalidation = { operator: 'break_below', fact_ref: 'market.support' };
  assert.deepEqual(validateReportDraftV2(crossFact, registry), { ok: true });
});

test('ReportDraftV2 rejects price conditions already resolved at the anchor close', () => {
  const resolved: Array<[ConditionOperator, string]> = [
    ['break_above', 'market.support'],
    ['break_below', 'market.resistance'],
    ['hold_above', 'market.resistance'],
    ['hold_below', 'market.support'],
  ];
  for (const [operator, fact_ref] of resolved) {
    const report = validV2();
    report.outlook.scenarios[0].trigger = { operator, fact_ref };
    const result = validateReportDraftV2(report, anchoredRegistry);
    assert.equal(result.ok, false, `${operator}/${fact_ref}`);
    if (!result.ok) assert.match(result.errors.join('\n'), /scenario\.0\.trigger references a level already resolved at the anchor close/);
  }
  const resolvedInvalidation = validV2();
  resolvedInvalidation.outlook.scenarios[0].invalidation = { operator: 'hold_above', fact_ref: 'market.resistance' };
  const result = validateReportDraftV2(resolvedInvalidation, anchoredRegistry);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('\n'), /scenario\.0\.invalidation references a level already resolved/);
});

test('ReportDraftV2 keeps price conditions that are still open at the anchor close', () => {
  const open: Array<[ConditionOperator, string]> = [
    ['break_above', 'market.resistance'],
    ['break_below', 'market.support'],
    // 收盘仍在支撑上方，"保持上方"正常且必要，不算退化。
    ['hold_above', 'market.support'],
    ['hold_below', 'market.resistance'],
    // 水平正好等于固化收盘时两侧都还没有被解决。
    ['break_above', 'market.latest_close'],
    ['break_below', 'market.latest_close'],
    ['hold_above', 'market.latest_close'],
    ['hold_below', 'market.latest_close'],
  ];
  for (const [operator, fact_ref] of open) {
    const report = validV2();
    report.outlook.scenarios[0].trigger = { operator, fact_ref };
    assert.deepEqual(validateReportDraftV2(report, anchoredRegistry), { ok: true }, `${operator}/${fact_ref}`);
  }
});

test('ReportDraftV2 skips the anchor check without a numeric latest close', () => {
  const report = validV2();
  report.outlook.scenarios[0].trigger = { operator: 'break_above', fact_ref: 'market.support' };
  assert.deepEqual(validateReportDraftV2(report, registry), { ok: true });
  const notNumeric: ReferenceRegistry = {
    ...anchoredRegistry,
    'market.latest_close': { ...anchoredRegistry['market.latest_close'], value: '暂无收盘' },
  };
  assert.deepEqual(validateReportDraftV2(report, notNumeric), { ok: true });
  const wrongKind: ReferenceRegistry = {
    ...anchoredRegistry,
    'market.latest_close': { ...anchoredRegistry['market.latest_close'], kind: 'market' },
  };
  assert.deepEqual(validateReportDraftV2(report, wrongKind), { ok: true });
});

test('ReportDraftV2 requires three evidence classes at top level and across scenarios plus risks', () => {
  const missingTop = validV2();
  missingTop.evidence_refs = ['market.close', 'chan.structure'];
  assert.equal(validateReportDraftV2(missingTop, registry).ok, false);
  const missingNarrative = validV2();
  for (const scenario of missingNarrative.outlook.scenarios) scenario.evidence_refs = ['market.close', 'chan.structure'];
  missingNarrative.risks = [{ narrative: '信息可能变化', evidence_refs: ['market.close'] }];
  assert.equal(validateReportDraftV2(missingNarrative, registry).ok, false);
});

test('ReportDraftV2 narrative fields reject trade semantics and Arabic price digits', () => {
  assert.equal(validateReportDraftV2({ ...validV2(), title: '目标价研究' }, registry).ok, false);
  assert.equal(validateReportDraftV2({ ...validV2(), title: '保证收益的研究结论' }, registry).ok, false);
  assert.equal(validateReportDraftV2({ ...validV2(), executive_summary: '预期收益翻倍' }, registry).ok, false);
  assert.equal(validateReportDraftV2({ ...validV2(), title: '风险收益特征研究' }, registry).ok, true);
  const numbered = validV2();
  numbered.outlook.scenarios[0].narrative = '突破 12.5 后转强';
  assert.equal(validateReportDraftV2(numbered, registry).ok, false);
  const fullWidthNumbered = validV2();
  fullWidthNumbered.outlook.scenarios[0].narrative = '突破１２．５后转强';
  assert.equal(validateReportDraftV2(fullWidthNumbered, registry).ok, false);
});
