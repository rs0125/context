import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAdsCapabilities, googleAdsFilters, googleAdsReport, readGoogleAdsCampaign } from '../src/lib/google-ads';
import { googleAdsCampaignOutput, googleAdsFiltersOutput, googleAdsReportOutput } from '../src/lib/google-ads-tooling';
import { adsContains, adsId, validateGoogleAdsCampaign, validateGoogleAdsReport } from '../src/lib/google-ads-query';
import { GOOGLE_ADS_REPORTS, GOOGLE_ADS_SECTIONS, GOOGLE_ADS_PRESETS } from '../src/lib/google-ads-catalog';
import { HttpError } from '../src/lib/errors';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/lib/analytics-google', async original => ({
  ...await original<typeof import('../src/lib/analytics-google')>(),
  analyticsCredentials: () => ({ identity: 'test-identity' }), googleAnalyticsRead: read,
}));
const account = { id: '1234567890', descriptiveName: 'Example Ads', currencyCode: 'INR', timeZone: 'Asia/Kolkata', manager: false, testAccount: false };
const row = {
  customer: account, campaign: { id: '123', name: 'Local', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'TARGET_SPEND' },
  campaignBudget: { id: '88', name: 'Daily budget', amountMicros: '100000000', explicitlyShared: false, period: 'DAILY' },
  adGroup: { id: '456', name: 'Warehouses', status: 'ENABLED' },
  adGroupAd: { status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED' }, ad: { id: '789', type: 'RESPONSIVE_SEARCH_AD',
    finalUrls: ['https://example.test/warehouses?private=secret#token'], responsiveSearchAd: { headlines: [{ text: 'Contact me 9876543210' }], descriptions: [{ text: 'Find warehouse space' }] } } },
  adGroupCriterion: { criterionId: '99', keyword: { text: 'warehouse', matchType: 'PHRASE' }, qualityInfo: { qualityScore: 7 } },
  searchTermView: { searchTerm: 'warehouse bangalore', status: 'ADDED' }, landingPageView: { unexpandedFinalUrl: 'https://example.test/listings?private=secret' },
  userLocationView: { countryCriterionId: '2356', targetingLocation: true }, geoTargetConstant: { id: '2356', name: 'India' }, languageConstant: { id: '1000', name: 'English' },
  conversionAction: { id: '777', name: 'Sales lead', category: 'SUBMIT_LEAD_FORM', status: 'ENABLED', primaryForGoal: true },
  segments: { date: '2026-10-24', device: 'MOBILE', adNetworkType: 'SEARCH', dayOfWeek: 'SATURDAY', hour: 0,
    geoTargetRegion: 'geoTargetConstants/0', geoTargetCity: 'geoTargetConstants/0', conversionAction: 'customers/1234567890/conversionActions/777',
    conversionActionName: 'Sales lead', conversionActionCategory: 'SUBMIT_LEAD_FORM' },
  campaignCriterion: { criterionId: '888', type: 'LANGUAGE', negative: false, language: { languageConstant: 'languageConstants/1000' }, keyword: { text: 'jobs', matchType: 'BROAD' } },
  sharedSet: { id: '555', name: 'Exclusions', status: 'ENABLED', type: 'NEGATIVE_KEYWORDS', resourceName: 'customers/1234567890/sharedSets/555', memberCount: '1' },
  campaignSharedSet: { sharedSet: 'customers/1234567890/sharedSets/555', status: 'ENABLED' },
  sharedCriterion: { sharedSet: 'customers/1234567890/sharedSets/555', criterionId: '666', keyword: { text: 'jobs', matchType: 'BROAD' } },
  customerNegativeCriterion: { negativeKeywordList: { sharedSet: 'customers/1234567890/sharedSets/555' } },
  recommendation: { type: 'KEYWORD', dismissed: false, resourceName: 'customers/1234567890/recommendations/abc' },
  changeEvent: { changeDateTime: '2026-10-24 10:25:00.253279', changeResourceType: 'CAMPAIGN', resourceChangeOperation: 'UPDATE', clientType: 'GOOGLE_ADS_WEB_CLIENT',
    changedFields: 'name,status', userEmail: 'private@example.test', oldResource: { private: 'secret' }, resourceName: 'customers/1234567890/changeEvents/123' },
  metrics: { impressions: '100', clicks: '10', costMicros: '12300000', conversions: 2.5, allConversions: 4.5, conversionsValue: 25, allConversionsValue: 45 }, private: 'secret',
};
type Row = Record<string, unknown>;
let rows: (query: string) => Row[];
let accountRow: typeof account;
let fieldMask: string | undefined;
const params = (values: string | Record<string, string> = '') => new URLSearchParams(values);
const reportQuery = () => read.mock.calls.at(-1)![1].query as string;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
  vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', account.id);
  rows = () => [structuredClone(row)]; accountRow = { ...account }; fieldMask = undefined;
  read.mockReset().mockImplementation(async (_destination, body: { query: string }, project: (value: unknown) => unknown) => {
    const fields = body.query.match(/^SELECT (.+?) FROM /)![1].split(', ');
    return { data: project({ results: body.query.includes('customer.currency_code') ? [{ customer: accountRow }] : rows(body.query),
      fieldMask: fieldMask ?? fields.map(field => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())).join(',') }),
    source_fetched_at: '2026-10-26T08:59:30.000Z', cache_hit: true };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Google Ads validation and fixed query scope', () => {
  it.each(['', '0', '-1', '001', '1e3', 'abc', '1 OR 1=1', '9223372036854775808', '12345678901234567890'])('rejects invalid ID %s without throwing outside validation', value => {
    expect(adsId.safeParse(value).success).toBe(false);
    expect(() => validateGoogleAdsCampaign(value, params())).toThrow(HttpError);
  });
  it.each(['customer_id=1234567890', 'query=SELECT', 'report=raw', 'report=overview&query_contains=warehouse',
    'report=campaigns&ad_group_id=456', 'report=keywords&compare_to=previous_period', 'report=overview&cursor=anything',
    'report=search_terms&query_contains=a&query_equals=b', 'report=keywords&keyword_contains=private%40example.test',
    'report=search_terms&query_equals=private%2540example.test', 'report=keywords&keyword_contains=bad%00label',
    'limit=1e1', 'limit=26', 'report=daily&report=overview', 'date_from=2026-02-30&date_to=2026-03-01',
    'date_from=2026-10-01', 'period=today&date_from=2026-10-01&date_to=2026-10-02'])('rejects invalid options before source access: %s', async query => {
    await expect(googleAdsReport(params(query))).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
    expect(read).not.toHaveBeenCalled();
  });
  it('escapes literal regex and GAQL string metacharacters', () => {
    expect(adsContains('search_term_view.search_term', "a.b'\\c[?]"))
      .toBe("search_term_view.search_term REGEXP_MATCH '(?i).*a\\\\.b\\'\\\\\\\\c\\\\[\\\\?\\\\].*'" );
  });
  it('rejects prototype-shaped unknown discovery parameters', async () => {
    await expect(googleAdsFilters(params('__proto__=value'))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(read).not.toHaveBeenCalled();
  });
  it('selects exact device/network segments without making overview a top-N sum', async () => {
    const result = await googleAdsReport(params('campaign_id=123&ad_group_id=456&device=mobile&network=SEARCH'));
    googleAdsReportOutput.parse(result);
    expect(reportQuery()).toContain("FROM ad_group WHERE segments.date BETWEEN '2026-09-28' AND '2026-10-25' AND campaign.id = 123 AND ad_group.id = 456 AND segments.device = 'MOBILE' AND segments.ad_network_type = 'SEARCH'");
    expect(reportQuery()).toContain('segments.device, segments.ad_network_type');
    expect(reportQuery()).toMatch(/ LIMIT 1$/);
    expect(result.items[0].dimensions).toEqual({});
    expect(result.quality.totals_included).toBe(true);
  });
});

