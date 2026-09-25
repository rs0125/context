import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { databaseOptions } from '../src/lib/db';
import { listKnowledge, searchKnowledge } from '../src/lib/knowledge';

const source = 'context_engine_private.knowledge_pages';
// SQL-only synthetic data: no source tables, fixture writes or company content.
const fixture = `fixture_pages AS (
  SELECT 'guide-' || lpad(n::text, 4, '0') AS id,
    CASE WHEN n = 601 THEN 'Special warehouse guide' ELSE 'Warehouse guide ' || n END AS title,
    'Synthetic guidance'::text AS summary, 'Warehouse specifications need verification.'::text AS body,
    DATE '2026-09-26' AS updated_at,
    CASE WHEN n = 602 THEN 'draft' ELSE 'reviewed' END AS status,
    CASE WHEN n = 603 THEN ARRAY['knowledge:read', 'crm:read'] ELSE ARRAY['knowledge:read'] END AS scopes
  FROM generate_series(1, 603) n
)`;

describe.skipIf(process.env.CONTEXT_LIVE_KNOWLEDGE_QUERY_TEST !== '1')('synthetic knowledge SQL on the transaction pooler', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let adapter: PoolClient;
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    pool = new pg.Pool({ ...databaseOptions({ ...env, NODE_ENV: 'test' }), max: 1, connectionTimeoutMillis: 3000,
      application_name: 'wareongo-context-synthetic-knowledge-check' });
    client = await pool.connect();
    adapter = { query: (sql: string, values: unknown[]) => {
      const replaced = sql.trim().replaceAll(source, 'fixture_pages');
      if (!sql.includes(source) || !replaced.startsWith('WITH ') || /\b(?:public|context_engine_private)\s*\./i.test(replaced)) {
        throw new Error('Fixture adapter refuses source reads');
      }
      return client.query(`WITH ${fixture}, ${replaced.slice(5)}`, values);
    } } as unknown as PoolClient;
  }, 10000);
  beforeEach(async () => {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
  });
  afterEach(async () => { if (client) await client.query('ROLLBACK'); });
  afterAll(async () => { client?.release(); await pool?.end(); });

  it('paginates a collection larger than 500 without skipping or repeating IDs', async () => {
    const first = await listKnowledge(adapter, ['knowledge:read'], 2);
    expect(first.items.map(page => page.id)).toEqual(['guide-0001', 'guide-0002']);
    const next = await listKnowledge(adapter, ['knowledge:read'], 3, first.nextCursor!);
    expect(next.items.map(page => page.id)).toEqual(['guide-0003', 'guide-0004', 'guide-0005']);
    expect(next.nextCursor).toBeTypeOf('string');
  });
  it('searches documents beyond the previous 500-page cutoff', async () => {
    const result = await searchKnowledge(adapter, 'special', ['knowledge:read']);
    expect(result.items.map(page => page.id)).toEqual(['guide-0601']);
    expect(result.nextCursor).toBeNull();
    expect(result.items[0]).toHaveProperty('snippet');
  });
  it('maintains ranking across pages and excludes drafts and insufficient scopes', async () => {
    const first = await searchKnowledge(adapter, 'warehouse', ['knowledge:read'], 1);
    const next = await searchKnowledge(adapter, 'warehouse', ['knowledge:read'], 2, first.nextCursor!);
    expect([...first.items, ...next.items].map(page => page.id)).toEqual(['guide-0001', 'guide-0002', 'guide-0003']);
    expect((await searchKnowledge(adapter, '602', ['knowledge:read'])).items).toEqual([]);
    expect((await searchKnowledge(adapter, '603', ['knowledge:read'])).items).toEqual([]);
    expect((await searchKnowledge(adapter, '603', ['knowledge:read', 'crm:read'])).items.map(page => page.id)).toEqual(['guide-0603']);
  });
});
