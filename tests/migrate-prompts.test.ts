import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/migrate-prompts.mjs';
const { migratePromptStorage, runPromptMigration } = await import(modulePath);

function fakeDatabase(options: { collision?: boolean; bypass?: boolean; privacy?: boolean } = {}) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: options.bypass !== false }] };
    if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: options.collision ? [{ oid: 1, owned: true, marker: 'unrelated-schema' }] : [] };
    if (sql.includes('FROM pg_class c JOIN')) return { rows: [{ oid: 2, owned: true, relkind: 'r', relpersistence: 'p', relispartition: false, relrowsecurity: true, relforcerowsecurity: true, marker: null }] };
    if (sql.includes('FROM pg_attribute a')) return { rows: [['id', 'text'], ['body', 'text'], ['revision', 'uuid'], ['updated_at', 'timestamp with time zone'], ['updated_by', 'text']]
      .map(([name, type]) => ({ name, type, not_null: name !== 'body', identity: '', generated: '', dropped: false, default_expression: name === 'updated_at' ? 'CURRENT_TIMESTAMP' : null })) };
    if (sql.includes('FROM pg_constraint')) return { rows: ['pkey', 'id_check', 'body_check', 'editor_check']
      .map(suffix => ({ name: `prompt_overrides_${suffix}`, validated: true, type: suffix === 'pkey' ? 'p' : suffix.endsWith('_key') ? 'u' : 'c', definition: suffix })) };
    if (sql.includes('AS inheritance')) return { rows: [{ policies: 0, triggers: 0, rules: 0, inheritance: 0 }] };
    if (sql.startsWith('SELECT rolname')) return { rows: ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname })) };
    if (sql.includes('AS no_api_role_access')) return { rows: [{ no_public_schema: true, no_public_table: true, no_api_role_access: options.privacy !== false }] };
    return { rows: [] };
  });
  return { query, client: { query } };
}

describe('staged prompt storage migration', () => {
  it('does not connect or mutate anything by default', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = vi.spyOn(pg, 'Pool');
    try {
      await runPromptMigration(['--env-file', '/nonexistent-console-migration-env']);
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({ staged: true, applied: false, requiresExplicitApply: true, schema: 'context_prompts_private' });
      expect(pool).not.toHaveBeenCalled();
    } finally { output.mockRestore(); pool.mockRestore(); }
  });

  it('creates only an empty private prompt table with forced RLS and verified revoked API roles', async () => {
    const { client, query } = fakeDatabase();
    expect(await migratePromptStorage(client)).toEqual({ applied: true, verified: true, seededPrompts: 0 });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN'); expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL statement_timeout = '4000ms'");
    expect(statements).toContain('ALTER TABLE context_prompts_private.prompt_overrides FORCE ROW LEVEL SECURITY');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(statements).toContain(`REVOKE ALL ON SCHEMA context_prompts_private FROM "${role}"`);
      expect(statements).toContain(`REVOKE ALL ON TABLE context_prompts_private.prompt_overrides FROM "${role}"`);
    }
    expect(statements.join('\n')).not.toMatch(/public\.|context_engine_private|INSERT INTO|UPDATE |DELETE FROM|CREATE POLICY/);
  });

  it.each([[{ collision: true }, 'PROMPTS_SCHEMA_COLLISION'], [{ bypass: false }, 'PROMPTS_ROLE_REQUIRES_RLS_BYPASS']])('rejects unsafe targets before any DDL', async (options, code) => {
    const { client, query } = fakeDatabase(options);
    await expect(migratePromptStorage(client)).rejects.toThrow(code);
    expect(query.mock.calls.some(([sql]) => /^(CREATE|ALTER|REVOKE)/.test(sql))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rolls back all DDL if effective API-role permissions cannot be removed', async () => {
    const { client, query } = fakeDatabase({ privacy: false });
    await expect(migratePromptStorage(client)).rejects.toThrow('PROMPTS_PRIVACY_UNVERIFIED');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });
});
