import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsPagination, resolveAnalyticsDates, validateGa4Query } from '../src/lib/analytics-query';

type Read = { kind: string };
type DimensionFilter = {
  filter?: { fieldName: string; stringFilter?: { value: string } };
  andGroup?: { expressions: DimensionFilter[] };
};
type Body = {
  dimensions?: { name: string }[] | string[];
  metrics?: { name: string }[];
  dateRanges?: { startDate: string; endDate: string }[];
  dimensionFilter?: DimensionFilter;
  [key: string]: unknown;
};
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../src/lib/analytics-google', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/analytics-google')>(),
  analyticsCredentials: () => ({ identity: 'synthetic-interpretation-test' }),
  ga4PropertyId: () => '123', searchConsoleSite: () => 'sc-domain:example.test',
  googleAnalyticsRead: readMock,
}));
import { analyticsCapabilities, ga4Report, searchConsoleReport } from '../src/lib/analytics';
import { analyticsCapabilitiesOutput, analyticsReportOutput, ga4ToolInput } from '../src/lib/analytics-tooling';

let pagePath: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  pagePath = '/warehouses/bengaluru';
  readMock.mockReset();
  readMock.mockImplementation(async (read: Read, body: Body | undefined, project: (raw: unknown) => unknown) => {
    const dimensions = (body?.dimensions ?? []) as { name: string }[];
    const filters = body?.dimensionFilter?.andGroup?.expressions ?? [body?.dimensionFilter];
    const eventName = filters.find(expression => expression?.filter?.fieldName === 'eventName')?.filter?.stringFilter?.value ?? 'form_submit';
    const raw = read.kind === 'ga4_metadata'
      ? { dimensions: ['lead_type', 'origin_placement'].map(name => ({ apiName: `customEvent:${name}` })), metrics: [] }
      : read.kind === 'search_console'
        ? { rows: [{ keys: [], clicks: 5, impressions: 100, ctr: 0.05, position: 3 }], responseAggregationType: 'byProperty' }
        : {
          dimensionHeaders: dimensions,
          metricHeaders: body!.metrics,
          rows: [{
            dimensionValues: dimensions.map(({ name }) => ({ value: name === 'pagePath' || name === 'landingPage' ? pagePath
              : name === 'eventName' ? eventName : name === 'sessionSourceMedium' ? 'google / organic' : 'normal' })),
            metricValues: body!.metrics!.map(({ name }) => ({ value: name === 'eventCount' ? '7'
              : name === 'engagementRate' ? '0.5' : '5' })),
          }],
          rowCount: 1,
          metadata: { timeZone: 'Asia/Kolkata' },
        };
    return { data: project(raw), source_fetched_at: '2026-09-26T01:59:30.000Z', cache_hit: true };
  });
});
afterEach(() => vi.useRealTimers());

function reportRequest() {
  const call = readMock.mock.calls.find(([read, body]) => read.kind === 'ga4_report' && body.dateRanges[0].startDate !== '7daysAgo');
  expect(call).toBeDefined();
  return call![1];
}
const exactEvent = (value: string) => ({ filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value, caseSensitive: true } } });
const pathFilter = (fieldName: string, value: string) => ({ filter: { fieldName, stringFilter: { matchType: 'CONTAINS', value, caseSensitive: true } } });
const aggregateLimits = {
  aggregation: 'aggregate', individual_journeys_available: false, crm_linkage_available: false, event_counts_are_unique_leads: false,
};

