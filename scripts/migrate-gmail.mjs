import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';
import { EXPECTED_RUNTIME_POLICY, RUNTIME_ROLE } from './runtime-policy.mjs';

// Private integration state only; never modifies Warehouse, CRM or roster.
// The default CLI invocation does not read environment files or connect to a DB.
const SCHEMA = 'context_gmail_private';
const MARKER = 'context-gmail-schema-v2';
const TABLE_MARKER = 'context-gmail-table-v2:';
const LEGACY_MARKER = 'context-gmail-schema-v1';
const LEGACY_TABLE_MARKER = 'context-gmail-table-v1:';
const BLOCKED_ROLES = ['anon', 'authenticated', 'service_role'];
const TABLES = {
  connections: {
    columns: [['id', 'uuid'], ['employee_id', 'integer'], ['employee_email', 'text'], ['google_sub', 'text'],
      ['account_email', 'text'], ['encrypted_refresh_token', 'text'], ['granted_scopes', 'text[]'],
      ['version', 'integer'], ['status', 'text'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']],
    nullable: ['google_sub', 'encrypted_refresh_token'],
    constraints: { connections_pkey: 'p', connections_employee_id_key: 'u', connections_id_employee_id_key: 'u',
      connections_employee_check: 'c', connections_email_check: 'c', connections_subject_check: 'c',
      connections_account_check: 'c', connections_token_check: 'c', connections_scopes_check: 'c',
      connections_version_check: 'c', connections_status_check: 'c' },
    create: `CREATE TABLE context_gmail_private.connections (
      id uuid PRIMARY KEY, employee_id integer NOT NULL UNIQUE, employee_email text NOT NULL,
      google_sub text, account_email text NOT NULL, encrypted_refresh_token text,
      granted_scopes text[] NOT NULL, version integer NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (id, employee_id),
      CONSTRAINT connections_employee_check CHECK (employee_id > 0),
      CONSTRAINT connections_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
      CONSTRAINT connections_subject_check CHECK (google_sub ~ '^[A-Za-z0-9_-]{1,255}$'),
      CONSTRAINT connections_account_check CHECK (account_email = employee_email),
      CONSTRAINT connections_token_check CHECK (encrypted_refresh_token IS NULL OR (char_length(encrypted_refresh_token) <= 12000 AND encrypted_refresh_token ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$')),
      CONSTRAINT connections_scopes_check CHECK (cardinality(granted_scopes) BETWEEN 0 AND 20 AND array_position(granted_scopes, NULL) IS NULL AND (google_sub IS NULL OR cardinality(granted_scopes) > 0)),
      CONSTRAINT connections_version_check CHECK (version > 0),
      CONSTRAINT connections_status_check CHECK ((status IN ('active', 'revoking', 'needs_reauth') AND encrypted_refresh_token IS NOT NULL AND google_sub IS NOT NULL) OR (status = 'disconnected' AND encrypted_refresh_token IS NULL))
    )`,
  },
  draft_operations: {
    columns: [['employee_id', 'integer'], ['employee_email', 'text'], ['operation_id', 'uuid'], ['connection_id', 'uuid'],
      ['connection_version', 'integer'], ['request_hash', 'text'], ['state', 'text'],
      ['draft_id', 'text'], ['message_id', 'text'], ['reason', 'text'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone'],
      ['google_sub', 'text'], ['retry_at', 'timestamp with time zone']],
    nullable: ['google_sub', 'retry_at', 'draft_id', 'message_id', 'reason'],
    constraints: { draft_operations_pkey: 'p', draft_operations_connection_fkey: 'f', draft_operations_employee_check: 'c',
      draft_operations_email_check: 'c', draft_operations_version_check: 'c', draft_operations_hash_check: 'c',
      draft_operations_subject_check: 'c', draft_operations_retry_check: 'c', draft_operations_state_check: 'c', draft_operations_result_check: 'c', draft_operations_reason_check: 'c' },
    create: `CREATE TABLE context_gmail_private.draft_operations (
      employee_id integer NOT NULL, employee_email text NOT NULL, operation_id uuid NOT NULL,
      connection_id uuid NOT NULL, connection_version integer NOT NULL, request_hash text NOT NULL,
      state text NOT NULL, draft_id text, message_id text, reason text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      google_sub text, retry_at timestamptz,
      PRIMARY KEY (employee_id, operation_id),
      CONSTRAINT draft_operations_connection_fkey FOREIGN KEY (connection_id, employee_id) REFERENCES context_gmail_private.connections (id, employee_id),
      CONSTRAINT draft_operations_employee_check CHECK (employee_id > 0),
      CONSTRAINT draft_operations_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
      CONSTRAINT draft_operations_version_check CHECK (connection_version > 0),
      CONSTRAINT draft_operations_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT draft_operations_subject_check CHECK (google_sub IS NULL OR google_sub ~ '^[A-Za-z0-9_-]{1,255}$'),
      CONSTRAINT draft_operations_retry_check CHECK ((state = 'retryable' AND retry_at IS NOT NULL) OR (state <> 'retryable' AND retry_at IS NULL)),
      CONSTRAINT draft_operations_state_check CHECK (state IN ('dispatching', 'created', 'unknown', 'rejected', 'retryable')),
      CONSTRAINT draft_operations_result_check CHECK ((state = 'created' AND draft_id IS NOT NULL AND message_id IS NOT NULL AND char_length(draft_id) <= 256 AND char_length(message_id) <= 256 AND draft_id ~ '^[A-Za-z0-9_-]+$' AND message_id ~ '^[A-Za-z0-9_-]+$') OR (state <> 'created' AND draft_id IS NULL AND message_id IS NULL)),
      CONSTRAINT draft_operations_reason_check CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{0,79}$')
    )`,
  },
};

// Validate the original deployment and its signed table descriptions before
// upgrading. Never adopt an unrelated schema or guess an old draft's identity.
const LEGACY_TABLES = {
  connections: { ...TABLES.connections, nullable: ['encrypted_refresh_token'] },
  draft_operations: {
    columns: [...TABLES.draft_operations.columns.slice(0, 6), ['encrypted_content', 'text'], ...TABLES.draft_operations.columns.slice(6, -2)],
    nullable: ['encrypted_content', 'draft_id', 'message_id', 'reason'],
    constraints: Object.fromEntries([...Object.entries(TABLES.draft_operations.constraints)
      .filter(([name]) => !['draft_operations_subject_check', 'draft_operations_retry_check'].includes(name)), ['draft_operations_content_check', 'c']]),
  },
};

class MigrationError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new MigrationError(code); }

async function inspect(client, name, definitions = TABLES) {
  const expected = definitions[name];
  const table = (await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
    obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [SCHEMA, name])).rows[0];
  if (!table || !table.owned || table.relkind !== 'r' || table.relpersistence !== 'p' || table.relispartition
    || !table.relrowsecurity || !table.relforcerowsecurity) fail('GMAIL_RELATION_INCOMPATIBLE');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped,
    pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table.oid])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated,
    pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [table.oid])).rows;
  const objects = (await client.query(`SELECT
    (SELECT count(*)::integer FROM pg_policy WHERE polrelid = $1 AND NOT COALESCE((${EXPECTED_RUNTIME_POLICY}), false)) AS policies,
    (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = $1) AS rules,
    (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1) AS inheritance`, [table.oid])).rows[0];
  if (columns.length !== expected.columns.length || columns.some((column, i) => column.name !== expected.columns[i][0]
    || column.type !== expected.columns[i][1] || column.not_null !== !expected.nullable.includes(column.name)
    || column.identity || column.generated || column.dropped
    || column.default_expression !== (['created_at', 'updated_at'].includes(column.name) ? 'CURRENT_TIMESTAMP' : null))
    || constraints.length !== Object.keys(expected.constraints).length || constraints.some(constraint => !constraint.validated
      || expected.constraints[constraint.name] !== constraint.type)
    || !objects || Object.values(objects).some(value => value !== 0)) fail('GMAIL_RELATION_INCOMPATIBLE');
  return { ...table, signature: createHash('sha256').update(JSON.stringify({ columns, constraints })).digest('hex') };
}

