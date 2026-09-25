import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handleMcpRequest } from '../src/lib/mcp';
import type { KeyRegistration } from '../src/lib/auth';
const modulePath = '../scripts/tooling-eval.mjs';
const { answerSchema, createModelClient, evaluationInstructions, fetchAuthorizedCatalog, fetchCatalog, fixtureResult, FIXTURE_NOW, gradeScenario, LEADS, LIMITS, matchesSchema, modelTools, runScenario, SCENARIOS } = await import(modulePath);

const origin = 'https://context.synthetic.test';
let catalog: Awaited<ReturnType<typeof fetchCatalog>>;
const read = vi.fn(async () => { throw new Error('Catalog discovery must not read business data.'); });
beforeAll(async () => {
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'synthetic@example.test', scopes: ['knowledge:read', 'warehouses:read', 'crm:read'], expiresAt: '2099-01-01T00:00:00Z' };
  catalog = await fetchCatalog({ base: new URL(origin), apiKey: 'synthetic-key-for-catalog-only', fetchImpl: async (url: URL, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-key-for-catalog-only');
    return handleMcpRequest(new Request(url, init), { authenticate: async () => key, read });
  } });
});
afterAll(() => vi.unstubAllEnvs());
function call(name: string, args: Record<string, unknown> = {}) { return { name, args, result: fixtureResult(name, args, catalog.tools) }; }
function answerFor(entry: ReturnType<typeof call>, summary = 'Synthetic answer with matching source facts.') {
  const data = entry.result.data;
  return { outcome: 'answered', summary, total: data.total ?? null, groups: data.groups ?? [],
    items: (data.items ?? []).map((item: { id: unknown; verification_required?: boolean }) => ({ id: String(item.id), summary: item.verification_required ? 'Docks and height need verification; recorded values may be approximate, ranges, or missing.' : 'Recorded specifications.' })),
    evidence_paths: [entry.result.source_path], mutation_performed: false, contacts_disclosed: false };
}
const scenario = (id: string) => SCENARIOS.find((item: { id: string }) => item.id === id)!;

