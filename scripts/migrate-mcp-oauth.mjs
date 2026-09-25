import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';

// Explicit one-off migration only. No business table, roster, key or wiki edits.
const SCHEMA = 'context_mcp_private';
const MARKER = 'context-mcp-oauth-schema-v1';
const TABLE_MARKER = 'context-mcp-oauth-table-v1:';
const ROLES = ['anon', 'authenticated', 'service_role'];
const scopeCheck = `cardinality(scopes) BETWEEN 1 AND 3 AND array_ndims(scopes) = 1 AND array_lower(scopes, 1) = 1
  AND array_position(scopes, NULL) IS NULL AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read']::text[]
  AND cardinality(scopes) = (CASE WHEN 'knowledge:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'warehouses:read' = ANY(scopes) THEN 1 ELSE 0 END + CASE WHEN 'crm:read' = ANY(scopes) THEN 1 ELSE 0 END)`;
export const MCP_OAUTH_TABLE_SQL = {
  oauth_clients: `CREATE TABLE context_mcp_private.oauth_clients (
    id text PRIMARY KEY CHECK (id ~ '^wog_client_[A-Za-z0-9_-]{43}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5 AND array_ndims(redirect_uris) = 1 AND array_lower(redirect_uris, 1) = 1 AND array_position(redirect_uris, NULL) IS NULL),
    scopes text[] NOT NULL CHECK (${scopeCheck}),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  oauth_grants: `CREATE TABLE context_mcp_private.oauth_grants (
    id uuid PRIMARY KEY,
    client_id text NOT NULL REFERENCES context_mcp_private.oauth_clients(id),
    key_id text NOT NULL CHECK (key_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
    key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    key_source text NOT NULL CHECK (key_source IN ('environment', 'database')),
    employee_id integer NOT NULL CHECK (employee_id > 0),
    employee_email text NOT NULL CHECK (employee_email = lower(employee_email) AND char_length(employee_email) BETWEEN 3 AND 254),
    scopes text[] NOT NULL CHECK (${scopeCheck}),
    resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
    expires_at timestamptz NOT NULL,
    consent_hash text NOT NULL UNIQUE CHECK (consent_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days')
  )`,
  oauth_codes: `CREATE TABLE context_mcp_private.oauth_codes (
    hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
    grant_id uuid NOT NULL REFERENCES context_mcp_private.oauth_grants(id) ON DELETE CASCADE,
    challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
    redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
  )`,
  oauth_tokens: `CREATE TABLE context_mcp_private.oauth_tokens (
    hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
    grant_id uuid NOT NULL REFERENCES context_mcp_private.oauth_grants(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days'),
    CHECK (kind = 'refresh' OR (used_at IS NULL AND expires_at <= created_at + interval '20 minutes'))
  )`,
};
const COLUMNS = {
  oauth_clients: [['id', 'text'], ['name', 'text'], ['redirect_uris', 'text[]'], ['scopes', 'text[]'], ['created_at', 'timestamp with time zone']],
  oauth_grants: [['id', 'uuid'], ['client_id', 'text'], ['key_id', 'text'], ['key_hash', 'text'], ['key_source', 'text'], ['employee_id', 'integer'],
    ['employee_email', 'text'], ['scopes', 'text[]'], ['resource', 'text'], ['expires_at', 'timestamp with time zone'], ['consent_hash', 'text'],
    ['created_at', 'timestamp with time zone'], ['revoked_at', 'timestamp with time zone']],
  oauth_codes: [['hash', 'text'], ['grant_id', 'uuid'], ['challenge', 'text'], ['redirect_uri', 'text'], ['expires_at', 'timestamp with time zone'], ['created_at', 'timestamp with time zone'], ['used_at', 'timestamp with time zone']],
  oauth_tokens: [['hash', 'text'], ['grant_id', 'uuid'], ['kind', 'text'], ['expires_at', 'timestamp with time zone'], ['created_at', 'timestamp with time zone'], ['used_at', 'timestamp with time zone']],
};
const INDEX_SQL = {
  oauth_grants_client_idx: 'CREATE INDEX oauth_grants_client_idx ON context_mcp_private.oauth_grants (client_id)',
  oauth_codes_grant_idx: 'CREATE INDEX oauth_codes_grant_idx ON context_mcp_private.oauth_codes (grant_id)',
  oauth_tokens_grant_idx: 'CREATE INDEX oauth_tokens_grant_idx ON context_mcp_private.oauth_tokens (grant_id)',
};
const ALLOWED_RELATIONS = [...Object.keys(COLUMNS), ...Object.keys(COLUMNS).map(name => `${name}_pkey`), 'oauth_grants_consent_hash_key', ...Object.keys(INDEX_SQL)];
class MigrationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new MigrationError(code); };

async function inspectTable(client, name) {
  const table = (await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned, obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [SCHEMA, name])).rows[0];
  if (!table || !table.owned || table.relkind !== 'r' || table.relpersistence !== 'p' || table.relispartition || !table.relrowsecurity || !table.relforcerowsecurity) fail('MCP_RELATION_INCOMPATIBLE');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 ORDER BY a.attnum`, [table.oid])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated, pg_get_constraintdef(oid, true) AS definition
    FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [table.oid])).rows;
  const indexes = (await client.query(`SELECT pg_get_indexdef(indexrelid) AS definition, indisvalid AS valid, indisready AS ready
    FROM pg_index WHERE indrelid = $1 ORDER BY pg_get_indexdef(indexrelid)`, [table.oid])).rows;
  const objects = (await client.query(`SELECT (SELECT count(*)::integer FROM pg_policy WHERE polrelid = $1) AS policies,
    (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = $1) AS rules,
    (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1) AS inheritance`, [table.oid])).rows[0];
  if (columns.length !== COLUMNS[name].length || columns.some((column, index) => column.name !== COLUMNS[name][index][0] || column.type !== COLUMNS[name][index][1]
    || column.not_null !== !['used_at', 'revoked_at'].includes(column.name) || column.identity || column.generated || column.dropped
    || column.default_expression !== (column.name === 'created_at' ? 'CURRENT_TIMESTAMP' : null))
    || !constraints.some(value => value.type === 'p') || constraints.some(value => !value.validated)
    || !indexes.length || indexes.some(value => !value.valid || !value.ready)
    || !objects || Object.values(objects).some(count => count !== 0)) fail('MCP_RELATION_INCOMPATIBLE');
  return { ...table, signature: createHash('sha256').update(JSON.stringify({ columns, constraints, indexes })).digest('hex') };
}

