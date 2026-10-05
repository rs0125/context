import { z } from 'zod';
import type { PoolClient } from 'pg';
import { requireScope, resolvePrincipal, type KeyRegistration, type Principal } from '../auth';
import { withReadOnlyTransaction, withCrmWriteTransaction } from '../db';
import { assertCrmAccess, getLiveCrmAccess } from '../crm-live';
import { HttpError } from '../errors';
import { redactCrmText } from '../crm-redaction';
import { rfqRecordUrl, rfqVersionSchema } from './changes';
import { CRM_NOTE_SCOPE, noteContentSchema, noteText, type NoteLive } from './notes';
import { CrmNoteClient, crmNotesConfiguration } from './notes-client';
import { claimCrmChange, findAgentCreatedNote, findCrmChange, finishCrmChange, listCrmNoteChanges, loadCrmChange, type CrmWriteReceipt } from './storage';
import { crmSnapshotContext, decryptCrmSnapshot } from './snapshots';
import { sameActor } from './change-access';

export type NoteDependencies = {
  readTransaction: typeof withReadOnlyTransaction; writeTransaction: typeof withCrmWriteTransaction;
  principal: typeof resolvePrincipal; liveAccess: typeof getLiveCrmAccess;
  find: typeof findCrmChange; claim: typeof claimCrmChange; finish: typeof finishCrmChange;
  origin: typeof findAgentCreatedNote; load: typeof loadCrmChange; list: typeof listCrmNoteChanges;
  crm: Pick<CrmNoteClient, 'creator' | 'deal' | 'read' | 'create' | 'update' | 'undoCreate' | 'trash'>;
  env: Partial<NodeJS.ProcessEnv>;
};
export type NoteRevalidate = (client: PoolClient, key: KeyRegistration) => Promise<void>;
export function noteDependencies(overrides: Partial<NoteDependencies>): NoteDependencies {
  const env = overrides.env ?? process.env;
  return { readTransaction: withReadOnlyTransaction, writeTransaction: withCrmWriteTransaction, principal: resolvePrincipal,
    liveAccess: getLiveCrmAccess, find: findCrmChange, claim: claimCrmChange, finish: finishCrmChange,
    origin: findAgentCreatedNote, load: loadCrmChange, list: listCrmNoteChanges, crm: new CrmNoteClient(env), env, ...overrides };
}
export function noteAuthorizer(deps: NoteDependencies, key: KeyRegistration, signal: AbortSignal, revalidate: NoteRevalidate) {
  return async (client: PoolClient): Promise<Principal> => {
    signal.throwIfAborted(); await revalidate(client, key);
    const actor = await deps.principal(client, key);
    requireScope(actor, CRM_NOTE_SCOPE); requireScope(actor, 'crm:read');
    if (!actor.twentyUserId) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A current linked CRM member is required.');
    return actor;
  };
}
export async function noteDeal(deps: NoteDependencies, actor: Principal, id: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const access = await deps.liveAccess(actor, { opportunityId: id, view: 'accessible', env: deps.env });
  assertCrmAccess(actor, access);
  if (access.mode === 'related' && !access.ids.includes(id)) throw new HttpError(403, 'CRM_DEAL_NOT_ACCESSIBLE', 'This deal is not currently accessible to you.');
  signal.throwIfAborted();
  const live = await deps.crm.deal(id, signal);
  if (live.id.toLowerCase() !== id || live.deletedAt !== null) throw new HttpError(403, 'CRM_DEAL_NOT_ACCESSIBLE', 'This deal is not currently available.');
  return { id, name: redactCrmText(live.name, { maxCharacters: 500 }).text || 'CRM deal', url: rfqRecordUrl(id, crmNotesConfiguration(deps.env).origin) };
}
export const noteSnapshotSchema = z.object({ kind: z.enum(['create', 'update', 'undo', 'delete']),
  note_id: z.string().uuid(), deal_id: z.string().uuid(), target_id: z.string().uuid(),
  target_updated_at: rfqVersionSchema, after_updated_at: rfqVersionSchema,
  after: noteContentSchema, before: noteContentSchema.optional(), undo_kind: z.enum(['creation', 'edit']).optional(),
  deletion_kind: z.enum(['deal_link', 'note']).optional(),
}).strict();
export type NoteSnapshot = z.infer<typeof noteSnapshotSchema>;
export function noteSnapshot(receipt: CrmWriteReceipt, env: Partial<NodeJS.ProcessEnv>): NoteSnapshot {
  if (!receipt.encrypted_snapshot || !receipt.action.endsWith('_crm_note')) throw new HttpError(409, 'CRM_NOTE_RECEIPT_UNAVAILABLE', 'The original note receipt could not be verified.');
  const snapshot = noteSnapshotSchema.parse(decryptCrmSnapshot(receipt.encrypted_snapshot, crmSnapshotContext(receipt), env));
  const kinds = { create_crm_note: 'create', update_crm_note: 'update', undo_crm_note: 'undo', delete_crm_note: 'delete' };
  if (snapshot.note_id !== receipt.resource_id || kinds[receipt.action as keyof typeof kinds] !== snapshot.kind
    || (snapshot.kind === 'update' && !snapshot.before) || (snapshot.kind === 'undo' && !snapshot.undo_kind)
    || (snapshot.kind === 'delete' && !snapshot.deletion_kind)) {
    throw new HttpError(409, 'CRM_NOTE_RECEIPT_UNAVAILABLE', 'The saved note change does not match its receipt.');
  }
  return snapshot;
}
export function assertNote(record: NoteLive, saved: NoteSnapshot, actor: Principal) {
  if (record.id !== saved.note_id || record.deletedAt !== null
    || record.createdBy.workspaceMemberId?.toLowerCase() !== actor.twentyUserId?.toLowerCase()) {
    throw new HttpError(403, 'CRM_NOTE_NOT_EDITABLE', 'Only your own notes created by this agent can be changed.');
  }
  const text = noteText(record);
  if (saved.after_updated_at !== record.updatedAt || saved.target_updated_at !== record.targetUpdatedAt
    || saved.after.title !== text.title || saved.after.body !== text.body) {
    throw new HttpError(409, 'CRM_NOTE_CHANGED', 'This note or its deal link changed outside this saved action. Nothing was overwritten. Review it in CRM.');
  }
}
export async function ownedNote(deps: NoteDependencies, actor: Principal, noteId: string, dealId: string) {
  return deps.readTransaction(async client => {
    const origin = await deps.origin(client, actor, noteId);
    if (!origin) throw new HttpError(403, 'CRM_NOTE_NOT_EDITABLE', 'Only notes created by this agent for you can be edited, removed or undone.');
    const first = noteSnapshot(origin, deps.env);
    if (first.deal_id !== dealId) throw new HttpError(403, 'CRM_NOTE_DEAL_MISMATCH', 'That note was not added by this agent to this deal.');
    const recent = await deps.list(client, actor, 1, noteId);
    const current = noteSnapshot(recent[0] ?? origin, deps.env);
    if (current.deal_id !== dealId || current.note_id !== noteId || current.target_id !== first.target_id) throw new HttpError(409, 'CRM_NOTE_RECEIPT_UNAVAILABLE', 'The note history could not be verified.');
    if (current.kind === 'delete' || (current.kind === 'undo' && current.undo_kind === 'creation')) {
      throw new HttpError(409, 'CRM_NOTE_REMOVED', 'This note was already removed from this deal. No further change is available here.');
    }
    return { origin, latest: recent[0] ?? origin, saved: current };
  });
}
export async function recheckNoteActor(deps: NoteDependencies, authorize: (client: PoolClient) => Promise<Principal>, actor: Principal) {
  sameNoteActor(await deps.readTransaction(authorize), actor);
}
export function sameNoteActor(current: Principal, actor: Principal) {
  sameActor(current, actor);
  if (current.isAnalyst !== actor.isAnalyst) throw new HttpError(403, 'CRM_ACCESS_CHANGED', 'CRM access changed during the request.');
}
