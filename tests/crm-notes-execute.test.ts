import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';
import type { NoteDependencies } from '../src/lib/crm-writes/notes-access';
import { executeCrmNoteCreate, executeCrmNoteDelete, executeCrmNoteUndo, executeCrmNoteUpdate } from '../src/lib/crm-writes/notes-execute';
import { listCrmNoteChanges, readCrmNote } from '../src/lib/crm-writes/notes-read';
import { noteBodyPayload } from '../src/lib/crm-writes/notes-client';
import type { NoteLive } from '../src/lib/crm-writes/notes';
import { crmSnapshotContext, decryptCrmSnapshot, encryptCrmSnapshot } from '../src/lib/crm-writes/snapshots';
import type { CrmWriteReceipt } from '../src/lib/crm-writes/storage';

const dealId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const createOp = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const updateOp = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const undoOp = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const deleteOp = '11111111-1111-4111-8111-111111111111';
const version = '2026-10-05T08:00:00.000Z', nextVersion = '2026-10-05T08:01:00.000Z';
const args = { operation_id: createOp, deal_id: dealId, title: 'Site visit', body: '  Client needs two docks.\nVisit on Tuesday.  ',
  raw_text: 'Add a note: Client needs two docks. Visit on Tuesday.' };
const principal: Principal = { employeeId: 7, email: 'employee@wareongo.com', twentyUserId: memberId,
  scopes: ['crm:read', 'crm.notes:write'], keyId: 'test', isAnalyst: false };
const key: KeyRegistration = { id: 'test', hash: 'a'.repeat(64), employeeId: 7, employeeEmail: principal.email,
  scopes: ['crm:read', 'crm.notes:write'], expiresAt: '2099-01-01T00:00:00Z' };
