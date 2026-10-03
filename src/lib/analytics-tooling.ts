import { z } from 'zod';
import { ANALYTICS_PERIODS, GA4_REPORT_PRESETS, SEARCH_CONSOLE_GROUPS } from './analytics';

const date = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/);
const literal = z.string().trim().min(1).max(120);
const device = z.enum(['desktop', 'mobile', 'tablet']);
const datesAndPage = {
  period: z.enum(ANALYTICS_PERIODS).describe('Calendar period in the source timezone. Default last_28_days means the last 28 completed days. Use either period or both explicit dates, never both. Recent dates are provisional.').optional(),
  date_from: date.describe('Inclusive first date, YYYY-MM-DD, paired with date_to. Maximum range 93 days; no future dates.').optional(),
  date_to: date.describe('Inclusive last date, YYYY-MM-DD. GA4 uses its property timezone; Search Console uses America/Los_Angeles.').optional(),
  limit: z.number().int().min(1).max(25).describe('Maximum rows, default 10. A report page is not the full total.').optional(),
  cursor: z.string().min(1).max(2048).describe('Unchanged nextCursor from this report with the same dates and filters. Pages are not a frozen snapshot.').optional(),
  compare_to: z.literal('previous_period').describe('Compare overall metrics with the immediately preceding equal-length period. Only GA4 overview or Search Console summary; no cursor. Read comparison dates and quality for both periods.').optional(),
};
export const ga4ToolInput = z.object({
  report: z.enum(GA4_REPORT_PRESETS).describe('For form-vs-session or page-type performance questions use form_performance: separate form_submit/generate_lead counts and server-calculated events per 100 matching entry sessions. One aggregate cohort per call; no event_name, page_path_contains, cursor or compare_to. overview: overall traffic/engagement; daily: trend; acquisition: session channels/sources; landing_pages: entry paths; devices/countries: audience. pages: viewed paths; events: event counts. first_visits: first_visit by entry, not later journeys. form_submissions: separate form events by recorded event page. warehouse_interest: tracked geography; lead_sources: form context. Check capabilities for metric/event definitions.').optional(),
  ...datesAndPage,
  event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).describe('Exact event name for events or warehouse_interest. On form_submissions only form_submit or generate_lead; omit to report both separately. first_visits fixes first_visit and does not accept this parameter. Counts are events, not unique people or CRM leads.').optional(),
  landing_page_contains: literal.describe('Case-sensitive entry-path substring, for example /warehouses/bengaluru. Filters by landing page across any report; it does not filter every page viewed. No query string, fragment or contact details.').optional(),
  page_path_contains: literal.describe('Case-sensitive recorded event-page path substring, available only on pages, events and form_submissions. Different from session entry. For tracked forms it can reflect the page where the form opened. Combines with landing_page_contains using AND. No URL query, fragment or contact details.').optional(),
  device: device.describe('Exact device category: desktop, mobile or tablet.').optional(),
  country: literal.describe('Exact case-sensitive GA4 country label, for example India; not an ISO country code. Use report=countries to discover observed labels.').optional(),
  channel: literal.describe('Exact case-sensitive session default channel label, for example Organic Search or Paid Search. Use acquisition to discover observed labels.').optional(),
  source: literal.describe('Exact case-sensitive session source, for example google. This is the source alone, not the combined source / medium label shown in acquisition.').optional(),
}).strict();

const nonnegative = z.number().min(0);
const count = nonnegative.int();
const nullableText = z.string().nullable();
const eventDefinition = z.object({ event_name: z.string(), meaning: z.string(),
  definition_basis: z.enum(['google_definition', 'website_source_review']), limitations: z.array(z.string()) });
