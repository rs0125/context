import type { PoolClient } from 'pg';
import { HttpError } from './errors';
import { sanitizeLabel } from './privacy';
import {
  WAREHOUSE_BOOLEAN_FIELDS, WAREHOUSE_CATEGORY_FIELDS, WAREHOUSE_FILTER_CATALOG,
  WAREHOUSE_NUMERIC_FIELDS, parseWarehouseMeasurement, warehouseMeasurementSql,
  type FieldEvidence, type WarehouseFilterDefinition,
} from './warehouse-fields';

type Row = Record<string, unknown>;
type Bind = (value: unknown) => string;
const MAX_ID = 2147483647;
const OPTION_LIMIT = 100;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:[.][0-9]{1,6})?$/;
const LABEL = /^[\p{L}\p{N} .,'()&/_–—-]+$/u;

function invalid(message: string): never { throw new HttpError(400, 'INVALID_QUERY', message); }

function validateKeys(query: URLSearchParams, allowed: readonly string[]) {
  const seen = new Set<string>();
  for (const [name] of query) {
    if (!allowed.includes(name)) invalid(`Unknown query parameter: ${name}`);
    if (seen.has(name)) invalid(`Duplicate query parameter: ${name}`);
    seen.add(name);
  }
}

function textParameter(query: URLSearchParams, name: string) {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const text = raw.trim();
  if (!text || text.length > 80 || !LABEL.test(text) || !sanitizeLabel(text, 80)) invalid(`${name} must be a location or category of at most 80 characters`);
  return text;
}

function numericParameter(query: URLSearchParams, definition: WarehouseFilterDefinition) {
  const value = query.get(definition.name);
  if (value === null) return undefined;
  if (!DECIMAL.test(value)) invalid(`${definition.name} must be an ordinary decimal number`);
  const number = Number(value);
  if (!Number.isFinite(number) || (definition.type === 'integer' && !Number.isSafeInteger(number))
    || (definition.minimum !== undefined && number < definition.minimum)
    || (definition.exclusiveMinimum !== undefined && number <= definition.exclusiveMinimum)
    || (definition.maximum !== undefined && number > definition.maximum)) invalid(`${definition.name} is outside the supported range`);
  return number;
}

function enumParameter(query: URLSearchParams, name: string, allowed: readonly string[], fallback?: string) {
  const value = query.get(name);
  if (value === null) return fallback;
  if (!allowed.includes(value)) invalid(`${name} must be ${allowed.join(', ')}`);
  return value;
}

function cityCondition(value: string, bind: Bind) {
  // Keep the original spelling bound once; aliases are fixed application data.
  const parameter = bind(value);
  return `(lower(btrim(w.city)) = lower(${parameter}) OR
    (lower(btrim(w.city)) IN ('bangalore', 'bengaluru') AND lower(${parameter}) IN ('bangalore', 'bengaluru')) OR
    (lower(btrim(w.city)) IN ('gurgaon', 'gurugram') AND lower(${parameter}) IN ('gurgaon', 'gurugram')))`;
}

function locationConditions(query: URLSearchParams, bind: Bind) {
  const clauses: string[] = [];
  const city = textParameter(query, 'city');
  const state = textParameter(query, 'state');
  if (city) clauses.push(cityCondition(city, bind));
  if (state) clauses.push(`lower(btrim(w.state)) = lower(${bind(state)})`);
  return clauses;
}

const NORMALIZERS = WAREHOUSE_NUMERIC_FIELDS.map(warehouseMeasurementSql);
const NORMALIZATION_JOINS = NORMALIZERS.map(({ join }) => join).join('\n');
const EVIDENCE_SELECT = `jsonb_build_object(${WAREHOUSE_NUMERIC_FIELDS.map((field, index) =>
  `'${field.field}', jsonb_build_object('kind', n${index}.kind, 'value', n${index}.value, 'lower', n${index}.lower, 'upper', n${index}.upper, 'source', n${index}.source)`
).join(', ')}) AS field_evidence`;
const COLUMNS = `w.id, w.city, w.state, w.zone, w."warehouseType" AS warehouse_type,
  w."totalSpaceSqft" AS total_space_sqft, w.micromarket AS micromarkets, w."suitableFor" AS suitable_for,
  w.availability, w.status, w."wogVerified" AS verified, w."flooringType" AS flooring_type,
  w.listing_type, w."waterSupply"::text AS water_supply, w."liftAccess" AS lift_access,
  wd."fireNocAvailable" AS fire_noc_available, wd."landType" AS land_type, wd."pollutionZone" AS pollution_zone,
  w."handoverDate"::text AS handover_date, w."createdAt" AS created_at, w.status_updated_at AS updated_at,
  ${EVIDENCE_SELECT}`;
const BASE_FROM = 'FROM public."Warehouse" w LEFT JOIN public."WarehouseData" wd ON wd."warehouseId" = w.id';
const FROM = `${BASE_FROM} ${NORMALIZATION_JOINS}`;

function timestamp(value: unknown) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$| )/.test(value))) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function calendarDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !value.startsWith('0000') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function labels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 100).map(item => sanitizeLabel(item, 80)).filter((item): item is string => item !== null))];
}

