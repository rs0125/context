import type { PoolClient } from 'pg';
import { z } from 'zod';
import { SCOPES } from './auth';
import { getConsoleIdentity, readConsoleSession, requireConsoleOrigin } from './console-auth';
import { withConsoleWriteTransaction, withReadOnlyTransaction } from './db';
import { HttpError } from './errors';

const TABLE = 'context_engine_private.knowledge_pages';
const MAX_BODY_BYTES = 100_000;
// JSON escaping can expand a 100 KB Markdown body to roughly 600 KB on the wire.
const MAX_REQUEST_BYTES = 640_000;
const MAX_ADMIN_PAGES = 1000;
const slugSchema = z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const revisionSchema = z.string().regex(/^\d{1,10}$/).refine(value => Number(value) <= 4_294_967_295);
const textSchema = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const scopesSchema = z.array(z.enum(SCOPES)).min(1).max(SCOPES.length)
  .refine(scopes => scopes.includes('knowledge:read') && new Set(scopes).size === scopes.length);
const inputSchema = z.object({
  id: slugSchema,
  title: textSchema(200),
  summary: textSchema(500),
  status: z.enum(['draft', 'reviewed']).default('draft'),
  scopes: scopesSchema,
  body: z.string().min(1).max(MAX_BODY_BYTES).refine(value => value.trim().length > 0
    && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_BODY_BYTES),
  revision: revisionSchema.optional(),
}).strict();
const metadataSchema = inputSchema.omit({ body: true, revision: true }).extend({
  status: z.enum(['draft', 'reviewed']),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }),
  revision: revisionSchema,
});
const storedPageSchema = metadataSchema.extend({
  // Historical private documents were bounded in characters; permit those reads
  // while enforcing the stricter byte limit on new browser writes.
  body: z.string().min(1).max(MAX_BODY_BYTES).refine(value => !value.includes('\0')),
});
const SELECT_METADATA = 'id, title, summary, status, scopes, updated_at::text AS "updatedAt", xmin::text AS revision';
type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Dependencies = {
  readTransaction: Transaction;
  writeTransaction: Transaction;
  identity: typeof getConsoleIdentity;
  session: typeof readConsoleSession;
  origin: typeof requireConsoleOrigin;
};
const defaults: Dependencies = {
  readTransaction: withReadOnlyTransaction,
  writeTransaction: withConsoleWriteTransaction,
  identity: getConsoleIdentity,
  session: readConsoleSession,
  origin: requireConsoleOrigin,
};

function unavailable(): never {
  throw new HttpError(503, 'KNOWLEDGE_UNAVAILABLE', 'The knowledge editor is temporarily unavailable.');
}

function validateId(id: string) {
  if (!slugSchema.safeParse(id).success) throw new HttpError(422, 'INVALID_PAGE', 'Use a page ID with lowercase letters, numbers, and hyphens (up to 100 characters).');
}

function parseInput(value: unknown, id?: string) {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, 'INVALID_PAGE', 'Provide a valid page ID, title, summary, scopes, and Markdown body of up to 100 KB.');
  if (id !== undefined && parsed.data.id !== id) throw new HttpError(422, 'INVALID_PAGE', 'The page ID cannot be changed.');
  if (id !== undefined && !parsed.data.revision) throw new HttpError(422, 'REVISION_REQUIRED', 'Reload the page before saving so its current revision is included.');
  if (id === undefined && parsed.data.revision !== undefined) throw new HttpError(422, 'INVALID_PAGE', 'New pages must not include a revision.');
  return parsed.data;
}

async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Send the page as application/json.');
  }
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'PAGE_TOO_LARGE', 'The page request is too large. Markdown is limited to 100 KB.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'A JSON page body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, 'PAGE_TOO_LARGE', 'The page request is too large. Markdown is limited to 100 KB.');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'The request must contain valid JSON.');
  } finally {
    reader.releaseLock();
  }
}

function parseMetadata(row: unknown) {
  const parsed = metadataSchema.safeParse(row);
  if (!parsed.success) unavailable();
  return parsed.data;
}

function parsePage(row: unknown, id: string) {
  const parsed = storedPageSchema.safeParse(row);
  if (!parsed.success || parsed.data.id !== id) unavailable();
  return parsed.data;
}

