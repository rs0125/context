import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePrincipal } from '../src/lib/auth';
import { requireActiveConsoleSession, revokeConsoleSession } from '../src/lib/console-sessions';
import { rotateOwnConsoleKey, getOwnConsoleKey } from '../src/lib/console-keys';
import { savePrompt } from '../src/lib/prompts';
import { consumeRameshNonce } from '../src/lib/ramesh-replay';
import { claimGmailDraftOperation, saveGmailConnection } from '../src/lib/gmail-storage';
const securityModule = '../scripts/migrate-security.mjs';
const roleModule = '../scripts/provision-runtime-role.mjs';
const knowledgeModule = '../scripts/migrate-knowledge.mjs';
const consoleModule = '../scripts/migrate-console.mjs';
const promptsModule = '../scripts/migrate-prompts.mjs';
const oauthModule = '../scripts/migrate-mcp-oauth.mjs';
const { migrateSecurityStorage } = await import(securityModule);
const { provisionRuntimeRole } = await import(roleModule);
const { migrateKnowledge } = await import(knowledgeModule);
const { migrateConsoleStorage } = await import(consoleModule);
const { migratePromptStorage } = await import(promptsModule);
const { migrateMcpOAuthStorage } = await import(oauthModule);
const gmailModule = '../scripts/migrate-gmail.mjs';
const { migrateGmailStorage } = await import(gmailModule);
const rameshModule = '../scripts/migrate-ramesh-auth.mjs';
const { applyRameshAuthSchema } = await import(rameshModule);
const platformModule = '../scripts/restrict-public-runtime-access.mjs';
const { restrictPublicAccess } = await import(platformModule);
const connection = process.env.CONTEXT_TEST_DATABASE_URL;

