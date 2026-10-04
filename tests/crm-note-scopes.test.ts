/** Current roster and explicit grants only. No provider, database or model calls. */
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { READ_SCOPES, SCOPES, parseKeyRegistry, resolvePrincipal, rosterReadScopes, rosterScopes, type KeyRegistration, type Scope } from '../src/lib/auth';
import { oauthScopes } from '../src/lib/mcp-oauth-protocol';

const employee = { id: 71, email: 'synthetic@wareongo.com', is_active: true,
  dashboardAccess: false, adminAccess: false, analystAccess: false, twenty_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const key: KeyRegistration = { employeeId: employee.id, employeeEmail: employee.email,
  id: 'synthetic', hash: 'a'.repeat(64), scopes: ['crm.notes:write'], expiresAt: '2099-01-01T00:00:00Z' };
const client = (rows: Record<string, unknown>[]) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as PoolClient;

describe('explicit agent-created deal-note capability', () => {
  it('requires an explicit grant and leaves read and OAuth defaults unchanged', async () => {
    expect(SCOPES).toContain('crm.notes:write');
    expect(READ_SCOPES).not.toContain('crm.notes:write');
    expect(rosterReadScopes(employee)).not.toContain('crm.notes:write');
    expect(rosterScopes(employee)).toContain('crm.notes:write');
    expect(oauthScopes(undefined)).toEqual([...READ_SCOPES]);
    expect(oauthScopes('crm.notes:write')).toEqual(['crm.notes:write']);
    expect((await resolvePrincipal(client([employee]), key)).scopes).toEqual(['crm.notes:write']);
    for (const scopes of [['knowledge:read'], ['crm:read'], ['crm.rfq:write']] as Scope[][]) {
      expect((await resolvePrincipal(client([employee]), { ...key, scopes })).scopes).toEqual(scopes);
    }
  });

  it.each([{ adminAccess: false, analystAccess: false }, { adminAccess: true, analystAccess: false }, { adminAccess: false, analystAccess: true }])(
    'requires a current linked CRM identity regardless of other access (%j)', async access => {
      const unlinked = { ...employee, ...access, twenty_user_id: null };
      expect(rosterScopes(unlinked)).not.toContain('crm.notes:write');
      expect((await resolvePrincipal(client([unlinked]), { ...key, scopes: ['knowledge:read', 'crm.notes:write'] })).scopes).toEqual(['knowledge:read']);
    });

  it('requires the same current, unique, active employee', async () => {
    for (const rows of [[], [{ ...employee, is_active: false }], [{ ...employee, id: 72 }],
      [{ ...employee, email: 'replacement@wareongo.com' }], [employee, { ...employee, id: 72 }]]) {
      await expect(resolvePrincipal(client(rows), key)).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
    }
  });

  it('accepts the specific notes capability without admitting duplicate or unrestricted CRM grants', () => {
    expect(parseKeyRegistry(JSON.stringify([key]))[0].scopes).toEqual(['crm.notes:write']);
    for (const scopes of [['crm:write'], ['crm.notes:*'], ['crm.notes:write', 'crm.notes:write']]) {
      expect(() => parseKeyRegistry(JSON.stringify([{ ...key, scopes }]))).toThrow();
      expect(() => oauthScopes(scopes.join(' '))).toThrow();
    }
  });
});