async function listPages(client: PoolClient) {
  const { rows } = await client.query(`SELECT ${SELECT_METADATA} FROM ${TABLE} ORDER BY title, id LIMIT 1001`);
  if (rows.length > MAX_ADMIN_PAGES) unavailable();
  const pages = rows.map(parseMetadata);
  if (new Set(pages.map(page => page.id)).size !== pages.length) unavailable();
  return { pages };
}

async function readPage(client: PoolClient, id: string) {
  const { rows } = await client.query(`SELECT ${SELECT_METADATA},
    CASE WHEN char_length(body) <= 100000 THEN body END AS body
    FROM ${TABLE} WHERE id = $1 LIMIT 2`, [id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Knowledge page not found.');
  if (rows.length !== 1) unavailable();
  return { page: parsePage(rows[0], id) };
}

async function createPage(client: PoolClient, value: unknown) {
  const page = parseInput(value);
  let rows;
  try {
    ({ rows } = await client.query(`INSERT INTO ${TABLE}
      (id, title, summary, body, updated_at, status, scopes)
      VALUES ($1, $2, $3, $4, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, $5, $6::text[])
      RETURNING ${SELECT_METADATA}, body`, [page.id, page.title, page.summary, page.body, page.status, page.scopes]));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'PAGE_EXISTS', 'That page ID already exists. Choose another ID or edit the existing page.');
    }
    throw error;
  }
  if (rows.length !== 1) unavailable();
  return { page: parsePage(rows[0], page.id) };
}

async function updatePage(client: PoolClient, id: string, value: unknown) {
  const page = parseInput(value, id);
  const { rows } = await client.query(`UPDATE ${TABLE}
    SET title = $2, summary = $3, body = $4, updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
      status = $5, scopes = $6::text[]
    WHERE id = $1 AND xmin::text = $7
    RETURNING ${SELECT_METADATA}, body`, [id, page.title, page.summary, page.body, page.status, page.scopes, page.revision]);
  if (!rows.length) {
    throw new HttpError(409, 'REVISION_CONFLICT', 'The page changed or is no longer available. Reload it before saving; your changes were not applied.');
  }
  if (rows.length !== 1) unavailable();
  return { page: parsePage(rows[0], id) };
}

/** Browser-only administrative surface; employee agent endpoints remain read-only. */
export async function handleConsoleKnowledgeRequest(request: Request, id?: string, dependencies: Partial<Dependencies> = {}): Promise<Response> {
  const deps = { ...defaults, ...dependencies };
  const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
  try {
    const expectedMutation = id === undefined ? 'POST' : 'PUT';
    if (request.method !== 'GET' && request.method !== expectedMutation) {
      return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This operation is not available.' } },
        { status: 405, headers: { ...headers, Allow: `GET, ${expectedMutation}` } });
    }
    const mutation = request.method !== 'GET';
    if (mutation) deps.origin(request);
    // Reject anonymous/expired sessions without consuming a shared pool socket;
    // current roster identity and admin status are still checked in the transaction.
    deps.session(request);
    const enabled = process.env.CONTEXT_CONSOLE_WRITES_ENABLED === 'true';
    // Consume and bound the network body before checking out the shared database socket.
    let input: unknown;
    let inputError: unknown;
    if (mutation && enabled) {
      try { input = await readJson(request); } catch (error) { inputError = error; }
    }
    const transaction = mutation && enabled ? deps.writeTransaction : deps.readTransaction;
    const result = await transaction(async client => {
      const identity = await deps.identity(request, client);
      if (identity.isAdmin !== true) throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required to edit knowledge.');
      if (mutation && !enabled) {
        throw new HttpError(503, 'CONSOLE_SETUP_REQUIRED', 'Knowledge editing is not enabled yet. An administrator must complete console setup and enable writes.');
      }
      if (id !== undefined) validateId(id);
      if (inputError) throw inputError;
      if (!mutation) return id === undefined ? listPages(client) : readPage(client, id);
      return id === undefined ? createPage(client, input) : updatePage(client, id, input);
    });
    return Response.json(result, { status: request.method === 'POST' ? 201 : 200, headers });
  } catch (error) {
    const safe = error instanceof HttpError ? error
      : new HttpError(503, 'KNOWLEDGE_UNAVAILABLE', 'The knowledge editor is temporarily unavailable.');
    return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status, headers });
  }
}
