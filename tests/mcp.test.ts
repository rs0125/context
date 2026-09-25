import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { KeyRegistration } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { handleMcpRequest } from '../src/lib/mcp';
import { handleApiRequest } from '../src/lib/api';
import type { PoolClient } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const origin = 'https://context.example.test';
const employee = { id: 7, email: 'employee@example.test', is_active: true, dashboardAccess: true, adminAccess: false, twenty_user_id: null };
function key(scopes: KeyRegistration['scopes'] = ['knowledge:read', 'warehouses:read', 'crm:read']): KeyRegistration {
  return { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: employee.email, scopes, expiresAt: '2099-01-01T00:00:00Z' };
}
function rpc(method: string, params: object = {}, init: RequestInit = {}) {
  return new Request(`${origin}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...init.headers } });
}
async function wire(response: Response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5));
  }
  return JSON.parse(text);
}
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());

describe('MCP read-only protocol', () => {
  it.each(['legacy', 'auto'] as const)('works through a real MCP SDK client with %s negotiation', async mode => {
    const registration = key(['knowledge:read']);
    const read = vi.fn(async () => Response.json({ data: { employee_id: 7, read_only: true }, meta: { generatedAt: '2026-09-25T00:00:00Z' } }));
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: async (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => registration, read }),
    });
    const client = new Client({ name: 'wareongo-toy-harness', version: '1.0.0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name)).toContain('get_context');
      const result = await client.callTool({ name: 'get_context', arguments: {} });
      expect(result.structuredContent).toMatchObject({ data: { employee_id: 7, read_only: true } });
      expect(result.isError).not.toBe(true);
      expect(read).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
  it('challenges unauthenticated clients with OAuth discovery without exposing tools', async () => {
    const read = vi.fn();
    const response = await handleMcpRequest(rpc('tools/list'), { authenticate: async () => { throw new HttpError(401, 'UNAUTHORIZED', 'Connect your account.'); }, read });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`${origin}/.well-known/oauth-protected-resource`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(read).not.toHaveBeenCalled();
  });
  it('supports the legacy initialization used by existing MCP clients', async () => {
    const response = await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'toy-claude-client', version: '1.0' } }), { authenticate: async () => key() });
    expect(response.status).toBe(200);
    const body = await wire(response);
    expect(body.result.serverInfo.name).toBe('wareongo-context');
    expect(body.result.instructions).toContain('verification_required');
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });
  it('supports older clients and acknowledges initialized notifications without a session', async () => {
    const deps = { authenticate: async () => key() };
    const initialized = await wire(await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'older-client', version: '1' } }, { headers: { 'MCP-Protocol-Version': '2025-03-26' } }), deps));
    expect(initialized.result.protocolVersion).toBe('2025-03-26');
    const response = await handleMcpRequest(rpc('notifications/initialized', {}, { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), deps);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
  it('rejects malformed JSON and unsupported protocol versions', async () => {
    const deps = { authenticate: async () => key(), read: vi.fn() };
    expect((await handleMcpRequest(rpc('tools/list', {}, { body: '{' }), deps)).status).toBe(400);
    expect((await handleMcpRequest(rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '1999-01-01' } }), deps)).status).toBe(400);
    expect(deps.read).not.toHaveBeenCalled();
  });
  it('lists all nine read tools and broad warehouse filters', async () => {
    const response = await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key() });
    const { result } = await wire(response);
    expect(result.tools).toHaveLength(9);
    for (const tool of result.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const warehouse = result.tools.find((tool: { name: string }) => tool.name === 'search_warehouses');
    expect(warehouse.inputSchema.additionalProperties).toBe(false);
    expect(warehouse.inputSchema.properties).toHaveProperty('docks_min');
    expect(warehouse.inputSchema.properties).toHaveProperty('power_min_kva');
    expect(Object.keys(warehouse.inputSchema.properties)).toHaveLength(42);
  });
  it('limits tool discovery to granted scopes, rejects unknown tools and does not expose writes', async () => {
    const read = vi.fn();
    const deps = { authenticate: async () => key(['knowledge:read']), read };
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), deps));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_context', 'search_knowledge', 'read_knowledge']);
    for (const name of ['search_crm_leads', 'update_warehouse', 'fetch', 'execute_sql']) {
      const body = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: {} }), deps));
      expect(body.error ?? body.result?.isError).toBeTruthy();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('invokes the REST read boundary in-process with bound identity and returns source provenance', async () => {
    const registration = key();
    const read = vi.fn(async (request: Request, path: string[], dependencies: Parameters<typeof handleApiRequest>[2]) => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBeNull();
      expect(path).toEqual(['warehouses']);
      expect(await dependencies!.authenticate!(request)).toEqual(registration);
      expect(new URL(request.url).searchParams.get('docks_min')).toBe('5');
      return Response.json({ data: { items: [{ id: 11, verification_required: true, field_evidence: { dock_count: { kind: 'range', lower: 4, upper: 8 } } }], nextCursor: 11 }, meta: { generatedAt: '2026-09-25T00:00:00Z' } });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: { city: 'Bengaluru', docks_min: 5, limit: 2 } }), { authenticate: async () => registration, read }));
    expect(body.result.structuredContent).toMatchObject({ source_path: '/api/v1/warehouses?city=Bengaluru&docks_min=5&limit=2', meta: { generatedAt: '2026-09-25T00:00:00Z' } });
    expect(JSON.parse(body.result.content[0].text).data.items[0].verification_required).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });
  it.each([{ phone: '9876543210' }, { limit: 1000 }, { docks_min: -1 }])('rejects unsupported filters before business reads: %j', async args => {
    const read = vi.fn();
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: args }), { authenticate: async () => key(), read }));
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves sanitization through the actual API boundary', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('VerifiedNumber') ? [employee] : sql.includes('"Warehouse"') ? [{ id: 12, city: 'Bengaluru', contactNumber: '9876543210', media: { secret: 'private' }, total_space_sqft: [40000] }] : [] }));
    const read: typeof handleApiRequest = (request, path, deps) => handleApiRequest(request, path, { ...deps, transaction: async work => work({ query } as unknown as PoolClient), audit: () => {} });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'read_warehouse', arguments: { id: 12 } }), { authenticate: async () => key(), read }));
    expect(body.result.structuredContent.data.id).toBe(12);
    expect(JSON.stringify(body)).not.toMatch(/9876543210|contactNumber|media|secret/);
  });
  it('keeps failures as tool errors rather than an empty list', async () => {
    const read = vi.fn(async () => Response.json({ error: { code: 'CRM_SOURCE_STALE', message: 'CRM needs a recent sync.' } }, { status: 503 }));
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_crm_leads', arguments: {} }), { authenticate: async () => key(), read }));
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.status).toBe(503);
    expect(body.result.structuredContent.error.code).toBe('CRM_SOURCE_STALE');
    expect(body.result.structuredContent).not.toHaveProperty('data');
  });
  it('does not share identity between simultaneous requests', async () => {
    const a = key(['knowledge:read']); const b = key(['knowledge:read']);
    const read: typeof handleApiRequest = async (request, _path, deps) => {
      const identity = await deps!.authenticate!(request);
      await new Promise(resolve => setTimeout(resolve, identity.id === a.id ? 10 : 1));
      return Response.json({ data: { marker: identity.id } });
    };
    const values = await Promise.all([a, b].map(async registration => wire(await handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => registration, read }))));
    expect(values.map(v => v.result.structuredContent.data.marker)).toEqual([a.id, b.id]);
  });
  it('rejects hostile origins and credentials in query strings before authentication', async () => {
    const authenticate = vi.fn(async () => key());
    expect((await handleMcpRequest(rpc('tools/list', {}, { headers: { Origin: 'https://evil.example' } }), { authenticate })).status).toBe(403);
    expect((await handleMcpRequest(new Request(`${origin}/mcp?token=secret`), { authenticate })).status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('bounds JSON payloads, rejects writes outside the protocol and avoids idle streams', async () => {
    const deps = { authenticate: async () => key(), read: vi.fn() };
    expect((await handleMcpRequest(rpc('tools/call', { large: 'a'.repeat(33000) }), deps)).status).toBe(413);
    expect((await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'DELETE' }), deps)).status).toBe(405);
    expect((await handleMcpRequest(new Request(`${origin}/mcp`), deps)).status).toBe(405);
    const cors = await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai' } }), deps);
    expect(cors.status).toBe(204);
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(cors.headers.get('access-control-allow-headers')).toContain('MCP-Method');
    expect(deps.read).not.toHaveBeenCalled();
  });
});
