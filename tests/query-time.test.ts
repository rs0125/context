import { describe, expect, it } from 'vitest';
import { addDateConditions, clockContext, resolveDateQuery } from '../src/lib/query-time';
import { buildPagination } from '../src/lib/query-pagination';

const now = new Date('2026-09-25T18:45:00Z'); // Already Sep 26 in India.
describe('India calendar query ranges', () => {
  it('resolves today from the server clock across UTC midnight boundaries', () => {
    expect(clockContext(now).local_date).toBe('2026-09-26');
    expect(resolveDateQuery(new URLSearchParams('period=today'), ['created'], now)).toMatchObject({ date_from: '2026-09-26', date_to: '2026-09-26', start_at: '2026-09-25T18:30:00.000Z', end_before: '2026-09-26T18:30:00.000Z', timezone: 'Asia/Kolkata' });
  });
  it.each([
    ['yesterday', '2026-09-25', '2026-09-25'], ['tomorrow', '2026-09-27', '2026-09-27'],
    ['this_week', '2026-09-21', '2026-09-27'], ['last_week', '2026-09-14', '2026-09-20'],
    ['this_month', '2026-09-01', '2026-09-30'], ['last_month', '2026-08-01', '2026-08-31'],
    ['last_7_days', '2026-09-20', '2026-09-26'], ['last_30_days', '2026-08-28', '2026-09-26'],
    ['next_7_days', '2026-09-26', '2026-10-02'],
  ])('resolves %s as calendar dates', (period, from, to) => {
    expect(resolveDateQuery(new URLSearchParams({ period }), ['created'], now)).toMatchObject({ date_from: from, date_to: to });
  });
  it('handles leap dates and inclusive explicit end dates', () => {
    expect(resolveDateQuery(new URLSearchParams('date_from=2028-02-29&date_to=2028-02-29'), ['created'], now)).toMatchObject({ start_at: '2028-02-28T18:30:00.000Z', end_before: '2028-02-29T18:30:00.000Z' });
    const range = resolveDateQuery(new URLSearchParams('date_to=2026-09-25'), ['created'], now);
    expect(range.start_at).toBeNull();
    const values: unknown[] = [];
    expect(addDateConditions(range, 'o.twenty_created_at', value => { values.push(value); return '$1'; })).toEqual(['o.twenty_created_at < $1::timestamptz']);
    expect(values).toEqual(['2026-09-25T18:30:00.000Z']);
  });
  it.each(['date_from=2026-02-29', 'date_to=2026-09-31', 'date_from=2026-09-25T00:00:00Z', 'period=today&date_to=2026-09-25', 'period=', 'date_field=created', 'period=today&date_field=deleted', 'date_from=2026-10-01&date_to=2026-09-30'])('rejects ambiguous or invalid dates: %s', query => {
    expect(() => resolveDateQuery(new URLSearchParams(query), ['created'], now)).toThrow();
  });
});

describe('stable date pagination', () => {
  const config = { idColumn: 'w.id', idType: 'integer' as const, sortColumns: { created_desc: 'w.created', created_asc: 'w.created' }, filterContext: { start_at: '2026-09-25T18:30:00Z' } };
  const bind = () => { const values: unknown[] = []; return { values, fn: (v: unknown) => { values.push(v); return `$${values.length}`; } }; };
  it('uses timestamp and ID tie breaks, NULLS LAST, and accepts only the matching search cursor', () => {
    const query = new URLSearchParams('city=Bangalore&sort=created_desc&limit=2');
    const page = buildPagination(query, config, bind().fn);
    const cursor = page.cursorFor({ id: 4, sort_value: new Date('2026-09-26T00:00:00Z') });
    query.set('cursor', cursor); query.set('limit', '1');
    const next = bind();
    const parsed = buildPagination(query, config, next.fn);
    expect(parsed.orderBy).toBe('w.created DESC NULLS LAST, w.id ASC');
    expect(parsed.where[0]).toContain('w.created < $2::timestamptz');
    expect(parsed.where[0]).toContain('w.id > $1');
    expect(parsed.where[0]).toContain('w.created IS NULL');
    expect(next.values).toEqual([4, '2026-09-26T00:00:00.000Z']);
    query.set('city', 'Mumbai');
    expect(() => buildPagination(query, config, bind().fn)).toThrow('does not match');
  });
  it('continues within null timestamps without returning dated records again', () => {
    const query = new URLSearchParams('sort=created_asc');
    const cursor = buildPagination(query, config, bind().fn).cursorFor({ id: 5, sort_value: null });
    query.set('cursor', cursor);
    expect(buildPagination(query, config, bind().fn).where).toEqual(['(w.created IS NULL AND w.id > $1)']);
  });
  it('rejects legacy numeric cursors for every sort with an explicit restart instruction', () => {
    expect(() => buildPagination(new URLSearchParams('cursor=12'), config, bind().fn)).toThrow('Restart the search');
    expect(() => buildPagination(new URLSearchParams('cursor=12&sort=created_desc'), config, bind().fn)).toThrow('Restart the search');
  });
});
