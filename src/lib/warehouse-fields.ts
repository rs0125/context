import { sanitizeLabel } from './privacy';

export type FieldEvidence = {
  kind: 'exact' | 'approximate' | 'range' | 'unknown';
  value?: number;
  lower?: number;
  upper?: number;
  source?: string;
};

export type WarehouseNumericField = {
  field: string; column: string; kind: 'area' | 'count' | 'length' | 'rate' | 'power';
  maximum: number; allowZero: boolean; integer?: boolean; minParam: string; maxParam: string;
};

export const WAREHOUSE_NUMERIC_FIELDS: readonly WarehouseNumericField[] = [
  { field: 'offered_space_sqft', column: 'w."offeredSpaceSqft"', kind: 'area', maximum: 1e9, allowZero: false, minParam: 'offered_area_min_sqft', maxParam: 'offered_area_max_sqft' },
  { field: 'dock_count', column: 'w."numberOfDocks"', kind: 'count', maximum: 10000, allowZero: true, integer: true, minParam: 'docks_min', maxParam: 'docks_max' },
  { field: 'clear_height_ft', column: 'w."clearHeightFt"', kind: 'length', maximum: 1000, allowZero: false, minParam: 'clear_height_min_ft', maxParam: 'clear_height_max_ft' },
  { field: 'asking_rate_per_sqft', column: 'w."ratePerSqft"', kind: 'rate', maximum: 1e6, allowZero: false, minParam: 'min_rate', maxParam: 'max_rate' },
  { field: 'gate_size_ft', column: 'w."gateSizeFt"', kind: 'length', maximum: 1000, allowZero: false, minParam: 'gate_width_min_ft', maxParam: 'gate_width_max_ft' },
  { field: 'plinth_height_ft', column: 'w."plinthHeightFt"', kind: 'length', maximum: 1000, allowZero: true, minParam: 'plinth_height_min_ft', maxParam: 'plinth_height_max_ft' },
  { field: 'dock_apron_length_ft', column: 'w."dockApronLengthFt"', kind: 'length', maximum: 1000, allowZero: true, minParam: 'dock_apron_min_ft', maxParam: 'dock_apron_max_ft' },
  { field: 'approach_road_width_ft', column: 'wd."approachRoadWidth"', kind: 'length', maximum: 1000, allowZero: false, minParam: 'approach_road_min_ft', maxParam: 'approach_road_max_ft' },
  { field: 'power_kva', column: 'wd."powerKva"', kind: 'power', maximum: 1e6, allowZero: true, minParam: 'power_min_kva', maxParam: 'power_max_kva' },
  { field: 'washroom_count', column: 'w.washroom_count', kind: 'count', maximum: 10000, allowZero: true, integer: true, minParam: 'washrooms_min', maxParam: 'washrooms_max' },
];

export const WAREHOUSE_CATEGORY_FIELDS = [
  { name: 'city', column: 'w.city', description: 'Exact city, ignoring case and surrounding spaces. Bangalore/Bengaluru and Gurgaon/Gurugram are aliases.' },
  { name: 'state', column: 'w.state', description: 'Exact state, ignoring case and surrounding spaces.' },
  { name: 'type', column: 'w."warehouseType"', description: 'Exact warehouse type; discover stored values from /warehouses/filters.' },
  { name: 'zone', column: 'w.zone', description: 'National operational region, such as SOUTH; not a direction within a city.' },
  { name: 'micromarket', column: 'w.micromarket', array: true, description: 'Exact member of the warehouse micromarket tags.' },
  { name: 'availability', column: 'w.availability', description: 'Exact stored availability label, such as Yes or Immediate; these labels are not interchangeable.' },
  { name: 'status', column: 'w.status', description: 'Exact warehouse construction/occupancy status.' },
  { name: 'listing_type', column: 'w.listing_type', description: 'Exact listing type, such as Rent or Sale.' },
  { name: 'flooring_type', column: 'w."flooringType"', description: 'Exact stored flooring category.' },
  { name: 'land_type', column: 'wd."landType"', description: 'Exact stored land-use category.' },
  { name: 'pollution_zone', column: 'wd."pollutionZone"', description: 'Exact stored pollution category.' },
  { name: 'water_supply', column: 'w."waterSupply"::text', description: 'Exact water supply enum; NONE means known absence, not missing data.' },
  { name: 'suitable_for', column: 'w."suitableFor"', array: true, description: 'Exact member of the warehouse use-case tags.' },
] as const;

export const WAREHOUSE_BOOLEAN_FIELDS = [
  { name: 'verified', column: 'w."wogVerified"', output: 'verified' },
  { name: 'fire_noc', column: 'wd."fireNocAvailable"', output: 'fire_noc_available' },
  { name: 'lift_access', column: 'w."liftAccess"', output: 'lift_access' },
] as const;

