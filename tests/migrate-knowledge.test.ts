import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The one-off CLI is JavaScript and does not participate in the Next.js bundle.
const modulePath = '../scripts/migrate-knowledge.mjs';
const { parseKnowledgeDocument, loadKnowledgeImport, knowledgeChecksum, migrateKnowledge, migrationDatabaseOptions } = await import(modulePath);

function source(metadata: Record<string, unknown> = {}, body = 'Generic reference text.') {
  return `---\n${JSON.stringify({ id: 'reference', title: 'Reference', summary: 'Generic summary', updatedAt: '2026-09-25', status: 'reviewed', scopes: ['knowledge:read'], ...metadata })}\n---\n${body}\n`;
}

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('private Markdown import validation', () => {
  it('preserves drafts, all scope requirements and date-only metadata', () => {
    const page = parseKnowledgeDocument(source({ status: 'draft', scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] }));
    expect(page).toMatchObject({ status: 'draft', updated_at: '2026-09-25', body: 'Generic reference text.', scopes: ['knowledge:read', 'warehouses:read', 'crm:read'] });
    expect(knowledgeChecksum([page])).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { id: '../private' }, { title: '' }, { summary: 'a'.repeat(501) }, { updatedAt: '2026-02-30' },
    { updatedAt: '2026-09-25T00:00:00Z' }, { status: 'public' }, { scopes: [] },
    { scopes: ['crm:read'] }, { scopes: ['knowledge:read', 'admin:all'] },
    { scopes: ['knowledge:read', 'knowledge:read'] }, { unknown: 'extra' },
  ])('rejects invalid metadata without echoing it: %j', metadata => {
    expect(() => parseKnowledgeDocument(source(metadata))).toThrow(/^INVALID_SOURCE_/);
  });

  it('rejects executable frontmatter engines before parsing and keeps errors opaque', () => {
    const payload = '---javascript\n(globalThis.__migrationExecuted = true, {id:"reference"})\n---\nbody';
    expect(() => parseKnowledgeDocument(payload)).toThrow('YAML_FRONTMATTER_REQUIRED');
    expect((globalThis as Record<string, unknown>).__migrationExecuted).toBeUndefined();
    expect(() => parseKnowledgeDocument('---\nkey: !!js/function function(){}\n---\nbody')).toThrow('INVALID_SOURCE_METADATA');
    expect(() => parseKnowledgeDocument(source({}, 'a'.repeat(100001)))).toThrow('INVALID_SOURCE_BODY');
    expect(() => parseKnowledgeDocument(source({}, 'bad\0value'))).toThrow('INVALID_SOURCE_DOCUMENT');
  });

  it('requires the exact expected file set and rejects symlinks', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-import-test-')); folders.push(directory);
    await writeFile(path.join(directory, 'reference.md'), source());
    expect(await loadKnowledgeImport(directory, 1)).toHaveLength(1);
    await expect(loadKnowledgeImport(directory, 2)).rejects.toThrow('SOURCE_FILE_SET_MISMATCH');
    await symlink(path.join(directory, 'reference.md'), path.join(directory, 'linked.md'));
    await expect(loadKnowledgeImport(directory, 2)).rejects.toThrow('SOURCE_FILE_SET_MISMATCH');
  });

  it('keeps metadata identity tied to the local source filename', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-import-test-')); folders.push(directory);
    await writeFile(path.join(directory, 'different.md'), source());
    await expect(loadKnowledgeImport(directory, 1)).rejects.toThrow('SOURCE_FILENAME_ID_MISMATCH');
  });

  it('uses one verified transaction-pooler socket and ignores URI overrides', () => {
    const options = migrationDatabaseOptions({ DATABASE_URL: 'postgresql://user:secret@sample.pooler.supabase.com:6543/postgres?sslmode=disable', PG_SSL_CA: 'line1\\nline2' });
    expect(options).toMatchObject({ max: 1, connectionTimeoutMillis: 5000, statement_timeout: 4000, ssl: { rejectUnauthorized: true, ca: 'line1\nline2' } });
    expect(new URL(options.connectionString).search).toBe('');
    expect(() => migrationDatabaseOptions({ DATABASE_URL: 'postgresql://user:secret@sample.pooler.supabase.com:5432/postgres' })).toThrow('TRANSACTION_POOLER_REQUIRED');
  });
});

