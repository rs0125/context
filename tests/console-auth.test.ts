import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, consoleJson, createConsoleSession, getConsoleIdentity, readConsoleSession, readSignedConsoleValue, requireConsoleOrigin, resolveConsoleEmployee, signedConsoleValue, type ConsoleIdentity } from '../src/lib/console-auth';
import { beginGoogleSignIn, finishGoogleSignIn, verifyGoogleIdToken } from '../src/lib/console-oauth';

const origin = 'https://context.example.test';
const sessionSecret = Buffer.alloc(32, 1).toString('base64url');
const identity: ConsoleIdentity = { employeeId: 7, email: 'employee@wareongo.com', name: 'Test Employee', isAdmin: false, scopes: ['knowledge:read'] };
const roster = { id: 7, email: identity.email, name: identity.name, is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: 'linked-crm-id' };
const now = Date.now();
const env = { NODE_ENV: 'test' as const, CONTEXT_CONSOLE_ORIGIN: origin, CONTEXT_SESSION_SECRET: sessionSecret, GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret' };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-google-key', alg: 'RS256', use: 'sig' };

beforeEach(() => { for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value); vi.stubEnv('ADMIN_EMAILS', ''); });
afterEach(() => vi.unstubAllEnvs());

function cookieRequest(cookie: string, init: RequestInit = {}) {
  return new Request(`${origin}/api/console/me`, { ...init, headers: { cookie, ...init.headers } });
}
function sessionCookie(overrides: Partial<ConsoleIdentity> = {}) {
  return consoleCookie('session', createConsoleSession({ ...identity, ...overrides }, 'google-user-123'), 28800).split(';')[0];
}
function database(rows: unknown[]) { const query = vi.fn().mockResolvedValue({ rows }); return { client: { query } as unknown as PoolClient, query }; }

