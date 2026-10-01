/** Additive, operator-only nonce storage. Defaults to a rolled-back validation. Never edits employee data. */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';

const schema = 'context_ramesh_private';
const marker = 'context-ramesh-request-auth-v1';
export const NONCE_SQL = `CREATE TABLE context_ramesh_private.request_nonces (
  hash text PRIMARY KEY CHECK (hash ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX request_nonces_expiry ON context_ramesh_private.request_nonces (expires_at);
ALTER TABLE context_ramesh_private.request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_ramesh_private.request_nonces FORCE ROW LEVEL SECURITY;`;
const checksum = createHash('sha256').update(NONCE_SQL).digest('hex');

export async function applyRameshAuthSchema(db) {
  await db.query('SELECT pg_advisory_xact_lock(195332, 1002)');
  const role = (await db.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
    EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE rolname='context_engine_runtime'`)).rows[0];
  if (!role || Object.values(role).some(value => value !== false)) throw new Error('RESTRICTED_CONTEXT_ROLE_REQUIRED');
  const existing = (await db.query(`SELECT obj_description(oid, 'pg_namespace') AS marker,
    nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
  if (existing && (!existing.owned || existing.marker !== marker)) throw new Error('RAMESH_SCHEMA_COLLISION');
  if (!existing) {
    await db.query(`CREATE SCHEMA context_ramesh_private;
      COMMENT ON SCHEMA context_ramesh_private IS '${marker}'; ${NONCE_SQL}
      COMMENT ON TABLE context_ramesh_private.request_nonces IS '${marker}:${checksum}';
      CREATE POLICY context_ramesh_runtime ON context_ramesh_private.request_nonces
        FOR ALL TO context_engine_runtime USING (true) WITH CHECK (true);`);
  }
  const shape = (await db.query(`SELECT c.oid, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
    obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='request_nonces'`, [schema])).rows[0];
  if (!shape || !shape.owned || shape.relkind !== 'r' || !shape.relrowsecurity || !shape.relforcerowsecurity || shape.marker !== `${marker}:${checksum}`) throw new Error('RAMESH_SCHEMA_INCOMPATIBLE');
  const columns = (await db.query(`SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
    WHERE attrelid=$1 AND attnum>0 ORDER BY attnum`, [shape.oid])).rows;
  if (JSON.stringify(columns) !== JSON.stringify([{ attname: 'hash', type: 'text', attnotnull: true }, { attname: 'expires_at', type: 'timestamp with time zone', attnotnull: true }])) throw new Error('RAMESH_SCHEMA_INCOMPATIBLE');
  const constraints = (await db.query(`SELECT contype, convalidated, condeferrable, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=$1 ORDER BY contype`, [shape.oid])).rows;
  if (constraints.length !== 2 || constraints.some(c => !c.convalidated || c.condeferrable)
    || constraints[0].contype !== 'c' || constraints[0].definition !== "CHECK ((hash ~ '^[A-Za-z0-9_-]{43}$'::text))"
    || constraints[1].contype !== 'p' || constraints[1].definition !== 'PRIMARY KEY (hash)') throw new Error('RAMESH_SCHEMA_INCOMPATIBLE');
  const indexes = (await db.query(`SELECT indisprimary, indisunique, indisvalid, indisready, indimmediate,
    indkey::text AS columns, indexprs IS NULL AND indpred IS NULL AS plain
    FROM pg_index WHERE indrelid=$1 ORDER BY indisprimary DESC`, [shape.oid])).rows;
  if (indexes.length !== 2 || indexes.some(i => !i.indisvalid || !i.indisready || !i.indimmediate || !i.plain)
    || !indexes[0].indisprimary || !indexes[0].indisunique || indexes[0].columns !== '1'
    || indexes[1].indisprimary || indexes[1].indisunique || indexes[1].columns !== '2') throw new Error('RAMESH_SCHEMA_INCOMPATIBLE');
  const policies = (await db.query(`SELECT polname, polcmd, polpermissive, pg_get_expr(polqual, polrelid) AS qual,
    pg_get_expr(polwithcheck, polrelid) AS check,
    polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='context_engine_runtime')] AS runtime_only
    FROM pg_policy WHERE polrelid=$1`, [shape.oid])).rows;
  if (policies.length !== 1 || policies[0].polname !== 'context_ramesh_runtime' || policies[0].polcmd !== '*'
    || !policies[0].polpermissive || policies[0].qual !== 'true' || policies[0].check !== 'true' || !policies[0].runtime_only) throw new Error('RAMESH_POLICY_INCOMPATIBLE');
  const unsafe = (await db.query(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1 AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=$1) OR
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=$1 OR inhparent=$1) AS unsafe`, [shape.oid])).rows[0];
  if (unsafe.unsafe) throw new Error('RAMESH_SCHEMA_INCOMPATIBLE');
  await db.query(`REVOKE ALL ON SCHEMA context_ramesh_private FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA context_ramesh_private FROM PUBLIC;
    GRANT USAGE ON SCHEMA context_ramesh_private TO context_engine_runtime;
    GRANT SELECT, INSERT, DELETE ON context_ramesh_private.request_nonces TO context_engine_runtime;
    GRANT SELECT (phone_number) ON public."VerifiedNumber" TO context_engine_runtime;`);
  for (const name of ['anon', 'authenticated', 'service_role']) {
    if ((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount)
      await db.query(`REVOKE ALL ON SCHEMA context_ramesh_private FROM ${name}; REVOKE ALL ON ALL TABLES IN SCHEMA context_ramesh_private FROM ${name}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values['env-file']) throw new Error('EXPLICIT_ADMIN_ENV_REQUIRED');
  const pool = new pg.Pool(migrationDatabaseOptions(await readEnv(values['env-file'])));
  pool.on('error', () => {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='2000ms'");
    await db.query("SET LOCAL statement_timeout='10000ms'");
    await applyRameshAuthSchema(db);
    await db.query(values.apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ checked: true, applied: values.apply, schema, role: 'context_engine_runtime' }));
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(true); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('RAMESH_AUTH_SETUP_FAILED'); process.exitCode = 1; });
