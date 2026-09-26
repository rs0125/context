import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './errors';
import { SCOPES, type Scope } from './auth';
import { consoleSecret, requireConsoleWrites, type ConsoleIdentity } from './console-auth';

export type ConsoleKey = { id: string; token: string; expiresAt: string; scopes: Scope[] };
type StoredKey = { id: string; employee_id: number; employee_email: string; token_hash: string; encrypted_token: string; scopes: unknown; expires_at: Date | string };
export const KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^wog_ctx_[A-Za-z0-9_-]{43}$/;
const FIELDS = 'id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at';

function aad(id: string, identity: Pick<ConsoleIdentity, 'employeeId' | 'email'>) {
  return Buffer.from(JSON.stringify(['context-key-v1', id, identity.employeeId, identity.email]));
}

export function encryptConsoleKey(token: string, id: string, identity: Pick<ConsoleIdentity, 'employeeId' | 'email'>, env: NodeJS.ProcessEnv = process.env) {
  if (!TOKEN.test(token)) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', consoleSecret('CONTEXT_KEY_ENCRYPTION_SECRET', env), iv);
  cipher.setAAD(aad(id, identity));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptConsoleKey(encrypted: string, id: string, identity: Pick<ConsoleIdentity, 'employeeId' | 'email'>, env: NodeJS.ProcessEnv = process.env) {
  const secret = consoleSecret('CONTEXT_KEY_ENCRYPTION_SECRET', env);
  try {
    if (!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{68}\.[A-Za-z0-9_-]{22}$/.test(encrypted)) throw new Error();
    const [, encodedIv, ciphertext, encodedTag] = encrypted.split('.');
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(encodedIv, 'base64url'));
    decipher.setAAD(aad(id, identity)); decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const token = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    if (!TOKEN.test(token)) throw new Error();
    return token;
  } catch { throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.'); }
}

function keyResponse(row: StoredKey, identity: ConsoleIdentity, now: number): ConsoleKey | null {
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) return null;
  if (row.employee_id !== identity.employeeId || row.employee_email !== identity.email
    || typeof row.id !== 'string' || !/^console_[a-f0-9-]{36}$/.test(row.id)
    || !Array.isArray(row.scopes) || row.scopes.length < 1 || row.scopes.length > 3 || new Set(row.scopes).size !== row.scopes.length
    || row.scopes.some(scope => !SCOPES.includes(scope as Scope))) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  const token = decryptConsoleKey(row.encrypted_token, row.id, identity);
  if (createHash('sha256').update(token).digest('hex') !== row.token_hash) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  return { id: row.id, token, expiresAt: new Date(expiresAt).toISOString(), scopes: (row.scopes as Scope[]).filter(scope => identity.scopes.includes(scope)) };
}

export async function getOwnConsoleKey(client: PoolClient, identity: ConsoleIdentity, now = Date.now()): Promise<ConsoleKey | null> {
  requireConsoleWrites();
  const { rows } = await client.query<StoredKey>(`SELECT ${FIELDS} FROM context_auth_private.employee_api_keys
    WHERE employee_id = $1 AND employee_email = $2 LIMIT 2`, [identity.employeeId, identity.email]);
  if (rows.length > 1) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  return rows[0] ? keyResponse(rows[0], identity, now) : null;
}

export async function rotateOwnConsoleKey(client: PoolClient, identity: ConsoleIdentity, now = Date.now()): Promise<ConsoleKey> {
  requireConsoleWrites();
  const id = `console_${randomUUID()}`;
  const token = `wog_ctx_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const encrypted = encryptConsoleKey(token, id, identity);
  const expiresAt = new Date(now + KEY_LIFETIME_MS).toISOString();
  const { rows } = await client.query<StoredKey>(`INSERT INTO context_auth_private.employee_api_keys
    (id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6::text[], $7::timestamptz)
    ON CONFLICT (employee_id) DO UPDATE SET id = EXCLUDED.id, employee_email = EXCLUDED.employee_email,
      token_hash = EXCLUDED.token_hash, encrypted_token = EXCLUDED.encrypted_token,
      scopes = EXCLUDED.scopes, expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP
    RETURNING ${FIELDS}`, [id, identity.employeeId, identity.email, hash, encrypted, identity.scopes, expiresAt]);
  if (rows.length !== 1) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  const result = keyResponse(rows[0], identity, now);
  if (!result || result.token !== token) throw new HttpError(503, 'CONSOLE_KEY_INVALID', 'The saved key could not be verified.');
  return result;
}
