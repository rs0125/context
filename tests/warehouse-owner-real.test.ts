import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { sanitizeLabel } from '../src/lib/privacy';
import { normalizeOwnerName, resolveOwnerNames } from '../src/lib/warehouse-owner';
import { searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';

// Explicit live-data opt-in. One verified TLS connection, read-only snapshots,
// no model calls or messages. Only the two allowlisted names, city and IDs are
// used as the oracle. Reports contain aggregate counts/timings, never names.
describe.skipIf(process.env.CONTEXT_LIVE_WAREHOUSE_OWNER_REAL_TEST !== '1')('real inventory owner search', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  const report: Record<string, unknown> = { cases: [] };
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    const connection = env.CONTEXT_DATABASE_URL ?? env.DATABASE_URL;
    if (!connection) throw new Error('Database configuration missing');
    const url = new URL(connection);
    if (!url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('Transaction pooler required');
    url.search = '';
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 4000,
      query_timeout: 6000, idleTimeoutMillis: 1000,
      ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
      application_name: 'wareongo-context-owner-real-data-verification' });
    client = await pool.connect();
    report.runtime_credentials = Boolean(env.CONTEXT_DATABASE_URL);
  }, 10000);
  afterAll(async () => {
    if (client) await client.query('ROLLBACK').catch(() => {});
    client?.release(); await pool?.end();
  });

  it('checks names, complete counts, pagination, company matches and typo fallbacks on a real snapshot', async () => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const source = await client.query<{ id: number; owner_name: string | null; owner_company_name: string | null }>(`SELECT id,
      CASE WHEN length("contactPerson") <= 100 THEN "contactPerson" END AS owner_name,
      CASE WHEN length("ownerCompanyName") <= 100 THEN "ownerCompanyName" END AS owner_company_name
      FROM public."Warehouse" WHERE visibility IS TRUE ORDER BY id LIMIT 20001`);
    expect(source.rows.length).toBeGreaterThan(0);
    expect(source.rows.length).toBeLessThanOrEqual(20000);
    const rows = source.rows.map(row => ({ id: row.id, names: [sanitizeLabel(row.owner_name), sanitizeLabel(row.owner_company_name)]
      .filter((name): name is string => name !== null) }));
    const names = [...new Set(rows.flatMap(row => row.names))];
    const usable = (name: unknown): name is string => typeof name === 'string' && name.length <= 80 && /^[A-Za-z .,'’()&/_–—-]{5,80}$/.test(name);
    const people = [...new Set(source.rows.map(row => sanitizeLabel(row.owner_name)).filter(usable))];
    const companies = [...new Set(source.rows.map(row => sanitizeLabel(row.owner_company_name)).filter(usable))];
    const pick = (list: string[], count: number) => list.filter((_, index) => index % Math.max(1, Math.floor(list.length / count)) === 0).slice(0, count);
    const cases: { name: string; mode: 'exact' | 'contains' | 'auto' | 'fuzzy'; expected?: number[]; target?: number; label: string }[] = [];
    for (const name of [...pick(people, 3), ...pick(companies, 2)]) {
      cases.push({ name, mode: 'exact', label: 'complete_name', expected: rows.filter(row => row.names.some(value =>
        value.trim().toLowerCase() === name.trim().toLowerCase())).map(row => row.id) });
    }
    for (const name of pick(people.filter(name => normalizeOwnerName(name).length >= 8), 3)) {
      const term = normalizeOwnerName(name).slice(0, 5).trim();
      cases.push({ name: term, mode: 'contains', label: 'partial_name', expected: rows.filter(row => row.names.some(value =>
        normalizeOwnerName(value).includes(term))).map(row => row.id) });
    }
    // Query spellings that really exist: auto must not widen these to similarly
    // named people. Include both long and short names from the actual inventory.
    for (const name of pick(people, 3)) {
      const resolved = resolveOwnerNames(name, 'auto', names);
      expect(resolved.strategy).toBe('literal_first');
      expect(resolved.approximate_name_count).toBe(0);
      cases.push({ name, mode: 'auto', label: 'existing_spelling', expected: rows.filter(row => row.names.some(value => resolved.matches.has(value))).map(row => row.id) });
    }
    // Known target by construction. Skip mutations that are already literal
    // names, because those are ambiguous user intentions, not misspellings.
    for (const name of pick(people.filter(name => /^[A-Za-z]{6,20}$/.test(name)), 8)) {
      const index = Math.floor(name.length / 2);
      const typo = name.slice(0, index) + name.slice(index + 1);
      const resolved = resolveOwnerNames(typo, 'auto', names);
      if (resolved.strategy !== 'fuzzy_fallback') continue;
      cases.push({ name: typo, mode: 'auto', label: 'generated_typo', target: rows.find(row => row.names.includes(name))!.id });
      if (cases.filter(test => test.label === 'generated_typo').length === 3) break;
    }
    expect(cases.filter(test => test.label === 'generated_typo').length).toBe(3);
    const observations: Record<string, unknown>[] = [];
    for (const test of cases) {
      const query = new URLSearchParams({ owner_name: test.name, owner_match_mode: test.mode });
      const summaryStarted = performance.now();
      const summary = await summarizeWarehouses(client, query);
      const summaryMs = Math.round(performance.now() - summaryStarted);
      const namePolicy = summary.matching_policy.owner_name!;
      for (const candidate of namePolicy.candidate_names) {
        expect(candidate.warehouse_count).toBe(rows.filter(row => row.names.some(name => name.toLowerCase() === candidate.name.toLowerCase())).length);
      }
      expect(namePolicy.disambiguation_recommended).toBe(namePolicy.approximate_name_count > 0 && namePolicy.matched_name_count > 1);
      query.set('limit', '2');
      const ids: number[] = [];
      const pageTimes: number[] = [];
      let cursor: string | null = null;
      do {
        if (cursor) query.set('cursor', cursor);
        const started = performance.now();
        const page = await searchWarehouses(client, query);
        pageTimes.push(Math.round(performance.now() - started));
        expect(page.matching_policy.owner_name).toEqual(summary.matching_policy.owner_name);
        for (const item of page.items) {
          const original = rows.find(row => row.id === item.id)!;
          expect(original).toBeDefined();
          expect(item.owner_name === null || original.names.includes(item.owner_name)).toBe(true);
          expect(item.owner_company_name === null || original.names.includes(item.owner_company_name)).toBe(true);
          ids.push(item.id);
        }
        cursor = page.nextCursor;
        if (ids.length > 200) throw new Error('Real test result bound exceeded');
      } while (cursor);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(summary.total);
      expect(summary.groups.reduce((sum, group) => sum + group.count, 0) + summary.other_count).toBe(summary.total);
      if (test.expected) expect(ids).toEqual(test.expected);
      if (test.target) expect(ids).toContain(test.target);
      observations.push({ kind: test.label, mode: test.mode, matches: ids.length, strategy: summary.matching_policy.owner_name?.strategy,
        matched_names: namePolicy.matched_name_count, disambiguation_recommended: namePolicy.disambiguation_recommended,
        summary_ms: summaryMs, page_ms: pageTimes, pages: pageTimes.length });
    }
    await client.query('COMMIT');
    Object.assign(report, { as_of: new Date().toISOString(), visible_warehouses: rows.length, distinct_names: names.length, cases: observations });
    await mkdir('.local/owner-search-verification', { recursive: true, mode: 0o700 });
    await writeFile('.local/owner-search-verification/real-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    console.info(JSON.stringify(report));
  }, 120000);
});
