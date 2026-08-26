import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  TRADING_REVIEW_DRAFT_JSON_SCHEMA,
  validateTradingReviewDraft,
  type TradingReviewDraftV1,
  type TradingReviewModelInputV1,
} from '../../../packages/contracts/src/index.js';
import { buildCustomModelConfig, buildPiSessionConfig } from './pi-session.js';

export const TRADING_REVIEW_TOOL_NAME = 'emit_trading_review';

export interface TradingReviewSessionResult {
  draft: unknown;
  session_id: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface TradingReviewSessionPort {
  run(reportId: string, input: TradingReviewModelInputV1, correction: boolean): Promise<TradingReviewSessionResult>;
}

export interface TradingReviewSessionConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  api?: 'openai-completions';
  sessionOptions: {
    thinkingLevel: 'off';
    noTools: 'builtin';
    tools: ['emit_trading_review'];
    excludeTools: string[];
  };
}

export function buildTradingReviewSessionConfig(env: Record<string, string | undefined> = process.env): TradingReviewSessionConfig {
  const base = buildPiSessionConfig(env);
  return {
    provider: base.provider,
    model: base.model,
    apiKey: base.apiKey,
    ...(base.baseUrl ? { baseUrl: base.baseUrl, api: base.api } : {}),
    sessionOptions: {
      thinkingLevel: 'off',
      noTools: 'builtin',
      tools: [TRADING_REVIEW_TOOL_NAME],
      excludeTools: ['read', 'bash', 'write', 'edit', 'skills', 'context'],
    },
  };
}

function safeModelInput(input: TradingReviewModelInputV1): TradingReviewModelInputV1 {
  return {
    schema_version: input.schema_version,
    period: {
      kind: input.period.kind,
      trading_day_count: input.period.trading_day_count,
      partial_period: input.period.partial_period,
    },
    sample: {
      closed_cycle_count: input.sample.closed_cycle_count,
      overall_conclusion_allowed: input.sample.overall_conclusion_allowed,
    },
    metrics: {
      account_adjusted_return_rate: input.metrics.account_adjusted_return_rate,
      period_max_drawdown_rate: input.metrics.period_max_drawdown_rate,
      win_rate: input.metrics.win_rate,
      average_win_loss_ratio: input.metrics.average_win_loss_ratio,
      profit_factor: input.metrics.profit_factor,
      median_holding_days: input.metrics.median_holding_days,
      median_capital_efficiency: input.metrics.median_capital_efficiency,
      discipline_adherence_rate: input.metrics.discipline_adherence_rate,
    },
    reason_groups: input.reason_groups.map((group) => ({
      side: group.side,
      reason_code: group.reason_code,
      sample_count: group.sample_count,
      conclusion_allowed: group.conclusion_allowed,
      win_rate: group.win_rate,
      average_cycle_return_rate: group.average_cycle_return_rate,
    })),
    metric_registry: input.metric_registry.map((entry) => ({
      ref: entry.ref,
      value: entry.value,
      conclusion_allowed: entry.conclusion_allowed,
    })),
    cases: input.cases.map((item) => ({
      case_label: item.case_label,
      cycle_return_rate: item.cycle_return_rate,
      holding_days: item.holding_days,
      buy_reason_code: item.buy_reason_code,
      sell_reason_code: item.sell_reason_code,
      discipline_followed: item.discipline_followed,
    })),
    comparison: input.comparison?.map((item) => ({ metric_ref: item.metric_ref, delta: item.delta })) ?? null,
    quality_warnings: [...input.quality_warnings],
  };
}

export function buildTradingReviewPrompt(_reportId: string, input: TradingReviewModelInputV1, correction = false): string {
  return [
    '你是受约束的周期交易复盘撰写器。',
    `只能调用 ${TRADING_REVIEW_TOOL_NAME}，不得调用任何其他工具。`,
    '只能根据给定指标引用生成叙述，不得补充股票、价格、数量、账户、时间、备注、网址或绝对金额。',
    '不得生成具体买卖指令、仓位比例、止损价、目标价、收益承诺或确定走势。',
    '所有叙述字段不得包含任何 Unicode 数字；数值事实只通过 metric_refs 引用。',
    'profit_sources、loss_patterns、discipline_review 和 next_period_experiment 只能引用 conclusion_allowed=true 的指标。',
    '下一周期只能提出一个可衡量的改进实验。',
    '标题必须严格等于“周期交易复盘”。',
    correction ? '上一份输出未通过结构或引用校验。仅修正结构和引用后重新提交，不要解释错误。' : '',
    `模型输入：${JSON.stringify(safeModelInput(input))}`,
  ].filter(Boolean).join('\n');
}

export function createTradingReviewTool(input: TradingReviewModelInputV1, onDraft: (draft: TradingReviewDraftV1) => void) {
  return {
    name: TRADING_REVIEW_TOOL_NAME,
    label: '提交周期交易复盘',
    description: '提交只包含受指标引用约束叙述的 TradingReviewDraftV1。',
    promptSnippet: '提交周期交易复盘草稿',
    promptGuidelines: ['只引用允许下结论的指标', '不生成交易指令或数字事实'],
    parameters: TRADING_REVIEW_DRAFT_JSON_SCHEMA,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' } as const,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: unknown) => {
      const checked = validateTradingReviewDraft(params, input);
      if (!checked.ok) throw new Error('invalid trading review draft');
      onDraft(structuredClone(params) as TradingReviewDraftV1);
      return {
        content: [{ type: 'text', text: '周期交易复盘草稿已捕获。' }],
        details: { captured: true },
        terminate: true,
      };
    },
  };
}

function isGlm5Model(model: unknown): model is string {
  return typeof model === 'string' && /^glm-5(?:[._-]|$)/iu.test(model);
}

export function forceTradingReviewToolChoicePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const request = payload as { model?: unknown; tools?: unknown };
  if (!Array.isArray(request.tools)) return payload;
  const hasTool = request.tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const definition = (tool as { function?: unknown }).function;
    return Boolean(definition && typeof definition === 'object' && (definition as { name?: unknown }).name === TRADING_REVIEW_TOOL_NAME);
  });
  if (!hasTool) return payload;
  return {
    ...request,
    ...(isGlm5Model(request.model) ? { thinking: { type: 'disabled' }, reasoning_effort: 'none' } : {}),
    tool_choice: 'required',
  };
}

export function forceTradingReviewToolChoiceExtension(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => forceTradingReviewToolChoicePayload(event.payload));
}

export class TradingReviewPiSession implements TradingReviewSessionPort {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async run(reportId: string, input: TradingReviewModelInputV1, correction: boolean): Promise<TradingReviewSessionResult> {
    const config = buildTradingReviewSessionConfig(this.env);
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
    if (!model) throw new Error('trading review model is not available');
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: config.provider,
      defaultModel: config.model,
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 60_000, maxRetryDelayMs: 0 } },
    }, { projectTrusted: false });
    let draft: TradingReviewDraftV1 | undefined;
    const tool = createTradingReviewTool(input, (value) => { draft = value; });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [forceTradingReviewToolChoiceExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: '你是受约束的周期交易复盘撰写器。',
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
    try {
      await result.session.prompt(buildTradingReviewPrompt(reportId, input, correction));
      return {
        draft,
        session_id: result.session.sessionId,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    } finally {
      result.session.dispose();
    }
  }
}
