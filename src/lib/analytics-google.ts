/** Server-side, bounded Google read transport. Never import this into client UI. */
import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { HttpError } from './errors';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly';
const MAX_BYTES = 2 * 1024 * 1024;
const DEADLINE = 8_000;
const TTL = 5 * 60_000;
const MAX_CACHE = 64;
const MAX_INFLIGHT = 16;
type Credentials = { identity: string; email: string; privateKey: string; keyId?: string };
type Token = { value: string; expires: number };
type Cached = { value: unknown; fetchedAt: string; expires: number };
const tokens = new Map<string, Token>();
const tokenInflight = new Map<string, Promise<Token>>();
const responses = new Map<string, Cached>();
const responseInflight = new Map<string, Promise<Cached>>();
function configError(): never { throw new HttpError(503, 'ANALYTICS_CONFIGURATION', 'The analytics read connection is not configured correctly.'); }
export function analyticsSourceError(code = 'ANALYTICS_RESPONSE_INVALID'): never {
  throw new HttpError(503, code, 'The analytics source response could not be verified. No result is available.');
}
export function analyticsCredentials(): Credentials {
  const raw = process.env.GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.length > 20_000) configError();
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { configError(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== 'service_account'
    || typeof data.client_email !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}@[a-z0-9][a-z0-9-]{0,62}\.iam\.gserviceaccount\.com$/.test(data.client_email)
    || typeof data.private_key !== 'string' || data.private_key.length > 12_000 || !/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+-----END PRIVATE KEY-----\s*$/.test(data.private_key)
    || (data.token_uri !== undefined && data.token_uri !== TOKEN_URL)
    || (data.private_key_id !== undefined && (typeof data.private_key_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.private_key_id)))) configError();
  return { identity: createHash('sha256').update(raw).digest('hex'), email: data.client_email,
    privateKey: data.private_key, keyId: data.private_key_id as string | undefined };
}
export function ga4PropertyId(): string {
  const value = process.env.GA4_PROPERTY_ID;
  if (!value || !/^[1-9]\d{0,19}$/.test(value)) configError();
  return value;
}
export function searchConsoleSite(): string {
  const value = process.env.SEARCH_CONSOLE_SITE_URL;
  if (!value || value.length > 300) configError();
  if (/^sc-domain:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !url.port && url.pathname === '/' && url.href === value && /^[a-z0-9.-]+$/.test(url.hostname)) return value;
  } catch { /* Configuration error is intentionally opaque. */ }
  configError();
}
function providerError(status: number): never {
  if (status === 401 || status === 403) throw new HttpError(503, 'ANALYTICS_SOURCE_DENIED', 'Google denied this analytics read. Check API enablement and service-account access.');
  if (status === 429) throw new HttpError(503, 'ANALYTICS_SOURCE_RATE_LIMITED', 'Google analytics quota is temporarily exhausted. Retry later.');
  if (status === 400) throw new HttpError(503, 'ANALYTICS_SOURCE_QUERY_UNAVAILABLE', 'Google could not run this supported report with the current property configuration.');
  throw new HttpError(503, 'ANALYTICS_SOURCE_UNAVAILABLE', 'The analytics source is temporarily unavailable.');
}
async function jsonRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<{ status: number; data?: unknown }> {
  const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status };
  }
  if (response.redirected || !response.body) analyticsSourceError();
  const rawSize = response.headers.get('content-length');
  if (rawSize !== null && (!/^\d+$/.test(rawSize) || Number(rawSize) > MAX_BYTES)) { await response.body.cancel(); analyticsSourceError(); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); analyticsSourceError(); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return { status: response.status, data: JSON.parse(text) as unknown };
  } finally { reader.releaseLock(); }
}
async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new HttpError(503, 'ANALYTICS_SOURCE_TIMEOUT', 'The analytics source did not respond in time.')); }, DEADLINE);
  });
  try { return await Promise.race([operation(parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal), timedOut]); }
  catch (error) { if (error instanceof HttpError) throw error; analyticsSourceError(); }
  finally { clearTimeout(timer); }
}
function put<K, V>(map: Map<K, V>, key: K, value: V, maximum = MAX_CACHE) {
  map.delete(key);
  while (map.size >= maximum) map.delete(map.keys().next().value!);
  map.set(key, value);
}
async function accessToken(credentials: Credentials): Promise<Token> {
  const cached = tokens.get(credentials.identity);
  if (cached && cached.expires > Date.now() + 60_000) return cached;
  const pending = tokenInflight.get(credentials.identity);
  if (pending) return pending;
  if (tokenInflight.size >= MAX_INFLIGHT) throw new HttpError(503, 'ANALYTICS_BUSY', 'Analytics reads are busy. Retry later.');
  const promise = deadline(async signal => {
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try { key = await importPKCS8(credentials.privateKey, 'RS256'); } catch { configError(); }
    const assertion = await new SignJWT({ scope: SCOPES }).setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(credentials.keyId ? { kid: credentials.keyId } : {}) })
      .setIssuer(credentials.email).setAudience(TOKEN_URL).setIssuedAt().setExpirationTime('1h').sign(key);
    const result = await jsonRequest(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, signal);
    if (result.status !== 200) providerError(result.status);
    const value = result.data as Record<string, unknown>;
    if (!value || typeof value !== 'object' || typeof value.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value.access_token)
      || value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isInteger(value.expires_in)
      || value.expires_in < 120 || value.expires_in > 7200) analyticsSourceError();
    const token = { value: value.access_token, expires: Date.now() + Math.min(value.expires_in, 3600) * 1000 };
    put(tokens, credentials.identity, token, 4);
    return token;
  });
  tokenInflight.set(credentials.identity, promise);
  try { return await promise; } finally { tokenInflight.delete(credentials.identity); }
}
type GoogleRead = { kind: 'ga4_report' | 'ga4_metadata'; property: string } | { kind: 'search_console'; site: string };
function destination(read: GoogleRead): string {
  if (read.kind === 'search_console') return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(read.site)}/searchAnalytics/query`;
  if (!/^[1-9]\d{0,19}$/.test(read.property)) configError();
  return `https://analyticsdata.googleapis.com/v1beta/properties/${read.property}${read.kind === 'ga4_metadata' ? '/metadata' : ':runReport'}`;
}
/** Cache contains only validated, projected output. Authorization is checked by
 * the calling API on every request, including cache hits. No stale fallback. */
