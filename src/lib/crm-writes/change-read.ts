import type { PoolClient } from 'pg';
import type { KeyRegistration } from '../auth';
import { rfqEditableView, rfqListChangesInputSchema, rfqReadInputSchema, rfqRecordUrl } from './changes';
import { crmText } from '../crm-presentation';
import { HttpError } from '../errors';
import { canUndo, changeAuthorizer, changeConfiguration, changeDependencies, requireOrigin, requireOwnedRfq, sameActor, type CrmChangeDependencies } from './change-access';

export async function readCrmRfq(id: string, key: KeyRegistration, signal: AbortSignal,
  revalidate: (client: PoolClient, key: KeyRegistration) => Promise<void> = async () => {}, overrides: Partial<CrmChangeDependencies> = {}) {
  const deps = changeDependencies(overrides), { origin } = changeConfiguration(deps.env);
  const parsed = rfqReadInputSchema.safeParse({ id });
  if (!parsed.success) throw new HttpError(400, 'CRM_RFQ_ID_INVALID', 'A valid RFQ ID is required.');
  const authorize = changeAuthorizer(deps, key, signal, revalidate);
  const actor = await deps.readTransaction(async client => {
    const actor = await authorize(client);
    requireOrigin(await deps.origin(client, actor, parsed.data.id.toLowerCase()));
    return actor;
  });
  await deps.crm.creator(actor, signal);
  const record = await deps.crm.read(parsed.data.id.toLowerCase(), signal);
  requireOwnedRfq(record, actor);
  sameActor(await deps.readTransaction(authorize), actor);
  return rfqEditableView(record, origin);
}

export async function listCrmRfqChanges(limit: number | undefined, key: KeyRegistration, signal: AbortSignal,
  revalidate: (client: PoolClient, key: KeyRegistration) => Promise<void> = async () => {}, overrides: Partial<CrmChangeDependencies> = {}) {
  const deps = changeDependencies(overrides), { origin } = changeConfiguration(deps.env);
  const parsed = rfqListChangesInputSchema.safeParse({ limit });
  if (!parsed.success) throw new HttpError(400, 'CRM_HISTORY_LIMIT_INVALID', 'Choose a limit between 1 and 10.');
  const authorize = changeAuthorizer(deps, key, signal, revalidate);
  const { actor, receipts } = await deps.readTransaction(async client => {
    const actor = await authorize(client);
    const receipts = await deps.list(client, actor, parsed.data.limit ?? 10);
    // Establish creation provenance before reading any live CRM record.
    const own = [];
    for (const receipt of receipts) {
      if (receipt.resource_id && ['created', 'updated'].includes(receipt.state)
        && await deps.origin(client, actor, receipt.resource_id)) own.push(receipt);
    }
    return { actor, receipts: own };
  });
  await deps.crm.creator(actor, signal);
  const items = [];
  const records = new Map<string, Awaited<ReturnType<typeof deps.crm.read>> | null>();
  for (const receipt of receipts) {
    const id = receipt.resource_id!;
    if (!records.has(id)) {
      let live: Awaited<ReturnType<typeof deps.crm.read>>;
      try { live = await deps.crm.read(id, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof HttpError) || error.code !== 'CRM_RFQ_NOT_FOUND') throw error;
        records.set(id, null); continue;
      }
      try { requireOwnedRfq(live, actor); }
      catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'CRM_RFQ_NOT_EDITABLE') throw error;
        records.set(id, null); continue;
      }
      records.set(id, live);
    }
    const live = records.get(id);
    if (live) items.push({ operation_id: receipt.operation_id, action: receipt.action, id,
      name: crmText(live.name, { maxCharacters: 500 }), url: rfqRecordUrl(id, origin),
      updated_at: live.updatedAt, undo_available: canUndo(receipt, live, deps.env) });
  }
  sameActor(await deps.readTransaction(authorize), actor);
  return { items, restriction: 'Only your agent-created RFQs that are still assigned to you. Undo is available only while the saved version is unchanged.' };
}
