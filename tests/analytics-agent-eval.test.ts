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
vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
import { handleApiRequest } from '../src/lib/api';
import { HttpError } from '../src/lib/errors';
import { ga4Report } from '../src/lib/analytics';
import { analyticsLocalDate } from '../src/lib/analytics-query';

function fixtureIsPreviousPeriod(end: string) {
  const localDay = Date.parse(`${analyticsLocalDate('Asia/Kolkata')}T00:00:00Z`);
  return Date.parse(`${end}T00:00:00Z`) < localDay - 28 * 86_400_000;
}

const synthetic = vi.hoisted(() => ({ unavailable: false, scenario: '' }));
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
        const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 10);
        const older = fixtureIsPreviousPeriod(range.endDate);
        const traffic: Record<string, number> = older
          ? { activeUsers: 64, totalUsers: 72, sessions: 100, engagedSessions: 60, screenPageViews: 200,
            eventCount: 400, keyEvents: 8, engagementRate: 0.60, userEngagementDuration: 3200, averageSessionDuration: 80 }
          : { activeUsers: 80, totalUsers: 90, sessions: 120, engagedSessions: 90, screenPageViews: 300,
            eventCount: 600, keyEvents: 12, engagementRate: 0.75, userEngagementDuration: 4800, averageSessionDuration: 90 };
        type FixtureRow = { dimensions: Record<string, string>; metrics: Record<string, number> };
        const eventNames = (expression: any): string[] | null => {
          if (expression?.filter?.fieldName === 'eventName') return expression.filter.inListFilter?.values
            ?? (expression.filter.stringFilter?.matchType === 'EXACT' ? [expression.filter.stringFilter.value] : null);
          for (const child of expression?.andGroup?.expressions ?? expression?.orGroup?.expressions ?? []) {
            const names = eventNames(child);
            if (names) return names;
          }
          return null;
        };
        const matches = (expression: any, values: Record<string, string>): boolean => {
          if (!expression) return true;
          if (expression.andGroup) return expression.andGroup.expressions.every((child: any) => matches(child, values));
          if (expression.orGroup) return expression.orGroup.expressions.some((child: any) => matches(child, values));
          if (expression.notExpression) return !matches(expression.notExpression, values);
          const filter = expression.filter;
          if (!filter) return true;
          const value = values[filter.fieldName] ?? '';
          if (filter.inListFilter) return filter.inListFilter.values.includes(value);
          if (filter.stringFilter?.matchType === 'EXACT') return value === filter.stringFilter.value;
          if (filter.stringFilter?.matchType === 'CONTAINS') return value.includes(filter.stringFilter.value);
          return true;
        };
        const selectedEvents = eventNames(body.dimensionFilter);
        const paths = synthetic.scenario === 'form_event_session_denominators'
          ? ['/request-warehouse', '/listings/bengaluru'] : ['/warehouses/bengaluru'];
        let fixtures: FixtureRow[] = paths.flatMap<FixtureRow>((path, index): FixtureRow[] => {
          const values = { pagePath: path, landingPage: path, sessionDefaultChannelGroup: 'Organic Search',
            sessionSourceMedium: 'google / organic', sessionSource: 'google', deviceCategory: 'mobile', country: 'India' };
          if (selectedEvents || dimensions.includes('eventName')) return (selectedEvents ?? ['generate_lead']).map(eventName => {
            const eventCount = eventName === 'first_visit' ? 37
              : eventName === 'form_submit' && paths.length === 2 ? [11, 21][index] : 7;
            const totalUsers = eventName === 'first_visit' ? 35
              : eventName === 'form_submit' && paths.length === 2 ? [9, 17][index] : 5;
            return { dimensions: { ...values, eventName }, metrics: { eventCount, totalUsers } };
          });
          const metrics: Record<string, number> = paths.length === 2 ? (index === 0
            ? { activeUsers: 90, totalUsers: 95, sessions: 101, engagedSessions: 70, screenPageViews: 202,
              eventCount: 300, keyEvents: 7, engagementRate: 70 / 101, userEngagementDuration: 4040, averageSessionDuration: 90 }
            : { activeUsers: 350, totalUsers: 400, sessions: 445, engagedSessions: 267, screenPageViews: 800,
              eventCount: 1800, keyEvents: 13, engagementRate: 0.6, userEngagementDuration: 17800, averageSessionDuration: 100 })
            : { ...traffic, ...(synthetic.scenario === 'recent_key_event_configuration' ? { keyEvents: 0 } : {}) };
          return [{ dimensions: values, metrics }];
        });
        // Some submit events occur on another page within the same entry session.
        // Fixture users are disjoint; summing these synthetic cells does not model
        // a generally valid way to aggregate Google's distinct-user metrics.
        if (paths.length === 2) fixtures = fixtures.flatMap(row => row.dimensions.eventName !== 'form_submit' ? [row]
          : (row.dimensions.landingPage === paths[0] ? [[0, 7, 6], [1, 4, 3]] : [[0, 4, 3], [1, 17, 14]])
            .map(([page, eventCount, totalUsers]) => ({ dimensions: { ...row.dimensions, pagePath: paths[page] }, metrics: { eventCount, totalUsers } })));
        fixtures = fixtures.filter(row => matches(body.dimensionFilter, row.dimensions));
        if (dimensions.includes('date')) fixtures = Array.from({ length: Math.round((to - from) / 86_400_000) + 1 }, (_, i) => ({
          dimensions: { ...fixtures[0]?.dimensions, date: new Date(from + i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '') },
          metrics: { ...traffic },
        }));
        const groups = new Map<string, FixtureRow[]>();
        for (const row of fixtures) {
          const key = JSON.stringify(dimensions.map((name: string) => row.dimensions[name]));
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        fixtures = [...groups.values()].map(group => {
          if (group.length === 1) return group[0];
          const metrics: Record<string, number> = {};
          for (const row of group) for (const [name, value] of Object.entries(row.metrics)) metrics[name] = (metrics[name] ?? 0) + value;
          if (metrics.sessions) {
            metrics.engagementRate = metrics.engagedSessions / metrics.sessions;
            metrics.averageSessionDuration = group.reduce((sum, row) => sum + row.metrics.averageSessionDuration * row.metrics.sessions, 0) / metrics.sessions;
          }
          return { dimensions: group[0].dimensions, metrics };
        });
        const total = fixtures.length;
        const rows = fixtures.slice(offset, offset + limit).map(row => ({
          dimensionValues: dimensions.map((name: string) => ({ value: row.dimensions[name] ?? '(not set)' })),
          metricValues: body.metrics.map((metric: { name: string }) => ({ value: String(row.metrics[metric.name] ?? 0) })),
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
const hasLimitation = (answer: string, topic: RegExp) => answer.split(/(?<=[.!?])\s+|\n/).some(sentence => topic.test(sentence)
  && /\b(?:not|no|cannot|can't|can’t|doesn't|doesn’t|don't|don’t|isn't|isn’t|aren't|aren’t|unable|unsupported|unavailable|unknown|unproven|insufficient|unverified)\b|does not|do not|doesn.t prove|can.t establish/i.test(sentence));
const gaRows = (trace: Trace[]) => trace.filter(t => t.name === 'ga4_report').flatMap(t => t.result?.data?.items ?? []);
function formComparisonEvidence(trace: Trace[]) {
  const reports = trace.filter(t => {
    if (t.name !== 'ga4_report' || !t.result?.data?.items) return false;
    const dates = t.result.data.query_context;
    const today = Date.parse(`${dates.local_date}T00:00:00Z`);
    return Number.isFinite(today) && dates.date_from === new Date(today - 28 * 86_400_000).toISOString().slice(0, 10)
      && dates.date_to === new Date(today - 86_400_000).toISOString().slice(0, 10);
  });
  const groups = [['/request-warehouse', 11, 101], ['/listings/bengaluru', 21, 445]] as const;
  const sameContext = (a: Trace, b: Trace) => ['date_from', 'date_to', 'timezone', 'device', 'country', 'channel', 'source']
    .every(key => a.result.data.query_context[key] === b.result.data.query_context[key]);
  const sessionReports = (path: string, sessions: number) => reports.filter(t => !t.args.page_path_contains
    && t.result.data.items.some((row: any) => row.metrics.sessions === sessions
      && (row.dimensions.landingPage === path || t.args.landing_page_contains === path)));
  const alignedSeparateReads = groups.every(([path, events, sessions]) => reports.some(t => t.args.landing_page_contains === path
    && !t.args.page_path_contains && t.result.data.pagination.offset === 0 && !t.result.data.pagination.has_more
    && t.result.data.items.filter((row: any) => row.dimensions.eventName === 'form_submit')
      .reduce((sum: number, row: any) => sum + row.metrics.eventCount, 0) === events
    && sessionReports(path, sessions).some(s => sameContext(t, s))));
  const validComposite = (t: Trace, path: string, events: number, sessions: number) => {
    const data = t.result.data;
    const performance = data.form_performance;
    const rows = data.items;
    if (t.args.report !== 'form_performance' || t.args.landing_page_contains !== path || t.args.page_path_contains
      || !performance?.matching_cohort || performance.denominator !== 'matching_entry_sessions'
      || performance.read_consistency !== 'independent_source_reads'
      || data.query_context.landing_page_contains !== path || data.query_context.page_path_contains !== null
      || data.pagination.offset !== 0 || data.pagination.has_more || rows.length !== 1
      || rows[0].metrics.sessions !== sessions || rows[0].metrics.formSubmitEventCount !== events
      || Math.abs(rows[0].metrics.formSubmitEventsPer100EntrySessions - events / sessions * 100) > 1e-9
      || !Number.isFinite(rows[0].metrics.formSubmitEventsPer100EntrySessions)) return false;
    const components = performance.components;
    if (!Array.isArray(components) || components.length !== 3) return false;
    const contextKeys = ['date_from', 'date_to', 'timezone', 'landing_page_contains', 'page_path_contains', 'device', 'country', 'channel', 'source'];
    if (!components.every((component: any) => contextKeys.every(key => component.query_context?.[key] === data.query_context[key]))) return false;
    const denominator = components.find((component: any) => component.name === 'sessions');
    const numerator = components.find((component: any) => component.name === 'form_submit');
    const ratio = performance.ratios?.find((value: any) => value.event_name === 'form_submit');
    return denominator?.metric === 'sessions' && denominator.value === sessions && denominator.query_context.event_names.length === 0
      && numerator?.metric === 'eventCount' && numerator.value === events && JSON.stringify(numerator.query_context.event_names) === '["form_submit"]'
      && ratio?.status === 'available' && ratio.metric === 'formSubmitEventsPer100EntrySessions'
      && Number.isFinite(ratio.value) && Math.abs(ratio.value - events / sessions * 100) < 1e-9;
  };
  const composites = groups.map(([path, events, sessions]) => reports.filter(t => validComposite(t, path, events, sessions)));
  const alignedComposite = composites[0].some(first => composites[1].some(second => sameContext(first, second)));
  const unaligned = groups.every(([path, events, sessions]) => sessionReports(path, sessions).length > 0
    && reports.some(t => t.result.data.items.some((row: any) => row.dimensions.eventName === 'form_submit'
      && (row.dimensions.pagePath === path || t.args.page_path_contains === path) && row.metrics.eventCount === events)));
  return { aligned: alignedSeparateReads || alignedComposite, unaligned };
}
function hasRecordedLeadEvents(trace: Trace[], period?: string) {
  return trace.some(t => t.name === 'ga4_report' && (!period || t.args.period === period) && (
    ['events', 'form_submissions'].includes(String(t.args.report)) && (!t.args.event_name || t.args.event_name === 'generate_lead')
      && t.result?.data?.items?.some((row: any) => row.dimensions.eventName === 'generate_lead' && row.metrics.eventCount === 7)
    || t.args.report === 'form_performance' && t.result?.data?.items?.some((row: any) => row.metrics.generateLeadEventCount === 7)
      && t.result?.data?.form_performance?.components?.some((component: any) => component.name === 'generate_lead'
        && component.metric === 'eventCount' && component.value === 7 && JSON.stringify(component.query_context?.event_names) === '["generate_lead"]')));
}
function reportsCalculatedFormRatio(answer: string) {
  const plain = answer.replace(/[*_~]/g, '');
  if (/\b11\s*[÷/]\s*101\b|\b21\s*[÷/]\s*445\b/.test(plain)) return true;
  const ratios = [11 / 101, 21 / 445, (11 / 101) / (21 / 445)];
  return [...plain.matchAll(/\b(\d+(?:\.\d+)?)\s*(%|percent|×|x\b|times\b)?/gi)].some(match => {
    const value = Number(match[1]) / (/^(?:%|percent)$/i.test(match[2] ?? '') ? 100 : 1);
    // Numeric claims near the computed ratios require aligned source groups,
    // even if the answer appends a caveat. This is not a semantic model grader.
    return ratios.some(ratio => Math.abs(value - ratio) / ratio < 0.025);
  });
}
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
    check: (trace, answer) => hasRecordedLeadEvents(trace, 'this_month') && /\b7\b/.test(answer) && /event/i.test(answer) && /(?:not|doesn.t|cannot|can.t|isn.t)[\s\S]{0,100}(?:unique|CRM|sales lead)/i.test(answer) },
  { id: 'search_today', prompt: 'Show today’s Google Search performance totals and explain any freshness limitations.',
    check: (trace, answer) => trace.some(t => t.name === 'search_console_report' && t.args.period === 'today' && t.args.data_state === 'all')
      && /provisional|incomplete|unfinished|can change|may change/i.test(answer) },
  { id: 'first_visit_journey_pipeline', prompt: 'For the last 28 complete days, show recorded first_visit counts by session entry page. Can these counts tell us which pages each first-time visitor later visited, how many became lifetime leads, and the CRM sales pipeline they created? Use the connected reports and distinguish what they establish.',
    check: (trace, answer) => trace.some(t => t.name === 'ga4_report' && t.args.report === 'first_visits')
      && gaRows(trace).some(row => row.dimensions.landingPage === '/warehouses/bengaluru' && row.metrics.eventCount === 37)
      && /\b37\b/.test(answer) && /first.visit|first visit/i.test(answer)
      && hasLimitation(answer, /journey|sequence|later|subsequent|individual|each.*(?:visitor|user)|person/i)
      && hasLimitation(answer, /CRM|pipeline|lifetime|lead/i) },
  { id: 'form_event_session_denominators', prompt: 'For the last 28 complete days, compare /request-warehouse and /listings/bengaluru using recorded form_submit counts and sessions by entry page. Is the first page converting about twice as many visitors, and how many unique CRM leads resulted? Retrieve the counts and explain what comparison is justified.',
    check: (trace, answer) => {
      const evidence = formComparisonEvidence(trace);
      return (evidence.aligned || (evidence.unaligned && !reportsCalculatedFormRatio(answer)
        && hasLimitation(answer, /ratio|rate|divid|compar/i)
        && /entry|landing|population|scope|mismatch|align/i.test(answer)))
      && [11, 21, 101, 445].every(count => new RegExp(`\\b${count}\\b`).test(answer))
      && /event|submission/i.test(answer) && /session/i.test(answer)
      && hasLimitation(answer, /(?:visitor|user|person|people).*conversion|conversion.*(?:visitor|user|person|people)|convert/i)
      && hasLimitation(answer, /CRM|unique.*lead/i);
    } },
  { id: 'recent_key_event_configuration', prompt: 'Key events were configured only recently. Check the last 28 complete days: does a zero key-event total mean we received zero enquiries? Also check the recorded successful form events. Explain whether these reports establish why pages are underperforming or whether proposed causes need further evidence.',
    check: (trace, answer) => trace.some(t => t.name === 'ga4_report' && (!t.args.report || t.args.report === 'overview')
      && t.result?.data?.items?.some((row: any) => row.metrics.keyEvents === 0))
      && hasRecordedLeadEvents(trace)
      && /\b7\b/.test(answer) && /configur|recent/i.test(answer)
      && hasLimitation(answer, /zero.*(?:enquir|inquir|lead)|(?:enquir|inquir|lead).*zero|key.?events?/i)
      && hasLimitation(answer, /caus|why|prove|explain|diagnos/i)
      && /hypothes|further|additional|investigat|test|could|may/i.test(answer) },
  { id: 'source_denied', prompt: 'How many visitors did the website have in the last 28 complete days?', unavailable: true,
    check: (trace, answer) => trace.some(t => t.result?.error?.code === 'ANALYTICS_SOURCE_DENIED') && /unavailable|denied|cannot|can.t|couldn.t|unable/i.test(answer)
      && !/(?:had|were|was|recorded)\s+(?:0|zero)\s+(?:users|visitors)/i.test(answer) },
];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); synthetic.unavailable = false; synthetic.scenario = ''; });

it.each(['2026-09-27T18:31:00Z', '2026-09-27T23:59:00Z', '2026-09-28T12:00:00Z'])('keeps synthetic comparison periods on the property calendar at %s', async now => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  const report = await ga4Report(new URLSearchParams('report=overview&period=last_28_days&compare_to=previous_period'));
  expect(report.query_context).toMatchObject({ date_from: '2026-08-31', date_to: '2026-09-27' });
  expect(report.items[0].metrics).toMatchObject({ sessions: 120, engagementRate: 0.75 });
  expect(report.comparison?.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'sessions', current: 120, previous: 100 }),
    expect.objectContaining({ name: 'engagementRate', current: 0.75, previous: 0.6 }),
  ]));
});

