import type { PoolClient } from 'pg';
import { requireScope, resolvePrincipal, type KeyRegistration, type Principal } from '../auth';
import { withReadOnlyTransaction, withCrmWriteTransaction } from '../db';
import { HttpError } from '../errors';
import { argumentsSha256 } from '../mcp-read-contract';
import { CrmRfqClient, crmWriteConfiguration } from './client';
import { RFQ_SCOPE, rfqInputSchema, rfqProblems, rfqPayload, type RfqResult } from './rfq';
import { claimCrmRfq, finishCrmRfq } from './storage';

export type CrmRfqDependencies = {
  readTransaction: typeof withReadOnlyTransaction; writeTransaction: typeof withCrmWriteTransaction;
  principal: typeof resolvePrincipal; claim: typeof claimCrmRfq; finish: typeof finishCrmRfq;
  crm: Pick<CrmRfqClient, 'creator' | 'create'>; env: Partial<NodeJS.ProcessEnv>;
};
export async function executeCrmRfq(raw: unknown, key: KeyRegistration, signal: AbortSignal,
  revalidate: (client: PoolClient, key: KeyRegistration) => Promise<void> = async () => {}, overrides: Partial<CrmRfqDependencies> = {}): Promise<RfqResult> {
  const deps: CrmRfqDependencies = { readTransaction: withReadOnlyTransaction, writeTransaction: withCrmWriteTransaction,
    principal: resolvePrincipal, claim: claimCrmRfq, finish: finishCrmRfq, env: process.env, crm: new CrmRfqClient(), ...overrides };
  const parsed = rfqInputSchema.safeParse(raw);
  // MCP rejects malformed UUIDs before invoking the adapter. Keep a valid typed
  // failure for direct internal callers without echoing any submitted content.
  const operation = parsed.success ? parsed.data.operation_id.toLowerCase() : '00000000-0000-4000-8000-000000000000';
  const result = (outcome: RfqResult['outcome'], code: string, message: string, id?: string): RfqResult => ({
    operation_id: operation, outcome, code, message, ...(id ? { data: { id, stage: 'RFQ_RECEIVED' } as const } : {}),
  });
  const unknown = () => result('outcome_unknown', 'CRM_OUTCOME_UNKNOWN', 'The RFQ may have been created. Keep this operation ID and exact arguments. Recovery checks the receipt only and never sends another creation. Ask an administrator to reconcile an unresolved result before creating it again.');
  if (!parsed.success) return result('not_dispatched', 'CRM_RFQ_INVALID', 'Provide the original raw_text, a location and quantified requirement with a unit. Only the advertised RFQ fields are accepted.');
  const input = { ...parsed.data, operation_id: operation };
  const problems = rfqProblems(input);
  if (problems.length) return result('not_dispatched', 'CRM_RFQ_INCOMPLETE', `Please supply or correct: ${problems.join(', ')}. Unknown optional fields should be omitted.`);
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
    crmWriteConfiguration(deps.env);
    const actor = await deps.readTransaction(authorize);
    const creator = await deps.crm.creator(actor, signal);
    const hash = argumentsSha256(input);
    const claim = await deps.writeTransaction(async client => {
      const current = await authorize(client);
      if (current.employeeId !== actor.employeeId || current.email !== actor.email || current.twentyUserId !== actor.twentyUserId) throw new HttpError(403, 'CRM_ACCESS_CHANGED', 'CRM identity changed.');
      return deps.claim(client, actor, operation, hash);
    });
    reserved = true;
    if (!claim.fresh) {
      if (claim.receipt.state === 'created' && claim.receipt.resource_id) return result('replayed', 'CRM_RFQ_REPLAYED', 'Original RFQ creation receipt. This does not prove the record is still present or unchanged.', claim.receipt.resource_id);
      if (claim.receipt.state === 'rejected') return result('rejected', 'CRM_RFQ_REJECTED', 'CRM rejected this creation. No further creation was sent.');
      return unknown();
    }
    // The durable claim commits before network I/O. A crash or cancellation from
    // this point is uncertain; even a retry in another process cannot POST twice.
    signal.throwIfAborted();
    const created = await deps.crm.create(rfqPayload(input, creator), signal);
    await deps.writeTransaction(client => deps.finish(client, actor, operation, hash, created));
    const current = await deps.readTransaction(authorize);
    if (current.employeeId !== actor.employeeId || current.email !== actor.email || current.twentyUserId !== actor.twentyUserId) return unknown();
    if (created.outcome === 'created') return result('created', 'CRM_RFQ_CREATED', 'Created a new RFQ with the original user text as its description.', created.id);
    if (created.outcome === 'rejected') return result('rejected', 'CRM_RFQ_REJECTED', 'CRM rejected this creation. Verify the supplied fields and server access before preparing another proposal.');
    return unknown();
  } catch (error) {
    if (reserved) return unknown();
    if (error instanceof HttpError) return result('not_dispatched', error.code, error.message);
    return result('not_dispatched', signal.aborted ? 'CRM_CANCELLED' : 'CRM_WRITE_UNAVAILABLE', 'No CRM request was dispatched by this attempt. Check access and receipt storage, then recover using the same operation ID.');
  }
}
