import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest } from '../src/lib/mcp';
import type { handleApiRequest } from '../src/lib/api';
import { getOpenApiDocument } from '../src/lib/openapi';
import { CALL_PERFORMANCE_SCOPE } from '../src/lib/call-performance-query';
import type { KeyRegistration } from '../src/lib/auth';
vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));

const origin = 'https://context.example.test';
const names = ['call_performance_capabilities', 'call_performance_summary', 'search_call_assignments', 'read_call_assignment'];
const now = '2026-11-05T12:00:00.000Z';
const base = { source: 'callongo', read_only: true, snapshot_at: now, timezone: 'Asia/Kolkata', guidance: 'Preserve evidence limits.',
  coverage: { scope: 'whole_source', manual_attempts: 2, first_audit_at: null, assignments_without_audit: 1,
    employee_callers: 5, linked_employee_callers: 2, callyzer_last_success_at: '2026-10-27T12:00:00.000Z',
    callyzer_status: 'stale', warnings: ['Missing activity does not prove inactivity.'] } };
const caller = { email: 'alice@example.test', name: 'Alice', active: true };
const context = { date_basis: 'assigned_at', state_basis: 'current', date_from: null, date_to: null, start_at: null, end_before: null, filters: {} };
const counts = { assignments: 1, open: 1, done: 0, dropped: 0, available: 0, unavailable: 0, unclear: 0, missing_outcome: 1,
  staff_marked_added: 0, distinct_numeric_references: 0, open_under_7_days: 1, open_7_to_30_days: 0, open_30_days_plus: 0 };
const assignment = { id: '9007199254740993', entity_type: 'record', entity_id: '00000000-0000-4000-8000-000000000001',
  caller, assigned_at: now, state: 'open', outcome: null, completed_at: null, staff_marked_added: false,
  has_recorded_reference: false, numeric_warehouse_reference: null, open_age_days: 0, audit_events: 0,
  source_path: '/api/v1/calls/assignments/9007199254740993' };
const page = { nextCursor: null, pagination: { limit: 25, has_more: false, snapshot: false } };
const results = {
  capabilities: { ...base, callers: [caller], callers_truncated: false,
    filters: { states: ['open', 'done', 'dropped'], outcomes: ['Available', 'Unavailable', 'Unclear'], entity_types: ['record', 'call'], gaps: [] },
    metrics: [{ name: 'assignments', definition: 'Assignment episodes.' }], max_page_size: 25, max_date_range_days: 366 },
  summary: { ...base, query_context: context, totals: counts, callers: [{ caller, metrics: counts }], callers_truncated: false, assignments_outside_caller_breakdown: 0 },
  assignments: { ...base, query_context: context, items: [assignment], ...page },
  detail: { ...base, assignment, history: [], history_has_creation_event: false, ...page },
};
async function clientFor(granted: boolean, read: typeof handleApiRequest, platform: 'claude' | 'whatsapp' = 'claude') {
  const key: KeyRegistration = { id: randomUUID(), employeeId: 7, hash: 'a'.repeat(64), employeeEmail: 'analyst@example.test',
    scopes: granted ? [CALL_PERFORMANCE_SCOPE] : ['analytics:read'], expiresAt: '2099-01-01T00:00:00Z' };
  const client = new Client({ name: 'call-report-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => key, read, platform }),
  }));
  return client;
}
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());
describe('caller performance MCP and OpenAPI contract', () => {
  it.each(['claude', 'whatsapp'] as const)('discovers and executes the four bounded read tools on %s', async platform => {
    const read = vi.fn(async (_request: Request, path: string[]) => Response.json({
      data: path.length === 3 ? results.detail : results[path[1] as 'summary' | 'capabilities' | 'assignments'],
      meta: { requestId: 'synthetic', generatedAt: now },
    }));
    const client = await clientFor(true, read, platform);
    try {
      const { tools } = await client.listTools();
      for (const name of names) {
        const tool = tools.find(t => t.name === name)!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool._meta?.['wareongo/context-read-v1']).toEqual({ requiredScopes: [CALL_PERFORMANCE_SCOPE], sourceFamily: 'calls' });
      }
      const cases = [
        { name: names[0], arguments: {}, path: ['calls', 'capabilities'] },
        { name: names[1], arguments: { caller: caller.email }, path: ['calls', 'summary'] },
        { name: names[2], arguments: { min_open_age_days: 7 }, path: ['calls', 'assignments'] },
        { name: names[3], arguments: { id: assignment.id }, path: ['calls', 'assignments', assignment.id] },
      ];
      for (const entry of cases) {
        const result = await client.callTool({ name: entry.name, arguments: entry.arguments });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 200,
          data: { coverage: { callyzer_status: 'stale', warnings: base.coverage.warnings } },
          meta: { toolName: entry.name, argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        expect((result.structuredContent as { source_path: string }).source_path).not.toContain('alice');
        expect(read.mock.calls.at(-1)?.[1]).toEqual(entry.path);
      }
      expect(new URL(read.mock.calls[1][0].url).searchParams.get('caller')).toBe(caller.email);
      expect(new URL(read.mock.calls[3][0].url).searchParams.has('id')).toBe(false);
      read.mockClear();
      for (const arguments_ of [{ limit: 100 }, { sql: 'select 1' }, { state: 'won' }]) {
        const result = await client.callTool({ name: 'search_call_assignments', arguments: arguments_ });
        expect(result.isError).toBe(true);
      }
      expect(read).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it('does not advertise or execute caller reports with website analytics scope alone', async () => {
    const read = vi.fn();
    const client = await clientFor(false, read);
    try {
      expect((await client.listTools()).tools.some(tool => names.includes(tool.name))).toBe(false);
      await expect(client.callTool({ name: names[1], arguments: {} })).rejects.toThrow('not found');
      expect(read).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it('publishes the same parameters and result schemas through OpenAPI', () => {
    const paths = getOpenApiDocument().paths;
    expect(paths['/calls/summary'].get.operationId).toBe('call_performance_summary');
    expect(paths['/calls/summary'].get.parameters.map(p => p.name)).not.toContain('limit');
    expect(paths['/calls/assignments'].get.parameters.map(p => p.name)).toContain('cursor');
    expect(paths['/calls/assignments/{id}'].get.parameters.find(p => p.name === 'id')).toMatchObject({ in: 'path', required: true });
  });
});
