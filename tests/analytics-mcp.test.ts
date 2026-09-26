import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest } from '../src/lib/mcp';
import type { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration } from '../src/lib/auth';
import { getOpenApiDocument } from '../src/lib/openapi';

const origin = 'https://context.example.test';
const meta = { requestId: 'synthetic', generatedAt: '2026-09-26T12:00:00.000Z' };
const report = {
  source: { system: 'ga4', property: 'properties/123', timezone: 'Asia/Kolkata' },
  source_status: { status: 'available', read_only: true }, report: 'overview',
  query_context: { date_from: '2026-09-01', date_to: '2026-09-25', timezone: 'Asia/Kolkata', local_date: '2026-09-26',
    period: null, inclusive: true, includes_recent_days: true, event_name: null, query_contains: null, page_contains: null, data_state: null },
  columns: [{ name: 'sessions', kind: 'metric', unit: 'count' }],
  items: [{ dimensions: {}, metrics: { sessions: 20 }, redacted: false, verification_required: false }],
  pagination: { limit: 10, returned_count: 1, has_more: false, next_cursor: null, offset: 0, source_row_count: 1,
    cap_reached: false, max_rows: 500, snapshot: false }, nextCursor: null,
  source_fetched_at: meta.generatedAt, served_at: meta.generatedAt, cache: { hit: false, age_seconds: 0, max_age_seconds: 300 },
  quality: { provisional: true, warnings: ['Recent data can change.'], data_loss_from_other_row: false, subject_to_thresholding: false,
    sampling: [], schema_restrictions: [], data_truncated: false, empty_reason: null, privacy_redactions: false,
    totals_included: true, first_incomplete_date: null, aggregation_type: null }, quota: null,
};
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());
async function withClient(scopes: KeyRegistration['scopes'], read: typeof handleApiRequest | undefined,
  work: (client: Client) => Promise<void>) {
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'admin@example.test', scopes, expiresAt: '2099-01-01T00:00:00Z' };
  const client = new Client({ name: 'analytics-toy-harness', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: async (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => key, read }),
  });
  try { await client.connect(transport); await work(client); } finally { await client.close(); }
}

describe('analytics MCP contract', () => {
  it('advertises the three bounded analytics tools only with the analytics grant', async () => {
    for (const granted of [false, true]) {
      await withClient(granted ? ['knowledge:read', 'analytics:read'] : ['knowledge:read'], undefined, async client => {
        const { tools } = await client.listTools();
        for (const name of ['analytics_capabilities', 'ga4_report', 'search_console_report']) {
          expect(tools.some(tool => tool.name === name)).toBe(granted);
        }
        if (granted) for (const tool of tools.filter(tool => ['ga4_report', 'search_console_report'].includes(tool.name))) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
          expect(tool.inputSchema.additionalProperties).toBe(false);
          expect(tool.inputSchema.properties).not.toHaveProperty('property_id');
          expect(tool.inputSchema.properties).not.toHaveProperty('credentials');
        }
      });
    }
  });
  it.each([
    ['ga4_report', { report: 'events', event_name: 'generate_lead', period: 'this_month', limit: 2 }, ['analytics', 'ga4']],
    ['search_console_report', { group: 'query', period: 'last_28_days', query_contains: 'warehouse', limit: 2 }, ['analytics', 'search-console']],
  ] as const)('routes %s through REST authorization and validates the structured result', async (name, args, path) => {
    const read = vi.fn(async () => Response.json({ data: report, meta }));
    await withClient(['analytics:read'], read, async client => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ status: 200, data: { quality: { provisional: true }, source_fetched_at: meta.generatedAt } });
      const [request, route, overrides] = read.mock.calls[0] as unknown as [Request, string[], { revalidateKey: unknown }];
      expect(route).toEqual(path);
      expect(overrides.revalidateKey).toBeTypeOf('function');
      for (const [key, value] of Object.entries(args)) expect(new URL(request.url).searchParams.get(key)).toBe(String(value));
      expect(String((response.structuredContent as Record<string, unknown>)?.source_path)).not.toContain('query_contains');
    });
  });
  it('keeps source failures as MCP tool errors with retry guidance', async () => {
    const read = vi.fn(async () => Response.json({ error: { code: 'ANALYTICS_SOURCE_DENIED', message: 'Source unavailable.' }, meta },
      { status: 503, headers: { 'Retry-After': '10' } }));
    await withClient(['analytics:read'], read, async client => {
      const result = await client.callTool({ name: 'ga4_report', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 503, error: { code: 'ANALYTICS_SOURCE_DENIED' }, retry_after_seconds: 10 });
      expect(result.structuredContent).not.toHaveProperty('data');
    });
  });
  it('retains Search Console discovery when GA4 is unavailable', async () => {
    const partial = { read_only: true, access: 'admins_only',
      ga4: { status: 'unavailable', property: '123', timezone: null, source_fetched_at: null,
        error_code: 'ANALYTICS_SOURCE_DENIED', custom_dimensions: [], reports: [] },
      search_console: { status: 'configured_not_verified', property: 'sc-domain:example.test', timezone: 'America/Los_Angeles',
        groups: ['summary', 'date', 'query', 'page', 'country', 'device'] },
      periods: ['today', 'yesterday', 'last_7_days', 'last_28_days', 'this_month', 'last_month'],
      default_period: 'last_28_days', max_date_range_days: 93, max_rows_per_page: 25, max_report_rows: 500,
      served_at: meta.generatedAt, guidance: ['Configured does not establish successful source access.'] };
    await withClient(['analytics:read'], async () => Response.json({ data: partial, meta }), async client => {
      const result = await client.callTool({ name: 'analytics_capabilities', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { ga4: { status: 'unavailable' }, search_console: { status: 'configured_not_verified' } } });
    });
  });
  it('uses the same input bounds and enums in the public REST reference', async () => {
    const doc = getOpenApiDocument();
    await withClient(['analytics:read'], undefined, async client => {
      const { tools } = await client.listTools();
      for (const [name, route] of [['ga4_report', '/analytics/ga4'], ['search_console_report', '/analytics/search-console']] as const) {
        const tool = tools.find(value => value.name === name)!;
        const params = doc.paths[route].get.parameters;
        expect(params.map(param => param.name).sort()).toEqual(Object.keys(tool.inputSchema.properties ?? {}).sort());
        for (const param of params) expect(param.schema).toEqual(tool.inputSchema.properties?.[param.name]);
      }
    });
  });
});
