import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleAdminEmail, consoleCookie, consoleJson, createConsoleSession, getConsoleIdentity, PASSWORD_SESSION_SUBJECT, readConsoleSession, requireConsoleOrigin, resolveConsoleEmployee, signedConsoleValue, type ConsoleIdentity } from '../src/lib/console-auth';
import { handlePasswordLogin, matchesConsolePassword } from '../src/lib/console-password';

const origin = 'https://context.example.test';
const sessionSecret = Buffer.alloc(32, 1).toString('base64url');
const password = 'synthetic-test-admin-password-0123456789';
const identity: ConsoleIdentity = { employeeId: 7, email: 'employee@wareongo.com', name: 'Test Employee', isAdmin: true, scopes: ['knowledge:read'] };
const roster = { id: 7, email: identity.email, name: identity.name, is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: 'linked-crm-id' };
const now = Date.now();
const env = { NODE_ENV: 'test' as const, CONTEXT_CONSOLE_ORIGIN: origin, CONTEXT_SESSION_SECRET: sessionSecret, CONTEXT_ADMIN_EMAIL: identity.email, CONTEXT_ADMIN_PASSWORD: password };

beforeEach(() => { for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value); vi.stubEnv('ADMIN_EMAILS', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function cookieRequest(cookie: string, init: RequestInit = {}) {
  return new Request(`${origin}/api/console/me`, { ...init, headers: { cookie, ...init.headers } });
}
function sessionCookie(overrides: Partial<ConsoleIdentity> = {}, subject = PASSWORD_SESSION_SUBJECT) {
  return consoleCookie('session', createConsoleSession({ ...identity, ...overrides }, subject), 28800).split(';')[0];
}
function database(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const client = { query } as unknown as PoolClient;
  const checkout = vi.fn();
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => { checkout(); return work(client); };
  return { client, query, checkout, transaction, limit: vi.fn() };
}
function login(body: unknown = { password }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('password admin session and current roster authorization', () => {
  it('uses signed HttpOnly host-only cookies with fixed eight-hour lifetime', () => {
    const token = createConsoleSession(identity, PASSWORD_SESSION_SUBJECT, env, now);
    const cookie = consoleCookie('session', token, 28800, env);
    expect(cookie).toContain('__Host-context_console_session=');
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=28800; Secure');
    expect(cookie).not.toContain('Domain=');
    expect(readConsoleSession(cookieRequest(cookie.split(';')[0]), env, now)).toMatchObject({ email: identity.email, employeeId: 7, sub: PASSWORD_SESSION_SUBJECT });
    expect(consoleJson({ ok: true }).headers.get('cache-control')).toContain('no-store');
  });

  it('rejects tampered, expired, duplicated, incomplete and cross-origin cookies', () => {
    const token = createConsoleSession(identity, PASSWORD_SESSION_SUBJECT, env, now);
    const name = '__Host-context_console_session';
    expect(() => readConsoleSession(cookieRequest(`${name}=${token.slice(0, -3)}xxx`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), env, now + 28800_000)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}; ${name}=${token}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${signedConsoleValue({ email: identity.email }, 'session', env)}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(''), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), { ...env, CONTEXT_CONSOLE_ORIGIN: 'https://preview.example.test' }, now)).toThrow();
  });

  it('rejects legacy identity subjects and any employee other than the configured admin before database work', async () => {
    const { client, query } = database([roster]);
    for (const cookie of [sessionCookie({}, 'legacy-external-subject'), sessionCookie({ email: 'other@wareongo.com' })]) {
      await expect(getConsoleIdentity(cookieRequest(cookie), client)).rejects.toMatchObject({ status: 401 });
    }
    const cookie = sessionCookie();
    vi.stubEnv('CONTEXT_ADMIN_EMAIL', 'new-admin@wareongo.com');
    await expect(getConsoleIdentity(cookieRequest(cookie), client)).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
  });

  it('rechecks active unique roster identity and derives API scopes from source permissions, independently of console admin', async () => {
    const { client, query } = database([roster]);
    const request = cookieRequest(sessionCookie());
    expect(await getConsoleIdentity(request, client)).toMatchObject({ employeeId: 7, isAdmin: true, scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, adminAccess: true, dashboardAccess: false, twenty_user_id: null }] });
    expect(await getConsoleIdentity(request, client)).toMatchObject({ isAdmin: true, scopes: ['knowledge:read', 'warehouses:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, adminAccess: false, dashboardAccess: false, twenty_user_id: null }] });
    expect(await getConsoleIdentity(request, client)).toMatchObject({ isAdmin: true, scopes: ['knowledge:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, is_active: false }] });
    await expect(getConsoleIdentity(request, client)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls[0][0]).not.toMatch(/phone_number|agent_session/);
    expect(query.mock.calls[0][1]).toEqual([identity.email]);
  });

  it.each([
    { label: 'missing', rows: [] },
    { label: 'duplicate', rows: [roster, { ...roster, id: 8 }] },
    { label: 'changed ID', rows: [{ ...roster, id: 8 }] },
  ])('refuses a $label roster identity', async ({ rows }) => {
    await expect(getConsoleIdentity(cookieRequest(sessionCookie()), database(rows).client)).rejects.toMatchObject({ status: 403 });
  });

  it('does not use the broader API admin allowlist to select a console user or widen scopes', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'OTHER@wareongo.com, EMPLOYEE@wareongo.com');
    const { client } = database([{ ...roster, dashboardAccess: false, twenty_user_id: null }]);
    expect(await resolveConsoleEmployee(client, identity.email)).toMatchObject({ isAdmin: true, scopes: ['knowledge:read'] });
    await expect(resolveConsoleEmployee(client, 'other@wareongo.com')).rejects.toMatchObject({ status: 403 });
    await expect(resolveConsoleEmployee(database([]).client, identity.email)).rejects.toMatchObject({ status: 403 });
  });

  it.each(['', 'employee@example.com', 'employee@wareongo.com.evil.example', 'a b@wareongo.com'])('rejects invalid configured admin identity %s', value => {
    expect(() => consoleAdminEmail({ ...env, CONTEXT_ADMIN_EMAIL: value })).toThrowError(expect.objectContaining({ status: 503 }));
  });

  it.each([undefined, 'null', 'https://evil.example', 'http://context.example.test', 'https://context.example.test.evil.example'])('rejects missing or forged browser Origin %s', originHeader => {
    const request = new Request(`${origin}/api/console/key`, { method: 'POST', headers: originHeader ? { Origin: originHeader } : {} });
    expect(() => requireConsoleOrigin(request)).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it('allows only the configured same-origin mutation request', () => {
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: { Origin: origin } }))).not.toThrow();
    expect(() => requireConsoleOrigin(new Request('https://evil.example/api/console/key', { method: 'POST', headers: { Origin: origin } }))).toThrow();
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } }))).toThrow();
  });
});

