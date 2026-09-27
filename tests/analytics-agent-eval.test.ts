/** Opt-in model evaluation. Actual MCP schemas, validation and projections;
 * fictional Google responses and employee only. No business data leaves here.
 * Run: CONTEXT_ANALYTICS_AGENT_EVAL=1 npx vitest run tests/analytics-agent-eval.test.ts
 * The dashboard credential is read in process, never passed to the model. */
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PoolClient } from 'pg';
import { handleMcpRequest } from '../src/lib/mcp';
import { handleApiRequest } from '../src/lib/api';
import { HttpError } from '../src/lib/errors';

const synthetic = vi.hoisted(() => ({ unavailable: false }));
vi.mock('../src/lib/analytics-google', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/analytics-google')>();
  return { ...actual, ga4PropertyId: () => '123', searchConsoleSite: () => 'sc-domain:wareongo.com',
    analyticsCredentials: () => ({ identity: 'fictional-evaluation', email: 'test@example.invalid', privateKey: '' }),
    googleAnalyticsRead: async (read: { kind: string }, body: any, project: (value: unknown) => unknown) => {
      if (synthetic.unavailable) throw new HttpError(503, 'ANALYTICS_SOURCE_DENIED', 'Google denied this analytics read. Check API enablement and service-account access.');
      let raw: unknown;
      if (read.kind === 'ga4_metadata') raw = { dimensions: [], metrics: [] };
      else if (read.kind === 'ga4_report') {
        const dimensions = (body.dimensions ?? []).map((value: { name: string }) => value.name);
        const range = body.dateRanges[0];
        const from = Date.parse(`${range.startDate}T00:00:00Z`), to = Date.parse(`${range.endDate}T00:00:00Z`);
        const total = dimensions.includes('date') ? Math.round((to - from) / 86_400_000) + 1 : 1;
        const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 10);
        const older = to < Date.now() - 29 * 86_400_000;
        const traffic: Record<string, number> = older
          ? { activeUsers: 64, totalUsers: 72, sessions: 100, engagedSessions: 60, screenPageViews: 200,
            eventCount: 400, keyEvents: 8, engagementRate: 0.60, userEngagementDuration: 3200, averageSessionDuration: 80 }
          : { activeUsers: 80, totalUsers: 90, sessions: 120, engagedSessions: 90, screenPageViews: 300,
            eventCount: 600, keyEvents: 12, engagementRate: 0.75, userEngagementDuration: 4800, averageSessionDuration: 90 };
        const rows = Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, i) => ({
          dimensionValues: dimensions.map((name: string) => ({ value: name === 'date'
            ? new Date(from + (offset + i) * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')
            : name === 'eventName' ? 'generate_lead' : name === 'pagePath' ? '/warehouses/bengaluru'
            : name === 'sessionDefaultChannelGroup' ? 'Organic Search' : name === 'sessionSourceMedium' ? 'google / organic' : 'mobile' })),
          metricValues: body.metrics.map((metric: { name: string }) => ({ value: dimensions.includes('eventName')
            ? metric.name === 'eventCount' ? '7' : '5' : String(traffic[metric.name] ?? 0) })),
        }));
        raw = { dimensionHeaders: dimensions.map((name: string) => ({ name })), metricHeaders: body.metrics,
          rows, rowCount: total, metadata: { timeZone: 'Asia/Kolkata' } };
      } else raw = { rows: [{ keys: body.dimensions.map((dimension: string) => dimension === 'query' ? 'warehouse for rent'
        : dimension === 'page' ? 'https://wareongo.com/warehouses/bengaluru' : dimension === 'device' ? 'mobile' : 'ind'),
        clicks: 13, impressions: 260, ctr: 0.05, position: 8 }], responseAggregationType: 'byProperty' };
      return { data: project(raw), source_fetched_at: new Date().toISOString(), cache_hit: false };
    } };
});

