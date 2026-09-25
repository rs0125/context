import { HttpError } from './errors';

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
