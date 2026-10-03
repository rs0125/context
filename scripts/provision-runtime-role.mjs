import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';
import { RUNTIME_ROLE } from './runtime-policy.mjs';
import { reviewedPlatformAccess } from './runtime-platform-access.mjs';

// Source reads and private application writes are explicit; no schema-wide
// grants, source writes, role membership, table ownership or RLS bypass.
export const RUNTIME_TABLES = [
  ['public."VerifiedNumber"', 'SELECT (id, phone_number, email, name, is_active, "dashboardAccess", "adminAccess", "analystAccess", twenty_user_id)'],
  ['public."Warehouse"', 'SELECT'], ['public."WarehouseData"', 'SELECT'],
  ['public.opportunities', 'SELECT'], ['public.stage_transitions', 'SELECT'], ['public.sync_checkpoints', 'SELECT'],
  ['context_auth_private.employee_api_keys', 'SELECT, INSERT, UPDATE'],
  ['context_engine_private.knowledge_pages', 'SELECT, INSERT, UPDATE'],
  ['context_prompts_private.prompt_overrides', 'SELECT, INSERT, UPDATE'],
  ['context_mcp_private.oauth_clients', 'SELECT, INSERT, DELETE'],
  ['context_mcp_private.oauth_grants', 'SELECT, INSERT, UPDATE'],
  ['context_mcp_private.oauth_codes', 'SELECT, INSERT, UPDATE'],
  ['context_mcp_private.oauth_tokens', 'SELECT, INSERT, UPDATE'],
  ['context_security_private.session_revocations', 'SELECT, INSERT, DELETE'],
  ['context_security_private.legacy_key_bindings', 'SELECT'],
  ['context_gmail_private.connections', 'SELECT, INSERT, UPDATE'],
  ['context_gmail_private.draft_operations', 'SELECT, INSERT, UPDATE'],
];

