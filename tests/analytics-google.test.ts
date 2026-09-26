import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, decodeJwt } from 'jose';

let credentials: string;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  credentials = JSON.stringify({ type: 'service_account', client_email: 'test@test-project.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey), private_key_id: 'testkey', token_uri: 'https://oauth2.googleapis.com/token' });
});
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', credentials);
  vi.stubEnv('GA4_PROPERTY_ID', '123');
  vi.stubEnv('SEARCH_CONSOLE_SITE_URL', 'sc-domain:wareongo.com');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const token = (value = 'unit-test-token') => Response.json({ access_token: value, expires_in: 3600, token_type: 'Bearer' });
const projection = (x: unknown) => ({ count: (x as { count: number }).count });
const read = { kind: 'ga4_report' as const, property: '123' };

describe('Google analytics read transport', () => {
  it('uses only readonly scopes, fixed HTTPS endpoints, redirection refusal and a single cached token', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ count: 7, hidden: 'secret' }))
      .mockResolvedValueOnce(Response.json({ count: 8 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    const first = await api.googleAnalyticsRead(read, { query: 'one' }, projection);
    const cached = await api.googleAnalyticsRead(read, { query: 'one' }, projection);
    await api.googleAnalyticsRead(read, { query: 'two' }, projection);
    expect(first).toMatchObject({ data: { count: 7 }, cache_hit: false });
    expect(cached).toMatchObject({ data: { count: 7 }, cache_hit: true, source_fetched_at: first.source_fetched_at });
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const claims = decodeJwt(new URLSearchParams(init.body).get('assertion')!);
    expect(claims.aud).toBe(url);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly');
    for (const [, request] of fetch.mock.calls) { expect(request.redirect).toBe('error'); expect(request.cache).toBe('no-store'); }
  });
  it('coalesces simultaneous requests without sharing mutable result objects', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ count: 7 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    const [a, b] = await Promise.all([api.googleAnalyticsRead(read, {}, projection), api.googleAnalyticsRead(read, {}, projection)]);
    a.data.count = 99;
    expect(b.data.count).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refreshes once on a source401 and does not loop', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token('first')).mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(token('second')).mockResolvedValueOnce(new Response('private error', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, projection)).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_DENIED', status: 503 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3][1].headers.Authorization).toBe('Bearer second');
  });
  it.each([[403, 'ANALYTICS_SOURCE_DENIED'], [429, 'ANALYTICS_SOURCE_RATE_LIMITED'], [500, 'ANALYTICS_SOURCE_UNAVAILABLE'], [400, 'ANALYTICS_SOURCE_QUERY_UNAVAILABLE']])('maps HTTP%s to safe %s without upstream text', async (status, code) => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('private@example.com token=SECRET', { status: status as number }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    let error: unknown;
    try { await api.googleAnalyticsRead(read, {}, projection); } catch (e) { error = e; }
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('SECRET');
  });
  it('does not return stale cached data when refreshing fails', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ count: 7 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await api.googleAnalyticsRead(read, {}, projection);
    vi.setSystemTime(Date.now() + 301_000);
    await expect(api.googleAnalyticsRead(read, {}, projection)).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_UNAVAILABLE' });
  });
  it('refreshes cache and token after credential rotation', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ count: 7 }))
      .mockResolvedValueOnce(token('next')).mockResolvedValueOnce(Response.json({ count: 8 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await api.googleAnalyticsRead(read, {}, projection);
    const changed = JSON.parse(credentials); changed.private_key_id = 'newkey';
    vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', JSON.stringify(changed));
    const second = await api.googleAnalyticsRead(read, {}, projection);
    expect(second.data.count).toBe(8);
    expect(second.cache_hit).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each(['', '{bad', JSON.stringify({ type: 'authorized_user', refresh_token: 'do-not-leak' }),
    JSON.stringify({ type: 'service_account', client_email: 'test@test.iam.gserviceaccount.com', private_key: 'SECRET' }),
  ])('rejects malformed configuration without making network requests', async raw => {
    vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', raw);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, projection)).rejects.toMatchObject({ code: 'ANALYTICS_CONFIGURATION' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never trusts a credential-supplied token host', async () => {
    const changed = JSON.parse(credentials); changed.token_uri = 'https://evil.test/token';
    vi.stubEnv('GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON', JSON.stringify(changed));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, projection)).rejects.toMatchObject({ code: 'ANALYTICS_CONFIGURATION' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces the upstream response size bound', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': '999999999' } }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, projection)).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it('rejects an aborted report before credentials or network use', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, projection, AbortSignal.abort())).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_TIMEOUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts a stalled upstream request at its deadline', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    const request = api.googleAnalyticsRead(read, {}, projection);
    const failure = expect(request).rejects.toMatchObject({ code: 'ANALYTICS_SOURCE_TIMEOUT' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(8001);
    await failure;
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  });
  it('does not cache a schema projection failure or expose the malformed source object', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ secret: 'private' }))
      .mockResolvedValueOnce(Response.json({ count: 9 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('../src/lib/analytics-google');
    await expect(api.googleAnalyticsRead(read, {}, () => api.analyticsSourceError())).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
    const result = await api.googleAnalyticsRead(read, {}, projection);
    expect(result).toMatchObject({ cache_hit: false, data: { count: 9 } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