export const analyticsInterpretationOutput = z.object({
  aggregation: z.literal('aggregate'), page_basis: z.enum(['session_entry', 'recorded_event_page', 'none']),
  acquisition_basis: z.enum(['first_visit_events_only', 'session', 'not_reported']),
  individual_journeys_available: z.literal(false), crm_linkage_available: z.literal(false), event_counts_are_unique_leads: z.literal(false),
  event_definitions: z.array(eventDefinition), limits: z.array(z.string()),
});
export const analyticsCapabilitiesOutput = z.object({
  read_only: z.literal(true), access: z.literal('analysts_only'),
  ga4: z.object({ status: z.enum(['available', 'not_configured', 'unavailable']), property: nullableText, timezone: nullableText,
    custom_dimensions: z.array(z.string()), source_fetched_at: z.string().datetime().nullable(), error_code: nullableText,
    event_definitions: z.array(eventDefinition),
    metric_definitions: z.array(z.object({ name: z.string(), unit: z.string(), definition: z.string(), calculation: nullableText })),
    reports: z.array(z.object({ name: z.enum(GA4_REPORT_PRESETS), available: z.boolean(), reason: nullableText,
      dimensions: z.array(z.string()), metrics: z.array(z.string()), event_name: nullableText, event_names: z.array(z.string()),
      read_strategy: z.enum(['single_report', 'three_matched_aggregates']).optional() })) }),
  search_console: z.object({ status: z.enum(['configured_not_verified', 'not_configured']), property: nullableText,
    timezone: z.literal('America/Los_Angeles'), groups: z.array(z.enum(SEARCH_CONSOLE_GROUPS)) }),
  periods: z.array(z.enum(ANALYTICS_PERIODS)), default_period: z.literal('last_28_days'),
  max_date_range_days: z.literal(93), max_rows_per_page: z.literal(25), max_report_rows: z.literal(500),
  served_at: z.string().datetime(), guidance: z.array(z.string()),
});
const analyticsReportBaseOutput = z.object({
  source: z.object({ system: z.enum(['ga4', 'search_console']), property: z.string(), timezone: z.string() }),
  source_status: z.object({ status: z.literal('available'), read_only: z.literal(true) }),
  report: z.string(),
  query_context: z.object({ date_from: date, date_to: date, timezone: z.string(), local_date: date,
    period: z.enum(ANALYTICS_PERIODS).nullable(), inclusive: z.literal(true), includes_recent_days: z.boolean(),
    event_name: nullableText, event_names: z.array(z.string()), query_contains: nullableText, page_contains: nullableText, data_state: z.enum(['final', 'all']).nullable(),
    landing_page_contains: nullableText, page_path_contains: nullableText, device: nullableText, country: nullableText, channel: nullableText, source: nullableText,
    query_equals: nullableText, page_equals: nullableText, query_not_contains: nullableText,
    compare_to: z.literal('previous_period').nullable() }),
  columns: z.array(z.object({ name: z.string(), kind: z.enum(['dimension', 'metric']), unit: z.string(),
    definition: z.string().optional(), calculation: z.string().optional() })),
  items: z.array(z.object({ dimensions: z.record(z.string(), nullableText), metrics: z.record(z.string(), z.number().nullable()),
    redacted: z.boolean(), verification_required: z.boolean() })).max(25),
  pagination: z.object({ limit: count.max(25), returned_count: count, has_more: z.boolean(), next_cursor: nullableText,
    offset: count, source_row_count: count.nullable(), cap_reached: z.boolean(), max_rows: z.literal(500), snapshot: z.literal(false) }),
  nextCursor: nullableText,
  source_fetched_at: z.string().datetime(), served_at: z.string().datetime(),
  cache: z.object({ hit: z.boolean(), max_age_seconds: z.literal(300), age_seconds: nonnegative }),
  quality: z.object({ provisional: z.boolean(), warnings: z.array(z.string()), data_loss_from_other_row: z.boolean(),
    subject_to_thresholding: z.boolean(), sampling: z.array(z.object({ samples_read: z.string(), sampling_space: z.string() })),
    schema_restrictions: z.array(z.object({ metric: z.string(), types: z.array(z.string()) })), data_truncated: z.boolean(),
    empty_reason: nullableText, privacy_redactions: z.boolean(), totals_included: z.boolean(), first_incomplete_date: nullableText,
    aggregation_type: nullableText }),
  quota: z.record(z.string(), z.object({ consumed: count, remaining: count })).nullable(),
  interpretation: analyticsInterpretationOutput,
});
export const analyticsReportOutput = analyticsReportBaseOutput.extend({
  form_performance: z.object({
    matching_cohort: z.literal(true), read_consistency: z.literal('independent_source_reads'), denominator: z.literal('matching_entry_sessions'),
    components: z.array(z.object({ name: z.enum(['sessions', 'form_submit', 'generate_lead']), metric: z.enum(['sessions', 'eventCount']),
      value: count.nullable(), query_context: analyticsReportBaseOutput.shape.query_context,
      source_fetched_at: z.string().datetime(), served_at: z.string().datetime(),
      cache: analyticsReportBaseOutput.shape.cache, quality: analyticsReportBaseOutput.shape.quality, quota: analyticsReportBaseOutput.shape.quota })).length(3),
    ratios: z.array(z.object({ event_name: z.enum(['form_submit', 'generate_lead']), metric: z.string(), value: nonnegative.nullable(),
      status: z.enum(['available', 'zero_sessions', 'missing_data', 'source_quality_limited', 'invalid_calculation']) })).length(2),
  }).optional(),
  comparison: z.object({
    mode: z.literal('previous_period'), window: z.literal('preceding_equal_days'),
    read_consistency: z.literal('independent_source_reads'),
    baseline: z.object({ query_context: analyticsReportBaseOutput.shape.query_context,
      source_fetched_at: z.string().datetime(), served_at: z.string().datetime(),
      cache: analyticsReportBaseOutput.shape.cache, quality: analyticsReportBaseOutput.shape.quality }),
    metrics: z.array(z.object({ name: z.string(), unit: z.string(), current: z.number().nullable(), previous: z.number().nullable(),
      absolute_change: z.number().nullable(), relative_change_percent: z.number().nullable(), percentage_point_change: z.number().nullable(),
      status: z.enum(['available', 'zero_baseline', 'missing_data']) })),
    warnings: z.array(z.string()),
  }).nullable().optional(),
});
export const searchConsoleToolInput = z.object({
  group: z.enum(SEARCH_CONSOLE_GROUPS).describe('summary: property aggregate; date: chronological trend, paginate for the whole range; query/page/country/device: top Google organic search rows; query_page: search term with its returned page. Grouped rows are not guaranteed complete.').optional(),
  ...datesAndPage,
  data_state: z.enum(['final', 'all']).describe('Default final: finalized Google Search data only. all includes provisional data and is required for any range ending today, including this_month. Final data may lag the requested end date.').optional(),
  query_contains: z.string().trim().min(1).max(120).describe('Case-insensitive literal substring of the Google search query. Filtered totals exclude anonymized or unavailable queries.').optional(),
  page_contains: z.string().trim().min(1).max(120).describe('Case-insensitive literal substring of the page URL. Returned URLs have query strings/fragments removed and detected contacts masked.').optional(),
  query_equals: literal.describe('Exact case-sensitive search query, for example warehouse in bengaluru. Cannot combine with query_contains. No contact details.').optional(),
  query_not_contains: literal.describe('Exclude queries containing this case-insensitive literal substring, for example a brand name. Combines with other filters using AND; anonymized queries remain omitted.').optional(),
  page_equals: z.string().trim().min(1).max(512).describe('Exact full public HTTP(S) page URL within the configured property, for example https://www.example.com/warehouses/bengaluru. URL paths are case-sensitive. No credentials, query string, fragment or contact details. Cannot combine with page_contains.').optional(),
  device: device.describe('Exact Search Console device category: desktop, mobile or tablet.').optional(),
  country: z.string().regex(/^[A-Za-z]{3}$/).describe('Three-letter ISO 3166-1 alpha-3 country code, for example ind for India. Normalized to lowercase; differs from GA4 country labels.').optional(),
}).strict();

export { ANALYTICS_INSTRUCTIONS } from './prompt-definitions';

export function analyticsQueryParameters(input: typeof ga4ToolInput | typeof searchConsoleToolInput) {
  const schema = z.toJSONSchema(input);
  return Object.entries(schema.properties ?? {}).map(([name, definition]) => ({
    name, in: 'query', required: false, schema: definition,
  }));
}
