import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { CrmRfqClient, crmWriteAvailability } from '../src/lib/crm-writes/client';
import { rfqPayload } from '../src/lib/crm-writes/rfq';

const env = { CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test', CONTEXT_CRM_WRITE_API_KEY: 'synthetic-write-key' };
const member = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userEmail: 'employee@wareongo.com', deletedAt: null, name: { firstName: 'Synthetic', lastName: 'Employee' } };
const actor: Principal = { employeeId: 7, email: member.userEmail, twentyUserId: member.id, scopes: ['crm.rfq:write'], keyId: 'test', isAnalyst: false };
const payload = rfqPayload({ operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', raw_text: '5000 sqft in Chennai', location: 'Chennai', requirement: '5000 sqft' }, { id: member.id, name: 'Synthetic Employee' });
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const signal = () => new AbortController().signal;
const created = () => ({ data: { createOpportunity: { id, deletedAt: null, ...payload } } });
describe('fixed-purpose CRM HTTP adapter', () => {
  it('uses only the exact POST path without upsert and verifies all requested fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(created(), { status: 201 }));
    expect(await new CrmRfqClient(env, fetcher).create(payload, signal())).toEqual({ outcome: 'created', id });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://crm.example.test/rest/opportunities?depth=0');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-write-key' } });
    expect(JSON.parse(init!.body as string)).toEqual(payload);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 404, 422, 429, 500, 502, 302])('classifies HTTP %s without echoing upstream data or retrying', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('secret upstream body', { status }));
    const result = await new CrmRfqClient(env, fetcher).create(payload, signal());
    expect(result).toEqual({ outcome: [400, 401, 403, 404, 422].includes(status) ? 'rejected' : 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['description', 'stage', 'createdBy', 'requirementInSft', 'ownerId'])('treats a successful response with altered %s as uncertain', async field => {
    const data = created(); (data.data.createOpportunity as Record<string, unknown>)[field] = 'wrong';
    const fetcher: typeof fetch = async () => Response.json(data, { status: 201 });
    expect(await new CrmRfqClient(env, fetcher).create(payload, signal())).toEqual({ outcome: 'outcome_unknown' });
  });
  it.each(['network', 'malformed', 'oversize'])('retains uncertainty on %s failures', async mode => {
    const fetcher: typeof fetch = async () => {
      if (mode === 'network') throw new Error('request failed');
      return new Response(mode === 'malformed' ? 'invalid json' : 'x'.repeat(65000), { status: 201 });
    };
    expect(await new CrmRfqClient(env, fetcher).create(payload, signal())).toEqual({ outcome: 'outcome_unknown' });
  });
  it('verifies membership by both unique email and roster-pinned ID, without an Analyst bypass', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { workspaceMembers: [member] }, pageInfo: { hasNextPage: false } }));
    const crm = new CrmRfqClient(env, fetcher);
    expect(await crm.creator(actor, signal())).toEqual({ id: member.id, name: 'Synthetic Employee' });
    expect(String(fetcher.mock.calls[0][0])).toContain('/rest/workspaceMembers?');
    await expect(crm.creator({ ...actor, twentyUserId: id, isAnalyst: true }, signal())).rejects.toMatchObject({ code: 'CRM_IDENTITY_UNAVAILABLE' });
  });
  it.each(['duplicate', 'deleted', 'incomplete', 'wrong-email'])('refuses %s membership results', async mode => {
    const members = mode === 'duplicate' ? [member, { ...member, id }] : [{ ...member, ...(mode === 'deleted' ? { deletedAt: '2026-01-01T00:00:00Z' } : {}), ...(mode === 'wrong-email' ? { userEmail: 'someone-else@wareongo.com' } : {}) }];
    const crm = new CrmRfqClient(env, async () => Response.json({ data: { workspaceMembers: members }, pageInfo: { hasNextPage: mode === 'incomplete' } }));
    await expect(crm.creator(actor, signal())).rejects.toMatchObject({ code: 'CRM_IDENTITY_UNAVAILABLE' });
  });
  it.each(['http://crm.example.test', 'https://key@crm.example.test', 'https://crm.example.test/evil', 'https://crm.example.test?key=x'])('refuses unsafe configured origin %s', url => {
    expect(crmWriteAvailability({ ...env, TWENTY_CRM_BASE_URL: url }).available).toBe(false);
  });
  it('does not reuse the CRM read key or enable itself implicitly', () => {
    expect(crmWriteAvailability({ ...env, CONTEXT_CRM_WRITE_API_KEY: '', TWENTY_CRM_API_KEY: 'read-key' }).available).toBe(false);
    expect(crmWriteAvailability({ ...env, CONTEXT_CRM_RFQ_WRITES_ENABLED: undefined }).available).toBe(false);
  });
});
