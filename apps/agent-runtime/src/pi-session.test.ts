import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomModelConfig, buildPiSessionConfig, buildReportPrompt, createReportTool, forceReportToolChoicePayload, isReportDraftV2Candidate, REPORT_TOOL_NAME } from './pi-session.js';
import * as piSessionModule from './pi-session.js';
import { AdvisorRunState, type ReportDraftV2 } from '../../../packages/contracts/src/index.js';

function draft(): ReportDraftV2 {
  const evidence_refs = ['market.close', 'chan.structure', 'news.latest'];
  return {
    version: 'ReportDraftV2', run_id: 'run-1', title: '证据摘要', executive_summary: '市场结构仍需观察',
    outlook: {
      horizon: '5-20-trading-days', direction: 'sideways', confidence: 'medium', thesis: '证据暂未形成一致方向',
      scenarios: [
        { case: 'bullish', narrative: '上方结构确认', trigger: { operator: 'break_above', fact_ref: 'market.resistance' }, invalidation: { operator: 'structure_invalidated', fact_ref: 'chan.structure' }, evidence_refs },
        { case: 'base', narrative: '结构保持震荡', trigger: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, invalidation: { operator: 'break_below', fact_ref: 'market.support' }, evidence_refs },
        { case: 'bearish', narrative: '下方结构转弱', trigger: { operator: 'break_below', fact_ref: 'market.support' }, invalidation: { operator: 'structure_confirmed', fact_ref: 'chan.structure' }, evidence_refs },
      ],
    },
    risks: [{ narrative: '信息质量可能变化', evidence_refs }], evidence_refs,
  };
}

test('Pi config is environment-only and disables every built-in tool', () => {
  const config = buildPiSessionConfig({ PI_PROVIDER: 'test', PI_MODEL: 'model-1', PI_API_KEY: 'key-1' });
  assert.deepEqual(config.sessionOptions, { thinkingLevel: 'off', noTools: 'builtin', tools: ['emit_research_report'], excludeTools: ['read', 'bash', 'write', 'edit', 'skills', 'context'] });
  assert.throws(() => buildPiSessionConfig({ PI_PROVIDER: 'test', PI_MODEL: 'model-1' }), /PI_API_KEY/);
});

test('custom OpenAI-compatible provider is normalized and report tool is required', () => {
  const config = buildPiSessionConfig({ PI_PROVIDER: 'tstech', PI_MODEL: 'glm-5.2', PI_API_KEY: 'key-1', PI_BASE_URL: 'http://a1.tstech.top/v1/chat/completions' });
  assert.equal(config.baseUrl, 'http://a1.tstech.top/v1');
  assert.equal(config.api, 'openai-completions');
  assert.equal(config.sessionOptions.thinkingLevel, 'off');
  assert.deepEqual(buildCustomModelConfig(config), {
    id: 'glm-5.2',
    name: 'glm-5.2',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { off: 'none' },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'zai',
    },
  });
  const payload = {
    model: 'glm-5.2',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: REPORT_TOOL_NAME, strict: true } }],
  };
  assert.deepEqual(forceReportToolChoicePayload(payload), {
    ...payload,
    thinking: { type: 'disabled' },
    reasoning_effort: 'none',
    tool_choice: 'required',
  });
});

test('non-GLM custom models do not receive Z.AI thinking compatibility', () => {
  const config = buildPiSessionConfig({
    PI_PROVIDER: 'generic',
    PI_MODEL: 'generic-model',
    PI_API_KEY: 'key-1',
    PI_BASE_URL: 'https://example.test/v1',
  });
  const modelConfig = buildCustomModelConfig(config);
  assert.equal(modelConfig.thinkingLevelMap, undefined);
  assert.equal(modelConfig.compat.thinkingFormat, undefined);
});

test('report tool prefers provider-side strict JSON Schema sampling', () => {
  const tool = createReportTool(() => undefined);
  assert.deepEqual(tool.constrainedSampling, { type: 'json_schema', strict: 'prefer' });
});

