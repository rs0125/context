import { expect, test, type Page } from '@playwright/test';

// Every console request is intercepted: these tests never contact a real login or
// database, and every employee, key, and document below is synthetic.
const token = `wog_ctx_${'A'.repeat(43)}`;
const rotatedToken = `wog_ctx_${'B'.repeat(43)}`;
const adminPassword = 'synthetic-admin-password-for-browser-tests';
const scopes = ['knowledge:read', 'warehouses:read', 'crm:read'];
const fixturePage = {
  id: 'sample-guide', title: 'Sample guide', summary: 'Synthetic browser fixture.',
  status: 'reviewed', scopes: ['knowledge:read'], updatedAt: '2026-09-25',
  revision: '123', body: '# Sample guide\n\nConfirm uncertain information with its source.',
};

async function mockConsole(page: Page, options: { admin?: boolean; enabled?: boolean; signedIn?: boolean; conflict?: boolean } = {}) {
  const { admin = false, enabled = true, signedIn = true, conflict = false } = options;
  let authenticated = signedIn;
  const mutations: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  let key = { id: 'synthetic-key', token, expiresAt: '2026-10-25T00:00:00.000Z', scopes };
  let currentPage = { ...fixturePage };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedText: string }).copiedText = text; },
    } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'Cache-Control': 'no-store' } });
    if (method !== 'GET') mutations.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
    if (path === '/api/auth/login') {
      if (request.postDataJSON()?.password !== adminPassword) return reply({ error: { code: 'INVALID_PASSWORD', message: 'Invalid administrator password.' } }, 401);
      authenticated = true;
      return reply({ ok: true });
    }
    if (path === '/api/console/me') return authenticated
      ? reply({ employee: { name: 'Alex Example', email: 'alex@example.test', isAdmin: admin, scopes }, apiBaseUrl: 'https://context.example.test/api/v1', capabilities: { writesEnabled: enabled } })
      : reply({ error: { code: 'CONSOLE_UNAUTHENTICATED', message: 'Sign in.' } }, 401);
    if (path === '/api/console/key') {
      if (method === 'POST') key = { ...key, token: rotatedToken };
      return reply({ key });
    }
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
    if (path === '/api/auth/logout') return reply({ ok: true });
    return reply({ error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'No real API requests are allowed in this browser test.' } }, 500);
  });
  await page.goto('/');
  return mutations;
}

test('admin password sign-in is clear and responsive', async ({ page }, testInfo) => {
  await mockConsole(page, { signedIn: false });
  await expect(page.getByLabel('Admin password')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sign-in-mobile.png'), fullPage: true });
});

test('password login clears rejected input and opens the admin workspace on success', async ({ page }) => {
  await mockConsole(page, { signedIn: false, admin: true });
  await page.getByLabel('Admin password').fill('incorrect-synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Admin password')).toHaveValue('');
  await expect(page.locator('.login-card [role=alert]')).toBeVisible();
  await page.getByLabel('Admin password').fill(adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Knowledge' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('employee copies instructions and own key, then confirms rotation', async ({ page }, testInfo) => {
  const mutations = await mockConsole(page);
  await expect(page.getByRole('button', { name: 'Knowledge', exact: true })).toHaveCount(0);
  await expect(page.locator('input#personal-key')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Copy instructions', exact: true }).click();
  const prompt = await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText);
  expect(prompt).toContain('verification');
  expect(prompt).not.toContain(token);
  await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(token);
  await page.getByRole('button', { name: 'Copy complete setup', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toContain(token);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.screenshot({ path: testInfo.outputPath('agent-access.png'), fullPage: true });
  await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(mutations).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Rotate key', exact: true }).click();
  await expect(page.locator('input#personal-key')).toHaveValue(rotatedToken);
  expect(mutations).toEqual([{ path: '/api/console/key', method: 'POST', body: null }]);
});

test('admin edits with revisions and protects unsaved work', async ({ page }, testInfo) => {
  const mutations = await mockConsole(page, { admin: true });
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: /Sample guide/ }).click();
  await expect(page.getByLabel('Page ID')).toBeDisabled();
  await page.getByLabel('Markdown content').fill('# Sample guide\n\nEdited synthetic information.');
  await page.getByRole('button', { name: 'Agent access', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Markdown content')).toContainText('Edited synthetic');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(mutations[0]).toMatchObject({ method: 'PUT', body: { revision: '123', id: 'sample-guide', status: 'reviewed' } });
  await page.screenshot({ path: testInfo.outputPath('knowledge-editor.png'), fullPage: true });
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

test('deferred storage disables writes without preventing GUI review on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mutations = await mockConsole(page, { admin: true, enabled: false });
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  await page.getByLabel('Page title').fill('Future guide');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(mutations).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('knowledge-mobile-setup.png'), fullPage: true });
});
