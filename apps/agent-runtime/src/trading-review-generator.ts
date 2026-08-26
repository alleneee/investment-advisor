import {
  validateTradingReviewDraft,
  validateTradingReviewModelInput,
  type TradingReviewDraftV1,
  type TradingReviewModelInputV1,
} from '../../../packages/contracts/src/index.js';
import { TradingReviewPiSession, type TradingReviewSessionPort } from './trading-review-session.js';

export type { TradingReviewSessionPort } from './trading-review-session.js';

export class InvalidTradingReviewInputError extends Error {
  constructor() { super('invalid trading review input'); this.name = 'InvalidTradingReviewInputError'; }
}

export class InvalidTradingReviewOutputError extends Error {
  constructor() { super('invalid trading review output'); this.name = 'InvalidTradingReviewOutputError'; }
}

export class TradingReviewTimeoutError extends Error {
  constructor() { super('trading review generation timed out'); this.name = 'TradingReviewTimeoutError'; }
}

export interface TradingReviewGenerationResult {
  draft: TradingReviewDraftV1;
  trace: {
    session_id: string;
    attempt_count: number;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface TradingReviewGeneratorPort {
  generate(reportId: string, input: unknown): Promise<TradingReviewGenerationResult>;
}

interface GeneratorOptions {
  per_attempt_timeout_ms?: number;
  total_timeout_ms?: number;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new TradingReviewTimeoutError()), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TradingReviewGenerator implements TradingReviewGeneratorPort {
  private readonly perAttemptTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(private readonly session: TradingReviewSessionPort, options: GeneratorOptions = {}) {
    this.perAttemptTimeoutMs = options.per_attempt_timeout_ms ?? 60_000;
    this.totalTimeoutMs = options.total_timeout_ms ?? 125_000;
  }

  async generate(reportId: string, input: unknown): Promise<TradingReviewGenerationResult> {
    const checkedInput = validateTradingReviewModelInput(input);
    if (!checkedInput.ok) throw new InvalidTradingReviewInputError();
    const modelInput = structuredClone(input) as TradingReviewModelInputV1;
    const deadline = Date.now() + this.totalTimeoutMs;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TradingReviewTimeoutError();
      const result = await withTimeout(this.session.run(reportId, modelInput, attempt === 2), Math.min(this.perAttemptTimeoutMs, remaining));
      const checkedDraft = validateTradingReviewDraft(result.draft, modelInput);
      if (checkedDraft.ok) {
        return {
          draft: structuredClone(result.draft) as TradingReviewDraftV1,
          trace: {
            session_id: result.session_id,
            attempt_count: attempt,
            usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
          },
        };
      }
    }
    throw new InvalidTradingReviewOutputError();
  }
}

export function createConfiguredTradingReviewGenerator(env: Record<string, string | undefined> = process.env): TradingReviewGenerator {
  return new TradingReviewGenerator(new TradingReviewPiSession(env));
}
