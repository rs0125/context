/** Actor-bound dispatch receipts with encrypted before/after images for narrow CRM undo. */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import { RFQ_ACTION } from './rfq';

export const crmWriteActionSchema = z.enum(['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq', 'create_crm_note', 'update_crm_note', 'undo_crm_note']);
export type CrmWriteAction = z.infer<typeof crmWriteActionSchema>;
const receipt = z.object({ employee_id: z.number().int().positive(), employee_email: z.string().email(),
  operation_id: z.string().uuid(), member_id: z.string().uuid(), action: crmWriteActionSchema, request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['dispatching', 'created', 'updated', 'undone', 'rejected', 'unknown']), resource_id: z.string().uuid().nullable(),
  encrypted_snapshot: z.string().max(90_000).nullable().default(null) });
// Optional at the type boundary for legacy receipt fixtures; parsed database rows always contain null or ciphertext.
export type CrmWriteReceipt = Omit<z.infer<typeof receipt>, 'encrypted_snapshot'> & { encrypted_snapshot?: string | null };
const columns = 'employee_id, employee_email, operation_id, member_id, action, request_hash, state, resource_id, encrypted_snapshot';
const successfulState = { create_crm_rfq: 'created', update_crm_rfq: 'updated', undo_crm_rfq: 'undone',
  create_crm_note: 'created', update_crm_note: 'updated', undo_crm_note: 'undone' } as const;
function unavailable(): never { throw new HttpError(503, 'CRM_RECEIPT_UNAVAILABLE', 'The change receipt could not be verified.'); }
function verifyReceipt(row: unknown, actor: Principal, operation?: string, hash?: string, action?: CrmWriteAction): CrmWriteReceipt {
  const stored = receipt.safeParse(row);
  if (!stored.success || stored.data.employee_id !== actor.employeeId || stored.data.employee_email !== actor.email
    || (operation !== undefined && stored.data.operation_id !== operation) || stored.data.member_id !== actor.twentyUserId?.toLowerCase()
    || (action !== undefined && stored.data.action !== action) || (hash !== undefined && stored.data.request_hash !== hash)) {
    throw new HttpError(409, 'CRM_OPERATION_CONFLICT', 'This operation ID is already bound to another request or employee identity.');
  }
  const success = ['created', 'updated', 'undone'].includes(stored.data.state);
  if (success !== (stored.data.resource_id !== null) || (success && stored.data.state !== successfulState[stored.data.action])) unavailable();
  return stored.data;
}

