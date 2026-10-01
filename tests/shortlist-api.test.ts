import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import type { CrmAccess, CrmView } from '../src/lib/crm-live';
import { HttpError } from '../src/lib/errors';
import { shortlistAssessmentOutput } from '../src/lib/shortlist-assessment';

const leadId = '12345678-1234-4234-8234-123456789012';
const memberId = '12345678-1111-4111-8111-123456789012';
const route = `crm/opportunities/${leadId}/assessment`;
const path = ['crm', 'opportunities', leadId, 'assessment'];
const active = { id: 7, email: 'alex@example.test', is_active: true, dashboardAccess: true, adminAccess: false, analystAccess: false, twenty_user_id: memberId };
type Row = Record<string, unknown>;
type Roster = typeof active;

function warehouseRow(id: number): Row {
  return { id, city: 'Bengaluru', state: 'Karnataka', total_space_sqft: [40_000], micromarkets: ['Hoskote'],
    warehouse_type: 'PEB', availability: 'Available', dock_count: '4', clear_height_ft: '30', power_kva: '100',
    created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-27T10:00:00.000Z' };
}

function harness(options: {
  scopes?: KeyRegistration['scopes'];
  initialRoster?: Partial<Roster>;
  finalRoster?: Partial<Roster>;
  stale?: 'initial' | 'final';
  lead?: Row;
  warehouses?: Row[];
  access?: CrmAccess;
} = {}) {
  const key: KeyRegistration = { employeeId: active.id, id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: active.email,
    scopes: options.scopes ?? ['crm:read', 'warehouses:read'], expiresAt: '2099-01-01T00:00:00.000Z' };
  const initialAt = new Date(Date.now() - 120_000).toISOString();
  const finalAt = new Date(Date.now() - 10_000).toISOString();
  const lead: Row = { opportunity_id: leadId, name: 'Synthetic requirement', company_name: 'Synthetic company',
    city: 'Bangalore', requirement_sqft: '40k sqft', micro_market: 'Hoskote', stage: 'RFQ_RECEIVED',
    twenty_created_at: '2026-09-20T09:00:00.000Z', twenty_updated_at: finalAt, last_polled_at: finalAt,
    ...options.lead };
  const state = { transactionNumber: 0, insideTransaction: false, liveComplete: false,
    events: [] as string[], reads: [] as { transaction: number; sql: string; values?: unknown[] }[] };
  const access: CrmAccess = options.access ?? { mode: 'related', memberId, ids: [leadId] };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    expect(state.insideTransaction).toBe(true);
    state.reads.push({ transaction: state.transactionNumber, sql, values });
    if (sql.includes('"VerifiedNumber"')) return { rows: [{ ...active, ...options.initialRoster,
      ...(state.liveComplete ? options.finalRoster : {}) }] };
    if (sql.includes('sync_checkpoints')) {
      const stale = options.stale === (state.liveComplete ? 'final' : 'initial');
      const at = state.liveComplete ? finalAt : initialAt;
      return { rows: ['opportunities', 'notes', 'tasks'].map(object => ({ object,
        last_run_at: stale ? '2000-01-01T00:00:00.000Z' : at,
        last_updated_at: at, last_run_status: 'ok', transaction_started_at: at })) };
    }
    if (sql.includes('FROM public.opportunities')) {
      expect(state.liveComplete).toBe(true);
      const permittedIds = values?.[1];
      return { rows: Array.isArray(permittedIds) && !permittedIds.includes(leadId) ? [] : [lead] };
    }
    if (sql.includes('FROM public."Warehouse"')) {
      expect(state.liveComplete).toBe(true);
      const requested = values?.[0];
      const rows = options.warehouses ?? [warehouseRow(12)];
      return { rows: rows.filter(row => Array.isArray(requested) && requested.includes(row.id)) };
    }
    throw new Error('Unexpected source read in assessment harness.');
  });
  const clients: PoolClient[] = [];
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    expect(state.insideTransaction).toBe(false);
    const number = ++state.transactionNumber;
    state.events.push(`begin:${number}`);
    state.insideTransaction = true;
    const client = { query } as unknown as PoolClient;
    clients.push(client);
    try { return await work(client); }
    finally { state.insideTransaction = false; state.events.push(`release:${number}`); }
  };
  const liveCrmAccess = vi.fn(async (_principal: Principal, _view: CrmView, _id?: string): Promise<CrmAccess> => {
    expect(state.insideTransaction).toBe(false);
    state.events.push('live-access');
    state.liveComplete = true;
    return access;
  });
  const relatedCrmContext = vi.fn(async () => { throw new Error('Assessment must not fetch live related records.'); });
  const revalidateKey = vi.fn(async (_client: PoolClient, _key: KeyRegistration) => {});
  const audit = vi.fn();
  const deps = { transaction, authenticate: vi.fn(() => key), liveCrmAccess, relatedCrmContext, revalidateKey, audit };
  return { deps, query, key, state, clients, initialAt, finalAt, lead, liveCrmAccess, revalidateKey, audit };
}

