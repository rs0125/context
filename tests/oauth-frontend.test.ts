import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleApiError } from '../src/components/console/helpers';
import { authorizationError, authorizationQuery, authorizationRedirect, oauthRequest, readAuthorizationPreview } from '../src/components/oauth/helpers';

afterEach(() => vi.unstubAllGlobals());

const currentOrigin = 'https://context.example.test';
const requestQuery = new URLSearchParams({ response_type: 'code', client_id: 'synthetic-client', redirect_uri: 'https://client.example.test/callback', resource: `${currentOrigin}/mcp`, code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'synthetic-state', scope: 'knowledge:read warehouses:read' });
const previewResponse = { requestHandle: 'synthetic-request-handle', clientName: 'Synthetic AI tool', clientOrigin: 'https://client.example.test', redirectOrigin: 'https://client.example.test', redirectUri: 'https://client.example.test/callback', resource: `${currentOrigin}/mcp`, requestedScopes: ['knowledge:read', 'warehouses:read'] };

describe('authorization request and preview', () => {
  it('preserves supported request parameters while rejecting duplicates and secret-bearing query additions', () => {
    expect(new URLSearchParams(authorizationQuery(requestQuery.toString())).get('state')).toBe('synthetic-state');
    expect(() => authorizationQuery(`${requestQuery}&apiKey=synthetic-secret`)).toThrow(/invalid/);
    expect(() => authorizationQuery(`${requestQuery}&client_id=second`)).toThrow(/invalid/);
    const weak = new URLSearchParams(requestQuery); weak.set('code_challenge_method', 'plain');
    expect(() => authorizationQuery(weak.toString())).toThrow(/not supported/);
    expect(() => authorizationQuery('client_id=only-one-field')).toThrow(/incomplete/);
  });

  it('accepts only supported read scopes and a resource on this authorization origin', () => {
    expect(readAuthorizationPreview(previewResponse, currentOrigin)).toMatchObject({ scopes: ['knowledge:read', 'warehouses:read'], redirectUri: 'https://client.example.test/callback' });
    expect(() => readAuthorizationPreview({ ...previewResponse, requestedScopes: ['admin:write'] }, currentOrigin)).toThrow();
    expect(() => readAuthorizationPreview({ ...previewResponse, resource: 'https://other.example.test/mcp' }, currentOrigin)).toThrow();
    expect(() => readAuthorizationPreview({ ...previewResponse, redirectUri: 'https://different.example.test/callback' }, currentOrigin)).toThrow();
    expect(() => readAuthorizationPreview({ ...previewResponse, redirectUri: 'javascript:alert(1)' }, currentOrigin)).toThrow();
  });

  it('allows localhost only over HTTP and rejects insecure public callback addresses', () => {
    expect(readAuthorizationPreview({ ...previewResponse, clientOrigin: 'http://localhost:4000', redirectOrigin: 'http://localhost:4000', redirectUri: 'http://localhost:4000/callback', resource: 'http://localhost:3100/mcp' }, 'http://localhost:3100').redirectOrigin).toBe('http://localhost:4000');
    expect(() => readAuthorizationPreview({ ...previewResponse, clientOrigin: 'http://client.example.test' }, currentOrigin)).toThrow();
  });
});

describe('authorization decisions', () => {
  const preview = readAuthorizationPreview(previewResponse, currentOrigin);

  it('only follows server-returned OAuth results at the registered callback', () => {
    expect(authorizationRedirect({ redirectUrl: 'https://client.example.test/callback?code=synthetic-code&state=synthetic-state' }, preview)).toContain('code=synthetic-code');
    expect(authorizationRedirect({ redirectUrl: 'https://client.example.test/callback?error=access_denied&state=synthetic-state' }, preview)).toContain('access_denied');
    for (const redirectUrl of ['https://other.example.test/callback?code=x', 'https://client.example.test/other?code=x', 'javascript:alert(1)', 'https://client.example.test/callback', 'https://client.example.test/callback?code=x#error']) {
      expect(() => authorizationRedirect({ redirectUrl }, preview)).toThrow();
    }
  });

  it('does not drop or duplicate registered callback query parameters', () => {
    const registered = { ...preview, redirectUri: 'https://client.example.test/callback?tenant=example' };
    expect(authorizationRedirect({ redirectUrl: 'https://client.example.test/callback?tenant=example&code=x' }, registered)).toContain('tenant=example');
    expect(() => authorizationRedirect({ redirectUrl: 'https://client.example.test/callback?code=x' }, registered)).toThrow();
    expect(() => authorizationRedirect({ redirectUrl: 'https://client.example.test/callback?tenant=example&tenant=other&code=x' }, registered)).toThrow();
  });

  it('sends the employee key only in a same-origin POST body and keeps decline key-free', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ redirectUrl: 'https://client.example.test/callback?code=example' }));
    vi.stubGlobal('fetch', fetchMock);
    await oauthRequest(undefined, { requestHandle: 'synthetic-handle', apiKey: 'synthetic-private-key', approve: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/oauth/authorize', expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: '{"requestHandle":"synthetic-handle","apiKey":"synthetic-private-key","approve":true}' }));
    await oauthRequest(undefined, { requestHandle: 'synthetic-handle', approve: false });
    expect(fetchMock.mock.calls[1][1].body).not.toContain('apiKey');
    expect(fetchMock.mock.calls.every(call => !call[0].includes('synthetic-private-key'))).toBe(true);
  });

  it('does not expose server diagnostics in consent errors', () => {
    const secretDiagnostic = 'private employee key and database password';
    expect(authorizationError(new ConsoleApiError('INVALID_KEY', secretDiagnostic, 401))).toContain('invalid or expired');
    expect(authorizationError(new ConsoleApiError('invalid_client', secretDiagnostic, 401))).toContain('requesting application is not registered');
    expect(authorizationError(new ConsoleApiError('USED', secretDiagnostic, 409))).toContain('expired or was already used');
    expect(authorizationError(new ConsoleApiError('SETUP', secretDiagnostic, 503))).toContain('temporarily unavailable');
    expect(authorizationError(new Error(secretDiagnostic))).not.toContain(secretDiagnostic);
  });
});
