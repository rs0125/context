/** Offline provider stubs; no real OAuth, mailbox or business calls. */
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { GmailClient, GmailClientError, GMAIL_COMPOSE_SCOPE, operationMessageId, type GmailDraft } from '../src/lib/gmail-client';
import { encryptGmailSecret, type GmailConnection, type GmailDraftUpdateOperation } from '../src/lib/gmail-storage';
vi.mock('../src/lib/gmail-oauth', () => ({ gmailAvailability: () => ({ available: true }), refreshGmailAccessToken: vi.fn() }));
import { executeEmailDraftUpdate, readEmailDraft, type GmailUpdateToolDependencies } from '../src/lib/gmail-tools';
const draftRef = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const otherOperation = '44444444-4444-4444-8444-444444444444';
const owner = { employeeId: 7, employeeEmail: 'employee@wareongo.com' };
const key: KeyRegistration = { id: 'test', ...owner, scopes: ['mail:drafts'], hash: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' };
const now = '2026-10-04T09:00:00.000Z';
const input = { operation_id: operationId, connection_id: connectionId, connection_version: 1, draft_ref: draftRef,
  expected_message_id: 'original_message', to: ['recipient@example.com'], cc: [], subject: 'Updated subject', body: 'Updated full body' };
function fixture(draftId = 'draft1') {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONTEXT_GMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString('base64url') };
  const connected: GmailConnection = { ...owner, id: connectionId, version: 1, status: 'active', googleSub: 'google-sub', accountEmail: owner.employeeEmail,
    encryptedRefreshToken: encryptGmailSecret('synthetic-token', { purpose: 'refresh_token', employeeId: 7, id: connectionId }, env),
    grantedScopes: [GMAIL_COMPOSE_SCOPE], createdAt: now, updatedAt: now };
  const state = { connected, revoked: false, originalPresent: true, ambiguousCommit: false, committed: false };
  const current: GmailDraft = { id: draftId, messageId: input.expected_message_id, threadId: null, operationId: draftRef,
    internetMessageId: operationMessageId(draftRef), from: owner.employeeEmail, editable: true, subject: 'Original', to: input.to, cc: [], bcc: [],
    body: 'Original body', bodyFormat: 'text', bodyTruncated: false, updateOperationId: null };
  const operations = new Map<string, GmailDraftUpdateOperation>();
  const db = {} as PoolClient;
  const revalidate = vi.fn(async () => { if (state.revoked) throw new HttpError(401, 'UNAUTHORIZED', 'Revoked'); });
  const gmail: GmailUpdateToolDependencies['gmail'] = {
    createDraft: vi.fn(async () => { throw new Error('Never create a replacement'); }),
    findDraftByOperation: vi.fn(async () => { throw new Error('Never search unrelated draft targets'); }),
    getDraft: vi.fn(async (_token, id) => { expect(id).toBe(draftId); return { ...current }; }),
    updateDraft: vi.fn(async (_token, id, content) => {
      expect(state.committed).toBe(true); expect(id).toBe(draftId); expect(content.operationId).toBe(draftRef);
      Object.assign(current, { messageId: 'updated_message', updateOperationId: content.updateOperationId });
      return { ...current };
    }),
  };
  const deps: GmailUpdateToolDependencies = {
    env, gmail, refresh: vi.fn(async () => 'synthetic-access-token'), needsReauth: vi.fn(async () => false),
    readTransaction: async work => work(db), writeTransaction: async work => {
      const result = await work(db); state.committed = true;
      if (state.ambiguousCommit) { state.ambiguousCommit = false; throw new Error('Private ambiguous commit'); }
      return result;
    },
    principal: vi.fn(async () => ({ ...owner, email: owner.employeeEmail, scopes: ['mail:drafts'], keyId: key.id, isAnalyst: false } as Principal)),
    connection: vi.fn(async () => ({ ...state.connected })),
    claim: vi.fn(async () => { throw new Error('Never claim creation'); }), finish: vi.fn(async () => { throw new Error('Never finish creation'); }),
    references: vi.fn(async () => ({ items: [], nextCursor: null })),
    operation: vi.fn<GmailUpdateToolDependencies['operation']>(async (_db, requestedOwner, ref) => state.originalPresent && requestedOwner.employeeId === owner.employeeId && ref === draftRef
      ? { ...owner, operationId: draftRef, connectionId, connectionVersion: 1, requestHash: 'a'.repeat(64), googleSub: 'google-sub', retryAt: null,
        state: 'created', draftId, messageId: 'original_message', reason: null, createdAt: now, updatedAt: now } : null),
    updateOperation: vi.fn(async (_db, _owner, id) => operations.get(id) ? { ...operations.get(id)! } : null),
    updateClaim: vi.fn(async (_db, _owner, args) => {
      const previous = operations.get(args.operationId);
      if (previous) return { claimed: false, operation: { ...previous } };
      if ([...operations.values()].some(op => ['dispatching', 'unknown'].includes(op.state)))
        throw new HttpError(409, 'GMAIL_DRAFT_UPDATE_PENDING', 'Earlier update unresolved');
      const op: GmailDraftUpdateOperation = { ...owner, ...args, googleSub: 'google-sub', state: 'dispatching', messageId: null, reason: null, createdAt: now, updatedAt: now };
      operations.set(args.operationId, op); return { claimed: true, operation: { ...op } };
    }),
    updateFinish: vi.fn(async (_db, _owner, id, result) => {
      const op = operations.get(id)!;
      if (op.state === 'dispatching' || op.state === 'unknown' && result.state === 'updated')
        Object.assign(op, { state: result.state, messageId: result.state === 'updated' ? result.messageId : null, reason: result.state === 'updated' ? null : result.reason });
      return { ...op };
    }),
  };
  return { deps, state, current, operations, gmail, revalidate,
    run: (args: unknown = input, signal = new AbortController().signal) => executeEmailDraftUpdate(args, key, signal, revalidate, deps),
    read: () => readEmailDraft({ draft_ref: draftRef }, key, new AbortController().signal, revalidate, deps) };
}