const signal = () => new AbortController().signal;
function fixture() {
  const actor = structuredClone(principal);
  const receipts = new Map<string, CrmWriteReceipt>(), notes = new Map<string, NoteLive>(), removed = new Set<string>();
  let accessible = true, mutationSequence = 0;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONTEXT_CRM_NOTES_ENABLED: 'true', CONTEXT_CRM_DELETES_ENABLED: 'true',
    CONTEXT_CRM_RFQ_WRITES_ENABLED: 'false', CONTEXT_CRM_WRITE_API_KEY: 'synthetic', TWENTY_CRM_BASE_URL: 'https://crm.example.test',
    CONTEXT_KEY_ENCRYPTION_SECRET: 'synthetic-note-encryption-secret-32-characters-long' };
  const client = {} as PoolClient;
  const transaction = async <T,>(work: (c: PoolClient) => Promise<T>) => work(client);
  const belongsTo = (receipt: CrmWriteReceipt, current: Principal) => receipt.employee_id === current.employeeId
    && receipt.employee_email === current.email && receipt.member_id === current.twentyUserId;
  const crm = {
    creator: vi.fn<NoteDependencies['crm']['creator']>(async () => ({ id: memberId, name: 'Synthetic Employee' })),
    deal: vi.fn<NoteDependencies['crm']['deal']>(async id => ({ id, name: 'Test Logistics - Hoskote', updatedAt: version, deletedAt: null })),
    read: vi.fn<NoteDependencies['crm']['read']>(async id => {
      if (!notes.has(id) || removed.has(id)) throw new HttpError(404, 'CRM_NOTE_NOT_FOUND', 'Missing note.');
      return structuredClone(notes.get(id)!);
    }),
    create: vi.fn<NoteDependencies['crm']['create']>(async (id, _target, _deal, content, creator) => {
      const record: NoteLive = { id, updatedAt: version, targetUpdatedAt: version, deletedAt: null,
        title: content.title, bodyV2: noteBodyPayload(content.body), createdBy: { workspaceMemberId: creator.id } };
      notes.set(id, record);
      return { outcome: 'created', record: structuredClone(record) };
    }),
    update: vi.fn<NoteDependencies['crm']['update']>(async (current, _deal, _target, content) => {
      const record = notes.get(current.id)!;
      if (record.updatedAt !== current.updatedAt) return { outcome: 'rejected', code: 'CRM_NOTE_VERSION_CONFLICT' };
      Object.assign(record, { title: content.title, bodyV2: noteBodyPayload(content.body),
        updatedAt: new Date(Date.parse(nextVersion) + mutationSequence++ * 60_000).toISOString() });
      return { outcome: 'updated', record: structuredClone(record) };
    }),
    undoCreate: vi.fn<NoteDependencies['crm']['undoCreate']>(async current => { removed.add(current.id); return { outcome: 'rolled_back' }; }),
    trash: vi.fn<NoteDependencies['crm']['trash']>(async current => {
      const record = structuredClone(notes.get(current.id)!);
      notes.get(current.id)!.deletedAt = nextVersion; removed.add(current.id);
      return { outcome: 'deleted', record };
    }),
  };
  const deps: NoteDependencies = { env, crm, readTransaction: transaction, writeTransaction: transaction,
    principal: vi.fn(async () => structuredClone(actor)),
    liveAccess: vi.fn(async () => ({ mode: 'related' as const, memberId, ids: accessible ? [dealId] : [] })),
    find: vi.fn(async (_client, current, operation, hash, action) => {
      const stored = receipts.get(operation);
      if (!stored) return null;
      if (!belongsTo(stored, current) || stored.request_hash !== hash || stored.action !== action) throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation conflict.');
      return structuredClone(stored);
    }),
    claim: vi.fn(async (_client, current, operation, hash, action, encryptedSnapshot) => {
      const stored = receipts.get(operation);
      if (stored) {
        if (!belongsTo(stored, current) || stored.request_hash !== hash || stored.action !== action) throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'Operation conflict.');
        return { fresh: false, receipt: structuredClone(stored) };
      }
      const receipt: CrmWriteReceipt = { employee_id: current.employeeId, employee_email: current.email, member_id: current.twentyUserId!,
        operation_id: operation, action, request_hash: hash, state: 'dispatching', resource_id: null, encrypted_snapshot: encryptedSnapshot ?? null };
      receipts.set(operation, receipt); return { fresh: true, receipt: structuredClone(receipt) };
    }),
    finish: vi.fn(async (_client, _current, operation, _hash, _action, result) => {
      const receipt = receipts.get(operation)!;
      receipt.state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome === 'rolled_back' ? 'undone' : result.outcome;
      receipt.resource_id = 'id' in result ? result.id : null;
      if (result.encryptedSnapshot) receipt.encrypted_snapshot = result.encryptedSnapshot;
    }),
    origin: vi.fn(async (_client, current, id) => {
      const found = [...receipts.values()].find(receipt => belongsTo(receipt, current) && receipt.resource_id === id && receipt.action === 'create_crm_note' && receipt.state === 'created');
      return found ? structuredClone(found) : null;
    }),
    load: vi.fn(async (_client, current, operation) => {
      const found = receipts.get(operation); return found && belongsTo(found, current) ? structuredClone(found) : null;
    }),
    list: vi.fn(async (_client, current, limit, noteId) => [...receipts.values()].reverse().filter(receipt => belongsTo(receipt, current)
      && ['created', 'updated', 'undone', 'deleted'].includes(receipt.state) && (noteId === undefined || receipt.resource_id === noteId)).slice(0, limit)),
  };
  const noteId = () => receipts.get(createOp)!.resource_id!;
  const updateArgs = () => ({ operation_id: updateOp, deal_id: dealId, note_id: noteId(), expected_updated_at: notes.get(noteId())!.updatedAt,
    body: 'Client needs three docks.', raw_text: 'Change my note to three docks.' });
  const undoArgs = () => ({ operation_id: undoOp, deal_id: dealId, original_operation_id: updateOp, raw_text: 'Undo the last note change' });
  const deleteArgs = () => ({ operation_id: deleteOp, deal_id: dealId, note_id: noteId(), expected_updated_at: notes.get(noteId())!.updatedAt,
    raw_text: 'Delete this note' });
  return { actor, env, deps, crm, notes, receipts, removed, noteId, updateArgs, undoArgs, deleteArgs, setAccessible: (value: boolean) => { accessible = value; },
    create: (input: unknown = args, abort = signal()) => executeCrmNoteCreate(input, key, abort, undefined, deps),
    update: (input: unknown = updateArgs()) => executeCrmNoteUpdate(input, key, signal(), undefined, deps),
    undo: (input: unknown = undoArgs()) => executeCrmNoteUndo(input, key, signal(), undefined, deps),
    delete: (input: unknown = deleteArgs()) => executeCrmNoteDelete(input, key, signal(), undefined, deps),
    read: (input: unknown = { deal_id: dealId, note_id: noteId() }) => readCrmNote(input, key, signal(), undefined, deps),
    list: () => listCrmNoteChanges({ deal_id: dealId }, key, signal(), undefined, deps) };
}

