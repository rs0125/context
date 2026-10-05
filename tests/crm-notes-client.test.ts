import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import { CrmNoteClient, crmNotesAvailability, crmNotesDeleteAvailability, noteBodyPayload, verifiedPlainNote } from '../src/lib/crm-writes/notes-client';
import type { NoteLive } from '../src/lib/crm-writes/notes';

const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dealId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const version = '2026-10-05T08:00:00.000Z', nextVersion = '2026-10-05T08:01:00.000Z';
const content = { title: 'Site visit', body: '  Client visited today.\n\nNeeds two additional docks.  ' };
const changed = { title: 'Site visit update', body: 'Client needs three additional docks.' };
const creator = { id: memberId, name: 'Synthetic Employee' };
const env = { CONTEXT_CRM_NOTES_ENABLED: 'true', CONTEXT_CRM_DELETES_ENABLED: 'true', CONTEXT_CRM_RFQ_WRITES_ENABLED: 'false',
  TWENTY_CRM_BASE_URL: 'https://crm.example.test', CONTEXT_CRM_WRITE_API_KEY: 'synthetic-note-key' };
const actor: Principal = { employeeId: 7, email: 'employee@wareongo.com', keyId: 'synthetic',
  twentyUserId: memberId, scopes: ['crm:read', 'crm.notes:write'], isAnalyst: false };
const signal = () => new AbortController().signal;
function fixture() {
  const record: NoteLive = { id: noteId, updatedAt: version, targetUpdatedAt: version, deletedAt: null,
    title: content.title, bodyV2: noteBodyPayload(content.body), createdBy: { workspaceMemberId: memberId, source: 'MANUAL', name: creator.name } };
  const target = { id: targetId, noteId, targetOpportunityId: dealId, targetCompanyId: null,
    targetPersonId: null, deletedAt: null, updatedAt: version };
  let targets: Array<Record<string, unknown>> = [target];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === '/rest/workspaceMembers') return Response.json({ data: { workspaceMembers: [{ id: memberId,
      userEmail: actor.email, deletedAt: null, name: { firstName: 'Synthetic', lastName: 'Employee' } }] }, pageInfo: { hasNextPage: false } });
    if (url.pathname === `/rest/opportunities/${dealId}`) return Response.json({ data: { opportunity: { id: dealId, name: 'Test Logistics - Hoskote', updatedAt: version, deletedAt: null } } });
    if (init?.method === 'POST' && url.pathname === '/rest/notes') {
      Object.assign(record, body);
      return Response.json({ data: { createNote: record } }, { status: 201 });
    }
    if (init?.method === 'POST' && url.pathname === '/rest/noteTargets') {
      Object.assign(target, body); targets = [target];
      return Response.json({ data: { createNoteTarget: target } }, { status: 201 });
    }
    if (init?.method === 'GET' && url.pathname === `/rest/notes/${noteId}`) return Response.json({ data: { note: record } });
    if (init?.method === 'GET' && url.pathname === '/rest/notes') return Response.json({ data: { notes: record.deletedAt === null ? [record] : [] }, pageInfo: { hasNextPage: false } });
    if (init?.method === 'GET' && url.pathname === '/rest/noteTargets') return Response.json({ data: { noteTargets: targets }, pageInfo: { hasNextPage: false } });
    if (init?.method === 'PATCH' && url.pathname === '/rest/notes') {
      if (!url.searchParams.get('filter')?.includes(`updatedAt[eq]:"${record.updatedAt}"`)) return Response.json({ data: { updateNotes: [] } });
      Object.assign(record, body, { updatedAt: nextVersion });
      return Response.json({ data: { updateNotes: [record] } });
    }
    if (init?.method === 'DELETE' && url.pathname === '/rest/noteTargets') {
      targets = targets.filter(value => value.id !== targetId);
      return Response.json({ data: { deleteNoteTargets: [{ id: targetId }] } });
    }
    if (init?.method === 'DELETE' && url.pathname === '/rest/notes') {
      if (!url.searchParams.get('filter')?.includes(`updatedAt[eq]:"${record.updatedAt}"`)) return Response.json({ data: { deleteNotes: [] } });
      record.deletedAt = nextVersion; targets = [];
      return Response.json({ data: { deleteNotes: [{ id: noteId }] } });
    }
    throw new Error('Unexpected endpoint');
  });
  const client = new CrmNoteClient(env, fetcher);
  return { record, target, fetcher, client, targets: (value: Array<Record<string, unknown>>) => { targets = value; },
    create: () => client.create(noteId, targetId, dealId, content, creator, signal()),
    read: () => client.read(noteId, dealId, targetId, signal()),
    update: () => client.update(structuredClone(record), dealId, targetId, changed, signal()),
    undo: () => client.undoCreate(structuredClone(record), dealId, targetId, signal()),
    trash: () => client.trash(structuredClone(record), dealId, targetId, signal()),
    mutations: () => fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET') };
}

