/** Supabase holds only nonce hashes and short expiry timestamps, not employee sessions or tokens. */
import { getPool } from './db';
import type { Pool } from 'pg';
import { HttpError } from './errors';

export async function consumeRameshNonce(hash: string, expiresAt: Date, pool: Pool = getPool()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hash) || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 75_000) return false;
  if (pool.waitingCount >= 4) throw new HttpError(503, 'RAMESH_AUTH_BUSY', 'Ramesh authentication is busy.');
  const db = await pool.connect().catch(() => { throw new HttpError(503, 'RAMESH_AUTH_UNAVAILABLE', 'Ramesh authentication is unavailable.'); });
  let destroy = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='4000ms'");
    await db.query("SET LOCAL lock_timeout='1000ms'");
    // Cleanup has one short-lived owner. Row-locking SELECT would require UPDATE
    // privileges, which this runtime deliberately does not have on replay records.
    const cleanup = await db.query('SELECT pg_try_advisory_xact_lock(195332, 1003) AS locked');
    if (cleanup.rows[0]?.locked) await db.query(`DELETE FROM context_ramesh_private.request_nonces WHERE hash IN (
      SELECT hash FROM context_ramesh_private.request_nonces WHERE expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at LIMIT 1000)`);
    const result = await db.query(`INSERT INTO context_ramesh_private.request_nonces (hash, expires_at)
      VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING hash`, [hash, expiresAt]);
    await db.query('COMMIT');
    return result.rowCount === 1;
  } catch {
    try { await db.query('ROLLBACK'); } catch { destroy = true; }
    throw new HttpError(503, 'RAMESH_AUTH_UNAVAILABLE', 'Ramesh authentication is unavailable.');
  } finally { db.release(destroy); }
}