function fakeDatabase(options: { collision?: boolean; bypass?: boolean; privacyFailure?: boolean; corruptReadback?: boolean } = {}) {
  let namespace = options.collision ? { oid: 11, owned: true, marker: 'unrelated-application-schema' } : null;
  let table: { oid: number; relkind: string; relpersistence: string; relispartition: boolean; relrowsecurity: boolean; relforcerowsecurity: boolean; owned: boolean; marker: string | null } | null = null;
  const stored = new Map<string, Record<string, unknown>>();
  let inserted = false;
  const columns = [['id', 'text'], ['title', 'text'], ['summary', 'text'], ['body', 'text'], ['updated_at', 'date'], ['status', 'text'], ['scopes', 'text[]']]
    .map(([name, type]) => ({ name, type, not_null: true, identity: '', generated: '', dropped: false, default_expression: null }));
  const constraints = ['pkey', 'id_check', 'title_check', 'summary_check', 'body_check', 'status_check', 'scopes_check']
    .map(suffix => ({ name: `knowledge_pages_${suffix}`, type: suffix === 'pkey' ? 'p' : 'c', validated: true, definition: suffix })).sort((a, b) => a.name.localeCompare(b.name));
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: options.bypass !== false }] };
    if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: namespace ? [namespace] : [] };
    if (sql.startsWith('CREATE SCHEMA')) namespace = { oid: 11, owned: true, marker: '' };
    if (sql.startsWith('COMMENT ON SCHEMA')) namespace!.marker = sql.match(/IS '([^']+)'/)![1];
    if (sql.startsWith('CREATE TABLE')) table = { oid: 12, relkind: 'r', relpersistence: 'p', relispartition: false, relrowsecurity: true, relforcerowsecurity: true, owned: true, marker: null };
    if (sql.startsWith('COMMENT ON TABLE')) table!.marker = sql.match(/IS '([^']+)'/)![1];
    if (sql.includes('FROM pg_class c JOIN pg_namespace')) return { rows: table ? [table] : [] };
    if (sql.includes('FROM pg_attribute a')) return { rows: columns };
    if (sql.includes('FROM pg_constraint WHERE')) return { rows: constraints };
    if (sql.includes('AS inheritance')) return { rows: [{ policies: 0, triggers: 0, rules: 0, inheritance: 0 }] };
    if (sql.includes('AS routines')) return { rows: [{ relations: 0, routines: 0 }] };
    if (sql.startsWith('SELECT rolname FROM')) return { rows: ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname })) };
    if (sql.includes('AS no_api_role_access')) return { rows: [{ no_public_schema: true, no_public_table: true, no_api_role_access: !options.privacyFailure }] };
    if (sql.startsWith('INSERT INTO')) {
      const [id, title, summary, body, updated_at, status, scopes] = values;
      if (stored.has(id as string)) return { rows: [], rowCount: 0 };
      stored.set(id as string, { id, title, summary, body, updated_at, status, scopes }); inserted = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, title, summary')) {
      const rows = [...stored.values()].filter(row => (values[0] as string[]).includes(row.id as string));
      return { rows: options.corruptReadback && inserted ? rows.map(row => ({ ...row, body: 'Wrong content' })) : rows };
    }
    return { rows: [] };
  });
  return { client: { query }, query, stored };
}

describe('transactional private knowledge migration', () => {
  it('creates only the private relation, revokes every API role, verifies readback and commits once', async () => {
    const { client, query } = fakeDatabase();
    const pages = [parseKnowledgeDocument(source()), parseKnowledgeDocument(source({ id: 'draft-reference', status: 'draft' }))];
    const result = await migrateKnowledge(client, pages);
    expect(result).toMatchObject({ pages: 2, reviewed: 1, draft: 1, inserted: 2, unchanged: 0, verified: true });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL statement_timeout = '4000ms'");
    expect(statements).toContain('ALTER TABLE context_engine_private.knowledge_pages FORCE ROW LEVEL SECURITY');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(statements).toContain(`REVOKE ALL ON SCHEMA context_engine_private FROM "${role}"`);
      expect(statements).toContain(`REVOKE ALL ON TABLE context_engine_private.knowledge_pages FROM "${role}"`);
    }
    expect(statements.some(sql => /public\."?(?:Warehouse|opportunities)|storage\./.test(sql))).toBe(false);
    expect(statements.find(sql => sql.startsWith('INSERT INTO'))).toContain('ON CONFLICT (id) DO NOTHING');
    expect(statements.join('\n')).not.toContain('Generic reference text.');
    expect(Object.keys(result).sort()).toEqual(['checksum_sha256', 'draft', 'inserted', 'pages', 'reviewed', 'unchanged', 'verified']);
  });

  it('reruns without overwriting identical pages and fails on any metadata/content difference', async () => {
    const { client, query } = fakeDatabase();
    const original = parseKnowledgeDocument(source());
    await migrateKnowledge(client, [original]);
    expect(await migrateKnowledge(client, [original])).toMatchObject({ inserted: 0, unchanged: 1 });
    const before = query.mock.calls.length;
    await expect(migrateKnowledge(client, [{ ...original, status: 'draft' }])).rejects.toThrow('EXISTING_PAGE_CONTENT_DIFFERS');
    const attempt = query.mock.calls.slice(before).map(([sql]) => sql);
    expect(attempt.at(-1)).toBe('ROLLBACK');
    expect(attempt.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE'))).toBe(false);
    expect(attempt).not.toContain('COMMIT');
  });

  it.each([
    [{ collision: true }, 'TARGET_SCHEMA_COLLISION'],
    [{ bypass: false }, 'IMPORT_ROLE_REQUIRES_RLS_BYPASS'],
  ])('refuses incompatible targets before any DDL or grant changes', async (options, code) => {
    const { client, query } = fakeDatabase(options);
    await expect(migrateKnowledge(client, [parseKnowledgeDocument(source())])).rejects.toThrow(code);
    expect(query.mock.calls.some(([sql]) => /^(?:CREATE|ALTER|REVOKE|INSERT)/.test(sql))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([
    [{ privacyFailure: true }, 'PRIVATE_PERMISSIONS_UNVERIFIED'],
    [{ corruptReadback: true }, 'IMPORT_READBACK_MISMATCH'],
  ])('rolls back atomically if privacy checks or exact readback fails', async (options, code) => {
    const { client, query } = fakeDatabase(options);
    await expect(migrateKnowledge(client, [parseKnowledgeDocument(source())])).rejects.toThrow(code);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });

  it('never includes raw database messages or failed-row content in its error', async () => {
    const query = vi.fn().mockRejectedValue(new Error('DETAIL: private page content and password'));
    await expect(migrateKnowledge({ query }, [parseKnowledgeDocument(source())])).rejects.toThrow(/^DATABASE_IMPORT_FAILED$/);
  });
});
