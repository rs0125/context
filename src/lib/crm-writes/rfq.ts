/** RFQ creation policy. New CRM actions get their own schema, scope and mapper. */
import { z } from 'zod';
import { CRM_LEAD_SOURCES, CRM_LEASE_DURATIONS, CRM_NUMBER_PATTERN, CRM_MAGNITUDE_PATTERN, CRM_SQFT_PATTERN, parseCrmArea } from '../crm-fields';
import { capacityUnit } from './capacity';

export const RFQ_SCOPE = 'crm.rfq:write' as const;
export const RFQ_ACTION = 'create_crm_rfq' as const;
// Creation has no existing value to clear. Empty optional text and null mean
// omitted, while meaningful placeholders such as "TBD" remain source data.
const optionalText = (max: number) => z.string().trim().max(max).regex(/^[^\x00-\x1f\x7f]*$/).nullable().optional();
const quote = optionalText(160).describe('Optional supporting excerpt from raw_text. Do not spend extra turns collecting evidence for an optional classification.');
export const rfqInputSchema = z.object({
  operation_id: z.string().uuid().describe('Stable operation UUID. Persist before dispatch and reuse unchanged on recovery. Never replace an uncertain operation.'),
  raw_text: z.string().min(1).max(3000).regex(/^[^\x00]+$/).describe('Entire original user RFQ message, verbatim, including whitespace and #twenty tags. This becomes the CRM description; never summarize or rewrite it. For multiple selected messages join their complete texts with two newlines in source order.'),
  location: optionalText(160).describe('Optional location wording from the brief: city, locality, corridor or alternatives. Omit if unknown; never require it before saving the original brief.'),
  requirement: optionalText(120).describe('Optional space/capacity wording from the brief, including any range, bound or approximation. Informal or incomplete wording is fine; omit if unclear. No quantified size or unit is required to save the brief.'),
  city: optionalText(120).describe('City explicitly supplied in raw_text; omit if only a locality/corridor is known.'),
  micro_market: optionalText(160).describe('Optional locality/corridor from raw_text, including supplied wording such as Anywhere or TBD.'),
  company_name: optionalText(120),
  poc_name: optionalText(120),
  poc_phone: optionalText(40).describe('Original Indian mobile number excerpt, only when supplied for this RFQ. Common separators and explicit 91/+91/0091 prefixes are accepted. International numbers remain in raw_text; no guessed country code or extensions.'),
  budget: optionalText(120).describe('Optional budget wording preserving currency, area basis, period and range. Source fragments may be joined with "; ". Omit if unclear; the full terms remain in the description. Never calculate a total deal value.'),
  lead_source: z.object({ value: z.enum(CRM_LEAD_SOURCES), quote }).strict().nullable().optional(),
  lease_duration: z.object({ value: z.enum(CRM_LEASE_DURATIONS), quote }).strict().nullable().optional(),
  repeat_client: z.object({ value: z.boolean(), quote }).strict().nullable().optional(),
}).strict();
export type RfqInput = z.infer<typeof rfqInputSchema>;
export type NormalizedRfqInput = { [K in keyof RfqInput]: Exclude<RfqInput[K], null> };
const optionalFields = ['location', 'requirement', 'city', 'micro_market', 'company_name', 'poc_name', 'poc_phone', 'budget', 'lead_source', 'lease_duration', 'repeat_client'] as const;
export function normalizeRfqInput(input: RfqInput): NormalizedRfqInput {
  const normalized = { ...input };
  for (const field of optionalFields) {
    if (normalized[field] == null || (typeof normalized[field] === 'string' && !normalized[field].trim())) delete normalized[field];
  }
  return normalized as NormalizedRfqInput;
}

const layout = (value: string) => value.replace(/\s+/gu, ' ').trim();
/** Whole excerpts, never a suffix of a name, number or decimal. */
function sourceExcerpts(source: string, excerpt: string) {
  const full = layout(source), part = layout(excerpt), matches: Array<{ before: string; after: string }> = [];
  if (!part) return matches;
  for (let start = full.indexOf(part); start !== -1; start = full.indexOf(part, start + 1)) {
    const before = full.slice(0, start), after = full.slice(start + part.length);
    if (/[\p{L}\p{N}_]$/u.test(before) && /^[\p{L}\p{N}_]/u.test(part)) continue;
    if (/[\p{L}\p{N}_]$/u.test(part) && /^[\p{L}\p{N}_]/u.test(after)) continue;
    if (/\d[.,]$/.test(before) && /^\d/.test(part)) continue;
    if (/\d$/.test(part) && /^[.,]\d/.test(after)) continue;
    matches.push({ before, after });
  }
  return matches;
}
/** Layout differences are harmless; spelling, punctuation, numbers and units still must match. */
export function hasSourceExcerpt(source: string, excerpt: string): boolean {
  return sourceExcerpts(source, excerpt).length > 0;
}
export const rfqOutputSchema = z.object({
  operation_id: z.string().uuid(),
  outcome: z.enum(['created', 'replayed', 'not_dispatched', 'rejected', 'outcome_unknown']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/), message: z.string().min(1).max(2000),
  data: z.object({ id: z.string().uuid(), stage: z.literal('RFQ_RECEIVED'), url: z.string().url().optional(),
    name: z.string().max(500).optional(), updated_at: z.string().datetime({ offset: true }).max(40).optional(),
    undo_available: z.boolean().optional() }).strict().optional(),
}).strict();
export type RfqResult = z.infer<typeof rfqOutputSchema>;
export type CrmCreator = { id: string; name: string };

