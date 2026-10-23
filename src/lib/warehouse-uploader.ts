import { sanitizeLabel } from './privacy';

export const UPLOADER_GUIDANCE = 'Copy a name from warehouse_filters.options.uploaded_by into uploaded_by on search_warehouses or warehouse_summary. Matches complete names after Unicode normalization, ignoring case and surrounding whitespace. Stored emails require one roster match; safe legacy names are retained. Unmapped or ambiguous emails and unsafe names are withheld. Names linked to multiple roster emails on visible inventory are omitted and rejected as ambiguous, even with narrower filters. Attribution is recorded, not verified identity, current assignment or a staff directory. Discovery is scoped by city/state; uploaded_by_truncated describes this name list only.';

// NFKC followed by the same whitespace trimming as String.trim(). Keep internal
// controls/formatting intact so the privacy boundary can withhold unsafe names.
function normalizedNameSql(column: string) {
  return `btrim(normalize(${column}, NFKC), U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')`;
}

// Resolve attribution within the caller's database snapshot. A scalar lookup
// cannot multiply warehouse rows; ambiguous email mappings remain unknown.
// Inactive roster entries still describe historical upload attribution.
export const UPLOADER_NAME_SQL = `CASE WHEN strpos(w."uploadedBy", '@') > 0 THEN (
  SELECT min(${normalizedNameSql('u.name')} COLLATE "C") FROM public."VerifiedNumber" u
  WHERE lower(btrim(u.email)) = lower(btrim(w."uploadedBy")) HAVING count(*) = 1
) ELSE ${normalizedNameSql('w."uploadedBy"')} END`;

// Check all visible inventory, so narrowing a city/date cannot make a shared
// name look like a unique staff identity. Unused roster names are not exposed.
export const AMBIGUOUS_UPLOADER_NAMES_SQL = `SELECT lower(${UPLOADER_NAME_SQL}) AS name
  FROM public."Warehouse" w WHERE w.visibility IS TRUE AND strpos(w."uploadedBy", '@') > 0
  GROUP BY lower(${UPLOADER_NAME_SQL}) HAVING count(DISTINCT lower(btrim(w."uploadedBy"))) > 1`;

export function warehouseUploaderName(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.normalize('NFKC').trim() : null;
  const name = sanitizeLabel(normalized, 80);
  return name !== null && name === normalized
    && /^[\p{L}\p{M}\p{N} .,'’()&/_–—-]+$/u.test(name) ? name : null;
}
