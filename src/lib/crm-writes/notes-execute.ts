import { randomUUID } from 'node:crypto';
import type { KeyRegistration } from '../auth';
import { HttpError } from '../errors';
import { argumentsSha256 } from '../mcp-read-contract';
import { noteCreateInputSchema, noteUpdateInputSchema, noteUndoInputSchema, noteDeleteInputSchema, noteText, type NoteContent, type NoteResult, type NoteResultData } from './notes';
import { crmNotesConfiguration, crmNotesDeleteConfiguration } from './notes-client';
import { assertNote, noteAuthorizer, noteDeal, noteDependencies, noteSnapshot, ownedNote, recheckNoteActor, sameNoteActor,
  type NoteDependencies, type NoteRevalidate, type NoteSnapshot } from './notes-access';
import { encryptCrmSnapshot } from './snapshots';
import type { CrmWriteReceipt } from './storage';

type Action = 'create_crm_note' | 'update_crm_note' | 'undo_crm_note' | 'delete_crm_note';
export const executeCrmNoteCreate = (raw: unknown, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate = async () => {}, overrides: Partial<NoteDependencies> = {}) => execute('create_crm_note', raw, key, signal, revalidate, overrides);
export const executeCrmNoteUpdate = (raw: unknown, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate = async () => {}, overrides: Partial<NoteDependencies> = {}) => execute('update_crm_note', raw, key, signal, revalidate, overrides);
export const executeCrmNoteUndo = (raw: unknown, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate = async () => {}, overrides: Partial<NoteDependencies> = {}) => execute('undo_crm_note', raw, key, signal, revalidate, overrides);
export const executeCrmNoteDelete = (raw: unknown, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate = async () => {}, overrides: Partial<NoteDependencies> = {}) => execute('delete_crm_note', raw, key, signal, revalidate, overrides);

