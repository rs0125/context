import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import { authenticateRameshRequest, revalidateRameshRequest, type RameshAuthDependencies } from '../src/lib/ramesh-auth';
import { handleRameshMcpRequest } from '../src/lib/ramesh-mcp';
import { handleMcpRequest } from '../src/lib/mcp';
import { handleApiRequest } from '../src/lib/api';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const origin = 'https://context.example.test', endpoint = `${origin}/mcp/ramesh`;
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } });
let privateKey: CryptoKey;
let registration: { kid: string; publicKey: object; scopes: string[]; expiresAt: string };
const employee = () => ({ id: 23, phone_number: '919876543210', email: 'employee@wareongo.test', is_active: true,
  dashboardAccess: true, adminAccess: false, analystAccess: false, twenty_user_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' });
let rows: ReturnType<typeof employee>[];
let db: PoolClient;
let deps: RameshAuthDependencies;
let nonces: Set<string>;

beforeEach(async () => {
  const keys = await generateKeyPair('EdDSA'); privateKey = keys.privateKey;
  registration = { kid: 'ramesh-test', publicKey: await exportJWK(keys.publicKey), scopes: ['knowledge:read', 'crm:read', 'warehouses:read'], expiresAt: '2099-01-01T00:00:00Z' };
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_RAMESH_AUTH_ENABLED', 'true');
  vi.stubEnv('CONTEXT_MCP_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([registration]));
  rows = [employee()]; nonces = new Set();
  db = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('VerifiedNumber') ? rows : [] })) } as unknown as PoolClient;
  deps = { readTransaction: async work => work(db), now: Date.now, consumeNonce: vi.fn(async hash => {
    if (nonces.has(hash)) return false; nonces.add(hash); return true;
  }) };
});
afterEach(() => vi.unstubAllEnvs());

