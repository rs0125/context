/** Explicit deletion metadata, scope/platform gates and exact source binding. No provider mutations. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyRegistration } from '../src/lib/auth';
import { handleMcpRequest } from '../src/lib/mcp';
import { argumentsSha256, MCP_READ_CONTRACTS } from '../src/lib/mcp-read-contract';
import type { PromptValues } from '../src/lib/prompt-definitions';
vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
const origin = 'https://context.example.test';
const id = randomUUID(), note = randomUUID();
const names = ['delete_crm_rfq', 'delete_crm_note'] as const;
const scopes: KeyRegistration['scopes'] = ['crm:read', 'crm.rfq:write', 'crm.notes:write'];
function key(grants = scopes): KeyRegistration { return { id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7, employeeEmail: 'test@wareongo.com', scopes: grants, expiresAt: '2099-01-01T00:00:00Z' }; }
function rpc(method: string, params: object = {}) { return new Request(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); }
async function wire(response: Response) { const body = await response.text(); return response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(body); }
const input = (name: typeof names[number]) => ({ operation_id: randomUUID(), ...(name === 'delete_crm_rfq' ? { id } : { deal_id: id, note_id: note }), expected_updated_at: '2026-10-05T10:00:00.000Z', raw_text: 'Delete this record from CRM.' });
beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_CRM_DELETES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'true'); vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'true'); vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'true');
  vi.stubEnv('TWENTY_CRM_BASE_URL', 'https://crm.example.test'); vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', 'synthetic');
});
afterEach(() => vi.unstubAllEnvs());
describe('direct CRM trash tools', () => {
  it.each(['claude', 'whatsapp'] as const)('advertises both deletes with explicit source-bound direct policy on %s', async platform => {
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key(), platform }));
    for (const name of names) {
      const tool = result.tools.find((t: { name: string }) => t.name === name);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(tool._meta['wareongo/context-write-v1']).toEqual({ requiredScopes: ['crm:read', name === 'delete_crm_rfq' ? 'crm.rfq:write' : 'crm.notes:write'], sourceFamily: 'crm', effect: 'delete', executionMode: 'direct_request', sourceTextArgument: 'raw_text', idempotencyArgument: 'operation_id' });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['expected_updated_at', 'operation_id', 'raw_text']));
      expect(tool.inputSchema.properties).not.toHaveProperty('hard_delete');
      expect(MCP_READ_CONTRACTS).not.toHaveProperty(name);
    }
  });
  it.each(['disabled', 'read-only', 'write-without-read', 'platform', 'credential'] as const)('hides and rejects both tools when %s', async reason => {
    if (reason === 'disabled') vi.stubEnv('CONTEXT_CRM_DELETES_ENABLED', 'false');
    if (reason === 'credential') vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    const grants = reason === 'read-only' ? ['crm:read'] as const : reason === 'write-without-read' ? ['crm.rfq:write', 'crm.notes:write'] as const : scopes;
    const mutate = vi.fn();
    const overrides = { authenticate: async () => key([...grants]), platform: 'whatsapp' as const, prompts: async () => reason === 'platform' ? { toolPlatforms: { delete_crm_rfq: ['claude'], delete_crm_note: ['claude'] } } as PromptValues : {}, crmRfqDelete: mutate, crmNoteDelete: mutate };
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), overrides));
    for (const name of names) {
      expect(result.tools.some((t: { name: string }) => t.name === name)).toBe(false);
      const denied = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: input(name) }), overrides));
      expect(denied.error || denied.result?.isError).toBeTruthy();
    }
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each(names)('binds the %s deletion receipt to the exact request without calling the read router', async name => {
    const args = input(name), read = vi.fn();
    const mutate = vi.fn(async () => ({ operation_id: args.operation_id, outcome: 'deleted' as const, code: 'CRM_DELETED', message: 'Moved to CRM trash.' }));
    const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: args }), { authenticate: async () => key(), read, crmRfqDelete: mutate, crmNoteDelete: mutate }));
    expect(result.isError).not.toBe(true); expect(result.structuredContent.outcome).toBe('deleted');
    expect(result.structuredContent.meta).toEqual({ toolName: name, employeeId: 7, argumentsSha256: argumentsSha256(args) });
    expect(mutate).toHaveBeenCalledWith(args, expect.objectContaining({ employeeId: 7 }), expect.any(AbortSignal), expect.any(Function));
    expect(read).not.toHaveBeenCalled();
  });
  it.each(names)('does not accept arbitrary deletion authority or hide uncertainty for %s', async name => {
    const args = input(name), mutate = vi.fn(async () => ({ operation_id: args.operation_id, outcome: 'outcome_unknown' as const, code: 'CRM_OUTCOME_UNKNOWN', message: 'Recover the original operation.' }));
    const overrides = { authenticate: async () => key(), crmRfqDelete: mutate, crmNoteDelete: mutate };
    const uncertain = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: args }), overrides));
    expect(uncertain.result.isError).toBe(true); mutate.mockClear();
    for (const patch of [{ expected_updated_at: undefined }, { hard_delete: true }, { employeeId: 8 }, { stage: 'ANY' }]) {
      const rejected = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: { ...args, ...patch } }), overrides));
      expect(rejected.error || rejected.result?.isError).toBeTruthy();
    }
    expect(mutate).not.toHaveBeenCalled();
  });
});
