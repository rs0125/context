import { z } from 'zod';
import { ANALYTICS_PERIODS, GA4_REPORT_PRESETS, SEARCH_CONSOLE_GROUPS } from './analytics';

const date = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/);
const datesAndPage = {
  period: z.enum(ANALYTICS_PERIODS).describe('Calendar period in the source timezone. Default last_28_days means the last 28 completed days. Use either period or both explicit dates, never both. Recent dates are provisional.').optional(),
  date_from: date.describe('Inclusive first date, YYYY-MM-DD, paired with date_to. Maximum range 93 days; no future dates.').optional(),
  date_to: date.describe('Inclusive last date, YYYY-MM-DD. GA4 uses its property timezone; Search Console uses America/Los_Angeles.').optional(),
  limit: z.number().int().min(1).max(25).describe('Maximum rows, default 10. A report page is not the full total.').optional(),
  cursor: z.string().min(1).max(2048).describe('Unchanged nextCursor from this report with the same dates and filters. Pages are not a frozen snapshot.').optional(),
};
export const ga4ToolInput = z.object({
  report: z.enum(GA4_REPORT_PRESETS).describe('overview: overall users/sessions/views; daily: trend; acquisition: session channels/sources; landing_pages: entry paths; devices/countries: aggregate audiences; events: recorded event counts; warehouse_interest: recorded warehouse geography; lead_sources: generate_lead events by recorded form context. Use capabilities to check custom-dimension reports.').optional(),
  ...datesAndPage,
  event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).describe('Exact event name for events or warehouse_interest reports, for example generate_lead, form_attempt or listing_impression. Counts are recorded events, not unique people or CRM leads.').optional(),
}).strict();

const nonnegative = z.number().min(0);
const count = nonnegative.int();
const nullableText = z.string().nullable();
export const analyticsCapabilitiesOutput = z.object({
  read_only: z.literal(true), access: z.literal('admins_only'),
  ga4: z.object({ status: z.enum(['available', 'not_configured', 'unavailable']), property: nullableText, timezone: nullableText,
    custom_dimensions: z.array(z.string()), source_fetched_at: z.string().datetime().nullable(), error_code: nullableText,
    reports: z.array(z.object({ name: z.enum(GA4_REPORT_PRESETS), available: z.boolean(), reason: nullableText,
      dimensions: z.array(z.string()), metrics: z.array(z.string()), event_name: nullableText })) }),
  search_console: z.object({ status: z.enum(['configured_not_verified', 'not_configured']), property: nullableText,
    timezone: z.literal('America/Los_Angeles'), groups: z.array(z.enum(SEARCH_CONSOLE_GROUPS)) }),
  periods: z.array(z.enum(ANALYTICS_PERIODS)), default_period: z.literal('last_28_days'),
  max_date_range_days: z.literal(93), max_rows_per_page: z.literal(25), max_report_rows: z.literal(500),
  served_at: z.string().datetime(), guidance: z.array(z.string()),
});
export const analyticsReportOutput = z.object({
  source: z.object({ system: z.enum(['ga4', 'search_console']), property: z.string(), timezone: z.string() }),
  source_status: z.object({ status: z.literal('available'), read_only: z.literal(true) }),
  report: z.string(),
  query_context: z.object({ date_from: date, date_to: date, timezone: z.string(), local_date: date,
    period: z.enum(ANALYTICS_PERIODS).nullable(), inclusive: z.literal(true), includes_recent_days: z.boolean(),
    event_name: nullableText, query_contains: nullableText, page_contains: nullableText, data_state: z.enum(['final', 'all']).nullable() }),
  columns: z.array(z.object({ name: z.string(), kind: z.enum(['dimension', 'metric']), unit: z.string() })),
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
});
export const searchConsoleToolInput = z.object({
  group: z.enum(SEARCH_CONSOLE_GROUPS).describe('summary: property aggregate; date: daily trend; query/page/country/device: top Google organic search rows. Grouped rows are not guaranteed complete.').optional(),
  ...datesAndPage,
  data_state: z.enum(['final', 'all']).describe('Default final: finalized Google Search data only. all includes provisional data and is required for any range ending today, including this_month. Final data may lag the requested end date.').optional(),
  query_contains: z.string().trim().min(1).max(120).describe('Literal substring of the Google search query. Filtered totals exclude anonymized or unavailable queries.').optional(),
  page_contains: z.string().trim().min(1).max(120).describe('Literal substring of the page URL. Returned URLs have query strings/fragments removed and detected contacts masked.').optional(),
}).strict();

export const ANALYTICS_INSTRUCTIONS = 'Website analytics is admin-only aggregate data. Use analytics_capabilities for supported reports/custom fields, ga4_report for traffic/events, and search_console_report for organic Google Search. Use source timezones and resolved inclusive dates rather than the India CRM clock. Preserve source_fetched_at, quality, pagination and any cache age; recently reported dates can change. Failed reads mean unavailable, not zero. Event counts and key events are not unique CRM leads, closed deals, revenue, or a sequential conversion funnel. Search Console clicks and GA4 sessions measure different things. Grouped rows may be incomplete: do not sum users across groups, average CTR/position, or claim a search page is an overall total. For source comparisons request matching explicit dates and state timezone differences. Redacted labels/paths can collide; do not infer hidden text or regroup masked rows as if they were one original value.';

export function analyticsQueryParameters(input: typeof ga4ToolInput | typeof searchConsoleToolInput) {
  const schema = z.toJSONSchema(input);
  return Object.entries(schema.properties ?? {}).map(([name, definition]) => ({
    name, in: 'query', required: false, schema: definition,
  }));
}
