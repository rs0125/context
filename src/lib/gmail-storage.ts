import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './errors';

/** Server-only storage. These records contain credentials and must never
 * be returned directly by a console route or an MCP tool. The caller owns the
 * transaction; in particular, COMMIT a successful draft claim before Gmail I/O. */
export type GmailOwner = { employeeId: number; employeeEmail: string };
export type GmailConnection = GmailOwner & {
  id: string; googleSub: string | null; accountEmail: string; encryptedRefreshToken: string | null;
  grantedScopes: string[]; version: number; status: 'active' | 'disconnected' | 'revoking' | 'needs_reauth';
  createdAt: string; updatedAt: string;
};
export type GmailDraftOperationState = 'dispatching' | 'created' | 'unknown' | 'rejected' | 'retryable';
export type GmailDraftOperation = GmailOwner & {
  operationId: string; connectionId: string; connectionVersion: number; requestHash: string;
  googleSub: string | null; retryAt: string | null; state: GmailDraftOperationState;
  draftId: string | null; messageId: string | null; reason: string | null;
  createdAt: string; updatedAt: string;
};
export type GmailSecretContext = {
  purpose: 'refresh_token' | 'draft_content'; employeeId: number; id: string;
};
export type GmailDraftClaim = {
  operationId: string; connectionId: string; connectionVersion: number; requestHash: string;
};
export type GmailDraftOutcome = {
  state: 'created' | 'unknown' | 'rejected' | 'retryable'; draftId?: string; messageId?: string; reason?: string; retryAfterMs?: number;
};

type Row = Record<string, unknown>;
const CONNECTIONS = 'context_gmail_private.connections';
const OPERATIONS = 'context_gmail_private.draft_operations';
const CONNECTION_FIELDS = 'id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version, status, created_at, updated_at';
const OPERATION_FIELDS = 'operation_id, employee_id, employee_email, connection_id, connection_version, request_hash, google_sub, retry_at, state, draft_id, message_id, reason, created_at, updated_at';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EMAIL = /^[^\s@]+@wareongo\.com$/;
const HASH = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,79}$/;
const STATES = ['dispatching', 'created', 'unknown', 'rejected', 'retryable'];
const unavailable = (): never => { throw new HttpError(503, 'GMAIL_STORAGE_UNAVAILABLE', 'Gmail connection storage could not be verified.'); };
const changed = (): never => { throw new HttpError(409, 'GMAIL_CONNECTION_CHANGED', 'Your Gmail connection changed. Reconnect or check its current status before continuing.'); };

function employeeId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}
function validOwner(owner: GmailOwner) {
  if (!employeeId(owner.employeeId) || typeof owner.employeeEmail !== 'string'
    || owner.employeeEmail.length > 254 || owner.employeeEmail !== owner.employeeEmail.toLowerCase()
    || !EMAIL.test(owner.employeeEmail)) unavailable();
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) return unavailable();
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return unavailable();
  return new Date(time).toISOString();
}
function scopes(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) || value.length > 20 || new Set(value).size !== value.length
    || value.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(item))) return unavailable();
  return [...value];
}
function cipherShape(value: unknown, maximum = 400_000): value is string {
  return typeof value === 'string' && value.length <= maximum
    && /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(value);
}
function encryptionKey(env: NodeJS.ProcessEnv) {
  const value = env.CONTEXT_GMAIL_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new HttpError(503, 'GMAIL_ENCRYPTION_CONFIGURATION', 'Gmail encryption is not configured.');
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new HttpError(503, 'GMAIL_ENCRYPTION_CONFIGURATION', 'Gmail encryption is not configured.');
  }
  return key;
}
function secretBinding(context: GmailSecretContext) {
  if (!employeeId(context.employeeId) || !['refresh_token', 'draft_content'].includes(context.purpose)) unavailable();
  return Buffer.from(JSON.stringify(['context-gmail-v1', context.purpose, context.employeeId, uuid(context.id)]));
}
function maximumSecretBytes(context: GmailSecretContext) { return context.purpose === 'refresh_token' ? 8192 : 262_144; }

