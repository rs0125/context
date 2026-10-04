import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';
import { EXPECTED_RUNTIME_POLICY, RUNTIME_ROLE } from './runtime-policy.mjs';

// Staged by default. Private undo snapshots are encrypted by the application before storage.
const SCHEMA = 'context_crm_private';
const TABLE = `${SCHEMA}.write_operations`;
const MARKER = 'context-crm-write-schema-v2';
const LEGACY_MARKER = 'context-crm-write-schema-v1';
const TABLE_MARKER = 'context-crm-write-receipts-v2:';
const LEGACY_TABLE_MARKER = 'context-crm-write-receipts-v1:';
const LEGACY_COLUMNS = [['employee_id', 'integer'], ['employee_email', 'text'], ['operation_id', 'uuid'], ['member_id', 'uuid'],
  ['action', 'text'], ['request_hash', 'text'], ['state', 'text'], ['resource_id', 'uuid'],
  ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']];
const COLUMNS = [...LEGACY_COLUMNS, ['encrypted_snapshot', 'text']];
const CONSTRAINTS = ['write_operations_pkey', 'write_operations_employee_check', 'write_operations_email_check',
  'write_operations_action_check', 'write_operations_hash_check', 'write_operations_state_check', 'write_operations_result_check'];
export const CRM_WRITE_TABLE_SQL = `CREATE TABLE ${TABLE} (
  employee_id integer NOT NULL, employee_email text NOT NULL, operation_id uuid NOT NULL, member_id uuid NOT NULL,
  action text NOT NULL, request_hash text NOT NULL, state text NOT NULL, resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  encrypted_snapshot text,
  PRIMARY KEY (employee_id, operation_id),
  CONSTRAINT write_operations_employee_check CHECK (employee_id > 0),
  CONSTRAINT write_operations_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
  CONSTRAINT write_operations_action_check CHECK (action IN ('create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq')),
  CONSTRAINT write_operations_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT write_operations_state_check CHECK (state IN ('dispatching', 'created', 'updated', 'undone', 'unknown', 'rejected')),
  CONSTRAINT write_operations_result_check CHECK ((state IN ('created', 'updated', 'undone')) = (resource_id IS NOT NULL))
)`;
const fail = code => { throw new Error(code); };
async function inspect(client, legacy = false) {
  const table = (await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned, obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'write_operations'`, [SCHEMA])).rows[0];
  if (!table || !table.owned || table.relkind !== 'r' || table.relpersistence !== 'p' || table.relispartition || !table.relrowsecurity || !table.relforcerowsecurity) fail('CRM_RELATION_INCOMPATIBLE');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 ORDER BY a.attnum`, [table.oid])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated, pg_get_constraintdef(oid, true) AS definition
    FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [table.oid])).rows;
  const objects = (await client.query(`SELECT
    (SELECT count(*)::integer FROM pg_policy WHERE polrelid = $1 AND NOT COALESCE((${EXPECTED_RUNTIME_POLICY}), false)) AS policies,
    (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = $1) AS rules,
    (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1) AS inheritance`, [table.oid])).rows[0];
  const expectedColumns = legacy ? LEGACY_COLUMNS : COLUMNS;
  if (columns.length !== expectedColumns.length || columns.some((col, i) => col.name !== expectedColumns[i][0] || col.type !== expectedColumns[i][1]
    || col.not_null !== (!['resource_id', 'encrypted_snapshot'].includes(col.name)) || col.identity || col.generated || col.dropped
    || col.default_expression !== (['created_at', 'updated_at'].includes(col.name) ? 'CURRENT_TIMESTAMP' : null))
    || constraints.length !== CONSTRAINTS.length || constraints.some(c => !c.validated || !CONSTRAINTS.includes(c.name) || c.type !== (c.name.endsWith('_pkey') ? 'p' : 'c'))
    || !objects || Object.values(objects).some(v => v !== 0)) fail('CRM_RELATION_INCOMPATIBLE');
  return { ...table, signature: createHash('sha256').update(JSON.stringify({ columns, constraints })).digest('hex') };
}

