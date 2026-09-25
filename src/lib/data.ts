import type { PoolClient } from 'pg';
import type { Principal } from './auth';
import type { CrmAccess } from './crm-live';
import { HttpError } from './errors';
import { numericValue, sanitizeLabel } from './privacy';
import { addDateConditions, resolveDateQuery, TEMPORAL_PARAMETER_NAMES, DATE_PERIODS } from './query-time';
import { buildPagination } from './query-pagination';

type Row = Record<string, unknown>;

export const ACTIVE_STAGES = [
  'NEW_LEAD', 'RFQ_RECEIVED', 'PROPOSAL_SHARED', 'FOLLOW_UP', 'SITE_VISIT',
  'NEGOTIATION', 'AGREEMENT_WORK', 'MONEY_COLLECTION',
] as const;
export const ALL_STAGES = [...ACTIVE_STAGES, 'RFQ_NOT_RELEVANT', 'DEAL_LOST', 'DEAL_CLOSED', 'DEAL_ON_HOLD'];
const SLA_VALUES = ['red', 'yellow', 'green', 'unknown', 'not_tracked'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_QUERY', message);
}

function validateParameters(query: URLSearchParams, allowed: readonly string[]) {
  const seen = new Set<string>();
  for (const [key] of query) {
    if (!allowed.includes(key)) invalid(`Unknown query parameter: ${key}`);
    if (seen.has(key)) invalid(`Duplicate query parameter: ${key}`);
    seen.add(key);
  }
}

function textParameter(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!value || value.length > 80 || !/^[\p{L}\p{N} .,'()&/-]+$/u.test(value)) {
    invalid(`${name} must be a location or category of at most 80 characters`);
  }
  return value;
}

function integerParameter(query: URLSearchParams, name: string, maximum: number, fallback?: number) {
  const value = query.get(name);
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) invalid(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) invalid(`${name} is outside the supported range`);
  return parsed;
}

function numberInRange(value: unknown, maximum: number, integer = false, allowZero = false): number | null {
  const number = numericValue(value);
  return number !== null && (allowZero ? number >= 0 : number > 0) && number <= maximum && (!integer || Number.isSafeInteger(number))
    ? number : null;
}

function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$| )/.test(value))) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nonnegativeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export { searchWarehouses, getWarehouse, getWarehouseFilterOptions, summarizeWarehouses } from './warehouse-data';

const OPPORTUNITY_FIELDS = [
  'opportunity_id', 'name', 'stage', 'priority', 'city', 'company_name',
  'last_contacted', 'next_follow_up', 'last_meaningful_update_at',
  'last_meaningful_update_kind', 'stage_entered_at', 'twenty_created_at', 'twenty_updated_at',
  'last_polled_at',
] as const;
const OPPORTUNITY_RESULT_FIELDS = [...OPPORTUNITY_FIELDS, 'requirement_sqft', 'micro_market'];
const OPPORTUNITY_COLUMNS = `${OPPORTUNITY_FIELDS.map((field) => `o.${field}`).join(', ')},
  o.data->>'requirementInSft' AS requirement_sqft,
  o.data->>'microMarket' AS micro_market`;

function opportunity(row: Row) {
  const priority = /^RATING_([1-5])$/.exec(typeof row.priority === 'string' ? row.priority : '');
  return {
    id: row.opportunity_id as string,
    name: sanitizeLabel(row.name),
    stage: typeof row.stage === 'string' && ALL_STAGES.includes(row.stage) ? row.stage : null,
    priority_stars: priority ? Number(priority[1]) : null,
    city: sanitizeLabel(row.city),
    company_name: sanitizeLabel(row.company_name),
    requirement_sqft: numberInRange(row.requirement_sqft, 1_000_000_000),
    micro_market: sanitizeLabel(row.micro_market),
    last_contacted: timestamp(row.last_contacted),
    next_follow_up: timestamp(row.next_follow_up),
    last_meaningful_update_at: timestamp(row.last_meaningful_update_at),
    last_meaningful_update_kind: typeof row.last_meaningful_update_kind === 'string'
      && ['opportunity', 'note', 'task', 'attachment', 'stage'].includes(row.last_meaningful_update_kind)
      ? row.last_meaningful_update_kind : null,
    stage_entered_at: timestamp(row.stage_entered_at),
    source_created_at: timestamp(row.twenty_created_at),
    source_updated_at: timestamp(row.twenty_updated_at),
    last_polled_at: timestamp(row.last_polled_at),
  };
}

