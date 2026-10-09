import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { executeCrmRfq, type CrmRfqDependencies } from '../src/lib/crm-writes/execute';
import type { CrmWriteReceipt } from '../src/lib/crm-writes/storage';
import { HttpError } from '../src/lib/errors';
import { crmSnapshotContext, decryptCrmSnapshot } from '../src/lib/crm-writes/snapshots';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';

const args = { operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', raw_text: '  Need 5000 sqft in Hoskote\n', location: 'Hoskote', requirement: '5000 sqft' };
const principal: Principal = { employeeId: 7, email: 'employee@wareongo.com', keyId: 'synthetic', scopes: ['crm.rfq:write'],
  twentyUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isAnalyst: false };
const key: KeyRegistration = { id: 'synthetic', hash: 'a'.repeat(64), employeeId: 7, employeeEmail: principal.email,
  scopes: ['crm.rfq:write'], expiresAt: '2099-01-01T00:00:00Z' };
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture() {
  let stored: CrmWriteReceipt | undefined;
  const actor = structuredClone(principal);
  const client = {} as PoolClient;
  const transaction = async <T,>(work: (c: PoolClient) => Promise<T>) => work(client);
  const crm = { creator: vi.fn(async () => ({ id: principal.twentyUserId!, name: 'Synthetic' })),
    create: vi.fn<CrmRfqDependencies['crm']['create']>(async () => ({ outcome: 'created', id })) };
  function checkStored(p: Principal, hash: string) {
    if (stored && (stored.request_hash !== hash || stored.member_id !== p.twentyUserId || stored.employee_email !== p.email)) throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation conflict.');
    return stored ? structuredClone(stored) : null;
  }
  const deps: CrmRfqDependencies = { readTransaction: transaction, writeTransaction: transaction, principal: vi.fn(async () => structuredClone(actor)), crm,
    env: { CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test', CONTEXT_CRM_WRITE_API_KEY: 'synthetic' },
    find: vi.fn(async (_c, p, _operation, hash) => checkStored(p, hash)),
    claim: vi.fn(async (_c, p, operation, hash) => {
      checkStored(p, hash);
      const fresh = !stored;
      stored ??= { employee_id: p.employeeId, employee_email: p.email, member_id: p.twentyUserId!, operation_id: operation,
        action: 'create_crm_rfq', request_hash: hash, state: 'dispatching', resource_id: null };
      return { fresh, receipt: structuredClone(stored) };
    }),
    finish: vi.fn(async (_c, _p, _operation, _hash, result) => {
      stored!.state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome;
      stored!.resource_id = result.outcome === 'created' ? result.id : null;
      if (result.outcome === 'created' && result.encryptedSnapshot) stored!.encrypted_snapshot = result.encryptedSnapshot;
    }),
  };
  return { deps, actor, crm, stored: () => stored, call: (input: unknown = args, signal = new AbortController().signal, revalidate = async () => {}) => executeCrmRfq(input, key, signal, revalidate, deps) };
}
describe('RFQ dispatch and recovery boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('commits a receipt and preserves raw description; retries only replay the receipt', async () => {
    const f = fixture();
    expect(await f.call()).toMatchObject({ outcome: 'created', data: { id, stage: 'RFQ_RECEIVED' } });
    expect(f.crm.create.mock.calls[0][0]).toMatchObject({ description: args.raw_text, stage: 'RFQ_RECEIVED' });
    expect(await f.call()).toMatchObject({ outcome: 'replayed', data: { id } });
    expect(f.crm.create).toHaveBeenCalledOnce();
    expect(f.crm.creator).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.claim).mock.invocationCallOrder[0]).toBeLessThan(f.crm.create.mock.invocationCallOrder[0]);
  });
  it('normalizes absent optional creation values once and replays without another dispatch', async () => {
    const f = fixture();
    const input = { ...args, city: null, company_name: '', budget: '   ', repeat_client: null };
    expect(await f.call(input)).toMatchObject({ outcome: 'created' });
    expect(await f.call(input)).toMatchObject({ outcome: 'replayed' });
    expect(f.crm.create).toHaveBeenCalledOnce();
    expect(f.crm.create.mock.calls[0][0]).not.toHaveProperty('city');
    expect(f.crm.create.mock.calls[0][0]).not.toHaveProperty('budget');
    expect(await f.call({ ...input, raw_text: args.raw_text + '\nNew text' })).toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it.each(['created', 'unknown'] as const)('preserves an earlier %s receipt when extraction rules have since become stricter', async state => {
    const f = fixture();
    const original = { ...args, raw_text: 'Need at least 5000 sqft in Hoskote' };
    // The old validator accepted this clipped bound. Never reinterpret a
    // historical result as proof that no write occurred under the old policy.
    f.deps.find = vi.fn<CrmRfqDependencies['find']>(async (_client, actor, operation, hash) => {
      expect(operation).toBe(original.operation_id);
      expect(hash).toBe(argumentsSha256(original));
      expect(actor.employeeId).toBe(principal.employeeId);
      return { employee_id: actor.employeeId, employee_email: actor.email, member_id: actor.twentyUserId!,
        operation_id: operation, action: 'create_crm_rfq', request_hash: hash, state,
        resource_id: state === 'created' ? id : null };
    });
    expect(await f.call(original)).toMatchObject({ outcome: state === 'created' ? 'replayed' : 'outcome_unknown' });
    expect(f.crm.creator).not.toHaveBeenCalled();
    expect(f.crm.create).not.toHaveBeenCalled();
    expect(f.deps.claim).not.toHaveBeenCalled();
  });
  it.each([['Coimbatore', '30,000sft', 'market rate'], ['Visakhapatnam', '25,000sft', 'TBD']])(
    'creates an RFQ in %s with an explicitly unrestricted locality', async (city, requirement, budget) => {
      const f = fixture();
      const raw_text = `Company Name - Acme\nCity - ${city}\nLocality - Anywhere\nArea required - ${requirement}\nBudget - ${budget}\nAdd this to crm as a separate rfq`;
      const input = { ...args, raw_text, location: city, city, requirement, company_name: 'Acme', micro_market: 'Anywhere', budget };
      expect(await f.call(input)).toMatchObject({ outcome: 'created', data: { id } });
      expect(f.crm.create.mock.calls[0][0]).toMatchObject({ city, microMarket: 'Anywhere', budget, description: raw_text });
      expect(await f.call(input)).toMatchObject({ outcome: 'replayed', data: { id } });
      expect(f.crm.create).toHaveBeenCalledOnce();
    });
  it('dispatches the full brief while omitting an optional value absent from its source', async () => {
    const f = fixture();
    expect(await f.call({ ...args, micro_market: 'Anywhere' })).toMatchObject({ outcome: 'created' });
    expect(f.crm.create.mock.calls[0][0]).not.toHaveProperty('microMarket');
    expect(f.crm.create.mock.calls[0][0].description).toBe(args.raw_text);
  });
  it('captures a bound encrypted create version for undo only after verified creation', async () => {
    const f = fixture();
    f.deps.env.CONTEXT_CRM_RFQ_EDITS_ENABLED = 'true';
    f.deps.env.CONTEXT_KEY_ENCRYPTION_SECRET = 'synthetic-create-key-at-least-32-characters';
    const record = { id, updatedAt: '2026-10-04T10:00:00.000Z', deletedAt: null, ownerId: principal.twentyUserId!,
      createdBy: { workspaceMemberId: principal.twentyUserId! }, stage: 'RFQ_RECEIVED', name: 'TBD - 5000 sqft - Hoskote' };
    f.crm.create.mockResolvedValue({ outcome: 'created', id, record });
    expect(await f.call()).toMatchObject({ outcome: 'created', data: { undo_available: true, updated_at: record.updatedAt } });
    const stored = f.stored()!;
    expect(stored.encrypted_snapshot).toMatch(/^v1\./);
    expect(stored.encrypted_snapshot).not.toContain(record.updatedAt);
    expect(decryptCrmSnapshot(stored.encrypted_snapshot!, crmSnapshotContext(stored), f.deps.env))
      .toEqual({ kind: 'create', record_id: id, after_updated_at: record.updatedAt });
    expect(await f.call()).toMatchObject({ outcome: 'replayed', data: { undo_available: false } });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('fails before reserving or creating when edits need an unavailable snapshot key', async () => {
    const f = fixture(); f.deps.env.CONTEXT_CRM_RFQ_EDITS_ENABLED = 'true';
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_SNAPSHOT_CONFIGURATION' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('keeps creation successful without offering undo when the provider omits its version', async () => {
    const f = fixture();
    f.deps.env.CONTEXT_CRM_RFQ_EDITS_ENABLED = 'true';
    f.deps.env.CONTEXT_KEY_ENCRYPTION_SECRET = 'synthetic-create-key-at-least-32-characters';
    expect(await f.call()).toMatchObject({ outcome: 'created', data: { undo_available: false } });
    expect(f.stored()?.encrypted_snapshot).toBeUndefined();
  });
  it.each(['created', 'rejected', 'outcome_unknown'] as const)('recovers %s without contacting CRM or writing another receipt', async outcome => {
    const f = fixture(); f.crm.create.mockResolvedValue(outcome === 'created' ? { outcome, id } : { outcome });
    await f.call();
    f.crm.creator.mockRejectedValue(new Error('CRM is offline'));
    f.deps.writeTransaction = async () => { throw new Error('Recovery must be read-only'); };
    expect(await f.call()).toMatchObject({ outcome: outcome === 'created' ? 'replayed' : outcome });
    expect(f.crm.creator).toHaveBeenCalledOnce();
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('does not replay a receipt for a changed CRM identity', async () => {
    const f = fixture(); await f.call();
    f.actor.twentyUserId = id;
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
    expect(f.crm.creator).toHaveBeenCalledOnce();
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('uses the injected environment for the default HTTP adapter', async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'GET'
      ? Response.json({ data: { workspaceMembers: [{ id: principal.twentyUserId, userEmail: principal.email, deletedAt: null, name: { firstName: 'Synthetic', lastName: '' } }] }, pageInfo: { hasNextPage: false } })
      : Response.json({ data: { createOpportunity: { ...JSON.parse(init!.body as string), id, deletedAt: null } } }, { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const { crm: _crm, ...deps } = f.deps;
    expect(await executeCrmRfq(args, key, new AbortController().signal, undefined, deps)).toMatchObject({ outcome: 'created' });
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://crm.example.test');
      expect(init!.headers).toMatchObject({ Authorization: 'Bearer synthetic' });
    }
  });
  it('admits only one concurrent dispatch for the same operation', async () => {
    const f = fixture();
    await Promise.all([f.call(), f.call(), f.call()]);
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('rejects reuse with changed arguments', async () => {
    const f = fixture(); await f.call();
    expect(await f.call({ ...args, raw_text: args.raw_text + 'extra' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it.each(['raw_text', 'operation_id'])('rejects missing critical %s before authorization or network', async field => {
    const f = fixture(); const input = { ...args, [field]: undefined };
    expect(await f.call(input)).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_RFQ_INVALID' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('rejects an empty source before any write', async () => {
    const f = fixture();
    expect(await f.call({ operation_id: args.operation_id, raw_text: ' \n\t' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_RFQ_INCOMPLETE', message: expect.stringContaining('original brief is empty') });
    expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('creates once from a brief alone and keeps retries bound to that complete source', async () => {
    const f = fixture();
    const input = { operation_id: args.operation_id, raw_text: '  Need a godown with truck parking. Size and location TBD.\n#twenty\n' };
    expect(await f.call(input)).toMatchObject({ outcome: 'created', data: { name: 'New RFQ' } });
    expect(f.crm.create.mock.calls[0][0]).toMatchObject({ name: 'New RFQ', description: input.raw_text });
    expect(await f.call(input)).toMatchObject({ outcome: 'replayed' });
    expect(await f.call({ ...input, raw_text: input.raw_text + 'Changed brief' })).toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('returns the title actually saved when optional extraction could not be used', async () => {
    const f = fixture();
    const input = { operation_id: args.operation_id, raw_text: 'Save this lead. Needs a small godown. Contact +44 (0) 9876543210',
      requirement: 'small godown', company_name: 'Invented Company', poc_phone: '+44 (0) 9876543210' };
    expect(await f.call(input)).toMatchObject({ outcome: 'created', data: { name: 'small godown' } });
    const payload = f.crm.create.mock.calls[0][0];
    for (const field of ['companyName', 'pocPhoneNumber', 'requirementInSft']) expect(payload).not.toHaveProperty(field);
    expect(payload.description).toBe(input.raw_text);
  });
  it.each(['scope', 'member', 'flag', 'key', 'membership'])('blocks missing %s before dispatch', async which => {
    const f = fixture();
    if (which === 'scope') f.actor.scopes = ['crm:read'];
    if (which === 'member') f.actor.twentyUserId = null;
    if (which === 'flag') f.deps.env.CONTEXT_CRM_RFQ_WRITES_ENABLED = 'false';
    if (which === 'key') f.deps.env.CONTEXT_CRM_WRITE_API_KEY = '';
    if (which === 'membership') f.crm.creator.mockRejectedValue(new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'No current member.'));
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it.each(['outcome_unknown', 'rejected'] as const)('does not resend after %s', async outcome => {
    const f = fixture(); f.crm.create.mockResolvedValue({ outcome });
    expect(await f.call()).toMatchObject({ outcome });
    expect(await f.call()).toMatchObject({ outcome });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('keeps crashes before receipt completion uncertain and never duplicates the write', async () => {
    const f = fixture(); f.deps.finish = vi.fn(async () => { throw new Error('Storage unavailable'); });
    expect(await f.call()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await f.call()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('withholds success when access is revoked after dispatch, while retaining its receipt', async () => {
    const f = fixture(); f.crm.create.mockImplementation(async () => { f.actor.scopes = []; return { outcome: 'created', id }; });
    expect(await f.call()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.stored()).toMatchObject({ state: 'created', resource_id: id });
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched', code: 'FORBIDDEN' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('revalidates the OAuth grant immediately before claiming a write', async () => {
    const f = fixture(); let n = 0;
    expect(await f.call(args, new AbortController().signal, async () => { if (++n === 2) throw new HttpError(403, 'FORBIDDEN', 'Grant revoked.'); })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('blocks a CRM identity change during the live member lookup before reserving or sending', async () => {
    const f = fixture();
    f.crm.creator.mockImplementation(async () => {
      f.actor.twentyUserId = id;
      return { id: principal.twentyUserId!, name: 'Synthetic' };
    });
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_ACCESS_CHANGED' });
    expect(f.deps.claim).not.toHaveBeenCalled();
    expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('keeps a cancelled reservation uncertain without sending a request on recovery', async () => {
    const f = fixture();
    const abort = new AbortController();
    const transaction = f.deps.writeTransaction;
    f.deps.writeTransaction = async work => {
      const result = await transaction(work);
      abort.abort();
      return result;
    };
    expect(await f.call(args, abort.signal)).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.stored()).toMatchObject({ state: 'dispatching' });
    expect(await f.call()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.crm.create).not.toHaveBeenCalled();
    expect(f.crm.creator).toHaveBeenCalledOnce();
  });
  it('persists a verified result after cancellation so recovery can return it without a second POST', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.crm.create.mockImplementation(async () => { abort.abort(); return { outcome: 'created', id }; });
    expect(await f.call(args, abort.signal)).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.stored()).toMatchObject({ state: 'created', resource_id: id });
    expect(await f.call()).toMatchObject({ outcome: 'replayed', data: { id } });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('withholds a completed result after a linked-member change and preserves its original attribution', async () => {
    const f = fixture();
    f.crm.create.mockImplementation(async () => { f.actor.twentyUserId = id; return { outcome: 'created', id }; });
    expect(await f.call()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.stored()).toMatchObject({ state: 'created', member_id: principal.twentyUserId, resource_id: id });
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('never dispatches if receipt storage or cancellation blocks the claim', async () => {
    const f = fixture(); f.deps.claim = vi.fn(async () => { throw new Error('DB unavailable'); });
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched' });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await f.call(args, cancelled.signal)).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_CANCELLED' });
    expect(f.crm.create).not.toHaveBeenCalled();
  });
});
