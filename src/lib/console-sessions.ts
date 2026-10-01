import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './errors';

type Session = { sid: string; exp: number };
const fingerprint = (sid: string) => createHash('sha256').update(sid).digest('hex');

/** Shared durable revocation; never cache an authorization decision per process. */
export async function requireActiveConsoleSession(client: PoolClient, session: Session) {
  const { rows } = await client.query(`SELECT session_hash FROM context_security_private.session_revocations
    WHERE session_hash = $1 AND expires_at > CURRENT_TIMESTAMP LIMIT 1`, [fingerprint(session.sid)]);
  if (rows.length) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
}

export async function revokeConsoleSession(client: PoolClient, session: Session) {
  await client.query(`INSERT INTO context_security_private.session_revocations (session_hash, expires_at)
    VALUES ($1, $2::timestamptz) ON CONFLICT (session_hash) DO NOTHING`,
  [fingerprint(session.sid), new Date(session.exp * 1000).toISOString()]);
  // Bound cleanup work. Expired cookies are rejected before a database lookup.
  await client.query(`DELETE FROM context_security_private.session_revocations WHERE session_hash IN
    (SELECT session_hash FROM context_security_private.session_revocations
      WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 100)`);
}
