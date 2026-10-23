import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getWarehouse, getWarehouseFilterOptions, getWarehousesByIds, searchWarehouses, summarizeWarehouses } from '../src/lib/warehouse-data';
import { compactWarehouseResults } from '../src/lib/mcp-results';

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.endsWith('AS ambiguous') ? [{ ambiguous: false }] : rows }));
  return { query, client: { query } as unknown as PoolClient };
}

describe('warehouse uploader discovery and filtering', () => {
  it('preserves the resolved name in concise, detailed and selected warehouse results without the raw email', async () => {
    const { client } = database([{ id: 12, uploaded_by: 'Alex Rao', uploadedBy: 'private@example.test' }]);
    const search = await searchWarehouses(client, new URLSearchParams());
    for (const item of [search.items[0], compactWarehouseResults(search, {}).items[0],
      await getWarehouse(client, 12), (await getWarehousesByIds(client, [12]))[0]]) {
      expect(item).toMatchObject({ uploaded_by: 'Alex Rao' });
      expect(JSON.stringify(item)).not.toContain('private@example.test');
      expect(item).not.toHaveProperty('uploadedBy');
    }
  });

  it.each([null, '', 'private@example.test', 'Alex 9876543210', 'Call me on 9999999999',
    'Al\u200bex', 'Al\tex', 'x'.repeat(81)])('withholds unavailable or unsafe names: %s', async name => {
    const { client } = database([{ id: 12, uploaded_by: name }]);
    expect(await getWarehouse(client, 12)).toMatchObject({ uploaded_by: null });
  });

  it.each([['Jose\u0301 Rao', 'José Rao'], ['Ａｌｅｘ', 'Alex'], ['\tAlex\r\n', 'Alex'], ['\uFEFFAlex\u2029', 'Alex']])(
    'normalizes safe uploader names consistently: %s', async (raw, normalized) => {
      const { client, query } = database([{ id: 12, uploaded_by: raw }]);
      const result = await searchWarehouses(client, new URLSearchParams({ uploaded_by: raw }));
      expect(result.items[0].uploaded_by).toBe(normalized);
      expect(result.query_context.uploaded_by).toBe(normalized);
      expect(query.mock.calls[0][1]).toEqual([normalized]);
      expect(query.mock.calls[1][1]).toEqual([normalized, 11]);
    });

  it('discovers bounded safe names with existing location scope and retains uploader guidance in MCP projection', async () => {
    const { client, query } = database([
      { field: 'uploaded_by', value: 'Alex Rao' }, { field: 'uploaded_by', value: 'alex rao' },
      { field: 'uploaded_by', value: 'private@example.test' }, { field: 'uploaded_by', value: 'Ａｌｅｘ' },
      { field: 'uploaded_by', value: 'रमेश शर्मा' },
    ]);
    const result = await getWarehouseFilterOptions(client, new URLSearchParams('city=Bangalore'));
    expect(result.options.uploaded_by).toEqual(['Alex Rao', 'Alex', 'रमेश शर्मा']);
    expect(result.uploader_guidance).toContain('Unmapped or ambiguous');
    expect(query.mock.calls[0][1]).toEqual(['Bangalore']);
    query.mockResolvedValue({ rows: Array.from({ length: 101 }, (_, i) => ({ field: 'uploaded_by', value: `Staff ${i}` })) });
    const capped = await getWarehouseFilterOptions(client, new URLSearchParams());
    expect(capped.truncated).toBe(true);
    expect(capped.uploaded_by_truncated).toBe(true);
    expect(capped.options.uploaded_by).toHaveLength(100);
  });

  it('reports uploader completeness independently of other option categories', async () => {
    const { client } = database([{ field: 'uploaded_by', value: 'Sam' },
      ...Array.from({ length: 101 }, (_, i) => ({ field: 'city', value: `City ${i}` }))]);
    expect(await getWarehouseFilterOptions(client, new URLSearchParams())).toMatchObject({
      options: { uploaded_by: ['Sam'] }, truncated: true, uploaded_by_truncated: false,
    });
  });

  it.each([searchWarehouses, summarizeWarehouses])('rejects ambiguous names before returning inventory or counts', async read => {
    const { client, query } = database([{ ambiguous: true }]);
    query.mockResolvedValue({ rows: [{ ambiguous: true }] });
    await expect(read(client, new URLSearchParams({ uploaded_by: 'Alex Rao', city: 'Delhi' })))
      .rejects.toMatchObject({ status: 422, code: 'UPLOADER_NAME_AMBIGUOUS' });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(['Alex Rao']);
  });

  it('binds uploader names in search and summary and rejects changing them across pages', async () => {
    const { client, query } = database([{ id: 1 }, { id: 2 }]);
    const params = new URLSearchParams({ uploaded_by: "O'Neill", city: 'Bangalore', limit: '1' });
    const first = await searchWarehouses(client, params);
    expect(first.query_context.uploaded_by).toBe("O'Neill");
    expect(query.mock.calls[1][0]).not.toContain("O'Neill");
    expect(query.mock.calls[1][1]).toEqual(['Bangalore', "O'Neill", 2]);
    params.set('cursor', first.nextCursor!);
    await searchWarehouses(client, params);
    expect(query.mock.calls[3][1]).toEqual(['Bangalore', "O'Neill", 1, 2]);
    params.set('uploaded_by', 'Sam');
    await expect(searchWarehouses(client, params)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(query).toHaveBeenCalledTimes(4);
    query.mockResolvedValueOnce({ rows: [{ ambiguous: false }] })
      .mockResolvedValueOnce({ rows: [{ total: '0', groups: [], groups_truncated: false }] });
    const summary = await summarizeWarehouses(client, new URLSearchParams({ uploaded_by: "O'Neill", city: 'Bangalore' }));
    expect(summary.query_context.uploaded_by).toBe("O'Neill");
    expect(query.mock.calls[5][1]).toEqual(['Bangalore', "O'Neill", 10]);
  });

  it.each(['uploaded_by=', 'uploaded_by=%20', 'uploaded_by=a%40example.test', 'uploaded_by=9876543210',
    'uploaded_by=A&uploaded_by=B', 'uploaded_by=%25', 'uploaded_by=Al%09ex', `uploaded_by=${'a'.repeat(81)}`])(
    'rejects invalid uploader input before source reads: %s', async input => {
      const { client, query } = database();
      for (const read of [searchWarehouses, summarizeWarehouses]) {
        await expect(read(client, new URLSearchParams(input))).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
      }
      expect(query).not.toHaveBeenCalled();
    });
});
