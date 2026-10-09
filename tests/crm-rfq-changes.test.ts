import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import type { CrmChangeDependencies } from '../src/lib/crm-writes/change-access';
import { executeCrmRfqUndo, executeCrmRfqUpdate } from '../src/lib/crm-writes/change-execute';
import { listCrmRfqChanges, readCrmRfq } from '../src/lib/crm-writes/change-read';
import { rfqChangeOutputSchema, type RfqLiveRecord } from '../src/lib/crm-writes/changes';
import { withCrmTextPolicy } from '../src/lib/crm-presentation';
import { crmSnapshotContext, decryptCrmSnapshot, encryptCrmSnapshot } from '../src/lib/crm-writes/snapshots';
import type { CrmWriteReceipt } from '../src/lib/crm-writes/storage';

const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const creationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const editId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const undoId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const memberId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const originalVersion = '2026-10-04T10:00:00.000Z';
const editedVersion = '2026-10-04T10:01:00.000Z';
const restoredVersion = '2026-10-04T10:02:00.000Z';
const principal: Principal = { employeeId: 7, email: 'employee@wareongo.com', keyId: 'synthetic',
  scopes: ['crm.rfq:write'], twentyUserId: memberId, isAnalyst: false };
const key: KeyRegistration = { id: 'synthetic', hash: 'a'.repeat(64), employeeId: 7, employeeEmail: principal.email,
  scopes: ['crm.rfq:write'], expiresAt: '2099-01-01T00:00:00Z' };
const args = { operation_id: editId, id, expected_updated_at: originalVersion,
  raw_text: 'Change the budget to 22 rs/sqft per month', changes: { budget: '22 rs/sqft per month' } };
const undoArgs = { operation_id: undoId, original_operation_id: editId, raw_text: 'Undo that budget change' };
const signal = () => new AbortController().signal;

