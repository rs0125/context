/** Real MCP envelopes with synthetic Gmail services. Never creates or sends real mail. */
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyRegistration } from '../src/lib/auth';
import { handleMcpRequest, type McpDependencies } from '../src/lib/mcp';
import { handleRameshMcpRequest } from '../src/lib/ramesh-mcp';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';
import { clockContext } from '../src/lib/query-time';
import { executeEmailDraft } from '../src/lib/gmail-tools';
import { handleApiRequest } from '../src/lib/api';
import { HttpError } from '../src/lib/errors';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
vi.mock('../src/lib/gmail-oauth', () => ({
  gmailAvailability: (env = process.env) => ({ available: env.CONTEXT_GMAIL_ENABLED === 'true' && env.GMAIL_TEST_CONFIGURED === 'true' }),
  refreshGmailAccessToken: vi.fn(() => { throw new Error('No real Gmail token access in MCP tests'); }),
}));
vi.mock('../src/lib/gmail-tools', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/gmail-tools')>(),
  executeEmailDraft: vi.fn(),
}));

const origin = 'https://context.example.test';
const names = ['get_email_connection', 'create_email_draft', 'read_email_draft', 'list_email_drafts'];
const input = { operation_id: randomUUID(), connection_id: randomUUID(), connection_version: 2,
  to: ['recipient@example.com'], subject: 'Warehouse options', body: 'Here are the options.' };
const key = (mail = true): KeyRegistration => ({ id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
  employeeEmail: 'employee@wareongo.com', scopes: mail ? ['mail:drafts'] : ['knowledge:read'], expiresAt: '2099-01-01T00:00:00Z' });
const saved = () => ({ operation_id: input.operation_id, outcome: 'created' as const, code: 'GMAIL_DRAFT_SAVED',
  message: 'Draft saved, not sent.', data: { draft_ref: input.operation_id, mailbox: 'employee@wareongo.com',
    subject: 'Warehouse options', status: 'draft' as const, provider: 'gmail' as const } });
function rpc(method: string, params: object = {}, endpoint = `${origin}/mcp`) {
  return new Request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function wire(response: Response) {
  const text = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(text);
}
const call = async (method: string, params: object = {}, overrides: Partial<McpDependencies> = {}) => wire(await handleMcpRequest(rpc(method, params), {
  authenticate: async () => key(), platform: 'whatsapp', ...overrides,
}));

beforeEach(() => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'true');
  vi.stubEnv('GMAIL_TEST_CONFIGURED', 'true');
  vi.stubEnv('CONTEXT_GIS_WRITES_ENABLED', 'false');
  vi.mocked(executeEmailDraft).mockReset().mockResolvedValue(saved());
});
afterEach(() => vi.unstubAllEnvs());

