import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { redactCrmText } from './crm-redaction';

export const ANALYTICS_PERIODS = ['today', 'yesterday', 'last_7_days', 'last_28_days', 'this_month', 'last_month'] as const;
export const GA4_REPORT_PRESETS = ['overview', 'daily', 'acquisition', 'landing_pages', 'pages', 'devices', 'countries', 'events', 'warehouse_interest', 'lead_sources', 'first_visits', 'form_submissions'] as const;
export const SEARCH_CONSOLE_GROUPS = ['summary', 'date', 'query', 'page', 'query_page', 'country', 'device'] as const;
const COMMON = ['period', 'date_from', 'date_to', 'limit', 'cursor', 'compare_to', 'device', 'country'] as const;
export const GA4_QUERY_PARAMETER_NAMES = ['report', 'event_name', 'landing_page_contains', 'page_path_contains', 'channel', 'source', ...COMMON] as const;
export const SEARCH_CONSOLE_QUERY_PARAMETER_NAMES = ['group', 'query_contains', 'query_equals', 'query_not_contains', 'page_contains', 'page_equals', 'data_state', ...COMMON] as const;
export const ANALYTICS_MAX_ROWS = 500;
const DAY = 86_400_000;
export function invalidAnalyticsQuery(message: string): never { throw new HttpError(400, 'INVALID_QUERY', message); }
export type AnalyticsPeriod = typeof ANALYTICS_PERIODS[number];
type DateQuery = { period: AnalyticsPeriod | null; date_from: string | null; date_to: string | null; limit: number; cursor: string | null };
type SegmentQuery = { compare_to: 'previous_period' | null; device: 'desktop' | 'mobile' | 'tablet' | null; country: string | null };
export type Ga4Query = DateQuery & SegmentQuery & { report: typeof GA4_REPORT_PRESETS[number]; event_name: string | null;
  landing_page_contains: string | null; page_path_contains: string | null; channel: string | null; source: string | null };
export type SearchConsoleQuery = DateQuery & SegmentQuery & { group: typeof SEARCH_CONSOLE_GROUPS[number]; query_contains: string | null;
  query_equals: string | null; query_not_contains: string | null; page_contains: string | null; page_equals: string | null; data_state: 'final' | 'all' };

