/** Read-only parsing of user-supplied locations. Coordinates are evidence, never write authorization. */
import { z } from 'zod';
import { HttpError } from './errors';

const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);
export const locationInputSchema = z.object({
  location: z.string().trim().min(1).max(2048).optional().describe('User-supplied coordinates, geo URI or Google Maps link. Addresses alone cannot be geocoded.'),
  latitude: latitude.optional(), longitude: longitude.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.location !== undefined ? value.latitude !== undefined || value.longitude !== undefined
    : value.latitude === undefined || value.longitude === undefined)
    ctx.addIssue({ code: 'custom', message: 'Supply location text OR both latitude and longitude, never both forms.' });
});
const method = z.enum(['supplied_coordinates', 'decimal_pair', 'dms', 'geo_uri', 'google_maps_pin', 'google_maps_viewport']);
const candidateSchema = z.object({ latitude, longitude, method, requiresConfirmation: z.boolean() }).strict();
const sourceSchema = z.union([
  z.object({ kind: z.literal('coordinates'), latitude, longitude }).strict(),
  z.object({ kind: z.enum(['text', 'url']), input: z.string().max(2048) }).strict(),
]);
export const locationOutputSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'unresolved']),
  candidates: z.array(candidateSchema).max(8), source: sourceSchema, reason: z.string(),
}).strict();
export type LocationInput = z.infer<typeof locationInputSchema>;
export type LocationResult = z.infer<typeof locationOutputSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type Parsed = { candidates: Candidate[]; invalid: boolean };
export type LocationResolverDependencies = { fetch: typeof globalThis.fetch; timeoutMs: number };
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numeric = new RegExp(`^${NUMBER}$`);
const pair = new RegExp(`^(${NUMBER})(?:\\s*[,;]\\s*|\\s+)(${NUMBER})$`);
function pairMatch(input: string) {
  let text = input.trim();
  if (text.startsWith('(') || text.endsWith(')')) {
    if (!text.startsWith('(') || !text.endsWith(')')) return null;
    text = text.slice(1, -1).trim();
  }
  return pair.exec(text);
}
const invalidInput = () => new HttpError(422, 'INVALID_LOCATION_INPUT', 'Supply one location string or a valid latitude/longitude pair.');