export async function provisionRuntimeRole(client, password, { commit = true, allowReviewedPlatformAccess = false } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('INVALID_RUNTIME_SECRET');
  if (typeof allowReviewedPlatformAccess !== 'boolean') throw new Error('INVALID_PLATFORM_ACCESS_OPTION');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    const existing = (await client.query('SELECT oid FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE])).rows;
    // Never adopt or reset a pre-existing login or rotate a live password.
    if (existing.length) throw new Error('RUNTIME_ROLE_ALREADY_EXISTS');
    await client.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const names = RUNTIME_TABLES.map(([table]) => table);
    for (const schema of new Set(names.map(table => table.split('.')[0]))) {
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
    }
    for (const [table, privileges] of RUNTIME_TABLES) {
      const relation = (await client.query('SELECT relkind, relrowsecurity FROM pg_class WHERE oid = to_regclass($1)', [table])).rows[0];
      if (!relation || relation.relkind !== 'r') throw new Error('RUNTIME_SOURCE_INCOMPATIBLE');
      await client.query(`GRANT ${privileges} ON TABLE ${table} TO ${RUNTIME_ROLE}`);
      if (table.startsWith('public.')) {
        if (relation.relrowsecurity) await client.query(`CREATE POLICY context_runtime_read ON ${table} FOR SELECT TO ${RUNTIME_ROLE} USING (true)`);
      } else {
        if (!relation.relrowsecurity) throw new Error('RUNTIME_PRIVATE_RLS_REQUIRED');
        await client.query(`CREATE POLICY context_runtime ON ${table} FOR ALL TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
      }
    }
    // PUBLIC privileges are inherited even by NOINHERIT roles. The optional,
    // explicit Supabase baseline never exempts application data or arbitrary
    // objects. It reports the inherited platform access without changing it.
    const platform = allowReviewedPlatformAccess
      ? await reviewedPlatformAccess(client, RUNTIME_ROLE) : { tables: [], functions: [], report: [] };
    const denied = RUNTIME_TABLES.flatMap(([table, privileges]) => {
      const allowed = privileges.startsWith('SELECT (') ? ['SELECT'] : privileges.split(', ');
      return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        .filter(privilege => !allowed.includes(privilege)).map(privilege => ({ relation: table, privilege }));
    });
    const unsafe = (await client.query(`SELECT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND p.oid <> ALL($5::oid[])
        AND has_schema_privilege($1, n.oid, 'USAGE')
        AND has_function_privilege($1, p.oid, 'EXECUTE')) AS definer_access,
      EXISTS (SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS denied(relation text, privilege text)
        WHERE has_table_privilege($1, relation, privilege) OR CASE
          WHEN privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          THEN has_any_column_privilege($1, relation, privilege) ELSE false END) AS extra_privileges,
      EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege($1, n.oid, 'CREATE')) OR has_database_privilege($1, current_database(), 'CREATE') AS schema_create,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public."VerifiedNumber"'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname <> ALL(ARRAY['id', 'phone_number', 'email', 'name', 'is_active', 'dashboardAccess', 'adminAccess', 'analystAccess', 'twenty_user_id'])
        AND has_column_privilege($1, a.attrelid, a.attname, 'SELECT')) AS roster_excess,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
        AND has_schema_privilege($1, n.oid, 'USAGE')
        AND c.oid <> ALL(ARRAY(SELECT to_regclass(x) FROM unnest($2::text[]) x))
        AND c.oid <> ALL($4::oid[])
        AND (has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
          OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))) AS unrelated_access`,
    [RUNTIME_ROLE, names, JSON.stringify(denied), platform.tables, platform.functions])).rows[0];
    if (!unsafe || ['definer_access', 'extra_privileges', 'schema_create', 'roster_excess', 'unrelated_access']
      .some(flag => unsafe[flag] !== false)) throw new Error('RUNTIME_PUBLIC_GRANTS_UNSAFE');
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { applied: commit, verified: true, role: RUNTIME_ROLE, sourceWrites: false, sourceTables: 6, privateTables: 11,
      platformIsolation: platform.report.length === 0, inheritedPlatformAccess: platform.report };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

export async function runRuntimeProvisioning(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, check: { type: 'boolean', default: false },
    'env-file': { type: 'string', default: '.env.local' }, 'output-file': { type: 'string', default: '.local/runtime-database.env' },
    'allow-reviewed-platform-access': { type: 'boolean', default: false } } });
  if (!values.apply && !values.check) { console.log(JSON.stringify({ staged: true, role: RUNTIME_ROLE })); return; }
  if (values.apply && values.check) throw new Error('CHOOSE_APPLY_OR_CHECK');
  const env = await readEnv(path.resolve(values['env-file']));
  const password = randomBytes(32).toString('base64url');
  const url = new URL(env.DATABASE_URL);
  const project = decodeURIComponent(url.username).split('.')[1];
  if (!project || !/^[a-z0-9]+$/.test(project)) throw new Error('POOLER_PROJECT_REQUIRED');
  url.username = `${RUNTIME_ROLE}.${project}`; url.password = password; url.search = '';
  if (values.apply) {
    const output = path.resolve(values['output-file']);
    if (output === path.resolve(values['env-file'])) throw new Error('SEPARATE_RUNTIME_FILE_REQUIRED');
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    // Preserve a recovery copy before creating the login; do not overwrite an
    // existing secret. The file is not proof of successful provisioning.
    await writeFile(output, `CONTEXT_DATABASE_URL=${url.toString()}\n`, { mode: 0o600, flag: 'wx' });
  }
  const pool = new pg.Pool(migrationDatabaseOptions(env)); pool.on('error', () => {});
  let client;
  try { client = await pool.connect(); console.log(JSON.stringify(await provisionRuntimeRole(client, password,
    { commit: values.apply, allowReviewedPlatformAccess: values['allow-reviewed-platform-access'] }))); }
  finally { if (client) client.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRuntimeProvisioning().catch(error => { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'RUNTIME_PROVISIONING_FAILED'); process.exitCode = 1; });
}