test('non-GLM report requests preserve their existing thinking settings', () => {
  const payload = {
    model: 'generic-model',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: REPORT_TOOL_NAME, strict: true } }],
  };
  assert.deepEqual(forceReportToolChoicePayload(payload), { ...payload, tool_choice: 'required' });
});

test('GLM requests without the report tool preserve their thinking settings', () => {
  const payload = {
    model: 'glm-5.2',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: 'unrelated_tool', strict: true } }],
  };
  assert.equal(forceReportToolChoicePayload(payload), payload);
});

test('provider-request extension returns the forced report-tool payload', () => {
  type Handler = (event: { payload: unknown }) => unknown;
  const factory = (piSessionModule as unknown as { forceReportToolChoiceExtension?: (pi: unknown) => void }).forceReportToolChoiceExtension;
  assert.equal(typeof factory, 'function');
  let handler: Handler | undefined;
  factory?.({
    on(event: string, candidate: Handler) {
      if (event === 'before_provider_request') handler = candidate;
    },
  });
  assert.ok(handler);
  const payload = { tools: [{ type: 'function', function: { name: REPORT_TOOL_NAME } }] };
  assert.deepEqual(handler({ payload }), { ...payload, tool_choice: 'required' });
});

test('report prompt skips malformed registries and entries without throwing', () => {
  const malformedRegistries: unknown[] = [
    null,
    [],
    [null, {}],
    {
      'news.null': null,
      'news.empty': {},
      'news.array': [],
      'news.bad-ref': { ref: 42, kind: 'news', label: '非法引用' },
      'news.bad-label': { ref: 'news.bad-label', kind: 'news', label: null },
      'news.bad-kind': { ref: 'news.bad-kind', kind: 'unknown', label: '非法类型' },
      'market.valid': { ref: 'market.valid', kind: 'market', label: '有效市场引用', value: '不进入提示词' },
    },
  ];

  for (const reference_registry of malformedRegistries) {
    let prompt = '';
    assert.doesNotThrow(() => {
      prompt = buildReportPrompt({
        tool: 'emit_research_report',
        state: {
          state: AdvisorRunState.EVIDENCE_READY,
          state_version: 3,
          run_id: 'run-malformed-registry',
          lease_epoch: 1,
          artifacts: { reference_registry },
        },
      });
    });
    assert.doesNotMatch(prompt, /news\.(?:null|empty|array|bad-ref|bad-label|bad-kind)/);
  }
});