function validAreas(value: unknown): number[] {
  return Array.isArray(value) ? value.slice(0, 100).filter((area): area is number =>
    typeof area === 'number' && Number.isSafeInteger(area) && area > 0 && area <= 1e9) : [];
}

function warehouse(row: Row, constrainedFields: readonly string[] = []) {
  const evidence: Record<string, FieldEvidence> = {};
  const supplied = row.field_evidence && typeof row.field_evidence === 'object' && !Array.isArray(row.field_evidence)
    ? row.field_evidence as Row : {};
  for (const field of WAREHOUSE_NUMERIC_FIELDS) {
    const entry = supplied[field.field];
    const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Row).source : row[field.field];
    evidence[field.field] = parseWarehouseMeasurement(source, field);
  }
  const exact = (field: string) => evidence[field].kind === 'exact' ? evidence[field].value! : null;
  const areas = validAreas(row.total_space_sqft);
  return {
    id: row.id as number,
    city: sanitizeLabel(row.city), state: sanitizeLabel(row.state), zone: sanitizeLabel(row.zone),
    warehouse_type: sanitizeLabel(row.warehouse_type), total_space_sqft: areas,
    offered_space_sqft: exact('offered_space_sqft'), dock_count: exact('dock_count'),
    clear_height_ft: exact('clear_height_ft'), asking_rate_per_sqft: exact('asking_rate_per_sqft'),
    gate_size_ft: exact('gate_size_ft'), plinth_height_ft: exact('plinth_height_ft'),
    dock_apron_length_ft: exact('dock_apron_length_ft'), approach_road_width_ft: exact('approach_road_width_ft'),
    power_kva: exact('power_kva'), washroom_count: exact('washroom_count'),
    availability: sanitizeLabel(row.availability), status: sanitizeLabel(row.status),
    verified: typeof row.verified === 'boolean' ? row.verified : null,
    fire_noc_available: typeof row.fire_noc_available === 'boolean' ? row.fire_noc_available : null,
    lift_access: typeof row.lift_access === 'boolean' ? row.lift_access : null,
    flooring_type: sanitizeLabel(row.flooring_type), listing_type: sanitizeLabel(row.listing_type),
    land_type: sanitizeLabel(row.land_type), pollution_zone: sanitizeLabel(row.pollution_zone),
    water_supply: sanitizeLabel(row.water_supply), micromarkets: labels(row.micromarkets), suitable_for: labels(row.suitable_for),
    handover_date: calendarDate(row.handover_date), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    field_evidence: evidence,
    verification_required: Object.values(evidence).some(item => item.kind === 'approximate' || item.kind === 'range')
      || constrainedFields.some(field => field === 'total_space_sqft' ? areas.length === 0 : evidence[field].kind === 'unknown'),
  };
}

