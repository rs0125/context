import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { CrmRfqClient, crmWriteAvailability } from '../src/lib/crm-writes/client';
import { rfqPayload } from '../src/lib/crm-writes/rfq';
import type { RfqLiveRecord } from '../src/lib/crm-writes/changes';

const env = { CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true', TWENTY_CRM_BASE_URL: 'https://crm.example.test', CONTEXT_CRM_WRITE_API_KEY: 'synthetic-write-key' };
const member = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userEmail: 'employee@wareongo.com', deletedAt: null, name: { firstName: 'Synthetic', lastName: 'Employee' } };
const actor: Principal = { employeeId: 7, email: member.userEmail, twentyUserId: member.id, scopes: ['crm.rfq:write'], keyId: 'test', isAnalyst: false };
const payload = rfqPayload({ operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', raw_text: '5000 sqft in Chennai', location: 'Chennai', requirement: '5000 sqft' }, { id: member.id, name: 'Synthetic Employee' });
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const signal = () => new AbortController().signal;
const created = () => ({ data: { createOpportunity: { id, deletedAt: null, ...payload } } });
const current: RfqLiveRecord = { id, updatedAt: '2026-10-04T10:00:00.000Z', deletedAt: null,
  name: 'TBD - 5000 sqft - Chennai', stage: 'RFQ_RECEIVED', ownerId: member.id,
  createdBy: { workspaceMemberId: member.id }, budget: '20 rs/sqft per month' };
const updated = { ...current, updatedAt: '2026-10-04T10:01:00.000Z', budget: '22 rs/sqft per month' };
describe('fixed-purpose CRM HTTP adapter', () => {
  it.each(['界', '\u0001'])('verifies create, read and edit responses containing a full 32K %j description', async character => {
    const description = 'Full source.\n'.padEnd(32_000, character);
    const fullPayload = { ...payload, description };
    const record = { ...current, ...fullPayload };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ data: { createOpportunity: record } }, { status: 201 });
      if (init?.method === 'PATCH') return Response.json({ data: { updateOpportunities: [{ ...record, updatedAt: updated.updatedAt, budget: updated.budget }] } });
      return Response.json({ data: { opportunity: record } });
    });
    const crm = new CrmRfqClient(env, fetcher);
    expect(await crm.create(fullPayload, signal())).toMatchObject({ outcome: 'created', id });
    expect((await crm.read(id, signal())).description).toBe(description);
    expect(await crm.update(record, { budget: updated.budget }, signal())).toMatchObject({ outcome: 'updated', record: { description } });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).description).toBe(description);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(['declared', 'streamed'])('retains uncertainty for a genuinely oversized %s CRM response', async mode => {
    const fullPayload = { ...payload, description: '界'.repeat(32_000) };
    const content = JSON.stringify({ data: { createOpportunity: { id, deletedAt: null, ...fullPayload, extra: 'x'.repeat(256 * 1024) } } });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(content, { status: 201,
      ...(mode === 'declared' ? { headers: { 'content-length': String(Buffer.byteLength(content)) } } : {}) }));
    expect(await new CrmRfqClient(env, fetcher).create(fullPayload, signal())).toEqual({ outcome: 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
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
  it('retains the verified creation version when Twenty provides it, for guarded undo', async () => {
    const record = { ...current, ...payload };
    const fetcher: typeof fetch = async () => Response.json({ data: { createOpportunity: record } }, { status: 201 });
    expect(await new CrmRfqClient(env, fetcher).create(payload, signal())).toEqual({ outcome: 'created', id, record });
  });
  it('reads a single live RFQ without caching and rejects substituted IDs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { opportunity: current } }));
    expect(await new CrmRfqClient(env, fetcher).read(id, signal())).toEqual(current);
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://crm.example.test/rest/opportunities/${id}?depth=0`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    await expect(new CrmRfqClient(env, fetcher).read(member.id, signal())).rejects.toMatchObject({ code: 'CRM_RFQ_UNAVAILABLE' });
    await expect(new CrmRfqClient(env, fetcher).read('../other', signal())).rejects.toMatchObject({ code: 'CRM_RFQ_ID_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['not-found', 'denied', 'outage', 'rate-limit', 'malformed', 'network'] as const)('distinguishes a %s read from a known missing record', async mode => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (mode === 'network') throw new Error('Synthetic transport failure');
      if (mode === 'malformed') return new Response('{broken');
      return new Response('', { status: mode === 'not-found' ? 404 : mode === 'denied' ? 403 : mode === 'rate-limit' ? 429 : 503 });
    });
    await expect(new CrmRfqClient(env, fetcher).read(id, signal())).rejects.toMatchObject(
      mode === 'not-found' ? { code: 'CRM_RFQ_NOT_FOUND', status: 404 } : { code: 'CRM_RFQ_UNAVAILABLE', status: 503 },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('sends a single conditional collection update with ID, version, ownership and stage predicates', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { updateOpportunities: [updated] } }));
    expect(await new CrmRfqClient(env, fetcher).update(current, { budget: updated.budget }, signal()))
      .toEqual({ outcome: 'updated', id, record: updated });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/rest/opportunities');
    expect(url.searchParams.get('filter')).toBe(`id[eq]:"${id}",updatedAt[eq]:"${current.updatedAt}",ownerId[eq]:"${member.id}",createdBy.workspaceMemberId[eq]:"${member.id}",stage[eq]:"RFQ_RECEIVED",deletedAt[is]:NULL`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PATCH', redirect: 'error', cache: 'no-store' });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ budget: updated.budget });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('reports an unmatched version without retrying or dropping the predicate', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { updateOpportunities: [] } }));
    expect(await new CrmRfqClient(env, fetcher).update(current, { budget: updated.budget }, signal()))
      .toEqual({ outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['id', 'owner', 'creator', 'stage', 'version', 'patch', 'deleted', 'many', 'bad-json'])('does not report successful edits for a %s mismatch', async mode => {
    const record = { ...updated, createdBy: { ...updated.createdBy } };
    if (mode === 'id') record.id = member.id;
    if (mode === 'owner') record.ownerId = id;
    if (mode === 'creator') record.createdBy.workspaceMemberId = id;
    if (mode === 'stage') record.stage = 'WON';
    if (mode === 'version') record.updatedAt = current.updatedAt;
    if (mode === 'patch') record.budget = '22 rs per month';
    if (mode === 'deleted') record.deletedAt = '2026-10-04T10:02:00.000Z';
    const fetcher = vi.fn<typeof fetch>(async () => mode === 'bad-json' ? new Response('broken')
      : Response.json({ data: { updateOpportunities: mode === 'many' ? [record, record] : [record] } }));
    expect(await new CrmRfqClient(env, fetcher).update(current, { budget: updated.budget }, signal())).toEqual({ outcome: 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects invalid versions, deleted records, and forbidden fields before mutation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const crm = new CrmRfqClient(env, fetcher);
    for (const record of [{ ...current, updatedAt: 'bad' }, { ...current, deletedAt: updated.updatedAt },
      { ...current, ownerId: null }, { ...current, createdBy: { workspaceMemberId: null } }]) {
      expect(await crm.update(record, { budget: '20' }, signal())).toEqual({ outcome: 'rejected', code: 'CRM_RFQ_CHANGE_INVALID' });
    }
    for (const patch of [{}, { stage: 'WON' }, { ownerId: id }, { deletedAt: updated.updatedAt }, { description: 'replacement' }]) {
      expect(await crm.update(current, patch, signal())).toEqual({ outcome: 'rejected', code: 'CRM_RFQ_CHANGE_INVALID' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('undoes creation only through explicitly soft-delete collection requests with the unchanged version', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { deleteOpportunities: [{ id }] } }));
    const crm = new CrmRfqClient(env, fetcher);
    expect(await crm.undoCreate(current, signal())).toEqual({ outcome: 'rolled_back', id });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/rest/opportunities');
    expect(url.searchParams.get('soft_delete')).toBe('true');
    expect(url.searchParams.get('filter')).toContain(`updatedAt[eq]:"${current.updatedAt}"`);
    expect(url.searchParams.get('filter')).toContain('stage[eq]:"RFQ_RECEIVED"');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'DELETE', redirect: 'error' });
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
    expect(await crm.undoCreate({ ...current, stage: 'WON' }, signal())).toEqual({ outcome: 'rejected', code: 'CRM_RFQ_CHANGE_INVALID' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['no-match', 'wrong-id', 'many', 'denied', 'network'])('handles %s soft-delete outcomes without a second request', async mode => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (mode === 'network') throw new Error('network');
      if (mode === 'denied') return new Response('', { status: 403 });
      return Response.json({ data: { deleteOpportunities: mode === 'no-match' ? [] : mode === 'many' ? [{ id }, { id }] : [{ id: member.id }] } });
    });
    const result = await new CrmRfqClient(env, fetcher).undoCreate(current, signal());
    expect(result).toEqual(mode === 'no-match' ? { outcome: 'rejected', code: 'CRM_RFQ_VERSION_CONFLICT' }
      : mode === 'denied' ? { outcome: 'rejected' } : { outcome: 'outcome_unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
