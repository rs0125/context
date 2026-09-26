import { HttpError } from './errors';
export const CRM_CONTEXT_SECTIONS = ['notes', 'tasks', 'company', 'stage_history'] as const;
export type CrmContextSection = typeof CRM_CONTEXT_SECTIONS[number];
export function parseCrmContextQuery(query: URLSearchParams) {
  const invalid = (): never => { throw new HttpError(400, 'INVALID_QUERY', 'Choose notes, tasks, company or stage_history, a limit from 1 to 10, and the matching continuation cursor.'); };
  const seen = new Set<string>();
  for (const name of query.keys()) {
    if (!['section', 'limit', 'cursor'].includes(name) || seen.has(name)) invalid();
    seen.add(name);
  }
  const section = query.get('section') as CrmContextSection;
  const limit = query.get('limit') ?? '10';
  const cursor = query.get('cursor') ?? undefined;
  if (!(CRM_CONTEXT_SECTIONS as readonly string[]).includes(section) || !/^(?:[1-9]|10)$/.test(limit)
    || (cursor !== undefined && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048 || section === 'company'))) invalid();
  return { section, limit: Number(limit), cursor };
}
