import { HttpError } from './errors';

export const TIMEZONE = 'Asia/Kolkata' as const;
export const DATE_PERIODS = ['today', 'yesterday', 'tomorrow', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days', 'next_7_days'] as const;
export const TEMPORAL_PARAMETER_NAMES = ['date_field', 'period', 'date_from', 'date_to'] as const;
const DAY = 86_400_000;
const OFFSET = 330 * 60_000;
function invalid(message: string): never { throw new HttpError(400, 'INVALID_QUERY', message); }

function calendar(value: string, name: string) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) invalid(`${name} must be a real calendar date in YYYY-MM-DD format.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(`${name} must be a real calendar date in YYYY-MM-DD format.`);
  return date.getTime();
}

export function clockContext(now = new Date()) {
  return { as_of: now.toISOString(), timezone: TIMEZONE, local_date: new Date(now.getTime() + OFFSET).toISOString().slice(0, 10) };
}

/** Calendar bounds are inclusive in requests and half-open UTC instants in SQL.
 * India has a fixed +05:30 offset. Never depend on the host machine timezone.
 */
export function resolveDateQuery(query: URLSearchParams, allowedFields: readonly string[], now = new Date()) {
  const date_field = query.get('date_field') ?? 'created';
  if (!allowedFields.includes(date_field)) invalid(`date_field must be ${allowedFields.join(', ')}.`);
  const period = query.get('period');
  let start: number | null = query.has('date_from') ? calendar(query.get('date_from')!, 'date_from') : null;
  let end: number | null = query.has('date_to') ? calendar(query.get('date_to')!, 'date_to') + DAY : null;
  if (period !== null) {
    if (!(DATE_PERIODS as readonly string[]).includes(period)) invalid(`period must be ${DATE_PERIODS.join(', ')}.`);
    if (start !== null || end !== null) invalid('Use period or date_from/date_to, not both.');
    const today = calendar(clockContext(now).local_date, 'today');
    const local = new Date(today);
    const monday = today - ((local.getUTCDay() + 6) % 7) * DAY;
    const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
    const windows: Record<string, [number, number]> = {
      today: [today, today + DAY], yesterday: [today - DAY, today], tomorrow: [today + DAY, today + 2 * DAY],
      this_week: [monday, monday + 7 * DAY], last_week: [monday - 7 * DAY, monday],
      this_month: [month, Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1)],
      last_month: [Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1), month],
      last_7_days: [today - 6 * DAY, today + DAY], last_30_days: [today - 29 * DAY, today + DAY],
      next_7_days: [today, today + 7 * DAY],
    };
    [start, end] = windows[period];
  }
  if (query.has('date_field') && start === null && end === null) invalid('date_field requires period, date_from, or date_to.');
  if (start !== null && end !== null && start >= end) invalid('date_from must not be later than date_to.');
  return {
    ...clockContext(now), date_field, period,
    date_from: start === null ? null : new Date(start).toISOString().slice(0, 10),
    date_to: end === null ? null : new Date(end - DAY).toISOString().slice(0, 10),
    start_at: start === null ? null : new Date(start - OFFSET).toISOString(),
    end_before: end === null ? null : new Date(end - OFFSET).toISOString(),
  };
}

export function addDateConditions(resolved: ReturnType<typeof resolveDateQuery>, expression: string, bind: (value: unknown) => string) {
  const clauses: string[] = [];
  if (resolved.start_at) clauses.push(`${expression} >= ${bind(resolved.start_at)}::timestamptz`);
  if (resolved.end_before) clauses.push(`${expression} < ${bind(resolved.end_before)}::timestamptz`);
  return clauses;
}
