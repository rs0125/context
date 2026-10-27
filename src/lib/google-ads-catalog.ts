export const GOOGLE_ADS_REPORTS = ['overview', 'daily', 'campaigns', 'ad_groups', 'ads', 'keywords', 'search_terms',
  'landing_pages', 'devices', 'networks', 'locations', 'schedule', 'conversions', 'campaign_diagnostics', 'keyword_diagnostics',
  'search_term_matches', 'campaign_search_terms', 'asset_performance', 'asset_groups', 'age_ranges', 'genders', 'income_ranges', 'conversion_dates', 'ad_asset_performance', 'conversion_lag', 'search_categories', 'click_types', 'parental_status', 'expanded_landing_pages'] as const;
export const GOOGLE_ADS_SECTIONS = ['settings', 'targeting', 'negative_keywords', 'negative_lists', 'creatives', 'assets', 'asset_groups',
  'conversion_actions', 'conversion_goals', 'recommendations', 'changes', 'asset_inventory', 'audiences', 'ad_group_settings'] as const;
export const GOOGLE_ADS_ACCOUNT_SECTIONS = ['asset_inventory', 'audiences', 'assets', 'conversion_actions', 'recommendations'] as const;
export const GOOGLE_ADS_DEVICES = ['desktop', 'mobile', 'tablet', 'connected_tv', 'other', 'unknown'] as const;
export const GOOGLE_ADS_NETWORKS = ['SEARCH', 'SEARCH_PARTNERS', 'CONTENT', 'YOUTUBE_SEARCH', 'YOUTUBE_WATCH', 'MIXED', 'UNKNOWN'] as const;
export const GOOGLE_ADS_SECTION_FILTERS: Record<typeof GOOGLE_ADS_SECTIONS[number], readonly string[]> = {
  settings: [], targeting: [], creatives: [], changes: [], conversion_goals: [],
  asset_inventory: ['asset_id'], audiences: ['user_list_id'], ad_group_settings: ['ad_group_id'],
  negative_keywords: ['origin', 'ad_group_id', 'shared_set_id'], negative_lists: ['origin', 'shared_set_id'],
  assets: ['origin', 'ad_group_id', 'asset_id'], asset_groups: ['asset_group_id'], conversion_actions: ['conversion_action_id'], recommendations: ['origin'],
};
export type AdsReport = typeof GOOGLE_ADS_REPORTS[number];
export type AdsDimension = { name: string; field: string; kind: 'label' | 'id' | 'date' | 'url' | 'geo' | 'conversion_action' | 'criterion_ref' | 'boolean' | 'category_id'; definition?: string };
const d = (name: string, field: string, kind: AdsDimension['kind'] = 'label'): AdsDimension => ({ name, field, kind });
const campaign = [d('campaign_id', 'campaign.id', 'id'), d('campaign_name', 'campaign.name')];
const adGroup = [...campaign, d('ad_group_id', 'ad_group.id', 'id'), d('ad_group_name', 'ad_group.name')];
type Preset = { resource: string; dimensions: AdsDimension[]; order: string[]; filters: readonly string[];
  metrics?: readonly string[]; rates?: boolean; chronological?: boolean; rankBy?: string; requiresCampaign?: boolean; dateBasis?: 'conversion'; warnings?: string[] };
const common = ['campaign_id', 'device', 'network'];
const grouped = [...common, 'ad_group_id'];
const aggregate = [...grouped];
export const GOOGLE_ADS_BASE_METRICS = ['impressions', 'clicks', 'cost', 'conversions', 'all_conversions', 'conversion_value', 'all_conversion_value'] as const;
const criterion = [...adGroup, d('criterion_id', 'ad_group_criterion.criterion_id', 'id')];
const demographic = (resource: string, name: string, field: string): Preset => ({ resource,
  dimensions: [...criterion, d(name, field)], order: ['ad_group.id', 'ad_group_criterion.criterion_id'], filters: ['campaign_id', 'ad_group_id'],
  warnings: ['Audience categories are Google reporting estimates, including unknown categories; they do not identify individual visitors.'] });
