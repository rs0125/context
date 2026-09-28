import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/errors';

type Read = { kind: string; property?: string; site?: string };
type Body = { dimensions?: { name: string }[] | string[]; metrics?: { name: string }[]; limit?: string; offset?: string;
  rowLimit?: number; startRow?: number; dateRanges?: { startDate: string; endDate: string }[]; [key: string]: unknown };
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../src/lib/analytics-google', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/analytics-google')>(),
  analyticsCredentials: () => ({ identity: 'unit-test-identity' }), ga4PropertyId: () => '123', searchConsoleSite: () => 'sc-domain:wareongo.com',
  googleAnalyticsRead: readMock,
}));
import { analyticsCapabilities, ga4Report, searchConsoleReport } from '../src/lib/analytics';

const CUSTOM = ['warehouse_city', 'warehouse_state', 'market_slug', 'lead_type', 'origin_placement'];
const DEFAULT_TIMING: Record<string, string> = { engagementRate: '0.6', userEngagementDuration: '120.5', averageSessionDuration: '24.25' };
const gaResponse = (body: Body, dimensionValues?: string[], metricValues?: string[]) => ({
  dimensionHeaders: (body.dimensions as { name: string }[] | undefined ?? []).map(x => ({ name: x.name })),
  metricHeaders: (body.metrics ?? []).map(x => ({ name: x.name, type: x.name === 'keyEvents' ? 'TYPE_FLOAT' : 'TYPE_INTEGER' })),
  rows: [{ dimensionValues: (body.dimensions as { name: string }[] | undefined ?? []).map((x, i) => ({ value: dimensionValues?.[i] ?? (x.name === 'date' ? '20260923' : 'normal') })),
    metricValues: (body.metrics ?? []).map((x, i) => ({ value: metricValues?.[i] ?? DEFAULT_TIMING[x.name] ?? '10' })) }],
  rowCount: 1, metadata: { timeZone: 'Asia/Kolkata' }, propertyQuota: { tokensPerDay: { consumed: 3, remaining: 9999 } },
});
let responseFactory: (read: Read, body: Body) => unknown;
const mockTransport = () => readMock.mockImplementation(async (read: Read, body: Body, project: (raw: unknown) => unknown) => ({
  data: project(responseFactory(read, body)), source_fetched_at: '2026-09-26T01:59:30.000Z', cache_hit: true,
}));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  readMock.mockReset();
  responseFactory = (read, body) => read.kind === 'ga4_metadata'
    ? { dimensions: CUSTOM.map(x => ({ apiName: `customEvent:${x}` })), metrics: [] }
    : read.kind === 'search_console'
      ? { rows: [{ keys: body.dimensions?.length ? ['warehouses in bangalore'] : [], clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 }], responseAggregationType: 'byProperty' }
      : gaResponse(body);
  mockTransport();
});
afterEach(() => vi.useRealTimers());
const actualGaCall = () => readMock.mock.calls.find(([read, body]) => read.kind === 'ga4_report' && body.dateRanges[0].startDate !== '7daysAgo');

