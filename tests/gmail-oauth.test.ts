import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, createConsoleSession, readSignedConsoleValue, signedConsoleValue, type ConsoleIdentity } from '../src/lib/console-auth';
import { GMAIL_COMPOSE_SCOPE } from '../src/lib/gmail-client';
import { GMAIL_CALLBACK_PATH, gmailAvailability, handleGmailCallback, handleGmailConnect, handleGmailConnection, handleGmailDisconnect, refreshGmailAccessToken } from '../src/lib/gmail-oauth';
import { completeGmailDisconnect, encryptGmailSecret, getGmailConnection, saveGmailConnection, disconnectGmailConnection, type GmailConnection } from '../src/lib/gmail-storage';
import { HttpError } from '../src/lib/errors';
import type { withReadOnlyTransaction } from '../src/lib/db';

vi.mock('../src/lib/gmail-storage', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/gmail-storage')>();
  return { ...original, getGmailConnection: vi.fn(), saveGmailConnection: vi.fn(), disconnectGmailConnection: vi.fn(), completeGmailDisconnect: vi.fn() };
});
const origin = 'https://context.example.test';
const clientId = 'draft-client.apps.googleusercontent.com';
const clientSecret = 'synthetic-draft-client-secret';
const refreshToken = 'synthetic-refresh-token';
const accessToken = 'synthetic-access-token';
const now = Date.UTC(2026, 9, 4, 12);
const email = 'employee@wareongo.com', googleSub = '107654321012345678901';
const identity: ConsoleIdentity = { employeeId: 7, email, name: 'Employee', isAdmin: false, isAnalyst: false, scopes: ['knowledge:read'] };
const roster = { id: 7, email, name: 'Employee', is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: null };
const connection: GmailConnection = {
  id: 'c291ed30-7c27-48b7-a36b-dc3941efaa4d', employeeId: 7, employeeEmail: email, googleSub, accountEmail: email,
  encryptedRefreshToken: 'replaced-for-disconnect', grantedScopes: ['openid', GMAIL_COMPOSE_SCOPE], version: 4,
  status: 'active', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
  vi.stubEnv('CONTEXT_GMAIL_CLIENT_ID', clientId);
  vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', clientSecret);
  vi.stubEnv('CONTEXT_GMAIL_ENCRYPTION_KEY', Buffer.alloc(32, 2).toString('base64url'));
  vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'true');
  connection.encryptedRefreshToken = encryptGmailSecret(refreshToken, { purpose: 'refresh_token', employeeId: 7, id: connection.id });
  vi.mocked(getGmailConnection).mockReset().mockResolvedValue(null);
  vi.mocked(saveGmailConnection).mockReset().mockResolvedValue(connection);
  vi.mocked(disconnectGmailConnection).mockReset().mockResolvedValue({ ...connection, version: 5, status: 'disconnected', encryptedRefreshToken: null });
  vi.mocked(completeGmailDisconnect).mockReset().mockImplementation(async (_client, _owner, revoke) => {
    await revoke({ ...connection, version: 5, status: 'revoking' });
    return { ...connection, version: 5, status: 'disconnected', encryptedRefreshToken: null };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function sessionCookie(account = identity, subject = googleSub) {
  return consoleCookie('session', createConsoleSession(account, `google:${subject}`), 28_800).split(';')[0];
}
function request(path: string, method = 'GET', cookie = sessionCookie(), originHeader: string | null = origin) {
  return new Request(`${origin}${path}`, { method, headers: { cookie, ...(originHeader ? { Origin: originHeader } : {}) } });
}
function deps() {
  let active = true, revoked = false;
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('session_revocations') ? (revoked ? [{ session_hash: 'revoked' }] : [])
    : [{ ...roster, is_active: active }] }));
  const client = { query } as unknown as PoolClient;
  const transaction = vi.fn(async <T>(operation: (client: PoolClient) => Promise<T>) => operation(client));
  const writeTransaction = vi.fn(async <T>(operation: (client: PoolClient) => Promise<T>) => operation(client));
  const disconnectTransaction = vi.fn(async <T>(operation: (client: PoolClient) => Promise<T>) => operation(client));
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
    access_token: accessToken, refresh_token: refreshToken, id_token: 'synthetic-id-token', token_type: 'Bearer',
    expires_in: 3600, scope: `openid email ${GMAIL_COMPOSE_SCOPE}`,
  }));
  const verify = vi.fn(async () => ({ email, sub: googleSub }));
  return { query, transaction: transaction as typeof withReadOnlyTransaction, writeTransaction: writeTransaction as typeof withReadOnlyTransaction,
    disconnectTransaction: disconnectTransaction as typeof withReadOnlyTransaction, fetch, verify, limit: vi.fn(), now: () => now,
    deactivate: () => { active = false; }, revoke: () => { revoked = true; } };
}
async function start(dependencies = deps()) {
  const session = sessionCookie();
  const response = await handleGmailConnect(request('/api/mail/google/connect', 'POST', session), dependencies);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toMatch(/^https:\/\/accounts.google.com\//);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const flow = readSignedConsoleValue(cookie.split('=')[1], 'google-oauth');
  const callback = (query = `code=one-use-code&state=${flow.state}`, overrideCookie = `${session}; ${cookie}`) => request(`${GMAIL_CALLBACK_PATH}?${query}`, 'GET', overrideCookie);
  return { response, cookie, flow, session, callback, dependencies };
}
function expectFailure(response: Response, code: string, clear = true) {
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`${origin}/mail?error=${code}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.getSetCookie()).toEqual(clear ? [expect.stringContaining('context_gmail_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure')] : []);
}

describe('Gmail configuration and refresh tokens', () => {
  it('requires a separate enabled client, canonical encryption key, and console session configuration', () => {
    expect(gmailAvailability()).toEqual({ enabled: true, configured: true, available: true });
    vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'false');
    expect(gmailAvailability()).toEqual({ enabled: false, configured: true, available: false });
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', '');
    expect(gmailAvailability()).toEqual({ enabled: false, configured: false, available: false });
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', clientSecret);
    vi.stubEnv('CONTEXT_GMAIL_ENCRYPTION_KEY', 'A'.repeat(42) + 'B');
    expect(gmailAvailability().configured).toBe(false);
  });
  it('refreshes only through the fixed server endpoint and returns only the bounded access token', async () => {
    const d = deps();
    expect(await refreshGmailAccessToken(refreshToken, undefined, process.env, d.fetch)).toBe(accessToken);
    const [url, options] = d.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
  });
  it.each([
    [{ error: 'invalid_grant', error_description: `${refreshToken} sensitive` }, 400, 'GMAIL_RECONNECT_REQUIRED'],
    [{ error: 'invalid_grant', error_description: refreshToken }, 500, 'GMAIL_OAUTH_UNAVAILABLE'],
    [{ error: 'invalid_client', error_description: clientSecret }, 401, 'GMAIL_OAUTH_UNAVAILABLE'],
    [{ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'openid email' }, 200, 'GMAIL_SCOPE_REQUIRED'],
    [{ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: `${GMAIL_COMPOSE_SCOPE} https://www.googleapis.com/auth/gmail.modify` }, 200, 'GMAIL_SCOPE_UNSUPPORTED'],
    [{ access_token: 'invalid\r\nBearer', token_type: 'Bearer', expires_in: 3600 }, 200, 'GMAIL_OAUTH_UNAVAILABLE'],
    [{ access_token: accessToken, token_type: 'mac', expires_in: 3600 }, 200, 'GMAIL_OAUTH_UNAVAILABLE'],
  ])('sanitizes failed token responses without replaying the request', async (body, status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status }));
    const error = await refreshGmailAccessToken(refreshToken, undefined, process.env, fetch).catch(error => error);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(refreshToken);
    expect(String(error)).not.toContain(clientSecret);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects missing config, disabled access and pre-aborted refreshes without HTTP', async () => {
    const fetch = deps().fetch;
    vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'false');
    await expect(refreshGmailAccessToken(refreshToken, undefined, process.env, fetch)).rejects.toMatchObject({ code: 'GMAIL_DISABLED' });
    vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'true');
    const controller = new AbortController(); controller.abort();
    await expect(refreshGmailAccessToken(refreshToken, controller.signal, process.env, fetch)).rejects.toMatchObject({ code: 'GMAIL_ABORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps token JSON and times out an uncooperative stream', async () => {
    const large = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: 'x'.repeat(32_769) }));
    await expect(refreshGmailAccessToken(refreshToken, undefined, process.env, large)).rejects.toMatchObject({ code: 'GMAIL_OAUTH_UNAVAILABLE' });
    const stalled = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }));
    const result = expect(refreshGmailAccessToken(refreshToken, undefined, process.env, stalled)).rejects.toMatchObject({ code: 'GMAIL_OAUTH_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(5_001);
    await result;
  });
  it('rejects redirected, unexpected success status and non-JSON token responses', async () => {
    const body = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 };
    const redirected = Response.json(body);
    Object.defineProperty(redirected, 'redirected', { value: true });
    for (const response of [redirected, Response.json(body, { status: 201 }), new Response(JSON.stringify(body))]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(refreshGmailAccessToken(refreshToken, undefined, process.env, fetch)).rejects.toMatchObject({ code: 'GMAIL_OAUTH_UNAVAILABLE' });
    }
  });
});

