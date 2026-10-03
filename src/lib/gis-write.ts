/** Server-only GIS writes adapter. Writes go through the dashboard backend, never the read database. */
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { importJWK, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireScope, resolvePrincipal, type KeyRegistration } from './auth';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';

const PATH = '/api/integrations/context-engine/geo/points';
const MAX_BYTES = 32768;
const DEADLINE_MS = 8000;
const categories = ['POTENTIAL_CLIENT', 'POTENTIAL_WAREHOUSE', 'FOOD_PLACE', 'HOTEL_RESTAURANT', 'LABOR_QUARTERS', 'OPEN_YARD_BTS'] as const;
export const gisWriteInputSchema = z.object({
  operation_id: z.string().uuid().describe('Stable UUID for this authorized creation. Persist before dispatch and reuse unchanged on recovery; never create a new ID to retry an uncertain result.'),
  name: z.string().trim().min(1).max(200),
  category: z.enum(categories),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  notes: z.string().max(5000).nullable().optional(),
  city: z.string().trim().max(200).nullable().optional(),
}).strict();
const pointSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200), category: z.enum(categories),
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  notes: z.string().max(5000).nullable(), city: z.string().max(200).nullable(),
  createdBy: z.string().email().max(254), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const gisWriteOutputSchema = z.object({
  operation_id: z.string().uuid(),
  outcome: z.enum(['created', 'replayed', 'not_dispatched', 'rejected', 'outcome_unknown']),
  code: z.string(), message: z.string(), data: pointSchema.optional(),
}).strict();
export const gisRollbackInputSchema = z.object({ operation_id: z.string().uuid().describe('Stable UUID for this authorized compensation. Reuse on recovery.'), original_operation_id: z.string().uuid().describe('The same employee’s original create_gis_poi operation UUID.') }).strict();
const rollbackDataSchema = z.object({ originalOperationId: z.string().uuid(), pointId: z.string().uuid(), before: pointSchema, after: z.null() }).strict();
export const gisRollbackOutputSchema = z.object({ operation_id: z.string().uuid(), outcome: z.enum(['rolled_back', 'replayed', 'not_dispatched', 'rejected', 'outcome_unknown']), code: z.string(), message: z.string(), data: rollbackDataSchema.optional() }).strict();
export type GisRollbackResult = z.infer<typeof gisRollbackOutputSchema>;
type GisOperationResult = GisWriteResult | GisRollbackResult;
export type GisWriteResult = z.infer<typeof gisWriteOutputSchema>;
export type GisWriteDependencies = {
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  principal: typeof resolvePrincipal;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  now: () => number;
  timeoutMs: number;
};
const privateJwk = z.object({
  kty: z.literal('OKP'), crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  alg: z.literal('EdDSA').optional(), use: z.literal('sig').optional(),
  key_ops: z.tuple([z.literal('sign')]).optional(), kid: z.string().optional(),
}).strict();

function configuration(env: NodeJS.ProcessEnv) {
  const endpoint = new URL(env.CONTEXT_GIS_BACKEND_URL ?? '');
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash
    || endpoint.pathname !== PATH || endpoint.href !== env.CONTEXT_GIS_BACKEND_URL
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) throw new Error('GIS_CONFIGURATION');
  const kid = env.CONTEXT_GIS_SIGNING_KID ?? '';
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(kid)) throw new Error('GIS_CONFIGURATION');
  const raw = env.CONTEXT_GIS_SIGNING_PRIVATE_JWK ?? '';
  if (raw.length > 4096) throw new Error('GIS_CONFIGURATION');
  const jwk = privateJwk.parse(JSON.parse(raw));
  if ((jwk.kid && jwk.kid !== kid) || [jwk.x, jwk.d].some(value => Buffer.from(value, 'base64url').toString('base64url') !== value))
    throw new Error('GIS_CONFIGURATION');
  const derived = createPublicKey(createPrivateKey({ key: jwk, format: 'jwk' })).export({ format: 'jwk' });
  if (derived.x !== jwk.x) throw new Error('GIS_CONFIGURATION');
  return { endpoint: endpoint.href, kid, jwk, fingerprint: createHash('sha256').update(JSON.stringify([endpoint.href, kid, jwk])).digest('hex') };
}

