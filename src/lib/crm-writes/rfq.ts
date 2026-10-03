/** RFQ creation policy. New CRM actions get their own schema, scope and mapper. */
import { z } from 'zod';
import { CRM_LEAD_SOURCES, CRM_LEASE_DURATIONS, CRM_NUMBER_PATTERN, CRM_MAGNITUDE_PATTERN, CRM_MAGNITUDE_MULTIPLIERS, CRM_SQFT_PATTERN, parseCrmArea } from '../crm-fields';

export const RFQ_SCOPE = 'crm.rfq:write' as const;
export const RFQ_ACTION = 'create_crm_rfq' as const;
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
const quote = text(160).describe('Exact supporting excerpt from raw_text. Do not infer a missing value.');
export const rfqInputSchema = z.object({
  operation_id: z.string().uuid().describe('Stable operation UUID. Persist before dispatch and reuse unchanged on recovery. Never replace an uncertain operation.'),
  raw_text: z.string().min(1).max(3000).regex(/^[^\x00]+$/).describe('Entire original user RFQ message, verbatim, including whitespace and #twenty tags. This becomes the CRM description; never summarize or rewrite it. For multiple selected messages join their complete texts with two newlines in source order.'),
  location: text(160).describe('Exact location excerpt from raw_text: a city, locality, corridor or alternatives. Required. Never infer a city from a locality.'),
  requirement: text(120).describe('Exact quantified space/capacity excerpt including its unit, e.g. 25,000-35,000 sqft or 100 pallets. Required; do not turn ranges into a single value.'),
  city: text(120).optional().describe('City explicitly supplied in raw_text; omit if only a locality/corridor is known.'),
  micro_market: text(160).optional().describe('Explicit locality/corridor excerpt from raw_text.'),
  company_name: text(120).optional(),
  poc_name: text(120).optional(),
  poc_phone: text(40).optional().describe('Exact Indian phone excerpt, only when supplied for this RFQ. International numbers remain in raw_text; no guessed country code.'),
  budget: text(120).optional().describe('Exact budget excerpt preserving currency, units, period and range. Never calculate total deal value.'),
  lead_source: z.object({ value: z.enum(CRM_LEAD_SOURCES), quote }).strict().optional(),
  lease_duration: z.object({ value: z.enum(CRM_LEASE_DURATIONS), quote }).strict().optional(),
  repeat_client: z.object({ value: z.boolean(), quote }).strict().optional(),
}).strict();
export type RfqInput = z.infer<typeof rfqInputSchema>;
export const rfqOutputSchema = z.object({
  operation_id: z.string().uuid(),
  outcome: z.enum(['created', 'replayed', 'not_dispatched', 'rejected', 'outcome_unknown']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/), message: z.string().min(1).max(2000),
  data: z.object({ id: z.string().uuid(), stage: z.literal('RFQ_RECEIVED') }).strict().optional(),
}).strict();
export type RfqResult = z.infer<typeof rfqOutputSchema>;
export type CrmCreator = { id: string; name: string };

const placeholder = /^(?:tbd|tbc|unknown|not\s+(?:known|available|provided|mentioned|specified)|n\/?a|none|nil|anywhere|any\s+(?:city|location)|india|pan[ -]?india|[-?]+)$/i;
const capacityUnit = `(?:${CRM_SQFT_PATTERN}|sq\\.?\\s*m\\.?|sqm|m²|square\\s*met(?:er|re)s?|acres?|pallets?|(?:metric\\s*)?ton(?:ne)?s?|mt|cbm|m³|cubic\\s*met(?:er|re)s?|containers?)`;
const capacity = new RegExp(`^(?:(?:~|≈|approx(?:imately)?\\.?|around|about)\\s*)?(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?(?:\\s*(?:-|–|—|to)\\s*(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?)?\\s*(${capacityUnit})$`, 'i');
function capacityValid(value: string) {
  const match = capacity.exec(value);
  if (!match) return false;
  const quantity = (raw: string, magnitude?: string) => Number(raw.replaceAll(',', '')) * (magnitude ? CRM_MAGNITUDE_MULTIPLIERS[magnitude.toLowerCase()] : 1);
  const first = quantity(match[1], match[2] ?? match[4]);
  const second = match[3] ? quantity(match[3], match[4]) : first;
  return Number.isFinite(first) && Number.isFinite(second) && first > 0 && second >= first && second <= 1_000_000_000;
}

/** Return actionable missing/invalid field names without echoing private input. */
export function rfqProblems(input: RfqInput): string[] {
  const issues: string[] = [];
  if (!input.raw_text.trim()) issues.push('raw_text');
  if (placeholder.test(input.location) || !/\p{L}/u.test(input.location)) issues.push('location');
  if (!capacityValid(input.requirement)) issues.push('requirement (positive quantity and explicit unit)');
  for (const field of ['location', 'requirement', 'city', 'micro_market', 'company_name', 'poc_name', 'poc_phone', 'budget'] as const) {
    const value = input[field];
    if (value !== undefined && (placeholder.test(value) || !input.raw_text.includes(value))) issues.push(`${field} (verbatim source required)`);
  }
  for (const field of ['lead_source', 'lease_duration', 'repeat_client'] as const) {
    if (input[field] && !input.raw_text.includes(input[field].quote)) issues.push(`${field} (supporting source required)`);
  }
  if (input.poc_phone && indianPhone(input.poc_phone) === null) issues.push('poc_phone (unambiguous Indian number)');
  return [...new Set(issues)];
}
function indianPhone(raw: string): string | null {
  if (!/^[+\d ()-]+$/.test(raw)) return null;
  const compact = raw.replace(/[ ()-]/g, '');
  const national = compact.startsWith('+91') ? compact.slice(3) : compact;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

export function rfqPayload(input: RfqInput, creator: CrmCreator): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: `${input.company_name ?? 'TBD'} - ${input.requirement} - ${input.location}`,
    description: input.raw_text,
    stage: 'RFQ_RECEIVED',
    createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name },
    ownerId: creator.id,
  };
  for (const [from, to] of [['company_name', 'companyName'], ['city', 'city'], ['micro_market', 'microMarket'], ['budget', 'budget']] as const) {
    if (input[from] !== undefined) payload[to] = input[from];
  }
  // Twenty's field is an integer, NOT text. Ranges, approximations and other
  // capacity units remain losslessly in the title/description, never collapsed.
  const area = parseCrmArea(input.requirement);
  if (area.kind === 'exact' && area.value !== null && new RegExp(`${CRM_SQFT_PATTERN}$`, 'i').test(input.requirement)) payload.requirementInSft = area.value;
  if (input.poc_name) {
    const [firstName, ...rest] = input.poc_name.split(/\s+/);
    payload.pocName = { firstName, lastName: rest.join(' ') };
  }
  if (input.poc_phone) payload.pocPhoneNumber = { primaryPhoneNumber: indianPhone(input.poc_phone), primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN' };
  if (input.lead_source) payload.leadSource = input.lead_source.value;
  if (input.lease_duration) payload.duration = input.lease_duration.value;
  if (input.repeat_client) payload.repeatClient = [input.repeat_client.value ? 'OPTION1' : 'NO'];
  return payload;
}
