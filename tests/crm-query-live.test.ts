import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg, { type PoolClient } from 'pg';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { CRM_DATE_FIELDS, CRM_SORTS, getCrmFilterOptions, getMyBriefing, getOpportunity, searchOpportunities, summarizeOpportunities } from '../src/lib/data';
import { CRM_ENUM_ARRAY_LIMIT } from '../src/lib/crm-fields';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const principal: Principal = { employeeId: 900001, email: 'synthetic@example.test', keyId: 'synthetic-query-fixture', scopes: ['crm:read'], twentyUserId: id(900001) };
const related: CrmAccess = { mode: 'related', memberId: principal.twentyUserId!, ids: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12].map(id) };
const all: CrmAccess = { mode: 'all', memberId: principal.twentyUserId! };
const columns = {
  opportunity_id: 'text', name: 'text', company_name: 'text', city: 'text', stage: 'text', priority: 'text',
  deleted_at: 'timestamptz', twenty_created_at: 'timestamptz', twenty_updated_at: 'timestamptz',
  last_contacted: 'timestamptz', next_follow_up: 'timestamptz', last_meaningful_update_at: 'timestamptz',
  last_note_at: 'timestamptz', last_task_at: 'timestamptz',
  last_meaningful_update_kind: 'text', stage_entered_at: 'timestamptz', last_polled_at: 'timestamptz', data: 'jsonb',
} as const;
function record(number: number, created: string | null, changes: Record<string, unknown> = {}) {
  return { opportunity_id: id(number), name: `Synthetic lead ${number}`, company_name: null, city: 'Bengaluru', stage: 'NEW_LEAD', priority: 'RATING_3',
    deleted_at: null, twenty_created_at: created, twenty_updated_at: created, last_contacted: created, next_follow_up: created,
    last_meaningful_update_at: created, last_meaningful_update_kind: 'opportunity', stage_entered_at: created, last_note_at: created, last_task_at: created,
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
function fixtureCte(rows: ReturnType<typeof record>[]) {
  return `fixture_opportunities (${Object.keys(columns).join(', ')}) AS (VALUES ${rows.map(row =>
    `(${Object.entries(columns).map(([name, type]) => literal((row as Record<string, unknown>)[name], type)).join(', ')})`).join(', ')})`;
}

// Opt-in executes the real query builders against a VALUES relation only.
// There are no fixture tables, production reads, source identifiers or writes.
// The single socket uses the existing verified transaction-pool TLS settings.
describe.skipIf(process.env.CONTEXT_LIVE_CRM_QUERY_TEST !== '1')('synthetic CRM SQL on the transaction pooler', () => {
  let pool: pg.Pool;
  let client: PoolClient;
  let fixtureClient: PoolClient;
  let queryCount = 0;
  function fixtureFor(rows: ReturnType<typeof record>[]) {
    const cte = fixtureCte(rows);
    return { query: async (sql: string, values?: unknown[]) => {
      if (!/^(?:SELECT|WITH)\b/.test(sql) || !sql.includes('public.opportunities')) throw new Error('Fixture adapter refuses unexpected query');
      const replaced = sql.replaceAll('public.opportunities', 'fixture_opportunities');
      if (/\bpublic\s*\./i.test(replaced)) throw new Error('Fixture query must not read any source table');
      const statement = replaced.startsWith('WITH ') ? `WITH ${cte}, ${replaced.slice(5)}` : `WITH ${cte} ${replaced}`;
      queryCount++;
      return client.query(statement, values);
    } } as unknown as PoolClient;
  }
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
    fixtureClient = fixtureFor(fixtureRows);
  }, 10000);
  beforeEach(async () => {
    queryCount = 0;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

  it('keeps malformed values distinct while matching exact and ranged positive areas consistently', async () => {
    const cases: [unknown, number | null][] = [
      ['40000', 40000], ['40,000', 40000], ['40000.0', 40000], [40000, 40000],
      [null, null], ['0', null], ['40000-50000', null], ['40,00', null], ['40000.5', null],
      ['1e4', null], ['-40', null], ['1000000001', null], [`${'0'.repeat(33)}40000`, 40000],
      [' 60000 ', 60000], ['1000000000', 1000000000], [undefined, null],
      [{ minimum: 40000 }, null], [[40000], null], ['1,000,000,000', 1000000000],
      ['40000.00000000000000000000001', null],
    ];
    const rows = cases.map(([area], index) => record(201 + index, '2026-09-20T00:00:00Z', { data: { requirementInSft: area } }));
    rows.push(record(221, '2026-09-20T00:00:00Z', { data: { requirementInSft: '40000' } }));
    rows.push(record(222, '2026-09-20T00:00:00Z', { deleted_at: '2026-09-24T00:00:00Z', data: { requirementInSft: '40000' } }));
    const fixture = fixtureFor(rows);
    const scope: CrmAccess = { ...related, ids: [...cases.map((_, index) => id(201 + index)), id(222)] };
    const unfiltered = await searchOpportunities(fixture, principal, new URLSearchParams('limit=25'), scope);
    expect(unfiltered.items.map(item => [item.id, item.requirement_sqft])).toEqual(cases.map(([, expected], index) => [id(201 + index), expected]));
    const filters = new URLSearchParams('requirement_sqft_min=40000&requirement_sqft_max=60000');
    const search = await searchOpportunities(fixture, principal, filters, scope);
    expect(search.items.map(item => item.id)).toEqual([201, 202, 203, 204, 207, 213, 214].map(id));
    expect(search.items.find(item => item.id === id(207))).toMatchObject({ requirement_sqft: null, verification_required: true,
      field_evidence: { requirement_sqft: { kind: 'range', state: 'parsed', min: 40000, max: 50000 } } });
    expect((await summarizeOpportunities(fixture, principal, filters, scope)).total).toBe(search.items.length);
    const ceiling = await searchOpportunities(fixture, principal, new URLSearchParams('requirement_sqft_min=1000000000'), scope);
    expect(ceiling.items.map(item => item.id)).toEqual([215, 219].map(id));
    const admin = await searchOpportunities(fixture, principal, filters, all);
    expect(admin.items.map(item => item.id)).toEqual([201, 202, 203, 204, 207, 213, 214, 221].map(id));
  }, 20000);

  it('matches unit shorthand, Indian grouping and approximate/ranged areas without promoting candidates to exact specifications', async () => {
    const cases = [
      ['40-50k sqft', 'range', null, 40000, 50000], ['~45k sft', 'approximate', 45000, null, null],
      ['1,00,000', 'exact', 100000, null, null], ['1.5 lakh sq ft', 'exact', 150000, null, null],
      ['0.04 million', 'exact', 40000, null, null], ['approx. 30-60 k', 'range', null, 30000, 60000],
      ['50000 to 40000', 'unknown', null, null, null], ['40k-50', 'unknown', null, null, null],
      ['40k-0.05m', 'range', null, 40000, 50000], ['0.00001 crore', 'exact', 100, null, null],
      ['\t40000', 'unknown', null, null, null], ['40000 phone9876543210', 'unknown', null, null, null],
    ] as const;
    const fixture = fixtureFor(cases.map(([area], index) => record(301 + index, '2026-09-20T00:00:00Z', { data: { requirementInSft: area } })));
    const scope: CrmAccess = { ...related, ids: cases.map((_, index) => id(301 + index)) };
    const allRows = await searchOpportunities(fixture, principal, new URLSearchParams('limit=25'), scope);
    for (const [index, [, kind, value, min, max]] of cases.entries()) {
      expect(allRows.items[index]).toMatchObject({ id: id(301 + index), requirement_sqft: kind === 'exact' ? value : null,
        field_evidence: { requirement_sqft: { kind, value, min, max, verification_required: true } } });
      if (kind === 'range' || kind === 'approximate') expect(allRows.items[index].verification_required).toBe(true);
    }
    const filters = new URLSearchParams('requirement_sqft_min=45000&requirement_sqft_max=46000');
    const overlapping = await searchOpportunities(fixture, principal, filters, scope);
    expect(overlapping.items.map(item => item.id)).toEqual([301, 302, 306, 309].map(id));
    expect(overlapping.items.every(item => item.requirement_sqft === null && item.verification_required)).toBe(true);
    expect((await summarizeOpportunities(fixture, principal, filters, scope)).total).toBe(4);
    const larger = await searchOpportunities(fixture, principal, new URLSearchParams('requirement_sqft_min=100000'), scope);
    expect(larger.items.map(item => item.id)).toEqual([303, 304].map(id));
    expect(JSON.stringify(allRows)).not.toContain('9876543210');
  }, 20000);

  const structuredRows = [
    record(101, '2026-09-20T00:00:00Z', { last_note_at: '2026-09-20T01:00:00Z', last_task_at: '2026-09-20T02:00:00Z', data: {
      requirementInSft: '40,000', microMarket: 'North', leadSource: 'OUTREACH', duration: 'LONG_TERM',
      industryVertical: ['FMCG', 'MANUFACTURING'], repeatClient: ['OPTION1'], occupancyTimeline: ['WITHIN_30_DAYS'], preferredLanguage: ['ENGLISH'],
      budget: 'INR 20-25 per sqft per month', amount: { amountMicros: '123456789', currencyCode: 'INR' }, followupcount: '2',
      pocPhone: '9876543210', notes: 'private@example.test',
    } }),
    record(102, '2026-09-20T00:00:00Z', { data: { microMarket: 'North, South', leadSource: 'BROKER', duration: 'SHORT_TERM', industryVertical: ['FMCG'], repeatClient: ['NO'] } }),
    record(103, '2026-09-20T00:00:00Z', { data: { microMarket: 'North, 9876543210', leadSource: 'private@example.test', duration: 'whatsapp', industryVertical: ['FMCG', 'private@example.test'], repeatClient: ['OPTION1', 'NO'] } }),
    record(104, '2026-09-20T00:00:00Z', { data: { industryVertical: 'FMCG', repeatClient: 'NO' } }),
    record(105, '2026-09-20T00:00:00Z', { data: { industryVertical: [], repeatClient: [] } }),
    record(106, '2026-09-20T00:00:00Z', { data: { industryVertical: ['FMCG', 12], repeatClient: ['NO', null] } }),
    record(107, '2026-09-20T00:00:00Z', { data: { industryVertical: Array(CRM_ENUM_ARRAY_LIMIT + 1).fill('FMCG'), repeatClient: Array(CRM_ENUM_ARRAY_LIMIT + 1).fill('NO') } }),
    record(108, '2026-09-20T00:00:00Z', { data: { microMarket: 'North, South', leadSource: 'BROKER', duration: 'SHORT_TERM', industryVertical: ['FMCG', 'FMCG'], repeatClient: ['NO', 'NO'] } }),
    record(109, '2026-09-20T00:00:00Z', { data: { microMarket: 'South', leadSource: 'OUTREACH', duration: 'LONG_TERM', industryVertical: ['MANUFACTURING'], repeatClient: ['OPTION1'] } }),
    record(110, '2026-09-20T00:00:00Z', { data: { leadSource: 'OUTREACH', duration: 'LONG_TERM', industryVertical: ['FMCG'], repeatClient: ['OPTION1'] } }),
    record(111, '2026-09-20T00:00:00Z', { deleted_at: '2026-09-24T00:00:00Z', data: { leadSource: 'OUTREACH', duration: 'LONG_TERM', industryVertical: ['FMCG'], repeatClient: ['OPTION1'] } }),
  ];
  const structuredScope: CrmAccess = { ...related, ids: [101, 102, 103, 104, 105, 106, 107, 108, 109, 111].map(id) };

  it('projects rich details and source timestamps from the same row on search and direct reads', async () => {
    const fixture = fixtureFor(structuredRows);
    const direct = await getOpportunity(fixture, principal, id(101), structuredScope);
    const search = await searchOpportunities(fixture, principal, new URLSearchParams('lead_source=OUTREACH&lease_duration=LONG_TERM&industry=FMCG&repeat_client=true'), structuredScope);
    expect(search.items).toHaveLength(1);
    expect(direct).toMatchObject(search.items[0]);
    expect(search.items[0]).not.toHaveProperty('description');
    const briefing = await getMyBriefing(fixture, principal, structuredScope);
    expect(briefing.priorities.find(item => item.id === id(101))).toMatchObject(search.items[0]);
    expect(direct).toMatchObject({ id: id(101), stage: 'NEW_LEAD', requirement_sqft: 40000, lead_source: 'OUTREACH', lease_duration: 'LONG_TERM',
      industry_verticals: ['FMCG', 'MANUFACTURING'], repeat_client: true, occupancy_timelines: ['WITHIN_30_DAYS'], preferred_languages: ['ENGLISH'],
      recorded_follow_up_count: 2, source_updated_at: '2026-09-20T00:00:00.000Z',
      last_note_at: '2026-09-20T01:00:00.000Z', last_task_at: '2026-09-20T02:00:00.000Z',
      budget: { kind: 'range', min: 20, max: 25, currency: 'INR', period: 'month', area_basis: 'sqft', verification_required: true },
      recorded_value: { amount_micros: '123456789', amount: '123.456789', currency_code: 'INR', verification_required: true },
    });
    expect(JSON.stringify(search)).not.toMatch(/9876543210|private@example|pocPhone|notes/);
    expect(await getOpportunity(fixture, principal, id(110), structuredScope)).toBeNull();
    expect(await getOpportunity(fixture, principal, id(111), all)).toBeNull();
  }, 20000);

  it.each([
    ['industry=FMCG', [101, 102, 108]], ['repeat_client=true', [101, 109]], ['repeat_client=false', [102, 108]],
    ['micro_market=north', [101]], ['micro_market=NORTH,%20SOUTH', [102, 108]], ['micro_market=South', [109]],
    ['lead_source=OUTREACH&lease_duration=LONG_TERM', [101, 109]],
  ] as const)('keeps %s searches and totals aligned without matching malformed or withheld components', async (filters, expectedIds) => {
    const fixture = fixtureFor(structuredRows);
    const query = new URLSearchParams(filters);
    const search = await searchOpportunities(fixture, principal, query, structuredScope);
    const summary = await summarizeOpportunities(fixture, principal, query, structuredScope);
    expect(search.items.map(item => item.id)).toEqual(expectedIds.map(id));
    expect(summary.total).toBe(expectedIds.length);
    expect(JSON.stringify([search, summary])).not.toMatch(/9876543210|private@example/);
  }, 20000);

  it.each([
    ['lead_source', [{ value: null, count: 5 }, { value: 'BROKER', count: 2 }, { value: 'OUTREACH', count: 2 }]],
    ['lease_duration', [{ value: null, count: 5 }, { value: 'LONG_TERM', count: 2 }, { value: 'SHORT_TERM', count: 2 }]],
  ] as const)('groups only supported %s values and counts withheld values in the null bucket', async (group, expected) => {
    const fixture = fixtureFor(structuredRows);
    const result = await summarizeOpportunities(fixture, principal, new URLSearchParams({ group_by: group }), structuredScope);
    expect(result).toMatchObject({ total: 9, groups: expected, other_count: 0, groups_truncated: false });
    const truncated = await summarizeOpportunities(fixture, principal, new URLSearchParams({ group_by: group, group_limit: '1' }), structuredScope);
    expect(truncated).toMatchObject({ total: 9, groups: [{ value: null, count: 5 }], other_count: 4, groups_truncated: true });
  }, 20000);

  it('withholds malformed classifications in returned records and preserves verified scope for richer filters', async () => {
    const fixture = fixtureFor(structuredRows);
    const unfiltered = await searchOpportunities(fixture, principal, new URLSearchParams(), structuredScope);
    for (const number of [103, 104, 105, 106, 107]) {
      expect(unfiltered.items.find(item => item.id === id(number))).toMatchObject({ lead_source: null, lease_duration: null, industry_verticals: null, repeat_client: null });
    }
    expect(unfiltered.items.find(item => item.id === id(103))?.micro_market).toBeNull();
    expect(unfiltered.items.find(item => item.id === id(108))).toMatchObject({ industry_verticals: ['FMCG'], repeat_client: false });
    const admin = await searchOpportunities(fixture, principal, new URLSearchParams('industry=FMCG'), all);
    expect(admin.items.map(item => item.id)).toEqual([101, 102, 108, 110].map(id));
    const denied = await summarizeOpportunities(fixture, principal, new URLSearchParams('industry=FMCG'), { ...structuredScope, ids: [] });
    expect(denied).toMatchObject({ total: 0, groups: [], other_count: 0 });
  }, 20000);
});