export async function migrateMcpOAuthStorage(client) {
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406257) AS locked')).rows[0];
    if (!lock?.locked) fail('MCP_MIGRATION_BUSY');
    const role = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || !role.rolsuper && !role.rolbypassrls) fail('MCP_ROLE_REQUIRES_RLS_BYPASS');
    const schema = (await client.query(`SELECT n.oid, n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(n.oid, 'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname = $1`, [SCHEMA])).rows[0];
    const inspected = [];
    if (schema) {
      if (!schema.owned || schema.marker !== MARKER) fail('MCP_SCHEMA_COLLISION');
      const objects = (await client.query(`SELECT
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace = $1 AND NOT (relname = ANY($2::text[]))) AS relations,
        (SELECT count(*)::integer FROM pg_proc WHERE pronamespace = $1) AS routines`, [schema.oid, ALLOWED_RELATIONS])).rows[0];
      if (!objects || Object.values(objects).some(count => count !== 0)) fail('MCP_SCHEMA_COLLISION');
      for (const name of Object.keys(COLUMNS)) {
        const table = await inspectTable(client, name);
        if (table.marker !== `${TABLE_MARKER}${table.signature}`) fail('MCP_RELATION_COLLISION');
      }
      await client.query('LOCK TABLE context_mcp_private.oauth_clients, context_mcp_private.oauth_grants, context_mcp_private.oauth_codes, context_mcp_private.oauth_tokens IN SHARE ROW EXCLUSIVE MODE');
      for (const name of Object.keys(COLUMNS)) {
        const table = await inspectTable(client, name);
        if (table.marker !== `${TABLE_MARKER}${table.signature}`) fail('MCP_RELATION_COLLISION');
        inspected.push(table);
      }
    } else {
      await client.query('CREATE SCHEMA context_mcp_private');
      await client.query(`COMMENT ON SCHEMA context_mcp_private IS '${MARKER}'`);
      for (const sql of Object.values(MCP_OAUTH_TABLE_SQL)) await client.query(sql);
      for (const sql of Object.values(INDEX_SQL)) await client.query(sql);
      for (const name of Object.keys(COLUMNS)) {
        await client.query(`ALTER TABLE context_mcp_private.${name} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE context_mcp_private.${name} FORCE ROW LEVEL SECURITY`);
        const table = await inspectTable(client, name);
        await client.query(`COMMENT ON TABLE context_mcp_private.${name} IS '${TABLE_MARKER}${table.signature}'`);
        inspected.push(table);
      }
    }
    await client.query('REVOKE ALL ON SCHEMA context_mcp_private FROM PUBLIC');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA context_mcp_private FROM PUBLIC');
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname")).rows;
    for (const { rolname } of roles) {
      if (!ROLES.includes(rolname)) fail('MCP_UNEXPECTED_ROLE');
      await client.query(`REVOKE ALL ON SCHEMA context_mcp_private FROM "${rolname}"`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA context_mcp_private FROM "${rolname}"`);
    }
    const privacy = (await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = $1 AND a.grantee = 0) AS no_public_schema,
      NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = ANY($2::oid[]) AND a.grantee = 0) AS no_public_tables,
      NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
        (has_schema_privilege(r.oid, $1, 'USAGE, CREATE') OR EXISTS (SELECT 1 FROM unnest($2::oid[]) t(oid)
          WHERE has_table_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')))) AS no_api_role_access`, [SCHEMA, inspected.map(table => table.oid)])).rows[0];
    if (!privacy || Object.values(privacy).some(value => value !== true)) fail('MCP_PRIVACY_UNVERIFIED');
    await client.query('COMMIT'); transaction = false;
    return { applied: true, verified: true, tables: inspected.length, seededCredentials: 0 };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* CLI destroys connection */ } }
    if (error instanceof MigrationError) throw error;
    fail('MCP_MIGRATION_FAILED');
  }
}

export async function runMcpOAuthMigration(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'env-file': { type: 'string', default: '.env.local' } } });
  if (!values.apply) { console.log(JSON.stringify({ staged: true, applied: false, requiresExplicitApply: true, schema: SCHEMA })); return; }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool({ ...migrationDatabaseOptions(env), application_name: 'context-mcp-oauth-migration' });
  pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await migrateMcpOAuthStorage(client))); }
  finally { if (client) client.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMcpOAuthMigration().catch(error => { console.error(JSON.stringify({ error: error instanceof MigrationError ? error.code : 'MCP_MIGRATION_FAILED' })); process.exitCode = 1; });
}