async function execute(action: Action, raw: unknown, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate,
  overrides: Partial<NoteDependencies>): Promise<NoteResult> {
  const deps = noteDependencies(overrides);
  const op = noteCreateInputSchema.shape.operation_id.safeParse(raw && typeof raw === 'object' && 'operation_id' in raw ? raw.operation_id : undefined);
  const operation = op.success ? op.data.toLowerCase() : '00000000-0000-4000-8000-000000000000';
  const result = (outcome: NoteResult['outcome'], code: string, message: string, data?: NoteResultData): NoteResult => ({ operation_id: operation, outcome, code, message, ...(data ? { data } : {}) });
  const unknown = () => result('outcome_unknown', 'CRM_NOTE_OUTCOME_UNKNOWN', 'The note action may have partly or fully completed. Preserve the same operation ID and arguments. Do not create another note or repeat the change; an administrator must reconcile an unresolved note/deal link.');
  const replay = (receipt: CrmWriteReceipt) => {
    if (['created', 'updated', 'undone', 'deleted'].includes(receipt.state)) return result('replayed', 'CRM_NOTE_REPLAYED', 'Original note action receipt. No request was sent again. Current note text is not disclosed by a historical receipt; use read_crm_note if still eligible.');
    if (receipt.state === 'rejected') return result('rejected', 'CRM_NOTE_REJECTED', 'The original note action was rejected. It was not sent again.');
    return unknown();
  };
  const parsed = action === 'create_crm_note' ? noteCreateInputSchema.safeParse(raw)
    : action === 'update_crm_note' ? noteUpdateInputSchema.safeParse(raw)
      : action === 'delete_crm_note' ? noteDeleteInputSchema.safeParse(raw) : noteUndoInputSchema.safeParse(raw);
  if (!parsed.success) return result('not_dispatched', 'CRM_NOTE_INVALID', 'Supply the exact deal, requested note text and original user request. Only the advertised fields are accepted.');
  const input = { ...parsed.data, operation_id: operation };
  if (!input.raw_text.trim() || (action === 'update_crm_note' && (!('title' in input) || input.title === undefined) && (!('body' in input) || input.body === undefined))) {
    return result('not_dispatched', 'CRM_NOTE_INVALID', 'Supply the original user request and at least one requested note field to change.');
  }
  let reserved = false;
  const authorize = noteAuthorizer(deps, key, signal, revalidate);
  try {
    crmNotesConfiguration(deps.env);
    if (action === 'delete_crm_note') crmNotesDeleteConfiguration(deps.env);
    const hash = argumentsSha256(input), dealId = input.deal_id.toLowerCase();
    const { actor, stored, original } = await deps.readTransaction(async client => {
      const actor = await authorize(client);
      const stored = await deps.find(client, actor, operation, hash, action);
      const original = !stored && 'original_operation_id' in input ? await deps.load(client, actor, input.original_operation_id.toLowerCase()) : null;
      return { actor, stored, original };
    });
    if (stored) return replay(stored);
    // Keep the original operation/hash recovery contract, but never reserve or
    // dispatch new note trash: the provider cannot atomically guard deal links.
    if (action === 'delete_crm_note') return result('not_dispatched', 'CRM_NOTE_DELETE_UNAVAILABLE',
      'Note trash is unavailable because a concurrent deal link cannot be protected. This tool only recovers an existing deletion operation with its original ID and unchanged arguments. Manage new note deletion in CRM; do not substitute undo or create another operation.');
    const creator = await deps.crm.creator(actor, signal);
    let originalSnapshot: NoteSnapshot | undefined;
    if ('original_operation_id' in input) {
      if (!original || !['create_crm_note', 'update_crm_note'].includes(original.action) || !['created', 'updated'].includes(original.state)) {
        throw new HttpError(409, 'CRM_NOTE_UNDO_UNAVAILABLE', 'Only a successful note creation or edit by this agent for you can be undone.');
      }
      originalSnapshot = noteSnapshot(original, deps.env);
      if (originalSnapshot.deal_id !== dealId) throw new HttpError(403, 'CRM_NOTE_DEAL_MISMATCH', 'That note action belongs to a different deal.');
    }
    const noteId = 'note_id' in input ? input.note_id.toLowerCase() : originalSnapshot?.note_id ?? randomUUID();
    const own = action === 'create_crm_note' ? undefined : await ownedNote(deps, actor, noteId, dealId);
    const targetId = own?.saved.target_id ?? randomUUID();
    // Resolve live authorization before accessing note contents or reserving any mutation.
    let deal = await noteDeal(deps, actor, dealId, signal);
    const current = own ? await deps.crm.read(noteId, dealId, targetId, signal) : undefined;
    if (current && own) assertNote(current, own.saved, actor);
    if ('note_id' in input && input.expected_updated_at !== current!.updatedAt) {
      throw new HttpError(409, 'CRM_NOTE_VERSION_CONFLICT', 'The note changed since the supplied version. Read the current note before changing it.');
    }
    if (originalSnapshot && current) {
      assertNote(current, originalSnapshot, actor);
      if (originalSnapshot.target_id !== targetId) throw new HttpError(409, 'CRM_NOTE_UNDO_UNAVAILABLE', 'The original deal link changed.');
    }
    const undoCreation = action === 'undo_crm_note' && originalSnapshot?.kind === 'create';
    const before = current ? noteText(current) : undefined;
    let desired: NoteContent;
    if ('original_operation_id' in input) {
      desired = undoCreation ? before! : originalSnapshot!.before!;
    } else if ('note_id' in input) desired = {
      title: 'title' in input && typeof input.title === 'string' ? input.title : before!.title,
      body: 'body' in input && typeof input.body === 'string' ? input.body : before!.body,
    };
    else desired = { title: input.title, body: input.body };
    const snapshotContext = { employeeId: actor.employeeId, email: actor.email, memberId: actor.twentyUserId!, operationId: operation, action, requestHash: hash };
    // Preassigned IDs and the before-image commit before either creation request.
    // A partial note/link creation is never automatically retried with replacement IDs.
    const pending = encryptCrmSnapshot({ kind: 'pending', note_id: noteId, target_id: targetId, deal_id: dealId,
      desired, ...(before ? { before, before_updated_at: current!.updatedAt, target_updated_at: current!.targetUpdatedAt } : {}) }, snapshotContext, deps.env);
    await recheckNoteActor(deps, authorize, actor);
    deal = await noteDeal(deps, actor, dealId, signal);
    const claimed = await deps.writeTransaction(async client => {
      sameNoteActor(await authorize(client), actor);
      return deps.claim(client, actor, operation, hash, action, pending);
    });
    reserved = true;
    if (!claimed.fresh) return replay(claimed.receipt);
    signal.throwIfAborted();
    const changed = action === 'create_crm_note'
      ? await deps.crm.create(noteId, targetId, dealId, desired, creator, signal)
      : undoCreation ? await deps.crm.undoCreate(current!, dealId, targetId, signal)
        : await deps.crm.update(current!, dealId, targetId, desired, signal);
    const expectedOutcome = action === 'create_crm_note' ? 'created' : undoCreation ? 'rolled_back' : 'updated';
    const success = changed.outcome === expectedOutcome;
    if (!success) {
      const outcome = changed.outcome === 'rejected' ? 'rejected' : 'outcome_unknown';
      await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, action, { outcome }));
      await recheckNoteActor(deps, authorize, actor);
      return outcome === 'rejected' ? result('rejected', 'code' in changed && changed.code ? changed.code : 'CRM_NOTE_REJECTED', 'No note action was applied. Read the current note and check access before another attempt.') : unknown();
    }
    const verified = 'record' in changed ? changed.record : current!;
    // Quote provider-verified text, never an imagined completion or the tool input alone.
    const text = noteText(verified);
    const snapshot: NoteSnapshot = { kind: action === 'create_crm_note' ? 'create' : action === 'update_crm_note' ? 'update' : 'undo',
      note_id: noteId, deal_id: dealId, target_id: targetId, target_updated_at: verified.targetUpdatedAt,
      after_updated_at: verified.updatedAt, after: text,
      ...(action === 'update_crm_note' ? { before } : {}), ...(action === 'undo_crm_note' ? { undo_kind: undoCreation ? 'creation' as const : 'edit' as const } : {}) };
    const outcome = action === 'create_crm_note' ? 'created' : action === 'update_crm_note' ? 'updated' : 'rolled_back';
    await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, action, { outcome, id: noteId,
      encryptedSnapshot: encryptCrmSnapshot(snapshot, snapshotContext, deps.env) }));
    await recheckNoteActor(deps, authorize, actor);
    deal = await noteDeal(deps, actor, dealId, signal);
    return result(outcome, action === 'create_crm_note' ? 'CRM_NOTE_CREATED' : action === 'update_crm_note' ? 'CRM_NOTE_UPDATED' : 'CRM_NOTE_UNDONE',
      action === 'create_crm_note' ? 'Added the verified note to this deal.' : action === 'update_crm_note' ? 'Updated this note on this deal.'
        : undoCreation ? 'Removed the note from this deal. The note itself and any other links were not deleted.' : 'Restored the note text from before that edit.',
      { id: noteId, deal, note: text, updated_at: verified.updatedAt, undo_available: action === 'create_crm_note' || action === 'update_crm_note',
        ...(snapshot.undo_kind ? { undo_kind: snapshot.undo_kind } : {}), ...(snapshot.deletion_kind ? { deletion_kind: snapshot.deletion_kind } : {}) });
  } catch (error) {
    if (reserved) return unknown();
    if (error instanceof HttpError) return result('not_dispatched', error.code, error.message);
    return result('not_dispatched', signal.aborted ? 'CRM_CANCELLED' : 'CRM_NOTE_UNAVAILABLE', 'No note mutation was dispatched by this attempt. Check current access and the saved note before retrying.');
  }
}
