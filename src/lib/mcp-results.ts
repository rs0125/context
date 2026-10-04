import { WAREHOUSE_NUMERIC_FIELDS } from './warehouse-fields';
import type { RedactedCrmText } from './crm-redaction';

const SUMMARY_FIELDS = ['id', 'city', 'state', 'micromarkets', 'warehouse_type', 'total_space_sqft',
  'asking_rate_per_sqft', 'dock_count', 'clear_height_ft', 'availability', 'verified',
  'fire_noc_available', 'flooring_type', 'land_type', 'pollution_zone', 'suitable_for',
  'status', 'zone', 'listing_type', 'water_supply', 'lift_access',
  'image_count', 'video_count', 'has_valid_google_maps_id',
  'created_at', 'updated_at', 'verification_required'] as const;
const SUMMARY_EVIDENCE = new Set(['asking_rate_per_sqft', 'dock_count', 'clear_height_ft']);

/** The detail endpoint returns longer excerpts. Search still shows which messy
 * factors are recorded and a safe preview, so the agent can choose useful reads. */
function contextPreview(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, RedactedCrmText>)
    .filter(([, field]) => field.state !== 'missing')
    .map(([name, field]) => [name, field.text && Array.from(field.text).length > 160
      ? { ...field, state: 'truncated', text: Array.from(field.text).slice(0, 160).join(''), truncated: true }
      : field]));
}

/** Projection happens after the API's permissions, privacy and evidence mapping.
 * Preserve every estimate/range that triggered verification, plus evidence for
 * all requested measurements. Omitted fields must be obtained by a detail read. */
export function compactWarehouseResults(data: Record<string, unknown>, filters: Record<string, unknown>) {
  const requested = new Set(WAREHOUSE_NUMERIC_FIELDS.filter(field =>
    filters[field.minParam] !== undefined || filters[field.maxParam] !== undefined).map(field => field.field));
  return { ...data, response_format: 'concise', items: (data.items as Record<string, unknown>[]).map(item => {
    const fullEvidence = item.field_evidence as Record<string, { kind: string; recorded_source?: RedactedCrmText }>;
    const field_evidence = Object.fromEntries(Object.entries(fullEvidence).filter(([field, evidence]) =>
      SUMMARY_EVIDENCE.has(field) || requested.has(field) || evidence.kind === 'range' || evidence.kind === 'approximate'
      || (evidence.recorded_source && evidence.recorded_source.state !== 'missing')));
    return { ...Object.fromEntries(SUMMARY_FIELDS.map(field => [field, item[field]])),
      ...Object.fromEntries([...requested].map(field => [field, item[field]])), field_evidence,
      ...(item.recorded_context ? { recorded_context: contextPreview(item.recorded_context) } : {}) };
  }) };
}

export function compactWarehouseFilters(data: Record<string, unknown>) {
  const { catalog: _catalog, ...options } = data;
  return options;
}
