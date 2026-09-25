import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readEnv } from './env-utils.mjs';

// Explicit live check: creates and revokes a connector grant, never changes
// warehouse, CRM, knowledge or employee records. Prints only counts/statuses.
const { values } = parseArgs({ options: {
  'env-file': { type: 'string', default: '.env.local' },
  'key-file': { type: 'string', default: '.local/keys/local-trial.json' },
  origin: { type: 'string' },
} });
const check = (condition, code) => { if (!condition) throw new Error(code); };
let requests = 0;
let refreshToken;
let clientId;
let origin;
let metadata;
async function request(path, init = {}) {
  const url = new URL(path, origin);
  check(url.origin === origin, 'UNEXPECTED_DESTINATION');
  requests++;
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
}
async function json(path, body, extraHeaders = {}) {
  const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  return { response, value: await response.json() };
}
async function form(path, body) {
  const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { response, value: await response.json() };
}
async function sdk(token, work) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => request(String(url), init),
  });
  const client = new Client({ name: 'wareongo-live-verification', version: '1.0.0' });
  try { await client.connect(transport); return await work(client); }
  finally { await client.close(); }
}
function data(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function main() {
  const env = await readEnv(values['env-file']);
  const base = new URL(values.origin ?? env.CONTEXT_CONSOLE_ORIGIN);
  check(base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password, 'INVALID_ORIGIN');
  check(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)), 'INVALID_ORIGIN');
  origin = base.origin;
  const key = JSON.parse(await readFile(values['key-file'], 'utf8')).apiKey;
  check(/^wog_ctx_[A-Za-z0-9_-]{43}$/.test(key), 'INVALID_TEST_KEY');
  const anonymous = await request('/mcp');
  check(anonymous.status === 401 && anonymous.headers.get('www-authenticate')?.includes('oauth-protected-resource'), 'MCP_AUTH_DISCOVERY_FAILED');
  const resource = await (await request('/.well-known/oauth-protected-resource')).json();
  check(resource.resource === `${origin}/mcp`, 'RESOURCE_METADATA_MISMATCH');
  metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  check(metadata.issuer === origin && metadata.code_challenge_methods_supported?.includes('S256'), 'OAUTH_METADATA_INVALID');
  for (const name of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint']) {
    check(new URL(metadata[name]).origin === origin, 'UNEXPECTED_AUTHORITY');
  }
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  const registered = await json(metadata.registration_endpoint, { client_name: 'Wareongo connector verification', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  check(registered.response.status === 201, 'CLIENT_REGISTRATION_FAILED');
  clientId = registered.value.client_id;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback, resource: resource.resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
  const previewResponse = await request(`/api/oauth/authorize?${query}`);
  check(previewResponse.status === 200, 'CONSENT_PREVIEW_FAILED');
  const preview = await previewResponse.json();
  const cookies = previewResponse.headers.getSetCookie();
  check(cookies.length > 0 && cookies.every(cookie => cookie.includes('HttpOnly')), 'CONSENT_COOKIE_MISSING');
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  const consent = await json('/api/oauth/authorize', { requestHandle: preview.requestHandle, apiKey: key, approve: true }, { Origin: origin, Cookie: cookie });
  check(consent.response.status === 200, 'CONSENT_FAILED');
  const redirect = new URL(consent.value.redirectUrl);
  check(redirect.origin + redirect.pathname === callback && redirect.searchParams.get('state') === state, 'CALLBACK_BINDING_FAILED');
  const issued = await form(metadata.token_endpoint, { grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback,
    resource: resource.resource, code: redirect.searchParams.get('code'), code_verifier: verifier });
  check(issued.response.status === 200 && issued.value.token_type?.toLowerCase() === 'bearer', 'TOKEN_EXCHANGE_FAILED');
  refreshToken = issued.value.refresh_token;
  const checks = await sdk(issued.value.access_token, async client => {
    const tools = await client.listTools();
    check(tools.tools.length >= 3 && tools.tools.every(tool => tool.annotations?.readOnlyHint === true), 'TOOL_DISCOVERY_FAILED');
    const context = await client.callTool({ name: 'get_context', arguments: {} });
    check(!context.isError && data(context).data.read_only === true, 'CONTEXT_READ_FAILED');
    const result = { tools: tools.tools.length, context: true, warehouse: 'not_granted', crm: 'not_granted' };
    if (tools.tools.some(tool => tool.name === 'search_warehouses')) {
      const warehouses = await client.callTool({ name: 'search_warehouses', arguments: { limit: 1, docks_min: 2 } });
      check(!warehouses.isError && Array.isArray(data(warehouses).data.items), 'WAREHOUSE_READ_FAILED');
      for (const item of data(warehouses).data.items) {
        check(!Object.keys(item).some(field => /phone|contact|email|media/i.test(field)), 'WAREHOUSE_PRIVATE_FIELD');
        check(typeof item.verification_required === 'boolean', 'WAREHOUSE_EVIDENCE_MISSING');
      }
      result.warehouse = 'read';
      if (tools.tools.some(tool => tool.name === 'warehouse_summary')) {
        const args = { city: 'Bangalore', period: 'today', sort: 'created_desc', limit: 2 };
        const dailyResult = await client.callTool({ name: 'search_warehouses', arguments: args });
        const daily = data(dailyResult).data;
        check(!dailyResult.isError && daily.query_context.timezone === 'Asia/Kolkata' && daily.query_context.date_field === 'created', 'WAREHOUSE_DAILY_QUERY_FAILED');
        for (const item of daily.items) check(['bangalore', 'bengaluru'].includes(item.city?.toLowerCase()) && item.created_at >= daily.query_context.start_at && item.created_at < daily.query_context.end_before, 'WAREHOUSE_DAILY_BOUNDARY_FAILED');
        const summaryResult = await client.callTool({ name: 'warehouse_summary', arguments: { city: 'Bengaluru', period: 'today', group_by: 'city' } });
        const summary = data(summaryResult).data;
        check(!summaryResult.isError && summary.total >= daily.items.length && summary.total === summary.groups.reduce((sum, group) => sum + group.count, 0) + summary.other_count, 'WAREHOUSE_DAILY_SUMMARY_FAILED');
        result.warehouse_added_today = { returned: daily.items.length, total: summary.total, date: daily.query_context.date_from, timezone: daily.query_context.timezone };
      }
    }
    if (tools.tools.some(tool => tool.name === 'search_crm_leads')) {
      const crm = await client.callTool({ name: 'search_crm_leads', arguments: { limit: 1 } });
      const value = data(crm);
      check(crm.isError ? typeof value.error?.code === 'string' : Boolean(value.data.access_scope && value.data.source_status), 'CRM_RESULT_INVALID');
      result.crm = crm.isError ? value.error.code : 'read';
      if (!crm.isError && tools.tools.some(tool => tool.name === 'crm_summary')) {
        const monthlyResult = await client.callTool({ name: 'search_crm_leads', arguments: { view: 'created', period: 'this_month', sort: 'created_desc', limit: 2 } });
        const monthly = data(monthlyResult).data;
        check(!monthlyResult.isError && monthly.access_scope === 'created' && monthly.query_context.date_field === 'created', 'CRM_MONTH_QUERY_FAILED');
        for (const item of monthly.items) check(item.source_created_at >= monthly.query_context.start_at && item.source_created_at < monthly.query_context.end_before, 'CRM_MONTH_BOUNDARY_FAILED');
        const summaryResult = await client.callTool({ name: 'crm_summary', arguments: { view: 'created', period: 'this_month', group_by: 'stage' } });
        const summary = data(summaryResult).data;
        check(!summaryResult.isError && summary.access_scope === 'created' && summary.total >= monthly.items.length && summary.total === summary.groups.reduce((sum, group) => sum + group.count, 0) + summary.other_count, 'CRM_MONTH_SUMMARY_FAILED');
        const filters = await client.callTool({ name: 'crm_filters', arguments: { view: 'assigned' } });
        check(!filters.isError && data(filters).data.date_fields.includes('created') && data(filters).data.access_scope === 'assigned', 'CRM_FILTER_DISCOVERY_FAILED');
        const followUp = await client.callTool({ name: 'search_crm_leads', arguments: { date_field: 'follow_up', period: 'tomorrow', sort: 'follow_up_asc', limit: 2 } });
        check(!followUp.isError && data(followUp).data.query_context.date_field === 'follow_up', 'CRM_FOLLOW_UP_QUERY_FAILED');
        result.crm_created_this_month = { returned: monthly.items.length, total: summary.total, access_scope: summary.access_scope };
        result.crm_follow_up = 'read';
      }
    }
    return result;
  });
  const renewed = await form(metadata.token_endpoint, { grant_type: 'refresh_token', client_id: clientId, resource: resource.resource, refresh_token: refreshToken });
  check(renewed.response.status === 200 && renewed.value.refresh_token !== refreshToken, 'REFRESH_ROTATION_FAILED');
  const oldRefresh = refreshToken;
  refreshToken = renewed.value.refresh_token;
  await sdk(renewed.value.access_token, async client => check(!(await client.callTool({ name: 'get_context', arguments: {} })).isError, 'RENEWED_ACCESS_FAILED'));
  const replay = await form(metadata.token_endpoint, { grant_type: 'refresh_token', client_id: clientId, resource: resource.resource, refresh_token: oldRefresh });
  check(replay.response.status === 400 && replay.value.error === 'invalid_grant', 'REFRESH_REPLAY_ACCEPTED');
  const revoked = await request('/mcp', { headers: { Authorization: `Bearer ${renewed.value.access_token}` } });
  check(revoked.status === 401, 'REPLAY_DID_NOT_REVOKE_GRANT');
  console.log(JSON.stringify({ passed: true, http_requests: requests, ...checks, pkce: true, refresh_rotation: true, refresh_replay_revokes: true }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ passed: false, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'MCP_VERIFICATION_UNAVAILABLE', http_requests: requests }));
  process.exitCode = 1;
} finally {
  if (refreshToken && clientId && metadata?.revocation_endpoint) {
    try { await form(metadata.revocation_endpoint, { token: refreshToken, client_id: clientId, token_type_hint: 'refresh_token' }); }
    catch { console.error(JSON.stringify({ cleanup: 'REVOKE_UNAVAILABLE' })); process.exitCode = 1; }
  }
}
