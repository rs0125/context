import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleApiError, consoleRequest, emptyDraft, importMarkdown, makeAgentSetup, makeSystemPrompt, validateDraft } from '../src/components/console/helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Markdown import boundaries', () => {
  it('imports supported metadata without silently publishing a reviewed file', () => {
    const { draft } = importMarkdown('---\nid: process-guide\ntitle: "A practical guide"\nsummary: Useful background\nstatus: reviewed\nscopes: [knowledge:read, warehouses:read]\n---\n# Content\n', 'guide.md');
    expect(draft).toMatchObject({ id: 'process-guide', title: 'A practical guide', summary: 'Useful background', status: 'draft', scopes: ['knowledge:read', 'warehouses:read'], body: '# Content\n' });
    expect(validateDraft(draft)).toBeNull();
  });

  it('does not execute YAML tags or import unknown permissions', () => {
    const { draft, notice } = importMarkdown('---\ntitle: !!js/function function() { throw new Error() }\nsummary: Basic guide\nscopes:\n  - knowledge:read\n  - crm:read\n  - admin:write\n  - crm:read\n---\n<script>window.example = true</script>', 'safe-filename.md');
    expect(draft.title).toBe('safe filename');
    expect(draft.scopes).toEqual(['knowledge:read', 'crm:read']);
    expect(draft.body).toBe('<script>window.example = true</script>');
    expect(draft.status).toBe('draft');
    expect(notice).toContain('Some reader permissions could not be imported');
  });

  it('retains scope restrictions from an unindented YAML sequence', () => {
    const { draft, notice } = importMarkdown('---\ntitle: A guide\nscopes:\n- knowledge:read\n- warehouses:read\n- crm:read\n---\n# Context', 'guide.md');
    expect(draft.scopes).toEqual(['knowledge:read', 'warehouses:read', 'crm:read']);
    expect(notice).not.toContain('could not be imported');
  });

  it('preserves plain Markdown and normalizes only file line endings', () => {
    const { draft } = importMarkdown('\uFEFF# Heading\r\n\r\n---\r\nBody', 'Team Notes.MD');
    expect(draft).toMatchObject({ id: 'team-notes', title: 'Team Notes', body: '# Heading\n\n---\nBody', scopes: ['knowledge:read'] });
  });

  it('rejects incomplete frontmatter, wrong file types, nulls, and excessive UTF-8 bytes', () => {
    expect(() => importMarkdown('---\ntitle: Unclosed\n# Content', 'file.md')).toThrow('closing');
    expect(() => importMarkdown('# Notes', 'file.html')).toThrow('.md');
    expect(() => importMarkdown('a\0b', 'file.md')).toThrow('null');
    expect(() => importMarkdown('é'.repeat(50_001), 'file.md')).toThrow('100 KB');
  });
});

describe('editor validation', () => {
  const complete = () => ({ ...emptyDraft(), id: 'sample-page', title: 'Sample page', summary: 'A useful page.', body: '# Useful context' });

  it('measures Markdown in bytes, including multibyte text', () => {
    expect(validateDraft({ ...complete(), body: 'é'.repeat(50_000) })).toBeNull();
    expect(validateDraft({ ...complete(), body: 'é'.repeat(50_001) })).toMatch(/100 KB/);
  });

  it('rejects path traversal, control characters, and elevated scopes', () => {
    expect(validateDraft({ ...complete(), id: '../private' })).toMatch(/page ID/);
    expect(validateDraft({ ...complete(), summary: 'one\ntwo' })).toMatch(/one line/);
    expect(validateDraft({ ...complete(), scopes: ['knowledge:read', 'admin:write'] })).toMatch(/permissions/);
    expect(validateDraft({ ...complete(), scopes: ['warehouses:read'] })).toMatch(/permissions/);
    expect(validateDraft({ ...complete(), scopes: ['knowledge:read', 'knowledge:read'] })).toMatch(/permissions/);
  });
});

describe('console transport and agent instructions', () => {
  it('sends credentials only to same-origin console requests with redirects disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ page: { id: 'guide' } }));
    vi.stubGlobal('fetch', fetchMock);
    await consoleRequest('/api/console/knowledge', { method: 'POST', body: { id: 'guide' } });
    expect(fetchMock).toHaveBeenCalledWith('/api/console/knowledge', expect.objectContaining({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', method: 'POST', body: '{"id":"guide"}' }));
  });

  it('preserves typed conflicts and makes network errors safe to show', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 'REVISION_CONFLICT', message: 'Reload this page.' } }, { status: 409 })).mockRejectedValueOnce(new Error('Sensitive network diagnostic'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(consoleRequest('/api/console/knowledge/guide')).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
    await expect(consoleRequest('/api/console/me')).rejects.toThrow(ConsoleApiError);
    fetchMock.mockRejectedValueOnce(new Error('Sensitive network diagnostic'));
    await expect(consoleRequest('/api/console/me')).rejects.not.toThrow('Sensitive network diagnostic');
  });

  it('rejects absolute URLs before making a network request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(consoleRequest('https://external.example.test/api/console/me')).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps copied credentials separate from the generic prompt', () => {
    const prompt = makeSystemPrompt('https://context.example.test/api/v1/');
    expect(prompt).toContain('GET https://context.example.test/api/v1/context');
    expect(prompt).toContain('verification_required');
    expect(prompt).toContain('source_status');
    expect(prompt).not.toContain('test-only-token');
    const setup = makeAgentSetup(prompt, 'test-only-token');
    expect(setup).toContain('SYSTEM INSTRUCTIONS');
    expect(setup).toContain('CREDENTIAL — STORE IN YOUR TOOL’S CREDENTIAL SETTINGS');
    expect(setup).toContain('Authorization: Bearer test-only-token');
  });
});
