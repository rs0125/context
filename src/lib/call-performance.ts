import type { PoolClient } from 'pg';
import { withCallRead } from './call-performance-db';
import { HttpError } from './errors';
import { buildPagination } from './query-pagination';
import { addDateConditions } from './query-time';
import { CALL_GAPS, CALL_OUTCOMES, CALL_PERFORMANCE_GUIDANCE, CALL_STATES,
  resolveCallDates, type CallFilters, type CallRequest } from './call-performance-query';

const METRICS = {
  assignments: 'Matching assignment episodes; reassignment can create a separate episode for the same target.',
  open: 'Matching assignments currently open.', done: 'Matching assignments currently marked Done by staff; not verified calls.',
  dropped: 'Matching assignments currently dropped, kept separate from Done.',
  available: 'Matching assignments with current recorded outcome Available, regardless of state.',
  unavailable: 'Matching assignments with current recorded outcome Unavailable, regardless of state.',
  unclear: 'Matching assignments with current recorded outcome Unclear, regardless of state.',
  missing_outcome: 'Matching assignments with no recorded outcome; not proof of no work.',
  staff_marked_added: 'Matching assignments currently marked Added to DB; not deduplicated or independently verified onboarding.',
  distinct_numeric_references: 'Distinct numeric warehouse references on matching assignments marked Added. Caller counts can overlap; use the overall total. This is not first onboarding credit or verified warehouse existence.',
  open_under_7_days: 'Current open assignments younger than seven elapsed 24-hour days since assignment.',
  open_7_to_30_days: 'Current open assignments at least seven but less than thirty elapsed days old.',
  open_30_days_plus: 'Current open assignments at least thirty elapsed days old. Age is not time spent working.',
};
type Metrics = Record<keyof typeof METRICS, number>;
type Caller = { email: string; name: string | null; active: boolean | null };
type AssignmentRow = {
  id: string; entity_type: 'record' | 'call'; entity_id: string; assignee: string;
  name: string | null; active: boolean | null; assigned_at: Date; state: 'open' | 'done' | 'dropped';
  outcome: 'Available' | 'Unavailable' | 'Unclear' | null; completed_at: Date | null;
  staff_marked_added: boolean; has_recorded_reference: boolean; numeric_warehouse_reference: string | null;
  audit_events: number; open_age_days: number | null;
};
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
function caller(row: { assignee: string; name: string | null; active: boolean | null }): Caller {
  return { email: row.assignee, name: row.name, active: row.active };
}
function assignment(row: AssignmentRow) {
  return { id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, caller: caller(row),
    assigned_at: iso(row.assigned_at)!, state: row.state, outcome: row.outcome, completed_at: iso(row.completed_at),
    staff_marked_added: row.staff_marked_added, has_recorded_reference: row.has_recorded_reference,
    numeric_warehouse_reference: row.numeric_warehouse_reference, open_age_days: row.open_age_days,
    audit_events: row.audit_events, source_path: `/api/v1/calls/assignments/${row.id}` };
}

/** One predicate shared by summary and search. Joins never multiply assignments. */
export function callAssignmentFilter(input: CallFilters, now: Date) {
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const snapshot = `${bind(now.toISOString())}::timestamptz`;
  const dates = resolveCallDates(input, now);
  const where = addDateConditions(dates, 'a.assigned_at', bind);
  if (input.caller) where.push(`a.assignee=${bind(input.caller)}`);
  if (input.entity_type) where.push(`a.entity_type=${bind(input.entity_type)}`);
  if (input.state) where.push(`a.state=${bind(input.state)}`);
  if (input.outcome) where.push(`a.outcome=${bind(input.outcome)}`);
  if (input.min_open_age_days !== undefined) where.push(`a.state='open'`, `a.assigned_at<=${snapshot}-${bind(input.min_open_age_days)}::integer*interval '24 hours'`);
  if (input.gap === 'missing_outcome') where.push('a.outcome IS NULL');
  if (input.gap === 'added_without_reference') where.push('a.staff_marked_added AND NOT a.has_recorded_reference');
  if (input.gap === 'done_available_without_numeric_reference') where.push("a.state='done' AND a.outcome='Available' AND a.numeric_warehouse_reference IS NULL");
  if (input.gap === 'without_audit') where.push('NOT EXISTS(SELECT 1 FROM call_performance.assignment_changes h WHERE h.assignment_id=a.id)');
  const filters: CallFilters = Object.fromEntries(Object.entries(input).filter(([key]) => !['limit', 'cursor'].includes(key)));
  return { params, bind, where, snapshot, context: { date_basis: 'assigned_at' as const, state_basis: 'current' as const,
    date_from: dates.date_from, date_to: dates.date_to, start_at: dates.start_at, end_before: dates.end_before, filters } };
}

