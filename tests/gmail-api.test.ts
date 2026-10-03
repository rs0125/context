/** REST + real mailbox read authorization with synthetic storage/provider ports. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { KeyRegistration } from '../src/lib/auth';
import { handleApiRequest } from '../src/lib/api';
import { HttpError } from '../src/lib/errors';
import { getEmailConnection, readEmailDraft, listEmailDrafts, type GmailToolDependencies } from '../src/lib/gmail-tools';
import { encryptGmailSecret, type GmailConnection, type GmailDraftOperation } from '../src/lib/gmail-storage';
import { GmailClientError, GMAIL_COMPOSE_SCOPE, type GmailDraft } from '../src/lib/gmail-client';

vi.mock('../src/lib/gmail-oauth', () => ({
  gmailAvailability: (env = process.env) => ({ available: env.CONTEXT_GMAIL_ENABLED === 'true' }),
  refreshGmailAccessToken: vi.fn(() => { throw new Error('Unexpected real Gmail refresh'); }),
}));

const origin = 'https://context.example.test';
const body = 'Synthetic private draft body';
function harness() {
  const owner = { employeeId: 7, employeeEmail: 'employee@wareongo.com' };
  const state = {
    enabled: true,
    employee: { id: owner.employeeId, email: owner.employeeEmail, is_active: true, dashboardAccess: false, adminAccess: false, analystAccess: false, twenty_user_id: null },
    connections: true,
    sockets: 0,
  };
  const env = { NODE_ENV: 'test' as const, CONTEXT_CONSOLE_ORIGIN: origin, CONTEXT_GMAIL_ENABLED: 'true', CONTEXT_GMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64url') };
  const connection: GmailConnection = { ...owner, id: randomUUID(), googleSub: 'synthetic-google-user', accountEmail: owner.employeeEmail,
    encryptedRefreshToken: null, grantedScopes: [GMAIL_COMPOSE_SCOPE], version: 3, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  connection.encryptedRefreshToken = encryptGmailSecret('synthetic-refresh-token', { purpose: 'refresh_token', employeeId: owner.employeeId, id: connection.id }, env);
  const operation: GmailDraftOperation = { ...owner, operationId: randomUUID(), connectionId: connection.id, connectionVersion: 3,
    requestHash: 'a'.repeat(64), googleSub: connection.googleSub, retryAt: null, state: 'created', draftId: 'synthetic-draft-id', messageId: 'synthetic-message-id', reason: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const key: KeyRegistration = { employeeId: owner.employeeId, employeeEmail: owner.employeeEmail, id: randomUUID(), hash: 'a'.repeat(64), scopes: ['mail:drafts'], expiresAt: '2099-01-01T00:00:00Z' };
  const client = { query: vi.fn(async () => ({ rows: [{ ...state.employee }] })) } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    state.sockets++;
    try { return await work(client); } finally { state.sockets--; }
  };
  const draft: GmailDraft = { id: operation.draftId!, messageId: operation.messageId!, threadId: null, operationId: operation.operationId,
    internetMessageId: null, subject: 'Warehouse options', to: [], cc: [], body, bodyTruncated: false, bodyFormat: 'text' };
  const getDraft = vi.fn(async () => { expect(state.sockets).toBe(0); return draft; });
  const refresh = vi.fn(async () => { expect(state.sockets).toBe(0); return 'synthetic-access-token'; });
  const lookup = vi.fn(async () => structuredClone(operation));
  const connectionLookup = vi.fn(async () => state.connections ? structuredClone(connection) : null);
  const references = vi.fn<GmailToolDependencies['references']>(async () => ({ items: [{ draft_ref: operation.operationId, created_at: operation.createdAt }], nextCursor: null }));
  const service: Partial<GmailToolDependencies> = {
    readTransaction: transaction, env, connection: connectionLookup, operation: lookup, references, refresh,
    gmail: { getDraft, createDraft: vi.fn(() => { throw new Error('Reads cannot create drafts'); }), findDraftByOperation: vi.fn(() => { throw new Error('Read must use exact owned reference'); }) },
  };
  const revalidateKey = vi.fn(async () => {});
  const deps = { authenticate: vi.fn(() => key), transaction, revalidateKey, audit: vi.fn(),
    getEmailConnection: ((candidate, signal, revalidate, overrides) => getEmailConnection(candidate, signal, revalidate, { ...service, ...overrides })) as typeof getEmailConnection,
    readEmailDraft: ((args, candidate, signal, revalidate, overrides) => readEmailDraft(args, candidate, signal, revalidate, { ...service, ...overrides })) as typeof readEmailDraft,
    listEmailDrafts: ((args, candidate, signal, revalidate, overrides) => listEmailDrafts(args, candidate, signal, revalidate, { ...service, ...overrides })) as typeof listEmailDrafts,
  };
  const request = (path: string, method = 'GET') => handleApiRequest(new Request(`${origin}/api/v1/${path}`, { method }), path.split('?')[0].split('/'), deps);
  return { state, env, key, connection, operation, request, deps, getDraft, refresh, lookup, connectionLookup, references };
}

describe('employee-owned Gmail draft REST reads', () => {
  it('returns connection information without credentials and handles a missing connection', async () => {
    const h = harness();
    const response = await h.request('mail/connection');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const result = await response.json();
    expect(result.data).toEqual({ provider: 'gmail', connected: true, connection_status: 'active', mailbox: h.key.employeeEmail, connection_id: h.connection.id,
      connection_version: 3, connect_url: `${origin}/mail`, capability: 'drafts_only' });
    expect(result.meta).toMatchObject({ requestId: expect.any(String), generatedAt: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-refresh-token|encryptedRefreshToken|googleSub|grantedScopes/);
    expect(h.deps.revalidateKey).toHaveBeenCalledOnce();
    h.state.connections = false;
    expect((await (await h.request('mail/connection')).json()).data).toMatchObject({ connected: false, connection_id: null, connection_version: null });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('reads an owned draft through a fresh connection and grant without holding a socket over provider I/O', async () => {
    const h = harness();
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({ draft_ref: h.operation.operationId, mailbox: h.key.employeeEmail,
      provider: 'gmail', status: 'draft', body, subject: 'Warehouse options' });
    expect(result.data).not.toHaveProperty('source_fetched_at');
    expect(result.meta.generatedAt).toEqual(expect.any(String));
    expect(h.getDraft).toHaveBeenCalledWith('synthetic-access-token', 'synthetic-draft-id', expect.any(AbortSignal));
    expect(h.deps.revalidateKey).toHaveBeenCalledTimes(3);
    expect(h.state.sockets).toBe(0);
  });

  it.each([[12000, '12'], [1501, '2'], [86_400_000, '86400']])('preserves bounded provider quota delay %i in REST read errors', async (retryAfterMs, expected) => {
    const h = harness();
    h.getDraft.mockRejectedValueOnce(new GmailClientError('GMAIL_RATE_LIMITED', { status: 403, retryAfterMs: Number(retryAfterMs) }));
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe(expected);
    expect((await response.json()).error.code).toBe('GMAIL_RATE_LIMITED');
  });

  it('preserves the generic REST retry delay when a source has no specific delay', async () => {
    const h = harness();
    h.getDraft.mockRejectedValueOnce(new GmailClientError('GMAIL_UNAVAILABLE'));
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
  });

  it.each([0, -1, 86401, NaN, Infinity, 1.5])('ignores an invalid generic error retry delay %s', async delay => {
    const h = harness();
    h.deps.revalidateKey.mockRejectedValueOnce(new HttpError(429, 'RATE_LIMITED', 'Rate limited.', { retryAfterSeconds: delay }));
    const response = await h.request('mail/connection');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it.each([
    ['revoking', 'GMAIL_REVOCATION_PENDING', 409],
    ['needs_reauth', 'GMAIL_RECONNECT_REQUIRED', 401],
  ] as const)('reports actionable %s state without provider access', async (status, code, httpStatus) => {
    const h = harness(); h.connection.status = status;
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(httpStatus);
    expect((await response.json()).error.code).toBe(code);
    expect(h.getDraft).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['mail/connection', 'mail/drafts', 'draft'] as const)('rejects disabled, unscoped or inactive %s access before storage or Gmail', async route => {
    for (const denial of ['disabled', 'scope', 'inactive'] as const) {
      const h = harness();
      if (denial === 'disabled') h.env.CONTEXT_GMAIL_ENABLED = 'false';
      if (denial === 'scope') h.key.scopes = ['knowledge:read'];
      if (denial === 'inactive') h.state.employee.is_active = false;
      const response = await h.request(route === 'draft' ? `mail/drafts/${h.operation.operationId}` : route);
      expect(response.status).toBe(denial === 'disabled' ? 503 : 403);
      expect(h.connectionLookup).not.toHaveBeenCalled();
      expect(h.getDraft).not.toHaveBeenCalled();
      expect(h.references).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(body);
    }
  });

  it('lists only private creation handles and reads a selected handle through fresh Gmail authorization', async () => {
    const h = harness();
    const listed = await h.request('mail/drafts');
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toContain('no-store');
    const result = await listed.json();
    expect(result.data).toMatchObject({items: [{draft_ref: h.operation.operationId, created_at: h.operation.createdAt}], nextCursor: null, current_status_verified: false});
    expect(result.data.guidance).toMatch(/read_email_draft/);
    expect(result.data.guidance).toMatch(/do not verify.*still exists/i);
    expect(h.references).toHaveBeenCalledWith(expect.anything(), {employeeId: h.key.employeeId, employeeEmail: h.key.employeeEmail}, expect.objectContaining({id: h.connection.id, version: h.connection.version}), {limit: 10});
    expect(JSON.stringify(result)).not.toMatch(/Synthetic private draft body|Warehouse options|synthetic-draft-id|synthetic-message-id|synthetic-refresh-token|encryptedContent|encryptedRefreshToken|googleSub|grantedScopes/);
    expect(h.getDraft).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.deps.revalidateKey).toHaveBeenCalledTimes(2);
    const read = await h.request(`mail/drafts/${result.data.items[0].draft_ref}`);
    expect(read.status).toBe(200);
    expect((await read.json()).data.body).toBe(body);
    expect(h.getDraft).toHaveBeenCalledOnce();
  });

  it('forwards bounded list pagination without caller-chosen owner or connection arguments', async () => {
    const h = harness();
    const cursor = randomUUID();
    const next = randomUUID();
    h.references.mockResolvedValue({items: [{draft_ref: h.operation.operationId, created_at: h.operation.createdAt}], nextCursor: next});
    const response = await h.request(`mail/drafts?limit=2&cursor=${cursor}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.nextCursor).toBe(next);
    expect(h.references.mock.calls[0][3]).toEqual({limit: 2, cursor});
    expect((await h.request('mail/drafts', 'HEAD')).status).toBe(200);
    expect(await (await h.request('mail/drafts', 'HEAD')).text()).toBe('');
  });

  it.each(['disconnected', 'missing', 'missing_google_scope'] as const)('rejects %s mailbox listing without disclosing historical handles', async change => {
    const h = harness();
    if (change === 'disconnected') h.connection.status = 'disconnected';
    if (change === 'missing') h.state.connections = false;
    if (change === 'missing_google_scope') h.connection.grantedScopes = [];
    const response = await h.request('mail/drafts');
    expect(response.status).toBe(409);
    expect(h.references).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(h.operation.operationId);
  });

  it.each(['offboard', 'disconnect', 'reconnect', 'scope', 'grant', 'disabled'] as const)('withholds listed references after in-flight %s', async change => {
    const h = harness();
    h.references.mockImplementation(async () => {
      if (change === 'offboard') h.state.employee.is_active = false;
      if (change === 'disconnect') h.connection.status = 'disconnected';
      if (change === 'reconnect') h.connection.version++;
      if (change === 'scope') h.key.scopes = ['knowledge:read'];
      if (change === 'grant') h.deps.revalidateKey.mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'Reconnect.'));
      if (change === 'disabled') h.env.CONTEXT_GMAIL_ENABLED = 'false';
      return {items: [{draft_ref: h.operation.operationId, created_at: h.operation.createdAt}], nextCursor: null};
    });
    const response = await h.request('mail/drafts');
    expect([401, 403, 409, 503]).toContain(response.status);
    expect(await response.text()).not.toContain(h.operation.operationId);
    expect(h.references).toHaveBeenCalledOnce();
    expect(h.getDraft).not.toHaveBeenCalled();
  });

  it.each(['limit=0', 'limit=21', 'limit=1.5', 'limit=NaN', 'cursor=not-a-uuid', 'employee_id=8', 'mailbox=other@example.com', `connection_id=${randomUUID()}`, 'connection_version=1'])( 'rejects unsupported list query %s before storage', async query => {
    const h = harness();
    expect([400, 422]).toContain((await h.request(`mail/drafts?${query}`)).status);
    expect(h.references).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['offboard', 'reconnect', 'scope', 'grant'] as const)('withholds draft content after in-flight %s', async change => {
    const h = harness();
    h.getDraft.mockImplementation(async () => {
      if (change === 'offboard') h.state.employee.is_active = false;
      if (change === 'reconnect') h.connection.version++;
      if (change === 'scope') h.key.scopes = ['knowledge:read'];
      if (change === 'grant') h.deps.revalidateKey.mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'Reconnect.'));
      return { id: 'synthetic-draft-id', messageId: 'synthetic-message-id', threadId: null, operationId: h.operation.operationId,
        internetMessageId: null, subject: 'Warehouse options', to: [], cc: [], body, bodyTruncated: false, bodyFormat: 'text' };
    });
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect([401, 403, 409]).toContain(response.status);
    expect(await response.text()).not.toContain(body);
    expect(h.getDraft).toHaveBeenCalledOnce();
  });

  it.each(['not-created', 'other-connection', 'different-account', 'unverified-account'] as const)('refuses %s references before Gmail reads', async kind => {
    const h = harness();
    if (kind === 'not-created') h.operation.state = 'unknown';
    if (kind === 'other-connection') h.operation.connectionId = randomUUID();
    if (kind === 'different-account') h.operation.googleSub = 'different-google-user';
    if (kind === 'unverified-account') h.operation.googleSub = null;
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(404);
    expect(h.getDraft).not.toHaveBeenCalled();
  });

  it('reads historical drafts after reauthorizing the same verified Google account', async () => {
    const h = harness(); h.connection.version++;
    const response = await h.request(`mail/drafts/${h.operation.operationId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.body).toBe(body);
    expect(h.getDraft).toHaveBeenCalledOnce();
  });

  it('rejects hidden query arguments, unknown routes, invalid references and REST mutations', async () => {
    for (const path of ['mail/connection?employee_id=8', 'mail/connection?mailbox=other@example.com', 'mail/drafts/not-a-uuid', 'mail/send']) {
      const h = harness();
      expect([400, 404, 422]).toContain((await h.request(path)).status);
      expect(h.getDraft).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
    }
    const h = harness();
    expect((await h.request('mail/connection', 'POST')).status).toBe(405);
    expect(h.deps.authenticate).not.toHaveBeenCalled();
    const head = await h.request('mail/connection', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