/** Google can assign its own RFC Message-ID while preserving the stable draft ID
 * and our custom operation markers. Exercise the real HTTP parser rather than
 * injecting editable=true into the service. All content here is synthetic. */
function providerFixture() {
  const ctx = fixture();
  const originalBody = 'Hello,\r\n\r\nCould you share the next meeting time?\r\n\r\nThanks!';
  const provider = {
    losePutResponse: false,
    draft: { id: 'draft1', message: {
      id: input.expected_message_id, threadId: 'synthetic_thread', labelIds: ['DRAFT'],
      payload: { partId: '', mimeType: 'text/plain', filename: '',
        headers: [
          { name: 'Received', value: 'by synthetic.google.test with SMTP id synthetic' },
          { name: 'X-Received', value: 'by synthetic.google.test with SMTP id synthetic' },
          { name: 'From', value: owner.employeeEmail },
          { name: 'To', value: input.to.join(', ') },
          { name: 'Subject', value: 'Next meeting' },
          { name: 'Message-ID', value: '<synthetic-provider-original@mail.gmail.com>' },
          { name: 'X-Wareongo-Operation-ID', value: draftRef },
          { name: 'MIME-Version', value: '1.0' },
          { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
          { name: 'Content-Transfer-Encoding', value: 'base64' },
        ],
        body: { size: Buffer.byteLength(originalBody), data: Buffer.from(originalBody).toString('base64url') },
      },
    } },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    expect(new URL(String(url)).origin).toBe('https://gmail.googleapis.com');
    expect(new URL(String(url)).pathname).toBe('/gmail/v1/users/me/drafts/draft1');
    if (options?.method === 'GET') {
      expect(new URL(String(url)).searchParams.get('format')).toBe('full');
      return Response.json(provider.draft);
    }
    expect(options?.method).toBe('PUT');
    expect(ctx.state.committed).toBe(true);
    const raw = Buffer.from(JSON.parse(String(options?.body)).message.raw, 'base64url').toString('utf8');
    const [rawHeaders, rawBody] = raw.split('\r\n\r\n');
    const headers = rawHeaders.replace(/\r\n[ \t]+/g, ' ').split('\r\n').map(line => {
      const colon = line.indexOf(':');
      return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
    });
    expect(headers).toContainEqual({ name: 'X-Wareongo-Operation-ID', value: draftRef });
    expect(headers).toContainEqual({ name: 'X-Wareongo-Update-ID', value: operationId });
    const body = Buffer.from(rawBody.replace(/\s/g, ''), 'base64');
    // Provider normalization replaces the RFC Message-ID, not our custom marker.
    provider.draft.message.id = 'updated_message';
    provider.draft.message.payload.headers = headers.map(header => header.name.toLowerCase() === 'message-id'
      ? { ...header, value: '<synthetic-provider-updated@mail.gmail.com>' } : header);
    provider.draft.message.payload.body = { size: body.byteLength, data: body.toString('base64url') };
    if (provider.losePutResponse) throw new Error('Synthetic connection dropped after provider saved the update');
    return Response.json({ id: provider.draft.id, message: { id: provider.draft.message.id, threadId: provider.draft.message.threadId } });
  });
  ctx.deps.gmail = new GmailClient({ fetch });
  return { ...ctx, provider, fetch, originalBody,
    putCount: () => fetch.mock.calls.filter(([, options]) => options?.method === 'PUT').length };
}

