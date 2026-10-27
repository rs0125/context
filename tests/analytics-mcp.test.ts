import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest } from '../src/lib/mcp';
vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
import type { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration } from '../src/lib/auth';
import { getOpenApiDocument } from '../src/lib/openapi';
import { buildAnalyticsComparison } from '../src/lib/analytics-comparison';

const origin = 'https://context.example.test';
const meta = { requestId: 'synthetic', generatedAt: '2026-09-26T12:00:00.000Z' };
const report = {
  source: { system: 'ga4', property: 'properties/123', timezone: 'Asia/Kolkata' },
  source_status: { status: 'available', read_only: true }, report: 'overview',
  query_context: { date_from: '2026-09-01', date_to: '2026-09-25', timezone: 'Asia/Kolkata', local_date: '2026-09-26',
    period: null, inclusive: true as const, includes_recent_days: true, event_name: null, event_names: [], query_contains: null, page_contains: null, data_state: null,
    landing_page_contains: null, device: null, country: null, channel: null, source: null,
    page_path_contains: null, campaign_id: null,
    query_equals: null, page_equals: null, query_not_contains: null, compare_to: null },
  interpretation: { aggregation: 'aggregate', page_basis: 'none', acquisition_basis: 'not_reported',
    individual_journeys_available: false, crm_linkage_available: false, event_counts_are_unique_leads: false,
    event_definitions: [], limits: ['Aggregate analytics cannot establish individual journeys or CRM attribution.'] },
  columns: [{ name: 'sessions', kind: 'metric', unit: 'count' }],
  items: [{ dimensions: {}, metrics: { sessions: 20 }, redacted: false, verification_required: false }],
  pagination: { limit: 10, returned_count: 1, has_more: false, next_cursor: null, offset: 0, source_row_count: 1,
    cap_reached: false, max_rows: 500, snapshot: false }, nextCursor: null,
  source_fetched_at: meta.generatedAt, served_at: meta.generatedAt, cache: { hit: false, age_seconds: 0, max_age_seconds: 300 },
  quality: { provisional: true, warnings: ['Recent data can change.'], data_loss_from_other_row: false, subject_to_thresholding: false,
    sampling: [], schema_restrictions: [], data_truncated: false, empty_reason: null, privacy_redactions: false,
    totals_included: true, first_incomplete_date: null, aggregation_type: null }, quota: null,
};
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());
async function withClient(scopes: KeyRegistration['scopes'], read: typeof handleApiRequest | undefined,
  work: (client: Client) => Promise<void>, platform: 'claude' | 'whatsapp' = 'claude') {
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'admin@example.test', scopes, expiresAt: '2099-01-01T00:00:00Z' };
  const client = new Client({ name: 'analytics-toy-harness', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: async (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => key, read, platform }),
  });
  try { await client.connect(transport); await work(client); } finally { await client.close(); }
}

