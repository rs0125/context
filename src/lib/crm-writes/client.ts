/** Fixed-purpose Twenty adapter. No model-controlled URL, method, headers or upsert. */
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import type { CrmCreator } from './rfq';

export function crmWriteConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (env.CONTEXT_CRM_RFQ_WRITES_ENABLED !== 'true') throw new HttpError(503, 'CRM_WRITES_DISABLED', 'RFQ creation is not enabled.');
  let url: URL;
  try { url = new URL(env.TWENTY_CRM_BASE_URL ?? ''); }
  catch { throw new HttpError(503, 'CRM_WRITE_CONFIGURATION', 'The CRM write connection is not configured.'); }
  const key = env.CONTEXT_CRM_WRITE_API_KEY;
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) {
    throw new HttpError(503, 'CRM_WRITE_CONFIGURATION', 'The CRM write connection is not configured.');
  }
  return { origin: url.origin, key };
}
export function crmWriteAvailability(env: Partial<NodeJS.ProcessEnv> = process.env) {
  try { crmWriteConfiguration(env); return { available: true }; }
  catch { return { available: false }; }
}

async function json(response: Response, limit: number): Promise<unknown> {
  if (response.redirected || !response.body) throw new Error('CRM_RESPONSE_UNVERIFIED');
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > limit)) {
    await response.body.cancel(); throw new Error('CRM_RESPONSE_UNVERIFIED');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('CRM_RESPONSE_UNVERIFIED'); }
      parts.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown;
  } finally { reader.releaseLock(); }
}
const member = z.object({ id: z.string().uuid(), userEmail: z.string().email(), deletedAt: z.null(),
  name: z.object({ firstName: z.string().max(200), lastName: z.string().max(200) }) });

export class CrmRfqClient {
  constructor(private readonly env: Partial<NodeJS.ProcessEnv> = process.env, private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown) {
    const { origin, key } = crmWriteConfiguration(this.env);
    return this.fetcher(new URL(path, origin), { method, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async creator(principal: Principal, signal: AbortSignal): Promise<CrmCreator> {
    if (!principal.twentyUserId) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A current linked CRM member is required.');
    try {
      const response = await this.request('/rest/workspaceMembers?limit=200&depth=0&filter=deletedAt[is]:NULL', 'GET', signal);
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const page = z.object({ data: z.object({ workspaceMembers: z.array(member).max(200) }), pageInfo: z.object({ hasNextPage: z.literal(false) }) }).parse(await json(response, 512_000));
      const matches = page.data.workspaceMembers.filter(row => row.userEmail.toLowerCase() === principal.email.toLowerCase());
      if (matches.length !== 1 || matches[0].id.toLowerCase() !== principal.twentyUserId.toLowerCase()
        || page.data.workspaceMembers.filter(row => row.id.toLowerCase() === principal.twentyUserId!.toLowerCase()).length !== 1) throw new Error();
      return { id: matches[0].id, name: `${matches[0].name.firstName} ${matches[0].name.lastName}`.trim() };
    } catch {
      throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'The employee could not be uniquely verified as a current CRM member.');
    }
  }
  async create(payload: Record<string, unknown>, signal: AbortSignal): Promise<{ outcome: 'created'; id: string } | { outcome: 'rejected' | 'outcome_unknown' }> {
    try {
      const response = await this.request('/rest/opportunities?depth=0', 'POST', signal, payload);
      if (!response.ok) {
        await response.body?.cancel();
        // Only explicit validation/access rejections establish that creation failed.
        return { outcome: [400, 401, 403, 404, 422].includes(response.status) && !response.redirected ? 'rejected' : 'outcome_unknown' };
      }
      const result = z.object({ data: z.object({ createOpportunity: z.object({ id: z.string().uuid(), deletedAt: z.null() }).passthrough() }) }).parse(await json(response, 64_000));
      const record = result.data.createOpportunity;
      if (response.status !== 201 || !contains(record, payload)) return { outcome: 'outcome_unknown' };
      return { outcome: 'created', id: record.id };
    } catch { return { outcome: 'outcome_unknown' }; }
  }
}
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => contains(actual[i], value));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
  return actual === expected;
}