function authorizationUnavailable(): never {
  throw new HttpError(503, 'CRM_AUTHORIZATION_UNAVAILABLE', 'Current CRM access could not be verified.');
}

/** A live access result is mandatory and bound to the current roster identity.
 * Related IDs already express the verified created-or-assigned union (or the
 * requested narrower view). Stale mirror assignments must not override them.
 * Only the live Twenty authorization adapter can grant mode=all.
 */
function crmScope(principal: Principal, access: CrmAccess, bind: (value: unknown) => string): string {
  if (!access || typeof access !== 'object'
    || typeof principal.twentyUserId !== 'string' || !UUID.test(principal.twentyUserId)
    || typeof access.memberId !== 'string' || !UUID.test(access.memberId)
    || access.memberId.toLowerCase() !== principal.twentyUserId.toLowerCase()) authorizationUnavailable();
  if (access.mode === 'all') return 'o.deleted_at IS NULL';
  if (access.mode !== 'related' || !Array.isArray(access.ids) || access.ids.length > 1000
    || access.ids.some((value) => typeof value !== 'string' || !UUID.test(value))) authorizationUnavailable();
  const ids = [...new Set(access.ids.map((value) => value.toLowerCase()))];
  // Empty sets intentionally produce ANY('{}'), which never grants access.
  return `o.deleted_at IS NULL AND o.opportunity_id = ANY(${bind(ids)}::text[])`;
}

export type CrmView = 'accessible' | 'created' | 'assigned';

export const CRM_DATE_FIELDS = ['created', 'updated', 'meaningful_update', 'follow_up', 'last_contacted', 'stage_entered'] as const;
export const CRM_SORTS = ['id_asc', 'created_desc', 'created_asc', 'updated_desc', 'follow_up_asc'] as const;
export const CRM_FOLLOW_UP = ['overdue', 'today', 'upcoming', 'missing'] as const;
export const CRM_SUMMARY_GROUPS = ['stage', 'city', 'priority'] as const;
const CRM_DATES: Record<string, string> = { created: 'o.twenty_created_at', updated: 'o.twenty_updated_at', meaningful_update: 'o.last_meaningful_update_at', follow_up: 'o.next_follow_up', last_contacted: 'o.last_contacted', stage_entered: 'o.stage_entered_at' };
const CRM_FILTERS = ['city', 'stage', 'view', 'assigned_to', 'q', 'active_only', 'priority_min', 'follow_up_status', ...TEMPORAL_PARAMETER_NAMES];
const CRM_DATE_GUIDANCE = 'created uses Twenty creation time, not mirror insertion time. updated is the Twenty row update clock and may include automation writes. meaningful_update is the tracked activity clock, not a full history. stage_entered may be an observed or approximate baseline, not the actual historical transition. view=created means created by you. Missing dates are excluded by date filters. Calendar dates use Asia/Kolkata; date_to is inclusive; SQL end_before is exclusive.';

function sqlText(value: string) { return `'${value.replaceAll("'", "''")}'`; }

/** These identifiers are application constants, never request input. Filtering
 * must not reveal a withheld name through short substring probes or split a
 * withheld city into several ranked groups. This deliberately conservative SQL
 * grammar accepts ordinary company/location labels and rejects contacts before
 * matching or aggregation; sanitizeLabel remains the final output boundary.
 */
function safeCrmLabelSql(column: 'o.name' | 'o.company_name' | 'o.city', maximum = 100) {
  const raw = `btrim(${column})`;
  const allowed = sqlText(`^[A-Za-z0-9 .,'()&/_–—-]{1,${maximum}}$`);
  const contacts = sqlText('https?:|www[.]|mailto:|tel:|wa[.]me|whatsapp|contact[[:space:]]*(me|us|number)|call[[:space:]]*(me|us|on)');
  const phone = sqlText('([0-9][[:space:][:punct:]–—]*){7,}');
  const spoken = sqlText('((zero|one|two|three|four|five|six|seven|eight|nine|oh)[[:space:],.-]+){6,}(zero|one|two|three|four|five|six|seven|eight|nine|oh)');
  return `CASE WHEN ${raw} ~ ${allowed} AND lower(${raw}) !~ ${contacts} AND ${raw} !~ ${phone} AND lower(${raw}) !~ ${spoken} THEN ${raw} ELSE NULL END`;
}

