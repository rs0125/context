import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/errors';

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../src/lib/analytics-google', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/analytics-google')>(),
  analyticsCredentials: () => ({ identity: 'synthetic-form-performance' }),
  ga4PropertyId: () => '123', searchConsoleSite: () => 'sc-domain:example.test', googleAnalyticsRead: readMock,
}));
import { analyticsCapabilities, ga4Report } from '../src/lib/analytics';
import { analyticsCapabilitiesOutput, analyticsReportOutput, ga4ToolInput } from '../src/lib/analytics-tooling';

type Expression = { filter?: { fieldName: string; stringFilter?: { value: string; matchType: string; caseSensitive: boolean } }; andGroup?: { expressions: Expression[] } };
type Body = { dateRanges: { startDate: string; endDate: string }[]; dimensions?: { name: string }[]; metrics: { name: string }[]; dimensionFilter?: Expression; limit?: string; offset?: string };
type Component = 'sessions' | 'form_submit' | 'generate_lead';
type ResponseOptions = { value: string | null; metadata?: Record<string, unknown>; rowCount?: number; invalidHeaders?: boolean; error?: HttpError; fetched?: string; cached?: boolean };
let source: Record<Component, ResponseOptions>;
const expressions = (body: Body) => body.dimensionFilter?.andGroup?.expressions ?? (body.dimensionFilter ? [body.dimensionFilter] : []);
const event = (body: Body) => expressions(body).find(value => value.filter?.fieldName === 'eventName')?.filter?.stringFilter?.value;
const componentCalls = () => readMock.mock.calls.filter(([read, body]) => read.kind === 'ga4_report' && body.dateRanges[0].startDate !== '7daysAgo');
const query = (extra: Record<string, string> = {}) => new URLSearchParams({ report: 'form_performance', ...extra });
async function run(extra: Record<string, string> = {}) {
  const result = await ga4Report(query(extra));
  const parsed = analyticsReportOutput.parse(result);
  expect(parsed.form_performance).toBeDefined();
  return { ...parsed, form_performance: parsed.form_performance! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T02:00:00.000Z'));
  source = { sessions: { value: '100', fetched: '2026-09-26T01:56:00.000Z', cached: true },
    form_submit: { value: '11', fetched: '2026-09-26T01:59:00.000Z', cached: true },
    generate_lead: { value: '8', fetched: '2026-09-26T02:00:00.000Z', cached: false } };
  readMock.mockReset();
  readMock.mockImplementation(async (read: { kind: string }, body: Body | undefined, project: (raw: unknown) => unknown) => {
    if (read.kind === 'ga4_metadata') return { data: project({ dimensions: [], metrics: [] }), source_fetched_at: '2026-09-26T02:00:00.000Z', cache_hit: false };
    const component = body!.metrics[0].name === 'sessions' ? 'sessions' : event(body!) as Component;
    const options = source[component] ?? { value: '1' };
    if (options.error) throw options.error;
    const raw = {
      dimensionHeaders: [], metricHeaders: options.invalidHeaders ? [{ name: 'other' }] : body!.metrics,
      rows: options.value === null ? [] : [{ dimensionValues: [], metricValues: [{ value: options.value }] }],
      rowCount: options.rowCount ?? (options.value === null ? 0 : 1), metadata: { timeZone: 'Asia/Kolkata', ...options.metadata },
      propertyQuota: { tokensPerHour: { consumed: 1, remaining: 100 } },
    };
    return { data: project(raw), source_fetched_at: options.fetched ?? '2026-09-26T02:00:00.000Z', cache_hit: options.cached ?? false };
  });
});
afterEach(() => vi.useRealTimers());

