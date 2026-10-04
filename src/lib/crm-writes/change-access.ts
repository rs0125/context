import type { PoolClient } from 'pg';
import { requireScope, resolvePrincipal, type KeyRegistration, type Principal } from '../auth';
import { withReadOnlyTransaction, withCrmWriteTransaction } from '../db';
import { HttpError } from '../errors';
import { CrmRfqClient, crmWriteConfiguration } from './client';
import { RFQ_SCOPE } from './rfq';
import { RFQ_DETAIL_FIELDS, type RfqLiveRecord } from './changes';
import { claimCrmChange, findAgentCreatedRfq, findCrmChange, finishCrmChange, listCrmChanges, loadCrmChange, type CrmWriteReceipt } from './storage';
import { crmSnapshotContext, decryptCrmSnapshot } from './snapshots';
import { z } from 'zod';

export type CrmChangeDependencies = {
  readTransaction: typeof withReadOnlyTransaction; writeTransaction: typeof withCrmWriteTransaction;
  principal: typeof resolvePrincipal; find: typeof findCrmChange; claim: typeof claimCrmChange; finish: typeof finishCrmChange;
  origin: typeof findAgentCreatedRfq; load: typeof loadCrmChange; list: typeof listCrmChanges;
  crm: Pick<CrmRfqClient, 'creator' | 'read' | 'update' | 'undoCreate'>; env: Partial<NodeJS.ProcessEnv>;
};
export function changeDependencies(overrides: Partial<CrmChangeDependencies>): CrmChangeDependencies {
  const env = overrides.env ?? process.env;
  return { readTransaction: withReadOnlyTransaction, writeTransaction: withCrmWriteTransaction,
    principal: resolvePrincipal, find: findCrmChange, claim: claimCrmChange, finish: finishCrmChange,
    origin: findAgentCreatedRfq, load: loadCrmChange, list: listCrmChanges, crm: new CrmRfqClient(env), env, ...overrides };
}
export function changeConfiguration(env: Partial<NodeJS.ProcessEnv>) {
  const config = crmWriteConfiguration(env);
  if (env.CONTEXT_CRM_RFQ_EDITS_ENABLED !== 'true') throw new HttpError(503, 'CRM_RFQ_EDITS_DISABLED', 'RFQ editing is not enabled.');
  return config;
}
export function changeAuthorizer(deps: CrmChangeDependencies, key: KeyRegistration, signal: AbortSignal,
  revalidate: (client: PoolClient, key: KeyRegistration) => Promise<void>) {
  return async (client: PoolClient): Promise<Principal> => {
    signal.throwIfAborted(); await revalidate(client, key);
    const actor = await deps.principal(client, key);
    requireScope(actor, RFQ_SCOPE);
    if (!actor.twentyUserId) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A linked CRM member is required.');
    return actor;
  };
}
export function sameActor(current: Principal, expected: Principal) {
  if (current.employeeId !== expected.employeeId || current.email !== expected.email || current.twentyUserId !== expected.twentyUserId) {
    throw new HttpError(403, 'CRM_ACCESS_CHANGED', 'CRM identity changed.');
  }
}
export function requireOwnedRfq(record: RfqLiveRecord, actor: Principal) {
  const member = actor.twentyUserId?.toLowerCase();
  if (!member || record.deletedAt !== null || record.ownerId?.toLowerCase() !== member
    || record.createdBy.workspaceMemberId?.toLowerCase() !== member) {
    throw new HttpError(403, 'CRM_RFQ_NOT_EDITABLE', 'Only RFQs created by this agent for you and still assigned to you can be edited.');
  }
}
export function requireOrigin(receipt: CrmWriteReceipt | null): asserts receipt is CrmWriteReceipt {
  if (!receipt) throw new HttpError(403, 'CRM_RFQ_NOT_EDITABLE', 'Only RFQs created by this agent for you can be edited. Other deals cannot be changed yet.');
}
const snapshotSchema = z.object({ kind: z.enum(['create', 'update']), record_id: z.string().uuid(),
  after_updated_at: z.string().datetime({ offset: true }).max(40),
  before: z.record(z.string(), z.unknown()).optional(),
}).strict();
export function changeSnapshot(receipt: CrmWriteReceipt, env: Partial<NodeJS.ProcessEnv>) {
  if (!receipt.encrypted_snapshot) return null;
  const snapshot = snapshotSchema.parse(decryptCrmSnapshot(receipt.encrypted_snapshot, crmSnapshotContext(receipt), env));
  if (snapshot.record_id !== receipt.resource_id || (snapshot.kind === 'create' ? receipt.action !== 'create_crm_rfq' : receipt.action !== 'update_crm_rfq')
    || (snapshot.kind === 'update' && (!snapshot.before || !Object.keys(snapshot.before).length
      || Object.keys(snapshot.before).some(field => !(RFQ_DETAIL_FIELDS as readonly string[]).includes(field))))) {
    throw new HttpError(409, 'CRM_UNDO_UNAVAILABLE', 'The saved change cannot be safely undone.');
  }
  return snapshot;
}
export function canUndo(receipt: CrmWriteReceipt, record: RfqLiveRecord, env: Partial<NodeJS.ProcessEnv>): boolean {
  if (!['created', 'updated'].includes(receipt.state)) return false;
  try {
    const saved = changeSnapshot(receipt, env);
    return !!saved && saved.after_updated_at === record.updatedAt && (saved.kind !== 'create' || record.stage === 'RFQ_RECEIVED');
  } catch { return false; }
}
