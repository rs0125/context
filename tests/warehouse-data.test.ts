import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getWarehouse, getWarehouseFilterOptions, searchWarehouses } from '../src/lib/warehouse-data';
import { WAREHOUSE_FILTER_CATALOG, WAREHOUSE_NUMERIC_FIELDS } from '../src/lib/warehouse-fields';

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}

function row(sources: Record<string, string | null> = {}) {
  return {
    id: 18, city: 'Bangalore', state: 'Karnataka', zone: 'SOUTH', warehouse_type: 'PEB',
    total_space_sqft: [10000, 50000], micromarkets: ['Nelamangala'], suitable_for: ['FMCG'],
    field_evidence: Object.fromEntries(WAREHOUSE_NUMERIC_FIELDS.map(({ field }) => [field, { source: sources[field] ?? null }])),
  };
}

describe('warehouse candidate evidence', () => {
  it('returns uncertain numeric evidence without pretending it is an exact specification', async () => {
    const { client } = database([row({ dock_count: 'approx 4', clear_height_ft: '25–30 ft', asking_rate_per_sqft: '22 negotiable', power_kva: '15 kVA' })]);
    const output = await searchWarehouses(client, new URLSearchParams('docks_min=4&clear_height_min_ft=28'));
    expect(output.items[0]).toMatchObject({
      dock_count: null, clear_height_ft: null, asking_rate_per_sqft: null, power_kva: 15, verification_required: true,
      field_evidence: { dock_count: { kind: 'approximate', value: 4 }, clear_height_ft: { kind: 'range', lower: 25, upper: 30 } },
    });
    expect(output.matching_policy).toMatchObject({ mode: 'permissive', include_unknown: false, range_matching: 'overlap' });
    expect(output.matching_policy.guidance).toMatch(/Tell the user.*verified/);
  });

  it('distinguishes an exact zero from unknown and flags explicitly included unknown constraints', async () => {
    const { client } = database([row({ dock_count: '0', plinth_height_ft: '0', washroom_count: 'No details yet' })]);
    const output = await searchWarehouses(client, new URLSearchParams('washrooms_min=2&include_unknown=true&match_mode=strict'));
    expect(output.items[0]).toMatchObject({ dock_count: 0, plinth_height_ft: 0, washroom_count: null, verification_required: true });
    expect(output.items[0].field_evidence.washroom_count).toEqual({ kind: 'unknown' });
    expect(output.matching_policy).toMatchObject({ mode: 'strict', include_unknown: true });
  });

  it('marks missing total-area candidates requiring verification when requested', async () => {
    const { client } = database([{ ...row(), total_space_sqft: [0, -20] }]);
    const output = await searchWarehouses(client, new URLSearchParams('area_min_sqft=10000&include_unknown=true'));
    expect(output.items[0]).toMatchObject({ total_space_sqft: [], verification_required: true });
  });

  it('does not label exact measurements uncertain just because unrelated fields are unfilled', async () => {
    const { client } = database([row({ dock_count: '04 docks', offered_space_sqft: '1,50,000 sft' })]);
    const item = await getWarehouse(client, 18);
    expect(item).toMatchObject({ dock_count: 4, offered_space_sqft: 150000, verification_required: false });
  });

  it('never forwards raw JSON, source notes, contacts or unsafe array labels', async () => {
    const { client } = database([{
      ...row({ dock_count: 'ask contact@example.com', clear_height_ft: 'call the owner named Private Person', asking_rate_per_sqft: '22 negotiable call 9876543210' }),
      address: 'Private Street', contactPerson: 'Private Person', contactNumber: '9876543210',
      micromarkets: ['Nelamangala', 'contact@example.com', 'call 9876543210'], suitable_for: ['FMCG', 'https://private.example'],
      fire_noc_available: null, lift_access: false,
    }]);
    const output = await getWarehouse(client, 18);
    expect(output).toMatchObject({ micromarkets: ['Nelamangala'], suitable_for: ['FMCG'], fire_noc_available: null, lift_access: false });
    expect(JSON.stringify(output)).not.toMatch(/Private|9876543210|contact@example|private\.example/);
    expect(output?.field_evidence.dock_count).toEqual({ kind: 'unknown' });
  });
});

