import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { getLiveCrmAccess } from '../src/lib/crm-live';

const MEMBER_ID = '00000000-0000-4000-8000-000000000100';
const OTHER_MEMBER_ID = '00000000-0000-4000-8000-000000000200';
const opportunityId = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const principal: Principal = {
  employeeId: 12, email: 'alex@example.test', scopes: ['crm:read'], keyId: 'test-key', twentyUserId: MEMBER_ID,
};
const env = { TWENTY_CRM_BASE_URL: 'https://crm.example.test', TWENTY_CRM_API_KEY: 'test-only-api-key' };
const member = () => ({ id: MEMBER_ID, userEmail: 'Alex@example.test', name: { firstName: 'Alex', lastName: 'Example' }, deletedAt: null });
const opportunity = (index: number) => ({ id: opportunityId(index), assignedTo: ['ALEX'], deletedAt: null });
const memberRole = () => ({
  id: '22222222-2222-4222-8222-222222222222', universalIdentifier: '33333333-3333-4333-8333-333333333333',
  label: 'Member', isEditable: true, canBeAssignedToUsers: true, canUpdateAllSettings: false,
  canReadAllObjectRecords: true, workspaceMembers: [{ id: MEMBER_ID }],
});
const adminRole = () => ({ ...memberRole(), universalIdentifier: '20202020-02c2-43f2-b94d-cab1f2b532eb',
  label: 'Admin', isEditable: false, canUpdateAllSettings: true });
const rolesResponse = (roles: unknown[] = [memberRole()]) => Response.json({ data: { getRoles: roles } });

function response(object: string, rows: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return Response.json({ data: { [object]: rows }, pageInfo: { hasNextPage, endCursor } });
}

function responses(...pages: Response[]) {
  return responsesWithRoles(rolesResponse(), ...pages);
}

function responsesWithRoles(roles: Response, ...pages: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  pages.forEach((page, index) => {
    fetcher.mockResolvedValueOnce(page);
    if (index === 0) fetcher.mockResolvedValueOnce(roles);
  });
  return { fetcher, options: { fetch: fetcher, env } };
}

afterEach(() => vi.useRealTimers());

