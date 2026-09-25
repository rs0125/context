import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptConsoleKey, encryptConsoleKey, getOwnConsoleKey, rotateOwnConsoleKey, KEY_LIFETIME_MS } from '../src/lib/console-keys';
import { authenticateRequestKey, findDatabaseKey, resolvePrincipal } from '../src/lib/auth';
import type { ConsoleIdentity } from '../src/lib/console-auth';

const identity: ConsoleIdentity = { employeeId: 7, email: 'employee@wareongo.com', name: 'Test Employee', isAdmin: false, scopes: ['knowledge:read', 'warehouses:read'] };
const secret = Buffer.alloc(32, 2).toString('base64url');
const token = `wog_ctx_${Buffer.alloc(32, 3).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');
const id = 'console_11111111-1111-4111-8111-111111111111';
const now = Date.now();
const request = (tokenValue = token) => new Request('https://context.example.test/api/v1/context', { headers: { Authorization: `Bearer ${tokenValue}` } });
const row = (overrides = {}) => ({ id, employee_id: 7, employee_email: identity.email, token_hash: hash,
  encrypted_token: encryptConsoleKey(token, id, identity), scopes: identity.scopes, expires_at: new Date(now + KEY_LIFETIME_MS), ...overrides });
function database(rows: unknown[]) { const query = vi.fn().mockResolvedValue({ rows }); return { query, client: { query } as unknown as PoolClient }; }

beforeEach(() => { vi.stubEnv('CONTEXT_KEY_ENCRYPTION_SECRET', secret); vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true'); vi.stubEnv('CONTEXT_API_KEYS_JSON', '[]'); });
afterEach(() => vi.unstubAllEnvs());

describe('employee-bound encrypted console keys', () => {
  it('encrypts for recopy with integrity bound to key ID, employee ID and email', () => {
    const encrypted = encryptConsoleKey(token, id, identity);
    expect(encrypted).not.toContain(token);
    expect(decryptConsoleKey(encrypted, id, identity)).toBe(token);
    for (const changed of [{ ...identity, employeeId: 8 }, { ...identity, email: 'other@wareongo.com' }]) {
      expect(() => decryptConsoleKey(encrypted, id, changed)).toThrowError(expect.objectContaining({ code: 'CONSOLE_KEY_INVALID' }));
    }
    expect(() => decryptConsoleKey(encrypted, `${id}x`, identity)).toThrow();
    expect(() => decryptConsoleKey(`${encrypted.slice(0, -3)}xxx`, id, identity)).toThrow();
    vi.stubEnv('CONTEXT_KEY_ENCRYPTION_SECRET', Buffer.alloc(32, 5).toString('base64url'));
    expect(() => decryptConsoleKey(encrypted, id, identity)).toThrow();
  });

  it('reads only the current employee key and returns only currently effective scopes', async () => {
    const { client, query } = database([row({ scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] })]);
    expect(await getOwnConsoleKey(client, identity, now)).toEqual({ id, token, expiresAt: new Date(now + KEY_LIFETIME_MS).toISOString(), scopes: identity.scopes });
    expect(query.mock.calls[0][1]).toEqual([7, identity.email]);
    expect(query.mock.calls[0][0]).toContain('WHERE employee_id = $1 AND employee_email = $2');
    await expect(getOwnConsoleKey(database([row({ employee_id: 8 })]).client, identity, now)).rejects.toThrow();
    await expect(getOwnConsoleKey(database([row({ token_hash: 'a'.repeat(64) })]).client, identity, now)).rejects.toThrow();
  });

  it('returns null for absent or expired keys', async () => {
    expect(await getOwnConsoleKey(database([]).client, identity, now)).toBeNull();
    expect(await getOwnConsoleKey(database([row({ expires_at: new Date(now) })]).client, identity, now)).toBeNull();
  });

  it('rotates atomically without persisting the plaintext token or permitting caller-selected scopes', async () => {
    const query = vi.fn(async (_sql: string, values: unknown[]) => {
      const [id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at] = values;
      return { rows: [{ id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at }] };
    });
    const result = await rotateOwnConsoleKey({ query } as unknown as PoolClient, identity, now);
    expect(result.token).toMatch(/^wog_ctx_[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBe(new Date(now + KEY_LIFETIME_MS).toISOString());
    expect(result.scopes).toEqual(identity.scopes);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (employee_id) DO UPDATE');
    expect(JSON.stringify(query.mock.calls[0])).not.toContain(result.token);
    expect(query.mock.calls[0][1][3]).toBe(createHash('sha256').update(result.token).digest('hex'));
  });

  it('keeps all new storage paths disabled until explicitly enabled', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
    const { client, query } = database([]);
    await expect(getOwnConsoleKey(client, identity)).rejects.toMatchObject({ code: 'CONSOLE_SETUP_REQUIRED' });
    await expect(rotateOwnConsoleKey(client, identity)).rejects.toMatchObject({ code: 'CONSOLE_SETUP_REQUIRED' });
    expect(await findDatabaseKey(client, hash)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('database-backed business bearer keys', () => {
  it('retains legacy environment keys without a database credential lookup', async () => {
    vi.stubEnv('CONTEXT_API_KEYS_JSON', JSON.stringify([{ id: 'legacy', hash, employeeEmail: identity.email, scopes: identity.scopes, expiresAt: new Date(now + KEY_LIFETIME_MS).toISOString() }]));
    const lookup = vi.fn();
    expect(await authenticateRequestKey(request(), lookup)).toMatchObject({ id: 'legacy' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up only the token hash and binds the resulting key to its employee ID', async () => {
    const { client, query } = database([row()]);
    const key = await authenticateRequestKey(request(), digest => findDatabaseKey(client, digest, now));
    expect(key).toMatchObject({ source: 'database', employeeId: 7, hash });
    expect(query.mock.calls[0][1]).toEqual([hash]);
    expect(query.mock.calls[0][0]).not.toContain('encrypted_token');
    expect(JSON.stringify(key)).not.toContain(token);
  });

  it('rejects invalid bearer syntax before lookup and respects the disabled feature flag', async () => {
    const lookup = vi.fn();
    await expect(authenticateRequestKey(new Request('https://context.example.test'), lookup)).rejects.toMatchObject({ status: 401 });
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
    await expect(authenticateRequestKey(request(), lookup)).rejects.toMatchObject({ status: 401 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects rotation/revocation before resolving the employee in each read transaction', async () => {
    const key = await findDatabaseKey(database([row()]).client, hash, now);
    const { client, query } = database([]);
    await expect(resolvePrincipal(client, key!)).rejects.toMatchObject({ status: 401 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('expires_at > CURRENT_TIMESTAMP');
    expect(query.mock.calls[0][1]).toEqual([id, hash, 7, identity.email]);
  });

  it('never follows a reassigned email to a different employee record', async () => {
    const key = await findDatabaseKey(database([row()]).client, hash, now);
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id }] }).mockResolvedValueOnce({ rows: [{ id: 8, email: identity.email, is_active: true, dashboardAccess: true, adminAccess: true, twenty_user_id: null }] });
    await expect(resolvePrincipal({ query } as unknown as PoolClient, key!)).rejects.toMatchObject({ status: 403 });
  });

  it('bounds all unknown-token lookups with one shared budget, while environment keys bypass it', async () => {
    // Move beyond any preceding test's window without needing a production
    // reset/export or allocating new limiter keys for each synthetic token.
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    const lookup = vi.fn().mockResolvedValue(null);
    try {
      for (let index = 0; index < 120; index += 1) {
        const unknownToken = `wog_ctx_${Buffer.alloc(32, index).toString('base64url')}`;
        await expect(authenticateRequestKey(request(unknownToken), lookup)).rejects.toMatchObject({ status: 401 });
      }
      expect(lookup).toHaveBeenCalledTimes(120);
      await expect(authenticateRequestKey(request(), lookup)).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      expect(lookup).toHaveBeenCalledTimes(120);

      vi.stubEnv('CONTEXT_API_KEYS_JSON', JSON.stringify([{ id: 'legacy-budget-bypass', hash, employeeEmail: identity.email,
        scopes: identity.scopes, expiresAt: new Date(now + KEY_LIFETIME_MS).toISOString() }]));
      expect(await authenticateRequestKey(request(), lookup)).toMatchObject({ id: 'legacy-budget-bypass' });
      expect(lookup).toHaveBeenCalledTimes(120);

      vi.stubEnv('CONTEXT_API_KEYS_JSON', '[]');
      time.mockReturnValue(now + 180_000);
      await expect(authenticateRequestKey(request(), lookup)).rejects.toMatchObject({ status: 401 });
      expect(lookup).toHaveBeenCalledTimes(121);
    } finally { time.mockRestore(); }
  });
});
