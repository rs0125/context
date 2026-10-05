import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const consoleModule = '../scripts/migrate-console.mjs';
const mcpModule = '../scripts/migrate-mcp-oauth.mjs';
const scopesModule = '../scripts/credential-scope-sql.mjs';
const { migrateConsoleStorage } = await import(consoleModule);
const { migrateMcpOAuthStorage } = await import(mcpModule);
const { CREDENTIAL_SCOPE_CHECK, CONSOLE_CREDENTIAL_SCOPE_CHECK } = await import(scopesModule);

const columns = {
  employee_api_keys: [['id', 'text'], ['employee_id', 'integer'], ['employee_email', 'text'], ['token_hash', 'text'], ['encrypted_token', 'text'], ['scopes', 'text[]'], ['expires_at', 'timestamp with time zone'], ['created_at', 'timestamp with time zone']],
  oauth_clients: [['id', 'text'], ['name', 'text'], ['redirect_uris', 'text[]'], ['scopes', 'text[]'], ['created_at', 'timestamp with time zone']],
  oauth_grants: [['id', 'uuid'], ['client_id', 'text'], ['key_id', 'text'], ['key_hash', 'text'], ['key_source', 'text'], ['employee_id', 'integer'], ['employee_email', 'text'], ['scopes', 'text[]'], ['resource', 'text'], ['expires_at', 'timestamp with time zone'], ['consent_hash', 'text'], ['created_at', 'timestamp with time zone'], ['revoked_at', 'timestamp with time zone']],
  oauth_codes: [['hash', 'text'], ['grant_id', 'uuid'], ['challenge', 'text'], ['redirect_uri', 'text'], ['expires_at', 'timestamp with time zone'], ['created_at', 'timestamp with time zone'], ['used_at', 'timestamp with time zone']],
  oauth_tokens: [['hash', 'text'], ['grant_id', 'uuid'], ['kind', 'text'], ['expires_at', 'timestamp with time zone'], ['created_at', 'timestamp with time zone'], ['used_at', 'timestamp with time zone']],
};
type CatalogTable = {
  oid: number; name: string; marker: string;
  columns: Record<string, unknown>[];
  constraints: { name: string; type: string; validated: boolean; definition: string }[];
  indexes: { definition: string; valid: boolean; ready: boolean }[];
};

function existingCatalog(kind: 'console' | 'mcp', options: { wrongSignature?: boolean; privacy?: boolean; analytics?: boolean; gis?: boolean; mail?: boolean; rfq?: boolean; allPrevious?: boolean } = {}) {
  const schema = kind === 'console' ? 'context_auth_private' : 'context_mcp_private';
  const schemaMarker = kind === 'console' ? 'context-console-auth-schema-v1' : 'context-mcp-oauth-schema-v1';
  const tableMarker = kind === 'console' ? 'context-console-employee-keys-v1:' : 'context-mcp-oauth-table-v1:';
  const signature = (table: CatalogTable) => createHash('sha256').update(JSON.stringify({
    columns: table.columns, constraints: table.constraints, ...(kind === 'mcp' ? { indexes: table.indexes } : {}),
  })).digest('hex');
  const oldScopeCheck = options.allPrevious
    ? "CHECK (cardinality(scopes) BETWEEN 1 AND 7 AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'gis:write', 'mail:drafts', 'crm.rfq:write']::text[])"
    : options.mail || options.rfq
    ? `CHECK (cardinality(scopes) BETWEEN 1 AND 6 AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'gis:write', '${options.mail ? 'mail:drafts' : 'crm.rfq:write'}']::text[])`
    : options.gis
    ? "CHECK (cardinality(scopes) BETWEEN 1 AND 5 AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'gis:write']::text[])"
    : options.analytics
    ? "CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read']::text[])"
    : "CHECK (cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read']::text[])";
  const catalog = Object.entries(columns).filter(([name]) => kind === 'console' ? name === 'employee_api_keys' : name.startsWith('oauth_')).map(([name, fields], index) => {
    const suffixes = kind === 'console'
      ? ['pkey', 'employee_id_key', 'token_hash_key', 'id_check', 'employee_check', 'email_check', 'hash_check', 'cipher_check', 'expiry_check', 'scopes_check']
      : ['pkey', ...(['oauth_clients', 'oauth_grants'].includes(name) ? ['scopes_check'] : [])];
    const table: CatalogTable = {
      oid: index + 10, name, marker: '',
      columns: fields.map(([name, type]) => ({ name, type, not_null: !['used_at', 'revoked_at'].includes(name), identity: '', generated: '', dropped: false, default_expression: name === 'created_at' ? 'CURRENT_TIMESTAMP' : null })),
      constraints: suffixes.map(suffix => ({ name: `${name}_${suffix}`, validated: true,
        type: suffix === 'pkey' ? 'p' : suffix.endsWith('_key') ? 'u' : 'c', definition: suffix === 'scopes_check' ? oldScopeCheck : suffix })),
      indexes: [{ definition: `CREATE UNIQUE INDEX ${name}_pkey`, valid: true, ready: true }],
    };
    table.marker = tableMarker + signature(table);
    return table;
  });
  if (options.wrongSignature) catalog[0].marker += 'tampered';
  const queries = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: true }] };
    if (sql.includes("obj_description(n.oid, 'pg_namespace')")) return { rows: [{ oid: 1, owned: true, marker: schemaMarker }] };
    if (sql.includes('AS relations')) return { rows: [{ relations: 0, routines: 0 }] };
    if (sql.includes('FROM pg_class c JOIN')) {
      const table = kind === 'console' ? catalog[0] : catalog.find(table => table.name === values[1])!;
      return { rows: [{ oid: table.oid, owned: true, relkind: 'r', relpersistence: 'p', relispartition: false, relrowsecurity: true, relforcerowsecurity: true, marker: table.marker }] };
    }
    if (sql.includes('FROM pg_attribute a')) return { rows: structuredClone(catalog.find(table => table.oid === values[0])!.columns) };
    if (sql.includes('FROM pg_constraint')) return { rows: structuredClone(catalog.find(table => table.oid === values[0])!.constraints) };
    if (sql.includes('FROM pg_index')) return { rows: structuredClone(catalog.find(table => table.oid === values[0])!.indexes) };
    if (sql.includes('AS inheritance')) return { rows: [{ policies: 0, triggers: 0, rules: 0, inheritance: 0 }] };
    if (sql.startsWith('ALTER TABLE') && sql.includes('DROP CONSTRAINT')) {
      const table = catalog.find(table => sql.startsWith(`ALTER TABLE ${schema}.${table.name}`))!;
      table.constraints.find(constraint => constraint.name === `${table.name}_scopes_check`)!.definition = `CHECK (${kind === 'console' ? CONSOLE_CREDENTIAL_SCOPE_CHECK : CREDENTIAL_SCOPE_CHECK})`;
    }
    if (sql.startsWith('COMMENT ON TABLE')) {
      const table = catalog.find(table => sql.startsWith(`COMMENT ON TABLE ${schema}.${table.name}`))!;
      const marker = / IS '([^']+)'$/.exec(sql)?.[1];
      expect(marker).toBe(tableMarker + signature(table));
      table.marker = marker!;
    }
    if (sql.startsWith('SELECT rolname')) return { rows: [{ rolname: 'anon' }, { rolname: 'authenticated' }, { rolname: 'service_role' }] };
    if (sql.includes('AS no_api_role_access')) return { rows: [{ no_public_schema: true, no_public_table: true, no_api_role_access: options.privacy !== false }] };
    return { rows: [] };
  });
  return { client: { query: queries }, queries, catalog };
}