describe('bounded GA4 presets and source semantics', () => {
  it('fetches only known aggregate metrics, authoritative timezone and useful units', async () => {
    const report = await ga4Report(new URLSearchParams());
    expect(report.source).toEqual({ system: 'ga4', property: '123', timezone: 'Asia/Kolkata' });
    expect(report.query_context).toMatchObject({ date_from: '2026-08-29', date_to: '2026-09-25', inclusive: true });
    expect(report.columns).toContainEqual(expect.objectContaining({ name: 'screenPageViews', kind: 'metric', unit: 'views' }));
    expect(report.columns).toContainEqual(expect.objectContaining({ name: 'keyEvents', kind: 'metric', unit: 'key_events' }));
    expect(report.quality.totals_included).toBe(true);
    expect(report.cache).toEqual({ hit: true, max_age_seconds: 300, age_seconds: 30 });
    expect(report.source_fetched_at).not.toBe(report.served_at);
    const body = actualGaCall()![1];
    expect(body.limit).toBe('1');
    expect(body.returnPropertyQuota).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/userId|sessionId|latitude|longitude|city/);
  });
  it('preserves fractional key events but withholds malformed counts as null', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => {
      if (read.kind !== 'ga4_report') return base(read, body);
      const response = gaResponse(body);
      response.rows[0].metricValues = body.metrics!.map(x => ({ value: x.name === 'keyEvents' ? '0.5' : x.name === 'sessions' ? 'NaN' : '10' }));
      return response;
    };
    const report = await ga4Report(new URLSearchParams());
    expect(report.items[0].metrics.keyEvents).toBe(0.5);
    expect(report.items[0].metrics.sessions).toBeNull();
    expect(report.items[0].verification_required).toBe(true);
    expect(report.quality.warnings.join(' ')).toContain('null is not zero');
  });
  it('uses exact event filtering so a low-frequency success event need not be in the top page', async () => {
    const report = await ga4Report(new URLSearchParams('report=events&event_name=generate_lead&limit=2'));
    expect(actualGaCall()![1].dimensionFilter).toEqual({ filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'generate_lead', caseSensitive: true } } });
    expect(report.quality.warnings.join(' ')).toContain('not a sequential conversion funnel');
    expect(report.quality.totals_included).toBe(false);
  });
  it('filters sessions and visitors before aggregation without changing the requested breakdown', async () => {
    const report = await ga4Report(new URLSearchParams({ report: 'events', event_name: 'generate_lead',
      landing_page_contains: '/warehouses/', device: 'mobile', country: 'India', channel: 'Organic Search', source: 'google' }));
    const body = actualGaCall()![1];
    expect(body.dimensions).toEqual([{ name: 'eventName' }]);
    expect(body.dimensionFilter.andGroup.expressions).toEqual([
      { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'generate_lead', caseSensitive: true } } },
      { filter: { fieldName: 'landingPage', stringFilter: { matchType: 'CONTAINS', value: '/warehouses/', caseSensitive: true } } },
      { filter: { fieldName: 'deviceCategory', stringFilter: { matchType: 'EXACT', value: 'mobile', caseSensitive: true } } },
      { filter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'India', caseSensitive: true } } },
      { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search', caseSensitive: true } } },
      { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'EXACT', value: 'google', caseSensitive: true } } },
    ]);
    expect(report.query_context).toMatchObject({ event_name: 'generate_lead', landing_page_contains: '/warehouses/', source: 'google', country: 'India', device: 'mobile' });
    expect(report.quality.warnings.join(' ')).toContain('session context');
    expect(report.comparison).toBeNull();
  });
  it('reports visited pages by views with sanitized paths and stable dimension tie breakers', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report' && body.dimensions?.length
      ? gaResponse(body, ['/listings/?secret=value']) : base(read, body);
    const report = await ga4Report(new URLSearchParams('report=pages'));
    expect(actualGaCall()![1].dimensions).toEqual([{ name: 'pagePath' }]);
    expect(actualGaCall()![1].metrics.map((x: { name: string }) => x.name)).toEqual(['screenPageViews', 'activeUsers', 'eventCount', 'keyEvents', 'userEngagementDuration']);
    expect(actualGaCall()![1].orderBys).toEqual([{ metric: { metricName: 'screenPageViews' }, desc: true }, { dimension: { dimensionName: 'pagePath' } }]);
    expect(report.items[0].dimensions.pagePath).toBe('/listings/');
    expect(report.quality.privacy_redactions).toBe(true);
  });
  it('compares matching aggregate segments over adjacent equal calendar windows', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report' && body.dateRanges![0].startDate !== '7daysAgo'
      ? gaResponse(body, [], body.metrics!.map(() => body.dateRanges![0].startDate === '2026-09-01' ? '15' : '10')) : base(read, body);
    const report = await ga4Report(new URLSearchParams('date_from=2026-09-01&date_to=2026-09-07&channel=Organic+Search&compare_to=previous_period'));
    const calls = readMock.mock.calls.filter(([read, body]) => read.kind === 'ga4_report' && body.dateRanges[0].startDate !== '7daysAgo');
    expect(calls.map(([, body]) => body.dateRanges)).toEqual([
      [{ startDate: '2026-09-01', endDate: '2026-09-07' }], [{ startDate: '2026-08-25', endDate: '2026-08-31' }],
    ]);
    expect(calls[0][1].dimensionFilter).toEqual(calls[1][1].dimensionFilter);
    expect(calls[0][3]).toBe(calls[1][3]);
    expect(report.comparison?.metrics.find(metric => metric.name === 'sessions')).toMatchObject({ current: 15, previous: 10, absolute_change: 5, relative_change_percent: 50 });
    expect(report.comparison?.baseline.query_context).toMatchObject({ date_from: '2026-08-25', date_to: '2026-08-31', channel: 'Organic Search', compare_to: null });
    expect(report.comparison?.baseline.quality.totals_included).toBe(true);
  });
  it('does not manufacture a successful comparison when the baseline source fails', async () => {
    const successfulRead = readMock.getMockImplementation()!;
    readMock.mockImplementation((read: Read, body: Body, ...rest: unknown[]) => {
      if (read.kind === 'ga4_report' && body.dateRanges![0].startDate === '2026-08-25') throw new HttpError(503, 'ANALYTICS_SOURCE_DENIED', 'Unavailable');
      return successfulRead(read, body, ...rest);
    });
    await expect(ga4Report(new URLSearchParams('date_from=2026-09-01&date_to=2026-09-07&compare_to=previous_period')))
      .rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_DENIED' });
  });
  it('separates session acquisition from recorded lead form context', async () => {
    await ga4Report(new URLSearchParams('report=acquisition'));
    expect(actualGaCall()![1].dimensions).toEqual([{ name: 'sessionDefaultChannelGroup' }, { name: 'sessionSourceMedium' }]);
    readMock.mockClear();
    const leads = await ga4Report(new URLSearchParams('report=lead_sources'));
    expect(actualGaCall()![1].dimensions).toEqual([{ name: 'customEvent:lead_type' }, { name: 'customEvent:origin_placement' }]);
    expect(actualGaCall()![1].dimensionFilter.filter.stringFilter.value).toBe('generate_lead');
    expect(leads.quality.warnings.join(' ')).toContain('not marketing channel attribution');
  });
  it('queries only registered custom dimensions and describes missing ones', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_metadata' ? { dimensions: [{ apiName: 'customEvent:warehouse_city' }], metrics: [] } : base(read, body);
    const report = await ga4Report(new URLSearchParams('report=warehouse_interest'));
    expect(actualGaCall()![1].dimensions).toEqual([{ name: 'customEvent:warehouse_city' }]);
    expect(report.quality.warnings.join(' ')).toContain('Unregistered dimensions omitted: warehouse_state, market_slug');
    expect(report.query_context.event_name).toBe('view_listing');
  });
  it('marks unavailable presets rather than issuing invalid custom dimension queries', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_metadata' ? { dimensions: [], metrics: [] } : base(read, body);
    const capabilities = await analyticsCapabilities();
    expect(capabilities.ga4.reports.find(x => x.name === 'lead_sources')).toMatchObject({ available: false });
    await expect(ga4Report(new URLSearchParams('report=lead_sources'))).rejects.toMatchObject({ status: 400, code: 'ANALYTICS_REPORT_UNAVAILABLE' });
    expect(actualGaCall()).toBeUndefined();
  });
  it('preserves independently configured Search Console when GA reads are denied', async () => {
    readMock.mockRejectedValue(new HttpError(503, 'ANALYTICS_SOURCE_DENIED', 'Unavailable'));
    const capabilities = await analyticsCapabilities();
    expect(capabilities.ga4).toMatchObject({ status: 'unavailable', timezone: null, error_code: 'ANALYTICS_SOURCE_DENIED' });
    expect(capabilities.search_console).toMatchObject({ status: 'configured_not_verified', property: 'sc-domain:wareongo.com' });
  });
  it('retains all material quality flags and never returns raw source metadata extensions', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => {
      if (read.kind !== 'ga4_report') return base(read, body);
      return { ...gaResponse(body), private_field: 'secret', metadata: { timeZone: 'Asia/Kolkata', subjectToThresholding: true,
        dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }],
        dataTruncationReasons: [{ dataTruncationType: 'DATA_TRUNCATION_TYPE_DATA_DRIVEN_ATTRIBUTION', dataTruncationMessage: 'secret@example.com' }],
        schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'eventCount', restrictedMetricTypes: ['REVENUE_DATA'] }] },
      } };
    };
    const report = await ga4Report(new URLSearchParams('report=events'));
    expect(report.quality).toMatchObject({ subject_to_thresholding: true, data_loss_from_other_row: true, data_truncated: true,
      sampling: [{ samples_read: '10', sampling_space: '100' }] });
    expect(report.items[0].metrics.eventCount).toBeNull();
    expect(JSON.stringify(report)).not.toContain('secret');
  });
  it('fails closed on malformed schemas and mismatched report headers', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => {
      if (read.kind === 'ga4_report' && body.dateRanges![0].startDate !== '7daysAgo') return { ...gaResponse(body), metricHeaders: [{ name: 'unexpectedPrivateMetric' }] };
      return base(read, body);
    };
    await expect(ga4Report(new URLSearchParams())).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it('carries unknown labels safely with explicit redaction, without merging grouped values', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report' && body.dimensions?.length
      ? gaResponse(body, ['private@example.com']) : base(read, body);
    const report = await ga4Report(new URLSearchParams('report=events'));
    expect(report.items[0].dimensions.eventName).toBe('[email omitted]');
    expect(report.items[0].redacted).toBe(true);
    expect(report.quality.privacy_redactions).toBe(true);
  });
  it('binds pagination while acknowledging provider changes between pages', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report' && body.dimensions?.length ? { ...gaResponse(body), rowCount: 3 } : base(read, body);
    const first = await ga4Report(new URLSearchParams('report=events&limit=1'));
    expect(first.pagination).toMatchObject({ has_more: true, source_row_count: 3, snapshot: false });
    const query = new URLSearchParams({ report: 'events', limit: '1', cursor: first.nextCursor! });
    readMock.mockClear();
    await ga4Report(query);
    expect(actualGaCall()![1].offset).toBe('1');
    query.set('event_name', 'different');
    await expect(ga4Report(query)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
});

