import { GOOGLE_ADS_SECTIONS } from './google-ads-catalog';

export type DetailField = { name: string; field: string; select?: string;
  kind?: 'id' | 'money' | 'number' | 'url' | 'image_url' | 'texts' | 'strings' | 'urls' | 'resources' | 'boolean' | 'proto_boolean' | 'constant' | 'resource' | 'resource_id' | 'timestamp' | 'field_mask' | 'prices' };
export const GOOGLE_ADS_DETAIL_LIST_LIMITS = { texts: 20, strings: 20, urls: 20, resources: 500, prices: 20 } as const;
const f = (name: string, field: string, kind?: DetailField['kind']): DetailField => ({ name, field, kind });
export const ASSET_FIELDS: DetailField[] = [f('asset_id', 'asset.id', 'id'), f('asset_type', 'asset.type'), f('name', 'asset.name'),
  f('final_urls', 'asset.final_urls', 'urls'), f('sitelink_text', 'asset.sitelink_asset.link_text'), f('sitelink_description_1', 'asset.sitelink_asset.description1'),
  f('sitelink_description_2', 'asset.sitelink_asset.description2'), f('callout_text', 'asset.callout_asset.callout_text'), f('text', 'asset.text_asset.text'),
  f('image_url', 'asset.image_asset.full_size.url', 'image_url'), f('youtube_video_id', 'asset.youtube_video_asset.youtube_video_id'),
  f('snippet_header', 'asset.structured_snippet_asset.header'), f('snippet_values', 'asset.structured_snippet_asset.values', 'strings'),
  f('lead_form_headline', 'asset.lead_form_asset.headline'), f('lead_form_business_name', 'asset.lead_form_asset.business_name'),
  f('lead_form_call_to_action', 'asset.lead_form_asset.call_to_action_type'),
  f('price_type', 'asset.price_asset.type'), f('price_qualifier', 'asset.price_asset.price_qualifier'), f('price_offerings', 'asset.price_asset.price_offerings', 'prices')];
export const SHARED_KEYWORD_FIELDS: DetailField[] = [f('shared_set_id', 'shared_criterion.shared_set', 'resource_id'),
  f('id', 'shared_criterion.criterion_id', 'id'), f('keyword', 'shared_criterion.keyword.text'), f('match_type', 'shared_criterion.keyword.match_type')];
