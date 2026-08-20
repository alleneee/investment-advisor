import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AdvisorOrchestrator, BudgetExceededError, InvalidModelOutputError, InvalidToolCallError, LeaseConflictError, type PiSessionPort } from './orchestrator.js';
import { ProviderError, type PythonRpcPort } from './rpc.js';
import { LazyPiSession } from './pi-session.js';

export { ProviderError } from './rpc.js';
export interface ServerOptions { rpc: PythonRpcPort; session?: PiSessionPort; token?: string }
export const MAX_BODY_BYTES = 512 * 1024;

export class InvalidRequestError extends Error { constructor() { super('invalid request'); this.name = 'InvalidRequestError'; } }
export class PayloadTooLargeError extends Error { constructor() { super('payload too large'); this.name = 'PayloadTooLargeError'; } }
export class ModelNotReadyError extends Error { constructor() { super('model service is not configured'); this.name = 'ModelNotReadyError'; } }
export class TimeoutError extends Error { constructor(_message?: string) { super('request timed out'); this.name = 'TimeoutError'; } }

interface ErrorEnvelope {
  status: number;
  error: { code: 'INVALID_REQUEST' | 'MODEL_NOT_READY' | 'PROVIDER_ERROR' | 'INVALID_MODEL_OUTPUT' | 'TIMEOUT' | 'INTERNAL_ERROR' | 'UNAUTHORIZED'; message: string; retryable: boolean };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    if (tooLarge) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    receivedBytes += buffer.byteLength;
    if (receivedBytes > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new PayloadTooLargeError();
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidRequestError();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError();
  }
}

export function mapServerError(error: unknown): ErrorEnvelope {
  if (error instanceof PayloadTooLargeError) return { status: 413, error: { code: 'INVALID_REQUEST', message: 'invalid request', retryable: false } };
  if (error instanceof InvalidRequestError || error instanceof LeaseConflictError || error instanceof InvalidToolCallError && !(error instanceof InvalidModelOutputError)) {
    return { status: 400, error: { code: 'INVALID_REQUEST', message: 'invalid request', retryable: false } };
  }
  if (error instanceof ModelNotReadyError) return { status: 503, error: { code: 'MODEL_NOT_READY', message: 'model service is not configured', retryable: false } };
  if (error instanceof ProviderError) return { status: 502, error: { code: 'PROVIDER_ERROR', message: 'upstream provider failed', retryable: true } };
  if (error instanceof InvalidModelOutputError) return { status: 422, error: { code: 'INVALID_MODEL_OUTPUT', message: 'model returned an invalid report', retryable: false } };
  if (error instanceof BudgetExceededError && error.reason === 'wall-clock') return { status: 504, error: { code: 'TIMEOUT', message: 'request timed out', retryable: true } };
  if (error instanceof TimeoutError) return { status: 504, error: { code: 'TIMEOUT', message: 'request timed out', retryable: true } };
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'internal server error', retryable: false } };
}

const unauthorized: ErrorEnvelope = { status: 401, error: { code: 'UNAUTHORIZED', message: 'authorization failed', retryable: false } };

export function createServer(options: ServerOptions): Server {
  const hasPiConfig = Boolean(process.env.PI_PROVIDER && process.env.PI_MODEL && process.env.PI_API_KEY);
  const ready = options.session !== undefined || hasPiConfig;
  const session: PiSessionPort = options.session ?? (hasPiConfig ? new LazyPiSession() : { run: async () => { throw new ModelNotReadyError(); } });
  const orchestrator = new AdvisorOrchestrator(options.rpc, session);
  const token = options.token ?? process.env.INTERNAL_AGENT_TOKEN;
  return createHttpServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const path = request.url ?? '/';
      if (method === 'GET' && path === '/health/live') return json(response, 200, { status: 'live' });
      if (method === 'GET' && path === '/health/ready') return json(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      const match = method === 'POST' && path.match(/^\/internal\/v1\/agent-runs\/([^/]+):execute$/);
      if (!match) return json(response, 404, { error: 'not found' });
      if (!token || request.headers.authorization !== `Bearer ${token}`) return json(response, unauthorized.status, { error: unauthorized.error });
      if (!ready) throw new ModelNotReadyError();
      const payload = await body(request);
      const runId = decodeURIComponent(match[1]);
      const result = await orchestrator.execute({
        run_id: runId,
        execution_id: String(payload.execution_id ?? `http-${Date.now()}`),
        lease_epoch: Number(payload.lease_epoch ?? 0),
        expected_state_version: payload.expected_state_version === undefined ? undefined : Number(payload.expected_state_version),
        max_turns: payload.max_turns === undefined ? undefined : Number(payload.max_turns),
      });
      return json(response, 200, result);
    } catch (error) {
      const mapped = mapServerError(error);
      return json(response, mapped.status, { error: mapped.error });
    }
  });
}

export async function createConfiguredServer(rpc: PythonRpcPort): Promise<Server> {
  return createServer({ rpc, token: process.env.INTERNAL_AGENT_TOKEN });
}
