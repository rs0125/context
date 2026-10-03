/** Minimal dispatch receipts, not a CRM audit/undo service. No raw RFQ text is stored here. */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import { RFQ_ACTION } from './rfq';

const receipt = z.object({ employee_id: z.number().int().positive(), employee_email: z.string().email(),
  operation_id: z.string().uuid(), member_id: z.string().uuid(), action: z.literal(RFQ_ACTION), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['dispatching', 'created', 'rejected', 'unknown']), resource_id: z.string().uuid().nullable() });
export type CrmWriteReceipt = z.infer<typeof receipt>;
const columns = 'employee_id, employee_email, operation_id, member_id, action, request_hash, state, resource_id';
export async function claimCrmRfq(client: PoolClient, actor: Principal, operation: string, hash: string) {
  const inserted = await client.query(`INSERT INTO context_crm_private.write_operations
    (employee_id, employee_email, operation_id, action, request_hash, member_id, state)
    VALUES ($1, $2, $3, $4, $5, $6, 'dispatching') ON CONFLICT (employee_id, operation_id) DO NOTHING RETURNING ${columns}`,
  [actor.employeeId, actor.email, operation, RFQ_ACTION, hash, actor.twentyUserId]);
  const row = inserted.rows[0] ?? (await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND operation_id = $2`, [actor.employeeId, operation])).rows[0];
  const stored = receipt.safeParse(row);
  if (!stored.success || stored.data.employee_id !== actor.employeeId || stored.data.employee_email !== actor.email
    || stored.data.operation_id !== operation || stored.data.member_id !== actor.twentyUserId?.toLowerCase()
    || stored.data.action !== RFQ_ACTION || stored.data.request_hash !== hash) {
    throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'This operation ID is already bound to another request or employee identity.');
  }
  if ((stored.data.state === 'created') !== (stored.data.resource_id !== null)) throw new HttpError(503, 'CRM_RECEIPT_UNAVAILABLE', 'The creation receipt could not be verified.');
  return { fresh: inserted.rows.length === 1, receipt: stored.data };
}
export async function finishCrmRfq(client: PoolClient, actor: Principal, operation: string, hash: string,
  result: { outcome: 'created'; id: string } | { outcome: 'rejected' | 'outcome_unknown' }) {
  const updated = await client.query(`UPDATE context_crm_private.write_operations SET state = $6, resource_id = $7, updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND operation_id = $3 AND action = $4 AND request_hash = $5 AND state = 'dispatching'
    RETURNING operation_id`, [actor.employeeId, actor.email, operation, RFQ_ACTION, hash,
    result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome, result.outcome === 'created' ? result.id : null]);
  if (updated.rows.length !== 1) throw new HttpError(503, 'CRM_RECEIPT_UNAVAILABLE', 'The creation receipt could not be saved.');
}