async function sourceContext(client: PoolClient) {
  const row = (await client.query<{
    snapshot_at: Date; manual_attempts: number; first_audit_at: Date | null; assignments_without_audit: number;
    employee_callers: number; linked_employee_callers: number; callyzer_accounts: number;
    callyzer_last_success_at: Date | null; callyzer_has_error: boolean | null;
  }>('SELECT transaction_timestamp() AS snapshot_at,c.* FROM call_performance.coverage c')).rows[0];
  if (!row) throw new HttpError(503, 'CALLS_SOURCE_UNAVAILABLE', 'Call reporting coverage is unavailable.');
  const now = new Date(row.snapshot_at);
  const lastSuccess = iso(row.callyzer_last_success_at);
  const lag = lastSuccess ? now.getTime() - Date.parse(lastSuccess) : Infinity;
  const status = row.callyzer_accounts !== 1 || !lastSuccess ? 'unavailable' as const
    : row.callyzer_has_error || lag < -60000 || lag > 15 * 60000 ? 'stale' as const : 'recent_import' as const;
  const warnings = ['Manual logs are recorded evidence only; missing attempts do not prove inactivity.',
    'Assignment outcomes and warehouse references are staff-recorded, not independently verified.'];
  if (row.assignments_without_audit || !row.first_audit_at) warnings.push('Retained change history does not cover every assignment from creation; historical states cannot be fully reconstructed.');
  if (row.linked_employee_callers < row.employee_callers) warnings.push('Callyzer links do not cover all employee callers.');
  if (status !== 'recent_import') warnings.push('Callyzer imports are stale or unavailable; missing recent calls cannot be interpreted as zero activity.');
  else warnings.push('A recent Callyzer import does not prove complete device uploads or assignment attribution.');
  return { now, base: { source: 'callongo' as const, read_only: true as const, snapshot_at: now.toISOString(),
    timezone: 'Asia/Kolkata' as const, guidance: CALL_PERFORMANCE_GUIDANCE,
    coverage: { scope: 'whole_source' as const, manual_attempts: row.manual_attempts, first_audit_at: iso(row.first_audit_at),
      assignments_without_audit: row.assignments_without_audit, employee_callers: row.employee_callers,
      linked_employee_callers: row.linked_employee_callers, callyzer_last_success_at: lastSuccess,
      callyzer_status: status, warnings } } };
}

function totalsSql(snapshot: string) {
  return `count(*)::integer AS assignments,
    count(*) FILTER(WHERE a.state='open')::integer AS open,
    count(*) FILTER(WHERE a.state='done')::integer AS done,
    count(*) FILTER(WHERE a.state='dropped')::integer AS dropped,
    count(*) FILTER(WHERE a.outcome='Available')::integer AS available,
    count(*) FILTER(WHERE a.outcome='Unavailable')::integer AS unavailable,
    count(*) FILTER(WHERE a.outcome='Unclear')::integer AS unclear,
    count(*) FILTER(WHERE a.outcome IS NULL)::integer AS missing_outcome,
    count(*) FILTER(WHERE a.staff_marked_added)::integer AS staff_marked_added,
    count(DISTINCT a.numeric_warehouse_reference) FILTER(WHERE a.staff_marked_added)::integer AS distinct_numeric_references,
    count(*) FILTER(WHERE a.state='open' AND a.assigned_at>${snapshot}-interval '7 days')::integer AS open_under_7_days,
    count(*) FILTER(WHERE a.state='open' AND a.assigned_at<=${snapshot}-interval '7 days'
      AND a.assigned_at>${snapshot}-interval '30 days')::integer AS open_7_to_30_days,
    count(*) FILTER(WHERE a.state='open' AND a.assigned_at<=${snapshot}-interval '30 days')::integer AS open_30_days_plus`;
}
function metrics(row: Metrics): Metrics {
  return Object.fromEntries(Object.keys(METRICS).map(key => [key, row[key as keyof Metrics]])) as Metrics;
}
const assignmentColumns = (snapshot: string) => `a.id::text,a.entity_type,a.entity_id::text,a.assignee,u.name,u.active,
  a.assigned_at,a.state,a.outcome,a.completed_at,a.staff_marked_added,a.has_recorded_reference,a.numeric_warehouse_reference,
  CASE WHEN a.state='open' THEN greatest(0,floor(extract(epoch FROM (${snapshot}-a.assigned_at))/86400))::integer END AS open_age_days,
  (SELECT count(*)::integer FROM call_performance.assignment_changes h WHERE h.assignment_id=a.id) AS audit_events`;
const assignmentFrom = 'FROM call_performance.assignments a LEFT JOIN call_performance.callers u ON u.email=a.assignee';

