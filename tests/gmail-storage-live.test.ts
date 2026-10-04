import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimGmailDraftOperation, claimGmailDraftUpdateOperation, finishGmailDraftUpdateOperation, getGmailDraftUpdateOperation, completeGmailDisconnect, decryptGmailSecret, disconnectGmailConnection,
  encryptGmailSecret, finishGmailDraftOperation,
  getGmailConnection, getGmailDraftOperation, listGmailDraftReferences, markGmailNeedsReauth, quarantineGmailIssuedToken, saveGmailConnection,
  type GmailOwner,
} from '../src/lib/gmail-storage';

const migrationPath = '../scripts/migrate-gmail.mjs';
const { migrateGmailStorage } = await import(migrationPath);
const databaseUrl = process.env.CONTEXT_GMAIL_TEST_DATABASE_URL;
const env = { NODE_ENV: 'test' as const, CONTEXT_GMAIL_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
const scopes = ['https://www.googleapis.com/auth/gmail.compose'];

// Frozen from the original v1 migration, independently of the current migration's
// table definitions. PostgreSQL renders the descriptions used in the v1 hashes.
const GMAIL_STORAGE_V1_SQL = `
  CREATE SCHEMA context_gmail_private;
  COMMENT ON SCHEMA context_gmail_private IS 'context-gmail-schema-v1';
  CREATE TABLE context_gmail_private.connections (
    id uuid PRIMARY KEY, employee_id integer NOT NULL UNIQUE, employee_email text NOT NULL,
    google_sub text NOT NULL, account_email text NOT NULL, encrypted_refresh_token text,
    granted_scopes text[] NOT NULL, version integer NOT NULL, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, employee_id),
    CONSTRAINT connections_employee_check CHECK (employee_id > 0),
    CONSTRAINT connections_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
    CONSTRAINT connections_subject_check CHECK (google_sub ~ '^[A-Za-z0-9_-]{1,255}$'),
    CONSTRAINT connections_account_check CHECK (account_email = employee_email),
    CONSTRAINT connections_token_check CHECK (encrypted_refresh_token IS NULL OR (char_length(encrypted_refresh_token) <= 12000 AND encrypted_refresh_token ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$')),
    CONSTRAINT connections_scopes_check CHECK (cardinality(granted_scopes) BETWEEN 1 AND 20 AND array_position(granted_scopes, NULL) IS NULL),
    CONSTRAINT connections_version_check CHECK (version > 0),
    CONSTRAINT connections_status_check CHECK ((status = 'active' AND encrypted_refresh_token IS NOT NULL) OR (status = 'disconnected' AND encrypted_refresh_token IS NULL))
  );
  CREATE TABLE context_gmail_private.draft_operations (
    employee_id integer NOT NULL, employee_email text NOT NULL, operation_id uuid NOT NULL,
    connection_id uuid NOT NULL, connection_version integer NOT NULL, request_hash text NOT NULL,
    encrypted_content text, state text NOT NULL, draft_id text, message_id text, reason text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (employee_id, operation_id),
    CONSTRAINT draft_operations_connection_fkey FOREIGN KEY (connection_id, employee_id) REFERENCES context_gmail_private.connections (id, employee_id),
    CONSTRAINT draft_operations_employee_check CHECK (employee_id > 0),
    CONSTRAINT draft_operations_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
    CONSTRAINT draft_operations_version_check CHECK (connection_version > 0),
    CONSTRAINT draft_operations_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT draft_operations_content_check CHECK (encrypted_content IS NULL OR (char_length(encrypted_content) <= 400000 AND encrypted_content ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$')),
    CONSTRAINT draft_operations_state_check CHECK (state IN ('dispatching', 'created', 'unknown', 'rejected')),
    CONSTRAINT draft_operations_result_check CHECK ((state = 'created' AND draft_id IS NOT NULL AND message_id IS NOT NULL AND char_length(draft_id) <= 256 AND char_length(message_id) <= 256 AND draft_id ~ '^[A-Za-z0-9_-]+$' AND message_id ~ '^[A-Za-z0-9_-]+$') OR (state <> 'created' AND draft_id IS NULL AND message_id IS NULL)),
    CONSTRAINT draft_operations_reason_check CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{0,79}$')
  );
  ALTER TABLE context_gmail_private.connections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE context_gmail_private.connections FORCE ROW LEVEL SECURITY;
  ALTER TABLE context_gmail_private.draft_operations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE context_gmail_private.draft_operations FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA context_gmail_private FROM PUBLIC;
  GRANT USAGE ON SCHEMA context_gmail_private TO context_engine_runtime;
  GRANT SELECT, INSERT, UPDATE ON context_gmail_private.connections, context_gmail_private.draft_operations TO context_engine_runtime;
  CREATE POLICY context_runtime ON context_gmail_private.connections FOR ALL TO context_engine_runtime USING (true) WITH CHECK (true);
  CREATE POLICY context_runtime ON context_gmail_private.draft_operations FOR ALL TO context_engine_runtime USING (true) WITH CHECK (true);
`;

async function signV1Table(client: PoolClient, name: 'connections' | 'draft_operations', version = 1) {
  const relation = `context_gmail_private.${name}`;
  // Preserve the original JSON property and row ordering, including null defaults.
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped,
    pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated,
    pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY conname`, [relation])).rows;
  const signature = createHash('sha256').update(JSON.stringify({ columns, constraints })).digest('hex');
  await client.query(`COMMENT ON TABLE ${relation} IS 'context-gmail-table-v${version}:${signature}'`);
}

// Dedicated disposable localhost database only. No mailbox or provider traffic.
describe.skipIf(!databaseUrl)('Gmail lifecycle on isolated PostgreSQL', () => {
  let admin: pg.Pool, runtime: pg.Pool, nextEmployee = 100;
  const tx = async <T>(action: (client: PoolClient) => Promise<T>) => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '4000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const employee = async (): Promise<GmailOwner> => {
    const id = ++nextEmployee, email = `synthetic${id}@wareongo.com`;
    await admin.query('INSERT INTO public."VerifiedNumber" VALUES ($1, $2, true)', [id, email]);
    return { employeeId: id, employeeEmail: email };
  };
  const input = (owner: GmailOwner, sub = 'synthetic_google_subject') => ({
    googleSub: sub, accountEmail: owner.employeeEmail, refreshToken: 'synthetic-refresh-token', grantedScopes: scopes,
  });
  const connect = (owner: GmailOwner, sub?: string) => tx(client => saveGmailConnection(client, owner, input(owner, sub), env));
  const claimInput = (connection: { id: string; version: number }) => ({
    operationId: randomUUID(), connectionId: connection.id, connectionVersion: connection.version, requestHash: 'a'.repeat(64),
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/context_gmail_test')
      throw new Error('LOCAL_ISOLATED_GMAIL_DATABASE_REQUIRED');
    admin = new pg.Pool({ connectionString: databaseUrl });
    const runtimePassword = randomBytes(24).toString('hex');
    await admin.query('CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY, email text NOT NULL, is_active boolean NOT NULL)');
    const roleClient = await admin.connect();
    try {
      await roleClient.query('BEGIN');
      await roleClient.query('SELECT pg_advisory_xact_lock(1784056941, 1802406261)');
      await roleClient.query(`CREATE ROLE context_engine_runtime LOGIN PASSWORD '${runtimePassword}'`);
      await roleClient.query('COMMIT');
    } catch (error) { await roleClient.query('ROLLBACK'); throw error; }
    finally { roleClient.release(); }
    await admin.query('GRANT USAGE ON SCHEMA public TO context_engine_runtime');
    await admin.query('GRANT SELECT ON public."VerifiedNumber" TO context_engine_runtime');
    const client = await admin.connect();
    try {
      expect(await migrateGmailStorage(client)).toMatchObject({ verified: true, runtimeGranted: true });
      expect(await migrateGmailStorage(client)).toMatchObject({ verified: true, runtimeGranted: true });
    } finally { client.release(); }
    url.username = 'context_engine_runtime'; url.password = runtimePassword;
    runtime = new pg.Pool({ connectionString: url.toString(), max: 5 });
  });
  afterAll(async () => { await runtime?.end(); await admin?.end(); });

  it('executes the schema twice and grants only private integration writes', async () => {
    const result = await runtime.query(`SELECT
      has_table_privilege(current_user, 'context_gmail_private.connections', 'UPDATE') AS can_disconnect,
      has_table_privilege(current_user, 'public."VerifiedNumber"', 'UPDATE') AS can_change_roster,
      has_table_privilege(current_user, 'context_gmail_private.draft_operations', 'DELETE') AS can_delete_operations,
      has_table_privilege(current_user, 'context_gmail_private.draft_update_operations', 'INSERT') AS can_record_updates,
      has_table_privilege(current_user, 'context_gmail_private.draft_update_operations', 'DELETE, TRUNCATE, REFERENCES, TRIGGER') AS unsafe_update_grants`);
    expect(result.rows[0]).toEqual({ can_disconnect: true, can_change_roster: false, can_delete_operations: false, can_record_updates: true, unsafe_update_grants: false });
    const columns = await admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='context_gmail_private' AND table_name='draft_operations'`);
    expect(columns.rows.map(row => row.column_name)).not.toContain('encrypted_content');
  });

  it('upgrades signed v1 storage without retaining content or guessing historical mailbox identity, then reruns safely', async () => {
    // Separate from the fresh-schema lifecycle tests, within the same disposable
    // localhost cluster. An existing database is deliberately never overwritten.
    await admin.query('CREATE DATABASE context_gmail_upgrade_test');
    const url = new URL(databaseUrl!); url.pathname = '/context_gmail_upgrade_test';
    const upgrade = new pg.Pool({ connectionString: url.toString() });
    const client = await upgrade.connect();
    try {
      await client.query('CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY, email text NOT NULL, is_active boolean NOT NULL)');
      await client.query('GRANT USAGE ON SCHEMA public TO context_engine_runtime');
      await client.query('GRANT SELECT ON public."VerifiedNumber" TO context_engine_runtime');
      await client.query(GMAIL_STORAGE_V1_SQL);
      await signV1Table(client, 'connections');
      await signV1Table(client, 'draft_operations');

      const owner = { employeeId: 1, employeeEmail: 'synthetic-upgrade@wareongo.com' };
      const connectionId = randomUUID(), googleSub = 'verified_v1_google_subject';
      const secretContext = { purpose: 'refresh_token' as const, employeeId: owner.employeeId, id: connectionId };
      const token = encryptGmailSecret('synthetic-v1-refresh-token', secretContext, env);
      await client.query('INSERT INTO public."VerifiedNumber" VALUES ($1, $2, true)', [owner.employeeId, owner.employeeEmail]);
      await client.query(`INSERT INTO context_gmail_private.connections
        (id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version, status)
        VALUES ($1, $2, $3, $4, $3, $5, $6, 2, 'active')`,
      [connectionId, owner.employeeId, owner.employeeEmail, googleSub, token, scopes]);
      const operations = [
        { id: randomUUID(), version: 2, state: 'created', draft: 'current-draft', message: 'current-message', reason: null },
        { id: randomUUID(), version: 1, state: 'created', draft: 'historical-draft', message: 'historical-message', reason: null },
        { id: randomUUID(), version: 2, state: 'dispatching', draft: null, message: null, reason: null },
        { id: randomUUID(), version: 2, state: 'unknown', draft: null, message: null, reason: 'PROVIDER_UNCERTAIN' },
      ];
      for (const operation of operations) {
        const content = encryptGmailSecret(JSON.stringify({ subject: 'Synthetic private subject', body: 'Synthetic private body' }),
          { purpose: 'draft_content', employeeId: owner.employeeId, id: operation.id }, env);
        await client.query(`INSERT INTO context_gmail_private.draft_operations
          (employee_id, employee_email, operation_id, connection_id, connection_version, request_hash,
           encrypted_content, state, draft_id, message_id, reason)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [owner.employeeId, owner.employeeEmail, operation.id, connectionId, operation.version, 'a'.repeat(64),
          content, operation.state, operation.draft, operation.message, operation.reason]);
      }
      const oldConnections = (await client.query('SELECT * FROM context_gmail_private.connections ORDER BY id')).rows;
      const oldOperations = (await client.query('SELECT * FROM context_gmail_private.draft_operations ORDER BY operation_id')).rows;
      const expectedOperations = oldOperations.map(({ encrypted_content, ...retained }) => {
        expect(encrypted_content).toMatch(/^v1\./);
        return { ...retained, google_sub: retained.connection_version === 2 ? googleSub : null, retry_at: null };
      });

      expect(await migrateGmailStorage(client)).toMatchObject({ applied: true, verified: true, runtimeGranted: true });
      expect((await client.query('SELECT * FROM context_gmail_private.connections ORDER BY id')).rows).toEqual(oldConnections);
      expect((await client.query('SELECT * FROM context_gmail_private.draft_operations ORDER BY operation_id')).rows).toEqual(expectedOperations);
      expect(decryptGmailSecret(oldConnections[0].encrypted_refresh_token, secretContext, env)).toBe('synthetic-v1-refresh-token');
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='context_gmail_private' AND table_name='draft_operations'`)).rows;
      expect(columns.map(row => row.column_name)).not.toContain('encrypted_content');
      expect(columns.map(row => row.column_name)).toEqual(expect.arrayContaining(['google_sub', 'retry_at']));

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE context_engine_runtime');
      const connection = await getGmailConnection(client, owner);
      expect(connection).toMatchObject({ id: connectionId, version: 2, googleSub, encryptedRefreshToken: token });
      const references = await listGmailDraftReferences(client, owner, connection!, { limit: 10 });
      expect(references.items.map(item => item.draft_ref)).toEqual([operations[0].id]);
      for (const operation of operations.filter(item => item.version === 2)) {
        expect(await claimGmailDraftOperation(client, owner, {
          operationId: operation.id, connectionId, connectionVersion: 2, requestHash: 'a'.repeat(64),
        })).toMatchObject({ claimed: false, operation: { state: operation.state } });
      }
      await client.query('COMMIT');

      // This also verifies the new signed descriptions after PostgreSQL retained
      // the dropped-column slot in pg_attribute and runtime policies were added.
      expect(await migrateGmailStorage(client)).toMatchObject({ applied: true, verified: true, runtimeGranted: true });
      expect((await client.query('SELECT * FROM context_gmail_private.connections ORDER BY id')).rows).toEqual(oldConnections);
      expect((await client.query('SELECT * FROM context_gmail_private.draft_operations ORDER BY operation_id')).rows).toEqual(expectedOperations);
      expect((await client.query(`SELECT obj_description(oid, 'pg_namespace') AS marker
        FROM pg_namespace WHERE nspname='context_gmail_private'`)).rows[0].marker).toBe('context-gmail-schema-v3');
    } finally { client.release(true); await upgrade.end(); }
  });

  it('upgrades populated v2 storage additively and preserves active credentials and uncertain outcomes', async () => {
    await admin.query('CREATE DATABASE context_gmail_v2_upgrade_test');
    const url = new URL(databaseUrl!); url.pathname = '/context_gmail_v2_upgrade_test';
    const upgrade = new pg.Pool({ connectionString: url.toString() });
    const client = await upgrade.connect();
    try {
      await client.query(GMAIL_STORAGE_V1_SQL);
      // Frozen v2 DDL, independent of the current migration implementation.
      await client.query(`ALTER TABLE context_gmail_private.connections ALTER COLUMN google_sub DROP NOT NULL,
        DROP CONSTRAINT connections_scopes_check, DROP CONSTRAINT connections_status_check;
        ALTER TABLE context_gmail_private.connections
        ADD CONSTRAINT connections_scopes_check CHECK (cardinality(granted_scopes) BETWEEN 0 AND 20 AND array_position(granted_scopes, NULL) IS NULL AND (google_sub IS NULL OR cardinality(granted_scopes) > 0)),
        ADD CONSTRAINT connections_status_check CHECK ((status IN ('active', 'revoking', 'needs_reauth') AND encrypted_refresh_token IS NOT NULL AND google_sub IS NOT NULL) OR (status = 'disconnected' AND encrypted_refresh_token IS NULL));
        ALTER TABLE context_gmail_private.draft_operations DROP COLUMN encrypted_content,
        ADD COLUMN google_sub text, ADD COLUMN retry_at timestamptz, DROP CONSTRAINT draft_operations_state_check;
        ALTER TABLE context_gmail_private.draft_operations
        ADD CONSTRAINT draft_operations_subject_check CHECK (google_sub IS NULL OR google_sub ~ '^[A-Za-z0-9_-]{1,255}$'),
        ADD CONSTRAINT draft_operations_retry_check CHECK ((state = 'retryable' AND retry_at IS NOT NULL) OR (state <> 'retryable' AND retry_at IS NULL)),
        ADD CONSTRAINT draft_operations_state_check CHECK (state IN ('dispatching', 'created', 'unknown', 'rejected', 'retryable'));
        COMMENT ON SCHEMA context_gmail_private IS 'context-gmail-schema-v2';`);
      await signV1Table(client, 'connections', 2);
      await signV1Table(client, 'draft_operations', 2);
      const id = randomUUID();
      const token = encryptGmailSecret('synthetic-v2-refresh-token', { purpose: 'refresh_token', employeeId: 1, id }, env);
      await client.query(`INSERT INTO context_gmail_private.connections
        (id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version, status)
        VALUES ($1, 1, 'synthetic-v2@wareongo.com', 'subject_v2', 'synthetic-v2@wareongo.com', $2, $3, 8, 'active')`, [id, token, scopes]);
      for (const state of ['created', 'unknown', 'dispatching', 'retryable', 'rejected']) {
        await client.query(`INSERT INTO context_gmail_private.draft_operations
          (employee_id, employee_email, operation_id, connection_id, connection_version, request_hash, state, draft_id, message_id, google_sub, retry_at)
          VALUES (1, 'synthetic-v2@wareongo.com', $1, $2, 8, $3, $4, $5, $6, 'subject_v2', $7)`,
        [randomUUID(), id, 'b'.repeat(64), state, state === 'created' ? 'draft_v2' : null,
          state === 'created' ? 'message_v2' : null, state === 'retryable' ? new Date('2026-10-06T06:00:00Z') : null]);
      }
      const beforeConnections = (await client.query('SELECT * FROM context_gmail_private.connections')).rows;
      const beforeOperations = (await client.query('SELECT * FROM context_gmail_private.draft_operations ORDER BY operation_id')).rows;
      for (let pass = 0; pass < 2; pass++) {
        expect(await migrateGmailStorage(client)).toMatchObject({ verified: true, runtimeGranted: true });
        expect((await client.query('SELECT * FROM context_gmail_private.connections')).rows).toEqual(beforeConnections);
        expect((await client.query('SELECT * FROM context_gmail_private.draft_operations ORDER BY operation_id')).rows).toEqual(beforeOperations);
        expect((await client.query('SELECT count(*)::int AS count FROM context_gmail_private.draft_update_operations')).rows[0].count).toBe(0);
      }
      const table = (await client.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid='context_gmail_private.draft_update_operations'::regclass`)).rows[0];
      expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(decryptGmailSecret(beforeConnections[0].encrypted_refresh_token, { purpose: 'refresh_token', employeeId: 1, id }, env))
        .toBe('synthetic-v2-refresh-token');
    } finally { client.release(true); await upgrade.end(); }
  });

  it('persists absent and repeated disconnects so stale first-connect callbacks cannot restore access', async () => {
    const owner = await employee();
    const first = await tx(client => disconnectGmailConnection(client, owner));
    expect(first).toMatchObject({ status: 'disconnected', googleSub: null, version: 1 });
    await expect(tx(client => saveGmailConnection(client, owner,
      { ...input(owner), expectedConnection: { id: null, version: null } }, env))).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    const second = await tx(client => disconnectGmailConnection(client, owner));
    expect(second!.version).toBe(2);
    await expect(tx(client => saveGmailConnection(client, owner,
      { ...input(owner), expectedConnection: { id: first!.id, version: first!.version } }, env))).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
  });

  it('keeps access disabled after failed revocation, serializes retry against callbacks, then erases the token', async () => {
    const owner = await employee(), connection = await connect(owner);
    await tx(client => disconnectGmailConnection(client, owner));
    await expect(tx(client => completeGmailDisconnect(client, owner, async () => { throw new Error('synthetic outage'); })))
      .rejects.toThrow('synthetic outage');
    expect(await tx(client => getGmailConnection(client, owner))).toMatchObject({ status: 'revoking' });
    await expect(connect(owner)).rejects.toMatchObject({ code: 'GMAIL_REVOCATION_PENDING' });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const completion = tx(client => completeGmailDisconnect(client, owner, async current => {
      expect(current.encryptedRefreshToken).toBeTruthy(); entered(); await gate;
    }));
    await started;
    const callback = tx(client => saveGmailConnection(client, owner, {
      ...input(owner), expectedConnection: { id: connection.id, version: connection.version },
    }, env));
    // Register rejection before releasing the provider gate, avoiding unhandled rejections.
    const rejected = expect(callback).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    release(); await completion; await rejected;
    const disconnected = await tx(client => getGmailConnection(client, owner));
    expect(disconnected).toMatchObject({ status: 'disconnected', encryptedRefreshToken: null });
    await connect(owner);
  });

  it('marks only the failed credential as needing reauthorization', async () => {
    const owner = await employee(), first = await connect(owner);
    expect(await tx(client => markGmailNeedsReauth(client, owner, first))).toBe(true);
    expect(await tx(client => getGmailConnection(client, owner))).toMatchObject({ status: 'needs_reauth' });
    const replacement = await connect(owner);
    expect(await tx(client => markGmailNeedsReauth(client, owner, first))).toBe(false);
    expect(await tx(client => getGmailConnection(client, owner))).toMatchObject({ status: 'active', version: replacement.version });
  });

  it.each(['absent', 'disconnected'] as const)('quarantines an unattached token over an %s connection and retains failed cleanup for retry', async initial => {
    const owner = await employee();
    const before = initial === 'disconnected' ? await tx(client => disconnectGmailConnection(client, owner)) : null;
    const issued = { googleSub: 'verified_orphan_subject', refreshToken: 'synthetic-orphan-refresh-token', grantedScopes: scopes };
    expect(await tx(client => quarantineGmailIssuedToken(client, owner, issued, env))).toBe('pending');
    const pending = await tx(client => getGmailConnection(client, owner));
    expect(pending).toMatchObject({ status: 'revoking', version: (before?.version ?? 0) + 1,
      googleSub: issued.googleSub, accountEmail: owner.employeeEmail });
    if (before) expect(pending!.id).toBe(before.id);
    expect(pending!.encryptedRefreshToken).toMatch(/^v1\./);
    expect(decryptGmailSecret(pending!.encryptedRefreshToken!,
      { purpose: 'refresh_token', employeeId: owner.employeeId, id: pending!.id }, env)).toBe(issued.refreshToken);
    await expect(connect(owner)).rejects.toMatchObject({ code: 'GMAIL_REVOCATION_PENDING' });
    await expect(tx(client => completeGmailDisconnect(client, owner, async () => { throw new Error('synthetic provider outage'); })))
      .rejects.toThrow('synthetic provider outage');
    expect(await tx(client => getGmailConnection(client, owner))).toEqual(pending);

    // A second failed callback for this same grant replaces the cleanup handle
    // while retaining the disconnected state and invalidating stale bindings.
    const later = { ...issued, refreshToken: 'synthetic-newer-orphan-refresh-token' };
    expect(await tx(client => quarantineGmailIssuedToken(client, owner, later, env))).toBe('pending');
    const replacement = await tx(client => getGmailConnection(client, owner));
    expect(replacement).toMatchObject({ id: pending!.id, status: 'revoking', version: pending!.version + 1 });
    let revoked = 0;
    const disconnected = await tx(client => completeGmailDisconnect(client, owner, async current => {
      expect(decryptGmailSecret(current.encryptedRefreshToken!,
        { purpose: 'refresh_token', employeeId: owner.employeeId, id: current.id }, env)).toBe(later.refreshToken);
      revoked++;
    }));
    expect(revoked).toBe(1);
    expect(disconnected).toMatchObject({ status: 'disconnected', encryptedRefreshToken: null, version: replacement!.version });
  });

  it('finishes an existing pending revocation after offboarding without restoring employee access', async () => {
    const owner = await employee(), connection = await connect(owner);
    await tx(client => disconnectGmailConnection(client, owner));
    await admin.query('UPDATE public."VerifiedNumber" SET is_active=false WHERE id=$1', [owner.employeeId]);
    await expect(tx(client => getGmailConnection(client, owner))).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
    await expect(connect(owner)).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
    let revoked = 0;
    const result = await tx(client => completeGmailDisconnect(client, owner, async current => {
      expect(current.id).toBe(connection.id);
      expect(decryptGmailSecret(current.encryptedRefreshToken!,
        { purpose: 'refresh_token', employeeId: owner.employeeId, id: current.id }, env)).toBe('synthetic-refresh-token');
      revoked++;
    }));
    expect(revoked).toBe(1);
    expect(result).toMatchObject({ status: 'disconnected', encryptedRefreshToken: null });
    expect((await admin.query('SELECT is_active FROM public."VerifiedNumber" WHERE id=$1', [owner.employeeId])).rows[0].is_active).toBe(false);
    await expect(tx(client => getGmailConnection(client, owner))).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
  });

  it('preserves a newer active grant when a stale callback has issued same-account or different-account credentials', async () => {
    const owner = await employee(), newer = await connect(owner, 'newer_verified_subject');
    const issued = { googleSub: newer.googleSub!, refreshToken: 'synthetic-discarded-flow-token', grantedScopes: scopes };
    expect(await tx(client => quarantineGmailIssuedToken(client, owner, issued, env))).toBe('covered');
    expect(await tx(client => getGmailConnection(client, owner))).toEqual(newer);
    expect(await tx(client => quarantineGmailIssuedToken(client, owner, { ...issued, googleSub: 'different_verified_subject' }, env))).toBe('manual');
    expect(await tx(client => getGmailConnection(client, owner))).toEqual(newer);
    let revokeCalled = false;
    await expect(tx(client => completeGmailDisconnect(client, owner, async () => { revokeCalled = true; })))
      .rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    expect(revokeCalled).toBe(false);
  });

  it('quarantines credentials arriving after offboarding and invalidates pending draft claims', async () => {
    const owner = await employee(), connection = await connect(owner), draft = claimInput(connection);
    await tx(client => claimGmailDraftOperation(client, owner, draft));
    await admin.query('UPDATE public."VerifiedNumber" SET is_active=false WHERE id=$1', [owner.employeeId]);
    const issued = { googleSub: connection.googleSub!, refreshToken: 'synthetic-offboarded-callback-token', grantedScopes: scopes };
    expect(await tx(client => quarantineGmailIssuedToken(client, owner, issued, env))).toBe('pending');
    const row = (await admin.query('SELECT status, version FROM context_gmail_private.connections WHERE employee_id=$1', [owner.employeeId])).rows[0];
    expect(row).toEqual({ status: 'revoking', version: connection.version + 1 });
    expect((await admin.query('SELECT state FROM context_gmail_private.draft_operations WHERE employee_id=$1 AND operation_id=$2',
      [owner.employeeId, draft.operationId])).rows[0].state).toBe('unknown');
    expect(await tx(client => completeGmailDisconnect(client, owner, async current => {
      expect(decryptGmailSecret(current.encryptedRefreshToken!,
        { purpose: 'refresh_token', employeeId: owner.employeeId, id: current.id }, env)).toBe(issued.refreshToken);
    }))).toMatchObject({ status: 'disconnected', encryptedRefreshToken: null });
  });

  it('retains historical references and reconciles uncertain drafts only for the same verified Google account', async () => {
    const owner = await employee(), connection = await connect(owner), draft = claimInput(connection);
    await tx(client => claimGmailDraftOperation(client, owner, draft));
    await tx(client => finishGmailDraftOperation(client, owner, draft.operationId, { state: 'unknown', reason: 'PROVIDER_UNCERTAIN' }));
    const replacement = await connect(owner);
    await expect(tx(client => claimGmailDraftOperation(client, owner, draft))).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    expect(await tx(client => finishGmailDraftOperation(client, owner, draft.operationId,
      { state: 'created', draftId: 'verified-draft', messageId: 'verified-message' }))).toMatchObject({ state: 'created' });
    const list = await tx(client => listGmailDraftReferences(client, owner, replacement, { limit: 10 }));
    expect(list.items.map(item => item.draft_ref)).toEqual([draft.operationId]);
    const changedAccount = await connect(owner, 'different_google_subject');
    expect((await tx(client => listGmailDraftReferences(client, owner, changedAccount, { limit: 10 }))).items).toEqual([]);
    const persisted = await tx(client => getGmailDraftOperation(client, owner, draft.operationId));
    expect(persisted!.googleSub).toBe('synthetic_google_subject');
  });

  it('honors persisted retry deadlines and permits one concurrent claim, while unknown attempts never re-dispatch', async () => {
    const owner = await employee(), connection = await connect(owner), draft = claimInput(connection);
    await tx(client => claimGmailDraftOperation(client, owner, draft));
    expect(await tx(client => finishGmailDraftOperation(client, owner, draft.operationId,
      { state: 'retryable', reason: 'GMAIL_RATE_LIMITED', retryAfterMs: 60_000 }))).toMatchObject({ state: 'retryable' });
    expect((await tx(client => claimGmailDraftOperation(client, owner, draft))).claimed).toBe(false);
    await admin.query(`UPDATE context_gmail_private.draft_operations SET retry_at=clock_timestamp()-interval '1 second'
      WHERE employee_id=$1 AND operation_id=$2`, [owner.employeeId, draft.operationId]);
    const contenders = await Promise.all([1, 2, 3].map(() => tx(client => claimGmailDraftOperation(client, owner, draft))));
    expect(contenders.filter(result => result.claimed)).toHaveLength(1);
    await tx(client => finishGmailDraftOperation(client, owner, draft.operationId, { state: 'unknown', reason: 'PROVIDER_UNCERTAIN' }));
    expect((await tx(client => claimGmailDraftOperation(client, owner, draft))).claimed).toBe(false);
  });

  const savedDraft = async () => {
    const owner = await employee(), connection = await connect(owner), creation = claimInput(connection);
    await tx(client => claimGmailDraftOperation(client, owner, creation));
    await tx(client => finishGmailDraftOperation(client, owner, creation.operationId,
      { state: 'created', draftId: 'same_draft', messageId: 'initial_message' }));
    return { owner, connection, creation, update: { ...claimInput(connection),
      draftRef: creation.operationId, draftId: 'same_draft', expectedMessageId: 'initial_message' } };
  };

  it('permits one concurrent claim and prevents a different update while the same draft is unresolved', async () => {
    const h = await savedDraft();
    const claims = await Promise.all([1, 2, 3].map(() => tx(client => claimGmailDraftUpdateOperation(client, h.owner, h.update))));
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    await expect(tx(client => claimGmailDraftUpdateOperation(client, h.owner,
      { ...h.update, operationId: randomUUID() }))).rejects.toMatchObject({ code: 'GMAIL_DRAFT_UPDATE_PENDING' });
    await tx(client => finishGmailDraftUpdateOperation(client, h.owner, h.update.operationId,
      { state: 'unknown', reason: 'PROVIDER_UNCERTAIN' }));
    expect((await tx(client => claimGmailDraftUpdateOperation(client, h.owner, h.update))).claimed).toBe(false);
    await expect(tx(client => claimGmailDraftUpdateOperation(client, h.owner,
      { ...h.update, operationId: randomUUID() }))).rejects.toMatchObject({ code: 'GMAIL_DRAFT_UPDATE_PENDING' });
    expect(await tx(client => finishGmailDraftUpdateOperation(client, h.owner, h.update.operationId,
      { state: 'rejected', reason: 'GMAIL_DRAFT_CHANGED' }))).toMatchObject({ state: 'unknown' });
    expect(await tx(client => finishGmailDraftUpdateOperation(client, h.owner, h.update.operationId,
      { state: 'updated', messageId: 'updated_message' }))).toMatchObject({ state: 'updated', draftRef: h.creation.operationId });
    const next = { ...h.update, operationId: randomUUID(), expectedMessageId: 'updated_message' };
    expect((await tx(client => claimGmailDraftUpdateOperation(client, h.owner, next))).claimed).toBe(true);
  });

  it('binds an edit operation to content, revision and original owned app-created draft', async () => {
    const h = await savedDraft();
    await tx(client => claimGmailDraftUpdateOperation(client, h.owner, h.update));
    for (const patch of [{ requestHash: 'c'.repeat(64) }, { expectedMessageId: 'different_message' }])
      await expect(tx(client => claimGmailDraftUpdateOperation(client, h.owner, { ...h.update, ...patch })))
        .rejects.toMatchObject({ code: 'GMAIL_OPERATION_CONFLICT' });
    const other = await savedDraft();
    await expect(tx(client => claimGmailDraftUpdateOperation(client, other.owner,
      { ...other.update, draftRef: h.creation.operationId }))).rejects.toMatchObject({ code: 'GMAIL_DRAFT_UNAVAILABLE' });
    expect(await tx(client => getGmailDraftUpdateOperation(client, other.owner, h.update.operationId))).toBeNull();
    await expect(tx(client => claimGmailDraftUpdateOperation(client, h.owner,
      { ...h.update, operationId: randomUUID(), draftId: 'foreign_provider_draft' })))
      .rejects.toMatchObject({ code: 'GMAIL_DRAFT_UNAVAILABLE' });
  });

  it('records an in-flight result after revocation without reopening employee access or retrying the write', async () => {
    const h = await savedDraft();
    await tx(client => claimGmailDraftUpdateOperation(client, h.owner, h.update));
    await admin.query('UPDATE public."VerifiedNumber" SET is_active=false WHERE id=$1', [h.owner.employeeId]);
    expect(await tx(client => finishGmailDraftUpdateOperation(client, h.owner, h.update.operationId,
      { state: 'updated', messageId: 'updated_after_offboarding' }))).toMatchObject({ state: 'updated' });
    await expect(tx(client => getGmailDraftUpdateOperation(client, h.owner, h.update.operationId)))
      .rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
    await expect(tx(client => claimGmailDraftUpdateOperation(client, h.owner, h.update)))
      .rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
  });

});