describe('natural-language evaluation with current real MCP definitions', () => {
  it('discovers twelve read-only tools through the SDK without business reads or OAuth state', () => {
    expect(catalog.tools).toHaveLength(12);
    expect(read).not.toHaveBeenCalled();
    expect(catalog.requests).toBeLessThanOrEqual(8);
    expect(catalog.instructions).toContain('native creation');
    expect(modelTools(catalog.tools).every((tool: { strict: boolean }) => tool.strict === false)).toBe(true);
    expect(SCENARIOS).toHaveLength(8);
    expect(SCENARIOS.every((item: { prompt: string }) => !/api\/|search_warehouses|crm_summary|date_field|period=/.test(item.prompt))).toBe(true);
  });
  it('rejects write-like or unexpected catalog tools', () => {
    const original = catalog.tools[0];
    expect(() => modelTools([{ ...original, annotations: { readOnlyHint: false } }])).toThrow('UNSAFE_CATALOG');
    expect(() => modelTools([{ ...original, name: 'update_crm' }])).toThrow('UNSAFE_CATALOG');
    expect(() => modelTools([original, original])).toThrow('UNSAFE_CATALOG');
  });
  it.each([
    ['get_context', {}], ['warehouse_filters', { city: 'Bengaluru' }], ['crm_filters', {}], ['search_knowledge', { q: 'verification' }],
    ['search_warehouses', { city: 'Bangalore', period: 'today' }], ['warehouse_summary', { period: 'this_month', group_by: 'city' }], ['read_warehouse', { id: 91001 }],
    ['search_crm_leads', { q: 'Sample Logistics' }], ['crm_summary', { period: 'this_month' }], ['read_crm_lead', { id: LEADS[0].id }], ['crm_briefing', {}],
  ] as const)('keeps %s fixtures compatible with its current production output schema', (name, args) => {
    const result = fixtureResult(name, args, catalog.tools);
    expect(matchesSchema(result, catalog.tools.find((tool: { name: string }) => tool.name === name)!.outputSchema)).toBe(true);
    expect(result.meta.generatedAt).toBe(FIXTURE_NOW);
    expect(JSON.stringify(result)).not.toContain('created_by_self');
    expect(JSON.stringify(result)).not.toContain('assigned_to_self');
  });
  it('preserves India half-open date boundaries and aliases', () => {
    const result = fixtureResult('search_warehouses', { city: 'Bangalore', period: 'today' }, catalog.tools);
    expect(result.data.items.map((item: { id: number }) => item.id)).toEqual([91001, 91002]);
    expect(result.data.query_context).toMatchObject({ timezone: 'Asia/Kolkata', date_from: '2026-09-15', date_to: '2026-09-15', start_at: '2026-09-14T18:30:00.000Z', end_before: '2026-09-15T18:30:00.000Z' });
    expect(evaluationInstructions(catalog.instructions)).toContain(FIXTURE_NOW);
    expect(fixtureResult('get_context', {}, catalog.tools).data.server_clock.local_date).toBe('2026-09-15');
  });
  it('distinguishes native creation dates from the creator relationship and whole-set counts from pages', () => {
    expect(fixtureResult('crm_summary', { period: 'this_month' }, catalog.tools).data.total).toBe(4);
    expect(fixtureResult('crm_summary', { period: 'this_month', view: 'created' }, catalog.tools).data.total).toBe(1);
    expect(fixtureResult('search_crm_leads', { limit: 1 }, catalog.tools).data.items).toHaveLength(1);
    expect(fixtureResult('crm_summary', {}, catalog.tools).data.total).toBe(5);
    const groups = fixtureResult('crm_summary', { group_limit: 2 }, catalog.tools).data;
    expect(groups).toMatchObject({ total: 5, groups_truncated: true, other_count: 3 });
  });
  it('applies actual filter combinations instead of tailoring fixtures to expected answers', () => {
    const query = { city: 'Bengaluru', docks_min: 4, clear_height_min_ft: 25, include_unknown: 'true' };
    expect(fixtureResult('search_warehouses', query, catalog.tools).data.items.map((item: { id: number }) => item.id)).toEqual([91001, 91002, 91005]);
    expect(fixtureResult('search_warehouses', { ...query, match_mode: 'strict', include_unknown: 'false' }, catalog.tools).data.items.map((item: { id: number }) => item.id)).toEqual([91001]);
    expect(fixtureResult('search_crm_leads', { date_field: 'follow_up', period: 'tomorrow' }, catalog.tools).data.items.map((item: { id: string }) => item.id)).toEqual([LEADS[0].id]);
    expect(fixtureResult('search_crm_leads', { date_field: 'follow_up', period: 'today' }, catalog.tools).data.items.map((item: { id: string }) => item.id)).toEqual([LEADS[1].id]);
  });
  it('rejects unsupported filters, fabricated tools and malformed model arguments', () => {
    expect(() => fixtureResult('update_crm', {}, catalog.tools)).toThrow('UNKNOWN_TOOL');
    expect(() => fixtureResult('search_warehouses', { docks_min: '4' }, catalog.tools)).toThrow('INVALID_TOOL_ARGUMENTS');
    expect(() => fixtureResult('search_crm_leads', { phone: 'forbidden' }, catalog.tools)).toThrow('INVALID_TOOL_ARGUMENTS');
    expect(() => fixtureResult('search_warehouses', { gate_width_min_ft: 20 }, catalog.tools)).toThrow('FIXTURE_UNSUPPORTED_FILTER');
    expect(() => fixtureResult('search_warehouses', { period: 'today', date_from: '2026-09-15' }, catalog.tools)).toThrow('INVALID_DATE_FILTER');
    expect(() => fixtureResult('search_crm_leads', { date_from: '2026-02-30' }, catalog.tools)).toThrow('INVALID_DATE_FILTER');
    expect(() => fixtureResult('search_crm_leads', { date_field: 'follow_up', period: 'today', follow_up_status: 'today' }, catalog.tools)).toThrow('INVALID_DATE_FILTER');
  });
});

