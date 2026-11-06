import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/lib/api';
import { CALL_PERFORMANCE_SCOPE } from '../src/lib/call-performance-query';
import type { KeyRegistration } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';

function harness(options: { admin?: boolean; analyst?: boolean; granted?: boolean } = {}) {
  let active = true, permitted = true, sockets = 0;
  const key: KeyRegistration = { id: randomUUID(), employeeId: 7, hash: 'a'.repeat(64), employeeEmail: 'reporter@example.test',
    scopes: options.granted === false ? ['knowledge:read'] : [CALL_PERFORMANCE_SCOPE], expiresAt: '2099-01-01T00:00:00Z' };
  const client = { query: vi.fn(async () => ({ rows: [{ id: 7, email: key.employeeEmail, is_active: active,
    adminAccess: permitted && (options.admin ?? false), analystAccess: permitted && (options.analyst ?? true),
    dashboardAccess: false, twenty_user_id: null }] })) } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    sockets++; try { return await work(client); } finally { sockets--; }
  };
  const payload = { assignment_evidence: 'synthetic data' };
  const source = vi.fn(async () => { expect(sockets).toBe(0); return payload; });
  return { payload, source, revoke: () => { permitted = false; }, deactivate: () => { active = false; },
    deps: { authenticate: () => key, transaction, callPerformance: source as never,
      revalidateKey: vi.fn(async () => {}), audit: vi.fn() } };
}
const read = (path: string, deps: Parameters<typeof handleApiRequest>[2], method = 'GET') =>
  handleApiRequest(new Request(`https://context.example.test/api/v1/${path}`, { method }), path.split('?')[0].split('/'), deps);

describe('caller performance REST authorization', () => {
  it.each(['calls/capabilities', 'calls/summary', 'calls/assignments', 'calls/assignments/42'])('reads %s with fresh Analyst authorization around the source transaction', async path => {
    const h = harness();
    const response = await read(path, h.deps);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(h.payload);
    expect(h.deps.revalidateKey).toHaveBeenCalledTimes(2);
    expect(h.source).toHaveBeenCalledOnce();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('inherits eligibility for an admin without granting a pre-existing credential new scopes', async () => {
    expect((await read('calls/summary', harness({ admin: true, analyst: false }).deps)).status).toBe(200);
    const h = harness({ admin: true, granted: false });
    expect((await read('calls/summary', h.deps)).status).toBe(403);
    expect(h.source).not.toHaveBeenCalled();
  });
  it('rejects an ordinary employee before touching the call database', async () => {
    const h = harness({ admin: false, analyst: false });
    expect((await read('calls/capabilities', h.deps)).status).toBe(403);
    expect(h.source).not.toHaveBeenCalled();
  });
  it.each(['revoke', 'deactivate'] as const)('withholds already fetched evidence after %s', async action => {
    const h = harness();
    h.source.mockImplementation(async () => { h[action](); return h.payload; });
    const response = await read('calls/summary', h.deps);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('assignment_evidence');
  });
  it('rechecks OAuth revocation after the read', async () => {
    const h = harness();
    h.deps.revalidateKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpError(401, 'UNAUTHORIZED', 'Revoked.'));
    const response = await read('calls/summary', h.deps);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('assignment_evidence');
  });
  it.each(['calls/summary?sql=select+1', 'calls/assignments?limit=26', 'calls/assignments?state=open&state=done',
    'calls/assignments/42?id=43', 'calls/assignments/9223372036854775808', 'calls/summary?date_from=2026-01-01'])('validates %s before a source query', async path => {
    const h = harness();
    expect([400, 422]).toContain((await read(path, h.deps)).status);
    expect(h.source).not.toHaveBeenCalled();
  });
  it('rejects writes and returns source failures as unavailable, not zero work', async () => {
    const h = harness();
    expect((await read('calls/assignments', h.deps, 'POST')).status).toBe(405);
    expect(h.source).not.toHaveBeenCalled();
    h.source.mockRejectedValueOnce(new HttpError(503, 'CALLS_SOURCE_UNAVAILABLE', 'Unavailable.'));
    const response = await read('calls/summary', h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CALLS_SOURCE_UNAVAILABLE' } });
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'calls/summary', status: 503 }));
  });
  it('advertises eligible access without querying call data', async () => {
    const h = harness();
    const body = await (await read('context', h.deps)).json();
    expect(body.data.call_performance_discovery).toMatchObject({ permitted: true, status: 'not_checked' });
    expect(h.source).not.toHaveBeenCalled();
    const denied = await (await read('context', harness({ analyst: false }).deps)).json();
    expect(denied.data.call_performance_discovery).toMatchObject({ permitted: false, capabilities_path: null });
  });
});
