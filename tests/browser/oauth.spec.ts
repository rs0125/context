import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const apiKey = `wog_ctx_${'C'.repeat(43)}`;
const redirectUri = 'https://client.example.test/connector/callback';

async function mockAuthorization(page: Page, options: { rejectKey?: boolean; unsafeRedirect?: boolean; unavailable?: boolean } = {}) {
  const posts: Record<string, unknown>[] = [];
  const requests: string[] = [];
  await page.route('https://client.example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Synthetic client callback</h1>' }));
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); requests.push(request.url());
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname !== '/api/oauth/authorize') return reply({ error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'Only mocked OAuth requests are allowed.' } }, 500);
    if (request.method() === 'GET') {
      if (options.unavailable) return reply({ error: { code: 'MCP_SETUP_REQUIRED', message: 'Synthetic unavailable service.' } }, 503);
      return reply({ requestHandle: 'synthetic-browser-request', clientName: 'Synthetic AI client', clientOrigin: 'https://client.example.test', redirectOrigin: 'https://client.example.test', redirectUri, resource: `${url.origin}/mcp`, requestedScopes: ['knowledge:read', 'crm:read'] });
    }
    const body = request.postDataJSON(); posts.push(body);
    if (options.rejectKey && body.approve) return reply({ error: { code: 'INVALID_KEY', message: 'Synthetic private diagnostic must not be shown.' } }, 401);
    if (options.unsafeRedirect) return reply({ redirectUrl: 'https://unrelated.example.test/callback?code=synthetic-code' });
    return reply({ redirectUrl: body.approve ? `${redirectUri}?code=synthetic-code&state=synthetic-state` : `${redirectUri}?error=access_denied&state=synthetic-state` });
  });
  const query = new URLSearchParams({ response_type: 'code', client_id: 'synthetic-client', redirect_uri: redirectUri, resource: 'http://localhost:3000/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'synthetic-state', scope: 'knowledge:read crm:read' });
  await page.goto(`/oauth/authorize?${query}`);
  return { posts, requests };
}

test('consent shows the application, complete redirect, and read permissions before any grant', async ({ page }) => {
  const { posts } = await mockAuthorization(page);
  await expect(page.getByRole('heading', { name: 'Synthetic AI client wants to read Wareongo context' })).toBeVisible();
  await expect(page.getByText(redirectUri, { exact: true })).not.toBeVisible();
  await expect(page.getByText('Company guides', { exact: true })).toBeVisible();
  await expect(page.getByText('CRM records', { exact: true })).toBeVisible();
  await expect(page.getByText('Warehouse listings', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Employee API key')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Admin password')).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await mkdir('previews', { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'previews/linear-consent-desktop.png', fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'previews/linear-consent-mobile.png', fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  await page.getByText('Connection details', { exact: true }).click();
  await expect(page.getByText(redirectUri, { exact: true })).toBeVisible();
});

for (const approve of [true, false]) test(`narrow consent keeps ${approve ? 'connecting' : 'cancelling'} controls readable`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockAuthorization(page);
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/oauth/authorize', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await pending;
    return route.fulfill({ json: { redirectUrl: `${redirectUri}?error=access_denied&state=synthetic-state` } });
  });
  try {
    await page.getByLabel('Employee API key').fill(apiKey);
    await page.getByRole('button', { name: approve ? 'Connect' : 'Cancel', exact: true }).click();
    const action = page.getByRole('button', { name: approve ? 'Connecting…' : 'Cancelling…', exact: true });
    await expect(action).toBeDisabled();
    const card = await page.locator('.consent-card').boundingBox();
    const button = await action.boundingBox();
    expect(card).not.toBeNull(); expect(button).not.toBeNull();
    expect(button!.x).toBeGreaterThanOrEqual(card!.x);
    expect(button!.x + button!.width).toBeLessThanOrEqual(card!.x + card!.width);
    expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { release(); }
  await expect(page).toHaveURL(`${redirectUri}?error=access_denied&state=synthetic-state`);
});

test('connect submits the employee key only in the approval body and follows the validated callback', async ({ page }) => {
  const { posts, requests } = await mockAuthorization(page);
  await page.getByLabel('Employee API key').fill(apiKey);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page).toHaveURL(`${redirectUri}?code=synthetic-code&state=synthetic-state`);
  expect(posts).toEqual([{ requestHandle: 'synthetic-browser-request', apiKey, approve: true }]);
  expect(requests.every(url => !url.includes(apiKey))).toBe(true);
  expect(page.url()).not.toContain(apiKey);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('a rejected employee key clears the input without exposing diagnostics', async ({ page }) => {
  await mockAuthorization(page, { rejectKey: true });
  await page.getByLabel('Employee API key').fill(apiKey);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.consent-card').getByRole('alert')).toContainText('invalid or expired');
  await expect(page.getByLabel('Employee API key')).toHaveValue('');
  await expect(page.getByText('Synthetic private diagnostic must not be shown.')).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('cancel declines without transmitting an entered key', async ({ page }) => {
  const { posts } = await mockAuthorization(page);
  await page.getByLabel('Employee API key').fill(apiKey);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(`${redirectUri}?error=access_denied&state=synthetic-state`);
  expect(posts).toEqual([{ requestHandle: 'synthetic-browser-request', approve: false }]);
});

test('unexpected redirect destinations fail closed and keep the key out of navigation', async ({ page }) => {
  await mockAuthorization(page, { unsafeRedirect: true });
  await page.getByLabel('Employee API key').fill(apiKey);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.consent-card').getByRole('alert')).toContainText('could not be verified');
  await expect(page.getByLabel('Employee API key')).toHaveValue('');
  expect(new URL(page.url()).pathname).toBe('/oauth/authorize');
  expect(page.url()).not.toContain(apiKey);
});

test('unavailable OAuth setup does not render a credential input', async ({ page }) => {
  await mockAuthorization(page, { unavailable: true });
  await expect(page.locator('.consent-card').getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('Employee API key')).toHaveCount(0);
});
