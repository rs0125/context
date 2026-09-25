import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { CRM_DATE_FIELDS, CRM_SORTS, getCrmFilterOptions, searchOpportunities, summarizeOpportunities } from '../src/lib/data';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const principal: Principal = { employeeId: 900001, email: 'synthetic@example.test', keyId: 'synthetic-query-fixture', scopes: ['crm:read'], twentyUserId: id(900001) };
const related: CrmAccess = { mode: 'related', memberId: principal.twentyUserId!, ids: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12].map(id) };
const all: CrmAccess = { mode: 'all', memberId: principal.twentyUserId! };
const columns = {
  opportunity_id: 'text', name: 'text', company_name: 'text', city: 'text', stage: 'text', priority: 'text',
  deleted_at: 'timestamptz', twenty_created_at: 'timestamptz', twenty_updated_at: 'timestamptz',
  last_contacted: 'timestamptz', next_follow_up: 'timestamptz', last_meaningful_update_at: 'timestamptz',
  last_meaningful_update_kind: 'text', stage_entered_at: 'timestamptz', last_polled_at: 'timestamptz', data: 'jsonb',
} as const;
function record(number: number, created: string | null, changes: Record<string, unknown> = {}) {
  return { opportunity_id: id(number), name: `Synthetic lead ${number}`, company_name: null, city: 'Bengaluru', stage: 'NEW_LEAD', priority: 'RATING_3',
    deleted_at: null, twenty_created_at: created, twenty_updated_at: created, last_contacted: created, next_follow_up: created,
    last_meaningful_update_at: created, last_meaningful_update_kind: 'opportunity', stage_entered_at: created,
    last_polled_at: '2026-09-25T12:00:00Z', data: { requirementInSft: '40000', microMarket: 'North' }, ...changes };
}
const fixtureRows = [
  record(1, '2026-08-31T18:29:59.999999Z', { name: "Acme's Logistics north", company_name: "Acme's Logistics", city: 'Bangalore', priority: 'RATING_5' }),
  record(2, '2026-08-31T18:30:00.000000Z', { name: "Acme's Logistics south", company_name: "Acme's Logistics", stage: 'SITE_VISIT', priority: 'RATING_4' }),
  record(3, '2026-09-25T12:00:00.123100Z', { name: 'Private 9876543210', city: 'Mumbai, 9876543210' }),
  record(4, '2026-09-25T12:00:00.123900Z', { name: 'Private 98 76 54 32 10', city: 'Delhi, contact us', stage: 'FOLLOW_UP' }),
  record(5, '2026-09-30T18:29:59.999999Z', { company_name: '9876543210', city: null, stage: 'DEAL_CLOSED' }),
  record(6, '2026-09-30T18:30:00.000000Z', { name: 'nine eight seven six five four three two one zero', city: 'Pune, nine eight seven six five four three two one zero', stage: 'DEAL_ON_HOLD' }),
  record(7, null, { city: 'Delhi, Mumbai', stage: 'DEAL_CLOSED', priority: null }),
  record(8, '2026-09-20T00:00:00Z', { name: 'Unrelated hidden lead', city: 'Mumbai', stage: 'DEAL_LOST', priority: 'RATING_9' }),
  record(9, '2026-09-20T01:00:00Z', { name: 'Deleted hidden lead', city: 'Delhi', deleted_at: '2026-09-24T00:00:00Z', stage: 'DEAL_LOST' }),
  record(10, '2026-09-20T02:00:00Z', { name: 'Private ९८७६५४३२१०', company_name: 'private@example.test' }),
  record(11, '2026-09-20T03:00:00Z', { name: 'Private 987—654—3210', city: 'one two three four five six seven', stage: 'FOLLOW_UP' }),
  record(12, '2026-09-20T04:00:00Z', { name: 'Private 987\u200B6543210', city: 'Chennai, www.example.test', stage: 'NEGOTIATION' }),
];
function literal(value: unknown, type: string) {
  if (value == null) return `NULL::${type}`;
  const text = type === 'jsonb' ? JSON.stringify(value) : String(value);
  return `'${text.replaceAll("'", "''")}'::${type}`;
}
const fixtureCte = `fixture_opportunities (${Object.keys(columns).join(', ')}) AS (VALUES ${fixtureRows.map(row =>
  `(${Object.entries(columns).map(([name, type]) => literal((row as Record<string, unknown>)[name], type)).join(', ')})`).join(', ')})`;

