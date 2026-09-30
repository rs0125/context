import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';

const employee = { id: 7, email: 'admin@example.test', is_active: true, adminAccess: true,
  dashboardAccess: false, twenty_user_id: null };
const payload = { source: 'synthetic', items: [], source_fetched_at: '2026-09-26T10:00:00Z' };
afterEach(() => vi.useRealTimers());
function harness(options: { admin?: boolean; analyst?: boolean; scopes?: KeyRegistration['scopes'] } = {}) {
  let sockets = 0;
  let roster = { ...employee, adminAccess: options.admin ?? true, analystAccess: options.analyst ?? false };
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: employee.email,
    scopes: options.scopes ?? ['analytics:read'], expiresAt: '2099-01-01T00:00:00Z' };
  const query = vi.fn(async () => ({ rows: [{ ...roster }] }));
  const client = { query } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    sockets++;
    try { return await work(client); } finally { sockets--; }
  };
  const source = vi.fn(async () => { expect(sockets).toBe(0); return payload; });
  const revalidateKey = vi.fn(async () => {});
  return { deps: { transaction, authenticate: vi.fn(() => key), revalidateKey,
    analyticsCapabilities: source as never, ga4Report: source as never, searchConsoleReport: source as never,
    audit: vi.fn() }, query, source, demote: () => { roster = { ...roster, adminAccess: false, analystAccess: false }; },
    deactivate: () => { roster = { ...roster, is_active: false }; } };
}
function read(path: string, deps: Parameters<typeof handleApiRequest>[2]) {
  return handleApiRequest(new Request(`https://context.example.test/api/v1/${path}`), path.split('?')[0].split('/'), deps);
}

describe('Analyst analytics REST boundary', () => {
  it.each(['capabilities', 'ga4', 'search-console'])('revalidates the admin before and after %s without holding a pool socket', async name => {
    const h = harness();
    const response = await read(`analytics/${name}`, h.deps);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(payload);
    expect(h.deps.revalidateKey).toHaveBeenCalledTimes(2);
    expect(h.source).toHaveBeenCalledOnce();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['capabilities', 'ga4', 'search-console'])('allows Analysts without admin access to read %s', async name => {
    const h = harness({ admin: false, analyst: true });
    expect((await read(`analytics/${name}`, h.deps)).status).toBe(200);
    expect(h.source).toHaveBeenCalledOnce();
  });
  it.each(['capabilities', 'ga4', 'search-console'])('withholds %s when Analyst access is revoked during the source read', async name => {
    const h = harness({ admin: false, analyst: true });
    h.source.mockImplementation(async () => { h.demote(); return payload; });
    const result = await read(`analytics/${name}`, h.deps);
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain('source_fetched_at');
  });
  it.each(['capabilities', 'ga4', 'search-console'])('rejects non-Analysts holding a claimed analytics scope before reading %s', async name => {
    const h = harness({ admin: false });
    expect((await read(`analytics/${name}`, h.deps)).status).toBe(403);
    expect(h.source).not.toHaveBeenCalled();
  });
  it('does not widen a pre-existing admin key', async () => {
    const h = harness({ scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] });
    expect((await read('analytics/ga4', h.deps)).status).toBe(403);
    expect(h.source).not.toHaveBeenCalled();
  });
  it.each(['demote', 'deactivate'] as const)('withholds an in-flight or cached report after %s', async action => {
    const h = harness();
    h.source.mockImplementation(async () => { h[action](); return payload; });
    const response = await read('analytics/ga4', h.deps);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('source_fetched_at');
  });
  it('withholds a report if its connector grant was revoked during the read', async () => {
    const h = harness();
    h.deps.revalidateKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpError(401, 'UNAUTHORIZED', 'Reconnect.'));
    const response = await read('analytics/ga4', h.deps);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('source_fetched_at');
  });
  it.each(['ga4?property_id=123', 'ga4?limit=1000', 'ga4?report=overview&report=events',
    'search-console?site=https://another.example', 'capabilities?credentials=anything'])('rejects hidden or invalid query options: %s', async path => {
    const h = harness();
    expect([400, 422]).toContain((await read(`analytics/${path}`, h.deps)).status);
    expect(h.source).not.toHaveBeenCalled();
  });
  it('rechecks expiry of a legacy environment key after the Google read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2098-12-31T23:59:59Z'));
    const h = harness();
    h.source.mockImplementation(async () => { vi.setSystemTime(new Date('2099-01-01T00:00:01Z')); return payload; });
    const response = await read('analytics/ga4', h.deps);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('source_fetched_at');
  });
  it('preserves source unavailability instead of returning empty data', async () => {
    const h = harness();
    h.source.mockRejectedValueOnce(new HttpError(503, 'ANALYTICS_SOURCE_UNAVAILABLE', 'Reporting unavailable.'));
    const response = await read('analytics/ga4', h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ANALYTICS_SOURCE_UNAVAILABLE' } });
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'analytics/ga4', status: 503 }));
  });
  it('context discovery reflects the granted scope and current admin role', async () => {
    const admin = await (await read('context', harness().deps)).json();
    const demoted = await (await read('context', harness({ admin: false }).deps)).json();
    expect(admin.data.analytics_discovery).toMatchObject({ permitted: true, status: 'not_checked' });
    expect(demoted.data.analytics_discovery).toMatchObject({ permitted: false, capabilities_path: null });
  });
});
