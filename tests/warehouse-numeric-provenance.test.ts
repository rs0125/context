import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getWarehouse } from '../src/lib/warehouse-data';
import { parseWarehouseMeasurement, warehouseMeasurementSql, WAREHOUSE_NUMERIC_FIELDS } from '../src/lib/warehouse-fields';
import { WAREHOUSE_NUMERIC_SOURCE_MAX_BYTES } from '../src/lib/warehouse-recorded-context';

describe('warehouse unknown measurement provenance', () => {
  it.each([null, undefined, '', '  '])('marks absent values as missing (%s)', value => {
    expect(parseWarehouseMeasurement(value, 'dock_count')).toEqual({ kind: 'unknown',
      recorded_source: { state: 'missing', text: null, redacted: false, truncated: false } });
  });

  it.each(['4 plus provision for 2 more docks', '10 ft x 12 ft', 'No details yet', '4.5 docks', '10 sqm'])(
    'keeps recorded but unparsed values distinct from absent measurements (%s)', value => {
      expect(parseWarehouseMeasurement(value, 'dock_count')).toEqual({ kind: 'unknown',
        recorded_source: { state: 'present', text: value, redacted: false, truncated: false } });
    },
  );

  it.each([{}, [], true, false, Number.NaN, Number.POSITIVE_INFINITY, 'x'.repeat(100_001)])(
    'withholds unsupported inputs without serializing their contents', value => {
      expect(parseWarehouseMeasurement(value, 'dock_count')).toEqual({ kind: 'unknown',
        recorded_source: { state: 'unsupported', text: null, redacted: false, truncated: false } });
    },
  );

  it('masks source contacts and names without returning the legacy raw source string', () => {
    const evidence = parseWarehouseMeasurement('4 plus 2 docks; owner named Private Person; sales@example.test; 9876543210', 'dock_count');
    expect(evidence).toMatchObject({ kind: 'unknown', recorded_source: { state: 'redacted', redacted: true } });
    expect(evidence.recorded_source?.text).toContain('4 plus 2 docks');
    expect(evidence).not.toHaveProperty('source');
    expect(JSON.stringify(evidence)).not.toMatch(/Private Person|sales@example|9876543210/);
  });

  it('retains exact, approximate and range semantics and their bounded measurement-only source', () => {
    expect(parseWarehouseMeasurement('0 docks', 'dock_count')).toEqual({ kind: 'exact', value: 0, source: '0 docks' });
    expect(parseWarehouseMeasurement('about 4 docks', 'dock_count')).toEqual({ kind: 'approximate', value: 4, source: 'about 4 docks' });
    expect(parseWarehouseMeasurement('20-25', 'asking_rate_per_sqft')).toEqual({ kind: 'range', lower: 20, upper: 25, source: '20-25' });
  });

  it('redacts complete supported text before reducing the numeric source budget', () => {
    const evidence = parseWarehouseMeasurement(`${'A '.repeat(45)}9876543210; ${'अनुमान '.repeat(100)}`, 'dock_count');
    expect(evidence.recorded_source).toMatchObject({ state: 'truncated', redacted: true, truncated: true });
    expect(JSON.stringify(evidence)).not.toContain('98765');
    expect(Buffer.byteLength(JSON.stringify(evidence.recorded_source!.text), 'utf8')).toBeLessThanOrEqual(WAREHOUSE_NUMERIC_SOURCE_MAX_BYTES);
  });

  it('fetches the complete bounded source, avoiding the former 101-character contact cutoff', () => {
    for (const [index, field] of WAREHOUSE_NUMERIC_FIELDS.entries()) {
      const { join } = warehouseMeasurementSql(field, index);
      expect(join).toContain(`CASE WHEN length(${field.column}::text) > 100000`);
      expect(join).toContain(`ELSE to_jsonb(${field.column}) END AS source`);
      expect(join).not.toContain('left(btrim(');
    }
  });

  it('carries missing, uninterpreted and oversized source states through the warehouse mapper', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 18, field_evidence: {
      dock_count: { source: null }, clear_height_ft: { source: '20 to ridge; 15 below beam' },
      power_kva: { source: { unsupported: true } },
    } }] });
    const result = await getWarehouse({ query } as unknown as PoolClient, 18);
    if (!result) throw new Error('Fixture warehouse missing');
    expect(result.field_evidence.dock_count.recorded_source?.state).toBe('missing');
    expect(result.field_evidence.clear_height_ft).toMatchObject({ kind: 'unknown', recorded_source: { state: 'present', text: '20 to ridge; 15 below beam' } });
    expect(result.field_evidence.power_kva.recorded_source?.state).toBe('unsupported');
    expect(result.clear_height_ft).toBeNull();
  });
});
