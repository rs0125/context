import type { PoolClient } from 'pg';
import type { KeyRegistration } from '../auth';
import { HttpError } from '../errors';
import { argumentsSha256 } from '../mcp-read-contract';
import { redactCrmText } from '../crm-redaction';
import { rfqBeforePatch, rfqEditPayload, rfqEditProblems, rfqRecordUrl, rfqUndoInputSchema, rfqUpdateInputSchema, type RfqChangeResult, type RfqLiveRecord } from './changes';
import { changeAuthorizer, changeConfiguration, changeDependencies, changeSnapshot, requireOrigin, requireOwnedRfq, sameActor, type CrmChangeDependencies } from './change-access';
import { encryptCrmSnapshot } from './snapshots';
import type { CrmWriteAction, CrmWriteReceipt } from './storage';

type Revalidate = (client: PoolClient, key: KeyRegistration) => Promise<void>;
export const executeCrmRfqUpdate = (raw: unknown, key: KeyRegistration, signal: AbortSignal,
  revalidate: Revalidate = async () => {}, overrides: Partial<CrmChangeDependencies> = {}) => execute('update_crm_rfq', raw, key, signal, revalidate, overrides);
export const executeCrmRfqUndo = (raw: unknown, key: KeyRegistration, signal: AbortSignal,
  revalidate: Revalidate = async () => {}, overrides: Partial<CrmChangeDependencies> = {}) => execute('undo_crm_rfq', raw, key, signal, revalidate, overrides);

