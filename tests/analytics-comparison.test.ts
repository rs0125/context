import { describe, expect, it } from 'vitest';
import { buildAnalyticsComparison, previousAnalyticsDates } from '../src/lib/analytics-comparison';

const dates = { date_from: '2026-03-01', date_to: '2026-03-28', timezone: 'America/Los_Angeles',
  local_date: '2026-04-05', period: null, inclusive: true as const, includes_recent_days: false };
function reports() {
  const common = {
    source: { system: 'search_console', property: 'sc-domain:example.test', timezone: dates.timezone }, report: 'summary',
    columns: [{ name: 'clicks', kind: 'metric', unit: 'clicks' }, { name: 'ctr', kind: 'metric', unit: 'fraction' },
      { name: 'position', kind: 'metric', unit: 'position' }],
    source_fetched_at: '2026-04-05T12:00:00.000Z', served_at: '2026-04-05T12:00:00.000Z',
    cache: { hit: false, max_age_seconds: 300, age_seconds: 0 },
    quality: { provisional: false, warnings: ['Grouped queries may be incomplete.'], subject_to_thresholding: false, aggregation_type: 'byProperty' },
  };
  return { current: { ...common, query_context: dates, items: [{ metrics: { clicks: 150, ctr: 0.05, position: 8 } }] },
    baseline: { ...common, query_context: previousAnalyticsDates(dates), items: [{ metrics: { clicks: 100, ctr: 0.04, position: 10 } }] } };
}

describe('aggregate analytics comparisons', () => {
  it('uses equally long adjacent calendar windows across DST and leap years', () => {
    expect(previousAnalyticsDates(dates)).toMatchObject({ date_from: '2026-02-01', date_to: '2026-02-28', timezone: dates.timezone });
    expect(previousAnalyticsDates({ ...dates, date_from: '2024-03-01', date_to: '2024-03-01' }))
      .toMatchObject({ date_from: '2024-02-29', date_to: '2024-02-29' });
    expect(previousAnalyticsDates({ ...dates, date_from: '2026-01-01', date_to: '2026-01-07' }))
      .toMatchObject({ date_from: '2025-12-25', date_to: '2025-12-31' });
  });
  it('does not label a prior equal-length window as the previous calendar month', () => {
    expect(previousAnalyticsDates({ ...dates, date_from: '2026-03-01', date_to: '2026-03-31', period: 'last_month' }))
      .toMatchObject({ date_from: '2026-01-29', date_to: '2026-02-28', period: null });
  });
  it('computes aggregate counts, percentage-point CTR and absolute position separately', () => {
    const { current, baseline } = reports();
    const result = buildAnalyticsComparison(current, baseline);
    expect(result.metrics[0]).toMatchObject({ current: 150, previous: 100, absolute_change: 50, relative_change_percent: 50, percentage_point_change: null });
    expect(result.metrics[1].percentage_point_change).toBeCloseTo(1);
    expect(result.metrics[1].relative_change_percent).toBeNull();
    expect(result.metrics[2]).toMatchObject({ absolute_change: -2, relative_change_percent: null, percentage_point_change: null });
  });
  it('compares engagement in seconds and rates in percentage points without conflating them', () => {
    const { current, baseline } = reports();
    const columns = [{ name: 'averageEngagementTimePerSession', kind: 'metric', unit: 'seconds' },
      { name: 'engagementRate', kind: 'metric', unit: 'fraction' }];
    const result = buildAnalyticsComparison(
      { ...current, report: 'overview', columns, items: [{ metrics: { averageEngagementTimePerSession: 40, engagementRate: 0.75 } }] },
      { ...baseline, report: 'overview', columns, items: [{ metrics: { averageEngagementTimePerSession: 32, engagementRate: 0.60 } }] },
    );
    expect(result.metrics[0]).toMatchObject({ current: 40, previous: 32, absolute_change: 8,
      relative_change_percent: 25, percentage_point_change: null });
    expect(result.metrics[1].percentage_point_change).toBeCloseTo(15);
    expect(result.metrics[1].relative_change_percent).toBeNull();
    expect(result.warnings.some(warning => warning.includes('engagement rate'))).toBe(true);
  });
  it.each([0, 25])('does not invent relative growth from a zero baseline when current=%s', value => {
    const { current, baseline } = reports();
    current.items[0].metrics.clicks = value; baseline.items[0].metrics.clicks = 0;
    expect(buildAnalyticsComparison(current, baseline).metrics[0])
      .toMatchObject({ absolute_change: value, relative_change_percent: null, status: 'zero_baseline' });
  });
  it.each(['current', 'baseline'] as const)('treats missing %s aggregate as unknown', which => {
    const pair = reports(); pair[which].items = [];
    const result = buildAnalyticsComparison(pair.current, pair.baseline);
    expect(result.metrics.every(metric => metric.absolute_change === null && metric.status === 'missing_data')).toBe(true);
    expect(result.warnings.some(warning => warning.includes('not zero'))).toBe(true);
  });
  it('preserves baseline quality and independent source timestamps and cache age', () => {
    const { current, baseline } = reports();
    baseline.quality.provisional = true; baseline.quality.subject_to_thresholding = true;
    baseline.source_fetched_at = '2026-04-05T11:57:00.000Z'; baseline.cache = { hit: true, max_age_seconds: 300, age_seconds: 180 };
    const result = buildAnalyticsComparison(current, baseline);
    expect(result.baseline.quality).toEqual(baseline.quality);
    expect(result.baseline.cache).toEqual(baseline.cache);
    expect(result.baseline.source_fetched_at).toBe(baseline.source_fetched_at);
    expect(result.read_consistency).toBe('independent_source_reads');
    expect(result.warnings.some(warning => warning.includes('incomplete processing'))).toBe(true);
  });
  it.each(['property', 'timezone', 'aggregation', 'dates', 'columns', 'grouped', 'multiple_rows'] as const)('rejects incompatible %s reports', reason => {
    const { current, baseline } = reports();
    if (reason === 'property') baseline.source = { ...baseline.source, property: 'another-property' };
    if (reason === 'timezone') baseline.query_context = { ...baseline.query_context, timezone: 'Asia/Kolkata' };
    if (reason === 'aggregation') baseline.quality = { ...baseline.quality, aggregation_type: 'byPage' };
    if (reason === 'dates') baseline.query_context = { ...baseline.query_context, date_to: '2026-02-27' };
    if (reason === 'columns') baseline.columns = baseline.columns.slice(1);
    if (reason === 'grouped') current.report = baseline.report = 'query';
    if (reason === 'multiple_rows') baseline.items.push(baseline.items[0]);
    expect(() => buildAnalyticsComparison(current, baseline)).toThrow('could not be safely compared');
  });
});
