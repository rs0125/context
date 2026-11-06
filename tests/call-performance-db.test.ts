import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callDatabaseOptions, withCallRead } from '../src/lib/call-performance-db';

const url = 'postgresql://call_performance_reader.project:synthetic@aws-0-example.pooler.supabase.com:6543/postgres';
const safeRole = { rolname: 'call_performance_reader', rolsuper: false, rolbypassrls: false, rolcreaterole: false,
  rolcreatedb: false, rolreplication: false, memberships: false };
function poolFixture(role = safeRole) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM pg_roles') ? [role] : [] }));
  const release = vi.fn();
  return { query, release, pool: { waitingCount: 0, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool };
}
describe('dedicated call-source database reader', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses verified TLS and bounded pooling; URL parameters cannot override them', () => {
    const options = callDatabaseOptions({ CONTEXT_CALLS_DATABASE_URL: `${url}?sslmode=disable&options=-c%20statement_timeout%3D0`, CONTEXT_CALLS_SSL_CA: 'public\\nanchor' });
    expect(options.connectionString).toBe(url);
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: 'public\nanchor' });
    expect(options.max).toBe(1);
    expect(options.statement_timeout).toBe(4000);
  });
  it.each([undefined, url.replace('call_performance_reader.project', 'postgres.project'), url.replace(':6543', ':5432'),
    url.replace('aws-0-example.pooler.supabase.com', 'other.example')])('refuses fallback or inappropriate connection %s', value => {
    expect(() => callDatabaseOptions({ CONTEXT_CALLS_DATABASE_URL: value, DATABASE_URL: url })).toThrowError(expect.objectContaining({ code: 'CALLS_CONFIGURATION' }));
  });
  it('runs reads in a repeatable-read read-only transaction and releases its client', async () => {
    const h = poolFixture();
    expect(await withCallRead(async () => 'report', h.pool)).toBe('report');
    expect(h.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each(['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'memberships', 'wrong_role'])('rejects unsafe role condition %s before reading', async flag => {
    const role = { ...safeRole, ...(flag === 'wrong_role' ? { rolname: 'postgres' } : { [flag]: true }) };
    const h = poolFixture(role), work = vi.fn(async (_client: PoolClient) => 'secret');
    await expect(withCallRead(work, h.pool)).rejects.toMatchObject({ code: 'CALLS_CONFIGURATION' });
    expect(work).not.toHaveBeenCalled();
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([
    { label: 'PostgreSQL error', error: Object.assign(new DatabaseError('private database message', 0, 'error'),
      { code: '42P01', detail: 'private row', internalQuery: 'private SQL', stack: 'private stack' }),
      diagnostic: { category: 'database', sqlstate: '42P01' } },
    { label: 'malformed SQLSTATE', error: Object.assign(new DatabaseError('private database message', 0, 'error'),
      { code: 'private code' }), diagnostic: { category: 'database' } },
    { label: 'connection error', error: Object.assign(new Error('private host'), { code: 'ECONNRESET' }),
      diagnostic: { category: 'connection', transportCode: 'ECONNRESET' } },
    { label: 'programming error', error: new TypeError('private row'), diagnostic: { category: 'programming' } },
    { label: 'untrusted error fields', error: Object.assign(new Error('private connection and row details'),
      { name: 'private name', code: 'private code', detail: 'private row' }), diagnostic: { category: 'unknown' } },
    { label: 'non-error throw', error: 'private thrown value', diagnostic: { category: 'unknown' } },
  ])('records safe diagnostics for $label while masking the public response', async ({ error, diagnostic }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = poolFixture();
    await expect(withCallRead(async () => { throw error; }, h.pool))
      .rejects.toMatchObject({ code: 'CALLS_SOURCE_UNAVAILABLE', message: 'The call reporting source is unavailable.' });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'call_reporting_error', phase: 'transaction', ...diagnostic });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(h.release).toHaveBeenCalledOnce();
  });
  it('reports acquisition failures without exposing the connection string', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = poolFixture();
    vi.mocked(h.pool.connect).mockRejectedValueOnce(Object.assign(new Error('postgresql://private:secret@host/database'), { code: 'ECONNREFUSED' }));
    const work = vi.fn(async () => 'report');
    await expect(withCallRead(work, h.pool)).rejects.toMatchObject({ code: 'CALLS_SOURCE_UNAVAILABLE' });
    expect(work).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
      { event: 'call_reporting_error', phase: 'connect', category: 'connection', transportCode: 'ECONNREFUSED' },
    ]);
  });
  it('reports a failed rollback separately and discards the broken client', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = poolFixture();
    await expect(withCallRead(async () => {
      h.query.mockRejectedValueOnce(Object.assign(new Error('private rollback details'), { code: 'EPIPE' }));
      throw new TypeError('private row');
    }, h.pool)).rejects.toMatchObject({ code: 'CALLS_SOURCE_UNAVAILABLE' });
    expect(h.release).toHaveBeenCalledWith(true);
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
      { event: 'call_reporting_error', phase: 'rollback', category: 'connection', transportCode: 'EPIPE' },
      { event: 'call_reporting_error', phase: 'transaction', category: 'programming' },
    ]);
  });
  it('bounds acquisition under saturation', async () => {
    const h = poolFixture();
    Object.assign(h.pool, { waitingCount: 4 });
    await expect(withCallRead(async () => 'report', h.pool)).rejects.toMatchObject({ code: 'CALLS_BUSY' });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});
