import type { PoolClient } from 'pg';
import type { Principal } from './auth';
import type { CrmAccess } from './crm-live';
import { HttpError } from './errors';
import { numericValue, sanitizeLabel } from './privacy';

type Row = Record<string, unknown>;

export const ACTIVE_STAGES = [
  'NEW_LEAD', 'RFQ_RECEIVED', 'PROPOSAL_SHARED', 'FOLLOW_UP', 'SITE_VISIT',
  'NEGOTIATION', 'AGREEMENT_WORK', 'MONEY_COLLECTION',
] as const;
const ALL_STAGES = [...ACTIVE_STAGES, 'RFQ_NOT_RELEVANT', 'DEAL_LOST', 'DEAL_CLOSED', 'DEAL_ON_HOLD'];
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

export { searchWarehouses, getWarehouse, getWarehouseFilterOptions } from './warehouse-data';

const OPPORTUNITY_FIELDS = [
  'opportunity_id', 'name', 'stage', 'priority', 'city', 'company_name',
  'last_contacted', 'next_follow_up', 'last_meaningful_update_at',
  'last_meaningful_update_kind', 'stage_entered_at', 'twenty_updated_at',
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

export function validateCrmQuery(query: URLSearchParams) {
  validateParameters(query, ['city', 'stage', 'limit', 'cursor', 'view', 'assigned_to']);
  if (query.has('assigned_to') && query.has('view')) invalid('Use view or assigned_to, not both');
  if (query.has('assigned_to') && query.get('assigned_to') !== 'me') invalid('assigned_to only supports me');
  const view = query.has('assigned_to') ? 'assigned' : query.get('view') ?? 'accessible';
  if (!['accessible', 'created', 'assigned'].includes(view)) invalid('view must be accessible, created, or assigned');
  const city = textParameter(query, 'city');
  const stage = query.get('stage');
  if (stage !== null && !ALL_STAGES.includes(stage)) invalid('Unknown CRM stage');
  const cursor = query.get('cursor');
  if (cursor !== null && !UUID.test(cursor)) invalid('CRM cursor must be a UUID');
  const limit = integerParameter(query, 'limit', 25, 10)!;
  return { view: view as CrmView, city, stage, cursor: cursor?.toLowerCase() ?? null, limit };
}

export async function searchOpportunities(client: PoolClient, principal: Principal, query: URLSearchParams, access: CrmAccess) {
  const { city, stage, cursor, limit } = validateCrmQuery(query);
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = [crmScope(principal, access, bind)];
  if (city) where.push(`lower(o.city) = lower(${bind(city)})`);
  if (stage) where.push(`o.stage = ${bind(stage)}`);
  if (cursor) where.push(`o.opportunity_id > ${bind(cursor.toLowerCase())}`);
  const result = await client.query<Row>(`SELECT ${OPPORTUNITY_COLUMNS}
    FROM public.opportunities o WHERE ${where.join(' AND ')}
    ORDER BY o.opportunity_id ASC LIMIT ${bind(limit + 1)}`, values);
  const selected = result.rows.slice(0, limit);
  return {
    items: selected.map(opportunity),
    nextCursor: result.rows.length > limit ? String(selected[selected.length - 1].opportunity_id) : null,
  };
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
