import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest, type McpDependencies } from '../src/lib/mcp';
import type { KeyRegistration, Scope } from '../src/lib/auth';
import { argumentsSha256, MCP_READ_CONTRACT_KEY, requestReadBinding } from '../src/lib/mcp-read-contract';
import { resolveDateQuery } from '../src/lib/query-time';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));

const origin = 'https://context.example.test';
const meta = { requestId: 'synthetic-contract', generatedAt: '2026-10-03T00:00:00.000Z' };
const expected: Record<string, { requiredScopes: Scope[]; sourceFamily: string }> = {
  get_context: { requiredScopes: [], sourceFamily: 'context' },
  resolve_location: { requiredScopes: [], sourceFamily: 'context' },
  analytics_capabilities: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  ga4_report: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  search_console_report: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  search_knowledge: { requiredScopes: ['knowledge:read'], sourceFamily: 'knowledge' },
  read_knowledge: { requiredScopes: ['knowledge:read'], sourceFamily: 'knowledge' },
  warehouse_filters: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  search_warehouses: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  warehouse_summary: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  read_warehouse: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  assess_shortlist: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_filters: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  search_crm_leads: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_summary: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  read_crm_lead: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  read_crm_lead_context: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_briefing: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function envelope(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.structuredContent as Record<string, unknown>;
}
function registration(scopes: Scope[]): KeyRegistration {
  return { id: randomUUID(), employeeId: 7, employeeEmail: 'synthetic@example.test', hash: 'a'.repeat(64), scopes, expiresAt: '2099-01-01T00:00:00Z' };
}
async function sdk(scopes: Scope[], read: McpDependencies['read'], platform: 'claude' | 'whatsapp' = 'whatsapp') {
  const key = registration(scopes);
  const client = new Client({ name: 'synthetic-read-contract', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => key, read, platform }),
  }));
  return client;
}

beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());

describe('server-owned MCP read contracts', () => {
  it.each(['claude', 'whatsapp'] as const)('advertises every %s read with its scopes, family, annotations and binding schema', async platform => {
    const read = vi.fn();
    const client = await sdk(['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read'], read, platform);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(expected).sort());
      for (const tool of tools) {
        expect(tool._meta?.[MCP_READ_CONTRACT_KEY]).toEqual(expected[tool.name]);
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(tool.outputSchema?.required).toEqual(expect.arrayContaining(['source_path', 'status', 'data', 'meta']));
        const schema = tool.outputSchema as { properties: { meta: { required: string[] } } };
        expect(schema.properties.meta.required).toEqual(expect.arrayContaining(['toolName', 'argumentsSha256']));
      }
      expect(read).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it.each<Scope[]>([[], ['knowledge:read'], ['warehouses:read'], ['crm:read'], ['analytics:read']])('discovery matches the advertised minimum scopes %j', async (...scopes) => {
    const read = vi.fn();
    const client = await sdk(scopes, read);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(expected).filter(name => expected[name].requiredScopes.every(scope => scopes.includes(scope))).sort());
      expect(read).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it('binds original trimmed input, ignores object order, and overwrites source-supplied binding fields', async () => {
    const read = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get('q')).toBe('synthetic');
      return Response.json({ data: { items: [], nextCursor: null }, meta: { ...meta, toolName: 'forged', argumentsSha256: '0'.repeat(64) } });
    });
    const client = await sdk(['knowledge:read'], read);
    try {
      const first = await client.callTool({ name: 'search_knowledge', arguments: { q: '  synthetic  ', limit: 2 } });
      const reordered = await client.callTool({ name: 'search_knowledge', arguments: { limit: 2, q: '  synthetic  ' } });
      const changed = await client.callTool({ name: 'search_knowledge', arguments: { q: 'synthetic', limit: 2 } });
      for (const result of [first, reordered, changed]) expect(result.isError).not.toBe(true);
      expect(envelope(first).meta).toEqual({ ...meta, toolName: 'search_knowledge', argumentsSha256: digest('{"limit":2,"q":"  synthetic  "}') });
      expect(envelope(reordered).meta).toEqual(envelope(first).meta);
      expect(envelope(changed).meta).toEqual({ ...meta, toolName: 'search_knowledge', argumentsSha256: digest('{"limit":2,"q":"synthetic"}') });
      expect(JSON.parse((first.content as Array<{ text: string }>)[0].text)).toEqual(first.structuredContent);
    } finally { await client.close(); }
  });

  it('keeps omitted arguments and defaulted projection settings distinct from explicitly supplied settings', async () => {
    const read = vi.fn(async () => Response.json({ data: {
      items: [], nextCursor: null,
      matching_policy: { mode: 'permissive', include_unknown: false, range_matching: 'overlap', guidance: 'Synthetic.' },
      query_context: { ...resolveDateQuery(new URLSearchParams(), ['created'], new Date(meta.generatedAt)), sort: 'id_asc', returned_count: 0, has_more: false },
    }, meta }));
    const client = await sdk(['warehouses:read'], read);
    try {
      const omitted = await client.callTool({ name: 'search_warehouses' });
      const empty = await client.callTool({ name: 'search_warehouses', arguments: {} });
      const explicit = await client.callTool({ name: 'search_warehouses', arguments: { response_format: 'concise' } });
      for (const result of [omitted, empty, explicit]) expect(result.isError).not.toBe(true);
      expect(envelope(omitted).meta).toEqual({ ...meta, toolName: 'search_warehouses', argumentsSha256: digest('{}') });
      expect(envelope(empty).meta).toEqual(envelope(omitted).meta);
      expect(envelope(explicit).meta).toEqual({ ...meta, toolName: 'search_warehouses', argumentsSha256: digest('{"response_format":"concise"}') });
      expect(envelope(explicit).data).toEqual(envelope(empty).data);
    } finally { await client.close(); }
  });

  it('canonicalizes nested JSON without mutating it and preserves array order and special own keys', () => {
    const args = JSON.parse('{"z":[{"b":2,"a":1},null,true],"a":{"Z":0,"A":"value","__proto__":{"z":2,"a":1}}}');
    const before = JSON.stringify(args);
    const expectedJson = '{"a":{"A":"value","Z":0,"__proto__":{"a":1,"z":2}},"z":[{"a":1,"b":2},null,true]}';
    expect(argumentsSha256(args)).toBe(digest(expectedJson));
    expect(argumentsSha256(JSON.parse(expectedJson))).toBe(argumentsSha256(args));
    expect(JSON.stringify(args)).toBe(before);
    const altered = structuredClone(args);
    altered.z.reverse();
    expect(argumentsSha256(altered)).not.toBe(argumentsSha256(args));
    const binding = requestReadBinding(Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'synthetic_read', arguments: args } })));
    args.z[0].a = 999;
    expect(binding).toEqual({ toolName: 'synthetic_read', argumentsSha256: digest(expectedJson) });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('leaves malformed and non-call envelopes to protocol validation and rejects extreme argument depth', () => {
    for (const value of ['{', 'null', '[]', '{"method":"tools/list"}', '{"method":"tools/call","params":{"name":"synthetic","arguments":[]}}'])
      expect(requestReadBinding(Buffer.from(value))).toBeUndefined();
    let args: Record<string, unknown> = {};
    for (let n = 0; n < 42; n++) args = { nested: args };
    expect(() => argumentsSha256(args)).toThrow('too deeply nested');
  });
});
