import { redactCrmText, type RedactedCrmText } from './crm-redaction';

const MAX_INPUT = 100_000;
const MAX_FIELD_TEXT_BYTES = 600;
export const WAREHOUSE_SELECTED_FIELD_TEXT_MAX_BYTES = 4000;
export const WAREHOUSE_RECORDED_CONTEXT_MAX_BYTES = 6000;
export const WAREHOUSE_NUMERIC_SOURCE_MAX_BYTES = 240;

/** Deliberately excludes identities, private commercial terms, notes and media.
 * These are recorded property facts, not verified specifications or instructions.
 */
export const WAREHOUSE_RECORDED_FIELDS = [
  { field: 'compliances', column: 'w.compliances' },
  { field: 'other_specifications', column: 'w."otherSpecifications"' },
  { field: 'fire_safety_measures', column: 'wd."fireSafetyMeasures"' },
  { field: 'fire_exits', column: 'w.fire_exits' },
  { field: 'fire_compliance_cert_type', column: 'w.fire_compliance_cert_type' },
  { field: 'floor_strength_per_sqm', column: 'w."floorStrengthPerSqm"' },
  { field: 'centre_height', column: 'w."centreHeight"' },
  { field: 'dimensions', column: 'wd.dimensions' },
  { field: 'parking_docking_space', column: 'wd."parkingDockingSpace"' },
  { field: 'dock_dimension', column: 'w."dockDimension"' },
  { field: 'dock_platform_type', column: 'w."dockPlatformType"' },
  { field: 'canopy_type', column: 'w."canopyType"' },
  { field: 'other_docking_specs', column: 'w."otherDockingSpecs"' },
  { field: 'ventilation_type', column: 'w."ventilationType"' },
  { field: 'ventilation_air_changes_per_day', column: 'w."ventilationAirChangesPerDay"' },
  { field: 'insulation_present', column: 'w."insulationPresent"' },
  { field: 'insulation_type', column: 'w."insulationType"' },
  { field: 'lighting_details', column: 'w."lightingDetails"' },
  { field: 'builtup_area', column: 'w.builtup_area' },
  { field: 'carpet_area', column: 'w.carpet_area' },
  { field: 'chargeable_area', column: 'w."chargeableArea"' },
  { field: 'total_floors', column: 'w."totalFloors"' },
  { field: 'passenger_lift_count', column: 'w."passengerLiftCount"' },
  { field: 'service_lift_count', column: 'w."serviceLiftCount"' },
  { field: 'lift_load_capacity', column: 'w."liftLoadCapacity"' },
  { field: 'handover_type', column: 'w."handoverType"' },
  { field: 'handover_lead_value', column: 'w."handoverLeadValue"' },
  { field: 'handover_lead_unit', column: 'w."handoverLeadUnit"' },
] as const;

export type WarehouseRecordedFieldName = typeof WAREHOUSE_RECORDED_FIELDS[number]['field'];
export const WAREHOUSE_RECORDED_FIELD_NAMES = WAREHOUSE_RECORDED_FIELDS.map(({ field }) => field);
export type WarehouseRecordedContext = Record<string, RedactedCrmText>;

/** The marker is deliberately non-text, so the mapper reports unsupported.
 * Never transfer an arbitrarily large value or a prefix cut through a contact.
 * Callers supply only application-owned SQL column identifiers.
 */
export function warehouseRecordedValueSql(column: string) {
  return `CASE WHEN length(${column}::text) > ${MAX_INPUT} THEN '{"unsupported":true}'::jsonb ELSE to_jsonb(${column}) END`;
}

export const WAREHOUSE_RECORDED_CONTEXT_SELECT = `jsonb_build_object(${WAREHOUSE_RECORDED_FIELDS.map(({ field, column }) =>
  `'${field}', ${warehouseRecordedValueSql(column)}`
).join(', ')}) AS recorded_context`;

function serializedBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

/** Account for UTF-8 and JSON escaping rather than assuming one byte per char.
 * Truncate only the already-redacted view, and preserve complete code points.
 */