const SAFE_NAME = safeCrmLabelSql('o.name');
const SAFE_COMPANY = safeCrmLabelSql('o.company_name');
const SAFE_CITY = safeCrmLabelSql('o.city', 80);

export function validateCrmQuery(query: URLSearchParams, mode: 'search' | 'summary' | 'filters' = 'search') {
  validateParameters(query, mode === 'filters' ? ['view', 'assigned_to'] : [...CRM_FILTERS, ...(mode === 'summary' ? ['group_by', 'group_limit'] : ['limit', 'cursor', 'sort'])]);
  if (query.has('assigned_to') && query.has('view')) invalid('Use view or assigned_to, not both');
  if (query.has('assigned_to') && query.get('assigned_to') !== 'me') invalid('assigned_to only supports me');
  const view = query.has('assigned_to') ? 'assigned' : query.get('view') ?? 'accessible';
  if (!['accessible', 'created', 'assigned'].includes(view)) invalid('view must be accessible, created, or assigned');
  const city = textParameter(query, 'city');
  if (city && sanitizeLabel(city, 80) !== city) invalid('city must be a location label, without contacts.');
  const stage = query.get('stage');
  if (stage !== null && !ALL_STAGES.includes(stage)) invalid('Unknown CRM stage');
  const cursor = query.get('cursor');
  const sort = query.get('sort') ?? 'id_asc';
  if (!(CRM_SORTS as readonly string[]).includes(sort)) invalid(`sort must be ${CRM_SORTS.join(', ')}`);
  if (cursor !== null && (sort === 'id_asc' ? !UUID.test(cursor) : cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) invalid('Use nextCursor from the same CRM search and sort.');
  const limit = integerParameter(query, 'limit', 25, 10)!;
  const q = textParameter(query, 'q');
  if (q && sanitizeLabel(q, 80) !== q) invalid('q must be a lead or company name, without contacts.');
  const active = query.get('active_only');
  if (active !== null && !['true', 'false'].includes(active)) invalid('active_only must be true or false');
  const priority = integerParameter(query, 'priority_min', 5);
  const followUp = query.get('follow_up_status');
  if (followUp !== null && !(CRM_FOLLOW_UP as readonly string[]).includes(followUp)) invalid(`follow_up_status must be ${CRM_FOLLOW_UP.join(', ')}`);
  if (followUp && query.get('date_field') === 'follow_up') invalid('Use follow_up_status or a follow_up date range, not both.');
  const dates = resolveDateQuery(query, CRM_DATE_FIELDS);
  const groupBy = query.get('group_by') ?? 'stage';
  if (!(CRM_SUMMARY_GROUPS as readonly string[]).includes(groupBy)) invalid(`group_by must be ${CRM_SUMMARY_GROUPS.join(', ')}`);
  const groupLimit = integerParameter(query, 'group_limit', 25, 10)!;
  return { view: view as CrmView, city, stage, cursor, limit, sort, q, active: active === 'true', priority, followUp, dates, groupBy, groupLimit };
}

function crmQuery(principal: Principal, query: URLSearchParams, access: CrmAccess, mode: 'search' | 'summary' | 'filters' = 'search') {
  const parsed = validateCrmQuery(query, mode);
  const { city, stage, q, active, priority, followUp, dates } = parsed;
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = [crmScope(principal, access, bind)];
  if (city) {
    const param = bind(city);
    where.push(`EXISTS (SELECT 1 FROM regexp_split_to_table(${SAFE_CITY}, ',') AS location(value) WHERE lower(btrim(location.value)) = lower(${param}) OR (lower(btrim(location.value)) IN ('bangalore','bengaluru') AND lower(${param}) IN ('bangalore','bengaluru')) OR (lower(btrim(location.value)) IN ('gurgaon','gurugram') AND lower(${param}) IN ('gurgaon','gurugram')))`);
  }
  if (stage) where.push(`o.stage = ${bind(stage)}`);
  if (q) {
    const param = bind(q);
    where.push(`(strpos(lower(coalesce(${SAFE_NAME}, '')), lower(${param})) > 0 OR strpos(lower(coalesce(${SAFE_COMPANY}, '')), lower(${param})) > 0)`);
  }
  if (active) where.push(`o.stage = ANY(${bind([...ACTIVE_STAGES])}::text[])`);
  if (priority) where.push(`o.priority = ANY(${bind(Array.from({ length: 6 - priority }, (_, index) => `RATING_${priority + index}`))}::text[])`);
  where.push(...addDateConditions(dates, CRM_DATES[dates.date_field], bind));
  let followUpWindow: { status: string; start_at: string | null; end_before: string | null; timezone: 'Asia/Kolkata' } | null = null;
  if (followUp) {
    const today = resolveDateQuery(new URLSearchParams('period=today'), ['created'], new Date(dates.as_of));
    followUpWindow = { status: followUp, start_at: followUp === 'today' ? today.start_at : followUp === 'upcoming' ? today.end_before : null,
      end_before: followUp === 'today' ? today.end_before : followUp === 'overdue' ? today.start_at : null, timezone: 'Asia/Kolkata' };
    if (followUp === 'missing') where.push('o.next_follow_up IS NULL');
    else {
      if (followUpWindow.start_at) where.push(`o.next_follow_up >= ${bind(followUpWindow.start_at)}::timestamptz`);
      if (followUpWindow.end_before) where.push(`o.next_follow_up < ${bind(followUpWindow.end_before)}::timestamptz`);
    }
  }
  return { ...parsed, values, bind, where, followUpWindow };
}

export async function searchOpportunities(client: PoolClient, principal: Principal, query: URLSearchParams, access: CrmAccess) {
  const { values, bind, where, dates, limit, followUpWindow } = crmQuery(principal, query, access);
  const pagination = buildPagination(query, { idColumn: 'o.opportunity_id', idType: 'uuid', sortColumns: Object.fromEntries(Object.entries({ created_desc: CRM_DATES.created, created_asc: CRM_DATES.created, updated_desc: CRM_DATES.updated, follow_up_asc: CRM_DATES.follow_up }).map(([name, column]) => [name, `date_trunc('milliseconds', ${column})`])), filterContext: { start_at: dates.start_at, end_before: dates.end_before, follow_up: followUpWindow } }, bind);
  where.push(...pagination.where);
  const result = await client.query<Row>(`SELECT ${OPPORTUNITY_COLUMNS}${pagination.sortColumn ? `, ${pagination.sortColumn} AS sort_value` : ''}
    FROM public.opportunities o WHERE ${where.join(' AND ')}
    ORDER BY ${pagination.orderBy} LIMIT ${bind(limit + 1)}`, values);
  const selected = result.rows.slice(0, limit);
  const last = selected.at(-1);
  const hasMore = result.rows.length > limit;
  return {
    items: selected.map(opportunity),
    nextCursor: hasMore && last ? pagination.cursorFor({ id: String(last.opportunity_id), sort_value: last.sort_value }) : null,
    query_context: { ...dates, follow_up: followUpWindow, sort: pagination.sort, returned_count: selected.length, has_more: hasMore, date_semantics: CRM_DATE_GUIDANCE },
  };
}

const SAFE_CITY_GROUP = `CASE WHEN lower(${SAFE_CITY}) IN ('bangalore','bengaluru') THEN 'Bengaluru'
  WHEN lower(${SAFE_CITY}) IN ('gurgaon','gurugram') THEN 'Gurugram' ELSE lower(${SAFE_CITY}) END`;

export async function summarizeOpportunities(client: PoolClient, principal: Principal, query: URLSearchParams, access: CrmAccess) {
  const { values, bind, where, dates, groupBy, groupLimit, followUpWindow } = crmQuery(principal, query, access, 'summary');
  const expressions: Record<string, string> = { stage: groupBy === 'stage' ? `CASE WHEN o.stage = ANY(${bind(ALL_STAGES)}::text[]) THEN o.stage END` : 'NULL', city: SAFE_CITY_GROUP, priority: "CASE WHEN o.priority ~ '^RATING_[1-5]$' THEN o.priority END" };
  const result = await client.query<Row>(`WITH grouped AS (
    SELECT ${expressions[groupBy]} AS value, count(*)::integer AS count FROM public.opportunities o WHERE ${where.join(' AND ')} GROUP BY 1
  ) SELECT coalesce((SELECT sum(count)::integer FROM grouped), 0) AS total,
    coalesce((SELECT jsonb_agg(g ORDER BY count DESC, value ASC NULLS LAST) FROM (SELECT * FROM grouped ORDER BY count DESC, value ASC NULLS LAST LIMIT ${bind(groupLimit + 1)}) g), '[]'::jsonb) AS groups`, values);
  const row = result.rows[0];
  const count = (value: unknown) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(503, 'CRM_DATA_UNAVAILABLE', 'The CRM summary could not be verified.');
    return parsed;
  };
  if (!row || !Array.isArray(row.groups) || row.groups.length > groupLimit + 1) throw new HttpError(503, 'CRM_DATA_UNAVAILABLE', 'The CRM summary could not be verified.');
  const allGroups = row.groups as Row[];
  const merged = new Map<string | null, number>();
  for (const group of allGroups.slice(0, groupLimit)) {
    if (!group || typeof group !== 'object') throw new HttpError(503, 'CRM_DATA_UNAVAILABLE', 'The CRM summary could not be verified.');
    const label = sanitizeLabel(group.value, 80);
    merged.set(label, (merged.get(label) ?? 0) + count(group.count));
  }
  const groups = [...merged].map(([value, count]) => ({ value, count }));
  const total = count(row.total);
  const other = total - groups.reduce((sum, group) => sum + group.count, 0);
  if (other < 0) throw new HttpError(503, 'CRM_DATA_UNAVAILABLE', 'The CRM summary could not be verified.');
  return { total, group_by: groupBy, groups, groups_truncated: allGroups.length > groupLimit, other_count: other,
    query_context: { ...dates, follow_up: followUpWindow, date_semantics: CRM_DATE_GUIDANCE, coverage: 'All currently permitted, nondeleted mirrored leads matching the filters. Null groups combine missing or withheld labels. Counts are not limited to a search page. City summaries keep multi-city labels together so each lead counts once; city search matches any comma-separated city.' } };
}

