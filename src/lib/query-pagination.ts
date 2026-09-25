import { createHash } from 'node:crypto';
import { HttpError } from './errors';

type Config = { idColumn: string; idType: 'integer' | 'uuid'; sortColumns: Record<string, string>; defaultSort?: string; filterContext?: unknown };
function invalid(message: string): never { throw new HttpError(400, 'INVALID_QUERY', message); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(value: unknown, type: Config['idType']) {
  return type === 'integer' ? /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647 : typeof value === 'string' && UUID.test(value);
}
function iso(value: unknown): string | null {
  if (value == null) return null;
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) invalid('Invalid date cursor. Restart the search without a cursor.');
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) invalid('Invalid date cursor. Restart the search without a cursor.');
  return date.toISOString();
}

/** Keysets are data bounds, never authority. IDs stay subject to the read scope.
 * New sort cursors bind filters/date windows to catch accidental cross-search reuse.
 */
export function buildPagination(query: URLSearchParams, config: Config, bind: (value: unknown) => string) {
  const sort = query.get('sort') ?? config.defaultSort ?? 'id_asc';
  if (sort !== 'id_asc' && !Object.hasOwn(config.sortColumns, sort)) invalid(`sort must be ${['id_asc', ...Object.keys(config.sortColumns)].join(', ')}.`);
  const sortColumn = sort === 'id_asc' ? null : config.sortColumns[sort];
  const direction = sort.endsWith('_desc') ? 'DESC' : 'ASC';
  const entries = [...query.entries()].filter(([key]) => !['cursor', 'limit', 'sort'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = createHash('sha256').update(JSON.stringify([entries, config.filterContext ?? null])).digest('hex').slice(0, 24);
  const raw = query.get('cursor');
  const where: string[] = [];
  if (raw !== null) {
    if (sortColumn === null) {
      if (!validId(raw, config.idType)) invalid('Use the nextCursor from this search. ID order requires a valid record ID.');
      where.push(`${config.idColumn} > ${bind(config.idType === 'integer' ? Number(raw) : raw.toLowerCase())}`);
    } else {
      let cursor: { v: number; sort: string; id: string | number; date: string | null; filter: string };
      try {
        if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
        cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!cursor || cursor.v !== 1 || cursor.sort !== sort || cursor.filter !== fingerprint || !validId(cursor.id, config.idType)
          || !Object.hasOwn(cursor, 'date') || (cursor.date !== null && typeof cursor.date !== 'string')) throw new Error();
      } catch { invalid('Cursor does not match this search. Keep the same filters and sort, or restart without cursor.'); }
      const date = iso(cursor.date);
      const id = bind(config.idType === 'integer' ? Number(cursor.id) : String(cursor.id).toLowerCase());
      if (date === null) where.push(`(${sortColumn} IS NULL AND ${config.idColumn} > ${id})`);
      else {
        const dateParam = `${bind(date)}::timestamptz`;
        where.push(`(${sortColumn} ${direction === 'ASC' ? '>' : '<'} ${dateParam} OR (${sortColumn} = ${dateParam} AND ${config.idColumn} > ${id}) OR ${sortColumn} IS NULL)`);
      }
    }
  }
  return {
    sort, sortColumn, where,
    orderBy: sortColumn ? `${sortColumn} ${direction} NULLS LAST, ${config.idColumn} ASC` : `${config.idColumn} ASC`,
    cursorFor(row: { id: string | number; sort_value?: unknown }) {
      if (!validId(row.id, config.idType)) invalid('Invalid source identifier.');
      return sortColumn === null ? String(row.id) : Buffer.from(JSON.stringify({ v: 1, sort, id: row.id, date: iso(row.sort_value), filter: fingerprint })).toString('base64url');
    },
  };
}
