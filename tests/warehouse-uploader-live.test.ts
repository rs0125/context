import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { getWarehouse, getWarehouseFilterOptions, searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';
import { warehouseUploaderName } from '../src/lib/warehouse-uploader';

// Executes actual PostgreSQL builders with synthetic relations, then compares
// real inventory against an independent in-memory attribution oracle. Read-only
// transactions, one verified TLS socket, no source writes or retained names.
describe.skipIf(process.env.CONTEXT_LIVE_WAREHOUSE_UPLOADER_TEST !== '1')('warehouse uploader SQL and real inventory', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let fixture: PoolClient;
  const record = (id: number, uploadedBy: string | null, extra = {}) => ({ id, uploadedBy,
    visibility: true, city: 'Bengaluru', state: 'Karnataka', totalSpaceSqft: [50000],
    createdAt: '2026-10-01T12:00:00Z', ...extra });
  let rows: ReturnType<typeof record>[];
  const roster = [
    { email: 'alex@example.test', name: 'Alex Rao' },
    { email: 'other-alex@example.test', name: 'Alex Rao' },
    { email: 'inactive@example.test', name: 'Former Staff', is_active: false },
    { email: 'duplicate@example.test', name: 'First' },
    { email: ' DUPLICATE@EXAMPLE.TEST ', name: 'Second' },
    { email: 'unsafe@example.test', name: 'Call me 9876543210' },
    { email: 'unused@example.test', name: 'Unused Staff' },
    { email: 'sam@example.test', name: 'Sam' },
    { email: 'jose@example.test', name: 'Jose\u0301 Rao' },
  ];
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    const connection = env.CONTEXT_DATABASE_URL ?? env.DATABASE_URL;
    if (!connection) throw new Error('Database configuration missing');
    const url = new URL(connection);
    if (!url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('Transaction pooler required');
    url.search = '';
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 4000,
      query_timeout: 6000, idleTimeoutMillis: 1000, application_name: 'warehouse-uploader-readonly-verification',
      ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) } });
    client = await pool.connect();
    fixture = { query: async (sql: string, values: unknown[] = []) => {
      const replaced = sql.replaceAll('public."WarehouseData"', 'fixture_details')
        .replaceAll('public."Warehouse"', 'fixture_warehouses').replaceAll('public."VerifiedNumber"', 'fixture_roster');
      if (!/^(SELECT|WITH)\b/.test(replaced) || /\bpublic\s*\./i.test(replaced)) throw new Error('Unexpected source query');
      const ctes = `fixture_warehouses AS (SELECT * FROM jsonb_populate_recordset(NULL::public."Warehouse", $${values.length + 1}::jsonb)),
        fixture_details AS (SELECT * FROM jsonb_populate_recordset(NULL::public."WarehouseData", '[]'::jsonb)),
        fixture_roster AS (SELECT * FROM jsonb_to_recordset($${values.length + 2}::jsonb) AS r(email text, name text))`;
      return client.query(replaced.startsWith('WITH ') ? `WITH ${ctes}, ${replaced.slice(5)}` : `WITH ${ctes} ${replaced}`,
        [...values, JSON.stringify(rows), JSON.stringify(roster)]);
    } } as unknown as PoolClient;
  }, 10000);
  beforeEach(async () => {
    rows = [record(1, ' ALEX@EXAMPLE.TEST '), record(2, ' Alex Rao ', { city: 'Bangalore' }),
      record(3, 'other-alex@example.test'), record(4, 'inactive@example.test'), record(5, 'unmapped@example.test'),
      record(6, 'duplicate@example.test'), record(7, 'Hidden Staff', { visibility: false }),
      record(8, 'Hidden Null', { visibility: null }), record(9, 'Sam'), record(10, 'unsafe@example.test'),
      record(11, null), record(12, 'alex rao', { city: 'Delhi', state: 'Delhi' }), record(13, 'रमेश शर्मा'),
      record(14, 'Ａｌｅｘ'), record(15, "O'Neill"), record(16, 'Sam', { contactPerson: 'Alex Rao' }),
      record(17, 'sam@example.test'), record(18, 'Jose\u0301 Rao'), record(19, '\tJosé Rao\n'), record(20, 'jose@example.test')];
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
  });
  afterEach(async () => { if (client) await client.query('ROLLBACK'); });
  afterAll(async () => { client?.release(); await pool?.end(); });

  it('discovers only round-trippable names on visible scoped inventory and withholds unsafe/unmapped attribution', async () => {
    const options = await getWarehouseFilterOptions(fixture, new URLSearchParams('city=Bangalore&state=Karnataka'));
    expect(options.options.uploaded_by).toEqual(expect.arrayContaining(['Alex', 'Former Staff', 'Sam', "O'Neill", 'रमेश शर्मा', 'José Rao']));
    expect(options.options.uploaded_by).toHaveLength(6);
    for (const name of options.options.uploaded_by) {
      const summary = await summarizeWarehouses(fixture, new URLSearchParams({ uploaded_by: name, city: 'Bangalore' }));
      expect(summary.total).toBeGreaterThan(0);
    }
    for (const id of [5, 6, 10, 11]) expect(await getWarehouse(fixture, id)).toMatchObject({ uploaded_by: null });
    expect(await getWarehouse(fixture, 4)).toMatchObject({ uploaded_by: 'Former Staff' });
    expect(await getWarehouse(fixture, 7)).toBeNull();
    expect(JSON.stringify(options)).not.toMatch(/example.test|Hidden Staff|Unused Staff|9876543210/);
  }, 20000);

  it('combines exact uploader names with location and dates before counts and pagination without duplicating rows', async () => {
    const params = new URLSearchParams({ uploaded_by: '  SAM  ', city: 'Bangalore', date_from: '2026-10-01', date_to: '2026-10-01' });
    const summary = await summarizeWarehouses(fixture, params);
    expect(summary).toMatchObject({ total: 3, groups: [{ value: 'Bengaluru', count: 3 }] });
    params.set('limit', '1');
    const ids: number[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await searchWarehouses(fixture, params);
      ids.push(...result.items.map(item => item.id));
      expect(result.items.every(item => item.uploaded_by === 'Sam')).toBe(true);
      if (!result.nextCursor) break;
      params.set('cursor', result.nextCursor);
    }
    expect(ids).toEqual([9, 16, 17]);
    for (const name of ['Sam Shah', 'Nobody', 'First', 'Second']) {
      expect((await summarizeWarehouses(fixture, new URLSearchParams({ uploaded_by: name }))).total).toBe(0);
    }
    const apostrophe = await searchWarehouses(fixture, new URLSearchParams({ uploaded_by: "O'Neill" }));
    expect(apostrophe.items.map(item => item.id)).toEqual([15]);
  }, 20000);

  it('rejects names shared by distinct known uploaders even when location/date isolate one identity', async () => {
    // Only legacy Alex Rao is in Delhi; ambiguity must remain global to visible
    // inventory. A requested city/date cannot resolve which person was intended.
    for (const read of [searchWarehouses, summarizeWarehouses]) {
      await expect(read(fixture, new URLSearchParams({ uploaded_by: '  ALEX RAO ', city: 'Delhi', date_from: '2026-10-01' })))
        .rejects.toMatchObject({ code: 'UPLOADER_NAME_AMBIGUOUS', status: 422 });
    }
    expect((await getWarehouseFilterOptions(fixture, new URLSearchParams('city=Delhi'))).options.uploaded_by).toEqual([]);
    // Case/space variants of one source email still represent one uploader.
    rows.push(record(21, ' SAM@EXAMPLE.TEST '));
    expect((await summarizeWarehouses(fixture, new URLSearchParams({ uploaded_by: 'Sam' }))).total).toBe(4);
    // An identity with no visible inventory cannot make an option ambiguous.
    rows = rows.filter(row => row.id !== 3);
    rows.push(record(22, 'other-alex@example.test', { visibility: false }));
    expect((await getWarehouseFilterOptions(fixture, new URLSearchParams())).options.uploaded_by).toContain('Alex Rao');
    expect((await summarizeWarehouses(fixture, new URLSearchParams({ uploaded_by: 'Alex Rao' }))).total).toBe(3);
  }, 20000);

  it('round-trips normalized Unicode names across discovery, search, summary and detail', async () => {
    for (const value of ['José Rao', 'Jose\u0301 Rao', '\tJOSÉ RAO\r\n']) {
      const query = new URLSearchParams({ uploaded_by: value });
      expect((await summarizeWarehouses(fixture, query)).total).toBe(3);
      const page = await searchWarehouses(fixture, query);
      expect(page.items.map(item => item.id)).toEqual([18, 19, 20]);
      expect(page.items.every(item => item.uploaded_by === 'José Rao')).toBe(true);
    }
    expect((await searchWarehouses(fixture, new URLSearchParams({ uploaded_by: 'Ａｌｅｘ' }))).items.map(item => item.id)).toEqual([14]);
    expect(await getWarehouse(fixture, 20)).toMatchObject({ uploaded_by: 'José Rao' });
    const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    rows = [record(1, `${whitespace}José Rao${whitespace}`)];
    expect((await getWarehouseFilterOptions(fixture, new URLSearchParams())).options.uploaded_by).toEqual(['José Rao']);
    expect((await summarizeWarehouses(fixture, new URLSearchParams({ uploaded_by: 'José Rao' }))).total).toBe(1);
  }, 20000);

  it('caps uploader options independently and reports truncation', async () => {
    rows = Array.from({ length: 101 }, (_, index) => record(index + 1, `Staff ${String(index).padStart(3, '0')}`));
    const result = await getWarehouseFilterOptions(fixture, new URLSearchParams());
    expect(result.options.uploaded_by).toHaveLength(100);
    expect(result.options.city).toEqual(['Bengaluru']);
    expect(result.truncated).toBe(true);
    expect(result.uploaded_by_truncated).toBe(true);
  });

  it('does not mark the uploader list incomplete when only other categories are capped', async () => {
    rows = Array.from({ length: 101 }, (_, index) => record(index + 1, 'Sam', { city: `City ${index}` }));
    const result = await getWarehouseFilterOptions(fixture, new URLSearchParams());
    expect(result).toMatchObject({ options: { uploaded_by: ['Sam'] }, truncated: true, uploaded_by_truncated: false });
  });

  it('matches real names, counts and a bounded page without assuming an uploader cardinality', async () => {
    const source = await client.query<{ id: number; uploadedBy: string }>('SELECT id, "uploadedBy" FROM public."Warehouse" WHERE visibility IS TRUE ORDER BY id');
    const people = await client.query<{ email: string | null; name: string }>('SELECT email, name FROM public."VerifiedNumber"');
    const canonical = (value: string) => {
      if (!value) return null;
      if (!value.includes('@')) return warehouseUploaderName(value);
      const matches = people.rows.filter(person => person.email?.trim().toLowerCase() === value.trim().toLowerCase());
      return matches.length === 1 ? warehouseUploaderName(matches[0].name) : null;
    };
    const expected = source.rows.map(row => ({ id: row.id, name: canonical(row.uploadedBy),
      email: row.uploadedBy?.includes('@') ? row.uploadedBy.trim().toLowerCase() : null }));
    const emailsByName = new Map<string, Set<string>>();
    for (const row of expected) if (row.name && row.email) {
      const key = row.name.toLowerCase();
      const emails = emailsByName.get(key) ?? new Set<string>();
      emails.add(row.email); emailsByName.set(key, emails);
    }
    const options = await getWarehouseFilterOptions(client, new URLSearchParams());
    const expectedNames = new Set(expected.flatMap(row => row.name && (emailsByName.get(row.name.toLowerCase())?.size ?? 0) <= 1 ? [row.name.toLowerCase()] : []));
    const observedNames = options.options.uploaded_by.map(name => name.toLowerCase());
    expect(observedNames.every(name => expectedNames.has(name))).toBe(true);
    if (!options.uploaded_by_truncated) expect(new Set(observedNames)).toEqual(expectedNames);
    // Exhaustive pagination is covered by synthetic relations above. Live data
    // may have zero, one, or many warehouses per uploader; read at most one page.
    const name = options.options.uploaded_by[0];
    if (!name) return;
    const expectedIds = expected.filter(row => row.name?.toLowerCase() === name.toLowerCase()).map(row => row.id);
    const summary = await summarizeWarehouses(client, new URLSearchParams({ uploaded_by: name }));
    expect(summary.total).toBe(expectedIds.length);
    const page = await searchWarehouses(client, new URLSearchParams({ uploaded_by: name, limit: '5' }));
    const ids = page.items.map(item => item.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(expectedIds.slice(0, ids.length));
    expect(Boolean(page.nextCursor)).toBe(expectedIds.length > ids.length);
    expect(JSON.stringify(await getWarehouse(client, ids[0]))).not.toContain('@');
  }, 25000);
});
