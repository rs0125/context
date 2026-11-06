import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCallPerformance } from '../src/lib/call-performance';
import { withCallRead } from '../src/lib/call-performance-db';
import { callCapabilitiesOutput, callSummaryOutput, callSearchOutput, callDetailOutput, validateCallRequest } from '../src/lib/call-performance-query';

const connection = process.env.CONTEXT_CALLS_TEST_DATABASE_URL;
// Disposable local synthetic data only. Never accepts a hosted/source URL.
describe.skipIf(!connection)('call performance on isolated PostgreSQL', () => {
  let owner: pg.Pool, reader: pg.Pool;
  const run = (path: string, query = '') => readCallPerformance(
    validateCallRequest(path.split('/'), new URLSearchParams(query), new Date('2026-11-05T12:00:00Z')),
    work => withCallRead(work, reader));
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/context_call_performance_test') throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');
    owner = new pg.Pool({ connectionString: connection, max: 1 });
    await owner.query(`CREATE TABLE public.bolna_app_users(email text PRIMARY KEY,name text,active boolean,role text,callyzer_number text);
      CREATE TABLE public.bolna_assignments(id bigint PRIMARY KEY,entity_type text,entity_id uuid,assignee text REFERENCES public.bolna_app_users(email),
        assigned_at timestamptz,state text,outcome text,completed_at timestamptz,added_to_db boolean,wh_id text,remarks text);
      CREATE TABLE public.bolna_assignment_changes(id bigint PRIMARY KEY,assignment_id bigint REFERENCES public.bolna_assignments(id),
        changed_at timestamptz,actor text,before_values jsonb,after_values jsonb);
      CREATE TABLE public.bolna_manual_attempts(id bigint);
      CREATE VIEW public.bolna_effective_manual_attempts AS SELECT id FROM public.bolna_manual_attempts;
      CREATE TABLE public.callyzer_sync_state(last_success_at timestamptz,last_error text);
      INSERT INTO public.bolna_app_users VALUES
        ('alice@example.test','Alice',true,'employee','private-device'),
        ('bob@example.test','Bob',false,'employee',null),
        ('empty@example.test','No assignments yet',true,'employee',null),
        ('admin@example.test','Admin without assignments',true,'admin',null);
      INSERT INTO public.callyzer_sync_state VALUES (now()-interval '3 days',null);
      INSERT INTO public.bolna_assignments VALUES
        (1,'record','00000000-0000-4000-8000-000000000001','alice@example.test',now()-interval '2 days','open',null,null,false,null,'private notes'),
        (2,'record','00000000-0000-4000-8000-000000000002','alice@example.test','2026-10-01 18:29:59Z','done','Available',now(),true,'100','private notes'),
        (3,'call','00000000-0000-4000-8000-000000000003','bob@example.test','2026-10-01 18:30:00Z','dropped','Available',now(),true,'100','private notes'),
        (4,'call','00000000-0000-4000-8000-000000000004','alice@example.test','2026-10-02 18:29:59.999999Z','done','Unavailable',now(),true,'private-reference-text','private notes'),
        (5,'record','00000000-0000-4000-8000-000000000005','bob@example.test','2026-10-02 18:30:00Z','open','Available',null,false,null,'private notes'),
        (7,'record','00000000-0000-4000-8000-000000000007','alice@example.test',now()-interval '7 days','open',null,null,true,'N/A','private notes'),
        (8,'record','00000000-0000-4000-8000-000000000008','bob@example.test',now()-interval '30 days','open','Unclear',null,false,null,'private notes'),
        (9007199254740993,'call','00000000-0000-4000-8000-000000000009','alice@example.test',now()-interval '8 days','done','Available',now(),false,null,'private notes');
      INSERT INTO public.bolna_assignment_changes VALUES
        (1,2,'2026-10-11 12:00:00Z','alice@example.test','{}','{"state":"open","notes":"private audit notes"}'),
        (2,2,'2026-10-12 12:00:00Z','alice@example.test','{"state":"open","wh_id":"private-reference-text"}','{"state":"done","outcome":"Available","added_to_db":true,"wh_id":"100","phone":"private customer phone"}'),
        (3,2,'2026-10-13 12:00:00Z',null,'{"state":"done"}','{"state":"open"}'),
        (9007199254740994,2,'2026-10-14 12:00:00Z','alice@example.test','{"state":"open"}','{"state":"done","outcome":"Available"}');`);
    await owner.query(readFileSync(new URL('../scripts/sql/call-performance.sql', import.meta.url), 'utf8'));
    await owner.query("ALTER ROLE call_performance_reader LOGIN PASSWORD 'synthetic-reader'");
    url.username = 'call_performance_reader'; url.password = 'synthetic-reader';
    reader = new pg.Pool({ connectionString: url.toString(), max: 1 });
  });
  afterAll(async () => {
    await reader?.end();
    if (owner) {
      await owner.query(`DROP SCHEMA IF EXISTS call_performance CASCADE;
        DROP VIEW IF EXISTS public.bolna_effective_manual_attempts;
        DROP TABLE IF EXISTS public.bolna_assignment_changes,public.bolna_assignments,public.bolna_app_users,
          public.bolna_manual_attempts,public.callyzer_sync_state CASCADE;
        DROP ROLE IF EXISTS call_performance_reader;`);
      await owner.end();
    }
  });
  it('counts assignment episodes once despite multiple history events and deduplicates overall references', async () => {
    const result = callSummaryOutput.parse(await run('calls/summary'));
    expect(result.totals).toMatchObject({ assignments: 8, open: 4, done: 3, dropped: 1, available: 4,
      unavailable: 1, unclear: 1, missing_outcome: 2, staff_marked_added: 4, distinct_numeric_references: 1 });
    expect(result.callers.reduce((n, c) => n + c.metrics.assignments, 0)).toBe(8);
    expect(result.callers.reduce((n, c) => n + c.metrics.distinct_numeric_references, 0)).toBe(2);
    expect(result.callers.find(c => c.caller.email === 'bob@example.test')?.caller.active).toBe(false);
    expect(result.coverage).toMatchObject({ manual_attempts: 0, assignments_without_audit: 7,
      employee_callers: 3, linked_employee_callers: 1, callyzer_status: 'stale' });
    expect(result.coverage.warnings.join(' ')).toContain('cannot be interpreted as zero');
  });
  it('uses assignment dates with exact IST boundaries and current outcomes', async () => {
    const query = 'date_from=2026-10-02&date_to=2026-10-02';
    const summary = callSummaryOutput.parse(await run('calls/summary', query));
    const search = callSearchOutput.parse(await run('calls/assignments', query));
    expect(summary.totals).toMatchObject({ assignments: 2, done: 1, dropped: 1 });
    expect(search.items.map(row => row.id)).toEqual(['3', '4']);
    expect(search.query_context.state_basis).toBe('current');
  });
  it.each(['gap=missing_outcome', 'gap=added_without_reference', 'gap=done_available_without_numeric_reference',
    'gap=without_audit', 'caller=bob%40example.test&state=open', 'entity_type=call', 'min_open_age_days=7'])('keeps summary and search filters aligned: %s', async query => {
    const summary = callSummaryOutput.parse(await run('calls/summary', query));
    const search = callSearchOutput.parse(await run('calls/assignments', query));
    expect(summary.totals.assignments).toBe(search.items.length);
  });
  it('partitions open ages with no overlap at seven and thirty days', async () => {
    const all = callSummaryOutput.parse(await run('calls/summary'));
    expect(all.totals.open_under_7_days + all.totals.open_7_to_30_days + all.totals.open_30_days_plus).toBe(all.totals.open);
    const age = callSearchOutput.parse(await run('calls/assignments', 'min_open_age_days=7'));
    expect(age.items.map(row => row.id)).toContain('7');
    expect(age.items.map(row => row.id)).not.toContain('1');
    expect(age.items.every(row => row.state === 'open' && row.open_age_days! >= 7)).toBe(true);
  });
  it('returns real zero assignment counts for an empty cohort while retaining source limitations', async () => {
    const result = callSummaryOutput.parse(await run('calls/summary', 'caller=empty%40example.test'));
    expect(result.totals.assignments).toBe(0);
    expect(result.callers).toEqual([]);
    expect(result.coverage.callyzer_status).toBe('stale');
  });
  it('paginates all assignments without losing bigint precision or accepting changed filters', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '3', ...(cursor ? { cursor } : {}) });
      const result = callSearchOutput.parse(await run('calls/assignments', query.toString()));
      seen.push(...result.items.map(row => row.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['1', '2', '3', '4', '5', '7', '8', '9007199254740993']);
    const first = callSearchOutput.parse(await run('calls/assignments', 'limit=1'));
    await expect(run('calls/assignments', new URLSearchParams({ state: 'open', cursor: first.nextCursor! }).toString())).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
  it('returns only projected history, paginates chronologically and binds cursors to an assignment', async () => {
    const first = callDetailOutput.parse(await run('calls/assignments/2', 'limit=2'));
    expect(first.assignment.audit_events).toBe(4);
    expect(first.history_has_creation_event).toBe(true);
    expect(first.history.map(row => row.id)).toEqual(['1', '2']);
    expect(first.history[1]).toMatchObject({ before: { state: 'open', numeric_warehouse_reference: null },
      after: { state: 'done', numeric_warehouse_reference: '100' } });
    const second = callDetailOutput.parse(await run('calls/assignments/2', new URLSearchParams({ limit: '2', cursor: first.nextCursor! }).toString()));
    expect(second.history.map(row => row.id)).toEqual(['3', '9007199254740994']);
    expect(second.nextCursor).toBeNull();
    expect(second.history[0].actor).toBeNull();
    await expect(run('calls/assignments/3', new URLSearchParams({ cursor: first.nextCursor! }).toString())).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    const noHistory = callDetailOutput.parse(await run('calls/assignments/9007199254740993'));
    expect(noHistory.history).toEqual([]);
    expect(noHistory.history_has_creation_event).toBe(false);
    expect(JSON.stringify([first, second, noHistory])).not.toContain('private');
  });
  it('keeps inactive callers discoverable without exposing their device numbers', async () => {
    const result = callCapabilitiesOutput.parse(await run('calls/capabilities'));
    expect(result.callers).toHaveLength(3);
    expect(result.callers.some(c => c.email === 'bob@example.test' && !c.active)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-device');
  });
  it('enforces projected source access and read-only transactions in PostgreSQL', async () => {
    await expect(reader.query('SELECT remarks FROM public.bolna_assignments')).rejects.toMatchObject({ code: '42501' });
    await expect(reader.query('SELECT wh_id FROM call_performance.assignments')).rejects.toMatchObject({ code: '42703' });
    await expect(reader.query("UPDATE call_performance.assignments SET state='done' WHERE id=1")).rejects.toBeDefined();
    const result = await withCallRead(async client => (await client.query("SHOW transaction_read_only")).rows[0], reader);
    expect(result.transaction_read_only).toBe('on');
    await expect(run('calls/assignments/999')).rejects.toMatchObject({ status: 404 });
  });
});