function inputValue(input: unknown): LocationInput {
  const result = locationInputSchema.safeParse(input);
  if (!result.success) throw invalidInput();
  return result.data;
}
export function parseLocationQuery(query: URLSearchParams): LocationInput {
  const value: Record<string, string | number> = {};
  for (const [key, raw] of query) {
    if (!['location', 'latitude', 'longitude'].includes(key) || Object.hasOwn(value, key)) throw invalidInput();
    if (key === 'location') value[key] = raw;
    else {
      if (!numeric.test(raw)) throw invalidInput();
      value[key] = Number(raw);
    }
  }
  return inputValue(value);
}
function candidate(lat: number, lng: number, method: Candidate['method']): Candidate | null {
  return latitude.safeParse(lat).success && longitude.safeParse(lng).success
    ? { latitude: Object.is(lat, -0) ? 0 : lat, longitude: Object.is(lng, -0) ? 0 : lng, method, requiresConfirmation: false } : null;
}
function add(parsed: Parsed, lat: number, lng: number, method: Candidate['method']) {
  const point = candidate(lat, lng, method);
  if (point) parsed.candidates.push(point); else parsed.invalid = true;
}
function unique(points: Candidate[]) {
  return points.filter((point, index) => !points.slice(0, index).some(other =>
    Math.abs(other.latitude - point.latitude) < 1e-10 && Math.abs(other.longitude - point.longitude) < 1e-10));
}
function outcome(source: LocationResult['source'], parsed: Parsed, ambiguous = false, reason?: string): LocationResult {
  const points = unique(parsed.candidates), needsSelection = ambiguous || parsed.invalid || points.length !== 1;
  const status = points.length ? needsSelection ? 'ambiguous' : 'resolved' : 'unresolved';
  return { status, candidates: points.slice(0, 8).map(point => ({ ...point, requiresConfirmation: needsSelection })), source,
    reason: reason ?? (points.length > 8 ? 'More than eight different coordinates were supplied; select one location.'
      : parsed.invalid ? 'Some supplied coordinates are invalid; confirm the intended latitude and longitude.'
      : points.length > 1 ? 'Multiple different coordinates were supplied; select the intended location.'
      : points.length ? 'An explicit coordinate pair was supplied. This does not verify the address, site or permission to save it.'
      : 'No explicit coordinates were found. Supply a pin or coordinates; address and place-ID geocoding is unavailable.') };
}
function decimalText(text: string): Parsed {
  const parsed: Parsed = { candidates: [], invalid: false };
  // Pair explicit axes in source order, so repeated locations never form cross-pairs.
  const axisPattern = new RegExp(`\\b(lat(?:itude)?|lon(?:g(?:itude)?)?|lng)\\s*[:=]?\\s*(${NUMBER})(?=$|[^\\w.]|\\.(?!\\d)|[NSEW]\\b)`, 'gi');
  const axes: { value: number; latitude: boolean; invalid: boolean }[] = [];
  for (const match of text.matchAll(axisPattern)) {
    const tail = text.slice(match.index! + match[0].length);
    if (/^\s*[°º'′"″]/.test(tail)) continue; // Parse a labelled DMS value only through the complete DMS grammar below.
    const isLatitude = /^lat/i.test(match[1]), hemisphere = /^\s*(north|south|east|west|[NSEW])\b/i.exec(tail)?.[1][0].toUpperCase();
    const invalid = hemisphere !== undefined && (match[2].startsWith('-') || match[2].startsWith('+')
      || isLatitude !== ['N', 'S'].includes(hemisphere));
    axes.push({ value: Number(match[2]) * (hemisphere && ['S', 'W'].includes(hemisphere) ? -1 : 1), latitude: isLatitude, invalid });
  }
  if (axes.length % 2) parsed.invalid = true;
  for (let index = 0; index + 1 < axes.length; index += 2) {
    const first = axes[index], second = axes[index + 1];
    if (first.invalid || second.invalid || first.latitude === second.latitude) { parsed.invalid = true; continue; }
    add(parsed, first.latitude ? first.value : second.value, first.latitude ? second.value : first.value, 'decimal_pair');
  }
  // Bare pairs must occupy the complete input (or a list item), not arbitrary address prose.
  const entire = pairMatch(text);
  if (entire) add(parsed, Number(entire[1]), Number(entire[2]), 'decimal_pair');
  else for (const part of text.split(/\n|\s*\|\s*|;(?=\s*[([]?[+-]?[\d.])|\s+(?:or|and)\s+/i)) {
    const match = pairMatch(part);
    if (match) add(parsed, Number(match[1]), Number(match[2]), 'decimal_pair');
  }
  return parsed;
}
function coordinates(text: string): Parsed {
  const parsed = decimalText(text);
  const tokens = [...text.matchAll(/(?<![\w.+-])([+-]?\d{1,3}(?:\.\d+)?)\s*[°º]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["″]\s*)?([NSEW])\b/gi)];
  const axes: { value: number; latitude: boolean; invalid: boolean }[] = [];
  for (const token of tokens) {
    const degrees = Number(token[1]), minutes = Number(token[2] ?? 0), seconds = Number(token[3] ?? 0);
    const hemisphere = token[4].toUpperCase(), isLatitude = hemisphere === 'N' || hemisphere === 'S';
    const invalid = token[1].startsWith('-') || token[1].startsWith('+') || minutes >= 60 || seconds >= 60
      || token[3] !== undefined && token[2] === undefined || token[2] !== undefined && !Number.isInteger(degrees)
      || token[3] !== undefined && !Number.isInteger(minutes);
    const value = (degrees + minutes / 60 + seconds / 3600) * (['S', 'W'].includes(hemisphere) ? -1 : 1);
    axes.push({ value, latitude: isLatitude, invalid });
  }
  if (axes.length % 2) parsed.invalid = true;
  for (let index = 0; index + 1 < axes.length; index += 2) {
    const first = axes[index], second = axes[index + 1];
    if (first.invalid || second.invalid || first.latitude === second.latitude) { parsed.invalid = true; continue; }
    add(parsed, first.latitude ? first.value : second.value, first.latitude ? second.value : first.value, 'dms');
  }
  return parsed;
}
/** URL labels/search prose are not pins. Only a complete numeric/DMS target is evidence. */
function urlCoordinates(text: string): Parsed {
  const raw = text.replace(/^loc:\s*/i, '');
  const normalized = pairMatch(raw) ? raw : raw.replace(/\s*\([^()]*\)\s*$/, '');
  if (!/^[\d\s.,;|()+\-°º'′"″NSEWnsew]+$/.test(normalized)) return { candidates: [], invalid: false };
  return coordinates(normalized);
}
function decoded(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'share.google']);
const MAP_HOSTS = new Set(['google.com', 'www.google.com', 'maps.google.com', 'google.co.in', 'www.google.co.in', 'maps.google.co.in']);
function safeMapsUrl(value: string): URL | null {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (SHORT_HOSTS.has(url.hostname)) {
    const prefix = url.hostname === 'goo.gl' ? '/maps/' : '/';
    if (!new RegExp(`^${prefix}[A-Za-z0-9_-]+/?$`).test(url.pathname)) return null;
  } else if (!MAP_HOSTS.has(url.hostname) || !(/^\/maps(?:\/|$)/.test(url.pathname)
    || url.hostname.startsWith('maps.google.') && url.pathname === '/')) return null;
  return url;
}
function mapsCoordinates(url: URL): { parsed: Parsed; ambiguous: boolean; reason?: string } {
  const parsed: Parsed = { candidates: [], invalid: false }, viewports: Parsed = { candidates: [], invalid: false };
  const inactiveQuery: Parsed = { candidates: [], invalid: false };
  const path = decoded(url.pathname);
  const directions = /^\/maps\/dir(?:\/|$)/i.test(path) || ['origin', 'destination', 'waypoints', 'saddr', 'daddr', 'dirflg'].some(key => url.searchParams.has(key));
  let unresolvedTarget = false, hasPinBlock = false;
  const addText = (text: string, target = false, destination = parsed) => {
    const result = urlCoordinates(text);
    destination.invalid ||= result.invalid;
    if (target && destination === parsed && !result.candidates.length) unresolvedTarget = true;
    destination.candidates.push(...result.candidates.map(point => ({ ...point, method: 'google_maps_pin' as const })));
  };
  for (const key of ['q', 'query', ...(directions ? ['origin', 'destination', 'waypoints', 'saddr', 'daddr'] : [])])
    for (const value of url.searchParams.getAll(key)) for (const part of value.split('|'))
      addText(part, true, key === 'query' && (url.searchParams.get('api') !== '1' || url.searchParams.has('map_action')) ? inactiveQuery : parsed);
  for (const value of [path, ...url.searchParams.getAll('data')]) {
    for (const match of value.matchAll(new RegExp(`!3d(${NUMBER})!4d(${NUMBER})(?=!|/|$)`, 'g'))) {
      const before = parsed.candidates.length;
      add(parsed, Number(match[1]), Number(match[2]), 'google_maps_pin');
      hasPinBlock ||= parsed.candidates.length > before;
    }
  }
  const pathParts = path.split('/');
  if (['search', 'place', 'dir'].includes(pathParts[2])) {
    for (const part of pathParts.slice(3)) if (!part.startsWith('@') && !part.startsWith('data=')) addText(part.replace(/\+/g, ' '));
  }
  for (const match of path.matchAll(new RegExp(`@(${NUMBER}),(${NUMBER})(?=,|/|$)`, 'g')))
    add(viewports, Number(match[1]), Number(match[2]), 'google_maps_viewport');
  for (const key of ['ll', 'sll', 'center']) for (const value of url.searchParams.getAll(key)) {
    const match = pairMatch(value);
    if (match) add(viewports, Number(match[1]), Number(match[2]), 'google_maps_viewport');
  }
  if (directions) return { parsed: parsed.candidates.length ? parsed : viewports, ambiguous: true, reason: 'This is a directions link, not one selected pin. Confirm which route location you mean.' };
  if (!hasPinBlock && parsed.candidates.length && inactiveQuery.candidates.length) {
    parsed.candidates.push(...inactiveQuery.candidates); parsed.invalid ||= inactiveQuery.invalid;
  }
  const placeSelector = ['query_place_id', 'place_id', 'cid', 'ftid'].some(key => url.searchParams.has(key));
  if (parsed.candidates.length || parsed.invalid) return { parsed, ambiguous: placeSelector || unresolvedTarget,
    ...(placeSelector || unresolvedTarget ? { reason: 'The link also contains a place selector or search target that cannot be verified; confirm the supplied coordinate pair.' } : {}) };
  if (inactiveQuery.candidates.length || inactiveQuery.invalid) return { parsed: inactiveQuery, ambiguous: true,
    reason: 'These query coordinates are not in an active Maps search URL; confirm them or provide a selected pin.' };
  return { parsed: viewports, ambiguous: true, ...(viewports.candidates.length ? { reason: 'Only the map viewport or search center is available. It is not a selected pin; confirm the intended coordinates.' } : {}) };
}

/** Resolve redirects only. No HTML, undocumented CID endpoint, geocoder, cookies or credentials are used. */
async function expandShortUrl(initial: URL, signal: AbortSignal, deps: LocationResolverDependencies): Promise<URL> {
  const timeout = Math.min(5000, Math.max(1, Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 5000));
  const deadline = AbortSignal.timeout(timeout), combined = AbortSignal.any([signal, deadline]);
  let current = initial;
  const seen = new Set<string>();
  for (let hop = 0; hop <= 4; hop++) {
    combined.throwIfAborted();
    if (!SHORT_HOSTS.has(current.hostname)) return current;
    if (hop === 4 || seen.has(current.href)) throw new Error('SHORTLINK_UNRESOLVED');
    seen.add(current.href);
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error('SHORTLINK_CANCELLED')); combined.addEventListener('abort', abort, { once: true }); });
    const pending = deps.fetch(current.href, { method: 'GET', redirect: 'manual', signal: combined, cache: 'no-store', credentials: 'omit', headers: { accept: 'text/html' } });
    // A noncompliant fetch implementation must not keep this operation alive or leak its eventual body.
    void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    let response: Response;
    try { response = await Promise.race([pending, aborted]); } finally { combined.removeEventListener('abort', abort); }
    void response.body?.cancel().catch(() => {}); // Zero body bytes are read, including on errors.
    if (response.redirected || ![301, 302, 303, 307, 308].includes(response.status)) throw new Error('SHORTLINK_UNRESOLVED');
    const target = response.headers.get('location');
    if (!target || target.length > 2048) throw new Error('SHORTLINK_UNRESOLVED');
    let next: URL;
    try { next = new URL(target, current); } catch { throw new Error('SHORTLINK_UNRESOLVED'); }
    const safe = safeMapsUrl(next.href);
    if (!safe) throw new Error('SHORTLINK_UNRESOLVED');
    current = safe;
  }
  throw new Error('SHORTLINK_UNRESOLVED');
}

export async function resolveLocation(input: unknown, signal: AbortSignal, overrides: Partial<LocationResolverDependencies> = {}): Promise<LocationResult> {
  const value = inputValue(input);
  const source: LocationResult['source'] = value.location !== undefined
    ? { kind: /^(?:https?:|geo:)/i.test(value.location) ? 'url' : 'text', input: value.location }
    : { kind: 'coordinates', latitude: value.latitude!, longitude: value.longitude! };
  if (signal.aborted) return outcome(source, { candidates: [], invalid: false }, false, 'Location resolution was cancelled.');
  if (value.location === undefined) return outcome(source, { candidates: [candidate(value.latitude!, value.longitude!, 'supplied_coordinates')!], invalid: false });
  const text = value.location;
  if (/^geo:/i.test(text)) {
    const match = new RegExp(`^geo:(${NUMBER}),(${NUMBER})(?:,(${NUMBER}))?(?:;u=(${NUMBER}))?(?:\\?(.*))?$`, 'i').exec(text);
    const parsed: Parsed = { candidates: [], invalid: false };
    if (!match) return outcome(source, parsed);
    if (match[3] !== undefined && !Number.isFinite(Number(match[3])) || match[4] !== undefined && (!Number.isFinite(Number(match[4])) || Number(match[4]) < 0))
      return outcome(source, { candidates: [], invalid: true });
    const query = new URLSearchParams(match[5] ?? '');
    // geo:0,0?q=... is a common search URI; its origin is a placeholder, not a pin.
    let unresolvedTarget = false;
    if (!query.has('q') || Number(match[1]) !== 0 || Number(match[2]) !== 0)
      add(parsed, Number(match[1]), Number(match[2]), 'geo_uri');
    for (const item of query.getAll('q')) {
      const point = urlCoordinates(item);
      parsed.invalid ||= point.invalid; unresolvedTarget ||= point.candidates.length === 0;
      parsed.candidates.push(...point.candidates.map(p => ({ ...p, method: 'geo_uri' as const })));
    }
    const uncertain = Number(match[4] ?? 0) > 0 || unresolvedTarget;
    return outcome(source, parsed, uncertain, uncertain ? 'The geo URI supplies uncertainty or an unresolved search target; confirm the intended pin coordinates.' : undefined);
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    const url = safeMapsUrl(text);
    if (!url) return outcome(source, { candidates: [], invalid: false }, false, 'Only explicit coordinates, geo URIs and approved HTTPS Google Maps links are supported.');
    let finalUrl = url;
    if (SHORT_HOSTS.has(url.hostname)) {
      try { finalUrl = await expandShortUrl(url, signal, { fetch: globalThis.fetch, timeoutMs: 5000, ...overrides }); }
      catch { return outcome(source, { candidates: [], invalid: false }, false, signal.aborted ? 'Location resolution was cancelled.' : 'The short link could not be safely resolved. Supply the expanded Maps pin URL or coordinates.'); }
    }
    const parsed = mapsCoordinates(finalUrl);
    return outcome(source, parsed.parsed, parsed.ambiguous, parsed.reason);
  }
  return outcome(source, coordinates(text));
}