test('information claims consume quotas only after registry existence and kind validation', () => {
  const missingNews = Array.from({ length: 5 }, (_, index) => ({
    claim: `MISSING_NEWS_CLAIM_${index + 1}`,
    source_ref: `news.missing-${index + 1}`,
  }));
  const prompt = buildReportPrompt({
    tool: 'emit_research_report',
    state: {
      state: AdvisorRunState.EVIDENCE_READY,
      state_version: 3,
      run_id: 'run-claim-registry',
      lease_epoch: 1,
      artifacts: {
        reference_registry: {
          'news.valid-sixth': { ref: 'news.valid-sixth', kind: 'news', label: '有效第六条新闻' },
          'news.wrong-kind': { ref: 'news.wrong-kind', kind: 'irm', label: '类型错误新闻' },
          'irm.valid': { ref: 'irm.valid', kind: 'irm', label: '有效互动' },
          'irm.wrong-kind': { ref: 'irm.wrong-kind', kind: 'news', label: '类型错误互动' },
          'hot.valid': { ref: 'hot.valid', kind: 'hot', label: '有效热榜' },
          'hot.wrong-kind': { ref: 'hot.wrong-kind', kind: 'irm', label: '类型错误热榜' },
          'information.quality': { ref: 'information.quality', kind: 'information_quality', label: '有效资讯质量' },
          'information.quality.wrong': { ref: 'information.quality.wrong', kind: 'hot', label: '类型错误资讯质量' },
        },
        evidence: {
          information: {
            claims: [
              ...missingNews,
              { claim: 'VALID_SIXTH_NEWS_CLAIM', source_ref: 'news.valid-sixth' },
              { claim: 'WRONG_NEWS_KIND_CLAIM', source_ref: 'news.wrong-kind' },
              { claim: 'VALID_IRM_CLAIM', source_ref: 'irm.valid' },
              { claim: 'WRONG_IRM_KIND_CLAIM', source_ref: 'irm.wrong-kind' },
              { claim: 'VALID_HOT_CLAIM', source_ref: 'hot.valid' },
              { claim: 'WRONG_HOT_KIND_CLAIM', source_ref: 'hot.wrong-kind' },
              { claim: 'VALID_INFORMATION_QUALITY_CLAIM', source_ref: 'information.quality' },
              { claim: 'WRONG_INFORMATION_QUALITY_CLAIM', source_ref: 'information.quality.wrong' },
            ],
          },
        },
      },
    },
  });

  assert.match(prompt, /VALID_SIXTH_NEWS_CLAIM/);
  assert.match(prompt, /VALID_IRM_CLAIM/);
  assert.match(prompt, /VALID_HOT_CLAIM/);
  assert.match(prompt, /VALID_INFORMATION_QUALITY_CLAIM/);
  assert.doesNotMatch(prompt, /MISSING_NEWS_CLAIM|news\.missing/);
  assert.doesNotMatch(prompt, /WRONG_(?:NEWS|IRM|HOT|INFORMATION_QUALITY)_KIND_CLAIM/);
});

test('information claims accept exactly four hundred Unicode code points and reject longer claims unchanged', () => {
  const exactClaim = `${'甲'.repeat(399)}𠮷`;
  const overlongClaim = `${'乙'.repeat(400)}𠮷`;
  assert.equal(Array.from(exactClaim).length, 400);
  assert.equal(Array.from(overlongClaim).length, 401);

  const prompt = buildReportPrompt({
    tool: 'emit_research_report',
    state: {
      state: AdvisorRunState.EVIDENCE_READY,
      state_version: 3,
      run_id: 'run-claim-length',
      lease_epoch: 1,
      artifacts: {
        reference_registry: {
          'news.exact': { ref: 'news.exact', kind: 'news', label: '边界长度新闻' },
          'news.too-long': { ref: 'news.too-long', kind: 'news', label: '超长新闻' },
        },
        evidence: {
          information: {
            claims: [
              { claim: exactClaim, source_ref: 'news.exact' },
              { claim: overlongClaim, source_ref: 'news.too-long' },
            ],
          },
        },
      },
    },
  });

  assert.ok(prompt.includes(exactClaim));
  assert.match(prompt, /news\.exact/);
  assert.doesNotMatch(prompt, /news\.too-long/);
  assert.ok(!prompt.includes('乙'.repeat(400)));
});

