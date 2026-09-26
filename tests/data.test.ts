import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { buildPagination } from '../src/lib/query-pagination';
import {
  ACTIVE_STAGES, getFreshness, getMyBriefing, getOpportunity, getWarehouse,
  searchOpportunities, searchWarehouses, validateCrmQuery,
} from '../src/lib/data';

const principal: Principal = {
  employeeId: 12, email: 'Alex@example.test', scopes: ['warehouses:read', 'crm:read'], keyId: 'test-key',
  twentyUserId: '10000000-0000-4000-8000-000000000001',
};
const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const related = (ids: string[] = [ID_1, ID_2]): CrmAccess => ({ mode: 'related', memberId: principal.twentyUserId!, ids });
const all: CrmAccess = { mode: 'all', memberId: principal.twentyUserId! };

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as PoolClient, query };
}

function queryCursor(query: URLSearchParams, id: number | string) {
  const warehouse = typeof id === 'number';
  return buildPagination(query, { idColumn: warehouse ? 'w.id' : 'o.opportunity_id', idType: warehouse ? 'integer' : 'uuid', sortColumns: {},
    filterContext: { start_at: null, end_before: null, ...(!warehouse ? { follow_up: null } : {}) },
  }, () => '$unused').cursorFor({ id });
}

function warehouseRow(id: number) {
  return {
    id, city: 'Bengaluru', state: 'Karnataka', zone: 'North', warehouse_type: 'Industrial',
    total_space_sqft: [40000], offered_space_sqft: '40000', asking_rate_per_sqft: '25',
    dock_count: '4', clear_height_ft: '35', verified: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function opportunityRow(id: string = ID_1) {
  return {
    opportunity_id: id, name: 'Bengaluru 40,000 sqft', stage: 'RFQ_RECEIVED',
    priority: 'RATING_3', city: 'Bengaluru', company_name: 'Example Logistics',
    requirement_sqft: '40000', micro_market: 'North',
    last_polled_at: new Date('2026-09-24T08:30:00Z'),
  };
}

describe('warehouse reads', () => {
  it('queries visible inventory with bound filters and a single matching area', async () => {
    const { client, query } = database([warehouseRow(1)]);
    const parameters = new URLSearchParams({
      city: 'Bengaluru', state: 'Karnataka', type: 'Industrial',
      area_min_sqft: '30000', area_max_sqft: '50000', max_rate: '25', limit: '25',
    });
    parameters.set('cursor', queryCursor(parameters, 8));
    const output = await searchWarehouses(client, parameters);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('w.visibility IS TRUE');
    expect(sql).toContain('unnest(w."totalSpaceSqft")');
    expect(sql).toContain('area_sqft >=');
    expect(sql).toContain('area_sqft <=');
    expect(sql).toContain('ORDER BY w.id ASC');
    expect(sql).not.toContain('Bengaluru');
    expect(sql).not.toMatch(/contactNumber|alt_phone_number|photos|negotiated_rent|scoutNotes/);
    expect(values).toEqual(['Bengaluru', 'Karnataka', 'Industrial', 30000, 50000, 25, 8, 26]);
    expect(output.items[0]).toMatchObject({ id: 1, total_space_sqft: [40000], asking_rate_per_sqft: 25 });
    expect(output.nextCursor).toBeNull();
  });

  it('uses a lookahead row without exposing it or skipping the next record', async () => {
    const { client, query } = database([warehouseRow(4), warehouseRow(9), warehouseRow(15)]);
    const output = await searchWarehouses(client, new URLSearchParams('limit=2'));
    expect(output.items.map((item) => item.id)).toEqual([4, 9]);
    expect(output.nextCursor).toBeTruthy();
    expect(output.nextCursor).not.toBe('9');
    await searchWarehouses(client, new URLSearchParams({ limit: '2', cursor: output.nextCursor! }));
    expect(query.mock.calls[1][1]).toEqual([9, 3]);
  });

  it('strips contacts, unknown fields, malformed measurements, and oversized phone-like numbers', async () => {
    const { client } = database([{
      ...warehouseRow(4),
      contactNumber: '+91 9876543210', alt_phone_number: '9876543211', address: 'Private address',
      company: { phone: '9876543210' }, media: ['https://private.example/file'],
      city: 'Bengaluru +91 9876543210',
      total_space_sqft: [40000, 9876543210],
      asking_rate_per_sqft: '20-25', offered_space_sqft: '40000 or 50000', dock_count: '9876543210',
    }]);
    const output = await getWarehouse(client, 4);
    expect(output).toMatchObject({
      id: 4, total_space_sqft: [40000], asking_rate_per_sqft: null, offered_space_sqft: null, dock_count: null,
    });
    expect(JSON.stringify(output)).not.toMatch(/987654321|Private address|private\.example/);
    expect(output).not.toHaveProperty('contactNumber');
    expect(output).not.toHaveProperty('company');
  });

  it('applies visibility and bound identifiers to detail reads', async () => {
    const { client, query } = database();
    expect(await getWarehouse(client, 123)).toBeNull();
    expect(query.mock.calls[0][0]).toContain('w.visibility IS TRUE AND w.id = $1');
    expect(query.mock.calls[0][1]).toEqual([123]);
  });

  it.each([
    ['2026-09-25', '2026-09-25'],
    ['2028-02-29', '2028-02-29'],
    ['2026-02-29', null],
    ['2026-02-30', null],
    ['2026-09-25T00:00:00+05:30', null],
    [new Date('2026-09-25T00:00:00+05:30'), null],
  ])('preserves date-only handovers without timezone conversion: %s', async (stored, expected) => {
    const { client, query } = database([{ ...warehouseRow(4), handover_date: stored }]);
    const output = await getWarehouse(client, 4);
    expect(query.mock.calls[0][0]).toContain('w."handoverDate"::text AS handover_date');
    expect(output?.handover_date).toBe(expected);
  });

  it.each([
    'q=9876543210', 'phone=9876543210', 'visibility=hidden', 'city=A&city=B',
    'limit=26', 'limit=0', 'limit=1.5', 'cursor=1e3', 'cursor=-1', 'cursor=2147483648',
    'area_min_sqft=50000&area_max_sqft=30000', 'max_rate=20-25',
    'max_rate=NaN', 'max_rate=Infinity', 'max_rate=1e3', 'city=', 'city=A%0AB',
  ])('rejects invalid query %s before accessing the database', async (parameters) => {
    const { client, query } = database();
    await expect(searchWarehouses(client, new URLSearchParams(parameters))).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('employee-scoped CRM reads', () => {
  it('returns core and business fields from one scoped row read in list, detail and briefing', async () => {
    const row = { ...opportunityRow(), lead_source: 'WEBSITE_SEO', lease_duration: 'SHORT_TERM',
      industry_verticals: ['FMCG'], occupancy_timelines: ['WITHIN_30_DAYS'], preferred_languages: ['ENGLISH'], repeat_client: ['OPTION1'],
      budget: 'INR 20-25 per sqft per month', amount_micros: '123456789', amount_currency: 'INR', recorded_follow_up_count: '0',
      twenty_updated_at: '2026-09-26T12:00:00Z', last_note_at: '2026-09-26T11:00:00Z', last_task_at: null,
      data: { description: 'Private raw content', pocPhoneNumber: '9876543210' }, last_note_text: 'private@example.test' };
    const list = database([row]); const detail = database([row]);
    const briefing = database([{ priorities: [row] }]);
    const listed = (await searchOpportunities(list.client, principal, new URLSearchParams(), related())).items[0];
    const read = await getOpportunity(detail.client, principal, ID_1, related());
    const priority = (await getMyBriefing(briefing.client, principal, related())).priorities[0];
    expect(read).toMatchObject(listed);
    expect(listed).not.toHaveProperty('description');
    expect(read?.description.state).toBe('missing');
    expect(priority).toMatchObject(listed);
    expect(listed).toMatchObject({ lead_source: 'WEBSITE_SEO', lease_duration: 'SHORT_TERM', industry_verticals: ['FMCG'],
      repeat_client: true, recorded_follow_up_count: 0, source_updated_at: '2026-09-26T12:00:00.000Z', last_note_at: '2026-09-26T11:00:00.000Z',
      last_task_at: null, budget: { kind: 'range', min: 20, max: 25, currency: 'INR', period: 'month', area_basis: 'sqft', verification_required: true },
      recorded_value: { amount_micros: '123456789', amount: '123.456789', currency_code: 'INR', verification_required: true } });
    for (const db of [list, detail, briefing]) {
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls[0][0]).not.toMatch(/JOIN|last_note_text|pocPhone|SELECT\s+o\.data\s*[,\s]/);
    }
    expect(JSON.stringify(listed)).not.toMatch(/Private raw|9876543210|private@example/);
  });

  it('returns masked detail narratives and recorded ownership without disclosing raw contacts', async () => {
    const db = database([{ ...opportunityRow(), description: 'Needs 40,000-60,000 sqft. Call +91 98765 43210 or owner@example.test.',
      loss_reason: 'Rate too high; buyer ९८७६५४३२१०', assigned_to: ['ALEX'], supply_owners: ['Sam +91 9876543210'],
      owner_workspace_member_id: principal.twentyUserId, creator_id: principal.twentyUserId, creator_name: 'Alex', creator_source: 'MANUAL',
      close_date: '2026-10-01T00:00:00Z' }]);
    const result = await getOpportunity(db.client, principal, ID_1, related());
    expect(result).toMatchObject({ description: { state: 'redacted', redacted: true }, loss_reason: { state: 'redacted' },
      close_date: '2026-10-01T00:00:00.000Z', ownership: { assigned_to: { values: ['ALEX'] }, supply_owners: { state: 'redacted' }, created_by: { name: { text: 'Alex' } } } });
    expect(result?.description.text).toContain('40,000-60,000 sqft');
    expect(JSON.stringify(result)).not.toMatch(/98765|९८७६५|owner@example/);
  });

  it('distinguishes missing, malformed and redacted source values and flags uncertain fields', async () => {
    const db = database([{ ...opportunityRow(), close_date: 'sometime next month', city: 'Bengaluru +91 9876543210',
      requirement_sqft: '40-60k sqft', budget: 'Market rate', lead_source: 'PARTNER_EVENT', micro_market: null }]);
    const result = await getOpportunity(db.client, principal, ID_1, related());
    expect(result).toMatchObject({ requirement_sqft: null, city: null, close_date: null, verification_required: true,
      field_evidence: { close_date: { state: 'unsupported', source: { text: 'sometime next month' } },
        city: { state: 'unsupported', source: { redacted: true } }, micro_market: { state: 'missing', source: null },
        lead_source: { state: 'unsupported', source: { text: 'PARTNER_EVENT' } },
        requirement_sqft: { state: 'parsed', kind: 'range', min: 40000, max: 60000 }, budget: { state: 'unsupported', source: { text: 'Market rate' } } } });
    expect(JSON.stringify(result)).not.toContain('9876543210');
  });

  it('does not reuse stale business metadata when a subsequent lead read observes a change', async () => {
    const db = database();
    db.query.mockResolvedValueOnce({ rows: [{ ...opportunityRow(), lease_duration: 'LONG_TERM', twenty_updated_at: '2026-09-26T10:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ ...opportunityRow(), lease_duration: 'SHORT_TERM', twenty_updated_at: '2026-09-26T11:00:00Z' }] });
    expect((await getOpportunity(db.client, principal, ID_1, related()))).toMatchObject({ lease_duration: 'LONG_TERM', source_updated_at: '2026-09-26T10:00:00.000Z' });
    expect((await getOpportunity(db.client, principal, ID_1, related()))).toMatchObject({ lease_duration: 'SHORT_TERM', source_updated_at: '2026-09-26T11:00:00.000Z' });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('reports independently stale activity even when opportunity sync is healthy', async () => {
    const started = '2026-09-26T12:00:00Z';
    const db = database([
      { object: 'opportunities', last_run_status: 'ok', last_run_at: started, transaction_started_at: started },
      { object: 'notes', last_run_status: 'ok', last_run_at: '2026-09-26T11:29:59Z', transaction_started_at: started },
      { object: 'tasks', last_run_status: 'error', last_run_at: started, transaction_started_at: started },
    ]);
    const result = await getFreshness(db.client);
    expect(result.read_consistency).toEqual({ database_snapshot: 'repeatable_read', transaction_started_at: '2026-09-26T12:00:00.000Z',
      lead_fields: 'same_row', cross_request_snapshot: false });
    expect(result.activity_status).toEqual({ status: 'degraded', unavailable_streams: ['notes', 'tasks'] });
    expect(result.source_status.opportunities.status).toBe('ok');
    expect(result.source_status.notes.status).toBe('ok');
  });

  it('uses successful poll times, not old changed-record watermarks, for activity freshness', async () => {
    const db = database(['opportunities', 'notes', 'tasks'].map(object => ({ object, last_run_status: 'ok',
      last_run_at: '2026-09-26T12:00:00Z', last_updated_at: '2026-06-01T00:00:00Z', transaction_started_at: '2026-09-26T12:00:01Z' })));
    const result = await getFreshness(db.client);
    expect(result.activity_status).toEqual({ status: 'current', unavailable_streams: [] });
    expect(result.source_status.notes.source_watermark_at).toBe('2026-06-01T00:00:00.000Z');
    expect(result.field_semantics).toContain('independent');
  });

  it('uses the live created-or-assigned union before filters and pagination without stale assignment restrictions', async () => {
    const { client, query } = database([opportunityRow(ID_1), opportunityRow(ID_2)]);
    const parameters = new URLSearchParams({ city: 'Bengaluru', stage: 'RFQ_RECEIVED', view: 'accessible', limit: '1' });
    const cursor = queryCursor(parameters, ID_1);
    parameters.set('cursor', cursor);
    const output = await searchOpportunities(client, principal, parameters, related());
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('o.deleted_at IS NULL');
    expect(sql).toContain('o.opportunity_id = ANY($1::text[])');
    expect(sql).not.toMatch(/LIKE|assignee_email|owner_id|last_note_text|SELECT\s+o\.data\b/);
    expect(sql).toContain('ORDER BY o.opportunity_id ASC');
    expect(values).toEqual([[ID_1, ID_2], 'Bengaluru', 'RFQ_RECEIVED', ID_1, 2]);
    expect(output.items).toHaveLength(1);
    expect(output.nextCursor).toBe(cursor);
  });

  it('uses the same live access boundary on detail and does not expose source JSON', async () => {
    const { client, query } = database([{
      ...opportunityRow(),
      data: { pocPhoneNumber: { primaryPhoneNumber: '9876543210' } },
      name: 'Requirement 9876543210',
      last_note_text: 'Call 9876543210', assignee_email: 'private@example.com',
      owner_id: 'other-owner',
    }]);
    const output = await getOpportunity(client, principal, ID_1, related());
    expect(query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($2::text[])');
    expect(query.mock.calls[0][0]).toContain('o.opportunity_id = $1');
    expect(query.mock.calls[0][1]).toEqual([ID_1, [ID_1, ID_2]]);
    expect(output).toMatchObject({ id: ID_1, requirement_sqft: 40000, priority_stars: 3 });
    expect(JSON.stringify(output)).not.toMatch(/9876543210|private@example|other-owner/);
    expect(output).not.toHaveProperty('data');
    expect(output).not.toHaveProperty('last_note_text');
    expect(output).not.toHaveProperty('assignee_email');
  });

  it('returns no record for an invisible or unrelated detail result', async () => {
    const { client } = database();
    expect(await getOpportunity(client, principal, ID_1, related([]))).toBeNull();
  });

  it('binds fresh permissions for each read, including a revoked assignment with no remaining created access', async () => {
    const listing = database();
    await searchOpportunities(listing.client, principal, new URLSearchParams(), related([ID_1]));
    expect(listing.query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($1::text[])');
    expect(listing.query.mock.calls[0][1]).toEqual([[ID_1], 11]);
    const detail = database();
    await getOpportunity(detail.client, principal, ID_1, related([]));
    expect(detail.query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($2::text[])');
    expect(detail.query.mock.calls[0][1]).toEqual([ID_1, []]);
  });

  it('deduplicates valid live IDs before binding them', async () => {
    const { client, query } = database();
    await searchOpportunities(client, principal, new URLSearchParams(), related([ID_1, ID_1, ID_2]));
    expect(query.mock.calls[0][1]).toEqual([[ID_1, ID_2], 11]);
  });

  it('uses all live Twenty admin records without an employee or stale mirror assignment restriction', async () => {
    const listing = database([opportunityRow()]);
    await searchOpportunities(listing.client, principal, new URLSearchParams('city=Bengaluru'), all);
    expect(listing.query.mock.calls[0][0]).toContain('o.deleted_at IS NULL');
    expect(listing.query.mock.calls[0][0]).not.toMatch(/ANY\(|assignee_email|owner_id/);
    expect(listing.query.mock.calls[0][1]).toEqual(['Bengaluru', 11]);
    const detail = database([opportunityRow()]);
    await getOpportunity(detail.client, principal, ID_1, all);
    expect(detail.query.mock.calls[0][0]).not.toMatch(/ANY\(|assignee_email|owner_id/);
    expect(detail.query.mock.calls[0][1]).toEqual([ID_1]);
  });

  it('does not infer all-record access from an unrelated dashboard admin flag', async () => {
    const { client, query } = database();
    const dashboardAdmin = { ...principal, adminAccess: true };
    await searchOpportunities(client, dashboardAdmin, new URLSearchParams(), related([]));
    expect(query.mock.calls[0][0]).toContain('o.opportunity_id = ANY($1::text[])');
    expect(query.mock.calls[0][1]).toEqual([[], 11]);
  });

  it.each([
    undefined, null, {},
    { mode: 'unknown', memberId: principal.twentyUserId },
    { mode: 'all', memberId: ID_2 },
    { mode: 'all', memberId: 'invalid' },
    { mode: 'related', memberId: principal.twentyUserId },
    { mode: 'related', memberId: principal.twentyUserId, ids: ['not-a-uuid'] },
    { mode: 'related', memberId: principal.twentyUserId, ids: Array(1001).fill(ID_1) },
  ])('fails closed on missing, mismatched, malformed, or incomplete access', async (access) => {
    const { client, query } = database();
    await expect(searchOpportunities(client, principal, new URLSearchParams(), access as CrmAccess)).rejects.toMatchObject({ status: 503 });
    await expect(getOpportunity(client, principal, ID_1, access as CrmAccess)).rejects.toMatchObject({ status: 503 });
    await expect(getMyBriefing(client, principal, access as CrmAccess)).rejects.toMatchObject({ status: 503 });
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed if the employee loses their linked Twenty identity', async () => {
    const { client, query } = database();
    await expect(searchOpportunities(client, { ...principal, twentyUserId: null }, new URLSearchParams(), all))
      .rejects.toMatchObject({ status: 503 });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps accepted quote-containing filter text in bind parameters', async () => {
    const { client, query } = database();
    const city = "Bengaluru' OR '1'='1";
    // Equals signs are rejected; a SQL-like but syntactically valid label is still bound.
    await expect(searchOpportunities(client, principal, new URLSearchParams({ city }), related()))
      .rejects.toMatchObject({ status: 400 });
    const permitted = "Bengaluru' OR 'anything' --";
    await searchOpportunities(client, principal, new URLSearchParams({ city: permitted }), related());
    expect(query.mock.calls[0][0]).not.toContain(permitted);
    expect(query.mock.calls[0][1]).toContain(permitted);
  });

  it.each([
    'assigned_to=all', 'assigned_to=someone@wareongo.com', 'assigned_to=me&assigned_to=all',
    'email=someone@wareongo.com', 'owner_id=someone', 'stage=UNKNOWN',
    'cursor=not-a-uuid', 'limit=100', 'city=A&city=B',
    'view=all', 'view=created&assigned_to=me', 'view=assigned&view=accessible',
  ])('rejects unsupported access/filter query %s', async (parameters) => {
    const { client, query } = database();
    await expect(searchOpportunities(client, principal, new URLSearchParams(parameters), related())).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('CRM view selection', () => {
  it.each([
    ['', 'accessible'], ['view=accessible', 'accessible'], ['view=created', 'created'],
    ['view=assigned', 'assigned'], ['assigned_to=me', 'assigned'],
  ])('normalizes %s to the upstream view %s', (query, view) => {
    expect(validateCrmQuery(new URLSearchParams(query))).toMatchObject({ view, limit: 10 });
  });
});

describe('briefing and freshness', () => {
  it('counts all authorized active deals while limiting only the priority list', async () => {
    const { client, query } = database([{
      total_active: 100,
      counts_by_stage: { RFQ_RECEIVED: 80, NEGOTIATION: 20, secret: 1 },
      counts_by_sla: { unknown: 80, not_tracked: 20 },
      follow_up_overdue: 4,
      priorities: [{ ...opportunityRow(), sla: 'unknown', days_in_stage: null, last_note_text: 'Private note' }],
    }]);
    const output = await getMyBriefing(client, principal, related());
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('o.opportunity_id = ANY($3::text[])');
    expect(sql).toContain('o.stage = ANY($2::text[])');
    expect(values[1]).toEqual([...ACTIVE_STAGES]);
    expect(values[2]).toEqual([ID_1, ID_2]);
    expect(sql.match(/LIMIT 20/g)).toHaveLength(1);
    expect(sql).toContain("WHEN stage_entered_at IS NULL THEN 'unknown'");
    expect(sql).toContain("WHEN days_in_stage <= 3 THEN 'green' WHEN days_in_stage <= 5 THEN 'yellow'");
    expect(sql).toContain("AT TIME ZONE 'Asia/Kolkata'");
    expect(sql).toContain('jsonb_agg(to_jsonb(prioritized) ORDER BY CASE prioritized.sla');
    expect(sql).toContain('ORDER BY CASE scored.sla');
    expect(output.total_active).toBe(100);
    expect(output.counts_by_stage).not.toHaveProperty('secret');
    expect(output.counts_by_sla).toMatchObject({ unknown: 80, not_tracked: 20 });
    expect(output.priorities[0]).toMatchObject({ sla: 'unknown', days_in_stage: null });
    expect(output.priorities[0]).not.toHaveProperty('last_note_text');
  });

  it('reports failed and absent sync streams without exposing error contents or claiming success', async () => {
    const { client, query } = database([{
      object: 'opportunities', last_run_status: 'error',
      last_run_at: new Date('2026-09-25T02:00:00Z'),
      last_updated_at: new Date('2026-09-24T00:00:00Z'),
      last_error: 'Secret contact data and upstream credentials',
    }]);
    const output = await getFreshness(client);
    expect(query.mock.calls[0][0]).not.toContain('last_error');
    expect(output.source_status.opportunities).toEqual({
      source_watermark_at: '2026-09-24T00:00:00.000Z', last_run_at: '2026-09-25T02:00:00.000Z', status: 'error',
    });
    expect(output.source_status.notes).toEqual({ source_watermark_at: null, last_run_at: null, status: 'unknown' });
    expect(JSON.stringify(output)).not.toMatch(/credentials|last_success/);
  });

  it('applies live permission intersection before all briefing aggregates and priorities', async () => {
    const { client, query } = database();
    await getMyBriefing(client, principal, related());
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('o.opportunity_id = ANY($3::text[])');
    expect(sql.indexOf('o.opportunity_id = ANY($3::text[])')).toBeLessThan(sql.indexOf('scored AS'));
    expect(values[2]).toEqual([ID_1, ID_2]);
    expect(sql).not.toMatch(/assignee_email|owner_id/);
  });

  it('aggregates all nondeleted active leads for verified Twenty admin access', async () => {
    const { client, query } = database();
    await getMyBriefing(client, principal, all);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('WHERE o.deleted_at IS NULL AND o.stage = ANY($2::text[])');
    expect(sql).not.toContain('o.opportunity_id = ANY(');
    expect(sql).not.toMatch(/assignee_email|owner_id/);
    expect(values).toHaveLength(2);
  });
});