describe('GA4 engagement metric semantics', () => {
  it.each(['overview', 'daily', 'acquisition', 'landing_pages', 'devices', 'countries'])('adds timing to %s within the ten-native-metric limit', async reportName => {
    const report = await ga4Report(new URLSearchParams({ report: reportName }));
    const metrics = actualGaCall()![1].metrics.map((metric: { name: string }) => metric.name);
    expect(metrics).toHaveLength(10);
    expect(metrics).toEqual(expect.arrayContaining(['activeUsers', 'totalUsers', 'sessions', 'engagedSessions', 'screenPageViews', 'eventCount', 'keyEvents', 'engagementRate', 'userEngagementDuration', 'averageSessionDuration']));
    expect(metrics).not.toContain('averageEngagementTimePerSession');
    expect(report.columns.filter(column => column.kind === 'metric')).toHaveLength(15);
    expect(report.items[0].metrics.averageEngagementTimePerSession).toBeCloseTo(12.05);
    if (['acquisition', 'landing_pages'].includes(reportName)) expect(actualGaCall()![1].orderBys[0]).toEqual({ metric: { metricName: 'sessions' }, desc: true });
  });
  it('preserves decimal seconds and calculates row averages with explicit units and formulas', async () => {
    const base = responseFactory;
    const values: Record<string, string> = { activeUsers: '4', sessions: '5', engagedSessions: '3', screenPageViews: '11', eventCount: '29',
      engagementRate: '0.6', userEngagementDuration: '123.75', averageSessionDuration: '48.125' };
    responseFactory = (read, body) => read.kind === 'ga4_report'
      ? gaResponse(body, undefined, body.metrics!.map(metric => values[metric.name] ?? '10')) : base(read, body);
    const report = await ga4Report(new URLSearchParams());
    expect(report.items[0].metrics).toMatchObject({ userEngagementDuration: 123.75, averageSessionDuration: 48.125,
      averageEngagementTimePerSession: 24.75, averageEngagementTimePerActiveUser: 30.9375, screenPageViewsPerSession: 2.2, eventsPerSession: 5.8 });
    expect(report.items[0].metrics.bounceRate).toBeCloseTo(0.4);
    expect(report.items[0].verification_required).toBe(false);
    expect(report.columns.find(column => column.name === 'averageEngagementTimePerSession')).toMatchObject({ unit: 'seconds', calculation: 'userEngagementDuration / sessions' });
    expect(report.columns.find(column => column.name === 'userEngagementDuration')?.definition).toContain('total, not an average');
    expect(report.columns.find(column => column.name === 'averageSessionDuration')?.calculation).toBeUndefined();
    expect(report.columns.find(column => column.name === 'bounceRate')).toMatchObject({ unit: 'fraction', calculation: '1 - engagementRate' });
    expect(report.columns.find(column => column.name === 'eventsPerSession')?.unit).toBe('events_per_session');
  });
  it('uses each grouped row\'s own denominator without inventing an overall average', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => {
      if (read.kind !== 'ga4_report' || !body.dimensions?.length) return base(read, body);
      const first = gaResponse(body, ['20260901'], body.metrics!.map(metric => metric.name === 'userEngagementDuration' ? '60' : metric.name === 'sessions' ? '1' : DEFAULT_TIMING[metric.name] ?? '10'));
      const second = gaResponse(body, ['20260902'], body.metrics!.map(metric => metric.name === 'userEngagementDuration' ? '90' : metric.name === 'sessions' ? '3' : DEFAULT_TIMING[metric.name] ?? '10'));
      return { ...first, rows: [...first.rows, ...second.rows], rowCount: 2 };
    };
    const report = await ga4Report(new URLSearchParams('report=daily'));
    expect(report.items.map(item => item.metrics.averageEngagementTimePerSession)).toEqual([60, 30]);
    expect(report.quality.totals_included).toBe(false);
    expect(report.quality.warnings.join(' ')).toContain('must not be summed or averaged across report rows');
  });
  it.each(['1.01', '-0.1', 'NaN'])('withholds an invalid engagement fraction %s and its complement', async value => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report'
      ? gaResponse(body, undefined, body.metrics!.map(metric => metric.name === 'engagementRate' ? value : DEFAULT_TIMING[metric.name] ?? '10')) : base(read, body);
    const report = await ga4Report(new URLSearchParams());
    expect(report.items[0].metrics.engagementRate).toBeNull();
    expect(report.items[0].metrics.bounceRate).toBeNull();
    expect(report.items[0].metrics.averageEngagementTimePerSession).toBeCloseTo(12.05);
    expect(report.items[0].verification_required).toBe(true);
  });
  it.each(['0', 'NaN'])('withholds session averages and rates when sessions is %s', async sessions => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report'
      ? gaResponse(body, undefined, body.metrics!.map(metric => metric.name === 'sessions' ? sessions : DEFAULT_TIMING[metric.name] ?? '10')) : base(read, body);
    const report = await ga4Report(new URLSearchParams());
    for (const metric of ['engagementRate', 'averageSessionDuration', 'bounceRate', 'averageEngagementTimePerSession', 'screenPageViewsPerSession', 'eventsPerSession']) expect(report.items[0].metrics[metric]).toBeNull();
    expect(report.items[0].metrics.averageEngagementTimePerActiveUser).toBeCloseTo(12.05);
    expect(report.quality.warnings.join(' ')).toContain('denominator was zero');
  });
  it('preserves valid zero numerators and treats a zero active-user denominator independently', async () => {
    const base = responseFactory;
    responseFactory = (read, body) => read.kind === 'ga4_report'
      ? gaResponse(body, undefined, body.metrics!.map(metric => ['activeUsers', 'screenPageViews', 'eventCount', 'userEngagementDuration', 'averageSessionDuration'].includes(metric.name) ? '0' : DEFAULT_TIMING[metric.name] ?? '10')) : base(read, body);
    const report = await ga4Report(new URLSearchParams());
    expect(report.items[0].metrics).toMatchObject({ averageEngagementTimePerSession: 0, screenPageViewsPerSession: 0, eventsPerSession: 0, averageSessionDuration: 0 });
    expect(report.items[0].metrics.averageEngagementTimePerActiveUser).toBeNull();
  });
  it.each(['userEngagementDuration', 'sessions', 'activeUsers', 'engagementRate', 'eventCount'])('propagates a restricted %s to dependent calculations', async restricted => {
    const base = responseFactory;
    responseFactory = (read, body) => {
      if (read.kind !== 'ga4_report' || body.dateRanges![0].startDate === '7daysAgo') return base(read, body);
      return { ...gaResponse(body), metadata: { timeZone: 'Asia/Kolkata', schemaRestrictionResponse: {
        activeMetricRestrictions: [{ metricName: restricted, restrictedMetricTypes: ['REVENUE_DATA'] }],
      } } };
    };
    const report = await ga4Report(new URLSearchParams());
    const values = report.items[0].metrics;
    expect(values[restricted]).toBeNull();
    if (['sessions', 'userEngagementDuration'].includes(restricted)) expect(values.averageEngagementTimePerSession).toBeNull();
    if (['activeUsers', 'userEngagementDuration'].includes(restricted)) expect(values.averageEngagementTimePerActiveUser).toBeNull();
    if (['sessions', 'engagementRate'].includes(restricted)) expect(values.bounceRate).toBeNull();
    if (['sessions', 'eventCount'].includes(restricted)) expect(values.eventsPerSession).toBeNull();
    expect(report.items[0].verification_required).toBe(true);
  });
  it('keeps visited-page engagement per active user separate from whole-session metrics', async () => {
    const report = await ga4Report(new URLSearchParams('report=pages'));
    expect(actualGaCall()![1].metrics).toHaveLength(5);
    expect(report.columns.filter(column => column.kind === 'metric')).toHaveLength(6);
    expect(report.items[0].metrics.averageEngagementTimePerActiveUser).toBeCloseTo(12.05);
    expect(report.items[0].metrics).not.toHaveProperty('sessions');
    expect(report.items[0].metrics).not.toHaveProperty('averageEngagementTimePerSession');
    expect(report.items[0].metrics).not.toHaveProperty('bounceRate');
    expect(report.quality.warnings.join(' ')).toContain('not the duration of a whole session');
  });
  it.each(['events', 'warehouse_interest', 'lead_sources'])('keeps %s as an event-count report', async reportName => {
    const report = await ga4Report(new URLSearchParams({ report: reportName }));
    expect(actualGaCall()![1].metrics.map((metric: { name: string }) => metric.name)).toEqual(['eventCount', 'totalUsers']);
    expect(Object.keys(report.items[0].metrics)).toEqual(['eventCount', 'totalUsers']);
  });
  it('discovers every returned engagement metric and distinguishes source metrics from calculations', async () => {
    const capabilities = await analyticsCapabilities();
    expect(capabilities.ga4.reports.find(report => report.name === 'overview')?.metrics).toHaveLength(15);
    expect(capabilities.ga4.reports.find(report => report.name === 'pages')?.metrics).toContain('averageEngagementTimePerActiveUser');
    expect(capabilities.ga4.metric_definitions.map(metric => metric.name)).toEqual(expect.arrayContaining([
      'engagementRate', 'userEngagementDuration', 'averageSessionDuration', 'averageEngagementTimePerSession',
      'averageEngagementTimePerActiveUser', 'bounceRate', 'screenPageViewsPerSession', 'eventsPerSession',
    ]));
    expect(capabilities.ga4.metric_definitions.find(metric => metric.name === 'userEngagementDuration')).toMatchObject({ unit: 'seconds', calculation: null });
    expect(capabilities.ga4.metric_definitions.find(metric => metric.name === 'averageEngagementTimePerActiveUser')).toMatchObject({ unit: 'seconds', calculation: 'userEngagementDuration / activeUsers' });
  });
});