function fixture() {
  const actor = structuredClone(principal);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true',
    CONTEXT_CRM_RFQ_EDITS_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test',
    CONTEXT_CRM_WRITE_API_KEY: 'synthetic', CONTEXT_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-secret-at-least-32-bytes' };
  const live: RfqLiveRecord = { id, updatedAt: originalVersion, deletedAt: null, ownerId: memberId,
    createdBy: { workspaceMemberId: memberId }, stage: 'RFQ_RECEIVED', name: 'Test Logistics - 50000 sqft - Hoskote',
    companyName: 'Test Logistics', city: 'Bangalore', microMarket: 'Hoskote', requirementInSft: 50000,
    budget: '20 rs/sqft per month', description: 'Test Logistics needs 50000 sqft in Hoskote. Call 9876543210 or sales@example.com',
    pocName: { firstName: 'Synthetic', lastName: 'Contact' },
    pocPhoneNumber: { primaryPhoneNumber: '9876543210', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [{ number: '9123456789' }] },
    leadSource: null, duration: null, repeatClient: [] };
  const created: CrmWriteReceipt = { employee_id: actor.employeeId, employee_email: actor.email,
    member_id: memberId, operation_id: creationId, action: 'create_crm_rfq', request_hash: 'a'.repeat(64),
    state: 'created', resource_id: id, encrypted_snapshot: null };
  const receipts = new Map<string, CrmWriteReceipt>([[creationId, created]]);
  const client = {} as PoolClient;
  const transaction = async <T,>(work: (c: PoolClient) => Promise<T>) => work(client);
  const belongsTo = (receipt: CrmWriteReceipt, current: Principal) => receipt.employee_id === current.employeeId
    && receipt.employee_email === current.email && receipt.member_id === current.twentyUserId;
  const crm = {
    creator: vi.fn<CrmChangeDependencies['crm']['creator']>(async () => ({ id: memberId, name: 'Synthetic Employee' })),
    read: vi.fn<CrmChangeDependencies['crm']['read']>(async () => structuredClone(live)),
    update: vi.fn<CrmChangeDependencies['crm']['update']>(async (expected, patch) => {
      if (expected.updatedAt !== live.updatedAt) return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      Object.assign(live, structuredClone(patch), { updatedAt: live.updatedAt === originalVersion ? editedVersion : restoredVersion });
      return { outcome: 'updated', id, record: structuredClone(live) };
    }),
    undoCreate: vi.fn<CrmChangeDependencies['crm']['undoCreate']>(async expected => {
      if (expected.updatedAt !== live.updatedAt) return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      live.deletedAt = restoredVersion;
      return { outcome: 'rolled_back', id };
    }),
  };
  const deps: CrmChangeDependencies = {
    readTransaction: transaction, writeTransaction: transaction, env, crm,
    principal: vi.fn(async () => structuredClone(actor)),
    find: vi.fn(async (_client, current, operation, hash, action) => {
      const stored = receipts.get(operation);
      if (!stored) return null;
      if (!belongsTo(stored, current) || stored.request_hash !== hash || stored.action !== action) {
        throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation belongs to different arguments or identity.');
      }
      return structuredClone(stored);
    }),
    claim: vi.fn(async (_client, current, operation, hash, action, encryptedSnapshot) => {
      // Model the database INSERT ON CONFLICT claim as one synchronous operation.
      const prior = receipts.get(operation);
      if (prior) {
        if (!belongsTo(prior, current) || prior.request_hash !== hash || prior.action !== action) {
          throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation belongs to different arguments or identity.');
        }
        return { fresh: false, receipt: structuredClone(prior) };
      }
      const stored: CrmWriteReceipt = { employee_id: current.employeeId, employee_email: current.email,
        member_id: current.twentyUserId!, operation_id: operation, action, request_hash: hash,
        state: 'dispatching', resource_id: null, encrypted_snapshot: encryptedSnapshot ?? null };
      receipts.set(operation, stored);
      return { fresh: true, receipt: structuredClone(stored) };
    }),
    finish: vi.fn(async (_client, _current, operation, _hash, _action, result) => {
      const stored = receipts.get(operation)!;
      stored.state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome === 'rolled_back' ? 'undone' : result.outcome;
      stored.resource_id = 'id' in result ? result.id : null;
      if (result.encryptedSnapshot) stored.encrypted_snapshot = result.encryptedSnapshot;
    }),
    origin: vi.fn(async (_client, current, recordId) => {
      const stored = [...receipts.values()].find(receipt => belongsTo(receipt, current)
        && receipt.action === 'create_crm_rfq' && receipt.state === 'created' && receipt.resource_id === recordId);
      return stored ? structuredClone(stored) : null;
    }),
    load: vi.fn(async (_client, current, operation) => {
      const stored = receipts.get(operation);
      return stored && belongsTo(stored, current) ? structuredClone(stored) : null;
    }),
    list: vi.fn(async (_client, current, limit) => [...receipts.values()].filter(receipt => belongsTo(receipt, current)).slice(0, limit)),
  };
  function snapshot(receipt: CrmWriteReceipt, value: Record<string, unknown>) {
    receipt.encrypted_snapshot = encryptCrmSnapshot(value, crmSnapshotContext(receipt), env);
  }
  return { actor, env, live, crm, deps, receipts, created, snapshot,
    update: (input: unknown = args, abort = signal(), revalidate = async () => {}) => executeCrmRfqUpdate(input, key, abort, revalidate, deps),
    undo: (input: unknown = undoArgs, abort = signal(), revalidate = async () => {}) => executeCrmRfqUndo(input, key, abort, revalidate, deps),
    read: (recordId = id, revalidate = async () => {}) => readCrmRfq(recordId, key, signal(), revalidate, deps),
    list: () => listCrmRfqChanges(10, key, signal(), undefined, deps) };
}

