import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { getRelatedCrmContext, RELATED_CRM_QUERIES, RELATED_CRM_RECORD_QUERIES, type RelatedCrmSection } from '../src/lib/crm-related';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const leadId = id(1);
const principal: Principal = { employeeId: 7, email: 'alex@example.test', keyId: 'synthetic', scopes: ['crm:read'], twentyUserId: id(2) };
const access: CrmAccess = { mode: 'related', memberId: id(2), ids: [leadId] };
const env = { TWENTY_CRM_BASE_URL: 'https://crm.example.test', TWENTY_CRM_API_KEY: 'synthetic-test-key' };
const dates = { createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-26T08:00:00Z', deletedAt: null };
function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage, endCursor } };
}
function target(section: 'notes' | 'tasks', number = 10) {
  return { id: id(number), deletedAt: null, [section === 'notes' ? 'noteId' : 'taskId']: id(number + 100),
    targetOpportunityId: leadId, targetCompanyId: null, targetPersonId: null };
}
function candidate(section: 'notes' | 'tasks', number = 10) {
  const relation = target(section, number);
  const object = { id: id(number + 100), ...dates, title: 'Discuss warehouse shortlist',
    bodyV2: { markdown: 'Needs 40,000 sqft. Call 9876543210 or alex@example.test.', blocknote: null },
    ...(section === 'tasks' ? { status: 'IN_PROGRESS', dueAt: '2026-09-27T06:00:00Z', assigneeId: id(2),
      assignee: { id: id(2), deletedAt: null, name: { firstName: 'Alex', lastName: 'Demo' }, userEmail: 'private@example.test' } } : {}),
    [section === 'notes' ? 'noteTargets' : 'taskTargets']: page([relation]),
  };
  return { ...relation, [section === 'notes' ? 'note' : 'task']: object };
}
function initialPayload(section: RelatedCrmSection, lead: Record<string, unknown>) {
  const first = structuredClone(lead);
  if (section === 'company') return { data: { opportunity: first } };
  const targetsKey = section === 'notes' ? 'noteTargets' : 'taskTargets';
  const targets = first[targetsKey] as ReturnType<typeof page>;
  delete first[targetsKey];
  for (const edge of targets.edges) { delete (edge.node as Record<string, unknown>).note; delete (edge.node as Record<string, unknown>).task; }
  return { data: { opportunity: first, [targetsKey]: targets } };
}
function harness(section: RelatedCrmSection, changes: Record<string, unknown> = {}) {
  const lead: Record<string, unknown> = { id: leadId, deletedAt: null, updatedAt: '2026-09-26T07:00:00Z',
    ...(section === 'company' ? { companyId: null, company: null } : { [section === 'notes' ? 'noteTargets' : 'taskTargets']: page([candidate(section)]) }),
    ...changes };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query;
    if (section !== 'company' && query === RELATED_CRM_RECORD_QUERIES[section]) {
      const targets = lead[section === 'notes' ? 'noteTargets' : 'taskTargets'] as ReturnType<typeof page>;
      const objectKey = section === 'notes' ? 'note' : 'task';
      const objects = new Map<string, Record<string, unknown>>();
      for (const edge of targets.edges) {
        const object = (edge.node as Record<string, unknown>)[objectKey] as Record<string, unknown> | undefined;
        if (object) objects.set(String(object.id), object);
      }
      return Response.json({ data: { [section]: page([...objects.values()]) } });
    }
    // The first query has no body/title fields at all; tests must provide them
    // through the separate batch, matching Twenty's supported relation depth.
    return Response.json(initialPayload(section, lead));
  });
  return { lead, fetcher, options: { section, access, env, fetch: fetcher } };
}