/** Both transports call this reader; all call-source facts share one snapshot. */
export async function readCallPerformance(request: CallRequest, transaction: typeof withCallRead = withCallRead) {
  return transaction(async client => {
    const { now, base } = await sourceContext(client);
    if (request.report === 'capabilities') {
      const people = (await client.query<Caller>('SELECT email,name,active FROM call_performance.callers ORDER BY email LIMIT 101')).rows;
      return { ...base, callers: people.slice(0, 100), callers_truncated: people.length > 100,
        filters: { states: [...CALL_STATES], outcomes: [...CALL_OUTCOMES], entity_types: ['record', 'call'], gaps: [...CALL_GAPS] },
        metrics: Object.entries(METRICS).map(([name, definition]) => ({ name, definition })), max_page_size: 25 as const, max_date_range_days: 366 as const };
    }
    if (request.report === 'summary') {
      const spec = callAssignmentFilter(request.input, now);
      const rows = (await client.query<Metrics & { assignee: string; name: string | null; active: boolean | null; is_total: boolean }>(`
        WITH totals AS (SELECT a.assignee,grouping(a.assignee)=1 AS is_total,${totalsSql(spec.snapshot)}
          FROM call_performance.assignments a ${spec.where.length ? `WHERE ${spec.where.join(' AND ')}` : ''}
          GROUP BY GROUPING SETS ((a.assignee),()))
        SELECT t.*,u.name,u.active FROM totals t LEFT JOIN call_performance.callers u ON u.email=t.assignee
        ORDER BY t.is_total DESC,t.assignments DESC,t.assignee LIMIT 102`, spec.params)).rows;
      const overall = rows.find(row => row.is_total);
      if (!overall) throw new HttpError(503, 'CALLS_SOURCE_UNAVAILABLE', 'Call summary is unavailable.');
      const people = rows.filter(row => !row.is_total);
      const shown = people.slice(0, 100);
      return { ...base, query_context: spec.context, totals: metrics(overall),
        callers: shown.map(row => ({ caller: caller(row), metrics: metrics(row) })), callers_truncated: people.length > 100,
        assignments_outside_caller_breakdown: overall.assignments - shown.reduce((sum, row) => sum + row.assignments, 0) };
    }
    if (request.report === 'assignments') {
      const spec = callAssignmentFilter(request.input, now), limit = request.input.limit ?? 25;
      const query = new URLSearchParams(Object.entries(request.input).map(([key, value]) => [key, String(value)]));
      const pagination = buildPagination(query, { idColumn: 'a.id', idType: 'bigint', sortColumns: {},
        filterContext: { date_from: spec.context.date_from, date_to: spec.context.date_to } }, spec.bind);
      const where = [...spec.where, ...pagination.where];
      const rows = (await client.query<AssignmentRow>(`SELECT ${assignmentColumns(spec.snapshot)} ${assignmentFrom}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${pagination.orderBy} LIMIT ${spec.bind(limit + 1)}`, spec.params)).rows;
      const shown = rows.slice(0, limit), more = rows.length > limit;
      return { ...base, query_context: spec.context, items: shown.map(assignment),
        nextCursor: more ? pagination.cursorFor(shown[shown.length - 1]) : null,
        pagination: { limit, has_more: more, snapshot: false as const } };
    }
    const { id, limit = 25, cursor } = request.input;
    const current = (await client.query<AssignmentRow>(`SELECT ${assignmentColumns('$1::timestamptz')} ${assignmentFrom}
      WHERE a.id=$2::bigint`, [now.toISOString(), id])).rows[0];
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Assignment not found.');
    const params: unknown[] = [id], bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const pagination = buildPagination(new URLSearchParams(cursor ? { cursor } : {}),
      { idColumn: 'h.id', idType: 'bigint', sortColumns: {}, filterContext: { assignment_id: id } }, bind);
    type ChangeRow = { id: string; changed_at: Date; actor: string | null; creation_event: boolean;
      before_state: string | null; after_state: string | null; before_outcome: string | null; after_outcome: string | null;
      before_staff_marked_added: boolean | null; after_staff_marked_added: boolean | null;
      before_numeric_warehouse_reference: string | null; after_numeric_warehouse_reference: string | null };
    const history = (await client.query<ChangeRow>(`SELECT h.id::text,h.changed_at,h.actor,h.creation_event,
      h.before_state,h.after_state,h.before_outcome,h.after_outcome,h.before_staff_marked_added,h.after_staff_marked_added,
      h.before_numeric_warehouse_reference,h.after_numeric_warehouse_reference
      FROM call_performance.assignment_changes h WHERE h.assignment_id=$1::bigint
      ${pagination.where.length ? `AND ${pagination.where.join(' AND ')}` : ''}
      ORDER BY ${pagination.orderBy} LIMIT ${bind(limit + 1)}`, params)).rows;
    const creation = (await client.query<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM call_performance.assignment_changes WHERE assignment_id=$1::bigint AND creation_event) AS present', [id])).rows[0].present;
    const shown = history.slice(0, limit), more = history.length > limit;
    return { ...base, assignment: assignment(current), history_has_creation_event: creation,
      history: shown.map(row => ({ id: row.id, changed_at: iso(row.changed_at)!, actor: row.actor, creation_event: row.creation_event,
        before: { state: row.before_state, outcome: row.before_outcome, staff_marked_added: row.before_staff_marked_added, numeric_warehouse_reference: row.before_numeric_warehouse_reference },
        after: { state: row.after_state, outcome: row.after_outcome, staff_marked_added: row.after_staff_marked_added, numeric_warehouse_reference: row.after_numeric_warehouse_reference } })),
      nextCursor: more ? pagination.cursorFor(shown[shown.length - 1]) : null,
      pagination: { limit, has_more: more, snapshot: false as const } };
  });
}