export const GOOGLE_ADS_DETAILS: Record<typeof GOOGLE_ADS_SECTIONS[number], { resource: string; fields: DetailField[]; order: string[] }> = {
  settings: { resource: 'campaign', order: [], fields: [
    { name: 'id', field: 'campaign.id', kind: 'id' }, { name: 'name', field: 'campaign.name' }, { name: 'status', field: 'campaign.status' },
    { name: 'channel', field: 'campaign.advertising_channel_type' }, { name: 'bidding_strategy', field: 'campaign.bidding_strategy_type' },
    { name: 'budget_id', field: 'campaign_budget.id', kind: 'id' }, { name: 'budget_name', field: 'campaign_budget.name' },
    { name: 'budget_amount', field: 'campaign_budget.amount_micros', kind: 'money' }, { name: 'budget_shared', field: 'campaign_budget.explicitly_shared', kind: 'boolean' },
    { name: 'budget_period', field: 'campaign_budget.period' },
    f('primary_status', 'campaign.primary_status'), f('primary_status_reasons', 'campaign.primary_status_reasons', 'strings'), f('serving_status', 'campaign.serving_status'),
    f('cpc_bid_ceiling', 'campaign.target_spend.cpc_bid_ceiling_micros', 'money'), f('target_cpa', 'campaign.target_cpa.target_cpa_micros', 'money'),
    f('target_roas', 'campaign.target_roas.target_roas', 'number'),
    f('maximize_conversions_target_cpa', 'campaign.maximize_conversions.target_cpa_micros', 'money'),
    f('maximize_conversion_value_target_roas', 'campaign.maximize_conversion_value.target_roas', 'number'),
    f('optimization_score', 'campaign.optimization_score', 'number'), f('bidding_system_status', 'campaign.bidding_strategy_system_status'),
    f('target_google_search', 'campaign.network_settings.target_google_search', 'boolean'), f('target_search_partners', 'campaign.network_settings.target_search_network', 'boolean'),
    f('target_content_network', 'campaign.network_settings.target_content_network', 'boolean'),
    f('positive_geo_target_type', 'campaign.geo_target_type_setting.positive_geo_target_type'), f('negative_geo_target_type', 'campaign.geo_target_type_setting.negative_geo_target_type'),
  ] },
  ad_group_settings: { resource: 'ad_group', order: ['ad_group.id'], fields: [f('campaign_id', 'campaign.id', 'id'),
    f('ad_group_id', 'ad_group.id', 'id'), f('name', 'ad_group.name'), f('type', 'ad_group.type'), f('status', 'ad_group.status'),
    f('primary_status', 'ad_group.primary_status'), f('primary_status_reasons', 'ad_group.primary_status_reasons', 'strings'),
    f('cpc_bid', 'ad_group.cpc_bid_micros', 'money'), f('target_cpa', 'ad_group.target_cpa_micros', 'money'),
    f('target_roas', 'ad_group.target_roas', 'number'), f('effective_target_cpa', 'ad_group.effective_target_cpa_micros', 'money'),
    f('effective_target_roas', 'ad_group.effective_target_roas', 'number')] },
  asset_inventory: { resource: 'asset', order: ['asset.id'], fields: ASSET_FIELDS },
  audiences: { resource: 'user_list', order: ['user_list.id'], fields: [f('user_list_id', 'user_list.id', 'id'), f('name', 'user_list.name'),
    f('type', 'user_list.type'), f('membership_status', 'user_list.membership_status'), f('size_for_search', 'user_list.size_for_search', 'number'),
    f('size_for_display', 'user_list.size_for_display', 'number')] },
  targeting: { resource: 'campaign_criterion', order: ['campaign_criterion.criterion_id'], fields: [
    { name: 'id', field: 'campaign_criterion.criterion_id', kind: 'id' }, { name: 'type', field: 'campaign_criterion.type' },
    { name: 'negative', field: 'campaign_criterion.negative', kind: 'boolean' }, { name: 'location_id', field: 'campaign_criterion.location.geo_target_constant', kind: 'constant' },
    { name: 'language_id', field: 'campaign_criterion.language.language_constant', kind: 'constant' }, { name: 'day_of_week', field: 'campaign_criterion.ad_schedule.day_of_week' },
    { name: 'start_hour', field: 'campaign_criterion.ad_schedule.start_hour' }, { name: 'end_hour', field: 'campaign_criterion.ad_schedule.end_hour' },
    { name: 'start_minute', field: 'campaign_criterion.ad_schedule.start_minute' }, { name: 'end_minute', field: 'campaign_criterion.ad_schedule.end_minute' },
    f('status', 'campaign_criterion.status'), f('device', 'campaign_criterion.device.type'), f('bid_modifier', 'campaign_criterion.bid_modifier', 'number'),
  ] },
  negative_keywords: { resource: 'campaign_criterion', order: ['campaign_criterion.criterion_id'], fields: [
    { name: 'id', field: 'campaign_criterion.criterion_id', kind: 'id' }, { name: 'keyword', field: 'campaign_criterion.keyword.text' }, { name: 'match_type', field: 'campaign_criterion.keyword.match_type' },
    f('status', 'campaign_criterion.status'),
  ] },
  negative_lists: { resource: 'campaign_shared_set', order: ['shared_set.id'], fields: [f('shared_set_id', 'shared_set.id', 'id'),
    f('name', 'shared_set.name'), f('type', 'shared_set.type'), f('status', 'shared_set.status'), f('link_status', 'campaign_shared_set.status'),
    f('member_count', 'shared_set.member_count', 'number'), f('resource', 'campaign_shared_set.shared_set', 'resource')] },
  creatives: { resource: 'ad_group_ad', order: ['ad_group.id', 'ad_group_ad.ad.id'], fields: [
    { name: 'ad_group_id', field: 'ad_group.id', kind: 'id' }, { name: 'id', field: 'ad_group_ad.ad.id', kind: 'id' }, { name: 'type', field: 'ad_group_ad.ad.type' },
    { name: 'status', field: 'ad_group_ad.status' }, { name: 'approval_status', field: 'ad_group_ad.policy_summary.approval_status' },
    { name: 'final_urls', field: 'ad_group_ad.ad.final_urls', kind: 'urls' }, { name: 'headlines', field: 'ad_group_ad.ad.responsive_search_ad.headlines', kind: 'texts' },
    { name: 'descriptions', field: 'ad_group_ad.ad.responsive_search_ad.descriptions', kind: 'texts' },
    f('ad_strength', 'ad_group_ad.ad_strength'), f('primary_status', 'ad_group_ad.primary_status'), f('primary_status_reasons', 'ad_group_ad.primary_status_reasons', 'strings'),
    f('review_status', 'ad_group_ad.policy_summary.review_status'),
  ] },
  assets: { resource: 'campaign_asset', order: ['asset.id', 'campaign_asset.field_type'], fields: [f('campaign_id', 'campaign.id', 'id'),
    f('field_type', 'campaign_asset.field_type'), f('status', 'campaign_asset.status'), ...ASSET_FIELDS] },
  asset_groups: { resource: 'asset_group', order: ['asset_group.id'], fields: [f('campaign_id', 'campaign.id', 'id'), f('id', 'asset_group.id', 'id'),
    f('name', 'asset_group.name'), f('status', 'asset_group.status'), f('ad_strength', 'asset_group.ad_strength'),
    f('primary_status', 'asset_group.primary_status'), f('primary_status_reasons', 'asset_group.primary_status_reasons', 'strings'), f('final_urls', 'asset_group.final_urls', 'urls')] },
  conversion_actions: { resource: 'conversion_action', order: ['conversion_action.id'], fields: [f('id', 'conversion_action.id', 'id'), f('name', 'conversion_action.name'),
    f('status', 'conversion_action.status'), f('type', 'conversion_action.type'), f('category', 'conversion_action.category'), f('primary_for_goal', 'conversion_action.primary_for_goal', 'boolean'),
    f('counting_type', 'conversion_action.counting_type'), f('click_through_lookback_days', 'conversion_action.click_through_lookback_window_days', 'number'),
    f('view_through_lookback_days', 'conversion_action.view_through_lookback_window_days', 'number'), f('attribution_model', 'conversion_action.attribution_model_settings.attribution_model'),
    f('default_value', 'conversion_action.value_settings.default_value', 'number'), f('default_currency', 'conversion_action.value_settings.default_currency_code'),
    f('always_use_default_value', 'conversion_action.value_settings.always_use_default_value', 'boolean')] },
  conversion_goals: { resource: 'campaign_conversion_goal', order: ['campaign_conversion_goal.category', 'campaign_conversion_goal.origin'], fields: [
    f('category', 'campaign_conversion_goal.category'), f('conversion_origin', 'campaign_conversion_goal.origin'),
    // These goal flags are non-optional proto3 booleans; omission encodes false.
    f('biddable', 'campaign_conversion_goal.biddable', 'proto_boolean')] },
  recommendations: { resource: 'recommendation', order: ['recommendation.type'], fields: [
    f('resource', 'recommendation.resource_name', 'resource'), f('campaign_id', 'recommendation.campaign', 'resource_id'), f('ad_group_id', 'recommendation.ad_group', 'resource_id'),
    { name: 'type', field: 'recommendation.type' }, { name: 'dismissed', field: 'recommendation.dismissed', kind: 'boolean' },
    ...(['base', 'potential'] as const).flatMap(basis => ['impressions', 'clicks', 'conversions', 'cost_micros'].map(metric => ({
      name: `${basis}_${metric === 'cost_micros' ? 'cost' : metric}`, field: `recommendation.impact.${basis}_metrics.${metric}`, select: 'recommendation.impact',
      kind: metric === 'cost_micros' ? 'money' as const : 'number' as const }))),
    { name: 'recommended_budget', field: 'recommendation.campaign_budget_recommendation.recommended_budget_amount_micros', select: 'recommendation.campaign_budget_recommendation', kind: 'money' },
    { name: 'recommended_keyword', field: 'recommendation.keyword_recommendation.keyword.text', select: 'recommendation.keyword_recommendation' },
    { name: 'recommended_keyword_match_type', field: 'recommendation.keyword_recommendation.keyword.match_type', select: 'recommendation.keyword_recommendation' },
    { name: 'recommended_target_cpa', field: 'recommendation.target_cpa_opt_in_recommendation.recommended_target_cpa_micros', select: 'recommendation.target_cpa_opt_in_recommendation', kind: 'money' },
  ] },
  changes: { resource: 'change_event', order: ['change_event.change_date_time DESC'], fields: [
    { name: 'changed_at', field: 'change_event.change_date_time', kind: 'timestamp' }, { name: 'resource_type', field: 'change_event.change_resource_type' },
    { name: 'operation', field: 'change_event.resource_change_operation' }, { name: 'client_type', field: 'change_event.client_type' }, { name: 'changed_fields', field: 'change_event.changed_fields', kind: 'field_mask' },
    f('changed_resource', 'change_event.change_resource_name', 'resource'),
  ] },
};