export async function getCrmFilterOptions(client: PoolClient, principal: Principal, query: URLSearchParams, access: CrmAccess) {
  const { values, where } = crmQuery(principal, query, access, 'filters');
  const result = await client.query<Row>(`SELECT DISTINCT ${SAFE_CITY_GROUP.replaceAll('o.city', 'location.value')} AS city FROM public.opportunities o CROSS JOIN LATERAL regexp_split_to_table(${SAFE_CITY}, ',') AS location(value) WHERE ${where.join(' AND ')} ORDER BY city ASC NULLS LAST LIMIT 101`, values);
  return { cities: result.rows.slice(0, 100).map(row => sanitizeLabel(row.city, 80)).filter((value): value is string => value !== null), cities_truncated: result.rows.length > 100,
    stages: ALL_STAGES, views: ['accessible', 'created', 'assigned'], date_fields: CRM_DATE_FIELDS, periods: DATE_PERIODS, sorts: CRM_SORTS, follow_up_statuses: CRM_FOLLOW_UP,
    summary_groups: CRM_SUMMARY_GROUPS, date_semantics: CRM_DATE_GUIDANCE, search_guidance: 'q searches permitted lead and company labels only; labels containing contacts or unsupported characters do not participate in text search. City matches a comma-separated member, with Bangalore/Bengaluru and Gurgaon/Gurugram aliases. All filters combine with AND. active_only=true excludes closed, lost, on-hold and irrelevant stages. Follow-ups become overdue on the next India calendar day. No contacts or note-text search.' };
}