describe('warehouse query boundary', () => {
  it('uses possible interval overlap and keeps categorical filters, visibility and pagination conjunctive', async () => {
    const { client, query } = database();
    await searchWarehouses(client, new URLSearchParams({ city: 'Bangalore', micromarket: "King's Road", docks_min: '4', docks_max: '6', verified: 'true', fire_noc: 'unknown', lift_access: 'false', cursor: '12' }));
    const [sql, values] = query.mock.calls[0];
    const where = sql.slice(sql.indexOf('WHERE w.visibility'));
    expect(where).toContain('w.visibility IS TRUE');
    expect(where).toContain('w."wogVerified" IS TRUE');
    expect(where).toContain('wd."fireNocAvailable" IS NULL');
    expect(where).toContain('w."liftAccess" IS FALSE');
    expect(where).toMatch(/n1\.kind IN \('exact', 'approximate', 'range'\) AND n1\.upper >= \$\d+ AND n1\.lower <= \$\d+/);
    expect(where).not.toContain("OR n1.kind = 'unknown'");
    expect(where).toContain('ORDER BY w.id ASC');
    expect(sql).not.toContain("King's Road");
    expect(values).toEqual(['Bangalore', "King's Road", 4, 6, 12, 11]);
    expect(sql).not.toMatch(/contactPerson|contactNumber|address|googleLocation|uploadedBy|scoutNotes|photos/);
  });

  it('keeps strict and unknown controls independent for each numeric constraint', async () => {
    const { client, query } = database();
    await searchWarehouses(client, new URLSearchParams('docks_min=4&power_max_kva=20&match_mode=strict&include_unknown=true'));
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/\(n1\.kind = 'exact' AND n1\.upper >= \$1 OR n1\.kind = 'unknown'\)/);
    expect(sql).toMatch(/\(n8\.kind = 'exact' AND n8\.lower <= \$2 OR n8\.kind = 'unknown'\)/);
  });

  it('does not sum spaces or turn city aliases into substring search', async () => {
    const { client, query } = database();
    await searchWarehouses(client, new URLSearchParams('city=Gurgaon&area_min_sqft=20000&area_max_sqft=30000'));
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("IN ('gurgaon', 'gurugram')");
    expect(sql).toContain('unnest(w."totalSpaceSqft")');
    expect(sql).toContain('WITH ORDINALITY AS area(area_sqft, area_ordinality)');
    expect(sql).toContain('area_ordinality <= 100');
    expect(sql).not.toMatch(/\bsum\(|ILIKE/);
    expect(values).toEqual(['Gurgaon', 20000, 30000, 11]);
  });

  it('bounds full evidence work to the page and parses only active specifications while finding candidates', async () => {
    const { client, query } = database();
    await searchWarehouses(client, new URLSearchParams('city=Bengaluru&docks_min=4&clear_height_min_ft=25&limit=25'));
    const sql = query.mock.calls[0][0] as string;
    const candidates = sql.split(') SELECT w.id,')[0];
    expect(candidates).toContain('WITH candidate_page AS MATERIALIZED');
    expect(candidates).toContain('w."numberOfDocks"');
    expect(candidates).toContain('w."clearHeightFt"');
    expect(candidates).not.toContain('w."offeredSpaceSqft"');
    expect(candidates).not.toContain('wd."powerKva"');
    expect(candidates).toContain('OFFSET 0');
    expect(candidates).toMatch(/ORDER BY w\.id ASC LIMIT \$\d+/);
    expect(sql).toContain('INNER JOIN candidate_page ON candidate_page.id = w.id');
    expect(query.mock.calls[0][1].at(-1)).toBe(26);
  });

  it.each([
    'docks_min=6&docks_max=4', 'power_min_kva=30&power_max_kva=20', 'gate_width_min_ft=40&gate_width_max_ft=20',
    'offered_area_min_sqft=0', 'clear_height_min_ft=0', 'gate_width_min_ft=0', 'min_rate=0', 'docks_min=-1',
    'docks_max=1.5', 'washrooms_max=10001', 'power_max_kva=1000001', 'dock_apron_max_ft=1001',
    'docks_min=4&docks_min=5', 'match_mode=loose', 'include_unknown=1', 'verified=yes', 'fire_noc=false&fire_noc=unknown',
    'contactPerson=Raj', 'warehouseType=PEB', 'q=owner', 'city=call%209876543210', 'state=private@example.com',
  ])('rejects invalid or privacy-sensitive input before querying: %s', async params => {
    const { client, query } = database();
    await expect(searchWarehouses(client, new URLSearchParams(params))).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('publishes one catalog entry per supported filter, with count and unit bounds', () => {
    const names = WAREHOUSE_FILTER_CATALOG.map(item => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const { minParam, maxParam } of WAREHOUSE_NUMERIC_FIELDS) expect(names).toEqual(expect.arrayContaining([minParam, maxParam]));
    expect(WAREHOUSE_FILTER_CATALOG.find(item => item.name === 'docks_min')).toMatchObject({ type: 'integer', minimum: 0, maximum: 10000 });
  });
});

describe('warehouse filter discovery', () => {
  it('collects bounded visible-only category options with location scoping and no private data', async () => {
    const { client, query } = database([
      { field: 'type', value: 'PEB' }, { field: 'city', value: 'Bengaluru' },
      { field: 'city', value: 'contact@example.com' }, { field: 'micromarket', value: '9876543210' },
      { field: 'contactPerson', value: 'Private Person' }, { field: 'type', value: 'peb' }, { field: 'fire_noc', value: 'unknown' },
    ]);
    const output = await getWarehouseFilterOptions(client, new URLSearchParams('city=Bangalore&state=Karnataka'));
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('w.visibility IS TRUE');
    expect(sql).toContain('rank <= 101');
    expect(sql).not.toMatch(/contactPerson|contactNumber|address|photos/);
    expect(values).toEqual(['Bangalore', 'Karnataka']);
    expect(output).toMatchObject({ options: { type: ['PEB'], city: ['Bengaluru'], micromarket: [], fire_noc: ['unknown'] }, truncated: false });
    expect(output.catalog).toEqual(WAREHOUSE_FILTER_CATALOG);
    expect(output.options).not.toHaveProperty('contactPerson');
  });

  it('marks truncated lists and never exceeds the bound', async () => {
    const { client } = database(Array.from({ length: 101 }, (_, index) => ({ field: 'city', value: `City ${index}` })));
    const output = await getWarehouseFilterOptions(client, new URLSearchParams());
    expect(output.truncated).toBe(true);
    expect(output.options.city).toHaveLength(100);
  });

  it.each(['city=A&city=B', 'docks_min=2', 'limit=1', 'visibility=hidden'])('rejects unsupported discovery scope %s', async params => {
    const { client, query } = database();
    await expect(getWarehouseFilterOptions(client, new URLSearchParams(params))).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});