/** Recovery is a read: it must not depend on Twenty being reachable. */
export async function findCrmChange(client: PoolClient, actor: Principal, operation: string, hash: string, action: CrmWriteAction): Promise<CrmWriteReceipt | null> {
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND operation_id = $2`, [actor.employeeId, operation]);
  return rows.length ? verifyReceipt(rows[0], actor, operation, hash, action) : null;
}

export async function claimCrmChange(client: PoolClient, actor: Principal, operation: string, hash: string, action: CrmWriteAction, encryptedSnapshot?: string) {
  if (!crmWriteActionSchema.safeParse(action).success || (encryptedSnapshot !== undefined && (typeof encryptedSnapshot !== 'string' || encryptedSnapshot.length > 90_000))) unavailable();
  const inserted = await client.query(`INSERT INTO context_crm_private.write_operations
    (employee_id, employee_email, operation_id, action, request_hash, member_id, state, encrypted_snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, 'dispatching', $7) ON CONFLICT (employee_id, operation_id) DO NOTHING RETURNING ${columns}`,
  [actor.employeeId, actor.email, operation, action, hash, actor.twentyUserId, encryptedSnapshot ?? null]);
  const stored = inserted.rows.length ? verifyReceipt(inserted.rows[0], actor, operation, hash, action)
    : await findCrmChange(client, actor, operation, hash, action);
  if (!stored) unavailable();
  return { fresh: inserted.rows.length === 1, receipt: stored };
}

export type CrmChangeResult =
  | { outcome: 'created' | 'updated' | 'rolled_back'; id: string; encryptedSnapshot?: string }
  | { outcome: 'rejected' | 'outcome_unknown'; encryptedSnapshot?: string };
export async function finishCrmChange(client: PoolClient, actor: Principal, operation: string, hash: string, action: CrmWriteAction, result: CrmChangeResult) {
  const success = ['created', 'updated', 'rolled_back'].includes(result.outcome);
  const state = result.outcome === 'outcome_unknown' ? 'unknown' : result.outcome === 'rolled_back' ? 'undone' : result.outcome;
  if (!crmWriteActionSchema.safeParse(action).success || (success && state !== successfulState[action])
    || (result.encryptedSnapshot !== undefined && (typeof result.encryptedSnapshot !== 'string' || result.encryptedSnapshot.length > 90_000))) unavailable();
  const updated = await client.query(`UPDATE context_crm_private.write_operations SET state = $6, resource_id = $7,
    encrypted_snapshot = COALESCE($9, encrypted_snapshot), updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND operation_id = $3 AND action = $4 AND request_hash = $5 AND member_id = $8 AND state = 'dispatching'
    RETURNING operation_id`, [actor.employeeId, actor.email, operation, action, hash,
    state, 'id' in result ? result.id : null, actor.twentyUserId, result.encryptedSnapshot ?? null]);
  if (updated.rows.length !== 1) unavailable();
}

/** These lookups never expose records retained under an old email/member binding. */
export async function loadCrmChange(client: PoolClient, actor: Principal, operation: string): Promise<CrmWriteReceipt | null> {
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND employee_email = $2 AND member_id = $3 AND operation_id = $4`,
  [actor.employeeId, actor.email, actor.twentyUserId, operation]);
  return rows.length ? verifyReceipt(rows[0], actor, operation) : null;
}
export async function findAgentCreatedRfq(client: PoolClient, actor: Principal, resourceId: string): Promise<CrmWriteReceipt | null> {
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND employee_email = $2 AND member_id = $3 AND resource_id = $4
      AND action = 'create_crm_rfq' AND state = 'created' ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
  [actor.employeeId, actor.email, actor.twentyUserId, resourceId]);
  return rows.length ? verifyReceipt(rows[0], actor, undefined, undefined, RFQ_ACTION) : null;
}
export async function listCrmChanges(client: PoolClient, actor: Principal, limit = 10): Promise<CrmWriteReceipt[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) unavailable();
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND employee_email = $2 AND member_id = $3
      AND action IN ('create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq')
    ORDER BY created_at DESC, operation_id DESC LIMIT $4`, [actor.employeeId, actor.email, actor.twentyUserId, limit]);
  return rows.map(row => verifyReceipt(row, actor));
}

export async function findAgentCreatedNote(client: PoolClient, actor: Principal, noteId: string): Promise<CrmWriteReceipt | null> {
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND employee_email = $2 AND member_id = $3 AND resource_id = $4
      AND action = 'create_crm_note' AND state = 'created' ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
  [actor.employeeId, actor.email, actor.twentyUserId, noteId]);
  return rows.length ? verifyReceipt(rows[0], actor, undefined, undefined, 'create_crm_note') : null;
}
/** The caller decrypts target binding and reauthorizes current deal/note access before disclosure. */
export async function listCrmNoteChanges(client: PoolClient, actor: Principal, limit = 10, noteId?: string): Promise<CrmWriteReceipt[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (noteId !== undefined && !z.string().uuid().safeParse(noteId).success)) unavailable();
  const { rows } = await client.query(`SELECT ${columns} FROM context_crm_private.write_operations
    WHERE employee_id = $1 AND employee_email = $2 AND member_id = $3
      AND action IN ('create_crm_note', 'update_crm_note', 'undo_crm_note') AND state IN ('created', 'updated', 'undone')
      AND ($5::uuid IS NULL OR resource_id = $5)
    ORDER BY created_at DESC, operation_id DESC LIMIT $4`, [actor.employeeId, actor.email, actor.twentyUserId, limit, noteId ?? null]);
  return rows.map(row => verifyReceipt(row, actor));
}

// Existing create callers retain their strict action binding and API.
export async function findCrmRfq(client: PoolClient, actor: Principal, operation: string, hash: string) {
  return findCrmChange(client, actor, operation, hash, RFQ_ACTION);
}
export async function claimCrmRfq(client: PoolClient, actor: Principal, operation: string, hash: string) {
  return claimCrmChange(client, actor, operation, hash, RFQ_ACTION);
}
export async function finishCrmRfq(client: PoolClient, actor: Principal, operation: string, hash: string,
  result: { outcome: 'created'; id: string; encryptedSnapshot?: string } | { outcome: 'rejected' | 'outcome_unknown' }) {
  return finishCrmChange(client, actor, operation, hash, RFQ_ACTION, result);
}