export type WarehouseFilterDefinition = {
  name: string; type: 'string' | 'number' | 'integer'; description: string;
  enum?: readonly string[]; minimum?: number; exclusiveMinimum?: number; maximum?: number; default?: number | string;
};

export const WAREHOUSE_FILTER_CATALOG: readonly WarehouseFilterDefinition[] = [
  ...WAREHOUSE_CATEGORY_FIELDS.map(({ name, description }) => ({ name, type: 'string' as const, description })),
  ...WAREHOUSE_BOOLEAN_FIELDS.map(({ name }) => ({ name, type: 'string' as const, enum: ['true', 'false', 'unknown'], description: `${name}: true, false, or missing (unknown); false never includes missing values.` })),
  ...(['area_min_sqft', 'area_max_sqft'] as const).map(name => ({ name, type: 'number' as const, exclusiveMinimum: 0, maximum: 1e9, description: 'Bound on one of the first 100 total-space entries in square feet, not the sum of the array. The same first-100 limit applies to returned entries.' })),
  ...WAREHOUSE_NUMERIC_FIELDS.flatMap(field => [field.minParam, field.maxParam].map(name => ({
    name, type: field.integer ? 'integer' as const : 'number' as const,
    ...(field.allowZero ? { minimum: 0 } : { exclusiveMinimum: 0 }), maximum: field.maximum,
    description: `${name === field.minParam ? 'Minimum' : 'Maximum'} ${field.field}. Permissive ranges match on possible overlap; unknowns are excluded unless include_unknown=true.`,
  }))),
  { name: 'match_mode', type: 'string', enum: ['permissive', 'strict'], default: 'permissive', description: 'Permissive accepts scalar estimates and overlapping ranges as candidates requiring verification. Strict excludes approximate values and ranges; include_unknown=true can independently admit missing or uninterpretable constrained values.' },
  { name: 'include_unknown', type: 'string', enum: ['true', 'false'], default: 'false', description: 'Include missing or uninterpretable values for constrained numeric fields; these matches require verification.' },
  { name: 'limit', type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Maximum records per page.' },
  { name: 'cursor', type: 'integer', minimum: 1, maximum: 2147483647, description: 'Exclusive warehouse ID cursor, from nextCursor.' },
];

// A shared grammar drives JavaScript evidence and PostgreSQL matching. Only
// complete, bounded scalar expressions are accepted; digits are never scraped
// from prose, dimensions, contacts, or an arbitrary sequence of punctuation.
const NUMBER = '(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3})(?:[.][0-9]+)?';
const METRES = /^(?:m|meters?|metres?|mtrs?)$/;
const METRES_TO_FEET = 3.280839895013123;
const MAX_SOURCE_LENGTH = 100;

function fieldDefinition(field: WarehouseNumericField | string): WarehouseNumericField {
  if (typeof field !== 'string') return field;
  const definition = WAREHOUSE_NUMERIC_FIELDS.find(candidate => candidate.field === field);
  if (!definition) throw new Error('Unknown warehouse numeric field');
  return definition;
}

export function warehouseMeasurementPatterns(fieldOrName: WarehouseNumericField | string) {
  const field = fieldDefinition(fieldOrName);
  const units = field.kind === 'length' ? '(?:ft[.]?|feet|foot|m|meters?|metres?|mtrs?)'
    : field.kind === 'area' ? '(?:sqft|sft|sq[.]?[ ]*ft[.]?|square[ ]+(?:feet|foot))'
    : field.kind === 'power' ? '(?:kva)'
    : field.kind === 'count' ? (field.field === 'dock_count' ? '(?:docks?|nos[.]?)' : '(?:washrooms?|nos[.]?)')
    : '(?:(?:/|per[ ]+)[ ]*(?:sqft|sft|sq[.]?[ ]*ft))';
  const prefix = field.kind === 'rate' ? '(?:(?:rs[.]?|inr|₹)[ ]*)?' : '';
  const scalar = `${prefix}(${NUMBER})[ ]*(${units})?`;
  return {
    exact: `^${scalar}$`,
    approximate: `^(?:approx(?:imately)?[.]?|about|around|~|≈)[ ]*${scalar}$`,
    approximateSuffix: `^${scalar}[ ]+(?:approx[.]?|approximately${field.kind === 'rate' ? '|negotiable' : ''})$`,
    range: `^${prefix}(${NUMBER})[ ]*(${units})?[ ]*(?:-|–|—|to)[ ]*${prefix}(${NUMBER})[ ]*(${units})?$`,
  };
}

function validMeasurement(number: number, field: WarehouseNumericField) {
  return Number.isFinite(number) && (field.allowZero ? number >= 0 : number > 0)
    && number <= field.maximum && (!field.integer || Number.isSafeInteger(number));
}

export function parseWarehouseMeasurement(value: unknown, fieldOrName: WarehouseNumericField | string): FieldEvidence {
  const field = fieldDefinition(fieldOrName);
  if (typeof value !== 'string' && typeof value !== 'number') return { kind: 'unknown' };
  const raw = String(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const source = sanitizeLabel(raw, MAX_SOURCE_LENGTH);
  // Unparsed specification prose may contain names or obfuscated contacts.
  // Only successfully parsed measurements are eligible for a source excerpt.
  const unknown: FieldEvidence = { kind: 'unknown' };
  if (!raw || raw.length > MAX_SOURCE_LENGTH) return unknown;
  const text = raw.toLowerCase();
  const patterns = warehouseMeasurementPatterns(field);
  const convert = (number: string, unit?: string) => Number(number.replaceAll(',', ''))
    * (field.kind === 'length' && METRES.test(unit ?? '') ? METRES_TO_FEET : 1);
  for (const key of ['exact', 'approximate', 'approximateSuffix', 'range'] as const) {
    const match = new RegExp(patterns[key]).exec(text);
    if (!match) continue;
    if (key === 'range') {
      const lower = convert(match[1], match[2] || match[4]);
      const upper = convert(match[3], match[4] || match[2]);
      if (!validMeasurement(lower, field) || !validMeasurement(upper, field) || lower > upper) return unknown;
      return { kind: 'range', lower, upper, ...(source ? { source } : {}) };
    }
    const number = convert(match[1], match[2]);
    if (!validMeasurement(number, field)) return unknown;
    return { kind: key === 'exact' ? 'exact' : 'approximate', value: number, ...(source ? { source } : {}) };
  }
  return unknown;
}

function sqlLiteral(text: string) { return `'${text.replaceAll("'", "''")}'`; }

/** SQL identifiers originate only in WAREHOUSE_NUMERIC_FIELDS, never in requests.
 * Each lateral yields kind/lower/upper/value plus source text for safe mapping.
 * WHERE and SELECT consume these same normalized values. OFFSET 0 deliberately
 * prevents PostgreSQL from flattening the stages and expanding each regex/cast
 * many times into every endpoint, predicate and JSON property.
 */
export function warehouseMeasurementSql(field: WarehouseNumericField, index: number) {
  const alias = `n${index}`;
  const patterns = warehouseMeasurementPatterns(field);
  const matchSql = Object.entries(patterns).map(([key, pattern]) => `regexp_match(t.text, ${sqlLiteral(pattern)}) AS "${key}"`).join(', ');
  const converted = (number: string, unit: string) => `(replace(${number}, ',', '')::numeric * ${field.kind === 'length' ? `CASE WHEN ${unit} ~ '^(m|meters?|metres?|mtrs?)$' THEN ${METRES_TO_FEET}::numeric ELSE 1::numeric END` : '1::numeric'})`;
  const low = converted('m.parts[1]', "COALESCE(m.parts[2], CASE WHEN m.kind = 'range' THEN m.parts[4] END, '')");
  const high = converted("CASE WHEN m.kind = 'range' THEN m.parts[3] ELSE m.parts[1] END", "COALESCE(CASE WHEN m.kind = 'range' THEN m.parts[4] END, m.parts[2], '')");
  const valid = `v.lo ${field.allowZero ? '>=' : '>'} 0 AND v.hi <= ${field.maximum} AND v.lo <= v.hi${field.integer ? ' AND trunc(v.lo) = v.lo AND trunc(v.hi) = v.hi' : ''}`;
  return { alias, join: `
    CROSS JOIN LATERAL (
      SELECT CASE WHEN ${valid} THEN m.kind ELSE 'unknown' END AS kind,
        CASE WHEN ${valid} THEN v.lo END AS lower,
        CASE WHEN ${valid} THEN v.hi END AS upper,
        CASE WHEN ${valid} AND m.kind <> 'range' THEN v.lo END AS value,
        left(btrim(${field.column}, E' \\t\\r\\n'), ${MAX_SOURCE_LENGTH + 1}) AS source
      FROM LATERAL (SELECT CASE WHEN length(btrim(${field.column}, E' \\t\\r\\n')) <= ${MAX_SOURCE_LENGTH} THEN lower(btrim(${field.column}, E' \\t\\r\\n')) END AS text OFFSET 0) t
      CROSS JOIN LATERAL (SELECT ${matchSql} OFFSET 0) p
      CROSS JOIN LATERAL (SELECT CASE WHEN p.exact IS NOT NULL THEN 'exact' WHEN p.approximate IS NOT NULL OR p."approximateSuffix" IS NOT NULL THEN 'approximate' WHEN p.range IS NOT NULL THEN 'range' ELSE 'unknown' END AS kind,
        COALESCE(p.exact, p.approximate, p."approximateSuffix", p.range) AS parts OFFSET 0) m
      CROSS JOIN LATERAL (SELECT ${low} AS lo, ${high} AS hi OFFSET 0) v
      OFFSET 0
    ) ${alias}` };
}