export const GOOGLE_ADS_PRESETS: Record<AdsReport, Preset> = {
  overview: { resource: 'customer', dimensions: [], order: [], filters: aggregate },
  daily: { resource: 'customer', dimensions: [d('date', 'segments.date', 'date')], order: ['segments.date'], filters: aggregate },
  campaigns: { resource: 'campaign', dimensions: [...campaign, d('status', 'campaign.status'), d('channel', 'campaign.advertising_channel_type')], order: ['campaign.id'], filters: [...common, 'campaign_status'] },
  ad_groups: { resource: 'ad_group', dimensions: [...adGroup, d('status', 'ad_group.status')], order: ['ad_group.id'], filters: grouped },
  ads: { resource: 'ad_group_ad', dimensions: [...adGroup, d('ad_id', 'ad_group_ad.ad.id', 'id'), d('ad_type', 'ad_group_ad.ad.type'), d('status', 'ad_group_ad.status')], order: ['ad_group.id', 'ad_group_ad.ad.id'], filters: grouped },
  keywords: { resource: 'keyword_view', dimensions: [...adGroup, d('criterion_id', 'ad_group_criterion.criterion_id', 'id'),
    d('keyword', 'ad_group_criterion.keyword.text'), d('match_type', 'ad_group_criterion.keyword.match_type'),
    { ...d('current_quality_score', 'ad_group_criterion.quality_info.quality_score'), definition: 'Current criterion quality score at retrieval, not a historical score for the requested report dates. Null means no score was returned.' }],
    order: ['ad_group.id', 'ad_group_criterion.criterion_id'], filters: [...grouped, 'keyword_contains', 'match_type'] },
  search_terms: { resource: 'search_term_view', dimensions: [...adGroup, d('search_term', 'search_term_view.search_term'), d('targeting_status', 'search_term_view.status')],
    order: ['campaign.id', 'ad_group.id', 'search_term_view.search_term'], filters: [...grouped, 'query_contains', 'query_equals'] },
  landing_pages: { resource: 'landing_page_view', dimensions: [...campaign, d('page', 'landing_page_view.unexpanded_final_url', 'url')],
    order: ['campaign.id', 'landing_page_view.unexpanded_final_url'], filters: common },
  devices: { resource: 'customer', dimensions: [d('device', 'segments.device')], order: ['segments.device'], filters: aggregate },
  networks: { resource: 'customer', dimensions: [d('network', 'segments.ad_network_type')], order: ['segments.ad_network_type'], filters: aggregate },
  locations: { resource: 'user_location_view', dimensions: [...campaign, d('country_id', 'user_location_view.country_criterion_id', 'geo'),
    { ...d('targeting_location', 'user_location_view.targeting_location', 'boolean'), definition: 'Whether Google classified this location as targeted. Targeted and untargeted rows are distinct; null means the classification was not returned.' },
    d('region_id', 'segments.geo_target_region', 'geo'), d('city_id', 'segments.geo_target_city', 'geo')],
    order: ['campaign.id', 'user_location_view.country_criterion_id', 'user_location_view.targeting_location', 'segments.geo_target_region', 'segments.geo_target_city'], filters: [...common, 'country_id'] },
  schedule: { resource: 'customer', dimensions: [d('day_of_week', 'segments.day_of_week'), d('hour', 'segments.hour')],
    order: ['segments.day_of_week', 'segments.hour'], filters: aggregate },
  conversions: { resource: 'customer', dimensions: [d('conversion_action_id', 'segments.conversion_action', 'conversion_action'),
    d('conversion_action_name', 'segments.conversion_action_name'), d('category', 'segments.conversion_action_category')],
    order: ['segments.conversion_action'], filters: [...aggregate, 'conversion_action_id'], metrics: ['conversions', 'all_conversions', 'conversion_value', 'all_conversion_value'], rates: false, rankBy: 'all_conversions' },
  campaign_diagnostics: { resource: 'campaign', dimensions: campaign, order: ['campaign.id'], filters: ['campaign_id', 'campaign_status'],
    metrics: [...GOOGLE_ADS_BASE_METRICS, 'search_impression_share', 'search_budget_lost_impression_share', 'search_rank_lost_impression_share',
      'search_top_impression_share', 'search_absolute_top_impression_share', 'top_impression_percentage', 'absolute_top_impression_percentage',
      'search_click_share', 'invalid_clicks', 'invalid_click_rate', 'phone_calls', 'phone_impressions', 'phone_through_rate'],
    warnings: ['Impression-share estimates can be bounded. Read metric_bounds: a bound is not an exact percentage. Do not average shares across rows. Phone calls and invalid clicks are separate Google measurements, not unique CRM leads.'] },
  keyword_diagnostics: { resource: 'keyword_view', dimensions: [...criterion, d('date', 'segments.date', 'date'), d('keyword', 'ad_group_criterion.keyword.text'),
    d('match_type', 'ad_group_criterion.keyword.match_type'), d('current_status', 'ad_group_criterion.status'),
    d('current_creative_quality', 'ad_group_criterion.quality_info.creative_quality_score'), d('current_landing_page_quality', 'ad_group_criterion.quality_info.post_click_quality_score'),
    d('current_predicted_ctr', 'ad_group_criterion.quality_info.search_predicted_ctr'), d('historical_creative_quality', 'metrics.historical_creative_quality_score'),
    d('historical_landing_page_quality', 'metrics.historical_landing_page_quality_score'), d('historical_predicted_ctr', 'metrics.historical_search_predicted_ctr')],
    order: ['ad_group.id', 'ad_group_criterion.criterion_id', 'segments.date'], filters: ['campaign_id', 'ad_group_id', 'keyword_contains', 'match_type'],
    metrics: [...GOOGLE_ADS_BASE_METRICS, 'historical_quality_score', 'current_cpc_bid'],
    warnings: ['Historical quality components belong to each returned date. Fields prefixed current_ describe configuration at retrieval, not that date. A missing score or bid is unavailable.'] },
  search_term_matches: { resource: 'search_term_view', dimensions: [...adGroup, d('search_term', 'search_term_view.search_term'),
    d('matched_keyword_id', 'segments.keyword.ad_group_criterion', 'criterion_ref'), d('matched_keyword', 'segments.keyword.info.text'),
    d('keyword_match_type', 'segments.keyword.info.match_type'), d('match_source', 'segments.search_term_match_source'), d('search_term_match_type', 'segments.search_term_match_type')],
    order: ['campaign.id', 'ad_group.id', 'search_term_view.search_term', 'segments.keyword.info.text', 'segments.keyword.info.match_type', 'segments.search_term_match_source', 'segments.search_term_match_type'],
    filters: [...grouped, 'query_contains', 'query_equals'], warnings: ['Keyword/match segmentation splits reported query rows. Missing keyword context is not proof of a missing keyword; this view excludes Performance Max.'] },
  campaign_search_terms: { resource: 'campaign_search_term_view', dimensions: [...campaign, d('search_term', 'campaign_search_term_view.search_term'),
    d('search_term_match_type', 'segments.search_term_match_type')], order: ['campaign.id', 'campaign_search_term_view.search_term', 'segments.search_term_match_type'],
    filters: [...common, 'query_contains', 'query_equals'], warnings: ['Campaign-level reported search terms can include Performance Max. Low-volume terms can be withheld. No keyword or ad-group segments are selected, which would exclude Performance Max.'] },
  asset_performance: { resource: 'campaign_asset', dimensions: [...campaign, d('asset_id', 'asset.id', 'id'), d('asset_type', 'asset.type'), d('field_type', 'campaign_asset.field_type')],
    order: ['campaign.id', 'asset.id', 'campaign_asset.field_type'], filters: ['campaign_id', 'asset_id'], warnings: ['Metrics describe campaign-asset associations. Asset rows can overlap ad activity; they are not additive campaign totals.'] },
  asset_groups: { resource: 'asset_group', dimensions: [...campaign, d('asset_group_id', 'asset_group.id', 'id'), d('asset_group_name', 'asset_group.name'),
    d('current_status', 'asset_group.status'), d('current_ad_strength', 'asset_group.ad_strength')], order: ['campaign.id', 'asset_group.id'], filters: ['campaign_id', 'asset_group_id'],
    warnings: ['Asset-group status and strength describe current configuration. No rows may mean the campaign has no supported asset groups.'] },
  ad_asset_performance: { resource: 'ad_group_ad_asset_view', dimensions: [...adGroup, d('ad_id', 'ad_group_ad.ad.id', 'id'),
    d('asset_id', 'asset.id', 'id'), d('asset_type', 'asset.type'), d('field_type', 'ad_group_ad_asset_view.field_type'),
    d('performance_label', 'ad_group_ad_asset_view.performance_label'), d('asset_source', 'ad_group_ad_asset_view.source')],
    order: ['ad_group.id', 'ad_group_ad.ad.id', 'asset.id', 'ad_group_ad_asset_view.field_type'], filters: ['campaign_id', 'ad_group_id', 'ad_id', 'asset_id'],
    warnings: ['Metrics describe ad-asset associations, including responsive-search headlines/descriptions. NOT_APPLICABLE labels do not mean metrics are absent. Assets can overlap ad activity; do not sum them as campaign totals. Read asset_inventory for content by asset_id.'] },
  expanded_landing_pages: { resource: 'expanded_landing_page_view', dimensions: [...campaign, d('page', 'expanded_landing_page_view.expanded_final_url', 'url')],
    order: ['campaign.id', 'expanded_landing_page_view.expanded_final_url'], filters: common,
    warnings: ['Expanded destinations differ from unexpanded landing-page templates. URL queries/fragments are withheld; distinct destinations can have identical displayed URLs.'] },
  conversion_lag: { resource: 'campaign', dimensions: [...campaign, d('conversion_action_id', 'segments.conversion_action', 'conversion_action'),
    d('conversion_action_name', 'segments.conversion_action_name'), d('lag_bucket', 'segments.conversion_lag_bucket')],
    order: ['campaign.id', 'segments.conversion_action', 'segments.conversion_lag_bucket'], filters: ['campaign_id', 'conversion_action_id'],
    metrics: ['conversions', 'all_conversions'], rates: false, rankBy: 'all_conversions',
    warnings: ['The reporting window uses ad-interaction dates; the lag bucket describes delay to conversion. Recent cohorts are incomplete and can change. No spend or CPA is returned.'] },
  search_categories: { resource: 'campaign_search_term_insight', requiresCampaign: true,
    dimensions: [...campaign, { ...d('category_id', 'campaign_search_term_insight.id', 'category_id'), definition: 'Google search category ID; 0 is the uncategorized bucket, not a missing ID.' },
      d('category', 'campaign_search_term_insight.category_label')], order: ['campaign.id', 'campaign_search_term_insight.id'],
    filters: ['campaign_id', 'category_id'], metrics: ['impressions', 'clicks'], rates: false, rankBy: 'clicks',
    warnings: ['Requires one campaign_id. Google category insights are a separate aggregation from visible search terms; do not reconstruct withheld queries from categories. An empty label can denote the uncategorized bucket.'] },
  click_types: { resource: 'campaign', dimensions: [...campaign, d('click_type', 'segments.click_type')],
    order: ['campaign.id', 'segments.click_type'], filters: ['campaign_id'],
    warnings: ['Click types distinguish interactions such as URL clicks, directions and sitelinks. Segmented impressions can overlap; do not sum or average these rows as an overall rate.'] },
  parental_status: demographic('parental_status_view', 'parental_status', 'ad_group_criterion.parental_status.type'),
  age_ranges: demographic('age_range_view', 'age_range', 'ad_group_criterion.age_range.type'),
  genders: demographic('gender_view', 'gender', 'ad_group_criterion.gender.type'),
  income_ranges: demographic('income_range_view', 'income_range', 'ad_group_criterion.income_range.type'),
  conversion_dates: { resource: 'campaign', dimensions: [...campaign, d('date', 'segments.date', 'date'),
    d('conversion_action_id', 'segments.conversion_action', 'conversion_action'), d('conversion_action_name', 'segments.conversion_action_name')],
    order: ['segments.date', 'campaign.id', 'segments.conversion_action'], filters: ['campaign_id', 'conversion_action_id'],
    metrics: ['conversions_by_conversion_date', 'all_conversions_by_conversion_date', 'conversion_value_by_conversion_date', 'all_conversion_value_by_conversion_date'],
    rates: false, chronological: true, dateBasis: 'conversion', warnings: ['Dates identify when conversions occurred, not the ad interaction. Do not combine these counts with interaction-date spend to calculate CPA. No spend or CPA is returned.'] },
};