async function signed(options: { claims?: Record<string, unknown>; header?: Record<string, unknown>; content?: string; key?: CryptoKey; token?: string; url?: string } = {}) {
  const content = options.content ?? body, now = Math.floor(Date.now() / 1000);
  const token = options.token ?? await new SignJWT({
    iss: 'wareongo:ramesh', aud: endpoint, sub: '23', phone: '+919876543210', chat_type: 'dm', htm: 'POST', htu: endpoint,
    iat: now, exp: now + 60, jti: randomUUID(), scopes: ['knowledge:read', 'crm:read', 'warehouses:read'],
    body_sha256: createHash('sha256').update(content).digest('base64url'), ...options.claims,
  }).setProtectedHeader({ alg: 'EdDSA', typ: 'ramesh-request+jwt', kid: registration.kid, ...options.header }).sign(options.key ?? privateKey);
  return new Request(options.url ?? endpoint, { method: 'POST', body: content, headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Ramesh ${token}`, 'MCP-Protocol-Version': '2025-11-25',
  } });
}

describe('Ramesh signed request authentication', () => {
  it.each(['crm.rfq:write', 'crm.notes:write'])('requires an explicit %s issuer grant and current linked CRM identity', async scope => {
    registration.scopes = [scope];
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([registration]));
    const key = await authenticateRameshRequest(await signed({ claims: { scopes: [scope] } }), deps);
    expect(key.scopes).toEqual([scope]);
    rows[0].twenty_user_id = '';
    await expect(authenticateRameshRequest(await signed({ claims: { scopes: [scope] } }), deps)).rejects.toMatchObject({ code: 'RAMESH_UNAUTHORIZED' });
  });
  it('binds the employee and intersects requested scopes with current roster permissions', async () => {
    rows[0].dashboardAccess = false;
    const key = await authenticateRameshRequest(await signed(), deps);
    expect(key.employeeId).toBe(23); expect(key.scopes).toEqual(['knowledge:read', 'crm:read']);
    expect(key.id).toMatch(/^ramesh_/); expect(nonces.size).toBe(1);
    await revalidateRameshRequest(db, key);
  });
  it('admits explicitly registered draft access for an active employee without dashboard permissions', async () => {
    registration.scopes = ['mail:drafts'];
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([registration]));
    rows[0].dashboardAccess = false;
    const key = await authenticateRameshRequest(await signed({ claims: { scopes: ['mail:drafts'] } }), deps);
    expect(key.employeeId).toBe(23);
    expect(key.scopes).toEqual(['mail:drafts']);
    await revalidateRameshRequest(db, key);
    rows[0].is_active = false;
    await expect(revalidateRameshRequest(db, key)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    ['issuer', { iss: 'attacker' }], ['audience', { aud: `${origin}/mcp` }], ['target', { htu: `${origin}/mcp` }],
    ['method', { htm: 'DELETE' }], ['group', { chat_type: 'group' }], ['other employee', { sub: '24' }],
    ['unknown number', { phone: '+919999999999' }], ['unregistered analytics scope', { scopes: ['analytics:read'] }],
    ['unregistered draft scope', { scopes: ['mail:drafts'] }], ['unsupported mail sending', { scopes: ['mail:send'] }],
    ['unregistered RFQ scope', { scopes: ['crm.rfq:write'] }], ['unregistered notes scope', { scopes: ['crm.notes:write'] }], ['unrestricted CRM write', { scopes: ['crm:write'] }],
    ['duplicate scope', { scopes: ['crm:read', 'crm:read'] }], ['unknown claim', { admin: true }],
    ['long expiry', { exp: Math.floor(Date.now() / 1000) + 900 }],
    ['expired', { iat: Math.floor(Date.now() / 1000) - 80, exp: Math.floor(Date.now() / 1000) - 20 }],
    ['future', { iat: Math.floor(Date.now() / 1000) + 30, exp: Math.floor(Date.now() / 1000) + 60 }],
  ])('denies a signed but invalid %s without consuming a nonce', async (_label, changes) => {
    await expect(authenticateRameshRequest(await signed({ claims: changes as Record<string, unknown> }), deps)).rejects.toMatchObject({ status: 401 });
    expect(nonces.size).toBe(0);
  });
  it('rejects forged signatures, unknown keys, unsafe headers, tampered bodies and alternate URLs', async () => {
    const other = await generateKeyPair('EdDSA');
    for (const options of [{ key: other.privateKey }, { header: { kid: 'unknown' } }, { header: { jku: 'https://evil.test/key' } },
      { header: { typ: 'JWT' } }, { url: `${endpoint}?employee=23` }]) {
      await expect(authenticateRameshRequest(await signed(options), deps)).rejects.toMatchObject({ status: 401 });
    }
    const valid = await signed();
    const changed = new Request(valid.url, { method: 'POST', headers: valid.headers, body: body + ' ' });
    await expect(authenticateRameshRequest(changed, deps)).rejects.toMatchObject({ status: 401 });
    const forged = new Request(valid, { headers: { ...Object.fromEntries(valid.headers), authorization: 'Ramesh a.b.c' } });
    await expect(authenticateRameshRequest(forged, deps)).rejects.toMatchObject({ status: 401 });
    expect(nonces.size).toBe(0);
  });
  it('denies inactive or ambiguous employees and rejects rebinding during a read', async () => {
    rows[0].is_active = false;
    await expect(authenticateRameshRequest(await signed(), deps)).rejects.toMatchObject({ status: 401 });
    rows[0].is_active = true; rows.push({ ...employee(), id: 24 });
    await expect(authenticateRameshRequest(await signed(), deps)).rejects.toMatchObject({ status: 401 });
    rows.pop();
    const key = await authenticateRameshRequest(await signed(), deps);
    rows[0].phone_number = '919999999999';
    await expect(revalidateRameshRequest(db, key)).rejects.toMatchObject({ status: 401 });
    rows[0] = employee(); rows[0].email = 'replacement@wareongo.test';
    await expect(revalidateRameshRequest(db, key)).rejects.toMatchObject({ status: 401 });
  });
  it('consumes a signature once and fails closed when the shared replay store fails', async () => {
    const request = await signed();
    const attempts = await Promise.allSettled([1, 2, 3].map(() => authenticateRameshRequest(request.clone(), deps)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(authenticateRameshRequest(await signed(), { ...deps, consumeNonce: async () => { throw new Error('fixture DB unavailable'); } })).rejects.toThrow();
  });
  it('rejects algorithm confusion and oversized bodies before any employee or nonce lookup', async () => {
    const request = await signed();
    const payload = JSON.parse(Buffer.from(request.headers.get('authorization')!.split('.')[1], 'base64url').toString());
    const hmac = await new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'ramesh-request+jwt', kid: registration.kid })
      .sign(new TextEncoder().encode(JSON.stringify(registration.publicKey)));
    await expect(authenticateRameshRequest(await signed({ token: hmac }), deps)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateRameshRequest(await signed({ content: 'a'.repeat(32769) }), deps)).rejects.toMatchObject({ status: 413 });
    expect(db.query).not.toHaveBeenCalled(); expect(nonces.size).toBe(0);
  });
  it('supports key overlap and enforces removal, expiry, and the kill switch on in-flight reads', async () => {
    const first = await authenticateRameshRequest(await signed(), deps);
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([{ ...registration, kid: 'next' }, registration]));
    await revalidateRameshRequest(db, first);
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([{ ...registration, kid: 'next' }]));
    await expect(revalidateRameshRequest(db, first)).rejects.toMatchObject({ status: 401 });
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([{ ...registration, expiresAt: '2020-01-01T00:00:00Z' }]));
    await expect(authenticateRameshRequest(await signed(), deps)).rejects.toMatchObject({ status: 401 });
    vi.stubEnv('CONTEXT_RAMESH_AUTH_ENABLED', 'false');
    await expect(authenticateRameshRequest(await signed(), deps)).rejects.toMatchObject({ status: 503 });
  });
});

describe('parallel MCP entry points', () => {
  it('exposes the full analytics catalogue for a registered admin and removes it after demotion', async () => {
    registration.scopes.push('analytics:read');
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([registration]));
    rows[0].adminAccess = true;
    const audit = vi.fn();
    const read: typeof handleApiRequest = (request, path, overrides) => handleApiRequest(request, path, {
      ...overrides, transaction: async work => work(db), audit,
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { fetch: async (input, init) => {
      const request = new Request(input, init);
      return handleRameshMcpRequest(request.method === 'POST'
        ? await signed({ content: await request.text(), claims: { scopes: registration.scopes } }) : request,
        { auth: deps, read, prompts: async () => ({}), audit });
    } });
    const client = new Client({ name: 'full-catalogue-test', version: '1' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toEqual(expect.arrayContaining(['analytics_capabilities', 'ga4_report', 'search_console_report', 'search_crm_leads', 'search_warehouses']));
      rows[0].adminAccess = false;
      const reduced = (await client.listTools()).tools.map(t => t.name);
      expect(reduced).not.toContain('ga4_report');
      await expect(client.callTool({ name: 'ga4_report', arguments: {} })).rejects.toThrow('not found');
      rows[0].analystAccess = true;
      expect((await client.listTools()).tools.map(t => t.name)).toContain('ga4_report');
    } finally { await client.close(); }
  });
  it('works through the real MCP SDK and API permission boundary with a distinct signature per HTTP request', async () => {
    const audit = vi.fn();
    const read: typeof handleApiRequest = (request, path, overrides) => handleApiRequest(request, path, { ...overrides,
      transaction: async work => work(db), audit });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { fetch: async (input, init) => {
      const incoming = new Request(input, init);
      return handleRameshMcpRequest(incoming.method === 'POST' ? await signed({ content: await incoming.text() }) : incoming,
        { auth: deps, read, prompts: async () => ({}), audit });
    } });
    const client = new Client({ name: 'signed-client-test', version: '1' });
    try {
      await client.connect(transport);
      const tools = await client.listTools(); expect(tools.tools.some(tool => tool.name === 'search_crm_leads')).toBe(true);
      const result = await client.callTool({ name: 'get_context', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { employee_id: 23, read_only: true } });
      expect(nonces.size).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(audit.mock.calls)).not.toMatch(/919876543210|privateKey|Ramesh ey/);
      rows[0].is_active = false;
      await expect(client.callTool({ name: 'get_context', arguments: {} })).rejects.toThrow();
    } finally { await client.close(); }
  });
  it('keeps OAuth and signed credentials separate and denies browser requests', async () => {
    const valid = await signed();
    const oauth = await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'POST', body, headers: valid.headers }));
    expect(oauth.status).toBe(401); expect(oauth.headers.get('www-authenticate')).toContain('Bearer');
    const signedResponse = await handleRameshMcpRequest(new Request(endpoint, { method: 'POST', body,
      headers: { ...Object.fromEntries(valid.headers), authorization: `Bearer wog_mcp_at_${'a'.repeat(43)}` } }), { auth: deps, audit: () => {} });
    expect(signedResponse.status).toBe(401); expect(signedResponse.headers.get('www-authenticate')).toMatch(/^Ramesh /);
    for (const method of ['GET', 'DELETE', 'OPTIONS']) expect((await handleRameshMcpRequest(new Request(endpoint, { method }))).status).toBe(405);
    expect((await handleRameshMcpRequest(new Request(valid, { headers: { ...Object.fromEntries(valid.headers), origin } }))).status).toBe(403);
  });
});
