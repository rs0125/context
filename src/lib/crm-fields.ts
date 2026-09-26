import { redactCrmText, type RedactedCrmText } from './crm-redaction';

/** Business classifications from Twenty's opportunity schema. These are recorded
 * values, not proof of a client-confirmed requirement: upstream parsing can apply
 * defaults. Only documented values enter typed categories; unknown values are
 * preserved separately as bounded, contact-masked source evidence.
 */
export const CRM_LEAD_SOURCES = [
  'OUTREACH', 'WEBSITE_SEO', 'WHATSAPP_INBOUND', 'EXISTING_CLIENT',
  'CLIENT_OWNER_REFERRAL', 'GODAMWALE', 'GW_REACTIVATION', 'BROKER',
  'TOLET_BOARDS', 'WEBSITE_GOOGLE_ADS',
] as const;
export const CRM_LEASE_DURATIONS = ['LONG_TERM', 'SHORT_TERM'] as const;
export const CRM_INDUSTRIES = [
  'OPT3PL_LOGISTICS', 'D2C_E_COMMERCE', 'ELECTRONICS_TECH', 'AUTO_AUTO_ANCILLIARY',
  'FMCG', 'TEXTILE_APPAREL', 'MANUFACTURING', 'OTHER',
] as const;
export const CRM_OCCUPANCY_TIMELINES = ['WITHIN_30_DAYS', 'OPT31_90_DAYS', 'OPT91_180_DAYS'] as const;
export const CRM_LANGUAGES = [
  'ENGLISH', 'HINDI', 'TAMIL', 'TELUGU', 'KANNADA', 'BENGALI',
  'GUJARATI', 'MARATHI', 'MALAYALAM', 'KONKANI',
] as const;
export const CRM_ENUM_ARRAY_LIMIT = 32;

export type CrmLeadSource = typeof CRM_LEAD_SOURCES[number];
export type CrmLeaseDuration = typeof CRM_LEASE_DURATIONS[number];
export type CrmIndustry = typeof CRM_INDUSTRIES[number];
export type CrmOccupancyTimeline = typeof CRM_OCCUPANCY_TIMELINES[number];
export type CrmLanguage = typeof CRM_LANGUAGES[number];

export type CrmBudget = {
  kind: 'exact' | 'range' | 'upper_bound' | 'lower_bound' | 'unknown';
  value: number | null;
  min: number | null;
  max: number | null;
  currency: 'INR' | null;
  period: 'month' | 'year' | null;
  area_basis: 'sqft' | 'acre' | null;
  bound_inclusive?: boolean;
  verification_required: true;
};

/** Amounts are decimal strings to avoid introducing float rounding. This is a
 * recorded opportunity value, not revenue, collected money or brokerage income.
 */
export type CrmRecordedValue = {
  amount_micros: string;
  amount: string;
  currency_code: string | null;
  verification_required: true;
};

export type RichCrmFields = {
  lead_source: CrmLeadSource | null;
  lease_duration: CrmLeaseDuration | null;
  industry_verticals: CrmIndustry[] | null;
  occupancy_timelines: CrmOccupancyTimeline[] | null;
  preferred_languages: CrmLanguage[] | null;
  repeat_client: boolean | null;
  budget: CrmBudget | null;
  recorded_value: CrmRecordedValue | null;
  field_evidence: Record<string, CrmFieldEvidence>;
};

export type CrmFieldEvidence = {
  state: 'missing' | 'parsed' | 'unsupported';
  source: RedactedCrmText | null;
};

export type CrmAreaEvidence = CrmFieldEvidence & {
  kind: 'exact' | 'range' | 'approximate' | 'unknown';
  value: number | null;
  min: number | null;
  max: number | null;
  verification_required: true;
};

// Shared with SQL filters. Captures in CRM_AREA_PATTERN: 1 approximation marker,
// 2 first number, 3 first magnitude, 4 second number, 5 second magnitude. The
// right magnitude applies to both bounds when the left has none (20-30k).
export const CRM_NUMERIC_TEXT_LIMIT = 160;
export const CRM_NUMBER_PATTERN = '(?:[0-9]{1,3}(?:,[0-9]{2})*,[0-9]{3}|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?';
export const CRM_MAGNITUDE_PATTERN = '(?:thousand|million|crores?|lakhs?|lacs?|cr|k|l|m)(?=$|\\s|[-–—/]|(?:to|sqft|sft)(?=$|[^A-Za-z]))';
export const CRM_MAGNITUDE_MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1000, thousand: 1000, l: 100000, lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000,
  m: 1000000, million: 1000000, cr: 10000000, crore: 10000000, crores: 10000000,
};
export const CRM_SQFT_PATTERN = '(?:sq\\.?\\s*ft\\.?|sqft|sft|sq\\s*feet|square\\s*(?:feet|foot)|ft2|ft²)';
export const CRM_AREA_PATTERN = `^(?:(~|≈|approx(?:imately)?\\.?|around|about|circa)\\s*)?(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?(?:\\s*(?:-|–|—|to)\\s*(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?)?\\s*(?:${CRM_SQFT_PATTERN})?$`;
const AREA_AMOUNT = new RegExp(CRM_AREA_PATTERN, 'i');

