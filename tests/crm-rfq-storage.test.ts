/** Disposable local PostgreSQL only. No Twenty calls or production credentials. */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { claimCrmRfq, finishCrmRfq } from '../src/lib/crm-writes/storage';
const modulePath = '../scripts/migrate-crm-writes.mjs';
const { migrateCrmWrites } = await import(modulePath);
const connection = process.env.CONTEXT_CRM_TEST_DATABASE_URL;
describe.skipIf(!connection)('isolated RFQ receipt migration and concurrency', () => {
  let owner: pg.Pool, runtime: pg.Pool;
  const actor: Principal = { employeeId: 7, email: 'employee@wareongo.com', keyId: 'test', scopes: ['crm.rfq:write'],
    twentyUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isAnalyst: false };
  const hash = 'a'.repeat(64);
  async function tx<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async function migrate() {
    const client = await owner.connect();
    try { return await migrateCrmWrites(client); } finally { client.release(); }
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/context_crm_rfq_test') throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');
    owner = new pg.Pool({ connectionString: connection, max: 4 });
    await owner.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE ROLE context_engine_runtime LOGIN PASSWORD 'rfq_fixture_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE TABLE public.opportunities (id integer);`);
    expect(await migrate()).toMatchObject({ applied: true, verified: true, runtimeGranted: true, businessWrites: false });
    url.username = 'context_engine_runtime'; url.password = 'rfq_fixture_only';
    runtime = new pg.Pool({ connectionString: url.toString(), max: 4 });
  }, 30_000);
  afterAll(async () => { await runtime?.end(); await owner?.end(); });
  it('admits one concurrent claim across connections and rejects payload or member rebinding', async () => {
    const operation = randomUUID();
    const claims = await Promise.all(Array.from({ length: 12 }, () => tx(runtime, c => claimCrmRfq(c, actor, operation, hash))));
    expect(claims.filter(c => c.fresh)).toHaveLength(1);
    expect(claims.every(c => c.receipt.state === 'dispatching')).toBe(true);
    await expect(tx(runtime, c => claimCrmRfq(c, actor, operation, 'b'.repeat(64)))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => claimCrmRfq(c, { ...actor, twentyUserId: randomUUID() }, operation, hash))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    const id = randomUUID();
    await tx(runtime, c => finishCrmRfq(c, actor, operation, hash, { outcome: 'created', id }));
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: false, receipt: { state: 'created', resource_id: id } });
    // Migration reruns grant narrowly and preserve existing operations.
    expect(await migrate()).toMatchObject({ verified: true });
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: false, receipt: { resource_id: id } });
  });
  it('makes claim rollback atomic and isolates operation IDs by employee', async () => {
    const operation = randomUUID();
    await expect(tx(runtime, async c => { await claimCrmRfq(c, actor, operation, hash); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: true });
    const other = { ...actor, employeeId: 8, email: 'other@wareongo.com' };
    expect(await tx(runtime, c => claimCrmRfq(c, other, operation, hash))).toMatchObject({ fresh: true, receipt: { employee_id: 8, state: 'dispatching', resource_id: null } });
    await expect(tx(runtime, c => finishCrmRfq(c, { ...actor, email: 'rebound@wareongo.com' }, operation, hash, { outcome: 'rejected' }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
  });
  it('unknown/rejected claims are terminal and cannot be reclaimed or overwritten', async () => {
    for (const outcome of ['outcome_unknown', 'rejected'] as const) {
      const operation = randomUUID();
      await tx(runtime, c => claimCrmRfq(c, actor, operation, hash));
      await tx(runtime, c => finishCrmRfq(c, actor, operation, hash, { outcome }));
      expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: false, receipt: { state: outcome === 'outcome_unknown' ? 'unknown' : 'rejected' } });
      await expect(tx(runtime, c => finishCrmRfq(c, actor, operation, hash, { outcome: 'created', id: randomUUID() }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
    }
  });
  it('does not grant public/API access, receipt deletion or business-table writes', async () => {
    const privacy = (await owner.query(`SELECT rolname, has_schema_privilege(rolname, 'context_crm_private', 'USAGE') AS schema,
      has_table_privilege(rolname, 'context_crm_private.write_operations', 'SELECT, INSERT, UPDATE, DELETE') AS access
      FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`)).rows;
    expect(privacy.every(r => r.schema === false && r.access === false)).toBe(true);
    await expect(runtime.query('DELETE FROM context_crm_private.write_operations')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('INSERT INTO public.opportunities VALUES (1)')).rejects.toMatchObject({ code: '42501' });
    expect((await owner.query('SELECT count(*)::int AS n FROM public.opportunities')).rows[0].n).toBe(0);
  });
  it('rejects future actions and invalid success receipts at the database boundary', async () => {
    const operation = randomUUID(); await tx(runtime, c => claimCrmRfq(c, actor, operation, hash));
    await expect(runtime.query("UPDATE context_crm_private.write_operations SET action='update_crm_deal' WHERE operation_id=$1", [operation])).rejects.toMatchObject({ code: '23514' });
    await expect(runtime.query("UPDATE context_crm_private.write_operations SET state='created' WHERE operation_id=$1", [operation])).rejects.toMatchObject({ code: '23514' });
  });
  it('refuses unexpected policies and schema drift without dropping existing receipts', async () => {
    await owner.query('CREATE POLICY unexpected ON context_crm_private.write_operations FOR SELECT TO PUBLIC USING (true)');
    await expect(migrate()).rejects.toThrow('CRM_RELATION_INCOMPATIBLE');
    await owner.query('DROP POLICY unexpected ON context_crm_private.write_operations');
    await owner.query('ALTER TABLE context_crm_private.write_operations ADD COLUMN unexpected text');
    await expect(migrate()).rejects.toThrow('CRM_RELATION_INCOMPATIBLE');
  });
});
