import { z } from 'zod';
import { HttpError } from './errors';
import { clockContext, resolveDateQuery } from './query-time';

export const CALL_PERFORMANCE_SCOPE = 'calls.performance:read' as const;
export const CALL_STATES = ['open', 'done', 'dropped'] as const;
export const CALL_OUTCOMES = ['Available', 'Unavailable', 'Unclear'] as const;
export const CALL_GAPS = ['missing_outcome', 'added_without_reference', 'done_available_without_numeric_reference', 'without_audit'] as const;
export const CALL_PERFORMANCE_GUIDANCE = "Read-only assignment reports for Analysts. Use summary for totals and search only for requested examples; stop when enough are returned. For Available markings not in the warehouse DB, use outcome=Available and warehouse_match=no. Warehouse DB contact matches are independent of staff_marked_added and saved references; never subtract staff markings to infer DB matches. Inspect warehouse_sync freshness and pending reviews separately from Callyzer. Counts are assignments; phone matches do not establish unique properties or first onboarding credit. Omit entity_type unless a subset is requested; call means AI reviews. Dates select assigned_at in IST, with current states; keep each subquestion's date scope separate. Actual-call rankings, period completions, first-call time and follow-up compliance are unsupported. Missing/stale logs never prove inactivity. Read supplied assignment IDs directly; convert history times to IST or label UTC. Missing history cannot establish creation state or first contact.";

const date = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/);
const id = z.string().regex(/^[1-9]\d{0,18}$/).describe('Exact assignment ID string supplied by the user or returned by search.');
const cursor = z.string().min(1).max(1024).describe('Copy nextCursor unchanged with the same filters. Pages are not a frozen snapshot.').optional();
const page = { limit: z.number().int().min(1).max(25).describe('Rows per page; default 25. For examples, request only the remaining number needed.').optional(), cursor };
export const callSummaryInput = z.object({
  caller: z.string().email().max(320).describe('Exact work email from call_performance_capabilities. Narrows report subjects.').optional(),
  entity_type: z.enum(['record', 'call']).describe('Omit for all call-dashboard assignments and team warehouse-reference totals. Filter only if the user explicitly chooses record (listing assignments) or call (AI execution reviews). Both types can record warehouse references; call does not mean calls made.').optional(),
  state: z.enum(CALL_STATES).describe('Current assignment state.').optional(),
  outcome: z.enum(CALL_OUTCOMES).describe('Current staff-recorded outcome.').optional(),
  warehouse_match: z.enum(['yes', 'no']).describe('Contact match against the imported warehouse DB index, independent of the manual Added flag. Use no with outcome=Available for Available markings with no DB match. Inspect warehouse_sync coverage and review flags.').optional(),
  date_from: date.describe('Inclusive first assignment date, IST. Pair with date_to. Omit both for all retained assignments.').optional(),
  date_to: date.describe('Inclusive last assignment date, IST. Maximum 366 days; no future dates.').optional(),
  min_open_age_days: z.number().int().min(0).max(36500).describe('Open for at least this many elapsed 24-hour days since assignment. Only current open work.').optional(),
  gap: z.enum(CALL_GAPS).describe('Recorded evidence gap, not a finding of employee inactivity.').optional(),
}).strict();
export const callSearchInput = callSummaryInput.extend(page);
export const callDetailInput = z.object({ id, ...page }).strict();
export const callCapabilitiesInput = z.object({}).strict();

export type CallFilters = z.infer<typeof callSummaryInput>;
export type CallRequest =
  | { report: 'capabilities'; input: z.infer<typeof callCapabilitiesInput> }
  | { report: 'summary'; input: CallFilters }
  | { report: 'assignments'; input: z.infer<typeof callSearchInput> }
  | { report: 'detail'; input: z.infer<typeof callDetailInput> };