async function execute(action: Extract<CrmWriteAction, 'update_crm_rfq' | 'undo_crm_rfq'>, raw: unknown, key: KeyRegistration,
  signal: AbortSignal, revalidate: Revalidate, overrides: Partial<CrmChangeDependencies>): Promise<RfqChangeResult> {
  const deps = changeDependencies(overrides);
  const submitted = rfqUpdateInputSchema.shape.operation_id.safeParse(raw && typeof raw === 'object' && 'operation_id' in raw ? raw.operation_id : undefined);
  const operation = submitted.success ? submitted.data.toLowerCase() : '00000000-0000-4000-8000-000000000000';
  let origin = '', reserved = false;
  const result = (outcome: RfqChangeResult['outcome'], code: string, message: string, id?: string, record?: RfqLiveRecord, undo = false): RfqChangeResult => ({
    operation_id: operation, outcome, code, message,
    ...(id ? { data: { id, url: rfqRecordUrl(id, origin), undo_available: undo,
      ...(record ? { name: redactCrmText(record.name, { maxCharacters: 500 }).text ?? '', updated_at: record.updatedAt } : {}) } } : {}),
  });
  const unknown = () => result('outcome_unknown', 'CRM_OUTCOME_UNKNOWN', 'The change may have completed. Keep the same operation ID and arguments. Recovery checks the receipt only; do not submit a replacement operation until the outcome is reconciled.');
  const replay = (receipt: CrmWriteReceipt) => {
    if (receipt.resource_id && ['updated', 'undone'].includes(receipt.state)) return result('replayed', 'CRM_RFQ_REPLAYED', 'Original change receipt. This does not prove the RFQ is still unchanged.', receipt.resource_id);
    if (receipt.state === 'rejected') return result('rejected', 'CRM_RFQ_REJECTED', 'The earlier change was rejected. No further change was sent.');
    return unknown();
  };
  const parsed = action === 'update_crm_rfq' ? rfqUpdateInputSchema.safeParse(raw) : rfqUndoInputSchema.safeParse(raw);
  if (!parsed.success) return result('not_dispatched', 'CRM_RFQ_INVALID', 'Supply the advertised fields, exact target and original user request. Stage, assignment and arbitrary fields cannot be changed.');
  const input = { ...parsed.data, operation_id: operation };
  if ('changes' in input) {
    const issues = rfqEditProblems(input);
    if (issues.length) return result('not_dispatched', 'CRM_RFQ_INCOMPLETE', `Please supply or correct: ${issues.join(', ')}.`);
  } else if (!input.raw_text.trim()) return result('not_dispatched', 'CRM_RFQ_INVALID', 'Supply the original undo request.');
  const authorize = changeAuthorizer(deps, key, signal, revalidate);
  try {
    origin = changeConfiguration(deps.env).origin;
    const hash = argumentsSha256(input);
    const { actor, stored, original, id } = await deps.readTransaction(async client => {
      const actor = await authorize(client);
      const stored = await deps.find(client, actor, operation, hash, action);
      if (stored) return { actor, stored, original: null, id: null };
      const original = 'original_operation_id' in input ? await deps.load(client, actor, input.original_operation_id.toLowerCase()) : null;
      if ('original_operation_id' in input && (!original || !['created', 'updated'].includes(original.state) || !original.resource_id)) {
        throw new HttpError(409, 'CRM_UNDO_UNAVAILABLE', 'Only a successful creation or edit by this agent for you can be undone.');
      }
      const id = 'id' in input ? input.id.toLowerCase() : original!.resource_id!;
      requireOrigin(await deps.origin(client, actor, id));
      return { actor, stored, original, id };
    });
    if (stored) return replay(stored);
    await deps.crm.creator(actor, signal);
    const current = await deps.crm.read(id!, signal);
    requireOwnedRfq(current, actor);
    let patch: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined;
    let undoCreate = false;
    if ('changes' in input) {
      if (input.expected_updated_at !== current.updatedAt) throw new HttpError(409, 'CRM_RFQ_VERSION_CONFLICT', 'The RFQ changed since it was read. Read it again and check the requested edit before trying again.');
      patch = rfqEditPayload(input, current);
      before = rfqBeforePatch(current, patch);
    } else {
      const saved = changeSnapshot(original!, deps.env);
      if (!saved) throw new HttpError(409, 'CRM_UNDO_UNAVAILABLE', 'This older change has no saved undo version. It can still be edited if it is your agent-created RFQ.');
      if (saved.after_updated_at !== current.updatedAt) throw new HttpError(409, 'CRM_RFQ_VERSION_CONFLICT', 'The RFQ has changed since that action. Undo would overwrite later work, so nothing was changed.');
      undoCreate = saved.kind === 'create';
      if (undoCreate && current.stage !== 'RFQ_RECEIVED') throw new HttpError(409, 'CRM_UNDO_UNAVAILABLE', 'This RFQ has progressed and its creation can no longer be undone.');
      if (!undoCreate) patch = saved.before!;
    }
    const context = { employeeId: actor.employeeId, email: actor.email, memberId: actor.twentyUserId!, operationId: operation, action, requestHash: hash };
    // Validate encryption and retain the exact before-image before any upstream mutation.
    const encryptedSnapshot = encryptCrmSnapshot({ kind: action === 'update_crm_rfq' ? 'update' : 'undo', record_id: current.id,
      before_updated_at: current.updatedAt, ...(before ? { before } : {}) }, context, deps.env);
    const claim = await deps.writeTransaction(async client => {
      sameActor(await authorize(client), actor);
      requireOrigin(await deps.origin(client, actor, current.id));
      return deps.claim(client, actor, operation, hash, action, encryptedSnapshot);
    });
    reserved = true;
    if (!claim.fresh) return replay(claim.receipt);
    signal.throwIfAborted();
    const changed = undoCreate ? await deps.crm.undoCreate(current, signal) : await deps.crm.update(current, patch!, signal);
    const success = changed.outcome === 'updated' || changed.outcome === 'rolled_back';
    const finished = success ? {
      outcome: action === 'update_crm_rfq' ? 'updated' as const : 'rolled_back' as const, id: changed.id,
      ...(action === 'update_crm_rfq' && changed.outcome === 'updated' ? { encryptedSnapshot: encryptCrmSnapshot({ kind: 'update', record_id: changed.id,
        after_updated_at: changed.record.updatedAt, before }, context, deps.env) } : {}),
    } : { outcome: changed.outcome };
    await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, action, finished));
    sameActor(await deps.readTransaction(authorize), actor);
    if (success) return result(action === 'update_crm_rfq' ? 'updated' : 'rolled_back', action === 'update_crm_rfq' ? 'CRM_RFQ_UPDATED' : 'CRM_RFQ_UNDONE',
      action === 'update_crm_rfq' ? 'Updated the requested RFQ details.' : undoCreate ? 'Moved the unchanged RFQ to CRM trash.' : 'Restored the details from before that edit.',
      changed.id, changed.outcome === 'updated' ? changed.record : undefined, action === 'update_crm_rfq');
    if (changed.outcome === 'rejected') return result('rejected', changed.code ?? 'CRM_RFQ_REJECTED',
      'No change was applied. The RFQ may have changed or CRM rejected access. Read it again before preparing another edit.');
    return unknown();
  } catch (error) {
    if (reserved) return unknown();
    if (error instanceof HttpError) return result('not_dispatched', error.code, error.message);
    return result('not_dispatched', signal.aborted ? 'CRM_CANCELLED' : 'CRM_WRITE_UNAVAILABLE', 'No CRM change was dispatched by this attempt. Check access and saved change storage before retrying.');
  }
}
