import { Pool, type PoolClient } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { HttpError } from './errors';

const globalDatabase = globalThis as unknown as { contextPool?: Pool };

export function databaseOptions(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ''); }
  catch { throw new HttpError(503, 'DATABASE_CONFIGURATION', 'Database connection is not configured.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') {
    throw new HttpError(503, 'DATABASE_CONFIGURATION', 'A Supabase transaction-pooler connection on port 6543 is required.');
  }
  const max = Number(env.PG_POOL_MAX ?? '1');
  if (!Number.isInteger(max) || max < 1 || max > 2) {
    throw new HttpError(503, 'DATABASE_CONFIGURATION', 'PG_POOL_MAX must be 1 or 2.');
  }
  // Do not let URI parameters override verified TLS or connection budgets.
  // Prisma-specific pgbouncer/connection_limit parameters do not configure pg.
  url.search = '';
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
    // Reuse the same bounded pooler connection across model-thinking gaps.
    // COMMIT releases the upstream database transaction even while this client
    // socket stays warm. Checkout/connection establishment remains bounded.
    max, min: 0, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    maxLifetimeSeconds: 300, allowExitOnIdle: true,
    application_name: 'wareongo-context-readonly',
    statement_timeout: 4_000, query_timeout: 5_000,
  };
}

export function getPool(): Pool {
  if (!globalDatabase.contextPool) {
    const pool = new Pool(databaseOptions());
    pool.on('error', () => console.error(JSON.stringify({ event: 'context_database_idle_error' })));
    if (process.env.VERCEL) attachDatabasePool(pool);
    globalDatabase.contextPool = pool;
  }
  return globalDatabase.contextPool;
}

/** All business reads and roster checks use one bounded transaction/client.
 * No session-level SETs, migrations, named prepared statements, or per-source pools.
 */
export async function withReadOnlyTransaction<T>(
  operation: (client: PoolClient) => Promise<T>, pool: Pool = getPool(),
): Promise<T> {
  return withTransaction(operation, pool, true);
}

/** Console mutations only. Staged schema changes must be applied deliberately
 * before enabling this path; business warehouse/CRM endpoints stay read-only. */
export async function withConsoleWriteTransaction<T>(
  operation: (client: PoolClient) => Promise<T>, pool?: Pool,
): Promise<T> {
  if (process.env.CONTEXT_CONSOLE_WRITES_ENABLED !== 'true') throw new HttpError(503, 'CONSOLE_SETUP_REQUIRED', 'Console storage is not enabled yet.');
  return withTransaction(operation, pool ?? getPool(), false);
}

async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>, pool: Pool, readOnly: boolean): Promise<T> {
  if (pool.waitingCount >= 4) {
    throw new HttpError(503, 'DATABASE_BUSY', 'The read service is busy. Retry shortly.');
  }
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch {
    // Counts distinguish a saturated local pool from a failed cold connection;
    // never include URLs, raw driver errors, credentials, or SQL in telemetry.
    console.error(JSON.stringify({ event: 'context_database_acquire_failed',
      total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }));
    throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'The read source is temporarily unavailable.');
  }
  let destroy = false;
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally { client.release(destroy); }
}