test('prompt sanitizer removes protocol-relative and arbitrary URI schemes without damaging normal facts', () => {
  const prompt = buildReportPrompt({
    tool: 'emit_research_report',
    state: {
      state: AdvisorRunState.EVIDENCE_READY,
      state_version: 3,
      run_id: 'run-uri-sanitize',
      lease_epoch: 1,
      artifacts: {
        reference_registry: {
          'market.safe-ref': {
            ref: 'market.safe-ref',
            kind: 'market',
            label: '正常中文标签，时间 2026-08-12T09:30:00+08:00；//secret.example/path www.secret.example/raw data:text/plain,secret javascript:alert(1) mailto:secret@example.com custom+scheme:value',
          },
          'news.safe-ref': { ref: 'news.safe-ref', kind: 'news', label: '正常资讯标签' },
        },
        market: {
          snapshot_id: 'market-safe',
          as_of: '2026-08-12T09:30:00+08:00',
          observations: [{
            instrument_ref: '002940.SZ',
            metric: '正常指标',
            value: '中文事实 ref market.safe-ref //cdn.secret.example/raw www.cdn-secret.example/raw data:image/png;base64,SECRET javascript:SECRET mailto:SECRET custom+scheme:SECRET',
          }],
        },
        evidence: {
          information: {
            claims: [{
              claim: '正常资讯事实 news.safe-ref //news.secret.example/raw www.news-secret.example/raw data:text/html,SECRET javascript:SECRET mailto:SECRET custom+scheme:SECRET',
              source_ref: 'news.safe-ref',
            }],
          },
        },
      },
    },
  });

  assert.match(prompt, /2026-08-12T09:30:00\+08:00/);
  assert.match(prompt, /market\.safe-ref/);
  assert.match(prompt, /news\.safe-ref/);
  assert.match(prompt, /正常中文标签|正常指标|中文事实|正常资讯事实/);
  assert.doesNotMatch(prompt, /secret\.example|cdn\.secret|news\.secret|cdn-secret|news-secret/);
  assert.doesNotMatch(prompt, /(?:^|[\s；])(?:\/\/|data:|javascript:|mailto:|custom\+scheme:)/imu);
});

test('report prompt exposes only safe tool summaries and references selected by information evidence', () => {
  const informationClaims = [
    ...Array.from({ length: 5 }, (_, index) => ({ claim: `允许新闻摘要${index + 1}`, source_ref: `news.selected-${index + 1}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ claim: `允许互动摘要${index + 1}`, source_ref: `irm.selected-${index + 1}` })),
    { claim: '允许热榜摘要', source_ref: 'hot.selected-1' },
    { claim: '允许资讯质量摘要', source_ref: 'information.quality' },
  ];
  const selectedInformationRegistry = Object.fromEntries(informationClaims.map(({ source_ref }) => [source_ref, {
    ref: source_ref,
    kind: source_ref.startsWith('news.') ? 'news' : source_ref.startsWith('irm.') ? 'irm' : source_ref.startsWith('hot.') ? 'hot' : 'information_quality',
    label: `${source_ref}标签 https://secret.example/label`,
    value: `SECRET_REGISTRY_VALUE_${source_ref}`,
    url: `https://secret.example/${source_ref}`,
  }]));
  const prompt = buildReportPrompt({
    tool: 'emit_research_report',
    state: {
      state: AdvisorRunState.EVIDENCE_READY, state_version: 3, run_id: 'run-1', lease_epoch: 1,
      artifacts: {
        timeframe: 'SECRET_OUTSIDE_TOOL_RESULTS',
        frozen_market_snapshot: { bars: Array.from({ length: 30 }, () => ({ raw: 'SECRET_FULL_KLINE', url: 'https://secret.example/kline' })) },
        frozen_chan_analysis: { structures: ['SECRET_FULL_CHAN'] },
        information_snapshot: {
          news: Array.from({ length: 12 }, (_, index) => ({ title: `SECRET_FULL_NEWS_${index}`, body: 'SECRET_LONG_NEWS_BODY'.repeat(30), url: 'https://secret.example/full-news' })),
        },
        market: {
          snapshot_id: 'market-1', as_of: '2026-08-12T00:00:00Z',
          observations: [{ instrument_ref: '002940.SZ', metric: 'window', value: '允许市场摘要' }],
          raw_payload: 'SECRET_MARKET_TOOL_EXTRA',
        },
        chan: {
          analysis_id: 'chan-1', signal_summary: '允许缠论摘要', evidence_refs: ['chan.structure'],
          raw_nodes: ['SECRET_CHAN_TOOL_EXTRA'],
        },
        evidence: {
          information: {
            kind: 'information', evidence_id: 'information-1', claims: [null, { invalid: true }, ...informationClaims],
            raw_response: 'SECRET_EVIDENCE_TOOL_EXTRA',
            source_url: 'https://secret.example/evidence',
          },
        },
        reference_registry: {
          'market.close': { ref: 'market.close', kind: 'market', label: '市场概览 来源 https://secret.example/raw', value: 'SECRET_MARKET_REGISTRY_VALUE', url: 'https://secret.example/raw' },
          'market.support': { ref: 'market.support', kind: 'price_level', label: '市场支撑', value: 'SECRET_SUPPORT_VALUE' },
          'chan.structure': { ref: 'chan.structure', kind: 'structure', label: '缠论结构', value: 'SECRET_CHAN_REGISTRY_VALUE' },
          ...selectedInformationRegistry,
          'news.extra': { ref: 'news.extra', kind: 'news', label: '未选择新闻', value: 'SECRET_EXTRA_REFERENCE' },
        },
      },
    },
  });
  assert.match(prompt, /market\.close.*市场概览 来源.*market/s);
  assert.match(prompt, /market\.support/);
  assert.match(prompt, /chan\.structure/);
  for (const { source_ref } of informationClaims) assert.match(prompt, new RegExp(source_ref.replace('.', '\\.')));
  assert.match(prompt, /2026-08-12/);
  assert.match(prompt, /允许市场摘要/);
  assert.match(prompt, /允许缠论摘要/);
  assert.match(prompt, /允许新闻摘要5/);
  assert.match(prompt, /允许互动摘要3/);
  assert.match(prompt, /允许资讯质量摘要/);
  assert.match(prompt, /三类证据/);
  assert.match(prompt, /看多.*基准.*看空/s);
  assert.match(prompt, /阿拉伯数字/);
  assert.doesNotMatch(prompt, /news\.extra|SECRET_EXTRA_REFERENCE/);
  assert.doesNotMatch(prompt, /SECRET_(?:OUTSIDE_TOOL_RESULTS|FULL_KLINE|FULL_CHAN|FULL_NEWS|LONG_NEWS_BODY)/);
  assert.doesNotMatch(prompt, /SECRET_(?:MARKET_TOOL_EXTRA|CHAN_TOOL_EXTRA|EVIDENCE_TOOL_EXTRA)/);
  assert.doesNotMatch(prompt, /SECRET_(?:MARKET_REGISTRY_VALUE|SUPPORT_VALUE|CHAN_REGISTRY_VALUE|REGISTRY_VALUE)/);
  assert.doesNotMatch(prompt, /frozen_market_snapshot|frozen_chan_analysis|information_snapshot|reference_registry/);
  assert.doesNotMatch(prompt, /secret\.example|https?:\/\/|ftp:\/\/|file:\/\/|www\./iu);
});

