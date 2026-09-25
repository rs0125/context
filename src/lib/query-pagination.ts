import { createHash } from 'node:crypto';
import { HttpError } from './errors';

type Config = { idColumn: string; idType: 'integer' | 'uuid'; sortColumns: Record<string, string>; defaultSort?: string; filterContext?: unknown };
function invalid(message: string): never { throw new HttpError(400, 'INVALID_QUERY', message); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_VERSION = 2;
type Cursor = { v: number; sort: string; id: string | number; date: string | null; filter: string };
function validId(value: unknown, type: Config['idType']) {
  return type === 'integer'
    ? ((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)))
      && Number(value) >= 1 && Number(value) <= 2147483647
    : typeof value === 'string' && UUID.test(value);
}
function iso(value: unknown): string | null {
  if (value == null) return null;
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) invalid('Invalid date cursor. Restart the search without a cursor.');
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) invalid('Invalid date cursor. Restart the search without a cursor.');
  return date.toISOString();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Keysets are data bounds, never authority. IDs stay subject to the read scope.
 * Every emitted cursor binds the collection, sort, normalized query and resolved
 * date windows. Page size may change. Domain-specific aliases/defaults are not
 * guessed here: callers must keep filter values unchanged. Bare record IDs and
 * v1 cursors require a restart; accepting them would lose these guarantees.
 */
export function buildPagination(query: URLSearchParams, config: Config, bind: (value: unknown) => string) {
  const sort = query.get('sort') ?? config.defaultSort ?? 'id_asc';
  if (sort !== 'id_asc' && !Object.hasOwn(config.sortColumns, sort)) invalid(`sort must be ${['id_asc', ...Object.keys(config.sortColumns)].join(', ')}.`);
  const sortColumn = sort === 'id_asc' ? null : config.sortColumns[sort];
  const direction = sort.endsWith('_desc') ? 'DESC' : 'ASC';
  const seen = new Set<string>();
  const filters: Record<string, string> = Object.create(null);
  for (const [key, value] of query) {
    if (seen.has(key)) invalid(`Duplicate query parameter: ${key}`);
    seen.add(key);
    if (!['cursor', 'limit', 'sort'].includes(key)) filters[key] = value.trim();
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({
    collection: config.idColumn, id_type: config.idType, sort,
    filters, resolved: config.filterContext ?? null,
  }))).digest('hex').slice(0, 24);
  const raw = query.get('cursor');
  const where: string[] = [];
  if (raw !== null) {
    if (/^[0-9]+$/.test(raw) || UUID.test(raw)) invalid('Legacy record-ID cursors are no longer supported. Restart the search without a cursor.');
    let cursor: Cursor;
    try {
      if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const decoded = Buffer.from(raw, 'base64url');
      if (decoded.toString('base64url') !== raw) throw new Error();
      cursor = JSON.parse(decoded.toString('utf8'));
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 5
        || cursor.v !== CURSOR_VERSION || cursor.sort !== sort || cursor.filter !== fingerprint || !validId(cursor.id, config.idType)
        || (config.idType === 'integer' && typeof cursor.id !== 'number') || !Object.hasOwn(cursor, 'date')
        || (cursor.date !== null && typeof cursor.date !== 'string') || (!sortColumn && cursor.date !== null)) throw new Error();
    } catch { invalid('Cursor does not match this search or is no longer supported. Keep the same filters and sort, or restart without a cursor.'); }
    const date = iso(cursor.date);
    if (date !== cursor.date) invalid('Invalid date cursor. Restart the search without a cursor.');
    const id = bind(config.idType === 'integer' ? Number(cursor.id) : String(cursor.id).toLowerCase());
    if (sortColumn === null) where.push(`${config.idColumn} > ${id}`);
    else {
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
      return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, sort,
        id: config.idType === 'integer' ? Number(row.id) : String(row.id).toLowerCase(),
        date: sortColumn ? iso(row.sort_value) : null, filter: fingerprint,
      })).toString('base64url');
    },
  };
}
