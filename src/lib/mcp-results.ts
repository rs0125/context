import { WAREHOUSE_NUMERIC_FIELDS } from './warehouse-fields';

const SUMMARY_FIELDS = ['id', 'city', 'state', 'micromarkets', 'warehouse_type', 'total_space_sqft',
  'offered_space_sqft', 'asking_rate_per_sqft', 'dock_count', 'clear_height_ft', 'availability', 'verified',
  'created_at', 'updated_at', 'verification_required'] as const;
const SUMMARY_EVIDENCE = new Set(['offered_space_sqft', 'asking_rate_per_sqft', 'dock_count', 'clear_height_ft']);

/** Projection happens after the API's permissions, privacy and evidence mapping.
 * Preserve every estimate/range that triggered verification, plus evidence for
 * all requested measurements. Omitted fields must be obtained by a detail read. */
export function compactWarehouseResults(data: Record<string, unknown>, filters: Record<string, unknown>) {
  const requested = new Set(WAREHOUSE_NUMERIC_FIELDS.filter(field =>
    filters[field.minParam] !== undefined || filters[field.maxParam] !== undefined).map(field => field.field));
  return { ...data, response_format: 'concise', items: (data.items as Record<string, unknown>[]).map(item => {
    const fullEvidence = item.field_evidence as Record<string, { kind: string }>;
    const field_evidence = Object.fromEntries(Object.entries(fullEvidence).filter(([field, evidence]) =>
      SUMMARY_EVIDENCE.has(field) || requested.has(field) || evidence.kind === 'range' || evidence.kind === 'approximate'));
    return { ...Object.fromEntries(SUMMARY_FIELDS.map(field => [field, item[field]])),
      ...Object.fromEntries([...requested].map(field => [field, item[field]])), field_evidence };
  }) };
}

export function compactWarehouseFilters(data: Record<string, unknown>) {
  const { catalog: _catalog, ...options } = data;
  return options;
}
