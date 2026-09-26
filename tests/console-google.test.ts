import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { PoolClient } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALLBACK_PATH, GOOGLE_FLOW_SECONDS, handleGoogleCallback, handleGoogleLogin, verifyGoogleIdToken } from '../src/lib/console-google';
import { consoleCookie, readConsoleSession, readSignedConsoleValue, signedConsoleValue } from '../src/lib/console-auth';
import { HttpError } from '../src/lib/errors';
import { POST as rejectPassword } from '../src/app/api/auth/login/route';
import type { withReadOnlyTransaction } from '../src/lib/db';

const origin = 'https://context.example.test';
const clientId = 'synthetic-client.apps.googleusercontent.com';
const clientSecret = 'synthetic-client-secret-never-returned';
const now = Date.UTC(2026, 8, 26, 12);
const seconds = Math.floor(now / 1000);
const nonce = 'N'.repeat(43), state = 'S'.repeat(43), verifier = 'V'.repeat(43);
const email = 'employee@wareongo.com';
const subject = '107654321012345678901';
const flow = { state, nonce, verifier, clientId, iat: seconds, exp: seconds + GOOGLE_FLOW_SECONDS };
const roster = { id: 7, email, name: 'Synthetic Employee', is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: null };
let signingKey: CryptoKey, otherKey: CryptoKey, getKey: JWTVerifyGetKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  const first = await generateKeyPair('RS256');
  signingKey = first.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  publicJwk = { ...await exportJWK(first.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});
beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
  vi.stubEnv('GOOGLE_CLIENT_ID', clientId);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', clientSecret);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function signedToken(overrides: Record<string, unknown> = {}, key = signingKey, header: Record<string, unknown> = {}) {
  const claims: JWTPayload = { iss: 'https://accounts.google.com', aud: clientId, sub: subject, iat: seconds, exp: seconds + 3600,
    nonce, email, email_verified: true, hd: 'wareongo.com', ...overrides };
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key', ...header }).sign(key);
}
function flowCookie(overrides: Record<string, unknown> = {}, purpose: 'google-oauth' | 'session' = 'google-oauth') {
  return consoleCookie('oauth', signedConsoleValue({ ...flow, ...overrides }, purpose), 600).split(';')[0];
}
function callbackRequest(query: Record<string, string | undefined> = {}, cookie = flowCookie()) {
  const url = new URL(`${origin}${GOOGLE_CALLBACK_PATH}`);
  url.search = new URLSearchParams({ code: 'synthetic-one-use-code', state }).toString();
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
  return new Request(url, { headers: { cookie } });
}
async function dependencies(claims: Record<string, unknown> = {}, rows: unknown[] = [roster]) {
  const token = await signedToken(claims);
  const query = vi.fn().mockResolvedValue({ rows });
  const transaction = vi.fn(async <T>(operation: (client: PoolClient) => Promise<T>) => operation({ query } as unknown as PoolClient));
  const fetch = vi.fn().mockResolvedValue(Response.json({ id_token: token, access_token: 'ignored-provider-access-token', refresh_token: 'ignored-provider-refresh-token' }));
  const verify = vi.fn((value: string, expected: Parameters<typeof verifyGoogleIdToken>[1]) => verifyGoogleIdToken(value, expected, getKey));
  return { fetch, transaction: transaction as typeof withReadOnlyTransaction, verify, limit: vi.fn(), now: () => now, query };
}
function assertFailure(response: Response, code: string, clearFlow = true) {
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`${origin}/?error=${code}`);
  expect(response.headers.getSetCookie()).toEqual(clearFlow
    ? [expect.stringContaining('context_console_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure')] : []);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('Google console authorization request', () => {
  it('starts code + PKCE S256 with distinct random state/nonce and a purpose-signed ten-minute cookie', async () => {
    const limit = vi.fn();
    const response = await handleGoogleLogin(new Request(`${origin}/api/auth/login`), { limit, now: () => now });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    expect(cookie).not.toContain('Domain=');
    const saved = readSignedConsoleValue(cookie.split(';')[0].split('=')[1], 'google-oauth');
    expect(saved).toMatchObject({ iat: seconds, exp: seconds + 600, clientId });
    expect(saved.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([saved.state, saved.nonce, saved.verifier]).size).toBe(3);
    expect(Object.fromEntries(target.searchParams)).toEqual({ client_id: clientId, response_type: 'code',
      scope: 'openid email', redirect_uri: `${origin}/api/auth/google/callback`, state: saved.state, nonce: saved.nonce,
      code_challenge: createHash('sha256').update(String(saved.verifier)).digest('base64url'), code_challenge_method: 'S256',
      hd: 'wareongo.com', prompt: 'select_account' });
    expect(target.toString()).not.toContain(clientSecret);
    expect(target.toString()).not.toContain(String(saved.verifier));
    expect(limit).toHaveBeenCalledWith(expect.any(Request), 'console-google:login', 30);
  });
  it('uses only a non-Secure local cookie for the explicitly configured localhost origin', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', 'http://localhost:3000');
    const response = await handleGoogleLogin(new Request('http://localhost:3000/api/auth/login'), { limit: vi.fn() });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toMatch(/^context_console_oauth=/);
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
    expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/google/callback');
  });
  it.each(['https://evil.example/api/auth/login', `${origin}/api/auth/login?next=https://evil.example`])('refuses a noncanonical or redirected request %s', async url => {
    assertFailure(await handleGoogleLogin(new Request(url), { limit: vi.fn() }), 'google_invalid', false);
  });
  it('fails closed for missing Google configuration without disclosing configuration', async () => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const response = await handleGoogleLogin(new Request(`${origin}/api/auth/login`));
    assertFailure(response, 'google_unavailable', false);
    expect(await response.text()).toBe('');
  });
  it('returns a safe 405 for password POST without parsing credentials', async () => {
    const response = await rejectPassword();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(await response.json()).toEqual({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use Google sign-in to access the console.' } });
  });
});