function request(params = '', init?: RequestInit) {
  return new Request(`https://context.example.com/api/v1/${route}${params ? `?${params}` : ''}`, init);
}

function businessReads(h: ReturnType<typeof harness>) {
  return h.state.reads.filter(read => read.sql.includes('FROM public.opportunities') || read.sql.includes('FROM public."Warehouse"'));
}

describe('shortlist assessment REST authorization and consistency', () => {
  it('allows a CRM-only employee to inspect requirements without any warehouse read', async () => {
    const h = harness({ scopes: ['crm:read'], initialRoster: { dashboardAccess: false } });
    const result = await handleApiRequest(request(), path, h.deps);
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.data).toMatchObject({ access_scope: 'created_or_assigned',
      lead: { id: leadId, source_updated_at: h.finalAt, last_polled_at: h.finalAt }, candidates: [],
      source_status: { opportunities: { status: 'ok', last_run_at: h.finalAt } },
      read_consistency: { database_snapshot: 'repeatable_read', transaction_started_at: h.finalAt, lead_fields: 'same_row', cross_request_snapshot: false } });
    expect(shortlistAssessmentOutput.safeParse(body.data).success).toBe(true);
    expect(body.data.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'area_sqft', source: 'crm_record' }),
      expect.objectContaining({ field: 'dock_count', status: 'missing', source: 'not_recorded', follow_up_question: expect.any(String) }),
    ]));
    expect(h.query.mock.calls.every(([sql]) => !sql.includes('FROM public."Warehouse"'))).toBe(true);
    expect(h.liveCrmAccess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ employeeId: 7 }), 'accessible', leadId);
    expect(h.deps.relatedCrmContext).not.toHaveBeenCalled();
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'crm/assessment', status: 200 }));
  });

  it.each([
    { scopes: ['crm:read'] as KeyRegistration['scopes'], roster: {}, params: 'warehouse_ids=12' },
    { scopes: ['crm:read', 'warehouses:read'] as KeyRegistration['scopes'], roster: { dashboardAccess: false }, params: 'warehouse_ids=12' },
    { scopes: ['warehouses:read'] as KeyRegistration['scopes'], roster: {}, params: '' },
  ])('checks current required scopes before upstream authorization and business reads: $scopes / $params', async ({ scopes, roster, params }) => {
    const h = harness({ scopes, initialRoster: roster });
    const result = await handleApiRequest(request(params), path, h.deps);
    expect(result.status).toBe(403);
    expect(h.liveCrmAccess).not.toHaveBeenCalled();
    expect(businessReads(h)).toHaveLength(0);
  });

  it('releases the preliminary client before live authorization and reads every result from the final snapshot', async () => {
    const h = harness();
    const result = await handleApiRequest(request('warehouse_ids=12&docks_min=4'), path, h.deps);
    expect(result.status).toBe(200);
    expect(h.state.events).toEqual(['begin:1', 'release:1', 'live-access', 'begin:2', 'release:2']);
    expect(h.clients).toHaveLength(2);
    expect(h.clients[0]).not.toBe(h.clients[1]);
    expect(h.revalidateKey).toHaveBeenNthCalledWith(2, h.clients[1], h.key);
    expect(businessReads(h)).toHaveLength(2);
    expect(businessReads(h).every(read => read.transaction === 2)).toBe(true);
    const body = await result.json();
    expect(body.data.read_consistency.transaction_started_at).toBe(h.finalAt);
    expect(body.data.source_status.opportunities.last_run_at).toBe(h.finalAt);
    expect(body.data.lead.source_updated_at).toBe(h.finalAt);
    expect(body.data.candidates[0]).toMatchObject({ id: 12, source_path: '/api/v1/warehouses/12',
      source_updated_at: '2026-09-27T10:00:00.000Z', verification_required: true });
    expect(body.data.candidates[0].checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'dock_count', state: 'meets_recorded_requirement', requirement: 4 }),
    ]));
    expect(shortlistAssessmentOutput.safeParse(body.data).success).toBe(true);
    expect(JSON.stringify(body.data)).not.toContain(h.initialAt);
    expect(JSON.stringify(body.data)).toContain(h.finalAt);
    expect(JSON.stringify(body.data)).toContain('2026-09-27T10:00:00.000Z');
  });

  it('uses target-specific live access and returns no lead or inventory data for a denied lead', async () => {
    const h = harness({ access: { mode: 'related', memberId, ids: [] } });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(404);
    expect(h.liveCrmAccess).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'accessible', leadId);
    const leadRead = h.query.mock.calls.find(([sql]) => sql.includes('FROM public.opportunities'));
    expect(leadRead?.[0]).toContain('ANY(');
    expect(leadRead?.[1]).toEqual([leadId, []]);
    expect(h.query.mock.calls.every(([sql]) => !sql.includes('FROM public."Warehouse"'))).toBe(true);
    const body = await result.json();
    expect(body).not.toHaveProperty('data');
    expect(JSON.stringify(body)).not.toContain('Synthetic requirement');
  });

  it('does not promote a dashboard admin into Twenty-wide access', async () => {
    const h = harness({ initialRoster: { adminAccess: true }, access: { mode: 'related', memberId, ids: [] } });
    const result = await handleApiRequest(request(), path, h.deps);
    expect(result.status).toBe(404);
    expect(businessReads(h)[0]?.values).toEqual([leadId, []]);
  });

  it('preserves all access when the current employee is an Analyst', async () => {
    const h = harness({ initialRoster: { analystAccess: true }, access: { mode: 'all', memberId } });
    const result = await handleApiRequest(request(), path, h.deps);
    expect(result.status).toBe(200);
    expect((await result.json()).data.access_scope).toBe('all');
  });

  it('withholds an in-flight Analyst assessment after permission removal', async () => {
    const h = harness({ initialRoster: { analystAccess: true }, finalRoster: { analystAccess: false }, access: { mode: 'all', memberId } });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(403);
    expect(businessReads(h)).toHaveLength(0);
  });
  it.each(['initial', 'final'] as const)('fails closed for a stale %s mirror snapshot', async stale => {
    const h = harness({ stale });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe('CRM_SOURCE_STALE');
    expect(h.liveCrmAccess).toHaveBeenCalledTimes(stale === 'initial' ? 0 : 1);
    expect(businessReads(h)).toHaveLength(0);
  });

  it('returns unavailable when live assignment verification fails, without reading lead or inventory rows', async () => {
    const h = harness();
    h.liveCrmAccess.mockRejectedValueOnce(new HttpError(503, 'CRM_AUTHORIZATION_UNAVAILABLE', 'Current assignment could not be verified.'));
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(503);
    expect(businessReads(h)).toHaveLength(0);
    expect((await result.json()).error.code).toBe('CRM_AUTHORIZATION_UNAVAILABLE');
  });

  it.each([
    { label: 'employee deactivation', roster: { is_active: false } },
    { label: 'employee identity change', roster: { id: 8 } },
    { label: 'Twenty identity change', roster: { twenty_user_id: '22345678-1111-4111-8111-123456789012' } },
    { label: 'CRM permission removal', roster: { twenty_user_id: '' } },
    { label: 'warehouse permission removal', roster: { dashboardAccess: false } },
  ])('rechecks $label after live authorization', async ({ roster }) => {
    const h = harness({ finalRoster: roster });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(403);
    expect(h.liveCrmAccess).toHaveBeenCalledOnce();
    expect(businessReads(h)).toHaveLength(0);
    expect((await result.json())).not.toHaveProperty('data');
  });

  it('rechecks connector revocation on the final client', async () => {
    const h = harness();
    h.revalidateKey.mockImplementation(async () => {
      if (h.state.liveComplete) throw new HttpError(401, 'UNAUTHORIZED', 'Connector revoked.');
    });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(401);
    expect(h.revalidateKey).toHaveBeenCalledTimes(2);
    expect(businessReads(h)).toHaveLength(0);
  });

  it('rechecks an environment key that expires during live authorization', async () => {
    const h = harness();
    const original = h.liveCrmAccess.getMockImplementation()!;
    h.liveCrmAccess.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      h.key.expiresAt = '2000-01-01T00:00:00.000Z';
      return result;
    });
    const result = await handleApiRequest(request('warehouse_ids=12'), path, h.deps);
    expect(result.status).toBe(401);
    expect(businessReads(h)).toHaveLength(0);
  });

  it('fetches five selected warehouses in one bounded visibility-filtered query', async () => {
    const ids = [15, 12, 14, 11, 13];
    const h = harness({ warehouses: [...ids].sort().map(warehouseRow) });
    const result = await handleApiRequest(request(`warehouse_ids=${ids.join(',')}`), path, h.deps);
    expect(result.status).toBe(200);
    const inventoryReads = h.state.reads.filter(read => read.sql.includes('FROM public."Warehouse"'));
    expect(inventoryReads).toHaveLength(1);
    expect(inventoryReads[0]).toMatchObject({ transaction: 2, values: [ids] });
    expect(inventoryReads[0].sql).toContain('w.visibility IS TRUE');
    expect(inventoryReads[0].sql).toContain('w.id = ANY($1::int[])');
    expect(inventoryReads[0].sql).toContain('LIMIT 5');
    const body = await result.json();
    expect(body.data.candidates.map((candidate: { id: number }) => candidate.id)).toEqual(ids);
    expect(shortlistAssessmentOutput.safeParse(body.data).success).toBe(true);
  });

  it('returns a generic failure with no partial shortlist when a selected warehouse is unavailable', async () => {
    const h = harness({ warehouses: [warehouseRow(12)] });
    const result = await handleApiRequest(request('warehouse_ids=12,13'), path, h.deps);
    expect(result.status).toBe(404);
    const body = await result.json();
    expect(body).not.toHaveProperty('data');
    expect(body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(body.error.message).not.toMatch(/\b(?:12|13)\b/);
    expect(JSON.stringify(body)).not.toContain('Hoskote');
    expect(JSON.stringify(body)).not.toContain('Synthetic requirement');
  });

  it('uses the existing allowlisted projectors and excludes private values from results and audit logs', async () => {
    const h = harness({ lead: { description: 'Call 9876543210 or person@example.test at https://private.example.test',
      loss_reason: 'Private contact 9999999999', phone: '9999999999', email: 'person@example.test',
      media: { private: 'private-lead-media' } },
    warehouses: [{ ...warehouseRow(12), contactNumber: '9876543210', alt_phone_number: '9999999999',
      latitude: 12.987654, longitude: 77.123456, negotiated_rent: 19, media: { private: 'private-warehouse-media' } }] });
    const result = await handleApiRequest(request('warehouse_ids=12&docks_min=4'), path, h.deps);
    expect(result.status).toBe(200);
    const wire = await result.text();
    for (const value of ['9876543210', '9999999999', 'person@example.test', 'private.example.test',
      'private-lead-media', 'private-warehouse-media', 'contactNumber', 'alt_phone_number', 'latitude', 'longitude', 'negotiated_rent']) {
      expect(wire).not.toContain(value);
      expect(JSON.stringify(h.audit.mock.calls)).not.toContain(value);
    }
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(active.email);
  });

  it.each([
    'warehouse_ids=', 'warehouse_ids=0', 'warehouse_ids=-1', 'warehouse_ids=12,12', 'warehouse_ids=1,2,3,4,5,6',
    'warehouse_ids=2147483648', 'warehouse_ids=12&warehouse_ids=13', 'warehouse_ids=12%2C%27OR%201%3D1',
    'docks_min=-1', 'docks_min=2.5', 'docks_min=4&docks_min=5', 'phone=9876543210', 'limit=1000',
    'view=all', 'notes=true', 'criteria=%7B%22phone%22%3A%229876543210%22%7D',
    'docks_min=10001', 'area_min_sqft=0', 'area_min_sqft=1000000001', 'area_min_sqft=50000&area_max_sqft=40000',
    'clear_height_min_ft=1001', 'power_min_kva=1000001', 'power_min_kva=1e3',
    'move_in_by=2026-02-30', 'move_in_by=today', 'city=9876543210', 'micromarket=person%40example.test',
  ])('rejects unsafe or unsupported parameters before any source read: %s', async params => {
    const h = harness();
    const result = await handleApiRequest(request(params), path, h.deps);
    expect([400, 422]).toContain(result.status);
    expect(h.state.transactionNumber).toBe(0);
    expect(h.liveCrmAccess).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects malformed lead IDs before source access', async () => {
    const h = harness();
    const invalidPath = ['crm', 'opportunities', 'invalid-id', 'assessment'];
    const result = await handleApiRequest(new Request(`https://context.example.com/api/v1/${invalidPath.join('/')}`), invalidPath, h.deps);
    expect(result.status).toBe(400);
    expect(h.state.transactionNumber).toBe(0);
    expect(h.liveCrmAccess).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('remains read-only for %s', async method => {
    const h = harness();
    const result = await handleApiRequest(request('', { method }), path, h.deps);
    expect(result.status).toBe(405);
    expect(h.deps.authenticate).not.toHaveBeenCalled();
    expect(h.state.transactionNumber).toBe(0);
  });
});
