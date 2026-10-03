import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleCookie, createConsoleSession, readSignedConsoleValue, type ConsoleIdentity } from '../src/lib/console-auth';
import { handleGmailCallback, handleGmailConnect, handleGmailDisconnect } from '../src/lib/gmail-oauth';
import { completeGmailDisconnect, disconnectGmailConnection, saveGmailConnection } from '../src/lib/gmail-storage';

const origin = 'https://context.example.test', email = 'employee@wareongo.com', googleSub = '107654321012345678901';
const scope = 'https://www.googleapis.com/auth/gmail.compose';
const owner = { employeeId: 7, employeeEmail: email };
type Row = Record<string, unknown>;

/** Execute the real storage functions. Only the SQL transport is synthetic;
 * callback preflight, commit ordering and expected-version checks are real. */
function database() {
  const rows: Row[] = [];
  const roster = { id: 7, email, name: 'Employee', is_active: true, adminAccess: false, dashboardAccess: true, twenty_user_id: null };
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> => {
    if (sql.includes('session_revocations') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('VerifiedNumber')) return { rows: [roster] };
    if (sql.startsWith('SELECT') && sql.includes('FROM context_gmail_private.connections')) return { rows: rows.map(row => ({ ...row })) };
    if (sql.startsWith('INSERT INTO context_gmail_private.connections')) {
      const [id, employee_id, employee_email] = values;
      const row = { id, employee_id, employee_email,
        ...(values.length === 3
          ? { google_sub: null, account_email: employee_email, encrypted_refresh_token: null, granted_scopes: [], version: 1, status: 'disconnected' }
          : values.length === 7 ? { google_sub: values[3], account_email: employee_email, encrypted_refresh_token: values[4], granted_scopes: values[5], version: values[6], status: 'revoking' }
            : { google_sub: values[3], account_email: values[4], encrypted_refresh_token: values[5], granted_scopes: values[6], version: values[7], status: 'active' }),
        created_at: new Date(), updated_at: new Date() };
      rows.splice(0, rows.length, row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE context_gmail_private.connections')) {
      if (sql.includes('CASE WHEN')) Object.assign(rows[0], {
        status: rows[0].encrypted_refresh_token === null ? 'disconnected' : 'revoking', version: Number(rows[0].version) + 1, updated_at: new Date(),
      });
      else if (sql.includes('SET encrypted_refresh_token = NULL')) Object.assign(rows[0], { encrypted_refresh_token: null, status: 'disconnected', updated_at: new Date() });
      else throw new Error('Unexpected connection update');
      return { rows: [{ ...rows[0] }] };
    }
    if (sql.startsWith('UPDATE context_gmail_private.draft_operations')) return { rows: [] };
    throw new Error('Unexpected database statement');
  });
  return { rows, roster, client: { query } as unknown as PoolClient };
}

afterEach(() => vi.unstubAllEnvs());

describe('Gmail callback and disconnect races', () => {
  it.each(['absent', 'already-disconnected'])('a later disconnect invalidates an in-flight callback when the row is %s', async initial => {
    vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
    vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_ID', 'draft-client.apps.googleusercontent.com');
    vi.stubEnv('CONTEXT_GMAIL_CLIENT_SECRET', 'synthetic-draft-secret');
    vi.stubEnv('CONTEXT_GMAIL_ENCRYPTION_KEY', Buffer.alloc(32, 2).toString('base64url'));
    vi.stubEnv('CONTEXT_GMAIL_ENABLED', 'true');
    const { client, rows } = database();
    if (initial === 'already-disconnected') {
      await saveGmailConnection(client, owner, { googleSub, accountEmail: email, refreshToken: 'synthetic-refresh', grantedScopes: [scope] });
      await disconnectGmailConnection(client, owner);
      await completeGmailDisconnect(client, owner, async () => {});
      expect(rows[0]).toMatchObject({ status: 'disconnected', version: 2 });
    }
    const identity: ConsoleIdentity = { employeeId: 7, email, name: 'Employee', isAdmin: false, isAnalyst: false, scopes: ['knowledge:read'] };
    const session = consoleCookie('session', createConsoleSession(identity, `google:${googleSub}`), 28800).split(';')[0];
    const request = (path: string, method = 'GET', cookie = session) => new Request(`${origin}${path}`, { method, headers: { Cookie: cookie, Origin: origin } });
    let allowToken!: (response: Response) => void, markFetching!: () => void;
    const tokenResponse = new Promise<Response>(resolve => { allowToken = resolve; });
    const fetching = new Promise<void>(resolve => { markFetching = resolve; });
    const transaction = async <T>(operation: (client: PoolClient) => Promise<T>) => operation(client);
    const deps = { transaction, writeTransaction: transaction, disconnectTransaction: transaction,
      fetch: vi.fn<typeof fetch>(async url => { if (String(url).endsWith('/revoke')) return new Response(''); markFetching(); return tokenResponse; }),
      verify: vi.fn(async () => ({ email, sub: googleSub })), limit: vi.fn() };
    const start = await handleGmailConnect(request('/api/mail/google/connect', 'POST'), deps);
    expect(start.status).toBe(303);
    const flowCookie = start.headers.getSetCookie()[0].split(';')[0];
    const flow = readSignedConsoleValue(flowCookie.split('=')[1], 'google-oauth');
    const callback = handleGmailCallback(request(`/api/mail/google/callback?code=one-use-code&state=${flow.state}`, 'GET', `${session}; ${flowCookie}`), deps);
    await fetching; // preflight passed; token exchange is still in flight
    const disconnect = await handleGmailDisconnect(request('/api/mail/connection', 'POST'), deps);
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toEqual({ disconnected: true, googleGrantRevoked: false, revocationPending: false });
    const version = initial === 'absent' ? 1 : 3;
    expect(rows[0]).toMatchObject({ status: 'disconnected', version });
    allowToken(Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-new-refresh', id_token: 'synthetic-id-token', token_type: 'Bearer', scope: `openid email ${scope}` }));
    const completed = await callback;
    expect(completed.headers.get('location')).toBe(`${origin}/mail?error=changed`);
    expect(rows[0]).toMatchObject({ status: 'disconnected', encrypted_refresh_token: null, version: version + 1 });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
});