describe('live CRM authorization', () => {
  it('returns only verified IDs using fixed read requests and no cache or redirects', async () => {
    const { fetcher, options } = responses(
      response('workspaceMembers', [member()]),
      response('opportunities', [{ ...opportunity(1), pocPhoneNumber: '9876543210', name: 'Private deal' }]),
    );
    const result = await getLiveCrmAccess(principal, options);
    expect(result).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1)] });
    expect(JSON.stringify(result)).not.toMatch(/9876543210|Private|test-only-api-key/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect((url as URL).origin).toBe('https://crm.example.test');
      if (init?.method === 'GET') {
        expect((url as URL).searchParams.get('depth')).toBe('0');
        expect((url as URL).searchParams.get('limit')).toBe('200');
      } else {
        expect((url as URL).pathname).toBe('/metadata');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.query.trim()).toMatch(/^query ContextReadRoles/);
        expect(body.query).not.toMatch(/\bmutation\b/);
      }
      expect((url as URL).href).not.toContain('test-only-api-key');
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-api-key' });
    }
    expect((fetcher.mock.calls[2][0] as URL).searchParams.get('filter')).toBe(`or(createdBy.workspaceMemberId[eq]:"${MEMBER_ID}",assignedTo[containsAny]:["ALEX"]),deletedAt[is]:NULL`);
  });

  it('includes created OR assigned deals, including created deals reassigned to others, and excludes owner-only/deleted records', async () => {
    const { options } = responses(
      response('workspaceMembers', [member()]),
      response('opportunities', [
        opportunity(1),
        { ...opportunity(2), assignedTo: ['OTHER'], createdBy: { workspaceMemberId: MEMBER_ID } },
        { ...opportunity(3), assignedTo: [], ownerId: MEMBER_ID, createdBy: { workspaceMemberId: OTHER_MEMBER_ID } },
        { ...opportunity(4), deletedAt: '2026-09-25T00:00:00Z' },
        { ...opportunity(5), assignedTo: null, createdBy: { workspaceMemberId: MEMBER_ID } },
        { ...opportunity(6), assignedTo: ['ALEX', 7] },
        { ...opportunity(7), assignedTo: ['alex'] },
      ]),
    );
    expect(await getLiveCrmAccess(principal, options)).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1), opportunityId(2), opportunityId(5)] });
  });

  it('fully paginates before returning identifiers', async () => {
    const { fetcher, options } = responses(
      response('workspaceMembers', [member()]),
      response('opportunities', [opportunity(2)], true, 'opaque-cursor-1'),
      response('opportunities', [opportunity(1)]),
    );
    expect(await getLiveCrmAccess(principal, options)).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1), opportunityId(2)] });
    expect((fetcher.mock.calls[3][0] as URL).searchParams.get('starting_after')).toBe('opaque-cursor-1');
  });

  describe('exact opportunity authorization', () => {
    it.each([
      { view: 'accessible' as const, row: opportunity(1001), filter: `or(createdBy.workspaceMemberId[eq]:"${MEMBER_ID}",assignedTo[containsAny]:["ALEX"])` },
      { view: 'created' as const, row: { ...opportunity(1001), assignedTo: ['OTHER'], createdBy: { workspaceMemberId: MEMBER_ID } }, filter: `createdBy.workspaceMemberId[eq]:"${MEMBER_ID}"` },
      { view: 'assigned' as const, row: opportunity(1001), filter: 'assignedTo[containsAny]:["ALEX"]' },
    ])('checks only the requested ID while retaining $view constraints', async ({ view, row, filter }) => {
      const { fetcher, options } = responses(response('workspaceMembers', [member()]), response('opportunities', [row]));
      const result = await getLiveCrmAccess(principal, { ...options, view, opportunityId: opportunityId(1001) });
      expect(result).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1001)] });
      expect(fetcher).toHaveBeenCalledTimes(3);
      const target = fetcher.mock.calls[2][0] as URL;
      expect(target.pathname).toBe('/rest/opportunities');
      expect(target.searchParams.get('filter')).toBe(`id[eq]:"${opportunityId(1001)}",${filter},deletedAt[is]:NULL`);
      expect(target.searchParams.get('limit')).toBe('1');
      expect(target.searchParams.get('depth')).toBe('0');
      expect(target.searchParams.has('starting_after')).toBe(false);
    });

    it('normalizes valid UUID casing for lookup and returned IDs', async () => {
      const id = 'abcdef12-abcd-4abc-8abc-abcdef123456';
      const { fetcher, options } = responses(response('workspaceMembers', [member()]),
        response('opportunities', [{ ...opportunity(1), id: id.toUpperCase() }]));
      expect(await getLiveCrmAccess(principal, { ...options, opportunityId: id.toUpperCase() }))
        .toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [id] });
      expect((fetcher.mock.calls[2][0] as URL).searchParams.get('filter')).toContain(`id[eq]:"${id}"`);
    });

    it.each(['', 'not-a-uuid', ` ${opportunityId(1)}`, `${opportunityId(1)},deletedAt[is]:NULL`, null, 123])(
      'rejects invalid target %j before any HTTP request', async (id) => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(getLiveCrmAccess(principal, { fetch: fetcher, env: {}, opportunityId: id as string }))
          .rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it('returns no authorized IDs when the specific record is absent or not related', async () => {
      const { fetcher, options } = responses(response('workspaceMembers', [member()]), response('opportunities', []));
      expect(await getLiveCrmAccess(principal, { ...options, opportunityId: opportunityId(1) }))
        .toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [] });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it.each([
      { rows: [opportunity(2)] },
      { rows: [{ ...opportunity(1), id: 'invalid' }] },
      { rows: [opportunity(1), opportunity(1)] },
      { rows: [opportunity(1)], more: true },
      { rows: [{ ...opportunity(1), deletedAt: '2026-09-25T00:00:00Z' }] },
      { rows: [{ ...opportunity(1), deletedAt: undefined }] },
      { rows: [{ ...opportunity(1), assignedTo: ['OTHER'], ownerId: MEMBER_ID }] },
      { rows: [{ ...opportunity(1), assignedTo: ['ALEX', 7] }] },
      { rows: [{ ...opportunity(1), assignedTo: null, createdBy: { workspaceMemberId: OTHER_MEMBER_ID } }] },
    ])('fails closed on a malformed, misfiltered, or incomplete exact result (%#)', async ({ rows, more }) => {
      const { fetcher, options } = responses(response('workspaceMembers', [member()]),
        response('opportunities', rows, more ?? false, more ? 'unexpected-more' : null));
      await expect(getLiveCrmAccess(principal, { ...options, opportunityId: opportunityId(1) }))
        .rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('does not let created ownership satisfy an assigned-only exact read', async () => {
      const { options } = responses(response('workspaceMembers', [member()]), response('opportunities', [
        { ...opportunity(1), assignedTo: ['OTHER'], createdBy: { workspaceMemberId: MEMBER_ID } },
      ]));
      await expect(getLiveCrmAccess(principal, { ...options, view: 'assigned', opportunityId: opportunityId(1) }))
        .rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
    });

    it('still permits an exact creator-only read with ambiguous assignment names', async () => {
      const { options } = responses(response('workspaceMembers', [member(), {
        ...member(), id: OTHER_MEMBER_ID, userEmail: 'other@example.test',
      }]), response('opportunities', [{ ...opportunity(1), assignedTo: null, createdBy: { workspaceMemberId: MEMBER_ID } }]));
      expect(await getLiveCrmAccess(principal, { ...options, view: 'created', opportunityId: opportunityId(1) }))
        .toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1)] });
    });

    it('checks live roles on exact reads and loses administrator access immediately after revocation', async () => {
      const before = responsesWithRoles(rolesResponse([adminRole()]), response('workspaceMembers', [member()]));
      const after = responsesWithRoles(rolesResponse([memberRole()]), response('workspaceMembers', [member()]), response('opportunities', []));
      expect(await getLiveCrmAccess(principal, { ...before.options, opportunityId: opportunityId(1) }))
        .toEqual({ mode: 'all', memberId: MEMBER_ID });
      expect(before.fetcher).toHaveBeenCalledTimes(2);
      expect((before.fetcher.mock.calls[1][0] as URL).pathname).toBe('/metadata');
      expect(await getLiveCrmAccess(principal, { ...after.options, opportunityId: opportunityId(1) }))
        .toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [] });
      expect(after.fetcher).toHaveBeenCalledTimes(3);
    });

    it('requires the current unique employee identity before checking an exact ID', async () => {
      const { fetcher, options } = responses(response('workspaceMembers', [{ ...member(), userEmail: 'someone-else@example.test' }]));
      await expect(getLiveCrmAccess(principal, { ...options, opportunityId: opportunityId(1) }))
        .rejects.toMatchObject({ status: 403, code: 'CRM_IDENTITY_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it('grants all-record access only for current membership in the verified built-in Twenty Admin role', async () => {
    const { fetcher, options } = responsesWithRoles(rolesResponse([adminRole()]), response('workspaceMembers', [member()]));
    expect(await getLiveCrmAccess(principal, options)).toEqual({ mode: 'all', memberId: MEMBER_ID });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([url]) => (url as URL).pathname === '/rest/opportunities')).toBe(false);
  });

  it.each([
    memberRole(),
    { ...adminRole(), universalIdentifier: memberRole().universalIdentifier },
    { ...adminRole(), isEditable: true },
    { ...adminRole(), canUpdateAllSettings: false },
    { ...adminRole(), canReadAllObjectRecords: false },
    { ...adminRole(), canBeAssignedToUsers: false },
    { ...adminRole(), workspaceMembers: [{ id: OTHER_MEMBER_ID }] },
  ])('does not promote a member, spoofed Admin label, incomplete administrator role, or another member (%#)', async (role) => {
    const { options } = responsesWithRoles(rolesResponse([role]),
      response('workspaceMembers', [member()]), response('opportunities', []));
    expect(await getLiveCrmAccess(principal, options)).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [] });
  });

  it('checks role membership afresh so revoked administrators stop receiving all-record access', async () => {
    const before = responsesWithRoles(rolesResponse([adminRole()]), response('workspaceMembers', [member()]));
    const after = responsesWithRoles(rolesResponse([{ ...adminRole(), workspaceMembers: [] }, memberRole()]),
      response('workspaceMembers', [member()]), response('opportunities', [opportunity(1)]));
    expect((await getLiveCrmAccess(principal, before.options)).mode).toBe('all');
    expect(await getLiveCrmAccess(principal, after.options)).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1)] });
  });

  it('keeps an administrator assigned-only view narrower than their default access', async () => {
    const { fetcher, options } = responsesWithRoles(rolesResponse([adminRole()]),
      response('workspaceMembers', [member()]), response('opportunities', [
        opportunity(1), { ...opportunity(2), assignedTo: ['OTHER'], createdBy: { workspaceMemberId: MEMBER_ID } },
      ]));
    expect(await getLiveCrmAccess(principal, { ...options, view: 'assigned' })).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1)] });
    expect((fetcher.mock.calls[2][0] as URL).searchParams.get('filter')).toBe('assignedTo[containsAny]:["ALEX"],deletedAt[is]:NULL');
  });

  it('created-only access uses workspace-member identity and works even when first-name assignment tokens are ambiguous', async () => {
    const { fetcher, options } = responses(
      response('workspaceMembers', [
        { ...member(), userId: OTHER_MEMBER_ID },
        { ...member(), id: OTHER_MEMBER_ID, userEmail: 'another-alex@example.test' },
      ]),
      response('opportunities', [
        { ...opportunity(1), assignedTo: ['OTHER'], createdBy: { workspaceMemberId: MEMBER_ID } },
        { ...opportunity(2), createdBy: { workspaceMemberId: OTHER_MEMBER_ID } },
        { ...opportunity(3), ownerId: MEMBER_ID },
      ]),
    );
    expect(await getLiveCrmAccess(principal, { ...options, view: 'created' })).toEqual({ mode: 'related', memberId: MEMBER_ID, ids: [opportunityId(1)] });
    expect((fetcher.mock.calls[2][0] as URL).searchParams.get('filter')).toBe(`createdBy.workspaceMemberId[eq]:"${MEMBER_ID}",deletedAt[is]:NULL`);
  });

  it.each([
    { errors: [{ message: 'Private upstream permission error' }], data: { getRoles: [adminRole()] } },
    { data: {} },
    { data: { getRoles: [{ ...adminRole(), workspaceMembers: null }] } },
    { data: { getRoles: [adminRole(), adminRole()] } },
  ])('fails closed when role metadata is partial, malformed, unavailable, or ambiguous (%#)', async (roleBody) => {
    const { fetcher, options } = responsesWithRoles(Response.json(roleBody), response('workspaceMembers', [member()]));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [],
    [{ ...member(), userEmail: 'other@example.test' }],
    [{ ...member(), id: OTHER_MEMBER_ID }],
    [{ ...member(), deletedAt: '2026-09-25T00:00:00Z' }],
    [{ ...member(), name: { firstName: 'Alex Name' } }],
    [member(), { ...member(), id: OTHER_MEMBER_ID, userEmail: 'other@example.test' }],
    [member(), { ...member(), id: OTHER_MEMBER_ID, name: { firstName: 'Other' } }],
    [member(), { ...member(), name: { firstName: 'Other' }, userEmail: 'other@example.test' }],
  ].map((members) => [members] as const))('denies missing, mismatched, and ambiguous identity mappings (%#)', async (members) => {
    const { fetcher, options } = responses(response('workspaceMembers', members));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 403, code: 'CRM_IDENTITY_UNAVAILABLE' });
    expect(fetcher.mock.calls.every(([url]) => (url as URL).pathname !== '/rest/opportunities')).toBe(true);
  });

  it('rejects an incomplete member directory even when the employee is in its first page', async () => {
    const { fetcher, options } = responses(response('workspaceMembers', [member()], true, 'more-members'));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows exactly 1000 opportunities when the fifth page is complete', async () => {
    const pages = Array.from({ length: 5 }, (_, page) => response('opportunities',
      Array.from({ length: 200 }, (_, row) => opportunity(page * 200 + row + 1)), page < 4, `cursor-${page}`));
    const { fetcher, options } = responses(response('workspaceMembers', [member()]), ...pages);
    const result = await getLiveCrmAccess(principal, options);
    expect(result.mode).toBe('related');
    if (result.mode !== 'related') throw new Error('Expected related access');
    expect(result.ids).toHaveLength(1000);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('rejects overflow instead of returning a partial authorized set', async () => {
    const pages = Array.from({ length: 5 }, (_, page) => response('opportunities', [opportunity(page + 1)], true, `cursor-${page}`));
    const { fetcher, options } = responses(response('workspaceMembers', [member()]), ...pages);
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('rejects repeated cursors and duplicate records across pages', async () => {
    for (const duplicateRecord of [true, false]) {
      const { options } = responses(
        response('workspaceMembers', [member()]),
        response('opportunities', [opportunity(1)], true, 'cursor'),
        response('opportunities', [opportunity(duplicateRecord ? 1 : 2)], true, 'cursor'),
      );
      await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503 });
    }
  });

  it.each([
    { data: { opportunities: [] } },
    { data: { opportunities: [] }, pageInfo: { hasNextPage: true, endCursor: 'more' } },
    { data: { opportunities: [opportunity(1)] }, pageInfo: { hasNextPage: true } },
    { data: { opportunities: [{ ...opportunity(1), id: 'not-a-uuid' }] }, pageInfo: { hasNextPage: false } },
    { data: { opportunities: Array.from({ length: 201 }, (_, index) => opportunity(index)) }, pageInfo: { hasNextPage: false } },
  ])('rejects malformed or oversized result sets (%#)', async (body) => {
    const { options } = responses(response('workspaceMembers', [member()]), Response.json(body));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503 });
  });

  it.each([301, 401, 429, 500])('does not expose upstream error payloads for HTTP %s', async (status) => {
    const { options } = responses(new Response('Upstream credential and contact data', { status }));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({
      status: 503, message: 'Current CRM assignment access could not be verified.',
    });
  });

  it('enforces response byte limits even without a Content-Length header', async () => {
    const chunk = new Uint8Array(1_100_000).fill(65);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); },
    });
    const { options } = responses(new Response(body));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503 });
  });

  it('rejects oversized Content-Length before reading the body', async () => {
    const { options } = responses(new Response('{}', { headers: { 'Content-Length': '3000000' } }));
    await expect(getLiveCrmAccess(principal, options)).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    {},
    { ...env, TWENTY_CRM_BASE_URL: 'http://crm.example.test' },
    { ...env, TWENTY_CRM_BASE_URL: 'https://user:pass@crm.example.test' },
    { ...env, TWENTY_CRM_BASE_URL: 'https://crm.example.test/rest' },
    { ...env, TWENTY_CRM_BASE_URL: 'https://crm.example.test/?target=other' },
    { ...env, TWENTY_CRM_API_KEY: 'bad\nkey' },
  ])('rejects unsafe or missing source configuration before sending credentials (%#)', async (configuration) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(getLiveCrmAccess(principal, { fetch: fetcher, env: configuration })).rejects.toMatchObject({ status: 503, code: 'CRM_CONFIGURATION' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts an upstream request at the total eight-second deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const result = expect(getLiveCrmAccess(principal, { fetch: fetcher, env })).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(8001);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
