import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getWarehouse, searchWarehouses } from '../src/lib/warehouse-data';
import {
  redactWarehouseRecordedSource, warehouseRecordedContext, WAREHOUSE_RECORDED_CONTEXT_MAX_BYTES,
  WAREHOUSE_RECORDED_FIELDS, WAREHOUSE_RECORDED_CONTEXT_SELECT,
} from '../src/lib/warehouse-recorded-context';

const recorded = {
  compliances: 'Fire NOC recorded; local authority approval pending',
  other_specifications: 'Owner to install an additional dock; available in two phases',
  fire_safety_measures: 'Hydrants installed; sprinklers proposed',
  fire_exits: 'Two exits on opposite sides', fire_compliance_cert_type: 'Fire NOC',
  floor_strength_per_sqm: '5 tonnes/sqm', centre_height: '32 ft at ridge',
  dimensions: '100 ft x 200 ft', parking_docking_space: 'Parking for 12 trailers',
  dock_dimension: '10 ft x 12 ft', dock_platform_type: 'Hydraulic leveller', canopy_type: 'Covered',
  other_docking_specs: 'One additional dock possible', ventilation_type: 'Natural and mechanical',
  ventilation_air_changes_per_day: 'Four nominal changes', insulation_present: 'Yes',
  insulation_type: 'Roof insulation', lighting_details: 'LED lighting, 150 lux',
  builtup_area: '60,000 sqft', carpet_area: '55,000 sqft', chargeable_area: 58000,
  total_floors: 'G+2', passenger_lift_count: '1', service_lift_count: '2', lift_load_capacity: '3 tonnes',
  handover_type: 'VARIABLE', handover_lead_value: 2, handover_lead_unit: 'MONTHS',
};

describe('bounded recorded warehouse property context', () => {
  it('retains every allowlisted property source without promoting narrative claims to parsed values', () => {
    const context = warehouseRecordedContext({ ...recorded, contact_person: 'Private Person', negotiated_rent: '18' });
    expect(Object.keys(context)).toEqual(WAREHOUSE_RECORDED_FIELDS.map(({ field }) => field));
    for (const [field, value] of Object.entries(recorded)) {
      expect(context[field as keyof typeof context]).toEqual({ state: 'present', text: String(value), redacted: false, truncated: false });
    }
    expect(context).not.toHaveProperty('contact_person');
    expect(context).not.toHaveProperty('negotiated_rent');
  });

  it('distinguishes missing, unsupported, redacted and truncated source evidence', () => {
    const context = warehouseRecordedContext({ compliances: null, other_specifications: { private: 'secret' },
      fire_safety_measures: 'Hydrants; sales@example.test', dimensions: 'x'.repeat(1000),
      lighting_details: 'x'.repeat(100_001) });
    expect(context.compliances).toMatchObject({ state: 'missing', text: null });
    expect(context.other_specifications).toMatchObject({ state: 'unsupported', text: null });
    expect(context.fire_safety_measures).toMatchObject({ state: 'redacted', text: 'Hydrants; [email omitted]', redacted: true });
    expect(context.dimensions).toMatchObject({ state: 'truncated', truncated: true });
    expect(context.lighting_details).toMatchObject({ state: 'unsupported', text: null });
    expect(JSON.stringify(context)).not.toMatch(/secret|sales@example/);
  });

  it('masks contact and identifying clauses while preserving property work attributed to an owner', () => {
    const output = redactWarehouseRecordedSource('Owner to install an additional dock; owner named Mr. Private Person; Call 98.76.54.32.10; negotiated rent: INR 18; Fire hydrants installed');
    expect(output.state).toBe('redacted');
    expect(output.text).toContain('Owner to install an additional dock');
    expect(output.text).toContain('Fire hydrants installed');
    expect(JSON.stringify(output)).not.toMatch(/Private Person|98\.76|INR 18/);
  });

  it.each([
    'Negotiated rent INR 18; four docks',
    'Negotiated rate is INR 18; four docks',
    'Owner Mr Synthetic Person; four docks',
    'Owner is Ms. Synthetic Person; four docks',
    'Owner is Synthetic Person; four docks',
    'Call Synthetic Person; four docks',
    'Contact Mr. Synthetic Person; four docks',
  ])('masks an explicitly identifying or private-commercial clause without requiring a colon (%s)', value => {
    const output = redactWarehouseRecordedSource(value);
    expect(output).toMatchObject({ state: 'redacted', text: '[content omitted]; four docks', redacted: true, truncated: false });
    expect(JSON.stringify(output)).not.toMatch(/INR 18|Synthetic Person/);
  });

  it.each([
    'Call bell installed at all docks; LED lighting',
    'Call Bell installed at all docks; LED lighting',
    'Contact resistance checked; LED lighting',
    'Reach truck available; four docks',
    'Call before site visit; four docks',
    'Owner to install an additional dock; four docks',
    'Owner is installing an additional dock; four docks',
    'Owner is Installing an additional dock; four docks',
  ])('preserves equipment and operational prose containing contact-like words (%s)', value => {
    expect(redactWarehouseRecordedSource(value)).toEqual({ state: 'present', text: value, redacted: false, truncated: false });
  });

  it('redacts a contact before a source budget can cut through its digits', () => {
    const output = redactWarehouseRecordedSource(`${'A '.repeat(297)}9876543210`, 600);
    expect(output.redacted).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/98765/);
    expect(output.state).toBe('truncated');
  });

  it('bounds the complete JSON context in UTF-8 bytes and keeps the state of every field', () => {
    for (const text of ['A'.repeat(2000), 'अ😀"\\\n'.repeat(1000)]) {
      const context = warehouseRecordedContext(Object.fromEntries(WAREHOUSE_RECORDED_FIELDS.map(({ field }) => [field, text])));
      expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(WAREHOUSE_RECORDED_CONTEXT_MAX_BYTES);
      expect(Object.keys(context)).toHaveLength(WAREHOUSE_RECORDED_FIELDS.length);
      expect(Object.values(context).every(value => value.state === 'truncated' && value.truncated)).toBe(true);
      expect(Object.values(context).some(value => value.text === null)).toBe(true);
      for (const source of Object.values(context)) expect(source.text?.isWellFormed() ?? true).toBe(true);
    }
  });

  it('guards every selected source before transferring an oversized value', () => {
    for (const { column } of WAREHOUSE_RECORDED_FIELDS) {
      expect(WAREHOUSE_RECORDED_CONTEXT_SELECT).toContain(`CASE WHEN length(${column}::text) > 100000 THEN '{"unsupported":true}'::jsonb ELSE to_jsonb(${column}) END`);
    }
    expect(WAREHOUSE_RECORDED_CONTEXT_SELECT).not.toMatch(/contactPerson|contactNumber|ownerCompany|negotiated_rent|scoutNotes|media|photos/);
  });

  it('recovers a later field through a focused selection and gives that field a larger text budget', () => {
    const row = Object.fromEntries(WAREHOUSE_RECORDED_FIELDS.map(({ field }) => [field, 'A '.repeat(1800)]));
    row.lift_load_capacity = `Capacity: 3 tonnes; ${'Detailed specification. '.repeat(120)}`;
    const all = warehouseRecordedContext(row);
    expect(all.lift_load_capacity).toMatchObject({ state: 'truncated', text: null, truncated: true });
    const focused = warehouseRecordedContext(row, ['lift_load_capacity']);
    expect(Object.keys(focused)).toEqual(['lift_load_capacity']);
    expect(focused.lift_load_capacity).toMatchObject({ state: 'present', text: row.lift_load_capacity.trim(), truncated: false });
    const multiple = warehouseRecordedContext(row, ['compliances', 'other_specifications', 'lift_load_capacity']);
    expect(Buffer.byteLength(JSON.stringify(multiple), 'utf8')).toBeLessThanOrEqual(WAREHOUSE_RECORDED_CONTEXT_MAX_BYTES);
    expect(multiple.lift_load_capacity.truncated).toBe(true);
  });
});