type Metric = { field: string; unit: string; definition: string; kind?: 'money' | 'score'; bound?: 'lower' | 'upper' };
const fraction = (name: string, definition: string, bound?: Metric['bound']): Metric => ({ field: `metrics.${name}`, unit: 'fraction', definition, bound });
export const GOOGLE_ADS_METRICS: Record<string, Metric> = {
  impressions: { field: 'metrics.impressions', unit: 'impressions', definition: 'Recorded ad impressions; not website page views.' },
  clicks: { field: 'metrics.clicks', unit: 'clicks', definition: 'Recorded ad clicks; not GA4 sessions or unique visitors.' },
  cost: { field: 'metrics.cost_micros', unit: 'currency', kind: 'money', definition: 'Recorded advertising spend in the account currency, converted from micros.' },
  conversions: { field: 'metrics.conversions', unit: 'attributed_conversions', definition: 'Google Ads conversions under the campaign goal configuration. Attribution can produce fractional counts; these are not unique CRM leads.' },
  all_conversions: { field: 'metrics.all_conversions', unit: 'attributed_conversions', definition: 'Includes additional conversion actions such as directions and other local actions. Keep separate from conversions and sales leads.' },
  conversion_value: { field: 'metrics.conversions_value', unit: 'currency', definition: 'Recorded Google Ads conversion value. Zero or a configured value is not proof of closed CRM revenue.' },
  all_conversion_value: { field: 'metrics.all_conversions_value', unit: 'currency', definition: 'Recorded value of all attributed conversion actions, including secondary actions; not verified CRM revenue.' },
  search_impression_share: fraction('search_impression_share', 'Share of eligible Search impressions. Google reports values below 10% as a bound.', 'lower'),
  search_budget_lost_impression_share: fraction('search_budget_lost_impression_share', 'Estimated Search impression share lost to budget. Values above 90% are a bound.', 'upper'),
  search_rank_lost_impression_share: fraction('search_rank_lost_impression_share', 'Estimated Search impression share lost to rank. Values above 90% are a bound.', 'upper'),
  search_top_impression_share: fraction('search_top_impression_share', 'Top Search impressions divided by estimated eligible top impressions; values below 10% are a bound.', 'lower'),
  search_absolute_top_impression_share: fraction('search_absolute_top_impression_share', 'Absolute-top Search impressions divided by estimated eligible absolute-top impressions; values below 10% are a bound.', 'lower'),
  search_click_share: fraction('search_click_share', 'Estimated share of eligible Search clicks; values below 10% are a bound.', 'lower'),
  top_impression_percentage: fraction('top_impression_percentage', 'Share of recorded impressions shown above organic results; distinct from eligible impression share.'),
  absolute_top_impression_percentage: fraction('absolute_top_impression_percentage', 'Share of recorded impressions in the very first ad position.'),
  invalid_clicks: { field: 'metrics.invalid_clicks', unit: 'clicks', definition: 'Google-classified invalid clicks; not additional valid clicks.' },
  invalid_click_rate: fraction('invalid_click_rate', 'Google-reported invalid-click rate.'),
  phone_calls: { field: 'metrics.phone_calls', unit: 'calls', definition: 'Google-recorded phone calls, not unique leads or all business calls.' },
  phone_impressions: { field: 'metrics.phone_impressions', unit: 'impressions', definition: 'Impressions with a phone number displayed.' },
  phone_through_rate: fraction('phone_through_rate', 'Google-reported phone calls divided by phone impressions.'),
  historical_quality_score: { field: 'metrics.historical_quality_score', unit: 'quality_score', kind: 'score', definition: 'Historical keyword quality score, 1–10, for the returned date; missing is unavailable.' },
  current_cpc_bid: { field: 'ad_group_criterion.cpc_bid_micros', unit: 'currency', kind: 'money', definition: 'Current keyword CPC bid at retrieval, not a historical bid or actual CPC.' },
  conversions_by_conversion_date: { field: 'metrics.conversions_by_conversion_date', unit: 'attributed_conversions', definition: 'Google Ads conversions dated by conversion occurrence, not ad interaction or unique CRM leads.' },
  all_conversions_by_conversion_date: { field: 'metrics.all_conversions_by_conversion_date', unit: 'attributed_conversions', definition: 'All attributed conversion actions dated by occurrence, including additional actions.' },
  all_conversion_value_by_conversion_date: { field: 'metrics.all_conversions_value_by_conversion_date', unit: 'currency', definition: 'Recorded all-conversion value dated by conversion occurrence, not ad interaction or verified CRM revenue.' },
  conversion_value_by_conversion_date: { field: 'metrics.conversions_value_by_conversion_date', unit: 'currency', definition: 'Recorded conversion value dated by occurrence, not verified CRM revenue.' },
};
export const GOOGLE_ADS_RATES = {
  ctr: { numerator: 'clicks', denominator: 'impressions', unit: 'fraction', definition: 'Clicks / impressions in the same aggregate; null when impressions are zero.' },
  average_cpc: { numerator: 'cost', denominator: 'clicks', unit: 'currency', definition: 'Spend / clicks in the same aggregate; null when clicks are zero.' },
  cost_per_conversion: { numerator: 'cost', denominator: 'conversions', unit: 'currency', definition: 'Spend / Google Ads conversions in the same aggregate, not cost per unique lead; null when conversions are zero.' },
} as const;

/** Field names are application constants, never supplied by a caller. */
export function adsField(row: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[part.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] : undefined, row);
}