export async function searchWarehouses(client: PoolClient, query: URLSearchParams) {
  validateKeys(query, WAREHOUSE_FILTER_CATALOG.map(({ name }) => name));
  const mode = enumParameter(query, 'match_mode', ['permissive', 'strict'], 'permissive') as 'permissive' | 'strict';
  const includeUnknown = enumParameter(query, 'include_unknown', ['true', 'false'], 'false') === 'true';
  const numbers = Object.fromEntries(WAREHOUSE_FILTER_CATALOG.filter(item => item.type !== 'string')
    .map(item => [item.name, numericParameter(query, item)]));
  const values: unknown[] = [];
  const bind: Bind = value => { values.push(value); return `$${values.length}`; };
  const where = ['w.visibility IS TRUE', ...locationConditions(query, bind)];
  for (const field of WAREHOUSE_CATEGORY_FIELDS) {
    if (field.name === 'city' || field.name === 'state') continue;
    const value = textParameter(query, field.name);
    if (!value) continue;
    where.push('array' in field ? `EXISTS (SELECT 1 FROM unnest(${field.column}) AS tag(value) WHERE lower(btrim(tag.value)) = lower(${bind(value)}))`
      : `lower(btrim(${field.column})) = lower(${bind(value)})`);
  }
  for (const field of WAREHOUSE_BOOLEAN_FIELDS) {
    const value = enumParameter(query, field.name, ['true', 'false', 'unknown']);
    if (value) where.push(`${field.column} IS ${value === 'unknown' ? 'NULL' : value.toUpperCase()}`);
  }
  if (numbers.cursor !== undefined) where.push(`w.id > ${bind(numbers.cursor)}`);
  const constrainedFields: string[] = [];
  const areaMin = numbers.area_min_sqft;
  const areaMax = numbers.area_max_sqft;
  if (areaMin !== undefined && areaMax !== undefined && areaMin > areaMax) invalid('area_min_sqft must not exceed area_max_sqft');
  if (areaMin !== undefined || areaMax !== undefined) {
    constrainedFields.push('total_space_sqft');
    const validArea = 'area_ordinality <= 100 AND area_sqft > 0 AND area_sqft <= 1000000000';
    const range = [validArea];
    if (areaMin !== undefined) range.push(`area_sqft >= ${bind(areaMin)}`);
    if (areaMax !== undefined) range.push(`area_sqft <= ${bind(areaMax)}`);
    const match = `EXISTS (SELECT 1 FROM unnest(w."totalSpaceSqft") WITH ORDINALITY AS area(area_sqft, area_ordinality) WHERE ${range.join(' AND ')})`;
    where.push(includeUnknown ? `(${match} OR NOT EXISTS (SELECT 1 FROM unnest(w."totalSpaceSqft") WITH ORDINALITY AS area(area_sqft, area_ordinality) WHERE ${validArea}))` : match);
  }
  WAREHOUSE_NUMERIC_FIELDS.forEach((field, index) => {
    const min = numbers[field.minParam]; const max = numbers[field.maxParam];
    if (min !== undefined && max !== undefined && min > max) invalid(`${field.minParam} must not exceed ${field.maxParam}`);
    if (min === undefined && max === undefined) return;
    constrainedFields.push(field.field);
    const match = [mode === 'strict' ? `n${index}.kind = 'exact'` : `n${index}.kind IN ('exact', 'approximate', 'range')`];
    // A range is a possible match only. The response preserves the interval and
    // flags verification instead of asserting that either endpoint is certain.
    if (min !== undefined) match.push(`n${index}.upper >= ${bind(min)}`);
    if (max !== undefined) match.push(`n${index}.lower <= ${bind(max)}`);
    where.push(`(${match.join(' AND ')}${includeUnknown ? ` OR n${index}.kind = 'unknown'` : ''})`);
  });
  const limit = numbers.limit ?? 10;
  // Only fields used by numeric predicates need parsing during the inventory
  // scan. Materialize the bounded page before building all response evidence.
  // This avoids ten normalizers per candidate and repeated regex evaluation in
  // a large flattened expression, while preserving identical matching rules.
  const candidateNormalizers = NORMALIZERS.filter((_, index) => constrainedFields.includes(WAREHOUSE_NUMERIC_FIELDS[index].field))
    .map(({ join }) => join).join('\n');
  const result = await client.query<Row>(`WITH candidate_page AS MATERIALIZED (
    SELECT w.id ${BASE_FROM} ${candidateNormalizers}
    WHERE ${where.join(' AND ')} ORDER BY w.id ASC LIMIT ${bind(limit + 1)}
  ) SELECT ${COLUMNS} ${BASE_FROM}
    INNER JOIN candidate_page ON candidate_page.id = w.id
    ${NORMALIZATION_JOINS} ORDER BY w.id ASC`, values);
  const selected = result.rows.slice(0, limit);
  return {
    items: selected.map(row => warehouse(row, constrainedFields)),
    nextCursor: result.rows.length > limit ? String(selected[selected.length - 1].id) : null,
    matching_policy: {
      mode, include_unknown: includeUnknown, range_matching: 'overlap' as const,
      guidance: 'Approximate values and overlapping ranges are provisional candidates. Tell the user that entries marked verification_required need their specifications verified. Unknown fields do not establish suitability; exact numeric properties are null for non-exact evidence.',
    },
  };
}