test('report prompt forbids Unicode digits in every generated narrative field', () => {
  const prompt = buildReportPrompt({
    tool: REPORT_TOOL_NAME,
    state: {
      state: AdvisorRunState.EVIDENCE_READY,
      state_version: 3,
      run_id: 'run-digit-policy',
      lease_epoch: 1,
      artifacts: {},
    },
  });

  assert.match(prompt, /标题必须严格等于“结构与资讯证据展望”/);
  assert.match(prompt, /title、executive_summary、outlook\.thesis、每个 scenario\.narrative、每个 risk\.narrative/);
  assert.match(prompt, /任何 Unicode 数字字符/);
  assert.match(prompt, /证券代码、日期、期限、百分比、数值或序号/);
});

test('ReportDraftV2 candidate requires the exact nested V2 shape', () => {
  const valid = draft();
  assert.equal(isReportDraftV2Candidate(valid), true);
  assert.equal(isReportDraftV2Candidate({ ...valid, version: 'ReportDraftV1' }), false);
  assert.equal(isReportDraftV2Candidate({ ...valid, extra: true }), false);
  assert.equal(isReportDraftV2Candidate({ ...valid, outlook: { ...valid.outlook, scenarios: valid.outlook.scenarios.slice(0, 2) } }), false);
  assert.equal(isReportDraftV2Candidate({ ...valid, risks: [{ narrative: '风险', evidence_refs: [], extra: true }] }), false);
});