describe('first visits and recorded form submissions', () => {
  it('counts only first_visit events by session entry and preserves event and user counts separately', async () => {
    const report = await ga4Report(new URLSearchParams('report=first_visits'));
    expect(reportRequest()).toMatchObject({
      dimensions: [{ name: 'landingPage' }], metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: exactEvent('first_visit'),
    });
    expect(report.items[0].metrics).toEqual({ eventCount: 7, totalUsers: 5 });
    expect(report.query_context.event_name).toBe('first_visit');
    expect(report.interpretation).toMatchObject({ ...aggregateLimits, page_basis: 'session_entry', acquisition_basis: 'first_visit_events_only' });
    expect(report.interpretation.event_definitions).toContainEqual(expect.objectContaining({
      event_name: 'first_visit', definition_basis: 'google_definition', meaning: expect.any(String),
    }));
    expect(report.quality.totals_included).toBe(false);
  });

  it('keeps form_submit and generate_lead as distinct event/page groups within a fixed event allowlist', async () => {
    const report = await ga4Report(new URLSearchParams('report=form_submissions'));
    expect(reportRequest()).toMatchObject({
      dimensions: [{ name: 'eventName' }, { name: 'pagePath' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['form_submit', 'generate_lead'], caseSensitive: true } } },
    });
    expect(reportRequest().orderBys).toEqual([
      { metric: { metricName: 'eventCount' }, desc: true },
      { dimension: { dimensionName: 'eventName' } }, { dimension: { dimensionName: 'pagePath' } },
    ]);
    expect(report.items[0]).toMatchObject({ dimensions: { eventName: 'form_submit', pagePath }, metrics: { eventCount: 7, totalUsers: 5 } });
    expect(report.interpretation).toMatchObject({ ...aggregateLimits, page_basis: 'recorded_event_page', acquisition_basis: 'not_reported' });
    expect(report.interpretation.event_definitions.map(definition => definition.event_name).sort()).toEqual(['form_submit', 'generate_lead']);
    for (const definition of report.interpretation.event_definitions) {
      expect(definition.meaning.trim().length).toBeGreaterThan(0);
      expect(definition.limitations.length).toBeGreaterThan(0);
    }
    const leadDefinition = report.interpretation.event_definitions.find(definition => definition.event_name === 'generate_lead')!;
    expect(leadDefinition.definition_basis).toBe('website_source_review');
    expect(leadDefinition.meaning).toMatch(/intake API.*success/i);
    expect(leadDefinition.limitations.join(' ')).toMatch(/not a Twenty opportunity/i);
    expect(leadDefinition.limitations.join(' ')).toMatch(/page.*opening.*differ.*submission/i);
    const submitDefinition = report.interpretation.event_definitions.find(definition => definition.event_name === 'form_submit')!;
    expect(submitDefinition.definition_basis).toBe('google_definition');
    expect(submitDefinition.limitations.join(' ')).toMatch(/does not prove server acceptance/i);
  });

  it.each(['form_submit', 'generate_lead'])('can narrow the form preset to %s without broadening its page meaning', async event_name => {
    const report = await ga4Report(new URLSearchParams({ report: 'form_submissions', event_name }));
    expect(reportRequest().dimensionFilter).toEqual(exactEvent(event_name));
    expect(report.query_context.event_name).toBe(event_name);
    expect(report.interpretation.page_basis).toBe('recorded_event_page');
    expect(report.interpretation.event_definitions.map(definition => definition.event_name)).toEqual([event_name]);
  });

  it('filters the recorded event path independently from session entry and session source', async () => {
    const report = await ga4Report(new URLSearchParams({ report: 'form_submissions', event_name: 'generate_lead',
      page_path_contains: '/contact', landing_page_contains: '/warehouses', source: 'google' }));
    expect(reportRequest().dimensionFilter.andGroup.expressions).toEqual(expect.arrayContaining([
      exactEvent('generate_lead'), pathFilter('pagePath', '/contact'), pathFilter('landingPage', '/warehouses'),
      { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'EXACT', value: 'google', caseSensitive: true } } },
    ]));
    expect(reportRequest().dimensionFilter.andGroup.expressions).toHaveLength(4);
    expect(report.query_context).toMatchObject({ page_path_contains: '/contact', landing_page_contains: '/warehouses', source: 'google' });
    expect(report.interpretation).toMatchObject({ ...aggregateLimits, page_basis: 'recorded_event_page', acquisition_basis: 'session' });
  });

  it('sanitizes form event pages without exposing contact or query details', async () => {
    pagePath = '/contact/private%2540example.test?token=do-not-return#hidden';
    const report = await ga4Report(new URLSearchParams('report=form_submissions'));
    expect(report.items[0].dimensions.pagePath).toBe('/contact/[email omitted]');
    expect(report.items[0].redacted).toBe(true);
    expect(report.quality.privacy_redactions).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/private|do-not-return|hidden/);
  });
});

