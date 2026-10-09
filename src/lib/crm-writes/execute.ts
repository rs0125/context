import type { PoolClient } from 'pg';
import { requireScope, resolvePrincipal, type KeyRegistration, type Principal } from '../auth';
import { withReadOnlyTransaction, withCrmWriteTransaction } from '../db';
import { HttpError } from '../errors';
import { argumentsSha256 } from '../mcp-read-contract';
import { CrmRfqClient, crmWriteConfiguration } from './client';
import { RFQ_SCOPE, rfqInputSchema, normalizeRfqInput, rfqProblems, rfqPayload, type RfqResult } from './rfq';
import { claimCrmRfq, findCrmRfq, finishCrmRfq, type CrmWriteReceipt } from './storage';
import { rfqRecordUrl, type RfqLiveRecord } from './changes';
import { encryptCrmSnapshot } from './snapshots';
import { crmText } from '../crm-presentation';

export type CrmRfqDependencies = {
  readTransaction: typeof withReadOnlyTransaction; writeTransaction: typeof withCrmWriteTransaction;
  principal: typeof resolvePrincipal; find: typeof findCrmRfq; claim: typeof claimCrmRfq; finish: typeof finishCrmRfq;
  crm: Pick<CrmRfqClient, 'creator' | 'create'>; env: Partial<NodeJS.ProcessEnv>;
};
export async function executeCrmRfq(raw: unknown, key: KeyRegistration, signal: AbortSignal,
  revalidate: (client: PoolClient, key: KeyRegistration) => Promise<void> = async () => {}, overrides: Partial<CrmRfqDependencies> = {}): Promise<RfqResult> {
  const env = overrides.env ?? process.env;
  const deps: CrmRfqDependencies = { readTransaction: withReadOnlyTransaction, writeTransaction: withCrmWriteTransaction,
    principal: resolvePrincipal, find: findCrmRfq, claim: claimCrmRfq, finish: finishCrmRfq, env, crm: new CrmRfqClient(env), ...overrides };
  const parsed = rfqInputSchema.safeParse(raw);
  // MCP rejects malformed UUIDs before invoking the adapter. Keep a valid typed
  // failure for direct internal callers without echoing any submitted content.
  const submittedOperation = rfqInputSchema.shape.operation_id.safeParse(
    raw && typeof raw === 'object' && 'operation_id' in raw ? raw.operation_id : undefined);
  const operation = submittedOperation.success ? submittedOperation.data.toLowerCase() : '00000000-0000-4000-8000-000000000000';
  let origin = '';
  const result = (outcome: RfqResult['outcome'], code: string, message: string, id?: string, record?: RfqLiveRecord, undo = false): RfqResult => ({
    operation_id: operation, outcome, code, message, ...(id ? { data: { id, stage: 'RFQ_RECEIVED',
      ...(origin ? { url: rfqRecordUrl(id, origin) } : {}), undo_available: undo,
      ...(record ? { name: crmText(record.name, { maxCharacters: 500 }).text ?? '', updated_at: record.updatedAt } : {}) } as const } : {}),
  });
  const unknown = () => result('outcome_unknown', 'CRM_OUTCOME_UNKNOWN', 'The RFQ may have been created. Keep this operation ID and exact arguments. Recovery checks the receipt only and never sends another creation. Ask an administrator to reconcile an unresolved result before creating it again.');
  function replay(receipt: CrmWriteReceipt): RfqResult {
    if (receipt.state === 'created' && receipt.resource_id) return result('replayed', 'CRM_RFQ_REPLAYED', 'Original RFQ creation receipt. This does not prove the record is still present or unchanged.', receipt.resource_id);
    if (receipt.state === 'rejected') return result('rejected', 'CRM_RFQ_REJECTED', 'CRM rejected this creation. No further creation was sent.');
    return unknown();
  }
  if (!parsed.success) return result('not_dispatched', 'CRM_RFQ_INVALID', 'Provide the original raw_text and valid advertised fields. All extracted details are optional and may be omitted.');
  const input = normalizeRfqInput({ ...parsed.data, operation_id: operation });
  let reserved = false;
  async function authorize(client: PoolClient): Promise<Principal> {
    signal.throwIfAborted();
    await revalidate(client, key);
    const principal = await deps.principal(client, key);
    requireScope(principal, RFQ_SCOPE);
    if (!principal.twentyUserId) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A linked CRM member is required to create RFQs.');
    return principal;
  }
  try {
    origin = crmWriteConfiguration(deps.env).origin;
    const hash = argumentsSha256(input);
    const { actor, stored } = await deps.readTransaction(async client => {
      const actor = await authorize(client);
      return { actor, stored: await deps.find(client, actor, operation, hash) };
    });
    if (stored) return replay(stored);
    // Recovery must honor the authenticated historical receipt even if a later
    // release tightens extraction rules. Revalidate only a new intended create.
    const problems = rfqProblems(input);
    if (problems.length) return result('not_dispatched', 'CRM_RFQ_INCOMPLETE', 'The original brief is empty. Retrieve its complete source text before saving; extracted details are optional.');
    const snapshotContext = { employeeId: actor.employeeId, email: actor.email, memberId: actor.twentyUserId!,
      operationId: operation, action: 'create_crm_rfq' as const, requestHash: hash };
    const editsEnabled = deps.env.CONTEXT_CRM_RFQ_EDITS_ENABLED === 'true';
    // Fail before dispatch if undo-image encryption is misconfigured.
    if (editsEnabled) encryptCrmSnapshot({ check: true }, snapshotContext, deps.env);
    const creator = await deps.crm.creator(actor, signal);
    const claim = await deps.writeTransaction(async client => {
      const current = await authorize(client);
      if (current.employeeId !== actor.employeeId || current.email !== actor.email || current.twentyUserId !== actor.twentyUserId) throw new HttpError(403, 'CRM_ACCESS_CHANGED', 'CRM identity changed.');
      return deps.claim(client, actor, operation, hash);
    });
    reserved = true;
    if (!claim.fresh) return replay(claim.receipt);
    // The durable claim commits before network I/O. A crash or cancellation from
    // this point is uncertain; even a retry in another process cannot POST twice.
    signal.throwIfAborted();
    const payload = rfqPayload(input, creator);
    const created = await deps.crm.create(payload, signal);
    const encryptedSnapshot = editsEnabled && created.outcome === 'created' && created.record
      ? encryptCrmSnapshot({ kind: 'create', record_id: created.id, after_updated_at: created.record.updatedAt }, snapshotContext, deps.env) : undefined;
    await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, { ...created, ...(encryptedSnapshot ? { encryptedSnapshot } : {}) }));
    const current = await deps.readTransaction(authorize);
    if (current.employeeId !== actor.employeeId || current.email !== actor.email || current.twentyUserId !== actor.twentyUserId) return unknown();
    if (created.outcome === 'created') {
      const receipt = result('created', 'CRM_RFQ_CREATED', 'Created a new RFQ with the complete original brief as its description. Structured details were populated where supported.', created.id, created.record, !!encryptedSnapshot);
      // Return the actual CRM title, or the title sent on the successful create.
      // The caller must not build a save receipt from unaccepted extractions.
      if (receipt.data) receipt.data.name ??= String(payload.name);
      return receipt;
    }
    if (created.outcome === 'rejected') return result('rejected', 'CRM_RFQ_REJECTED', 'CRM rejected this creation. Verify the supplied fields and server access before preparing another proposal.');
    return unknown();
  } catch (error) {
    if (reserved) return unknown();
    if (error instanceof HttpError) return result('not_dispatched', error.code, error.message);
    return result('not_dispatched', signal.aborted ? 'CRM_CANCELLED' : 'CRM_WRITE_UNAVAILABLE', 'No CRM request was dispatched by this attempt. Check access and receipt storage, then recover using the same operation ID.');
  }
}
