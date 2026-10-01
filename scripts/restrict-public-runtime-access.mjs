/** Operator-only Supabase prerequisite. Preserve existing roles while removing PUBLIC defaults.
 * Only the enumerated platform objects are considered; no business rows or RLS policies change.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';

const EXCLUDED = 'context_engine_runtime';
const quote = value => `"${value.replaceAll('"', '""')}"`;
export const PLATFORM_OBJECTS = [
  { kind: 'table', name: 'public.geography_columns' },
  { kind: 'table', name: 'public.geometry_columns' },
  { kind: 'table', name: 'public.spatial_ref_sys' },
  { kind: 'table', name: 'net.http_request_queue' },
  { kind: 'table', name: 'net._http_response' },
  { kind: 'function', name: 'public.rls_auto_enable()' },
  { kind: 'function', name: 'public.st_estimatedextent(text,text,text,boolean)' },
  { kind: 'function', name: 'public.st_estimatedextent(text,text,text)' },
  { kind: 'function', name: 'public.st_estimatedextent(text,text)' },
];
const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'EXECUTE']);

/** Caller owns the transaction. Returns exact rollback statements, never credentials. */
export async function restrictPublicAccess(db, objects = PLATFORM_OBJECTS) {
  await db.query('SELECT pg_advisory_xact_lock(195332, 1004)');
  const roles = (await db.query('SELECT rolname FROM pg_roles WHERE rolname<>$1 ORDER BY rolname', [EXCLUDED])).rows.map(r => r.rolname);
  if (!roles.length || roles.length > 200 || objects.length > 20) throw new Error('PLATFORM_ACCESS_REVIEW_REQUIRED');
  const rollback = [], touched = [];
  for (const object of objects) {
    if (!['table', 'function'].includes(object.kind) || typeof object.name !== 'string') throw new Error('INVALID_PLATFORM_OBJECT');
    const table = object.kind === 'table';
    const target = (await db.query(table
      ? `SELECT c.oid, format('%I.%I',n.nspname,c.relname) AS name, COALESCE(c.relacl,acldefault('r',c.relowner)) AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1) AND c.relkind IN ('r','v')`
      : `SELECT p.oid, format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS name,
           COALESCE(p.proacl,acldefault('f',p.proowner)) AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=to_regprocedure($1)`, [object.name])).rows[0];
    if (!target) continue;
    const grants = (await db.query('SELECT privilege_type,is_grantable FROM aclexplode($1::aclitem[]) WHERE grantee=0 ORDER BY privilege_type', [target.acl])).rows;
    if (!grants.length) continue;
    if (grants.some(g => !allowed.has(g.privilege_type) || g.is_grantable || (table ? g.privilege_type === 'EXECUTE' : g.privilege_type !== 'EXECUTE'))) throw new Error('UNEXPECTED_PLATFORM_ACL');
    const privileges = grants.map(g => g.privilege_type);
    const has = table ? 'has_table_privilege' : 'has_function_privilege';
    const snapshot = async () => (await db.query(`SELECT role,privilege,${has}(role,$3::oid,privilege) AS permitted
      FROM unnest($1::text[]) role CROSS JOIN unnest($2::text[]) privilege ORDER BY role,privilege`, [roles, privileges, target.oid])).rows;
    const before = await snapshot(), type = table ? 'TABLE' : 'FUNCTION';
    if (before.some(row => row.permitted !== true)) throw new Error('PLATFORM_ACCESS_REVIEW_REQUIRED');
    await db.query(`REVOKE ${privileges.join(', ')} ON ${type} ${target.name} FROM PUBLIC`);
    // PostgreSQL can emit only a warning for an ineffective REVOKE issued by a
    // non-owner. Never mistake that for a successful privilege change.
    const remaining = (await db.query(table
      ? `SELECT count(*)::int AS count FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1 AND a.grantee=0`
      : `SELECT count(*)::int AS count FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1 AND a.grantee=0`, [target.oid])).rows[0];
    if (remaining.count !== 0) throw new Error('PLATFORM_OWNER_PRIVILEGES_REQUIRED');
    const afterRevoke = await snapshot();
    const undo = [];
    for (const privilege of privileges) {
      const restore = afterRevoke.filter(row => row.privilege === privilege && !row.permitted).map(row => row.role);
      if (!restore.length) continue;
      await db.query(`GRANT ${privilege} ON ${type} ${target.name} TO ${restore.map(quote).join(', ')}`);
      undo.push(`REVOKE ${privilege} ON ${type} ${target.name} FROM ${restore.map(quote).join(', ')};`);
    }
    if (JSON.stringify(await snapshot()) !== JSON.stringify(before)) throw new Error('EXISTING_PLATFORM_ACCESS_CHANGED');
    rollback.unshift(`GRANT ${privileges.join(', ')} ON ${type} ${target.name} TO PUBLIC;`, ...undo);
    touched.push({ kind: object.kind, name: object.name, privileges });
  }
  const afterRoles = (await db.query('SELECT rolname FROM pg_roles WHERE rolname<>$1 ORDER BY rolname', [EXCLUDED])).rows.map(r => r.rolname);
  if (JSON.stringify(afterRoles) !== JSON.stringify(roles)) throw new Error('CONCURRENT_ROLE_CHANGE');
  return { rolesPreserved: roles.length, objects: touched, rollback };
}

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, apply: { type: 'boolean', default: false }, 'rollback-file': { type: 'string' } } });
  if (!values['env-file'] || (values.apply && !values['rollback-file'])) throw new Error('EXPLICIT_ENV_AND_ROLLBACK_REQUIRED');
  const pool = new pg.Pool(migrationDatabaseOptions(await readEnv(values['env-file']))); pool.on('error', () => {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='1000ms'"); await db.query("SET LOCAL statement_timeout='10000ms'");
    if ((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [EXCLUDED])).rowCount) throw new Error('RUN_BEFORE_RUNTIME_PROVISIONING');
    const result = await restrictPublicAccess(db);
    if (values.apply) await writeFile(values['rollback-file'], `BEGIN;\n${result.rollback.join('\n')}\nCOMMIT;\n`, { mode: 0o600, flag: 'wx' });
    await db.query(values.apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ checked: true, applied: values.apply, rolesPreserved: result.rolesPreserved, objects: result.objects }));
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'PLATFORM_ACCESS_SETUP_FAILED'); process.exitCode = 1;
});