function missing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
}

function sourceText(value: unknown): RedactedCrmText {
  // Flat enum arrays may contain unknown classifications; expose only their
  // visible strings, never arbitrary object serialization or nested payloads.
  if (Array.isArray(value)) {
    if (value.length <= CRM_ENUM_ARRAY_LIMIT && value.every(item => typeof item === 'string')) return redactCrmText(value.join(', '), { maxCharacters: 500 });
    return { state: 'unsupported', text: null, redacted: false, truncated: false };
  }
  return redactCrmText(typeof value === 'number' && Number.isFinite(value) ? String(value) : value, { maxCharacters: 500 });
}

function evidence(value: unknown, parsed: boolean, includeSource = false): CrmFieldEvidence {
  if (missing(value)) return { state: 'missing', source: null };
  return { state: parsed ? 'parsed' : 'unsupported', source: !parsed || includeSource ? sourceText(value) : null };
}

function multipliedNumber(value: string, magnitude: string | undefined, requireInteger: boolean): number | null {
  const multiplier = magnitude ? CRM_MAGNITUDE_MULTIPLIERS[magnitude.toLowerCase()] : 1;
  if (multiplier === undefined) return null;
  const [whole, fraction = ''] = value.replaceAll(',', '').split('.');
  // Integer area validation happens before float conversion, so 40000 plus an
  // arbitrarily tiny fractional tail is never silently rounded to 40000 sqft.
  const numerator = BigInt(whole + fraction) * BigInt(multiplier);
  const denominator = 10n ** BigInt(fraction.length);
  if (requireInteger && numerator % denominator !== 0n) return null;
  if (numerator <= 0n || numerator > 1_000_000_000n * denominator) return null;
  const parsed = Number(numerator) / Number(denominator);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000_000 ? parsed : null;
}

/** Recorded requirement units are sqft. This does not extract or infer a
 * requirement from an unrelated description, lead title or warehouse record.
 */
export function parseCrmArea(value: unknown): CrmAreaEvidence {
  const initial: CrmAreaEvidence = { ...evidence(value, false, true), kind: 'unknown', value: null, min: null, max: null, verification_required: true };
  if (missing(value)) return initial;
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || raw.length > CRM_NUMERIC_TEXT_LIMIT || /[\x00-\x1f\x7f]/.test(raw)) return initial;
  const match = AREA_AMOUNT.exec(raw.replace(/^ +| +$/g, ''));
  if (!match) return initial;
  const first = multipliedNumber(match[2], match[3] ?? match[5], true);
  const second = match[4] === undefined ? null : multipliedNumber(match[4], match[5], true);
  if (first === null || (match[4] !== undefined && (second === null || second < first))) return initial;
  // A qualified range is still a range, with verification required; do not
  // collapse it into an apparently exact scalar.
  return { ...initial, state: 'parsed', kind: second !== null ? 'range' : match[1] ? 'approximate' : 'exact',
    value: second === null ? first : null, min: second === null ? null : first, max: second };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null;
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(value) || !value.length || value.length > CRM_ENUM_ARRAY_LIMIT) return null;
  const result = new Set<T>();
  for (const item of value) {
    const parsed = enumValue(item, allowed);
    // A partially accepted multi-select would silently misrepresent the record.
    if (parsed === null) return null;
    result.add(parsed);
  }
  return [...result];
}

function repeatClient(value: unknown): boolean | null {
  const values = enumArray(value, ['OPTION1', 'NO'] as const);
  return values?.length === 1 ? values[0] === 'OPTION1' : null;
}

const BUDGET_CURRENCY = '(?:INR|₹|Rs\\.?|rupees?)';
const BUDGET_AMOUNT = new RegExp(`^(?:(<=|>=|<|>|under|below|over|above|up to|at most|at least)\\s*)?(?:(${BUDGET_CURRENCY})\\s*)?(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?(?:\\s*(?:-|–|—|to)\\s*(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?)?(?:\\s*(${BUDGET_CURRENCY}))?(.*)$`, 'i');
const AREA_UNIT = new RegExp(`^(?:psf|(?:per\\s+|/\\s*)(${CRM_SQFT_PATTERN}|acres?))(?=$|\\s|/)`, 'i');
const PERIOD_UNIT = /^(?:(monthly|yearly|annually)|(?:per\s+|\/\s*)(month|mo|mth|year|yr|annum))(?=$|\s|\/)/i;