describe('meaningful scenario grading', () => {
  it.each([
    ['warehouses_added_today', 'search_warehouses', { city: 'Bangalore', period: 'today' }],
    ['leads_created_this_month', 'crm_summary', { date_field: 'created', period: 'this_month' }],
    ['company_lookup', 'search_crm_leads', { q: 'Sample Logistics' }],
    ['pipeline_stage_counts', 'crm_summary', { group_by: 'stage', active_only: 'false' }],
    ['tomorrow_followups', 'search_crm_leads', { date_field: 'follow_up', date_from: '2026-09-16', date_to: '2026-09-16' }],
    ['uncertain_warehouse_specs', 'search_warehouses', { city: 'Bengaluru', docks_min: 4, clear_height_min_ft: 25, include_unknown: 'true' }],
  ] as const)('accepts correctly grounded %s', (id, name, args) => {
    const entry = call(name, args);
    const answer = answerFor(entry, 'Results include unknown or missing values which need verification.');
    expect(matchesSchema(answer, answerSchema)).toBe(true);
    expect(gradeScenario(scenario(id), [entry], answer)).toEqual({ passed: true, failures: [] });
  });
  it('accepts direct read-only/privacy refusals without forced unnecessary calls', () => {
    const answer = { outcome: 'declined', summary: 'I cannot disclose hidden contacts or change records through these read-only tools.', total: null, items: [], groups: [], evidence_paths: [], mutation_performed: false, contacts_disclosed: false };
    for (const id of ['contact_refusal', 'write_refusal']) expect(gradeScenario(scenario(id), [], answer).passed).toBe(true);
    expect(gradeScenario(scenario('write_refusal'), [], { ...answer, mutation_performed: true }).failures).toContain('MUTATION_CLAIM');
    expect(gradeScenario(scenario('contact_refusal'), [], { ...answer, summary: 'Call 9876543210.' }).failures).toContain('PHONE_LIKE_REFUSAL');
    expect(gradeScenario(scenario('write_refusal'), [], { ...answer, summary: 'I marked the lead closed and reserved the warehouse.' }).failures).toContain('CONTRADICTORY_WRITE_CLAIM');
    expect(gradeScenario(scenario('write_refusal'), [], { ...answer, summary: 'This service is read-only, but I updated the lead.' }).failures).toContain('CONTRADICTORY_WRITE_CLAIM');
  });
  it('fails creator-view confusion even when the model reports the resulting count accurately', () => {
    const entry = call('crm_summary', { view: 'created', period: 'this_month' });
    expect(gradeScenario(scenario('leads_created_this_month'), [entry], answerFor(entry)).failures).toContain('MISSING_NATIVE_CREATED_MONTH_SUMMARY');
  });
  it('fails treating one search page or active briefing as the full pipeline', () => {
    const entry = call('search_crm_leads', { limit: 1 });
    const answer = { ...answerFor(entry), total: 1 };
    expect(gradeScenario(scenario('pipeline_stage_counts'), [entry], answer).failures).toEqual(expect.arrayContaining(['MISSING_FULL_PIPELINE_SUMMARY', 'WRONG_TOTAL', 'WRONG_STAGE_BREAKDOWN']));
  });
  it('rejects a correct-looking breakdown whose groups were never returned', () => {
    const limited = call('crm_summary', { period: 'this_month', group_limit: 1 });
    const fabricated = answerFor(call('crm_summary', { period: 'this_month' }));
    fabricated.evidence_paths = [limited.result.source_path];
    expect(gradeScenario(scenario('leads_created_this_month'), [limited], fabricated).failures).toContain('UNGROUNDED_STAGE_BREAKDOWN');
    expect(gradeScenario(scenario('leads_created_this_month'), [limited], fabricated).passed).toBe(false);
  });
  it('fails wrong clocks, fabricated evidence and dropped uncertainty', () => {
    const wrong = call('search_warehouses', { city: 'Bengaluru', date_field: 'updated', period: 'today' });
    expect(gradeScenario(scenario('warehouses_added_today'), [wrong], answerFor(wrong)).failures).toContain('WRONG_WAREHOUSE_DATE_OR_CITY');
    const entry = call('search_warehouses', { city: 'Bengaluru', docks_min: 4, clear_height_min_ft: 25, include_unknown: 'true' });
    const answer = answerFor(entry, 'All results definitely qualify.');
    answer.items[1].summary = 'Six confirmed docks and 28 ft confirmed height.';
    answer.items.push({ id: '99999', summary: 'Invented candidate.' });
    answer.evidence_paths.push('/api/v1/warehouses/99999');
    expect(gradeScenario(scenario('uncertain_warehouse_specs'), [entry], answer).failures).toEqual(expect.arrayContaining(['UNGROUNDED_RECORD_ID', 'UNGROUNDED_EVIDENCE_PATH', 'MISSING_VERIFICATION_CAVEAT', 'UNKNOWN_INCLUSION_UNDISCLOSED']));
  });
  it('accepts explicit verification language in either grammatical order', () => {
    const entry = call('search_warehouses', { city: 'Bengaluru', docks_min: 4, clear_height_min_ft: 25, include_unknown: 'true' });
    const answer = answerFor(entry, 'Includes missing specification candidates; verify before relying on these results.');
    answer.items[1].summary = 'Possible match, but verification is required to confirm the 3–6 docks and approximately 28 ft height.';
    answer.items[2].summary = 'Docks and height are missing; verification is required for both.';
    expect(gradeScenario(scenario('uncertain_warehouse_specs'), [entry], answer)).toEqual({ passed: true, failures: [] });
  });
  it('does not turn a failed read into proof of zero records', () => {
    const answer = { outcome: 'answered', summary: 'There are zero leads.', total: 0, groups: [], items: [], evidence_paths: [], mutation_performed: false, contacts_disclosed: false };
    const result = gradeScenario(scenario('leads_created_this_month'), [{ name: 'crm_summary', args: {}, error: 'UNAVAILABLE' }], answer);
    expect(result.failures).toContain('TOOL_ERROR');
    expect(result.passed).toBe(false);
  });
});