// This suite creates a synthetic database schema. Never point it at production.
describe.skipIf(!connection)('isolated PostgreSQL security boundaries', () => {
  let owner: pg.PoolClient, runtime: pg.PoolClient;
  let ownerPool: pg.Pool, runtimePool: pg.Pool;
  const identity = { employeeId: 7, email: 'test@wareongo.com', name: 'Synthetic', isAdmin: true, isAnalyst: true,
    scopes: ['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read'] as const };
  const legacy = { id: 'synthetic_legacy', hash: 'a'.repeat(64), employeeEmail: identity.email,
    scopes: ['knowledge:read'] as const, expiresAt: '2099-01-01T00:00:00Z' };
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/context_security_test') throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');
    ownerPool = new pg.Pool({ connectionString: connection }); owner = await ownerPool.connect();
    await owner.query(`CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY, email text, name text, is_active boolean,
      "dashboardAccess" boolean, "adminAccess" boolean, "analystAccess" boolean, twenty_user_id text, phone_number text, private_notes text);
      INSERT INTO public."VerifiedNumber" VALUES (7, 'test@wareongo.com', 'Synthetic', true, true, true, false, null, '919876543210', 'private');
      CREATE TABLE public."Warehouse" (id integer);
      ALTER TABLE public."Warehouse" ENABLE ROW LEVEL SECURITY;
      INSERT INTO public."Warehouse" VALUES (1);
      CREATE TABLE public."WarehouseData" (id integer);
      CREATE TABLE public.opportunities (id integer);
      CREATE TABLE public.stage_transitions (id integer);
      CREATE TABLE public.sync_checkpoints (id integer);
      CREATE TABLE public.unrelated_sensitive_data (secret text);
      CREATE SCHEMA inaccessible;
      REVOKE ALL ON SCHEMA inaccessible FROM PUBLIC;
      CREATE TABLE inaccessible.platform_metadata (id integer);
      GRANT SELECT ON inaccessible.platform_metadata TO PUBLIC;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
    await migrateConsoleStorage(owner); await migrateKnowledge(owner, []);
    await migratePromptStorage(owner); await migrateMcpOAuthStorage(owner);
    await migrateSecurityStorage(owner, [legacy]);
    await migrateGmailStorage(owner);
    const password = randomBytes(32).toString('base64url');
    // --check must leave no role or changed privileges behind.
    expect(await provisionRuntimeRole(owner, password, { commit: false })).toMatchObject({ applied: false, privateTables: 11 });
    expect((await owner.query("SELECT oid FROM pg_roles WHERE rolname = 'context_engine_runtime'")).rows).toEqual([]);
    for (const grant of [
      'INSERT ON public."Warehouse"', 'INSERT (id) ON public."Warehouse"', 'CREATE ON SCHEMA public',
      'SELECT (secret) ON public.unrelated_sensitive_data', 'SELECT (private_notes) ON public."VerifiedNumber"',
      'DELETE ON context_prompts_private.prompt_overrides',
    ]) {
      await owner.query(`GRANT ${grant} TO PUBLIC`);
      await expect(provisionRuntimeRole(owner, password)).rejects.toThrow('RUNTIME_PUBLIC_GRANTS_UNSAFE');
      await expect(provisionRuntimeRole(owner, password, { allowReviewedPlatformAccess: true })).rejects.toThrow('RUNTIME_PUBLIC_GRANTS_UNSAFE');
      await owner.query(`REVOKE ${grant} FROM PUBLIC`);
    }
    await owner.query("CREATE FUNCTION public.unsafe_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
    await expect(provisionRuntimeRole(owner, password)).rejects.toThrow('RUNTIME_PUBLIC_GRANTS_UNSAFE');
    await expect(provisionRuntimeRole(owner, password, { allowReviewedPlatformAccess: true })).rejects.toThrow('RUNTIME_PUBLIC_GRANTS_UNSAFE');
    await owner.query('DROP FUNCTION public.unsafe_definer()');
    // Same-named objects without extension provenance are not an exception.
    await owner.query('CREATE SCHEMA net; GRANT USAGE ON SCHEMA net TO PUBLIC; CREATE TABLE net.http_request_queue (id integer); GRANT SELECT ON net.http_request_queue TO PUBLIC');
    await expect(provisionRuntimeRole(owner, password, { allowReviewedPlatformAccess: true })).rejects.toThrow('REVIEWED_PLATFORM_OBJECT_CHANGED');
    await owner.query('DROP TABLE net.http_request_queue; DROP SCHEMA net');
    await owner.query("CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN; END'");
    await expect(provisionRuntimeRole(owner, password)).rejects.toThrow('RUNTIME_PUBLIC_GRANTS_UNSAFE');
    expect(await provisionRuntimeRole(owner, password, { commit: false, allowReviewedPlatformAccess: true }))
      .toMatchObject({ applied: false, sourceWrites: false, platformIsolation: false,
        inheritedPlatformAccess: [{ kind: 'function', name: 'public.rls_auto_enable()', privileges: ['EXECUTE'] }] });
    expect((await owner.query("SELECT oid FROM pg_roles WHERE rolname = 'context_engine_runtime'")).rows).toEqual([]);
    await owner.query('DROP FUNCTION public.rls_auto_enable()');
    await provisionRuntimeRole(owner, password);
    await owner.query('BEGIN'); await applyRameshAuthSchema(owner); await owner.query('COMMIT');
    url.username = 'context_engine_runtime'; url.password = password;
    runtimePool = new pg.Pool({ connectionString: url.toString() }); runtime = await runtimePool.connect();
  }, 30_000);
  afterAll(async () => {
    runtime?.release(true); owner?.release(true);
    await runtimePool?.end(); await ownerPool?.end();
  });
  it('uses a real login with no elevated role attributes', async () => {
    const { rows } = await runtime.query('SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ rolname: 'context_engine_runtime', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false });
  });
  it('reads permitted roster columns and RLS-protected inventory but cannot read unrelated data', async () => {
    expect((await resolvePrincipal(runtime, { ...legacy, scopes: [...legacy.scopes] })).employeeId).toBe(7);
    expect((await runtime.query('SELECT id FROM public."Warehouse"')).rows).toEqual([{ id: 1 }]);
    expect((await runtime.query('SELECT phone_number FROM public."VerifiedNumber"')).rows).toEqual([{ phone_number: '919876543210' }]);
    await expect(runtime.query('SELECT private_notes FROM public."VerifiedNumber"')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT * FROM public.unrelated_sensitive_data')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT * FROM inaccessible.platform_metadata')).rejects.toMatchObject({ code: '42501' });
  });
  it.each([
    'UPDATE public."VerifiedNumber" SET "adminAccess" = true',
    'INSERT INTO public."Warehouse" VALUES (2)',
    'DELETE FROM public.opportunities',
    'TRUNCATE public."Warehouse"',
    'CREATE TABLE public.forbidden (id integer)',
    'CREATE ROLE forbidden_role',
    'SET ROLE postgres',
    'UPDATE context_security_private.legacy_key_bindings SET employee_id = 8',
    'DELETE FROM context_prompts_private.prompt_overrides',
    'DELETE FROM context_gmail_private.connections',
    'TRUNCATE context_gmail_private.draft_operations',
    "UPDATE context_ramesh_private.request_nonces SET expires_at = now() + interval '1 hour'",
  ])('denies %s', async sql => { await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' }); });
  it('can issue and recopy a private key and save a prompt with the restricted role', async () => {
    const previous = { writes: process.env.CONTEXT_CONSOLE_WRITES_ENABLED, secret: process.env.CONTEXT_KEY_ENCRYPTION_SECRET };
    process.env.CONTEXT_CONSOLE_WRITES_ENABLED = 'true'; process.env.CONTEXT_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('base64url');
    try {
      const actor = { ...identity, scopes: [...identity.scopes] };
      const key = await rotateOwnConsoleKey(runtime, actor);
      expect((await getOwnConsoleKey(runtime, actor))?.token).toBe(key.token);
      expect((await savePrompt(runtime, { id: 'mcp', body: 'Synthetic instructions', revision: null }, identity.email)).prompt.body).toBe('Synthetic instructions');
    } finally {
      if (previous.writes === undefined) delete process.env.CONTEXT_CONSOLE_WRITES_ENABLED; else process.env.CONTEXT_CONSOLE_WRITES_ENABLED = previous.writes;
      if (previous.secret === undefined) delete process.env.CONTEXT_KEY_ENCRYPTION_SECRET; else process.env.CONTEXT_KEY_ENCRYPTION_SECRET = previous.secret;
    }
  });
  it('persists logout across connections without giving the runtime write access to legacy bindings', async () => {
    const session = { sid: 'A'.repeat(32), exp: Math.floor(Date.now() / 1000) + 28800 };
    await requireActiveConsoleSession(runtime, session);
    await revokeConsoleSession(runtime, session);
    await expect(requireActiveConsoleSession(owner, session)).rejects.toMatchObject({ status: 401 });
  });
  it('keeps Gmail private and claims a draft at most once across real committed concurrent transactions', async () => {
    const gmailOwner = { employeeId: identity.employeeId, employeeEmail: identity.email };
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONTEXT_GMAIL_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
    await runtime.query('BEGIN');
    const connection = await saveGmailConnection(runtime, gmailOwner, { googleSub: 'synthetic-google-sub',
      accountEmail: identity.email, refreshToken: 'synthetic-refresh-token', grantedScopes: ['https://www.googleapis.com/auth/gmail.compose'] }, env);
    await runtime.query('COMMIT');
    const claim = { operationId: randomUUID(), connectionId: connection.id, connectionVersion: connection.version, requestHash: 'a'.repeat(64) };
    const results = await Promise.all([1, 2, 3].map(async () => {
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        const result = await claimGmailDraftOperation(client, gmailOwner, claim);
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await owner.query('BEGIN');
      try {
        await owner.query(`SET LOCAL ROLE ${role}`);
        await expect(owner.query('SELECT * FROM context_gmail_private.connections')).rejects.toMatchObject({ code: '42501' });
      } finally { await owner.query('ROLLBACK'); }
    }
  });
  it('reruns all private migrations safely after restricted-role policies are installed', async () => {
    await migrateConsoleStorage(owner); await migrateKnowledge(owner, []);
    await migratePromptStorage(owner); await migrateMcpOAuthStorage(owner);
    await expect(migrateSecurityStorage(owner, [legacy])).resolves.toMatchObject({ verified: true });
    await expect(migrateGmailStorage(owner)).resolves.toMatchObject({ verified: true, runtimeGranted: true });
  });
  it('does not adopt an existing runtime role or reset its password', async () => {
    await expect(provisionRuntimeRole(owner, randomBytes(32).toString('base64url'))).rejects.toThrow('RUNTIME_ROLE_ALREADY_EXISTS');
    expect((await runtime.query('SELECT current_user')).rows[0].current_user).toBe('context_engine_runtime');
  });
  it('narrows PUBLIC defaults without changing any existing role access and produces an exact rollback', async () => {
    await owner.query(`CREATE TABLE public.platform_fixture (id integer);
      GRANT SELECT, INSERT ON public.platform_fixture TO PUBLIC;
      CREATE FUNCTION public.platform_fixture_fn() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';`);
    const before = (await owner.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid='public.platform_fixture'::regclass`)).rows;
    await owner.query('BEGIN');
    const result = await restrictPublicAccess(owner, [{ kind: 'table', name: 'public.platform_fixture' }, { kind: 'function', name: 'public.platform_fixture_fn()' }]);
    await owner.query('COMMIT');
    expect(result.objects).toHaveLength(2); expect(result.rolesPreserved).toBeGreaterThan(3);
    await expect(runtime.query('SELECT * FROM public.platform_fixture')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT public.platform_fixture_fn()')).rejects.toMatchObject({ code: '42501' });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await owner.query(`SELECT has_table_privilege($1,'public.platform_fixture','SELECT,INSERT') AND
        has_function_privilege($1,'public.platform_fixture_fn()','EXECUTE') AS retained`, [role])).rows[0].retained).toBe(true);
    }
    await owner.query('BEGIN'); await owner.query(result.rollback.join('\n')); await owner.query('COMMIT');
    expect((await owner.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid='public.platform_fixture'::regclass`)).rows).toEqual(before);
    await owner.query('DROP TABLE public.platform_fixture; DROP FUNCTION public.platform_fixture_fn()');
  });
  it('refuses a warning-only ineffective REVOKE when the operator does not own the platform function', async () => {
    await owner.query(`CREATE FUNCTION public.managed_platform_fixture() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      ALTER FUNCTION public.managed_platform_fixture() OWNER TO service_role;`);
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE authenticated');
      await expect(restrictPublicAccess(owner, [{ kind: 'function', name: 'public.managed_platform_fixture()' }]))
        .rejects.toThrow('PLATFORM_OWNER_PRIVILEGES_REQUIRED');
    } finally { await owner.query('ROLLBACK'); }
    expect((await owner.query("SELECT has_function_privilege('context_engine_runtime','public.managed_platform_fixture()','EXECUTE') AS unchanged")).rows[0].unchanged).toBe(true);
    await owner.query('DROP FUNCTION public.managed_platform_fixture()');
  });
  it('rejects concurrent replays across connections and after reconnecting, while cleaning expired entries', async () => {
    const hash = randomBytes(32).toString('base64url'), expiry = new Date(Date.now() + 60_000);
    await owner.query('INSERT INTO context_ramesh_private.request_nonces VALUES ($1, now() - interval \'1 second\')', [randomBytes(32).toString('base64url')]);
    const results = await Promise.all([1, 2, 3].map(() => consumeRameshNonce(hash, expiry, runtimePool)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await owner.query('SELECT count(*)::int AS count FROM context_ramesh_private.request_nonces')).rows[0].count).toBe(1);
    const fresh = new pg.Pool(runtimePool.options);
    try { expect(await consumeRameshNonce(hash, expiry, fresh)).toBe(false); } finally { await fresh.end(); }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await owner.query('BEGIN');
      try {
        await owner.query(`SET LOCAL ROLE ${role}`);
        await expect(owner.query('SELECT * FROM context_ramesh_private.request_nonces')).rejects.toMatchObject({ code: '42501' });
      } finally { await owner.query('ROLLBACK'); }
    }
  });
  it('validates nonce migrations on rerun and refuses dropped uniqueness, schema drift, and unsafe policies', async () => {
    await owner.query('BEGIN'); await applyRameshAuthSchema(owner); await owner.query('COMMIT');
    for (const sql of [
      'ALTER TABLE context_ramesh_private.request_nonces DROP CONSTRAINT request_nonces_pkey',
      'DROP INDEX context_ramesh_private.request_nonces_expiry',
      'ALTER TABLE context_ramesh_private.request_nonces ADD COLUMN token text',
      'CREATE POLICY untrusted ON context_ramesh_private.request_nonces USING (true)',
    ]) {
      await owner.query('BEGIN');
      try { await owner.query(sql); await expect(applyRameshAuthSchema(owner)).rejects.toThrow(/RAMESH_(SCHEMA|POLICY)_INCOMPATIBLE/); }
      finally { await owner.query('ROLLBACK'); }
    }
  });
  it('rejects unexpected RLS policies even when the expression is null', async () => {
    await owner.query('DROP POLICY context_runtime ON context_prompts_private.prompt_overrides');
    await owner.query('CREATE POLICY context_runtime ON context_prompts_private.prompt_overrides TO context_engine_runtime');
    await expect(migratePromptStorage(owner)).rejects.toThrow('PROMPTS_RELATION_INCOMPATIBLE');
    await owner.query('ALTER POLICY context_runtime ON context_prompts_private.prompt_overrides USING (true) WITH CHECK (true)');
  });
  it('refuses an unexpected policy in security storage without altering it', async () => {
    await owner.query('CREATE POLICY untrusted ON context_security_private.session_revocations USING (true)');
    await expect(migrateSecurityStorage(owner, [legacy])).rejects.toThrow('SECURITY_STORAGE_INCOMPATIBLE');
    expect((await owner.query("SELECT polname FROM pg_policy WHERE polrelid = 'context_security_private.session_revocations'::regclass AND polname = 'untrusted'")).rows).toHaveLength(1);
    await owner.query('DROP POLICY untrusted ON context_security_private.session_revocations');
  });
  it('does not transfer a pinned key to a replacement employee on migration rerun', async () => {
    await owner.query('UPDATE public."VerifiedNumber" SET id = 8 WHERE id = 7');
    await expect(resolvePrincipal(runtime, { ...legacy, scopes: [...legacy.scopes] })).rejects.toMatchObject({ status: 403 });
    await expect(migrateSecurityStorage(owner, [legacy])).rejects.toThrow('SECURITY_STORAGE_INCOMPATIBLE');
    expect((await owner.query('SELECT employee_id FROM context_security_private.legacy_key_bindings')).rows).toEqual([{ employee_id: 7 }]);
  });
});