export async function migrateCrmWrites(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406261) AS locked')).rows[0];
    if (!lock?.locked) fail('CRM_MIGRATION_BUSY');
    const role = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || (!role.rolsuper && !role.rolbypassrls)) fail('CRM_ROLE_REQUIRES_RLS_BYPASS');
    const schema = (await client.query(`SELECT n.oid, n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(n.oid, 'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname = $1`, [SCHEMA])).rows[0];
    if (schema) {
      if (!schema.owned || ![MARKER, LEGACY_MARKER].includes(schema.marker)) fail('CRM_SCHEMA_COLLISION');
      const legacy = schema.marker === LEGACY_MARKER;
      const tableMarker = legacy ? LEGACY_TABLE_MARKER : TABLE_MARKER;
      const extra = (await client.query(`SELECT
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace = $1 AND relname NOT IN ('write_operations', 'write_operations_pkey')) AS relations,
        (SELECT count(*)::integer FROM pg_proc WHERE pronamespace = $1) AS routines`, [schema.oid])).rows[0];
      if (!extra || Object.values(extra).some(v => v !== 0)) fail('CRM_SCHEMA_COLLISION');
      let table = await inspect(client, legacy);
      if (table.marker !== tableMarker + table.signature) fail('CRM_RELATION_COLLISION');
      await client.query(`LOCK TABLE ${TABLE} IN SHARE ROW EXCLUSIVE MODE`);
      table = await inspect(client, legacy);
      if (table.marker !== tableMarker + table.signature) fail('CRM_RELATION_COLLISION');
      if (legacy) {
        await client.query(`ALTER TABLE ${TABLE}
          ADD COLUMN encrypted_snapshot text,
          DROP CONSTRAINT write_operations_action_check,
          ADD CONSTRAINT write_operations_action_check CHECK (action IN ('create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq')),
          DROP CONSTRAINT write_operations_state_check,
          ADD CONSTRAINT write_operations_state_check CHECK (state IN ('dispatching', 'created', 'updated', 'undone', 'unknown', 'rejected')),
          DROP CONSTRAINT write_operations_result_check,
          ADD CONSTRAINT write_operations_result_check CHECK ((state IN ('created', 'updated', 'undone')) = (resource_id IS NOT NULL))`);
        const upgraded = await inspect(client);
        await client.query(`COMMENT ON TABLE ${TABLE} IS '${TABLE_MARKER}${upgraded.signature}'`);
        await client.query(`COMMENT ON SCHEMA ${SCHEMA} IS '${MARKER}'`);
      }
    } else {
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`COMMENT ON SCHEMA ${SCHEMA} IS '${MARKER}'`);
      await client.query(CRM_WRITE_TABLE_SQL);
      await client.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
      const table = await inspect(client);
      await client.query(`COMMENT ON TABLE ${TABLE} IS '${TABLE_MARKER}${table.signature}'`);
    }
    const blocked = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')")).rows;
    for (const name of ['PUBLIC', ...blocked.map(row => row.rolname)]) {
      if (!['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(name)) fail('CRM_UNEXPECTED_ROLE');
      await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${name}`);
      await client.query(`REVOKE ALL ON TABLE ${TABLE} FROM ${name}`);
    }
    const runtime = (await client.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS memberships FROM pg_roles r WHERE rolname = $1`, [RUNTIME_ROLE])).rows[0];
    if (runtime) {
      if (Object.values(runtime).some(v => v !== false)) fail('CRM_RUNTIME_ROLE_UNSAFE');
      await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${RUNTIME_ROLE}`);
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RUNTIME_ROLE}`);
      await client.query(`REVOKE ALL ON TABLE ${TABLE} FROM ${RUNTIME_ROLE}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${TABLE} TO ${RUNTIME_ROLE}`);
      const policies = (await client.query('SELECT polname FROM pg_policy WHERE polrelid = to_regclass($1)', [TABLE])).rows;
      if (!policies.length) await client.query(`CREATE POLICY context_runtime ON ${TABLE} FOR ALL TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
    }
    const privacy = (await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = $1 AND a.grantee = 0) AS no_public_schema,
      NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = to_regclass($2) AND a.grantee = 0) AS no_public_table,
      NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
        (has_schema_privilege(r.oid, $1, 'USAGE, CREATE') OR has_table_privilege(r.oid, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
          OR has_any_column_privilege(r.oid, $2, 'SELECT, INSERT, UPDATE, REFERENCES'))) AS no_api_role_access`, [SCHEMA, TABLE])).rows[0];
    if (!privacy || Object.values(privacy).some(v => v !== true)) fail('CRM_PRIVACY_UNVERIFIED');
    if (runtime) {
      const access = (await client.query(`SELECT has_schema_privilege($1, $2, 'USAGE') AND NOT has_schema_privilege($1, $2, 'CREATE')
        AND has_table_privilege($1, $3, 'SELECT') AND has_table_privilege($1, $3, 'INSERT') AND has_table_privilege($1, $3, 'UPDATE')
        AND NOT has_table_privilege($1, $3, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
        AND NOT has_any_column_privilege($1, $3, 'REFERENCES') AS safe`, [RUNTIME_ROLE, SCHEMA, TABLE])).rows[0];
      if (access?.safe !== true) fail('CRM_RUNTIME_GRANTS_UNSAFE');
    }
    const verified = await inspect(client);
    if (verified.marker !== TABLE_MARKER + verified.signature) fail('CRM_RELATION_COLLISION');
    await client.query('COMMIT');
    return { applied: true, verified: true, runtimeGranted: Boolean(runtime), businessWrites: false };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
export async function runCrmWriteMigration(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'env-file': { type: 'string', default: '.env.local' } } });
  if (!values.apply) { console.log(JSON.stringify({ staged: true, applied: false, schema: SCHEMA })); return; }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool(migrationDatabaseOptions(env)); pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await migrateCrmWrites(client))); }
  finally { client?.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCrmWriteMigration().catch(error => { console.error(/^CRM_[A-Z_]+$/.test(error.message) ? error.message : 'CRM_MIGRATION_FAILED'); process.exitCode = 1; });
}