describe.each([
  { kind: 'console' as const, migrate: migrateConsoleStorage, upgraded: ['employee_api_keys'] },
  { kind: 'mcp' as const, migrate: migrateMcpOAuthStorage, upgraded: ['oauth_clients', 'oauth_grants'] },
])('$kind credential scope migration', ({ kind, migrate, upgraded }) => {
  it.each([{ analytics: false }, { analytics: true }, { gis: true }, { mail: true }, { rfq: true }, { allPrevious: true }])('upgrades only verified locked constraints, preserving rows and idempotency (%j)', async previous => {
    const { client, queries, catalog } = existingCatalog(kind, previous);
    await migrate(client);
    const statements = queries.mock.calls.map(([sql]) => sql);
    const alterations = statements.filter(sql => sql.startsWith('ALTER TABLE'));
    expect(alterations).toHaveLength(upgraded.length);
    for (const name of upgraded) {
      const alteration = alterations.find(sql => sql.includes(`.${name}`))!;
      expect(alteration).toContain('BETWEEN 1 AND 10');
      expect(alteration).toContain('cms:read');
      expect(alteration).toContain('cms:write');
      expect(alteration).toContain("'gis:write'");
      expect(alteration).toContain("'mail:drafts'");
      expect(alteration).toContain("'crm.rfq:write'");
      expect(alteration).toContain("'crm.notes:write'");
      expect(alteration).toContain("'analytics:read'");
      expect(statements.findIndex(sql => sql.startsWith('LOCK TABLE'))).toBeLessThan(statements.indexOf(alteration));
      expect(catalog.find(table => table.name === name)!.constraints.find(constraint => constraint.name === `${name}_scopes_check`)!.definition).toContain('array_position(scopes, NULL) IS NULL');
    }
    expect(statements.join('\n')).not.toMatch(/public\.|context_engine_private|INSERT INTO|UPDATE |DELETE FROM|CREATE POLICY/);
    expect(statements.at(-1)).toBe('COMMIT');
    queries.mockClear();
    await migrate(client);
    expect(queries.mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(false);
    expect(queries.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('refuses a changed table signature before changing constraints', async () => {
    const { client, queries } = existingCatalog(kind, { wrongSignature: true });
    await expect(migrate(client)).rejects.toThrow(`${kind === 'console' ? 'CONSOLE' : 'MCP'}_RELATION_COLLISION`);
    expect(queries.mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(false);
    expect(queries.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rolls the upgrade back when private storage verification fails', async () => {
    const { client, queries } = existingCatalog(kind, { privacy: false });
    await expect(migrate(client)).rejects.toThrow(`${kind === 'console' ? 'CONSOLE' : 'MCP'}_PRIVACY_UNVERIFIED`);
    expect(queries.mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(true);
    expect(queries.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(queries.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
