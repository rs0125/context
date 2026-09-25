import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, createConsoleSession, type ConsoleIdentity } from '../src/lib/console-auth';
import { encryptConsoleKey } from '../src/lib/console-keys';

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('../src/lib/db', () => ({ withReadOnlyTransaction: mocks.read, withConsoleWriteTransaction: mocks.write }));
import { GET as getMe } from '../src/app/api/console/me/route';
import { GET as getKey, POST as rotateKey } from '../src/app/api/console/key/route';
import { POST as logout } from '../src/app/api/auth/logout/route';

const origin = 'https://context.example.test';
const identity: ConsoleIdentity = { employeeId: 19, email: 'employee@wareongo.com', name: 'Example', isAdmin: false, scopes: ['knowledge:read', 'warehouses:read'] };
const roster = { id: 19, email: identity.email, name: identity.name, is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: null };
const token = `wog_ctx_${Buffer.alloc(32, 6).toString('base64url')}`;
const id = 'console_11111111-1111-4111-8111-111111111111';
const client = { query: mocks.query } as unknown as PoolClient;

beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
  vi.stubEnv('CONTEXT_KEY_ENCRYPTION_SECRET', Buffer.alloc(32, 2).toString('base64url'));
  vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
  vi.stubEnv('ADMIN_EMAILS', '');
  mocks.query.mockReset(); mocks.read.mockReset(); mocks.write.mockReset();
  mocks.read.mockImplementation(async (work: (client: PoolClient) => unknown) => work(client));
  mocks.write.mockImplementation(async (work: (client: PoolClient) => unknown) => work(client));
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('VerifiedNumber')) return { rows: [roster] };
    if (sql.startsWith('INSERT')) {
      const [id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at] = values;
      return { rows: [{ id, employee_id, employee_email, token_hash, encrypted_token, scopes, expires_at }] };
    }
    return { rows: [{ id, employee_id: identity.employeeId, employee_email: identity.email,
      token_hash: createHash('sha256').update(token).digest('hex'), encrypted_token: encryptConsoleKey(token, id, identity),
      scopes: identity.scopes, expires_at: new Date(Date.now() + 86400_000) }] };
  });
});
afterEach(() => vi.unstubAllEnvs());

function request(route: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  const cookie = consoleCookie('session', createConsoleSession(identity, 'test-google-user'), 28800).split(';')[0];
  return new Request(`${origin}${route}`, { method, body, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: origin } : {}), ...headers } });
}

describe('console HTTP boundaries', () => {
  it('returns the current identity, full API base and deferred-write capability', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
    const response = await getMe(request('/api/console/me'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ employee: { email: identity.email, name: identity.name, isAdmin: false, scopes: identity.scopes }, apiBaseUrl: `${origin}/api/v1`, capabilities: { writesEnabled: false } });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('employee_api_keys'))).toBe(false);
  });

  it('rejects missing sessions before any database work', async () => {
    expect((await getMe(new Request(`${origin}/api/console/me`))).status).toBe(401);
    expect((await getKey(new Request(`${origin}/api/console/key`))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it('keeps staged key storage disabled without touching the private table', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
    for (const response of [await getKey(request('/api/console/key')), await rotateKey(request('/api/console/key', 'POST'))]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'CONSOLE_SETUP_REQUIRED' } });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('recopies only the current user key with a private uncached response', async () => {
    const response = await getKey(request('/api/console/key'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: { id, token, scopes: identity.scopes } });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(mocks.query.mock.calls[1][1]).toEqual([19, identity.email]);
  });

  it('rotates an authenticated same-origin key using current roster scopes', async () => {
    const response = await rotateKey(request('/api/console/key', 'POST', '{}'));
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output.key.token).toMatch(/^wog_ctx_[A-Za-z0-9_-]{43}$/);
    expect(output.key.scopes).toEqual(identity.scopes);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(output.key.token);
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it.each(['https://evil.example', 'null', ''])('rejects key-rotation CSRF %s before opening a transaction', async Origin => {
    const response = await rotateKey(request('/api/console/key', 'POST', undefined, { Origin }));
    expect(response.status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('rejects attempts to select another employee or supply scopes', async () => {
    expect((await getKey(request('/api/console/key?employee_id=20'))).status).toBe(400);
    expect((await rotateKey(request('/api/console/key', 'POST', JSON.stringify({ employeeId: 20, scopes: ['crm:read'] })))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('checks employee deactivation again before a key read or rotation', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...roster, is_active: false }] });
    expect((await getKey(request('/api/console/key'))).status).toBe(403);
    expect((await rotateKey(request('/api/console/key', 'POST'))).status).toBe(403);
    expect(mocks.query.mock.calls.some(([sql]) => !String(sql).includes('VerifiedNumber'))).toBe(false);
  });

  it('clears both HttpOnly cookies only for same-origin logout and returns JSON', async () => {
    expect((await logout(request('/api/auth/logout', 'POST', undefined, { Origin: 'https://evil.example' }))).status).toBe(403);
    const response = await logout(request('/api/auth/logout', 'POST'));
    expect(await response.json()).toEqual({ signedOut: true });
    expect(response.headers.get('set-cookie')).toContain('context_console_session=;');
    expect(response.headers.get('set-cookie')).toContain('context_console_oauth=;');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
