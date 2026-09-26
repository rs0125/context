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
const gaResponse = (body: Body, dimensionValues?: string[], metricValues?: string[]) => ({
  dimensionHeaders: (body.dimensions as { name: string }[] | undefined ?? []).map(x => ({ name: x.name })),
  metricHeaders: (body.metrics ?? []).map(x => ({ name: x.name, type: x.name === 'keyEvents' ? 'TYPE_FLOAT' : 'TYPE_INTEGER' })),
  rows: [{ dimensionValues: (body.dimensions as { name: string }[] | undefined ?? []).map((x, i) => ({ value: dimensionValues?.[i] ?? (x.name === 'date' ? '20260923' : 'normal') })),
    metricValues: (body.metrics ?? []).map((_x, i) => ({ value: metricValues?.[i] ?? '10' })) }],
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
    expect(report.columns).toContainEqual({ name: 'screenPageViews', kind: 'metric', unit: 'views' });
    expect(report.columns).toContainEqual({ name: 'keyEvents', kind: 'metric', unit: 'key_events' });
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
