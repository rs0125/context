import { HttpError } from './errors';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const counters = new Map<string, { expires: number; count: number }>();
/** Per registered credential, per process. This is not a distributed quota. */
export function rateLimit(keyId: string, now = Date.now(), max = Number(process.env.CONTEXT_REQUESTS_PER_MINUTE ?? 30)) {
  if (!Number.isInteger(max) || max < 1 || max > 120) throw new HttpError(503, 'RATE_LIMIT_CONFIGURATION', 'Request limits are not configured correctly.');
  for (const [key, value] of counters) if (value.expires <= now) counters.delete(key);
  const state = counters.get(keyId) ?? { expires: now + 60_000, count: 0 };
  if (state.count >= max) throw new HttpError(429, 'RATE_LIMITED', 'Request limit reached. Retry in one minute.');
  state.count += 1;
  counters.set(keyId, state);
}

/** Anonymous callers cannot allocate an unbounded map or evict authenticated
 * quotas. This is process-local abuse resistance, not a distributed limiter. */
export function createAnonymousLimiter(maxEntries = 2048, windowMs = 60_000) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 8192 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error('INVALID_LIMITER_CONFIGURATION');
  const entries = new Map<string, { expires: number; count: number }>();
  function fingerprint(namespace: string, subject: string) {
    return createHash('sha256').update(namespace).update('\0').update(subject).digest('hex');
  }
  function current(namespace: string, subject: string, now: number) {
    for (const [key, value] of entries) if (value.expires <= now) entries.delete(key);
    const key = fingerprint(namespace, subject);
    return { key, state: entries.get(key) };
  }
  return {
    check(namespace: string, subject: string, max: number, now = Date.now()) {
      if (!Number.isInteger(max) || max < 1 || max > 120) throw new HttpError(503, 'RATE_LIMIT_CONFIGURATION', 'Request limits are not configured correctly.');
      if ((current(namespace, subject, now).state?.count ?? 0) >= max) throw new HttpError(429, 'RATE_LIMITED', 'Request limit reached. Retry in one minute.');
    },
    record(namespace: string, subject: string, now = Date.now()) {
      const { key, state } = current(namespace, subject, now);
      if (!state && entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, { expires: state?.expires ?? now + windowMs, count: Math.min(121, (state?.count ?? 0) + 1) });
    },
    size: () => entries.size,
  };
}

const failedCredentials = createAnonymousLimiter();
const anonymousRequests = createAnonymousLimiter();
/** Charge only proven authentication failures. Never use a shared IP/global
 * failure bucket to reject a potentially valid access/refresh token. Rotating
 * random tokens still require bounded DB lookups; deploy an edge WAF for that. */
export function checkFailedCredential(namespace: string, credential: string) { failedCredentials.check(namespace, credential, 5); }
export function noteFailedCredential(namespace: string, credential: string) { failedCredentials.record(namespace, credential); }

/** DCR is inherently anonymous. Trust only Vercel's overwritten client-IP
 * header on Vercel; arbitrary forwarded headers elsewhere are not identities.
 * A hashed fallback is intentionally conservative for local/self-hosted use.
 * https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for */
export function anonymousRequestLimit(request: Request, namespace: string, max: number) {
  const candidate = process.env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for')?.trim() : undefined;
  const source = candidate && isIP(candidate) ? candidate : 'unattributed';
  anonymousRequests.check(namespace, source, max);
  anonymousRequests.record(namespace, source);
}