describe('analytics MCP contract', () => {
  it.each(['claude', 'whatsapp'] as const)('routes all Ads tools with their bindings and output contracts on %s', async platform => {
    const source = { system: 'google_ads', property: '1234567890', account_name: 'Example', timezone: 'Asia/Kolkata', currency: 'INR' };
    const dates = { date_from: '2026-09-01', date_to: '2026-09-25', timezone: 'Asia/Kolkata', local_date: '2026-09-26', period: null, inclusive: true, includes_recent_days: true };
    const { quota: _quota, ...reportBase } = report;
    const data = { ...reportBase, source, query_context: { ...dates, report: 'overview', compare_to: null }, comparison: null,
      quality: { provisional: true, warnings: [], data_truncated: false, privacy_redactions: false, totals_included: true, aggregation_type: 'google_ads_interaction_date', empty_reason: null },
      interpretation: { aggregation: 'aggregate', conversion_basis: 'google_ads_campaign_goals', date_basis: 'ad_interaction', event_counts_are_unique_leads: false, crm_linkage_available: false, guidance: 'Separate metrics.' } };
    const choice = { id: '123', name: 'Example', status: 'ENABLED' };
    const filters = { source, read_only: true, campaign_id: null, campaigns: [choice], campaigns_truncated: false,
      nextCursor: null, pagination: { limit: 100, has_more: false, snapshot: false },
      ad_groups: [], ad_groups_truncated: false, ad_groups_loaded: false, conversion_actions: [], conversion_actions_truncated: false,
      devices: ['mobile'], networks: ['SEARCH'], campaign_statuses: ['ENABLED'], source_fetched_at: meta.generatedAt, served_at: meta.generatedAt, guidance: 'Use string IDs.' };
    const campaign = { source, source_status: report.source_status, source_fetched_at: report.source_fetched_at, served_at: report.served_at,
      cache: report.cache, pagination: report.pagination, nextCursor: null, campaign: choice, scope: 'campaign', section: 'creatives', query_context: null,
      quality: { data_truncated: false, privacy_redactions: false, warnings: [] }, items: [{ values: { id: '789', headlines: ['Warehouse space'] }, redacted: false, truncated_fields: [] }] };
    const read = vi.fn(async (request: Request, path: string[]) => {
      const params = new URL(request.url).searchParams;
      const expandedCampaign = { ...campaign, ...(path.at(-1) === 'account' ? { scope: 'account', campaign: null } : {}), section: params.get('section') ?? 'settings',
        components: [{ name: 'account_assets', source_fetched_at: report.source_fetched_at, cache: report.cache, data_truncated: false }],
        quality: { ...campaign.quality, coverage_complete: true, unavailable_resources: [] },
        items: [{ values: { origin: 'account', unknown_flag: null, changed_fields: 'keyword.text,keyword.matchType',
          price_offerings: [{ header: 'Space', description: 'Storage', amount: 25, currency: 'USD', unit: 'PER_MONTH', final_url: 'https://example.test/space' }] }, redacted: false, verification_required: true, truncated_fields: [] }] };
      const expandedReport = { ...data, report: params.get('report') ?? 'overview',
        items: [{ dimensions: { campaign_id: '123' }, metrics: { search_impression_share: null }, metric_bounds: { search_impression_share: { operator: 'lt', value: 0.1 } }, redacted: false, verification_required: false }] };
      return Response.json({ data: path.at(-1) === 'filters' ? filters : (path.includes('campaigns') || path.at(-1) === 'account') ? expandedCampaign : expandedReport, meta });
    });
    await withClient(['analytics:read'], read, async client => {
      const { tools } = await client.listTools();
      const cases = [
        { name: 'google_ads_filters', args: { campaign_id: '123' }, path: ['analytics', 'google-ads', 'filters'] },
        { name: 'google_ads_report', args: { report: 'overview', campaign_id: '123', period: 'last_28_days' }, path: ['analytics', 'google-ads'] },
        { name: 'read_google_ads_campaign', args: { scope: 'account', section: 'asset_inventory', asset_id: '789' }, path: ['analytics', 'google-ads', 'account'] },
        { name: 'read_google_ads_campaign', args: { id: '123', section: 'creatives' }, path: ['analytics', 'google-ads', 'campaigns', '123'] },
        { name: 'google_ads_filters', args: { campaign_id: '123', limit: 2, cursor: 'opaque_cursor' }, path: ['analytics', 'google-ads', 'filters'] },
        { name: 'google_ads_report', args: { report: 'campaign_diagnostics', campaign_id: '123' }, path: ['analytics', 'google-ads'] },
        { name: 'google_ads_report', args: { report: 'asset_groups', asset_group_id: '789' }, path: ['analytics', 'google-ads'] },
        { name: 'read_google_ads_campaign', args: { id: '123', section: 'negative_keywords', origin: 'shared', shared_set_id: '456' }, path: ['analytics', 'google-ads', 'campaigns', '123'] },
        { name: 'read_google_ads_campaign', args: { id: '123', section: 'assets', origin: 'account', asset_id: '789' }, path: ['analytics', 'google-ads', 'campaigns', '123'] },
      ];
      for (const entry of cases) {
        expect(tools.find(tool => tool.name === entry.name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        const result = await client.callTool({ name: entry.name, arguments: entry.args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 200, data: { source }, meta: { toolName: entry.name, argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        const [request, path] = read.mock.calls.at(-1)!;
        expect(path).toEqual(entry.path);
        for (const [name, value] of Object.entries(entry.args)) if (!['id', 'scope'].includes(name)) expect(new URL(request.url).searchParams.get(name)).toBe(String(value));
      }
    }, platform);
  });
  it('advertises the six bounded analytics tools only with the analytics grant', async () => {
    for (const granted of [false, true]) {
      await withClient(granted ? ['knowledge:read', 'analytics:read'] : ['knowledge:read'], undefined, async client => {
        const { tools } = await client.listTools();
        for (const name of ['analytics_capabilities', 'ga4_report', 'search_console_report', 'google_ads_filters', 'google_ads_report', 'read_google_ads_campaign']) {
          expect(tools.some(tool => tool.name === name)).toBe(granted);
        }
        if (granted) for (const tool of tools.filter(tool => ['ga4_report', 'search_console_report', 'google_ads_report', 'google_ads_filters', 'read_google_ads_campaign'].includes(tool.name))) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
          expect(tool.inputSchema.additionalProperties).toBe(false);
          expect(tool.inputSchema.properties).not.toHaveProperty('property_id');
          expect(tool.inputSchema.properties).not.toHaveProperty('credentials');
          expect(tool.inputSchema.properties).not.toHaveProperty('metric_set');
          expect(tool.inputSchema.properties).not.toHaveProperty('metrics');
        }
      });
    }
  });
  it.each([
    ['ga4_report', { report: 'pages', landing_page_contains: '/warehouses', device: 'mobile', country: 'India', channel: 'Organic Search', source: 'google', period: 'this_month', limit: 2 }, ['analytics', 'ga4']],
    ['search_console_report', { group: 'query_page', period: 'last_28_days', query_equals: 'warehouse bengaluru', query_not_contains: 'brand', page_equals: 'https://www.example.test/warehouses', device: 'mobile', country: 'ind', limit: 2 }, ['analytics', 'search-console']],
  ] as const)('routes %s through REST authorization and validates the structured result', async (name, args, path) => {
    const data = name === 'search_console_report' ? { ...report,
      source: { system: 'search_console', property: 'sc-domain:example.test', timezone: 'America/Los_Angeles' }, report: 'query_page',
      query_context: { ...report.query_context, timezone: 'America/Los_Angeles', data_state: 'final' },
      columns: [{ name: 'query', kind: 'dimension', unit: 'label' }, { name: 'page', kind: 'dimension', unit: 'url' }, { name: 'clicks', kind: 'metric', unit: 'count' }],
      items: [{ dimensions: { query: 'warehouse bengaluru', page: 'https://www.example.test/warehouses' }, metrics: { clicks: 20 }, redacted: false, verification_required: false }],
    } : { ...report, report: 'pages',
      columns: [{ name: 'pagePath', kind: 'dimension', unit: 'path' }, { name: 'screenPageViews', kind: 'metric', unit: 'count' }],
      items: [{ dimensions: { pagePath: '/warehouses/bengaluru' }, metrics: { screenPageViews: 20 }, redacted: false, verification_required: false }],
    };
    const read = vi.fn(async () => Response.json({ data, meta }));
    await withClient(['analytics:read'], read, async client => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ status: 200, data: { quality: { provisional: true }, source_fetched_at: meta.generatedAt } });
      expect(response.structuredContent).toMatchObject({ data: { source: { system: name === 'ga4_report' ? 'ga4' : 'search_console' } } });
      const [request, route, overrides] = read.mock.calls[0] as unknown as [Request, string[], { revalidateKey: unknown }];
      expect(route).toEqual(path);
      expect(overrides.revalidateKey).toBeTypeOf('function');
      for (const [key, value] of Object.entries(args)) expect(new URL(request.url).searchParams.get(key)).toBe(String(value));
      const sourcePath = String((response.structuredContent as Record<string, unknown>)?.source_path);
      for (const field of ['query_contains', 'query_equals', 'query_not_contains', 'page_contains', 'page_equals', 'landing_page_contains', 'country', 'channel', 'source']) expect(sourcePath).not.toContain(`${field}=`);
      expect(sourcePath).toContain('device=mobile');
    });
  });
  it('keeps transient source failures as MCP tool errors with retry guidance', async () => {
    const read = vi.fn(async () => Response.json({ error: { code: 'ANALYTICS_SOURCE_TIMEOUT', message: 'Source unavailable.' }, meta },
      { status: 503, headers: { 'Retry-After': '10' } }));
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'ga4_report', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 503, error: { code: 'ANALYTICS_SOURCE_TIMEOUT', recovery: { retryable: true, action: 'retry_later' } }, retry_after_seconds: 10 });
      expect(result.structuredContent).not.toHaveProperty('data');
    });
  });
  it.each([
    ['ANALYTICS_CONFIGURATION', 503, 'check_source_configuration'],
    ['ANALYTICS_SOURCE_DENIED', 503, 'check_google_access'],
    ['ANALYTICS_REPORT_UNAVAILABLE', 400, 'check_capabilities'],
    ['INVALID_QUERY', 400, 'correct_query'],
    ['FORBIDDEN', 403, 'check_engine_access'],
    ['ANALYTICS_RESPONSE_INVALID', 503, 'investigate_source_response'],
  ] as const)('provides actionable recovery without blind retries for %s', async (code, status, action) => {
    const read = vi.fn(async () => Response.json({ error: { code, message: 'The report could not be read.' }, meta },
      { status, headers: { 'Retry-After': '10' } }));
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'search_console_report', arguments: { query_equals: 'private@example.test', page_equals: 'https://example.test/private' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status, error: { code, recovery: { retryable: false, action, guidance: expect.any(String) } } });
      expect(result.structuredContent).not.toHaveProperty('retry_after_seconds');
      expect(result.structuredContent).not.toHaveProperty('data');
      expect(JSON.stringify(result)).not.toContain('private@example.test');
      expect(JSON.stringify(result)).not.toContain('https://example.test/private');
    });
  });
  it('validates comparison metrics and retains each period’s evidence through MCP', async () => {
    const baseline = { ...report, query_context: { ...report.query_context, date_from: '2026-08-07', date_to: '2026-08-31', includes_recent_days: false },
      items: [{ ...report.items[0], metrics: { sessions: 10 } }], quality: { ...report.quality, provisional: false, warnings: [] } };
    const data = { ...report, comparison: buildAnalyticsComparison(report, baseline) };
    const read = vi.fn(async () => Response.json({ data, meta }));
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'ga4_report', arguments: { report: 'overview', date_from: '2026-09-01', date_to: '2026-09-25', compare_to: 'previous_period' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { comparison: {
        read_consistency: 'independent_source_reads', baseline: { source_fetched_at: meta.generatedAt, quality: { provisional: false } },
        metrics: [{ name: 'sessions', current: 20, previous: 10, absolute_change: 10, relative_change_percent: 100 }],
      } } });
      expect((result.structuredContent as Record<string, unknown>).source_path).toContain('compare_to=previous_period');
    });
  });
  it('returns default engagement measurements with explicit units and calculation evidence', async () => {
    const data = { ...report,
      columns: [
        { name: 'engagementRate', kind: 'metric', unit: 'fraction', definition: 'Fraction of sessions that were engaged.' },
        { name: 'userEngagementDuration', kind: 'metric', unit: 'seconds', definition: 'Total foreground engagement time.' },
        { name: 'averageEngagementTimePerSession', kind: 'metric', unit: 'seconds', definition: 'Engagement time per session.', calculation: 'userEngagementDuration / sessions' },
        { name: 'averageEngagementTimePerActiveUser', kind: 'metric', unit: 'seconds', definition: 'Engagement time per active user.', calculation: 'userEngagementDuration / activeUsers' },
        { name: 'averageSessionDuration', kind: 'metric', unit: 'seconds', definition: 'Average session duration reported by GA4.' },
      ],
      items: [{ dimensions: {}, metrics: { engagementRate: 0.75, userEngagementDuration: 4800,
        averageEngagementTimePerSession: 40, averageEngagementTimePerActiveUser: 60, averageSessionDuration: 90.5 },
        redacted: false, verification_required: false }],
    };
    const read = vi.fn(async () => Response.json({ data, meta }));
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'ga4_report', arguments: { report: 'overview', period: 'last_28_days' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { columns: data.columns, items: data.items } });
    });
  });
  it.each(['ga4', 'search_console', 'google_ads'] as const)('routes only the requested %s capability source', async source => {
    const partial = { read_only: true, access: 'analysts_only', requested_source: source,
      ga4: source === 'ga4' ? { status: 'unavailable', property: '123', timezone: null, source_fetched_at: null,
        error_code: 'ANALYTICS_SOURCE_DENIED', custom_dimensions: [], reports: [], event_definitions: [], metric_definitions: [] } : null,
      google_ads: source === 'google_ads' ? { status: 'available', account: { id: '1234567890', name: 'Example', currency: 'INR', timezone: 'Asia/Kolkata' },
        source_fetched_at: meta.generatedAt, error_code: null, reports: [], campaign_sections: [], account_sections: [], guidance: 'Use Ads reports.' } : null,
      search_console: source === 'search_console' ? { status: 'configured_not_verified', property: 'sc-domain:example.test', timezone: 'America/Los_Angeles', groups: ['summary'] } : null,
      periods: ['last_28_days'], default_period: 'last_28_days', max_date_range_days: 93, max_rows_per_page: 25, max_report_rows: 500,
      served_at: meta.generatedAt, guidance: ['Other sources are not checked.'] };
    const read = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get('source')).toBe(source);
      return Response.json({ data: partial, meta });
    });
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'analytics_capabilities', arguments: { source } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: partial });
      expect(read).toHaveBeenCalledTimes(1);
    });
  });
  it.each([{}, { scope: 'account', id: '123' }])('rejects ambiguous Ads reader scope: %j', async args => {
    const read = vi.fn();
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'read_google_ads_campaign', arguments: args });
      expect(result.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
  });
  it('requires a source before capability discovery', async () => {
    const read = vi.fn();
    await withClient(['analytics:read'], read, async client => {
      expect((await client.callTool({ name: 'analytics_capabilities', arguments: {} })).isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
  });
  it('uses the same input bounds and enums in the public REST reference', async () => {
    const doc = getOpenApiDocument();
    await withClient(['analytics:read'], undefined, async client => {
      const { tools } = await client.listTools();
      for (const [name, route] of [['ga4_report', '/analytics/ga4'], ['search_console_report', '/analytics/search-console'],
        ['google_ads_report', '/analytics/google-ads'], ['google_ads_filters', '/analytics/google-ads/filters'], ['read_google_ads_campaign', '/analytics/google-ads/campaigns/{id}']] as const) {
        const tool = tools.find(value => value.name === name)!;
        const params = doc.paths[route].get.parameters;
        expect(params.map(param => param.name).sort()).toEqual(Object.keys(tool.inputSchema.properties ?? {}).filter(key => !(name === 'read_google_ads_campaign' && key === 'scope')).sort());
        for (const param of params) expect(param.schema).toEqual(tool.inputSchema.properties?.[param.name]);
      }
    });
  });
});
