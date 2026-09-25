import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { describe, it, vi } from 'vitest';
import { handleConsoleKnowledgeRequest } from '../src/lib/console-knowledge';
import {
  consoleCookie, consoleOrigin, createConsoleSession, getConsoleIdentity,
  PASSWORD_SESSION_SUBJECT, resolveConsoleEmployee, SESSION_SECONDS,
} from '../src/lib/console-auth';
import { readKnowledge } from '../src/lib/knowledge';

class VerificationError extends Error {}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new VerificationError(code);
}

// Explicit opt-in only. This is a real database check, but every fixture write
// remains inside one outer transaction that is always rolled back. A savepoint
// per handler gives updates different xmin values without retaining documents.
describe.skipIf(process.env.CONTEXT_LIVE_CONSOLE_TEST !== '1')('rollback-only console integration', () => {
  it('checks admin publication, revision conflicts, rollback cleanup, and private key storage permissions', async () => {
    let pool: pg.Pool | undefined;
    let client: PoolClient | undefined;
    let inTransaction = false;
    let stage = 'CONFIGURATION';
    const fixtureId = `console-live-${randomUUID()}`;
    try {
      const envModule = '../scripts/env-utils.mjs';
      const migrationModule = '../scripts/migrate-knowledge.mjs';
      const { readEnv } = await import(envModule);
      const { migrationDatabaseOptions } = await import(migrationModule);
      const env = await readEnv('.env.local') as Record<string, string>;
      check(env.CONTEXT_CONSOLE_WRITES_ENABLED === 'true', 'CONSOLE_LIVE_WRITES_NOT_CONFIGURED');
      for (const name of ['CONTEXT_CONSOLE_ORIGIN', 'CONTEXT_SESSION_SECRET', 'CONTEXT_ADMIN_EMAIL',
        'CONTEXT_ADMIN_PASSWORD', 'ADMIN_EMAILS', 'CONTEXT_CONSOLE_WRITES_ENABLED']) {
        vi.stubEnv(name, env[name] ?? '');
      }
      const email = process.env.CONTEXT_ADMIN_EMAIL?.trim().toLowerCase();
      check(email && /^[^\s@]+@wareongo\.com$/.test(email), 'CONSOLE_LIVE_ADMIN_NOT_CONFIGURED');
      const origin = consoleOrigin();

      stage = 'CONNECT';
      pool = new pg.Pool({ ...migrationDatabaseOptions(env), max: 1, application_name: 'context-console-rollback-verification' });
      pool.on('error', () => {});
      client = await pool.connect();
      const connection = client;
      inTransaction = true;
      await connection.query('BEGIN');
      await connection.query("SET LOCAL statement_timeout = '4000ms'");
      await connection.query("SET LOCAL lock_timeout = '1000ms'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");

      stage = 'ADMIN_SESSION';
      const rosterIdentity = await resolveConsoleEmployee(connection, email);
      const session = createConsoleSession({ ...rosterIdentity, isAdmin: true }, PASSWORD_SESSION_SUBJECT);
      const cookie = consoleCookie('session', session, SESSION_SECONDS).split(';')[0];
      function request(method: string, id?: string, body?: unknown) {
        return new Request(`${origin}/api/console/knowledge${id ? `/${id}` : ''}`, {
          method,
          headers: { Cookie: cookie, ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }
      const verified = await getConsoleIdentity(request('GET'), connection);
      check(verified.isAdmin === true && verified.employeeId === rosterIdentity.employeeId
        && verified.email === rosterIdentity.email, 'CONSOLE_LIVE_ADMIN_SESSION_REJECTED');

      let savepoint = 0;
      const transaction = async <T>(work: (active: PoolClient) => Promise<T>): Promise<T> => {
        // Identifier contains only a fixed prefix and a locally generated integer.
        const name = `console_live_${++savepoint}`;
        await connection.query(`SAVEPOINT ${name}`);
        try {
          const result = await work(connection);
          await connection.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await connection.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await connection.query(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      };
      const dependencies = { readTransaction: transaction, writeTransaction: transaction };
      const draft = {
        id: fixtureId,
        title: 'Synthetic rollback verification fixture',
        summary: 'Temporary fixture for rollback-only verification. This is not organisational guidance.',
        body: '# Synthetic test fixture\n\nThis document exists only inside an uncommitted verification transaction.',
        scopes: ['knowledge:read'],
      };

      stage = 'CREATE_DRAFT';
      const collision = await connection.query('SELECT id FROM context_engine_private.knowledge_pages WHERE id = $1', [fixtureId]);
      check(collision.rows.length === 0, 'CONSOLE_LIVE_FIXTURE_ID_COLLISION');
      const createdResponse = await handleConsoleKnowledgeRequest(request('POST', undefined, draft), undefined, dependencies);
      check(createdResponse.status === 201, 'CONSOLE_LIVE_CREATE_REJECTED');
      const created = await createdResponse.json();
      check(created.page?.id === fixtureId && created.page.status === 'draft'
        && /^\d+$/.test(created.page.revision), 'CONSOLE_LIVE_CREATE_RESULT_INVALID');
      check(await readKnowledge(connection, fixtureId, ['knowledge:read']) === null, 'CONSOLE_LIVE_DRAFT_VISIBLE_TO_AGENT');

      stage = 'READ_DRAFT';
      const detailResponse = await handleConsoleKnowledgeRequest(request('GET', fixtureId), fixtureId, dependencies);
      check(detailResponse.status === 200 && detailResponse.headers.get('cache-control')?.includes('no-store'), 'CONSOLE_LIVE_DETAIL_REJECTED');
      const detail = await detailResponse.json();
      check(detail.page?.body === draft.body && detail.page.revision === created.page.revision, 'CONSOLE_LIVE_DETAIL_MISMATCH');

      stage = 'DUPLICATE_RECOVERY';
      const duplicateResponse = await handleConsoleKnowledgeRequest(request('POST', undefined, draft), undefined, dependencies);
      check(duplicateResponse.status === 409, 'CONSOLE_LIVE_DUPLICATE_NOT_REJECTED');
      check((await duplicateResponse.json()).error?.code === 'PAGE_EXISTS', 'CONSOLE_LIVE_DUPLICATE_RESULT_INVALID');

      stage = 'PUBLISH';
      const publishedInput = { ...draft, status: 'reviewed', body: `${draft.body}\n\nSynthetic reviewed content.`, revision: created.page.revision };
      const publishedResponse = await handleConsoleKnowledgeRequest(request('PUT', fixtureId, publishedInput), fixtureId, dependencies);
      check(publishedResponse.status === 200, 'CONSOLE_LIVE_UPDATE_REJECTED');
      const published = await publishedResponse.json();
      check(published.page?.status === 'reviewed' && /^\d+$/.test(published.page.revision)
        && published.page.revision !== created.page.revision, 'CONSOLE_LIVE_REVISION_DID_NOT_CHANGE');
      const agentPage = await readKnowledge(connection, fixtureId, ['knowledge:read']);
      check(agentPage?.body === publishedInput.body, 'CONSOLE_LIVE_REVIEWED_PAGE_UNAVAILABLE');

      stage = 'STALE_REVISION';
      const staleResponse = await handleConsoleKnowledgeRequest(request('PUT', fixtureId,
        { ...publishedInput, body: 'Synthetic stale content that must never replace the current fixture.' }), fixtureId, dependencies);
      check(staleResponse.status === 409 && (await staleResponse.json()).error?.code === 'REVISION_CONFLICT', 'CONSOLE_LIVE_STALE_REVISION_ACCEPTED');
      check((await readKnowledge(connection, fixtureId, ['knowledge:read']))?.body === publishedInput.body, 'CONSOLE_LIVE_STALE_WRITE_CHANGED_CONTENT');

      stage = 'PRIVATE_STORAGE';
      const privacy = (await connection.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced_rls,
        (SELECT count(*)::integer FROM pg_policy WHERE polrelid = c.oid) AS policies,
        NOT EXISTS (SELECT 1 FROM LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE a.grantee = 0) AS no_public_schema,
        NOT EXISTS (SELECT 1 FROM LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0) AS no_public_table,
        NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
          (has_schema_privilege(r.oid, n.oid, 'USAGE, CREATE') OR has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))) AS no_api_role_access
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'context_auth_private' AND c.relname = 'employee_api_keys'`)).rows;
      check(privacy.length === 1 && privacy[0].rls === true && privacy[0].forced_rls === true
        && privacy[0].policies === 0 && privacy[0].no_public_schema === true && privacy[0].no_public_table === true
        && privacy[0].no_api_role_access === true, 'CONSOLE_LIVE_PRIVATE_STORAGE_NOT_PROTECTED');

      stage = 'ROLLBACK';
      await connection.query('ROLLBACK');
      inTransaction = false;
      inTransaction = true;
      await connection.query('BEGIN READ ONLY');
      await connection.query("SET LOCAL statement_timeout = '4000ms'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
      const remaining = await connection.query('SELECT id FROM context_engine_private.knowledge_pages WHERE id = $1', [fixtureId]);
      check(remaining.rows.length === 0, 'CONSOLE_LIVE_FIXTURE_RETAINED');
      await connection.query('ROLLBACK');
      inTransaction = false;
    } catch (error) {
      // Vitest must never print a raw pg error, row payload, signed cookie, or env.
      if (error instanceof VerificationError) throw error;
      throw new VerificationError(`CONSOLE_LIVE_${stage}_FAILED`);
    } finally {
      let cleanupFailed = false;
      if (client && inTransaction) {
        try { await client.query('ROLLBACK'); } catch { cleanupFailed = true; }
      }
      try { client?.release(true); } catch { cleanupFailed = true; }
      try { await pool?.end(); } catch { cleanupFailed = true; }
      vi.unstubAllEnvs();
      if (cleanupFailed) throw new VerificationError('CONSOLE_LIVE_CLEANUP_FAILED');
    }
  }, 45_000);
});