export function encryptGmailSecret(value: string, context: GmailSecretContext, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')
    || Buffer.byteLength(value) > maximumSecretBytes(context)) return unavailable();
  const key = encryptionKey(env), aad = secretBinding(context), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptGmailSecret(value: string, context: GmailSecretContext, env: NodeJS.ProcessEnv = process.env): string {
  const key = encryptionKey(env), aad = secretBinding(context);
  try {
    if (!cipherShape(value)) throw new Error();
    const [, iv, ciphertext, tag] = value.split('.');
    const bytes = Buffer.from(ciphertext, 'base64url');
    if (!bytes.length || bytes.length > maximumSecretBytes(context) || bytes.toString('base64url') !== ciphertext
      || Buffer.from(tag, 'base64url').toString('base64url') !== tag) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
    const decoded = plain.toString('utf8');
    if (!decoded.length || decoded.includes('\0') || !Buffer.from(decoded).equals(plain)) throw new Error();
    return decoded;
  } catch { return unavailable(); }
}

export async function assertGmailOwnerActive(client: PoolClient, owner: GmailOwner): Promise<void> {
  validOwner(owner);
  // Only SELECT on the roster: no row locks requiring source UPDATE privileges.
  const { rows } = await client.query<Row>(`SELECT id, email, is_active FROM public."VerifiedNumber"
    WHERE lower(email) = $1 LIMIT 2`, [owner.employeeEmail]);
  if (rows.length !== 1 || rows[0].id !== owner.employeeId || rows[0].is_active !== true
    || typeof rows[0].email !== 'string' || rows[0].email.toLowerCase() !== owner.employeeEmail) {
    throw new HttpError(403, 'GMAIL_EMPLOYEE_INACTIVE', 'An active matching employee account is required.');
  }
}

