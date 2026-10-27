import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { googleAdsCapabilities, googleAdsFilters, googleAdsReport, readGoogleAdsCampaign } from '../src/lib/google-ads';
import { GOOGLE_ADS_PRESETS, GOOGLE_ADS_REPORTS, GOOGLE_ADS_SECTIONS, GOOGLE_ADS_ACCOUNT_SECTIONS } from '../src/lib/google-ads-catalog';
import { googleAdsCapabilitiesOutput, googleAdsFiltersOutput, googleAdsReportOutput, googleAdsCampaignOutput } from '../src/lib/google-ads-tooling';
import { ga4Report } from '../src/lib/analytics';
import { analyticsReportOutput } from '../src/lib/analytics-tooling';

// Opt-in, real read-only Google requests. No OpenAI or business writes. The
// customer is supplied by the operator, never chosen from a caller's input.
describe.skipIf(process.env.CONTEXT_LIVE_GOOGLE_ADS_TEST !== '1')('live Google Ads and linked GA4 reports', () => {
  let filters: Awaited<ReturnType<typeof googleAdsFilters>>;
  let campaign: string;
  let group: string | undefined;
  const saved = { ...process.env };
  const fetch = globalThis.fetch;
  beforeAll(async () => {
    const env = parseEnv(await readFile('.env.local', 'utf8'));
    for (const key of ['GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTY_ID', 'GOOGLE_ADS_CUSTOMER_ID']) {
      if (!process.env[key] && env[key]) process.env[key] = env[key];
    }
    // Report provider enums for debugging, never raw errors or credentials.
    globalThis.fetch = async (...args) => {
      const response = await fetch(...args);
      if (!response.ok && String(args[0]).startsWith('https://googleads.googleapis.com/')) {
        const body = await response.clone().json().catch(() => ({}));
        console.error('Google Ads status', response.status, JSON.stringify(body.error?.details?.flatMap((detail: { errors?: { errorCode: unknown }[] }) => detail.errors?.map(error => error.errorCode) ?? [])));
      }
      return response;
    };
    const capabilities = await googleAdsCapabilities();
    expect(googleAdsCapabilitiesOutput.parse(capabilities).status).toBe('available');
    filters = await googleAdsFilters(new URLSearchParams());
    googleAdsFiltersOutput.parse(filters);
    expect(filters.ad_groups_loaded).toBe(false);
    campaign = filters.campaigns[0]?.id;
    expect(campaign).toBeTruthy();
    const scoped = await googleAdsFilters(new URLSearchParams({ campaign_id: campaign }));
    googleAdsFiltersOutput.parse(scoped);
    expect(scoped.ad_groups_loaded).toBe(true);
    expect(scoped.campaigns.every(row => row.id === campaign)).toBe(true);
    group = scoped.ad_groups[0]?.id;
  }, 40_000);
  afterAll(() => {
    globalThis.fetch = fetch;
    for (const key of ['GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTY_ID', 'GOOGLE_ADS_CUSTOMER_ID']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  it.each(GOOGLE_ADS_REPORTS)('reads and validates %s', async report => {
    const result = await googleAdsReport(new URLSearchParams({ report, limit: '2', ...(GOOGLE_ADS_PRESETS[report].requiresCampaign ? { campaign_id: campaign } : {}) }));
    googleAdsReportOutput.parse(result);
    expect(result.source.property).toBe(process.env.GOOGLE_ADS_CUSTOMER_ID);
    if (report === 'keywords') {
      expect(result.columns.find(column => column.name === 'current_quality_score')?.definition).toContain('not a historical score');
      expect(result.columns.some(column => column.name === 'quality_score')).toBe(false);
    }
    if (report === 'locations') {
      expect(result.columns.some(column => column.name === 'targeting_location')).toBe(true);
      for (const item of result.items) expect(['true', 'false', null]).toContain(item.dimensions.targeting_location);
    }
    if (result.nextCursor) {
      const next = await googleAdsReport(new URLSearchParams({ report, limit: '2', cursor: result.nextCursor, ...(GOOGLE_ADS_PRESETS[report].requiresCampaign ? { campaign_id: campaign } : {}) }));
      googleAdsReportOutput.parse(next);
      expect(next.pagination.offset).toBe(2);
      expect(next.items[0]).not.toEqual(result.items[0]);
    }
    const filtered = await googleAdsReport(new URLSearchParams({ report, campaign_id: campaign, limit: '2',
      ...(group && GOOGLE_ADS_PRESETS[report].filters.includes('ad_group_id') ? { ad_group_id: group } : {}) }));
    googleAdsReportOutput.parse(filtered);
    for (const row of filtered.items) if (row.dimensions.campaign_id) expect(row.dimensions.campaign_id).toBe(campaign);
  }, 40_000);
  it.each(GOOGLE_ADS_SECTIONS.filter(s => !['asset_inventory', 'audiences'].includes(s)))('reads campaign %s', async section => {
    const result = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section }));
    googleAdsCampaignOutput.parse(result);
    expect(result.campaign?.id).toBe(campaign);
    if (section === 'changes') for (const item of result.items) {
      expect(item.values.changed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/);
    }
    if (result.nextCursor) {
      const next = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section, cursor: result.nextCursor }));
      expect(next.pagination.offset).toBe(result.items.length);
      googleAdsCampaignOutput.parse(next);
    }
  }, 40_000);
  it.each(GOOGLE_ADS_ACCOUNT_SECTIONS)('reads account %s without a campaign ID', async section => {
    const result = await readGoogleAdsCampaign(null, new URLSearchParams({ section, limit: '2' }));
    googleAdsCampaignOutput.parse(result);
    expect(result.scope).toBe('account');
    expect(result.campaign).toBeNull();
    if (result.nextCursor) {
      const next = await readGoogleAdsCampaign(null, new URLSearchParams({ section, limit: '2', cursor: result.nextCursor }));
      googleAdsCampaignOutput.parse(next);
      expect(next.pagination.offset).toBe(2);
    }
  }, 40_000);
  it('accepts a bounded settings limit and keeps dates exclusive to changes', async () => {
    const result = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'settings', limit: '25' }));
    googleAdsCampaignOutput.parse(result);
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(result.query_context).toBeNull();
    await expect(readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'targeting', period: 'last_28_days' }))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  }, 40_000);
  it('compares complete aggregates and preserves conversion definitions', async () => {
    const result = await googleAdsReport(new URLSearchParams({ period: 'last_7_days', compare_to: 'previous_period', campaign_id: campaign }));
    googleAdsReportOutput.parse(result);
    expect(result.quality.totals_included).toBe(true);
    expect(result.comparison?.baseline.quality.totals_included).toBe(true);
    expect(result.columns.map(column => column.name)).toEqual(expect.arrayContaining(['conversions', 'all_conversions', 'cost', 'cost_per_conversion']));
    if (filters.conversion_actions[0]) {
      const selected = await googleAdsReport(new URLSearchParams({ report: 'conversions', conversion_action_id: filters.conversion_actions[0].id }));
      googleAdsReportOutput.parse(selected);
      expect(selected.items.every(row => row.dimensions.conversion_action_id === filters.conversion_actions[0].id)).toBe(true);
      expect(selected.columns.some(column => column.name === 'cost')).toBe(false);
    }
  }, 40_000);
  it('executes literal keyword/search filters and exact segment enums', async () => {
    const cases: Record<string, string>[] = [{ report: 'keywords', keyword_contains: 'warehouse', match_type: 'PHRASE' },
      { report: 'search_terms', query_contains: 'warehouse' }, { report: 'search_terms', query_equals: "warehouse ' OR 1 = 1" },
      { report: 'campaigns', campaign_status: 'ENABLED', device: 'mobile', network: 'SEARCH' }];
    for (const args of cases) {
      const result = await googleAdsReport(new URLSearchParams(args));
      googleAdsReportOutput.parse(result);
      if ('query_equals' in args) expect(result.items).toHaveLength(0);
      if ('query_contains' in args || 'keyword_contains' in args) {
        expect(result.items.length).toBeGreaterThan(0);
        for (const item of result.items) expect((item.dimensions.search_term ?? item.dimensions.keyword)?.toLowerCase()).toContain('warehouse');
      }
    }
  }, 40_000);
  it.each(GOOGLE_ADS_REPORTS.filter(report => GOOGLE_ADS_PRESETS[report].filters.includes('device') && GOOGLE_ADS_PRESETS[report].filters.includes('network')))('selects exact device and network filters for %s without losing its aggregate', async report => {
    const result = await googleAdsReport(new URLSearchParams({ report, campaign_id: campaign, device: 'mobile', network: 'SEARCH', limit: '1' }));
    googleAdsReportOutput.parse(result);
    expect(result.query_context).toMatchObject({ device: 'mobile', network: 'SEARCH' });
    if (report === 'overview') expect(result.items.length).toBeLessThanOrEqual(1);
  }, 40_000);
  it('retrieves shared/ad-group exclusions and diagnoses current delivery', async () => {
    const lists = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'negative_lists', origin: 'shared', limit: '25' }));
    expect(lists.items.length).toBeGreaterThan(0);
    for (const list of lists.items) {
      const result = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'negative_keywords', origin: 'shared', shared_set_id: String(list.values.shared_set_id), limit: '25' }));
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every(item => item.values.origin === 'shared' && item.values.shared_set_id === list.values.shared_set_id)).toBe(true);
    }
    const groups = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'negative_keywords', origin: 'ad_group' }));
    expect(groups.items.length).toBeGreaterThan(0);
    expect(groups.items.every(item => item.values.ad_group_id)).toBe(true);
    const settings = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'settings' }));
    expect(settings.items[0].values.primary_status).toBeTruthy();
    expect(settings.items[0].values.cpc_bid_ceiling).toBeGreaterThan(0);
  }, 60_000);
  it('paginates real discovery and retains account recommendations and assets', async () => {
    let cursor: string | null = null; const ids: string[] = [];
    do {
      const page = await googleAdsFilters(new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) }));
      googleAdsFiltersOutput.parse(page); ids.push(...page.conversion_actions.map(action => action.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(filters.conversion_actions.map(action => action.id).sort());
    const recommendations = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'recommendations', origin: 'account' }));
    expect(recommendations.items.some(item => item.values.type === 'PERFORMANCE_MAX_OPT_IN')).toBe(true);
    const assets = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'assets', origin: 'account' }));
    expect(assets.items.some(item => item.values.asset_type === 'PRICE')).toBe(true);
    const image = assets.items.find(item => item.values.asset_type === 'IMAGE');
    expect(image?.values.image_url).toMatch(/^https:\/\/tpc\.googlesyndication\.com\/simgad\/[0-9]+$/);
    googleAdsCampaignOutput.parse(assets);
  }, 90_000);
  it('preserves typed change paths and conversion-date semantics', async () => {
    const changes = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'changes', limit: '25' }));
    for (const item of changes.items) {
      expect(String(item.values.changed_fields)).not.toContain('[link omitted]');
      if (item.values.changed_resource) expect(item.values.changed_resource).toMatch(/^customers\//);
    }
    const dates = await googleAdsReport(new URLSearchParams({ report: 'conversion_dates', campaign_id: campaign }));
    expect(dates.interpretation.date_basis).toBe('conversion');
    expect(dates.columns.some(column => column.name === 'cost')).toBe(false);
    const goals = await readGoogleAdsCampaign(campaign, new URLSearchParams({ section: 'conversion_goals', limit: '25' }));
    expect(goals.items.some(item => item.values.goal_config_level === 'CUSTOMER')).toBe(true);
    expect(goals.items.some(item => item.values.biddable === false)).toBe(true);
  }, 60_000);
  it.each(['ads_costs', 'ads_campaigns', 'ads_keywords', 'ads_queries'])('reads linked GA4 %s with a campaign filter', async report => {
    const result = await ga4Report(new URLSearchParams({ report, campaign_id: campaign, limit: '2' }));
    analyticsReportOutput.parse(result);
    expect(result.source.system).toBe('ga4');
    expect(result.items.every(row => (row.dimensions.googleAdsCampaignId ?? row.dimensions.sessionGoogleAdsCampaignId) === campaign)).toBe(true);
  }, 40_000);
});
