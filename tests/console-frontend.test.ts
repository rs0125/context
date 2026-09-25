import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleApiError, consoleRequest, emptyDraft, importMarkdown, loginErrorMessage, makeConnectorSetup, makeSystemPrompt, mcpServerUrl, validateDraft } from '../src/components/console/helpers';

afterEach(() => vi.unstubAllGlobals());

describe('sign-in failure messages', () => {
  const diagnostic = 'sensitive upstream diagnostic, password=test-only-secret, postgres://private-host';

  it.each([
    ['CONNECTION_FAILED', 0, 'Cannot reach the console server. Check that it is running and refresh this page.'],
    ['CONSOLE_ORIGIN_DENIED', 403, 'This address is not allowed for console sign-in. Open the configured console URL.'],
    ['CONSOLE_CONFIGURATION', 503, 'Admin sign-in is not configured on this server.'],
    ['CONSOLE_SETUP_REQUIRED', 503, 'Workspace setup is incomplete. Finish console setup before signing in.'],
    ['DATABASE_CONFIGURATION', 503, 'The console data connection is not configured on this server.'],
    ['CONSOLE_ACCESS_DENIED', 403, 'The configured admin account is not available in the active employee roster. Check its access before signing in.'],
    ['CONSOLE_INVALID_CREDENTIALS', 401, 'Sign-in failed. Check the admin password and try again.'],
    ['RATE_LIMITED', 429, 'Too many sign-in attempts. Wait a moment and try again.'],
  ])('distinguishes %s without including upstream diagnostics', (code, status, expected) => {
    const message = loginErrorMessage(new ConsoleApiError(code as string, diagnostic, status as number));
    expect(message).toBe(expected);
    expect(message).not.toContain('test-only-secret');
    expect(message).not.toContain('private-host');
  });

  it.each(['DATABASE_UNAVAILABLE', 'DATABASE_BUSY', 'CONSOLE_UNAVAILABLE'])('does not label %s as an incorrect password', code => {
    const message = loginErrorMessage(new ConsoleApiError(code, diagnostic, 503));
    expect(message).toBe('The console is temporarily unavailable. Wait a moment and try again.');
    expect(message).not.toMatch(/password/i);
  });

  it('uses safe fallbacks for unknown gateway errors, denied requests, and unexpected exceptions', () => {
    expect(loginErrorMessage(new ConsoleApiError('UNKNOWN_UPSTREAM', diagnostic, 502))).toMatch(/temporarily unavailable/);
    expect(loginErrorMessage(new ConsoleApiError('UNKNOWN_DENIAL', diagnostic, 403))).toMatch(/blocked for this request/);
    expect(loginErrorMessage(new Error(diagnostic))).toBe('Unable to sign in right now. Please try again.');
    expect(loginErrorMessage({ code: 'CONSOLE_CONFIGURATION', message: diagnostic })).toBe('Unable to sign in right now. Please try again.');
  });
});

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

  it('posts the admin password as JSON only to the fixed same-origin login route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await consoleRequest('/api/auth/login', { method: 'POST', body: { password: 'test-only-password' } });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: '{"password":"test-only-password"}',
    }));
    await expect(consoleRequest('/api/auth/login?password=test-only-password')).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    await expect(consoleRequest('/api/auth/google')).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('copies only connection instructions and keeps secrets out of every setup block', () => {
    const prompt = makeSystemPrompt('https://context.example.test/api/v1/');
    expect(prompt).toContain('GET https://context.example.test/api/v1/context');
    expect(prompt).toContain('verification_required');
    expect(prompt).toContain('source_status');
    expect(prompt).toContain('Pasting this text into an ordinary chat does not connect the API');
    expect(prompt).not.toContain('test-only-token');
    const setup = makeConnectorSetup('https://context.example.test/api/v1/');
    expect(setup).toContain('MCP server URL: https://context.example.test/mcp');
    expect(setup).toContain('Do not paste your API key');
    expect(setup).not.toContain('Authorization: Bearer');
    expect(setup).not.toContain('test-only-token');
    expect(mcpServerUrl('http://localhost:3100/api/v1')).toBe('http://localhost:3100/mcp');
    expect(mcpServerUrl('https://context.example.test/api/v1?ignored=true#fragment')).toBe('https://context.example.test/mcp');
  });
});
