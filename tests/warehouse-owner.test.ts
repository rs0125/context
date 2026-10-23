import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getWarehouse, getWarehousesByIds, searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';
import { normalizeOwnerName, resolveOwnerNames, OWNER_LOOKUP_LIMIT } from '../src/lib/warehouse-owner';

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}

describe('warehouse owner-name discovery', () => {
  it('returns recorded contact and company names on search, detail and selected reads', async () => {
    const { client } = database([{ id: 12, owner_name: 'Ramesh Mehta', owner_company_name: 'Example Estates',
      contactNumber: '9876543210', alt_phone_number: '9999999999', uploadedBy: 'Private uploader',
      address: 'Private street', negotiated_rent: '18' }]);
    const items = [(await searchWarehouses(client, new URLSearchParams())).items[0],
      await getWarehouse(client, 12), (await getWarehousesByIds(client, [12]))[0]];
    for (const item of items) {
      expect(item).toMatchObject({ id: 12, owner_name: 'Ramesh Mehta', owner_company_name: 'Example Estates' });
      expect(JSON.stringify(item)).not.toMatch(/9876543210|9999999999|Private|negotiated_rent/);
    }
  });

  it.each([null, '', 'private@example.test', 'Owner 9876543210', 'Call me on 9999999999', 'x'.repeat(101)])(
    'does not pass malformed/contact-bearing name fields through: %s', async value => {
      const { client } = database([{ id: 12, owner_name: value, owner_company_name: value }]);
      expect(await getWarehouse(client, 12)).toMatchObject({ owner_name: null, owner_company_name: null });
    });

  it('resolves names before pagination and binds only matched IDs, independently of numeric matching', async () => {
    const { client, query } = database([{ id: 12, owner_name: "O'Neill" }]);
    const output = await searchWarehouses(client, new URLSearchParams({ owner_name: "O'Neill", city: 'Bangalore', match_mode: 'strict', limit: '2' }));
    const [sql, values] = query.mock.calls[1];
    expect(sql).not.toContain("O'Neill");
    expect(sql).toContain('w.visibility IS TRUE');
    expect(sql.indexOf('w.id = ANY($2::int[])')).toBeLessThan(sql.indexOf('ORDER BY'));
    expect(query.mock.calls[0][1]).toEqual(['Bangalore']);
    expect(values).toEqual(['Bangalore', [12], 3]);
    expect(output.matching_policy).toMatchObject({ mode: 'strict', owner_name: {
      query: "O'Neill", mode: 'auto', fields: ['owner_name', 'owner_company_name'], strategy: 'literal_first',
      minimum_similarity: 0.75, max_edits: 2, minimum_fuzzy_characters: 5,
    } });
    expect(sql).not.toMatch(/contactNumber|alt_phone_number|scoutNotes/);
  });

  it.each(['contains', 'exact'])('disables typo expansion explicitly with %s', async mode => {
    const { client, query } = database([{ id: 12, owner_name: "O'Neill" }]);
    await searchWarehouses(client, new URLSearchParams({ owner_name: "O'Neill", owner_match_mode: mode }));
    expect(query.mock.calls[1][1]).toEqual([[12], 11]);
  });

  it('applies the same name policy to complete summary counts', async () => {
    const { client } = database([{ total: '3', groups: [{ value: 'Bengaluru', count: 3 }], groups_truncated: false }]);
    const output = await summarizeWarehouses(client, new URLSearchParams('owner_name=Ramseh'));
    expect(output).toMatchObject({ total: 3, matching_policy: { owner_name: { query: 'Ramseh', mode: 'auto' } } });
  });

  it.each(['owner_name=Raj', 'owner_name=Ramesh&owner_match_mode=exact'])('rejects reusing a cursor with changed name matching: %s', async changed => {
    const { client, query } = database([{ id: 1 }, { id: 2 }]);
    const first = await searchWarehouses(client, new URLSearchParams('owner_name=Ramesh&limit=1'));
    const next = new URLSearchParams(changed);
    next.set('cursor', first.nextCursor!);
    await expect(searchWarehouses(client, next)).rejects.toMatchObject({ status: 400 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['owner_name=', 'owner_name=---', 'owner_name=1234', 'owner_name=9876543210',
    'owner_name=private%40example.test', 'owner_name=%25', 'owner_name=Ramesh%7C.*',
    'owner_name=Ramesh&owner_name=Suresh', 'owner_match_mode=exact', 'owner_name=Ramesh&owner_match_mode=loose',
    `owner_name=${'a'.repeat(81)}`])('rejects invalid name filters before any query: %s', async parameters => {
    const { client, query } = database();
    for (const read of [searchWarehouses, summarizeWarehouses]) {
      await expect(read(client, new URLSearchParams(parameters))).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps Unicode names and disables typo expansion for short names', () => {
    expect(normalizeOwnerName('  Ｒａｍｅｓｈ / Mehta  ')).toBe('ramesh mehta');
    expect(normalizeOwnerName('रमेश शर्मा')).toBe('रमेश शर्मा');
    expect(resolveOwnerNames('Raj', 'fuzzy', ['Raja', 'Rai']).matches.has('Rai')).toBe(false);
    expect(resolveOwnerNames('R K', 'fuzzy', ['R A']).matches.size).toBe(0);
  });

  it('prefers existing literal names and uses typo matching only as a fallback in auto mode', () => {
    const names = ['Ramesh Mehta', 'Rakesh Mehta', 'Rajesh Shah'];
    const literal = resolveOwnerNames('Rakesh', 'auto', names);
    expect([...literal.matches.keys()]).toEqual(['Rakesh Mehta']);
    expect(literal.strategy).toBe('literal_first');
    const fallback = resolveOwnerNames('Rakessh', 'auto', names);
    expect(fallback.strategy).toBe('fuzzy_fallback');
    expect(fallback.matches.has('Rakesh Mehta')).toBe(true);
    expect(resolveOwnerNames('Rakesh', 'fuzzy', names).matches.size).toBe(3);
  });

  it.each([
    ['Anil Varma', 'Anilvarma', true], ['Mr. Anil Varma', 'Anilvarma', true],
    ['K S Prasad', 'KS Prasad', true], ['Abhijeet', 'Abijeeth', true],
    ['Abhijeet', 'Abijeethx', false], ['Sarvan', 'Saream', false],
    ['Ravi', 'Rani', false], ['Mr. Ravi', 'Mr. Rani', false], ['Ramesh Mehta', 'Ramesh', false],
    ['नरेश', 'नरेश', true],
  ])('calibrated name comparison: %s / %s = %s', (query, name, expected) => {
    expect(resolveOwnerNames(query, 'fuzzy', [name]).matches.has(name)).toBe(expected);
  });

  it('never silently truncates the scoped lookup or returns a partial total', async () => {
    const { client, query } = database(Array.from({ length: OWNER_LOOKUP_LIMIT + 1 }, (_, id) => ({ id, owner_name: 'Example' })));
    await expect(summarizeWarehouses(client, new URLSearchParams('owner_name=Example'))).rejects.toMatchObject({ code: 'OWNER_SEARCH_TOO_BROAD' });
    expect(query).toHaveBeenCalledOnce();
  });

  it('does not search names withheld by the output boundary', async () => {
    const { client, query } = database([{ id: 1, owner_name: 'Private 9876543210' }, { id: 2, owner_name: 'Private@example.test' }]);
    await searchWarehouses(client, new URLSearchParams('owner_name=Private'));
    expect(query.mock.calls[1][1]).toEqual([[], 11]);
  });

  it('surfaces ambiguous names and complete per-name counts without double-counting case or role variants', async () => {
    const { client, query } = database();
    query.mockResolvedValueOnce({ rows: [
      { id: 1, owner_name: 'Anil Kumar', owner_company_name: 'Anil Kumar' },
      { id: 2, owner_name: 'anil kumar' }, { id: 3, owner_name: 'Anil Kumari' },
    ] }).mockResolvedValueOnce({ rows: [{ total: '3', groups: [{ value: 'Bengaluru', count: 3 }], groups_truncated: false }] });
    const result = await summarizeWarehouses(client, new URLSearchParams('owner_name=AnilKumr'));
    expect(result.total).toBe(3);
    expect(result.matching_policy.owner_name).toMatchObject({ strategy: 'fuzzy_fallback', disambiguation_recommended: true,
      matched_name_count: 2, approximate_name_count: 2, candidates_truncated: false, candidate_names: [
        { name: 'Anil Kumar', kind: 'fuzzy', warehouse_count: 2 }, { name: 'Anil Kumari', kind: 'fuzzy', warehouse_count: 1 },
      ] });
  });
});