function budget(value: unknown): CrmBudget | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const unknown: CrmBudget = {
    kind: 'unknown', value: null, min: null, max: null,
    currency: null, period: null, area_basis: null, verification_required: true,
  };
  // Accept only a complete monetary expression. An unparsed suffix, contact,
  // instruction, mixed currency or malformed range withholds the entire value.
  if (typeof value !== 'string' || value.length > CRM_NUMERIC_TEXT_LIMIT || /[\x00-\x1f\x7f]/.test(value)) return unknown;
  const match = BUDGET_AMOUNT.exec(value.trim());
  if (!match || (match[2] && match[7]) || (match[1] && match[5])) return unknown;
  const first = multipliedNumber(match[3], match[4] ?? match[6], false);
  const second = match[5] === undefined ? null : multipliedNumber(match[5], match[6], false);
  if (first === null || (match[5] !== undefined && (second === null || second < first))) return unknown;

  let remainder = match[8].trim();
  let areaBasis: 'sqft' | 'acre' | null = null;
  let period: 'month' | 'year' | null = null;
  // There can be at most one area basis and one period, in either order.
  for (let index = 0; remainder && index < 2; index += 1) {
    const area = AREA_UNIT.exec(remainder);
    if (area && areaBasis === null) {
      areaBasis = /^acre/i.test(area[1] ?? '') ? 'acre' : 'sqft';
      remainder = remainder.slice(area[0].length).trim();
      continue;
    }
    const time = PERIOD_UNIT.exec(remainder);
    if (!time || period !== null) return unknown;
    period = /^(?:month|mo$|mth)/i.test(time[1] ?? time[2]) ? 'month' : 'year';
    remainder = remainder.slice(time[0].length).trim();
  }
  if (remainder) return unknown;
  const bound = match[1]?.toLowerCase();
  const upper = bound !== undefined && ['<', '<=', 'under', 'below', 'up to', 'at most'].includes(bound);
  return {
    kind: bound ? upper ? 'upper_bound' : 'lower_bound' : second === null ? 'exact' : 'range',
    value: !bound && second === null ? first : null,
    min: bound ? upper ? null : first : second === null ? null : first,
    max: bound && upper ? first : second,
    currency: match[2] || match[7] ? 'INR' : null,
    period,
    area_basis: areaBasis,
    ...(bound ? { bound_inclusive: ['<=', '>=', 'up to', 'at most', 'at least'].includes(bound) } : {}),
    verification_required: true,
  };
}

function recordedValue(microsValue: unknown, currencyValue: unknown): CrmRecordedValue | null {
  // JSON numbers outside this range may already have lost precision before the
  // read. Refuse them even if the PostgreSQL text representation looks integral.
  if (typeof microsValue !== 'number' && typeof microsValue !== 'string') return null;
  if (typeof microsValue === 'number' && (!Number.isSafeInteger(microsValue) || microsValue < 0)) return null;
  if (typeof microsValue === 'string' && !/^\d{1,16}$/.test(microsValue)) return null;
  const micros = BigInt(microsValue);
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return {
    amount_micros: micros.toString(),
    amount: `${whole}${fraction ? `.${fraction}` : ''}`,
    currency_code: typeof currencyValue === 'string' && /^[A-Z]{3}$/.test(currencyValue) ? currencyValue : null,
    verification_required: true,
  };
}

/** Map aliases selected from the same opportunity row as the core lead fields.
 * No extra fetch, transitive lookup or arbitrary JSON traversal belongs here.
 */
export function richCrmFields(row: Record<string, unknown>): RichCrmFields {
  const fields = {
    lead_source: enumValue(row.lead_source, CRM_LEAD_SOURCES),
    lease_duration: enumValue(row.lease_duration, CRM_LEASE_DURATIONS),
    industry_verticals: enumArray(row.industry_verticals, CRM_INDUSTRIES),
    occupancy_timelines: enumArray(row.occupancy_timelines, CRM_OCCUPANCY_TIMELINES),
    preferred_languages: enumArray(row.preferred_languages, CRM_LANGUAGES),
    repeat_client: repeatClient(row.repeat_client),
    budget: budget(row.budget),
    recorded_value: recordedValue(row.amount_micros, row.amount_currency),
  };
  return { ...fields, field_evidence: {
    ...Object.fromEntries(['lead_source', 'lease_duration', 'industry_verticals', 'occupancy_timelines', 'preferred_languages', 'repeat_client'].map(field =>
      [field, evidence(row[field], fields[field as keyof typeof fields] !== null)])),
    budget: evidence(row.budget, fields.budget !== null && fields.budget.kind !== 'unknown', true),
    recorded_value: evidence(row.amount_micros, fields.recorded_value !== null),
    recorded_currency: evidence(row.amount_currency, fields.recorded_value?.currency_code !== null && fields.recorded_value?.currency_code !== undefined),
  } };
}
