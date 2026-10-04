/** Routing and authorization gates for live, receipt-owned RFQ reads; no provider calls. */
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration } from '../src/lib/auth';
import type { readCrmRfq, listCrmRfqChanges } from '../src/lib/crm-writes/change-read';
import { HttpError } from '../src/lib/errors';

const origin = 'https://context.example.test';
beforeEach(() => {
  vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', 'synthetic');
  vi.stubEnv('TWENTY_CRM_BASE_URL', 'https://crm.example.test');
});
afterEach(() => vi.unstubAllEnvs());
function harness() {
  const id = randomUUID();
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
    employeeEmail: 'employee@wareongo.com', scopes: ['crm.rfq:write'], expiresAt: '2099-01-01T00:00:00Z' };
  const read = vi.fn<typeof readCrmRfq>(async () => ({ id, updated_at: '2026-10-04T10:00:00.000Z', editable: true } as Awaited<ReturnType<typeof readCrmRfq>>));
  const list = vi.fn<typeof listCrmRfqChanges>(async () => ({ items: [], restriction: 'Own agent-created RFQs only.' }));
  const deps = { authenticate: async () => key, readCrmRfq: read, listCrmRfqChanges: list,
    transaction: vi.fn(() => { throw new Error('Do not enter generic CRM mirror authorization'); }),
    liveCrmAccess: vi.fn(() => { throw new Error('Do not authorize via broad CRM reads'); }),
    revalidateKey: vi.fn(async () => {}), audit: vi.fn() };
  const request = (path: string, method = 'GET') => handleApiRequest(new Request(`${origin}/api/v1/${path}`, { method }), path.split('?')[0].split('/'), deps);
  return { id, key, read, list, deps, request };
}

describe('owned RFQ REST reads', () => {
  it('uses the live domain reader, retains grant revalidation and returns a private envelope', async () => {
    const h = harness();
    const response = await h.request(`crm/rfqs/${h.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).data).toMatchObject({ id: h.id, editable: true });
    expect(h.read).toHaveBeenCalledWith(h.id, h.key, expect.any(AbortSignal), h.deps.revalidateKey);
    expect(h.deps.transaction).not.toHaveBeenCalled();
    expect(h.deps.liveCrmAccess).not.toHaveBeenCalled();
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'crm/rfq/read', status: 200 }));
  });
  it('bounds recent changes and uses HEAD without a body', async () => {
    const h = harness();
    expect((await h.request('crm/rfq-changes?limit=3')).status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(3, h.key, expect.any(AbortSignal), h.deps.revalidateKey);
    const head = await h.request('crm/rfq-changes', 'HEAD');
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
  it.each(['crm/rfqs/not-an-id', 'crm/rfq-changes?limit=11', 'crm/rfq-changes?limit=0', 'crm/rfq-changes?limit=1&limit=2', 'crm/rfq-changes?employee_id=8', 'crm/rfqs/00000000-0000-4000-8000-000000000000?scope=all'])('rejects malformed or authority-expanding query %s', async path => {
    const h = harness();
    expect((await h.request(path)).status).toBe(422);
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it('cannot substitute ordinary CRM read permission or bypass feature configuration', async () => {
    const h = harness(); h.key.scopes = ['crm:read'];
    expect((await h.request(`crm/rfqs/${h.id}`)).status).toBe(403);
    h.key.scopes = ['crm.rfq:write']; vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'false');
    expect((await h.request(`crm/rfqs/${h.id}`)).status).toBe(503);
    vi.stubEnv('CONTEXT_CRM_RFQ_EDITS_ENABLED', 'true'); vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    expect((await h.request(`crm/rfqs/${h.id}`)).status).toBe(503);
    expect(h.read).not.toHaveBeenCalled();
  });
  it('preserves a current domain authorization refusal and never exposes stored details', async () => {
    const h = harness(); h.read.mockRejectedValue(new HttpError(403, 'CRM_RFQ_NOT_OWNED', 'Only your agent-created RFQs can be edited.'));
    const response = await h.request(`crm/rfqs/${h.id}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CRM_RFQ_NOT_OWNED' } });
  });
  it('does not expose REST mutations or accept another nested RFQ path', async () => {
    const h = harness();
    expect((await h.request(`crm/rfqs/${h.id}`, 'PATCH')).status).toBe(405);
    expect((await h.request(`crm/rfqs/${h.id}/changes`)).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
});
