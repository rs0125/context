import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateMcpRequest, handleMcpOAuthRequest, revalidateMcpGrant, type McpOAuthDependencies } from '../src/lib/mcp-oauth';
import { authorizationServerMetadata, createConsent, hashOAuth, parseAuthorization, protectedResourceMetadata, readConsent, validateRedirect } from '../src/lib/mcp-oauth-protocol';
import type { KeyRegistration } from '../src/lib/auth';
import { createAnonymousLimiter } from '../src/lib/rate-limit';
import { HttpError } from '../src/lib/errors';

const origin = 'https://context.example.test';
const resource = `${origin}/mcp`;
const redirect = 'https://claude.ai/api/mcp/auth_callback';
const apiKey = `wog_ctx_${Buffer.alloc(32, 6).toString('base64url')}`;
const key: KeyRegistration = { id: 'test_employee', hash: hashOAuth(apiKey), employeeEmail: 'person@wareongo.com', scopes: ['knowledge:read', 'warehouses:read', 'crm:read'], expiresAt: new Date(Date.now() + 86400_000).toISOString() };
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 3).toString('base64url'));
  vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_MCP_ENABLED', 'true');
  vi.stubEnv('CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS', '');
  vi.stubEnv('CONTEXT_API_KEYS_JSON', JSON.stringify([key]));
  vi.stubEnv('ADMIN_EMAILS', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

type Row = Record<string, any>;
function database() {
  let state = { clients: new Map<string, Row>(), grants: new Map<string, Row>(), codes: new Map<string, Row>(), tokens: new Map<string, Row>() };
  const roster: Row = { id: 19, email: key.employeeEmail, is_active: true, dashboardAccess: true, adminAccess: false, twenty_user_id: '10000000-0000-4000-8000-000000000019' };
  const dbKeys = new Map<string, Row>();
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('FROM public."VerifiedNumber"')) return { rows: values[0] === roster.email ? [{ ...roster }] : [] };
    if (sql.includes('context_auth_private.employee_api_keys')) {
      if (sql.startsWith('SELECT id FROM')) {
        const row = dbKeys.get(values[1]);
        return { rows: row && row.id === values[0] && row.employee_id === values[2] && row.employee_email === values[3] ? [{ id: row.id }] : [] };
      }
      return { rows: dbKeys.has(values[0]) ? [dbKeys.get(values[0])] : [] };
    }
    if (sql.startsWith('DELETE FROM context_mcp_private.oauth_clients')) {
      let removed = 0;
      for (const [id, row] of state.clients) if (Date.parse(row.created_at) <= Date.now() - values[0] * 1000
        && ![...state.grants.values()].some(grant => grant.client_id === id) && removed < 2000) { state.clients.delete(id); removed++; }
      return { rows: [], rowCount: removed };
    }
    if (sql.startsWith('SELECT count(*)')) {
      const rows = sql.includes('oauth_clients') ? state.clients : sql.includes('oauth_grants') ? state.grants : state.tokens;
      return { rows: [{ count: [...rows.values()].filter(row => (!values.length || row.grant_id === values[0])
        && (!sql.includes('WHERE NOT EXISTS') || ![...state.grants.values()].some(grant => grant.client_id === row.id))).length }] };
    }
    if (sql.startsWith('SELECT id, name')) {
      const row = state.clients.get(values[0]);
      return { rows: row && (Date.parse(row.created_at) > Date.now() - values[1] * 1000 || [...state.grants.values()].some(grant => grant.client_id === row.id)) ? [row] : [] };
    }
    if (sql.startsWith('INSERT INTO context_mcp_private.oauth_clients')) {
      const [id, name, redirect_uris, scopes] = values;
      state.clients.set(id, { id, name, redirect_uris, scopes, created_at: new Date().toISOString() }); return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO context_mcp_private.oauth_grants')) {
      const [id, client_id, key_id, key_hash, key_source, employee_id, employee_email, scopes, resource, expires_at, consent_hash] = values;
      if ([...state.grants.values()].some(row => row.consent_hash === consent_hash)) return { rows: [] };
      state.grants.set(id, { id, client_id, key_id, key_hash, key_source, employee_id, employee_email, scopes, resource, expires_at, consent_hash, revoked_at: null });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('INSERT INTO context_mcp_private.oauth_codes')) {
      const [hash, grant_id, challenge, redirect_uri, expires_at] = values;
      state.codes.set(hash, { hash, grant_id, challenge, redirect_uri, expires_at, used_at: null }); return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO context_mcp_private.oauth_tokens')) {
      const [access, refresh, grant_id, accessExpiry, refreshExpiry] = values;
      state.tokens.set(access, { hash: access, grant_id, kind: 'access', expires_at: accessExpiry, used_at: null });
      state.tokens.set(refresh, { hash: refresh, grant_id, kind: 'refresh', expires_at: refreshExpiry, used_at: null }); return { rows: [] };
    }
    if (sql.startsWith('UPDATE context_mcp_private.oauth_grants')) {
      let grant = state.grants.get(values[0]);
      if (sql.includes('FROM context_mcp_private.oauth_tokens')) {
        const token = state.tokens.get(values[0]); grant = token && state.grants.get(token.grant_id);
        if (grant?.client_id !== values[1]) grant = undefined;
      }
      if (grant) { if (sql.includes('SET scopes')) grant.scopes = values[1]; else grant.revoked_at = new Date(); }
      return { rows: grant && sql.includes('RETURNING g.id') ? [{ id: grant.id, key_id: grant.key_id }] : [] };
    }
    if (sql.startsWith('UPDATE context_mcp_private.oauth_codes')) { const row = state.codes.get(values[0]); if (row) row.used_at = new Date(); return { rows: [] }; }
    if (sql.startsWith('UPDATE context_mcp_private.oauth_tokens')) { const row = state.tokens.get(values[0]); if (row) row.used_at = new Date(); return { rows: [] }; }
    if (sql.startsWith('SELECT g.scopes')) {
      const grant = state.grants.get(values[0]); const token = state.tokens.get(values[1]);
      const valid = grant && token && token.grant_id === grant.id && token.kind === 'access' && token.expires_at > new Date()
        && grant.revoked_at === null && grant.expires_at > new Date() && grant.resource === values[2]
        && grant.key_id === values[3] && grant.key_hash === values[4] && grant.employee_id === values[5] && grant.employee_email === values[6];
      return { rows: valid ? [{ scopes: grant.scopes }] : [] };
    }
    if (sql.includes('FROM context_mcp_private.oauth_codes c')) {
      const code = state.codes.get(values[0]); const grant = code && state.grants.get(code.grant_id);
      return { rows: grant?.client_id === values[1] ? [{ ...grant, challenge: code!.challenge, redirect_uri: code!.redirect_uri, code_expires_at: code!.expires_at, used_at: code!.used_at }] : [] };
    }
    if (sql.includes('FROM context_mcp_private.oauth_tokens t')) {
      const token = state.tokens.get(values[0]); const grant = token && state.grants.get(token.grant_id);
      if (!grant || !token) return { rows: [] };
      if (sql.includes("t.kind = 'access'") && (token.kind !== 'access' || token.expires_at <= new Date() || grant.revoked_at !== null || grant.expires_at <= new Date() || grant.resource !== values[1])) return { rows: [] };
      if (sql.includes("t.kind = 'refresh'") && (token.kind !== 'refresh' || grant.client_id !== values[1])) return { rows: [] };
      return { rows: [{ ...grant, token_expires_at: token.expires_at, used_at: token.used_at }] };
    }
    throw new Error('Unexpected synthetic database statement.');
  });
  const client = { query } as unknown as PoolClient;
  const commits = vi.fn(); const rollbacks = vi.fn();
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(state);
    try { const result = await work(client); commits(); return result; }
    catch (error) { state = snapshot; rollbacks(); throw error; }
  };
  const failures = createAnonymousLimiter();
  const deps: McpOAuthDependencies = { readTransaction: transaction, writeTransaction: transaction, limit: vi.fn(), anonymousLimit: vi.fn(),
    checkFailed: (namespace, credential) => failures.check(namespace, credential, 5), noteFailed: (namespace, credential) => failures.record(namespace, credential), audit: vi.fn() };
  return { deps, query, client, roster, dbKeys, commits, rollbacks, state: () => state };
}
function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function tokenRequest(values: Record<string, string>) {
  return new Request(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
}
async function registered(db: ReturnType<typeof database>) {
  const response = await handleMcpOAuthRequest(jsonRequest('/oauth/register', { client_name: 'Synthetic Claude', redirect_uris: [redirect], ignored_metadata: 'ignored', logo_uri: 'http://127.0.0.1/private' }), 'register', db.deps);
  expect(response.status).toBe(201);
  return await response.json();
}
async function consent(db: ReturnType<typeof database>) {
  const client = await registered(db);
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-secret-state' });
  const response = await handleMcpOAuthRequest(new Request(`${origin}/api/oauth/authorize?${params}`), 'authorize', db.deps);
  expect(response.status).toBe(200);
  return { client, params, preview: await response.json(), cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function authorized(db: ReturnType<typeof database>) {
  const start = await consent(db);
  const request = jsonRequest('/api/oauth/authorize', { requestHandle: start.preview.requestHandle, approve: true, apiKey }, { Cookie: start.cookie });
  const response = await handleMcpOAuthRequest(request, 'authorize', db.deps);
  expect(response.status).toBe(200);
  const output = await response.json();
  const callback = new URL(output.redirectUrl);
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(callback.searchParams.get('state')).toBe('client-secret-state');
  expect(output.redirectUrl).not.toContain(apiKey);
  return { ...start, code: callback.searchParams.get('code')!, body: { requestHandle: start.preview.requestHandle, approve: true, apiKey } };
}
async function exchange(db: ReturnType<typeof database>, auth: Awaited<ReturnType<typeof authorized>>, overrides: Record<string, string> = {}) {
  return handleMcpOAuthRequest(tokenRequest({ grant_type: 'authorization_code', client_id: auth.client.client_id, code: auth.code, redirect_uri: redirect, resource, code_verifier: verifier, ...overrides }), 'token', db.deps);
}
async function refresh(db: ReturnType<typeof database>, clientId: string, token: string, extra: Record<string, string> = {}) {
  return handleMcpOAuthRequest(tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource, ...extra }), 'token', db.deps);
}
const accessRequest = (token: string) => new Request(resource, { headers: { Authorization: `Bearer ${token}` } });

describe('OAuth availability and lifecycle audit', () => {
  it('does not let unrelated invalid tokens consume the authenticated quota, including shared client egress', async () => {
    const db = database(); const auth = await authorized(db); const issued = await (await exchange(db, auth)).json();
    vi.mocked(db.deps.limit).mockClear();
    for (let index = 0; index < 150; index++) {
      const bogus = `wog_mcp_at_${Buffer.alloc(32, index).toString('base64url')}`;
      const request = new Request(resource, { headers: { Authorization: `Bearer ${bogus}`, 'x-vercel-forwarded-for': '203.0.113.8' } });
      await expect(authenticateMcpRequest(request, db.deps)).rejects.toMatchObject({ status: 401 });
    }
    expect(db.deps.limit).not.toHaveBeenCalled();
    const valid = new Request(resource, { headers: { Authorization: `Bearer ${issued.access_token}`, 'x-vercel-forwarded-for': '203.0.113.8' } });
    expect(await authenticateMcpRequest(valid, db.deps)).toMatchObject({ id: key.id });
    expect(db.deps.limit).toHaveBeenCalledExactlyOnceWith(`access:${key.id}`, 120);
  });
  it('rejects repeated proven bad tokens before DB work and never caches source outages as bad credentials', async () => {
    const db = database(), invalid = `wog_mcp_at_${Buffer.alloc(32, 211).toString('base64url')}`;
    for (let i = 0; i < 5; i++) await expect(authenticateMcpRequest(accessRequest(invalid), db.deps)).rejects.toMatchObject({ status: 401 });
    const before = db.query.mock.calls.length;
    await expect(authenticateMcpRequest(accessRequest(invalid), db.deps)).rejects.toMatchObject({ status: 429 });
    expect(db.query).toHaveBeenCalledTimes(before);
    const unavailable = database();
    unavailable.deps.readTransaction = vi.fn(async () => { throw new HttpError(503, 'SOURCE_UNAVAILABLE', 'Synthetic outage'); });
    for (let i = 0; i < 7; i++) await expect(authenticateMcpRequest(accessRequest(invalid), unavailable.deps)).rejects.toMatchObject({ status: 503 });
    expect(unavailable.deps.readTransaction).toHaveBeenCalledTimes(7);
  });
  it('does not let failed PKCE proofs block the valid proof for the same code', async () => {
    const db = database(); const auth = await authorized(db);
    for (let i = 0; i < 5; i++) expect((await exchange(db, auth, { code_verifier: 'b'.repeat(64) })).status).toBe(400);
    expect((await exchange(db, auth, { code_verifier: 'b'.repeat(64) })).status).toBe(429);
    expect((await exchange(db, auth)).status).toBe(200);
  });
  it('recovers pending registration capacity while preserving old clients and all issued grants/tokens', async () => {
    const db = database(); const auth = await authorized(db); const issued = await (await exchange(db, auth)).json();
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    db.state().clients.get(auth.client.client_id)!.created_at = old;
    for (let index = 0; index < 2000; index++) {
      const id = `wog_client_${String(index).padStart(43, '0')}`;
      db.state().clients.set(id, { id, name: 'Unused synthetic client', redirect_uris: [redirect], scopes: key.scopes, created_at: old });
    }
    const newClient = await registered(db);
    expect(db.state().clients.size).toBe(2);
    expect(db.state().clients.has(auth.client.client_id)).toBe(true);
    expect(db.state().clients.has(newClient.client_id)).toBe(true);
    expect(db.state().grants.size).toBe(1);
    expect(db.state().tokens.size).toBe(2);
    expect(await authenticateMcpRequest(accessRequest(issued.access_token), db.deps)).toMatchObject({ id: key.id });
    expect(db.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'register', expiredUnusedRemoved: 2000 }));
    const cleanup = db.query.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM context_mcp_private.oauth_clients'))!;
    expect(cleanup[0]).toContain('NOT EXISTS');
    expect(cleanup[0]).toContain('LIMIT 2000');
    expect(cleanup[1]).toEqual([1800]);
  });
  it('expires never-used client identities and generates new IDs for identical anonymous metadata', async () => {
    const db = database(); const first = await consent(db); const second = await registered(db);
    expect(second.client_id).not.toBe(first.client.client_id);
    db.state().clients.get(first.client.client_id)!.created_at = new Date(Date.now() - 31 * 60_000).toISOString();
    const response = await handleMcpOAuthRequest(new Request(`${origin}/api/oauth/authorize?${first.params}`), 'authorize', db.deps);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('invalid_client');
  });
  it('bounds fresh pending registrations but does not count used client identities against that cap', async () => {
    const db = database();
    for (let index = 0; index < 2000; index++) {
      const id = `wog_client_${String(index).padStart(43, '0')}`;
      db.state().clients.set(id, { id, name: 'Pending', redirect_uris: [redirect], scopes: key.scopes, created_at: new Date().toISOString() });
    }
    const response = await handleMcpOAuthRequest(jsonRequest('/oauth/register', { redirect_uris: [redirect] }), 'register', db.deps);
    expect(response.status).toBe(503);
    // A granted identity is retained indefinitely and frees a pending slot.
    const first = db.state().clients.keys().next().value!;
    db.state().grants.set('synthetic-existing-grant', { client_id: first });
    expect((await registered(db)).client_id).toBeTruthy();
    expect(db.state().clients.size).toBe(2001);
  });
  it('logs committed replay revocation and lifecycle outcomes without credentials, state, IPs, or employee data', async () => {
    const db = database(); const auth = await authorized(db); const issued = await (await exchange(db, auth)).json();
    const rotated = await (await refresh(db, auth.client.client_id, issued.refresh_token)).json();
    expect((await refresh(db, auth.client.client_id, issued.refresh_token)).status).toBe(400);
    const events = vi.mocked(db.deps.audit).mock.calls.map(([entry]) => entry);
    expect(events).toContainEqual(expect.objectContaining({ action: 'token', outcome: 'replay_revoked', reason: 'refresh_replay' }));
    const replayIndex = events.findIndex(entry => entry.outcome === 'replay_revoked');
    expect(vi.mocked(db.deps.audit).mock.invocationCallOrder[replayIndex]).toBeGreaterThan(db.commits.mock.invocationCallOrder.at(-1)!);
    const serialized = JSON.stringify(events);
    for (const secret of [apiKey, auth.code, auth.preview.requestHandle, auth.cookie, verifier, issued.access_token, issued.refresh_token, rotated.refresh_token, key.employeeEmail, key.id, 'client-secret-state']) expect(serialized).not.toContain(secret);
    expect(events.some(entry => typeof entry.requestId === 'string')).toBe(true);
  });
  it('does not roll back token issuance if the audit sink fails', async () => {
    const db = database(); const auth = await authorized(db);
    db.deps.audit = () => { throw new Error('Synthetic unavailable logger'); };
    expect((await exchange(db, auth)).status).toBe(200);
    expect(db.state().tokens.size).toBe(2);
  });
});