describe('Search Console aggregate semantics', () => {
  it('uses final web performance, a provider aggregate, Pacific dates, no synthetic summed totals', async () => {
    const report = await searchConsoleReport(new URLSearchParams());
    expect(readMock.mock.calls[0][1]).toMatchObject({ startDate: '2026-08-28', endDate: '2026-09-24', dimensions: [], dataState: 'final', type: 'web', aggregationType: 'auto', rowLimit: 1 });
    expect(report.items[0].metrics).toEqual({ clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 });
    expect(report.quality).toMatchObject({ totals_included: true, aggregation_type: 'byProperty' });
    expect(report.source.timezone).toBe('America/Los_Angeles');
  });
  it('uses compatible auto aggregation when filtering a summary by public page path', async () => {
    await searchConsoleReport(new URLSearchParams('page_contains=/listings/'));
    expect(readMock.mock.calls[0][1]).toMatchObject({ aggregationType: 'auto', dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'contains', expression: '/listings/' }] }] });
  });
  it('returns bounded query/page pairs and combines exact, excluded, device and country filters', async () => {
    responseFactory = () => ({ rows: [{ keys: ['warehouse bangalore', 'https://wareongo.com/listings/?tracking=secret'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 }], responseAggregationType: 'byPage' });
    const report = await searchConsoleReport(new URLSearchParams({ group: 'query_page', query_equals: 'warehouse bangalore', query_not_contains: 'wareongo',
      page_equals: 'https://wareongo.com/listings/', device: 'mobile', country: 'IND' }));
    expect(readMock.mock.calls[0][1]).toMatchObject({ dimensions: ['query', 'page'], type: 'web', aggregationType: 'auto',
      dimensionFilterGroups: [{ groupType: 'and', filters: [
        { dimension: 'query', operator: 'equals', expression: 'warehouse bangalore' },
        { dimension: 'query', operator: 'notContains', expression: 'wareongo' },
        { dimension: 'page', operator: 'equals', expression: 'https://wareongo.com/listings/' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
        { dimension: 'country', operator: 'equals', expression: 'ind' },
      ] }] });
    expect(report.items[0].dimensions).toEqual({ query: 'warehouse bangalore', page: 'https://wareongo.com/listings/' });
    expect(report.quality).toMatchObject({ totals_included: false, aggregation_type: 'byPage', privacy_redactions: true });
    expect(report.quality.warnings.join(' ')).toContain('exclusion filters');
  });
  it('rejects an exact page from outside the configured property before any source read', async () => {
    await expect(searchConsoleReport(new URLSearchParams('page_equals=https://wareongo.com.evil.test/foo'))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(readMock).not.toHaveBeenCalled();
  });
  it('compares provider summary metrics and preserves an absent baseline as unknown', async () => {
    responseFactory = (_read, body) => body.startDate === '2026-09-01'
      ? { rows: [{ clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 }], responseAggregationType: 'byProperty' } : {};
    const report = await searchConsoleReport(new URLSearchParams('date_from=2026-09-01&date_to=2026-09-07&query_not_contains=wareongo&compare_to=previous_period'));
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(readMock.mock.calls[1][1]).toMatchObject({ startDate: '2026-08-25', endDate: '2026-08-31', dimensions: [], rowLimit: 1 });
    expect(readMock.mock.calls[0][1].dimensionFilterGroups).toEqual(readMock.mock.calls[1][1].dimensionFilterGroups);
    expect(report.comparison?.metrics.find(metric => metric.name === 'clicks')).toMatchObject({ current: 5, previous: null, absolute_change: null, relative_change_percent: null, status: 'missing_data' });
    expect(report.comparison?.baseline.quality.empty_reason).toContain('does not establish zero');
  });
  it('requires explicit all for named or explicit today and refuses unsupported inputs before calls', async () => {
    for (const text of ['period=today', 'date_from=2026-09-25&date_to=2026-09-25', 'period=this_month', 'query_contains=private%40example.com']) {
      await expect(searchConsoleReport(new URLSearchParams(text))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    }
    expect(readMock).not.toHaveBeenCalled();
  });
  it('marks incomplete all/date results and handles provider omission of missing days', async () => {
    responseFactory = () => ({ rows: [{ keys: ['2026-09-25'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 }],
      responseAggregationType: 'byProperty', metadata: { first_incomplete_date: '2026-09-24' } });
    const report = await searchConsoleReport(new URLSearchParams('group=date&period=today&data_state=all'));
    expect(report.quality).toMatchObject({ provisional: true, first_incomplete_date: '2026-09-24', totals_included: false });
    expect(report.items).toHaveLength(1);
  });
  it('removes page query strings and contact text from search queries', async () => {
    responseFactory = () => ({ rows: [{ keys: ['https://wareongo.com/foo?phone=9876543210#token'], clicks: 1, impressions: 10, ctr: 0.1, position: 1 }] });
    const report = await searchConsoleReport(new URLSearchParams('group=page'));
    expect(report.items[0].dimensions.page).toBe('https://wareongo.com/foo');
    expect(report.quality.privacy_redactions).toBe(true);
  });
  it('uses a lookahead row for bounded pagination without assuming export completeness', async () => {
    responseFactory = (_read, body) => ({ rows: Array.from({ length: body.rowLimit! }, (_, i) => ({ keys: [`warehouse ${i}`], clicks: 5, impressions: 100, ctr: 0.05, position: 3.5 })) });
    const report = await searchConsoleReport(new URLSearchParams('group=query&limit=2'));
    expect(readMock.mock.calls[0][1].rowLimit).toBe(3);
    expect(report.items).toHaveLength(2);
    expect(report.pagination).toMatchObject({ has_more: true, source_row_count: null, snapshot: false });
    expect(report.quality.warnings.join(' ')).toContain('top available rows');
  });
  it('distinguishes absent rows from a returned zero aggregate', async () => {
    responseFactory = () => ({});
    const empty = await searchConsoleReport(new URLSearchParams());
    expect(empty.items).toEqual([]);
    expect(empty.quality.empty_reason).toContain('does not establish zero');
    responseFactory = () => ({ rows: [{ clicks: 0, impressions: 0, ctr: 0, position: 0 }] });
    const zero = await searchConsoleReport(new URLSearchParams());
    expect(zero.items[0].metrics.clicks).toBe(0);
    expect(zero.quality.empty_reason).toBeNull();
  });
});
