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
  it('looks up only the roster-pinned member and verifies email, without an Analyst bypass', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { workspaceMembers: [member] }, pageInfo: { hasNextPage: false } }));
    const crm = new CrmRfqClient(env, fetcher);
    expect(await crm.creator(actor, signal())).toEqual({ id: member.id, name: 'Synthetic Employee' });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/rest/workspaceMembers');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('filter')).toBe(`id[eq]:"${member.id}",deletedAt[is]:NULL`);
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
    await expect(crm.creator({ ...actor, twentyUserId: id, isAnalyst: true }, signal())).rejects.toMatchObject({ code: 'CRM_IDENTITY_UNAVAILABLE' });
  });
  it.each(['duplicate', 'deleted', 'incomplete', 'wrong-email', 'wrong-id', 'missing', 'nameless'])('refuses %s membership results', async mode => {
    const members = mode === 'missing' ? [] : mode === 'duplicate' ? [member, { ...member, id }] : [{ ...member, ...(mode === 'deleted' ? { deletedAt: '2026-01-01T00:00:00Z' } : {}), ...(mode === 'wrong-email' ? { userEmail: 'someone-else@wareongo.com' } : {}), ...(mode === 'wrong-id' ? { id } : {}), ...(mode === 'nameless' ? { name: { firstName: ' ', lastName: '' } } : {}) }];
    const crm = new CrmRfqClient(env, async () => Response.json({ data: { workspaceMembers: members }, pageInfo: { hasNextPage: mode === 'incomplete' } }));
    await expect(crm.creator(actor, signal())).rejects.toMatchObject({ code: 'CRM_IDENTITY_UNAVAILABLE' });
  });
  it('normalizes UUID casing before the targeted lookup and attribution', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { workspaceMembers: [{ ...member, id: member.id.toUpperCase(), userEmail: member.userEmail.toUpperCase() }] }, pageInfo: { hasNextPage: false } }));
    expect(await new CrmRfqClient(env, fetcher).creator({ ...actor, twentyUserId: member.id.toUpperCase() }, signal())).toEqual({ id: member.id, name: 'Synthetic Employee' });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('filter')).toBe(`id[eq]:"${member.id}",deletedAt[is]:NULL`);
  });
  it('rejects invalid linked IDs before making a CRM request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CrmRfqClient(env, fetcher).creator({ ...actor, twentyUserId: 'bad-id' }, signal())).rejects.toMatchObject({ code: 'CRM_IDENTITY_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['wrong-member', 'wrong-owner', 'missing-fields', 'wrong-status', 'invalid-utf8', 'redirected'])('never reports creation for a %s response', async mode => {
    const data = created();
    const record = data.data.createOpportunity as Record<string, unknown>;
    if (mode === 'wrong-member') record.createdBy = { source: 'MANUAL', workspaceMemberId: id, name: 'Synthetic Employee' };
    if (mode === 'wrong-owner') record.ownerId = id;
    if (mode === 'missing-fields') delete record.description;
    const response = mode === 'invalid-utf8'
      ? new Response(new Uint8Array([0xff, 0xfe]), { status: 201 })
      : Response.json(data, { status: mode === 'wrong-status' ? 200 : 201 });
    if (mode === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
    const fetcher = vi.fn<typeof fetch>(async () => response);
    expect(await new CrmRfqClient(env, fetcher).create(payload, signal())).toEqual({ outcome: 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['http://crm.example.test', 'https://key@crm.example.test', 'https://crm.example.test/evil', 'https://crm.example.test?key=x'])('refuses unsafe configured origin %s', url => {
    expect(crmWriteAvailability({ ...env, TWENTY_CRM_BASE_URL: url }).available).toBe(false);
  });
  it('does not reuse the CRM read key or enable itself implicitly', () => {
    expect(crmWriteAvailability({ ...env, CONTEXT_CRM_WRITE_API_KEY: '', TWENTY_CRM_API_KEY: 'read-key' }).available).toBe(false);
    expect(crmWriteAvailability({ ...env, CONTEXT_CRM_RFQ_WRITES_ENABLED: undefined }).available).toBe(false);
  });
});
