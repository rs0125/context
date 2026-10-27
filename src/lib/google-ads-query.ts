import { z } from 'zod';
import { ANALYTICS_PERIODS, analyticsDateParameters, invalidAnalyticsQuery, validateAnalyticsLiteral } from './analytics-query';
import { GOOGLE_ADS_DEVICES, GOOGLE_ADS_NETWORKS, GOOGLE_ADS_PRESETS, GOOGLE_ADS_REPORTS, GOOGLE_ADS_SECTIONS, GOOGLE_ADS_SECTION_FILTERS, GOOGLE_ADS_ACCOUNT_SECTIONS } from './google-ads-catalog';

export const adsId = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n)
  .describe('Exact numeric ID returned by Google Ads discovery; keep it as a string.');
export const adsCategoryId = z.union([adsId, z.literal('0')]);
const date = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/);
const page = { limit: z.number().int().min(1).max(25).describe('Maximum rows per page, default 10. A page is not a full total.').optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/).describe('Copy nextCursor unchanged with the same report, dates and filters. Pages are not a frozen snapshot.').optional() };
const dates = { period: z.enum(ANALYTICS_PERIODS).describe('Default last_28_days, the last 28 completed days in the account timezone. Use period or both explicit dates.').optional(),
  date_from: date.describe('Inclusive first date, YYYY-MM-DD; maximum range 93 days (changes: last 30 days only).').optional(),
  date_to: date.describe('Inclusive last date, YYYY-MM-DD. No future dates.').optional() };
const text = z.string().trim().min(1).max(120);
export const googleAdsFiltersInput = z.object({ campaign_id: adsId.optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Choices per list per page, default 100. Follow nextCursor to finish discovery.'),
  cursor: page.cursor,
}).strict();
export const googleAdsReportInput = z.object({
  report: z.enum(GOOGLE_ADS_REPORTS).optional().describe('Default overview is a full aggregate. daily and conversion_dates are chronological; other reports rank by spend, conversions/lag by all_conversions, and search_categories by clicks. Search terms can omit low-volume queries. Use conversions to distinguish conversion actions.'),
  ...dates, ...page,
  compare_to: z.literal('previous_period').optional().describe('Overview only: compare the preceding equal number of calendar days.'),
  campaign_id: adsId.optional(), ad_group_id: adsId.optional(),
  asset_id: adsId.optional(), asset_group_id: adsId.optional(), ad_id: adsId.optional(),
  category_id: adsCategoryId.optional().describe('search_categories only; 0 is the uncategorized bucket. campaign_id is required.'),
  campaign_status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).optional().describe('campaigns and campaign_diagnostics reports.'),
  device: z.enum(GOOGLE_ADS_DEVICES).optional(), network: z.enum(GOOGLE_ADS_NETWORKS).optional(),
  country_id: adsId.optional().describe('locations report only; country criterion ID returned by that report.'),
  conversion_action_id: adsId.optional().describe('conversions, conversion_dates and conversion_lag only; no selected-action spend or CPA is inferred.'),
  keyword_contains: text.optional().describe('Literal case-insensitive substring; keywords and keyword_diagnostics.'),
  match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).optional().describe('keywords and keyword_diagnostics.'),
  query_contains: text.optional().describe('Literal case-insensitive substring; search_terms, search_term_matches and campaign_search_terms.'),
  query_equals: text.optional().describe('Exact search term on search-term reports. Cannot combine with query_contains.'),
}).strict();
export const googleAdsCampaignInput = z.object({
  id: adsId.optional().describe('Required for campaign scope. Omit for scope=account.'),
  scope: z.enum(['campaign', 'account']).optional().describe('Default campaign. Account scope requires no id and supports asset_inventory, audiences, assets, conversion_actions and unattached recommendations.'),
  section: z.enum(GOOGLE_ADS_SECTIONS).optional().describe('Default settings in campaign scope, asset_inventory in account scope. Other sections are bounded pages; dates apply only to changes, within the last 30 days.'),
  ...page,
  origin: z.enum(['campaign', 'ad_group', 'shared', 'account']).optional().describe('Narrow negative_keywords, negative_lists, assets or recommendations by returned origin. Shared lists apply to negative sections; ad_group applies to negatives/assets.'),
  ad_group_id: adsId.optional(), shared_set_id: adsId.optional(), asset_id: adsId.optional(), asset_group_id: adsId.optional(), conversion_action_id: adsId.optional(), user_list_id: adsId.optional(),
  period: dates.period.describe('Only section=changes: default last_28_days. Omit dates for every current-configuration section.'),
  date_from: dates.date_from.describe('Only section=changes: inclusive first date within the last 30 days, paired with date_to instead of period. Omit for every current-configuration section.'),
  date_to: dates.date_to.describe('Only section=changes: inclusive last date, paired with date_from. Omit for every current-configuration section.'),
}).strict();

