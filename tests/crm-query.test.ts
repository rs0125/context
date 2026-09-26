import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOpportunities, summarizeOpportunities, getCrmFilterOptions, validateCrmQuery, getOpportunity } from '../src/lib/data';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { CRM_INDUSTRIES, CRM_LEAD_SOURCES, CRM_LEASE_DURATIONS } from '../src/lib/crm-fields';

const id = '00000000-0000-4000-8000-000000000001';
const id2 = '00000000-0000-4000-8000-000000000002';
const principal: Principal = { employeeId: 1, email: 'example@example.test', keyId: 'fake', scopes: ['crm:read'], twentyUserId: id };
const access: CrmAccess = { mode: 'related', memberId: id, ids: [id, id2] };
const database = (rows: unknown[] = []) => {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

describe('CRM task queries', () => {
  it('uses native creation time and keeps creator relationship separate from dates', async () => {
    const db = database([{ opportunity_id: id, twenty_created_at: new Date('2026-09-04T00:00:00Z'), created_at: new Date('2026-08-04T00:00:00Z') }]);
    const query = new URLSearchParams('view=created&period=this_month&sort=created_desc');
    expect(validateCrmQuery(query).view).toBe('created');
    const result = await searchOpportunities(db.client, principal, query, access);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('o.twenty_created_at >= $2::timestamptz');
    expect(sql).toContain('o.twenty_created_at < $3::timestamptz');
    expect(sql).not.toMatch(/o\.created_at|first_seen_at|o\.data\b[^-]/);
    expect(values).toEqual([[id, id2], '2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z', 11]);
    expect(result.items[0].source_created_at).toBe('2026-09-04T00:00:00.000Z');
    expect(result.query_context).toMatchObject({ date_field: 'created', returned_count: 1, has_more: false });
  });
  it('matches named leads with bound literal text and never searches hidden notes or contacts', async () => {
    const db = database();
    const q = "Acme's Logistics";
    await searchOpportunities(db.client, principal, new URLSearchParams({ q, city: 'Bangalore' }), access);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('strpos(lower(coalesce(CASE WHEN btrim(o.name)');
    expect(sql).toContain('strpos(lower(coalesce(CASE WHEN btrim(o.company_name)');
    expect(sql).toContain('regexp_split_to_table(CASE WHEN btrim(o.city)');
    expect(sql).not.toContain("regexp_split_to_table(o.city, ',')");
    expect(sql).toContain("IN ('bangalore','bengaluru')");
    expect(sql).not.toContain(q);
    expect(sql).not.toMatch(/note_text|pocPhone|phone_number|email/);
    expect(values).toEqual([[id, id2], 'Bangalore', q, 11]);
  });
  it.each(['987654', '654321', 'eight seven', 'sample'])('matches %s only against privacy-checked labels', async fragment => {
    const db = database();
    await searchOpportunities(db.client, principal, new URLSearchParams({ q: fragment }), access);
    const [sql, values] = db.query.mock.calls[0];
    expect(values).toEqual([[id, id2], fragment, 11]);
    expect(sql).not.toMatch(/coalesce\(o\.(?:name|company_name),/);
    for (const column of ['o.name', 'o.company_name']) {
      expect(sql).toContain(`btrim(${column}) !~ '([0-9][[:space:][:punct:]–—]*){7,}'`);
      expect(sql).toContain(`THEN btrim(${column}) ELSE NULL END`);
    }
    expect(sql).toContain('contact[[:space:]]*(me|us|number)');
    expect(sql).toContain('zero|one|two|three|four|five|six|seven|eight|nine|oh');
  });
  it.each([
    ['overdue', ['2026-09-24T18:30:00.000Z']],
    ['today', ['2026-09-24T18:30:00.000Z', '2026-09-25T18:30:00.000Z']],
    ['upcoming', ['2026-09-25T18:30:00.000Z']], ['missing', []],
  ])('applies %s follow-up semantics in India time', async (status, bounds) => {
    const db = database();
    await searchOpportunities(db.client, principal, new URLSearchParams({ follow_up_status: status }), access);
    expect(db.query.mock.calls[0][1]).toEqual([[id, id2], ...bounds, 11]);
    expect(db.query.mock.calls[0][0]).toContain('o.next_follow_up');
  });
  it('supports tomorrow follow-ups with priority and active-stage filters', async () => {
    const db = database();
    const result = await searchOpportunities(db.client, principal, new URLSearchParams('date_field=follow_up&period=tomorrow&active_only=true&priority_min=4&sort=follow_up_asc'), access);
    expect(db.query.mock.calls[0][0]).toContain('o.next_follow_up >=');
    expect(db.query.mock.calls[0][1]).toContainEqual(['RATING_4', 'RATING_5']);
    expect(result.query_context).toMatchObject({ date_field: 'follow_up', start_at: '2026-09-25T18:30:00.000Z', end_before: '2026-09-26T18:30:00.000Z' });
  });
  it('applies the same bounded structured filters to search and totals under the verified scope', async () => {
    const filters = new URLSearchParams({ requirement_sqft_min: '30000', requirement_sqft_max: '50000',
      micro_market: "O'Hare, North", lead_source: 'OUTREACH', lease_duration: 'LONG_TERM', industry: 'FMCG', repeat_client: 'false' });
    const search = database();
    await searchOpportunities(search.client, principal, filters, access);
    const summary = database([{ total: 0, groups: [] }]);
    await summarizeOpportunities(summary.client, principal, new URLSearchParams([...filters, ['group_by', 'lead_source']]), access);
    const expected = [[id, id2], 30000, 50000, "O'Hare, North", 'OUTREACH', 'LONG_TERM', '["FMCG"]', false, 11];
    expect(search.query.mock.calls[0][1]).toEqual(expected);
    expect(summary.query.mock.calls[0][1]).toEqual(expected);
    for (const db of [search, summary]) {
      const sql = db.query.mock.calls[0][0] as string;
      expect(sql).toContain('o.opportunity_id = ANY($1::text[])');
      expect(sql).not.toContain("O'Hare, North");
      expect(sql).toContain("jsonb_typeof(o.data->'industryVertical') = 'array'");
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('= $8::boolean');
      expect(sql).not.toMatch(/regexp_split_to_table\([^)]*microMarket/);
    }
  });
  it.each([
    ['requirement_sqft_min', '30000', '40000'], ['requirement_sqft_max', '50000', '60000'],
    ['micro_market', 'North', 'South'], ['lead_source', 'OUTREACH', 'BROKER'],
    ['lease_duration', 'LONG_TERM', 'SHORT_TERM'], ['industry', 'FMCG', 'MANUFACTURING'],
    ['repeat_client', 'true', 'false'],
  ])('binds %s to the search cursor rather than silently changing the candidate set', async (name, initial, changed) => {
    const db = database([{ opportunity_id: id }, { opportunity_id: id2 }]);
    const query = new URLSearchParams({ [name]: initial, limit: '1' });
    const first = await searchOpportunities(db.client, principal, query, access);
    query.set('cursor', first.nextCursor!);
    query.set(name, changed);
    await expect(searchOpportunities(db.client, principal, query, access)).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(db.query).toHaveBeenCalledOnce();
  });
  it.each([
    'requirement_sqft_min=0', 'requirement_sqft_max=-1', 'requirement_sqft_min=1.5',
    'requirement_sqft_min=1000000001', 'requirement_sqft_min=40,000', 'requirement_sqft_max=1e6',
    'requirement_sqft_min=50000&requirement_sqft_max=40000',
    'micro_market=North,9876543210', 'micro_market=private%40example.test',
    'lead_source=unknown', 'lease_duration=LONG', 'industry=FMCG,MANUFACTURING',
    'industry=private%40example.test', 'repeat_client=yes', 'repeat_client=OPTION1',
    'lead_source=OUTREACH&lead_source=BROKER',
  ])('refuses ambiguous or unsafe structured filters before querying: %s', async input => {
    for (const read of [searchOpportunities, summarizeOpportunities]) {
      const db = database();
      await expect(read(db.client, principal, new URLSearchParams(input), access)).rejects.toMatchObject({ status: 400 });
      expect(db.query).not.toHaveBeenCalled();
    }
  });
  it('keeps date sorting and cursor comparisons at the same precision', async () => {
    const db = database([{ opportunity_id: id, sort_value: '2026-09-25T00:00:00.123Z' }, { opportunity_id: id2 }]);
    const query = new URLSearchParams('sort=created_desc&limit=1');
    const first = await searchOpportunities(db.client, principal, query, access);
    query.set('cursor', first.nextCursor!);
    await searchOpportunities(db.client, principal, query, access);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("date_trunc('milliseconds', o.twenty_created_at) <");
    expect(sql).toContain("ORDER BY date_trunc('milliseconds', o.twenty_created_at) DESC NULLS LAST, o.opportunity_id ASC");
    expect(first.items[0]).not.toHaveProperty('sort_value');
    expect(first.query_context.has_more).toBe(true);
  });
  it.each(['id_asc', 'created_desc'].flatMap(sort => ['today', 'overdue', 'upcoming'].map(status => ({ sort, status }))))('binds $sort/$status follow-up cursors to their resolved India day', async ({ status, sort }) => {
    vi.setSystemTime(new Date('2026-09-25T18:29:50Z'));
    const db = database([{ opportunity_id: id, sort_value: '2026-09-25T00:00:00.123Z' }, { opportunity_id: id2 }]);
    const query = new URLSearchParams({ follow_up_status: status, sort, limit: '1' });
    const first = await searchOpportunities(db.client, principal, query, access);
    expect(first.query_context.follow_up).toEqual({ status, timezone: 'Asia/Kolkata',
      start_at: status === 'today' ? '2026-09-24T18:30:00.000Z' : status === 'upcoming' ? '2026-09-25T18:30:00.000Z' : null,
      end_before: status === 'today' ? '2026-09-25T18:30:00.000Z' : status === 'overdue' ? '2026-09-24T18:30:00.000Z' : null,
    });
    query.set('cursor', first.nextCursor!);
    vi.setSystemTime(new Date('2026-09-25T18:29:59Z'));
    await searchOpportunities(db.client, principal, query, access);
    vi.setSystemTime(new Date('2026-09-25T18:30:00Z'));
    await expect(searchOpportunities(db.client, principal, query, access)).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(db.query).toHaveBeenCalledTimes(2);
  });
  it('keeps missing-date cursors usable across midnight because their predicate does not move', async () => {
    const db = database([{ opportunity_id: id, sort_value: null }, { opportunity_id: id2 }]);
    const query = new URLSearchParams('follow_up_status=missing&sort=follow_up_asc&limit=1');
    const first = await searchOpportunities(db.client, principal, query, access);
    query.set('cursor', first.nextCursor!);
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    await searchOpportunities(db.client, principal, query, access);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(first.query_context.follow_up).toMatchObject({ status: 'missing', start_at: null, end_before: null });
  });
  it('does not substitute mirror dates when the native source creation date is missing', async () => {
    const db = database([{ opportunity_id: id, twenty_created_at: null, created_at: new Date(), first_seen_at: new Date() }]);
    expect((await getOpportunity(db.client, principal, id, access))?.source_created_at).toBeNull();
  });
  it.each(['q=9876543210', 'q=person%40example.com', 'city=9876543210', 'city=Delhi,9876543210', 'city=call%20me', 'city=nine%20eight%20seven%20six%20five%20four%20three', 'priority_min=0', 'priority_min=6', 'active_only=yes', 'date_field=follow_up&period=today&follow_up_status=overdue', 'date_field=created', 'period=this_month&period=today', 'sort=phone_desc'])('rejects unsupported/ambiguous queries: %s', async input => {
    const db = database();
    await expect(searchOpportunities(db.client, principal, new URLSearchParams(input), access)).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('scoped CRM aggregates and discovery', () => {
  it('withholds unsafe city labels before grouping/truncating and exposes resolved follow-up bounds', async () => {
    const db = database([{ total: 5, groups: [{ value: null, count: 4 }, { value: 'Bengaluru', count: 1 }] }]);
    const result = await summarizeOpportunities(db.client, principal, new URLSearchParams('group_by=city&group_limit=1&follow_up_status=today'), access);
    expect(result).toMatchObject({ total: 5, groups: [{ value: null, count: 4 }], other_count: 1, groups_truncated: true });
    expect(result.query_context.follow_up).toMatchObject({ status: 'today', start_at: '2026-09-24T18:30:00.000Z', end_before: '2026-09-25T18:30:00.000Z' });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql.slice(0, sql.indexOf('GROUP BY'))).toContain('contact[[:space:]]*(me|us|number)');
    expect(sql.slice(0, sql.indexOf('GROUP BY'))).toContain('THEN btrim(o.city) ELSE NULL END');
    expect(sql).not.toContain('phone_number');
  });
  it('counts the full filtered set with live scoped IDs before bounded groups', async () => {
    const db = database([{ total: 43, groups: [{ value: 'NEW_LEAD', count: 30 }, { value: 'FOLLOW_UP', count: 13 }] }]);
    const result = await summarizeOpportunities(db.client, principal, new URLSearchParams('period=this_month&group_limit=1'), access);
    expect(result).toMatchObject({ total: 43, groups: [{ value: 'NEW_LEAD', count: 30 }], groups_truncated: true, other_count: 13 });
    expect(db.query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($1::text[])');
    expect(db.query.mock.calls[0][0]).toContain('o.twenty_created_at >=');
    expect(db.query.mock.calls[0][0]).toContain('sum(count)');
    expect(db.query.mock.calls[0][1][0]).toEqual([id, id2]);
  });
  it.each(['city', 'priority', 'lead_source', 'lease_duration'])('uses only referenced bindings for %s summaries', async group => {
    const db = database([{ total: 0, groups: [] }]);
    await summarizeOpportunities(db.client, principal, new URLSearchParams({ group_by: group }), { mode: 'all', memberId: id });
    expect(db.query.mock.calls[0][1]).toEqual([11]);
    expect(db.query.mock.calls[0][0]).toContain('LIMIT $1');
  });
  it('does not turn invalid aggregate output into a zero count', async () => {
    const db = database([]);
    await expect(summarizeOpportunities(db.client, principal, new URLSearchParams(), access)).rejects.toMatchObject({ status: 503 });
  });
  it.each(['group_by=owner_email', 'group_limit=26', 'cursor=123', 'sort=created_desc', 'limit=10'])('rejects summary leakage or pagination dimensions: %s', async input => {
    const db = database();
    await expect(summarizeOpportunities(db.client, principal, new URLSearchParams(input), access)).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it('scopes city discovery to the same live permissions and sanitizes labels', async () => {
    const db = database([{ city: 'Bengaluru' }, { city: 'private@example.com' }]);
    const result = await getCrmFilterOptions(db.client, principal, new URLSearchParams('view=assigned'), access);
    expect(result.cities).toEqual(['Bengaluru']);
    expect(result.periods).toContain('this_month');
    expect(result.lead_sources).toEqual(CRM_LEAD_SOURCES);
    expect(result.lease_durations).toEqual(CRM_LEASE_DURATIONS);
    expect(result.industries).toEqual(CRM_INDUSTRIES);
    expect(result.summary_groups).toEqual(expect.arrayContaining(['lead_source', 'lease_duration']));
    expect(result.filter_guidance).toContain('complete recorded label');
    expect(db.query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($1::text[])');
    expect(db.query.mock.calls[0][0]).toContain('regexp_split_to_table(CASE WHEN btrim(o.city)');
    expect(db.query.mock.calls[0][0]).not.toContain("regexp_split_to_table(o.city, ',')");
    expect(db.query.mock.calls[0][1]).toEqual([[id, id2]]);
  });
});
