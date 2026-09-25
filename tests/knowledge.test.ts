import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { listKnowledge, readKnowledge, searchKnowledge } from "../src/lib/knowledge";

const scopes = ["knowledge:read"];
const unavailable = {
  status: 503,
  code: "KNOWLEDGE_UNAVAILABLE",
  message: "The knowledge source is temporarily unavailable.",
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary",
    updatedAt: "2026-09-25", status: "reviewed", scopes: ["knowledge:read"],
    body_length: 40, body: "Synthetic document used only in tests.", ...overrides,
  };
}

function searchPage(overrides: Record<string, unknown> = {}) {
  return {
    ...page(), snippet_source: "Synthetic warehouse guidance.", snippet_before: false,
    snippet_after: false, score: 8, ...overrides,
  };
}

function database(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}

function collection(pages: unknown[], pageCount = pages.length) {
  return database([{ page_count: pageCount, pages }]);
}

function assertSqlAccess(sql: string) {
  expect(sql).toContain("context_engine_private.knowledge_pages");
  expect(sql).toContain("status = 'reviewed'");
  expect(sql).toContain("scopes <@ $1::text[]");
  expect(sql).toContain("'knowledge:read' = ANY(scopes)");
}

describe("private database knowledge publication and permissions", () => {
  it("lists only safe metadata using the existing client and bounded authorized SQL", async () => {
    const db = collection([page()]);
    expect(await listKnowledge(db.client, scopes)).toEqual([{
      id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary", updatedAt: "2026-09-25",
    }]);
    const [sql, parameters] = db.query.mock.calls[0];
    assertSqlAccess(sql);
    expect(sql).toContain("LIMIT 501");
    expect(sql).toContain("LIMIT 500");
    expect(sql).not.toContain("THEN body");
    expect(parameters).toEqual([scopes]);
  });

  it("performs no database query without knowledge:read", async () => {
    const db = database([]);
    expect(await listKnowledge(db.client, [])).toEqual([]);
    expect(await readKnowledge(db.client, "synthetic-guide", ["crm:read"])).toBeNull();
    expect(await searchKnowledge(db.client, "warehouse", ["warehouses:read"])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("defensively excludes draft and insufficiently scoped rows from every output", async () => {
    const rows = [page(), page({ id: "unpublished", status: "draft" }),
      page({ id: "restricted", scopes: ["knowledge:read", "crm:read"] })];
    expect((await listKnowledge(collection(rows).client, scopes)).map(({ id }) => id)).toEqual(["synthetic-guide"]);
    expect((await searchKnowledge(collection(rows.map(searchPage)).client, "warehouse", scopes)).map(({ id }) => id))
      .toEqual(["synthetic-guide"]);
    for (const row of rows.slice(1)) {
      expect(await readKnowledge(database([row]).client, row.id, scopes)).toBeNull();
    }
  });

  it("reads a reviewed page with all required scopes and binds its id", async () => {
    const allowed = ["knowledge:read", "crm:read"];
    const db = database([page({ scopes: allowed })]);
    const result = await readKnowledge(db.client, "synthetic-guide", allowed);
    expect(result).toEqual({
      id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary", updatedAt: "2026-09-25",
      body: "Synthetic document used only in tests.",
    });
    const [sql, parameters] = db.query.mock.calls[0];
    assertSqlAccess(sql);
    expect(sql).toContain("id = $2");
    expect(sql).toContain("updated_at::text");
    expect(sql).toContain("char_length(body) <= 100000");
    expect(sql).not.toContain("synthetic-guide");
    expect(parameters).toEqual([allowed, "synthetic-guide"]);
  });

  it.each(["../secret", "%2e%2e%2fsecret", "a/b", "/etc/passwd", "reference.md", "A", "a\\b", "a".repeat(101)])(
    "rejects malformed id %s before querying", async (id) => {
      const db = database([]);
      expect(await readKnowledge(db.client, id, scopes)).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    },
  );
});

describe("knowledge database validation and failure boundaries", () => {
  it.each([
    { id: "../invalid" }, { title: "" }, { title: "line\nbreak" }, { summary: "x".repeat(501) },
    { updatedAt: "2026-02-30" }, { scopes: [] }, { scopes: ["crm:read"] },
    { scopes: ["knowledge:read", "knowledge:read"] }, { status: "unexpected" }, { body_length: 100001 },
  ])("fails closed on malformed published metadata: %j", async (override) => {
    await expect(listKnowledge(collection([page(override)]).client, scopes)).rejects.toMatchObject(unavailable);
  });

  it("rejects an oversized body even when its reported database length is incorrect", async () => {
    await expect(readKnowledge(database([page({ body: "x".repeat(100001) })]).client, "synthetic-guide", scopes))
      .rejects.toMatchObject(unavailable);
  });

  it("rejects duplicate ids, mismatched reads, and more than 500 accessible reviewed pages", async () => {
    await expect(listKnowledge(collection([page(), page()]).client, scopes)).rejects.toMatchObject(unavailable);
    await expect(readKnowledge(database([page({ id: "wrong-page" })]).client, "synthetic-guide", scopes))
      .rejects.toMatchObject(unavailable);
    await expect(listKnowledge(collection([], 501).client, scopes)).rejects.toMatchObject(unavailable);
    await expect(searchKnowledge(collection([], 501).client, "warehouse", scopes)).rejects.toMatchObject(unavailable);
  });

  it("returns null for an absent page and exposes no driver error or local fallback", async () => {
    expect(await readKnowledge(database([]).client, "synthetic-guide", scopes)).toBeNull();
    const db = database([]);
    db.query.mockRejectedValue(new Error("Synthetic private driver detail"));
    await expect(listKnowledge(db.client, scopes)).rejects.toMatchObject(unavailable);
    await expect(readKnowledge(db.client, "synthetic-guide", scopes)).rejects.toMatchObject(unavailable);
    await expect(searchKnowledge(db.client, "warehouse", scopes)).rejects.toMatchObject(unavailable);
  });

  it.each([
    [], [{ page_count: -1, pages: [] }], [{ page_count: "1", pages: [] }],
    [{ page_count: 0, pages: [page()] }], [{ page_count: 1, pages: null }],
  ])("rejects malformed collection envelopes", async (...rows) => {
    await expect(listKnowledge(database(rows).client, scopes)).rejects.toMatchObject(unavailable);
  });
});

describe("bounded SQL knowledge search", () => {
  it("ranks title, summary, and body in SQL and returns only a compact plain-text snippet", async () => {
    const db = collection([searchPage({ snippet_source: "## Synthetic **warehouse** [guidance](https://example.invalid)." })]);
    const results = await searchKnowledge(db.client, "warehouse Warehouse", scopes, 3);
    expect(results).toEqual([{
      id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary", updatedAt: "2026-09-25",
      snippet: "Synthetic warehouse guidance.",
    }]);
    const [sql, parameters] = db.query.mock.calls[0];
    assertSqlAccess(sql);
    expect(sql).toContain("p.title ILIKE term.pattern ESCAPE '!' THEN 8");
    expect(sql).toContain("p.summary ILIKE term.pattern ESCAPE '!' THEN 4");
    expect(sql).toContain("p.body ILIKE term.pattern ESCAPE '!' THEN 1");
    expect(sql).toContain("ORDER BY score DESC, id LIMIT $4");
    expect(sql).toContain("substring(body FROM snippet_start FOR 320)");
    expect(parameters).toEqual([scopes, ["warehouse"], ["%warehouse%"], 3]);
  });

  it("adds omission markers while keeping snippets bounded", async () => {
    const db = collection([searchPage({ snippet_source: "warehouse ".repeat(32), snippet_before: true, snippet_after: true })]);
    const [result] = await searchKnowledge(db.client, "warehouse", scopes);
    expect(result.snippet.length).toBeLessThanOrEqual(242);
    expect(result.snippet.startsWith("…")).toBe(true);
    expect(result.snippet.endsWith("…")).toBe(true);
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("score");
  });

  it("binds normalized literal search terms without wildcard or SQL injection", async () => {
    const db = collection([]);
    const input = "warehouse%_ ' OR 1=1 --";
    await searchKnowledge(db.client, input, scopes);
    const [sql, parameters] = db.query.mock.calls[0];
    expect(sql).not.toContain(input);
    expect(sql).toContain("ESCAPE '!'");
    expect(parameters).toEqual([scopes, ["warehouse", "or", "1"], ["%warehouse%", "%or%", "%1%"], 10]);
  });

  it("skips empty searches and clamps result limits", async () => {
    const db = collection([]);
    expect(await searchKnowledge(db.client, " %_ ", scopes)).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    await searchKnowledge(db.client, "warehouse", scopes, 1000);
    expect(db.query.mock.calls[0][1][3]).toBe(25);
    await searchKnowledge(db.client, "warehouse", scopes, Number.NaN);
    expect(db.query.mock.calls[1][1][3]).toBe(10);
  });
});
