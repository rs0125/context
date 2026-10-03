import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { READ_SCOPES, SCOPES, rosterReadScopes, rosterScopes, resolvePrincipal, type KeyRegistration } from '../src/lib/auth';

const row = { id: 71, email: 'synthetic@wareongo.com', is_active: true,
  dashboardAccess: false, adminAccess: false, analystAccess: false, twenty_user_id: null };
const key: KeyRegistration = { employeeId: row.id, employeeEmail: row.email,
  id: 'synthetic', hash: 'a'.repeat(64), scopes: ['knowledge:read', 'gis:write'], expiresAt: '2099-01-01T00:00:00Z' };
const client = (employee: Record<string, unknown>) => ({ query: vi.fn(async () => ({ rows: [employee] })) }) as unknown as PoolClient;

describe('explicit GIS write eligibility', () => {
  it('keeps the default read vocabulary separate from supported actions', () => {
    expect(READ_SCOPES).not.toContain('gis:write');
    expect(SCOPES).toContain('gis:write');
    expect(rosterReadScopes({ ...row, adminAccess: true })).not.toContain('gis:write');
  });

  it.each([
    [{ dashboardAccess: true }, true], [{ adminAccess: true }, true],
    [{ analystAccess: true }, false], [{}, false], [{ dashboardAccess: 'true', adminAccess: 1 }, false],
  ] as const)('requires current dashboard/admin eligibility (%j)', async (overrides, allowed) => {
    const employee = { ...row, ...overrides };
    expect(rosterScopes(employee).includes('gis:write')).toBe(allowed);
    expect((await resolvePrincipal(client(employee), key)).scopes.includes('gis:write')).toBe(allowed);
  });

  it('never expands a read credential when the employee gains write eligibility', async () => {
    const principal = await resolvePrincipal(client({ ...row, adminAccess: true }), { ...key, scopes: ['knowledge:read', 'warehouses:read'] });
    expect(principal.scopes).toEqual(['knowledge:read', 'warehouses:read']);
  });

  it('removes an explicit GIS grant on permission revocation and rejects inactive/reassigned identities', async () => {
    expect((await resolvePrincipal(client({ ...row, dashboardAccess: true }), key)).scopes).toContain('gis:write');
    expect((await resolvePrincipal(client(row), key)).scopes).not.toContain('gis:write');
    for (const invalid of [{ ...row, is_active: false }, { ...row, id: row.id + 1 }])
      await expect(resolvePrincipal(client(invalid), key)).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
  });
});