describe('CRM notes fixed adapter and note editor compatibility', () => {
  it('uses a separate notes gate and dedicated credential without relying on RFQ activation', async () => {
    expect(crmNotesAvailability(env)).toEqual({ available: true });
    expect(crmNotesAvailability({ ...env, CONTEXT_CRM_NOTES_ENABLED: 'false', CONTEXT_CRM_RFQ_WRITES_ENABLED: 'true' })).toEqual({ available: false });
    expect(crmNotesAvailability({ ...env, CONTEXT_CRM_WRITE_API_KEY: '', TWENTY_CRM_API_KEY: 'read-key' })).toEqual({ available: false });
    const f = fixture(); expect(await f.client.creator(actor, signal())).toEqual(creator);
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer synthetic-note-key' } });
  });
  it('reads the exact pinned deal identity and never changes it', async () => {
    const f = fixture(); expect(await f.client.deal(dealId, signal())).toMatchObject({ id: dealId, name: 'Test Logistics - Hoskote' });
    expect(String(f.fetcher.mock.calls[0][0])).toBe(`https://crm.example.test/rest/opportunities/${dealId}?depth=0`);
    expect(f.mutations()).toEqual([]);
  });
  it.each(['x', '  exact  ', 'first\n\nlast\n', 'first\r\nlast', '測試 ₹20/sqft\n😀'])('roundtrips exact plain note text %j through BlockNote', body => {
    const f = fixture(); expect(verifiedPlainNote({ ...f.record, bodyV2: noteBodyPayload(body) })).toEqual({ title: content.title, body });
  });
  it.each(['markdown-only', 'divergence', 'image', 'link', 'bold', 'children', 'alignment', 'unexpected-data'])('refuses %s content instead of flattening or discarding it', async mode => {
    const f = fixture(); const blocks = JSON.parse(f.record.bodyV2.blocknote!);
    if (mode === 'markdown-only') f.record.bodyV2.blocknote = null;
    if (mode === 'divergence') f.record.bodyV2.markdown = 'stale body';
    if (mode === 'image') blocks[0].type = 'image';
    if (mode === 'link') blocks[0].content[0] = { type: 'link', href: 'https://example.test', content: 'hidden' };
    if (mode === 'bold') blocks[0].content[0].styles = { bold: true };
    if (mode === 'children') blocks[0].children = [{ type: 'paragraph', content: [] }];
    if (mode === 'alignment') blocks[0].props = { textAlignment: 'right' };
    if (mode === 'unexpected-data') blocks[0].tableContent = { rows: ['discarded'] };
    if (!['markdown-only', 'divergence'].includes(mode)) f.record.bodyV2.blocknote = JSON.stringify(blocks);
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_NOTE_FORMAT_UNSUPPORTED' });
    expect(f.mutations()).toEqual([]);
  });
  it('accepts editor-generated default props and split plain text spans without changing text', () => {
    const f = fixture(); f.record.bodyV2 = { markdown: 'Two spans', blocknote: JSON.stringify([{ id: noteId, type: 'paragraph',
      props: { textAlignment: 'left', textColor: 'default', backgroundColor: 'default' },
      content: [{ type: 'text', text: 'Two ', styles: {} }, { type: 'text', text: 'spans', styles: {} }], children: [] }]) };
    expect(verifiedPlainNote(f.record).body).toBe('Two spans');
  });
  it('verifies the complete sole-target closure and carries its exact version', async () => {
    const f = fixture(); expect(await f.read()).toMatchObject({ id: noteId, targetUpdatedAt: version });
    const url = new URL(String(f.fetcher.mock.calls[1][0]));
    expect(url.pathname).toBe('/rest/noteTargets');
    expect(url.searchParams.get('limit')).toBe('2');
    expect(url.searchParams.get('filter')).toBe(`noteId[eq]:"${noteId}",deletedAt[is]:NULL`);
  });
  it.each(['shared', 'moved', 'company', 'person', 'custom-target', 'wrong-target', 'missing', 'deleted'])('refuses a %s association', async mode => {
    const f = fixture();
    if (mode === 'shared') f.targets([f.target, { ...f.target, id: otherId, targetOpportunityId: otherId }]);
    if (mode === 'moved') f.targets([{ ...f.target, targetOpportunityId: otherId }]);
    if (mode === 'company') f.targets([{ ...f.target, targetCompanyId: otherId }]);
    if (mode === 'person') f.targets([{ ...f.target, targetPersonId: otherId }]);
    if (mode === 'custom-target') f.targets([{ ...f.target, targetCustomThingId: otherId }]);
    if (mode === 'wrong-target') f.targets([{ ...f.target, id: otherId }]);
    if (mode === 'missing') f.targets([]);
    if (mode === 'deleted') f.targets([{ ...f.target, deletedAt: nextVersion }]);
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_NOTE_LINK_CHANGED' });
    expect(f.mutations()).toEqual([]);
  });
  it.each(['incomplete', 'oversized', 'bad-json', 'http'])('does not pretend a %s closure is verified', async mode => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname !== '/rest/noteTargets') return defaultFetch(url, init);
      if (mode === 'bad-json') return new Response('bad json');
      if (mode === 'http') return new Response('private error', { status: 503 });
      if (mode === 'oversized') return new Response('x'.repeat(128_001));
      return Response.json({ data: { noteTargets: [f.target] }, pageInfo: { hasNextPage: true } });
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'CRM_NOTE_UNAVAILABLE' });
  });
  it.each([404, 403, 429, 503])('distinguishes missing notes from HTTP %s read failures', async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response('private response', { status }));
    await expect(f.read()).rejects.toMatchObject({ code: status === 404 ? 'CRM_NOTE_NOT_FOUND' : 'CRM_NOTE_UNAVAILABLE' });
  });
  it('creates a note and its deal link with pre-reserved IDs, then verifies the saved content and association', async () => {
    const f = fixture(); const result = await f.create();
    expect(result).toMatchObject({ outcome: 'created', record: { id: noteId, targetUpdatedAt: version, title: content.title } });
    expect(f.mutations()).toHaveLength(2);
    const [note, target] = f.mutations();
    expect(new URL(String(note[0])).pathname).toBe('/rest/notes');
    expect(JSON.parse(String(note[1]!.body))).toMatchObject({ id: noteId, title: content.title,
      bodyV2: { markdown: content.body }, createdBy: { workspaceMemberId: memberId } });
    expect(new URL(String(target[0])).pathname).toBe('/rest/noteTargets');
    expect(JSON.parse(String(target[1]!.body))).toMatchObject({ id: targetId, noteId, targetOpportunityId: dealId });
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://crm.example.test');
      expect(new URL(String(url)).searchParams.has('upsert')).toBe(false);
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
    }
  });
  it.each([400, 403, 409, 422])('returns a clean rejection only when the first POST is explicitly rejected with HTTP %s', async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response('private detail', { status }));
    expect(await f.create()).toEqual({ outcome: 'rejected' }); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['denied-link', 'lost-link', 'bad-link', 'lost-note', 'wrong-note'])('retains uncertainty after %s and never cleans up or retries automatically', async mode => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === 'POST' && new URL(String(url)).pathname === '/rest/noteTargets') {
        if (mode === 'denied-link') return new Response('denied', { status: 403 });
        if (mode === 'lost-link') throw new Error('connection lost');
        if (mode === 'bad-link') return Response.json({ data: { createNoteTarget: { ...f.target, targetOpportunityId: otherId } } }, { status: 201 });
      }
      if (init?.method === 'POST' && new URL(String(url)).pathname === '/rest/notes') {
        if (mode === 'lost-note') throw new Error('connection lost');
        if (mode === 'wrong-note') return Response.json({ data: { createNote: { ...f.record, id: otherId } } }, { status: 201 });
      }
      return defaultFetch(url, init);
    });
    expect(await f.create()).toEqual({ outcome: 'outcome_unknown' });
    expect(f.mutations()).toHaveLength(['lost-note', 'wrong-note'].includes(mode) ? 1 : 2);
    expect(f.mutations().every(([, init]) => init?.method === 'POST')).toBe(true);
  });
  it('updates only note content under the exact note version and creator, with pre/post association checks', async () => {
    const f = fixture(); expect(await f.update()).toMatchObject({ outcome: 'updated', record: { title: changed.title, targetUpdatedAt: version, updatedAt: nextVersion } });
    const [url, init] = f.mutations()[0];
    expect(new URL(String(url)).pathname).toBe('/rest/notes');
    expect(new URL(String(url)).searchParams.get('filter')).toBe(`id[eq]:"${noteId}",updatedAt[eq]:"${version}",createdBy.workspaceMemberId[eq]:"${memberId}",deletedAt[is]:NULL`);
    expect(init?.method).toBe('PATCH');
    expect(Object.keys(JSON.parse(String(init!.body))).sort()).toEqual(['bodyV2', 'title']);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2);
  });
  it('refuses observed sharing or changed target version before issuing an edit', async () => {
    const f = fixture(); f.targets([f.target, { ...f.target, id: otherId }]);
    expect(await f.update()).not.toMatchObject({ outcome: 'updated' }); expect(f.mutations()).toHaveLength(0);
    f.targets([{ ...f.target, updatedAt: nextVersion }]);
    expect(await f.update()).toMatchObject({ outcome: 'rejected', code: 'CRM_NOTE_VERSION_CONFLICT' }); expect(f.mutations()).toHaveLength(0);
  });
  it('does not claim success if the note is shared during an update', async () => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const result = await defaultFetch(url, init);
      if (init?.method === 'PATCH') f.targets([f.target, { ...f.target, id: otherId, targetOpportunityId: otherId }]);
      return result;
    });
    expect(await f.update()).toEqual({ outcome: 'outcome_unknown' }); expect(f.mutations()).toHaveLength(1);
  });
  it.each(['empty', 'wrong-id', 'unchanged-version', 'wrong-text'])('rejects a %s update response without retrying', async mode => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method !== 'PATCH') return defaultFetch(url, init);
      const updated = { ...f.record, title: changed.title, bodyV2: noteBodyPayload(changed.body), updatedAt: nextVersion,
        ...(mode === 'wrong-id' ? { id: otherId } : {}), ...(mode === 'unchanged-version' ? { updatedAt: version } : {}),
        ...(mode === 'wrong-text' ? { bodyV2: noteBodyPayload('unexpected change') } : {}) };
      return Response.json({ data: { updateNotes: mode === 'empty' ? [] : [updated] } });
    });
    expect(await f.update()).toMatchObject({ outcome: mode === 'empty' ? 'rejected' : 'outcome_unknown' });
    expect(f.mutations()).toHaveLength(1);
  });
  it('undoes creation by soft-deleting only the original deal link while preserving the note and its content', async () => {
    const f = fixture(); const before = structuredClone(f.record);
    expect(await f.undo()).toEqual({ outcome: 'rolled_back' });
    expect(f.record).toEqual(before);
    const [url, init] = f.mutations()[0], parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/rest/noteTargets'); expect(parsed.searchParams.get('soft_delete')).toBe('true');
    expect(parsed.searchParams.get('filter')).toBe(`id[eq]:"${targetId}",updatedAt[eq]:"${version}",noteId[eq]:"${noteId}",targetOpportunityId[eq]:"${dealId}",targetCompanyId[is]:NULL,targetPersonId[is]:NULL,deletedAt[is]:NULL`);
    expect(init?.method).toBe('DELETE'); expect(init?.body).toBeUndefined(); expect(f.mutations()).toHaveLength(1);
  });
  it('preserves a concurrent new link when undoing the original addition', async () => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const result = await defaultFetch(url, init);
      if (init?.method === 'DELETE') f.targets([{ ...f.target, id: otherId, targetOpportunityId: otherId }]);
      return result;
    });
    expect(await f.undo()).toEqual({ outcome: 'rolled_back' }); expect(f.record.deletedAt).toBeNull();
    expect(f.mutations()).toHaveLength(1);
  });
  it('does not claim unlink success when the original target remains visible', async () => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => init?.method === 'DELETE'
      ? Response.json({ data: { deleteNoteTargets: [{ id: targetId }] } }) : defaultFetch(url, init));
    expect(await f.undo()).toEqual({ outcome: 'outcome_unknown' }); expect(f.mutations()).toHaveLength(1);
  });
  it('checks the current note version and text again before unlinking', async () => {
    const f = fixture(); const original = structuredClone(f.record);
    f.record.updatedAt = nextVersion; f.record.bodyV2 = noteBodyPayload(changed.body);
    expect(await f.client.undoCreate(original, dealId, targetId, signal())).toMatchObject({ outcome: 'rejected', code: 'CRM_NOTE_VERSION_CONFLICT' });
    expect(f.mutations()).toHaveLength(0);
  });
  it('withholds an unchanged-note receipt if note text changes while the deal link is removed', async () => {
    const f = fixture(); const defaultFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const result = await defaultFetch(url, init);
      if (init?.method === 'DELETE') { f.record.updatedAt = nextVersion; f.record.bodyV2 = noteBodyPayload(changed.body); }
      return result;
    });
    expect(await f.undo()).toEqual({ outcome: 'outcome_unknown' });
    expect(f.record.bodyV2.markdown).toBe(changed.body); expect(f.record.deletedAt).toBeNull();
    expect(f.mutations()).toHaveLength(1);
  });
  it('does not dispatch when cancelled before the request', async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    expect(await f.client.create(noteId, targetId, dealId, content, creator, abort.signal)).toEqual({ outcome: 'outcome_unknown' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('CRM note trash adapter is disabled', () => {
  it.each(['current', 'edited', 'shared', 'link-races-delete', 'disabled'] as const)('never reads or deletes a %s note, including direct adapter calls', async state => {
    const f = fixture();
    if (state === 'edited') await f.update();
    if (state === 'shared') f.targets([f.target, { ...f.target, id: otherId, targetOpportunityId: otherId }]);
    const before = structuredClone(f.record);
    f.fetcher.mockClear();
    if (state === 'link-races-delete') f.fetcher.mockImplementation(async () => { throw new Error('No provider request is safe for note trash.'); });
    const client = state === 'disabled' ? new CrmNoteClient({ ...env, CONTEXT_CRM_DELETES_ENABLED: 'false' }, f.fetcher) : f.client;
    expect(await client.trash(f.record, dealId, targetId, signal())).toEqual({ outcome: 'rejected', code: 'CRM_NOTE_DELETE_UNAVAILABLE' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.record).toEqual(before);
  });
  it('keeps existing recovery discovery gates without offering fresh deletion', () => {
    expect(crmNotesDeleteAvailability(env)).toEqual({ available: true });
    for (const overrides of [{ CONTEXT_CRM_DELETES_ENABLED: undefined }, { CONTEXT_CRM_DELETES_ENABLED: 'false' },
      { CONTEXT_CRM_NOTES_ENABLED: 'false' }, { CONTEXT_CRM_WRITE_API_KEY: '', TWENTY_CRM_API_KEY: 'read-key' }]) {
      expect(crmNotesDeleteAvailability({ ...env, ...overrides })).toEqual({ available: false });
    }
  });
});
