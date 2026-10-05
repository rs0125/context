import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { CrmRfqClient } from '../src/lib/crm-writes/client';
import { executeCrmRfqDelete, type CrmDeleteDependencies } from '../src/lib/crm-writes/delete-execute';
import { rfqDeleteOutputSchema } from '../src/lib/crm-writes/delete';
import type { RfqLiveRecord } from '../src/lib/crm-writes/changes';
import type { CrmWriteReceipt } from '../src/lib/crm-writes/storage';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const version = '2026-10-05T10:00:00.000Z';
const newer = '2026-10-05T11:00:00.000Z';
const env = { CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true', CONTEXT_CRM_RFQ_EDITS_ENABLED: 'true',
  CONTEXT_CRM_DELETES_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test',
  CONTEXT_CRM_WRITE_API_KEY: 'synthetic-key', CONTEXT_KEY_ENCRYPTION_SECRET: 'synthetic-secret-of-more-than-32-characters' };
const key: KeyRegistration = { id: 'test', hash: 'a'.repeat(64), employeeId: 7, employeeEmail: 'employee@wareongo.com',
  scopes: ['crm:read', 'crm.rfq:write'], expiresAt: '2099-01-01T00:00:00Z' };
const input = { operation_id: operation, id, expected_updated_at: version, raw_text: 'Delete this opportunity' };
const signal = () => new AbortController().signal;
const record = (): RfqLiveRecord => ({ id, name: 'Test Logistics after edits - sales@example.com', updatedAt: version,
  deletedAt: null, stage: 'PROPOSAL', ownerId: member, createdBy: { workspaceMemberId: member } });

function fixture() {
  const actor: Principal = { employeeId: 7, email: key.employeeEmail!, keyId: key.id,
    scopes: [...key.scopes], twentyUserId: member, isAnalyst: false };
  const live = record(), records = new Map<string, CrmWriteReceipt>();
  const created: CrmWriteReceipt = { employee_id: actor.employeeId, employee_email: actor.email,
    member_id: member, action: 'create_crm_rfq', operation_id: other, request_hash: 'b'.repeat(64), state: 'created', resource_id: id };
  const belongs = (receipt: CrmWriteReceipt, current: Principal) => receipt.employee_id === current.employeeId
    && receipt.employee_email === current.email && receipt.member_id === current.twentyUserId;
  const transaction = async <T,>(work: (client: PoolClient) => Promise<T>) => work({} as PoolClient);
  const crm: CrmDeleteDependencies['crm'] = {
    creator: vi.fn(async () => ({ id: member, name: 'Employee' })),
    read: vi.fn(async () => structuredClone(live)),
    delete: vi.fn<CrmDeleteDependencies['crm']['delete']>(async current => {
      if (current.updatedAt !== live.updatedAt || current.ownerId !== live.ownerId || current.stage !== live.stage
        || current.createdBy.workspaceMemberId !== live.createdBy.workspaceMemberId || live.deletedAt !== null)
        return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      live.deletedAt = newer;
      return { outcome: 'deleted', id };
    }),
  };
  const deps: Partial<CrmDeleteDependencies> = { env: { ...env }, crm, readTransaction: transaction, writeTransaction: transaction,
    principal: vi.fn(async () => structuredClone(actor)),
    origin: vi.fn(async (_client, current, target) => belongs(created, current) && target === created.resource_id ? created : null),
    find: vi.fn(async (_client, current, operationId, hash, action) => {
      const receipt = records.get(operationId);
      if (!receipt) return null;
      if (!belongs(receipt, current) || receipt.request_hash !== hash || receipt.action !== action)
        throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Different request or actor.');
      return structuredClone(receipt);
    }),
    claim: vi.fn(async (_client, current, operationId, hash, action, encryptedSnapshot) => {
      const existing = records.get(operationId);
      if (existing) return { fresh: false, receipt: structuredClone(existing) };
      const receipt: CrmWriteReceipt = { employee_id: current.employeeId, employee_email: current.email,
        member_id: current.twentyUserId!, operation_id: operationId, action, request_hash: hash,
        state: 'dispatching', resource_id: null, encrypted_snapshot: encryptedSnapshot };
      records.set(operationId, receipt);
      return { fresh: true, receipt: structuredClone(receipt) };
    }),
    finish: vi.fn(async (_client, _actor, operationId, _hash, _action, result) => {
      const receipt = records.get(operationId)!;
      receipt.state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome === 'rolled_back' ? 'undone' : result.outcome;
      receipt.resource_id = 'id' in result ? result.id : null;
    }),
  };
  return { actor, live, records, deps, crm, created,
    remove: (args: unknown = input, abort = signal()) => executeCrmRfqDelete(args, key, abort, undefined, deps) };
}

