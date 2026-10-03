import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/migrate-gmail.mjs';
const { migrateGmailStorage, runGmailMigration } = await import(modulePath);
const runtimeModulePath = '../scripts/provision-runtime-role.mjs';
const { RUNTIME_TABLES } = await import(runtimeModulePath);
type Row = Record<string, unknown>;
type Options = { collision?: boolean; bypass?: boolean; locked?: boolean; privacy?: boolean; runtime?: boolean;
  runtimeUnsafe?: boolean; unsafeGrant?: boolean; unexpectedPolicy?: boolean; foreignTrigger?: boolean; changedConstraint?: boolean };

function database(options: Options = {}) {
  let schemaCreated = false;
  const markers = new Map<string, string>(), policies = new Set<string>();
  const definitions = new Map<string, string>();
  const columns: Record<string, string[][]> = {
    connections: [['id', 'uuid'], ['employee_id', 'integer'], ['employee_email', 'text'], ['google_sub', 'text'],
      ['account_email', 'text'], ['encrypted_refresh_token', 'text'], ['granted_scopes', 'text[]'], ['version', 'integer'],
      ['status', 'text'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']],
    draft_operations: [['employee_id', 'integer'], ['employee_email', 'text'], ['operation_id', 'uuid'], ['connection_id', 'uuid'],
      ['connection_version', 'integer'], ['request_hash', 'text'], ['encrypted_content', 'text'], ['state', 'text'],
      ['draft_id', 'text'], ['message_id', 'text'], ['reason', 'text'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']],
  };
  const nullable = ['encrypted_refresh_token', 'encrypted_content', 'draft_id', 'message_id', 'reason'];
  const tableName = (oid: unknown) => oid === 10 ? 'connections' : 'draft_operations';
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: options.locked !== false }] };
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: options.bypass !== false }] };
    if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: options.collision || schemaCreated
      ? [{ oid: 1, owned: true, marker: options.collision ? 'unrelated-schema' : 'context-gmail-schema-v1' }] : [] };
    if (sql.startsWith('CREATE SCHEMA')) schemaCreated = true;
    if (sql.startsWith('CREATE TABLE')) {
      const name = /CREATE TABLE context_gmail_private\.(\w+)/.exec(sql)![1]; definitions.set(name, sql);
    }
    if (sql.startsWith('COMMENT ON TABLE')) {
      const [, name, marker] = /COMMENT ON TABLE context_gmail_private\.(\w+) IS '([^']+)'/.exec(sql)!;
      markers.set(name, marker);
    }
    if (sql.includes('AS relations')) return { rows: [{ relations: 0, routines: 0 }] };
    if (sql.includes('FROM pg_class c JOIN pg_namespace n') && sql.includes('c.relname = $2')) {
      const name = String(values[1]);
      return { rows: [{ oid: name === 'connections' ? 10 : 11, relkind: 'r', relpersistence: 'p', relispartition: false,
        owned: true, relrowsecurity: true, relforcerowsecurity: true, marker: markers.get(name) ?? null }] };
    }
    if (sql.includes('FROM pg_attribute a')) return { rows: columns[tableName(values[0])].map(([name, type]) => ({
      name, type, not_null: !nullable.includes(name), identity: '', generated: '', dropped: false,
      default_expression: ['created_at', 'updated_at'].includes(name) ? 'CURRENT_TIMESTAMP' : null,
    })) };
    if (sql.includes('FROM pg_constraint')) {
      const name = tableName(values[0]);
      const rows: Row[] = [{ name: `${name}_pkey`, type: 'p', validated: true, definition: 'PRIMARY KEY' }];
      if (name === 'connections') rows.push(...['connections_employee_id_key', 'connections_id_employee_id_key'].map(name => ({
        name, type: 'u', validated: true, definition: 'UNIQUE',
      })));
      for (const match of definitions.get(name)!.matchAll(/CONSTRAINT (\w+) (CHECK|FOREIGN KEY)([^\n]+)/g)) {
        rows.push({ name: match[1], type: match[2] === 'CHECK' ? 'c' : 'f', validated: true,
          definition: options.changedConstraint && match[1] === 'connections_status_check' ? 'CHECK (true)' : match[0] });
      }
      return { rows: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
    }
    if (sql.includes('AS policies')) return { rows: [{ policies: options.unexpectedPolicy ? 1 : 0, triggers: options.foreignTrigger ? 1 : 0, rules: 0, inheritance: 0 }] };
    if (sql.startsWith('SELECT rolname')) return { rows: ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname })) };
    if (sql.includes('FROM pg_roles r WHERE rolname = $1')) return { rows: options.runtime === false ? [] : [{ oid: 20,
      rolsuper: options.runtimeUnsafe === true, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: false }] };
    if (sql.startsWith('SELECT polname')) return { rows: policies.has(String(values[0])) ? [{ polname: 'context_runtime' }] : [] };
    if (sql.startsWith('CREATE POLICY')) policies.add(/ON (context_gmail_private\.\w+)/.exec(sql)![1]);
    if (sql.includes('AS no_api_role_access')) return { rows: [{ no_public_schema: true, no_public_table: true, no_api_role_access: options.privacy !== false }] };
    if (sql.includes('AS tables_safe')) return { rows: [{ schema_safe: true, tables_safe: options.unsafeGrant !== true }] };
    return { rows: [] };
  });
  return { client: { query }, query, options, policies };
}

