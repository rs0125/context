/** Disposable local PostgreSQL only. No Twenty calls or production credentials. */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { claimCrmRfq, findCrmRfq, finishCrmRfq, claimCrmChange, findCrmChange, finishCrmChange,
  loadCrmChange, findAgentCreatedRfq, listCrmChanges, findAgentCreatedNote, listCrmNoteChanges } from '../src/lib/crm-writes/storage';
import { encryptCrmSnapshot, decryptCrmSnapshot, crmSnapshotContext } from '../src/lib/crm-writes/snapshots';
const modulePath = '../scripts/migrate-crm-writes.mjs';
const { migrateCrmWrites } = await import(modulePath);
const connection = process.env.CONTEXT_CRM_TEST_DATABASE_URL;
describe.skipIf(!connection)('isolated CRM receipt migration and concurrency', () => {
  let owner: pg.Pool, runtime: pg.Pool;
  const actor: Principal = { employeeId: 7, email: 'employee@wareongo.com', keyId: 'test', scopes: ['crm.rfq:write'],
    twentyUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isAnalyst: false };
  const hash = 'a'.repeat(64);
  const legacyOperation = randomUUID(), legacyResource = randomUUID();
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
  async function tableSignature() {
    const oid = (await owner.query("SELECT 'context_crm_private.write_operations'::regclass::oid AS oid")).rows[0].oid;
    const columns = (await owner.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
      a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped, pg_get_expr(d.adbin, d.adrelid) AS default_expression
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 ORDER BY a.attnum`, [oid])).rows;
    const constraints = (await owner.query(`SELECT conname AS name, contype AS type, convalidated AS validated, pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [oid])).rows;
    return createHash('sha256').update(JSON.stringify({ columns, constraints })).digest('hex');
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/context_crm_rfq_test') throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');
    owner = new pg.Pool({ connectionString: connection, max: 4 });
    await owner.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE ROLE context_engine_runtime LOGIN PASSWORD 'rfq_fixture_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE TABLE public.opportunities (id integer);`);
    // Exact prior release shape, with a real successful receipt. Upgrade must validate
    // the old signature before it changes anything, and must retain the receipt.
    await owner.query(`CREATE SCHEMA context_crm_private;
      COMMENT ON SCHEMA context_crm_private IS 'context-crm-write-schema-v1';
      CREATE TABLE context_crm_private.write_operations (
        employee_id integer NOT NULL, employee_email text NOT NULL, operation_id uuid NOT NULL, member_id uuid NOT NULL,
        action text NOT NULL, request_hash text NOT NULL, state text NOT NULL, resource_id uuid,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (employee_id, operation_id),
        CONSTRAINT write_operations_employee_check CHECK (employee_id > 0),
        CONSTRAINT write_operations_email_check CHECK (employee_email = lower(employee_email) AND char_length(employee_email) <= 254 AND employee_email ~ '^[^[:space:]@]+@wareongo[.]com$'),
        CONSTRAINT write_operations_action_check CHECK (action = 'create_crm_rfq'),
        CONSTRAINT write_operations_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT write_operations_state_check CHECK (state IN ('dispatching', 'created', 'unknown', 'rejected')),
        CONSTRAINT write_operations_result_check CHECK ((state = 'created') = (resource_id IS NOT NULL))
      ); ALTER TABLE context_crm_private.write_operations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE context_crm_private.write_operations FORCE ROW LEVEL SECURITY;`);
    const signature = await tableSignature();
    await owner.query("COMMENT ON TABLE context_crm_private.write_operations IS 'context-crm-write-receipts-v1:wrong'");
    await expect(migrate()).rejects.toThrow('CRM_RELATION_COLLISION');
    await owner.query(`COMMENT ON TABLE context_crm_private.write_operations IS 'context-crm-write-receipts-v1:${signature}'`);
    await owner.query(`INSERT INTO context_crm_private.write_operations
      (employee_id, employee_email, operation_id, member_id, action, request_hash, state, resource_id)
      VALUES ($1, $2, $3, $4, 'create_crm_rfq', $5, 'created', $6)`,
    [actor.employeeId, actor.email, legacyOperation, actor.twentyUserId, hash, legacyResource]);
    expect(await migrate()).toMatchObject({ applied: true, verified: true, runtimeGranted: true, businessWrites: false });
    url.username = 'context_engine_runtime'; url.password = 'rfq_fixture_only';
    runtime = new pg.Pool({ connectionString: url.toString(), max: 4 });
  }, 30_000);
  afterAll(async () => { await runtime?.end(); await owner?.end(); });
  it('upgrades v1 in place while preserving successful legacy receipts without inventing snapshots', async () => {
    expect(await tx(runtime, c => findCrmRfq(c, actor, legacyOperation, hash))).toMatchObject({
      state: 'created', resource_id: legacyResource, encrypted_snapshot: null,
    });
    expect(await tx(runtime, c => findAgentCreatedRfq(c, actor, legacyResource))).toMatchObject({ operation_id: legacyOperation });
    const marker = (await owner.query("SELECT obj_description('context_crm_private'::regnamespace, 'pg_namespace') AS marker")).rows[0].marker;
    expect(marker).toBe('context-crm-write-schema-v3');
  });
  it('verifies and upgrades v2 without changing existing RFQ edits or encrypted snapshots', async () => {
    const operation = randomUUID();
    const ciphertext = encryptCrmSnapshot({ before: { budget: '20/month' }, after: { budget: '25/month' } }, {
      employeeId: actor.employeeId!, email: actor.email!, memberId: actor.twentyUserId!, operationId: operation,
      action: 'update_crm_rfq', requestHash: hash,
    }, { CONTEXT_KEY_ENCRYPTION_SECRET: 'local-only-rfq-test-secret-over-32-characters' });
    await tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'update_crm_rfq', ciphertext));
    await tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'update_crm_rfq', { outcome: 'updated', id: legacyResource }));
    const before = (await owner.query('SELECT * FROM context_crm_private.write_operations ORDER BY operation_id')).rows;
    // Reproduce the deployed v2 table exactly, retaining its rows and runtime policy.
    await owner.query(`ALTER TABLE context_crm_private.write_operations DROP CONSTRAINT write_operations_action_check,
      ADD CONSTRAINT write_operations_action_check CHECK (action IN ('create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq'));
      COMMENT ON SCHEMA context_crm_private IS 'context-crm-write-schema-v2';
      COMMENT ON TABLE context_crm_private.write_operations IS 'context-crm-write-receipts-v2:wrong'`);
    const signature = await tableSignature();
    await expect(migrate()).rejects.toThrow('CRM_RELATION_COLLISION');
    expect(await tableSignature()).toBe(signature);
    await owner.query(`COMMENT ON TABLE context_crm_private.write_operations IS 'context-crm-write-receipts-v2:${signature}'`);
    expect(await migrate()).toMatchObject({ verified: true, runtimeGranted: true, businessWrites: false });
    expect((await owner.query('SELECT * FROM context_crm_private.write_operations ORDER BY operation_id')).rows).toEqual(before);
    expect(await tx(runtime, c => loadCrmChange(c, actor, operation))).toMatchObject({
      action: 'update_crm_rfq', state: 'updated', resource_id: legacyResource, encrypted_snapshot: ciphertext,
    });
    const upgradedSignature = await tableSignature();
    expect(upgradedSignature).not.toBe(signature);
    expect(await migrate()).toMatchObject({ verified: true });
    expect(await tableSignature()).toBe(upgradedSignature);
  });
  it('admits one concurrent claim across connections and rejects payload or member rebinding', async () => {
    const operation = randomUUID();
    const claims = await Promise.all(Array.from({ length: 12 }, () => tx(runtime, c => claimCrmRfq(c, actor, operation, hash))));
    expect(claims.filter(c => c.fresh)).toHaveLength(1);
    expect(claims.every(c => c.receipt.state === 'dispatching')).toBe(true);
    await expect(tx(runtime, c => claimCrmRfq(c, actor, operation, 'b'.repeat(64)))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => claimCrmRfq(c, { ...actor, twentyUserId: randomUUID() }, operation, hash))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => findCrmRfq(c, actor, operation, 'b'.repeat(64)))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => findCrmRfq(c, { ...actor, twentyUserId: randomUUID() }, operation, hash))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    const id = randomUUID();
    await tx(runtime, c => finishCrmRfq(c, actor, operation, hash, { outcome: 'created', id }));
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: false, receipt: { state: 'created', resource_id: id } });
    // Migration reruns grant narrowly and preserve existing operations.
    expect(await migrate()).toMatchObject({ verified: true });
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: false, receipt: { resource_id: id } });
    expect(await tx(runtime, async c => {
      await c.query('SET TRANSACTION READ ONLY');
      return findCrmRfq(c, actor, operation, hash);
    })).toMatchObject({ state: 'created', resource_id: id });
  });
  it('makes claim rollback atomic and isolates operation IDs by employee', async () => {
    const operation = randomUUID();
    expect(await tx(runtime, c => findCrmRfq(c, actor, operation, hash))).toBeNull();
    await expect(tx(runtime, async c => { await claimCrmRfq(c, actor, operation, hash); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await tx(runtime, c => claimCrmRfq(c, actor, operation, hash))).toMatchObject({ fresh: true });
    const other = { ...actor, employeeId: 8, email: 'other@wareongo.com' };
    expect(await tx(runtime, c => claimCrmRfq(c, other, operation, hash))).toMatchObject({ fresh: true, receipt: { employee_id: 8, state: 'dispatching', resource_id: null } });
    await expect(tx(runtime, c => finishCrmRfq(c, { ...actor, email: 'rebound@wareongo.com' }, operation, hash, { outcome: 'rejected' }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
    await expect(tx(runtime, c => finishCrmRfq(c, { ...actor, twentyUserId: randomUUID() }, operation, hash, { outcome: 'rejected' }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
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
  it('claims edits once, retains encrypted before-images and replaces them only on completion', async () => {
    const operation = randomUUID(), action = 'update_crm_rfq' as const;
    const env = { CONTEXT_KEY_ENCRYPTION_SECRET: 'local-only-rfq-test-secret-over-32-characters' };
    const context = { employeeId: actor.employeeId!, email: actor.email!, memberId: actor.twentyUserId!, operationId: operation, action, requestHash: hash };
    const before = encryptCrmSnapshot({ before: { budget: '₹20/sq ft/month' } }, context, env);
    const after = encryptCrmSnapshot({ before: { budget: '₹20/sq ft/month' }, after: { budget: '₹25/sq ft/month' } }, context, env);
    const claims = await Promise.all(Array.from({ length: 8 }, () => tx(runtime, c => claimCrmChange(c, actor, operation, hash, action, before))));
    expect(claims.filter(c => c.fresh)).toHaveLength(1);
    expect(claims.every(c => c.receipt.encrypted_snapshot === before)).toBe(true);
    await expect(tx(runtime, c => findCrmRfq(c, actor, operation, hash))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'undo_crm_rfq'))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await tx(runtime, c => finishCrmChange(c, actor, operation, hash, action, { outcome: 'updated', id: legacyResource, encryptedSnapshot: after }));
    const stored = await tx(runtime, c => findCrmChange(c, actor, operation, hash, action));
    expect(stored).toMatchObject({ state: 'updated', resource_id: legacyResource, encrypted_snapshot: after });
    expect(decryptCrmSnapshot(stored!.encrypted_snapshot!, crmSnapshotContext(stored!), env)).toEqual({ before: { budget: '₹20/sq ft/month' }, after: { budget: '₹25/sq ft/month' } });
    expect(await tx(runtime, c => claimCrmChange(c, actor, operation, hash, action, before))).toMatchObject({ fresh: false, receipt: { encrypted_snapshot: after } });
    await expect(tx(runtime, c => finishCrmChange(c, actor, operation, hash, action, { outcome: 'updated', id: legacyResource, encryptedSnapshot: before }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
  });
  it('actor-scoped history and provenance lookups exclude other members, emails, employees and non-create receipts', async () => {
    const operation = randomUUID(), resource = randomUUID();
    await tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'undo_crm_rfq'));
    await tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'undo_crm_rfq', { outcome: 'rolled_back', id: resource }));
    expect(await tx(runtime, c => loadCrmChange(c, actor, operation))).toMatchObject({ state: 'undone', resource_id: resource });
    expect(await tx(runtime, c => findAgentCreatedRfq(c, actor, resource))).toBeNull();
    for (const other of [{ ...actor, employeeId: 99 }, { ...actor, email: 'other@wareongo.com' }, { ...actor, twentyUserId: randomUUID() }]) {
      expect(await tx(runtime, c => loadCrmChange(c, other, operation))).toBeNull();
      expect(await tx(runtime, c => findAgentCreatedRfq(c, other, legacyResource))).toBeNull();
      expect(await tx(runtime, c => listCrmChanges(c, other))).toEqual([]);
    }
    expect(await tx(runtime, c => listCrmChanges(c, actor, 1))).toHaveLength(1);
    await expect(tx(runtime, c => listCrmChanges(c, actor, 100))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
  });
  it('failed edit receipts preserve their encrypted before-image and cannot be reclaimed', async () => {
    const operation = randomUUID();
    await tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'update_crm_rfq', 'test-ciphertext-placeholder'));
    await tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'update_crm_rfq', { outcome: 'outcome_unknown' }));
    expect(await tx(runtime, c => loadCrmChange(c, actor, operation))).toMatchObject({ state: 'unknown', resource_id: null, encrypted_snapshot: 'test-ciphertext-placeholder' });
    await expect(tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'update_crm_rfq', { outcome: 'updated', id: legacyResource }))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
  });
  it('admits a single note dispatch and binds provenance to the exact actor and action', async () => {
    const operation = randomUUID(), noteId = randomUUID();
    const claims = await Promise.all(Array.from({ length: 12 }, () => tx(runtime,
      c => claimCrmChange(c, actor, operation, hash, 'create_crm_note', 'encrypted-note-before-image'))));
    expect(claims.filter(c => c.fresh)).toHaveLength(1);
    await expect(tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'create_crm_rfq'))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => claimCrmChange(c, actor, operation, 'b'.repeat(64), 'create_crm_note'))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    await expect(tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'create_crm_note', { outcome: 'updated', id: noteId })))
      .rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
    await tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'create_crm_note', { outcome: 'created', id: noteId, encryptedSnapshot: 'encrypted-note-after-image' }));
    expect(await tx(runtime, c => findAgentCreatedNote(c, actor, noteId))).toMatchObject({
      operation_id: operation, state: 'created', resource_id: noteId, encrypted_snapshot: 'encrypted-note-after-image',
    });
    expect(await tx(runtime, c => findAgentCreatedRfq(c, actor, noteId))).toBeNull();
    expect(await tx(runtime, c => findAgentCreatedNote(c, actor, legacyResource))).toBeNull();
    await expect(tx(runtime, c => findCrmRfq(c, actor, operation, hash))).rejects.toMatchObject({ code: 'CRM_OPERATION_CONFLICT' });
    for (const other of [{ ...actor, employeeId: 99 }, { ...actor, email: 'other@wareongo.com' }, { ...actor, twentyUserId: randomUUID() }]) {
      expect(await tx(runtime, c => findAgentCreatedNote(c, other, noteId))).toBeNull();
      expect(await tx(runtime, c => listCrmNoteChanges(c, other))).toEqual([]);
      await expect(tx(runtime, c => finishCrmChange(c, other, operation, hash, 'create_crm_note', { outcome: 'created', id: noteId })))
        .rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
    }
  });
  it('keeps note/RFQ histories separate, includes successful undo, and filters a note before applying its limit', async () => {
    const noteId = randomUUID(), otherNote = randomUUID();
    const changes = [
      { action: 'create_crm_note', outcome: 'created', id: noteId },
      { action: 'update_crm_note', outcome: 'updated', id: noteId },
      { action: 'undo_crm_note', outcome: 'rolled_back', id: noteId },
      { action: 'create_crm_note', outcome: 'created', id: otherNote },
    ] as const;
    const operations: string[] = [];
    for (const [index, change] of changes.entries()) {
      const operation = randomUUID(); operations.push(operation);
      await tx(runtime, c => claimCrmChange(c, actor, operation, hash, change.action));
      await tx(runtime, c => finishCrmChange(c, actor, operation, hash, change.action, { outcome: change.outcome, id: change.id }));
      // Deterministic ordering, independent of clock precision or UUID ordering.
      await owner.query("UPDATE context_crm_private.write_operations SET created_at = '2099-01-01T00:00:00Z'::timestamptz + $2 * interval '1 second' WHERE operation_id = $1", [operation, index]);
    }
    for (const outcome of ['rejected', 'outcome_unknown'] as const) {
      const operation = randomUUID();
      await tx(runtime, c => claimCrmChange(c, actor, operation, hash, 'update_crm_note'));
      await tx(runtime, c => finishCrmChange(c, actor, operation, hash, 'update_crm_note', { outcome }));
    }
    const pending = randomUUID();
    await tx(runtime, c => claimCrmChange(c, actor, pending, hash, 'update_crm_note'));
    const notes = await tx(runtime, c => listCrmNoteChanges(c, actor, 50));
    expect(notes.every(r => r.action.endsWith('_note') && ['created', 'updated', 'undone'].includes(r.state))).toBe(true);
    expect(notes.slice(0, 4).map(r => r.operation_id)).toEqual([...operations].reverse());
    expect(await tx(runtime, c => listCrmNoteChanges(c, actor, 1, noteId))).toMatchObject([
      { operation_id: operations[2], action: 'undo_crm_note', state: 'undone' },
    ]);
    expect(await tx(runtime, c => listCrmNoteChanges(c, actor, 50, randomUUID()))).toEqual([]);
    expect(await tx(runtime, c => findAgentCreatedNote(c, actor, noteId))).toMatchObject({ operation_id: operations[0] });
    const rfqs = await tx(runtime, c => listCrmChanges(c, actor, 50));
    expect(rfqs.length).toBeGreaterThan(0);
    expect(rfqs.every(r => r.action.endsWith('_rfq'))).toBe(true);
    expect((await tx(runtime, c => listCrmChanges(c, actor, 1)))[0].action.endsWith('_rfq')).toBe(true);
    for (const limit of [0, 51, 1.5]) await expect(tx(runtime, c => listCrmNoteChanges(c, actor, limit))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
    await expect(tx(runtime, c => listCrmNoteChanges(c, actor, 10, "' OR true --"))).rejects.toMatchObject({ code: 'CRM_RECEIPT_UNAVAILABLE' });
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
