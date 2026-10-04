/** Deal-scoped note REST reads retain domain authorization; no provider calls. */
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/lib/api';
import type { KeyRegistration } from '../src/lib/auth';
import type { readCrmNote, listCrmNoteChanges } from '../src/lib/crm-writes/notes-read';
import { HttpError } from '../src/lib/errors';
import { getOpenApiDocument } from '../src/lib/openapi';

const origin = 'https://context.example.test';
beforeEach(() => {
  vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'true');
  vi.stubEnv('CONTEXT_CRM_RFQ_WRITES_ENABLED', 'false');
  vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', 'synthetic');
  vi.stubEnv('TWENTY_CRM_BASE_URL', 'https://crm.example.test');
});
afterEach(() => vi.unstubAllEnvs());
function harness() {
  const dealId = randomUUID(), noteId = randomUUID();
  const key: KeyRegistration = { id: randomUUID(), hash: 'a'.repeat(64), employeeId: 7,
    employeeEmail: 'employee@wareongo.com', scopes: ['crm:read', 'crm.notes:write'], expiresAt: '2099-01-01T00:00:00Z' };
  const read = vi.fn<typeof readCrmNote>(async () => ({ id: noteId, deal: { id: dealId, name: 'Synthetic deal' }, note: { title: 'Synthetic title', body: 'Exact note text.' }, updated_at: '2026-10-05T10:00:00.000Z', editable: true } as Awaited<ReturnType<typeof readCrmNote>>));
  const list = vi.fn<typeof listCrmNoteChanges>(async () => ({ items: [] } as unknown as Awaited<ReturnType<typeof listCrmNoteChanges>>));
  const deps = { authenticate: async () => key, readCrmNote: read, listCrmNoteChanges: list,
    transaction: vi.fn(() => { throw new Error('Do not enter generic CRM mirror authorization'); }),
    liveCrmAccess: vi.fn(() => { throw new Error('Do not authorize via broad CRM reads'); }),
    revalidateKey: vi.fn(async () => {}), audit: vi.fn() };
  const request = (path: string, method = 'GET') => handleApiRequest(new Request(`${origin}/api/v1/${path}`, { method }), path.split('?')[0].split('/'), deps);
  const route = `crm/deals/${dealId}`;
  return { dealId, noteId, route, key, read, list, deps, request };
}

describe('deal-scoped note REST reads', () => {
  it('reads the live authorized note through the domain boundary and returns a private envelope', async () => {
    const h = harness();
    const response = await h.request(`${h.route}/notes/${h.noteId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).data).toMatchObject({ id: h.noteId, note: { body: 'Exact note text.' } });
    expect(h.read).toHaveBeenCalledWith({ deal_id: h.dealId, note_id: h.noteId }, h.key, expect.any(AbortSignal), h.deps.revalidateKey);
    expect(h.deps.transaction).not.toHaveBeenCalled(); expect(h.deps.liveCrmAccess).not.toHaveBeenCalled();
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'crm/note/read', status: 200 }));
    expect(JSON.stringify(h.deps.audit.mock.calls)).not.toContain(h.dealId);
    expect(JSON.stringify(h.deps.audit.mock.calls)).not.toContain('Exact note text');
  });
  it('lists bounded deal-specific changes and supports HEAD without a response body', async () => {
    const h = harness();
    expect((await h.request(`${h.route}/note-changes?limit=3`)).status).toBe(200);
    expect(h.list).toHaveBeenCalledWith({ deal_id: h.dealId, limit: 3 }, h.key, expect.any(AbortSignal), h.deps.revalidateKey);
    const head = await h.request(`${h.route}/note-changes`, 'HEAD');
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'crm/note-changes', status: 200 }));
  });
  it('rejects invalid IDs, duplicate parameters and authority-expanding query inputs', async () => {
    const h = harness();
    for (const path of [
      `crm/deals/not-an-id/notes/${h.noteId}`, `${h.route}/notes/not-an-id`, `${h.route}/note-changes?limit=0`,
      `${h.route}/note-changes?limit=11`, `${h.route}/note-changes?limit=1&limit=2`, `${h.route}/note-changes?limit=NaN`,
      `${h.route}/note-changes?employee_id=8`, `${h.route}/notes/${h.noteId}?deal_id=${randomUUID()}`,
    ]) expect((await h.request(path)).status).toBe(422);
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it('requires both note and CRM read scopes independently of other write grants', async () => {
    const h = harness();
    for (const scopes of [['crm:read'], ['crm.notes:write'], ['crm:read', 'crm.rfq:write']] as KeyRegistration['scopes'][]) {
      h.key.scopes = scopes;
      expect((await h.request(`${h.route}/notes/${h.noteId}`)).status).toBe(403);
      expect((await h.request(`${h.route}/note-changes`)).status).toBe(403);
    }
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it('requires configured notes but does not require RFQ creation to be enabled', async () => {
    const h = harness();
    expect((await h.request(`${h.route}/notes/${h.noteId}`)).status).toBe(200); h.read.mockClear();
    vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'false');
    expect((await h.request(`${h.route}/notes/${h.noteId}`)).status).toBe(503);
    vi.stubEnv('CONTEXT_CRM_NOTES_ENABLED', 'true'); vi.stubEnv('CONTEXT_CRM_WRITE_API_KEY', '');
    expect((await h.request(`${h.route}/note-changes`)).status).toBe(503);
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it('preserves a current domain authorization refusal without exposing old note content', async () => {
    const h = harness(); h.read.mockRejectedValue(new HttpError(403, 'CRM_NOTE_NOT_OWNED', 'Only your agent-created notes are editable.'));
    const response = await h.request(`${h.route}/notes/${h.noteId}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CRM_NOTE_NOT_OWNED' } });
  });
  it('provides no REST mutation, arbitrary deal route or cross-deal note listing', async () => {
    const h = harness();
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await h.request(`${h.route}/notes/${h.noteId}`, method)).status).toBe(405);
    for (const path of ['crm/deals', `${h.route}/notes`, `${h.route}/note-changes/extra`, `${h.route}/notes/${h.noteId}/extra`]) expect((await h.request(path)).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it('documents the same read-only routes and exact scope/target requirements in OpenAPI', () => {
    const { paths } = getOpenApiDocument();
    const detail = paths['/crm/deals/{deal_id}/notes/{note_id}'];
    const list = paths['/crm/deals/{deal_id}/note-changes'];
    expect(Object.keys(detail)).toEqual(['get']); expect(Object.keys(list)).toEqual(['get']);
    for (const route of [detail, list]) expect(route.get.description).toMatch(/crm:read, crm.notes:write/);
    expect(detail.get.parameters.map(parameter => parameter.name)).toEqual(['deal_id', 'note_id']);
    expect(list.get.parameters.map(parameter => parameter.name)).toEqual(['deal_id', 'limit']);
  });
});