describe('path scope and bounded query validation', () => {
  it.each(['pages', 'events', 'form_submissions'])('applies page_path_contains to recorded pagePath for %s', async report => {
    const result = await ga4Report(new URLSearchParams({ report, page_path_contains: '/warehouses/' }));
    const filter = reportRequest().dimensionFilter;
    const expressions = filter.andGroup?.expressions ?? [filter];
    expect(expressions).toContainEqual(pathFilter('pagePath', '/warehouses/'));
    expect(result.interpretation.page_basis).toBe('recorded_event_page');
  });

  it.each([
    'report=first_visits&event_name=first_visit', 'report=first_visits&event_name=generate_lead',
    'report=form_submissions&event_name=form_attempt', 'report=form_submissions&event_name=page_view',
    'report=first_visits&compare_to=previous_period', 'report=form_submissions&compare_to=previous_period',
    ...['overview', 'daily', 'acquisition', 'landing_pages', 'first_visits', 'devices', 'countries', 'warehouse_interest', 'lead_sources']
      .map(report => `report=${report}&page_path_contains=/warehouses/`),
  ])('rejects unsupported semantics before a source read: %s', async query => {
    await expect(ga4Report(new URLSearchParams(query))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(readMock).not.toHaveBeenCalled();
  });

  it.each(['/contact?token=private', '/contact#details', '/private@example.test', 'https://example.test/contact',
    '/contact%253Ftoken=private', '/9876543210', '', 'x'.repeat(121)])('refuses an unsafe page path filter: %s', async value => {
    await expect(ga4Report(new URLSearchParams({ report: 'events', page_path_contains: value })))
      .rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('binds continuation cursors to the recorded-page filter', () => {
    const query = validateGa4Query(new URLSearchParams('report=form_submissions&page_path_contains=/contact'));
    const dates = resolveAnalyticsDates(query, 'Asia/Kolkata');
    const cursor = analyticsPagination(query, dates, 'synthetic-ga4').cursorFor(10);
    expect(analyticsPagination({ ...query, cursor, limit: 25 }, dates, 'synthetic-ga4').offset).toBe(10);
    expect(() => analyticsPagination({ ...query, cursor, page_path_contains: '/warehouses' }, dates, 'synthetic-ga4')).toThrow('Cursor');
    expect(() => analyticsPagination({ ...query, cursor, page_path_contains: null }, dates, 'synthetic-ga4')).toThrow('Cursor');
  });
});

describe('structured analytics interpretation contract', () => {
  it('requires interpretation and rejects claims of individual journeys, CRM linkage or unique leads', async () => {
    const report = await ga4Report(new URLSearchParams('report=form_submissions'));
    const { interpretation, ...withoutInterpretation } = report;
    expect(analyticsReportOutput.safeParse(withoutInterpretation).success).toBe(false);
    for (const field of ['individual_journeys_available', 'crm_linkage_available', 'event_counts_are_unique_leads']) {
      expect(analyticsReportOutput.safeParse({ ...report, interpretation: { ...interpretation, [field]: true } }).success).toBe(false);
    }
  });

  it.each(['first_visits', 'form_submissions', 'acquisition', 'lead_sources'])('retains interpretation after the public output schema parses %s', async reportName => {
    const report = await ga4Report(new URLSearchParams({ report: reportName }));
    const parsed = analyticsReportOutput.parse(report);
    expect(parsed.interpretation).toEqual(report.interpretation);
    expect(parsed.interpretation).toMatchObject(aggregateLimits);
    expect(parsed.interpretation.limits.length).toBeGreaterThan(0);
    expect(parsed.query_context).toHaveProperty('page_path_contains', null);
    if (reportName === 'acquisition') expect(parsed.interpretation.acquisition_basis).toBe('session');
    if (reportName === 'lead_sources') expect(parsed.interpretation.acquisition_basis).toBe('not_reported');
  });

  it('keeps Search Console interpretation separate from onsite event and session attribution', async () => {
    const report = await searchConsoleReport(new URLSearchParams());
    expect(analyticsReportOutput.parse(report).interpretation).toMatchObject({
      ...aggregateLimits, page_basis: 'none', acquisition_basis: 'not_reported', event_definitions: [],
    });
  });

  it('exposes both supported presets and the event/page filter in discovery', async () => {
    const capabilities = analyticsCapabilitiesOutput.parse(await analyticsCapabilities());
    expect(capabilities.ga4.reports).toContainEqual(expect.objectContaining({
      name: 'first_visits', available: true, dimensions: ['landingPage'], metrics: ['eventCount', 'totalUsers'], event_name: 'first_visit',
    }));
    expect(capabilities.ga4.reports).toContainEqual(expect.objectContaining({
      name: 'form_submissions', available: true, dimensions: ['eventName', 'pagePath'], metrics: ['eventCount', 'totalUsers'],
    }));
    expect(ga4ToolInput.parse({ report: 'form_submissions', page_path_contains: '/contact' }))
      .toEqual({ report: 'form_submissions', page_path_contains: '/contact' });
  });
});
