import { HttpError } from './errors';
import { analyticsCalendar, type resolveAnalyticsDates } from './analytics-query';

type Dates = ReturnType<typeof resolveAnalyticsDates>;
const DAY = 86_400_000;

/** Calendar arithmetic, independent of DST and the server's own timezone. */
export function previousAnalyticsDates(dates: Dates): Dates {
  const first = analyticsCalendar(dates.date_from);
  const days = (analyticsCalendar(dates.date_to) - first) / DAY + 1;
  if (!Number.isInteger(days) || days < 1 || days > 93) invalidComparison();
  const date_from = new Date(first - days * DAY).toISOString().slice(0, 10);
  const date_to = new Date(first - DAY).toISOString().slice(0, 10);
  analyticsCalendar(date_from); analyticsCalendar(date_to);
  return { ...dates, date_from, date_to, period: null,
    includes_recent_days: analyticsCalendar(date_to) >= analyticsCalendar(dates.local_date) - 2 * DAY };
}

type Report = {
  source: { system: string; property: string; timezone: string };
  report: string;
  query_context: Dates;
  columns: { name: string; kind: string; unit: string }[];
  items: { metrics: Record<string, number | null> }[];
  source_fetched_at: string;
  served_at: string;
  cache: { hit: boolean; max_age_seconds: number; age_seconds: number };
  quality: { provisional: boolean; warnings: string[]; aggregation_type?: string | null };
};
function invalidComparison(): never {
  throw new HttpError(503, 'ANALYTICS_COMPARISON_INVALID', 'The two aggregate reports could not be safely compared. No comparison is available.');
}
function finite(value: number): number | null { return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null; }

/** Compare provider aggregates, never totals reconstructed from a top-N page.
 * Each period keeps its own provenance. A missing aggregate is unknown, not 0. */
export function buildAnalyticsComparison<T extends Report>(current: T, baseline: T) {
  const expected = previousAnalyticsDates(current.query_context);
  if (!['overview', 'summary'].includes(current.report) || current.report !== baseline.report
    || current.source.system !== baseline.source.system || current.source.property !== baseline.source.property
    || current.source.timezone !== baseline.source.timezone
    || current.query_context.timezone !== baseline.query_context.timezone
    || (current.items.length > 0 && baseline.items.length > 0
      && current.quality.aggregation_type !== baseline.quality.aggregation_type)
    || baseline.query_context.date_from !== expected.date_from || baseline.query_context.date_to !== expected.date_to
    || current.items.length > 1 || baseline.items.length > 1
    || JSON.stringify(current.columns) !== JSON.stringify(baseline.columns)) invalidComparison();
  const metrics = current.columns.filter(column => column.kind === 'metric').map(column => {
    const now = current.items[0]?.metrics[column.name] ?? null;
    const before = baseline.items[0]?.metrics[column.name] ?? null;
    const available = now !== null && before !== null && Number.isFinite(now) && Number.isFinite(before);
    const change = available ? finite(now - before) : null;
    return {
      name: column.name, unit: column.unit, current: now, previous: before,
      absolute_change: change,
      relative_change_percent: available && before !== 0 && column.unit !== 'position' && column.unit !== 'fraction'
        ? finite((now - before) / before * 100) : null,
      percentage_point_change: change !== null && column.unit === 'fraction' ? finite(change * 100) : null,
      status: !available ? 'missing_data' as const : before === 0 ? 'zero_baseline' as const : 'available' as const,
    };
  });
  const warnings = [
    'Previous period means the immediately preceding equal number of calendar days, not the previous calendar month or matched weekdays.',
    'The periods are independent source reads and may have different cache ages or data completeness; this is not a frozen snapshot.',
  ];
  if (current.quality.provisional || baseline.quality.provisional) warnings.push('At least one period includes recent or provisional data. Differences may reflect incomplete processing.');
  if (metrics.some(metric => metric.status === 'missing_data')) warnings.push('Missing aggregate rows or null metrics are unavailable, not zero; their changes were withheld.');
  if (metrics.some(metric => metric.status === 'zero_baseline')) warnings.push('A zero baseline has no defined relative percentage change; use the absolute change.');
  if (metrics.some(metric => metric.unit === 'fraction')) warnings.push('Rate changes are percentage points. Recorded rates such as CTR, engagement rate and bounce rate are fractions, for example 0.05 means 5%.');
  if (metrics.some(metric => metric.unit === 'position')) warnings.push('A negative position change means the average numerical rank is lower; this is not proof that every query improved.');
  return {
    mode: 'previous_period' as const, window: 'preceding_equal_days' as const,
    read_consistency: 'independent_source_reads' as const,
    baseline: { query_context: baseline.query_context as T['query_context'], source_fetched_at: baseline.source_fetched_at,
      served_at: baseline.served_at, cache: baseline.cache, quality: baseline.quality as T['quality'] },
    metrics, warnings,
  };
}