describe('explicit own opportunity deletion', () => {
  it('deletes the current version after edits and progression without an undo chain', async () => {
    const f = fixture();
    const result = rfqDeleteOutputSchema.parse(await f.remove());
    expect(result).toMatchObject({ outcome: 'deleted', data: { id, deletion_kind: 'trash', undo_available: false,
      url: `https://crm.example.test/object/opportunity/${id}` } });
    expect(JSON.stringify(result)).not.toContain('sales@example.com');
    expect(f.crm.delete).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: version, stage: 'PROPOSAL' }), expect.anything());
    expect(f.records.get(operation)).toMatchObject({ state: 'deleted', resource_id: id, action: 'delete_crm_rfq' });
    expect(f.records.get(operation)!.encrypted_snapshot).not.toContain(id);
  });
  it('replays without another provider call or redisclosing CRM data', async () => {
    const f = fixture(); await f.remove();
    vi.mocked(f.crm.read).mockRejectedValue(new Error('CRM unreachable'));
    expect(await f.remove()).toMatchObject({ outcome: 'replayed' });
    expect(await f.remove()).not.toHaveProperty('data');
    expect(f.crm.read).toHaveBeenCalledOnce(); expect(f.crm.delete).toHaveBeenCalledOnce();
  });
  it.each(['employee', 'email', 'member', 'record'] as const)('refuses a different %s before any CRM lookup', async field => {
    const f = fixture(); f.actor.isAnalyst = true;
    if (field === 'employee') f.actor.employeeId += 1;
    if (field === 'email') f.actor.email = 'other@wareongo.com';
    if (field === 'member') f.actor.twentyUserId = other;
    expect(await f.remove(field === 'record' ? { ...input, id: other } : input)).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_RFQ_NOT_DELETABLE' });
    expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.delete).not.toHaveBeenCalled();
  });
  it.each(['owner', 'creator', 'deleted', 'version', 'id'] as const)('refuses a changed live %s before reserving', async field => {
    const f = fixture();
    if (field === 'owner') f.live.ownerId = other;
    if (field === 'creator') f.live.createdBy.workspaceMemberId = other;
    if (field === 'deleted') f.live.deletedAt = newer;
    if (field === 'version') f.live.updatedAt = newer;
    if (field === 'id') f.live.id = other;
    expect(await f.remove()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.delete).not.toHaveBeenCalled();
  });
  it.each(['crm:read', 'crm.rfq:write', 'deletes', 'edits', 'writes', 'encryption'] as const)('requires %s configuration and grants', async missing => {
    const f = fixture();
    if (missing === 'crm:read' || missing === 'crm.rfq:write') f.actor.scopes = f.actor.scopes.filter(scope => scope !== missing);
    if (missing === 'deletes') f.deps.env!.CONTEXT_CRM_DELETES_ENABLED = 'false';
    if (missing === 'edits') f.deps.env!.CONTEXT_CRM_RFQ_EDITS_ENABLED = 'false';
    if (missing === 'writes') f.deps.env!.CONTEXT_CRM_RFQ_WRITES_ENABLED = 'false';
    if (missing === 'encryption') delete f.deps.env!.CONTEXT_KEY_ENCRYPTION_SECRET;
    expect(await f.remove()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.delete).not.toHaveBeenCalled();
  });
  it('revalidates identity, grants and creation provenance immediately before claiming', async () => {
    const f = fixture();
    vi.mocked(f.crm.read).mockImplementation(async () => { f.actor.twentyUserId = other; return structuredClone(f.live); });
    expect(await f.remove()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_ACCESS_CHANGED' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.delete).not.toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.crm.read).mockImplementation(async () => { g.created.resource_id = other; return structuredClone(g.live); });
    expect(await g.remove()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_RFQ_NOT_DELETABLE' });
    expect(g.crm.delete).not.toHaveBeenCalled();
  });
  it.each(['owner', 'creator', 'stage', 'version'] as const)('provider guard rejects a concurrent %s change', async field => {
    const f = fixture(), claim = f.deps.claim!;
    f.deps.claim = vi.fn<CrmDeleteDependencies['claim']>(async (...args) => {
      const result = await claim(...args);
      if (field === 'owner') f.live.ownerId = other;
      if (field === 'creator') f.live.createdBy.workspaceMemberId = other;
      if (field === 'stage') f.live.stage = 'WON';
      if (field === 'version') f.live.updatedAt = newer;
      return result;
    });
    expect(await f.remove()).toMatchObject({ outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' });
    expect(f.live.deletedAt).toBeNull();
    expect(await f.remove()).toMatchObject({ outcome: 'rejected' }); expect(f.crm.delete).toHaveBeenCalledOnce();
  });
  it('permits only one concurrent dispatch and rejects operation reuse with changed arguments', async () => {
    const f = fixture(); await Promise.all([f.remove(), f.remove(), f.remove()]);
    expect(f.crm.delete).toHaveBeenCalledOnce();
    expect(await f.remove({ ...input, raw_text: 'different request' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
  });
  it('keeps a committed reservation uncertain when cancelled before provider dispatch, including on recovery', async () => {
    const f = fixture(), abort = new AbortController(), claim = f.deps.claim!;
    f.deps.claim = vi.fn<CrmDeleteDependencies['claim']>(async (...args) => {
      const result = await claim(...args); abort.abort(); return result;
    });
    expect(await f.remove(input, abort.signal)).toMatchObject({ outcome: 'outcome_unknown', code: 'CRM_OUTCOME_UNKNOWN' });
    expect(f.records.get(operation)).toMatchObject({ state: 'dispatching', resource_id: null });
    expect(await f.remove()).toMatchObject({ outcome: 'outcome_unknown', code: 'CRM_OUTCOME_UNKNOWN' });
    expect(f.crm.delete).not.toHaveBeenCalled(); expect(f.deps.claim).toHaveBeenCalledOnce();
  });
  it.each(['unknown', 'finish-failure', 'revoked'] as const)('keeps %s deletion uncertain without a second dispatch', async mode => {
    const f = fixture();
    if (mode === 'unknown') vi.mocked(f.crm.delete).mockResolvedValue({ outcome: 'outcome_unknown' });
    if (mode === 'finish-failure') f.deps.finish = vi.fn(async () => { throw new Error('receipt write failed'); });
    if (mode === 'revoked') {
      const remove = vi.mocked(f.crm.delete).getMockImplementation()!;
      vi.mocked(f.crm.delete).mockImplementation(async (...args) => { const result = await remove(...args); f.actor.scopes = []; return result; });
    }
    expect(await f.remove()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await f.remove()).not.toHaveProperty('data'); expect(f.crm.delete).toHaveBeenCalledOnce();
  });
  it('rejects empty requests and model-controlled extra fields before any I/O', async () => {
    const f = fixture();
    for (const args of [{ ...input, raw_text: ' ' }, { ...input, method: 'DELETE' }, { ...input, expected_updated_at: 'invalid' }])
      expect(await f.remove(args)).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.principal).not.toHaveBeenCalled(); expect(f.crm.delete).not.toHaveBeenCalled();
  });
});

describe('conditional opportunity soft delete adapter', () => {
  it('sends one soft collection DELETE bound to current id, version, owner, creator and progressed stage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { deleteOpportunities: [{ id }] } }));
    expect(await new CrmRfqClient(env, fetcher).delete(record(), signal())).toEqual({ outcome: 'deleted', id });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/rest/opportunities'); expect(url.searchParams.get('soft_delete')).toBe('true');
    expect(url.searchParams.get('filter')).toBe(`id[eq]:"${id}",updatedAt[eq]:"${version}",ownerId[eq]:"${member}",createdBy.workspaceMemberId[eq]:"${member}",stage[eq]:"PROPOSAL",deletedAt[is]:NULL`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'DELETE', redirect: 'error', cache: 'no-store' });
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['empty', 'wrong-id', 'many', 'wrong-status', 'bad-json', 'network', 'denied', 'server', 'redirect'] as const)('does not claim success or retry for %s replies', async mode => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (mode === 'network') throw new Error('network failed');
      if (mode === 'bad-json') return new Response('invalid');
      if (mode === 'denied' || mode === 'server') return new Response('upstream-secret', { status: mode === 'denied' ? 403 : 500 });
      const response = Response.json({ data: { deleteOpportunities: mode === 'empty' ? [] : mode === 'wrong-id' ? [{ id: other }] : mode === 'many' ? [{ id }, { id: other }] : [{ id }] } }, { status: mode === 'wrong-status' ? 201 : 200 });
      if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    expect(await new CrmRfqClient(env, fetcher).delete(record(), signal())).toEqual(mode === 'empty'
      ? { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' } : mode === 'denied' ? { outcome: 'rejected' } : { outcome: 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('fails closed on disabled deletion, malformed records or filter-injection values before calling CRM', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const invalid = [{ ...record(), id: 'bad' }, { ...record(), updatedAt: 'bad' }, { ...record(), ownerId: null },
      { ...record(), createdBy: { workspaceMemberId: null } }, { ...record(), deletedAt: newer }, { ...record(), stage: 'WON",id[neq]:"bad' }];
    for (const current of invalid) expect(await new CrmRfqClient(env, fetcher).delete(current, signal())).toMatchObject({ outcome: 'rejected' });
    expect(await new CrmRfqClient({ ...env, CONTEXT_CRM_DELETES_ENABLED: 'false' }, fetcher).delete(record(), signal())).toMatchObject({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
