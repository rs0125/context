import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { handleApiRequest, assertFreshCrm } from '../src/lib/api';
import { authenticateKey, type KeyRegistration } from '../src/lib/auth';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../src/lib/errors';
import type { CrmAccess } from '../src/lib/crm-live';

const active = { id: 7, email: 'alex@example.test', is_active: true, dashboardAccess: true, adminAccess: false, twenty_user_id: '12345678-1111-1111-1111-123456789012' };
function harness(options: { scopes?: KeyRegistration['scopes']; roster?: unknown[]; stale?: boolean } = {}) {
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'alex@example.test',
    scopes: options.scopes ?? ['knowledge:read', 'warehouses:read', 'crm:read'], expiresAt: '2099-01-01T00:00:00.000Z' };
  const query = vi.fn(async (text: string) => {
    if (text.includes('"VerifiedNumber"')) return { rows: options.roster ?? [active] };
    if (text.includes('sync_checkpoints')) return { rows: [{ object: 'opportunities', last_run_at: options.stale ? '2000-01-01T00:00:00Z' : new Date(), last_run_status: 'ok' }] };
    if (text.includes('context_engine_private.knowledge_pages')) return { rows: [{ page_count: 1, pages: [{
      id: 'test-guide', title: 'Synthetic guide', summary: 'Synthetic test summary', updatedAt: '2026-09-25',
      status: 'reviewed', scopes: ['knowledge:read'], body_length: 42,
    }] }] };
    if (/AS total\b/.test(text) && text.includes('public.opportunities')) return { rows: [{ total: 0, groups: [] }] };
    if (/AS total\b/.test(text) && text.includes('"Warehouse"')) return { rows: [{ total: 0, groups: [], groups_truncated: false }] };
    if (text.includes('"Warehouse"')) return { rows: [{ id: 12, city: 'Bengaluru', total_space_sqft: [40000], contactNumber: '9876543210', alt_phone_number: '9999999999', media: { secret: 'private' }, negotiated_rent: '18' }] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const transactionMock = vi.fn(async (work: (db: PoolClient) => Promise<unknown>) => work(client));
  const transaction = async <T>(work: (db: PoolClient) => Promise<T>): Promise<T> => await transactionMock(work) as T;
  return { query, transaction, transactionMock, authenticate: vi.fn(() => key), liveCrmAccess: vi.fn(async (): Promise<CrmAccess> => ({ mode: 'related', memberId: active.twenty_user_id, ids: [] })), audit: vi.fn() };
}
const request = (path: string, init?: RequestInit) => new Request(`https://context.example.com/api/v1/${path}`, init);

describe('REST access boundary', () => {
  it.each(['context', 'context.md'])('keeps %s available independently of a failed knowledge source', async route => {
    const deps = harness();
    const original = deps.query.getMockImplementation()!;
    deps.query.mockImplementation(async sql => {
      if (sql.includes('knowledge_pages')) throw new Error('synthetic knowledge outage');
      return original(sql);
    });
    const result = await handleApiRequest(request(route), [route], deps);
    expect(result.status).toBe(200);
    expect(deps.query.mock.calls.every(([sql]) => !sql.includes('knowledge_pages'))).toBe(true);
    if (route === 'context') {
      const data = (await result.json()).data;
      expect(data).not.toHaveProperty('knowledge');
      expect(data.knowledge_discovery).toMatchObject({ permitted: true, status: 'not_checked' });
      expect(data.server_clock).toHaveProperty('local_date');
    }
  });
  it('paginates knowledge independently and applies scope before querying pages', async () => {
    const deps = harness();
    deps.query.mockImplementation(async sql => sql.includes('VerifiedNumber') ? { rows: [active] } : { rows: [] });
    const result = await handleApiRequest(request('wiki/pages?limit=2'), ['wiki', 'pages'], deps);
    expect(result.status).toBe(200);
    expect((await result.json()).data).toEqual({ items: [], nextCursor: null });
    const denied = harness({ scopes: ['warehouses:read'] });
    expect((await handleApiRequest(request('wiki/pages'), ['wiki', 'pages'], denied)).status).toBe(403);
    expect(denied.query.mock.calls.every(([sql]) => !sql.includes('knowledge_pages'))).toBe(true);
    expect((await handleApiRequest(request('wiki/pages?cursor=old-id'), ['wiki', 'pages'], harness())).status).toBe(400);
  });
  it.each(['crm/summary', 'crm/filters'])('applies current identity, view and source freshness to %s', async route => {
    const deps = harness();
    const result = await handleApiRequest(request(`${route}?view=created`), route.split('/'), deps);
    expect(result.status).toBe(200);
    expect(deps.liveCrmAccess).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7 }), 'created');
    expect((await result.json()).data).toMatchObject({ access_scope: 'created', source_status: { opportunities: { status: 'ok' } } });
    const stale = harness({ stale: true });
    expect((await handleApiRequest(request(route), route.split('/'), stale)).status).toBe(503);
    expect(stale.liveCrmAccess).not.toHaveBeenCalled();
    const denied = harness({ scopes: ['knowledge:read'] });
    expect((await handleApiRequest(request(route), route.split('/'), denied)).status).toBe(403);
    expect(denied.liveCrmAccess).not.toHaveBeenCalled();
    const failed = harness(); failed.liveCrmAccess.mockRejectedValueOnce(new Error('unavailable'));
    expect((await handleApiRequest(request(route), route.split('/'), failed)).status).toBe(503);
    expect(failed.query.mock.calls.every(([sql]) => !sql.includes('FROM public.opportunities'))).toBe(true);
  });
  it('routes warehouse summaries before ID lookup and protects them with warehouse scope', async () => {
    const result = await handleApiRequest(request('warehouses/summary?period=today'), ['warehouses', 'summary'], harness());
    expect(result.status).toBe(200);
    expect((await result.json()).data).toMatchObject({ total: 0, query_context: { period: 'today', timezone: 'Asia/Kolkata' } });
    const denied = await handleApiRequest(request('warehouses/summary'), ['warehouses', 'summary'], harness({ scopes: ['crm:read'] }));
    expect(denied.status).toBe(403);
  });
  it('rejects missing keys without connecting to the database', async () => {
    const deps = harness();
    const response = await handleApiRequest(request('warehouses'), ['warehouses'], { ...deps, authenticate: req => authenticateKey(req, []) });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(deps.transactionMock).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s before auth or database work', async method => {
    const deps = harness();
    const response = await handleApiRequest(request('warehouses', { method }), ['warehouses'], deps);
    expect(response.status).toBe(405);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.transactionMock).not.toHaveBeenCalled();
  });
  it('serves the OpenAPI schema without database access', async () => {
    const deps = harness();
    const response = await handleApiRequest(request('openapi.json'), ['openapi.json'], deps);
    const document = await response.json();
    expect(response.status).toBe(200);
    expect(document.openapi).toBe('3.1.0');
    expect(deps.transactionMock).not.toHaveBeenCalled();
    for (const route of Object.values(document.paths) as Record<string, unknown>[]) {
      expect(route).not.toHaveProperty('post'); expect(route).not.toHaveProperty('delete');
    }
  });
  it('rejects inactive employees even with a recognised key', async () => {
    const deps = harness({ roster: [{ ...active, is_active: false }] });
    const response = await handleApiRequest(request('warehouses'), ['warehouses'], deps);
    expect(response.status).toBe(403);
    expect(deps.query).toHaveBeenCalledTimes(1);
  });
  it('checks scope on direct record access', async () => {
    const deps = harness({ scopes: ['knowledge:read'] });
    const response = await handleApiRequest(request('warehouses/12'), ['warehouses', '12'], deps);
    expect(response.status).toBe(403);
    expect(deps.query).toHaveBeenCalledTimes(1);
  });
  it('protects warehouse filter discovery with the same scope as inventory', async () => {
    const deps = harness({ scopes: ['knowledge:read'] });
    const response = await handleApiRequest(request('warehouses/filters'), ['warehouses', 'filters'], deps);
    expect(response.status).toBe(403);
    expect(deps.query).toHaveBeenCalledTimes(1);
  });
  it('routes filter discovery before warehouse IDs and rejects private filter dimensions', async () => {
    const response = await handleApiRequest(request('warehouses/filters'), ['warehouses', 'filters'], harness());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.catalog).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'docks_min' })]));
    const invalid = await handleApiRequest(request('warehouses/filters?phone=123'), ['warehouses', 'filters'], harness());
    expect(invalid.status).toBe(400);
  });
  it('strips non-allowlisted source fields from HTTP responses', async () => {
    const deps = harness();
    const response = await handleApiRequest(request('warehouses'), ['warehouses'], deps);
    const body = await response.json();
    expect(body.data.items[0]).toMatchObject({ id: 12, city: 'Bengaluru' });
    const wire = JSON.stringify(body);
    for (const forbidden of ['9876543210', '9999999999', 'contactNumber', 'alt_phone_number', 'negotiated_rent', 'media']) expect(wire).not.toContain(forbidden);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, status: 200 }));
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain('alex@');
  });
  it('rejects hidden-field filters and oversized pages', async () => {
    for (const params of ['phone=1234567890', 'limit=1000', 'city=Bengaluru&city=Hyderabad']) {
      const response = await handleApiRequest(request(`warehouses?${params}`), ['warehouses'], harness());
      expect(response.status).toBe(400);
    }
  });
  it('serves authenticated Markdown and excludes draft pages', async () => {
    const response = await handleApiRequest(request('context.md'), ['context.md'], harness());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    const body = await response.text();
    expect(body).toContain('/api/v1/wiki/pages/');
    expect(body).not.toContain('wog_ctx_');
    expect(body).not.toContain('shortlisting-recommendation');
    expect(body).toContain('/api/v1/warehouses/filters');
    expect(body).toContain('data needs verification');
  });
  it('refuses stale CRM assignment data before querying deals', async () => {
    const deps = harness({ stale: true });
    const response = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], deps);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CRM_SOURCE_STALE');
    expect(deps.query.mock.calls.every(([query]) => !query.includes('FROM public.opportunities'))).toBe(true);
  });
  it('uses a generic not-found result for unassigned CRM IDs', async () => {
    const deps = harness();
    const id = '12345678-1234-1234-1234-123456789012';
    const response = await handleApiRequest(request(`crm/opportunities/${id}`), ['crm', 'opportunities', id], deps);
    expect(response.status).toBe(404);
    expect(deps.query).toHaveBeenLastCalledWith(expect.stringContaining('ANY('), expect.arrayContaining([id, []]));
    expect(deps.transactionMock).toHaveBeenCalledTimes(2);
    expect(deps.liveCrmAccess).toHaveBeenCalledOnce();
    expect(deps.liveCrmAccess).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7 }), 'accessible', id);
  });
  it('refuses CRM reads when live assignment verification fails', async () => {
    const deps = harness();
    deps.liveCrmAccess.mockRejectedValueOnce(new Error('upstream unavailable'));
    const response = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], deps);
    expect(response.status).toBe(503);
    expect(deps.query.mock.calls.every(([query]) => !query.includes('FROM public.opportunities'))).toBe(true);
  });
  it('uses the verified Twenty admin result without granting WAG admins extra CRM access', async () => {
    const admin = harness();
    admin.liveCrmAccess.mockResolvedValue({ mode: 'all', memberId: active.twenty_user_id });
    const response = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], admin);
    expect(response.status).toBe(200);
    expect((await response.json()).data.access_scope).toBe('all');
    expect(admin.query).toHaveBeenLastCalledWith(expect.not.stringContaining('assignee_email'), expect.any(Array));
    const dashboardAdmin = harness({ roster: [{ ...active, adminAccess: true }] });
    const restricted = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], dashboardAdmin);
    expect((await restricted.json()).data.access_scope).toBe('created_or_assigned');
    expect(dashboardAdmin.query).toHaveBeenLastCalledWith(expect.stringContaining('ANY('), expect.arrayContaining([[]]));
  });
  it.each(['created', 'assigned'])('passes the %s filter to live authorization', async view => {
    const deps = harness();
    const response = await handleApiRequest(request(`crm/opportunities?view=${view}`), ['crm', 'opportunities'], deps);
    expect(response.status).toBe(200);
    expect(deps.liveCrmAccess).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7 }), view);
    expect((await response.json()).data.access_scope).toBe(view);
  });
  it('validates CRM routes and filters before upstream requests', async () => {
    for (const [route, path] of [
      ['crm/unknown', ['crm', 'unknown']],
      ['crm/opportunities?view=all', ['crm', 'opportunities']],
      ['crm/opportunities?view=created&assigned_to=me', ['crm', 'opportunities']],
    ] as const) {
      const deps = harness();
      const response = await handleApiRequest(request(route), [...path], deps);
      expect([400, 404]).toContain(response.status);
      expect(deps.liveCrmAccess).not.toHaveBeenCalled();
      expect(deps.transactionMock).not.toHaveBeenCalled();
    }
  });
  it('rechecks employee activation after the live assignment request', async () => {
    const deps = harness();
    deps.liveCrmAccess.mockImplementationOnce(async () => {
      deps.query.mockImplementationOnce(async () => ({ rows: [] }));
      return { mode: 'related' as const, memberId: active.twenty_user_id, ids: [] };
    });
    const response = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], deps);
    expect(response.status).toBe(403);
    expect(deps.query.mock.calls.every(([query]) => !query.includes('FROM public.opportunities'))).toBe(true);
  });
  it('rechecks connector revocation inside the read transaction after live CRM verification', async () => {
    const deps = harness();
    let revoked = false;
    const revalidateKey = vi.fn(async () => {
      if (revoked) throw new HttpError(401, 'UNAUTHORIZED', 'The connector has been revoked.');
    });
    deps.liveCrmAccess.mockImplementationOnce(async () => {
      revoked = true;
      return { mode: 'related' as const, memberId: active.twenty_user_id, ids: [] };
    });
    const response = await handleApiRequest(request('crm/opportunities'), ['crm', 'opportunities'], { ...deps, revalidateKey });
    expect(response.status).toBe(401);
    expect(revalidateKey).toHaveBeenCalledTimes(2);
    expect(deps.query.mock.calls.every(([query]) => !query.includes('FROM public.opportunities'))).toBe(true);
  });
  it('rejects browser origins outside the allowlist without database work', async () => {
    const deps = harness();
    const response = await handleApiRequest(request('context', { headers: { Origin: 'https://untrusted.example' } }), ['context'], deps);
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(deps.transactionMock).not.toHaveBeenCalled();
  });
  it('never returns raw exception details', async () => {
    const deps = harness();
    deps.transactionMock.mockRejectedValueOnce(new Error('secret postgres://credential@host'));
    const response = await handleApiRequest(request('context'), ['context'], deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('credential');
  });
  it('rejects failed and future-dated sync checkpoints', () => {
    const status = (date: string, value: string) => ({ source_status: { opportunities: { last_run_at: date, status: value, source_watermark_at: null } } });
    expect(() => assertFreshCrm(status(new Date().toISOString(), 'error'))).toThrow('successful recent sync');
    expect(() => assertFreshCrm(status('2099-01-01T00:00:00Z', 'ok'))).toThrow('successful recent sync');
  });
});
