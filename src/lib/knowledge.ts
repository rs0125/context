import type { PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "./errors";

const MAX_PAGES = 500;
const MAX_BODY = 100_000;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const scopeSchema = z.enum(["knowledge:read", "warehouses:read", "crm:read"]);
const accessSchema = z.object({
  status: z.enum(["reviewed", "draft"]),
  scopes: z.array(scopeSchema).min(1).max(3).refine((scopes) =>
    scopes.includes("knowledge:read") && new Set(scopes).size === scopes.length),
});
const metadataSchema = accessSchema.extend({
  id: z.string().max(100).regex(slug),
  title: z.string().trim().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  summary: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }),
  body_length: z.number().int().min(0).max(MAX_BODY),
});

export type KnowledgeSummary = {
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
};
export type KnowledgePage = KnowledgeSummary & { body: string };
export type KnowledgeSearchResult = KnowledgeSummary & { snippet: string };
type Row = Record<string, unknown>;

const TABLE = "context_engine_private.knowledge_pages";
const ACCESS = "status = 'reviewed' AND scopes <@ $1::text[] AND 'knowledge:read' = ANY(scopes)";
const METADATA = 'id, title, summary, updated_at::text AS "updatedAt", status, scopes, char_length(body) AS body_length';

function unavailable(): never {
  throw new HttpError(503, "KNOWLEDGE_UNAVAILABLE", "The knowledge source is temporarily unavailable.");
}

function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Row;
}

function permitted(row: Row, scopes: readonly string[]) {
  const access = accessSchema.safeParse(row);
  if (!access.success) unavailable();
  return access.data.status === "reviewed" && access.data.scopes.every((scope) => scopes.includes(scope));
}

function summary(row: Row): KnowledgeSummary {
  const metadata = metadataSchema.safeParse(row);
  if (!metadata.success) unavailable();
  const { id, title, summary, updatedAt } = metadata.data;
  return { id, title, summary, updatedAt };
}

function uniqueRows(rows: unknown[], scopes: readonly string[]) {
  const ids = new Set<string>();
  return rows.flatMap((value) => {
    const row = record(value);
    // Enforce the publication and permission boundary again before mapping database rows.
    if (!permitted(row, scopes)) return [];
    const metadata = summary(row);
    if (ids.has(metadata.id)) unavailable();
    ids.add(metadata.id);
    return [{ row, metadata }];
  });
}

async function boundedCollection(client: PoolClient, sql: string, parameters: unknown[], limit: number) {
  try {
    const result = await client.query<Row>(sql, parameters);
    if (result.rows.length !== 1) unavailable();
    const { page_count: count, pages } = record(result.rows[0]);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_PAGES ||
        !Array.isArray(pages) || pages.length > limit || pages.length > count) unavailable();
    return pages;
  } catch {
    // Do not propagate driver messages, SQL, document contents, or database credentials.
    unavailable();
  }
}

/** Uses the request's existing read-only transaction; no local files or additional pool. */
export async function listKnowledge(client: PoolClient, scopes: string[]): Promise<KnowledgeSummary[]> {
  if (!scopes.includes("knowledge:read")) return [];
  const rows = await boundedCollection(client, `
    WITH permitted AS MATERIALIZED (
      SELECT ${METADATA} FROM ${TABLE}
      WHERE ${ACCESS} ORDER BY id LIMIT 501
    ), selected AS (
      SELECT * FROM permitted ORDER BY title, id LIMIT 500
    )
    SELECT (SELECT count(*)::integer FROM permitted) AS page_count,
      coalesce((SELECT jsonb_agg(to_jsonb(selected) ORDER BY title, id) FROM selected), '[]'::jsonb) AS pages
  `, [[...new Set(scopes)]], MAX_PAGES);
  return uniqueRows(rows, scopes).map(({ metadata }) => metadata);
}

export async function readKnowledge(client: PoolClient, id: string, scopes: string[]): Promise<KnowledgePage | null> {
  if (!scopes.includes("knowledge:read") || id.length > 100 || !slug.test(id)) return null;
  let rows: Row[];
  try {
    rows = (await client.query<Row>(`
      SELECT ${METADATA}, CASE WHEN char_length(body) <= 100000 THEN body END AS body
      FROM ${TABLE} WHERE ${ACCESS} AND id = $2 LIMIT 2
    `, [[...new Set(scopes)], id])).rows;
  } catch {
    unavailable();
  }
  if (rows.length > 1) unavailable();
  const page = uniqueRows(rows, scopes)[0];
  if (!page) return null;
  if (page.metadata.id !== id) unavailable();
  const body = z.string().max(MAX_BODY).safeParse(page.row.body);
  if (!body.success) unavailable();
  return { ...page.metadata, body: body.data.trim() };
}

function plainText(markdown: string) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchKnowledge(client: PoolClient, query: string, scopes: string[], limit = 10): Promise<KnowledgeSearchResult[]> {
  if (!scopes.includes("knowledge:read")) return [];
  const terms = [...new Set(query.slice(0, 200).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length) return [];
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(25, Math.floor(limit))) : 10;
  const patterns = terms.map((term) => `%${term.replace(/[!%_]/g, "!$&")}%`);
  const rows = await boundedCollection(client, `
    WITH permitted AS MATERIALIZED (
      SELECT ${METADATA}, CASE WHEN char_length(body) <= 100000 THEN body END AS body
      FROM ${TABLE} WHERE ${ACCESS} ORDER BY id LIMIT 501
    ), scored AS (
      SELECT p.*, hits.score, greatest(1, coalesce(hits.first_match, 1) - 50) AS snippet_start
      FROM permitted p CROSS JOIN LATERAL (
        SELECT sum(
          (CASE WHEN p.title ILIKE term.pattern ESCAPE '!' THEN 8 ELSE 0 END) +
          (CASE WHEN p.summary ILIKE term.pattern ESCAPE '!' THEN 4 ELSE 0 END) +
          (CASE WHEN p.body ILIKE term.pattern ESCAPE '!' THEN 1 ELSE 0 END)
        )::integer AS score,
        min(nullif(strpos(lower(p.body), term.value), 0)) AS first_match
        FROM unnest($2::text[], $3::text[]) AS term(value, pattern)
      ) hits
    ), selected AS (
      SELECT id, title, summary, "updatedAt", status, scopes, body_length, score,
        substring(body FROM snippet_start FOR 320) AS snippet_source,
        snippet_start > 1 AS snippet_before,
        body_length > snippet_start + 319 AS snippet_after
      FROM scored WHERE score > 0 ORDER BY score DESC, id LIMIT $4
    )
    SELECT (SELECT count(*)::integer FROM permitted) AS page_count,
      coalesce((SELECT jsonb_agg(to_jsonb(selected) ORDER BY score DESC, id) FROM selected), '[]'::jsonb) AS pages
  `, [[...new Set(scopes)], terms, patterns, boundedLimit], boundedLimit);
  return uniqueRows(rows, scopes).map(({ row, metadata }) => {
    // PostgreSQL counts Unicode characters; a bounded substring can use two UTF-16 units each.
    if (typeof row.snippet_source !== "string" || row.snippet_source.length > 640 ||
        typeof row.snippet_before !== "boolean" || typeof row.snippet_after !== "boolean") unavailable();
    const text = plainText(row.snippet_source);
    const snippet = `${row.snippet_before ? "…" : ""}${text.slice(0, 240)}${row.snippet_after || text.length > 240 ? "…" : ""}`;
    return { ...metadata, snippet };
  });
}
