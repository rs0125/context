import type { PoolClient } from 'pg';
import { requireScope, type KeyRegistration, type Principal } from '../auth';
import { HttpError } from '../errors';
import { argumentsSha256 } from '../mcp-read-contract';
import { redactCrmText } from '../crm-redaction';
import { CrmRfqClient } from './client';
import { changeDependencies, requireOwnedRfq, sameActor, type CrmChangeDependencies } from './change-access';
import { rfqRecordUrl } from './changes';
import { RFQ_SCOPE } from './rfq';
import { rfqDeleteConfiguration, rfqDeleteInputSchema, type RfqDeleteResult } from './delete';
import { encryptCrmSnapshot } from './snapshots';
import type { CrmWriteReceipt } from './storage';
export { rfqDeleteAvailability } from './delete';

export type CrmDeleteDependencies = Omit<CrmChangeDependencies, 'crm'> & {
  crm: Pick<CrmRfqClient, 'creator' | 'read' | 'delete'>;
};
type Revalidate = (client: PoolClient, key: KeyRegistration) => Promise<void>;

/** A deletion targets the current version, not the original creation/last edit operation. */
export async function executeCrmRfqDelete(raw: unknown, key: KeyRegistration, signal: AbortSignal,
  revalidate: Revalidate = async () => {}, overrides: Partial<CrmDeleteDependencies> = {}): Promise<RfqDeleteResult> {
  const { crm, ...shared } = overrides;
  const deps: CrmDeleteDependencies = { ...changeDependencies(shared), crm: crm ?? new CrmRfqClient(shared.env ?? process.env) };
  const submitted = rfqDeleteInputSchema.shape.operation_id.safeParse(raw && typeof raw === 'object' && 'operation_id' in raw ? raw.operation_id : undefined);
  const operation = submitted.success ? submitted.data.toLowerCase() : '00000000-0000-4000-8000-000000000000';
  let reserved = false;
  const result = (outcome: RfqDeleteResult['outcome'], code: string, message: string): RfqDeleteResult => ({ operation_id: operation, outcome, code, message });
  const unknown = () => result('outcome_unknown', 'CRM_OUTCOME_UNKNOWN', 'The opportunity may have been moved to CRM trash. Keep the same operation ID and arguments. Recovery checks the receipt only; do not submit a replacement operation until its outcome is reconciled.');
  const replay = (receipt: CrmWriteReceipt) => {
    if (receipt.state === 'deleted' && receipt.resource_id) return result('replayed', 'CRM_RFQ_DELETE_REPLAYED', 'The original deletion completed. No new deletion was sent; current CRM content was not fetched.');
    if (receipt.state === 'rejected') return result('rejected', 'CRM_RFQ_DELETE_REJECTED', 'The earlier deletion was rejected. No further deletion was sent.');
    return unknown();
  };
  const parsed = rfqDeleteInputSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.raw_text.trim()) return result('not_dispatched', 'CRM_RFQ_DELETE_INVALID', 'Supply the exact opportunity ID, fresh updated_at version and original user deletion request.');
  const input = { ...parsed.data, id: parsed.data.id.toLowerCase(), operation_id: operation };
  const authorize = async (client: PoolClient) => {
    signal.throwIfAborted(); await revalidate(client, key);
    const actor = await deps.principal(client, key);
    requireScope(actor, 'crm:read'); requireScope(actor, RFQ_SCOPE);
    if (!actor.twentyUserId) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A linked CRM member is required.');
    return actor;
  };
  const requireOrigin = async (client: PoolClient, actor: Principal) => {
    if (!await deps.origin(client, actor, input.id)) throw new HttpError(403, 'CRM_RFQ_NOT_DELETABLE', 'Only opportunities created by Ramesh for you and still assigned to you can be deleted.');
  };
  try {
    const { origin } = rfqDeleteConfiguration(deps.env), hash = argumentsSha256(input), action = 'delete_crm_rfq' as const;
    const { actor, stored } = await deps.readTransaction(async client => {
      const actor = await authorize(client), stored = await deps.find(client, actor, operation, hash, action);
      if (!stored) await requireOrigin(client, actor);
      return { actor, stored };
    });
    if (stored) return replay(stored);
    await deps.crm.creator(actor, signal);
    const current = await deps.crm.read(input.id, signal);
    if (current.id.toLowerCase() !== input.id) throw new HttpError(409, 'CRM_RFQ_UNAVAILABLE', 'The exact opportunity could not be verified.');
    try { requireOwnedRfq(current, actor); }
    catch (error) {
      if (error instanceof HttpError && error.code === 'CRM_RFQ_NOT_EDITABLE') throw new HttpError(403,
        'CRM_RFQ_NOT_DELETABLE', 'Only active opportunities created by Ramesh for you and still assigned to you can be deleted.');
      throw error;
    }
    if (current.updatedAt !== input.expected_updated_at) throw new HttpError(409, 'CRM_RFQ_VERSION_CONFLICT', 'The opportunity changed since it was read. Read it again and check the requested deletion before trying again.');
    // The provider's conditional deletion binds the current stage, creator, owner and version.
    // Persist the exact target before dispatch, without retaining unrelated CRM record fields.
    const encryptedSnapshot = encryptCrmSnapshot({ kind: 'delete', record_id: current.id,
      before_updated_at: current.updatedAt, stage: current.stage }, {
      employeeId: actor.employeeId, email: actor.email, memberId: actor.twentyUserId!,
      operationId: operation, action, requestHash: hash,
    }, deps.env);
    const claim = await deps.writeTransaction(async client => {
      sameActor(await authorize(client), actor);
      await requireOrigin(client, actor);
      return deps.claim(client, actor, operation, hash, action, encryptedSnapshot);
    });
    if (!claim.fresh) return replay(claim.receipt);
    // The durable reservation must remain uncertain on cancellation or failure,
    // even if this process stops before issuing the provider request.
    reserved = true;
    signal.throwIfAborted();
    const changed = await deps.crm.delete(current, signal);
    await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, action, changed));
    sameActor(await deps.readTransaction(authorize), actor);
    if (changed.outcome === 'deleted') return { ...result('deleted', 'CRM_RFQ_DELETED', 'Moved the requested opportunity to CRM trash. It was not permanently destroyed.'),
      data: { id: current.id, name: redactCrmText(current.name, { maxCharacters: 500 }).text ?? '',
        url: rfqRecordUrl(current.id, origin), deletion_kind: 'trash', undo_available: false } };
    if (changed.outcome === 'rejected') return result('rejected', changed.code ?? 'CRM_RFQ_DELETE_REJECTED', 'No opportunity was deleted. The record may have changed or CRM rejected access. Read it again before preparing another deletion.');
    return unknown();
  } catch (error) {
    if (reserved) return unknown();
    if (error instanceof HttpError) return result('not_dispatched', error.code, error.message);
    return result('not_dispatched', signal.aborted ? 'CRM_CANCELLED' : 'CRM_WRITE_UNAVAILABLE', 'No CRM deletion was dispatched by this attempt. Check access and saved change storage before retrying.');
  }
}
