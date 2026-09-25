import { describe, expect, it } from 'vitest';
import { buildPagination } from '../src/lib/query-pagination';
import { resolveDateQuery } from '../src/lib/query-time';

const uuid = '00000000-0000-4000-8000-000000000abc';
const configurations = [
  { idColumn: 'w.id', idType: 'integer' as const, id: 500 },
  { idColumn: 'o.opportunity_id', idType: 'uuid' as const, id: uuid },
];
const dateColumns = { created_asc: 'source.created', created_desc: 'source.created' };
const resolved = { start_at: '2026-09-24T18:30:00.000Z', end_before: '2026-09-25T18:30:00.000Z' };
function bindings() {
  const values: unknown[] = [];
  return { values, bind: (value: unknown) => { values.push(value); return `$${values.length}`; } };
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

describe.each(configurations)('opaque pagination for $idType identifiers', config => {
  const options = { ...config, sortColumns: dateColumns, filterContext: resolved };
  it('round-trips default ID order and allows only page size / query-order changes', () => {
    const initial = new URLSearchParams('city=Bangalore&period=today&limit=1');
    const first = buildPagination(initial, options, bindings().bind);
    const cursor = first.cursorFor({ id: config.id });
    expect(cursor).not.toBe(String(config.id));
    const query = new URLSearchParams({ period: 'today', city: ' Bangalore ', sort: 'id_asc', cursor, limit: '25' });
    const bound = bindings();
    const next = buildPagination(query, { ...options, filterContext: { end_before: resolved.end_before, start_at: resolved.start_at } }, bound.bind);
    expect(next.where).toEqual([`${config.idColumn} > $1`]);
    expect(next.orderBy).toBe(`${config.idColumn} ASC`);
    expect(bound.values).toEqual([config.id]);
  });

  it.each(['id_asc', 'created_desc', 'created_asc'])('binds %s cursors to filters, sort and collection', sort => {
    const query = new URLSearchParams({ city: 'Bangalore', sort });
    const cursor = buildPagination(query, options, bindings().bind).cursorFor({ id: config.id, sort_value: '2026-09-25T00:00:00.000Z' });
    query.set('cursor', cursor); query.set('city', 'Mumbai');
    expect(() => buildPagination(query, options, bindings().bind)).toThrow('does not match');
    query.set('city', 'Bangalore'); query.set('sort', sort === 'id_asc' ? 'created_desc' : 'id_asc');
    expect(() => buildPagination(query, options, bindings().bind)).toThrow('does not match');
    query.set('sort', sort);
    expect(() => buildPagination(query, { ...options, idColumn: 'different.id' }, bindings().bind)).toThrow('does not match');
  });

  it.each(['id_asc', 'created_desc'])('refuses %s continuation after the resolved India date changes', sort => {
    const query = new URLSearchParams({ period: 'today', sort });
    const window = (now: string) => {
      const { start_at, end_before } = resolveDateQuery(query, ['created'], new Date(now));
      return { start_at, end_before };
    };
    const cursor = buildPagination(query, { ...options, filterContext: window('2026-09-25T18:29:50Z') }, bindings().bind)
      .cursorFor({ id: config.id, sort_value: '2026-09-25T00:00:00.000Z' });
    query.set('cursor', cursor);
    expect(() => buildPagination(query, { ...options, filterContext: window('2026-09-25T18:29:59Z') }, bindings().bind)).not.toThrow();
    expect(() => buildPagination(query, { ...options, filterContext: window('2026-09-25T18:30:00Z') }, bindings().bind)).toThrow('does not match');
  });

  it('binds moving follow-up windows even when no explicit date range is supplied', () => {
    const query = new URLSearchParams('follow_up_status=today');
    const followUp = { status: 'today', timezone: 'Asia/Kolkata', ...resolved };
    const config = { ...options, filterContext: { start_at: null, end_before: null, follow_up: followUp } };
    query.set('cursor', buildPagination(query, config, bindings().bind).cursorFor({ id: options.id }));
    expect(() => buildPagination(query, { ...config, filterContext: { ...config.filterContext, follow_up: { ...followUp, start_at: resolved.end_before } } }, bindings().bind)).toThrow('does not match');
  });

  it.each(['created_asc', 'created_desc'])('uses stable date/id ties and a null tail for %s', sort => {
    const query = new URLSearchParams({ sort });
    const first = buildPagination(query, options, bindings().bind);
    query.set('cursor', first.cursorFor({ id: config.id, sort_value: new Date('2026-09-25T00:00:00.123Z') }));
    const dated = bindings();
    const next = buildPagination(query, options, dated.bind);
    expect(next.orderBy).toBe(`source.created ${sort.endsWith('desc') ? 'DESC' : 'ASC'} NULLS LAST, ${config.idColumn} ASC`);
    expect(next.where[0]).toContain(`source.created = $2::timestamptz AND ${config.idColumn} > $1`);
    expect(next.where[0]).toContain('OR source.created IS NULL');
    expect(dated.values).toEqual([config.id, '2026-09-25T00:00:00.123Z']);
    query.set('cursor', first.cursorFor({ id: config.id, sort_value: null }));
    expect(buildPagination(query, options, bindings().bind).where).toEqual([`(source.created IS NULL AND ${config.idColumn} > $1)`]);
  });

  it('requires an explicit restart for legacy bare IDs and prior-version cursors', () => {
    expect(() => buildPagination(new URLSearchParams({ cursor: String(config.id) }), options, bindings().bind)).toThrow('Restart the search');
    const current = buildPagination(new URLSearchParams(), options, bindings().bind).cursorFor({ id: config.id });
    const prior = { ...JSON.parse(Buffer.from(current, 'base64url').toString()), v: 1 };
    expect(() => buildPagination(new URLSearchParams({ cursor: encode(prior) }), options, bindings().bind)).toThrow('restart without a cursor');
  });

  it.each(['', '!', 'a'.repeat(1025), encode(null), encode([]), encode({ v: 2 }), 'not-a-cursor'])('rejects malformed cursor %s before binding a keyset', cursor => {
    const bound = bindings();
    expect(() => buildPagination(new URLSearchParams({ cursor }), options, bound.bind)).toThrow();
    expect(bound.values).toEqual([]);
  });

  it('rejects wrong identifier types, surplus fields and noncanonical date values', () => {
    const query = new URLSearchParams('sort=created_desc');
    const valid = JSON.parse(Buffer.from(buildPagination(query, options, bindings().bind).cursorFor({ id: config.id, sort_value: null }), 'base64url').toString());
    for (const changes of [{ id: [config.id] }, { id: 0 }, { extra: true }, { date: '2026-02-30T00:00:00.000Z' }, { date: 'not-a-date' }]) {
      query.set('cursor', encode({ ...valid, ...changes }));
      expect(() => buildPagination(query, options, bindings().bind)).toThrow();
    }
  });

  it('rejects duplicate query parameters rather than fingerprinting an ambiguous filter', () => {
    expect(() => buildPagination(new URLSearchParams('city=A&city=B'), options, bindings().bind)).toThrow('Duplicate query parameter');
  });
});