describe('MCP OAuth protocol and consent boundaries', () => {
  it('publishes one canonical resource, public DCR, S256 and code/refresh metadata', () => {
    expect(protectedResourceMetadata()).toMatchObject({ resource, authorization_servers: [origin], bearer_methods_supported: ['header'] });
    expect(authorizationServerMetadata()).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, registration_endpoint: `${origin}/oauth/register`, token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
    expect(authorizationServerMetadata().grant_types_supported).not.toContain('password');
  });
  it.each(['https://evil.example/callback', 'https://claude.ai/other', 'https://claude.ai/api/mcp/auth_callback?next=https://evil.example', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://localhost:6274/callback', 'https://claude.ai/api/mcp/auth_callback#fragment', 'https://user:pass@claude.ai/api/mcp/auth_callback'])('denies untrusted or nonexact callback %s', value => {
    expect(() => validateRedirect(value)).toThrow();
  });
  it('allows only explicitly configured extra HTTPS origins, and loopback only in local console mode', () => {
    vi.stubEnv('CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS', 'https://trusted.example');
    expect(validateRedirect('https://trusted.example/exact-callback')).toBe('https://trusted.example/exact-callback');
    vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', 'http://localhost:3100');
    expect(validateRedirect('http://127.0.0.1:6274/callback')).toBe('http://127.0.0.1:6274/callback');
    expect(() => validateRedirect('http://localhost.evil.example:6274/callback')).toThrow();
  });
  it('ignores unknown DCR metadata without fetching metadata or accepting unsupported grants', async () => {
    const db = database(); const fetcher = vi.spyOn(globalThis, 'fetch');
    const registration = await registered(db);
    expect(registration).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [redirect] });
    expect(registration).not.toHaveProperty('client_secret');
    expect(fetcher).not.toHaveBeenCalled();
    const rejected = await handleMcpOAuthRequest(jsonRequest('/oauth/register', { redirect_uris: [redirect], grant_types: ['password'] }), 'register', db.deps);
    expect(rejected.status).toBe(400);
  });
  it('requires exact client redirect, S256, resource, and rejects duplicate/unknown authorization parameters', async () => {
    const db = database(); const start = await consent(db);
    expect(start.preview).toMatchObject({ redirectUri: redirect, redirectOrigin: 'https://claude.ai', clientOrigin: 'https://claude.ai', resource });
    for (const change of [{ resource: `${origin}/api/v1` }, { code_challenge_method: 'plain' }, { redirect_uri: 'https://claude.ai/other' }, { apiKey }]) {
      const params = new URLSearchParams(start.params); for (const [name, value] of Object.entries(change)) params.set(name, value);
      expect(() => parseAuthorization(params)).toThrow();
    }
    const duplicate = new URLSearchParams(start.params); duplicate.append('client_id', start.client.client_id);
    expect(() => parseAuthorization(duplicate)).toThrow();
  });
  it('binds preview to an HttpOnly browser cookie, rejecting tamper, missing cookie, expiry and cross-origin approval', async () => {
    const db = database(); const start = await consent(db);
    const body = { requestHandle: start.preview.requestHandle, approve: true, apiKey };
    expect((await handleMcpOAuthRequest(jsonRequest('/api/oauth/authorize', body), 'authorize', db.deps)).status).toBe(409);
    expect((await handleMcpOAuthRequest(jsonRequest('/api/oauth/authorize', body, { Cookie: start.cookie, Origin: 'https://evil.example' }), 'authorize', db.deps)).status).toBe(403);
    const request = new Request(`${origin}/api/oauth/authorize`, { headers: { Cookie: start.cookie } });
    expect(() => readConsent(request, start.preview.requestHandle + 'x')).toThrow();
    expect(() => readConsent(request, start.preview.requestHandle, Date.now() + 601_000)).toThrow();
    const repeated = createConsent(request, parseAuthorization(start.params));
    expect(repeated.cookie.split(';')[0]).toBe(start.cookie);
    expect(db.state().grants.size).toBe(0);
  });
  it('denies consent without accepting the console password and does not create a grant on cancellation', async () => {
    const db = database(); const start = await consent(db);
    const bad = await handleMcpOAuthRequest(jsonRequest('/api/oauth/authorize', { requestHandle: start.preview.requestHandle, approve: true, apiKey: 'shared-admin-password' }, { Cookie: start.cookie }), 'authorize', db.deps);
    expect(bad.status).toBe(401);
    const denied = await handleMcpOAuthRequest(jsonRequest('/api/oauth/authorize', { requestHandle: start.preview.requestHandle, approve: false }, { Cookie: start.cookie }), 'authorize', db.deps);
    expect(denied.status).toBe(200);
    expect(new URL((await denied.json()).redirectUrl).searchParams.get('error')).toBe('access_denied');
    expect(db.state().grants.size).toBe(0);
  });
  it('consumes a browser approval handle once and stores only credential hashes', async () => {
    const db = database(); const auth = await authorized(db);
    const replay = await handleMcpOAuthRequest(jsonRequest('/api/oauth/authorize', auth.body, { Cookie: auth.cookie }), 'authorize', db.deps);
    expect(replay.status).toBe(409);
    expect(db.state().grants.size).toBe(1);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(auth.code);
  });
  it('fails closed before DB work when disabled, malformed or the fixed request budget is exhausted', async () => {
    const db = database();
    vi.stubEnv('CONTEXT_MCP_ENABLED', 'false');
    expect((await handleMcpOAuthRequest(jsonRequest('/oauth/register', {}), 'register', db.deps)).status).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
    vi.stubEnv('CONTEXT_MCP_ENABLED', '');
    await expect(authenticateMcpRequest(accessRequest(apiKey), db.deps)).rejects.toMatchObject({ status: 401 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('MCP OAuth token lifecycle and employee isolation', () => {
  it('exchanges PKCE code, narrows requested access to the employee, and authenticates only audience-bound OAuth access tokens', async () => {
    const db = database(); db.roster.dashboardAccess = false; db.roster.twenty_user_id = null;
    const auth = await authorized(db); const response = await exchange(db, auth);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'knowledge:read', resource });
    expect(tokens.expires_in).toBeGreaterThan(850); expect(tokens.expires_in).toBeLessThanOrEqual(900);
    expect(await authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).toMatchObject({ id: key.id, employeeId: 19, employeeEmail: key.employeeEmail, scopes: ['knowledge:read'] });
    await expect(authenticateMcpRequest(accessRequest(tokens.refresh_token), db.deps)).rejects.toMatchObject({ status: 401 });
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(tokens.access_token);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(tokens.refresh_token);
    expect([...db.state().tokens.values()].every(row => row.expires_at <= new Date(key.expiresAt))).toBe(true);
  });
  it('rejects incorrect verifier, callback, resource and client without consuming a valid code', async () => {
    const db = database(); const auth = await authorized(db); const other = await registered(db);
    const invalid: Record<string, string>[] = [{ code_verifier: 'b'.repeat(64) }, { redirect_uri: `${redirect}/different` }, { resource: `${origin}/api/v1` }, { client_id: other.client_id }];
    for (const overrides of invalid) {
      expect((await exchange(db, auth, overrides)).status).toBe(400);
    }
    expect([...db.state().codes.values()][0].used_at).toBe(null);
    expect((await exchange(db, auth)).status).toBe(200);
  });
  it('commits family revocation on code replay', async () => {
    const db = database(); const auth = await authorized(db); const tokens = await (await exchange(db, auth)).json();
    const replay = await exchange(db, auth);
    expect(replay.status).toBe(400); expect((await replay.json()).error).toBe('invalid_grant');
    expect([...db.state().grants.values()][0].revoked_at).not.toBe(null);
    await expect(authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).rejects.toMatchObject({ status: 401 });
  });
  it('rotates refresh tokens atomically and persists revocation after a reused refresh token', async () => {
    const db = database(); const auth = await authorized(db); const first = await (await exchange(db, auth)).json();
    const refreshed = await refresh(db, auth.client.client_id, first.refresh_token);
    expect(refreshed.status).toBe(200); const second = await refreshed.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await authenticateMcpRequest(accessRequest(second.access_token), db.deps)).toMatchObject({ employeeId: 19 });
    const replay = await refresh(db, auth.client.client_id, first.refresh_token);
    expect(replay.status).toBe(400); expect((await replay.json()).error).toBe('invalid_grant');
    expect([...db.state().grants.values()][0].revoked_at).not.toBe(null);
    for (const access of [first.access_token, second.access_token]) await expect(authenticateMcpRequest(accessRequest(access), db.deps)).rejects.toMatchObject({ status: 401 });
  });
  it('narrows refresh permissions and never restores removed scopes on later refresh', async () => {
    const db = database(); const auth = await authorized(db); const first = await (await exchange(db, auth)).json();
    const second = await (await refresh(db, auth.client.client_id, first.refresh_token, { scope: 'knowledge:read' })).json();
    expect(second.scope).toBe('knowledge:read');
    const widened = await refresh(db, auth.client.client_id, second.refresh_token, { scope: 'knowledge:read warehouses:read' });
    expect((await widened.json()).error).toBe('invalid_scope');
    const third = await (await refresh(db, auth.client.client_id, second.refresh_token)).json();
    expect(third.scope).toBe('knowledge:read');
  });
  it.each(['removed', 'expired', 'inactive', 'changed-employee'])('invalidates code/refresh/access when the source employee key is %s', async condition => {
    const db = database(); const auth = await authorized(db); const tokens = await (await exchange(db, auth)).json();
    if (condition === 'removed') vi.stubEnv('CONTEXT_API_KEYS_JSON', '[]');
    if (condition === 'expired') vi.stubEnv('CONTEXT_API_KEYS_JSON', JSON.stringify([{ ...key, expiresAt: new Date(Date.now() - 1000).toISOString() }]));
    if (condition === 'inactive') db.roster.is_active = false;
    if (condition === 'changed-employee') db.roster.id = 20;
    await expect(authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).rejects.toMatchObject({ status: 401 });
    const result = await refresh(db, auth.client.client_id, tokens.refresh_token);
    expect(result.status).toBe(400); expect((await result.json()).error).toBe('invalid_grant');
  });
  it('rechecks database-backed employee key hashes so console rotation revokes connector access', async () => {
    const db = database(); vi.stubEnv('CONTEXT_API_KEYS_JSON', '[]');
    db.dbKeys.set(key.hash, { id: 'console_11111111-1111-4111-8111-111111111111', employee_id: 19, employee_email: key.employeeEmail, token_hash: key.hash, scopes: key.scopes, expires_at: new Date(key.expiresAt) });
    const auth = await authorized(db); const tokens = await (await exchange(db, auth)).json();
    const current = await authenticateMcpRequest(accessRequest(tokens.access_token), db.deps);
    expect(current.source).toBe('database');
    db.dbKeys.delete(key.hash);
    await expect(authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).rejects.toMatchObject({ status: 401 });
    expect((await (await refresh(db, auth.client.client_id, tokens.refresh_token)).json()).error).toBe('invalid_grant');
  });
  it('revokes only the matching public client family and rechecks grant state during later business transactions', async () => {
    const db = database(); const auth = await authorized(db); const tokens = await (await exchange(db, auth)).json();
    const current = await authenticateMcpRequest(accessRequest(tokens.access_token), db.deps);
    await revalidateMcpGrant(db.client, current);
    const other = await registered(db);
    const revoke = (clientId: string) => handleMcpOAuthRequest(new Request(`${origin}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }) }), 'revoke', db.deps);
    expect((await revoke(other.client_id)).status).toBe(200);
    await revalidateMcpGrant(db.client, current);
    expect((await revoke(auth.client.client_id)).status).toBe(200);
    await expect(revalidateMcpGrant(db.client, current)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects JSON token exchange, duplicated parameters and unsupported grants before database work', async () => {
    const db = database();
    expect((await handleMcpOAuthRequest(jsonRequest('/oauth/token', {}), 'token', db.deps)).status).toBe(415);
    const repeated = new Request(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `client_id=a&client_id=b&resource=${encodeURIComponent(resource)}` });
    expect((await handleMcpOAuthRequest(repeated, 'token', db.deps)).status).toBe(400);
    expect((await handleMcpOAuthRequest(tokenRequest({ grant_type: 'password', resource }), 'token', db.deps)).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects expired codes, access tokens and refresh tokens, and grants for another audience', async () => {
    const db = database(); const auth = await authorized(db);
    const storedCode = [...db.state().codes.values()][0];
    storedCode.expires_at = new Date(Date.now() - 1000);
    expect((await exchange(db, auth)).status).toBe(400);
    db.state().codes.get(hashOAuth(auth.code))!.expires_at = new Date(Date.now() + 100_000);
    const tokens = await (await exchange(db, auth)).json();
    db.state().tokens.get(hashOAuth(tokens.access_token))!.expires_at = new Date(Date.now() - 1000);
    await expect(authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).rejects.toMatchObject({ status: 401 });
    db.state().tokens.get(hashOAuth(tokens.access_token))!.expires_at = new Date(Date.now() + 100_000);
    [...db.state().grants.values()][0].resource = `${origin}/other`;
    await expect(authenticateMcpRequest(accessRequest(tokens.access_token), db.deps)).rejects.toMatchObject({ status: 401 });
    [...db.state().grants.values()][0].resource = resource;
    db.state().tokens.get(hashOAuth(tokens.refresh_token))!.expires_at = new Date(Date.now() - 1000);
    expect((await (await refresh(db, auth.client.client_id, tokens.refresh_token)).json()).error).toBe('invalid_grant');
  });

  it('keeps missing-client token errors interoperable and never exposes raw driver failures', async () => {
    const db = database(); const auth = await authorized(db);
    db.state().clients.delete(auth.client.client_id);
    const missing = await exchange(db, auth);
    expect(missing.status).toBe(401); expect((await missing.json()).error).toBe('invalid_client');
    const failing = { ...db.deps, readTransaction: async <T>(): Promise<T> => { throw new Error('postgres://private-password@internal-host'); } };
    const preview = await handleMcpOAuthRequest(new Request(`${origin}/api/oauth/authorize?${auth.params}`), 'authorize', failing);
    expect(preview.status).toBe(503);
    expect(await preview.text()).not.toMatch(/private-password|internal-host/);
  });

  it('uses one fixed real registration budget before any database work, regardless of submitted client names', async () => {
    const db = database();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
    const deps = { readTransaction: db.deps.readTransaction, writeTransaction: db.deps.writeTransaction };
    for (let index = 0; index < 10; index++) {
      expect((await handleMcpOAuthRequest(jsonRequest('/oauth/register', { client_name: `unknown-${index}` }), 'register', deps)).status).toBe(400);
    }
    const exhausted = await handleMcpOAuthRequest(jsonRequest('/oauth/register', { client_name: 'valid', redirect_uris: [redirect] }), 'register', deps);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('retry-after')).toBe('60');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('bounds malformed registration bodies and never opens a transaction for oversized input', async () => {
    const db = database();
    const huge = jsonRequest('/oauth/register', { client_name: 'x'.repeat(9000) });
    expect((await handleMcpOAuthRequest(huge, 'register', db.deps)).status).toBe(413);
    const declared = jsonRequest('/oauth/register', {}, { 'Content-Length': '9000' });
    expect((await handleMcpOAuthRequest(declared, 'register', db.deps)).status).toBe(413);
    expect(db.query).not.toHaveBeenCalled();
  });
});
