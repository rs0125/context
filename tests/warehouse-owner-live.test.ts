import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { getWarehouse, searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';

// Real query builders and PostgreSQL execution using synthetic JSONB relations.
// Existing row types check schema compatibility; no source rows or writes are
// needed. One verified TLS socket, short read-only transactions and an opt-in.
describe.skipIf(process.env.CONTEXT_LIVE_WAREHOUSE_TEST !== '1')('synthetic warehouse owner SQL', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let fixture: PoolClient;
  const record = (id: number, contactPerson: string | null, changes: Record<string, unknown> = {}) => ({
    id, contactPerson, ownerCompanyName: null, visibility: true, city: 'Bengaluru',
    totalSpaceSqft: [50000], numberOfDocks: '4', createdAt: '2026-09-01T12:00:00Z', ...changes,
  });
  const rows = [
    record(1, 'Ramesh Mehta', { ownerCompanyName: 'Ramesh Estates', city: 'Bangalore' }),
    record(2, 'Ramseh Mehta'), record(3, 'Suresh Shah'),
    record(4, 'Priya Rao', { ownerCompanyName: 'Ramesh Logistics' }),
    record(5, 'Ramesh Hidden', { visibility: false }), record(6, 'Ramesh Hidden Null', { visibility: null }),
    record(7, 'Ramesh Delhi', { city: 'Delhi' }), record(8, "O'Neill & Sons"),
    record(9, 'José Menéndez'), record(10, 'रमेश शर्मा'),
    record(11, null), record(12, 'Ramesh Local', { numberOfDocks: '2' }),
  ];
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    if (!env.DATABASE_URL) throw new Error('Database configuration missing');
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('Transaction pooler required');
    url.search = '';
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000,
      query_timeout: 6000, idleTimeoutMillis: 1000,
      ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
      application_name: 'wareongo-context-synthetic-owner-verification' });
    client = await pool.connect();
    fixture = { query: async (sql: string, values: unknown[] = []) => {
      if (!/^(?:SELECT|WITH)\b/.test(sql) || !sql.includes('public."Warehouse"')) throw new Error('Unexpected fixture query');
      const replaced = sql.replaceAll('public."WarehouseData"', 'fixture_details').replaceAll('public."Warehouse"', 'fixture_warehouses')
        .replaceAll('public."VerifiedNumber"', 'fixture_roster');
      if (/\bpublic\s*\./i.test(replaced)) throw new Error('Source table access refused');
      const ctes = `fixture_warehouses AS (SELECT * FROM jsonb_populate_recordset(NULL::public."Warehouse", $${values.length + 1}::jsonb)),
        fixture_details AS (SELECT * FROM jsonb_populate_recordset(NULL::public."WarehouseData", '[]'::jsonb)),
        fixture_roster AS (SELECT NULL::text AS email, NULL::text AS name WHERE false)`;
      return client.query(replaced.startsWith('WITH ') ? `WITH ${ctes}, ${replaced.slice(5)}` : `WITH ${ctes} ${replaced}`,
        [...values, JSON.stringify(rows)]);
    } } as unknown as PoolClient;
  }, 10000);
  beforeEach(async () => {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
  });
  afterEach(async () => { if (client) await client.query('ROLLBACK'); });
  afterAll(async () => { client?.release(); await pool?.end(); });

  it('matches case, partial names and each one-character typo but not unrelated people', async () => {
    for (const name of ['RAMESH', 'rames', 'ramsh', 'rameesh', 'ramezh', 'ramseh']) {
      const result = await searchWarehouses(fixture, new URLSearchParams({ owner_name: name, owner_match_mode: 'fuzzy', city: 'Bangalore', docks_min: '4', include_unknown: 'false', limit: '25' }));
      const ids = result.items.map(item => item.id);
      expect(ids, name).toContain(1);
      expect(ids, name).toContain(4);
      expect(ids, name).not.toEqual(expect.arrayContaining([3, 5, 6, 7, 12]));
      expect(ids.every(id => [1, 2, 4].includes(id)), name).toBe(true);
    }
  }, 20000);

  it.each([
    ['exact', '  ramesh mehta  ', [1]], ['exact', 'Ramesh', []],
    ['contains', 'Ramesh', [1, 4, 12]], ['contains', 'Ramseh', [2]],
    ['fuzzy', 'Raj', []], ['fuzzy', 'O Neill', [8]], ['exact', "O'Neill & Sons", [8]],
    ['fuzzy', 'jose', []], ['contains', 'José', [9]], ['exact', 'रमेश शर्मा', [10]],
    ['contains', 'रमेश', [10]], ['fuzzy', 'Nobody', []],
  ])('executes %s matching for %s', async (mode, name, ids) => {
    const result = await searchWarehouses(fixture, new URLSearchParams({ owner_name: name, owner_match_mode: mode, city: 'Bengaluru', limit: '25' }));
    expect(result.items.map(item => item.id)).toEqual(ids);
  });

  it('counts before pagination, counts a dual-field match once, and preserves visibility and other constraints', async () => {
    const query = new URLSearchParams('owner_name=Ramesh&owner_match_mode=fuzzy&city=Bangalore&docks_min=4&include_unknown=false');
    const summary = await summarizeWarehouses(fixture, query);
    expect(summary).toMatchObject({ total: 3, groups: [{ value: 'Bengaluru', count: 3 }], other_count: 0 });
    query.set('limit', '1');
    const ids: number[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await searchWarehouses(fixture, query);
      ids.push(...result.items.map(item => item.id));
      if (!result.nextCursor) break;
      query.set('cursor', result.nextCursor);
    }
    expect(ids).toEqual([1, 2, 4]);
    expect(ids).toHaveLength(summary.total);
    expect(await getWarehouse(fixture, 5)).toBeNull();
    expect(await getWarehouse(fixture, 1)).toMatchObject({ owner_name: 'Ramesh Mehta', owner_company_name: 'Ramesh Estates' });
  });

  it('bounds the longest accepted name expression in PostgreSQL', async () => {
    const result = await searchWarehouses(fixture, new URLSearchParams({ owner_name: 'abcdefghij'.repeat(8) }));
    expect(result.items).toEqual([]);
  });

  it('keeps literal preference stable on later pages and applies it within the other filters', async () => {
    const query = new URLSearchParams('owner_name=Ramesh&city=Bangalore&docks_min=4&include_unknown=false&limit=1');
    const first = await searchWarehouses(fixture, query);
    expect(first.items.map(item => item.id)).toEqual([1]);
    expect(first.matching_policy.owner_name).toMatchObject({ mode: 'auto', strategy: 'literal_first', approximate_name_count: 0 });
    query.set('cursor', first.nextCursor!);
    const second = await searchWarehouses(fixture, query);
    expect(second.items.map(item => item.id)).toEqual([4]);
    expect(second.nextCursor).toBeNull();
    expect(second.matching_policy.owner_name?.strategy).toBe('literal_first');
    const fallback = await searchWarehouses(fixture, new URLSearchParams('owner_name=Ramseh&city=Delhi'));
    expect(fallback.items.map(item => item.id)).toEqual([7]);
    expect(fallback.matching_policy.owner_name?.strategy).toBe('fuzzy_fallback');
  });
});