export async function getWarehouse(client: PoolClient, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) invalid('Warehouse id must be a positive PostgreSQL integer');
  const result = await client.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE w.visibility IS TRUE AND w.id = $1 LIMIT 1`, [id]);
  return result.rows[0] ? warehouse(result.rows[0]) : null;
}

export async function getWarehouseFilterOptions(client: PoolClient, query: URLSearchParams) {
  validateKeys(query, ['city', 'state']);
  const values: unknown[] = [];
  const bind: Bind = value => { values.push(value); return `$${values.length}`; };
  const where = ['w.visibility IS TRUE', ...locationConditions(query, bind)];
  const sources = [
    ...WAREHOUSE_CATEGORY_FIELDS.map(field => ({ name: field.name, expression: 'array' in field ? field.column : `ARRAY[${field.column}]` })),
    ...WAREHOUSE_BOOLEAN_FIELDS.map(field => ({ name: field.name, expression: `ARRAY[CASE WHEN ${field.column} IS TRUE THEN 'true' WHEN ${field.column} IS FALSE THEN 'false' ELSE 'unknown' END]` })),
  ];
  const result = await client.query<Row>(`WITH visible AS MATERIALIZED (
    SELECT ${sources.map(field => `${field.expression} AS "${field.name}"`).join(', ')}
    FROM public."Warehouse" w LEFT JOIN public."WarehouseData" wd ON wd."warehouseId" = w.id WHERE ${where.join(' AND ')}
  ), option_values AS (
    ${sources.map(field => `SELECT '${field.name}' AS field, btrim(value) AS value FROM visible CROSS JOIN LATERAL unnest("${field.name}") AS option(value) WHERE value IS NOT NULL AND length(btrim(value)) BETWEEN 1 AND 80`).join(' UNION ALL ')}
  ), distinct_values AS (
    SELECT field, min(value COLLATE "C") AS value FROM option_values GROUP BY field, lower(value)
  ), ranked AS (
    SELECT field, value, row_number() OVER (PARTITION BY field ORDER BY lower(value) COLLATE "C", value COLLATE "C") AS rank FROM distinct_values
  ) SELECT field, value FROM ranked WHERE rank <= ${OPTION_LIMIT + 1} ORDER BY field, rank`, values);
  const options: Record<string, string[]> = Object.fromEntries(sources.map(field => [field.name, []]));
  let truncated = false;
  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    if (typeof row.field !== 'string' || !Object.hasOwn(options, row.field)) continue;
    counts[row.field] = (counts[row.field] ?? 0) + 1;
    if (counts[row.field] > OPTION_LIMIT) { truncated = true; continue; }
    const value = sanitizeLabel(row.value, 80);
    if (value && LABEL.test(value) && !options[row.field].some(existing => existing.toLowerCase() === value.toLowerCase())) options[row.field].push(value);
  }
  return { catalog: WAREHOUSE_FILTER_CATALOG, options, truncated };
}
