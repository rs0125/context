import { describe, expect, it } from 'vitest';
import { validateCallRequest } from '../src/lib/call-performance-query';
import { callAssignmentFilter } from '../src/lib/call-performance';
import { buildPagination } from '../src/lib/query-pagination';

const now = new Date('2026-11-05T12:00:00Z');
const parse = (query = '', path = ['calls', 'assignments']) => validateCallRequest(path, new URLSearchParams(query), now);
describe('call report query contract', () => {
  it('resolves paired IST assignment dates and shares bounded filters', () => {
    const request = parse('caller=ALICE%40example.test&date_from=2026-10-02&date_to=2026-10-02&min_open_age_days=7&gap=missing_outcome&limit=10');
    if (request.report !== 'assignments') throw new Error('wrong route');
    expect(request.input).toMatchObject({ caller: 'alice@example.test', limit: 10, min_open_age_days: 7 });
    const spec = callAssignmentFilter(request.input, now);
    expect(spec.context).toMatchObject({ date_basis: 'assigned_at', state_basis: 'current',
      start_at: '2026-10-01T18:30:00.000Z', end_before: '2026-10-02T18:30:00.000Z' });
    expect(spec.context.filters).not.toHaveProperty('limit');
    expect(spec.params).toContain('alice@example.test');
    expect(spec.where.join(' ')).not.toContain('alice@example.test');
    expect(spec.where.join(' ')).toContain("a.state='open'");
  });
  it.each([
    'date_from=2026-10-01', 'date_to=2026-10-01', 'date_from=2026-02-30&date_to=2026-03-02',
    'date_from=2026-11-02&date_to=2026-11-01', 'date_from=2025-01-01&date_to=2026-11-01',
    'date_from=2026-11-05&date_to=2026-11-06', 'state=done&min_open_age_days=0',
    'state=open&state=done', 'limit=1.5', 'limit=26', 'min_open_age_days=-1',
    'sql=select+1', 'caller=not-an-email', 'outcome=won', 'gap=no_work', 'period=this_week',
  ])('rejects unsupported or misleading query %s', query => expect(() => parse(query)).toThrow());
  it('keeps all retained work when dates are omitted and rejects unknown routes', () => {
    const spec = callAssignmentFilter({}, now);
    expect(spec.context.start_at).toBeNull();
    expect(spec.where).toEqual([]);
    expect(() => parse('', ['calls', 'dispatch'])).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => parse('limit=2', ['calls', 'summary'])).toThrow();
  });
  it('accepts bigint assignment IDs without converting them to numbers', () => {
    expect(parse('', ['calls', 'assignments', '9007199254740993'])).toMatchObject({ input: { id: '9007199254740993' } });
    for (const id of ['0', '-1', '1.2', '1 OR 1=1', '9223372036854775808']) expect(() => parse('', ['calls', 'assignments', id])).toThrow();
  });
  it('binds bigint cursors to filters and preserves precision', () => {
    const values: unknown[] = [];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const config = { idColumn: 'a.id', idType: 'bigint' as const, sortColumns: {} };
    const first = buildPagination(new URLSearchParams('state=open'), config, bind);
    const cursor = first.cursorFor({ id: '9007199254740993' });
    const next = buildPagination(new URLSearchParams({ state: 'open', cursor }), config, bind);
    expect(next.where).toEqual(['a.id > $1']);
    expect(values).toEqual(['9007199254740993']);
    expect(() => buildPagination(new URLSearchParams({ state: 'done', cursor }), config, bind)).toThrow();
    expect(() => first.cursorFor({ id: '9223372036854775808' })).toThrow();
  });
});