export async function googleAnalyticsRead<T>(read: GoogleRead, body: unknown, project: (raw: unknown) => T, signal?: AbortSignal): Promise<{ data: T; source_fetched_at: string; cache_hit: boolean }> {
  if (signal?.aborted) throw new HttpError(503, 'ANALYTICS_SOURCE_TIMEOUT', 'The analytics source did not respond in time.');
  const credentials = analyticsCredentials();
  const url = destination(read);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const key = createHash('sha256').update(JSON.stringify([credentials.identity, url, serialized])).digest('hex');
  const cached = responses.get(key);
  if (cached && cached.expires > Date.now()) return { data: structuredClone(cached.value) as T, source_fetched_at: cached.fetchedAt, cache_hit: true };
  const pending = responseInflight.get(key);
  if (pending) { const result = await pending; return { data: structuredClone(result.value) as T, source_fetched_at: result.fetchedAt, cache_hit: true }; }
  if (responseInflight.size >= MAX_INFLIGHT) throw new HttpError(503, 'ANALYTICS_BUSY', 'Analytics reads are busy. Retry later.');
  const promise = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(credentials);
      if (signal?.aborted) throw new HttpError(503, 'ANALYTICS_SOURCE_TIMEOUT', 'The analytics source did not respond in time.');
      const result = await deadline(signal => jsonRequest(url, { method: serialized === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token.value}`, ...(serialized ? { 'Content-Type': 'application/json' } : {}) }, body: serialized }, signal), signal);
      if (result.status === 401 && attempt === 0) {
        if (tokens.get(credentials.identity) === token) tokens.delete(credentials.identity);
        continue;
      }
      if (result.status !== 200) providerError(result.status);
      const projected = project(result.data);
      const output = { value: projected, fetchedAt: new Date().toISOString(), expires: Date.now() + TTL };
      put(responses, key, output);
      return output;
    }
    return providerError(401);
  })();
  responseInflight.set(key, promise);
  try { const result = await promise; return { data: structuredClone(result.value) as T, source_fetched_at: result.fetchedAt, cache_hit: false }; }
  finally { responseInflight.delete(key); }
}