describe('deal note write authorization and reliable receipts', () => {
  it('adds a note to a currently accessible deal with actual saved text and an unambiguous deal receipt', async () => {
    const f = fixture(), result = await f.create();
    expect(result).toMatchObject({ outcome: 'created', data: { id: f.noteId(),
      deal: { id: dealId, name: 'Test Logistics - Hoskote', url: `https://crm.example.test/object/opportunity/${dealId}` },
      note: { title: args.title, body: args.body }, undo_available: true } });
    expect(f.deps.origin).not.toHaveBeenCalled();
    expect(f.deps.liveAccess).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.deps.claim).mock.invocationCallOrder[0]).toBeLessThan(f.crm.create.mock.invocationCallOrder[0]);
  });
  it('commits preassigned note and target IDs before dispatch and keeps orphan outcomes terminal', async () => {
    const f = fixture(); f.crm.create.mockResolvedValue({ outcome: 'outcome_unknown' });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' });
    const receipt = f.receipts.get(createOp)!;
    const pending = decryptCrmSnapshot(receipt.encrypted_snapshot!, crmSnapshotContext(receipt), f.env);
    expect(pending).toMatchObject({ kind: 'pending', note_id: f.crm.create.mock.calls[0][0], target_id: f.crm.create.mock.calls[0][1], deal_id: dealId });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('replays a successful operation without disclosing historical text or calling CRM again', async () => {
    const f = fixture(); await f.create(); const calls = f.crm.deal.mock.calls.length;
    f.crm.deal.mockRejectedValue(new Error('Offline'));
    const replay = await f.create();
    expect(replay).toMatchObject({ outcome: 'replayed' }); expect(replay.data).toBeUndefined();
    expect(f.crm.deal).toHaveBeenCalledTimes(calls); expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it.each(['read-scope', 'note-scope', 'member', 'gate', 'encryption', 'crm-access'])('refuses missing %s before mutation', async reason => {
    const f = fixture();
    if (reason === 'read-scope') f.actor.scopes = ['crm.notes:write'];
    if (reason === 'note-scope') f.actor.scopes = ['crm:read', 'crm.rfq:write'];
    if (reason === 'member') f.actor.twentyUserId = null;
    if (reason === 'gate') f.env.CONTEXT_CRM_NOTES_ENABLED = 'false';
    if (reason === 'encryption') delete f.env.CONTEXT_KEY_ENCRYPTION_SECRET;
    if (reason === 'crm-access') f.setAccessible(false);
    expect(await f.create()).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('does not reserve a write after the employee loses deal access during preflight', async () => {
    const f = fixture(); f.crm.deal.mockImplementation(async id => { f.setAccessible(false); return { id, name: 'Test Logistics', updatedAt: version, deletedAt: null }; });
    expect(await f.create()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_DEAL_NOT_ACCESSIBLE' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('withholds success when deal access is lost after mutation but preserves the receipt', async () => {
    const f = fixture(), implementation = f.crm.create.getMockImplementation()!;
    f.crm.create.mockImplementation(async (...args) => { const result = await implementation(...args); f.setAccessible(false); return result; });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.receipts.get(createOp)).toMatchObject({ state: 'created' }); expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('detects Analyst privilege changes while authorizing a note write', async () => {
    const f = fixture(); f.actor.isAnalyst = true;
    f.crm.creator.mockImplementation(async () => { f.actor.isAnalyst = false; return { id: memberId, name: 'Employee' }; });
    expect(await f.create()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_ACCESS_CHANGED' });
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('admits one concurrent dispatch and rejects changed-argument reuse', async () => {
    const f = fixture(); await Promise.all([f.create(), f.create(), f.create()]);
    expect(f.crm.create).toHaveBeenCalledOnce();
    expect(await f.create({ ...args, body: 'Changed body' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
  });
  it('keeps receipt persistence failure uncertain without duplicating a saved note', async () => {
    const f = fixture(); f.deps.finish = vi.fn(async () => { throw new Error('storage failed'); });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' }); expect(f.crm.create).toHaveBeenCalledOnce();
  });
  it('does not dispatch a cancelled reserved creation on recovery', async () => {
    const f = fixture(), abort = new AbortController(), transaction = f.deps.writeTransaction;
    f.deps.writeTransaction = async work => { const result = await transaction(work); abort.abort(); return result; };
    expect(await f.create(args, abort.signal)).toMatchObject({ outcome: 'outcome_unknown' });
    expect(await f.create()).toMatchObject({ outcome: 'outcome_unknown' }); expect(f.crm.create).not.toHaveBeenCalled();
  });
  it('updates only the requested text field, preserving the verified title and full before-image', async () => {
    const f = fixture(); await f.create();
    expect(await f.update()).toMatchObject({ outcome: 'updated', data: { note: { title: args.title, body: 'Client needs three docks.' } } });
    expect(f.crm.update.mock.calls[0][3]).toEqual({ title: args.title, body: 'Client needs three docks.' });
    const receipt = f.receipts.get(updateOp)!;
    expect(decryptCrmSnapshot(receipt.encrypted_snapshot!, crmSnapshotContext(receipt), f.env)).toMatchObject({ before: { title: args.title, body: args.body } });
  });
  it.each(['other-note', 'other-deal', 'other-employee', 'other-member', 'changed-content', 'changed-target', 'stale-version'])('refuses %s edits before dispatch', async reason => {
    const f = fixture(); await f.create(); const input = f.updateArgs();
    if (reason === 'other-note') input.note_id = otherId;
    if (reason === 'other-deal') input.deal_id = otherId;
    if (reason === 'other-employee') f.actor.employeeId += 1;
    if (reason === 'other-member') f.actor.twentyUserId = otherId;
    if (reason === 'changed-content') f.notes.get(f.noteId())!.bodyV2 = noteBodyPayload('External update');
    if (reason === 'changed-target') f.notes.get(f.noteId())!.targetUpdatedAt = nextVersion;
    if (reason === 'stale-version') input.expected_updated_at = nextVersion;
    expect(await f.update(input)).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).not.toHaveBeenCalled();
  });
  it('refuses edits to arbitrary notes even for Analysts', async () => {
    const f = fixture(); f.actor.isAnalyst = true;
    expect(await f.update({ operation_id: updateOp, deal_id: dealId, note_id: otherId, expected_updated_at: version, title: 'Changed', raw_text: 'Change the title' }))
      .toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_NOT_EDITABLE' });
    expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'createdBy', 'noteTargets', 'bodyV2'])('rejects injected %s payloads', async field => {
    const f = fixture(); await f.create();
    expect(await f.update({ ...f.updateArgs(), [field]: 'injected' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_INVALID' });
    expect(f.crm.update).not.toHaveBeenCalled();
  });
  it('undoes an unchanged edit from its encrypted saved text without rewriting creation history', async () => {
    const f = fixture(); await f.create(); await f.update();
    expect(await f.undo()).toMatchObject({ outcome: 'rolled_back', data: { note: { title: args.title, body: args.body }, undo_kind: 'edit', undo_available: false } });
    expect(f.crm.update).toHaveBeenCalledTimes(2); expect(f.crm.undoCreate).not.toHaveBeenCalled();
    expect(f.receipts.get(updateOp)).toMatchObject({ state: 'updated' }); expect(f.receipts.get(undoOp)).toMatchObject({ state: 'undone' });
  });
  it('undoes addition by unlinking the note from its original deal and retains note text in the result', async () => {
    const f = fixture(); await f.create();
    expect(await f.undo({ ...f.undoArgs(), original_operation_id: createOp })).toMatchObject({ outcome: 'rolled_back', data: {
      deal: { id: dealId }, note: { title: args.title, body: args.body }, undo_kind: 'creation', undo_available: false } });
    expect(f.crm.undoCreate).toHaveBeenCalledOnce(); expect(f.crm.update).not.toHaveBeenCalled();
    expect(f.notes.get(f.noteId())?.deletedAt).toBeNull();
  });
  it.each(['later-edit', 'wrong-deal', 'tampered', 'wrong-actor'])('refuses %s undo without touching the note', async reason => {
    const f = fixture(); await f.create(); await f.update(); const input = f.undoArgs();
    if (reason === 'later-edit') f.notes.get(f.noteId())!.updatedAt = '2026-10-05T08:09:00.000Z';
    if (reason === 'wrong-deal') input.deal_id = otherId;
    if (reason === 'tampered') f.receipts.get(updateOp)!.encrypted_snapshot += 'x';
    if (reason === 'wrong-actor') f.actor.employeeId += 1;
    expect(await f.undo(input)).toMatchObject({ outcome: 'not_dispatched' });
    expect(f.crm.update).toHaveBeenCalledOnce(); expect(f.crm.undoCreate).not.toHaveBeenCalled();
  });
  it('refuses an old creation undo after a successful note edit', async () => {
    const f = fixture(); await f.create(); await f.update();
    expect(await f.undo({ ...f.undoArgs(), original_operation_id: createOp })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_CHANGED' });
    expect(f.crm.undoCreate).not.toHaveBeenCalled();
  });
  it('verifies original note provenance even when a latest snapshot is internally valid but belongs to another deal', async () => {
    const f = fixture(); await f.create(); await f.update(); const receipt = f.receipts.get(updateOp)!;
    const snapshot = decryptCrmSnapshot(receipt.encrypted_snapshot!, crmSnapshotContext(receipt), f.env);
    receipt.encrypted_snapshot = encryptCrmSnapshot({ ...snapshot, deal_id: otherId }, crmSnapshotContext(receipt), f.env);
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_NOTE_RECEIPT_UNAVAILABLE' });
  });
});

describe('own-agent note read and history disclosure', () => {
  it('returns the current verified saved note with the exact deal and versions', async () => {
    const f = fixture(); await f.create();
    expect(await f.read()).toMatchObject({ id: f.noteId(), note: { title: args.title, body: args.body }, deal: { id: dealId }, updated_at: version });
  });
  it('checks live deal access before reading note text and again before releasing it', async () => {
    const f = fixture(); await f.create(); f.crm.read.mockClear(); f.setAccessible(false);
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_DEAL_NOT_ACCESSIBLE' }); expect(f.crm.read).not.toHaveBeenCalled();
    f.setAccessible(true); const read = f.crm.read.getMockImplementation()!;
    f.crm.read.mockImplementation(async (...args) => { const result = await read(...args); f.setAccessible(false); return result; });
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_DEAL_NOT_ACCESSIBLE' });
  });
  it('does not convert history read outages into an empty history', async () => {
    const f = fixture(); await f.create(); f.crm.read.mockRejectedValue(new HttpError(503, 'CRM_NOTE_UNAVAILABLE', 'Upstream unavailable.'));
    await expect(f.list()).rejects.toMatchObject({ code: 'CRM_NOTE_UNAVAILABLE' });
  });
  it('withholds known shared or changed notes from history without exposing saved body text', async () => {
    const f = fixture(); await f.create(); f.crm.read.mockRejectedValue(new HttpError(409, 'CRM_NOTE_LINK_CHANGED', 'Shared note.'));
    const history = await f.list(); expect(history.items).toEqual([]); expect(JSON.stringify(history)).not.toContain(args.body);
  });
});

describe('recovery-only note trash', () => {
  async function savedDeletion(state: 'deleted' | 'rejected' | 'dispatching' | 'unknown') {
    const f = fixture(); await f.create();
    const input = f.deleteArgs(), original = f.receipts.get(createOp)!;
    const receipt: CrmWriteReceipt = { ...original, operation_id: deleteOp, action: 'delete_crm_note',
      request_hash: argumentsSha256(input), state, resource_id: state === 'deleted' ? f.noteId() : null,
      encrypted_snapshot: null };
    if (state === 'deleted') {
      const created = decryptCrmSnapshot(original.encrypted_snapshot!, crmSnapshotContext(original), f.env) as Record<string, unknown>;
      receipt.encrypted_snapshot = encryptCrmSnapshot({ ...created, kind: 'delete', deletion_kind: 'note' }, crmSnapshotContext(receipt), f.env);
    }
    f.receipts.set(deleteOp, receipt);
    for (const method of Object.values(f.crm)) method.mockClear();
    vi.mocked(f.deps.claim).mockClear(); vi.mocked(f.deps.finish).mockClear();
    return { ...f, input };
  }
  it.each(['creation', 'edit', 'undo-edit'])('blocks a new deletion after %s without reading CRM, reserving or substituting undo', async step => {
    const f = fixture(); await f.create();
    if (step !== 'creation') await f.update();
    if (step === 'undo-edit') await f.undo();
    const before = structuredClone(f.notes), receipts = structuredClone(f.receipts);
    for (const method of Object.values(f.crm)) method.mockClear();
    vi.mocked(f.deps.claim).mockClear(); vi.mocked(f.deps.finish).mockClear();
    expect(await f.delete()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_DELETE_UNAVAILABLE' });
    for (const method of Object.values(f.crm)) expect(method).not.toHaveBeenCalled();
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.deps.finish).not.toHaveBeenCalled();
    expect(f.notes).toEqual(before); expect(f.receipts).toEqual(receipts);
  });
  it.each(['deleted', 'rejected', 'dispatching', 'unknown'] as const)('recovers an existing %s receipt without changing it or calling CRM', async state => {
    const f = await savedDeletion(state), before = structuredClone(f.receipts);
    const output = await f.delete(f.input);
    expect(output).toMatchObject({ operation_id: deleteOp,
      outcome: state === 'deleted' ? 'replayed' : state === 'rejected' ? 'rejected' : 'outcome_unknown' });
    expect(output.data).toBeUndefined(); expect(JSON.stringify(output)).not.toContain(args.body);
    expect(f.deps.find).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ employeeId: 7 }),
      deleteOp, argumentsSha256(f.input), 'delete_crm_note');
    for (const method of Object.values(f.crm)) expect(method).not.toHaveBeenCalled();
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.deps.finish).not.toHaveBeenCalled();
    expect(f.receipts).toEqual(before);
  });
  it.each(['deal_id', 'note_id', 'expected_updated_at', 'raw_text'] as const)('rejects changed recovery argument %s', async field => {
    const f = await savedDeletion('unknown');
    const changed = { ...f.input, [field]: field === 'expected_updated_at' ? nextVersion : field === 'raw_text' ? 'A different request' : otherId };
    expect(await f.delete(changed)).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_OPERATION_CONFLICT' });
    for (const method of Object.values(f.crm)) expect(method).not.toHaveBeenCalled();
    expect(f.deps.claim).not.toHaveBeenCalled();
  });
  it.each(['employee', 'email', 'member', 'read-scope', 'write-scope', 'delete-gate', 'notes-gate', 'key'] as const)('retains recovery identity and configuration boundary: %s', async reason => {
    const f = await savedDeletion('deleted');
    if (reason === 'employee') f.actor.employeeId += 1;
    if (reason === 'email') f.actor.email = 'someone@example.test';
    if (reason === 'member') f.actor.twentyUserId = otherId;
    if (reason === 'read-scope') f.actor.scopes = ['crm.notes:write'];
    if (reason === 'write-scope') f.actor.scopes = ['crm:read'];
    if (reason === 'delete-gate') f.env.CONTEXT_CRM_DELETES_ENABLED = 'false';
    if (reason === 'notes-gate') f.env.CONTEXT_CRM_NOTES_ENABLED = 'false';
    if (reason === 'key') delete f.env.CONTEXT_CRM_WRITE_API_KEY;
    const output = await f.delete(f.input);
    expect(output.outcome).toBe('not_dispatched'); expect(output.data).toBeUndefined();
    for (const method of Object.values(f.crm)) expect(method).not.toHaveBeenCalled();
  });
  it.each(['soft_delete', 'permanent', 'target_id', 'ownerId', 'body'])('rejects recovery parameter injection via %s', async field => {
    const f = await savedDeletion('unknown');
    expect(await f.delete({ ...f.input, [field]: 'injected' })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_INVALID' });
    for (const method of Object.values(f.crm)) expect(method).not.toHaveBeenCalled();
  });
  it('does not adopt a historically deleted note restored outside the agent', async () => {
    const f = await savedDeletion('deleted');
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_NOTE_REMOVED' });
    expect(await f.list()).toMatchObject({ items: [] });
    expect(await f.update()).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_REMOVED' });
    expect(await f.undo({ ...f.undoArgs(), original_operation_id: createOp })).toMatchObject({ outcome: 'not_dispatched', code: 'CRM_NOTE_REMOVED' });
    expect(f.crm.read).not.toHaveBeenCalled(); expect(f.crm.update).not.toHaveBeenCalled();
  });
});