/** Safe for discovery: exposes no URL, key material or configuration error detail. */
export function gisWriteAvailability(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.CONTEXT_GIS_WRITES_ENABLED === 'true';
  try { configuration(env); return { enabled, configured: true, available: enabled }; }
  catch { return { enabled, configured: false, available: false }; }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('GIS_RESPONSE_INVALID');
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) {
    void response.body.cancel().catch(() => {}); throw new Error('GIS_RESPONSE_INVALID');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('GIS_RESPONSE_INVALID');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

const rejectionCodes: Record<number, readonly string[]> = {
  400: ['CONTEXT_GEO_INVALID_POINT', 'CONTEXT_GEO_INVALID_ROLLBACK'], 401: ['CONTEXT_GEO_UNAUTHORIZED'],
  403: ['CONTEXT_GEO_FORBIDDEN'], 404: ['CONTEXT_GEO_ORIGINAL_NOT_FOUND'], 409: ['CONTEXT_GEO_IDEMPOTENCY_CONFLICT', 'CONTEXT_GEO_POINT_CHANGED', 'CONTEXT_GEO_ALREADY_ROLLED_BACK'],
  413: ['CONTEXT_GEO_BODY_TOO_LARGE'], 415: ['CONTEXT_GEO_UNSUPPORTED_ENCODING'],
};
const backendRollbackSuccess = z.object({ success: z.literal(true), operationId: z.string().uuid(), replayed: z.boolean(), data: rollbackDataSchema }).strict();
const backendSuccess = z.object({ success: z.literal(true), operationId: z.string().uuid(), replayed: z.boolean(), data: pointSchema }).strict();

/** Exactly one HTTP attempt. The caller owns durable intent/idempotency across separate invocations. */
export async function executeGisWrite(args: unknown, key: KeyRegistration, requestSignal: AbortSignal,
  revalidateKey: (client: PoolClient, key: KeyRegistration) => Promise<void>, overrides: Partial<GisWriteDependencies> = {}): Promise<GisWriteResult> {
  return executeGisOperation(args, key, requestSignal, revalidateKey, overrides, false) as Promise<GisWriteResult>;
}
export async function executeGisRollback(args: unknown, key: KeyRegistration, requestSignal: AbortSignal,
  revalidateKey: (client: PoolClient, key: KeyRegistration) => Promise<void>, overrides: Partial<GisWriteDependencies> = {}): Promise<GisRollbackResult> {
  return executeGisOperation(args, key, requestSignal, revalidateKey, overrides, true) as Promise<GisRollbackResult>;
}

/** Exactly one HTTP attempt. The caller owns durable intent/idempotency across separate invocations. */
async function executeGisOperation(
  args: unknown,
  key: KeyRegistration,
  requestSignal: AbortSignal,
  revalidateKey: (client: PoolClient, key: KeyRegistration) => Promise<void>,
  overrides: Partial<GisWriteDependencies>,
  rollback: boolean,
): Promise<GisOperationResult> {
  const parsed = (rollback ? gisRollbackInputSchema : gisWriteInputSchema).safeParse(args);
  if (!parsed.success) throw new HttpError(422, 'GIS_WRITE_INVALID_INPUT', 'Use a stable operation UUID and valid GIS point fields; caller identity fields are not accepted.');
  const input = parsed.data as z.infer<typeof gisWriteInputSchema>;
  const originalOperationId = rollback ? (parsed.data as z.infer<typeof gisRollbackInputSchema>).original_operation_id.toLowerCase() : undefined;
  const operationId = input.operation_id.toLowerCase();
  if (rollback && originalOperationId === operationId) throw new HttpError(422, 'GIS_WRITE_INVALID_INPUT', 'Use a separate operation UUID for compensation.');
  const deps: GisWriteDependencies = { transaction: withReadOnlyTransaction, principal: resolvePrincipal, fetch: globalThis.fetch,
    env: process.env, now: Date.now, timeoutMs: DEADLINE_MS, ...overrides };
  const result = (outcome: GisOperationResult['outcome'], code: string, message: string): GisOperationResult => ({ operation_id: operationId, outcome, code, message });
  if (requestSignal.aborted) return result('not_dispatched', 'GIS_WRITE_CANCELLED', 'This attempt was cancelled before dispatch.');
  if (deps.env.CONTEXT_GIS_WRITES_ENABLED !== 'true') return result('not_dispatched', 'GIS_WRITE_DISABLED', 'GIS writes are not enabled. No request was dispatched.');
  let config: ReturnType<typeof configuration>;
  try { config = configuration(deps.env); }
  catch { return result('not_dispatched', 'GIS_WRITE_CONFIGURATION', 'GIS writes are not configured. No request was dispatched.'); }
  const endpoint = rollback ? `${config.endpoint}/rollback` : config.endpoint;
  const payload = rollback ? { operationId, originalOperationId } : { operationId, name: input.name, category: input.category, lat: input.latitude, lng: input.longitude,
    ...(input.notes !== undefined ? { notes: input.notes } : {}), ...(input.city !== undefined ? { city: input.city } : {}) };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return result('not_dispatched', 'GIS_WRITE_TOO_LARGE', 'The GIS request exceeds its UTF-8 size limit. No request was dispatched.');
  let dispatched = false, timedOut = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  requestSignal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(DEADLINE_MS, Math.max(1, deps.timeoutMs)));
  let stopWaiting: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    stopWaiting = () => reject(new Error('GIS_CANCELLED'));
    controller.signal.addEventListener('abort', stopWaiting, { once: true });
  });
  const stillEnabled = () => {
    controller.signal.throwIfAborted();
    if (deps.env.CONTEXT_GIS_WRITES_ENABLED !== 'true' || configuration(deps.env).fingerprint !== config.fingerprint)
      throw new HttpError(503, 'GIS_WRITE_CONFIGURATION', 'GIS writes configuration changed.');
  };
  const authorize = () => deps.transaction(async client => {
    controller.signal.throwIfAborted();
    await revalidateKey(client, key);
    const principal = await deps.principal(client, key);
    requireScope(principal, 'gis:write');
    if (!Number.isSafeInteger(principal.employeeId) || principal.employeeId <= 0 || principal.employeeId > 2147483647
      || !z.string().email().max(254).safeParse(principal.email).success || principal.email !== principal.email.trim().toLowerCase())
      throw new HttpError(403, 'GIS_WRITE_FORBIDDEN', 'The active employee binding is unavailable.');
    controller.signal.throwIfAborted();
    return principal;
  });
  try {
    return await Promise.race([cancelled, (async (): Promise<GisOperationResult> => {
      const signingKey = await importJWK(config.jwk, 'EdDSA');
      const principal = await authorize();
      stillEnabled();
      const nowMs = deps.now(), now = Math.floor(nowMs / 1000);
      const expires = Math.min(now + 60, Math.floor(Date.parse(key.expiresAt) / 1000));
      // A signed downstream capability cannot outlive the authenticated grant.
      // Require at least one usable whole second after conservative expiry rounding.
      if (!Number.isFinite(expires) || expires * 1000 - nowMs < 1000)
        throw new HttpError(401, 'GIS_WRITE_UNAUTHORIZED', 'The authenticated grant has expired or is too close to expiry.');
      const assertion = await new SignJWT({ iss: 'wareongo:context-engine', aud: endpoint, htu: endpoint,
        htm: 'POST', sub: String(principal.employeeId), email: principal.email, scopes: [rollback ? 'geo:points:rollback' : 'geo:points:create'],
        body_sha256: createHash('sha256').update(body, 'utf8').digest('base64url'), iat: now, exp: expires, jti: randomUUID(),
      }).setProtectedHeader({ alg: 'EdDSA', typ: 'context-geo-write+jwt', kid: config.kid }).sign(signingKey);
      stillEnabled();
      dispatched = true;
      const response = await deps.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `ContextEngine ${assertion}` },
        body, redirect: 'error', cache: 'no-store', signal: controller.signal });
      const value = await readJson(response);
      if (response.status !== 200 && response.status !== 201) {
        const error = z.object({ success: z.literal(false), code: z.string() }).strict().safeParse(value);
        if (error.success && rejectionCodes[response.status]?.includes(error.data.code))
          return result('rejected', error.data.code, 'The backend rejected this attempt. Do not substitute a new operation ID. An earlier uncertain attempt, if any, remains unresolved.');
        throw new Error('GIS_RESPONSE_UNAVAILABLE');
      }
      const verified = rollback ? backendRollbackSuccess.parse(value) : backendSuccess.parse(value);
      if (verified.operationId !== operationId || verified.replayed !== (response.status === 200)) throw new Error('GIS_RESPONSE_MISMATCH');
      if (rollback) {
        const record = verified.data as z.infer<typeof rollbackDataSchema>;
        if (record.originalOperationId !== originalOperationId || record.pointId !== record.before.id
          || record.before.createdBy !== record.before.createdBy.trim().toLowerCase()
          || Date.parse(record.before.updatedAt) < Date.parse(record.before.createdAt)) throw new Error('GIS_RESPONSE_MISMATCH');
      } else {
        const record = verified.data as z.infer<typeof pointSchema>;
        if ((!verified.replayed && record.createdBy !== principal.email) || record.createdBy !== record.createdBy.trim().toLowerCase()
          || record.name !== input.name || record.category !== input.category
          || record.lat !== input.latitude || record.lng !== input.longitude || record.notes !== (input.notes ?? null)
          || record.city !== (input.city ?? null) || Date.parse(record.updatedAt) < Date.parse(record.createdAt)) throw new Error('GIS_RESPONSE_MISMATCH');
      }
      const current = await authorize();
      if (current.employeeId !== principal.employeeId || current.email !== principal.email) throw new Error('GIS_IDENTITY_CHANGED');
      stillEnabled();
      if (rollback) return { operation_id: operationId, outcome: verified.replayed ? 'replayed' : 'rolled_back', code: 'GIS_ROLLBACK_CONFIRMED',
        message: verified.replayed ? 'The original compensation receipt was recovered. No additional point was deleted; this is not a current-state read.' : 'The backend confirmed rollback of the unchanged GIS point created by your original operation.', data: verified.data as z.infer<typeof rollbackDataSchema> };
      return { operation_id: operationId, outcome: verified.replayed ? 'replayed' : 'created', code: 'GIS_WRITE_CONFIRMED',
        message: verified.replayed ? 'The original creation receipt was recovered. No additional point was created; this is not a current-state read.' : 'The backend confirmed creation of this GIS point.', data: verified.data as z.infer<typeof pointSchema> };

    })()]);
  } catch (error) {
    if (dispatched) return result('outcome_unknown', 'GIS_WRITE_OUTCOME_UNKNOWN', 'The action may have committed, but no authorized verified receipt is available. Retry only with this same operation_id and unchanged arguments. Never claim failure or create a replacement operation.');
    if (controller.signal.aborted) return result('not_dispatched', timedOut ? 'GIS_WRITE_TIMEOUT' : 'GIS_WRITE_CANCELLED', 'This attempt stopped before dispatch. No backend request was sent.');
    const code = error instanceof HttpError && error.status === 403 ? 'GIS_WRITE_FORBIDDEN'
      : error instanceof HttpError && error.status === 401 ? 'GIS_WRITE_UNAUTHORIZED' : 'GIS_WRITE_UNAVAILABLE';
    return result('not_dispatched', code, 'GIS writes authorization or configuration could not be established. No backend request was sent.');
  } finally {
    clearTimeout(timer); requestSignal.removeEventListener('abort', cancel);
    if (stopWaiting) controller.signal.removeEventListener('abort', stopWaiting);
    controller.abort();
  }
}
