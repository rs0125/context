import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyRegistration } from '../src/lib/auth';
import { READ_SCOPES, SCOPES, rosterReadScopes, rosterScopes } from '../src/lib/auth';
import { handleMcpRequest } from '../src/lib/mcp';
import { argumentsSha256, MCP_READ_CONTRACTS } from '../src/lib/mcp-read-contract';
import { clockContext } from '../src/lib/query-time';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
const origin = 'https://context.example.test';
const args = { operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', raw_text: '5000 sqft in Hoskote', location: 'Hoskote', requirement: '5000 sqft' };
function key(write = true): KeyRegistration { return { id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
  employeeEmail: 'synthetic@wareongo.com', scopes: write ? ['knowledge:read', 'crm.rfq:write'] : ['crm:read'], expiresAt: '2099-01-01T00:00:00Z' }; }
function rpc(method: string, params: object = {}) { return new Request(`${origin}/mcp`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); }
async function wire(response: Response) { const body = await response.text(); return response.headers.get('content-type')?.includes('text/event-stream')
  ? JSON.parse(body.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(body); }
beforeEach(() => {
  vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'false');
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'true');
  vi.stubEnv('TWENTY_CRM_BASE_URL', 'https://crm.example.test'); vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', 'synthetic');
});
afterEach(() => vi.unstubAllEnvs());
describe('RFQ-only scope and MCP contract', () => {
  it('adds supported syntax without granting reads, general CRM writes, or default writes', () => {
    expect(SCOPES).toContain('crm.rfq:write'); expect(SCOPES).not.toContain('crm:write'); expect(READ_SCOPES).not.toContain('crm.rfq:write');
    const row = { dashboardAccess: true, adminAccess: true, analystAccess: true, twenty_user_id: null };
    expect(rosterScopes(row)).not.toContain('crm.rfq:write');
    expect(rosterReadScopes({ ...row, twenty_user_id: args.operation_id })).not.toContain('crm.rfq:write');
    expect(rosterScopes({ ...row, twenty_user_id: args.operation_id })).toContain('crm.rfq:write');
    expect(MCP_READ_CONTRACTS).not.toHaveProperty('create_crm_rfq');
  });
  it.each(['claude', 'whatsapp'] as const)('advertises only the create contract for %s with no audit disclosure or reversal', async platform => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(), platform }));
    const writes = result.tools.filter((t: { annotations: { readOnlyHint: boolean } }) => !t.annotations.readOnlyHint);
    expect(writes.map((t: { name: string }) => t.name)).toEqual(['create_crm_rfq']);
    expect(writes[0]._meta['wareongo/context-write-v1']).toEqual({ executionMode: 'direct_request', requiredScopes: ['crm.rfq:write'], sourceFamily: 'crm', effect: 'create', idempotencyArgument: 'operation_id', sourceTextArgument: 'raw_text' });
    expect(writes[0].inputSchema.additionalProperties).toBe(false);
    expect(writes[0].inputSchema.properties).not.toHaveProperty('stage');
  });
  it.each(['read scope', 'disabled', 'no key', 'hidden platform'])('hides creation for %s', async reason => {
    if (reason === 'disabled') vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'false');
    if (reason === 'no key') vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(reason !== 'read scope'), platform: 'whatsapp',
      prompts: async () => reason === 'hidden platform' ? { toolPlatforms: { create_crm_rfq: ['claude'] } } : {} }));
    expect(result.tools.map((t: { name: string }) => t.name)).not.toContain('create_crm_rfq');
  });
  it('reports actual RFQ capability with current scope narrowing', async () => {
    const k = key(); let scopes = k.scopes;
    const read = async () => Response.json({ data: { employee_id: 7, scopes, read_only: true, server_clock: clockContext(),
      knowledge_discovery: { permitted: true, status: 'not_checked', index_path: '/wiki', search_path: '/wiki/search' } }, meta: { requestId: 'synthetic-context', generatedAt: new Date().toISOString() } });
    const request = () => handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => k, read });
    expect((await wire(await request())).result.structuredContent.data).toMatchObject({ read_only: false, write_capabilities: ['create_crm_rfq'] });
    scopes = ['knowledge:read'];
    expect((await wire(await request())).result.structuredContent.data).toMatchObject({ read_only: true, write_capabilities: [] });
  });
  it('binds the result to employee and exact arguments without invoking the read API', async () => {
    const crmRfq = vi.fn(async () => ({ operation_id: args.operation_id, outcome: 'outcome_unknown' as const, code: 'CRM_OUTCOME_UNKNOWN', message: 'Recover the same operation.' }));
    const read = vi.fn();
    const response = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_crm_rfq', arguments: args }), { authenticate: async () => key(), crmRfq, read }));
    expect(crmRfq).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    expect(response.result.structuredContent).toMatchObject({ outcome: 'outcome_unknown', meta: { toolName: 'create_crm_rfq', argumentsSha256: argumentsSha256(args), employeeId: 7 } });
  });
  it('rejects missing critical fields, arbitrary write arguments and hidden tool calls', async () => {
    const crmRfq = vi.fn();
    for (const input of [{ ...args, operation_id: undefined }, { ...args, location: undefined }, { ...args, stage: 'DEAL_CLOSED' }, { ...args, employeeId: 8 }, { ...args, action: 'update' }]) {
      const response = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_crm_rfq', arguments: input }), { authenticate: async () => key(), crmRfq }));
      expect(response.error || response.result?.isError).toBeTruthy();
    }
    const response = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_crm_rfq', arguments: args }), { authenticate: async () => key(false), crmRfq }));
    expect(response.error || response.result?.isError).toBeTruthy(); expect(crmRfq).not.toHaveBeenCalled();
  });
});