describe('console session and current employee authorization', () => {
  it('uses signed HttpOnly host-only cookies with fixed bounded lifetime', () => {
    const token = createConsoleSession(identity, 'google-user-123', env, now);
    const cookie = consoleCookie('session', token, 28800, env);
    expect(cookie).toContain('__Host-context_console_session=');
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=28800; Secure');
    expect(cookie).not.toContain('Domain=');
    expect(readConsoleSession(cookieRequest(cookie.split(';')[0]), env, now)).toMatchObject({ email: identity.email, employeeId: 7 });
    expect(consoleJson({ ok: true }).headers.get('cache-control')).toContain('no-store');
  });

  it('rejects tampered, expired, duplicated or wrong-purpose cookies', () => {
    const token = createConsoleSession(identity, 'google-user-123', env, now);
    const name = '__Host-context_console_session';
    expect(() => readConsoleSession(cookieRequest(`${name}=${token.slice(0, -3)}xxx`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), env, now + 28800_000)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}; ${name}=${token}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${signedConsoleValue({ email: identity.email }, 'oauth', env)}`), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(''), env, now)).toThrow();
    expect(() => readConsoleSession(cookieRequest(`${name}=${token}`), { ...env, CONTEXT_CONSOLE_ORIGIN: 'https://preview.example.test' }, now)).toThrow();
  });

  it('rechecks active unique roster identity, scopes and admin permission each request', async () => {
    const { client, query } = database([roster]);
    const request = cookieRequest(sessionCookie());
    expect(await getConsoleIdentity(request, client)).toMatchObject({ employeeId: 7, isAdmin: false, scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, adminAccess: true, dashboardAccess: false, twenty_user_id: null }] });
    expect(await getConsoleIdentity(request, client)).toMatchObject({ isAdmin: true, scopes: ['knowledge:read', 'warehouses:read'] });
    query.mockResolvedValueOnce({ rows: [{ ...roster, is_active: false }] });
    await expect(getConsoleIdentity(request, client)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls[0][0]).not.toMatch(/phone_number|agent_session/);
    expect(query.mock.calls[0][1]).toEqual([identity.email]);
  });

  it.each([[], [roster, { ...roster, id: 8 }], [{ ...roster, id: 8 }]])('refuses missing, duplicate or changed employee IDs', async (...rows) => {
    const { client } = database(rows);
    await expect(getConsoleIdentity(cookieRequest(sessionCookie()), client)).rejects.toMatchObject({ status: 403 });
  });

  it('honors admin email allowlisting only alongside an active roster record', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'OTHER@wareongo.com, EMPLOYEE@wareongo.com');
    const { client } = database([{ ...roster, dashboardAccess: false }]);
    expect(await resolveConsoleEmployee(client, identity.email)).toMatchObject({ isAdmin: true });
    await expect(resolveConsoleEmployee(database([]).client, identity.email)).rejects.toMatchObject({ status: 403 });
    await expect(resolveConsoleEmployee(client, 'employee@other.example')).rejects.toMatchObject({ status: 403 });
  });

  it.each([undefined, 'null', 'https://evil.example', 'http://context.example.test', 'https://context.example.test.evil.example'])('rejects missing or forged browser Origin %s', originHeader => {
    const request = new Request(`${origin}/api/console/key`, { method: 'POST', headers: originHeader ? { Origin: originHeader } : {} });
    expect(() => requireConsoleOrigin(request)).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it('allows only configured same-origin mutation requests', () => {
    expect(() => requireConsoleOrigin(new Request(`${origin}/api/console/key`, { method: 'POST', headers: { Origin: origin } }))).not.toThrow();
    expect(() => requireConsoleOrigin(new Request('https://evil.example/api/console/key', { method: 'POST', headers: { Origin: origin } }))).toThrow();
  });
});

function claims(overrides: Record<string, unknown> = {}) {
  return { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: 'google-user-123',
    email: identity.email, email_verified: true, hd: 'wareongo.com', nonce: 'test-nonce',
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...overrides };
}
function token(payload = claims(), header: Record<string, unknown> = { alg: 'RS256', kid: jwk.kid }) {
  const unsigned = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

describe('Google identity verification', () => {
  it('verifies a real RSA signature and the exact work-domain claims', () => {
    expect(verifyGoogleIdToken(token(), 'test-nonce', env.GOOGLE_CLIENT_ID, [jwk], now)).toEqual({ email: identity.email, sub: 'google-user-123' });
    expect(verifyGoogleIdToken(token(claims({ aud: ['another-audience', env.GOOGLE_CLIENT_ID], azp: env.GOOGLE_CLIENT_ID })), 'test-nonce', env.GOOGLE_CLIENT_ID, [jwk], now)).toMatchObject({ email: identity.email });
  });

  it.each([
    { iss: 'https://accounts.google.com.evil.example' }, { aud: 'other-client' },
    { aud: [env.GOOGLE_CLIENT_ID, 'other-client'] }, { azp: 'other-client' },
    { nonce: 'other-nonce' }, { hd: 'gmail.com' }, { hd: undefined },
    { email: 'employee@wareongo.com.evil.example' }, { email_verified: false }, { email_verified: 'true' },
    { sub: undefined }, { exp: Math.floor(now / 1000) }, { iat: Math.floor(now / 1000) + 120 },
    { iat: Math.floor(now / 1000) - 601 }, { exp: Math.floor(now / 1000) + 10000 },
    { nbf: Math.floor(now / 1000) + 120 },
  ])('rejects an invalid signed identity assertion %j', overrides => {
    expect(() => verifyGoogleIdToken(token(claims(overrides)), 'test-nonce', env.GOOGLE_CLIENT_ID, [jwk], now)).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it('rejects algorithm/key substitution and invalid signatures', () => {
    for (const header of [{ alg: 'none', kid: jwk.kid }, { alg: 'HS256', kid: jwk.kid }, { alg: 'RS256', kid: 'wrong' }, { alg: 'RS256', kid: jwk.kid, jku: 'https://evil.example' }]) {
      expect(() => verifyGoogleIdToken(token(claims(), header), 'test-nonce', env.GOOGLE_CLIENT_ID, [jwk], now)).toThrow();
    }
    const good = token();
    expect(() => verifyGoogleIdToken(`${good.slice(0, -8)}AAAAAAAA`, 'test-nonce', env.GOOGLE_CLIENT_ID, [jwk], now)).toThrow();
  });

  it('binds Google authorization to browser state, PKCE and nonce without a database socket', async () => {
    const start = beginGoogleSignIn(env, now);
    const authorization = new URL(start.url);
    const cookie = start.cookie.split(';')[0];
    const transaction = readSignedConsoleValue(cookie.slice(cookie.indexOf('=') + 1), 'oauth', env);
    expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(String(transaction.verifier)).digest('base64url'));
    expect(authorization.searchParams.get('hd')).toBe('wareongo.com');
    expect(start.url).not.toContain(String(transaction.verifier));
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/token')) {
        const body = init?.body as URLSearchParams;
        expect(body.get('code_verifier')).toBe(transaction.verifier);
        expect(init?.redirect).toBe('error');
        return Response.json({ id_token: token(claims({ nonce: transaction.nonce })) });
      }
      return Response.json({ keys: [jwk] }, { headers: { 'Cache-Control': 'max-age=300' } });
    });
    const callback = new Request(`${origin}/api/auth/google/callback?code=test-code&state=${transaction.state}`, { headers: { Cookie: cookie } });
    expect(await finishGoogleSignIn(callback, { env, now, fetch: fetcher })).toEqual({ email: identity.email, sub: 'google-user-123' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const wrongState = new Request(`${origin}/api/auth/google/callback?code=test-code&state=wrong`, { headers: { Cookie: cookie } });
    fetcher.mockClear();
    await expect(finishGoogleSignIn(wrongState, { env, now, fetch: fetcher })).rejects.toThrow();
    await expect(finishGoogleSignIn(callback, { env, now: now + 600_000, fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
