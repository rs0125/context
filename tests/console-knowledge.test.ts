import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConsoleKnowledgeRequest } from '../src/lib/console-knowledge';
import { HttpError } from '../src/lib/errors';
import { consoleCookie, createConsoleSession } from '../src/lib/console-auth';

const origin = 'https://console.example.invalid';
const metadata = {
  id: 'synthetic-guide', title: 'Synthetic guide', summary: 'Synthetic summary',
  status: 'draft', scopes: ['knowledge:read'], updatedAt: '2026-09-25', revision: '2468',
};
const stored = { ...metadata, body: '# Synthetic Markdown\n\nTest content.' };
const payload = {
  id: metadata.id, title: metadata.title, summary: metadata.summary,
  scopes: metadata.scopes, body: stored.body,
};

function request(method = 'GET', body?: unknown, options: { origin?: string; contentType?: string; raw?: string; length?: string } = {}) {
  return new Request(`${origin}/api/console/knowledge`, {
    method,
    ...(method === 'GET' ? {} : {
      headers: {
        origin: options.origin ?? origin,
        'content-type': options.contentType ?? 'application/json',
        ...(options.length ? { 'content-length': options.length } : {}),
      },
      body: options.raw ?? JSON.stringify(body),
    }),
  });
}

function setup(rows: unknown[] = [stored]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const client = { query } as unknown as PoolClient;
  const identity = vi.fn().mockResolvedValue({
    employeeId: 7, email: 'admin@example.invalid', name: 'Synthetic Admin',
    isAdmin: true, scopes: ['knowledge:read'],
  });
  const checkOrigin = vi.fn((incoming: Request) => {
    if (incoming.headers.get('origin') !== origin) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.');
  });
  const session = vi.fn();
  const readTransaction = vi.fn();
  const writeTransaction = vi.fn();
  const dependencies = {
    identity, session, origin: checkOrigin,
    readTransaction: async <T>(operation: (connection: PoolClient) => Promise<T>): Promise<T> => {
      readTransaction();
      return operation(client);
    },
    writeTransaction: async <T>(operation: (connection: PoolClient) => Promise<T>): Promise<T> => {
      writeTransaction();
      return operation(client);
    },
  };
  return { query, client, identity, session, checkOrigin, readTransaction, writeTransaction, dependencies };
}

beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'false'));
afterEach(() => vi.unstubAllEnvs());

