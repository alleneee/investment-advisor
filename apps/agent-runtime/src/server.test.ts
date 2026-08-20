import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createServer, ProviderError, TimeoutError } from './server.js';
import { BudgetExceededError } from './orchestrator.js';
import { FakePythonRpc, FakeSession } from './runtime-fakes.js';
import { AdvisorRunState, type AdvisorRun } from '../../../packages/contracts/src/index.js';
import type { PythonRpcPort } from './rpc.js';

const registry = {
  'market.close': { ref: 'market.close', kind: 'market' as const, label: '市场', value: '震荡' },
  'market.resistance': { ref: 'market.resistance', kind: 'price_level' as const, label: '压力', value: 12.5 },
  'market.support': { ref: 'market.support', kind: 'price_level' as const, label: '支撑', value: 10.5 },
  'chan.structure': { ref: 'chan.structure', kind: 'structure' as const, label: '结构', value: '震荡' },
  'news.latest': { ref: 'news.latest', kind: 'news' as const, label: '信息', value: '已核验' },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  return `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function seededRpc(runId = 'run-http'): FakePythonRpc {
  const rpc = new FakePythonRpc();
  rpc.seed({ run_id: runId, state: AdvisorRunState.QUEUED, state_version: 0, lease_epoch: 1, artifacts: { reference_registry: registry } });
  return rpc;
}

async function errorResponse(server: Server, runId = 'run-http', body = JSON.stringify({ execution_id: 'e', lease_epoch: 1 })) {
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/internal/v1/agent-runs/${runId}:execute`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body });
    return { status: response.status, text: await response.text() };
  } finally { await close(server); }
}

function rawExecute(base: string, headers: Record<string, string | number>, chunks: Buffer[] = []): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/internal/v1/agent-runs/run-http:execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', connection: 'close', ...headers },
    }, (response) => {
      const responseChunks: Buffer[] = [];
      response.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(responseChunks).toString('utf8') }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('explicit session is ready and execute is bearer protected', async () => {
  const server = createServer({ rpc: seededRpc(), session: new FakeSession(), token: 'secret' });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    const unauthorized = await fetch(`${base}/internal/v1/agent-runs/run-http:execute`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: { code: 'UNAUTHORIZED', message: 'authorization failed', retryable: false } });
    const response = await fetch(`${base}/internal/v1/agent-runs/run-http:execute`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: 'e', lease_epoch: 1 }) });
    assert.equal(response.status, 200);
  } finally { await close(server); }
});

test('missing Pi configuration is not ready and never falls back to FakeSession', async () => {
  const saved = { provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL, key: process.env.PI_API_KEY };
  delete process.env.PI_PROVIDER; delete process.env.PI_MODEL; delete process.env.PI_API_KEY;
  try {
    const server = createServer({ rpc: seededRpc(), token: 'secret' });
    const base = await listen(server);
    try {
      assert.equal((await fetch(`${base}/health/ready`)).status, 503);
      const response = await fetch(`${base}/internal/v1/agent-runs/run-http:execute`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'MODEL_NOT_READY', message: 'model service is not configured', retryable: false } });
    } finally { await close(server); }
  } finally {
    if (saved.provider === undefined) delete process.env.PI_PROVIDER; else process.env.PI_PROVIDER = saved.provider;
    if (saved.model === undefined) delete process.env.PI_MODEL; else process.env.PI_MODEL = saved.model;
    if (saved.key === undefined) delete process.env.PI_API_KEY; else process.env.PI_API_KEY = saved.key;
  }
});

test('declared request bodies above the fixed limit return safe 413 and keep the server ready', async () => {
  const server = createServer({ rpc: seededRpc(), session: new FakeSession(), token: 'secret' });
  const base = await listen(server);
  try {
    const response = await rawExecute(base, { 'content-length': 512 * 1024 + 1 }, [Buffer.alloc(512 * 1024 + 1, 'x')]);
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.text), { error: { code: 'INVALID_REQUEST', message: 'invalid request', retryable: false } });
    assert.doesNotMatch(response.text, /secret/i);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  } finally { await close(server); }
});

test('chunked request bodies above the fixed limit return safe 413 and keep the server ready', async () => {
  const server = createServer({ rpc: seededRpc(), session: new FakeSession(), token: 'secret' });
  const base = await listen(server);
  try {
    const first = Buffer.alloc(300 * 1024, 'a');
    first.write('secret request body');
    const response = await rawExecute(base, { 'transfer-encoding': 'chunked' }, [first, Buffer.alloc(300 * 1024, 'b')]);
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.text), { error: { code: 'INVALID_REQUEST', message: 'invalid request', retryable: false } });
    assert.doesNotMatch(response.text, /secret|request body/i);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  } finally { await close(server); }
});

test('HTTP errors use stable status, code, retryability, and safe messages', async () => {
  const providerRpc = { ...seededRpc(), getState: async () => { throw new ProviderError('secret raw provider body'); } } as unknown as PythonRpcPort;
  const provider = await errorResponse(createServer({ rpc: providerRpc, session: new FakeSession(), token: 'secret' }));
  assert.equal(provider.status, 502);
  assert.deepEqual(JSON.parse(provider.text), { error: { code: 'PROVIDER_ERROR', message: 'upstream provider failed', retryable: true } });

  const invalid = await errorResponse(createServer({ rpc: seededRpc(), session: { run: async () => undefined }, token: 'secret' }));
  assert.equal(invalid.status, 422);
  assert.equal(JSON.parse(invalid.text).error.code, 'INVALID_MODEL_OUTPUT');

  const timedOut = await errorResponse(createServer({ rpc: seededRpc(), session: { run: async () => { throw new TimeoutError('secret timeout stack'); } }, token: 'secret' }));
  assert.equal(timedOut.status, 504);
  assert.deepEqual(JSON.parse(timedOut.text), { error: { code: 'TIMEOUT', message: 'request timed out', retryable: true } });

  const budgetTimedOut = await errorResponse(createServer({ rpc: seededRpc(), session: { run: async () => { throw new BudgetExceededError('wall-clock budget exhausted'); } }, token: 'secret' }));
  assert.equal(budgetTimedOut.status, 504);
  assert.deepEqual(JSON.parse(budgetTimedOut.text), { error: { code: 'TIMEOUT', message: 'request timed out', retryable: true } });

  const internal = await errorResponse(createServer({ rpc: seededRpc(), session: { run: async () => { throw new Error('secret internal stack'); } }, token: 'secret' }));
  assert.equal(internal.status, 500);
  assert.deepEqual(JSON.parse(internal.text), { error: { code: 'INTERNAL_ERROR', message: 'internal server error', retryable: false } });

  const malformed = await errorResponse(createServer({ rpc: seededRpc(), session: new FakeSession(), token: 'secret' }), 'run-http', '{bad json');
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.text), { error: { code: 'INVALID_REQUEST', message: 'invalid request', retryable: false } });

  for (const response of [provider, invalid, timedOut, budgetTimedOut, internal, malformed]) {
    assert.doesNotMatch(response.text, /secret|raw provider body|stack/i);
  }
});
