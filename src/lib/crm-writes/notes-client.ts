/** Fixed note/deal adapter. No arbitrary payloads, upsert, retries or permanent deletes. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import { crmWriteConnectionConfiguration, verifyCrmCreator } from './client';
import type { CrmCreator } from './rfq';
import { rfqVersionSchema } from './changes';
import { noteContentSchema, noteLiveSchema, type NoteContent, type NoteLive } from './notes';

const uuid = z.string().uuid();
const targetSchema = z.object({ id: uuid, noteId: uuid, targetOpportunityId: uuid.nullable(),
  targetCompanyId: uuid.nullable(), targetPersonId: uuid.nullable(), deletedAt: z.string().nullable(), updatedAt: rfqVersionSchema,
}).passthrough();
type Target = z.infer<typeof targetSchema>;
export type NoteMutationResult = { outcome: 'created' | 'updated' | 'deleted'; record: NoteLive }
  | { outcome: 'rolled_back' }
  | { outcome: 'rejected' | 'outcome_unknown'; code?: string };
const unknown = (): NoteMutationResult => ({ outcome: 'outcome_unknown' });
const conflict = (): NoteMutationResult => ({ outcome: 'rejected', code: 'CRM_NOTE_VERSION_CONFLICT' });
function unavailable(): never { throw new HttpError(503, 'CRM_NOTE_UNAVAILABLE', 'The current note and its deal link could not be verified.'); }
function incompatible(): never { throw new HttpError(409, 'CRM_NOTE_FORMAT_UNSUPPORTED', 'This note contains formatting or content that cannot safely be edited here. Open it in CRM.'); }
export function crmNotesConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (env.CONTEXT_CRM_NOTES_ENABLED !== 'true') throw new HttpError(503, 'CRM_NOTES_DISABLED', 'CRM note writing is not enabled.');
  return crmWriteConnectionConfiguration(env);
}
export function crmNotesAvailability(env: Partial<NodeJS.ProcessEnv> = process.env) {
  try { crmNotesConfiguration(env); return { available: true }; } catch { return { available: false }; }
}
export function crmNotesDeleteConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (env.CONTEXT_CRM_DELETES_ENABLED !== 'true') throw new HttpError(503, 'CRM_DELETES_DISABLED', 'CRM deletion is not enabled.');
  return crmNotesConfiguration(env);
}
export function crmNotesDeleteAvailability(env: Partial<NodeJS.ProcessEnv> = process.env) {
  try { crmNotesDeleteConfiguration(env); return { available: true }; } catch { return { available: false }; }
}

/** BlockNote is the CRM editor's source of truth; preserve line breaks and literal text. */
export function noteBodyPayload(body: string) {
  return { markdown: body, blocknote: JSON.stringify(body.split('\n').map(line => ({ id: randomUUID(), type: 'paragraph',
    content: [{ type: 'text', text: line, styles: {} }], children: [] }))) };
}
/** Refuse formatted/media notes rather than flattening or losing their editor content. */
export function verifiedPlainNote(record: z.infer<typeof noteLiveSchema>): NoteContent {
  let blocks: unknown;
  try { blocks = JSON.parse(record.bodyV2.blocknote ?? 'null'); } catch { incompatible(); }
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2001) incompatible();
  const lines: string[] = [];
  for (const value of blocks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) incompatible();
    const block = value as Record<string, unknown>;
    if (block.type !== 'paragraph' || !Array.isArray(block.content) || (block.children !== undefined && (!Array.isArray(block.children) || block.children.length))
      || Object.keys(block).some(key => !['id', 'type', 'content', 'children', 'props'].includes(key))) incompatible();
    if (block.props !== undefined) {
      if (!block.props || typeof block.props !== 'object' || Array.isArray(block.props)) incompatible();
      const defaults: Record<string, unknown> = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };
      if (Object.entries(block.props).some(([key, value]) => !Object.hasOwn(defaults, key) || defaults[key] !== value)) incompatible();
    }
    let line = '';
    for (const value of block.content) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) incompatible();
      const span = value as Record<string, unknown>;
      if (span.type !== 'text' || typeof span.text !== 'string' || Object.keys(span).some(key => !['type', 'text', 'styles'].includes(key))
        || (span.styles !== undefined && (!span.styles || typeof span.styles !== 'object' || Array.isArray(span.styles) || Object.keys(span.styles).length))) incompatible();
      line += span.text;
    }
    lines.push(line);
  }
  if (lines.join('\n') !== record.bodyV2.markdown) incompatible();
  const content = noteContentSchema.safeParse({ title: record.title, body: record.bodyV2.markdown });
  if (!content.success) incompatible();
  return content.data;
}