it('grades aligned form groups or an explicit ratio refusal, and rejects the observed mixed-scope ratio', async () => {
  synthetic.scenario = 'form_event_session_denominators';
  const call = async (args: Record<string, string>): Promise<Trace> => ({ name: 'ga4_report', args,
    result: { data: await ga4Report(new URLSearchParams({ period: 'last_28_days', ...args })) } });
  const landing = await call({ report: 'landing_pages' });
  const unaligned = [landing, await call({ report: 'form_submissions' })];
  const check = scenarios.find(scenario => scenario.id === 'form_event_session_denominators')!.check;
  const counts = 'Recorded form_submit events: 11 and 21; entry sessions: 101 and 445. ';
  const caution = 'This is not a visitor conversion rate, and unique CRM leads are unavailable.';
  expect(check(unaligned, counts + 'The events per session ratio is 10.9% versus 4.7%, about 2.3×. ' + caution)).toBe(false);
  expect(check(unaligned, counts + 'I cannot calculate a ratio because event pages and entry sessions have different populations. ' + caution)).toBe(true);
  for (const report of ['events', 'form_submissions']) {
    const aligned = [landing, ...await Promise.all(['/request-warehouse', '/listings/bengaluru'].map(path =>
      call({ report, event_name: 'form_submit', landing_page_contains: path })))];
    expect(formComparisonEvidence(aligned).aligned).toBe(true);
    expect(check(aligned, counts + 'For matching entry groups, the event-per-session ratios are 10.9% and 4.7%. ' + caution)).toBe(true);
  }
});

