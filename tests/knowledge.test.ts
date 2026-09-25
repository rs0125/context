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
    body_length: 40, score: 0, body: "Synthetic document used only in tests.", ...overrides,
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

function collection(pages: unknown[]) {
  return database(pages);
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
    expect(await listKnowledge(db.client, scopes)).toEqual({ items: [{
      id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary", updatedAt: "2026-09-25",
    }], nextCursor: null });
    const [sql, parameters] = db.query.mock.calls[0];
    assertSqlAccess(sql);
    expect(sql).toContain("LIMIT $4");
    expect(sql).not.toContain("LIMIT 501");
    expect(parameters).toEqual([scopes, [], [], 11, null, null]);
  });

  it("performs no database query without knowledge:read", async () => {
    const db = database([]);
    expect(await listKnowledge(db.client, [])).toEqual({ items: [], nextCursor: null });
    expect(await readKnowledge(db.client, "synthetic-guide", ["crm:read"])).toBeNull();
    expect(await searchKnowledge(db.client, "warehouse", ["warehouses:read"])).toEqual({ items: [], nextCursor: null });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("defensively excludes draft and insufficiently scoped rows from every output", async () => {
    const rows = [page(), page({ id: "unpublished", status: "draft" }),
      page({ id: "restricted", scopes: ["knowledge:read", "crm:read"] })];
    expect((await listKnowledge(collection(rows).client, scopes)).items.map(({ id }) => id)).toEqual(["synthetic-guide"]);
    expect((await searchKnowledge(collection(rows.map(searchPage)).client, "warehouse", scopes)).items.map(({ id }) => id))
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

  it("rejects duplicate ids and mismatched reads", async () => {
    await expect(listKnowledge(collection([page(), page()]).client, scopes)).rejects.toMatchObject(unavailable);
    await expect(readKnowledge(database([page({ id: "wrong-page" })]).client, "synthetic-guide", scopes))
      .rejects.toMatchObject(unavailable);
  });

  it("returns null for an absent page and exposes no driver error or local fallback", async () => {
    expect(await readKnowledge(database([]).client, "synthetic-guide", scopes)).toBeNull();
    const db = database([]);
    db.query.mockRejectedValue(new Error("Synthetic private driver detail"));
    await expect(listKnowledge(db.client, scopes)).rejects.toMatchObject(unavailable);
    await expect(readKnowledge(db.client, "synthetic-guide", scopes)).rejects.toMatchObject(unavailable);
    await expect(searchKnowledge(db.client, "warehouse", scopes)).rejects.toMatchObject(unavailable);
  });

  it("rejects oversized result pages", async () => {
    await expect(listKnowledge(database(Array.from({ length: 12 }, (_, i) => page({ id: `page-${i}` }))).client, scopes))
      .rejects.toMatchObject(unavailable);
  });

});

describe("bounded SQL knowledge search", () => {
  it("ranks title, summary, and body in SQL and returns only a compact plain-text snippet", async () => {
    const db = collection([searchPage({ snippet_source: "## Synthetic **warehouse** [guidance](https://example.invalid)." })]);
    const results = await searchKnowledge(db.client, "warehouse Warehouse", scopes, 3);
    expect(results).toEqual({ items: [{
      id: "synthetic-guide", title: "Synthetic guide", summary: "Synthetic test summary", updatedAt: "2026-09-25",
      snippet: "Synthetic warehouse guidance.",
    }], nextCursor: null });
    const [sql, parameters] = db.query.mock.calls[0];
    assertSqlAccess(sql);
    expect(sql).toContain("p.title ILIKE term.pattern ESCAPE '!' THEN 8");
    expect(sql).toContain("p.summary ILIKE term.pattern ESCAPE '!' THEN 4");
    expect(sql).toContain("p.body ILIKE term.pattern ESCAPE '!' THEN 1");
    expect(sql).toContain("ORDER BY score DESC, id COLLATE \"C\" LIMIT $4");
    expect(sql).toContain("substring(body FROM snippet_start FOR 320)");
    expect(parameters).toEqual([scopes, ["warehouse"], ["%warehouse%"], 4, null, null]);
  });

  it("adds omission markers while keeping snippets bounded", async () => {
    const db = collection([searchPage({ snippet_source: "warehouse ".repeat(32), snippet_before: true, snippet_after: true })]);
    const { items: [result] } = await searchKnowledge(db.client, "warehouse", scopes);
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
    expect(parameters).toEqual([scopes, ["1", "or", "warehouse"], ["%1%", "%or%", "%warehouse%"], 11, null, null]);
  });

  it("skips empty searches and clamps result limits", async () => {
    const db = collection([]);
    expect(await searchKnowledge(db.client, " %_ ", scopes)).toEqual({ items: [], nextCursor: null });
    expect(db.query).not.toHaveBeenCalled();
    await searchKnowledge(db.client, "warehouse", scopes, 1000);
    expect(db.query.mock.calls[0][1][3]).toBe(26);
    await searchKnowledge(db.client, "warehouse", scopes, Number.NaN);
    expect(db.query.mock.calls[1][1][3]).toBe(11);
  });
});


describe("knowledge pagination", () => {
  it("continues a bounded index instead of imposing a 500-document collection limit", async () => {
    const db = database([page({ id: 'guide-a' }), page({ id: 'guide-b' })]);
    const first = await listKnowledge(db.client, scopes, 1);
    expect(first.items.map(item => item.id)).toEqual(['guide-a']);
    expect(first.nextCursor).toBeTypeOf('string');
    db.query.mockResolvedValueOnce({ rows: [page({ id: 'guide-b' })] });
    const next = await listKnowledge(db.client, scopes, 5, first.nextCursor!);
    expect(next.items.map(item => item.id)).toEqual(['guide-b']);
    expect(next.nextCursor).toBeNull();
    expect(db.query.mock.calls[1][1]).toEqual([scopes, [], [], 6, 'guide-a', 0]);
    expect(db.query.mock.calls[0][0]).not.toContain('LIMIT 501');
  });

  it("binds ranking cursors to normalized terms and permission scopes", async () => {
    const db = database([searchPage({ id: 'guide-a' }), searchPage({ id: 'guide-b' })]);
    const first = await searchKnowledge(db.client, 'warehouse', scopes, 1);
    const changed = database([]);
    await expect(searchKnowledge(changed.client, 'pricing', scopes, 1, first.nextCursor!)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(searchKnowledge(changed.client, 'warehouse', [...scopes, 'crm:read'], 1, first.nextCursor!)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(changed.query).not.toHaveBeenCalled();
    expect(await searchKnowledge(changed.client, 'WAREHOUSE warehouse', scopes, 4, first.nextCursor!)).toEqual({ items: [], nextCursor: null });
    expect(changed.query.mock.calls[0][1]).toEqual([scopes, ['warehouse'], ['%warehouse%'], 5, 'guide-a', 8]);
  });

  it.each(['', 'plain-id', 'x'.repeat(1025), Buffer.from(JSON.stringify({ v: 1, id: '../secret', score: 0 })).toString('base64url')])('rejects malformed cursor %s before querying', async cursor => {
    const db = database([]);
    await expect(listKnowledge(db.client, scopes, 1, cursor)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