async function json(response: Response): Promise<unknown> {
  if (response.redirected || !response.body) unavailable();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 128_000)) { await response.body.cancel(); unavailable(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 128_000) { await reader.cancel(); unavailable(); }
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}
function sameId(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
function sameContent(record: z.infer<typeof noteLiveSchema>, content: NoteContent) {
  const actual = verifiedPlainNote(record);
  return actual.title === content.title && actual.body === content.body;
}
function matches(target: Target, noteId: string, dealId: string, targetId: string) {
  return sameId(target.id, targetId) && sameId(target.noteId, noteId) && !!target.targetOpportunityId && sameId(target.targetOpportunityId, dealId)
    && target.targetCompanyId === null && target.targetPersonId === null && target.deletedAt === null
    && !Object.entries(target).some(([key, value]) => /^target.+Id$/.test(key) && key !== 'targetOpportunityId' && value !== null);
}
function rejectedResponse(response: Response): NoteMutationResult {
  return { outcome: [400, 401, 403, 404, 409, 412, 422].includes(response.status) && !response.redirected ? 'rejected' : 'outcome_unknown' };
}
function notSent(error: unknown): NoteMutationResult {
  return { outcome: 'rejected', code: error instanceof HttpError ? error.code : 'CRM_NOTE_UNAVAILABLE' };
}

export class CrmNoteClient {
  constructor(private readonly env: Partial<NodeJS.ProcessEnv> = process.env, private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', signal: AbortSignal, body?: unknown) {
    const { origin, key } = crmNotesConfiguration(this.env);
    signal.throwIfAborted();
    return this.fetcher(new URL(path, origin), { method, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async creator(actor: Principal, signal: AbortSignal): Promise<CrmCreator> {
    crmNotesConfiguration(this.env);
    return verifyCrmCreator(actor, signal, this.env, this.fetcher);
  }
  async deal(id: string, signal: AbortSignal) {
    const parsed = uuid.parse(id).toLowerCase();
    try {
      const response = await this.request(`/rest/opportunities/${parsed}?depth=0`, 'GET', signal);
      if (!response.ok) { await response.body?.cancel(); unavailable(); }
      const data = z.object({ data: z.object({ opportunity: z.object({ id: uuid, name: z.string().min(1).max(500),
        updatedAt: rfqVersionSchema, deletedAt: z.null() }) }) }).parse(await json(response));
      if (!sameId(data.data.opportunity.id, parsed)) unavailable();
      return data.data.opportunity;
    } catch { unavailable(); }
  }
  private async targets(noteId: string, signal: AbortSignal): Promise<Target[]> {
    const query = new URLSearchParams({ depth: '0', limit: '2', filter: `noteId[eq]:"${uuid.parse(noteId).toLowerCase()}",deletedAt[is]:NULL` });
    const response = await this.request(`/rest/noteTargets?${query}`, 'GET', signal);
    if (!response.ok) { await response.body?.cancel(); unavailable(); }
    const page = z.object({ data: z.object({ noteTargets: z.array(targetSchema).max(2) }), pageInfo: z.object({ hasNextPage: z.literal(false) }) }).parse(await json(response));
    return page.data.noteTargets;
  }
  private async soleTarget(noteId: string, dealId: string, targetId: string, signal: AbortSignal): Promise<Target> {
    const targets = await this.targets(noteId, signal);
    if (targets.length !== 1 || !matches(targets[0], noteId, dealId, targetId)) {
      throw new HttpError(409, 'CRM_NOTE_LINK_CHANGED', 'This note is shared, moved or no longer linked to the original deal. Nothing was changed.');
    }
    return targets[0];
  }
  private async readRecord(noteId: string, signal: AbortSignal): Promise<z.infer<typeof noteLiveSchema>> {
    try {
      const response = await this.request(`/rest/notes/${uuid.parse(noteId).toLowerCase()}?depth=0`, 'GET', signal);
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new HttpError(404, 'CRM_NOTE_NOT_FOUND', 'The note no longer exists.');
        unavailable();
      }
      const { data: { note } } = z.object({ data: z.object({ note: noteLiveSchema }) }).parse(await json(response));
      if (!sameId(note.id, noteId) || note.deletedAt !== null) throw new HttpError(404, 'CRM_NOTE_NOT_FOUND', 'The note no longer exists.');
      verifiedPlainNote(note);
      return note;
    } catch (error) { if (error instanceof HttpError) throw error; unavailable(); }
  }
  async read(noteId: string, dealId: string, targetId: string, signal: AbortSignal): Promise<NoteLive> {
    uuid.parse(dealId); uuid.parse(targetId);
    try {
      const note = await this.readRecord(noteId, signal);
      const target = await this.soleTarget(noteId, dealId, targetId, signal);
      return { ...note, targetUpdatedAt: target.updatedAt };
    } catch (error) { if (error instanceof HttpError) throw error; unavailable(); }
  }
  async create(noteId: string, targetId: string, dealId: string, content: NoteContent, creator: CrmCreator, signal: AbortSignal): Promise<NoteMutationResult> {
    uuid.parse(noteId); uuid.parse(targetId); uuid.parse(dealId); uuid.parse(creator.id); noteContentSchema.parse(content);
    try {
      const payload = { id: noteId, title: content.title, bodyV2: noteBodyPayload(content.body),
        createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name } };
      const response = await this.request('/rest/notes?depth=0', 'POST', signal, payload);
      if (!response.ok) { await response.body?.cancel(); return rejectedResponse(response); }
      const { data: { createNote: created } } = z.object({ data: z.object({ createNote: noteLiveSchema }) }).parse(await json(response));
      if (response.status !== 201 || !sameId(created.id, noteId) || created.deletedAt !== null || created.createdBy.workspaceMemberId !== creator.id
        || !sameContent(created, content)) return unknown();
      // Once a note exists, every later failure is a partial/unknown outcome, never a clean rejection.
      const linked = await this.request('/rest/noteTargets?depth=0', 'POST', signal, { id: targetId, noteId, targetOpportunityId: dealId,
        createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name } });
      if (!linked.ok) { await linked.body?.cancel(); return unknown(); }
      const target = z.object({ data: z.object({ createNoteTarget: targetSchema }) }).parse(await json(linked));
      if (linked.status !== 201 || !matches(target.data.createNoteTarget, noteId, dealId, targetId)) return unknown();
      const record = await this.read(noteId, dealId, targetId, signal);
      if (record.updatedAt !== created.updatedAt || record.targetUpdatedAt !== target.data.createNoteTarget.updatedAt
        || record.createdBy.workspaceMemberId !== creator.id || !sameContent(record, content)) return unknown();
      return { outcome: 'created', record };
    } catch { return unknown(); }
  }
  async update(current: NoteLive, dealId: string, targetId: string, content: NoteContent, signal: AbortSignal): Promise<NoteMutationResult> {
    let dispatched = false;
    try {
      noteContentSchema.parse(content); verifiedPlainNote(current);
      const target = await this.soleTarget(current.id, uuid.parse(dealId), uuid.parse(targetId), signal);
      if (target.updatedAt !== current.targetUpdatedAt || !current.createdBy.workspaceMemberId || current.deletedAt !== null) return conflict();
      const filter = `id[eq]:"${uuid.parse(current.id)}",updatedAt[eq]:"${rfqVersionSchema.parse(current.updatedAt)}",createdBy.workspaceMemberId[eq]:"${uuid.parse(current.createdBy.workspaceMemberId)}",deletedAt[is]:NULL`;
      const query = new URLSearchParams({ depth: '0', filter });
      dispatched = true;
      const response = await this.request(`/rest/notes?${query}`, 'PATCH', signal, { title: content.title, bodyV2: noteBodyPayload(content.body) });
      if (!response.ok) { await response.body?.cancel(); return rejectedResponse(response); }
      const records = z.object({ data: z.object({ updateNotes: z.array(noteLiveSchema).max(1) }) }).parse(await json(response)).data.updateNotes;
      if (response.status !== 200) return unknown();
      if (!records.length) return conflict();
      const record = records[0];
      if (!sameId(record.id, current.id) || record.deletedAt !== null || record.createdBy.workspaceMemberId !== current.createdBy.workspaceMemberId
        || Date.parse(record.updatedAt) <= Date.parse(current.updatedAt) || !sameContent(record, content)) return unknown();
      const after = await this.soleTarget(current.id, dealId, targetId, signal);
      if (after.updatedAt !== current.targetUpdatedAt) return unknown();
      return { outcome: 'updated', record: { ...record, targetUpdatedAt: after.updatedAt } };
    } catch (error) { return dispatched ? unknown() : notSent(error); }
  }
  /** Trash only our current, sole-linked note. Never permanently delete a note. */
  async trash(current: NoteLive, dealId: string, targetId: string, signal: AbortSignal): Promise<NoteMutationResult> {
    let dispatched = false;
    try {
      crmNotesDeleteConfiguration(this.env);
      const latest = await this.read(current.id, dealId, targetId, signal);
      if (!current.createdBy.workspaceMemberId || current.deletedAt !== null
        || latest.updatedAt !== current.updatedAt || latest.targetUpdatedAt !== current.targetUpdatedAt
        || latest.createdBy.workspaceMemberId !== current.createdBy.workspaceMemberId
        || !sameContent(latest, verifiedPlainNote(current))) return conflict();
      // Twenty guards this note row atomically, but cannot also lock its noteTargets.
      // Refuse every observed shared/moved link above; a concurrent new relation can
      // still race the provider's soft-delete cascade across those separate rows.
      const filter = `id[eq]:"${uuid.parse(current.id)}",updatedAt[eq]:"${rfqVersionSchema.parse(current.updatedAt)}",createdBy.workspaceMemberId[eq]:"${uuid.parse(current.createdBy.workspaceMemberId)}",deletedAt[is]:NULL`;
      const query = new URLSearchParams({ filter, soft_delete: 'true' });
      dispatched = true;
      const response = await this.request(`/rest/notes?${query}`, 'DELETE', signal);
      if (!response.ok) { await response.body?.cancel(); return rejectedResponse(response); }
      const deleted = z.object({ data: z.object({ deleteNotes: z.array(z.object({ id: uuid })).max(1) }) }).parse(await json(response)).data.deleteNotes;
      if (response.status !== 200) return unknown();
      if (!deleted.length) return conflict();
      if (!sameId(deleted[0].id, current.id)) return unknown();
      // Delete responses contain only IDs. Verify the note is no longer active;
      // a provider outage or a concurrent restore must not produce a success claim.
      const activeQuery = new URLSearchParams({ depth: '0', limit: '1', filter: `id[eq]:"${uuid.parse(current.id)}",deletedAt[is]:NULL` });
      const active = await this.request(`/rest/notes?${activeQuery}`, 'GET', signal);
      if (!active.ok) { await active.body?.cancel(); return unknown(); }
      const remaining = z.object({ data: z.object({ notes: z.array(z.object({ id: uuid })).max(1) }),
        pageInfo: z.object({ hasNextPage: z.literal(false) }) }).parse(await json(active)).data.notes;
      if (remaining.length) return unknown();
      return { outcome: 'deleted', record: latest };
    } catch (error) { return dispatched ? unknown() : notSent(error); }
  }
  /** Undo addition to this deal by unlinking only our original target. Never delete the note. */
  async undoCreate(current: NoteLive, dealId: string, targetId: string, signal: AbortSignal): Promise<NoteMutationResult> {
    let dispatched = false;
    try {
      const latest = await this.read(current.id, dealId, targetId, signal);
      if (latest.updatedAt !== current.updatedAt || latest.targetUpdatedAt !== current.targetUpdatedAt
        || latest.createdBy.workspaceMemberId !== current.createdBy.workspaceMemberId || !sameContent(latest, verifiedPlainNote(current))) return conflict();
      const filter = `id[eq]:"${uuid.parse(targetId)}",updatedAt[eq]:"${latest.targetUpdatedAt}",noteId[eq]:"${current.id}",targetOpportunityId[eq]:"${dealId}",targetCompanyId[is]:NULL,targetPersonId[is]:NULL,deletedAt[is]:NULL`;
      const query = new URLSearchParams({ filter, soft_delete: 'true' });
      dispatched = true;
      const response = await this.request(`/rest/noteTargets?${query}`, 'DELETE', signal);
      if (!response.ok) { await response.body?.cancel(); return rejectedResponse(response); }
      const deleted = z.object({ data: z.object({ deleteNoteTargets: z.array(z.object({ id: uuid })).max(1) }) }).parse(await json(response)).data.deleteNoteTargets;
      if (response.status !== 200) return unknown();
      if (!deleted.length) return conflict();
      if (!sameId(deleted[0].id, targetId)) return unknown();
      const remaining = await this.targets(current.id, signal);
      if (remaining.some(row => sameId(row.id, targetId))) return unknown();
      const after = await this.readRecord(current.id, signal);
      if (after.updatedAt !== current.updatedAt || after.createdBy.workspaceMemberId !== current.createdBy.workspaceMemberId
        || !sameContent(after, verifiedPlainNote(current))) return unknown();
      return { outcome: 'rolled_back' };
    } catch (error) { return dispatched ? unknown() : notSent(error); }
  }
}
