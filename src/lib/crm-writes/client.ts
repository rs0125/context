/** Fixed-purpose Twenty adapter. No model-controlled URL, method, headers or upsert. */
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import type { CrmCreator } from './rfq';
import { RFQ_DETAIL_FIELDS, rfqLiveRecordSchema, type RfqLiveRecord } from './changes';

export function crmWriteConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (env.CONTEXT_CRM_RFQ_WRITES_ENABLED !== 'true') throw new HttpError(503, 'CRM_WRITES_DISABLED', 'RFQ creation is not enabled.');
  return crmWriteConnectionConfiguration(env);
}
/** Shared dedicated credential only; each action family applies its own feature gate. */
export function crmWriteConnectionConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
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

/** Exact live member verification shared by independently gated CRM action families. */
export async function verifyCrmCreator(principal: Principal, signal: AbortSignal,
  env: Partial<NodeJS.ProcessEnv> = process.env, fetcher: typeof fetch = fetch): Promise<CrmCreator> {
  const linked = z.string().uuid().safeParse(principal.twentyUserId);
  if (!linked.success) throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'A current linked CRM member is required.');
  const memberId = linked.data.toLowerCase();
  try {
    const { origin, key } = crmWriteConnectionConfiguration(env);
    const query = new URLSearchParams({ limit: '1', depth: '0', filter: `id[eq]:"${memberId}",deletedAt[is]:NULL` });
    const response = await fetcher(new URL(`/rest/workspaceMembers?${query}`, origin), { method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const page = z.object({ data: z.object({ workspaceMembers: z.array(member).length(1) }), pageInfo: z.object({ hasNextPage: z.literal(false) }) }).parse(await json(response, 64_000));
    const current = page.data.workspaceMembers[0];
    if (current.id.toLowerCase() !== memberId || current.userEmail.toLowerCase() !== principal.email.toLowerCase()) throw new Error();
    const name = `${current.name.firstName} ${current.name.lastName}`.trim();
    if (!name) throw new Error();
    return { id: memberId, name };
  } catch {
    throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'The employee could not be uniquely verified as a current CRM member.');
  }
}