describe('bounded live CRM related context', () => {
  it.each(['notes', 'tasks'] as const)('reads %s with two bounded batches and redacts only the allowed text projection', async section => {
    const { fetcher, options } = harness(section);
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://crm.example.test/graphql');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-test-key' } });
    expect(JSON.parse(String(init?.body))).toEqual({ query: RELATED_CRM_QUERIES[section], variables: { id: leadId, first: 10, after: null } });
    expect(RELATED_CRM_QUERIES[section]).not.toMatch(/mutation|userEmail|pocPhone|attachments|targetPerson\s*\{/);
    expect(RELATED_CRM_QUERIES[section]).not.toContain('bodyV2');
    expect(RELATED_CRM_QUERIES[section]).toContain('opportunity(filter: {id: {eq: $id}}) { id deletedAt updatedAt }');
    expect(RELATED_CRM_QUERIES[section]).toContain('filter: {targetOpportunityId: {eq: $id}}');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ query: RELATED_CRM_RECORD_QUERIES[section], variables: { ids: [id(110)], first: 1 } });
    expect(RELATED_CRM_RECORD_QUERIES[section]).not.toContain('opportunity(');
    expect(result).toMatchObject({ section, nextCursor: null, freshness_basis: 'live_twenty_read',
      source_opportunity_updated_at: '2026-09-26T07:00:00.000Z',
      coverage: { scanned: 1, returned: 1, withheld: 0, has_more: false, relationship_policy: 'single_lead_only' } });
    expect(result.items[0]).toMatchObject({ id: id(110), title: { text: 'Discuss warehouse shortlist', state: 'present' },
      body: { state: 'redacted', redacted: true }, source_updated_at: '2026-09-26T08:00:00.000Z' });
    expect(JSON.stringify(result)).toContain('40,000 sqft');
    expect(JSON.stringify(result)).not.toMatch(/9876543210|alex@example|private@example|synthetic-test-key/);
    if (section === 'tasks') expect(result.items[0]).toMatchObject({ status: 'IN_PROGRESS', due_at: '2026-09-27T06:00:00.000Z',
      assignee: { id: id(2), name: { text: 'Alex Demo' }, is_you: true }, assignee_status: 'available' });
  });

  it.each(['notes', 'tasks'] as const)('withholds shared %s even for an admin when any target points elsewhere', async section => {
    const item = candidate(section);
    const object = item[section === 'notes' ? 'note' : 'task'] as Record<string, unknown>;
    const targetsKey = section === 'notes' ? 'noteTargets' : 'taskTargets';
    for (const changes of [
      { targetOpportunityId: id(999) }, { targetCompanyId: id(999) }, { targetPersonId: id(999) },
      { targetOpportunityId: null }, { targetCompanyId: undefined }, { deletedAt: dates.updatedAt },
      { [section === 'notes' ? 'noteId' : 'taskId']: id(999) },
    ]) {
      object[targetsKey] = page([target(section), { ...target(section, 11), [section === 'notes' ? 'noteId' : 'taskId']: id(110), ...changes }]);
      const { options } = harness(section, { [targetsKey]: page([item]) });
      const result = await getRelatedCrmContext(principal, leadId, { ...options, access: { mode: 'all', memberId: id(2) } });
      expect(result.items).toEqual([]);
      expect(result.coverage).toMatchObject({ scanned: 1, returned: 0, withheld: 1 });
      expect(JSON.stringify(result)).not.toContain(id(999));
    }
  });

  it('withholds records whose relationship closure is truncated or missing the requested target', async () => {
    for (const closure of [page([target('notes')], true, 'more-targets'), page([]), page([{ ...target('notes'), id: id(12) }])]) {
      const item = candidate('notes');
      (item.note as Record<string, unknown>).noteTargets = closure;
      const { options } = harness('notes', { noteTargets: page([item]) });
      const result = await getRelatedCrmContext(principal, leadId, options);
      expect(result.items).toEqual([]);
      expect(result.coverage.withheld).toBe(1);
    }
  });

  it('keeps pagination moving across wholly withheld pages and binds cursors to lead and section', async () => {
    const item = candidate('notes');
    (item.note as Record<string, unknown>).deletedAt = dates.updatedAt;
    const first = harness('notes', { noteTargets: page([item], true, 'upstream-page-two') });
    const result = await getRelatedCrmContext(principal, leadId, first.options);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).not.toBeNull();
    expect(result.coverage.has_more).toBe(true);
    const next = harness('notes', { noteTargets: page([]) });
    await getRelatedCrmContext(principal, leadId, { ...next.options, limit: 5, cursor: result.nextCursor! });
    expect(JSON.parse(String(next.fetcher.mock.calls[0][1]?.body)).variables).toEqual({ id: leadId, first: 5, after: 'upstream-page-two' });
    const denied = harness('tasks');
    await expect(getRelatedCrmContext(principal, leadId, { ...denied.options, cursor: result.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await expect(getRelatedCrmContext(principal, id(9), { ...first.options, cursor: result.nextCursor! })).rejects.toMatchObject({ status: 400 });
    expect(denied.fetcher).not.toHaveBeenCalled();
  });

  it.each(['notes', 'tasks'] as const)('uses root %s pagination at limit one and ignores an unrequested nested collection', async section => {
    const targetsKey = section === 'notes' ? 'noteTargets' : 'taskTargets';
    const first = harness(section, { [targetsKey]: page([candidate(section)], true, 'next-root-target') });
    const firstPayload = initialPayload(section, first.lead);
    // Simulate Twenty including an unpaginated nested relation. Only the
    // explicitly scoped root collection may determine this page or cursor.
    firstPayload.data.opportunity[targetsKey] = page([candidate(section), candidate(section, 11)]);
    first.fetcher.mockResolvedValueOnce(Response.json(firstPayload));
    const result = await getRelatedCrmContext(principal, leadId, { ...first.options, limit: 1 });
    expect(result.items.map(item => item.id)).toEqual([id(110)]);
    expect(result.coverage).toMatchObject({ scanned: 1, returned: 1, has_more: true });
    expect(result.nextCursor).not.toBeNull();
    const second = harness(section, { [targetsKey]: page([candidate(section, 11)]) });
    const continuation = await getRelatedCrmContext(principal, leadId, { ...second.options, limit: 1, cursor: result.nextCursor! });
    expect(continuation.items.map(item => item.id)).toEqual([id(111)]);
    expect(continuation.nextCursor).toBeNull();
    expect(JSON.parse(String(second.fetcher.mock.calls[0][1]?.body)).variables).toMatchObject({ first: 1, after: 'next-root-target' });
  });

  it('withholds an oversized nested target closure even when Twenty incorrectly reports no next page', async () => {
    const item = candidate('notes');
    (item.note as Record<string, unknown>).noteTargets = page(Array.from({ length: 51 }, (_, index) => ({ ...target('notes'), id: id(10 + index) })));
    const { options } = harness('notes', { noteTargets: page([item]) });
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(result.items).toEqual([]);
    expect(result.coverage).toMatchObject({ scanned: 1, withheld: 1, returned: 0 });
  });

  it('deduplicates records when two complete same-lead targets point to one note', async () => {
    const first = candidate('notes');
    const second = { ...first, id: id(11) };
    (first.note as Record<string, unknown>).noteTargets = page([target('notes'), { ...target('notes'), id: id(11) }]);
    const { options } = harness('notes', { noteTargets: page([first, second]) });
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(result.items).toHaveLength(1);
    expect(result.coverage).toMatchObject({ scanned: 2, returned: 1, withheld: 0 });
  });

  it('fetches a full ten-record page in two requests without one request per record', async () => {
    const { options, fetcher } = harness('notes', { noteTargets: page(Array.from({ length: 10 }, (_, index) => candidate('notes', 10 + index))) });
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(result.items).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).variables).toEqual({ ids: Array.from({ length: 10 }, (_, index) => id(110 + index)), first: 10 });
  });

  it('rejects injected, duplicate or incomplete batch results instead of interpreting them as scoped content', async () => {
    const first = candidate('notes'); const second = candidate('notes', 11);
    for (const batch of [
      page([{ ...first.note as object, id: id(999) }]),
      page([first.note, first.note]),
      page([first.note], true, 'unexpected-batch-continuation'),
    ]) {
      const { options, fetcher } = harness('notes', { noteTargets: page([first, second]) });
      fetcher.mockImplementationOnce(fetcher.getMockImplementation()!).mockResolvedValueOnce(Response.json({ data: { notes: batch } }));
      await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503, code: 'CRM_CONTEXT_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('reports records disappearing between target discovery and batch fetch as withheld', async () => {
    const { options, fetcher } = harness('notes');
    fetcher.mockImplementationOnce(fetcher.getMockImplementation()!).mockResolvedValueOnce(Response.json({ data: { notes: page([]) } }));
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(result.items).toEqual([]);
    expect(result.coverage).toMatchObject({ scanned: 1, returned: 0, withheld: 1 });
  });

  it('does not request records when no candidate target is eligible for this lead', async () => {
    for (const targets of [[], [{ ...target('notes'), targetPersonId: id(999) }]]) {
      const { options, fetcher } = harness('notes', { noteTargets: page(targets) });
      const result = await getRelatedCrmContext(principal, leadId, options);
      expect(result.items).toEqual([]);
      expect(result.coverage.withheld).toBe(targets.length);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('uses validated BlockNote text only when Markdown is missing and never echoes an unknown text object', async () => {
    const item = candidate('notes');
    const object = item.note as Record<string, unknown>;
    const blocknote = JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Verify loading access. Email private@example.test.' }], children: [] }]);
    for (const [markdown, state] of [[null, 'redacted'], [{ text: 'untrusted shape' }, 'unsupported']] as const) {
      object.bodyV2 = { markdown, blocknote };
      const { options } = harness('notes', { noteTargets: page([item]) });
      const result = await getRelatedCrmContext(principal, leadId, options);
      expect(result.items[0]).toMatchObject({ body: { state } });
      expect(JSON.stringify(result)).not.toContain('private@example');
    }
  });

  it('distinguishes unassigned tasks from unresolved assignment metadata', async () => {
    for (const [assignment, status] of [
      [{ assigneeId: null, assignee: null }, 'unassigned'],
      [{ assigneeId: id(2), assignee: null }, 'unavailable'],
      [{ assigneeId: id(2), assignee: { id: id(9), deletedAt: null, name: { firstName: 'Wrong member' } } }, 'unavailable'],
    ] as const) {
      const item = candidate('tasks'); Object.assign(item.task as object, assignment);
      const { options } = harness('tasks', { taskTargets: page([item]) });
      const result = await getRelatedCrmContext(principal, leadId, options);
      expect(result.items[0]).toMatchObject({ assignee: null, assignee_status: status });
    }
  });

  it('returns only allowlisted linked company fields without traversing people or other opportunities', async () => {
    const { options, fetcher } = harness('company', { companyId: id(20), company: { id: id(20), ...dates, name: 'Example Logistics',
      employees: 120, idealCustomerProfile: true, address: { addressCity: 'Bengaluru', addressState: 'Karnataka', addressCountry: 'India', addressStreet1: 'Private street 9876543210' },
      domainName: { primaryLinkUrl: 'https://private.example.test' }, people: [{ email: 'private@example.test' }], opportunities: [{ id: id(999) }],
    } });
    const result = await getRelatedCrmContext(principal, leadId, options);
    expect(result.items).toEqual([{ id: id(20), name: { text: 'Example Logistics', state: 'present', redacted: false, truncated: false },
      employees: 120, ideal_customer_profile: true, city: 'Bengaluru', state: 'Karnataka', country: 'India',
      source_created_at: '2026-09-20T00:00:00.000Z', source_updated_at: '2026-09-26T08:00:00.000Z' }]);
    expect(result.coverage).toMatchObject({ relationship_policy: 'linked_company_only', link_status: 'available' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).variables).toEqual({ id: leadId });
    expect(JSON.stringify(result)).not.toMatch(/private|9876543210|addressStreet|people/);
    expect(JSON.stringify(result)).not.toContain(id(999));
  });

  it('does not confuse a missing company link with a deleted or mismatched linked company', async () => {
    const missing = await getRelatedCrmContext(principal, leadId, harness('company').options);
    expect(missing.coverage).toMatchObject({ scanned: 0, withheld: 0, link_status: 'not_linked' });
    for (const company of [null, { id: id(21), ...dates }, { id: id(20), ...dates, deletedAt: dates.updatedAt }]) {
      const result = await getRelatedCrmContext(principal, leadId, harness('company', { companyId: id(20), company }).options);
      expect(result.items).toEqual([]);
      expect(result.coverage).toMatchObject({ scanned: 1, withheld: 1, link_status: 'unavailable' });
    }
  });

  it('checks CRM scope and verified lead identity before making a network request', async () => {
    const { options, fetcher } = harness('notes');
    await expect(getRelatedCrmContext({ ...principal, scopes: [] }, leadId, options)).rejects.toMatchObject({ status: 403 });
    await expect(getRelatedCrmContext(principal, leadId, { ...options, access: { ...access, ids: [] } })).rejects.toMatchObject({ status: 404 });
    await expect(getRelatedCrmContext(principal, leadId, { ...options, access: { ...access, memberId: id(99) } })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, 11, 1.5, NaN])('rejects invalid page limit %s before HTTP', async limit => {
    const { options, fetcher } = harness('notes');
    await expect(getRelatedCrmContext(principal, leadId, { ...options, limit })).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['http://crm.example.test', 'https://crm.example.test/api', 'https://user:secret@crm.example.test', 'https://crm.example.test?token=secret'])('rejects unsafe source configuration %s', async origin => {
    const { options, fetcher } = harness('notes');
    await expect(getRelatedCrmContext(principal, leadId, { ...options, env: { ...env, TWENTY_CRM_BASE_URL: origin } })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed for partial GraphQL data, a wrong lead, broken pagination and missing relationship pages', async () => {
    const correct = harness('notes').lead;
    const malformed = candidate('notes'); (malformed.note as Record<string, unknown>).noteTargets = { edges: [] };
    const payloads = [
      { ...initialPayload('notes', correct), errors: [{ message: 'secret source detail' }] },
      initialPayload('notes', { ...correct, id: id(999) }),
      initialPayload('notes', { ...correct, noteTargets: page([], true, null) }),
      initialPayload('notes', { ...correct, noteTargets: page([candidate('notes'), candidate('notes')]) }),
    ];
    for (const payload of payloads) {
      const { options, fetcher } = harness('notes'); fetcher.mockResolvedValueOnce(Response.json(payload));
      await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503, code: 'CRM_CONTEXT_UNAVAILABLE' });
    }
    const brokenClosure = harness('notes', { noteTargets: page([malformed]) });
    await expect(getRelatedCrmContext(principal, leadId, brokenClosure.options)).rejects.toMatchObject({ status: 503 });
  });

  it('does not interpret removed leads or upstream failures as an empty related-record collection', async () => {
    for (const opportunity of [null, { id: leadId, ...dates, deletedAt: dates.updatedAt }]) {
      const { options, fetcher } = harness('notes'); fetcher.mockResolvedValueOnce(Response.json({ data: { opportunity } }));
      await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 404 });
    }
    const { options, fetcher } = harness('notes'); fetcher.mockRejectedValueOnce(new Error('Secret internal host/password'));
    await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503, message: 'The requested CRM context could not be verified.' });
  });

  it('bounds response bytes and page size before interpreting source content', async () => {
    const { options, fetcher } = harness('notes');
    fetcher.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }));
    await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503 });
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503 });
    fetcher.mockResolvedValueOnce(Response.json(initialPayload('notes', { ...harness('notes').lead, noteTargets: page([candidate('notes'), candidate('notes', 11)]) })));
    await expect(getRelatedCrmContext(principal, leadId, { ...options, limit: 1 })).rejects.toMatchObject({ status: 503 });
  });

  it('aborts its bounded request and withholds late source results', async () => {
    vi.useFakeTimers();
    try {
      const { options, fetcher, lead } = harness('notes');
      fetcher.mockImplementationOnce(async (_url, init) => {
        vi.advanceTimersByTime(8_001);
        expect(init?.signal?.aborted).toBe(true);
        return Response.json({ data: { opportunity: lead } });
      });
      await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('shares one eight-second deadline across both batches instead of resetting it for record fetching', async () => {
    vi.useFakeTimers();
    try {
      const { options, fetcher } = harness('notes');
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) => {
        const batch = JSON.parse(String(init?.body)).query === RELATED_CRM_RECORD_QUERIES.notes;
        vi.advanceTimersByTime(batch ? 5000 : 4000);
        return original(url, init);
      });
      await expect(getRelatedCrmContext(principal, leadId, options)).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
