import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';

// Without --apply this command performs no network or database work.
// Prompt overrides live in their own private schema; no source records change.
const SCHEMA = 'context_prompts_private';
const MARKER = 'context-prompts-schema-v1';
const TABLE_MARKER = 'context-prompt-overrides-v1:';
const COLUMNS = [['id', 'text'], ['body', 'text'], ['revision', 'uuid'],
  ['updated_at', 'timestamp with time zone'], ['updated_by', 'text']];
const BLOCKED_ROLES = ['anon', 'authenticated', 'service_role'];
const CONSTRAINT_NAMES = ['prompt_overrides_pkey', 'prompt_overrides_id_check', 'prompt_overrides_body_check', 'prompt_overrides_editor_check'];
const CREATE_TABLE = `CREATE TABLE context_prompts_private.prompt_overrides (
  id text PRIMARY KEY,
  body text,
  revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by text NOT NULL,
  CONSTRAINT prompt_overrides_id_check CHECK (id IN ('mcp', 'analytics', 'rest') OR id ~ '^tool[.][a-z][a-z0-9_]{0,79}$'),
  CONSTRAINT prompt_overrides_body_check CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 20000 AND char_length(btrim(body)) > 0)),
  CONSTRAINT prompt_overrides_editor_check CHECK (updated_by = lower(updated_by) AND char_length(updated_by) <= 254 AND updated_by ~ '^[^[:space:]@]+@wareongo[.]com$')
)`;

class MigrationError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new MigrationError(code); }

async function inspect(client) {
  const table = (await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned, obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'prompt_overrides'`, [SCHEMA])).rows[0];
  if (!table || !table.owned || table.relkind !== 'r' || table.relpersistence !== 'p' || table.relispartition || !table.relrowsecurity || !table.relforcerowsecurity) fail('PROMPTS_RELATION_INCOMPATIBLE');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 ORDER BY a.attnum`, [table.oid])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated, pg_get_constraintdef(oid, true) AS definition
    FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [table.oid])).rows;
  const objects = (await client.query(`SELECT (SELECT count(*)::integer FROM pg_policy WHERE polrelid = $1) AS policies,
    (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = $1) AS rules,
    (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1) AS inheritance`, [table.oid])).rows[0];
  if (columns.length !== COLUMNS.length || columns.some((column, index) => column.name !== COLUMNS[index][0] || column.type !== COLUMNS[index][1]
    || column.not_null !== (column.name !== 'body') || column.identity || column.generated || column.dropped
    || column.default_expression !== (column.name === 'updated_at' ? 'CURRENT_TIMESTAMP' : null))
    || constraints.length !== CONSTRAINT_NAMES.length || constraints.some(constraint => !constraint.validated || !CONSTRAINT_NAMES.includes(constraint.name)
      || constraint.type !== (constraint.name.endsWith('_pkey') ? 'p' : constraint.name.endsWith('_key') ? 'u' : 'c'))
    || !objects || Object.values(objects).some(count => count !== 0)) fail('PROMPTS_RELATION_INCOMPATIBLE');
  return { ...table, constraints, signature: createHash('sha256').update(JSON.stringify({ columns, constraints })).digest('hex') };
}

export async function migratePromptStorage(client) {
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406257) AS locked')).rows[0];
    if (!lock?.locked) fail('PROMPTS_MIGRATION_BUSY');
    const role = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || (!role.rolsuper && !role.rolbypassrls)) fail('PROMPTS_ROLE_REQUIRES_RLS_BYPASS');
    const schema = (await client.query(`SELECT n.oid, n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(n.oid, 'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname = $1`, [SCHEMA])).rows[0];
    let table;
    if (schema) {
      if (!schema.owned || schema.marker !== MARKER) fail('PROMPTS_SCHEMA_COLLISION');
      const collisions = (await client.query(`SELECT
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace = $1 AND relname NOT IN ('prompt_overrides', 'prompt_overrides_pkey')) AS relations,
        (SELECT count(*)::integer FROM pg_proc WHERE pronamespace = $1) AS routines`, [schema.oid])).rows[0];
      if (!collisions || Object.values(collisions).some(count => count !== 0)) fail('PROMPTS_SCHEMA_COLLISION');
      table = await inspect(client);
      if (table.marker !== `${TABLE_MARKER}${table.signature}`) fail('PROMPTS_RELATION_COLLISION');
      await client.query('LOCK TABLE context_prompts_private.prompt_overrides IN SHARE ROW EXCLUSIVE MODE');
      table = await inspect(client);
      if (table.marker !== `${TABLE_MARKER}${table.signature}`) fail('PROMPTS_RELATION_COLLISION');
    } else {
      await client.query('CREATE SCHEMA context_prompts_private');
      await client.query(`COMMENT ON SCHEMA context_prompts_private IS '${MARKER}'`);
      await client.query(CREATE_TABLE);
      await client.query('ALTER TABLE context_prompts_private.prompt_overrides ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE context_prompts_private.prompt_overrides FORCE ROW LEVEL SECURITY');
      table = await inspect(client);
      await client.query(`COMMENT ON TABLE context_prompts_private.prompt_overrides IS '${TABLE_MARKER}${table.signature}'`);
    }
    await client.query('REVOKE ALL ON SCHEMA context_prompts_private FROM PUBLIC');
    await client.query('REVOKE ALL ON TABLE context_prompts_private.prompt_overrides FROM PUBLIC');
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname")).rows;
    for (const { rolname } of roles) {
      if (!BLOCKED_ROLES.includes(rolname)) fail('PROMPTS_UNEXPECTED_ROLE');
      await client.query(`REVOKE ALL ON SCHEMA context_prompts_private FROM "${rolname}"`);
      await client.query(`REVOKE ALL ON TABLE context_prompts_private.prompt_overrides FROM "${rolname}"`);
    }
    const privacy = (await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = $1 AND a.grantee = 0) AS no_public_schema,
      NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = $2 AND a.grantee = 0) AS no_public_table,
      NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
        (has_schema_privilege(r.oid, $1, 'USAGE, CREATE') OR has_table_privilege(r.oid, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))) AS no_api_role_access`, [SCHEMA, table.oid])).rows[0];
    if (!privacy || Object.values(privacy).some(value => value !== true)) fail('PROMPTS_PRIVACY_UNVERIFIED');
    await client.query('COMMIT'); transaction = false;
    return { applied: true, verified: true, seededPrompts: 0 };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* connection is destroyed by CLI */ } }
    if (error instanceof MigrationError) throw error;
    fail('PROMPTS_MIGRATION_FAILED');
  }
}

export async function runPromptMigration(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'env-file': { type: 'string', default: '.env.local' } } });
  if (!values.apply) { console.log(JSON.stringify({ staged: true, applied: false, requiresExplicitApply: true, schema: SCHEMA })); return; }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool({ ...migrationDatabaseOptions(env), application_name: 'context-prompt-storage-migration' });
  pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await migratePromptStorage(client))); }
  finally { if (client) client.release(true); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPromptMigration().catch(error => { console.error(JSON.stringify({ error: error instanceof MigrationError ? error.code : 'PROMPTS_MIGRATION_FAILED' })); process.exitCode = 1; });
}
