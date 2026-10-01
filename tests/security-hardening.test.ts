import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, createConsoleSession, getConsoleIdentity, type ConsoleIdentity } from '../src/lib/console-auth';
import { resolvePrincipal, type KeyRegistration } from '../src/lib/auth';
import { securityAudit } from '../src/lib/security-audit';
import { HttpError } from '../src/lib/errors';

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../src/lib/db', () => ({ withSessionWriteTransaction: mocks.write }));
import { POST as logout } from '../src/app/api/auth/logout/route';

const origin = 'https://context.example.test';
const identity: ConsoleIdentity = { employeeId: 7, email: 'employee@wareongo.com', name: 'Synthetic employee',
  isAdmin: false, isAnalyst: true, scopes: ['knowledge:read', 'crm:read', 'analytics:read'] };
const roster = { id: 7, email: identity.email, name: identity.name, is_active: true,
  adminAccess: false, analystAccess: true, dashboardAccess: false, twenty_user_id: null };
const key: KeyRegistration = { id: 'legacy', hash: 'a'.repeat(64), employeeEmail: identity.email,
  scopes: ['knowledge:read', 'crm:read'], expiresAt: '2099-01-01T00:00:00Z' };
const request = (cookie?: string, method = 'GET') => new Request(`${origin}/api/auth/logout`, { method,
  headers: { Origin: origin, ...(cookie ? { cookie } : {}) } });
beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
  mocks.write.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('durable session revocation', () => {
  it('rejects a copied cookie after logout, including on a separate database client', async () => {
    const revoked = new Set<string>();
    const database = () => ({ query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('VerifiedNumber')) return { rows: [roster] };
      if (sql.startsWith('INSERT')) { revoked.add(String(values[0])); return { rows: [] }; }
      if (sql.startsWith('DELETE')) return { rows: [] };
      return { rows: revoked.has(String(values[0])) ? [{ session_hash: values[0] }] : [] };
    }) });
    const first = database(), second = database();
    mocks.write.mockImplementation(async work => work(first));
    const cookie = consoleCookie('session', createConsoleSession(identity, 'google:123'), 28800).split(';')[0];
    expect(await getConsoleIdentity(request(cookie), first as unknown as PoolClient)).toMatchObject({ employeeId: 7 });
    const response = await logout(request(cookie, 'POST'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(getConsoleIdentity(request(cookie), second as unknown as PoolClient)).rejects.toMatchObject({ status: 401 });
    expect((await logout(request(cookie, 'POST'))).status).toBe(200);
    expect(revoked.size).toBe(1);
    expect([...revoked][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first.query.mock.calls)).not.toContain(cookie);
    const fresh = consoleCookie('session', createConsoleSession(identity, 'google:123'), 28800).split(';')[0];
    expect(await getConsoleIdentity(request(fresh), second as unknown as PoolClient)).toMatchObject({ employeeId: 7 });
  });
  it('does not claim successful logout or discard the retry cookie when revocation fails', async () => {
    mocks.write.mockRejectedValue(new Error('database down; secret connection string'));
    const cookie = consoleCookie('session', createConsoleSession(identity, 'google:123'), 28800).split(';')[0];
    const result = await logout(request(cookie, 'POST'));
    expect(result.status).toBe(503); expect(result.headers.has('set-cookie')).toBe(false);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('secret connection');
  });
  it('allows missing or invalid expired sessions to clear cookies without a database write', async () => {
    expect((await logout(request(undefined, 'POST'))).status).toBe(200);
    expect((await logout(request('__Host-context_console_session=invalid', 'POST'))).status).toBe(200);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('fails closed if the shared revocation lookup is unavailable', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('VerifiedNumber')) return { rows: [roster] };
      throw new Error('storage unavailable');
    }) } as unknown as PoolClient;
    const cookie = consoleCookie('session', createConsoleSession(identity, 'google:123'), 28800).split(';')[0];
    await expect(getConsoleIdentity(request(cookie), client)).rejects.toThrow('storage unavailable');
  });
});

describe('immutable environment key identity', () => {
  it.each([undefined, 7])('rejects email reassignment for migrated or explicit ID %j', async employeeId => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('legacy_key_bindings') ? [{ employee_id: 7 }] : [{ ...roster, id: 8 }] }));
    await expect(resolvePrincipal({ query } as unknown as PoolClient, { ...key, employeeId })).rejects.toMatchObject({ status: 403 });
  });
  it('preserves a migrated token and its existing narrow scopes', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('legacy_key_bindings') ? [{ employee_id: 7 }] : [roster] }));
    expect(await resolvePrincipal({ query } as unknown as PoolClient, key)).toMatchObject({ employeeId: 7, scopes: key.scopes });
    expect(query.mock.calls[0][0]).toContain('token_hash = $2');
  });
  it.each([[], [{ employee_id: '7' }], [{ employee_id: 7 }, { employee_id: 8 }]].map(rows => [rows]))('rejects missing or corrupt migration bindings (%#)', async rows => {
    const query = vi.fn(async () => ({ rows }));
    await expect(resolvePrincipal({ query } as unknown as PoolClient, key)).rejects.toMatchObject({ status: 401 });
    expect(query).toHaveBeenCalledOnce();
  });
});

it('security logs allow only bounded metadata, never arbitrary error or source content', () => {
  const secret = 'wog_ctx_' + createHash('sha256').update('synthetic').digest('base64url');
  securityAudit('key_rotate', 'failure', { employeeId: 7, resourceId: secret + '@example.test', error: new Error(secret) });
  securityAudit('prompt_save', 'failure', { employeeId: 7, error: new HttpError(403, 'ADMIN_REQUIRED', secret) });
  const logs = vi.mocked(console.info).mock.calls.map(([value]) => JSON.parse(value));
  expect(logs).toEqual([
    { event: 'context_security', action: 'key_rotate', outcome: 'failure', employee_id: 7, code: 'INTERNAL_ERROR' },
    { event: 'context_security', action: 'prompt_save', outcome: 'failure', employee_id: 7, code: 'ADMIN_REQUIRED' },
  ]);
  expect(JSON.stringify(logs)).not.toContain(secret);
});
