import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/migrate-mcp-oauth.mjs';
const { migrateMcpOAuthStorage, runMcpOAuthMigration } = await import(modulePath);
afterEach(() => vi.restoreAllMocks());

describe('MCP OAuth migration fail-closed boundaries', () => {
  it('does no database or environment-file work without explicit --apply', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = vi.spyOn(pg, 'Pool');
    await runMcpOAuthMigration(['--env-file', '/nonexistent-mcp-oauth-migration-env']);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({ staged: true, applied: false, requiresExplicitApply: true, schema: 'context_mcp_private' });
    expect(pool).not.toHaveBeenCalled();
  });

  it.each([
    { failure: 'MCP_MIGRATION_BUSY', lock: false, bypass: true, schema: null },
    { failure: 'MCP_ROLE_REQUIRES_RLS_BYPASS', lock: true, bypass: false, schema: null },
    { failure: 'MCP_SCHEMA_COLLISION', lock: true, bypass: true, schema: { owned: true, marker: 'unrelated-schema', oid: 1 } },
    { failure: 'MCP_SCHEMA_COLLISION', lock: true, bypass: true, schema: { owned: false, marker: 'context-mcp-oauth-schema-v1', oid: 1 } },
  ])('rolls back $failure without changing any schema or privileges', async options => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ locked: options.lock }] };
      if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: options.bypass }] };
      if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: options.schema ? [options.schema] : [] };
      return { rows: [] };
    });
    await expect(migrateMcpOAuthStorage({ query })).rejects.toThrow(options.failure);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN'); expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).toContain("SET LOCAL statement_timeout = '4000ms'");
    expect(statements.some(sql => /^(CREATE|ALTER|REVOKE|INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it('hides raw database failures and rolls back an open transaction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) throw new Error('postgres://private-credential@internal-host');
      return { rows: [] };
    });
    await expect(migrateMcpOAuthStorage({ query })).rejects.toThrow('MCP_MIGRATION_FAILED');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
