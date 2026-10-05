/** Employee-bound CMS bridge. Page schemas and draft transactions stay in the CMS. */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { requireScope, resolvePrincipal, type KeyRegistration } from './auth';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';

const pageType = z.enum([
  'blog',
  'city',
  'state',
  'micromarket',
  'service',
  'legal',
  'ad',
]);
const slug = z
  .string()
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const write = z
  .object({
    operation_id: z.uuid(),
    preview_id: z.uuid(),
    preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
    review_url: z
      .string()
      .url()
      .max(500)
      .describe(
        'Exact CMS review_url returned with the immutable diff. Show this link with the diff before requesting edit confirmation.',
      ),
  })
  .strict();
export const cmsInputs = {
  cms_schema: z.object({ page_type: pageType.optional() }).strict(),
  cms_list_pages: z
    .object({
      page_type: pageType,
      state: z.enum(['no_content', 'draft', 'published', 'staged']).optional(),
      has_import_draft: z.boolean().optional(),
      after: z.string().max(400).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
    .strict(),
  cms_read_page: z
    .object({ page_type: pageType, slug, city_slug: slug.optional() })
    .strict(),
  cms_prepare_import: z
    .object({
      page_type: pageType,
      schema_version: z.string().regex(/^[a-f0-9]{64}$/),
      csv_text: z
        .string()
        .max(24000)
        .describe(
          'Read the attached CSV as UTF-8 text. At most 20 parsed data rows and 24,000 UTF-8 bytes; split larger files at CSV row boundaries. Never pass a local file path or remote URL.',
        ),
    })
    .strict(),
  cms_read_import: z.object({ preview_id: z.uuid() }).strict(),
  cms_fill_empty_drafts: write,
  cms_edit_drafts: write,
};
export type CmsTool = keyof typeof cmsInputs;
export const cmsEnvelope = z.object({
  source_path: z.string(),
  status: z.number(),
  data: z.record(z.string(), z.unknown()),
  meta: z.object({
    requestId: z.string(),
    generatedAt: z.string(),
    toolName: z.string(),
    argumentsSha256: z.string(),
  }),
});
export const cmsWriteOutput = z
  .object({
    operation_id: z.uuid(),
    outcome: z.enum([
      'updated',
      'replayed',
      'not_dispatched',
      'rejected',
      'outcome_unknown',
    ]),
    code: z.string(),
    message: z.string(),
    data: z
      .object({
        preview_id: z.uuid(),
        review_url: z.string().url(),
        pages: z.array(z.string()).max(20),
        published: z.literal(false),
      })
      .strict()
      .optional(),
  })
  .strict();
const privateKey = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
function configuration(env: NodeJS.ProcessEnv) {
  const endpoint = new URL(env.CONTEXT_CMS_URL ?? '');
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/api/integrations/context-engine' ||
    isIP(endpoint.hostname) ||
    !endpoint.hostname.includes('.') ||
    /(?:^|\.)(localhost|local|internal|lan|home)$/.test(endpoint.hostname)
  )
    throw new Error('CMS_CONFIGURATION');
  const kid = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,48}$/)
    .parse(env.CONTEXT_CMS_SIGNING_KID);
  const jwk = privateKey.parse(
    JSON.parse(env.CONTEXT_CMS_SIGNING_PRIVATE_JWK ?? '{}'),
  );
  return {
    endpoint: endpoint.href,
    kid,
    key: createPrivateKey({ key: jwk, format: 'jwk' }),
  };
}
export function cmsAvailability(env: NodeJS.ProcessEnv = process.env) {
  try {
    configuration(env);
    return env.CONTEXT_CMS_ENABLED === 'true';
  } catch {
    return false;
  }
}
export type CmsDependencies = {
  transaction: typeof withReadOnlyTransaction;
  principal: typeof resolvePrincipal;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  now: () => number;
};
export async function callCms(
  name: CmsTool,
  raw: unknown,
  key: KeyRegistration,
  signal: AbortSignal,
  revalidateKey: (client: PoolClient, key: KeyRegistration) => Promise<void>,
  overrides: Partial<CmsDependencies> = {},
) {
  const args = cmsInputs[name].parse(raw),
    write = name === 'cms_fill_empty_drafts' || name === 'cms_edit_drafts';
  const operationId = write
    ? (args as z.infer<typeof cmsInputs.cms_edit_drafts>).operation_id
    : undefined;
  const deps = {
    transaction: withReadOnlyTransaction,
    principal: resolvePrincipal,
    fetch: globalThis.fetch,
    env: process.env,
    now: Date.now,
    ...overrides,
  };
  let dispatched = false;
  try {
    if (!cmsAvailability(deps.env))
      throw new HttpError(
        503,
        'CMS_DISABLED',
        'CMS integration is not enabled or configured.',
      );
    const config = configuration(deps.env);
    const authorize = () =>
      deps.transaction(async (client) => {
        await revalidateKey(client, key);
        const actor = await deps.principal(client, key);
        requireScope(actor, 'cms:read');
        if (write || name === 'cms_prepare_import')
          requireScope(actor, 'cms:write');
        return actor;
      });
    signal.throwIfAborted();
    const actor = await authorize(),
      now = deps.now();
    const expires = Math.min(now + 60000, Date.parse(key.expiresAt));
    if (expires <= now + 1000)
      throw new HttpError(
        401,
        'CMS_AUTH_EXPIRED',
        'Refresh your credential before this operation.',
      );
    const requestId = randomUUID();
    const body = JSON.stringify({
      actor_email: actor.email,
      actor_id: actor.employeeId,
      action: name.slice(4),
      args,
      issued_at: now,
      expires_at: expires,
      request_id: requestId,
      audience: 'wareongo:cms-drafts:v1',
    });
    if (Buffer.byteLength(body) > 32768)
      throw new HttpError(
        413,
        'CMS_BODY_TOO_LARGE',
        'Split the CSV into smaller batches.',
      );
    const signature = sign(null, Buffer.from(body), config.key).toString(
      'base64url',
    );
    signal.throwIfAborted();
    dispatched = true;
    const response = await deps.fetch(config.endpoint, {
      method: 'POST',
      body,
      headers: {
        authorization: `ContextEngine ${config.kid}.${signature}`,
        'content-type': 'application/json',
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (
      response.redirected ||
      !response.headers.get('content-type')?.startsWith('application/json') ||
      !response.body
    )
      throw new Error('CMS_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 95000) {
          void reader.cancel();
          throw new Error('CMS_RESPONSE_SIZE');
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      // A documented pre-dispatch rejection is definitive. Unexpected remote
      // failures/transport errors preserve uncertainty and the operation ID.
      if (
        [400, 401, 403, 404, 409, 413, 422].includes(response.status) &&
        value.ok === false &&
        /^[A-Z_]{1,60}$/.test(value.code)
      ) {
        if (write)
          return {
            operation_id: operationId,
            outcome: 'rejected',
            code: value.code,
            message:
              'CMS rejected this attempt. Read the current preview and resolve the error before a new operation.',
          };
        throw new HttpError(
          response.status,
          value.code,
          typeof value.message === 'string'
            ? value.message.slice(0, 500)
            : 'CMS rejected this request.',
        );
      }
      throw new Error('CMS_RESPONSE');
    }
    if (
      value.ok !== true ||
      value.request_id !== requestId ||
      !value.data ||
      typeof value.data !== 'object' ||
      Array.isArray(value.data)
    )
      throw new Error('CMS_RESPONSE');
    const current = await authorize();
    if (
      actor.employeeId !== current.employeeId ||
      actor.email !== current.email
    )
      throw new Error('CMS_IDENTITY_CHANGED');
    if (write) {
      const result = cmsWriteOutput.parse(value.data);
      if (
        result.operation_id !== operationId ||
        !['updated', 'replayed'].includes(result.outcome) ||
        result.data?.published !== false
      )
        throw new Error('CMS_RESPONSE');
      return result;
    }
    return value.data as Record<string, unknown>;
  } catch (error) {
    if (write)
      return {
        operation_id: operationId,
        outcome: dispatched ? 'outcome_unknown' : 'not_dispatched',
        code: error instanceof HttpError ? error.code : 'CMS_UNAVAILABLE',
        message: dispatched
          ? 'The draft outcome could not be verified. Retry only with the same operation ID and unchanged preview; never create a replacement operation.'
          : 'No CMS write was dispatched.',
      };
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'CMS_UNAVAILABLE',
      'CMS is unavailable. This does not establish that a page or draft is missing.',
    );
  }
}
