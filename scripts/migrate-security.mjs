import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';
import { EXPECTED_RUNTIME_POLICY } from './runtime-policy.mjs';

const SCHEMA = 'context_security_private';
const MARKER = 'context-security-storage-v1';
const TABLES = ['session_revocations', 'legacy_key_bindings'];
const fail = () => { throw new Error('SECURITY_STORAGE_INCOMPATIBLE'); };

export async function migrateSecurityStorage(client, keys = []) {
  if (!Array.isArray(keys) || keys.length > 1000 || keys.some(key => !key || !Number.isFinite(Date.parse(key.expiresAt)))) fail();
  const active = keys.filter(key => Date.parse(key.expiresAt) > Date.now());
  if (active.some(key => !/^[a-zA-Z0-9_-]{1,64}$/.test(key.id) || !/^[a-f0-9]{64}$/.test(key.hash)
    || typeof key.employeeEmail !== 'string' || !/^[^\s@]+@wareongo\.com$/.test(key.employeeEmail)
    || key.employeeEmail !== key.employeeEmail.toLowerCase())) fail();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const locked = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406258) AS locked')).rows[0];
    if (!locked?.locked) fail();
    const owner = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!owner || (!owner.rolsuper && !owner.rolbypassrls)) fail();
    const schema = (await client.query(`SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname = $1`, [SCHEMA])).rows[0];
    if (schema && (!schema.owned || schema.marker !== MARKER)) fail();
    if (!schema) {
      await client.query('CREATE SCHEMA context_security_private');
      await client.query(`COMMENT ON SCHEMA context_security_private IS '${MARKER}'`);
      await client.query(`CREATE TABLE context_security_private.session_revocations (
        session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
        expires_at timestamptz NOT NULL)`);
      await client.query('CREATE INDEX session_revocations_expiry_idx ON context_security_private.session_revocations (expires_at)');
      await client.query(`CREATE TABLE context_security_private.legacy_key_bindings (
        key_id text NOT NULL CHECK (key_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
        token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        employee_id integer NOT NULL CHECK (employee_id > 0), employee_email text NOT NULL,
        PRIMARY KEY (key_id, token_hash))`);
      for (const table of TABLES) {
        await client.query(`ALTER TABLE context_security_private.${table} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE context_security_private.${table} FORCE ROW LEVEL SECURITY`);
        await client.query(`COMMENT ON TABLE context_security_private.${table} IS '${MARKER}'`);
      }
    }
    const tables = (await client.query(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid AND NOT COALESCE((${EXPECTED_RUNTIME_POLICY}), false)) AS unexpected_policy,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) AS triggers,
      EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class = c.oid) AS rules,
      EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = c.oid OR inhparent = c.oid) AS inheritance,
      obj_description(c.oid, 'pg_class') AS marker FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind <> 'i'`, [SCHEMA])).rows;
    if (tables.length !== TABLES.length || tables.some(table => !TABLES.includes(table.relname) || table.relkind !== 'r'
      || !table.owned || !table.relrowsecurity || !table.relforcerowsecurity || table.marker !== MARKER
      || [table.unexpected_policy, table.triggers, table.rules, table.inheritance].some(flag => flag !== false))) fail();
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')")).rows.map(row => row.rolname);
    for (const role of ['PUBLIC', ...roles]) {
      if (!['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(role)) fail();
      await client.query(`REVOKE ALL ON SCHEMA context_security_private FROM ${role}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA context_security_private FROM ${role}`);
    }
    const privacy = (await client.query(`SELECT NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
      AND has_schema_privilege(oid, 'context_security_private', 'USAGE, CREATE')) AS private`)).rows[0];
    if (privacy?.private !== true) fail();
    for (const key of active) {
      const rows = (await client.query(`SELECT id, email, is_active FROM public."VerifiedNumber"
        WHERE lower(email) = $1 LIMIT 2 FOR SHARE`, [key.employeeEmail])).rows;
      if (rows.length !== 1 || rows[0].is_active !== true || !Number.isSafeInteger(rows[0].id) || rows[0].id <= 0
        || (key.employeeId !== undefined && key.employeeId !== rows[0].id)) fail();
      await client.query(`INSERT INTO context_security_private.legacy_key_bindings (key_id, token_hash, employee_id, employee_email)
        VALUES ($1, $2, $3, $4) ON CONFLICT (key_id, token_hash) DO NOTHING`, [key.id, key.hash, rows[0].id, key.employeeEmail]);
      const binding = (await client.query(`SELECT employee_id, employee_email FROM context_security_private.legacy_key_bindings
        WHERE key_id = $1 AND token_hash = $2`, [key.id, key.hash])).rows;
      if (binding.length !== 1 || binding[0].employee_id !== rows[0].id || binding[0].employee_email !== key.employeeEmail) fail();
    }
    await client.query('COMMIT');
    return { applied: true, verified: true, legacyKeysBound: active.length };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

export async function runSecurityMigration(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'env-file': { type: 'string', default: '.env.local' } } });
  if (!values.apply) { console.log(JSON.stringify({ staged: true, applied: false, schema: SCHEMA })); return; }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool(migrationDatabaseOptions(env)); pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await migrateSecurityStorage(client, JSON.parse(env.CONTEXT_API_KEYS_JSON ?? '[]')))); }
  finally { if (client) client.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSecurityMigration().catch(() => { console.error('SECURITY_MIGRATION_FAILED'); process.exitCode = 1; });
}