function parameters(query: URLSearchParams, allowed: readonly string[]) {
  if (query.toString().length > 4096) invalidAnalyticsQuery('Analytics query is too long.');
  const seen = new Set<string>();
  for (const [name] of query) {
    if (!allowed.includes(name) || seen.has(name)) invalidAnalyticsQuery('Unknown or duplicate analytics query parameter.');
    seen.add(name);
  }
}
export function analyticsCalendar(value: string): number {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) invalidAnalyticsQuery('Dates must be real YYYY-MM-DD calendar dates.');
  const n = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) invalidAnalyticsQuery('Dates must be real YYYY-MM-DD calendar dates.');
  return n;
}
function enumValue<T extends string>(value: string, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) invalidAnalyticsQuery(`${name} must be one of: ${values.join(', ')}.`);
  return value as T;
}
function common(query: URLSearchParams): DateQuery {
  const from = query.get('date_from');
  const to = query.get('date_to');
  const period = query.get('period');
  if ((from === null) !== (to === null) || (period !== null && from !== null)) invalidAnalyticsQuery('Use period or both date_from and date_to.');
  if (from !== null && to !== null) {
    const days = (analyticsCalendar(to) - analyticsCalendar(from)) / DAY + 1;
    if (days < 1 || days > 93) invalidAnalyticsQuery('Analytics date range must contain 1 to 93 inclusive days.');
    // Reject dates in the future in every timezone before any provider request.
    if (to > new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10)) invalidAnalyticsQuery('Future analytics dates are not supported.');
  }
  const rawLimit = query.get('limit') ?? '10';
  if (!/^(?:[1-9]|1\d|2[0-5])$/.test(rawLimit)) invalidAnalyticsQuery('limit must be an integer from 1 to 25.');
  const cursor = query.get('cursor');
  if (cursor !== null && (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))) invalidAnalyticsQuery('Invalid analytics cursor.');
  return { period: from === null ? enumValue(period ?? 'last_28_days', ANALYTICS_PERIODS, 'period') : null,
    date_from: from, date_to: to, limit: Number(rawLimit), cursor };
}
export function validateGa4Query(query: URLSearchParams): Ga4Query {
  parameters(query, GA4_QUERY_PARAMETER_NAMES);
  const base = common(query);
  const report = enumValue(query.get('report') ?? 'overview', GA4_REPORT_PRESETS, 'report');
  const event = query.get('event_name');
  if (event !== null && (!['events', 'warehouse_interest', 'form_submissions'].includes(report) || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(event)
    || /\d{7}/.test(event))) invalidAnalyticsQuery('event_name is a literal GA event name, available only for events, warehouse_interest and form_submissions.');
  if (report === 'form_submissions' && event !== null && !['form_submit', 'generate_lead'].includes(event)) {
    invalidAnalyticsQuery('form_submissions supports form_submit or generate_lead; omit event_name to report both separately.');
  }
  if (query.has('page_path_contains') && !['pages', 'events', 'form_submissions'].includes(report)) {
    invalidAnalyticsQuery('page_path_contains filters recorded event page context and is available only for pages, events and form_submissions.');
  }
  if (report === 'overview' && base.cursor) invalidAnalyticsQuery('overview has one aggregate row and does not support cursors.');
  const compare_to = comparison(query, report === 'overview');
  return { ...base, report, event_name: event, compare_to, device: device(query), country: literal(query, 'country'),
    landing_page_contains: literal(query, 'landing_page_contains'), page_path_contains: literal(query, 'page_path_contains'),
    channel: literal(query, 'channel'), source: literal(query, 'source') };
}
function comparison(query: URLSearchParams, aggregate: boolean): SegmentQuery['compare_to'] {
  const value = query.get('compare_to');
  if (value === null) return null;
  if (!aggregate) invalidAnalyticsQuery('compare_to is available only for GA4 overview or Search Console summary.');
  return enumValue(value, ['previous_period'] as const, 'compare_to');
}
function device(query: URLSearchParams): SegmentQuery['device'] {
  const value = query.get('device');
  return value === null ? null : enumValue(value, ['desktop', 'mobile', 'tablet'] as const, 'device');
}
function literal(query: URLSearchParams, name: string): string | null {
  const value = query.get(name);
  if (value === null) return null;
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
  }
  // Referral hostnames are useful source labels, while contacts and full URLs remain excluded.
  const inspected = name === 'source' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(decoded) ? decoded.replaceAll('.', ' ') : decoded;
  const redacted = redactCrmText(inspected, { maxCharacters: 120 });
  if (!value.trim() || value.length > 120 || /[\x00-\x1f\x7f\p{Cf}]/u.test(value)
    || redacted.redacted || redacted.truncated || redacted.state === 'unsupported') invalidAnalyticsQuery(`${name} must be a short literal without contact details or URLs.`);
  if (['page_contains', 'landing_page_contains', 'page_path_contains'].includes(name) && /[?#@]/.test(decoded)) invalidAnalyticsQuery(`${name} must be a path fragment without query parameters, credentials or fragments.`);
  return value.trim();
}
function pageEquals(query: URLSearchParams): string | null {
  const value = query.get('page_equals');
  if (value === null) return null;
  const invalid = () => invalidAnalyticsQuery('page_equals must be a public HTTP(S) URL without contacts, credentials, query parameters or fragments.');
  if (!/^https?:\/\//.test(value) || value.length > 512 || /[?#\s\\\p{Cf}]/u.test(value)) return invalid();
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.port) return invalid();
    let path = url.pathname;
    for (let i = 0; i < 3; i++) { const next = decodeURIComponent(path); if (next === path) break; path = next; }
    const inspected = `${url.hostname.replaceAll('.', ' ')} ${path}`.normalize('NFKC');
    const redacted = redactCrmText(inspected, { maxCharacters: 512 });
    if (/[?#@\\\x00-\x1f\x7f\p{Cf}]/u.test(path) || redacted.redacted || redacted.truncated || redacted.state === 'unsupported') return invalid();
    return url.href;
  } catch { return invalid(); }
}
/** Compare parsed hosts/origins, never substring-match a URL against a property. */
export function validateSearchConsolePageScope(page: string | null, site: string) {
  if (page === null) return;
  const url = new URL(page);
  const inScope = site.startsWith('sc-domain:')
    ? url.hostname === site.slice(10) || url.hostname.endsWith(`.${site.slice(10)}`)
    : (() => { const property = new URL(site); return url.origin === property.origin && url.pathname.startsWith(property.pathname); })();
  if (!inScope) invalidAnalyticsQuery('page_equals must belong to the configured Search Console property.');
}
export function validateSearchConsoleQuery(query: URLSearchParams): SearchConsoleQuery {
  parameters(query, SEARCH_CONSOLE_QUERY_PARAMETER_NAMES);
  const base = common(query);
  const group = enumValue(query.get('group') ?? 'summary', SEARCH_CONSOLE_GROUPS, 'group');
  const state = enumValue(query.get('data_state') ?? 'final', ['final', 'all'] as const, 'data_state');
  if (group === 'summary' && base.cursor) invalidAnalyticsQuery('summary has one aggregate row and does not support cursors.');
  if (base.period === 'today' && state !== 'all') invalidAnalyticsQuery('For today, use data_state=all; today is not finalized.');
  if (query.has('query_equals') && query.has('query_contains')) invalidAnalyticsQuery('Use query_equals or query_contains, not both.');
  if (query.has('page_equals') && query.has('page_contains')) invalidAnalyticsQuery('Use page_equals or page_contains, not both.');
  const country = query.get('country');
  if (country !== null && !/^[A-Za-z]{3}$/.test(country)) invalidAnalyticsQuery('Search Console country must be a three-letter ISO country code, such as ind.');
  return { ...base, group, data_state: state, compare_to: comparison(query, group === 'summary'), device: device(query), country: country?.toLowerCase() ?? null,
    query_contains: literal(query, 'query_contains'), query_equals: literal(query, 'query_equals'), query_not_contains: literal(query, 'query_not_contains'),
    page_contains: literal(query, 'page_contains'), page_equals: pageEquals(query) };
}
export function analyticsLocalDate(timezone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
  } catch { throw new HttpError(503, 'ANALYTICS_RESPONSE_INVALID', 'The analytics source did not provide a valid reporting timezone.'); }
}
export function resolveAnalyticsDates(query: DateQuery, timezone: string, now = new Date()) {
  const local_date = analyticsLocalDate(timezone, now);
  const today = analyticsCalendar(local_date);
  const local = new Date(today);
  const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  const format = (n: number) => new Date(n).toISOString().slice(0, 10);
  const dates: Record<AnalyticsPeriod, [number, number]> = {
    today: [today, today], yesterday: [today - DAY, today - DAY],
    last_7_days: [today - 7 * DAY, today - DAY], last_28_days: [today - 28 * DAY, today - DAY],
    this_month: [month, today], last_month: [Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1), month - DAY],
  };
  const [from, to] = query.period ? dates[query.period] : [analyticsCalendar(query.date_from!), analyticsCalendar(query.date_to!)];
  if (to > today) invalidAnalyticsQuery('Future dates in the source reporting timezone are not supported.');
  return { date_from: format(from), date_to: format(to), timezone, local_date,
    period: query.period, inclusive: true as const, includes_recent_days: to >= today - 2 * DAY };
}
export function analyticsPagination(query: Ga4Query | SearchConsoleQuery, resolved: ReturnType<typeof resolveAnalyticsDates>, sourceIdentity: string) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  const fingerprint = createHash('sha256').update(JSON.stringify({ sourceIdentity, filters,
    from: resolved.date_from, to: resolved.date_to, timezone: resolved.timezone })).digest('hex');
  let offset = 0;
  if (query.cursor !== null) {
    try {
      const decoded = Buffer.from(query.cursor, 'base64url');
      if (decoded.toString('base64url') !== query.cursor) throw new Error();
      const value = JSON.parse(decoded.toString('utf8'));
      if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || value.v !== 1 || value.f !== fingerprint
        || !Number.isSafeInteger(value.o) || value.o < 1 || value.o >= ANALYTICS_MAX_ROWS) throw new Error();
      offset = value.o;
    } catch { invalidAnalyticsQuery('Cursor does not match this report and its resolved dates. Keep the same filters or restart without a cursor.'); }
  }
  return { offset, limit: Math.min(query.limit, ANALYTICS_MAX_ROWS - offset),
    cursorFor(next: number) { return Buffer.from(JSON.stringify({ v: 1, f: fingerprint, o: next })).toString('base64url'); } };
}
