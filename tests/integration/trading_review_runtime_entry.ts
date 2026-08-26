import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';

import type { TradingReviewDraftV1, TradingReviewModelInputV1 } from '../../packages/contracts/src/index.js';
import { FakePythonRpc, FakeSession } from '../../apps/agent-runtime/src/runtime-fakes.js';
import { createServer } from '../../apps/agent-runtime/src/server.js';
import { TradingReviewGenerator } from '../../apps/agent-runtime/src/trading-review-generator.js';
import type { TradingReviewSessionPort, TradingReviewSessionResult } from '../../apps/agent-runtime/src/trading-review-session.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`integration entry environment is missing: ${name}`);
  return value;
}

const port = Number(process.env.PORT);
const token = requiredEnvironment('INTERNAL_AGENT_TOKEN');
const auditPath = requiredEnvironment('TRADING_REVIEW_AUDIT_PATH');
if (!Number.isInteger(port) || port < 1) throw new Error('integration entry port is invalid');

class DeterministicTradingReviewSession implements TradingReviewSessionPort {
  async run(reportId: string, input: TradingReviewModelInputV1, _correction: boolean): Promise<TradingReviewSessionResult> {
    writeFileSync(auditPath, JSON.stringify({ report_id: reportId, model_input: input }), 'utf8');
    const refs = input.metric_registry
      .filter((entry) => entry.conclusion_allowed)
      .map((entry) => entry.ref)
      .slice(0, 1);
    const evidence = { narrative: '样本表现仍需持续验证', metric_refs: refs };
    const draft: TradingReviewDraftV1 = {
      schema_version: 'trading_review_draft.v1',
      title: '周期交易复盘',
      profit_sources: refs.length ? [evidence] : [],
      loss_patterns: refs.length ? [evidence] : [],
      discipline_review: { narrative: '执行纪律应结合原始计划持续复核', metric_refs: refs },
      limitations: ['样本数量有限，结论仅用于复盘假设'],
      next_period_experiment: {
        hypothesis: '减少计划外操作可能改善执行一致性',
        action: '下一周期只执行预先定义的交易模式',
        measurement: '比较执行纪律与周期结果的同步变化',
        success_criterion: '执行纪律改善且回撤没有恶化',
        metric_refs: refs,
      },
    };
    return { draft, session_id: `trading-${reportId}`, usage: { input_tokens: 17, output_tokens: 11 } };
  }
}

const server: Server = createServer({
  rpc: new FakePythonRpc(),
  session: new FakeSession(),
  tradingReviewGenerator: new TradingReviewGenerator(new DeterministicTradingReviewSession()),
  token,
});
server.listen(port, '127.0.0.1');

function stop(): void {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