describe('matched session-entry form performance', () => {
  it('uses one date/config resolution and identical cohort filters across three minimal aggregate reads', async () => {
    const report = await run({ period: 'last_28_days', landing_page_contains: '/warehouse/', device: 'mobile', country: 'India', channel: 'Organic Search', source: 'google' });
    const calls = componentCalls();
    expect(readMock).toHaveBeenCalledTimes(5); // metadata, reporting timezone, three bounded components
    expect(calls).toHaveLength(3);
    const common = expressions(calls[0][1]).filter(value => value.filter?.fieldName !== 'eventName');
    expect(common.map(value => value.filter?.fieldName)).toEqual(['landingPage', 'deviceCategory', 'country', 'sessionDefaultChannelGroup', 'sessionSource']);
    for (const [, body, , signal] of calls) {
      expect(body).toMatchObject({ dateRanges: [{ startDate: '2026-08-29', endDate: '2026-09-25' }], dimensions: [], limit: '1', offset: '0', returnPropertyQuota: true });
      expect(body.metrics).toHaveLength(1);
      expect(expressions(body).filter(value => value.filter?.fieldName !== 'eventName')).toEqual(common);
      expect(signal).toBe(calls[0][3]);
    }
    expect(calls.map(([, body]) => event(body) ?? null)).toEqual([null, 'form_submit', 'generate_lead']);
    expect(report.items).toEqual([{ dimensions: {}, metrics: { sessions: 100, formSubmitEventCount: 11, generateLeadEventCount: 8,
      formSubmitEventsPer100EntrySessions: 11, generateLeadEventsPer100EntrySessions: 8 }, redacted: false, verification_required: false }]);
    expect(report.query_context).toMatchObject({ event_name: null, event_names: ['form_submit', 'generate_lead'], landing_page_contains: '/warehouse/', page_path_contains: null });
    expect(report.interpretation).toMatchObject({ page_basis: 'session_entry', acquisition_basis: 'session', individual_journeys_available: false, crm_linkage_available: false });
    expect(report.form_performance.ratios.map(ratio => ratio.status)).toEqual(['available', 'available']);
    expect(report.pagination).toMatchObject({ limit: 1, returned_count: 1, has_more: false, next_cursor: null, source_row_count: null, snapshot: false });
    expect(report.quality.totals_included).toBe(true);
  });

  it('preserves every component filter, cache timestamp, source quality and quota without pretending reads are a snapshot', async () => {
    const report = await run({ date_from: '2026-08-01', date_to: '2026-08-31', landing_page_contains: '/listings/' });
    expect(report.source_fetched_at).toBe(source.sessions.fetched);
    expect(report.cache).toEqual({ hit: false, max_age_seconds: 300, age_seconds: 240 });
    expect(report.quota).toBeNull();
    expect(report.form_performance).toMatchObject({ matching_cohort: true, read_consistency: 'independent_source_reads', denominator: 'matching_entry_sessions' });
    for (const component of report.form_performance.components) {
      expect(component.query_context).toMatchObject({ date_from: '2026-08-01', date_to: '2026-08-31', timezone: 'Asia/Kolkata', landing_page_contains: '/listings/' });
      expect(component.query_context.event_names).toEqual(component.name === 'sessions' ? [] : [component.name]);
      expect(component.source_fetched_at).toBe(source[component.name].fetched);
      expect(component.cache.hit).toBe(source[component.name].cached);
      expect(component.quality.totals_included).toBe(true);
      expect(component.quota).toEqual({ tokensPerHour: { consumed: 1, remaining: 100 } });
    }
  });

  it('does not sum overlapping event types or call ratios conversion rates, and permits more than 100 events per 100 sessions', async () => {
    source.form_submit.value = '210';
    source.generate_lead.value = '180';
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventsPer100EntrySessions).toBe(210);
    expect(report.items[0].metrics.generateLeadEventsPer100EntrySessions).toBe(180);
    expect(Object.values(report.items[0].metrics)).not.toContain(390);
    expect(report.columns.filter(column => column.name.endsWith('EntrySessions')).every(column => column.unit === 'events_per_100_sessions')).toBe(true);
    expect(report.quality.warnings.join(' ')).toMatch(/Never add them together/);
    expect(report.interpretation.limits.join(' ')).toMatch(/not a percentage of visitors or sessions that converted/);
  });

  it('retains explicit zero event counts as zero only when the source returned them', async () => {
    source.form_submit.value = '0';
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventCount).toBe(0);
    expect(report.items[0].metrics.formSubmitEventsPer100EntrySessions).toBe(0);
    expect(report.form_performance.ratios[0].status).toBe('available');
  });

  it.each([null, 'NaN', '1.5', '-1', '9007199254740992'])('withholds a missing or invalid event count (%s), preserving the other event', async value => {
    source.form_submit.value = value;
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventCount).toBeNull();
    expect(report.items[0].metrics.formSubmitEventsPer100EntrySessions).toBeNull();
    expect(report.items[0].metrics.generateLeadEventsPer100EntrySessions).toBe(8);
    expect(report.form_performance.ratios.map(ratio => ratio.status)).toEqual(['missing_data', 'available']);
    expect(report.items[0].verification_required).toBe(true);
  });

  it.each([['0', 'zero_sessions'], [null, 'missing_data'], ['invalid', 'missing_data']])('withholds both ratios with denominator %s', async (value, status) => {
    source.sessions.value = value;
    const report = await run();
    expect(report.form_performance.ratios.every(ratio => ratio.value === null && ratio.status === status)).toBe(true);
    expect(report.items[0].metrics.formSubmitEventCount).toBe(11);
  });

  it('keeps one null-valued summary with explicit absence when every source returns no rows', async () => {
    for (const component of Object.values(source)) component.value = null;
    const report = await run();
    expect(report.items).toHaveLength(1);
    expect(Object.values(report.items[0].metrics).every(value => value === null)).toBe(true);
    expect(report.quality.empty_reason).toMatch(/does not establish zero/);
    expect(report.form_performance.components.every(component => component.quality.empty_reason !== null)).toBe(true);
  });

  it.each([
    { subjectToThresholding: true }, { dataLossFromOtherRow: true }, { dataTruncationReasons: [{ dataTruncationType: 'UNKNOWN' }] },
    { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] }, { emptyReason: 'Unavailable source data' },
  ])('retains but does not divide a quality-limited numerator (%j)', async metadata => {
    source.form_submit.metadata = metadata;
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventCount).toBe(11);
    expect(report.form_performance.ratios.map(ratio => ratio.status)).toEqual(['source_quality_limited', 'available']);
  });

  it('withholds both ratios for a thresholded denominator even when its source number is present', async () => {
    source.sessions.metadata = { subjectToThresholding: true };
    const report = await run();
    expect(report.items[0].metrics.sessions).toBe(100);
    expect(report.form_performance.ratios.every(ratio => ratio.status === 'source_quality_limited' && ratio.value === null)).toBe(true);
    expect(report.quality.subject_to_thresholding).toBe(true);
  });

  it('does not expose a restricted count or calculate its ratio', async () => {
    source.form_submit.metadata = { schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'eventCount', restrictedMetricTypes: ['UNKNOWN'] }] } };
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventCount).toBeNull();
    expect(report.form_performance.ratios[0]).toMatchObject({ status: 'missing_data', value: null });
  });

  it('withholds an unsafe calculated magnitude while retaining the independently valid source count', async () => {
    source.sessions.value = '1';
    source.form_submit.value = String(Number.MAX_SAFE_INTEGER);
    const report = await run();
    expect(report.items[0].metrics.formSubmitEventCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(report.form_performance.ratios[0]).toMatchObject({ status: 'invalid_calculation', value: null });
  });

  it.each(['ANALYTICS_SOURCE_DENIED', 'ANALYTICS_SOURCE_QUERY_UNAVAILABLE', 'ANALYTICS_SOURCE_TIMEOUT'])('fails the report on %s rather than returning partial or fabricated success', async code => {
    source.generate_lead.error = new HttpError(503, code, 'Unavailable test source.');
    await expect(ga4Report(query())).rejects.toMatchObject({ code });
  });

  it.each(['headers', 'timezone', 'extra_rows'])('fails closed for incompatible aggregate %s', async problem => {
    if (problem === 'headers') source.form_submit.invalidHeaders = true;
    if (problem === 'timezone') source.form_submit.metadata = { timeZone: 'America/Los_Angeles' };
    if (problem === 'extra_rows') source.form_submit.rowCount = 2;
    await expect(ga4Report(query())).rejects.toBeInstanceOf(HttpError);
  });

  it('aborts all component reads under the existing operation deadline without a partial response', async () => {
    const implementation = readMock.getMockImplementation()!;
    readMock.mockImplementation((read, body, project, signal) => event(body ?? {}) === 'generate_lead'
      ? new Promise(() => undefined) : implementation(read, body, project, signal));
    const pending = expect(ga4Report(query())).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(35_001);
    await pending;
    expect(componentCalls().every(([, , , signal]) => signal.aborted)).toBe(true);
  });

  it.each([
    { cursor: 'abc' }, { compare_to: 'previous_period' }, { page_path_contains: '/warehouse/' }, { event_name: 'form_submit' },
    { date_from: '2026-01-01', date_to: '2026-08-01' }, { landing_page_contains: '/contact?phone=9999999999' },
  ] as Record<string, string>[])('rejects an unsafe or unsupported query before any provider read (%j)', async params => {
    await expect(ga4Report(query(params))).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('marks recent dates provisional in every component and keeps explicit dates identical', async () => {
    const report = await run({ period: 'today' });
    expect(report.query_context).toMatchObject({ date_from: '2026-09-26', date_to: '2026-09-26', includes_recent_days: true });
    expect(report.quality.provisional).toBe(true);
    expect(report.form_performance.components.every(component => component.quality.provisional && component.query_context.date_to === '2026-09-26')).toBe(true);
  });

  it('advertises the composite and calculated metrics without requiring custom dimensions or a new tool', async () => {
    expect(ga4ToolInput.safeParse({ report: 'form_performance', landing_page_contains: '/warehouse/' }).success).toBe(true);
    const capabilities = await analyticsCapabilities();
    expect(analyticsCapabilitiesOutput.safeParse(capabilities).success).toBe(true);
    expect(capabilities.ga4.reports.find(report => report.name === 'form_performance')).toMatchObject({ available: true, dimensions: [],
      metrics: ['sessions', 'formSubmitEventCount', 'generateLeadEventCount', 'formSubmitEventsPer100EntrySessions', 'generateLeadEventsPer100EntrySessions'],
      event_name: null, event_names: ['form_submit', 'generate_lead'], read_strategy: 'three_matched_aggregates' });
  });
});
