import { z } from 'zod';
import { ANALYTICS_PERIODS } from './analytics-query';
import { GOOGLE_ADS_DEVICES, GOOGLE_ADS_NETWORKS, GOOGLE_ADS_REPORTS, GOOGLE_ADS_SECTIONS, GOOGLE_ADS_ACCOUNT_SECTIONS } from './google-ads-catalog';
import { adsId, googleAdsReportInput } from './google-ads-query';

const text = z.string().nullable();
const count = z.number().int().nonnegative();
const date = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/);
const account = z.object({ id: adsId, name: text, currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string() });
const source = account.omit({ id: true, name: true }).extend({ system: z.literal('google_ads'), property: adsId, account_name: text });
const dates = z.object({ date_from: date, date_to: date, timezone: z.string(), local_date: date,
  period: z.enum(ANALYTICS_PERIODS).nullable(), inclusive: z.literal(true), includes_recent_days: z.boolean() });
const cache = z.object({ hit: z.boolean(), max_age_seconds: z.literal(300), age_seconds: count });
const provenance = { source, source_status: z.object({ status: z.literal('available'), read_only: z.literal(true) }),
  source_fetched_at: z.string().datetime().describe('ISO 8601 fetch timestamp in UTC (Z), not the account timezone.'), served_at: z.string().datetime(), cache };
const pagination = { nextCursor: text, pagination: z.object({ limit: count.min(1).max(25), returned_count: count.max(25),
  has_more: z.boolean(), next_cursor: text, offset: count, source_row_count: count.nullable(), cap_reached: z.boolean(), max_rows: z.literal(500), snapshot: z.literal(false) }) };
const choice = z.object({ id: adsId, name: text, status: text });
const quality = z.object({ provisional: z.boolean().describe('Recent-date flag; false does not certify finalized data.'), warnings: z.array(z.string()), data_truncated: z.boolean(),
  privacy_redactions: z.boolean(), totals_included: z.boolean(), aggregation_type: z.enum(['google_ads_interaction_date', 'google_ads_conversion_date']), empty_reason: text });
const queryContext = googleAdsReportInput.omit({ limit: true, cursor: true, compare_to: true }).extend({
  ...dates.shape, report: z.enum(GOOGLE_ADS_REPORTS), compare_to: z.literal('previous_period').nullable(),
});
export const googleAdsCapabilitiesOutput = z.object({
  status: z.enum(['available', 'not_configured', 'unavailable']), account: account.nullable(), error_code: text,
  source_fetched_at: z.string().datetime().nullable(),
  reports: z.array(z.object({ name: z.enum(GOOGLE_ADS_REPORTS), available: z.boolean(), filters: z.array(z.string()), dimensions: z.array(z.string()), metrics: z.array(z.string()) })),
  campaign_sections: z.array(z.enum(GOOGLE_ADS_SECTIONS)), account_sections: z.array(z.enum(GOOGLE_ADS_ACCOUNT_SECTIONS)), guidance: z.string(),
  campaign_section_filters: z.array(z.object({ section: z.enum(GOOGLE_ADS_SECTIONS), filters: z.array(z.string()) })).optional(),
});
export const googleAdsFiltersOutput = z.object({
  source, read_only: z.literal(true), campaign_id: adsId.nullable(),
  nextCursor: text, pagination: z.object({ limit: count.min(1).max(100), has_more: z.boolean(), snapshot: z.literal(false) }),
  campaigns: z.array(choice).max(100), campaigns_truncated: z.boolean(),
  ad_groups: z.array(choice).max(100), ad_groups_truncated: z.boolean(), ad_groups_loaded: z.boolean(),
  conversion_actions: z.array(choice.extend({ category: text, primary_for_goal: z.boolean().nullable() })).max(100), conversion_actions_truncated: z.boolean(),
  devices: z.array(z.enum(GOOGLE_ADS_DEVICES)), networks: z.array(z.enum(GOOGLE_ADS_NETWORKS)), campaign_statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])),
  source_fetched_at: z.string().datetime(), served_at: z.string().datetime(), guidance: z.string(),
});
export const googleAdsReportOutput = z.object({
  ...provenance, ...pagination, report: z.enum(GOOGLE_ADS_REPORTS), query_context: queryContext,
  columns: z.array(z.object({ name: z.string(), kind: z.enum(['dimension', 'metric']), unit: z.string(), definition: z.string().optional() })),
  items: z.array(z.object({ dimensions: z.record(z.string(), text), metrics: z.record(z.string(), z.number().nullable()),
    metric_bounds: z.record(z.string(), z.object({ operator: z.enum(['lt', 'gt']), value: z.number() })).optional(),
    redacted: z.boolean(), verification_required: z.boolean() })).max(25),
  quality,
  interpretation: z.object({ aggregation: z.literal('aggregate'), conversion_basis: z.literal('google_ads_campaign_goals'), date_basis: z.enum(['ad_interaction', 'conversion']),
    event_counts_are_unique_leads: z.literal(false), crm_linkage_available: z.literal(false), guidance: z.string() }),
  comparison: z.object({ mode: z.literal('previous_period'), window: z.literal('preceding_equal_days'), read_consistency: z.literal('independent_source_reads'),
    baseline: z.object({ query_context: queryContext, source_fetched_at: z.string().datetime(), served_at: z.string().datetime(), cache, quality }),
    metrics: z.array(z.object({ name: z.string(), unit: z.string(), current: z.number().nullable(), previous: z.number().nullable(),
      absolute_change: z.number().nullable(), relative_change_percent: z.number().nullable(), percentage_point_change: z.number().nullable(),
      status: z.enum(['available', 'zero_baseline', 'missing_data']) })), warnings: z.array(z.string()) }).nullable(),
});
export const googleAdsCampaignOutput = z.object({
  ...provenance, ...pagination, campaign: choice.nullable(), scope: z.enum(['campaign', 'account']), section: z.enum(GOOGLE_ADS_SECTIONS), query_context: dates.nullable(),
  items: z.array(z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()).max(500),
    z.array(z.object({ header: text, description: text, amount: z.number().nullable(), currency: text, unit: text, final_url: text })).max(20), z.null()])),
    redacted: z.boolean(), verification_required: z.boolean().optional(), truncated_fields: z.array(z.string()).max(100) })).max(25),
  components: z.array(z.object({ name: z.string(), source_fetched_at: z.string().datetime(), cache, data_truncated: z.boolean() })).optional(),
  quality: z.object({ data_truncated: z.boolean(), privacy_redactions: z.boolean(), warnings: z.array(z.string()),
    coverage_complete: z.boolean().optional().describe('All source components and nested lists were accessible within their limits. Follow nextCursor for remaining pages.'),
    unavailable_resources: z.array(z.string()).max(500).optional() }),
});