const qualifier = '(?:~|≈|approx(?:imately)?\\.?|around|about|circa|at least|at most|up to|upto|over|above|under|below|[<>]=?|min(?:imum)?\\.?|max(?:imum)?\\.?|no less than|not less than|no more than|not more than|more than|less than|between)';
const suffixQualifier = '(?:min(?:imum)?\\.?|max(?:imum)?\\.?|approx(?:imately)?\\.?|at least|at most|or more|or less)';
const precedingQualifier = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${qualifier}\\s*$`, 'iu');
const followingQualifier = new RegExp(`^\\s*${suffixQualifier}(?=$|[^\\p{L}\\p{N}_])(?!\\s+\\d)`, 'iu');
const precedingRange = new RegExp(`${CRM_NUMBER_PATTERN}\\s*(?:${CRM_MAGNITUDE_PATTERN})?\\s*(?:${capacityUnit})?\\s*(?:[-–—]|to)\\s*$`, 'i');
const precedingBetween = new RegExp(`\\bbetween\\s+${CRM_NUMBER_PATTERN}\\s*(?:${CRM_MAGNITUDE_PATTERN})?\\s*(?:${capacityUnit})?\\s+and\\s*$`, 'i');
const followingRange = new RegExp(`^\\s*(?:[-–—]|to)\\s*${CRM_NUMBER_PATTERN}\\s*(?:${CRM_MAGNITUDE_PATTERN})?\\s*${capacityUnit}(?=$|[^\\p{L}\\p{N}_])`, 'iu');

/** Controls optional enrichment only; never prevents capturing the brief. */
function hasCompleteRequirement(source: string, requirement: string): boolean {
  return sourceExcerpts(source, requirement).some(({ before, after }) =>
    !precedingQualifier.test(before) && !followingQualifier.test(after)
    // A label separator ("Area-5000 sqft") is not a negative sign. Numeric
    // range prefixes and standalone signed quantities remain guarded.
    && !/(?:^|[^\p{L}])-$/u.test(before) && !/[+−]$/.test(before)
    && !/^\s*\+\s*(?:$|in\b|at\b|near\b|[,.])/i.test(after)
    && !precedingRange.test(before) && !precedingBetween.test(before) && !followingRange.test(after));
}

/** A brief can be captured without extracting any structured details. */
export function rfqProblems(input: RfqInput): string[] {
  return input.raw_text.trim() ? [] : ['raw_text'];
}

/** Best-effort enrichment only. Unsupported details stay in the original description. */
function rfqEnrichment(submitted: RfqInput): NormalizedRfqInput {
  const input = normalizeRfqInput(submitted);
  for (const field of ['location', 'requirement', 'city', 'micro_market', 'company_name', 'poc_name', 'poc_phone'] as const) {
    const value = input[field];
    if (value !== undefined && !hasSourceExcerpt(input.raw_text, value)) delete input[field];
  }
  // Withhold a detected clipped exact amount; never refuse the whole brief.
  if (input.requirement && parseCrmArea(input.requirement).kind === 'exact'
    && !hasCompleteRequirement(input.raw_text, input.requirement)) delete input.requirement;
  if (input.budget && !input.budget.split('; ').every(fragment => hasSourceExcerpt(input.raw_text, fragment))) delete input.budget;
  for (const field of ['lead_source', 'lease_duration', 'repeat_client'] as const) {
    const evidence = input[field]?.quote;
    if (evidence && !hasSourceExcerpt(input.raw_text, evidence)) delete input[field];
  }
  if (input.poc_phone && (indianPhone(input.poc_phone) === null || !sourceExcerpts(input.raw_text, input.poc_phone)
    .some(({ before }) => !/(?:\+[\d ().-]*|\b00\d[\d ().-]*|\b91[ ().-]*)$/.test(before))))
    delete input.poc_phone;
  return input;
}
export function indianPhone(raw: string): string | null {
  if (!/^[+\d ().\s-]+$/.test(raw)) return null;
  const compact = raw.replace(/[ ().\s-]/g, '');
  const national = compact.startsWith('+91') ? compact.slice(3)
    : compact.startsWith('0091') ? compact.slice(4)
      : /^91\d{10}$/.test(compact) ? compact.slice(2) : compact;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

export function rfqPayload(submitted: RfqInput, creator: CrmCreator): Record<string, unknown> {
  const input = rfqEnrichment(submitted);
  const payload: Record<string, unknown> = {
    name: [input.company_name, input.requirement, input.location ?? input.city ?? input.micro_market].filter(Boolean).join(' - ') || 'New RFQ',
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
  if (input.requirement && area.kind === 'exact' && area.value !== null && new RegExp(`${CRM_SQFT_PATTERN}$`, 'i').test(input.requirement)) payload.requirementInSft = area.value;
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