describe('agent-created RFQ access and disclosure', () => {
  it('refuses arbitrary deals before calling CRM, including for Analysts', async () => {
    const f = fixture(); f.actor.isAnalyst = true;
    await expect(f.read(otherId)).rejects.toMatchObject({ code: 'CRM_RFQ_NOT_EDITABLE' });
    expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.creator).not.toHaveBeenCalled();
  });
  it.each(['employee', 'email', 'member'] as const)('does not inherit the agent creation receipt after a changed %s binding', async field => {
    const f = fixture();
    if (field === 'employee') f.actor.employeeId += 1;
    if (field === 'email') f.actor.email = 'other@wareongo.com';
    if (field === 'member') f.actor.twentyUserId = otherId;
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_RFQ_NOT_EDITABLE' });
    expect(f.crm.read).not.toHaveBeenCalled();
  });
  it.each(['owner', 'creator', 'deleted'] as const)('refuses a historical creation receipt when the live record has a changed %s', async field => {
    const f = fixture();
    if (field === 'owner') f.live.ownerId = otherId;
    if (field === 'creator') f.live.createdBy.workspaceMemberId = otherId;
    if (field === 'deleted') f.live.deletedAt = editedVersion;
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_RFQ_NOT_EDITABLE' });
  });
  it('discloses live editable details and versions while masking contacts everywhere', async () => {
    const f = fixture(); f.live.budget = 'Contact sales@example.com for budget';
    const view = await f.read();
    expect(view).toMatchObject({ id, updated_at: originalVersion, editable: true,
      fields: { requirement_sqft: 50000, company_name: { text: 'Test Logistics' }, contact_phone_present: true } });
    expect(view.url).toBe(`https://crm.example.test/object/opportunity/${id}`);
    expect(JSON.stringify(view)).not.toMatch(/9876543210|9123456789|sales@example\.com/);
    expect(JSON.stringify(view)).toContain('omitted');
    expect(f.deps.principal).toHaveBeenCalledTimes(2);
  });
  it.each(['redacted', 'unredacted'] as const)('labels normalized RFQ text under the %s policy without modifying storage', async policy => {
    const f = fixture(), original = '  Fixture Banyan needs office + warehouse.\nBudget TBD.\n';
    f.live.description = original;
    const view = await withCrmTextPolicy(policy, () => f.read());
    expect(view.description).toEqual({ state: 'present', text: original.trim(), redacted: false,
      truncated: false, representation: 'normalized_display' });
    expect(view.fields.company_name).toMatchObject({ text: 'Test Logistics', representation: 'normalized_display' });
    expect(f.live.description).toBe(original);
  });
  it('withholds read results if a grant is revoked after the live read', async () => {
    const f = fixture(); f.crm.read.mockImplementation(async () => { f.actor.scopes = []; return structuredClone(f.live); });
    await expect(f.read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('filters history by agent origin and current ownership without releasing before-images', async () => {
    const f = fixture();
    f.snapshot(f.created, { kind: 'create', record_id: id, after_updated_at: originalVersion });
    f.receipts.set(editId, { ...f.created, action: 'update_crm_rfq', state: 'updated', operation_id: editId, resource_id: otherId });
    const result = await f.list();
    expect(result.items).toEqual([expect.objectContaining({ operation_id: creationId, id, undo_available: true })]);
    expect(f.crm.read).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/9876543210|encrypted_snapshot|request_hash|before/);
    f.live.ownerId = otherId;
    expect((await f.list()).items).toEqual([]);
  });
  it('marks historical creates without a captured version and externally modified records as not undoable', async () => {
    const f = fixture(); expect((await f.list()).items[0].undo_available).toBe(false);
    f.snapshot(f.created, { kind: 'create', record_id: id, after_updated_at: originalVersion });
    f.live.updatedAt = editedVersion;
    expect((await f.list()).items[0].undo_available).toBe(false);
  });
  it('does not turn an unavailable CRM read into an empty successful history', async () => {
    const f = fixture();
    f.crm.read.mockRejectedValue(new HttpError(503, 'CRM_RFQ_UNAVAILABLE', 'Synthetic provider failure'));
    await expect(f.list()).rejects.toMatchObject({ code: 'CRM_RFQ_UNAVAILABLE' });
    expect(f.crm.read).toHaveBeenCalledOnce();
  });
  it.each(['not-found', 'deleted', 'reassigned', 'creator-changed'] as const)('omits a known %s RFQ from history', async reason => {
    const f = fixture();
    if (reason === 'not-found') f.crm.read.mockRejectedValue(new HttpError(404, 'CRM_RFQ_NOT_FOUND', 'Missing RFQ'));
    if (reason === 'deleted') f.live.deletedAt = editedVersion;
    if (reason === 'reassigned') f.live.ownerId = otherId;
    if (reason === 'creator-changed') f.live.createdBy.workspaceMemberId = otherId;
    expect((await f.list()).items).toEqual([]);
  });
});

describe('RFQ detail updates and guarded undo', () => {
  it('edits an older agent-created record, captures an encrypted before-image, and replays without sending a second update', async () => {
    const f = fixture();
    expect(await f.update()).toMatchObject({ outcome: 'updated', data: { id, updated_at: editedVersion, undo_available: true } });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ budget: args.changes.budget });
    const stored = f.receipts.get(editId)!;
    expect(stored.encrypted_snapshot).not.toContain('20 rs');
    expect(decryptCrmSnapshot(stored.encrypted_snapshot!, crmSnapshotContext(stored), f.env))
      .toMatchObject({ kind: 'update', record_id: id, after_updated_at: editedVersion, before: { budget: '20 rs/sqft per month' } });
    const replayed = await f.update();
    expect(replayed).toMatchObject({ outcome: 'replayed', data: { id } });
    expect(replayed.data).not.toHaveProperty('description_unchanged');
    expect(f.crm.update).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.claim).mock.invocationCallOrder[0]).toBeLessThan(f.crm.update.mock.invocationCallOrder[0]);
  });
  it('rejects arbitrary record IDs before any CRM read or mutation', async () => {
    const f = fixture();
    expect(await f.update({ ...args, id: otherId })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it.each(['stage', 'ownerId', 'createdBy', 'deletedAt', 'description', 'arbitraryField'])('rejects forbidden edit field %s before reserving or calling CRM', async field => {
    const f = fixture();
    expect(await f.update({ ...args, changes: { [field]: 'injected' } })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it.each(['scope', 'member', 'edits-disabled', 'writes-disabled', 'encryption'])('blocks missing %s before dispatch', async reason => {
    const f = fixture();
    if (reason === 'scope') f.actor.scopes = ['crm:read'];
    if (reason === 'member') f.actor.twentyUserId = null;
    if (reason === 'edits-disabled') f.env.CONTEXT_CRM_RFQ_EDITS_ENABLED = 'false';
    if (reason === 'writes-disabled') f.env.CONTEXT_CRM_RFQ_WRITES_ENABLED = 'false';
    if (reason === 'encryption') delete f.env.CONTEXT_KEY_ENCRYPTION_SECRET;
    expect(await f.update()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it.each(['owner', 'creator', 'version', 'deleted'] as const)('blocks a changed live %s before reserving', async reason => {
    const f = fixture();
    if (reason === 'owner') f.live.ownerId = otherId;
    if (reason === 'creator') f.live.createdBy.workspaceMemberId = otherId;
    if (reason === 'version') f.live.updatedAt = editedVersion;
    if (reason === 'deleted') f.live.deletedAt = editedVersion;
    expect(await f.update()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it('does not dispatch after identity revocation during live lookup', async () => {
    const f = fixture();
    f.crm.read.mockImplementation(async () => { f.actor.twentyUserId = otherId; return structuredClone(f.live); });
    expect(await f.update()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_ACCESS_CHANGED' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it('requires accurate replacement titles for requirement changes and preserves range semantics', async () => {
    const f = fixture();
    expect(await f.update({ ...args, changes: { requirement: '20k-30k sqft' } })).toMatchObject({ outcome: 'not_dispatched' });
    expect(await f.update({ ...args, changes: { requirement: '20k-30k sqft', title: 'Test Logistics - 20k-30k sqft - Hoskote' } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ name: 'Test Logistics - 20k-30k sqft - Hoskote', requirementInSft: null });
  });
  it('accepts explicit bound syntax on edits and clears an obsolete exact area', async () => {
    const f = fixture();
    const requirement = 'between 3,000 and 5,000 sft';
    expect(await f.update({ ...args, raw_text: `Change the requirement to ${requirement}`,
      changes: { requirement, title: `Test Logistics - ${requirement} - Hoskote` } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ name: `Test Logistics - ${requirement} - Hoskote`, requirementInSft: null });
  });
  it('accepts an explicit Indian prefix on edits without losing secondary phones', async () => {
    const f = fixture();
    expect(await f.update({ ...args, raw_text: 'Change primary phone to 0091 99887 76655',
      changes: { poc_phone: '0091 99887 76655' } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toMatchObject({ pocPhoneNumber: {
      primaryPhoneNumber: '9988776655', primaryPhoneCallingCode: '+91', additionalPhones: [{ number: '9123456789' }],
    } });
  });
  it.each([
    { field: 'city', native: 'city', value: 'Bengaluru', title: 'Test Logistics - 50000 sqft - Hoskote, Bengaluru' },
    { field: 'micro_market', native: 'microMarket', value: 'Nelamangala', title: 'Test Logistics - 50000 sqft - Nelamangala' },
  ])('requires the replacement title to reflect a changed $field', async ({ field, native, value, title }) => {
    const f = fixture(), raw_text = `Change the ${field} to ${value}`;
    expect(await f.update({ ...args, raw_text, changes: { [field]: value } })).toMatchObject({ outcome: 'not_dispatched' });
    expect(await f.update({ ...args, raw_text, changes: { [field]: value, title: f.live.name } })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).not.toHaveBeenCalled();
    expect(await f.update({ ...args, raw_text, changes: { [field]: value, title } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ [native]: value, name: title });
  });
  it('requires an explicit revised title when clearing a location detail', async () => {
    const f = fixture(), raw_text = 'Clear the city field and remove it from the title';
    expect(await f.update({ ...args, raw_text, changes: { city: null } })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).not.toHaveBeenCalled();
    expect(await f.update({ ...args, raw_text, changes: { city: null, title: 'Test Logistics - 50000 sqft - Hoskote' } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ city: null, name: 'Test Logistics - 50000 sqft - Hoskote' });
  });
  it('preserves secondary phones when replacing the primary number and never rewrites original intake text', async () => {
    const f = fixture(); const description = f.live.description;
    expect(await f.update({ ...args, raw_text: 'Change primary phone to 9988776655', changes: { poc_phone: '9988776655' } })).toMatchObject({ outcome: 'updated' });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ pocPhoneNumber: { primaryPhoneNumber: '9988776655',
      primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [{ number: '9123456789' }] } });
    expect(f.live.description).toBe(description);
  });
  it.each([
    [true, ['OPTION1']], [false, ['NO']], [null, []],
  ] as const)('clears budget and sets repeat client to %s while comparing the untouched stored brief', async (repeat_client, native) => {
    const f = fixture(), original = '  Fixture Banyan needs office + warehouse.\nBudget TBD.\n#twenty\n';
    f.live.description = original;
    const result = await f.update({ ...args, raw_text: `Clear budget and set repeat client to ${repeat_client}; keep the description unchanged.`,
      changes: { budget: null, repeat_client } });
    expect(rfqChangeOutputSchema.parse(result)).toMatchObject({ outcome: 'updated', data: { description_unchanged: true } });
    expect(f.crm.update.mock.calls[0][1]).toEqual({ budget: null, repeatClient: native });
    expect(f.live.description).toBe(original);
    expect(f.live.budget).toBeNull();
    expect(f.live.repeatClient).toEqual(native);
  });
  it('leaves an omitted repeat-client value unchanged', async () => {
    const f = fixture(); f.live.repeatClient = ['OPTION1'];
    expect(await f.update()).toMatchObject({ outcome: 'updated', data: { description_unchanged: true } });
    expect(f.live.repeatClient).toEqual(['OPTION1']);
    expect(f.crm.update.mock.calls[0][1]).not.toHaveProperty('repeatClient');
  });
  it.each([
    { before: '  Same words\n', after: 'Same words', comparison: false },
    { before: null, after: null, comparison: true },
    { before: null, after: '', comparison: false },
    { before: undefined, after: undefined, comparison: undefined },
    { before: 'Original', after: undefined, comparison: undefined },
    { before: undefined, after: 'Original', comparison: undefined },
    { before: { text: 'Original' }, after: { text: 'Original' }, comparison: undefined },
  ])('reports only an actual native description comparison: $before -> $after', async ({ before, after, comparison }) => {
    const f = fixture(); f.live.description = before;
    f.crm.update.mockImplementation(async (_expected, patch) => {
      Object.assign(f.live, structuredClone(patch), { description: after, updatedAt: editedVersion });
      return { outcome: 'updated', id, record: structuredClone(f.live) };
    });
    const result = rfqChangeOutputSchema.parse(await f.update());
    expect(result.outcome).toBe('updated');
    if (comparison === undefined) expect(result.data).not.toHaveProperty('description_unchanged');
    else expect(result.data?.description_unchanged).toBe(comparison);
    expect(f.crm.read).toHaveBeenCalledOnce();
    expect(f.crm.update.mock.calls[0][1]).not.toHaveProperty('description');
  });
  it('rejects operation reuse with changed values and allows only one concurrent dispatch', async () => {
    const f = fixture(); await Promise.all([f.update(), f.update(), f.update()]);
    expect(f.crm.update).toHaveBeenCalledOnce();
    expect(await f.update({ ...args, changes: { budget: '23 rs/sqft per month' } })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
  });
  it('does not let a competing edit overwrite the first writer after both read the same version', async () => {
    const f = fixture();
    const results = await Promise.all([f.update(), f.update({ ...args, operation_id: otherId, changes: { budget: '23 rs/sqft per month' } })]);
    expect(results.map(result => result.outcome).sort()).toEqual(['rejected', 'updated']);
    expect(f.crm.update).toHaveBeenCalledTimes(2);
    expect(f.crm.update.mock.calls.map(call => call[0].updatedAt)).toEqual([originalVersion, originalVersion]);
    expect(f.live.budget).toBe(args.changes.budget);
    expect(await f.update({ ...args, operation_id: otherId, changes: { budget: '23 rs/sqft per month' } })).toMatchObject({ outcome: 'rejected' });
    expect(f.crm.update).toHaveBeenCalledTimes(2);
  });
  it.each(['outcome_unknown', 'rejected'] as const)('never repeats a %s edit', async outcome => {
    const f = fixture(); f.crm.update.mockResolvedValue({ outcome });
    expect(await f.update()).toMatchObject({ outcome });
    expect(await f.update()).toMatchObject({ outcome });
    expect(f.crm.update).toHaveBeenCalledOnce();
  });
  it('keeps a dispatched edit uncertain if saving its receipt fails', async () => {
    const f = fixture(); f.deps.finish = vi.fn(async () => { throw new Error('storage failure'); });
    expect(await f.update()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await f.update()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.crm.update).toHaveBeenCalledOnce();
  });
  it('retains the result but withholds success when the grant is revoked after dispatch', async () => {
    const f = fixture(); const implementation = f.crm.update.getMockImplementation()!;
    f.crm.update.mockImplementation(async (...input) => { const result = await implementation(...input); f.actor.scopes = []; return result; });
    expect(await f.update()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.receipts.get(editId)).toMatchObject({ state: 'updated', resource_id: id });
    expect(await f.update()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).toHaveBeenCalledOnce();
  });
  it('undoes only the saved changed fields while retaining both original and compensation receipts', async () => {
    const f = fixture(); await f.update();
    expect(await f.undo()).toMatchObject({ outcome: 'rolled_back', data: { id, undo_available: false } });
    expect(f.crm.update.mock.calls[1][1]).toEqual({ budget: '20 rs/sqft per month' });
    expect(f.live.budget).toBe('20 rs/sqft per month');
    expect(f.receipts.get(editId)).toMatchObject({ state: 'updated' });
    expect(f.receipts.get(undoId)).toMatchObject({ state: 'undone' });
    expect(await f.undo()).toMatchObject({ outcome: 'replayed' });
    expect(f.crm.update).toHaveBeenCalledTimes(2);
    expect(f.crm.undoCreate).not.toHaveBeenCalled();
  });
  it.each(['later-edit', 'no-snapshot', 'tampered', 'cross-actor', 'wrong-record', 'forbidden-before'] as const)('refuses %s undo without issuing another mutation', async reason => {
    const f = fixture(); await f.update(); const stored = f.receipts.get(editId)!;
    if (reason === 'later-edit') f.live.updatedAt = restoredVersion;
    if (reason === 'no-snapshot') stored.encrypted_snapshot = null;
    if (reason === 'tampered') stored.encrypted_snapshot += 'x';
    if (reason === 'cross-actor') f.actor.employeeId += 1;
    if (reason === 'wrong-record') f.snapshot(stored, { kind: 'update', record_id: otherId, after_updated_at: editedVersion, before: { budget: '20' } });
    if (reason === 'forbidden-before') f.snapshot(stored, { kind: 'update', record_id: id, after_updated_at: editedVersion, before: { ownerId: otherId } });
    expect(await f.undo()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).toHaveBeenCalledOnce(); expect(f.crm.undoCreate).not.toHaveBeenCalled();
  });
  it('refuses historical creation undo without a captured version but permits guarded undo for a new creation', async () => {
    const f = fixture(); const input = { ...undoArgs, original_operation_id: creationId };
    expect(await f.undo(input)).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.undoCreate).not.toHaveBeenCalled();
    f.snapshot(f.created, { kind: 'create', record_id: id, after_updated_at: originalVersion });
    expect(await f.undo(input)).toMatchObject({ outcome: 'rolled_back', data: { id, undo_available: false } });
    expect(f.crm.undoCreate).toHaveBeenCalledOnce(); expect(f.crm.update).not.toHaveBeenCalled();
    expect(f.receipts.get(creationId)).toMatchObject({ state: 'created' });
    expect(f.receipts.get(undoId)).toMatchObject({ state: 'undone' });
  });
  it('does not undo creation after the RFQ progresses beyond its intake stage', async () => {
    const f = fixture(); f.snapshot(f.created, { kind: 'create', record_id: id, after_updated_at: originalVersion });
    f.live.stage = 'PROPOSAL';
    expect(await f.undo({ ...undoArgs, original_operation_id: creationId })).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.undoCreate).not.toHaveBeenCalled();
  });
});
