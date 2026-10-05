/** Private CRM undo images, bound to their employee, operation and exact request. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { CrmWriteAction, CrmWriteReceipt } from './storage';

const MAX_BYTES = 65_536;
const contextSchema = z.object({
  employeeId: z.number().int().positive(), email: z.string().max(254).regex(/^[^\s@]+@wareongo\.com$/),
  memberId: z.string().uuid(), operationId: z.string().uuid(),
  action: z.enum(['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq', 'create_crm_note', 'update_crm_note', 'undo_crm_note', 'delete_crm_rfq', 'delete_crm_note']),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CrmSnapshotContext = {
  employeeId: number; email: string; memberId: string; operationId: string; action: CrmWriteAction; requestHash: string;
};
export function crmSnapshotContext(receipt: CrmWriteReceipt): CrmSnapshotContext {
  return { employeeId: receipt.employee_id, email: receipt.employee_email, memberId: receipt.member_id,
    operationId: receipt.operation_id, action: receipt.action, requestHash: receipt.request_hash };
}
function unavailable(): never { throw new HttpError(503, 'CRM_SNAPSHOT_UNAVAILABLE', 'The saved CRM change could not be verified.'); }
function key(env: Partial<NodeJS.ProcessEnv>) {
  const secret = env.CONTEXT_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, 'CRM_SNAPSHOT_CONFIGURATION', 'CRM change encryption is not configured.');
  // Retain the v1 purpose for existing RFQ ciphertext. Authenticated action binding separates notes.
  return Buffer.from(hkdfSync('sha256', secret, 'wareongo-context-engine', 'crm-rfq-snapshot-v1', 32));
}
function binding(context: CrmSnapshotContext) {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success || context.email !== context.email.toLowerCase()) unavailable();
  return Buffer.from(JSON.stringify(['crm-rfq-snapshot-v1', context.employeeId, context.email,
    context.memberId.toLowerCase(), context.operationId.toLowerCase(), context.action, context.requestHash]));
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Callers validate their CRM snapshot shape; this layer enforces encryption and size/binding. */
export function encryptCrmSnapshot(value: Record<string, unknown>, context: CrmSnapshotContext, env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const secret = key(env), aad = binding(context);
  try {
    if (!record(value)) unavailable();
    const plain = JSON.stringify(value);
    if (Buffer.byteLength(plain) > MAX_BYTES || !record(JSON.parse(plain))) unavailable();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  } catch { return unavailable(); }
}

export function decryptCrmSnapshot(value: string, context: CrmSnapshotContext, env: Partial<NodeJS.ProcessEnv> = process.env): Record<string, unknown> {
  const secret = key(env), aad = binding(context);
  try {
    if (typeof value !== 'string' || value.length > 90_000 || !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(value)) unavailable();
    const [, iv, ciphertext, tag] = value.split('.');
    const bytes = Buffer.from(ciphertext, 'base64url'), tagBytes = Buffer.from(tag, 'base64url'), ivBytes = Buffer.from(iv, 'base64url');
    if (bytes.length > MAX_BYTES || bytes.toString('base64url') !== ciphertext || tagBytes.toString('base64url') !== tag
      || ivBytes.toString('base64url') !== iv) unavailable();
    const decipher = createDecipheriv('aes-256-gcm', secret, ivBytes);
    decipher.setAAD(aad); decipher.setAuthTag(tagBytes);
    const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
    const utf8 = plain.toString('utf8');
    if (!Buffer.from(utf8).equals(plain)) unavailable();
    const decoded: unknown = JSON.parse(utf8);
    if (!record(decoded)) unavailable();
    return decoded;
  } catch { return unavailable(); }
}
