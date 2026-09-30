import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, createConsoleSession } from '../src/lib/console-auth';
import { handleConsolePromptsRequest } from '../src/lib/console-prompts';
import { HttpError } from '../src/lib/errors';
import { MCP_INSTRUCTIONS, PROMPT_DEFINITIONS, REST_PROMPT_TEMPLATE, promptText, renderRestPrompt, type PromptValues } from '../src/lib/prompt-definitions';
import { readPrompts, savePrompt } from '../src/lib/prompts';
import { handleMcpRequest } from '../src/lib/mcp';

const origin = 'https://context.example.test';
const identity = { employeeId: 7, email: 'admin@wareongo.com', name: 'Admin', isAdmin: true, isAnalyst: true, scopes: ['knowledge:read'] as const };
type Row = { id: string; body: string | null; revision: string; updatedAt: string; updatedBy: string };
const row = (id = 'mcp', body: string | null = 'Custom instructions.'): Row => ({ id, body, revision: randomUUID(), updatedAt: '2026-09-30T12:00:00Z', updatedBy: identity.email });

function setup(initial: Row[] = [], ready = true) {
  const records = new Map(initial.map(record => [record.id, record]));
  const query = vi.fn(async (sql: string, args: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes('to_regclass')) return { rows: [{ relation: ready ? 'context_prompts_private.prompt_overrides' : null }] };
    if (sql.startsWith('SELECT')) return { rows: [...records.values()] };
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
      const [id, body, revision, updatedBy, expected] = args as [string, string | null, string, string, string | undefined];
      const previous = records.get(id);
      if (sql.startsWith('INSERT') ? previous !== undefined : previous?.revision !== expected) return { rows: [] };
      const saved = { id, body, revision, updatedBy, updatedAt: '2026-09-30T13:00:00Z' };
      records.set(id, saved); return { rows: [saved] };
    }
    throw new Error('Unexpected SQL');
  });
  const client = { query } as unknown as PoolClient;
  const readTransaction = vi.fn();
  const writeTransaction = vi.fn();
  const identify = vi.fn(async () => ({ ...identity, scopes: [...identity.scopes] }));
  const session = vi.fn();
  const deps = {
    readTransaction: async <T,>(work: (client: PoolClient) => Promise<T>) => { readTransaction(); return work(client); },
    writeTransaction: async <T,>(work: (client: PoolClient) => Promise<T>) => { writeTransaction(); return work(client); },
    identity: identify, session,
  };
  return { client, query, records, deps, readTransaction, writeTransaction };
}
function request(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/console/prompts`, { method, headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => { vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());

describe('persistent prompt editing', () => {
  it('returns all defaults before migration without querying missing storage', async () => {
    const { client, query } = setup([], false);
    const result = await readPrompts(client);
    expect(result.storageReady).toBe(false);
    expect(result.prompts).toHaveLength(20);
    expect(result.prompts.every(prompt => prompt.body === prompt.defaultBody && prompt.revision === null && !prompt.customized)).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });
  it('preserves unrelated defaults and surfaces saved metadata', async () => {
    const custom = row('tool.search_warehouses');
    const { client } = setup([custom]);
    const { prompts } = await readPrompts(client);
    expect(prompts.find(prompt => prompt.id === custom.id)).toMatchObject({ ...custom, customized: true });
    expect(prompts.find(prompt => prompt.id === 'mcp')?.body).toBe(MCP_INSTRUCTIONS);
  });
  it('saves one prompt, rejects stale writes, and retains revisions after restoring defaults', async () => {
    const { client, records } = setup();
    const first = await savePrompt(client, { id: 'mcp', body: 'First version', revision: null }, identity.email);
    expect(first.prompt.body).toBe('First version');
    await expect(savePrompt(client, { id: 'mcp', body: 'Stale first save', revision: null }, identity.email)).rejects.toMatchObject({ status: 409 });
    const reset = await savePrompt(client, { id: 'mcp', body: null, revision: first.prompt.revision }, identity.email);
    expect(reset.prompt).toMatchObject({ customized: false, body: MCP_INSTRUCTIONS });
    expect(reset.prompt.revision).not.toBe(first.prompt.revision);
    await expect(savePrompt(client, { id: 'mcp', body: 'Stale edit', revision: first.prompt.revision }, identity.email)).rejects.toMatchObject({ status: 409 });
    expect(records.get('mcp')?.body).toBeNull();
    expect(records.size).toBe(1);
  });
  it.each([
    { id: 'unknown', body: 'text', revision: null }, { id: 'mcp', body: '', revision: null },
    { id: 'mcp', body: ' \n\t', revision: null }, { id: 'mcp', body: 'a\0b', revision: null },
    { id: 'mcp', body: 'a'.repeat(20001), revision: null }, { id: 'tool.get_context', body: 'a'.repeat(8001), revision: null },
    { id: 'mcp', body: 'text' }, { id: 'mcp', body: 'text', revision: 'bad' },
    { id: 'mcp', body: 'text', revision: null, updatedBy: 'someone@wareongo.com' },
  ])('rejects invalid input before touching storage (%#)', async input => {
    const { client, query } = setup();
    await expect(savePrompt(client, input, identity.email)).rejects.toMatchObject({ status: 422 });
    expect(query).not.toHaveBeenCalled();
  });
  it('reports missing storage for writes and does not hide storage failures on reads', async () => {
    const { client, query } = setup([], false);
    await expect(savePrompt(client, { id: 'mcp', body: 'Custom', revision: null }, identity.email)).rejects.toMatchObject({ code: 'PROMPTS_SETUP_REQUIRED' });
    query.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(readPrompts(client)).rejects.toThrow('Database unavailable');
    expect(query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
  it('renders every REST address placeholder without interpreting template text', () => {
    expect(renderRestPrompt(`${origin}/api/v1/`, '{{apiBaseUrl}}/context {{apiBaseUrl}}/openapi.json ${secret}')).toBe(`${origin}/api/v1/context ${origin}/api/v1/openapi.json ${'${secret}'}`);
    expect(renderRestPrompt(`${origin}/api/v1`)).not.toContain('{{apiBaseUrl}}');
    expect(REST_PROMPT_TEMPLATE).toContain('{{apiBaseUrl}}');
    expect(new Set(PROMPT_DEFINITIONS.map(prompt => prompt.id)).size).toBe(20);
  });
});

describe('browser prompt authorization', () => {
  it('rejects missing sessions before database work', async () => {
    const { deps, readTransaction } = setup();
    deps.session.mockImplementation(() => { throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in.'); });
    expect((await handleConsolePromptsRequest(request(), deps)).status).toBe(401);
    expect(readTransaction).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT'])('rejects non-admin %s before reading prompt storage', async method => {
    const { deps, query } = setup();
    deps.identity.mockResolvedValue({ ...identity, scopes: [...identity.scopes], isAdmin: false });
    expect((await handleConsolePromptsRequest(request(method, method === 'PUT' ? { id: 'mcp', body: 'Custom', revision: null } : undefined), deps)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('uses real session and current roster admin status on every read and write', async () => {
    vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
    const test = setup();
    const roster = { id: identity.employeeId, email: identity.email, name: identity.name, is_active: true, adminAccess: true, dashboardAccess: true, twenty_user_id: null };
    const originalQuery = test.query.getMockImplementation()!;
    test.query.mockImplementation(async (sql, args) => sql.includes('VerifiedNumber') ? { rows: [roster] } : originalQuery(sql, args));
    const cookie = consoleCookie('session', createConsoleSession({ ...identity, scopes: [...identity.scopes] }, 'google:synthetic-admin'), 3600).split(';')[0];
    const deps = { readTransaction: test.deps.readTransaction, writeTransaction: test.deps.writeTransaction };
    const good = await handleConsolePromptsRequest(request('PUT', { id: 'mcp', body: 'Custom', revision: null }, { cookie }), deps);
    expect(good.status).toBe(200);
    roster.adminAccess = false;
    test.query.mockClear();
    expect((await handleConsolePromptsRequest(request('GET', undefined, { cookie }), deps)).status).toBe(403);
    expect((await handleConsolePromptsRequest(request('PUT', { id: 'mcp', body: 'Another', revision: (await good.json()).prompt.revision }, { cookie }), deps)).status).toBe(403);
    expect(test.query.mock.calls.every(([sql]) => sql.includes('VerifiedNumber'))).toBe(true);
  });
  it('requires console origin and write enablement', async () => {
    const { deps, query, writeTransaction } = setup();
    const input = { id: 'mcp', body: 'Custom', revision: null };
    expect((await handleConsolePromptsRequest(request('PUT', input, { origin: 'https://evil.example' }), deps)).status).toBe(403);
    expect(writeTransaction).not.toHaveBeenCalled();
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
    const disabled = await handleConsolePromptsRequest(request('PUT', input), deps);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: { code: 'CONSOLE_SETUP_REQUIRED' } });
    expect(query).not.toHaveBeenCalled();
  });
  it('bounds requests and returns safe errors without database diagnostics', async () => {
    const { deps, query } = setup();
    expect((await handleConsolePromptsRequest(request('PUT', { body: 'a'.repeat(128001) }), deps)).status).toBe(413);
    expect((await handleConsolePromptsRequest(request('PUT', {}, { 'content-type': 'text/plain' }), deps)).status).toBe(415);
    expect(query).not.toHaveBeenCalled();
    query.mockRejectedValueOnce(new Error('private connection details'));
    const response = await handleConsolePromptsRequest(request(), deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private connection');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('MCP uses the saved prompt configuration', () => {
  const key = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: identity.email, scopes: ['knowledge:read'] as const, expiresAt: '2099-01-01T00:00:00Z' };
  async function rpc(method: string, prompts: PromptValues, params: unknown = {}) {
    const response = await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), { authenticate: async () => ({ ...key, scopes: [...key.scopes] }), prompts: async () => prompts });
    expect(response.status).toBe(200);
    const body = await response.text();
    return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5) : body);
  }
  it('sends edited main and analytics instructions on initialization', async () => {
    const { result } = await rpc('initialize', { mcp: 'Workspace instructions.', analytics: 'Analytics instructions.' },
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prompt-test', version: '1.0' } });
    expect(result.instructions).toBe('Workspace instructions. Analytics instructions.');
  });
  it('refreshes edited tool descriptions and keeps scopes, schemas and read-only annotations', async () => {
    const { result } = await rpc('tools/list', { 'tool.search_knowledge': 'Updated guidance search.', 'tool.ga4_report': 'Hidden analytics.' });
    const search = result.tools.find((tool: { name: string }) => tool.name === 'search_knowledge');
    expect(search.description).toBe('Updated guidance search.');
    expect(search.inputSchema.properties.q.maxLength).toBe(120);
    expect(search.annotations.readOnlyHint).toBe(true);
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_context', 'search_knowledge', 'read_knowledge']);
    const next = await rpc('tools/list', {});
    expect(next.result.tools.find((tool: { name: string }) => tool.name === 'search_knowledge').description).toBe(promptText('tool.search_knowledge'));
  });
});