describe('owned RFQ edit and undo MCP integration', () => {
  beforeEach(() => vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'true'));
  it.each(['claude', 'whatsapp'] as const)('advertises narrow reads/update/undo on %s without generic journal access', async platform => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(), platform }));
    const named = Object.fromEntries(result.tools.map((tool: { name: string }) => [tool.name, tool]));
    for (const name of ['read_crm_rfq', 'list_crm_rfq_changes', 'update_crm_rfq', 'undo_crm_rfq']) expect(named).toHaveProperty(name);
    // Execution policy is explicit; even the destructive undo hint must not reintroduce a confirmation loop.
    for (const name of ['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq'])
      expect(named[name]._meta['wareongo/context-write-v1'].executionMode).toBe('direct_request');
    for (const name of ['update_crm_rfq', 'undo_crm_rfq']) {
      expect(named[name]._meta['wareongo/context-write-v1']).toEqual({ executionMode: 'direct_request', requiredScopes: ['crm.rfq:write'], sourceFamily: 'crm', effect: 'update', idempotencyArgument: 'operation_id', sourceTextArgument: 'raw_text' });
      expect(named[name].inputSchema.additionalProperties).toBe(false);
    }
    expect(named.undo_crm_rfq.annotations.destructiveHint).toBe(true);
    expect(named.read_crm_rfq._meta['wareongo/context-read-v1']).toEqual({ requiredScopes: ['crm.rfq:write'], sourceFamily: 'crm' });
    expect(named.update_crm_rfq.inputSchema.properties.changes.properties).not.toHaveProperty('stage');
    expect(named.update_crm_rfq.inputSchema.properties.changes.properties).not.toHaveProperty('ownerId');
  });
  it.each(['read-only scope', 'disabled edits', 'disabled creation', 'missing writer', 'platform'])('hides all edit capabilities for %s', async reason => {
    if (reason === 'disabled edits') vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'false');
    if (reason === 'disabled creation') vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'false');
    if (reason === 'missing writer') vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    const tools = ['read_crm_rfq', 'list_crm_rfq_changes', 'update_crm_rfq', 'undo_crm_rfq'] as const;
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), {
      authenticate: async () => key(reason !== 'read-only scope'), platform: 'whatsapp',
      prompts: async () => reason === 'platform' ? { toolPlatforms: Object.fromEntries(tools.map(name => [name, ['claude']])) } : {},
    }));
    for (const name of tools) expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain(name);
  });
  it('rejects stale direct RFQ write/read calls when the tool is excluded from a platform', async () => {
    const mutate = vi.fn(), read = vi.fn();
    const prompts = async () => ({ toolPlatforms: { update_crm_rfq: ['whatsapp' as const], read_crm_rfq: ['whatsapp' as const] } });
    const input = { operation_id: args.operation_id, id: randomUUID(), expected_updated_at: '2026-10-04T10:00:00.000Z', raw_text: 'Change the budget to 22 per sqft per month', changes: { budget: '22/sqft/month' } };
    for (const [name, parameters] of [['update_crm_rfq', input], ['read_crm_rfq', { id: input.id }]] as const) {
      const denied = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: parameters }), { authenticate: async () => key(), platform: 'claude', prompts, crmRfqUpdate: mutate, read }));
      expect(denied.error || denied.result?.isError).toBeTruthy();
    }
    expect(mutate).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(), platform: 'whatsapp', prompts }));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['read_crm_rfq', 'update_crm_rfq']));
  });
  it('routes RFQ reads through the authorized REST boundary with argument binding', async () => {
    const id = randomUUID();
    const read = vi.fn(async (_request: Request, path: string[]) => Response.json({ data: path[1] === 'rfqs' ? { id, editable: true } : { items: [] }, meta: { requestId: 'owned-rfq', generatedAt: new Date().toISOString() } }));
    for (const [name, input, expected] of [
      ['read_crm_rfq', { id }, ['crm', 'rfqs', id]],
      ['list_crm_rfq_changes', { limit: 3 }, ['crm', 'rfq-changes']],
    ] as const) {
      const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input }), { authenticate: async () => key(), read }));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.meta).toMatchObject({ toolName: name, argumentsSha256: argumentsSha256(input) });
      expect(read.mock.calls.at(-1)![1]).toEqual(expected);
    }
  });
  it.each(['update_crm_rfq', 'undo_crm_rfq'] as const)('binds %s success to exact arguments and employee', async name => {
    const input = name === 'update_crm_rfq'
      ? { operation_id: args.operation_id, id: randomUUID(), expected_updated_at: '2026-10-04T10:00:00.000Z', raw_text: 'Change the budget to 22 rupees per sqft per month', changes: { budget: 'INR22/sqft/month' } }
      : { operation_id: args.operation_id, original_operation_id: randomUUID(), raw_text: 'Undo that change' };
    const mutate = vi.fn(async () => ({ operation_id: input.operation_id, outcome: name === 'update_crm_rfq' ? 'updated' as const : 'rolled_back' as const, code: 'OK', message: 'Completed.' }));
    const read = vi.fn();
    const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input }), { authenticate: async () => key(), read, crmRfqUpdate: mutate, crmRfqUndo: mutate }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.meta).toEqual({ toolName: name, argumentsSha256: argumentsSha256(input), employeeId: 7 });
    expect(mutate).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  });
  it('rejects unadvertised calls and arbitrary update fields before dispatch', async () => {
    const mutate = vi.fn();
    const input = { operation_id: args.operation_id, id: randomUUID(), expected_updated_at: '2026-10-04T10:00:00.000Z', raw_text: 'Mark it won', changes: { stage: 'DEAL_CLOSED' } };
    const response = await wire(await handleMcpRequest(rpc('tools/call', { name: 'update_crm_rfq', arguments: input }), { authenticate: async () => key(), crmRfqUpdate: mutate }));
    expect(response.error || response.result?.isError).toBeTruthy();
    vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'false');
    const denied = await wire(await handleMcpRequest(rpc('tools/call', { name: 'undo_crm_rfq', arguments: { operation_id: args.operation_id, original_operation_id: randomUUID(), raw_text: 'undo' } }), { authenticate: async () => key(), crmRfqUndo: mutate }));
    expect(denied.error || denied.result?.isError).toBeTruthy(); expect(mutate).not.toHaveBeenCalled();
  });
});
