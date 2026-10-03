import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { KeyRegistration } from '../src/lib/auth';
import { handleMcpRequest, type McpDependencies } from '../src/lib/mcp';
import { clockContext } from '../src/lib/query-time';
import { HttpError } from '../src/lib/errors';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
const origin = 'https://context.example.test';
const backend = 'https://dashboard.example.test/api/integrations/context-engine/geo/points';
const point = { operation_id: randomUUID(), name: 'Synthetic prospect', category: 'POTENTIAL_CLIENT', latitude: 12.9716, longitude: 77.5946 };
const key = (write = false): KeyRegistration => ({ id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
  employeeEmail: 'synthetic@wareongo.com', scopes: write ? ['knowledge:read', 'gis:write'] : ['knowledge:read'], expiresAt: '2099-01-01T00:00:00Z' });
function rpc(method: string, params: object = {}) {
  return new Request(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function wire(response: Response) {
  const text = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5))
    : JSON.parse(text);
}
beforeEach(() => {
  const pair = generateKeyPairSync('ed25519');
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_GIS_WRITES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_GIS_BACKEND_URL', backend);
  vi.stubEnv('CONTEXT_GIS_SIGNING_KID', 'synthetic-gis-key');
  vi.stubEnv('CONTEXT_GIS_SIGNING_PRIVATE_JWK', JSON.stringify(pair.privateKey.export({ format: 'jwk' })));
});
afterEach(() => vi.unstubAllEnvs());

describe('separately authorized GIS MCP write', () => {
  it('keeps the initial OAuth challenge limited to read access', async () => {
    const response = await handleMcpRequest(rpc('tools/list'), { authenticate: async () => { throw new HttpError(401, 'UNAUTHORIZED', 'Connect first.'); } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('knowledge:read');
    expect(response.headers.get('www-authenticate')).not.toContain('gis:write');
  });
  it('keeps existing read grants read-only and excludes creation from discovery', async () => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key() }));
    expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain('create_gis_poi');
    expect(result.tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)).toBe(true);
  });
  it.each(['claude', 'whatsapp'] as const)('advertises a distinct write contract on permitted %s connections', async platform => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(true), platform }));
    const tool = result.tools.find((item: { name: string }) => item.name === 'create_gis_poi');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tool._meta['wareongo/context-write-v1']).toMatchObject({ requiredScopes: ['gis:write'], idempotencyArgument: 'operation_id', auditHistory: 'actor_scoped' });
    expect(tool._meta['wareongo/context-read-v1']).toBeUndefined();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['operation_id', 'name', 'category', 'latitude', 'longitude']));
    expect(tool.inputSchema.properties).not.toHaveProperty('employeeId');
    expect(tool.inputSchema.properties).not.toHaveProperty('authorization');
  });
  it.each(['disabled', 'missing configuration', 'platform hidden'] as const)('does not publish a write when %s', async reason => {
    if (reason === 'disabled') vi.stubEnv('CONTEXT_GIS_WRITES_ENABLED', 'false');
    if (reason === 'missing configuration') vi.stubEnv('CONTEXT_GIS_SIGNING_PRIVATE_JWK', '');
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(true), platform: 'whatsapp',
      prompts: async () => reason === 'platform hidden' ? { toolPlatforms: { create_gis_poi: ['claude'] } } : {} }));
    expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain('create_gis_poi');
  });
  it('reports effective write capability truthfully while the context call stays a read', async () => {
    const registration = key(true);
    const read: McpDependencies['read'] = async () => Response.json({ data: { employee_id: 7, scopes: registration.scopes,
      read_only: true, knowledge_discovery: { permitted: true, status: 'not_checked', index_path: '/wiki', search_path: '/wiki/search' },
      server_clock: clockContext() }, meta: { requestId: 'synthetic-context', generatedAt: new Date().toISOString() } });
    const result = await wire(await handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => registration, read }));
    expect(result.result.structuredContent.data).toMatchObject({ read_only: false, write_capabilities: ['create_gis_poi', 'rollback_gis_poi'] });
    vi.stubEnv('CONTEXT_GIS_WRITES_ENABLED', 'false');
    const hidden = await wire(await handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => registration, read }));
    expect(hidden.result.structuredContent.data).toMatchObject({ read_only: true, write_capabilities: [] });
  });
  it('dispatches through the write adapter, never the read API, and retains uncertain outcomes', async () => {
    const write = vi.fn(async (..._args: Parameters<McpDependencies['gisWrite']>) => ({ operation_id: point.operation_id, outcome: 'outcome_unknown' as const,
      code: 'GIS_OUTCOME_UNKNOWN', message: 'Retry only the same operation_id and unchanged arguments.' }));
    const read = vi.fn();
    const result = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_gis_poi', arguments: point }),
      { authenticate: async () => key(true), gisWrite: write as McpDependencies['gisWrite'], read }));
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toEqual(point);
    expect(read).not.toHaveBeenCalled();
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent).toMatchObject({ operation_id: point.operation_id, outcome: 'outcome_unknown',
      meta: { toolName: 'create_gis_poi', argumentsSha256: argumentsSha256(point), employeeId: 7 } });
  });
  it('publishes guarded compensation metadata and binds its typed result without a read call', async () => {
    const registration=key(true);
    const {result:catalog}=await wire(await handleMcpRequest(rpc('tools/list'),{authenticate:async()=>registration}));
    const tool=catalog.tools.find((t:{name:string})=>t.name==='rollback_gis_poi');
    expect(tool.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true,idempotentHint:true});
    expect(tool._meta['wareongo/context-write-v1']).toMatchObject({effect:'compensate',auditHistory:'actor_scoped',compensates:'create_gis_poi',originalOperationArgument:'original_operation_id'});
    const args={operation_id:randomUUID(),original_operation_id:point.operation_id};
    const rollback=vi.fn(async()=>({operation_id:args.operation_id,outcome:'rolled_back' as const,code:'GIS_ROLLBACK_CONFIRMED',message:'The unchanged original point was removed.'}));
    const read=vi.fn();
    const value=await wire(await handleMcpRequest(rpc('tools/call',{name:'rollback_gis_poi',arguments:args}),{authenticate:async()=>registration,gisRollback:rollback,read}));
    expect(rollback).toHaveBeenCalledOnce();expect(read).not.toHaveBeenCalled();expect(value.result.isError).not.toBe(true);
    expect(value.result.structuredContent).toMatchObject({outcome:'rolled_back',meta:{toolName:'rollback_gis_poi',argumentsSha256:argumentsSha256(args),employeeId:7}});
  });
  it('rejects missing operation identity and model-supplied identity before dispatch', async () => {
    const write = vi.fn();
    for (const args of [{ ...point, operation_id: undefined }, { ...point, employeeId: 8 }, { ...point, latitude: null }]) {
      const result = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_gis_poi', arguments: args }),
        { authenticate: async () => key(true), gisWrite: write }));
      expect(result.error || result.result?.isError).toBeTruthy();
    }
    expect(write).not.toHaveBeenCalled();
  });
});
