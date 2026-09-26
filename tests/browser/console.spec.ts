import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Every console request is intercepted: these tests never contact a real login or
// database, and every employee, key, and document below is synthetic.
const token = `wog_ctx_${'A'.repeat(43)}`;
const rotatedToken = `wog_ctx_${'B'.repeat(43)}`;
const scopes = ['knowledge:read', 'warehouses:read', 'crm:read'];
const fixturePage = {
  id: 'sample-guide', title: 'Sample guide', summary: 'Synthetic browser fixture.',
  status: 'reviewed', scopes: ['knowledge:read'], updatedAt: '2026-09-25',
  revision: '123', body: '# Sample guide\n\nConfirm uncertain information with its source.',
};

test.beforeAll(async () => { await mkdir('previews', { recursive: true }); });
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (?:401|403|409)\b/.test(message.text())) errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

async function screenshot(page: Page, filename: string) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `previews/${filename}`, fullPage: true,
    style: 'nextjs-portal { display: none !important; }' });
}

type ConsoleControl = { signedIn: boolean; admin: boolean; email?: string; scopes?: string[] };
async function mockConsole(page: Page, options: { admin?: boolean; enabled?: boolean; signedIn?: boolean; conflict?: boolean; employeeScopes?: string[]; keyScopes?: string[]; entryPath?: string; control?: ConsoleControl; shared?: boolean; expiresAt?: string } = {}) {
  const { admin = false, enabled = true, signedIn = true, conflict = false, employeeScopes = scopes, keyScopes = employeeScopes, entryPath = '/' } = options;
  let authenticated = signedIn;
  const mutations: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  let key = { id: 'synthetic-key', token, expiresAt: options.expiresAt ?? '2026-10-25T00:00:00.000Z', scopes: keyScopes };
  let currentPage = { ...fixturePage };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedText: string }).copiedText = text; },
    } });
  });
  // Separate navigations keep every hop interceptable. A fulfilled HTTP redirect
  // can bypass the next Playwright route handler; never contact real Google.
  const navigation = (destination: string) => `<script>location.replace(${JSON.stringify(destination)})</script>`;
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html',
    body: navigation('http://localhost:3000/api/auth/google/callback?code=synthetic-code&state=synthetic-state') }));
  await (options.shared ? page.context() : page).route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'Cache-Control': 'no-store' } });
    if (method !== 'GET') mutations.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
    if (path === '/api/auth/login') {
      if (method !== 'GET') return reply({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use Google sign-in.' } }, 405);
      return route.fulfill({ contentType: 'text/html', body: navigation('https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client') });
    }
    if (path === '/api/auth/google/callback') {
      authenticated = true;
      return route.fulfill({ contentType: 'text/html', body: navigation('/') });
    }
    if (path === '/api/console/me') return (options.control?.signedIn ?? authenticated)
      ? reply({ employee: { name: 'Alex Example', email: options.control?.email ?? 'employee@wareongo.com', isAdmin: options.control?.admin ?? admin, scopes: options.control?.scopes ?? employeeScopes }, apiBaseUrl: 'https://context.example.test/api/v1', capabilities: { writesEnabled: enabled } })
      : reply({ error: { code: 'CONSOLE_UNAUTHENTICATED', message: 'Sign in.' } }, 401);
    if (path === '/api/console/key') {
      if (method === 'POST') key = { ...key, token: rotatedToken };
      return reply({ key });
    }
    if (path.startsWith('/api/console/knowledge') && !(options.control?.admin ?? admin)) return reply({ error: { code: 'ADMIN_REQUIRED', message: 'Administrator access is required to edit knowledge.' } }, 403);
    if (path === '/api/console/knowledge') {
      if (method === 'GET') return reply({ pages: [currentPage] });
      const body = request.postDataJSON();
      currentPage = { ...body, updatedAt: '2026-09-25', revision: '125' };
      return reply({ page: currentPage }, 201);
    }
    if (path === '/api/console/knowledge/sample-guide') {
      if (method === 'GET') return reply({ page: currentPage });
      if (conflict) return reply({ error: { code: 'REVISION_CONFLICT', message: 'Another administrator changed this page. Load the latest version before saving.' } }, 409);
      currentPage = { ...request.postDataJSON(), updatedAt: '2026-09-25', revision: '124' };
      return reply({ page: currentPage });
    }
    if (path === '/api/auth/logout') { authenticated = false; if (options.control) options.control.signedIn = false; return reply({ signedOut: true }); }
    return reply({ error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'No real API requests are allowed in this browser test.' } }, 500);
  });
  await page.goto(entryPath);
  return mutations;
}