function boundText(value: RedactedCrmText, maxTextBytes: number): RedactedCrmText {
  if (value.text === null || serializedBytes(value.text) <= maxTextBytes) return value;
  const points = Array.from(value.text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(points.slice(0, middle).join('')) <= maxTextBytes) low = middle;
    else high = middle - 1;
  }
  return { state: 'truncated', text: points.slice(0, low).join('').trimEnd() || null, redacted: value.redacted, truncated: true };
}

/** Uses the CRM contact/markup redactor plus narrow identifying clauses found
 * in copied property fields. This is a bounded view, not a general PII proof.
 * A specification such as "owner to install an additional dock" is retained.
 */
export function redactWarehouseRecordedSource(value: unknown, maxTextBytes = MAX_FIELD_TEXT_BYTES): RedactedCrmText {
  const input = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  // Use the redactor's largest output window before applying the smaller wire
  // budget: contact matching must see the complete supported source first.
  const source = redactCrmText(input, { maxCharacters: 12_000 });
  if (source.text === null) return source;
  let omitted = false;
  const omit = () => { omitted = true; return '[content omitted]'; };
  const namedTarget = (text: string) => /^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,4}(?:\s|$)/u.test(text);
  const text = source.text
    .replace(/\b(?:negotiated\s+(?:rent|rental|rate)\b\s*[:=]?|(?:private|internal|scout)\s+notes?\b\s*[:=]?|(?:negotiated|private)\s*[:=])[^;\n]*/giu, omit)
    .replace(/\b(?:owner|landlord|broker|contact(?: person)?|poc)\s*(?:(?:name(?:d)?|at)\b\s*[:=-]?\s*|[:=]\s*|(?:is\s+)?(?:mr|mrs|ms|dr|shri|smt)\b[.]?\s*)[^;\n]*/giu, omit)
    .replace(/\b(?:owner|landlord|broker|poc)\s+is\s+([^;\n]*)/giu, (whole, target: string) => {
      if (/^(?:installing|providing|adding|arranging|responsible|ready|willing|going|to)\b/iu.test(target)) return whole;
      return namedTarget(target) ? omit() : whole;
    })
    .replace(/\b(?:call|contact|reach(?: out to)?)\s+([^;\n]*)/giu, (whole, target: string) => {
      // These words also name equipment and operating procedures. Require a
      // contact target before masking, rather than removing every action verb.
      if (/^(?:bell|bells|button|buttons|point|points|alarm|alarms|system|systems|resistance|area|surface|surfaces|truck|trucks|stacker|stackers|height|distance|before|after|ahead)\b/iu.test(target)) return whole;
      const contactTarget = /^(?:(?:the\s+)?(?:owner|landlord|broker|contact|poc)|mr|mrs|ms|dr|shri|smt|me|us|him|her|at|on|via)\b|^\[(?:phone|email|contact|link) omitted\]/iu.test(target);
      return contactTarget || namedTarget(target) ? omit() : whole;
    });
  return boundText({ ...source, text, redacted: source.redacted || omitted,
    state: source.truncated ? 'truncated' : source.redacted || omitted ? 'redacted' : source.state }, maxTextBytes);
}

export function warehouseRecordedContext(value: unknown, fields?: readonly WarehouseRecordedFieldName[]): WarehouseRecordedContext {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const selected = fields === undefined ? WAREHOUSE_RECORDED_FIELDS : WAREHOUSE_RECORDED_FIELDS.filter(({ field }) => fields.includes(field));
  const perFieldBudget = fields === undefined ? MAX_FIELD_TEXT_BYTES : WAREHOUSE_SELECTED_FIELD_TEXT_MAX_BYTES;
  const context = Object.fromEntries(selected.map(({ field }) =>
    [field, redactWarehouseRecordedSource(row[field], perFieldBudget)]));
  // Keep every selected field's state, including missing/unsupported, while sharing one
  // serialized budget. Earlier fields retain text first when a record is large.
  for (const { field } of [...selected].reverse()) {
    const excess = serializedBytes(context) - WAREHOUSE_RECORDED_CONTEXT_MAX_BYTES;
    if (excess <= 0) break;
    const source = context[field];
    if (source.text === null) continue;
    const truncated = { ...source, state: 'truncated' as const, truncated: true };
    const metadataGrowth = serializedBytes(truncated) - serializedBytes(source);
    context[field] = boundText(truncated, Math.max(2, serializedBytes(source.text) - excess - metadataGrowth));
  }
  return context;
}
