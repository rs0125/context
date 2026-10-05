import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rosterReadScopes, resolvePrincipal, type KeyRegistration } from '../src/lib/auth';
import { resolveConsoleEmployee, type ConsoleIdentity } from '../src/lib/console-auth';
import { handleConsolePromptsRequest } from '../src/lib/console-prompts';
import { handleConsoleKnowledgeRequest } from '../src/lib/console-knowledge';

const admin = { id: 1, email: 'admin@wareongo.com', name: 'Synthetic admin', is_active: true,
  adminAccess: true, analystAccess: false, dashboardAccess: false, twenty_user_id: null };
const employee = { ...admin, id: 2, email: 'employee@wareongo.com', name: 'Synthetic employee', adminAccess: false };
const actor: ConsoleIdentity = { employeeId: 1, email: admin.email, name: admin.name, isAdmin: true, isAnalyst: true, scopes: ['knowledge:read', 'crm:read', 'analytics:read'] };
type Row = Record<string, unknown>;
function database(options: { actor?: Row[]; target?: Row[] } = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('WHERE lower(r.email)')) return { rows: values?.[0] === admin.email ? options.actor ?? [admin] : options.target ?? [employee] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => work(client);
  return { query, client, transaction };
}
const origin = 'https://context.example.test';
beforeEach(() => { vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin); vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());

describe('employee, Analyst and admin permission boundaries', () => {
  it.each([
    [{}, ['knowledge:read']],
    [{ dashboardAccess: true }, ['knowledge:read', 'warehouses:read']],
    [{ twenty_user_id: '11111111-1111-4111-8111-111111111111' }, ['knowledge:read', 'crm:read']],
    [{ analystAccess: true }, ['knowledge:read', 'crm:read', 'analytics:read', 'cms:read']],
    [{ analystAccess: true, dashboardAccess: true }, ['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'cms:read']],
    [{ adminAccess: true }, ['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'cms:read']],
    [{ analystAccess: 'true', adminAccess: 1 }, ['knowledge:read']],
  ] as const)('derives scopes identically for browser and agent identities (%j)', async (overrides, expected) => {
    const row = { ...employee, ...overrides };
    const db = database({ target: [row] });
    expect(rosterReadScopes(row)).toEqual(expected);
    const identity = await resolveConsoleEmployee(db.client, employee.email);
    const key: KeyRegistration = { employeeId: employee.id, id: 'synthetic', hash: 'a'.repeat(64), employeeEmail: employee.email,
      scopes: ['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'cms:read'], expiresAt: '2099-01-01T00:00:00Z' };
    const principal = await resolvePrincipal(db.client, key);
    expect(identity.scopes).toEqual(expected); expect(principal.scopes).toEqual(expected);
    expect(identity.isAnalyst).toBe(principal.isAnalyst);
    expect(identity.isAdmin).toBe(row.adminAccess === true);
    // Neither the signed browser cookie nor a credential can supply this flag.
    expect(db.query.mock.calls[0][0]).toContain('r."analystAccess"');
  });

  it('does not widen an older credential after an Analyst grant', async () => {
    const db = database({ target: [{ ...employee, analystAccess: true }] });
    const principal = await resolvePrincipal(db.client, { employeeId: employee.id, id: 'old-key', hash: 'a'.repeat(64), employeeEmail: employee.email,
      scopes: ['knowledge:read'], expiresAt: '2099-01-01T00:00:00Z' });
    expect(principal).toMatchObject({ isAnalyst: true, scopes: ['knowledge:read'] });
  });

  it.each(['prompts', 'knowledge'])('denies an Analyst the admin %s API', async name => {
    const db = database();
    const deps = { readTransaction: db.transaction, writeTransaction: db.transaction,
      session: vi.fn(), identity: vi.fn(async () => ({ ...actor, isAdmin: false })), origin: vi.fn() };
    const req = new Request(`${origin}/api/console/${name}`);
    const response = name === 'prompts' ? await handleConsolePromptsRequest(req, deps)
      : await handleConsoleKnowledgeRequest(req, undefined, deps);
    expect(response.status).toBe(403); expect(db.query).not.toHaveBeenCalled();
  });
});