describe('Gmail private storage migration', () => {
  it('includes only integration-state writes in fresh runtime-role provisioning', () => {
    expect(RUNTIME_TABLES.filter(([name]: string[]) => name.startsWith('context_gmail_private.'))).toEqual([
      ['context_gmail_private.connections', 'SELECT, INSERT, UPDATE'],
      ['context_gmail_private.draft_operations', 'SELECT, INSERT, UPDATE'],
    ]);
    for (const [name, privileges] of RUNTIME_TABLES as string[][]) {
      if (name.startsWith('public.')) expect(privileges).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/);
    }
  });
  it('defaults to a staged plan without loading credentials or opening a connection', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = vi.spyOn(pg, 'Pool');
    try {
      await runGmailMigration(['--env-file', '/nonexistent-gmail-env']);
      expect(pool).not.toHaveBeenCalled();
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({ staged: true, applied: false, requiresExplicitApply: true, schema: 'context_gmail_private' });
    } finally { log.mockRestore(); pool.mockRestore(); }
  });

  it('creates empty forced-RLS tables and narrowly grants only the safe runtime role', async () => {
    const db = database();
    expect(await migrateGmailStorage(db.client)).toEqual({ applied: true, verified: true, seededConnections: 0, runtimeGranted: true });
    const sql = db.query.mock.calls.map(([statement]) => statement);
    expect(sql[0]).toBe('BEGIN'); expect(sql.at(-1)).toBe('COMMIT');
    for (const table of ['connections', 'draft_operations']) {
      expect(sql).toContain(`ALTER TABLE context_gmail_private.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE context_gmail_private.${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE ON TABLE context_gmail_private.${table} TO context_engine_runtime`);
      expect(sql).toContain(`CREATE POLICY context_runtime ON context_gmail_private.${table} FOR ALL TO context_engine_runtime USING (true) WITH CHECK (true)`);
      for (const role of ['PUBLIC', '"anon"', '"authenticated"', '"service_role"']) {
        expect(sql).toContain(`REVOKE ALL ON SCHEMA context_gmail_private FROM ${role}`);
        expect(sql).toContain(`REVOKE ALL ON TABLE context_gmail_private.${table} FROM ${role}`);
      }
    }
    const joined = sql.join('\n');
    expect(joined).toContain('PRIMARY KEY (employee_id, operation_id)');
    expect(joined).toContain('FOREIGN KEY (connection_id, employee_id)');
    expect(joined).toContain("state IN ('dispatching', 'created', 'unknown', 'rejected')");
    expect(joined).not.toMatch(/(?:INSERT INTO|UPDATE |DELETE FROM) public\.|GRANT ALL|GRANT .*DELETE|GRANT .*TO (?:PUBLIC|anon|authenticated|service_role)/);
  });

  it('is rerunnable without changing credentials, existing operation state, or policy definitions', async () => {
    const db = database();
    await migrateGmailStorage(db.client);
    db.query.mockClear();
    expect(await migrateGmailStorage(db.client)).toMatchObject({ verified: true, runtimeGranted: true });
    const statements = db.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).not.toMatch(/^(?:CREATE TABLE|CREATE SCHEMA|CREATE POLICY|INSERT INTO|UPDATE |DELETE FROM)/m);
    expect(statements).toContain('LOCK TABLE context_gmail_private.connections, context_gmail_private.draft_operations');
  });

  it('leaves forced RLS closed when a runtime role has not been provisioned', async () => {
    const db = database({ runtime: false });
    expect(await migrateGmailStorage(db.client)).toMatchObject({ runtimeGranted: false });
    expect(db.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/CREATE POLICY|GRANT /);
  });

  it.each([
    [{ collision: true }, 'GMAIL_SCHEMA_COLLISION'], [{ bypass: false }, 'GMAIL_ROLE_REQUIRES_RLS_BYPASS'], [{ locked: false }, 'GMAIL_MIGRATION_BUSY'],
  ] as const)('rejects unsafe migration targets before any DDL (%j)', async (options, code) => {
    const db = database(options);
    await expect(migrateGmailStorage(db.client)).rejects.toThrow(code);
    expect(db.query.mock.calls.some(([sql]) => /^(CREATE|ALTER|REVOKE|GRANT)/.test(sql))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([
    [{ privacy: false }, 'GMAIL_PRIVACY_UNVERIFIED'], [{ runtimeUnsafe: true }, 'GMAIL_RUNTIME_ROLE_UNSAFE'],
    [{ unsafeGrant: true }, 'GMAIL_RUNTIME_GRANTS_UNSAFE'], [{ unexpectedPolicy: true }, 'GMAIL_RELATION_INCOMPATIBLE'],
    [{ foreignTrigger: true }, 'GMAIL_RELATION_INCOMPATIBLE'],
  ] as const)('rolls back if RLS, runtime permissions or privacy cannot be verified (%j)', async (options, code) => {
    const db = database(options);
    await expect(migrateGmailStorage(db.client)).rejects.toThrow(code);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });

  it('detects a replaced constraint despite an unchanged name and schema marker', async () => {
    const db = database();
    await migrateGmailStorage(db.client);
    db.options.changedConstraint = true; db.query.mockClear();
    await expect(migrateGmailStorage(db.client)).rejects.toThrow('GMAIL_RELATION_COLLISION');
    expect(db.query.mock.calls.some(([sql]) => /^(ALTER|REVOKE|GRANT)/.test(sql))).toBe(false);
  });

  it('sanitizes unexpected driver errors that might contain encrypted values or credentials', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory')) throw new Error('password=secret and SQL details');
      return { rows: [] };
    });
    await expect(migrateGmailStorage({ query })).rejects.toThrow('GMAIL_MIGRATION_FAILED');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
