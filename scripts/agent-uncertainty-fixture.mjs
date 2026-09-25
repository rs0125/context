import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createContextReader, createResponseClient, LIMITS, runScenario } from './agent-harness.mjs';

const FIXTURE_ORIGIN = 'https://warehouse-fixture.invalid';
const FIXTURE_TRANSPORT_TOKEN = 'synthetic_transport_token_not_an_employee_key';
const records = [
  {
    id: 900000001, synthetic_fixture: true, city: 'Fixture City',
    dock_count: null, clear_height_ft: 30, availability: null, verification_required: true,
    field_evidence: {
      dock_count: { kind: 'range', lower: 2, upper: 6, source: '2-6 docks' },
      clear_height_ft: { kind: 'exact', value: 30, source: '30 ft' },
    },
  },
  {
    id: 900000002, synthetic_fixture: true, city: 'Fixture City',
    dock_count: null, clear_height_ft: 30, availability: null, verification_required: true,
    field_evidence: {
      dock_count: { kind: 'approximate', value: 4, source: 'about 4 docks' },
      clear_height_ft: { kind: 'exact', value: 30, source: '30 ft' },
    },
  },
];
const catalog = [
  { name: 'docks_min', type: 'integer', minimum: 0, description: 'Minimum candidate dock count; permissive ranges can overlap the requirement.' },
  { name: 'clear_height_min_ft', type: 'number', exclusiveMinimum: 0, description: 'Minimum recorded clear height in feet.' },
  { name: 'match_mode', type: 'string', enum: ['permissive', 'strict'], default: 'permissive' },
  { name: 'limit', type: 'integer', minimum: 1, maximum: 2, default: 2 },
];

export const FIXTURE_SCENARIO = {
  id: 'synthetic_warehouse_uncertainty', required: ['context', 'warehouses'],
  prompt: 'This is an uncertainty test using synthetic fixtures, not real warehouse inventory. Read /api/v1/context.md, then find up to two synthetic candidates requiring at least 4 docks and 25 ft clear height using permissive filters and limit=2. If both fixtures are returned, discuss both. Preserve a recorded range as a range with both endpoints and preserve an approximate count as approximate. Each item must say its specifications require verification; possible overlap does not prove the minimum is met. Clearly label the answer as a synthetic fixture test, do not claim availability or suitability, and do not describe these as real warehouses.',
};

/** This fetch implementation never performs network I/O or reads a database. */
export function createFixtureFetch() {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const json = (data, status = 200) => Response.json({ data, meta: { source: 'synthetic_fixture', real_inventory: false } }, { status });
    if (url.origin !== FIXTURE_ORIGIN || options.method !== 'GET') return json({ error: 'FIXTURE_READ_ONLY' }, 405);
    if (url.pathname === '/api/v1/context.md' || url.pathname === '/api/v1/wiki/pages/warehouse-fields') {
      return new Response('# Synthetic warehouse fixture context\n\nThese records are invented test fixtures, not Wareongo inventory. No employee credential, warehouse database, or context server is used. Read-only scopes: knowledge:read, warehouses:read.\n\nUse GET /api/v1/warehouses?docks_min=4&clear_height_min_ft=25&match_mode=permissive&limit=2. Optional filter discovery: /api/v1/warehouses/filters.\n\nRead field_evidence: exact is a recorded scalar, approximate is an estimate, range preserves both endpoints, and unknown does not establish a fact. Exact numeric properties are null for estimates and ranges. verification_required=true means each item needs verification before asserting it meets a requirement. Availability is unknown. State explicitly that this is a synthetic fixture exercise.\n', { headers: { 'Content-Type': 'text/markdown' } });
    }
    if (url.pathname === '/api/v1/warehouses/filters') return json({ synthetic_fixture: true, catalog, options: {}, truncated: false });
    if (url.pathname === '/api/v1/warehouses') {
      const allowed = new Set(['docks_min', 'clear_height_min_ft', 'match_mode', 'limit']);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)
        || url.searchParams.get('docks_min') !== '4' || url.searchParams.get('clear_height_min_ft') !== '25'
        || ![null, 'permissive'].includes(url.searchParams.get('match_mode')) || url.searchParams.get('limit') !== '2') {
        return json({ error: 'USE_DOCUMENTED_SYNTHETIC_FILTERS' }, 400);
      }
      return json({ synthetic_fixture: true, items: records, nextCursor: null,
        matching_policy: { mode: 'permissive', include_unknown: false, range_matching: 'overlap', guidance: 'These synthetic candidates need verification; range overlap and approximate counts do not guarantee the minimum.' } });
    }
    const id = /^\/api\/v1\/warehouses\/(90000000[12])$/.exec(url.pathname)?.[1];
    if (id) return json(records.find(record => String(record.id) === id));
    return json({ error: 'FIXTURE_ROUTE_UNAVAILABLE' }, 404);
  };
}