describe('bounded admin password login', () => {
  it('compares the exact password and issues a session after a read-only current roster lookup', async () => {
    const dependencies = database([roster]);
    const response = await handlePasswordLogin(login(), dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toContain('no-store');
    const cookie = response.headers.get('set-cookie')!;
    expect(readConsoleSession(cookieRequest(cookie.split(';')[0]))).toMatchObject({ email: identity.email, employeeId: identity.employeeId, sub: PASSWORD_SESSION_SUBJECT });
    expect(dependencies.checkout).toHaveBeenCalledOnce();
    expect(dependencies.limit).toHaveBeenCalledOnce();
    expect(dependencies.query.mock.calls[0][1]).toEqual([identity.email]);
    expect(JSON.stringify(dependencies.query.mock.calls)).not.toContain(password);
    expect(matchesConsolePassword(password, env)).toBe(true);
    expect(matchesConsolePassword(`${password} `, env)).toBe(false);
  });

  it.each(['', 'wrong', 'wrong-password-of-a-different-length'])('returns a generic failure without database allocation for wrong passwords', async wrong => {
    const dependencies = database([roster]);
    const response = await handlePasswordLogin(login({ password: wrong }), dependencies);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'CONSOLE_INVALID_CREDENTIALS', message: 'Password verification failed.' } });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(dependencies.checkout).not.toHaveBeenCalled();
  });

  it.each(['', 'short-password', ' '.repeat(24), 'x'.repeat(257)])('fails closed for missing, weak-length or oversized configured passwords', async configured => {
    vi.stubEnv('CONTEXT_ADMIN_PASSWORD', configured);
    const dependencies = database([roster]);
    const response = await handlePasswordLogin(login(), dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONSOLE_CONFIGURATION' } });
    expect(dependencies.checkout).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { password: 123 }, { password, email: 'other@wareongo.com' }, { password: 'x'.repeat(257) }])('rejects malformed or additional login fields', async body => {
    const dependencies = database([roster]);
    expect((await handlePasswordLogin(login(body), dependencies)).status).toBe(400);
    expect(dependencies.checkout).not.toHaveBeenCalled();
  });

  it('rejects declared or streamed oversized bodies, invalid JSON and wrong media type before database work', async () => {
    const dependencies = database([roster]);
    expect((await handlePasswordLogin(login({ password }, { 'Content-Length': '4097' }), dependencies)).status).toBe(413);
    expect((await handlePasswordLogin(login({ password: 'x'.repeat(4097) }), dependencies)).status).toBe(413);
    expect((await handlePasswordLogin(login({ password }, { 'Content-Type': 'text/plain' }), dependencies)).status).toBe(415);
    const malformed = new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
    expect((await handlePasswordLogin(malformed, dependencies)).status).toBe(400);
    expect(dependencies.checkout).not.toHaveBeenCalled();
  });

  it('blocks cross-origin login before consuming the password budget or allocating a database connection', async () => {
    const dependencies = database([roster]);
    expect((await handlePasswordLogin(login({ password }, { Origin: 'https://evil.example' }), dependencies)).status).toBe(403);
    expect(dependencies.limit).not.toHaveBeenCalled();
    expect(dependencies.checkout).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'inactive', rows: [{ ...roster, is_active: false }] },
    { label: 'missing', rows: [] },
    { label: 'duplicate', rows: [roster, { ...roster, id: 8 }] },
  ])('does not issue a session for a $label roster identity even with a correct password', async ({ rows }) => {
    const response = await handlePasswordLogin(login(), database(rows));
    expect(response.status).toBe(403);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('bounds all password attempts with one fixed global bucket before the database, including a valid password after exhaustion', async () => {
    const dependencies = database([roster]);
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    for (let i = 0; i < 10; i++) {
      expect((await handlePasswordLogin(login({ password: `wrong-${i}` }), { transaction: dependencies.transaction })).status).toBe(401);
    }
    const blocked = await handlePasswordLogin(login(), { transaction: dependencies.transaction });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(dependencies.checkout).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(now + 181_000);
    expect((await handlePasswordLogin(login(), { transaction: dependencies.transaction })).status).toBe(200);
    expect(dependencies.checkout).toHaveBeenCalledOnce();
  });
});