describe('console knowledge access and read responses', () => {
  it('rejects missing or expired sessions before checking out a database socket', async () => {
    const test = setup();
    test.session.mockImplementationOnce(() => { throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.'); });
    const response = await handleConsoleKnowledgeRequest(request(), undefined, test.dependencies);
    expect(response.status).toBe(401);
    expect(test.readTransaction).not.toHaveBeenCalled();
    expect(test.writeTransaction).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it('rechecks admin identity inside the read transaction and lists draft metadata without bodies', async () => {
    const test = setup([metadata]);
    const incoming = request();
    const response = await handleConsoleKnowledgeRequest(incoming, undefined, test.dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pages: [metadata] });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(test.identity).toHaveBeenCalledWith(incoming, test.client);
    expect(test.identity.mock.invocationCallOrder[0]).toBeLessThan(test.query.mock.invocationCallOrder[0]);
    expect(test.readTransaction).toHaveBeenCalledOnce();
    expect(test.writeTransaction).not.toHaveBeenCalled();
    expect(test.query.mock.calls[0][0]).not.toMatch(/\bbody\b/);
    expect(test.query.mock.calls[0][0]).toContain('xmin::text AS revision');
  });

  it('reads a private draft by bound ID with a revision for the editor', async () => {
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request(), metadata.id, test.dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ page: stored });
    expect(test.query.mock.calls[0][1]).toEqual([metadata.id]);
    expect(test.query.mock.calls[0][0]).not.toContain(metadata.id);
  });

  it.each(['GET', 'POST', 'PUT'])('blocks non-admin %s without reading or writing knowledge', async method => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    test.identity.mockResolvedValueOnce({ employeeId: 7, email: 'employee@example.invalid', name: 'Employee', isAdmin: false, scopes: ['knowledge:read'] });
    const response = await handleConsoleKnowledgeRequest(request(method, payload), method === 'PUT' ? metadata.id : undefined, test.dependencies);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } });
    expect(test.query).not.toHaveBeenCalled();
  });

  it('rechecks access on every request and rejects a revoked admin session', async () => {
    const test = setup([metadata]);
    expect((await handleConsoleKnowledgeRequest(request(), undefined, test.dependencies)).status).toBe(200);
    test.identity.mockRejectedValueOnce(new HttpError(403, 'EMPLOYEE_INACTIVE', 'Employee access is unavailable.'));
    expect((await handleConsoleKnowledgeRequest(request(), undefined, test.dependencies)).status).toBe(403);
    expect(test.identity).toHaveBeenCalledTimes(2);
    expect(test.query).toHaveBeenCalledOnce();
  });
  it('uses the current database admin flag with a real employee session for every knowledge operation', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
    vi.stubEnv('CONTEXT_SESSION_SECRET', Buffer.alloc(32, 1).toString('base64url'));
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const employee = { id: 7, email: 'employee@wareongo.com', name: 'Employee', is_active: true,
      adminAccess: true, dashboardAccess: false, twenty_user_id: null };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('VerifiedNumber') ? [employee] : [metadata] }));
    const client = { query } as unknown as PoolClient;
    const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => work(client);
    const cookie = consoleCookie('session', createConsoleSession({ employeeId: 7, email: employee.email, name: employee.name,
      isAdmin: true, scopes: ['knowledge:read'] }, 'google:107654321012345678901'), 28800).split(';')[0];
    const incoming = (method: string) => {
      const value = request(method, payload); value.headers.set('cookie', cookie); return value;
    };
    const dependencies = { readTransaction: transaction, writeTransaction: transaction };
    expect((await handleConsoleKnowledgeRequest(incoming('GET'), undefined, dependencies)).status).toBe(200);
    employee.adminAccess = false;
    for (const method of ['GET', 'POST', 'PUT']) {
      expect((await handleConsoleKnowledgeRequest(incoming(method), method === 'PUT' ? metadata.id : undefined, dependencies)).status).toBe(403);
    }
    expect(query.mock.calls.filter(([sql]) => !sql.includes('VerifiedNumber'))).toHaveLength(1);
  });

  it('returns a safe 404 for missing pages and rejects traversal before a page query', async () => {
    const test = setup([]);
    expect((await handleConsoleKnowledgeRequest(request(), metadata.id, test.dependencies)).status).toBe(404);
    test.query.mockClear();
    expect((await handleConsoleKnowledgeRequest(request(), '../secret', test.dependencies)).status).toBe(422);
    expect(test.query).not.toHaveBeenCalled();
  });
});

describe('console knowledge write gate, origin, and revisions', () => {
  it.each(['false', '', 'TRUE', '1'])('keeps writes disabled for the value %j, while checking admin access', async value => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', value);
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request('POST', payload), undefined, test.dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONSOLE_SETUP_REQUIRED' } });
    expect(test.identity).toHaveBeenCalledOnce();
    expect(test.readTransaction).toHaveBeenCalledOnce();
    expect(test.writeTransaction).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT'])('checks browser origin before every %s transaction', async method => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request(method, payload, { origin: 'https://hostile.example.invalid' }),
      method === 'PUT' ? metadata.id : undefined, test.dependencies);
    expect(response.status).toBe(403);
    expect(test.checkOrigin).toHaveBeenCalledOnce();
    expect(test.readTransaction).not.toHaveBeenCalled();
    expect(test.writeTransaction).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it('creates a draft by default with bound values, preserving Markdown as inert text', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const markdown = '---javascript\nprocess.exit()\n---\n# This is literal Markdown, not evaluated.';
    const test = setup([{ ...stored, body: markdown }]);
    const response = await handleConsoleKnowledgeRequest(request('POST', { ...payload, body: markdown }), undefined, test.dependencies);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ page: { status: 'draft', body: markdown, revision: metadata.revision } });
    expect(test.writeTransaction).toHaveBeenCalledOnce();
    expect(test.readTransaction).not.toHaveBeenCalled();
    const [sql, values] = test.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO context_engine_private.knowledge_pages');
    expect(sql).not.toContain(markdown);
    expect(values).toEqual([payload.id, payload.title, payload.summary, markdown, 'draft', payload.scopes]);
  });

  it('updates only the matching xmin revision and returns the new revision', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup([{ ...stored, status: 'reviewed', revision: '2469' }]);
    const response = await handleConsoleKnowledgeRequest(request('PUT', { ...payload, status: 'reviewed', revision: '2468' }), metadata.id, test.dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ page: { status: 'reviewed', revision: '2469' } });
    const [sql, values] = test.query.mock.calls[0];
    expect(sql).toContain('WHERE id = $1 AND xmin::text = $7');
    expect(values).toEqual([payload.id, payload.title, payload.summary, payload.body, 'reviewed', payload.scopes, '2468']);
  });

  it('returns 409 on stale revisions without overwriting the current row', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup([]);
    const response = await handleConsoleKnowledgeRequest(request('PUT', { ...payload, revision: '2468' }), metadata.id, test.dependencies);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(test.query).toHaveBeenCalledOnce();
  });

  it('returns a safe duplicate-ID conflict without driver details or existing page content', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    test.query.mockRejectedValueOnce({ code: '23505', detail: 'Synthetic private record detail' });
    const response = await handleConsoleKnowledgeRequest(request('POST', payload), undefined, test.dependencies);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'PAGE_EXISTS', message: 'That page ID already exists. Choose another ID or edit the existing page.' } });
  });
});

