import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { PROMPT_DEFINITIONS, TOOL_PLATFORMS, promptDefinition, type PromptDocument, type PromptValues, type ToolPromptName } from './prompt-definitions';

const TABLE = 'context_prompts_private.prompt_overrides';
const SELECT = 'id, body, platforms, revision::text, updated_at::text AS "updatedAt", updated_by AS "updatedBy"';
const text = z.string().min(1).max(20000).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const platforms = z.array(z.enum(TOOL_PLATFORMS)).max(TOOL_PLATFORMS.length)
  .refine(values => new Set(values).size === values.length)
  .transform(values => TOOL_PLATFORMS.filter(platform => values.includes(platform)));
const storedSchema = z.object({
  id: z.string(), body: text.nullable(), platforms: platforms.nullable(), revision: z.string().uuid(),
  updatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))), updatedBy: z.string().min(1).max(254),
});
const inputSchema = z.object({ id: z.string(), body: text.nullable(), platforms: platforms.nullable().optional(), revision: z.string().uuid().nullable() }).strict();

function unavailable(): never { throw new HttpError(503, 'PROMPTS_UNAVAILABLE', 'Prompts are temporarily unavailable. Please try again.'); }

export async function promptStorageReady(client: PoolClient) {
  const { rows } = await client.query('SELECT to_regclass($1)::text AS relation', [TABLE]);
  if (rows.length !== 1 || !('relation' in rows[0])) unavailable();
  return rows[0].relation !== null;
}

function document(row: unknown): PromptDocument {
  const result = storedSchema.safeParse(row);
  if (!result.success) unavailable();
  const stored = result.data;
  const definition = promptDefinition(stored.id);
  if (!definition || (stored.body !== null && stored.body.length > definition.maxLength)
    || (stored.platforms !== null && !definition.defaultPlatforms)) unavailable();
  return { ...definition, ...stored, id: definition.id, body: stored.body ?? definition.defaultBody,
    platforms: stored.platforms ?? definition.defaultPlatforms, customized: stored.body !== null };
}

export async function readPrompts(client: PoolClient) {
  const storageReady = await promptStorageReady(client);
  const { rows } = storageReady ? await client.query(`SELECT ${SELECT} FROM ${TABLE} WHERE id = ANY($1::text[])`,
    [PROMPT_DEFINITIONS.map(prompt => prompt.id)]) : { rows: [] };
  const saved = new Map(rows.map(row => { const value = document(row); return [value.id, value]; }));
  if (saved.size !== rows.length) unavailable();
  return { storageReady, prompts: PROMPT_DEFINITIONS.map((definition): PromptDocument => saved.get(definition.id)
    ?? { ...definition, body: definition.defaultBody, platforms: definition.defaultPlatforms, customized: false, revision: null, updatedAt: null, updatedBy: null }) };
}

/** Read each request afresh; a saved prompt is shared across all server instances. */
export async function loadPromptValues(): Promise<PromptValues> {
  return withReadOnlyTransaction(async client => {
    const { prompts } = await readPrompts(client);
    return {
      ...Object.fromEntries(prompts.filter(prompt => prompt.customized).map(prompt => [prompt.id, prompt.body])),
      toolPlatforms: Object.fromEntries(prompts.filter(prompt => prompt.platforms !== undefined)
        .map(prompt => [prompt.id.slice('tool.'.length) as ToolPromptName, prompt.platforms!])),
    };
  });
}

export async function savePrompt(client: PoolClient, input: unknown, updatedBy: string) {
  const result = inputSchema.safeParse(input);
  const definition = result.success ? promptDefinition(result.data.id) : undefined;
  if (!result.success || !definition || (result.data.body !== null && result.data.body.length > definition.maxLength)
    || ('platforms' in result.data && !definition.defaultPlatforms)) {
    throw new HttpError(422, 'INVALID_PROMPT', 'Choose a known prompt and provide non-empty text within its character limit, or restore its default. Tool platforms must be a unique list of supported platforms. Include the current revision.');
  }
  if (!await promptStorageReady(client)) {
    throw new HttpError(503, 'PROMPTS_SETUP_REQUIRED', 'Prompt storage has not been set up yet.');
  }
  const { id, body, revision } = result.data;
  const nextRevision = randomUUID();
  // Keep a revision even after restoring defaults so stale editors cannot
  // resurrect an earlier override. Null bodies track future built-in defaults.
  const values = [id, body, nextRevision, updatedBy, result.data.platforms ?? null];
  const { rows } = revision === null
    ? await client.query(`INSERT INTO ${TABLE} (id, body, revision, updated_by, platforms, updated_at)
        VALUES ($1, $2, $3::uuid, $4, $5::text[], CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING RETURNING ${SELECT}`, values)
    : await client.query(`UPDATE ${TABLE} SET body = $2, revision = $3::uuid, updated_by = $4, updated_at = CURRENT_TIMESTAMP,
        platforms = CASE WHEN $6::boolean THEN $5::text[] ELSE platforms END
        WHERE id = $1 AND revision = $7::uuid RETURNING ${SELECT}`, [...values, 'platforms' in result.data, revision]);
  if (!rows.length) throw new HttpError(409, 'REVISION_CONFLICT', 'Another administrator changed this prompt. Copy any edits you want to keep, then load the latest version. Your changes were not saved.');
  if (rows.length !== 1) unavailable();
  return { prompt: document(rows[0]) };
}