it('accepts valid server-calculated form cohorts and rejects withheld, altered or mismatched composite evidence', async () => {
  synthetic.scenario = 'form_event_session_denominators';
  const trace: Trace[] = await Promise.all(['/request-warehouse', '/listings/bengaluru'].map(async path => {
    const args = { report: 'form_performance', period: 'last_28_days', landing_page_contains: path };
    return { name: 'ga4_report', args, result: { data: await ga4Report(new URLSearchParams(args)) } };
  }));
  const check = scenarios.find(scenario => scenario.id === 'form_event_session_denominators')!.check;
  const answer = 'Recorded form_submit events are 11 and 21, from 101 and 445 entry sessions. The backend reports 10.89 and 4.72 events per 100 matching entry sessions. These are not visitor conversion rates. Unique CRM leads are unavailable.';
  expect(formComparisonEvidence(trace).aligned).toBe(true);
  expect(check(trace, answer)).toBe(true);
  for (const change of ['status', 'component_date', 'comparison_date', 'both_comparison_dates', 'count', 'ratio', 'event_filter', 'page_filter']) {
    const altered = structuredClone(trace);
    const data = altered[0].result.data;
    if (change === 'status') data.form_performance.ratios[0].status = 'source_quality_limited';
    if (change === 'component_date') data.form_performance.components[0].query_context.date_to = '2025-01-01';
    if (change === 'comparison_date') {
      data.query_context.date_to = '2025-01-01';
      for (const component of data.form_performance.components) component.query_context.date_to = '2025-01-01';
    }
    if (change === 'both_comparison_dates') for (const item of altered) {
      item.result.data.query_context.date_from = '2025-01-01';
      item.result.data.query_context.date_to = '2025-01-28';
      for (const component of item.result.data.form_performance.components) {
        component.query_context.date_from = '2025-01-01';
        component.query_context.date_to = '2025-01-28';
      }
    }
    if (change === 'count') data.items[0].metrics.formSubmitEventCount = 100;
    if (change === 'ratio') data.form_performance.ratios[0].value = 100;
    if (change === 'event_filter') data.form_performance.components[0].query_context.event_names = ['form_submit'];
    if (change === 'page_filter') data.form_performance.components[1].query_context.page_path_contains = '/request-warehouse';
    expect(formComparisonEvidence(altered).aligned, change).toBe(false);
    expect(check(altered, answer), change).toBe(false);
  }
});