describe('durable employee-owned Gmail draft replacement', () => {
  it('links the actual current provider thread after an update instead of guessing from its new message ID', async () => {
    const ctx = fixture('r-202');
    ctx.current.threadId = 'abc123';
    const read = await ctx.read();
    const updated = await ctx.run();
    expect(updated.outcome).toBe('updated');
    expect(updated.data?.draft_url).toBe(read.draft_url);
    expect(updated.data?.draft_url).toMatch(/^https:\/\/mail\.google\.com\/mail\/\?authuser=employee%40wareongo\.com#drafts\?compose=/);
    expect((await ctx.run()).data?.draft_url).toBeUndefined();
    expect(ctx.gmail.updateDraft).toHaveBeenCalledOnce();
    expect(ctx.gmail.createDraft).not.toHaveBeenCalled();
  });
  it('reads, updates and rereads the same draft when Google replaces the RFC Message-ID', async () => {
    const ctx = providerFixture();
    expect(await ctx.read()).toMatchObject({ draft_ref: draftRef, message_id: input.expected_message_id,
      body: ctx.originalBody, editable: true });
    expect(await ctx.run()).toMatchObject({ outcome: 'updated', code: 'GMAIL_DRAFT_UPDATED', data: { draft_ref: draftRef } });
    expect(await ctx.read()).toMatchObject({ draft_ref: draftRef, message_id: 'updated_message', editable: true,
      to: input.to, cc: input.cc, subject: input.subject, body: input.body });
    expect(await ctx.run()).toMatchObject({ outcome: 'replayed', data: { draft_ref: draftRef } });
    expect(ctx.putCount()).toBe(1);
    expect(ctx.deps.claim).not.toHaveBeenCalled();
    expect(ctx.fetch.mock.calls.every(([, options]) => ['GET', 'PUT'].includes(String(options?.method)))).toBe(true);
  });
  it('recovers a saved update after a lost HTTP response and Google-assigned Message-ID without another PUT', async () => {
    const ctx = providerFixture();
    ctx.provider.losePutResponse = true;
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(ctx.operations.get(operationId)?.state).toBe('unknown');
    ctx.state.connected.version++;
    expect(await ctx.run()).toMatchObject({ outcome: 'replayed', code: 'GMAIL_DRAFT_UPDATED', data: { draft_ref: draftRef } });
    expect(await ctx.read()).toMatchObject({ message_id: 'updated_message', editable: true, body: input.body });
    expect(ctx.operations.get(operationId)).toMatchObject({ state: 'updated', messageId: 'updated_message' });
    expect(ctx.putCount()).toBe(1);
    expect(ctx.deps.claim).not.toHaveBeenCalled();
  });
  it.each(['wrong_draft', 'missing_marker', 'wrong_marker'] as const)('rejects provider %s before any PUT', async kind => {
    const ctx = providerFixture();
    if (kind === 'wrong_draft') ctx.provider.draft.id = 'unowned_draft';
    else ctx.provider.draft.message.payload.headers = ctx.provider.draft.message.payload.headers.flatMap(header => {
      if (header.name !== 'X-Wareongo-Operation-ID') return [header];
      return kind === 'missing_marker' ? [] : [{ ...header, value: otherOperation }];
    });
    if (kind === 'wrong_draft') await expect(ctx.read()).rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID' });
    else expect(await ctx.read()).toMatchObject({ editable: false });
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected',
      code: kind === 'wrong_draft' ? 'GMAIL_RESPONSE_INVALID' : 'GMAIL_DRAFT_NOT_EDITABLE' });
    expect(ctx.putCount()).toBe(0);
    expect(ctx.fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(ctx.deps.claim).not.toHaveBeenCalled();
  });
  it.each(['missing_creation_marker', 'wrong_creation_marker', 'missing_update_marker', 'wrong_update_marker', 'wrong_draft'] as const)
    ('does not recover an uncertain HTTP update from %s', async kind => {
      const ctx = providerFixture(); ctx.provider.losePutResponse = true;
      expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
      if (kind === 'wrong_draft') ctx.provider.draft.id = 'unowned_draft';
      else {
        const marker = kind.includes('creation') ? 'X-Wareongo-Operation-ID' : 'X-Wareongo-Update-ID';
        ctx.provider.draft.message.payload.headers = ctx.provider.draft.message.payload.headers.flatMap(header => {
          if (header.name !== marker) return [header];
          return kind.startsWith('missing') ? [] : [{ ...header, value: otherOperation }];
        });
      }
      expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
      expect(ctx.operations.get(operationId)?.state).toBe('unknown');
      expect(ctx.putCount()).toBe(1);
      expect(ctx.deps.claim).not.toHaveBeenCalled();
    });
  it('checks the current revision, commits a claim, PUTs once, and preserves the original reference on replay', async () => {
    const ctx = fixture();
    expect(await ctx.read()).toMatchObject({ draft_ref: draftRef, message_id: input.expected_message_id, editable: true });
    expect(await ctx.run()).toMatchObject({ outcome: 'updated', code: 'GMAIL_DRAFT_UPDATED', data: { draft_ref: draftRef } });
    expect(await ctx.run()).toMatchObject({ outcome: 'replayed', data: { draft_ref: draftRef } });
    expect(ctx.gmail.updateDraft).toHaveBeenCalledTimes(1);
    expect(ctx.gmail.createDraft).not.toHaveBeenCalled();
    expect(ctx.gmail.findDraftByOperation).not.toHaveBeenCalled();
    expect(ctx.operations.get(operationId)).toMatchObject({ state: 'updated', messageId: 'updated_message' });
  });
  it.each(['stale', 'unsupported', 'wrong_sender', 'lost_marker'] as const)('rejects %s before provider mutation', async kind => {
    const ctx = fixture();
    if (kind === 'stale') ctx.current.messageId = 'newer_message';
    if (kind === 'unsupported') ctx.current.editable = false;
    if (kind === 'wrong_sender') ctx.current.from = 'other@wareongo.com';
    if (kind === 'lost_marker') ctx.current.operationId = null;
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected', code: kind === 'stale' ? 'GMAIL_DRAFT_CHANGED' : 'GMAIL_DRAFT_NOT_EDITABLE' });
    expect(ctx.gmail.updateDraft).not.toHaveBeenCalled();
    expect(ctx.operations.get(operationId)?.state).toBe('rejected');
  });
  it('rejects another owner’s reference and changed connection before claiming or reading Google', async () => {
    const ctx = fixture(); ctx.state.originalPresent = false;
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected', code: 'GMAIL_DRAFT_UNAVAILABLE' });
    expect(ctx.deps.updateClaim).not.toHaveBeenCalled(); expect(ctx.gmail.getDraft).not.toHaveBeenCalled();
    ctx.state.originalPresent = true; ctx.state.connected.version++;
    expect(await ctx.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GMAIL_CONNECTION_CHANGED' });
    expect(ctx.gmail.updateDraft).not.toHaveBeenCalled();
  });
  it('recovers a timed-out PUT using only the exact target marker, even after same-account reauthorization', async () => {
    const ctx = fixture();
    vi.mocked(ctx.gmail.updateDraft).mockImplementationOnce(async () => {
      ctx.current.updateOperationId = operationId; ctx.current.messageId = 'updated_message';
      throw new GmailClientError('GMAIL_TIMEOUT', { operationMayHaveSucceeded: true });
    });
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    ctx.state.connected.version++;
    expect(await ctx.run()).toMatchObject({ outcome: 'replayed', data: { draft_ref: draftRef } });
    expect(ctx.gmail.updateDraft).toHaveBeenCalledTimes(1);
    expect(ctx.operations.get(operationId)?.state).toBe('updated');
  });
  it('keeps an unresolved PUT unknown and blocks a replacement operation instead of overwriting', async () => {
    const ctx = fixture();
    vi.mocked(ctx.gmail.updateDraft).mockRejectedValue(new GmailClientError('GMAIL_UNAVAILABLE', { operationMayHaveSucceeded: true }));
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await ctx.run({ ...input, operation_id: otherOperation })).toMatchObject({ outcome: 'rejected', code: 'GMAIL_DRAFT_UPDATE_PENDING' });
    expect(ctx.gmail.updateDraft).toHaveBeenCalledTimes(1);
  });
  it('treats ambiguous claim commit as uncertain and never dispatches a PUT on retry', async () => {
    const ctx = fixture(); ctx.state.ambiguousCommit = true;
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(ctx.gmail.updateDraft).not.toHaveBeenCalled();
  });
  it('records known success after cancellation or revocation without disclosing private draft data', async () => {
    for (const mode of ['abort', 'revoked']) {
      const ctx = fixture(), controller = new AbortController();
      vi.mocked(ctx.gmail.updateDraft).mockImplementationOnce(async () => {
        if (mode === 'abort') controller.abort(); else ctx.state.revoked = true;
        return { ...ctx.current, messageId: 'updated_message' };
      });
      const result = await ctx.run(input, controller.signal);
      expect(result.outcome).toBe('outcome_unknown'); expect(result.data).toBeUndefined();
      expect(ctx.operations.get(operationId)).toMatchObject({ state: 'updated', messageId: 'updated_message' });
      expect(ctx.gmail.updateDraft).toHaveBeenCalledTimes(1);
    }
  });
  it('does not use another Google account to recover an old operation', async () => {
    const ctx = fixture();
    vi.mocked(ctx.gmail.updateDraft).mockRejectedValue(new GmailClientError('GMAIL_TIMEOUT', { operationMayHaveSucceeded: true }));
    await ctx.run(); vi.mocked(ctx.gmail.getDraft).mockClear();
    ctx.state.connected.googleSub = 'different-google-account'; ctx.state.connected.version++;
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown', recovery: { action: 'check_gmail_connection' } });
    expect(ctx.gmail.getDraft).not.toHaveBeenCalled();
  });
  it('rejects changed arguments under the same operation ID and never retries a definite rejection', async () => {
    const ctx = fixture();
    vi.mocked(ctx.gmail.updateDraft).mockRejectedValue(new GmailClientError('GMAIL_ACCESS_DENIED'));
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected', code: 'GMAIL_ACCESS_DENIED' });
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected' });
    expect(await ctx.run({ ...input, subject: 'Changed request' })).toMatchObject({ outcome: 'rejected', code: 'GMAIL_OPERATION_CONFLICT' });
    expect(ctx.gmail.updateDraft).toHaveBeenCalledTimes(1);
  });
});
