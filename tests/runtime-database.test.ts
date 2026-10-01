import type { Pool, PoolClient } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { databaseOptions, withReadOnlyTransaction, withSessionWriteTransaction } from '../src/lib/db';
const url = 'postgresql://context_engine_runtime.test:synthetic@aws-0-example.pooler.supabase.com:6543/postgres';
afterEach(() => vi.unstubAllEnvs());
it('requires a separate runtime credential in production and gives it precedence over the migration URL', () => {
  expect(() => databaseOptions({ NODE_ENV: 'production', DATABASE_URL: url })).toThrow();
  expect(databaseOptions({ NODE_ENV: 'production', CONTEXT_DATABASE_URL: url, DATABASE_URL: 'not-a-runtime-url' }).connectionString).toBe(url);
});
it.each(['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'memberships', 'wrong_role'])('rejects unsafe runtime permission %s before the operation', async flag => {
  vi.stubEnv('CONTEXT_DATABASE_URL', url);
  const role: Record<string, unknown> = { rolname: 'context_engine_runtime', rolsuper: false, rolbypassrls: false,
    rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: false };
  if (flag === 'wrong_role') role.rolname = 'postgres'; else role[flag] = true;
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM pg_roles') ? [role] : [] }));
  const release = vi.fn();
  const pool = { waitingCount: 0, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  const operation = vi.fn(async (_client: PoolClient) => 'business data');
  await expect(withReadOnlyTransaction(operation, pool)).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
  expect(operation).not.toHaveBeenCalled();
  expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  expect(release).toHaveBeenCalledOnce();
});
it('commits session revocation even while console editing and key issuance are disabled', async () => {
  vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false');
  vi.stubEnv('CONTEXT_DATABASE_URL', url);
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM pg_roles')
    ? [{ rolname: 'context_engine_runtime', rolsuper: false, rolbypassrls: false, rolcreaterole: false,
      rolcreatedb: false, rolreplication: false, memberships: false }] : [] }));
  const release = vi.fn();
  const pool = { waitingCount: 0, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  const operation = vi.fn(async (_client: PoolClient) => 'revoked');
  expect(await withSessionWriteTransaction(operation, pool)).toBe('revoked');
  expect(operation).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  expect(release).toHaveBeenCalledOnce();
});
