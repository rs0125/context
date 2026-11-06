import { DatabaseError, Pool, type PoolClient } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { HttpError } from './errors';

const globalDatabase = globalThis as unknown as { callPerformancePool?: Pool };
function logSourceError(phase: 'connect' | 'transaction' | 'rollback' | 'idle', error: unknown) {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const sqlstate = error instanceof DatabaseError && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const transportCode = typeof code === 'string'
    && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code) ? code : undefined;
  const category = error instanceof DatabaseError ? 'database' : transportCode ? 'connection'
    : error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError
      ? 'programming' : 'unknown';
  // Codes and fixed categories only: driver messages, details and stacks can contain source data or credentials.
  console.error(JSON.stringify({ event: 'call_reporting_error', phase, category, sqlstate, transportCode }));
}
export function callDatabaseOptions(env: Record<string, string | undefined> = process.env) {
  let url: URL;
  try { url = new URL(env.CONTEXT_CALLS_DATABASE_URL ?? ''); }
  catch { throw new HttpError(503, 'CALLS_CONFIGURATION', 'The call reporting source is not configured.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.pooler.supabase.com')
    || url.port !== '6543' || !/^call_performance_reader(?:\.[a-z0-9]+)?$/.test(decodeURIComponent(url.username))) {
    throw new HttpError(503, 'CALLS_CONFIGURATION', 'Call reporting requires its dedicated Supabase transaction-pooler reader.');
  }
  url.search = '';
  return {
    connectionString: url.toString(), ssl: { rejectUnauthorized: true,
      ...(env.CONTEXT_CALLS_SSL_CA ? { ca: env.CONTEXT_CALLS_SSL_CA.replace(/\\n/g, '\n') } : {}) },
    max: 1, min: 0, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    maxLifetimeSeconds: 300, allowExitOnIdle: true, statement_timeout: 4000, query_timeout: 5000,
    application_name: 'context-call-performance',
  };
}
function getCallPool() {
  if (!globalDatabase.callPerformancePool) {
    const pool = new Pool(callDatabaseOptions());
    pool.on('error', error => logSourceError('idle', error));
    if (process.env.VERCEL) attachDatabasePool(pool);
    globalDatabase.callPerformancePool = pool;
  }
  return globalDatabase.callPerformancePool;
}
export async function withCallRead<T>(work: (client: PoolClient) => Promise<T>, pool: Pool = getCallPool()): Promise<T> {
  if (pool.waitingCount >= 4) throw new HttpError(503, 'CALLS_BUSY', 'Call reporting is busy. Retry shortly.');
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) {
    logSourceError('connect', error);
    throw new HttpError(503, 'CALLS_SOURCE_UNAVAILABLE', 'The call reporting source is unavailable.');
  }
  let destroy = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const role = (await client.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships
      FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if (!role || role.rolname !== 'call_performance_reader'
      || [role.rolsuper,role.rolbypassrls,role.rolcreaterole,role.rolcreatedb,role.rolreplication,role.memberships].some(flag => flag !== false)) {
      throw new HttpError(503, 'CALLS_CONFIGURATION', 'The call reporting reader is not configured safely.');
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { destroy = true; logSourceError('rollback', rollbackError); }
    if (error instanceof HttpError) throw error;
    logSourceError('transaction', error);
    throw new HttpError(503, 'CALLS_SOURCE_UNAVAILABLE', 'The call reporting source is unavailable.');
  } finally { client.release(destroy); }
}
