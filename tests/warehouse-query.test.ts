import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWarehouse, searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';
import { WAREHOUSE_FILTER_CATALOG, WAREHOUSE_SUMMARY_CATALOG } from '../src/lib/warehouse-fields';

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}

function record(id: number, sort_value: string | null = '2026-09-25T03:00:00.123Z') {
  return { id, city: 'Bengaluru', sort_value, created_at: sort_value, total_space_sqft: [10000] };
}

afterEach(() => vi.useRealTimers());

describe('warehouse calendar queries and stable pagination', () => {
  it('filters the complete India calendar month and returns explicit page/date meaning', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const { client, query } = database([record(3), record(8)]);
    const response = await searchWarehouses(client, new URLSearchParams('period=this_month&limit=1'));
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain(`(w."createdAt" AT TIME ZONE 'UTC') >= $1::timestamptz`);
    expect(sql).toContain(`(w."createdAt" AT TIME ZONE 'UTC') < $2::timestamptz`);
    expect(values).toEqual(['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z', 2]);
    expect(response.nextCursor).toBeTruthy();
    expect(response.nextCursor).not.toBe('3');
    expect(response.query_context).toMatchObject({
      timezone: 'Asia/Kolkata', date_field: 'created', date_from: '2026-09-01', date_to: '2026-09-30',
      start_at: values[0], end_before: values[1], returned_count: 1, has_more: true, sort: 'id_asc',
    });
    expect(response.query_context.semantics.pagination).toMatch(/not a total/);
    expect(response.query_context.semantics.pagination).toMatch(/not a frozen snapshot/);
  });

  it('uses explicit inclusive dates for row-update filters and states their limits', async () => {
    const { client, query } = database();
    const response = await searchWarehouses(client, new URLSearchParams('date_field=updated&date_from=2026-09-24&date_to=2026-09-24'));
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain(`(w.status_updated_at AT TIME ZONE 'UTC') >= $1::timestamptz`);
    expect(values).toEqual(['2026-09-23T18:30:00.000Z', '2026-09-24T18:30:00.000Z', 11]);
    expect(response.query_context.semantics.updated_at).toMatch(/not a complete edit history/);
    expect(response.query_context.semantics.updated_at).toMatch(/WarehouseData may not advance/);
    expect(response.query_context).toMatchObject({ returned_count: 0, has_more: false });
  });

  it('keeps timestamps interpreted as UTC on detail reads, independently of the pool session timezone', async () => {
    const { client, query } = database([record(3)]);
    const response = await getWarehouse(client, 3);
    expect(query.mock.calls[0][0]).toContain(`(w."createdAt" AT TIME ZONE 'UTC') AS created_at`);
    expect(query.mock.calls[0][0]).toContain(`(w.status_updated_at AT TIME ZONE 'UTC') AS updated_at`);
    expect(response?.created_at).toBe('2026-09-25T03:00:00.123Z');
  });

  it.each(['created_desc', 'created_asc', 'updated_desc'])('round-trips %s cursors with a timestamp and deterministic ID tie-break', async sort => {
    const { client, query } = database([record(3), record(8)]);
    const params = new URLSearchParams({ sort, city: 'Bengaluru', limit: '1' });
    const first = await searchWarehouses(client, params);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toBe('3');
    expect(first.items[0]).not.toHaveProperty('sort_value');
    const source = sort.startsWith('created') ? `w."createdAt"` : 'w.status_updated_at';
    const direction = sort.endsWith('asc') ? 'ASC' : 'DESC';
    const expression = `date_trunc('milliseconds', (${source} AT TIME ZONE 'UTC'))`;
    expect(query.mock.calls[0][0]).toContain(`${expression} ${direction} NULLS LAST, w.id ASC`);
    expect(query.mock.calls[0][0]).toContain(`${expression} AS sort_value`);
    params.set('cursor', first.nextCursor!); params.set('limit', '2');
    await searchWarehouses(client, params);
    const [sql, values] = query.mock.calls[1];
    expect(sql).toContain(`${expression} = $3::timestamptz AND w.id > $2`);
    expect(sql).toContain(`${expression} IS NULL`);
    expect(values).toEqual(['Bengaluru', 3, '2026-09-25T03:00:00.123Z', 3]);
    params.set('city', 'Mumbai');
    await expect(searchWarehouses(client, params)).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps null-date cursor traversal within the null tail', async () => {
    const { client, query } = database([record(3, null), record(8, null)]);
    const params = new URLSearchParams('sort=created_desc&limit=1');
    const first = await searchWarehouses(client, params);
    params.set('cursor', first.nextCursor!);
    await searchWarehouses(client, params);
    expect(query.mock.calls[1][0]).toContain(`(date_trunc('milliseconds', (w."createdAt" AT TIME ZONE 'UTC')) IS NULL AND w.id > $1)`);
    expect(query.mock.calls[1][1]).toEqual([3, 2]);
  });

  it.each(['id_asc', 'created_desc'])('binds the relative window, not the request clock, for %s', async sort => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const { client, query } = database([record(3), record(8)]);
    const params = new URLSearchParams({ period: 'this_month', sort, limit: '1' });
    const first = await searchWarehouses(client, params);
    params.set('cursor', first.nextCursor!);
    vi.setSystemTime(new Date('2026-09-25T12:00:05Z'));
    await searchWarehouses(client, params);
    expect(query).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    await expect(searchWarehouses(client, params)).rejects.toMatchObject({ status: 400 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['date_field=updated', 'date_field=handover&period=today', 'date_from=2026-02-30',
    'date_from=2026-09-25&date_to=2026-09-24', 'period=this_month&date_to=2026-09-25',
    'period=last_year', 'period=today&period=yesterday', 'sort=updated_asc',
    'sort=created_desc&cursor=4', 'cursor=2147483648'])('rejects invalid temporal/paging input before a DB call: %s', async input => {
    const { client, query } = database();
    await expect(searchWarehouses(client, new URLSearchParams(input))).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('warehouse summaries count the complete filtered set', () => {
  it('uses the same predicates and uncertainty policy as search with one bounded aggregate query', async () => {
    const search = database();
    const summary = database([{ total: '137', groups: [{ value: 'Bengaluru', count: 120 }], groups_truncated: true }]);
    const filters = 'city=Bangalore&docks_min=4&include_unknown=true&date_from=2026-09-01';
    const listing = await searchWarehouses(search.client, new URLSearchParams(filters));
    const result = await summarizeWarehouses(summary.client, new URLSearchParams(`${filters}&group_limit=1`));
    const [sql, values] = summary.query.mock.calls[0];
    const searchSql = search.query.mock.calls[0][0] as string;
    const predicates = searchSql.split('WHERE w.visibility IS TRUE')[1].split(' ORDER BY')[0];
    expect(sql).toContain(`WHERE w.visibility IS TRUE${predicates}`);
    expect(values).toEqual(['Bangalore', 4, '2026-08-31T18:30:00.000Z', 1]);
    expect(result).toMatchObject({ total: 137, group_by: 'city', groups: [{ value: 'Bengaluru', count: 120 }], other_count: 17, groups_truncated: true });
    expect(result.matching_policy).toEqual(listing.matching_policy);
    expect(result.query_context).toMatchObject({ returned_count: 1, has_more: false, date_field: 'created' });
    expect(sql).toContain('count(*)::text FROM matched');
    expect(sql).toContain('GROUP BY lower(label)');
    expect(sql).toContain('LIMIT $4');
    expect(sql).not.toMatch(/sum\(|contactNumber|contactPerson|scoutNotes|photos/);
    expect(summary.query).toHaveBeenCalledTimes(1);
  });

  it('combines canonical city aliases and counts withheld labels without exporting them', async () => {
    const { client, query } = database([{ total: '10', groups: [
      { value: 'Bangalore', count: 3 }, { value: 'Bengaluru', count: 2 },
      { value: null, count: 1 }, { value: 'contact@example.com', count: 4 },
    ], groups_truncated: false }]);
    const response = await summarizeWarehouses(client, new URLSearchParams());
    expect(response.groups).toEqual([{ value: 'Bengaluru', count: 5 }, { value: null, count: 5 }]);
    expect(response.other_count).toBe(0);
    expect(JSON.stringify(response)).not.toContain('contact@example.com');
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("IN ('bangalore', 'bengaluru') THEN 'Bengaluru'");
    expect(sql).toContain("IN ('gurgaon', 'gurugram') THEN 'Gurugram'");
    expect(sql).toContain('ELSE NULL END AS label');
    expect(response.query_context.semantics.groups).toMatch(/missing or safely withheld/);
  });

  it('represents a complete empty result as zero without inventing a group', async () => {
    const { client } = database([{ total: '0', groups: [], groups_truncated: false }]);
    const response = await summarizeWarehouses(client, new URLSearchParams('group_by=verified'));
    expect(response).toMatchObject({ total: 0, groups: [], groups_truncated: false, other_count: 0, group_by: 'verified' });
  });

  it.each([
    { total: '4', groups: [{ value: 'PEB', count: 5 }], groups_truncated: false },
    { total: '4', groups: [{ value: 'PEB', count: 3 }], groups_truncated: false },
    { total: '0', groups: [{ value: 'PEB', count: 0 }], groups_truncated: false },
    { total: '-1', groups: [], groups_truncated: false },
  ])('does not publish inconsistent source aggregate counts', async aggregate => {
    const { client } = database([aggregate]);
    await expect(summarizeWarehouses(client, new URLSearchParams('group_by=type')))
      .rejects.toMatchObject({ status: 503, code: 'WAREHOUSE_DATA_UNAVAILABLE' });
  });

  it.each(['limit=1', 'cursor=8', 'sort=created_desc', 'group_by=contactPerson',
    'group_by=city&group_by=state', 'group_limit=0', 'group_limit=26', 'group_limit=1.2',
    'group_by=city%3BDROP%20TABLE%20Warehouse'])('rejects unsupported grouping and search pagination: %s', async input => {
    const { client, query } = database();
    await expect(summarizeWarehouses(client, new URLSearchParams(input))).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('publishes temporal sorting separately from summary grouping', () => {
    expect(WAREHOUSE_FILTER_CATALOG.find(field => field.name === 'cursor')?.type).toBe('string');
    expect(WAREHOUSE_FILTER_CATALOG.map(field => field.name)).toEqual(expect.arrayContaining(['period', 'date_from', 'date_to', 'date_field', 'sort']));
    const summaryNames = WAREHOUSE_SUMMARY_CATALOG.map(field => field.name);
    expect(summaryNames).toEqual(expect.arrayContaining(['period', 'group_by', 'group_limit']));
    expect(summaryNames).not.toEqual(expect.arrayContaining(['limit', 'cursor', 'sort']));
  });
});