describe('warehouse recorded context on search and detail', () => {
  it('maps the allowlist and guard markers consistently without returning private database columns', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 18, city: 'Bengaluru', total_space_sqft: [50000],
      recorded_context: { ...recorded, lighting_details: { unsupported: true } },
      contactPerson: 'Private Person', contactNumber: '9876543210', negotiated_rent: '18', scoutNotes: 'Private memo',
    }] });
    const client = { query } as unknown as PoolClient;
    const detail = await getWarehouse(client, 18);
    const search = await searchWarehouses(client, new URLSearchParams());
    expect(detail).not.toBeNull();
    for (const output of [detail!, search.items[0]]) {
      expect(output.recorded_context.dimensions).toMatchObject({ state: 'present', text: '100 ft x 200 ft' });
      expect(output.recorded_context.lighting_details).toMatchObject({ state: 'unsupported', text: null });
      expect(JSON.stringify(output)).not.toMatch(/Private|9876543210|negotiated_rent|scoutNotes/);
    }
    for (const [sql] of query.mock.calls) expect(sql).toContain(WAREHOUSE_RECORDED_CONTEXT_SELECT);
  });

  it('returns only selected context fields on detail with all ordinary warehouse facts intact', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 18, city: 'Bengaluru', recorded_context: recorded }] });
    const detail = await getWarehouse({ query } as unknown as PoolClient, 18, ['handover_lead_value', 'handover_lead_unit']);
    expect(detail).toMatchObject({ id: 18, city: 'Bengaluru', recorded_context: {
      handover_lead_value: { state: 'present', text: '2' }, handover_lead_unit: { state: 'present', text: 'MONTHS' },
    } });
    expect(Object.keys(detail!.recorded_context)).toEqual(['handover_lead_value', 'handover_lead_unit']);
  });
});
