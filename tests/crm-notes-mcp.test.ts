/** Note MCP contracts and platform/scope gates; executors and provider I/O are mocked. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyRegistration } from '../src/lib/auth';
import { handleMcpRequest } from '../src/lib/mcp';
import { argumentsSha256, MCP_READ_CONTRACTS } from '../src/lib/mcp-read-contract';
import { clockContext } from '../src/lib/query-time';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
const origin = 'https://context.example.test';
const dealId = randomUUID(), noteId = randomUUID();
const args = { operation_id: randomUUID(), deal_id: dealId, raw_text: 'Add a site visit note to this deal.', title: 'Site visit', body: 'Visited the site.\n\n  Follow up Friday.' };
const names = ['create_crm_note', 'read_crm_note', 'list_crm_note_changes', 'update_crm_note', 'undo_crm_note'] as const;
const resultData = { id: noteId, deal: { id: dealId, name: 'Synthetic deal', url: `https://crm.wareongo.com/object/opportunity/${dealId}` }, note: { title: args.title, body: args.body }, undo_available: true };
function key(scopes: KeyRegistration['scopes'] = ['crm:read', 'crm.notes:write']): KeyRegistration { return { id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
  employeeEmail: 'synthetic@wareongo.com', scopes, expiresAt: '2099-01-01T00:00:00Z' }; }
function rpc(method: string, params: object = {}) { return new Request(`${origin}/mcp`, { method: 'POST', headers: {
  'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); }
async function wire(response: Response) { const body = await response.text(); return response.headers.get('content-type')?.includes('text/event-stream')
  ? JSON.parse(body.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(body); }
beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'false'); vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'false');
  vi.stubEnv('TWENTY_CRM_BASE_URL', 'https://crm.example.test'); vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', 'synthetic');
});
afterEach(() => vi.unstubAllEnvs());

describe('CRM note MCP integration', () => {
  it.each(['claude', 'whatsapp'] as const)('advertises separately granted note tools on %s without broader CRM rights', async platform => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(), platform }));
    const named = Object.fromEntries(result.tools.map((tool: { name: string }) => [tool.name, tool]));
    for (const name of names) expect(named).toHaveProperty(name);
    expect(named).not.toHaveProperty('create_crm_rfq');
    for (const name of ['create_crm_note', 'update_crm_note', 'undo_crm_note']) {
      expect(named[name]._meta['wareongo/context-write-v1']).toEqual({ executionMode: 'direct_request', requiredScopes: ['crm:read', 'crm.notes:write'], sourceFamily: 'crm', effect: name === 'create_crm_note' ? 'create' : 'update', idempotencyArgument: 'operation_id', sourceTextArgument: 'raw_text' });
      expect(named[name].inputSchema.additionalProperties).toBe(false);
      expect(named[name].inputSchema.properties).not.toHaveProperty('employeeId');
      expect(named[name].inputSchema.properties).not.toHaveProperty('stage');
      expect(named[name].annotations.destructiveHint).toBe(name === 'undo_crm_note');
      expect(MCP_READ_CONTRACTS).not.toHaveProperty(name);
    }
    for (const name of ['read_crm_note', 'list_crm_note_changes']) expect(named[name]._meta['wareongo/context-read-v1']).toEqual({ requiredScopes: ['crm:read', 'crm.notes:write'], sourceFamily: 'crm' });
  });
  it.each(['missing read scope', 'missing note scope', 'disabled', 'missing credential', 'platform'])('hides and rejects note tools with %s', async reason => {
    if (reason === 'disabled') vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'false');
    if (reason === 'missing credential') vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    const k = key(reason === 'missing read scope' ? ['crm.notes:write'] : reason === 'missing note scope' ? ['crm:read', 'crm.rfq:write'] : undefined);
    const read = vi.fn(), mutate = vi.fn();
    const deps = { authenticate: async () => k, platform: 'whatsapp' as const, read, crmNoteCreate: mutate,
      prompts: async () => reason === 'platform' ? { toolPlatforms: Object.fromEntries(names.map(name => [name, ['claude']])) } : {} };
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), deps));
    for (const name of names) expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain(name);
    for (const [name, input] of [['create_crm_note', args], ['read_crm_note', { deal_id: dealId, note_id: noteId }]] as const) {
      const denied = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input }), deps));
      expect(denied.error || denied.result?.isError).toBeTruthy();
    }
    expect(mutate).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it('narrows reported capabilities when either current note grant disappears', async () => {
    const k = key(); let scopes = k.scopes;
    const read = async () => Response.json({ data: { employee_id: 7, scopes, read_only: true, server_clock: clockContext(),
      knowledge_discovery: { permitted: false, status: 'not_permitted', index_path: '/wiki', search_path: '/wiki/search' } }, meta: { requestId: 'note-context', generatedAt: new Date().toISOString() } });
    const current = async () => (await wire(await handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => k, read }))).result.structuredContent.data;
    expect(await current()).toMatchObject({ read_only: false, write_capabilities: ['create_crm_note', 'update_crm_note', 'undo_crm_note'] });
    for (const reduced of [['crm:read'], ['crm.notes:write']] as const) {
      scopes = [...reduced]; expect(await current()).toMatchObject({ read_only: true, write_capabilities: [] });
    }
  });
  it('maps exact deal-scoped read arguments to real REST routes and binds results', async () => {
    const read = vi.fn(async (_request: Request, path: string[]) => Response.json({ data: path[3] === 'notes'
      ? { ...resultData, updated_at: '2026-10-05T10:00:00.000Z', editable: true, latest_operation_id: args.operation_id, guidance: 'Your current note.' }
      : { deal: resultData.deal, items: [], scanned: 0, guidance: 'Your recent note changes.' }, meta: { requestId: 'notes-read', generatedAt: new Date().toISOString() } }));
    for (const [name, input, path] of [
      ['read_crm_note', { deal_id: dealId, note_id: noteId }, ['crm', 'deals', dealId, 'notes', noteId]],
      ['list_crm_note_changes', { deal_id: dealId, limit: 3 }, ['crm', 'deals', dealId, 'note-changes']],
    ] as const) {
      const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input }), { authenticate: async () => key(), read }));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.meta).toMatchObject({ toolName: name, argumentsSha256: argumentsSha256(input) });
      expect(read).toHaveBeenLastCalledWith(expect.any(Request), path, expect.any(Object));
      const request = read.mock.calls.at(-1)![0] as unknown as Request;
      expect(new URL(request.url).searchParams.toString()).toBe(name === 'list_crm_note_changes' ? 'limit=3' : '');
    }
  });
  it.each(['create_crm_note', 'update_crm_note', 'undo_crm_note'] as const)('binds %s results to exact source arguments and employee', async name => {
    const common = { operation_id: args.operation_id, deal_id: dealId, raw_text: args.raw_text };
    const input = name === 'create_crm_note' ? args : name === 'update_crm_note'
      ? { ...common, note_id: noteId, expected_updated_at: '2026-10-05T10:00:00.000Z', body: args.body }
      : { ...common, original_operation_id: randomUUID() };
    const outcome = name === 'create_crm_note' ? 'created' : name === 'update_crm_note' ? 'updated' : 'rolled_back';
    const mutate = vi.fn(async () => ({ operation_id: args.operation_id, outcome: outcome as 'created' | 'updated' | 'rolled_back', code: 'OK', message: 'Completed.', data: resultData }));
    const read = vi.fn();
    const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input }), { authenticate: async () => key(), read, crmNoteCreate: mutate, crmNoteUpdate: mutate, crmNoteUndo: mutate }));
    expect(result.isError).not.toBe(true); expect(read).not.toHaveBeenCalled();
    expect(result.structuredContent.data).toEqual(resultData);
    expect(result.structuredContent.meta).toEqual({ toolName: name, argumentsSha256: argumentsSha256(input), employeeId: 7 });
    expect(mutate).toHaveBeenCalledWith(input, expect.objectContaining({ employeeId: 7 }), expect.any(AbortSignal), expect.any(Function));
  });
  it('reports uncertainty as an error and rejects arbitrary authority or unsupported note fields', async () => {
    const mutate = vi.fn(async () => ({ operation_id: args.operation_id, outcome: 'outcome_unknown' as const, code: 'CRM_OUTCOME_UNKNOWN', message: 'Recover this operation.' }));
    const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_crm_note', arguments: args }), { authenticate: async () => key(), crmNoteCreate: mutate }));
    expect(result.isError).toBe(true); mutate.mockClear();
    for (const input of [{ ...args, deal_id: undefined }, { ...args, title: '' }, { ...args, body: 'x'.repeat(2001) }, { ...args, employeeId: 8 }, { ...args, stage: 'DEAL_CLOSED' }]) {
      const denied = await wire(await handleMcpRequest(rpc('tools/call', { name: 'create_crm_note', arguments: input }), { authenticate: async () => key(), crmNoteCreate: mutate }));
      expect(denied.error || denied.result?.isError).toBeTruthy();
    }
    expect(mutate).not.toHaveBeenCalled();
  });
});