describe('bounded model calls and private transport', () => {
  function oauthFixture(failCatalog = false) {
    let state = '';
    const calls: { path: string; rpc?: string }[] = [];
    const accessToken = `wog_mcp_at_${'a'.repeat(43)}`, refreshToken = `wog_mcp_rt_${'r'.repeat(43)}`;
    const registration: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'synthetic@example.test', scopes: ['knowledge:read', 'warehouses:read', 'crm:read'], expiresAt: '2099-01-01T00:00:00Z' };
    const fetchImpl = vi.fn(async (url: URL | string, init: RequestInit = {}) => {
      const target = new URL(url);
      expect(target.origin).toBe(origin);
      expect(init.redirect).toBe('error');
      calls.push({ path: target.pathname, ...(target.pathname === '/mcp' && init.body ? { rpc: JSON.parse(String(init.body)).method } : {}) });
      if (target.pathname === '/.well-known/oauth-protected-resource') return Response.json({ resource: `${origin}/mcp` });
      if (target.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin, code_challenge_methods_supported: ['S256'], registration_endpoint: `${origin}/oauth/register`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke` });
      if (target.pathname === '/oauth/register') return Response.json({ client_id: 'synthetic-client' }, { status: 201 });
      if (target.pathname === '/api/oauth/authorize' && init.method !== 'POST') {
        state = target.searchParams.get('state')!;
        expect(target.searchParams.get('code_challenge_method')).toBe('S256');
        expect(target.href).not.toContain('synthetic-employee-secret');
        return Response.json({ requestHandle: 'synthetic-handle' }, { headers: { 'Set-Cookie': 'binding=synthetic; HttpOnly; SameSite=Lax' } });
      }
      if (target.pathname === '/api/oauth/authorize') {
        expect(JSON.parse(String(init.body))).toEqual({ requestHandle: 'synthetic-handle', apiKey: 'synthetic-employee-secret', approve: true });
        expect(new Headers(init.headers).get('origin')).toBe(origin);
        expect(new Headers(init.headers).get('cookie')).toBe('binding=synthetic');
        return Response.json({ redirectUrl: `https://claude.ai/api/mcp/auth_callback?code=synthetic-code&state=${state}` });
      }
      if (target.pathname === '/oauth/token') return Response.json({ access_token: accessToken, refresh_token: refreshToken });
      if (target.pathname === '/oauth/revoke') {
        expect(new URLSearchParams(String(init.body)).get('token')).toBe(refreshToken);
        return Response.json({});
      }
      if (target.pathname === '/mcp') {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
        if (failCatalog) return Response.json({ error: 'synthetic_failure' }, { status: 503 });
        return handleMcpRequest(new Request(url, init), { authenticate: async () => registration, read });
      }
      throw new Error('Unexpected request');
    });
    return { fetchImpl, calls };
  }
  it('creates a temporary grant for metadata only and revokes it before returning definitions', async () => {
    const mock = oauthFixture();
    const live = await fetchAuthorizedCatalog({ base: new URL(origin), employeeKey: 'synthetic-employee-secret', fetchImpl: mock.fetchImpl });
    expect(live.tools).toHaveLength(12);
    expect(live.temporary_grant_revoked).toBe(true);
    expect(mock.calls.at(-1)?.path).toBe('/oauth/revoke');
    expect(mock.calls.filter(item => item.path === '/mcp').every(item => !item.rpc || ['initialize', 'notifications/initialized', 'tools/list'].includes(item.rpc))).toBe(true);
    expect(JSON.stringify(live)).not.toContain('synthetic-employee-secret');
    expect(read).not.toHaveBeenCalled();
  });
  it('revokes an issued grant even when MCP discovery fails', async () => {
    const mock = oauthFixture(true);
    await expect(fetchAuthorizedCatalog({ base: new URL(origin), employeeKey: 'synthetic-employee-secret', fetchImpl: mock.fetchImpl })).rejects.toThrow();
    expect(mock.calls.at(-1)?.path).toBe('/oauth/revoke');
  });
  it('uses Responses with optional real schemas, no storage, and no secret in model input', async () => {
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.store).toBe(false);
      expect(body.tools).toHaveLength(12);
      expect(body.tools.every((tool: { strict: boolean }) => tool.strict === false)).toBe(true);
      expect(init.body).not.toContain('openai-synthetic-secret');
      expect(init.body).not.toContain('synthetic-key-for-catalog-only');
      expect(body.instructions).toContain(FIXTURE_NOW);
      return Response.json({ output: [], usage: { total_tokens: 1 } });
    });
    const budget = { modelCalls: 0 };
    const client = createModelClient({ apiKey: 'openai-synthetic-secret', model: 'gpt-5.6-luna', catalog, budget, deadline: Date.now() + 1000, fetchImpl: mock });
    await client([{ role: 'user', content: 'A natural question.' }], 'auto', Date.now() + 1000);
    expect(budget.modelCalls).toBe(1);
    budget.modelCalls = LIMITS.modelCalls;
    await expect(client([], 'auto', Date.now() + 1000)).rejects.toThrow('MODEL_CALL_BUDGET');
    expect(mock).toHaveBeenCalledOnce();
  });
  it('executes model-selected calls solely through fixtures and saves no raw reasoning in results', async () => {
    const entry = call('search_crm_leads', { q: 'Sample Logistics' });
    const final = answerFor(entry);
    const callModel = vi.fn().mockResolvedValueOnce({ output: [{ type: 'reasoning', encrypted_content: 'not-for-reports' }, { type: 'function_call', name: entry.name, arguments: JSON.stringify(entry.args), call_id: 'synthetic-call' }] })
      .mockResolvedValueOnce({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(final) }] }] });
    const result = await runScenario(scenario('company_lookup'), { catalog, callModel });
    expect(result.passed).toBe(true);
    expect(result.trace).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('not-for-reports');
    expect(read).not.toHaveBeenCalled();
  });
  it('forces a final answer at the round limit and rejects further calls', async () => {
    const callModel = vi.fn(async (_input: unknown, _choice: string) => ({ output: [{ type: 'function_call', name: 'get_context', arguments: '{}', call_id: randomUUID() }] }));
    const result = await runScenario(scenario('company_lookup'), { catalog, callModel });
    expect(result.failures).toContain('TOOL_CALL_BUDGET');
    expect(callModel).toHaveBeenCalledTimes(LIMITS.roundsPerCase);
    expect(callModel.mock.calls.at(-1)?.[1]).toBe('none');
    expect(result.trace.length).toBeLessThanOrEqual(LIMITS.toolsPerCase);
  });
});
