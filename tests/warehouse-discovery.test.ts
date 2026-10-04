import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { searchWarehouses } from '../src/lib/warehouse-data';
import { compactWarehouseResults } from '../src/lib/mcp-results';
import { WAREHOUSE_RECORDED_FIELDS } from '../src/lib/warehouse-recorded-context';

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}

describe('permissive warehouse discovery', () => {
  it.each([
    ['', true], ['&include_unknown=false', false],
    ['&match_mode=strict', false], ['&match_mode=strict&include_unknown=true', true],
  ])('keeps unknown numeric inclusion explicit for %s', async (extra, includesUnknown) => {
    const { client, query } = database();
    const result = await searchWarehouses(client, new URLSearchParams(`docks_min=4&area_min_sqft=40000${extra}`));
    expect(result.matching_policy.include_unknown).toBe(includesUnknown);
    const sql = query.mock.calls[0][0];
    expect(sql.includes("OR n0.kind = 'unknown'")).toBe(includesUnknown);
    expect(sql.includes('OR NOT EXISTS (SELECT 1 FROM unnest')).toBe(includesUnknown);
    expect(sql).toContain('w.visibility IS TRUE');
  });

  it('retains useful unparsed specifications and conflicting flags in concise discovery', async () => {
    const { client } = database([{ id: 42, city: 'Bhiwandi', total_space_sqft: [50000],
      fire_noc_available: false, flooring_type: 'VDF', land_type: 'Industrial',
      field_evidence: { power_kva: { source: 'Existing connection; upgrade possible' } },
      recorded_context: { compliances: 'Fire NOC reported by owner; document not reviewed',
        floor_strength_per_sqm: 'Suitable for heavy racks, load test pending',
        parking_docking_space: 'Two trailers can wait inside' },
    }]);
    const full = await searchWarehouses(client, new URLSearchParams('city=Bhiwandi&area_min_sqft=40000'));
    const concise = compactWarehouseResults(full, {});
    expect(concise.items[0]).toMatchObject({ id: 42, fire_noc_available: false, flooring_type: 'VDF',
      field_evidence: { power_kva: { kind: 'unknown', recorded_source: { state: 'present', text: 'Existing connection; upgrade possible' } } },
      recorded_context: { compliances: { text: 'Fire NOC reported by owner; document not reviewed' },
        floor_strength_per_sqm: { text: 'Suitable for heavy racks, load test pending' } } });
    expect(concise.items[0].recorded_context).not.toHaveProperty('dimensions');
  });

  it('marks concise source previews as truncated without changing the full evidence', async () => {
    const text = 'Hydrants and sprinklers described. '.repeat(12);
    const { client } = database([{ id: 42, recorded_context: { compliances: text } }]);
    const full = await searchWarehouses(client, new URLSearchParams());
    const result = compactWarehouseResults(full, {});
    expect(result.items[0].recorded_context).toMatchObject({ compliances: { state: 'truncated', truncated: true } });
    expect(full.items[0].recorded_context.compliances.text).toBe(text.trim());
  });

  it('counts complete Unicode characters when previewing evidence', () => {
    const preview = (text: string) => compactWarehouseResults({ items: [{ id: 42, field_evidence: {},
      recorded_context: { compliances: { state: 'present', text, redacted: false, truncated: false } },
    }] }, {}).items[0].recorded_context;
    expect(preview('🏭'.repeat(100))).toMatchObject({ compliances: { state: 'present', truncated: false } });
    expect(preview('🏭'.repeat(161))).toMatchObject({ compliances: { state: 'truncated', text: '🏭'.repeat(160), truncated: true } });
  });

  it('resumes large pages from the last emitted row without skipping fetched records', async () => {
    const context = Object.fromEntries(WAREHOUSE_RECORDED_FIELDS.map(({ field }) => [field, 'Technical observation. '.repeat(50)]));
    const rows = Array.from({ length: 26 }, (_, index) => ({ id: index + 1, city: 'Bhiwandi', total_space_sqft: [50000], recorded_context: context }));
    const { client, query } = database(rows);
    const parameters = new URLSearchParams('city=Bhiwandi&limit=25');
    const first = await searchWarehouses(client, parameters);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(25);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(80_000);
    expect(first.query_context).toMatchObject({ returned_count: first.items.length, has_more: true });
    const last = first.items.at(-1)!.id;
    parameters.set('cursor', first.nextCursor!);
    query.mockResolvedValue({ rows: rows.filter(row => row.id > last) });
    const second = await searchWarehouses(client, parameters);
    expect(second.items[0].id).toBe(last + 1);
    expect(query.mock.calls[1][1]).toContain(last);
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(first.items.length + second.items.length);
    parameters.set('include_unknown', 'false');
    await expect(searchWarehouses(client, parameters)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
});