describe('console knowledge validation and safe failures', () => {
  it.each([
    { id: "guide'); DROP TABLE knowledge_pages; --" }, { title: '' }, { summary: 'x'.repeat(501) },
    { title: 'line\nbreak' }, { body: ' ' }, { body: '\0' }, { body: 'x'.repeat(100001) },
    { body: '🧪'.repeat(25001) }, { scopes: [] }, { scopes: ['crm:read'] },
    { scopes: ['knowledge:read', 'knowledge:read'] }, { scopes: ['knowledge:read', 'admin:write'] },
    { status: 'published' }, { revision: '123' }, { updatedAt: '2026-01-01' },
  ])('rejects invalid create payload %# before database writes', async invalid => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request('POST', { ...payload, ...invalid }), undefined, test.dependencies);
    expect(response.status).toBe(422);
    expect(test.query).not.toHaveBeenCalled();
    expect(test.identity).toHaveBeenCalledOnce();
  });

  it.each([
    { revision: undefined }, { revision: 'not-a-revision' }, { revision: '4294967296' },
    { revision: '1 OR 1=1' }, { revision: '2468', id: 'renamed-guide' },
  ])('requires an immutable ID and valid revision for updates %#', async invalid => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request('PUT', { ...payload, ...invalid }), metadata.id, test.dependencies);
    expect(response.status).toBe(422);
    expect(test.query).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and non-JSON input without writes', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    expect((await handleConsoleKnowledgeRequest(request('POST', undefined, { raw: '{' }), undefined, test.dependencies)).status).toBe(400);
    expect((await handleConsoleKnowledgeRequest(request('POST', payload, { contentType: 'text/plain' }), undefined, test.dependencies)).status).toBe(415);
    expect(test.query).not.toHaveBeenCalled();
  });

  it('bounds the request stream even when Content-Length is absent', async () => {
    vi.stubEnv('CONTEXT_CONSOLE_WRITES_ENABLED', 'true');
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request('POST', undefined, { raw: ' '.repeat(640001) }), undefined, test.dependencies);
    expect(response.status).toBe(413);
    expect(test.query).not.toHaveBeenCalled();
  });

  it('returns a generic no-store error for malformed DB rows and driver failures', async () => {
    const test = setup([{ ...metadata, revision: 'private-driver-data' }]);
    const malformed = await handleConsoleKnowledgeRequest(request(), undefined, test.dependencies);
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: { code: 'KNOWLEDGE_UNAVAILABLE', message: 'The knowledge editor is temporarily unavailable.' } });
    test.query.mockRejectedValueOnce(new Error('Synthetic private query and document contents'));
    const failed = await handleConsoleKnowledgeRequest(request(), undefined, test.dependencies);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toContain('no-store');
    expect(await failed.json()).toEqual({ error: { code: 'KNOWLEDGE_UNAVAILABLE', message: 'The knowledge editor is temporarily unavailable.' } });
  });

  it('provides no delete operation', async () => {
    const test = setup();
    const response = await handleConsoleKnowledgeRequest(request('DELETE'), metadata.id, test.dependencies);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, PUT');
    expect(test.query).not.toHaveBeenCalled();
  });
});