type Trace = { name: string; args: Record<string, unknown>; result: any };
type Scenario = { id: string; prompt: string; check: (trace: Trace[], answer: string) => boolean; unavailable?: boolean };
const scenarios: Scenario[] = [
  { id: 'aggregate_comparison', prompt: 'How did total website sessions change in the last 28 complete days versus the immediately preceding 28 days? Give both totals and the percent change.',
    check: (trace, answer) => trace.some(t => t.name === 'ga4_report' && t.args.compare_to === 'previous_period' && (!t.args.report || t.args.report === 'overview'))
      && /120/.test(answer) && /100/.test(answer) && /20\s*%/.test(answer) },
  { id: 'engagement_timing', prompt: 'For the last 28 complete days, what were average engagement time per active user, average engagement time per session, average session duration, and engagement rate? Explain how the two time concepts differ and compare engagement rate with the immediately preceding 28 days.',
    check: (trace, answer) => trace.some(t => t.name === 'ga4_report' && t.args.compare_to === 'previous_period'
      && (!t.args.report || t.args.report === 'overview'))
      && /\b60\b|\b1\s*min/i.test(answer) && /\b40\b/.test(answer) && /\b90\b|\b1\s*min(?:ute)?\s*30/i.test(answer)
      && /75\s*%/.test(answer) && /15\s*(?:percentage[ -]points?|pp)\b/i.test(answer)
      && /foreground|focus(?:ed)?|active(?:ly)?\s+(?:engag|interact)/i.test(answer) && /seconds?|\bsec\b/i.test(answer) },
  { id: 'exact_page_queries', prompt: 'Which search queries lead to exactly https://wareongo.com/warehouses/bengaluru in Google Search over the last 28 complete days? Show query and page together.',
    check: trace => trace.some(t => t.name === 'search_console_report' && t.args.page_equals === 'https://wareongo.com/warehouses/bengaluru' && t.args.group === 'query_page') },
  { id: 'nonbrand_mobile', prompt: 'Show Google search queries from mobile devices in India during the last 28 complete days, excluding queries containing wareongo.',
    check: trace => trace.some(t => t.name === 'search_console_report' && t.args.query_not_contains === 'wareongo' && t.args.device === 'mobile'
      && String(t.args.country).toLowerCase() === 'ind' && t.args.group === 'query') },
  { id: 'whole_daily_trend', prompt: 'Show the whole daily website traffic trend for the last 28 complete days, with a row for every date the source returns. Fetch all needed pages.',
    check: trace => new Set(trace.filter(t => t.name === 'ga4_report' && t.args.report === 'daily')
      .flatMap(t => t.result?.data?.items ?? []).map(row => row.dimensions.date)).size === 28 },
  { id: 'recorded_lead_events', prompt: 'How many sales leads did the website generate this month? Tell me exactly what the source can establish.',
    check: (trace, answer) => trace.some(t => t.name === 'ga4_report' && t.args.report === 'events' && t.args.event_name === 'generate_lead'
      && t.args.period === 'this_month') && /\b7\b/.test(answer) && /event/i.test(answer) && /(?:not|doesn.t|cannot|can.t|isn.t)[\s\S]{0,100}(?:unique|CRM|sales lead)/i.test(answer) },
  { id: 'search_today', prompt: 'Show today’s Google Search performance totals and explain any freshness limitations.',
    check: (trace, answer) => trace.some(t => t.name === 'search_console_report' && t.args.period === 'today' && t.args.data_state === 'all')
      && /provisional|incomplete|unfinished|can change|may change/i.test(answer) },
  { id: 'source_denied', prompt: 'How many visitors did the website have in the last 28 complete days?', unavailable: true,
    check: (trace, answer) => trace.some(t => t.result?.error?.code === 'ANALYTICS_SOURCE_DENIED') && /unavailable|denied|cannot|can.t|couldn.t|unable/i.test(answer)
      && !/(?:had|were|was|recorded)\s+(?:0|zero)\s+(?:users|visitors)/i.test(answer) },
];
afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.env.CONTEXT_ANALYTICS_AGENT_EVAL !== '1')('evaluates real analytics MCP contracts with a bounded synthetic agent', async () => {
  const env = parseEnv(await readFile('../Backend_Repository/.env', 'utf8'));
  const credential = env.OPENAI_API_KEY;
  if (!credential) throw new Error('EVAL_CREDENTIAL_UNAVAILABLE');
  const model = process.env.CONTEXT_ANALYTICS_EVAL_MODEL ?? 'gpt-5.6-luna';
  const origin = 'https://context.example.test';
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
  const key = { id: randomUUID(), hash: 'a'.repeat(64), employeeEmail: 'fictional@example.test', scopes: ['analytics:read'] as const,
    expiresAt: '2099-01-01T00:00:00Z' };
  const roster = { id: 1, email: key.employeeEmail, is_active: true, adminAccess: true, dashboardAccess: false, twenty_user_id: null };
  const transaction = async <T,>(work: (client: PoolClient) => Promise<T>) => work({ query: async () => ({ rows: [roster] }) } as unknown as PoolClient);
  const client = new Client({ name: 'synthetic-analytics-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    fetch: async (url, init) => handleMcpRequest(new Request(url, init), { authenticate: async () => ({ ...key, scopes: [...key.scopes] }),
      read: (request, path) => handleApiRequest(request, path, { authenticate: () => ({ ...key, scopes: [...key.scopes] }),
        transaction, revalidateKey: async () => {}, audit: () => {} }) }),
  });
  let calls = 0;
  const deadline = Date.now() + 480_000;
  const results: Record<string, unknown>[] = [];
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const modelTools = tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
      parameters: tool.inputSchema, strict: false }));
    for (const scenario of scenarios) {
      synthetic.unavailable = scenario.unavailable ?? false;
      const input: any[] = [{ role: 'user', content: scenario.prompt }];
      const trace: Trace[] = [];
      let answer = '';
      let error: string | null = null;
      try {
        for (let round = 0; round < 6; round++) {
          if (++calls > 32 || Date.now() >= deadline) throw new Error('EVAL_BUDGET');
          const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error',
            headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
            body: JSON.stringify({ model, store: false, tools: modelTools, input, parallel_tool_calls: false, max_output_tokens: 2000,
              reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'], tool_choice: trace.length >= 5 ? 'none' : 'auto',
              instructions: `${client.getInstructions()}\nThis is an evaluation with fictional source data. Answer the user's question with citations. You have at most five tool calls. Current UTC time: ${new Date().toISOString()}.` }) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`EVAL_HTTP_${response.status}`); }
          const body = await response.json();
          if (body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('EVAL_RESPONSE_INCOMPLETE');
          input.push(...body.output);
          const requested = body.output.filter((part: any) => part.type === 'function_call');
          if (!requested.length) {
            answer = body.output.filter((part: any) => part.type === 'message').flatMap((part: any) => part.content ?? [])
              .filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('\n');
            break;
          }
          for (const call of requested) {
            if (trace.length >= 5) throw new Error('EVAL_TOOL_BUDGET');
            const args = JSON.parse(call.arguments);
            const result = await client.callTool({ name: call.name, arguments: args });
            const data = result.structuredContent ?? { error: result.content };
            trace.push({ name: call.name, args, result: data });
            input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(data) });
          }
        }
      } catch (cause) { error = cause instanceof Error && /^EVAL_[A-Z0-9_]+$/.test(cause.message) ? cause.message : 'EVAL_FAILED'; }
      const passed = !error && !!answer && scenario.check(trace, answer);
      results.push({ id: scenario.id, passed, error, trace, answer });
      console.log(JSON.stringify({ scenario: scenario.id, passed, error, tools: trace.map(t => t.name) }));
    }
    const report = JSON.stringify({ evidence: 'synthetic-model-evaluation', limitation: 'Deterministic assertions plus human review; not a production Claude or Google data test.',
      model, model_calls: calls, catalog_sha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'), results }, null, 2);
    if (report.includes(credential)) throw new Error('EVAL_SECRET_IN_REPORT');
    await mkdir('.local/analytics-research', { recursive: true, mode: 0o700 });
    await writeFile('.local/analytics-research/agent-eval-report.json', report, { mode: 0o600 });
    await chmod('.local/analytics-research/agent-eval-report.json', 0o600);
    expect(results.filter(result => !result.passed).map(result => result.id)).toEqual([]);
  } finally { await client.close(); }
}, 540_000);