describe('signed Google ID-token verification', () => {
  it.each(['https://accounts.google.com', 'accounts.google.com'])('accepts the documented issuer %s and normalizes the verified work email', async iss => {
    await expect(verifyGoogleIdToken(await signedToken({ iss, email: 'Employee@Wareongo.com' }), { clientId, nonce, now }, getKey))
      .resolves.toEqual({ sub: subject, email });
  });
  it.each([
    { name: 'other audience', claims: { aud: 'other-client.apps.googleusercontent.com' } },
    { name: 'other issuer', claims: { iss: 'https://evil.example' } },
    { name: 'wrong nonce', claims: { nonce: 'X'.repeat(43) } },
    { name: 'absent nonce', claims: { nonce: undefined } },
    { name: 'expired token inside clock tolerance', claims: { exp: seconds } },
    { name: 'future issue time', claims: { iat: seconds + 31 } },
    { name: 'old issue time', claims: { iat: seconds - 700 } },
    { name: 'missing issue time', claims: { iat: undefined } },
    { name: 'fractional expiry', claims: { exp: seconds + 0.5 } },
    { name: 'missing subject', claims: { sub: undefined } },
    { name: 'unsafe subject', claims: { sub: 'employee@wareongo.com' } },
    { name: 'oversized subject', claims: { sub: 'a'.repeat(256) } },
    { name: 'wrong authorized party', claims: { azp: 'other-client' } },
    { name: 'multiple audiences without azp', claims: { aud: [clientId, 'other-client'] } },
  ])('rejects $name with a real valid signature', async ({ claims }) => {
    await expect(verifyGoogleIdToken(await signedToken(claims), { clientId, nonce, now }, getKey)).rejects.toMatchObject({ status: 401 });
  });
  it('accepts multiple audiences only with this application as the authorized party', async () => {
    await expect(verifyGoogleIdToken(await signedToken({ aud: [clientId, 'other-client'], azp: clientId }), { clientId, nonce, now }, getKey))
      .resolves.toEqual({ sub: subject, email });
  });
  it.each([
    { name: 'foreign email domain', claims: { email: 'employee@example.com' } },
    { name: 'suffix spoof', claims: { email: 'employee@wareongo.com.evil.example' } },
    { name: 'email whitespace', claims: { email: ' employee@wareongo.com' } },
    { name: 'foreign Workspace', claims: { hd: 'example.com' } },
    { name: 'unverified email', claims: { email_verified: false } },
    { name: 'string verification flag', claims: { email_verified: 'true' } },
  ])('denies $name despite a valid signature', async ({ claims }) => {
    await expect(verifyGoogleIdToken(await signedToken(claims), { clientId, nonce, now }, getKey)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['hd', 'email', 'email_verified', 'aud', 'exp'])('rejects missing required %s claim', async field => {
    await expect(verifyGoogleIdToken(await signedToken({ [field]: undefined }), { clientId, nonce, now }, getKey)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a forged signature, unknown kid, and absent kid', async () => {
    for (const token of [await signedToken({}, otherKey), await signedToken({}, signingKey, { kid: 'other' }), await signedToken({}, signingKey, { kid: undefined })]) {
      await expect(verifyGoogleIdToken(token, { clientId, nonce, now }, getKey)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('rejects unsigned and symmetric JWTs before key resolution', async () => {
    const resolver = vi.fn(getKey);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.`;
    const symmetric = await new SignJWT({ sub: subject }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
    for (const token of [unsigned, symmetric]) await expect(verifyGoogleIdToken(token, { clientId, nonce, now }, resolver)).rejects.toMatchObject({ status: 401 });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('Google callback browser binding, transport, and roster checks', () => {
  it('exchanges the code and verifies identity before opening a read transaction, then returns only the console session', async () => {
    const deps = await dependencies();
    const response = await handleGoogleCallback(callbackRequest({ scope: 'openid email', authuser: '0', hd: 'wareongo.com' }), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${origin}/`);
    expect(deps.fetch.mock.invocationCallOrder[0]).toBeLessThan(deps.verify.mock.invocationCallOrder[0]);
    expect(deps.verify.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.transaction).mock.invocationCallOrder[0]);
    const [url, options] = deps.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(options.body as URLSearchParams)).toEqual({ code: 'synthetic-one-use-code', code_verifier: verifier,
      client_id: clientId, client_secret: clientSecret, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: 'authorization_code' });
    expect(deps.query.mock.calls[0][1]).toEqual([email]);
    expect(deps.query.mock.calls[0][0]).toMatch(/^SELECT/);
    expect(deps.limit).toHaveBeenCalledWith(expect.any(Request), 'console-google:callback', 30);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('Max-Age=0');
    const session = readConsoleSession(new Request(origin, { headers: { cookie: cookies[1].split(';')[0] } }), process.env, now);
    expect(session).toMatchObject({ email, employeeId: 7, sub: `google:${subject}` });
    expect(session).not.toHaveProperty('isAdmin');
    expect(cookies.join(' ')).not.toMatch(/ignored-provider|synthetic-client-secret/);
    expect(await response.text()).toBe('');
  });
  it.each([
    { label: 'missing state', query: { state: '' } }, { label: 'wrong state', query: { state: 'X'.repeat(43) } },
    { label: 'wrong issuer', query: { iss: 'https://evil.example' } }, { label: 'missing code', query: { code: '' } },
    { label: 'huge code', query: { code: 'x'.repeat(2049) } }, { label: 'code with whitespace', query: { code: 'bad code' } },
    { label: 'error and code', query: { error: 'access_denied' } },
  ])('rejects $label before any provider request or DB checkout', async ({ query, label }) => {
    const deps = await dependencies();
    assertFailure(await handleGoogleCallback(callbackRequest(query), deps), 'google_invalid', !['missing state', 'wrong state'].includes(label));
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled(); expect(deps.limit).not.toHaveBeenCalled();
  });
  it.each(['state', 'code', 'error', 'iss'])('rejects duplicated %s before any HTTP call', async field => {
    const deps = await dependencies(), request = callbackRequest();
    const url = new URL(request.url); url.searchParams.append(field, 'first'); url.searchParams.append(field, 'second');
    assertFailure(await handleGoogleCallback(new Request(url, { headers: request.headers }), deps), 'google_invalid', field !== 'state');
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'expired', cookie: () => flowCookie({ iat: seconds - 600, exp: seconds }) },
    { label: 'future', cookie: () => flowCookie({ iat: seconds + 31, exp: seconds + 631 }) },
    { label: 'long lifetime', cookie: () => flowCookie({ exp: seconds + 601 }) },
    { label: 'changed client', cookie: () => flowCookie({ clientId: 'other-client' }) },
    { label: 'wrong signature purpose', cookie: () => flowCookie({}, 'session') },
    { label: 'missing', cookie: () => '' },
    { label: 'tampered', cookie: () => `${flowCookie()}changed` },
    { label: 'duplicated', cookie: () => `${flowCookie()}; ${flowCookie()}` },
  ])('rejects a $label flow cookie without consuming unbound browser state', async ({ cookie }) => {
    const deps = await dependencies();
    assertFailure(await handleGoogleCallback(callbackRequest({}, cookie()), deps), 'google_invalid', false);
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it('handles cancellation only after state validation and ignores provider error text', async () => {
    const deps = await dependencies();
    const url = new URL(`${origin}/api/auth/google/callback`);
    url.search = new URLSearchParams({ state, error: 'access_denied', error_description: 'untrusted-provider-contents' }).toString();
    const response = await handleGoogleCallback(new Request(url, { headers: { cookie: flowCookie() } }), deps);
    assertFailure(response, 'google_cancelled');
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
    expect(response.headers.get('location')).not.toContain('untrusted');
    url.searchParams.set('state', 'X'.repeat(43));
    assertFailure(await handleGoogleCallback(new Request(url, { headers: { cookie: flowCookie() } }), deps), 'google_invalid', false);
  });
  it('preserves a newer tab B flow after the stale tab A callback, so B can complete', async () => {
    const start = () => handleGoogleLogin(new Request(`${origin}/api/auth/login`), { limit: vi.fn(), now: () => now });
    const first = await start(), second = await start();
    const firstState = new URL(first.headers.get('location')!).searchParams.get('state')!;
    const secondState = new URL(second.headers.get('location')!).searchParams.get('state')!;
    const secondCookie = second.headers.getSetCookie()[0].split(';')[0];
    const secondFlow = readSignedConsoleValue(secondCookie.split('=')[1], 'google-oauth');
    const deps = await dependencies({ nonce: secondFlow.nonce });
    assertFailure(await handleGoogleCallback(callbackRequest({ state: firstState }, secondCookie), deps), 'google_invalid', false);
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
    const successful = await handleGoogleCallback(callbackRequest({ state: secondState }, secondCookie), deps);
    expect(successful.headers.get('location')).toBe(`${origin}/`);
    expect(successful.headers.getSetCookie()).toEqual([
      expect.stringContaining('context_console_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'),
      expect.stringContaining('context_console_session='),
    ]);
    expect(deps.fetch).toHaveBeenCalledOnce(); expect(deps.transaction).toHaveBeenCalledOnce();
  });
  it('stops a callback rejected by the bounded anonymous admission limit before HTTP or DB', async () => {
    const deps = await dependencies();
    deps.limit.mockImplementation(() => { throw new HttpError(429, 'RATE_LIMITED', 'Retry.'); });
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_unavailable');
    expect(deps.fetch).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'bad nonce', claims: { nonce: 'X'.repeat(43) }, error: 'google_invalid' },
    { label: 'foreign Workspace', claims: { hd: 'example.com' }, error: 'google_denied' },
    { label: 'unverified email', claims: { email_verified: false }, error: 'google_denied' },
  ])('does not open a transaction for $label', async ({ claims, error }) => {
    const deps = await dependencies(claims);
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), error);
    expect(deps.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'missing employee', rows: [] }, { label: 'inactive employee', rows: [{ ...roster, is_active: false }] },
    { label: 'ambiguous employee', rows: [roster, { ...roster, id: 8 }] },
  ])('does not issue a session for $label after verified sign-in', async ({ rows }) => {
    const deps = await dependencies({}, rows);
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_denied');
    expect(deps.transaction).toHaveBeenCalledOnce();
  });
  it.each([
    { label: 'provider error', response: () => new Response('provider-secret-error', { status: 500 }) },
    { label: 'redirect', response: () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) },
    { label: 'invalid JSON', response: () => new Response('provider-secret-error') },
    { label: 'missing ID token', response: () => Response.json({ access_token: 'provider-secret-error' }) },
    { label: 'huge declared body', response: () => new Response('{}', { headers: { 'content-length': '32769' } }) },
    { label: 'huge chunked body', response: () => new Response('x'.repeat(32769)) },
    { label: 'huge ID token', response: () => Response.json({ id_token: 'x'.repeat(16385) }) },
  ])('bounds and redacts $label', async ({ response }) => {
    const deps = await dependencies(); deps.fetch.mockResolvedValue(response());
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_unavailable');
    expect(deps.verify).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it('treats Google code reuse or invalid code as an invalid flow and never opens a transaction', async () => {
    const deps = await dependencies(); deps.fetch.mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_invalid');
    expect(deps.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { status: 400, error: 'invalid_client' }, { status: 401, error: 'invalid_client' },
    { status: 400, error: 'unauthorized_client' }, { status: 401, error: 'unauthorized_client' },
  ])('classifies Google $status $error as service configuration unavailable without disclosing provider details', async ({ status, error }) => {
    const deps = await dependencies();
    deps.fetch.mockResolvedValue(Response.json({ error, error_description: `provider text ${clientSecret}`, other: 'private-provider-content' }, { status }));
    const response = await handleGoogleCallback(callbackRequest(), deps);
    assertFailure(response, 'google_unavailable');
    expect(await response.text()).toBe('');
    expect([...response.headers.values()].join(' ')).not.toMatch(/provider text|private-provider-content|synthetic-client-secret/);
    expect(deps.verify).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'oversized error JSON', response: () => Response.json({ error: 'invalid_grant', error_description: 'x'.repeat(8192) }, { status: 400 }) },
    { label: 'invalid error JSON', response: () => new Response('private-provider-error', { status: 401 }) },
    { label: 'unknown error', response: () => Response.json({ error: 'unrecognized' }, { status: 400 }) },
    { label: 'wrong error type', response: () => Response.json({ error: ['invalid_grant'] }, { status: 400 }) },
  ])('fails safely on $label before verification or DB lookup', async ({ response }) => {
    const deps = await dependencies(); deps.fetch.mockResolvedValue(response());
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_unavailable');
    expect(deps.verify).not.toHaveBeenCalled(); expect(deps.transaction).not.toHaveBeenCalled();
  });
  it('redacts network and database errors and clears the temporary cookie', async () => {
    const deps = await dependencies();
    deps.fetch.mockRejectedValueOnce(new Error(`network error ${clientSecret}`));
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_unavailable');
    expect(deps.transaction).not.toHaveBeenCalled();
    vi.mocked(deps.transaction).mockRejectedValueOnce(new Error('private-database-connection-details'));
    assertFailure(await handleGoogleCallback(callbackRequest(), deps), 'google_unavailable');
  });
  it('never follows caller supplied next/redirect URLs on successful callback', async () => {
    const response = await handleGoogleCallback(callbackRequest({ next: 'https://evil.example', redirect_uri: 'https://evil.example' }), await dependencies());
    expect(response.headers.get('location')).toBe(`${origin}/`);
  });
});

describe('production Google JWKS resolver', () => {
  it('uses a fixed bounded HTTPS fetch and caches actual verified signing keys', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ keys: [publicJwk] }));
    vi.stubGlobal('fetch', fetch);
    const token = await signedToken({}, signingKey, { jku: 'https://evil.example/keys', x5u: 'https://evil.example/cert' });
    await expect(verifyGoogleIdToken(token, { clientId, nonce, now })).resolves.toEqual({ sub: subject, email });
    await expect(verifyGoogleIdToken(token, { clientId, nonce, now })).resolves.toEqual({ sub: subject, email });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe('https://www.googleapis.com/oauth2/v3/certs');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
