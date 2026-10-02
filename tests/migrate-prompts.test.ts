import pg from 'pg';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/migrate-prompts.mjs';
const { migratePromptStorage, runPromptMigration } = await import(modulePath);

function fakeDatabase(options: { collision?: boolean; bypass?: boolean; privacy?: boolean; existing?: 1 | 2; tampered?: boolean } = {}) {
  let version = options.existing ?? 2;
  let schemaExists = Boolean(options.existing);
  const columns = () => [['id', 'text'], ['body', 'text'], ['revision', 'uuid'], ['updated_at', 'timestamp with time zone'], ['updated_by', 'text'],
    ...(version === 2 ? [['platforms', 'text[]']] : [])]
    .map(([name, type]) => ({ name, type, not_null: !['body', 'platforms'].includes(name), identity: '', generated: '', dropped: false, default_expression: name === 'updated_at' ? 'CURRENT_TIMESTAMP' : null }));
  const constraints = () => ['pkey', 'id_check', 'body_check', 'editor_check', ...(version === 2 ? ['platforms_check'] : [])]
    .map(suffix => ({ name: `prompt_overrides_${suffix}`, validated: true, type: suffix === 'pkey' ? 'p' : 'c', definition: suffix }));
  let marker = options.existing ? `context-prompt-overrides-v${version}:${options.tampered ? 'tampered' : createHash('sha256').update(JSON.stringify({ columns: columns(), constraints: constraints() })).digest('hex')}` : null;
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: options.bypass !== false }] };
    if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: options.collision || schemaExists ? [{ oid: 1, owned: true, marker: options.collision ? 'unrelated-schema' : 'context-prompts-schema-v1' }] : [] };
    if (sql.includes('AS routines')) return { rows: [{ relations: 0, routines: 0 }] };
    if (sql.includes('FROM pg_class c JOIN')) return { rows: [{ oid: 2, owned: true, relkind: 'r', relpersistence: 'p', relispartition: false, relrowsecurity: true, relforcerowsecurity: true, marker }] };
    if (sql.includes('FROM pg_attribute a')) return { rows: columns() };
    if (sql.includes('FROM pg_constraint')) return { rows: constraints() };
    if (sql.includes('AS inheritance')) return { rows: [{ policies: 0, triggers: 0, rules: 0, inheritance: 0 }] };
    if (sql.startsWith('SELECT rolname')) return { rows: ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname })) };
    if (sql.includes('AS no_api_role_access')) return { rows: [{ no_public_schema: true, no_public_table: true, no_api_role_access: options.privacy !== false }] };
    if (sql === 'CREATE SCHEMA context_prompts_private') schemaExists = true;
    if (sql.includes('ADD COLUMN platforms')) version = 2;
    if (sql.startsWith('COMMENT ON TABLE')) marker = sql.split("'")[1];
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
  it('upgrades verified v1 storage in place and leaves existing prompt rows and revisions intact', async () => {
    const { client, query } = fakeDatabase({ existing: 1 });
    await migratePromptStorage(client);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('LOCK TABLE context_prompts_private.prompt_overrides IN SHARE ROW EXCLUSIVE MODE');
    expect(statements).toContain('ALTER TABLE context_prompts_private.prompt_overrides ADD COLUMN platforms text[]');
    expect(statements.some(sql => sql.includes('ADD CONSTRAINT prompt_overrides_platforms_check'))).toBe(true);
    expect(statements.some(sql => sql.startsWith('COMMENT ON TABLE') && sql.includes('context-prompt-overrides-v2:'))).toBe(true);
    expect(statements.join('\n')).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM|DROP /);
    query.mockClear();
    await migratePromptStorage(client);
    expect(query.mock.calls.some(([sql]) => /ADD COLUMN|ADD CONSTRAINT/.test(sql))).toBe(false);
  });
  it('rejects a tampered v1 table before applying the upgrade', async () => {
    const { client, query } = fakeDatabase({ existing: 1, tampered: true });
    await expect(migratePromptStorage(client)).rejects.toThrow('PROMPTS_RELATION_COLLISION');
    expect(query.mock.calls.some(([sql]) => /^(CREATE|ALTER|REVOKE)/.test(sql))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