export class CrmRfqClient {
  constructor(private readonly env: Partial<NodeJS.ProcessEnv> = process.env, private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', signal: AbortSignal, body?: unknown) {
    const { origin, key } = crmWriteConfiguration(this.env);
    return this.fetcher(new URL(path, origin), { method, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async creator(principal: Principal, signal: AbortSignal): Promise<CrmCreator> {
    crmWriteConfiguration(this.env);
    return verifyCrmCreator(principal, signal, this.env, this.fetcher);
  }
  async create(payload: Record<string, unknown>, signal: AbortSignal): Promise<{ outcome: 'created'; id: string; record?: RfqLiveRecord } | { outcome: 'rejected' | 'outcome_unknown' }> {
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
      const snapshot = rfqLiveRecordSchema.safeParse(record);
      return { outcome: 'created', id: record.id, ...(snapshot.success ? { record: snapshot.data } : {}) };
    } catch { return { outcome: 'outcome_unknown' }; }
  }
  /** Callers must first establish an actor-bound successful creation receipt. */
  async read(id: string, signal: AbortSignal): Promise<RfqLiveRecord> {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) throw new HttpError(400, 'CRM_RFQ_ID_INVALID', 'A valid RFQ ID is required.');
    try {
      const response = await this.request(`/rest/opportunities/${parsedId.data.toLowerCase()}?depth=0`, 'GET', signal);
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && !response.redirected)
          throw new HttpError(404, 'CRM_RFQ_NOT_FOUND', 'The requested RFQ is no longer available.');
        throw new Error();
      }
      const result = z.object({ data: z.object({ opportunity: rfqLiveRecordSchema }) }).parse(await json(response, 64_000));
      if (result.data.opportunity.id.toLowerCase() !== parsedId.data.toLowerCase()) throw new Error();
      return result.data.opportunity;
    } catch (error) {
      if (error instanceof HttpError && error.code === 'CRM_RFQ_NOT_FOUND') throw error;
      throw new HttpError(503, 'CRM_RFQ_UNAVAILABLE', 'The current RFQ could not be verified. Nothing was changed.');
    }
  }
  async update(current: RfqLiveRecord, patch: Record<string, unknown>, signal: AbortSignal): Promise<CrmRfqChangeOutcome> {
    const filter = guardedFilter(current);
    if (!filter || !Object.keys(patch).length || Object.keys(patch).some(key => !(RFQ_DETAIL_FIELDS as readonly string[]).includes(key))) {
      return { outcome: 'rejected', code: 'CRM_RFQ_CHANGE_INVALID' };
    }
    try {
      const query = new URLSearchParams({ depth: '0', filter });
      const response = await this.request(`/rest/opportunities?${query}`, 'PATCH', signal, patch);
      if (!response.ok) {
        await response.body?.cancel();
        return rejectedResponse(response);
      }
      const result = z.object({ data: z.object({ updateOpportunities: z.array(rfqLiveRecordSchema).max(1) }) }).parse(await json(response, 64_000));
      if (response.status !== 200) return { outcome: 'outcome_unknown' };
      const record = result.data.updateOpportunities[0];
      if (!record) return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      if (record.id.toLowerCase() !== current.id.toLowerCase() || record.deletedAt !== null
        || record.ownerId?.toLowerCase() !== current.ownerId?.toLowerCase()
        || record.createdBy.workspaceMemberId?.toLowerCase() !== current.createdBy.workspaceMemberId?.toLowerCase()
        || record.stage !== current.stage || Date.parse(record.updatedAt) <= Date.parse(current.updatedAt)
        || !contains(record, patch)) return { outcome: 'outcome_unknown' };
      return { outcome: 'updated', id: record.id, record };
    } catch { return { outcome: 'outcome_unknown' }; }
  }
  /** Reverses only an unchanged RFQ creation; never permanently deletes a record. */
  async undoCreate(current: RfqLiveRecord, signal: AbortSignal): Promise<CrmRfqChangeOutcome> {
    const filter = guardedFilter(current);
    if (!filter || current.stage !== 'RFQ_RECEIVED') return { outcome: 'rejected', code: 'CRM_RFQ_CHANGE_INVALID' };
    try {
      const query = new URLSearchParams({ filter, soft_delete: 'true' });
      const response = await this.request(`/rest/opportunities?${query}`, 'DELETE', signal);
      if (!response.ok) {
        await response.body?.cancel();
        return rejectedResponse(response);
      }
      const result = z.object({ data: z.object({ deleteOpportunities: z.array(z.object({ id: z.string().uuid() })).max(1) }) }).parse(await json(response, 64_000));
      if (response.status !== 200) return { outcome: 'outcome_unknown' };
      const record = result.data.deleteOpportunities[0];
      if (!record) return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      if (record.id.toLowerCase() !== current.id.toLowerCase()) return { outcome: 'outcome_unknown' };
      return { outcome: 'rolled_back', id: record.id };
    } catch { return { outcome: 'outcome_unknown' }; }
  }
  /** Explicit removal of the current owned opportunity, even after edits or stage changes. */
  async delete(current: RfqLiveRecord, signal: AbortSignal): Promise<CrmRfqDeleteOutcome> {
    const filter = guardedFilter(current);
    if (!filter || this.env.CONTEXT_CRM_DELETES_ENABLED !== 'true') return { outcome: 'rejected', code: 'CRM_RFQ_DELETE_INVALID' };
    try {
      const query = new URLSearchParams({ filter, soft_delete: 'true' });
      const response = await this.request(`/rest/opportunities?${query}`, 'DELETE', signal);
      if (!response.ok) {
        await response.body?.cancel();
        return { outcome: [400, 401, 403, 404, 409, 412, 422].includes(response.status) && !response.redirected ? 'rejected' : 'outcome_unknown' };
      }
      const result = z.object({ data: z.object({ deleteOpportunities: z.array(z.object({ id: z.string().uuid() })).max(1) }) }).parse(await json(response, 64_000));
      if (response.status !== 200) return { outcome: 'outcome_unknown' };
      const record = result.data.deleteOpportunities[0];
      if (!record) return { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' };
      if (record.id.toLowerCase() !== current.id.toLowerCase()) return { outcome: 'outcome_unknown' };
      return { outcome: 'deleted', id: record.id };
    } catch { return { outcome: 'outcome_unknown' }; }
  }
}
export type CrmRfqDeleteOutcome = { outcome: 'deleted'; id: string }
  | { outcome: 'rejected' | 'outcome_unknown'; code?: string };
export type CrmRfqChangeOutcome = { outcome: 'updated'; id: string; record: RfqLiveRecord }
  | { outcome: 'rolled_back'; id: string }
  | { outcome: 'rejected' | 'outcome_unknown'; code?: string };

function rejectedResponse(response: Response): CrmRfqChangeOutcome {
  return { outcome: [400, 401, 403, 404, 409, 412, 422].includes(response.status) && !response.redirected ? 'rejected' : 'outcome_unknown' };
}

/** The collection route retains these predicates in the provider mutation. */
function guardedFilter(current: RfqLiveRecord): string | null {
  const parsed = rfqLiveRecordSchema.safeParse(current);
  if (!parsed.success || current.deletedAt !== null || !current.ownerId || !current.createdBy.workspaceMemberId
    || !/^[A-Z][A-Z0-9_]{0,99}$/.test(current.stage)) return null;
  return `id[eq]:"${current.id.toLowerCase()}",updatedAt[eq]:"${current.updatedAt}",ownerId[eq]:"${current.ownerId.toLowerCase()}",createdBy.workspaceMemberId[eq]:"${current.createdBy.workspaceMemberId.toLowerCase()}",stage[eq]:"${current.stage}",deletedAt[is]:NULL`;
}
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => contains(actual[i], value));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
  return actual === expected;
}