describe('per-employee Gmail OAuth flow', () => {
  it('starts a separately signed offline PKCE flow bound to employee, Google subject and browser session', async () => {
    const { response, flow, dependencies } = await start();
    const url = new URL(response.headers.get('location')!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: clientId, response_type: 'code', scope: `openid email ${GMAIL_COMPOSE_SCOPE}`,
      redirect_uri: `${origin}${GMAIL_CALLBACK_PATH}`, state: flow.state, nonce: flow.nonce,
      code_challenge: createHash('sha256').update(String(flow.verifier)).digest('base64url'), code_challenge_method: 'S256',
      access_type: 'offline', include_granted_scopes: 'false', prompt: 'consent', hd: 'wareongo.com', login_hint: email });
    expect(flow).toMatchObject({ kind: 'gmail-connect', employeeId: 7, email, sub: `google:${googleSub}`, connectionId: null, connectionVersion: null });
    expect(flow.sid).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(new Set([flow.state, flow.nonce, flow.verifier]).size).toBe(3);
    expect(response.headers.getSetCookie()[0]).toContain('__Host-context_gmail_oauth=');
    expect(response.headers.getSetCookie()[0]).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    expect(url.toString()).not.toContain(clientSecret);
    expect(url.toString()).not.toContain(String(flow.verifier));
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });
  it.each([null, 'https://evil.example'])('rejects a connect without the exact Origin (%s)', async originHeader => {
    const d = deps();
    expectFailure(await handleGmailConnect(request('/api/mail/google/connect', 'POST', sessionCookie(), originHeader), d), 'denied', false);
    expect(d.transaction).not.toHaveBeenCalled();
  });
  it('requires an active unrevoked console session before redirecting to Gmail authorization', async () => {
    const d = deps(); d.deactivate();
    expectFailure(await handleGmailConnect(request('/api/mail/google/connect', 'POST'), d), 'denied', false);
    expect(d.fetch).not.toHaveBeenCalled();
    const revoked = deps(); revoked.revoke();
    expectFailure(await handleGmailConnect(request('/api/mail/google/connect', 'POST'), revoked), 'expired', false);
  });
  it('does not start consent while a Google revocation is pending', async () => {
    vi.mocked(getGmailConnection).mockResolvedValue({ ...connection, status: 'revoking' });
    const d = deps();
    expectFailure(await handleGmailConnect(request('/api/mail/google/connect', 'POST'), d), 'disconnect_pending', false);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('verifies Google identity and scopes, rechecks live employee/session and atomically binds refresh tokens', async () => {
    const { callback, flow, dependencies: d } = await start();
    const response = await handleGmailCallback(callback(), d);
    expect(response.headers.get('location')).toBe(`${origin}/mail?connected=1`);
    const [url, options] = d.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({ client_id: clientId, client_secret: clientSecret,
      redirect_uri: `${origin}${GMAIL_CALLBACK_PATH}`, grant_type: 'authorization_code', code: 'one-use-code', code_verifier: flow.verifier });
    expect(d.verify).toHaveBeenCalledWith('synthetic-id-token', { clientId, nonce: flow.nonce, now });
    expect(saveGmailConnection).toHaveBeenCalledWith(expect.anything(), { employeeId: 7, employeeEmail: email }, {
      googleSub, accountEmail: email, refreshToken, grantedScopes: ['openid', 'email', GMAIL_COMPOSE_SCOPE], expectedConnection: { id: null, version: null },
    });
    expect(d.transaction).toHaveBeenCalledTimes(2); // start + pre-exchange check
    expect(d.writeTransaction).toHaveBeenCalledTimes(1);
    const exposed = JSON.stringify([...response.headers]) + await response.text();
    for (const secret of [accessToken, refreshToken, clientSecret, 'synthetic-id-token']) expect(exposed).not.toContain(secret);
  });
  it.each(['state', 'session', 'expired', 'purpose', 'extra', 'duplicate'])('rejects an unbound callback (%s) before token exchange', async mode => {
    const { flow, callback, cookie, session, dependencies: d } = await start();
    let callbackRequest = callback();
    if (mode === 'state') callbackRequest = callback(`code=one-use-code&state=${'X'.repeat(43)}`);
    if (mode === 'session') callbackRequest = callback(undefined, `${sessionCookie()}; ${cookie}`);
    if (mode === 'duplicate') callbackRequest = callback(`code=one-use-code&state=${flow.state}&state=${flow.state}`);
    if (['expired', 'purpose', 'extra'].includes(mode)) {
      const changed = { ...flow, ...(mode === 'expired' ? { iat: 1, exp: 601 } : mode === 'purpose' ? { kind: 'different' } : { returnTo: 'https://evil.example' }) };
      callbackRequest = callback(undefined, `${session}; __Host-context_gmail_oauth=${signedConsoleValue(changed, 'google-oauth')}`);
    }
    expectFailure(await handleGmailCallback(callbackRequest, d), 'expired', false);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(saveGmailConnection).not.toHaveBeenCalled();
  });
  it('consumes only a matching cancelled flow and never exchanges its code', async () => {
    const { flow, callback, dependencies: d } = await start();
    expectFailure(await handleGmailCallback(callback(`error=access_denied&state=${flow.state}`), d), 'cancelled');
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it.each([{ email: 'other@wareongo.com', sub: googleSub }, { email, sub: 'other-google-sub' }])('rejects an account mismatch even after valid token verification', async mismatch => {
    const { callback, dependencies: d } = await start();
    d.verify.mockResolvedValue(mismatch);
    expectFailure(await handleGmailCallback(callback(), d), 'denied');
    expect(saveGmailConnection).not.toHaveBeenCalled();
  });
  it('rejects an inactive employee or revoked browser session after external I/O', async () => {
    for (const type of ['employee', 'session']) {
      const { callback, dependencies: d } = await start();
      d.verify.mockImplementation(async () => { if (type === 'employee') d.deactivate(); else d.revoke(); return { email, sub: googleSub }; });
      expectFailure(await handleGmailCallback(callback(), d), type === 'employee' ? 'denied' : 'expired');
      expect(saveGmailConnection).not.toHaveBeenCalled();
    }
  });
  it('rejects a new connection version before HTTP or an atomic conflict during save', async () => {
    vi.mocked(getGmailConnection).mockResolvedValue(connection);
    const first = await start();
    vi.mocked(getGmailConnection).mockResolvedValue({ ...connection, version: 5, status: 'disconnected' });
    expectFailure(await handleGmailCallback(first.callback(), first.dependencies), 'changed');
    expect(first.dependencies.fetch).not.toHaveBeenCalled();
    vi.mocked(getGmailConnection).mockResolvedValue(connection);
    const second = await start();
    vi.mocked(saveGmailConnection).mockRejectedValue(new HttpError(409, 'GMAIL_CONNECTION_CHANGED', 'Connection changed.'));
    expectFailure(await handleGmailCallback(second.callback(), second.dependencies), 'changed');
    expect(saveGmailConnection).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ expectedConnection: { id: connection.id, version: 4 } }));
  });
  it.each(['scope', 'refresh'])('does not replace a connection when Google omits required %s information', async missing => {
    const { callback, dependencies: d } = await start();
    d.fetch.mockResolvedValue(Response.json({ access_token: accessToken, id_token: 'synthetic-id-token', token_type: 'Bearer',
      ...(missing === 'refresh' ? {} : { refresh_token: refreshToken }), ...(missing === 'scope' ? {} : { scope: GMAIL_COMPOSE_SCOPE }) }));
    expectFailure(await handleGmailCallback(callback(), d), missing === 'scope' ? 'scope' : 'unavailable');
    expect(saveGmailConnection).not.toHaveBeenCalled();
  });
});

