import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { KeyRegistration } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { handleMcpRequest } from '../src/lib/mcp';
import { handleApiRequest } from '../src/lib/api';
import type { PoolClient } from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clockContext, resolveDateQuery } from '../src/lib/query-time';
import { WAREHOUSE_FILTER_CATALOG } from '../src/lib/warehouse-fields';
import { getOpenApiDocument } from '../src/lib/openapi';
import { CRM_LEAD_SOURCES, CRM_LEASE_DURATIONS, CRM_INDUSTRIES } from '../src/lib/crm-fields';

const origin = 'https://context.example.test';
const employee = { id: 7, email: 'employee@example.test', is_active: true, dashboardAccess: true, adminAccess: false, twenty_user_id: null };
const now = new Date('2026-09-25T00:00:00Z');
const meta = { requestId: 'synthetic-mcp-test', generatedAt: now.toISOString() };
const contextData = { constraints: { contacts: 'masked_or_excluded', narrative_context: 'redacted_lead_context', media: 'excluded', crm_scope: 'created or assigned; verified Twenty admins see all', max_page_size: 25 }, employee_id: 7, read_only: true, scopes: ['knowledge:read'], knowledge_discovery: { permitted: true, status: 'not_checked', index_path: '/api/v1/wiki/pages', search_path: '/api/v1/wiki/search' }, server_clock: clockContext(now) };
const queryContext = { ...resolveDateQuery(new URLSearchParams(), ['created'], now), sort: 'id_asc', returned_count: 1, has_more: true };
const matchingPolicy = { mode: 'permissive', include_unknown: false, range_matching: 'overlap', guidance: 'Verify uncertain candidates.' };
const sourceStream = { source_watermark_at: now.toISOString(), last_run_at: now.toISOString(), status: 'ok' };
const crmAccess = {
  access_scope: 'created_or_assigned', source_status: { opportunities: sourceStream, notes: sourceStream, tasks: sourceStream },
  read_consistency: { database_snapshot: 'repeatable_read', transaction_started_at: now.toISOString(), lead_fields: 'same_row', cross_request_snapshot: false },
  activity_status: { status: 'current', unavailable_streams: [] }, field_semantics: 'Recorded categories may be defaults; verify monetary units.',
};
const missingText = { state: 'missing', text: null, redacted: false, truncated: false };
const ownership = { assigned_to: { state: 'missing', values: null, redacted: false }, supply_owners: { state: 'missing', values: null, redacted: false }, owner_workspace_member_id: null, created_by: { workspace_member_id: null, name: missingText, source: missingText }, updated_by: { workspace_member_id: null, name: missingText, source: missingText } };
const richLead = {
  close_date: null, ownership, verification_required: true,
  id: '77777777-7777-4777-8777-777777777777', name: 'Synthetic Logistics', stage: 'NEW_LEAD', source_created_at: now.toISOString(),
  lead_source: 'WEBSITE_SEO', lease_duration: 'LONG_TERM', industry_verticals: ['FMCG'], occupancy_timelines: null, preferred_languages: ['ENGLISH'], repeat_client: false,
  budget: { kind: 'exact', value: 25, min: null, max: null, currency: null, period: null, area_basis: null, verification_required: true },
  recorded_value: { amount_micros: '0', amount: '0', currency_code: null, verification_required: true },
  last_note_at: null, last_task_at: now.toISOString(), recorded_follow_up_count: 0, field_evidence: { budget: { state: 'parsed', source: null } },
};
function key(scopes: KeyRegistration['scopes'] = ['knowledge:read', 'warehouses:read', 'crm:read']): KeyRegistration {
  return { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: employee.email, scopes, expiresAt: '2099-01-01T00:00:00Z' };
}
function rpc(method: string, params: object = {}, init: RequestInit = {}) {
  return new Request(`${origin}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...init.headers } });
}
async function wire(response: Response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5));
  }
  return JSON.parse(text);
}
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());

describe('MCP read-only protocol', () => {
  it.each(['legacy', 'auto'] as const)('works through a real MCP SDK client with %s negotiation', async mode => {
    const registration = key(['knowledge:read']);
    const read = vi.fn(async () => Response.json({ data: contextData, meta }));
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: async (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => registration, read }),
    });
    const client = new Client({ name: 'wareongo-toy-harness', version: '1.0.0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name)).toContain('get_context');
      const result = await client.callTool({ name: 'get_context', arguments: {} });
      expect(result.structuredContent).toMatchObject({ data: { employee_id: 7, read_only: true } });
      expect(result.isError).not.toBe(true);
      expect(read).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
  it('challenges unauthenticated clients with OAuth discovery without exposing tools', async () => {
    const read = vi.fn();
    const response = await handleMcpRequest(rpc('tools/list'), { authenticate: async () => { throw new HttpError(401, 'UNAUTHORIZED', 'Connect your account.'); }, read });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`${origin}/.well-known/oauth-protected-resource`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(read).not.toHaveBeenCalled();
  });
  it('supports the legacy initialization used by existing MCP clients', async () => {
    const response = await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'toy-claude-client', version: '1.0' } }), { authenticate: async () => key() });
    expect(response.status).toBe(200);
    const body = await wire(response);
    expect(body.result.serverInfo.name).toBe('wareongo-context');
    expect(body.result.instructions).toContain('verification_required');
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });
  it('supports older clients and acknowledges initialized notifications without a session', async () => {
    const deps = { authenticate: async () => key() };
    const initialized = await wire(await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'older-client', version: '1' } }, { headers: { 'MCP-Protocol-Version': '2025-03-26' } }), deps));
    expect(initialized.result.protocolVersion).toBe('2025-03-26');
    const response = await handleMcpRequest(rpc('notifications/initialized', {}, { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), deps);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
  it('rejects malformed JSON and unsupported protocol versions', async () => {
    const deps = { authenticate: async () => key(), read: vi.fn() };
    expect((await handleMcpRequest(rpc('tools/list', {}, { body: '{' }), deps)).status).toBe(400);
    expect((await handleMcpRequest(rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '1999-01-01' } }), deps)).status).toBe(400);
    expect(deps.read).not.toHaveBeenCalled();
  });
  it('lists all thirteen read tools with warehouse catalogs and business output contracts', async () => {
    const response = await handleMcpRequest(rpc('tools/list'), { authenticate: async () => key() });
    const { result } = await wire(response);
    expect(result.tools).toHaveLength(13);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.outputSchema.required).toEqual(expect.arrayContaining(['source_path', 'status', 'data', 'meta']));
    }
    const warehouse = result.tools.find((tool: { name: string }) => tool.name === 'search_warehouses');
    expect(warehouse.inputSchema.additionalProperties).toBe(false);
    expect(warehouse.inputSchema.properties).toHaveProperty('docks_min');
    expect(warehouse.inputSchema.properties).toHaveProperty('power_min_kva');
    expect(Object.keys(warehouse.inputSchema.properties).sort()).toEqual([...WAREHOUSE_FILTER_CATALOG.map(field => field.name), 'response_format'].sort());
    expect(warehouse.inputSchema.properties.cursor.maxLength).toBe(1024);
    expect(warehouse.outputSchema.properties.data.required).toEqual(expect.arrayContaining(['items', 'nextCursor', 'query_context', 'matching_policy']));
    const crm = result.tools.find((tool: { name: string }) => tool.name === 'search_crm_leads');
    expect(crm.inputSchema.properties.date_field.enum).toContain('created');
    expect(crm.inputSchema.properties.period.enum).toContain('this_month');
    expect(crm.inputSchema.properties).toHaveProperty('q');
    expect(crm.inputSchema.properties.lead_source.enum).toEqual(CRM_LEAD_SOURCES);
    expect(crm.inputSchema.properties.lease_duration.enum).toEqual(CRM_LEASE_DURATIONS);
    expect(crm.inputSchema.properties.industry.enum).toEqual(CRM_INDUSTRIES);
    expect(crm.inputSchema.properties.requirement_sqft_min).toMatchObject({ type: 'integer', minimum: 1, maximum: 1_000_000_000 });
    expect(crm.inputSchema.properties.repeat_client.enum).toEqual(['true', 'false']);
    expect(crm.inputSchema.properties).not.toHaveProperty('budget_min');
    expect(crm.inputSchema.properties).not.toHaveProperty('amount_min');
    expect(crm.description).toContain('view=created, date_field=created, period=this_month');
    const summary = result.tools.find((tool: { name: string }) => tool.name === 'crm_summary');
    expect(summary.inputSchema.properties).not.toHaveProperty('cursor');
    expect(summary.inputSchema.properties.group_by.enum).toEqual(expect.arrayContaining(['lead_source', 'lease_duration']));
    expect(summary.outputSchema.properties.data.required).toEqual(expect.arrayContaining(['total', 'groups', 'groups_truncated', 'other_count', 'query_context', 'access_scope', 'source_status', 'read_consistency', 'activity_status', 'field_semantics']));
    const related = result.tools.find((tool: { name: string }) => tool.name === 'read_crm_lead_context');
    expect(related.inputSchema.required).toEqual(['id', 'section']);
    expect(related.inputSchema.properties.section.enum).toEqual(['notes', 'tasks', 'company', 'stage_history']);
    expect(related.inputSchema.properties.limit.maximum).toBe(10);
  });
  it('limits tool discovery to granted scopes, rejects unknown tools and does not expose writes', async () => {
    const read = vi.fn();
    const deps = { authenticate: async () => key(['knowledge:read']), read };
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), deps));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_context', 'search_knowledge', 'read_knowledge']);
    for (const name of ['search_crm_leads', 'read_crm_lead_context', 'crm_summary', 'crm_filters', 'warehouse_summary', 'update_warehouse', 'fetch', 'execute_sql']) {
      const body = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: {} }), deps));
      expect(body.error ?? body.result?.isError).toBeTruthy();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('invokes the REST read boundary in-process with bound identity and returns source provenance', async () => {
    const registration = key();
    const read = vi.fn(async (request: Request, path: string[], dependencies: Parameters<typeof handleApiRequest>[2]) => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBeNull();
      expect(path).toEqual(['warehouses']);
      expect(await dependencies!.authenticate!(request)).toEqual(registration);
      expect(new URL(request.url).searchParams.get('docks_min')).toBe('5');
      return Response.json({ data: { items: [{ id: 11, verification_required: true, field_evidence: { dock_count: { kind: 'range', lower: 4, upper: 8 } } }], nextCursor: '11', matching_policy: matchingPolicy, query_context: queryContext }, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: { city: 'Bengaluru', docks_min: 5, limit: 2 } }), { authenticate: async () => registration, read }));
    expect(body.result.structuredContent).toMatchObject({ source_path: '/api/v1/warehouses?city=Bengaluru&docks_min=5&limit=2', meta });
    expect(JSON.parse(body.result.content[0].text).data.items[0].verification_required).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });
  it('keeps concise candidates small without hiding requested unknowns or uncertain measurements', async () => {
    const item = { id: 12, city: 'Bengaluru', created_at: now.toISOString(), updated_at: now.toISOString(),
      dock_count: null, clear_height_ft: 30, power_kva: null, washroom_count: 8, land_type: 'Industrial',
      verification_required: true, field_evidence: {
        dock_count: { kind: 'range', lower: 2, upper: 6 }, clear_height_ft: { kind: 'exact', value: 30 },
        power_kva: { kind: 'unknown' }, gate_size_ft: { kind: 'approximate', value: 20 },
        washroom_count: { kind: 'exact', value: 8 },
      } };
    const read = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.has('response_format')).toBe(false);
      return Response.json({ data: { items: [item], nextCursor: null, matching_policy: matchingPolicy, query_context: queryContext }, meta });
    });
    const args = { power_min_kva: 100, include_unknown: 'true' };
    const concise = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: args }), { authenticate: async () => key(), read }));
    expect(concise.result.isError).not.toBe(true);
    const data = concise.result.structuredContent.data;
    expect(data.response_format).toBe('concise');
    expect(data.items[0]).toMatchObject({ id: 12, created_at: now.toISOString(), verification_required: true, power_kva: null,
      field_evidence: { dock_count: { kind: 'range', lower: 2, upper: 6 }, power_kva: { kind: 'unknown' }, gate_size_ft: { kind: 'approximate', value: 20 } } });
    expect(data.items[0]).not.toHaveProperty('land_type');
    expect(data.items[0].field_evidence).not.toHaveProperty('washroom_count');
    const detailed = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: { ...args, response_format: 'detailed' } }), { authenticate: async () => key(), read }));
    expect(detailed.result.structuredContent.data).toMatchObject({ response_format: 'detailed', items: [item] });
  });
  it('browses knowledge without a mandatory query and preserves pagination', async () => {
    const read = vi.fn(async (request: Request, path: string[]) => {
      expect(path).toEqual(['wiki', 'pages']);
      expect(new URL(request.url).searchParams.get('cursor')).toBe('opaque-next-page');
      return Response.json({ data: { items: [], nextCursor: null }, meta });
    });
    const result = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_knowledge', arguments: { cursor: 'opaque-next-page' } }), { authenticate: async () => key(), read }));
    expect(result.result.isError).not.toBe(true);
    expect(result.result.structuredContent.data).toEqual({ items: [], nextCursor: null });
    expect(result.result.structuredContent.source_path).toBe('/api/v1/wiki/pages');
    expect(result.result.structuredContent.meta.requestId).toBe(meta.requestId);
  });
  it('returns recorded filter options without repeating the input schema catalog', async () => {
    const read = vi.fn(async () => Response.json({ data: { catalog: WAREHOUSE_FILTER_CATALOG, options: { city: ['Bengaluru'] }, truncated: false }, meta }));
    const result = await wire(await handleMcpRequest(rpc('tools/call', { name: 'warehouse_filters', arguments: {} }), { authenticate: async () => key(), read }));
    expect(result.result.structuredContent.data).toEqual({ options: { city: ['Bengaluru'] }, truncated: false });
  });
  it.each([{ phone: '9876543210' }, { limit: 1000 }, { docks_min: -1 }])('rejects unsupported filters before business reads: %j', async args => {
    const read = vi.fn();
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_warehouses', arguments: args }), { authenticate: async () => key(), read }));
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ['crm_summary', { limit: 1 }], ['warehouse_summary', { cursor: '17' }],
    ['crm_filters', { employee_id: 42 }], ['search_crm_leads', { priority_min: 6 }],
    ['search_crm_leads', { period: 'whenever' }], ['search_crm_leads', { date_from: '09/01/2026' }],
    ['search_crm_leads', { cursor: 'a'.repeat(1025) }], ['search_warehouses', { cursor: 'a'.repeat(1025) }],
    ['search_crm_leads', { requirement_sqft_min: 0 }], ['search_crm_leads', { requirement_sqft_max: 1_000_000_001 }],
    ['search_crm_leads', { requirement_sqft_min: 12.5 }], ['search_crm_leads', { lead_source: 'PRIVATE_SOURCE' }],
    ['search_crm_leads', { industry: 'UNLISTED_INDUSTRY' }], ['search_crm_leads', { repeat_client: 'maybe' }],
    ['search_crm_leads', { budget_min: 10000 }], ['crm_summary', { group_by: 'recorded_value' }],
    ['read_crm_lead_context', { id: richLead.id }], ['read_crm_lead_context', { id: richLead.id, section: 'all' }],
    ['read_crm_lead_context', { id: richLead.id, section: 'notes', limit: 11 }], ['read_crm_lead_context', { id: richLead.id, section: 'notes', cursor: 'a'.repeat(2049) }],
  ])('rejects unsupported summary, identity or temporal inputs for %s', async (name, args) => {
    const read = vi.fn();
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: args }), { authenticate: async () => key(), read }));
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps creator scope independent of the requested creation period', async () => {
    const registration = key(['crm:read']);
    const read = vi.fn(async (request: Request, path: string[], deps: Parameters<typeof handleApiRequest>[2]) => {
      expect(path).toEqual(['crm', 'opportunities']);
      expect(await deps!.authenticate!(request)).toEqual(registration);
      expect(Object.fromEntries(new URL(request.url).searchParams)).toMatchObject({ view: 'created', date_field: 'created', period: 'this_month', q: 'Sample Logistics', sort: 'created_desc' });
      return Response.json({ data: { items: [], nextCursor: null, query_context: { ...resolveDateQuery(new URLSearchParams('date_field=created&period=this_month'), ['created'], now), sort: 'created_desc', returned_count: 0, has_more: false }, ...crmAccess }, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_crm_leads', arguments: { view: 'created', date_field: 'created', period: 'this_month', q: 'Sample Logistics', sort: 'created_desc' } }), { authenticate: async () => registration, read }));
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.data.query_context).toMatchObject({ date_from: '2026-09-01', date_to: '2026-09-30', timezone: 'Asia/Kolkata' });
    expect(read).toHaveBeenCalledOnce();
  });
  it.each(['warehouse_summary', 'crm_summary'])('preserves complete totals and truncated groups for %s', async name => {
    const data = { total: 37, group_by: 'city', groups: [{ value: 'Sample City', count: 30 }], groups_truncated: true, other_count: 7, query_context: queryContext,
      ...(name === 'crm_summary' ? crmAccess : { matching_policy: matchingPolicy }) };
    const read = vi.fn(async (request: Request, path: string[]) => {
      expect(path).toEqual(name === 'crm_summary' ? ['crm', 'summary'] : ['warehouses', 'summary']);
      expect(new URL(request.url).searchParams.get('group_limit')).toBe('1');
      return Response.json({ data, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: { group_by: 'city', group_limit: 1, period: 'this_month' } }), { authenticate: async () => key(), read }));
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.data).toMatchObject({ total: 37, groups_truncated: true, other_count: 7 });
  });
  it('routes scoped CRM discovery and preserves a truncated vocabulary', async () => {
    const read = vi.fn(async (request: Request, path: string[]) => {
      expect(path).toEqual(['crm', 'filters']);
      expect(new URL(request.url).searchParams.get('view')).toBe('assigned');
      return Response.json({ data: { cities: ['Sample City'], cities_truncated: true, stages: ['NEW_LEAD'], date_fields: ['created'], periods: ['this_month'], sorts: ['id_asc'], lead_sources: CRM_LEAD_SOURCES, lease_durations: CRM_LEASE_DURATIONS, industries: CRM_INDUSTRIES, filter_guidance: 'Unknown values do not match; recorded categories may be defaults.', ...crmAccess }, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'crm_filters', arguments: { view: 'assigned' } }), { authenticate: async () => key(), read }));
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.data.cities_truncated).toBe(true);
    expect(body.result.structuredContent.data.lead_sources).toEqual(CRM_LEAD_SOURCES);
    expect(body.result.structuredContent.data).not.toHaveProperty('micro_markets');
  });
  it.each(['search_crm_leads', 'read_crm_lead', 'crm_briefing'])('preserves structured details, unknown units and degraded activity for %s in one read', async name => {
    const metadata = { ...crmAccess, activity_status: { status: 'degraded', unavailable_streams: ['notes'] } };
    const data = name === 'search_crm_leads'
      ? { items: [richLead], nextCursor: null, query_context: queryContext, ...metadata }
      : name === 'read_crm_lead' ? { ...richLead, ...metadata, description: missingText, loss_reason: missingText }
        : { as_of: now.toISOString(), timezone: 'Asia/Kolkata', total_active: 1, counts_by_stage: { NEW_LEAD: 1 }, counts_by_sla: { unknown: 1 }, follow_up_overdue: 0, priorities: [richLead], ...metadata };
    const filters = { requirement_sqft_min: 10000, requirement_sqft_max: 50000, micro_market: 'North, East', lead_source: 'WEBSITE_SEO', lease_duration: 'LONG_TERM', industry: 'FMCG', repeat_client: 'false' };
    const args = name === 'read_crm_lead' ? { id: richLead.id } : name === 'search_crm_leads' ? filters : {};
    const read = vi.fn(async (request: Request) => {
      if (name === 'search_crm_leads') expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ ...filters, requirement_sqft_min: '10000', requirement_sqft_max: '50000' });
      return Response.json({ data, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name, arguments: args }), { authenticate: async () => key(), read }));
    expect(body.result.isError).not.toBe(true);
    expect(read).toHaveBeenCalledOnce();
    const result = body.result.structuredContent.data;
    const lead = name === 'search_crm_leads' ? result.items[0] : name === 'crm_briefing' ? result.priorities[0] : result;
    expect(lead).toMatchObject(richLead);
    expect(result.read_consistency).toEqual(crmAccess.read_consistency);
    expect(result.activity_status).toEqual(metadata.activity_status);
    expect(result.field_semantics).toBe(crmAccess.field_semantics);
  });
  it('returns a tool error when a successful read violates the declared aggregate contract', async () => {
    const read = vi.fn(async () => Response.json({ data: { total: '37', groups: [] }, meta }));
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'crm_summary', arguments: {} }), { authenticate: async () => key(), read }));
    expect(body.result?.isError ?? body.error).toBeTruthy();
  });
  it.each(['notes', 'tasks', 'company', 'stage_history'])('routes one related %s section and preserves independent source clocks and coverage', async section => {
    const text = { state: 'redacted', text: 'Recorded context. Contact [phone omitted].', redacted: true, truncated: false };
    const narrative = { id: richLead.id, title: text, body: text, source_created_at: now.toISOString(), source_updated_at: now.toISOString() };
    const item = section === 'notes' ? narrative : section === 'tasks' ? { ...narrative, status: 'TODO', due_at: null, assignee: null, assignee_status: 'unassigned' }
      : section === 'company' ? { id: richLead.id, name: text, employees: null, ideal_customer_profile: null, city: null, state: null, country: null, source_created_at: now.toISOString(), source_updated_at: now.toISOString() }
        : { id: 'synthetic-transition', from_stage: 'NEW_LEAD', to_stage: 'SITE_VISIT', changed_at: now.toISOString(), detected_at: now.toISOString() };
    const data = { ...crmAccess, section, items: [item], nextCursor: null,
      read_consistency: { ...crmAccess.read_consistency, related_sources_atomic: false },
      source_fetched_at: now.toISOString(), source_opportunity_updated_at: now.toISOString(), mirror_source_updated_at: '2026-09-24T00:00:00.000Z', lead_version_matches_mirror: false,
      freshness_basis: section === 'stage_history' ? 'observed_mirror_history' : 'live_twenty_read', text_guidance: 'Separate observations; do not reconstruct masked contacts.',
      coverage: { scanned: 1, returned: 1, withheld: 0, has_more: false,
        ...(section === 'company' ? { relationship_policy: 'linked_company_only', link_status: 'available' } : section === 'stage_history' ? { relationship_policy: 'scoped_lead_history', history_complete: false } : { relationship_policy: 'single_lead_only', guidance: 'Shared activity is withheld.' }) } };
    const read = vi.fn(async (request: Request, path: string[]) => {
      expect(path).toEqual(['crm', 'opportunities', richLead.id, 'context']);
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ section, limit: '2' });
      return Response.json({ data, meta });
    });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'read_crm_lead_context', arguments: { id: richLead.id, section, limit: 2 } }), { authenticate: async () => key(), read }));
    expect(body.result.isError).not.toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(body.result.structuredContent.data).toEqual(data);
    expect(body.result.structuredContent.source_path).toBe(`/api/v1/crm/opportunities/${richLead.id}/context?section=${section}&limit=2`);
  });
  it('documents matching temporal and summary contracts in the REST specification', () => {
    const document = getOpenApiDocument();
    const crm = document.paths['/crm/opportunities'].get.parameters;
    expect(crm.map(parameter => parameter.name)).toEqual(expect.arrayContaining(['q', 'date_field', 'period', 'date_from', 'date_to', 'sort', 'follow_up_status', 'requirement_sqft_min', 'requirement_sqft_max', 'micro_market', 'lead_source', 'lease_duration', 'industry', 'repeat_client']));
    expect(document.components.schemas.Opportunity.properties).toHaveProperty('source_created_at');
    expect(Object.keys(document.components.schemas.Opportunity.properties)).toEqual(expect.arrayContaining(['budget', 'recorded_value', 'lead_source', 'lease_duration', 'industry_verticals', 'occupancy_timelines', 'preferred_languages', 'repeat_client', 'last_note_at', 'last_task_at', 'recorded_follow_up_count']));
    expect(document.components.schemas.CrmBudget.properties.currency.enum).toContain(null);
    expect(document.components.schemas.CrmBudget.properties.verification_required.const).toBe(true);
    expect(document.components.schemas.CrmReadConsistency.properties.cross_request_snapshot.const).toBe(false);
    expect(document.components.schemas.OpportunityDetail.required).toEqual(expect.arrayContaining(['read_consistency', 'activity_status', 'field_semantics']));
    expect(document.components.schemas.OpportunityDetail.required).toEqual(expect.arrayContaining(['ownership', 'close_date', 'description', 'loss_reason']));
    expect(document.components.schemas.CrmBudget.properties.kind.enum).toEqual(expect.arrayContaining(['upper_bound', 'lower_bound']));
    const related = document.paths['/crm/opportunities/{id}/context'].get.parameters;
    expect(related.find(parameter => parameter.name === 'section')).toMatchObject({ required: true, schema: { enum: ['notes', 'tasks', 'company', 'stage_history'] } });
    for (const route of ['/warehouses/summary', '/crm/summary'] as const) {
      const params = document.paths[route].get.parameters.map(parameter => parameter.name);
      expect(params).toContain('group_limit');
      expect(params).not.toContain('limit');
      expect(params).not.toContain('cursor');
      expect(params).not.toContain('sort');
    }
    expect(document.paths['/crm/filters'].get.parameters.map(parameter => parameter.name)).toEqual(['view', 'assigned_to']);
  });
  it('preserves sanitization through the actual API boundary', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('VerifiedNumber') ? [employee] : sql.includes('"Warehouse"') ? [{ id: 12, city: 'Bengaluru', contactNumber: '9876543210', media: { secret: 'private' }, total_space_sqft: [40000] }] : [] }));
    const read: typeof handleApiRequest = (request, path, deps) => handleApiRequest(request, path, { ...deps, transaction: async work => work({ query } as unknown as PoolClient), audit: () => {} });
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'read_warehouse', arguments: { id: 12 } }), { authenticate: async () => key(), read }));
    expect(body.result.structuredContent.data.id).toBe(12);
    expect(JSON.stringify(body)).not.toMatch(/9876543210|contactNumber|media|secret/);
  });
  it('keeps failures as tool errors rather than an empty list', async () => {
    const read = vi.fn(async () => Response.json({ error: { code: 'CRM_SOURCE_STALE', message: 'CRM needs a recent sync.' } }, { status: 503, headers: { 'Retry-After': '10' } }));
    const body = await wire(await handleMcpRequest(rpc('tools/call', { name: 'search_crm_leads', arguments: {} }), { authenticate: async () => key(), read }));
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.status).toBe(503);
    expect(body.result.structuredContent.error.code).toBe('CRM_SOURCE_STALE');
    expect(body.result.structuredContent.retry_after_seconds).toBe(10);
    expect(body.result.structuredContent).not.toHaveProperty('data');
  });
  it('does not share identity between simultaneous requests', async () => {
    const a = key(['knowledge:read']); const b = key(['knowledge:read']);
    const read: typeof handleApiRequest = async (request, _path, deps) => {
      const identity = await deps!.authenticate!(request);
      await new Promise(resolve => setTimeout(resolve, identity.id === a.id ? 10 : 1));
      return Response.json({ data: { ...contextData, marker: identity.id }, meta });
    };
    const values = await Promise.all([a, b].map(async registration => wire(await handleMcpRequest(rpc('tools/call', { name: 'get_context', arguments: {} }), { authenticate: async () => registration, read }))));
    expect(values.map(v => v.result.structuredContent.data.marker)).toEqual([a.id, b.id]);
  });
  it('rejects hostile origins and credentials in query strings before authentication', async () => {
    const authenticate = vi.fn(async () => key());
    expect((await handleMcpRequest(rpc('tools/list', {}, { headers: { Origin: 'https://evil.example' } }), { authenticate })).status).toBe(403);
    expect((await handleMcpRequest(new Request(`${origin}/mcp?token=secret`), { authenticate })).status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('bounds JSON payloads, rejects writes outside the protocol and avoids idle streams', async () => {
    const deps = { authenticate: async () => key(), read: vi.fn() };
    expect((await handleMcpRequest(rpc('tools/call', { large: 'a'.repeat(33000) }), deps)).status).toBe(413);
    expect((await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'DELETE' }), deps)).status).toBe(405);
    expect((await handleMcpRequest(new Request(`${origin}/mcp`), deps)).status).toBe(405);
    const cors = await handleMcpRequest(new Request(`${origin}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai' } }), deps);
    expect(cors.status).toBe(204);
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(cors.headers.get('access-control-allow-headers')).toContain('MCP-Method');
    expect(deps.read).not.toHaveBeenCalled();
  });
});