it('accepts recorded generate_lead counts from the composite without treating them as unique leads or key events', async () => {
  synthetic.scenario = 'recent_key_event_configuration';
  const call = async (args: Record<string, string>): Promise<Trace> => ({ name: 'ga4_report', args,
    result: { data: await ga4Report(new URLSearchParams(args)) } });
  const monthly = [await call({ report: 'form_performance', period: 'this_month' })];
  expect(scenarios.find(scenario => scenario.id === 'recorded_lead_events')!.check(monthly,
    'The source recorded 7 generate_lead events this month. These are not unique CRM sales leads.')).toBe(true);
  const history = [await call({ report: 'overview', period: 'last_28_days' }),
    await call({ report: 'form_performance', period: 'last_28_days' })];
  const answer = 'Zero key events does not prove zero enquiries because they were configured recently. There were 7 recorded generate_lead events, not unique CRM leads. These reports cannot prove the causes of underperformance; explanations remain hypotheses requiring further investigation.';
  expect(scenarios.find(scenario => scenario.id === 'recent_key_event_configuration')!.check(history, answer)).toBe(true);
  const altered = structuredClone(history);
  altered[1].result.data.items[0].metrics.generateLeadEventCount = 0;
  expect(hasRecordedLeadEvents(altered)).toBe(false);
  const bothEventTypes = [await call({ report: 'form_submissions', period: 'this_month' })];
  expect(scenarios.find(scenario => scenario.id === 'recorded_lead_events')!.check(bothEventTypes,
    'The source recorded 7 generate_lead events this month. These are not unique CRM sales leads.')).toBe(true);
  expect(hasRecordedLeadEvents([await call({ report: 'form_submissions', period: 'this_month', event_name: 'form_submit' })])).toBe(false);
});

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
      synthetic.scenario = scenario.id;
      const input: any[] = [{ role: 'user', content: scenario.prompt }];
      const trace: Trace[] = [];
      let answer = '';
      let error: string | null = null;
      try {
        for (let round = 0; round < 6; round++) {
          if (++calls > 40 || Date.now() >= deadline) throw new Error('EVAL_BUDGET');
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