export function evaluateUncertaintyFixture(result) {
  const failures = [...result.failures];
  const check = (condition, code) => { if (!condition) failures.push(code); };
  const answer = result.answer;
  const first = answer?.items?.find(item => item.id === '900000001');
  const second = answer?.items?.find(item => item.id === '900000002');
  check(answer?.items?.length === 2 && !!first && !!second, 'BOTH_FIXTURES_REQUIRED');
  check(/\b(?:synthetic|fixture|simulated)\b/i.test(answer?.summary ?? ''), 'SYNTHETIC_DATA_NOT_IDENTIFIED');
  check(/\b2\b/.test(first?.summary ?? '') && /\b6\b/.test(first?.summary ?? '')
    && /\brange\b|\bbetween\b|\b2\s*(?:[-–—]|to)\s*6\b/i.test(first?.summary ?? ''), 'RANGE_ENDPOINTS_NOT_PRESERVED');
  check(/\b4\b/.test(second?.summary ?? '')
    && /\b(?:approx(?:imate(?:ly)?)?|about|around|estimated?)\b/i.test(second?.summary ?? ''), 'APPROXIMATE_COUNT_NOT_PRESERVED');
  check(Array.isArray(answer?.unknowns) && answer.unknowns.length > 0, 'MISSING_FIXTURE_UNCERTAINTY');
  check((answer?.items ?? []).every(item => !/\b(?:definitely|certainly|guaranteed)\s+(?:meets?|satisfies|has)\b/i.test(item.summary)), 'UNSUPPORTED_CERTAINTY');
  return { ...result, failures: [...new Set(failures)], verdict: failures.length ? 'fail' : result.verdict };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'dashboard-env': { type: 'string', default: '../Backend_Repository/.env' },
    model: { type: 'string', default: 'gpt-5.6-luna' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('node scripts/agent-uncertainty-fixture.mjs [--dashboard-env ../Backend_Repository/.env] [--model gpt-5.6-luna]');
    return;
  }
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(values.model)) throw new Error('INVALID_MODEL');
  const key = parseEnv(await readFile(values['dashboard-env'], 'utf8')).OPENAI_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw new Error('OPENAI_KEY_MISSING');
  const budget = { modelCalls: 0, contextCalls: 0 };
  const deadline = Date.now() + LIMITS.caseMs;
  const directory = path.resolve('.local/harness');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const reportFile = path.join(directory, `fixture-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`);
  const report = { startedAt: new Date().toISOString(), model: values.model, synthetic_only: true, store: false,
    limits: { modelCalls: 6, contextCalls: 6, caseMs: LIMITS.caseMs }, budget,
    note: 'Actual OpenAI model with local synthetic tool fixtures only. This does not test live inventory or establish universal model reliability.' };
  const callModel = createResponseClient({ apiKey: key, model: values.model, budget, deadline });
  const readContext = createContextReader({ base: new URL(FIXTURE_ORIGIN), apiKey: FIXTURE_TRANSPORT_TOKEN,
    openaiKey: key, budget, deadline, fetchImpl: createFixtureFetch() });
  const result = evaluateUncertaintyFixture(await runScenario(FIXTURE_SCENARIO, { callModel, readContext, runDeadline: deadline }));
  Object.assign(report, { finishedAt: new Date().toISOString(), verdict: result.verdict, cases: [result] });
  const serialized = JSON.stringify(report, null, 2).replaceAll(key, '[REDACTED_CREDENTIAL]').replaceAll(FIXTURE_TRANSPORT_TOKEN, '[REDACTED_SYNTHETIC_TOKEN]');
  await writeFile(reportFile, `${serialized}\n`, { mode: 0o600 });
  await chmod(reportFile, 0o600);
  console.log(JSON.stringify({ verdict: result.verdict, failures: result.failures, usage: result.usage,
    model_calls: budget.modelCalls, fixture_tool_calls: budget.contextCalls }));
  if (result.verdict !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ verdict: 'fail', error: 'FIXTURE_HARNESS_FAILURE' })); process.exitCode = 1; });
}
