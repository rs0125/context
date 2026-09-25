import { createHash, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { HttpError } from './errors';
import { checkFailedCredential, noteFailedCredential } from './rate-limit';

export const SCOPES = ['knowledge:read', 'warehouses:read', 'crm:read'] as const;
export type Scope = typeof SCOPES[number];
export type Principal = { employeeId: number; email: string; scopes: Scope[]; keyId: string; twentyUserId?: string | null };
const registration = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  employeeEmail: z.string().email().transform(v => v.toLowerCase()),
  scopes: z.array(z.enum(SCOPES)).min(1).max(3),
  expiresAt: z.string().datetime(),
}).strict();
export type KeyRegistration = z.infer<typeof registration> & { source?: 'database'; employeeId?: number };

export function isEnvironmentAdmin(email: string, env: NodeJS.ProcessEnv = process.env) {
  return (env.ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}

export function bearerKeyToken(request: Request) {
  const token = /^Bearer (wog_ctx_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.');
  return token;
}

export function parseKeyRegistry(raw = process.env.CONTEXT_API_KEYS_JSON ?? '[]'): KeyRegistration[] {
  try {
    const keys = z.array(registration).max(1000).parse(JSON.parse(raw));
    if (new Set(keys.map(k => k.id)).size !== keys.length || new Set(keys.map(k => k.hash)).size !== keys.length) throw new Error('duplicates');
    return keys;
  } catch { throw new HttpError(503, 'AUTH_CONFIGURATION', 'API authentication is not configured correctly.'); }
}

export function authenticateKey(request: Request, keys = parseKeyRegistry(), now = Date.now()): KeyRegistration {
  const token = bearerKeyToken(request);
  const digest = createHash('sha256').update(token).digest();
  let match: KeyRegistration | undefined;
  for (const key of keys) {
    if (timingSafeEqual(digest, Buffer.from(key.hash, 'hex'))) match = key;
  }
  if (!match || Date.parse(match.expiresAt) <= now) {
    throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.');
  }
  return match;
}

export async function findDatabaseKey(client: PoolClient, hash: string, now = Date.now()): Promise<KeyRegistration | null> {
  if (process.env.CONTEXT_CONSOLE_WRITES_ENABLED !== 'true') return null;
  const { rows } = await client.query<{ id: string; token_hash: string; employee_id: number; employee_email: string; scopes: unknown; expires_at: Date | string }>(
    `SELECT id, token_hash, employee_id, employee_email, scopes, expires_at
      FROM context_auth_private.employee_api_keys WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP LIMIT 2`, [hash]);
  if (!rows.length) return null;
  const row = rows[0];
  try {
    const key = registration.parse({ id: row.id, hash: row.token_hash, employeeEmail: row.employee_email,
      scopes: row.scopes, expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at });
    if (rows.length !== 1 || !Number.isSafeInteger(row.employee_id) || row.employee_id <= 0 || key.hash !== hash || Date.parse(key.expiresAt) <= now) throw new Error();
    return { ...key, source: 'database', employeeId: row.employee_id };
  } catch { throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.'); }
}

export async function authenticateRequestKey(request: Request, lookup: (hash: string) => Promise<KeyRegistration | null>): Promise<KeyRegistration> {
  const token = bearerKeyToken(request);
  const keys = parseKeyRegistry();
  try { return authenticateKey(request, keys); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401 || process.env.CONTEXT_CONSOLE_WRITES_ENABLED !== 'true') throw error;
  }
  // Throttle repeated proven failures independently of valid employee keys.
  // There is no shared/IP pre-auth quota that anonymous traffic can exhaust for
  // everyone. Rotating random tokens still need bounded DB lookups and edge WAF.
  checkFailedCredential('rest-key', token);
  let match: KeyRegistration | null;
  try { match = await lookup(createHash('sha256').update(token).digest('hex')); }
  catch (error) {
    if (error instanceof HttpError && error.status === 401) noteFailedCredential('rest-key', token);
    throw error;
  }
  if (!match) { noteFailedCredential('rest-key', token); throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.'); }
  return match;
}

export async function resolvePrincipal(client: PoolClient, key: KeyRegistration): Promise<Principal> {
  if (key.source === 'database') {
    if (process.env.CONTEXT_CONSOLE_WRITES_ENABLED !== 'true' || !key.employeeId) throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.');
    // Recheck inside each business-read transaction, including after a live CRM
    // authorization request, so rotation during that gap revokes the old key.
    const current = await client.query(`SELECT id FROM context_auth_private.employee_api_keys
      WHERE id = $1 AND token_hash = $2 AND employee_id = $3 AND employee_email = $4
        AND expires_at > CURRENT_TIMESTAMP LIMIT 1`, [key.id, key.hash, key.employeeId, key.employeeEmail]);
    if (current.rows.length !== 1) throw new HttpError(401, 'UNAUTHORIZED', 'A valid employee API key is required.');
  }
  const { rows } = await client.query<{
    id: number; email: string; is_active: boolean; dashboardAccess: boolean;
    adminAccess: boolean; twenty_user_id: string | null;
  }>(`SELECT id, email, is_active, "dashboardAccess", "adminAccess", twenty_user_id
      FROM public."VerifiedNumber" WHERE lower(email) = $1 LIMIT 2`, [key.employeeEmail]);
  const employee = rows[0];
  if (rows.length !== 1 || !employee || !employee.is_active || (key.employeeId !== undefined && employee.id !== key.employeeId)) throw new HttpError(403, 'EMPLOYEE_INACTIVE', 'Employee access is unavailable.');
  const scopes = key.scopes.filter(scope => {
    if (scope === 'warehouses:read') return employee.dashboardAccess || employee.adminAccess || isEnvironmentAdmin(employee.email);
    if (scope === 'crm:read') return Boolean(employee.twenty_user_id);
    return true;
  });
  return { employeeId: employee.id, email: employee.email.toLowerCase(), scopes, keyId: key.id, twentyUserId: employee.twenty_user_id };
}

export function requireScope(principal: Principal, scope: Scope) {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, 'FORBIDDEN', 'This API key does not have access to this resource.');
}