export async function getOpportunity(client: PoolClient, principal: Principal, id: string, access: CrmAccess) {
  if (!UUID.test(id)) invalid('Opportunity id must be a UUID');
  const values: unknown[] = [id.toLowerCase()];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const scope = crmScope(principal, access, bind);
  const result = await client.query<Row>(`SELECT ${OPPORTUNITY_COLUMNS}
    FROM public.opportunities o
    WHERE ${scope} AND o.opportunity_id = $1 LIMIT 1`, values);
  return result.rows[0] ? opportunity(result.rows[0]) : null;
}

function counts(value: unknown, allowed: readonly string[]) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
  return Object.fromEntries(allowed.map((key) => [key, nonnegativeInteger(record[key])]));
}

export async function getMyBriefing(client: PoolClient, principal: Principal, access: CrmAccess) {
  const now = new Date().toISOString();
  const columns = OPPORTUNITY_RESULT_FIELDS.join(', ');
  const priorityOrder = (relation: 'scored' | 'prioritized') => `CASE ${relation}.sla WHEN 'red' THEN 0 WHEN 'yellow' THEN 1
    WHEN 'unknown' THEN 2 WHEN 'green' THEN 3 ELSE 4 END,
    ${relation}.next_follow_up ASC NULLS LAST, ${relation}.stage_entered_at ASC NULLS LAST, ${relation}.opportunity_id ASC`;
  // Counts cover every authorized active row. LIMIT applies only to priorities.
  // Rules match CRM-Automations/src/lib/sla.js; missing clocks are explicit.
  const values: unknown[] = [now, [...ACTIVE_STAGES]];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const scope = crmScope(principal, access, bind);
  const result = await client.query<Row>(`WITH scoped AS (
    SELECT ${OPPORTUNITY_COLUMNS},
      floor(extract(epoch FROM ($1::timestamptz - o.stage_entered_at)) / 86400)::integer AS days_in_stage
    FROM public.opportunities o
    WHERE ${scope} AND o.stage = ANY($2::text[])
  ), scored AS (
    SELECT ${columns}, days_in_stage,
      CASE
        WHEN stage IN ('NEGOTIATION', 'AGREEMENT_WORK', 'MONEY_COLLECTION') THEN 'not_tracked'
        WHEN stage_entered_at IS NULL THEN 'unknown'
        WHEN stage IN ('NEW_LEAD', 'RFQ_RECEIVED') THEN
          CASE WHEN days_in_stage <= 1 THEN 'green' WHEN days_in_stage <= 2 THEN 'yellow' ELSE 'red' END
        WHEN stage IN ('PROPOSAL_SHARED', 'FOLLOW_UP') THEN
          CASE WHEN days_in_stage <= 3 THEN 'green' WHEN days_in_stage <= 5 THEN 'yellow' ELSE 'red' END
        WHEN stage = 'SITE_VISIT' THEN
          CASE WHEN days_in_stage <= 1 THEN 'green' WHEN days_in_stage <= 3 THEN 'yellow' ELSE 'red' END
        ELSE 'not_tracked'
      END AS sla
    FROM scoped
  ) SELECT
    (SELECT count(*)::integer FROM scored) AS total_active,
    coalesce((SELECT jsonb_object_agg(stage, total) FROM
      (SELECT stage, count(*)::integer AS total FROM scored GROUP BY stage) stage_counts), '{}'::jsonb) AS counts_by_stage,
    coalesce((SELECT jsonb_object_agg(sla, total) FROM
      (SELECT sla, count(*)::integer AS total FROM scored GROUP BY sla) sla_counts), '{}'::jsonb) AS counts_by_sla,
    (SELECT count(*)::integer FROM scored WHERE next_follow_up <
      (date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')) AS follow_up_overdue,
    coalesce((SELECT jsonb_agg(to_jsonb(prioritized) ORDER BY ${priorityOrder('prioritized')}) FROM
      (SELECT ${columns}, days_in_stage, sla FROM scored
       ORDER BY ${priorityOrder('scored')} LIMIT 20) prioritized), '[]'::jsonb) AS priorities`,
  values);
  const row = result.rows[0] ?? {};
  return {
    as_of: now,
    timezone: 'Asia/Kolkata',
    total_active: nonnegativeInteger(row.total_active),
    counts_by_stage: counts(row.counts_by_stage, ACTIVE_STAGES),
    counts_by_sla: counts(row.counts_by_sla, SLA_VALUES),
    // A follow-up dated today becomes overdue on the next IST calendar day.
    follow_up_overdue: nonnegativeInteger(row.follow_up_overdue),
    priorities: Array.isArray(row.priorities) ? row.priorities.slice(0, 20).map((entry: Row) => ({
      ...opportunity(entry),
      sla: typeof entry.sla === 'string' && (SLA_VALUES as readonly string[]).includes(entry.sla) ? entry.sla : 'unknown',
      days_in_stage: typeof entry.days_in_stage === 'number' && Number.isSafeInteger(entry.days_in_stage)
        ? entry.days_in_stage : null,
    })) : [],
  };
}

export async function getFreshness(client: PoolClient) {
  const streams = ['opportunities', 'notes', 'tasks'];
  const result = await client.query<Row>(`SELECT object, last_updated_at, last_run_at, last_run_status
    FROM public.sync_checkpoints WHERE object = ANY($1::text[]) ORDER BY object ASC`, [streams]);
  return {
    source_status: Object.fromEntries(streams.map((stream) => {
      const row = result.rows.find((record) => record.object === stream);
      return [stream, {
        // last_updated_at is the source watermark; last_run_at can be a failure.
        source_watermark_at: timestamp(row?.last_updated_at),
        last_run_at: timestamp(row?.last_run_at),
        status: row?.last_run_status === 'ok' || row?.last_run_status === 'error' ? row.last_run_status : 'unknown',
      }];
    })),
  };
}