// Opt-in executes the real query builders against a VALUES relation only.
// There are no fixture tables, production reads, source identifiers or writes.
// The single socket uses the existing verified transaction-pool TLS settings.
describe.skipIf(process.env.CONTEXT_LIVE_CRM_QUERY_TEST !== '1')('synthetic CRM SQL on the transaction pooler', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let fixtureClient: PoolClient;
  let queryCount = 0;
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    if (!env.DATABASE_URL) throw new Error('Database configuration missing');
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('Transaction pooler required');
    url.search = '';
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000,
      query_timeout: 6000, idleTimeoutMillis: 1000, ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
      application_name: 'wareongo-context-synthetic-crm-query-verification' });
    client = await pool.connect();
    fixtureClient = { query: async (sql: string, values?: unknown[]) => {
      if (!/^(?:SELECT|WITH)\b/.test(sql) || !sql.includes('public.opportunities')) throw new Error('Fixture adapter refuses unexpected query');
      const replaced = sql.replaceAll('public.opportunities', 'fixture_opportunities');
      if (/\bpublic\s*\./i.test(replaced)) throw new Error('Fixture query must not read any source table');
      const statement = replaced.startsWith('WITH ') ? `WITH ${fixtureCte}, ${replaced.slice(5)}` : `WITH ${fixtureCte} ${replaced}`;
      queryCount++;
      return client.query(statement, values);
    } } as unknown as PoolClient;
  }, 10000);
  beforeEach(async () => {
    queryCount = 0;
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
  });
  afterEach(async () => { vi.useRealTimers(); if (client) await client.query('ROLLBACK'); });
  afterAll(async () => { client?.release(); await pool?.end(); });

  it.each(['stage', 'city', 'priority'])('counts the complete scoped set by %s with exact parameter bindings', async group => {
    for (const [access, expected] of [[related, 10], [all, 11]] as const) {
      const response = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams({ group_by: group, group_limit: '1' }), access);
      expect(response.total).toBe(expected);
      expect(response.groups).toHaveLength(1);
      expect(response.groups[0].count + response.other_count).toBe(expected);
      expect(response.groups_truncated).toBe(true);
      const full = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams({ group_by: group, group_limit: '25' }), access);
      expect(full.total).toBe(expected);
      expect(full.groups.reduce((sum, item) => sum + item.count, 0)).toBe(expected);
      expect(full.other_count).toBe(0);
      expect(full.groups_truncated).toBe(false);
    }
  }, 20000);

  it('merges unsafe city labels into one complete null bucket before truncation', async () => {
    const response = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams('group_by=city&group_limit=1'), related);
    expect(response).toMatchObject({ total: 10, groups: [{ value: null, count: 6 }], other_count: 4, groups_truncated: true });
    const full = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams('group_by=city&group_limit=25'), related);
    expect(full.groups).toEqual([{ value: null, count: 6 }, { value: 'Bengaluru', count: 3 }, { value: 'delhi, mumbai', count: 1 }]);
    const options = await getCrmFilterOptions(fixtureClient, principal, new URLSearchParams(), related);
    expect(options.cities.toSorted()).toEqual(['Bengaluru', 'delhi', 'mumbai']);
    expect(JSON.stringify([full, options])).not.toMatch(/call me|contact us|example\.test|nine eight|one two/);
  }, 20000);

  it('never matches or discovers components of a wholly withheld city label', async () => {
    for (const city of ['Mumbai', 'Delhi']) {
      const response = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ city }), related);
      expect(response.items.map(item => item.id)).toEqual([id(7)]);
    }
    for (const city of ['Pune', 'Chennai', '987654']) {
      const response = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ city }), related);
      expect(response.items, city).toEqual([]);
    }
    const options = await getCrmFilterOptions(fixtureClient, principal, new URLSearchParams(), related);
    expect(options.cities.toSorted()).toEqual(['Bengaluru', 'delhi', 'mumbai']);
    await expect(searchOpportunities(fixtureClient, principal, new URLSearchParams({ city: '9876543210' }), related)).rejects.toMatchObject({ status: 400 });
  }, 20000);

  it('does not reveal withheld labels through short fragments while normal partial company search works', async () => {
    for (const q of ['987654', '654321', 'Private', 'eight seven', 'example']) {
      const response = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ q }), related);
      expect(response.items, q).toEqual([]);
      const count = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams({ q }), related);
      expect(count.total, q).toBe(0);
    }
    const named = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ q: "ACME'S log" }), related);
    expect(named.items.map(item => item.id)).toEqual([id(1), id(2)]);
    const city = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ city: 'Mumbai' }), related);
    expect(city.items.map(item => item.id)).toEqual([id(7)]);
  }, 30000);

  it.each(CRM_DATE_FIELDS)('uses native %s instants with inclusive India dates, excluding missing and denied rows', async field => {
    const query = { date_field: field, date_from: '2026-09-01', date_to: '2026-09-30' };
    const response = await searchOpportunities(fixtureClient, principal, new URLSearchParams({ ...query, limit: '25' }), related);
    expect(response.items.map(item => item.id)).toEqual([2, 3, 4, 5, 10, 11, 12].map(id));
    const summary = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams(query), related);
    expect(summary.total).toBe(7);
    expect(summary.query_context).toMatchObject({ start_at: '2026-08-31T18:30:00.000Z', end_before: '2026-09-30T18:30:00.000Z' });
  }, 20000);

  it.each(CRM_SORTS)('pages %s through timestamp ties and nulls exactly once without granting unrelated rows', async sort => {
    const query = new URLSearchParams({ sort, limit: '2' });
    const seen: string[] = [];
    for (let page = 0; page < 7; page++) {
      const response = await searchOpportunities(fixtureClient, principal, query, related);
      seen.push(...response.items.map(item => item.id));
      if (!response.nextCursor) break;
      query.set('cursor', response.nextCursor);
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).not.toContain(id(8)); expect(seen).not.toContain(id(9));
    if (sort !== 'id_asc') {
      expect(seen.at(-1)).toBe(id(7));
      expect(seen.indexOf(id(3)) + 1).toBe(seen.indexOf(id(4)));
    }
  }, 30000);

  it('uses explicit follow-up windows and refuses date cursors after the India day changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-25T18:29:59Z'));
    const query = new URLSearchParams('follow_up_status=today&sort=created_desc&limit=1');
    const response = await searchOpportunities(fixtureClient, principal, query, related);
    expect(response.items.map(item => item.id)).toEqual([id(3)]);
    expect(response.nextCursor).not.toBeNull();
    expect(response.query_context.follow_up).toMatchObject({ start_at: '2026-09-24T18:30:00.000Z', end_before: '2026-09-25T18:30:00.000Z' });
    query.set('cursor', response.nextCursor!);
    vi.setSystemTime(new Date('2026-09-25T18:30:00Z'));
    await expect(searchOpportunities(fixtureClient, principal, query, related)).rejects.toMatchObject({ status: 400 });
    expect(queryCount).toBe(1);
  }, 20000);

  it('fails closed for an empty scope or a different live member identity', async () => {
    const denied: CrmAccess = { ...related, ids: [] };
    const response = await summarizeOpportunities(fixtureClient, principal, new URLSearchParams(), denied);
    expect(response).toMatchObject({ total: 0, groups: [], other_count: 0 });
    await expect(searchOpportunities(fixtureClient, principal, new URLSearchParams(), { ...related, memberId: id(99999) }))
      .rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
    expect(queryCount).toBe(1);
  }, 20000);
});