describe('mailbox connection visibility and disconnect', () => {
  it('returns only the requesting employee connection summary, never credentials or provider subject', async () => {
    vi.mocked(getGmailConnection).mockResolvedValue(connection);
    const d = deps();
    const response = await handleGmailConnection(request('/api/mail/connection'), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ employee: { email, name: 'Employee' }, connection: {
      connected: true, status: 'active', accountEmail: email, updatedAt: connection.updatedAt,
    }, availability: { enabled: true, configured: true, available: true } });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['needs_reauth', 'revoking'] as const)('reports %s as unavailable, without treating stored credentials as a healthy connection', async status => {
    vi.mocked(getGmailConnection).mockResolvedValue({ ...connection, status });
    const response = await handleGmailConnection(request('/api/mail/connection'), deps());
    expect(await response.json()).toMatchObject({ connection: { connected: false, status } });
  });
  it('durably disables locally, then revokes through a bounded fixed endpoint even with drafting and OAuth config disabled', async () => {
    vi.mocked(disconnectGmailConnection).mockResolvedValue({ ...connection, status: 'revoking', version: 5 });
    vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'false');
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', '');
    const d = deps(); d.fetch.mockResolvedValue(new Response(''));
    const response = await handleGmailDisconnect(request('/api/mail/connection', 'POST'), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ disconnected: true, googleGrantRevoked: true, revocationPending: false });
    expect(d.writeTransaction).not.toHaveBeenCalled();
    expect(d.disconnectTransaction).toHaveBeenCalledTimes(2);
    expect(disconnectGmailConnection).toHaveBeenCalledWith(expect.anything(), { employeeId: 7, employeeEmail: email });
    expect(completeGmailDisconnect).toHaveBeenCalledWith(expect.anything(), { employeeId: 7, employeeEmail: email }, expect.any(Function));
    const [url, options] = d.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({ token: refreshToken });
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });
  it('leaves a retryable local disable if the token cannot be decrypted', async () => {
    vi.mocked(disconnectGmailConnection).mockResolvedValue({ ...connection, status: 'revoking', version: 5 });
    vi.stubEnv('CONTEXT_GMAIL_ENCRYPTION_KEY', '');
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', '');
    const d = deps();
    const response = await handleGmailDisconnect(request('/api/mail/connection', 'POST'), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ disconnected: true, googleGrantRevoked: false, revocationPending: true });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('does not claim Google revocation when no stored token remains', async () => {
    const d = deps();
    const response = await handleGmailDisconnect(request('/api/mail/connection', 'POST'), d);
    expect(await response.json()).toEqual({ disconnected: true, googleGrantRevoked: false, revocationPending: false });
    expect(d.disconnectTransaction).toHaveBeenCalledTimes(1);
    expect(completeGmailDisconnect).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('accepts an already invalid token on revocation retry', async () => {
    vi.mocked(disconnectGmailConnection).mockResolvedValue({ ...connection, status: 'revoking', version: 5 });
    const d = deps(); d.fetch.mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 400 }));
    const response = await handleGmailDisconnect(request('/api/mail/connection', 'POST'), d);
    expect(await response.json()).toEqual({ disconnected: true, googleGrantRevoked: true, revocationPending: false });
  });
  it.each(['network', 'server', 'bad_error', 'redirect', 'wrong_success', 'stream'] as const)('keeps revocation retryable and sanitizes %s failures', async mode => {
    vi.mocked(disconnectGmailConnection).mockResolvedValue({ ...connection, status: 'revoking', version: 5 });
    const d = deps();
    if (mode === 'network') d.fetch.mockRejectedValue(new Error(refreshToken));
    if (mode === 'server') d.fetch.mockResolvedValue(Response.json({ error_description: refreshToken }, { status: 503 }));
    if (mode === 'bad_error') d.fetch.mockResolvedValue(Response.json({ error: 'invalid_grant', error_description: refreshToken }, { status: 400 }));
    if (mode === 'redirect') {
      const redirected = new Response(''); Object.defineProperty(redirected, 'redirected', { value: true });
      d.fetch.mockResolvedValue(redirected);
    }
    if (mode === 'wrong_success') d.fetch.mockResolvedValue(Response.json({}, { status: 201 }));
    if (mode === 'stream') d.fetch.mockResolvedValue(new Response(new ReadableStream({ start() {} }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const result = handleGmailDisconnect(request('/api/mail/connection', 'POST'), d);
    if (mode === 'stream') await vi.advanceTimersByTimeAsync(2_001);
    const response = await result;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ disconnected: true, googleGrantRevoked: false, revocationPending: true });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin disconnects without altering local or Google access', async () => {
    const d = deps();
    expect((await handleGmailDisconnect(request('/api/mail/connection', 'POST', sessionCookie(), 'https://evil.test'), d)).status).toBe(403);
    expect(disconnectGmailConnection).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