function invalid(message: string): never { throw new HttpError(422, 'INVALID_QUERY', message); }
export function validateCallRequest(path: string[], query: URLSearchParams, now = new Date()): CallRequest {
  const route = path.join('/');
  const report = route === 'calls/capabilities' ? 'capabilities' : route === 'calls/summary' ? 'summary'
    : route === 'calls/assignments' ? 'assignments'
      : path.length === 3 && path[0] === 'calls' && path[1] === 'assignments' ? 'detail' : null;
  if (!report) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
  const schema = report === 'summary' ? callSummaryInput : report === 'assignments' ? callSearchInput
    : report === 'detail' ? callDetailInput.omit({ id: true }) : callCapabilitiesInput;
  const values: Record<string, unknown> = {};
  for (const [key, value] of query) {
    if (Object.hasOwn(values, key) || !Object.hasOwn(schema.shape, key)) invalid('Unsupported or duplicate call report parameter.');
    values[key] = ['limit', 'min_open_age_days'].includes(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) invalid('Use the call report schema: valid enums, paired calendar dates and a page limit from 1 to 25.');
  if (report === 'detail') {
    const detail = callDetailInput.safeParse({ ...parsed.data, id: path[2] });
    if (!detail.success || BigInt(path[2]) > 9223372036854775807n) invalid('Assignment id must be a positive PostgreSQL bigint string.');
    return { report, input: detail.data };
  }
  if (report === 'capabilities') return { report, input: {} };
  const input = parsed.data as z.infer<typeof callSearchInput>;
  if (input.caller) input.caller = input.caller.toLowerCase();
  if (!!input.date_from !== !!input.date_to) invalid('Supply both date_from and date_to, or omit both.');
  const dates = resolveCallDates(input, now);
  if (dates.date_to && dates.date_to > clockContext(now).local_date) invalid('Assignment dates cannot be in the future.');
  if (dates.start_at && dates.end_before && Date.parse(dates.end_before) - Date.parse(dates.start_at) > 366 * 86400000) invalid('The maximum dated assignment cohort is 366 days. Omit dates for all retained assignments.');
  if (input.min_open_age_days !== undefined && input.state && input.state !== 'open') invalid('min_open_age_days applies only to open assignments.');
  return { report, input };
}

export function resolveCallDates(input: CallFilters, now: Date) {
  const query = new URLSearchParams();
  if (input.date_from) query.set('date_from', input.date_from);
  if (input.date_to) query.set('date_to', input.date_to);
  // Reuse the existing calendar validator and half-open IST bounds.
  query.set('date_field', 'assigned');
  if (!input.date_from && !input.date_to) query.delete('date_field');
  return resolveDateQuery(query, ['created', 'assigned'], now);
}

const timestamp = z.string().datetime();
const count = z.number().int().nonnegative();
const caller = z.object({ email: z.string(), name: z.string().nullable(), active: z.boolean().nullable() });
const coverage = z.object({
  scope: z.literal('whole_source'), manual_attempts: count, first_audit_at: timestamp.nullable(),
  assignments_without_audit: count, employee_callers: count, linked_employee_callers: count,
  callyzer_last_success_at: timestamp.nullable(), callyzer_status: z.enum(['unavailable', 'stale', 'recent_import']),
  warehouse_sync: z.object({ status: z.enum(['unavailable', 'stale', 'catching_up', 'recent_import']), enabled: z.boolean(), initialized: z.boolean(),
    interval_seconds: count.nullable(), last_success_at: timestamp.nullable(), last_snapshot_at: timestamp.nullable(),
    has_more: z.boolean(), audit_replay_limited: z.boolean(), pending_reviews: count }),
  warnings: z.array(z.string()),
});
const base = {
  source: z.literal('callongo'), read_only: z.literal(true), snapshot_at: timestamp,
  timezone: z.literal('Asia/Kolkata'), coverage, guidance: z.string(),
};
const context = z.object({
  date_basis: z.literal('assigned_at'), state_basis: z.literal('current'), date_from: date.nullable(), date_to: date.nullable(),
  start_at: timestamp.nullable(), end_before: timestamp.nullable(), filters: callSummaryInput,
});
export const callMetricsOutput = z.object({
  assignments: count, open: count, done: count, dropped: count,
  available: count, unavailable: count, unclear: count, missing_outcome: count,
  staff_marked_added: count, distinct_numeric_references: count,
  warehouse_matched: count, without_warehouse_match: count, warehouse_match_needs_review: count,
  open_under_7_days: count, open_7_to_30_days: count, open_30_days_plus: count,
});
export const callCapabilitiesOutput = z.object({ ...base,
  callers: z.array(caller).max(100), callers_truncated: z.boolean(),
  filters: z.object({ states: z.array(z.string()), outcomes: z.array(z.string()), entity_types: z.array(z.string()), gaps: z.array(z.string()), warehouse_match: z.array(z.enum(['yes', 'no'])) }),
  metrics: z.array(z.object({ name: z.string(), definition: z.string() })), max_page_size: z.literal(25), max_date_range_days: z.literal(366),
});
export const callSummaryOutput = z.object({ ...base, query_context: context, totals: callMetricsOutput,
  callers: z.array(z.object({ caller, metrics: callMetricsOutput })).max(100), callers_truncated: z.boolean(),
  assignments_outside_caller_breakdown: count,
});
const assignment = z.object({
  id: z.string(), entity_type: z.enum(['record', 'call']), entity_id: z.string(), caller,
  assigned_at: timestamp, state: z.enum(CALL_STATES), outcome: z.enum(CALL_OUTCOMES).nullable(),
  completed_at: timestamp.nullable(), staff_marked_added: z.boolean(),
  has_recorded_reference: z.boolean(), numeric_warehouse_reference: z.string().nullable(),
  warehouse_matched: z.boolean(), matched_warehouse_ids: z.array(z.string()).max(25),
  warehouse_matches_truncated: z.boolean(), warehouse_match_needs_review: z.boolean(),
  open_age_days: count.nullable(), audit_events: count, source_path: z.string(),
});
const pagination = { nextCursor: z.string().nullable(), pagination: z.object({ limit: count, has_more: z.boolean(), snapshot: z.literal(false) }) };
export const callSearchOutput = z.object({ ...base, query_context: context, items: z.array(assignment).max(25), ...pagination });
const changeValues = z.object({ state: z.string().nullable(), outcome: z.string().nullable(),
  staff_marked_added: z.boolean().nullable(), numeric_warehouse_reference: z.string().nullable() });
export const callDetailOutput = z.object({ ...base, assignment,
  history: z.array(z.object({ id: z.string(), changed_at: timestamp, actor: z.string().nullable(),
    creation_event: z.boolean(), before: changeValues, after: changeValues })).max(25),
  history_has_creation_event: z.boolean(), ...pagination,
});