function parse<S extends z.ZodType>(schema: S, params: URLSearchParams): z.infer<S> {
  if (params.toString().length > 4096) invalidAnalyticsQuery('Google Ads query is too long.');
  const values: Record<string, unknown> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) invalidAnalyticsQuery('Duplicate Google Ads query parameter.');
    values[key] = value;
  }
  if (params.has('limit')) {
    if (!/^(?:[1-9]\d?|100)$/.test(params.get('limit')!)) invalidAnalyticsQuery('limit must be a positive integer within this tool’s page limit.');
    values.limit = Number(params.get('limit'));
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) invalidAnalyticsQuery('Use the supported Google Ads parameters, enums and string IDs from discovery.');
  return parsed.data;
}
export function validateGoogleAdsFilters(params: URLSearchParams) {
  const input = parse(googleAdsFiltersInput, params);
  return { ...input, limit: input.limit ?? 100, cursor: input.cursor ?? null };
}
export function validateGoogleAdsReport(params: URLSearchParams) {
  const input = parse(googleAdsReportInput, params);
  const report = input.report ?? 'overview';
  const allowed = ['report', 'period', 'date_from', 'date_to', 'limit', 'cursor', 'compare_to', ...GOOGLE_ADS_PRESETS[report].filters];
  for (const name of params.keys()) if (!allowed.includes(name)) invalidAnalyticsQuery(`${name} is not supported on this Google Ads report.`);
  if (GOOGLE_ADS_PRESETS[report].requiresCampaign && !input.campaign_id) invalidAnalyticsQuery('This Google Ads report requires one campaign_id from discovery.');
  if (input.query_equals && input.query_contains) invalidAnalyticsQuery('Use query_equals or query_contains, not both.');
  if (input.compare_to && report !== 'overview') invalidAnalyticsQuery('compare_to is supported only on overview.');
  if (input.cursor && report === 'overview') invalidAnalyticsQuery('overview has one aggregate and does not accept a cursor.');
  for (const name of ['query_contains', 'query_equals', 'keyword_contains']) validateAnalyticsLiteral(params, name);
  return { ...input, ...analyticsDateParameters(params), report, compare_to: input.compare_to ?? null };
}
export type GoogleAdsReportQuery = ReturnType<typeof validateGoogleAdsReport>;
export function validateGoogleAdsCampaign(id: string | null, params: URLSearchParams) {
  if (id !== null && !adsId.safeParse(id).success || params.has('id') || params.has('scope')) invalidAnalyticsQuery('Use one campaign ID from Google Ads discovery.');
  const scope = id === null ? 'account' as const : 'campaign' as const;
  const input = parse(googleAdsCampaignInput, new URLSearchParams([...params, ['scope', scope], ...(id === null ? [] : [['id', id]])]));
  const section = input.section ?? (scope === 'account' ? 'asset_inventory' : 'settings');
  if (scope === 'account' && !(GOOGLE_ADS_ACCOUNT_SECTIONS as readonly string[]).includes(section)
    || scope === 'campaign' && ['asset_inventory', 'audiences'].includes(section)) invalidAnalyticsQuery('This section is unavailable in the requested scope.');
  if (scope === 'account' && (input.ad_group_id || input.origin && input.origin !== 'account')) invalidAnalyticsQuery('Account scope supports only account origin, without ad_group_id.');
  for (const name of ['origin', 'ad_group_id', 'shared_set_id', 'asset_id', 'asset_group_id', 'conversion_action_id', 'user_list_id']) {
    if (params.has(name) && !GOOGLE_ADS_SECTION_FILTERS[section].includes(name)) invalidAnalyticsQuery(`${name} is not supported on this campaign section.`);
  }
  const origins = section === 'negative_keywords' ? ['campaign', 'ad_group', 'shared', 'account']
    : section === 'negative_lists' ? ['shared', 'account'] : section === 'assets' ? ['campaign', 'ad_group', 'account'] : ['campaign', 'account'];
  if (input.origin && !origins.includes(input.origin)) invalidAnalyticsQuery('origin is not supported on this section.');
  if (input.ad_group_id && section !== 'ad_group_settings' && (input.shared_set_id || input.origin && input.origin !== 'ad_group')) invalidAnalyticsQuery('ad_group_id requires origin=ad_group or no origin, without shared_set_id.');
  if (input.shared_set_id && input.origin && !['shared', 'account'].includes(input.origin)) invalidAnalyticsQuery('shared_set_id requires a shared/account origin or no origin.');
  if (section !== 'changes' && ['period', 'date_from', 'date_to'].some(key => params.has(key))) invalidAnalyticsQuery('Dates apply only to the changes section.');
  if (section === 'settings' && input.cursor) invalidAnalyticsQuery('settings returns one campaign and does not accept a cursor.');
  return { ...input, ...analyticsDateParameters(params), scope, section };
}
export function adsString(value: string) { return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
export function adsContains(field: string, value: string) {
  const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `${field} REGEXP_MATCH ${adsString(`(?i).*${literal}.*`)}`;
}