describe('WhatsApp Gmail draft MCP boundary', () => {
  it.each(['disabled', 'unconfigured', 'missing_scope', 'claude'] as const)('hides all mail tools and rejects direct creation when %s', async condition => {
    if (condition === 'disabled') vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'false');
    if (condition === 'unconfigured') vi.stubEnv('GMAIL_TEST_CONFIGURED', 'false');
    const deps: Partial<McpDependencies> = { authenticate: async () => key(condition !== 'missing_scope'),
      platform: condition === 'claude' ? 'claude' : 'whatsapp' };
    const listed = (await call('tools/list', {}, deps)).result.tools.map((tool: { name: string }) => tool.name);
    for (const name of names) expect(listed).not.toContain(name);
    const result = await call('tools/call', { name: 'create_email_draft', arguments: input }, deps);
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(executeEmailDraft).not.toHaveBeenCalled();
  });

  it('advertises scoped mail reads and a separate creation contract without history or sending authority', async () => {
    const tools = (await call('tools/list')).result.tools;
    expect(tools.filter((tool: { name: string }) => names.includes(tool.name))).toHaveLength(4);
    expect(tools.map((tool: { name: string }) => tool.name)).not.toContain('send_email');
    const create = tools.find((tool: { name: string }) => tool.name === 'create_email_draft');
    expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(create._meta['wareongo/context-write-v1']).toEqual({ requiredScopes: ['mail:drafts'], sourceFamily: 'mail', effect: 'create', idempotencyArgument: 'operation_id' });
    expect(create._meta).not.toHaveProperty('wareongo/context-read-v1');
    expect(create.inputSchema.additionalProperties).toBe(false);
    expect(create.inputSchema.properties).not.toHaveProperty('from');
    for (const name of ['get_email_connection', 'read_email_draft', 'list_email_drafts']) {
      const read = tools.find((tool: { name: string }) => tool.name === name);
      expect(read.annotations.readOnlyHint).toBe(true);
      expect(read._meta['wareongo/context-read-v1']).toEqual({ requiredScopes: ['mail:drafts'], sourceFamily: 'mail' });
    }
  });

  it('reloads the draft-list tool permission and platform selection on each request', async () => {
    expect((await call('tools/list')).result.tools.map((tool: {name: string}) => tool.name)).toContain('list_email_drafts');
    for (const denied of [{authenticate: async () => key(false)}, {prompts: async () => ({toolPlatforms: {list_email_drafts: []}})}]) {
      const read = vi.fn();
      expect((await call('tools/list', {}, denied)).result.tools.map((tool: {name: string}) => tool.name)).not.toContain('list_email_drafts');
      const result = await call('tools/call', {name: 'list_email_drafts', arguments: {}}, {...denied, read});
      expect(result.error ?? result.result?.isError).toBeTruthy();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('carries list pagination in a read envelope and binds it to the original authenticated request', async () => {
    const employee = key(), revalidateKey = vi.fn(async () => {});
    const cursor = randomUUID(), args = {limit: 2, cursor};
    const data = {items: [{draft_ref: input.operation_id, created_at: '2026-10-04T09:00:00.000Z'}], nextCursor: input.operation_id,
      current_status_verified: false, guidance: 'Use read_email_draft for current content.'};
    const read = vi.fn(async () => Response.json({data, meta: {requestId: 'synthetic-list', generatedAt: new Date().toISOString(), toolName: 'forged', argumentsSha256: '0'.repeat(64)}}));
    const result = (await call('tools/call', {name: 'list_email_drafts', arguments: args}, {read, authenticate: async () => employee, revalidateKey})).result;
    expect(result.isError).not.toBe(true);
    const [request, path, deps] = read.mock.calls[0] as unknown as [Request, string[], {authenticate: () => unknown; revalidateKey: unknown}];
    expect(path).toEqual(['mail', 'drafts']);
    expect(new URL(request.url).searchParams.get('limit')).toBe('2');
    expect(new URL(request.url).searchParams.get('cursor')).toBe(cursor);
    expect(deps.authenticate()).toBe(employee);
    expect(deps.revalidateKey).toBe(revalidateKey);
    expect(result.structuredContent).toMatchObject({source_path: '/api/v1/mail/drafts?limit=2', status: 200, data,
      meta: {toolName: 'list_email_drafts', argumentsSha256: argumentsSha256(args)}});
    expect(executeEmailDraft).not.toHaveBeenCalled();
  });

  it.each([{employeeId: 8}, {mailbox: 'other@example.com'}, {connection_id: randomUUID()}, {cursor: 'not-a-uuid'}, {limit: 21}])('rejects an invalid list invocation %j before the read boundary', async args => {
    const read = vi.fn();
    const result = await call('tools/call', {name: 'list_email_drafts', arguments: args}, {read});
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['from', 'send', 'attachments', 'bcc', 'html', 'employeeId'] as const)('rejects unsupported creation field %s before dispatch', async name => {
    const result = await call('tools/call', { name: 'create_email_draft', arguments: { ...input, [name]: 'not allowed' } });
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(executeEmailDraft).not.toHaveBeenCalled();
  });

  it('binds success to the original wire arguments and authenticated employee after defaults and trimming', async () => {
    const employee = key();
    const args = { ...input, subject: '  Warehouse options  ', to: undefined };
    const wireArgs = JSON.parse(JSON.stringify(args));
    const revalidateKey = vi.fn(async () => {});
    const result = (await call('tools/call', { name: 'create_email_draft', arguments: wireArgs }, { authenticate: async () => employee, revalidateKey })).result;
    expect(result.isError).not.toBe(true);
    expect(executeEmailDraft).toHaveBeenCalledOnce();
    expect(executeEmailDraft).toHaveBeenCalledWith({ ...wireArgs, subject: 'Warehouse options', to: [], cc: [] }, employee, expect.any(AbortSignal), revalidateKey);
    expect(result.structuredContent.meta).toEqual({ toolName: 'create_email_draft', argumentsSha256: argumentsSha256(wireArgs), employeeId: 7 });
    expect(result.structuredContent.data).toEqual(saved().data);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('keeps current scope and platform changes out of get_context write capabilities', async () => {
    let currentScopes: string[] = ['mail:drafts'];
    const read: McpDependencies['read'] = async () => Response.json({ data: { employee_id: 7, scopes: currentScopes, read_only: true,
      knowledge_discovery: { permitted: false, status: 'not_permitted', index_path: '/api/v1/wiki/pages', search_path: '/api/v1/wiki/search' },
      server_clock: clockContext() }, meta: { requestId: 'synthetic', generatedAt: new Date().toISOString() } });
    const invoke = (deps: Partial<McpDependencies> = {}) => call('tools/call', { name: 'get_context', arguments: {} }, { read, ...deps });
    expect((await invoke()).result.structuredContent.data).toMatchObject({ read_only: false, write_capabilities: ['create_email_draft'] });
    currentScopes = [];
    expect((await invoke()).result.structuredContent.data).toMatchObject({ read_only: true, write_capabilities: [] });
    currentScopes = ['mail:drafts'];
    expect((await invoke({ platform: 'claude' })).result.structuredContent.data).toMatchObject({ read_only: true, write_capabilities: [] });
    expect((await invoke({ prompts: async () => ({ toolPlatforms: { create_email_draft: [] } }) })).result.structuredContent.data)
      .toMatchObject({ read_only: true, write_capabilities: [] });
    expect(executeEmailDraft).not.toHaveBeenCalled();
  });

  it.each(['get_email_connection', 'read_email_draft'] as const)('keeps %s on the read envelope and passes grant revalidation', async name => {
    const employee = key(), revalidateKey = vi.fn(async () => {});
    const data = name === 'get_email_connection'
      ? { provider: 'gmail', connected: true, connection_status: 'active', mailbox: employee.employeeEmail, connection_id: input.connection_id, connection_version: 2, connect_url: `${origin}/mail`, capability: 'drafts_only' }
      : { draft_ref: input.operation_id, mailbox: employee.employeeEmail, provider: 'gmail', status: 'draft', subject: input.subject, to: [], cc: [], bcc: [], recipients_truncated: false, body: input.body, body_format: 'text', body_truncated: false, content_guidance: 'Source data.' };
    const read = vi.fn(async () => Response.json({ data, meta: { requestId: 'synthetic', generatedAt: new Date().toISOString(), toolName: 'forged', argumentsSha256: '0'.repeat(64) } }));
    const args = name === 'get_email_connection' ? {} : { draft_ref: input.operation_id };
    const result = (await call('tools/call', { name, arguments: args }, { read, authenticate: async () => employee, revalidateKey })).result;
    expect(result.isError).not.toBe(true);
    const expectedPath = name === 'get_email_connection' ? ['mail', 'connection'] : ['mail', 'drafts', input.operation_id];
    const [request, path, deps] = read.mock.calls[0] as unknown as [Request, string[], Partial<Parameters<typeof handleMcpRequest>[1]> & { authenticate: () => unknown }];
    expect(path).toEqual(expectedPath);
    expect(request.url).toBe(`${origin}/api/v1/${expectedPath.join('/')}`);
    expect(deps.authenticate()).toBe(employee);
    expect(deps.revalidateKey).toBe(revalidateKey);
    expect(result.structuredContent).toMatchObject({ source_path: `/api/v1/${expectedPath.join('/')}`, status: 200, data,
      meta: { toolName: name, argumentsSha256: argumentsSha256(args) } });
    expect(executeEmailDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['GMAIL_RECONNECT_REQUIRED', 401, 409, 'reconnect_gmail'],
    ['GMAIL_REVOCATION_PENDING', 409, 409, 'finish_gmail_disconnect'],
    ['GMAIL_DRAFT_UNAVAILABLE', 404, 404, 'check_gmail_draft'],
    ['GMAIL_RATE_LIMITED', 429, 429, 'retry_later'],
  ] as const)('preserves %s recovery through REST and MCP', async (code, sourceStatus, status, action) => {
    const read: McpDependencies['read'] = (request, path, overrides) => handleApiRequest(request, path, {
      ...overrides, audit: () => {},
      readEmailDraft: async () => { throw new HttpError(sourceStatus, code, 'Synthetic source failure.', { retryAfterSeconds: 7200 }); },
    });
    const result = (await call('tools/call', { name: 'read_email_draft', arguments: { draft_ref: input.operation_id } }, { read })).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status, source_path: `/api/v1/mail/drafts/${input.operation_id}`,
      error: { code, domain: 'gmail', recovery: { action, retryable: code === 'GMAIL_RATE_LIMITED' } } });
    if (code === 'GMAIL_RATE_LIMITED') expect(result.structuredContent.retry_after_seconds).toBe(7200);
    else expect(result.structuredContent).not.toHaveProperty('retry_after_seconds');
    expect(result.structuredContent).not.toHaveProperty('data');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('keeps revoked Context credentials distinct from Gmail recovery in MCP', async () => {
    const read: McpDependencies['read'] = (request, path, overrides) => handleApiRequest(request, path, {
      ...overrides, audit: () => {},
      readEmailDraft: async () => { throw new HttpError(401, 'UNAUTHORIZED', 'The Context grant was revoked.'); },
    });
    const result = (await call('tools/call', { name: 'read_email_draft', arguments: { draft_ref: input.operation_id } }, { read })).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 401, error: { code: 'UNAUTHORIZED' } });
    expect(result.structuredContent.error).not.toHaveProperty('domain');
    expect(result.structuredContent.error).not.toHaveProperty('recovery');
  });

  it('dispatches signed WhatsApp creation with request-owned actor and hash metadata', async () => {
    const pair = await generateKeyPair('EdDSA');
    vi.stubEnv('CONTEXT_RAMESH_AUTH_ENABLED', 'true');
    vi.stubEnv('CONTEXT_RAMESH_PUBLIC_KEYS_JSON', JSON.stringify([{ kid: 'mail-test', publicKey: await exportJWK(pair.publicKey), scopes: ['mail:drafts'], expiresAt: '2099-01-01T00:00:00Z' }]));
    const endpoint = `${origin}/mcp/ramesh`, now = Math.floor(Date.now() / 1000);
    const request = rpc('tools/call', { name: 'create_email_draft', arguments: input }, endpoint);
    const body = await request.clone().text();
    const token = await new SignJWT({ phone: '+919000000007', chat_type: 'dm', htm: 'POST', htu: endpoint,
      scopes: ['mail:drafts'], body_sha256: createHash('sha256').update(body).digest('base64url') })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'ramesh-request+jwt', kid: 'mail-test' }).setIssuer('wareongo:ramesh')
      .setAudience(endpoint).setSubject('7').setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID()).sign(pair.privateKey);
    request.headers.set('authorization', `Ramesh ${token}`);
    const employee = { id: 7, email: 'employee@wareongo.com', phone_number: '919000000007', is_active: true, dashboardAccess: false, adminAccess: false, analystAccess: false, twenty_user_id: null };
    const database = { query: vi.fn(async () => ({ rows: [employee] })) } as unknown as PoolClient;
    const result = (await wire(await handleRameshMcpRequest(request, { auth: { readTransaction: async work => work(database), consumeNonce: async () => true }, prompts: async () => ({}), audit: () => {} }))).result;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.meta).toEqual({ toolName: 'create_email_draft', argumentsSha256: argumentsSha256(input), employeeId: 7 });
    expect(executeEmailDraft).toHaveBeenCalledOnce();
    expect(vi.mocked(executeEmailDraft).mock.calls[0][1]).toMatchObject({ employeeId: 7, employeeEmail: employee.email, scopes: ['mail:drafts'] });
  });
});