describe('Google Ads discovery, projection and pagination', () => {
  it('distinguishes unloaded ad groups, scoped groups, duplicate names and capped lists', async () => {
    rows = () => Array.from({ length: 101 }, (_, i) => ({ ...row, campaign: { ...row.campaign, id: String(i + 1) } }));
    const result = await googleAdsFilters(params());
    googleAdsFiltersOutput.parse(result);
    expect(result.campaigns).toHaveLength(100);
    expect(result.campaigns_truncated).toBe(true);
    expect(new Set(result.campaigns.map(item => item.id)).size).toBe(100);
    expect(result.ad_groups_loaded).toBe(false);
    expect(read.mock.calls.some(([, body]) => body.query.includes(' FROM ad_group '))).toBe(false);
    const scoped = await googleAdsFilters(params('campaign_id=123'));
    expect(scoped.ad_groups_loaded).toBe(true);
    expect(scoped.ad_groups_truncated).toBe(true);
    expect(reportQuery()).toContain('FROM ad_group WHERE campaign.id = 123');
  });
  it.each(GOOGLE_ADS_REPORTS)('projects the fixed %s report into its public contract', async report => {
    const result = await googleAdsReport(params({ report, ...(GOOGLE_ADS_PRESETS[report].requiresCampaign ? { campaign_id: '123' } : {}) }));
    googleAdsReportOutput.parse(result);
    expect(JSON.stringify(result)).not.toMatch(/private@example|9876543210|private=secret|oldResource|userEmail/);
    expect(result.source).toMatchObject({ system: 'google_ads', currency: 'INR', timezone: 'Asia/Kolkata' });
    if (GOOGLE_ADS_PRESETS[report].rates !== false) expect(result.items[0].metrics).toMatchObject({ cost: 12.3, ctr: 0.1, average_cpc: 1.23, cost_per_conversion: 4.92, conversions: 2.5, all_conversions: 4.5 });
    else if (report === 'conversions') expect(Object.keys(result.items[0].metrics)).toEqual(['conversions', 'all_conversions', 'conversion_value', 'all_conversion_value']);
    else expect(result.items[0].metrics).not.toHaveProperty('cost');
  });
  it('preserves absent optional metrics and withholds unsafe numbers and undefined rates', async () => {
    rows = () => [{ ...row, metrics: { conversions: 0.00000000000000000001, clicks: '9007199254740992', costMicros: '1000000' } }];
    const result = await googleAdsReport(params());
    expect(result.items[0].metrics).toMatchObject({ impressions: null, clicks: null, all_conversions: null, cost: 1, ctr: null, average_cpc: null, cost_per_conversion: null });
    expect(result.items[0].verification_required).toBe(true);
  });
  it('does not manufacture zero spend or rates from an absent selected cost', async () => {
    const { costMicros: _cost, ...metrics } = row.metrics;
    rows = () => [{ ...row, metrics }];
    const result = await googleAdsReport(params());
    googleAdsReportOutput.parse(result);
    expect(result.items[0].metrics).toMatchObject({ cost: null, average_cpc: null, cost_per_conversion: null, clicks: 10, ctr: 0.1 });
    expect(result.items[0].verification_required).toBe(true);
    expect(result.quality.warnings.join(' ')).toContain('null, not zero');
  });
  it('retains explicit zero activity without flagging it as missing', async () => {
    rows = () => [{ ...row, metrics: { impressions: '0', clicks: '0', costMicros: '0', conversions: 0, allConversions: 0, conversionsValue: 0, allConversionsValue: 0 } }];
    const result = await googleAdsReport(params());
    expect(result.items[0].metrics).toEqual({ impressions: 0, clicks: 0, cost: 0, conversions: 0, all_conversions: 0, conversion_value: 0, all_conversion_value: 0,
      ctr: null, average_cpc: null, cost_per_conversion: null });
    expect(result.items[0].verification_required).toBe(false);
  });
  it('never interprets a missing field mask as zero metrics', async () => {
    fieldMask = 'customer.id';
    await expect(googleAdsReport(params())).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it('compares full aggregates and keeps zero-baseline rates undefined', async () => {
    rows = query => [{ ...row, metrics: query.includes("'2026-10-12'")
      ? { impressions: '0', clicks: '0', costMicros: '0', conversions: 0, allConversions: 0, conversionsValue: 0, allConversionsValue: 0 } : row.metrics }];
    const result = await googleAdsReport(params('period=last_7_days&compare_to=previous_period'));
    googleAdsReportOutput.parse(result);
    expect(result.comparison?.baseline.query_context).toMatchObject({ date_from: '2026-10-12', date_to: '2026-10-18', compare_to: null });
    expect(result.comparison?.metrics.find(metric => metric.name === 'cost')).toMatchObject({ previous: 0, current: 12.3, relative_change_percent: null, status: 'zero_baseline' });
    expect(result.comparison?.metrics.find(metric => metric.name === 'ctr')?.status).toBe('missing_data');
  });
  it('withholds comparisons when a selected baseline metric is absent', async () => {
    rows = query => [{ ...row, metrics: query.includes("'2026-10-12'") ? {} : row.metrics }];
    const result = await googleAdsReport(params('period=last_7_days&compare_to=previous_period'));
    expect(result.comparison?.metrics.find(metric => metric.name === 'cost')).toMatchObject({ previous: null, current: 12.3,
      absolute_change: null, relative_change_percent: null, status: 'missing_data' });
  });
  it('labels the quality score as current when reporting historical keyword performance', async () => {
    const result = await googleAdsReport(params('report=keywords&date_from=2026-08-01&date_to=2026-08-31'));
    expect(result.items[0].dimensions.current_quality_score).toBe('7');
    expect(result.items[0].dimensions).not.toHaveProperty('quality_score');
    expect(result.columns.find(column => column.name === 'current_quality_score')?.definition).toContain('not a historical score');
    expect(result.quality.warnings.join(' ')).toContain('current keyword configuration');
    expect((await googleAdsCapabilities()).reports.find(report => report.name === 'keywords')?.dimensions).toContain('current_quality_score');
  });
  it('preserves targeted, untargeted and unavailable classifications on otherwise identical locations', async () => {
    rows = query => query.includes(' FROM geo_target_constant ') ? [{ geoTargetConstant: row.geoTargetConstant }]
      : [true, false, undefined].map(targetingLocation => ({ ...row, userLocationView: { ...row.userLocationView, targetingLocation } }));
    const result = await googleAdsReport(params('report=locations'));
    googleAdsReportOutput.parse(result);
    expect(result.items.map(item => item.dimensions.targeting_location)).toEqual(['true', 'false', null]);
    expect(result.items[0].dimensions).not.toEqual(result.items[1].dimensions);
    const query = read.mock.calls.find(([, body]) => body.query.includes(' FROM user_location_view '))![1].query;
    expect(query).toContain('user_location_view.targeting_location ASC');
  });
  it.each([7, 25])('binds cursors and stops at 500 rows with page size %s', async limit => {
    rows = () => Array.from({ length: 501 }, (_, i) => ({ ...row, campaign: { ...row.campaign, id: String(i + 1) } }));
    let cursor: string | null = null;
    let returned = 0;
    for (let offset = 0; offset < 500; offset += limit) {
      const result = await googleAdsReport(params({ report: 'campaigns', limit: String(limit), ...(cursor ? { cursor } : {}) }));
      returned += result.items.length;
      expect(result.pagination.offset).toBe(offset);
      expect(result.items[0].dimensions.campaign_id).toBe(String(offset + 1));
      expect(result.quality.data_truncated).toBe(true);
      if (offset === 0) {
        const changedFilters: Record<string, string>[] = [{ campaign_id: '123' }, { period: 'last_7_days' }, { report: 'ads' }];
        for (const change of changedFilters) {
          await expect(googleAdsReport(params({ report: 'campaigns', cursor: result.nextCursor!, ...change }))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
        }
      }
      cursor = result.nextCursor;
      if (offset + limit >= 500) expect(result.pagination).toMatchObject({ has_more: false, cap_reached: true, source_row_count: null });
    }
    expect(returned).toBe(500);
    expect(cursor).toBeNull();
  });
  it('reports absent configuration independently and rejects manager/test accounts', async () => {
    vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', '');
    expect(await googleAdsCapabilities()).toMatchObject({ status: 'not_configured', account: null });
    expect(read).not.toHaveBeenCalled();
    vi.stubEnv('GOOGLE_ADS_CUSTOMER_ID', account.id);
    accountRow.manager = true;
    await expect(googleAdsFilters(params())).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
    accountRow = { ...account, testAccount: true };
    await expect(googleAdsFilters(params())).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
});

describe('Google Ads campaign details', () => {
  it.each(GOOGLE_ADS_SECTIONS.filter(s => !['asset_inventory', 'audiences'].includes(s)))('returns only permitted %s fields', async section => {
    const result = await readGoogleAdsCampaign('123', params({ section }));
    googleAdsCampaignOutput.parse(result);
    expect(JSON.stringify(result)).not.toMatch(/private@example|9876543210|private=secret|oldResource|userEmail/);
    if (section === 'changes') expect(result.items[0].values.changed_at).toBe('2026-10-24 10:25:00.253279');
    if (section === 'settings') expect(result.items[0].values.budget_amount).toBe(100);
    if (section === 'targeting') expect(result.items[0].values).toMatchObject({ language_id: '1000', language_name: 'English' });
  });
  it('returns not-found for an account-scoped missing campaign before section reads', async () => {
    rows = () => [];
    await expect(readGoogleAdsCampaign('999', params('section=creatives'))).rejects.toMatchObject({ status: 404 });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('accepts a bounded settings limit without turning the single campaign into a paged report', async () => {
    const result = await readGoogleAdsCampaign('123', params('section=settings&limit=25'));
    googleAdsCampaignOutput.parse(result);
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(reportQuery()).toMatch(/ LIMIT 1$/);
  });
  it.each(['2026-02-30 10:25:00', '2026-10-24 24:00:00', '2026-10-24 10:60:00', '2026-10-24 10:25:60',
    '2026-10-24 10:25:00.1234567', '2026-10-24 10:25:00 private@example.test'])('rejects a malformed source timestamp: %s', async timestamp => {
    rows = () => [{ ...row, changeEvent: { ...row.changeEvent, changeDateTime: timestamp } }];
    await expect(readGoogleAdsCampaign('123', params('section=changes'))).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it.each(['2026-10-24 10:25:00', '2026-10-24 10:25:00.1', '2026-10-24 10:25:00.253279'])('preserves valid account-local timestamp precision: %s', async timestamp => {
    rows = () => [{ ...row, changeEvent: { ...row.changeEvent, changeDateTime: timestamp } }];
    const result = await readGoogleAdsCampaign('123', params('section=changes'));
    expect(result.items[0].values.changed_at).toBe(timestamp);
    expect(result.items[0].redacted).toBe(false);
  });
  it.each([
    ['2026-10-26', '2026-10-25', '2026-10-26'],
    ['2026-10-01', '2026-09-30', '2026-10-01'],
    ['2026-01-01', '2025-12-31', '2026-01-01'],
    ['2024-03-01', '2024-02-29', '2024-03-01'],
  ])('includes the last fractional second and excludes the next day at %s', async (today, day, nextDay) => {
    vi.setSystemTime(new Date(`${today}T09:00:00Z`));
    const timestamps = [`${day} 23:59:59.253279`, `${nextDay} 00:00:00`];
    rows = query => {
      if (!query.includes(' FROM change_event ')) return [row];
      const end = query.match(/change_event\.change_date_time (<|<=) '([^']+)'/)!;
      return timestamps.filter(time => end[1] === '<' ? time < end[2] : time <= end[2])
        .map(changeDateTime => ({ changeEvent: { ...row.changeEvent, changeDateTime } }));
    };
    const result = await readGoogleAdsCampaign('123', params({ section: 'changes', date_from: day, date_to: day }));
    expect(result.items.map(item => item.values.changed_at)).toEqual([timestamps[0]]);
  });
  it.each(['section=settings&cursor=abc', 'section=targeting&period=today', 'section=changes&period=last_month', 'section=changes&date_from=2026-09-01&date_to=2026-09-02'])('rejects unsupported section/date combinations: %s', async query => {
    await expect(readGoogleAdsCampaign('123', params(query))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
});

describe('Ads semantic regressions and expanded coverage', () => {
  it.each(['keywords', 'keyword_diagnostics', 'search_terms', 'search_term_matches', 'campaign_search_terms'] as const)('matches known substrings in %s', async report => {
    const names = ['warehouse', 'warehouse for rent', 'Small Warehouse in Bengaluru'];
    rows = query => {
      const pattern = query.match(/REGEXP_MATCH '([^']+)'/)?.[1];
      if (!pattern) throw new Error('Missing substring filter');
      // Google REGEXP_MATCH applies the expression to the entire string.
      const expression = new RegExp(`^(?:${pattern.replace('(?i)', '')})$`, 'i');
      return names.filter(name => expression.test(name)).map(name => ({ ...row,
        adGroupCriterion: { ...row.adGroupCriterion, keyword: { text: name, matchType: 'PHRASE' } },
        searchTermView: { searchTerm: name, status: 'ADDED' }, campaignSearchTermView: { searchTerm: name } }));
    };
    const keyword = ['keywords', 'keyword_diagnostics'].includes(report);
    const result = await googleAdsReport(params({ report, [keyword ? 'keyword_contains' : 'query_contains']: 'warehouse' }));
    expect(result.items.map(item => item.dimensions[keyword ? 'keyword' : 'search_term'])).toEqual(names);
  });
  it.each([
    ['settings', 'budget_shared', 'campaignBudget', 'explicitlyShared'],
    ['targeting', 'negative', 'campaignCriterion', 'negative'],
    ['recommendations', 'dismissed', 'recommendation', 'dismissed'],
  ])('preserves unknown optional flags for %s', async (section, field, key, property) => {
    const fixture = structuredClone(row) as Row;
    delete (fixture[key] as Row)[property]; rows = () => [fixture];
    const result = await readGoogleAdsCampaign('123', params({ section }));
    expect(result.items[0].values[field]).toBeNull();
    expect(result.items[0].verification_required).toBe(true);
    googleAdsCampaignOutput.parse(result);
  });
  it('does not classify missing primary_for_goal as a secondary action', async () => {
    const { primaryForGoal: _flag, ...action } = row.conversionAction;
    rows = () => [{ ...row, conversionAction: action }];
    const result = await googleAdsFilters(params());
    expect(result.conversion_actions[0].primary_for_goal).toBeNull();
    googleAdsFiltersOutput.parse(result);
  });
  it('decodes non-optional protobuf goal flags as false while preserving explicit true', async () => {
    rows = () => [{ ...row, campaignConversionGoal: { category: 'CONTACT', origin: 'WEBSITE' },
      customerConversionGoal: { category: 'REQUEST_QUOTE', origin: 'WEBSITE', biddable: true }, conversionGoalCampaignConfig: { goalConfigLevel: 'CUSTOMER' } }];
    const result = await readGoogleAdsCampaign('123', params('section=conversion_goals&limit=25'));
    expect(result.items.find(item => item.values.origin === 'campaign')?.values.biddable).toBe(false);
    expect(result.items.find(item => item.values.origin === 'account')?.values.biddable).toBe(true);
    expect(result.items.find(item => item.values.origin === 'configuration')?.values.goal_config_level).toBe('CUSTOMER');
  });
  it.each(['keyword.text,keyword.matchType', { paths: ['keyword.text', 'keyword.matchType'] }])('preserves typed field paths: %j', async changedFields => {
    rows = () => [{ ...row, changeEvent: { ...row.changeEvent, changedFields } }];
    const result = await readGoogleAdsCampaign('123', params('section=changes'));
    expect(result.items[0].values.changed_fields).toBe('keyword.text,keyword.matchType');
    expect(result.items[0].redacted).toBe(false);
  });
  it.each(['keyword..text', 'https://private.example', 'text,private@example.test', { paths: [123] }, { paths: Array(257).fill('status') }])('rejects invalid typed field paths: %j', async changedFields => {
    rows = () => [{ ...row, changeEvent: { ...row.changeEvent, changedFields } }];
    await expect(readGoogleAdsCampaign('123', params('section=changes'))).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it('pages discovery beyond 100 and 500 choices without repeating exhausted lists', async () => {
    rows = query => {
      const kind = query.includes(' FROM conversion_action ') ? 'conversion_action' : 'campaign';
      const total = kind === 'campaign' ? 603 : 102;
      const after = Number(query.match(/\.id > (\d+)/)?.[1] ?? 0);
      const limit = Number(query.match(/ LIMIT (\d+)$/)![1]);
      return Array.from({ length: Math.min(limit, total - after) }, (_, index) => {
        const id = String(after + index + 1);
        return kind === 'campaign' ? { campaign: { ...row.campaign, id } } : { conversionAction: { ...row.conversionAction, id } };
      });
    };
    const campaigns: string[] = []; const actions: string[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const result = await googleAdsFilters(params(cursor ? { cursor } : {}));
      googleAdsFiltersOutput.parse(result);
      campaigns.push(...result.campaigns.map(item => item.id)); actions.push(...result.conversion_actions.map(item => item.id));
      cursor = result.nextCursor; pages++;
      if (pages > 2) expect(result.conversion_actions).toEqual([]);
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(campaigns).toHaveLength(603); expect(new Set(campaigns).size).toBe(603);
    expect(actions).toHaveLength(102); expect(new Set(actions).size).toBe(102);
  });
  it('binds discovery cursors to the campaign and page size', async () => {
    rows = () => Array.from({ length: 101 }, (_, index) => ({ ...row, campaign: { ...row.campaign, id: String(index + 1) } }));
    const first = await googleAdsFilters(params()); expect(first.nextCursor).toBeTruthy();
    for (const extra of [{ limit: '99' }, { campaign_id: '123' }] as Record<string, string>[]) await expect(googleAdsFilters(params({ ...extra, cursor: first.nextCursor! }))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
  it('keeps impression-share bounds distinct from exact percentages', async () => {
    rows = () => [{ ...row, metrics: { ...row.metrics, searchImpressionShare: 0.0999, searchRankLostImpressionShare: 0.9001, searchBudgetLostImpressionShare: 0.2 } }];
    const result = await googleAdsReport(params('report=campaign_diagnostics'));
    expect(result.items[0].metrics).toMatchObject({ search_impression_share: null, search_rank_lost_impression_share: null, search_budget_lost_impression_share: 0.2 });
    expect(result.items[0].metric_bounds).toEqual({ search_impression_share: { operator: 'lt', value: 0.1 }, search_rank_lost_impression_share: { operator: 'gt', value: 0.9 } });
    googleAdsReportOutput.parse(result);
  });
  it('keeps conversion-occurrence dates separate from spend and interaction dates', async () => {
    rows = () => [{ ...row, metrics: { conversionsByConversionDate: 2, allConversionsByConversionDate: 3, conversionsValueByConversionDate: -4, allConversionsValueByConversionDate: -6 } }];
    const result = await googleAdsReport(params('report=conversion_dates'));
    expect(result.items[0].metrics).toEqual({ conversions_by_conversion_date: 2, all_conversions_by_conversion_date: 3, conversion_value_by_conversion_date: -4, all_conversion_value_by_conversion_date: -6 });
    expect(result.interpretation.date_basis).toBe('conversion'); expect(result.quality.aggregation_type).toBe('google_ads_conversion_date');
    expect(result.columns.some(column => ['cost', 'cost_per_conversion'].includes(column.name))).toBe(false);
    expect(result.quality.warnings.join(' ')).toContain('conversion occurrence');
  });
  it('preserves asset association identity rather than collapsing shared assets', async () => {
    rows = () => ['SITELINK', 'BUSINESS_NAME'].map(fieldType => ({ ...row, asset: { id: '55', type: 'TEXT' }, campaignAsset: { fieldType } }));
    const result = await googleAdsReport(params('report=asset_performance'));
    expect(result.items[0].dimensions).not.toEqual(result.items[1].dimensions);
  });
  it('projects populated Performance Max search terms and asset groups without keyword segmentation', async () => {
    rows = () => [{ ...row, campaign: { ...row.campaign, advertisingChannelType: 'PERFORMANCE_MAX' },
      campaignSearchTermView: { searchTerm: 'warehouse storage' },
      assetGroup: { id: '765', name: 'Storage', status: 'ENABLED', adStrength: 'GOOD', primaryStatus: 'ELIGIBLE', finalUrls: ['https://example.test/storage?tracking=hidden'] } }];
    const terms = await googleAdsReport(params('report=campaign_search_terms'));
    expect(terms.items[0].dimensions).toMatchObject({ campaign_id: '123', search_term: 'warehouse storage' });
    expect(reportQuery()).not.toMatch(/segments\.keyword|ad_group/);
    const performance = await googleAdsReport(params('report=asset_groups&asset_group_id=765'));
    expect(performance.items[0].dimensions).toMatchObject({ asset_group_id: '765', current_ad_strength: 'GOOD' });
    const configuration = await readGoogleAdsCampaign('123', params('section=asset_groups&asset_group_id=765'));
    expect(configuration.items[0].values).toMatchObject({ id: '765', primary_status: 'ELIGIBLE', final_urls: ['https://example.test/storage'] });
  });
  it('returns custom goal action membership alongside campaign and account defaults', async () => {
    const custom = 'customers/1234567890/customConversionGoals/42';
    rows = () => [{ ...row, conversionGoalCampaignConfig: { goalConfigLevel: 'CAMPAIGN', customConversionGoal: custom },
      customConversionGoal: { resourceName: custom, name: 'Qualified enquiries', status: 'ENABLED', conversionActions: ['customers/1234567890/conversionActions/777'] } }];
    const result = await readGoogleAdsCampaign('123', params('section=conversion_goals&limit=25'));
    expect(result.items.find(item => item.values.origin === 'configuration')?.values).toMatchObject({ goal_config_level: 'CAMPAIGN', custom_goal: custom });
    expect(result.items.find(item => item.values.origin === 'custom_goal')?.values).toMatchObject({ resource: custom, conversion_actions: ['customers/1234567890/conversionActions/777'] });
    googleAdsCampaignOutput.parse(result);
  });
  it('keeps conversion default currency distinct from the Ads account currency', async () => {
    rows = () => [{ ...row, conversionAction: { ...row.conversionAction, valueSettings: { defaultValue: 20, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: true } } }];
    const result = await readGoogleAdsCampaign('123', params('section=conversion_actions'));
    expect(result.source.currency).toBe('INR');
    expect(result.items[0].values).toMatchObject({ default_value: 20, default_currency: 'USD', always_use_default_value: true });
  });
  it('combines exclusions with distinct origins and IDs instead of deduplicating their text', async () => {
    rows = () => [{ ...row, adGroupCriterion: { ...row.adGroupCriterion, keyword: row.campaignCriterion.keyword } }];
    const result = await readGoogleAdsCampaign('123', params('section=negative_keywords&limit=25'));
    expect(result.items.map(item => item.values.origin).sort()).toEqual(['account', 'ad_group', 'campaign', 'shared']);
    expect(result.items.map(item => item.values.keyword)).toEqual(['jobs', 'jobs', 'jobs', 'jobs']);
    expect(result.items.find(item => item.values.origin === 'ad_group')?.values.ad_group_id).toBe('456');
    expect(result.items.find(item => item.values.origin === 'shared')?.values.shared_set_id).toBe('555');
    expect(result.components.map(item => item.name)).toContain('account_list_links');
  });
  it('narrows shared-list reads without reading unrelated keyword sources', async () => {
    const result = await readGoogleAdsCampaign('123', params('section=negative_keywords&origin=shared&shared_set_id=555'));
    expect(result.items.every(item => item.values.origin === 'shared')).toBe(true);
    const queries = read.mock.calls.map(([, body]) => body.query as string);
    expect(queries.some(query => query.includes(' FROM ad_group_criterion ') || query.includes(' FROM customer_negative_criterion '))).toBe(false);
    expect(queries.find(query => query.includes(' FROM campaign_shared_set '))).toContain('shared_set.id = 555');
  });
  it('discloses cross-account shared lists without querying their members', async () => {
    rows = () => [{ ...row, campaignSharedSet: { ...row.campaignSharedSet, sharedSet: 'customers/9999999999/sharedSets/555' } }];
    const result = await readGoogleAdsCampaign('123', params('section=negative_keywords&origin=shared'));
    expect(result.items).toEqual([]); expect(result.quality.coverage_complete).toBe(false);
    expect(result.quality.unavailable_resources).toEqual(['customers/9999999999/sharedSets/555']);
    expect(read.mock.calls.some(([, body]) => body.query.includes(' FROM shared_criterion '))).toBe(false);
  });
  it('bounds unavailable list references across independent exclusion sources', async () => {
    rows = query => query.includes(' FROM campaign ') ? [row] : Array.from({ length: 500 }, (_, index) => ({ ...row,
      campaignSharedSet: { sharedSet: `customers/9999999999/sharedSets/${index + 1}` },
      customerNegativeCriterion: { id: String(index + 501), negativeKeywordList: { sharedSet: `customers/9999999999/sharedSets/${index + 501}` } } }));
    const result = await readGoogleAdsCampaign('123', params('section=negative_lists'));
    expect(result.quality.unavailable_resources).toHaveLength(500);
    expect(result.quality).toMatchObject({ coverage_complete: false, data_truncated: true });
    googleAdsCampaignOutput.parse(result);
  });
  it('preserves recommendation identity, scope and optional impact amounts', async () => {
    rows = query => [{ ...row, recommendation: { ...row.recommendation,
      resourceName: `customers/1234567890/recommendations/${query.includes('IS NULL') ? 'account' : 'campaign'}`,
      impact: { baseMetrics: { costMicros: '1500000', clicks: 2 }, potentialMetrics: { costMicros: '2000000', clicks: 3 } } } }];
    const result = await readGoogleAdsCampaign('123', params('section=recommendations'));
    expect(result.items.map(item => item.values.origin)).toEqual(['account', 'campaign']);
    expect(new Set(result.items.map(item => item.values.resource)).size).toBe(2);
    expect(result.items[0].values).toMatchObject({ base_cost: 1.5, potential_cost: 2, base_conversions: null });
  });
  it('fails a combined section if an account component is unavailable', async () => {
    rows = query => { if (query.includes('recommendation.campaign IS NULL')) throw new HttpError(503, 'ANALYTICS_SOURCE_UNAVAILABLE', 'Unavailable'); return [row]; };
    await expect(readGoogleAdsCampaign('123', params('section=recommendations'))).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_UNAVAILABLE' });
  });
  it('projects price offerings with their own currency and masks text/URL contacts', async () => {
    rows = () => [{ ...row, asset: { id: '55', type: 'PRICE', priceAsset: { priceOfferings: [{ header: 'Space 9876543210', description: 'private@example.test',
      price: { amountMicros: '25000000', currencyCode: 'USD' }, unit: 'PER_MONTH', finalUrl: 'https://example.test/space?private=secret' }] } }, customerAsset: { fieldType: 'PRICE', status: 'ENABLED' } }];
    const result = await readGoogleAdsCampaign('123', params('section=assets&origin=account'));
    expect(result.items[0].values.price_offerings).toEqual([{ header: expect.stringContaining('[phone omitted]'), description: expect.stringContaining('[email omitted]'),
      amount: 25, currency: 'USD', unit: 'PER_MONTH', final_url: 'https://example.test/space' }]);
    expect(result.items[0].redacted).toBe(true); googleAdsCampaignOutput.parse(result);
  });
  it.each([
    ['https://tpc.googlesyndication.com/simgad/12345678901234567890', 'https://tpc.googlesyndication.com/simgad/12345678901234567890', false],
    ['https://tpc.googlesyndication.com/simgad/12345678901234567890?secret=hidden#private', 'https://tpc.googlesyndication.com/simgad/12345678901234567890', true],
    ['https://tpc.googlesyndication.com.evil.test/simgad/9876543210', 'https://tpc.googlesyndication.com.evil.test/simgad/[phone omitted]', true],
    ['https://example.test/contact/9876543210', 'https://example.test/contact/[phone omitted]', true],
  ])('preserves typed Google image IDs while sanitizing other URLs: %s', async (url, expected, redacted) => {
    rows = () => [{ ...row, asset: { id: '55', type: 'IMAGE', imageAsset: { fullSize: { url } } } }];
    const result = await readGoogleAdsCampaign('123', params('section=assets&origin=account'));
    expect(result.items[0].values.image_url).toBe(expected);
    expect(result.items[0].redacted).toBe(redacted);
  });
  it.each(['section=settings&origin=account', 'section=assets&origin=shared', 'section=negative_keywords&ad_group_id=456&origin=shared',
    'section=negative_keywords&ad_group_id=456&shared_set_id=555', 'section=targeting&asset_id=55', 'section=conversion_goals&date_from=2026-10-01&date_to=2026-10-02'])('rejects unsupported section filters: %s', async query => {
    await expect(readGoogleAdsCampaign('123', params(query))).rejects.toMatchObject({ code: 'INVALID_QUERY' }); expect(read).not.toHaveBeenCalled();
  });
});


describe('Ads review: nested bounds, explicit scope and populated coverage', () => {
  it.each([1, 21, 500, 501])('reports complete custom-goal membership or explicit truncation for %s members', async count => {
    const custom = 'customers/1234567890/customConversionGoals/42';
    const members = Array.from({ length: count }, (_, i) => `customers/1234567890/conversionActions/${i + 1}`);
    rows = query => query.includes(' FROM conversion_goal_campaign_config ')
      ? [{ conversionGoalCampaignConfig: { goalConfigLevel: 'CAMPAIGN', customConversionGoal: custom } }]
      : query.includes(' FROM custom_conversion_goal ')
        ? [{ customConversionGoal: { resourceName: custom, name: 'Goals', status: 'ENABLED', conversionActions: members } }]
        : query.includes(' FROM campaign ') ? [{ campaign: row.campaign }] : [];
    const result = await readGoogleAdsCampaign('123', params('section=conversion_goals&limit=25'));
    googleAdsCampaignOutput.parse(result);
    const goal = result.items.find(item => item.values.origin === 'custom_goal')!;
    expect(goal.values.conversion_actions).toEqual(members.slice(0, 500));
    expect(goal.truncated_fields).toEqual(count > 500 ? ['conversion_actions'] : []);
    expect(result.nextCursor).toBeNull();
    expect(result.quality).toMatchObject({ data_truncated: count > 500, coverage_complete: count <= 500, privacy_redactions: false });
    expect(result.components.find(component => component.name === 'custom_goal')?.data_truncated).toBe(count > 500);
  });
  it('marks nested string truncation separately from privacy redaction', async () => {
    rows = () => [{ asset: { id: '55', type: 'STRUCTURED_SNIPPET', structuredSnippetAsset: { header: 'Types', values: Array(21).fill('Warehouse') } } }];
    const result = await readGoogleAdsCampaign(null, params('section=asset_inventory'));
    expect(result.items[0].values.snippet_values).toHaveLength(20);
    expect(result.items[0].truncated_fields).toEqual(['snippet_values']);
    expect(result.quality).toMatchObject({ data_truncated: true, coverage_complete: false, privacy_redactions: false });
    expect(result.quality.warnings.join(' ')).not.toContain('500-row');
  });
  it.each(['asset_inventory', 'audiences', 'assets', 'conversion_actions', 'recommendations'])('reads account %s with no campaign existence dependency', async section => {
    rows = query => {
      if (query.includes(' FROM campaign ')) throw new Error('Account read must not fetch a campaign');
      if (query.includes(' FROM asset ')) return [{ asset: { id: '55', type: 'TEXT', textAsset: { text: 'Warehouse' } } }];
      if (query.includes(' FROM user_list ')) return [{ userList: { id: '66', name: 'Visitors', type: 'RULE_BASED', membershipStatus: 'OPEN', sizeForSearch: '0' } }];
      return [];
    };
    const result = await readGoogleAdsCampaign(null, params({ section }));
    googleAdsCampaignOutput.parse(result);
    expect(result.scope).toBe('account'); expect(result.campaign).toBeNull();
    expect(read.mock.calls.some(([, body]) => /campaign.id =|campaigns\/null/.test(body.query))).toBe(false);
  });
  it('pages full inventory and binds cursors to account scope, section and asset filters', async () => {
    rows = () => ['55', '56'].map(id => ({ asset: { id, type: 'TEXT', textAsset: { text: 'Warehouse' } } }));
    const first = await readGoogleAdsCampaign(null, params('section=asset_inventory&limit=1'));
    const next = await readGoogleAdsCampaign(null, params({ section: 'asset_inventory', limit: '1', cursor: first.nextCursor! }));
    expect(next.items[0].values.asset_id).toBe('56');
    await expect(readGoogleAdsCampaign(null, params({ section: 'asset_inventory', asset_id: '55', limit: '1', cursor: first.nextCursor! }))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(readGoogleAdsCampaign(null, params({ section: 'audiences', limit: '1', cursor: first.nextCursor! }))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
  it('projects lead-form/snippet content without leaking contacts, submissions or private URLs', async () => {
    rows = () => [{ asset: { id: '55', type: 'LEAD_FORM', leadFormAsset: { headline: 'Find space', businessName: 'Phone 9876543210', callToActionType: 'GET_STARTED', fields: [{ private: 'hidden lead' }] },
      structuredSnippetAsset: { header: 'Types', values: ['Warehouse', 'private@example.test'] }, finalUrls: ['https://example.test/form?token=private'] } }];
    const result = await readGoogleAdsCampaign(null, params('section=asset_inventory&asset_id=55'));
    expect(result.items[0].values).toMatchObject({ lead_form_headline: 'Find space', lead_form_call_to_action: 'GET_STARTED', snippet_header: 'Types', final_urls: ['https://example.test/form'] });
    expect(JSON.stringify(result)).not.toMatch(/9876543210|private@example|hidden lead|token=private/);
    expect(result.quality.privacy_redactions).toBe(true); expect(result.quality.data_truncated).toBe(false);
    expect(reportQuery()).toContain('asset.id = 55');
  });
  it('keeps per-ad asset identities distinct and exposes NOT_APPLICABLE metrics', async () => {
    rows = () => ['789', '790'].map(ad => ({ campaign: row.campaign, adGroup: row.adGroup,
      adGroupAd: { ad: { id: ad } }, asset: { id: '55', type: 'TEXT' }, adGroupAdAssetView: { fieldType: 'HEADLINE', performanceLabel: 'NOT_APPLICABLE', source: 'ADVERTISER' }, metrics: row.metrics }));
    const result = await googleAdsReport(params('report=ad_asset_performance&ad_id=789&asset_id=55'));
    expect(result.items.map(item => item.dimensions.ad_id)).toEqual(['789', '790']);
    expect(result.items[0].dimensions.performance_label).toBe('NOT_APPLICABLE');
    expect(result.items[0].metrics.clicks).toBe(10);
    expect(reportQuery()).toContain('ad_group_ad.ad.id = 789 AND asset.id = 55');
  });
  it('retains category zero, uses click ordering, and rejects unscoped category requests', async () => {
    await expect(googleAdsReport(params('report=search_categories'))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(read).not.toHaveBeenCalled();
    rows = () => [{ campaign: row.campaign, campaignSearchTermInsight: { id: '0', categoryLabel: '' }, metrics: { impressions: '100', clicks: '10' } }];
    const result = await googleAdsReport(params('report=search_categories&campaign_id=123&category_id=0'));
    expect(result.items[0].dimensions).toMatchObject({ category_id: '0', category: null });
    expect(result.items[0].metrics).toEqual({ impressions: 100, clicks: 10 });
    expect(reportQuery()).toContain('campaign_search_term_insight.id = 0');
    expect(reportQuery()).toContain('ORDER BY metrics.clicks DESC');
    expect(reportQuery()).not.toContain('cost_micros');
  });
  it.each(['conversion_dates', 'conversion_lag'] as const)('keeps action identity and no spend in %s', async report => {
    rows = () => [{ campaign: row.campaign, segments: { ...row.segments, conversionLagBucket: 'ONE_TO_TWO_DAYS' },
      metrics: { conversions: 2.5, allConversions: 3.5, conversionsByConversionDate: 2.5, allConversionsByConversionDate: 3.5, conversionsValueByConversionDate: 4, allConversionsValueByConversionDate: 7 } }];
    const result = await googleAdsReport(params({ report, conversion_action_id: '777' }));
    expect(result.items[0].dimensions.conversion_action_id).toBe('777');
    expect(result.items[0].dimensions.conversion_action_name).toBe('Sales lead');
    expect(result.items[0].metrics).not.toHaveProperty('cost');
    expect(reportQuery()).toContain("segments.conversion_action = 'customers/1234567890/conversionActions/777'");
    if (report === 'conversion_lag') expect(result.items[0].dimensions.lag_bucket).toBe('ONE_TO_TWO_DAYS');
  });
  it('keeps configured ad-group bids separate from actual CPC and preserves unknown fields', async () => {
    rows = query => query.includes(' FROM campaign ') ? [{ campaign: row.campaign }] : [{ campaign: row.campaign,
      adGroup: { id: '456', name: 'Warehouse', status: 'ENABLED', primaryStatus: 'ELIGIBLE', cpcBidMicros: '200000000', targetCpaMicros: '0' } }];
    const result = await readGoogleAdsCampaign('123', params('section=ad_group_settings&ad_group_id=456'));
    expect(result.items[0].values).toMatchObject({ ad_group_id: '456', primary_status: 'ELIGIBLE', cpc_bid: 200, target_cpa: 0, target_roas: null });
    expect(result.items[0].values).not.toHaveProperty('average_cpc');
    expect(reportQuery()).toContain('campaign.id = 123 AND ad_group.id = 456');
  });
  it('keeps expanded URL privacy and parental-status identity', async () => {
    rows = () => [{ campaign: row.campaign, adGroup: row.adGroup, adGroupCriterion: { criterionId: '99', parentalStatus: { type: 'PARENT' } },
      expandedLandingPageView: { expandedFinalUrl: 'https://example.test/page?email=private@example.test#secret' }, metrics: row.metrics }];
    const pages = await googleAdsReport(params('report=expanded_landing_pages'));
    expect(pages.items[0].dimensions.page).toBe('https://example.test/page'); expect(pages.quality.privacy_redactions).toBe(true);
    const parents = await googleAdsReport(params('report=parental_status'));
    expect(parents.items[0].dimensions).toMatchObject({ parental_status: 'PARENT', ad_group_id: '456', criterion_id: '99' });
  });
});