export async function migrateGmailStorage(client) {
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406260) AS locked')).rows[0];
    if (!lock?.locked) fail('GMAIL_MIGRATION_BUSY');
    const role = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || (!role.rolsuper && !role.rolbypassrls)) fail('GMAIL_ROLE_REQUIRES_RLS_BYPASS');
    const schema = (await client.query(`SELECT n.oid, n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(n.oid, 'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname = $1`, [SCHEMA])).rows[0];
    if (schema && (!schema.owned || ![MARKER, LEGACY_MARKER].includes(schema.marker))) fail('GMAIL_SCHEMA_COLLISION');
    if (schema) {
      const collisions = (await client.query(`SELECT
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace = $1 AND relname NOT IN
          ('connections', 'connections_pkey', 'connections_employee_id_key', 'connections_id_employee_id_key', 'draft_operations', 'draft_operations_pkey')) AS relations,
        (SELECT count(*)::integer FROM pg_proc WHERE pronamespace = $1) AS routines`, [schema.oid])).rows[0];
      if (!collisions || Object.values(collisions).some(value => value !== 0)) fail('GMAIL_SCHEMA_COLLISION');
      await client.query('LOCK TABLE context_gmail_private.connections, context_gmail_private.draft_operations IN SHARE ROW EXCLUSIVE MODE');
      const upgrading = schema.marker === LEGACY_MARKER;
      for (const name of Object.keys(TABLES)) {
        const table = await inspect(client, name, upgrading ? LEGACY_TABLES : TABLES);
        if (table.marker !== `${upgrading ? LEGACY_TABLE_MARKER : TABLE_MARKER}${table.signature}`) fail('GMAIL_RELATION_COLLISION');
      }
      if (upgrading) {
        await client.query(`ALTER TABLE ${SCHEMA}.connections ALTER COLUMN google_sub DROP NOT NULL,
          DROP CONSTRAINT connections_scopes_check, DROP CONSTRAINT connections_status_check`);
        await client.query(`ALTER TABLE ${SCHEMA}.draft_operations DROP COLUMN encrypted_content,
          ADD COLUMN google_sub text, ADD COLUMN retry_at timestamptz, DROP CONSTRAINT draft_operations_state_check`);
        for (const [name, constraints] of [
          ['connections', ['connections_scopes_check', 'connections_status_check']],
          ['draft_operations', ['draft_operations_subject_check', 'draft_operations_retry_check', 'draft_operations_state_check']],
        ]) {
          for (const constraint of constraints) {
            const definition = TABLES[name].create.split('\n').find(line => line.trim().startsWith(`CONSTRAINT ${constraint} `)).trim().replace(/,$/, '');
            await client.query(`ALTER TABLE ${SCHEMA}.${name} ADD ${definition}`);
          }
        }
        // A v1 operation has proven mailbox identity only if its credential
        // generation still matches. Older references remain unavailable rather
        // than being assigned to a potentially different Google subject.
        await client.query(`UPDATE ${SCHEMA}.draft_operations AS operation SET google_sub = connection.google_sub
          FROM ${SCHEMA}.connections AS connection WHERE operation.connection_id = connection.id
            AND operation.employee_id = connection.employee_id AND operation.employee_email = connection.employee_email
            AND operation.connection_version = connection.version`);
        await client.query(`COMMENT ON SCHEMA ${SCHEMA} IS '${MARKER}'`);
        for (const name of Object.keys(TABLES)) {
          const table = await inspect(client, name);
          await client.query(`COMMENT ON TABLE ${SCHEMA}.${name} IS '${TABLE_MARKER}${table.signature}'`);
        }
      }
    } else {
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`COMMENT ON SCHEMA ${SCHEMA} IS '${MARKER}'`);
      for (const [name, definition] of Object.entries(TABLES)) {
        await client.query(definition.create);
        await client.query(`ALTER TABLE ${SCHEMA}.${name} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${SCHEMA}.${name} FORCE ROW LEVEL SECURITY`);
        const table = await inspect(client, name);
        await client.query(`COMMENT ON TABLE ${SCHEMA}.${name} IS '${TABLE_MARKER}${table.signature}'`);
      }
    }
    for (const name of Object.keys(TABLES)) {
      const table = await inspect(client, name);
      if (table.marker !== `${TABLE_MARKER}${table.signature}`) fail('GMAIL_RELATION_COLLISION');
    }
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname")).rows;
    for (const name of ['PUBLIC', ...roles.map(row => row.rolname)]) {
      if (name !== 'PUBLIC' && !BLOCKED_ROLES.includes(name)) fail('GMAIL_UNEXPECTED_ROLE');
      const grantee = name === 'PUBLIC' ? 'PUBLIC' : `"${name}"`;
      await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${grantee}`);
      for (const table of Object.keys(TABLES)) await client.query(`REVOKE ALL ON TABLE ${SCHEMA}.${table} FROM ${grantee}`);
    }
    const runtime = (await client.query(`SELECT oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS memberships
      FROM pg_roles r WHERE rolname = $1`, [RUNTIME_ROLE])).rows[0];
    if (runtime) {
      if (['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'memberships'].some(flag => runtime[flag] !== false)) fail('GMAIL_RUNTIME_ROLE_UNSAFE');
      await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${RUNTIME_ROLE}`);
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RUNTIME_ROLE}`);
      for (const table of Object.keys(TABLES)) {
        await client.query(`REVOKE ALL ON TABLE ${SCHEMA}.${table} FROM ${RUNTIME_ROLE}`);
        await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${SCHEMA}.${table} TO ${RUNTIME_ROLE}`);
        const policies = (await client.query('SELECT polname FROM pg_policy WHERE polrelid = to_regclass($1)', [`${SCHEMA}.${table}`])).rows;
        if (!policies.length) await client.query(`CREATE POLICY context_runtime ON ${SCHEMA}.${table} FOR ALL TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
      }
    }
    const privacy = (await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = $1 AND a.grantee = 0) AS no_public_schema,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
        WHERE n.nspname = $1 AND c.relkind = 'r' AND a.grantee = 0) AS no_public_table,
      NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
        (has_schema_privilege(r.oid, $1, 'USAGE, CREATE') OR EXISTS
          (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND
            (has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))))) AS no_api_role_access`, [SCHEMA])).rows[0];
    if (!privacy || Object.values(privacy).some(value => value !== true)) fail('GMAIL_PRIVACY_UNVERIFIED');
    if (runtime) {
      const access = (await client.query(`SELECT
        has_schema_privilege($1, $2, 'USAGE') AND NOT has_schema_privilege($1, $2, 'CREATE') AS schema_safe,
        NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $2 AND c.relkind = 'r' AND (
            NOT has_table_privilege($1, c.oid, 'SELECT') OR NOT has_table_privilege($1, c.oid, 'INSERT') OR NOT has_table_privilege($1, c.oid, 'UPDATE')
            OR has_table_privilege($1, c.oid, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege($1, c.oid, 'REFERENCES'))) AS tables_safe`, [RUNTIME_ROLE, SCHEMA])).rows[0];
      if (!access || Object.values(access).some(value => value !== true)) fail('GMAIL_RUNTIME_GRANTS_UNSAFE');
      for (const name of Object.keys(TABLES)) await inspect(client, name);
    }
    await client.query('COMMIT'); transaction = false;
    return { applied: true, verified: true, seededConnections: 0, runtimeGranted: Boolean(runtime) };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof MigrationError) throw error;
    fail('GMAIL_MIGRATION_FAILED');
  }
}

export async function runGmailMigration(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'env-file': { type: 'string', default: '.env.local' } } });
  if (!values.apply) {
    console.log(JSON.stringify({ staged: true, applied: false, requiresExplicitApply: true, schema: SCHEMA })); return;
  }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool({ ...migrationDatabaseOptions(env), application_name: 'context-gmail-storage-migration' });
  pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await migrateGmailStorage(client))); }
  finally { if (client) client.release(true); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGmailMigration().catch(error => {
    console.error(JSON.stringify({ error: error instanceof MigrationError ? error.code : 'GMAIL_MIGRATION_FAILED' })); process.exitCode = 1;
  });
}
