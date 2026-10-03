import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_SCOPES, type KeyRegistration } from '../src/lib/auth';
import { handleMcpRequest } from '../src/lib/mcp';
import { handleRameshMcpRequest } from '../src/lib/ramesh-mcp';
import { TOOL_DEFAULT_PLATFORMS, TOOL_PROMPTS, type PromptValues, type ToolPlatform } from '../src/lib/prompt-definitions';

const origin = 'https://context.example.test';
const whatsappEndpoint = `${origin}/mcp/ramesh`;
let privateKey: CryptoKey;
let key: KeyRegistration;
let prompts: PromptValues;
const employee = { id: 23, phone_number: '919876543210', email: 'admin@wareongo.test', is_active: true,
  dashboardAccess: true, adminAccess: true, analystAccess: true, twenty_user_id: null };
const database = { query: vi.fn(async () => ({ rows: [employee] })) } as unknown as PoolClient;
// A valid empty knowledge page lets allowed calls complete through the SDK.
const read = vi.fn(async () => Response.json({ data: { items: [], nextCursor: null },
  meta: { requestId: 'platform-test', generatedAt: new Date().toISOString() } }));

beforeEach(async () => {
  const pair = await generateKeyPair('EdDSA'); privateKey = pair.privateKey;
  key = { id: randomUUID(), hash: 'a'.repeat(64), employeeId: employee.id, employeeEmail: employee.email,
    scopes: [...READ_SCOPES], expiresAt: '2099-01-01T00:00:00Z' };
  prompts = {};
  read.mockClear();
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_MCP_ENABLED', 'true');
  vi.stubEnv('CONTEXT_RAMESH_AUTH_ENABLED', 'true');
  vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([{ kid: 'platform-test', publicKey: await exportJWK(pair.publicKey),
    scopes: [...READ_SCOPES], expiresAt: '2099-01-01T00:00:00Z' }]));
});
afterEach(() => vi.unstubAllEnvs());

async function rpc(platform: ToolPlatform, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const endpoint = platform === 'whatsapp' ? whatsappEndpoint : `${origin}/mcp`;
  if (platform === 'whatsapp') {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: 'wareongo:ramesh', aud: endpoint, sub: String(employee.id), phone: `+${employee.phone_number}`,
      chat_type: 'dm', htm: 'POST', htu: endpoint, iat: now, exp: now + 60, jti: randomUUID(), scopes: key.scopes,
      body_sha256: createHash('sha256').update(body).digest('base64url') })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'ramesh-request+jwt', kid: 'platform-test' }).sign(privateKey);
    headers.authorization = `Ramesh ${token}`;
  }
  const request = new Request(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
  const dependencies = { read, prompts: async () => prompts };
  const response = platform === 'whatsapp'
    ? await handleRameshMcpRequest(request, { ...dependencies, auth: { readTransaction: async work => work(database), consumeNonce: async () => true }, audit: () => {} })
    : await handleMcpRequest(request, { ...dependencies, authenticate: async () => key });
  expect(response.status).toBe(200);
  const text = await response.text();
  return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5) : text);
}
const names = (result: { tools: { name: string }[] }) => result.tools.map(tool => tool.name);

describe('platform-specific MCP tool availability', () => {
  it('keeps existing read tools on both harnesses by default within granted scopes', async () => {
    expect(key.scopes).not.toContain('gis:write');
    const expected = Object.keys(TOOL_PROMPTS).filter(name => name !== 'create_gis_poi'
      && (key.scopes.includes('analytics:read') || !['analytics_capabilities', 'ga4_report', 'search_console_report'].includes(name)));
    for (const platform of ['claude', 'whatsapp'] as const) {
      expect(names((await rpc(platform, 'tools/list')).result)).toEqual(expected);
    }
  });

  it.each(([['claude'], ['whatsapp'], ['claude', 'whatsapp'], []] as ToolPlatform[][]).map(selection => ({ selection })))('enforces the $selection selection for discovery and direct execution', async ({ selection }) => {
    prompts = { toolPlatforms: { search_knowledge: selection } };
    for (const platform of ['claude', 'whatsapp'] as const) {
      const listed = names((await rpc(platform, 'tools/list')).result);
      expect(listed.includes('search_knowledge')).toBe(selection.includes(platform));
      read.mockClear();
      const result = await rpc(platform, 'tools/call', { name: 'search_knowledge', arguments: {} });
      if (selection.includes(platform)) {
        expect(result.result.isError).not.toBe(true);
        expect(read).toHaveBeenCalledOnce();
      } else {
        expect(result.error ?? result.result?.isError).toBeTruthy();
        expect(read).not.toHaveBeenCalled();
      }
    }
  });

  it('applies code defaults to a newly restricted tool even before it has a saved override', async () => {
    const previous = TOOL_DEFAULT_PLATFORMS.search_knowledge;
    TOOL_DEFAULT_PLATFORMS.search_knowledge = ['whatsapp'];
    try {
      expect(names((await rpc('claude', 'tools/list')).result)).not.toContain('search_knowledge');
      expect(names((await rpc('whatsapp', 'tools/list')).result)).toContain('search_knowledge');
    } finally { TOOL_DEFAULT_PLATFORMS.search_knowledge = previous; }
  });

  it('rejects stale calls immediately after a platform is deselected', async () => {
    expect(names((await rpc('claude', 'tools/list')).result)).toContain('search_knowledge');
    prompts = { toolPlatforms: { search_knowledge: ['whatsapp'] } };
    const result = await rpc('claude', 'tools/call', { name: 'search_knowledge', arguments: {} });
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(names((await rpc('whatsapp', 'tools/list')).result)).toContain('search_knowledge');
  });

  it('does not trust headers, client names or tool arguments to choose a platform', async () => {
    prompts = { toolPlatforms: { search_knowledge: ['whatsapp'] } };
    await rpc('claude', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'whatsapp', version: '1' } });
    const listed = await rpc('claude', 'tools/list', { platform: 'whatsapp' }, { 'x-platform': 'whatsapp', 'x-tool-platform': 'whatsapp' });
    expect(names(listed.result)).not.toContain('search_knowledge');
    const result = await rpc('claude', 'tools/call', { name: 'search_knowledge', arguments: { platform: 'whatsapp' } });
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['claude', 'whatsapp'] as const)('still requires employee scopes on %s', async platform => {
    key.scopes = ['knowledge:read'];
    prompts = { toolPlatforms: { search_crm_leads: ['claude', 'whatsapp'] } };
    expect(names((await rpc(platform, 'tools/list')).result)).not.toContain('search_crm_leads');
    const result = await rpc(platform, 'tools/call', { name: 'search_crm_leads', arguments: {} });
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
});
