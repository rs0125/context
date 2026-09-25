import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { parseWarehouseMeasurement, warehouseMeasurementSql, WAREHOUSE_NUMERIC_FIELDS } from '../src/lib/warehouse-fields';
import { getWarehouseFilterOptions, searchWarehouses } from '../src/lib/data';

// Explicit opt-in only. One transaction-pool socket; SELECTs and synthetic
// expressions only. No fixture tables or production writes are needed.
describe.skipIf(process.env.CONTEXT_LIVE_WAREHOUSE_TEST !== '1')('read-only warehouse integration', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    if (!env.DATABASE_URL) throw new Error('Database configuration missing');
    const url = new URL(env.DATABASE_URL);
    if (!url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('Transaction pooler required');
    url.search = '';
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000,
      query_timeout: 6000, idleTimeoutMillis: 1000,
      ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
      application_name: 'wareongo-context-filter-verification' });
    client = await pool.connect();
  }, 10000);
  beforeEach(async () => {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
  });
  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('PostgreSQL and response evidence agree on mixed real-world formats', async () => {
    const samples = [null, '', '0', '4', '4.5', '1,500', '1,00,000', '10,00,000', '1,2,3', '10000 sft',
      '25ft', '12 feet', '10 M', '10mtrs', '3–4 ft', '3-4 ft', '4 to 6', '20ft-60ft', '10m-40ft',
      'approx 4', 'Approximately 4', '~4', '4 approx', '₹ 25', 'Rs. 25', '25 Negotiable', '20-25',
      '15KVA', '15kw', '2 docks', '2 washrooms', '02', '2.5 docks', '4x6', '4/6', 'N/A', 'None',
      'As per client requirement', '4 call me 9876543210', '9876543210', '-4', '4e1', '9'.repeat(101),
      ' '.repeat(101) + '4', '\t4\n', '4\n5', '0-4', '6-4'];
    for (const definition of WAREHOUSE_NUMERIC_FIELDS) {
      const { join, alias } = warehouseMeasurementSql({ ...definition, column: 'input.sample' }, 0);
      const result = await client.query(`SELECT input.ordinality, ${alias}.kind, ${alias}.value,
        ${alias}.lower, ${alias}.upper FROM unnest($1::text[]) WITH ORDINALITY AS input(sample, ordinality)
        ${join} ORDER BY input.ordinality`, [samples]);
      expect(result.rows).toHaveLength(samples.length);
      for (let index = 0; index < samples.length; index++) {
        const expected = parseWarehouseMeasurement(samples[index], definition);
        const actual = result.rows[index];
        expect(actual.kind, `${definition.field}: ${samples[index]}`).toBe(expected.kind);
        if (expected.kind === 'unknown') {
          expect(actual.value).toBeNull(); expect(actual.lower).toBeNull(); expect(actual.upper).toBeNull();
        } else if (expected.kind === 'range') {
          expect(actual.value).toBeNull();
          expect(Number(actual.lower)).toBeCloseTo(expected.lower!, 8);
          expect(Number(actual.upper)).toBeCloseTo(expected.upper!, 8);
        } else {
          expect(Number(actual.value)).toBeCloseTo(expected.value!, 8);
        }
      }
    }
  }, 20000);

  it('combines live location, dock and height constraints without discarding uncertain candidates', async () => {
    const query = new URLSearchParams('city=Bengaluru&docks_min=4&clear_height_min_ft=25&include_unknown=true&limit=25');
    const started = performance.now();
    const result = await searchWarehouses(client, query);
    console.info(JSON.stringify({ check: 'combined_warehouse_filter', duration_ms: Math.round(performance.now() - started), records: result.items.length }));
    expect(result.items.length).toBeGreaterThan(0);
    for (const record of result.items) {
      expect(['bengaluru', 'bangalore']).toContain(record.city?.toLowerCase());
      for (const [field, minimum] of [['dock_count', 4], ['clear_height_ft', 25]] as const) {
        const evidence = record.field_evidence[field];
        if (evidence.kind === 'unknown') expect(record.verification_required).toBe(true);
        else if (evidence.kind === 'range') {
          expect(evidence.upper).toBeGreaterThanOrEqual(minimum);
          expect(record.verification_required).toBe(true);
        } else {
          expect(evidence.value).toBeGreaterThanOrEqual(minimum);
          if (evidence.kind === 'approximate') expect(record.verification_required).toBe(true);
        }
      }
    }
    query.set('city', 'Bangalore');
    const alias = await searchWarehouses(client, query);
    expect(alias.items.map(record => record.id)).toEqual(result.items.map(record => record.id));
    query.set('match_mode', 'strict'); query.set('include_unknown', 'false');
    const strict = await searchWarehouses(client, query);
    expect(strict.items.length).toBeGreaterThan(0);
    for (const record of strict.items) {
      expect(record.dock_count).toBeGreaterThanOrEqual(4);
      expect(record.clear_height_ft).toBeGreaterThanOrEqual(25);
    }
  }, 20000);

  it('distinguishes true, false and unknown Fire NOC and provides live filter discovery', async () => {
    for (const value of ['true', 'false', 'unknown']) {
      const result = await searchWarehouses(client, new URLSearchParams(`fire_noc=${value}&limit=2`));
      for (const record of result.items) expect(record.fire_noc_available).toBe(value === 'unknown' ? null : value === 'true');
    }
    const options = await getWarehouseFilterOptions(client, new URLSearchParams('city=Bengaluru'));
    expect(options.catalog.some(field => field.name === 'docks_min')).toBe(true);
    expect(options.options.type.length).toBeGreaterThan(0);
  }, 20000);
});