test('Google sign-in is clear and responsive', async ({ page }) => {
  await mockConsole(page, { signedIn: false });
  await expect(page.getByRole('heading', { name: 'Sign in with your work account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/login');
  await expect(page.locator('.login-card')).toContainText('@wareongo.com');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText('Admin sign in', { exact: true })).toHaveCount(0);
  await screenshot(page, 'google-sign-in-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, 'google-sign-in-mobile.png');
});

test('Google starts with GET and returns the employee to their own workspace', async ({ page }) => {
  const mutations = await mockConsole(page, { signedIn: false, employeeScopes: ['knowledge:read', 'warehouses:read'] });
  const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/login');
  const google = page.waitForRequest(request => new URL(request.url()).origin === 'https://accounts.google.com');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  expect((await started).method()).toBe('GET');
  expect((await started).postData()).toBeNull();
  expect((await google).method()).toBe('GET');
  await expect(page.getByLabel('Employee API key')).toHaveValue(token);
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Your read access' })).toHaveText('Company knowledgeWarehouse context');
  expect(mutations).toHaveLength(0);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

for (const [code, message] of [
  ['google_cancelled', 'Google sign-in was cancelled'],
  ['google_denied', 'active @wareongo.com employee account'],
  ['google_invalid', 'expired or could not be verified'],
  ['google_unavailable', 'unavailable right now'],
  ['untrusted-provider-message', 'Google sign-in could not be completed'],
] as const) test(`Google callback explains ${code} without retaining it in the URL`, async ({ page }) => {
  await mockConsole(page, { signedIn: false, entryPath: `/?error=${code}` });
  await expect(page.locator('.login-card [role=alert]')).toContainText(message);
  await expect(page.locator('.login-card')).not.toContainText(code);
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});

test('employee follows the three-step setup and copies URL and key separately', async ({ page }) => {
  const mutations = await mockConsole(page);
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toHaveCount(0);
  await expect(page.locator('input#personal-key')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('list', { name: 'Connect Claude in three steps' }).locator(':scope > li')).toHaveCount(3);
  await expect(page.getByLabel('Connector URL')).toHaveValue('https://context.example.test/mcp');
  await expect(page.getByLabel('REST instructions')).not.toBeVisible();
  await expect(page.getByText('This key gives access as')).toContainText('employee@wareongo.com');
  await expect(page.getByRole('list', { name: 'Your read access' })).toContainText('CRM context');
  await expect(page.getByText('CRM records follow your permissions in Twenty.')).toBeVisible();
  await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe('https://context.example.test/mcp');
  await page.getByRole('button', { name: 'Copy key', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(token);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await screenshot(page, 'google-employee-access.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, 'google-employee-access-mobile.png');
  await page.getByText('Other AI tools & API details', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy instructions', exact: true }).click();
  const prompt = await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText);
  expect(prompt).toContain('verification');
  expect(prompt).toContain('Pasting this text into an ordinary chat does not connect the API');
  expect(prompt).not.toContain(token);
  await page.getByText('Key settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Replace key', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(mutations).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Replace key', exact: true }).click();
  await expect(page.locator('input#personal-key')).toHaveValue(rotatedToken);
  expect(mutations).toEqual([{ path: '/api/console/key', method: 'POST', body: null }]);
});

test('admin knowledge access does not widen the employee key read scopes', async ({ page }) => {
  await mockConsole(page, { admin: true, employeeScopes: scopes, keyScopes: ['knowledge:read'] });
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByLabel('Employee API key')).toHaveValue(token);
  await expect(page.getByRole('list', { name: 'Your read access' })).toHaveText('Company knowledge');
  await expect(page.getByText('CRM records follow your permissions in Twenty.')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'but this key does not' })).toBeVisible();
  await screenshot(page, 'google-admin-access.png');
});

test('admin edits with revisions and protects unsaved work', async ({ page }) => {
  const mutations = await mockConsole(page, { admin: true });
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: /Sample guide/ }).click();
  await expect(page.getByLabel('Page ID')).toBeDisabled();
  await page.getByLabel('Markdown content').fill('# Sample guide\n\nEdited synthetic information.');
  await page.getByRole('button', { name: 'Connect Claude', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Markdown content')).toContainText('Edited synthetic');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(mutations[0]).toMatchObject({ method: 'PUT', body: { revision: '123', id: 'sample-guide', status: 'reviewed' } });
  await screenshot(page, 'google-knowledge-editor.png');
});

test('Markdown import stays draft until explicitly published', async ({ page }) => {
  const mutations = await mockConsole(page, { admin: true });
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByLabel('Import a Markdown file').setInputFiles({
    name: 'imported-guide.md', mimeType: 'text/markdown',
    buffer: Buffer.from('---\ntitle: Imported guide\nsummary: Synthetic import\nstatus: reviewed\nscopes:\n- knowledge:read\n- crm:read\n---\n# Imported guide\n\nSynthetic imported body.'),
  });
  await expect(page.getByLabel('Publication status')).toHaveValue('draft');
  await expect(page.getByLabel('Markdown content')).toHaveValue('# Imported guide\n\nSynthetic imported body.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(mutations[0]).toMatchObject({ method: 'POST', body: { status: 'draft', scopes: ['knowledge:read', 'crm:read'] } });
});

test('conflict preserves local edits for the administrator', async ({ page }) => {
  await mockConsole(page, { admin: true, conflict: true });
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: /Sample guide/ }).click();
  await page.getByLabel('Markdown content').fill('My unsaved version');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page editor' }).getByRole('alert')).toContainText('Your edits are still here');
  await expect(page.getByLabel('Markdown content')).toHaveValue('My unsaved version');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Load latest' })).toBeVisible();
});

test('deferred storage disables writes without preventing GUI review on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mutations = await mockConsole(page, { admin: true, enabled: false });
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  await page.getByLabel('Page title').fill('Future guide');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(mutations).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, 'google-knowledge-mobile-setup.png');
});

test('another tab logout clears the previously loaded employee key', async ({ page, context }) => {
  const control = { signedIn: true, admin: false };
  await mockConsole(page, { control, shared: true });
  await expect(page.getByLabel('Employee API key')).toHaveValue(token);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByLabel('Employee API key')).toHaveValue(token);
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(other.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByLabel('Employee API key')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});

test('live administrator denial clears stale knowledge and permissions', async ({ page }) => {
  const control = { signedIn: true, admin: true };
  await mockConsole(page, { control });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /Sample guide/ }).click();
  await expect(page.getByLabel('Markdown content')).toHaveValue(fixturePage.body);
  control.admin = false;
  await page.getByRole('button', { name: 'Refresh page list' }).click();
  await expect(page.getByLabel('Markdown content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toHaveCount(0);
});

test('focus preserves same-employee unsaved work and clears it when permissions change', async ({ page }) => {
  const control = { signedIn: true, admin: true, scopes };
  await mockConsole(page, { control });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /Sample guide/ }).click();
  await page.getByLabel('Markdown content').fill('Unsaved synthetic changes');
  const sameRefresh = page.waitForResponse(response => response.url().endsWith('/api/console/me'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sameRefresh;
  await expect(page.getByLabel('Markdown content')).toHaveValue('Unsaved synthetic changes');
  control.admin = false;
  control.scopes = ['knowledge:read'];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Markdown content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Your read access' })).toHaveText('Company knowledge');
});

test('an expired open-page key is removed without polling the database', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-26T00:00:00Z') });
  let keyReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/console/key') keyReads += 1; });
  await mockConsole(page, { expiresAt: '2026-09-26T00:00:30Z' });
  await expect(page.getByLabel('Employee API key')).toHaveValue(token);
  const readsBeforeExpiry = keyReads;
  await page.clock.fastForward(31_000);
  await expect(page.getByLabel('Employee API key')).toHaveCount(0);
  await expect(page.getByText('Your API key has expired.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toBeEnabled();
  expect(keyReads).toBe(readsBeforeExpiry);
});
