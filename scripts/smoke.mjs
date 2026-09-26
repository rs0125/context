import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

async function main() {
  const { values } = parseArgs({ options: {
    base: { type: 'string', default: 'http://127.0.0.1:3000' },
    'key-file': { type: 'string', default: '.local/keys/local-trial.json' },
  } });
  const base = new URL(values.base);
  if (base.username || base.password || base.search || base.hash) throw new Error('Provide a plain origin without credentials or query parameters.');
  // This script transmits the configured employee key. Explicitly name a remote
  // https deployment if needed; local HTTP is supported for development only.
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Remote deployments require HTTPS.');
  const { apiKey } = JSON.parse(await readFile(values['key-file'], 'utf8'));
  if (typeof apiKey !== 'string' || !/^wog_ctx_[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new Error('Invalid key file.');
  const summary = [];
  async function read(route, authenticated = true) {
    const response = await fetch(new URL(route, base), {
      headers: authenticated ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    assert(!body.includes(apiKey), 'A response exposed an API key.');
    summary.push({ route, status: response.status });
    return { response, body };
  }
  assert.equal((await read('/api/health', false)).response.status, 200);
  assert.equal((await read('/api/v1/openapi.json', false)).response.status, 200);
  assert.equal((await read('/api/v1/context', false)).response.status, 401);
  const context = await read('/api/v1/context');
  assert.equal(context.response.status, 200, `Authenticated context failed (${context.response.status}).`);
  const info = JSON.parse(context.body).data;
  assert.equal(info.read_only, true);
  assert.equal((await read('/api/v1/context.md')).response.status, 200);
  assert.equal((await read('/api/v1/wiki/search?q=warehouse&limit=1')).response.status, 200);
  const discovery = await read('/api/v1/warehouses/filters?city=Bengaluru');
  assert.equal(discovery.response.status, 200, 'Warehouse filter discovery failed.');
  assert(JSON.parse(discovery.body).data.catalog.some(filter => filter.name === 'docks_min'));
  const candidates = await read('/api/v1/warehouses?city=Bengaluru&docks_min=4&clear_height_min_ft=25&include_unknown=true&limit=2');
  assert.equal(candidates.response.status, 200, 'Combined warehouse filters failed.');
  assert.equal(JSON.parse(candidates.body).data.matching_policy.mode, 'permissive');
  const warehouse = await read('/api/v1/warehouses?limit=1');
  assert.equal(warehouse.response.status, 200, 'Warehouse access failed.');
  const records = JSON.parse(warehouse.body).data.items;
  if (records.length) assert.equal((await read(`/api/v1/warehouses/${records[0].id}`)).response.status, 200);
  const blockedFields = ['contactNumber', 'alt_phone_number', 'contactPerson', 'negotiated_rent', 'photos', 'media', 'scoutNotes'];
  for (const field of blockedFields) assert(!warehouse.body.includes(`"${field}"`), `Forbidden field ${field}.`);
  const crm = await read('/api/v1/crm/opportunities?limit=1');
  if (crm.response.status === 503 && JSON.parse(crm.body).error?.code === 'CRM_SOURCE_STALE') {
    summary.push({ crm: 'Blocked safely: CRM mirror sync is stale or failed.' });
  } else {
    assert.equal(crm.response.status, 200, 'CRM access failed.');
    assert(['all', 'created_or_assigned'].includes(JSON.parse(crm.body).data.access_scope));
    for (const view of ['created', 'assigned']) {
      const narrowed = await read(`/api/v1/crm/opportunities?view=${view}&limit=1`);
      assert.equal(narrowed.response.status, 200, `${view} CRM access failed.`);
      assert.equal(JSON.parse(narrowed.body).data.access_scope, view);
    }
    const deals = JSON.parse(crm.body).data.items;
    if (deals.length) assert.equal((await read(`/api/v1/crm/opportunities/${deals[0].id}`)).response.status, 200);
    assert.equal((await read('/api/v1/crm/my-briefing')).response.status, 200);
  }
  assert.equal((await read('/api/v1/warehouses?phone=1234567890')).response.status, 400);
  console.log(JSON.stringify({ result: 'passed', checks: summary }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