function connection(row: Row, owner: GmailOwner): GmailConnection {
  if (row.employee_id !== owner.employeeId || row.employee_email !== owner.employeeEmail
    || row.account_email !== owner.employeeEmail
    || (row.google_sub === null ? row.status !== 'disconnected' : typeof row.google_sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(row.google_sub))
    || !employeeId(row.version) || !['active', 'disconnected', 'revoking', 'needs_reauth'].includes(String(row.status))
    || (row.status !== 'disconnected' ? !cipherShape(row.encrypted_refresh_token, 12_000) : row.encrypted_refresh_token !== null)) return unavailable();
  return { ...owner, id: uuid(row.id), googleSub: row.google_sub as string | null, accountEmail: row.account_email,
    encryptedRefreshToken: row.encrypted_refresh_token as string | null, grantedScopes: scopes(row.granted_scopes, row.google_sub === null),
    version: row.version, status: row.status as GmailConnection['status'], createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}

async function readConnection(client: PoolClient, owner: GmailOwner): Promise<GmailConnection | null> {
  const { rows } = await client.query<Row>(`SELECT ${CONNECTION_FIELDS} FROM ${CONNECTIONS}
    WHERE employee_id = $1 AND employee_email = $2 LIMIT 2`, [owner.employeeId, owner.employeeEmail]);
  if (rows.length > 1) return unavailable();
  return rows[0] ? connection(rows[0], owner) : null;
}

export async function getGmailConnection(client: PoolClient, owner: GmailOwner): Promise<GmailConnection | null> {
  await assertGmailOwnerActive(client, owner);
  return readConnection(client, owner);
}

async function lockOwner(client: PoolClient, owner: GmailOwner) {
  validOwner(owner);
  // Serializes claims, reconnects and finishes even when no connection exists yet.
  // The surrounding transaction supplies statement/lock deadlines.
  await client.query('SELECT pg_advisory_xact_lock(1784056942, $1)', [owner.employeeId]);
  await assertGmailOwnerActive(client, owner);
}

export async function saveGmailConnection(client: PoolClient, owner: GmailOwner, input: {
  googleSub: string; accountEmail: string; refreshToken: string; grantedScopes: string[];
  expectedConnection?: { id: string | null; version: number | null };
}, env: NodeJS.ProcessEnv = process.env): Promise<GmailConnection> {
  validOwner(owner);
  if (input.accountEmail !== owner.employeeEmail || typeof input.googleSub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(input.googleSub)
    || typeof input.refreshToken !== 'string' || /\s/.test(input.refreshToken)) return unavailable();
  const grantedScopes = scopes(input.grantedScopes);
  if (input.expectedConnection && (input.expectedConnection.id === null
    ? input.expectedConnection.version !== null
    : typeof input.expectedConnection.id !== 'string' || !UUID.test(input.expectedConnection.id)
      || !employeeId(input.expectedConnection.version))) return unavailable();
  await lockOwner(client, owner);
  const old = await readConnection(client, owner);
  if (old?.status === 'revoking') throw new HttpError(409, 'GMAIL_REVOCATION_PENDING', 'Finish disconnecting Gmail before reconnecting.');
  if (input.expectedConnection && (input.expectedConnection.id !== (old?.id ?? null)
    || input.expectedConnection.version !== (old?.version ?? null))) return changed();
  if (old && old.version >= 2_147_483_647) return unavailable();
  const id = old?.id ?? randomUUID(), version = (old?.version ?? 0) + 1;
  const encrypted = encryptGmailSecret(input.refreshToken, { purpose: 'refresh_token', employeeId: owner.employeeId, id }, env);
  const { rows } = await client.query<Row>(`INSERT INTO ${CONNECTIONS}
    (id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, 'active')
    ON CONFLICT (employee_id) DO UPDATE SET google_sub = EXCLUDED.google_sub, account_email = EXCLUDED.account_email,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, granted_scopes = EXCLUDED.granted_scopes,
      version = EXCLUDED.version, status = 'active', updated_at = CURRENT_TIMESTAMP
    WHERE ${CONNECTIONS}.id = EXCLUDED.id AND ${CONNECTIONS}.employee_email = EXCLUDED.employee_email
    RETURNING ${CONNECTION_FIELDS}`, [id, owner.employeeId, owner.employeeEmail, input.googleSub, input.accountEmail, encrypted, grantedScopes, version]);
  if (rows.length !== 1) return unavailable();
  await invalidateDispatches(client, owner);
  return connection(rows[0], owner);
}

async function invalidateDispatches(client: PoolClient, owner: GmailOwner) {
  // A draft may already be in flight. Unknown is honest; rejected would imply it
  // cannot have been created. Neither state can ever be dispatched again.
  await client.query(`UPDATE ${OPERATIONS} SET state = 'unknown', reason = 'CONNECTION_CHANGED', updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND state = 'dispatching'`, [owner.employeeId, owner.employeeEmail]);
}

export async function disconnectGmailConnection(client: PoolClient, owner: GmailOwner): Promise<GmailConnection | null> {
  await lockOwner(client, owner);
  const old = await readConnection(client, owner);
  // Persist a tombstone even on the first disconnect. Every disconnect advances
  // the OAuth generation, invalidating callbacks that already passed preflight.
  if (!old) {
    const { rows } = await client.query<Row>(`INSERT INTO ${CONNECTIONS}
      (id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version, status)
      VALUES ($1, $2, $3, NULL, $3, NULL, '{}'::text[], 1, 'disconnected') RETURNING ${CONNECTION_FIELDS}`,
    [randomUUID(), owner.employeeId, owner.employeeEmail]);
    if (rows.length !== 1) return unavailable();
    return connection(rows[0], owner);
  }
  if (old.version >= 2_147_483_647) return unavailable();
  const { rows } = await client.query<Row>(`UPDATE ${CONNECTIONS}
    SET status = CASE WHEN encrypted_refresh_token IS NULL THEN 'disconnected' ELSE 'revoking' END,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND id = $3 RETURNING ${CONNECTION_FIELDS}`,
  [owner.employeeId, owner.employeeEmail, old.id]);
  if (rows.length !== 1) return unavailable();
  await invalidateDispatches(client, owner);
  return connection(rows[0], owner);
}

/** Commit disconnectGmailConnection first. Only this rare, bounded revocation
 * holds an owner lock across provider I/O; no concurrent callback can install a
 * new credential while an older token is being revoked project-wide. A failure
 * rolls back this transaction, leaving access disabled and revocation retryable. */
export async function completeGmailDisconnect(client: PoolClient, owner: GmailOwner,
  revoke: (connection: GmailConnection) => Promise<void>): Promise<GmailConnection | null> {
  await lockOwner(client, owner);
  const current = await readConnection(client, owner);
  if (!current || current.status === 'disconnected') return current;
  if (current.status !== 'revoking' || !current.encryptedRefreshToken) return changed();
  await revoke(current);
  const { rows } = await client.query<Row>(`UPDATE ${CONNECTIONS}
    SET encrypted_refresh_token = NULL, status = 'disconnected', updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND id = $3 AND version = $4 AND status = 'revoking'
    RETURNING ${CONNECTION_FIELDS}`, [owner.employeeId, owner.employeeEmail, current.id, current.version]);
  if (rows.length !== 1) return unavailable();
  return connection(rows[0], owner);
}

/** An old failed refresh must never invalidate a newly reconnected credential. */
export async function markGmailNeedsReauth(client: PoolClient, owner: GmailOwner,
  binding: { id: string; version: number }): Promise<boolean> {
  if (!employeeId(binding.version)) return unavailable();
  await lockOwner(client, owner);
  const { rows } = await client.query<Row>(`UPDATE ${CONNECTIONS}
    SET status = 'needs_reauth', updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND id = $3 AND version = $4 AND status = 'active'
    RETURNING id`, [owner.employeeId, owner.employeeEmail, uuid(binding.id), binding.version]);
  if (rows.length > 1) return unavailable();
  if (rows.length) await invalidateDispatches(client, owner);
  return rows.length === 1;
}

function operation(row: Row, owner: GmailOwner): GmailDraftOperation {
  if (row.employee_id !== owner.employeeId || row.employee_email !== owner.employeeEmail
    || !employeeId(row.connection_version) || typeof row.request_hash !== 'string' || !HASH.test(row.request_hash)
    || !STATES.includes(String(row.state))
    || (row.google_sub !== null && (typeof row.google_sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(row.google_sub)))
    || (row.state === 'retryable' ? row.retry_at === null : row.retry_at !== null)
    || (row.reason !== null && (typeof row.reason !== 'string' || !REASON.test(row.reason)))
    || (row.state === 'created'
      ? typeof row.draft_id !== 'string' || !PROVIDER_ID.test(row.draft_id) || typeof row.message_id !== 'string' || !PROVIDER_ID.test(row.message_id)
      : row.draft_id !== null || row.message_id !== null)) return unavailable();
  return { ...owner, operationId: uuid(row.operation_id), connectionId: uuid(row.connection_id),
    connectionVersion: row.connection_version, requestHash: row.request_hash,
    googleSub: row.google_sub as string | null, retryAt: row.retry_at === null ? null : timestamp(row.retry_at), state: row.state as GmailDraftOperationState,
    draftId: row.draft_id as string | null, messageId: row.message_id as string | null, reason: row.reason as string | null,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}

async function readOperation(client: PoolClient, owner: GmailOwner, operationId: string): Promise<GmailDraftOperation | null> {
  const { rows } = await client.query<Row>(`SELECT ${OPERATION_FIELDS} FROM ${OPERATIONS}
    WHERE employee_id = $1 AND employee_email = $2 AND operation_id = $3 LIMIT 2`, [owner.employeeId, owner.employeeEmail, uuid(operationId)]);
  if (rows.length > 1) return unavailable();
  return rows[0] ? operation(rows[0], owner) : null;
}

export async function getGmailDraftOperation(client: PoolClient, owner: GmailOwner, operationId: string): Promise<GmailDraftOperation | null> {
  await assertGmailOwnerActive(client, owner);
  return readOperation(client, owner, operationId);
}

/** References only, scoped to the verified Google account across reauthorization. Never disclose bodies,
 * recipients, credentials or provider IDs while recovering a conversational handle. */
export async function listGmailDraftReferences(client: PoolClient, owner: GmailOwner,
  binding: { id: string; version: number; googleSub: string | null }, input: { limit: number; cursor?: string }) {
  await assertGmailOwnerActive(client, owner);
  if (!employeeId(binding.version) || !binding.googleSub || !/^[A-Za-z0-9_-]{1,255}$/.test(binding.googleSub)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) return unavailable();
  const parameters: unknown[] = [owner.employeeId, owner.employeeEmail, uuid(binding.id), binding.googleSub];
  let before: string | null = null;
  if (input.cursor) {
    // Keep PostgreSQL's full timestamp precision for a stable (created_at, UUID) keyset.
    const cursor = await client.query<Row>(`SELECT created_at::text AS cursor_time FROM ${OPERATIONS}
      WHERE employee_id=$1 AND employee_email=$2 AND connection_id=$3 AND google_sub=$4
      AND state='created' AND operation_id=$5`, [...parameters, uuid(input.cursor)]);
    if (cursor.rows.length !== 1 || typeof cursor.rows[0].cursor_time !== 'string')
      throw new HttpError(422, 'GMAIL_INVALID_CURSOR', 'Restart the draft list using the current mailbox connection.');
    before = cursor.rows[0].cursor_time;
  }
  const { rows } = await client.query<Row>(`SELECT operation_id, created_at FROM ${OPERATIONS}
    WHERE employee_id=$1 AND employee_email=$2 AND connection_id=$3 AND google_sub=$4 AND state='created'
    AND ($5::timestamptz IS NULL OR (created_at,operation_id)<($5::timestamptz,$6::uuid))
    ORDER BY created_at DESC,operation_id DESC LIMIT $7`,
  [...parameters, before, input.cursor ? uuid(input.cursor) : null, input.limit + 1]);
  const items = rows.slice(0, input.limit).map(row => ({ draft_ref: uuid(row.operation_id), created_at: timestamp(row.created_at) }));
  return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.draft_ref : null };
}

/** Only claimed:true may dispatch, once the enclosing transaction has COMMITTED.
 * Existing dispatching/unknown records are deliberately never reclaimed, even
 * after a timeout/crash. Gmail draft creation has no idempotency-key contract. */
export async function claimGmailDraftOperation(client: PoolClient, owner: GmailOwner, input: GmailDraftClaim): Promise<{
  claimed: boolean; operation: GmailDraftOperation;
}> {
  const operationId = uuid(input.operationId), connectionId = uuid(input.connectionId);
  if (!employeeId(input.connectionVersion) || !HASH.test(input.requestHash)) return unavailable();
  await lockOwner(client, owner);
  const current = await readConnection(client, owner);
  if (!current || current.status !== 'active' || !current.googleSub || current.id !== connectionId || current.version !== input.connectionVersion) return changed();
  const existing = await readOperation(client, owner, operationId);
  if (existing) {
    if (existing.requestHash !== input.requestHash) throw new HttpError(409, 'GMAIL_OPERATION_CONFLICT', 'This operation ID was already used for different draft content.');
    if (existing.connectionId !== connectionId || existing.connectionVersion !== input.connectionVersion || existing.googleSub !== current.googleSub) return changed();
    if (existing.state === 'retryable') {
      // Only a definitive provider rejection can be retried. The database clock
      // and owner lock ensure exactly one contender can acquire the next attempt.
      const { rows } = await client.query<Row>(`UPDATE ${OPERATIONS}
        SET state = 'dispatching', retry_at = NULL, reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE employee_id = $1 AND employee_email = $2 AND operation_id = $3 AND state = 'retryable'
          AND retry_at <= CURRENT_TIMESTAMP RETURNING ${OPERATION_FIELDS}`, [owner.employeeId, owner.employeeEmail, operationId]);
      if (rows.length > 1) return unavailable();
      if (rows.length) return { claimed: true, operation: operation(rows[0], owner) };
    }
    return { claimed: false, operation: existing };
  }
  const { rows } = await client.query<Row>(`INSERT INTO ${OPERATIONS}
    (employee_id, employee_email, operation_id, connection_id, connection_version, request_hash, google_sub, state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'dispatching')
    ON CONFLICT (employee_id, operation_id) DO NOTHING RETURNING ${OPERATION_FIELDS}`,
  [owner.employeeId, owner.employeeEmail, operationId, connectionId, input.connectionVersion, input.requestHash, current.googleSub]);
  // A conflict despite the owner lock indicates another writer does not follow
  // this protocol. Fail closed; do not interpret an ambiguous insert as a claim.
  if (rows.length !== 1) return unavailable();
  return { claimed: true, operation: operation(rows[0], owner) };
}

export async function finishGmailDraftOperation(client: PoolClient, owner: GmailOwner, operationId: string, input: GmailDraftOutcome): Promise<GmailDraftOperation> {
  if (!['created', 'unknown', 'rejected', 'retryable'].includes(input.state)
    || (input.state === 'retryable'
      ? !Number.isInteger(input.retryAfterMs) || Number(input.retryAfterMs) < 1000 || Number(input.retryAfterMs) > 86_400_000
      : input.retryAfterMs !== undefined)
    || (input.reason !== undefined && !REASON.test(input.reason))
    || (input.state === 'created'
      ? !input.draftId || !PROVIDER_ID.test(input.draftId) || !input.messageId || !PROVIDER_ID.test(input.messageId)
      : input.draftId !== undefined || input.messageId !== undefined)) return unavailable();
  await lockOwner(client, owner);
  const existing = await readOperation(client, owner, operationId);
  if (!existing) throw new HttpError(404, 'GMAIL_OPERATION_NOT_FOUND', 'This draft operation was not found.');
  const current = await readConnection(client, owner);
  const mailboxChanged = !current || current.status !== 'active' || current.id !== existing.connectionId
    || !existing.googleSub || current.googleSub !== existing.googleSub;
  const connectionChanged = mailboxChanged || current!.version !== existing.connectionVersion;
  // A verified provider read can reconcile an uncertain create. This does not
  // authorize another create request; unknown operations remain unclaimable.
  const reconciled = existing.state === 'unknown' && input.state === 'created' && !mailboxChanged;
  if (existing.state !== 'dispatching' && !reconciled) return existing;
  const outcome: GmailDraftOutcome = connectionChanged && !reconciled ? { state: 'unknown', reason: 'CONNECTION_CHANGED' } : input;
  const { rows } = await client.query<Row>(`UPDATE ${OPERATIONS}
    SET state = $4, draft_id = $5, message_id = $6, reason = $7,
      retry_at = CASE WHEN $9::integer IS NULL THEN NULL ELSE CURRENT_TIMESTAMP + $9 * INTERVAL '1 millisecond' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = $1 AND employee_email = $2 AND operation_id = $3 AND state = $8
    RETURNING ${OPERATION_FIELDS}`, [owner.employeeId, owner.employeeEmail, uuid(operationId), outcome.state,
    outcome.draftId ?? null, outcome.messageId ?? null, outcome.reason ?? null, existing.state, outcome.retryAfterMs ?? null]);
  if (rows.length !== 1) return unavailable();
  return operation(rows[0], owner);
}
