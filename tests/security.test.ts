import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateKey, parseKeyRegistry, requireScope, resolvePrincipal,
  type KeyRegistration, type Scope,
} from '../src/lib/auth';
import { databaseOptions, withReadOnlyTransaction } from '../src/lib/db';
import { numericValue, sanitizeLabel } from '../src/lib/privacy';

const token = `wog_ctx_${'A'.repeat(43)}`;
const otherToken = `wog_ctx_${'B'.repeat(43)}`;
const now = Date.parse('2026-09-25T00:00:00.000Z');
const allScopes: Scope[] = ['knowledge:read', 'warehouses:read', 'crm:read'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function registration(overrides: Partial<KeyRegistration> = {}): KeyRegistration {
  return {
    id: 'employee-test', hash: digest(token), employeeEmail: 'employee@example.test',
    scopes: [...allScopes], expiresAt: '2026-09-26T00:00:00.000Z', ...overrides,
  };
}

function request(authorization?: string) {
  return new Request('https://context.example.test/api/v1/context', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function rosterClient(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as PoolClient, query };
}

const employee = {
  id: 7, email: 'Employee@Example.Test', is_active: true,
  dashboardAccess: true, adminAccess: false, twenty_user_id: '11111111-1111-4111-8111-111111111111',
};

describe('employee API credentials', () => {
  it('authenticates a matching hash without storing the bearer token in the registry', () => {
    const keys = parseKeyRegistry(JSON.stringify([registration({ employeeEmail: 'Employee@Example.Test' })]));
    expect(JSON.stringify(keys)).not.toContain(token);
    expect(authenticateKey(request(`Bearer ${token}`), keys, now)).toMatchObject({
      id: 'employee-test', employeeEmail: 'employee@example.test',
    });
  });

  it.each([
    undefined, '', 'Basic credentials', token, `Bearer ${otherToken}`, 'Bearer wog_ctx_short',
    `Bearer ${token} extra`,
  ])('rejects missing or invalid authorization %s', (authorization) => {
    expect(() => authenticateKey(request(authorization), [registration()], now)).toThrowError(
      expect.objectContaining({ status: 401, code: 'UNAUTHORIZED' }),
    );
  });

  it.each(['2026-09-24T00:00:00.000Z', '2026-09-25T00:00:00.000Z'])(
    'rejects credentials expired at %s, including the exact boundary', (expiresAt) => {
      expect(() => authenticateKey(request(`Bearer ${token}`), [registration({ expiresAt })], now))
        .toThrowError(expect.objectContaining({ status: 401 }));
    },
  );

  it('rejects a removed credential without looking up the employee', () => {
    expect(() => authenticateKey(request(`Bearer ${token}`), [], now))
      .toThrowError(expect.objectContaining({ status: 401 }));
  });

  it.each([
    [registration(), registration({ hash: digest(otherToken) })],
    [registration(), registration({ id: 'different-id' })],
  ])('fails closed on duplicate registry IDs or hashes', (...entries) => {
    expect(() => parseKeyRegistry(JSON.stringify(entries)))
      .toThrowError(expect.objectContaining({ status: 503, code: 'AUTH_CONFIGURATION' }));
  });

  it.each([
    'not-json', '{}', 'null',
    JSON.stringify([{ ...registration(), scopes: ['crm:read:all'] }]),
    JSON.stringify([{ ...registration(), hash: token }]),
    JSON.stringify([{ ...registration(), unexpectedAdmin: true }]),
  ])('rejects malformed registry configuration', (raw) => {
    expect(() => parseKeyRegistry(raw))
      .toThrowError(expect.objectContaining({ status: 503, code: 'AUTH_CONFIGURATION' }));
  });
});

describe('live employee permissions', () => {
  it('resolves a single active employee using only the fixed credential identity', async () => {
    const { client, query } = rosterClient([employee]);
    const principal = await resolvePrincipal(client, registration());
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('WHERE lower(email) = $1 LIMIT 2');
    expect(sql).not.toContain('employee@example.test');
    expect(sql).not.toMatch(/phone_number|contactNumber/);
    expect(values).toEqual(['employee@example.test']);
    expect(principal).toEqual({
      employeeId: 7, email: 'employee@example.test', scopes: allScopes, keyId: 'employee-test',
      twentyUserId: employee.twenty_user_id,
    });
  });

  it.each([
    [],
    [{ ...employee, is_active: false }],
    [employee, { ...employee, id: 8, email: 'employee@example.test' }],
  ])('rejects missing, inactive, or ambiguous employee identities', async (...rows) => {
    const { client } = rosterClient(rows);
    await expect(resolvePrincipal(client, registration()))
      .rejects.toMatchObject({ status: 403, code: 'EMPLOYEE_INACTIVE' });
  });

  it('removes warehouse and CRM scopes when the current roster permissions are absent', async () => {
    const { client } = rosterClient([{ ...employee, dashboardAccess: false, twenty_user_id: null }]);
    const principal = await resolvePrincipal(client, registration());
    expect(principal.scopes).toEqual(['knowledge:read']);
    expect(() => requireScope(principal, 'warehouses:read'))
      .toThrowError(expect.objectContaining({ status: 403, code: 'FORBIDDEN' }));
    expect(() => requireScope(principal, 'crm:read'))
      .toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => requireScope(principal, 'knowledge:read')).not.toThrow();
  });

  it('does not add scopes to a limited key when the employee is an administrator', async () => {
    const { client } = rosterClient([{ ...employee, adminAccess: true }]);
    const principal = await resolvePrincipal(client, registration({ scopes: ['knowledge:read'] }));
    expect(principal.scopes).toEqual(['knowledge:read']);
  });

  it('allows an explicitly granted warehouse scope for an admin without granting CRM access', async () => {
    const { client } = rosterClient([{
      ...employee, dashboardAccess: false, adminAccess: true, twenty_user_id: null,
    }]);
    const principal = await resolvePrincipal(client, registration());
    expect(principal.scopes).toEqual(['knowledge:read', 'warehouses:read']);
  });
  it('never grants privileges through an environment admin list or truthy source values', async () => {
    vi.stubEnv('ADMIN_EMAILS', employee.email);
    try {
      const { client } = rosterClient([{ ...employee, dashboardAccess: 'true', adminAccess: 1, twenty_user_id: 'malformed-twenty-id' }]);
      expect(await resolvePrincipal(client, registration())).toMatchObject({ scopes: ['knowledge:read'], twentyUserId: null });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('contact information boundaries', () => {
  it.each([
    '+91 9876543210', '98765 43210', '98.76.54.32.10', '9—8—7—6—5—4—3—2—1—0',
    '٩٨٧٦٥٤٣٢١٠', '९८७६५४३२१०', '９８７６５４３２１０', '98765\u200B43210',
    'nine eight seven six five four three two one zero',
    'sales@example.test', 'https://example.test', 'www.example.test', 'wa.me/9876543210',
    'mailto:sales@example.test', 'tel:1234', 'Contact me for details', 'Call us today',
    '<script>unsafe</script>', 'Line one\nline two',
  ])('withholds label containing contact data or unsafe text: %s', (value) => {
    expect(sanitizeLabel(value)).toBeNull();
  });

  it('retains ordinary labels and short business measurements', () => {
    expect(sanitizeLabel('  Bengaluru  ')).toBe('Bengaluru');
    expect(sanitizeLabel('40,000 sqft')).toBe('40,000 sqft');
    expect(sanitizeLabel('Phase 2')).toBe('Phase 2');
    expect(sanitizeLabel('Müller Logistics')).toBe('Müller Logistics');
    expect(sanitizeLabel(null)).toBeNull();
    expect(sanitizeLabel({ phone: '9876543210' })).toBeNull();
    expect(sanitizeLabel('x'.repeat(101))).toBeNull();
  });

  it.each([
    [40000, 40000], ['40,000', 40000], ['25.50', 25.5], [' 0 ', 0],
  ])('parses an unambiguous numeric measurement %s', (input, expected) => {
    expect(numericValue(input)).toBe(expected);
  });

  it.each(['20-25', '25 per month', '1e3', 'NaN', 'Infinity', '', '-1', '40,00', null, Infinity, -1])(
    'does not extract digits from ambiguous or invalid values: %s', (input) => {
      expect(numericValue(input)).toBeNull();
    },
  );
});

const poolUrl = 'postgresql://test_user:test_password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';

describe('Supabase transaction pool configuration', () => {
  it('defaults to one socket and strips URI overrides without disabling TLS verification', () => {
    const options = databaseOptions({
      NODE_ENV: 'test',
      DATABASE_URL: `${poolUrl}?sslmode=disable&sslcert=untrusted&connection_limit=99&statement_timeout=0`,
      PG_SSL_CA: 'certificate-line-one\\ncertificate-line-two',
    });
    expect(options.max).toBe(1);
    expect(options.min).toBe(0);
    expect(new URL(options.connectionString).search).toBe('');
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: 'certificate-line-one\ncertificate-line-two' });
    expect(options.statement_timeout).toBeLessThan(options.query_timeout);
    expect(options.idleTimeoutMillis).toBeGreaterThan(0);
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('allows at most two sockets per instance', () => {
    expect(databaseOptions({ NODE_ENV: 'test', DATABASE_URL: poolUrl, PG_POOL_MAX: '2' }).max).toBe(2);
  });

  it.each(['0', '3', '99', '-1', '1.5', 'NaN', 'Infinity', ''])('rejects pool max %s', (maximum) => {
    expect(() => databaseOptions({ NODE_ENV: 'test', DATABASE_URL: poolUrl, PG_POOL_MAX: maximum }))
      .toThrowError(expect.objectContaining({ status: 503, code: 'DATABASE_CONFIGURATION' }));
  });

  it.each([
    '', 'not-a-url',
    'postgresql://test_user:test_password@db.example.supabase.co:5432/postgres',
    poolUrl.replace(':6543/', ':5432/'),
    poolUrl.replace('pooler.supabase.com', 'pooler.supabase.com.attacker.test'),
    poolUrl.replace('postgresql:', 'https:'),
  ])('rejects nontransaction or untrusted database URLs', (url) => {
    expect(() => databaseOptions({ NODE_ENV: 'test', DATABASE_URL: url }))
      .toThrowError(expect.objectContaining({ status: 503, code: 'DATABASE_CONFIGURATION' }));
  });
});

function transactionPool(waitingCount = 0) {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  return { pool: { connect, waitingCount } as unknown as Pool, client, query, release, connect };
}

describe('read-only transaction lifecycle', () => {
  it('starts read-only, sets only transaction-local limits, and commits before releasing', async () => {
    const { pool, client, query, release } = transactionPool();
    const operation = vi.fn(async (connection: PoolClient) => {
      expect(connection).toBe(client);
      await connection.query('SELECT $1::integer AS value', [7]);
      return { value: 7 };
    });
    await expect(withReadOnlyTransaction(operation, pool)).resolves.toEqual({ value: 7 });
    const statements = query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe('BEGIN READ ONLY');
    expect(statements).toContain("SET LOCAL statement_timeout = '4000ms'");
    expect(statements).toContain("SET LOCAL lock_timeout = '1000ms'");
    expect(statements).toContain("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(query.mock.invocationCallOrder.at(-1)!);
  });

  it('rolls back an operation failure and preserves its original error', async () => {
    const { pool, query, release } = transactionPool();
    const failure = new Error('Test query failed');
    await expect(withReadOnlyTransaction(async () => { throw failure; }, pool)).rejects.toBe(failure);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('destroys the connection if rollback fails', async () => {
    const { pool, query, release } = transactionPool();
    query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('Connection lost');
      return { rows: [] };
    });
    const failure = new Error('Original failure');
    await expect(withReadOnlyTransaction(async () => { throw failure; }, pool)).rejects.toBe(failure);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not execute business reads when transaction setup fails', async () => {
    const { pool, query, release } = transactionPool();
    query.mockRejectedValueOnce(new Error('BEGIN failed'));
    const operation = vi.fn();
    await expect(withReadOnlyTransaction(operation, pool)).rejects.toThrow('BEGIN failed');
    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('attempts rollback and releases the connection after a failed commit', async () => {
    const { pool, query, release } = transactionPool();
    query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('COMMIT failed');
      return { rows: [] };
    });
    await expect(withReadOnlyTransaction(async () => 'read result', pool)).rejects.toThrow('COMMIT failed');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('refuses more queued work before requesting a connection', async () => {
    const { pool, connect } = transactionPool(4);
    const operation = vi.fn();
    await expect(withReadOnlyTransaction(operation, pool))
      .rejects.toMatchObject({ status: 503, code: 'DATABASE_BUSY' });
    expect(connect).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports connection acquisition failures without exposing driver messages', async () => {
    const { pool, connect, release } = transactionPool();
    connect.mockRejectedValue(new Error('Database password and hostname must not be exposed'));
    await expect(withReadOnlyTransaction(vi.fn(), pool))
      .rejects.toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The read source is temporarily unavailable.' });
    expect(release).not.toHaveBeenCalled();
  });
});
