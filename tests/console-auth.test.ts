import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, consoleJson, createConsoleSession, getConsoleIdentity, readConsoleSession, readSignedConsoleValue, requireConsoleOrigin, resolveConsoleEmployee, signedConsoleValue, type ConsoleIdentity } from '../src/lib/console-auth';
import { resolvePrincipal } from '../src/lib/auth';

const origin = 'https://context.example.test';
const subject = 'google:107654321012345678901';
const identity: ConsoleIdentity = { employeeId: 7, email: 'employee@wareongo.com', name: 'Test Employee', isAdmin: false, scopes: ['knowledge:read'] };
const roster = { id: 7, email: identity.email, name: identity.name, is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: '11111111-1111-4111-8111-111111111111' };
const now = Date.now();
const env = { NODE_ENV: 'test' as const, CONTEXT_CONSOLE_ORIGIN: origin, CONTEXT_SESSION_SECRET: Buffer.alloc(32, 1).toString('base64url') };
beforeEach(() => { for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const cookieRequest = (cookie: string) => new Request(`${origin}/api/console/me`, { headers: { cookie } });
function sessionCookie(overrides: Partial<ConsoleIdentity> = {}) {
  return consoleCookie('session', createConsoleSession({ ...identity, ...overrides }, subject), 28800).split(';')[0];
}
function signedSession(overrides: Record<string, unknown>) {
  return consoleCookie('session', signedConsoleValue({ employeeId: 7, email: identity.email, sub: subject,
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 28800, sid: 'A'.repeat(32), ...overrides }, 'session'), 28800).split(';')[0];
}
function database(rows: unknown[]) { const query = vi.fn().mockResolvedValue({ rows }); return { query, client: { query } as unknown as PoolClient }; }

describe('Google employee sessions and current roster authorization', () => {
  it('uses signed HttpOnly host-only cookies with fixed eight-hour lifetime and a provider subject', () => {
    const token = createConsoleSession(identity, subject, env, now);
    const cookie = consoleCookie('session', token, 28800, env);
    expect(cookie).toContain('__Host-context_console_session=');
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=28800; Secure');
    expect(cookie).not.toContain('Domain=');
    expect(readConsoleSession(cookieRequest(cookie.split(';')[0]), env, now)).toMatchObject({ email: identity.email, employeeId: 7, sub: subject });
    expect(consoleJson({ ok: true }).headers.get('cache-control')).toContain('no-store');
  });
  it('rejects tampered, expired, duplicated, incomplete and cross-origin cookies', () => {
    const token = createConsoleSession(identity, subject, env, now), name = '__Host-context_console_session';
    expect(() => readConsoleSession(cookieRequest(`${name}=${token.slice(0, -3)}xxx`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), env, now + 28800_000)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}; ${name}=${token}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${signedConsoleValue({ email: identity.email }, 'session', env)}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(''), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), { ...env, CONTEXT_CONSOLE_ORIGIN: 'https://preview.example.test' }, now)).toThrow();
  });
  it.each(['password-admin', 'legacy-external-subject', 'google:', `google:${identity.email}`, 'google:bad subject'])('rejects legacy or invalid subject %s before database work', async sub => {
    const { client, query } = database([roster]);
    await expect(getConsoleIdentity(cookieRequest(signedSession({ sub })), client)).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
  });
  it('separates Google OAuth state signatures from authenticated session signatures', () => {
    const value = signedConsoleValue({ state: 'synthetic-state' }, 'google-oauth');
    expect(readSignedConsoleValue(value, 'google-oauth')).toEqual({ state: 'synthetic-state' });
    expect(() => readSignedConsoleValue(value, 'session')).toThrowError(expect.objectContaining({ status: 401 }));
  });
  it('rechecks active unique roster identity and role on every request, without cached admin claims', async () => {
    const { client, query } = database([roster]);
    const request = cookieRequest(sessionCookie({ isAdmin: true }));
    expect(await getConsoleIdentity(request, client)).toMatchObject({ employeeId: 7, isAdmin: false, scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, adminAccess: true, dashboardAccess: false, twenty_user_id: null }] });
    expect(await getConsoleIdentity(request, client)).toMatchObject({ isAdmin: true, scopes: ['knowledge:read', 'warehouses:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, dashboardAccess: false, twenty_user_id: null }] });
    expect(await getConsoleIdentity(request, client)).toMatchObject({ isAdmin: false, scopes: ['knowledge:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, is_active: false }] });
    await expect(getConsoleIdentity(request, client)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls[0][0]).not.toMatch(/phone_number|agent_session/);
    expect(query.mock.calls[0][1]).toEqual([identity.email]);
  });
  it.each([
    { label: 'missing', rows: [] }, { label: 'inactive', rows: [{ ...roster, is_active: false }] },
    { label: 'non-boolean active', rows: [{ ...roster, is_active: 'true' }] },
    { label: 'duplicate case-insensitive email', rows: [roster, { ...roster, id: 8, email: 'Employee@wareongo.com' }] },
    { label: 'changed ID', rows: [{ ...roster, id: 8 }] }, { label: 'changed email', rows: [{ ...roster, email: 'other@wareongo.com' }] },
  ])('refuses a $label roster identity', async ({ rows }) => {
    await expect(getConsoleIdentity(cookieRequest(sessionCookie()), database(rows).client)).rejects.toMatchObject({ status: 403 });
  });
  it('allows other active work employees and ignores all environment admin identities', async () => {
    vi.stubEnv('CONTEXT_ADMIN_EMAIL', identity.email); vi.stubEnv('ADMIN_EMAILS', 'OTHER@wareongo.com, EMPLOYEE@wareongo.com');
    const email = 'other@wareongo.com';
    const { client } = database([{ ...roster, id: 8, email, dashboardAccess: false, twenty_user_id: null }]);
    expect(await resolveConsoleEmployee(client, email)).toMatchObject({ employeeId: 8, email, isAdmin: false, scopes: ['knowledge:read'] });
    expect(await getConsoleIdentity(cookieRequest(sessionCookie({ employeeId: 8, email })), client)).toMatchObject({ employeeId: 8, isAdmin: false });
  });
  it.each(['', 'employee@example.com', 'employee@wareongo.com.evil.example', 'a b@wareongo.com', 'a@b@wareongo.com'])('rejects invalid or external work identity %s before DB lookup', async email => {
    const { client, query } = database([]);
    await expect(resolveConsoleEmployee(client, email)).rejects.toMatchObject({ status: 403 });
    expect(() => readConsoleSession(cookieRequest(signedSession({ email })))).toThrowError(expect.objectContaining({ status: 401 }));
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { dashboardAccess: false, adminAccess: false, twenty_user_id: null },
    { dashboardAccess: true, adminAccess: false, twenty_user_id: roster.twenty_user_id },
    { dashboardAccess: false, adminAccess: true, twenty_user_id: null },
    { dashboardAccess: 'true', adminAccess: 'true', twenty_user_id: 'invalid-id' },
  ])('derives identical current scopes for console and REST credentials', async permissions => {
    const { client } = database([{ ...roster, ...permissions }]);
    const browser = await resolveConsoleEmployee(client, identity.email);
    const agent = await resolvePrincipal(client, { id: 'synthetic-key', hash: 'a'.repeat(64), employeeEmail: identity.email,
      scopes: ['knowledge:read', 'warehouses:read', 'crm:read'], expiresAt: '2099-01-01T00:00:00Z' });
    expect(browser.scopes).toEqual(agent.scopes);
    expect(browser.isAdmin).toBe(permissions.adminAccess === true);
  });
  it.each([undefined, 'null', 'https://evil.example', 'http://context.example.test', 'https://context.example.test.evil.example'])('rejects missing or forged browser Origin %s', originHeader => {
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: originHeader ? { Origin: originHeader } : {} }))).toThrowError(expect.objectContaining({ status: 403 }));
  });
  it('allows only configured same-origin mutations', () => {
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: { Origin: origin } }))).not.toThrow();
    expect(() => requireConsoleOrigin(new Request('https://evil.example/api/console/key', { method: 'POST', headers: { Origin: origin } }))).toThrow();
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } }))).toThrow();
  });
});
