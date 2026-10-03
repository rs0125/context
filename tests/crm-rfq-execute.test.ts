import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { executeCrmRfq, type CrmRfqDependencies } from '../src/lib/crm-writes/execute';
import type { CrmWriteReceipt } from '../src/lib/crm-writes/storage';
import { HttpError } from '../src/lib/errors';

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
  const deps: CrmRfqDependencies = { readTransaction: transaction, writeTransaction: transaction, principal: vi.fn(async () => actor), crm,
    env: { CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test', CONTEXT_CRM_WRITE_API_KEY: 'synthetic' },
    claim: vi.fn(async (_c, p, operation, hash) => {
      if (stored && stored.request_hash !== hash) throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation conflict.');
      const fresh = !stored;
      stored ??= { employee_id: p.employeeId, employee_email: p.email, member_id: p.twentyUserId!, operation_id: operation,
        action: 'create_crm_rfq', request_hash: hash, state: 'dispatching', resource_id: null };
      return { fresh, receipt: structuredClone(stored) };
    }),
    finish: vi.fn(async (_c, _p, _operation, _hash, result) => {
      stored!.state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome;
      stored!.resource_id = result.outcome === 'created' ? result.id : null;
    }),
  };
  return { deps, actor, crm, stored: () => stored, call: (input: unknown = args, signal = new AbortController().signal, revalidate = async () => {}) => executeCrmRfq(input, key, signal, revalidate, deps) };
}
describe('RFQ dispatch and recovery boundary', () => {
  it('commits a receipt and preserves raw description; retries only replay the receipt', async () => {
    const f = fixture();
    expect(await f.call()).toMatchObject({ outcome: 'created', data: { id, stage: 'RFQ_RECEIVED' } });
    expect(f.crm.create.mock.calls[0][0]).toMatchObject({ description: args.raw_text, stage: 'RFQ_RECEIVED' });
    expect(await f.call()).toMatchObject({ outcome: 'replayed', data: { id } });
    expect(f.crm.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.claim).mock.invocationCallOrder[0]).toBeLessThan(f.crm.create.mock.invocationCallOrder[0]);
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
  it.each(['raw_text', 'location', 'requirement'])('rejects missing critical %s before authorization or network', async field => {
    const f = fixture(); const input = { ...args, [field]: undefined };
    expect(await f.call(input)).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('provides actionable missing-field errors before any write', async () => {
    const f = fixture();
    expect(await f.call({ ...args, requirement: 'big', raw_text: 'big Hoskote' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_RFQ_INCOMPLETE', message: expect.stringContaining('positive quantity') });
    expect(f.crm.create).not.toHaveBeenCalled();
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
  it('never dispatches if receipt storage or cancellation blocks the claim', async () => {
    const f = fixture(); f.deps.claim = vi.fn(async () => { throw new Error('DB unavailable'); });
    expect(await f.call()).toMatchObject({ outcome: 'not_dispatched' });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await f.call(args, cancelled.signal)).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_CANCELLED' });
    expect(f.crm.create).not.toHaveBeenCalled();
  });
});
