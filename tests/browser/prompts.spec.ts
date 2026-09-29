import { expect, test, type Page } from '@playwright/test';
import { PROMPT_DEFINITIONS, type PromptDocument } from '../../src/lib/prompt-definitions';

async function mockPrompts(page: Page, options: { admin?: boolean; ready?: boolean; enabled?: boolean; conflict?: boolean } = {}) {
  const { admin = true, ready = true, enabled = true, conflict = false } = options;
  const prompts: PromptDocument[] = PROMPT_DEFINITIONS.map(prompt => ({ ...prompt, body: prompt.defaultBody, customized: false, revision: null, updatedAt: null, updatedBy: null }));
  const writes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text: string) => { (window as unknown as { copiedText: string }).copiedText = text; } } }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/console/me') return reply({ employee: { name: 'Alex Example', email: 'admin@wareongo.com', isAdmin: admin, scopes: ['knowledge:read'] },
      apiBaseUrl: 'https://context.example.test/api/v1', restPromptTemplate: prompts.find(prompt => prompt.id === 'rest')!.body, capabilities: { writesEnabled: enabled } });
    if (path === '/api/console/key') return reply({ key: { id: 'synthetic-key', token: `wog_ctx_${'A'.repeat(43)}`, scopes: ['knowledge:read'], expiresAt: '2099-01-01T00:00:00Z' } });
    if (path === '/api/console/prompts') {
      if (!admin) return reply({ error: { code: 'ADMIN_REQUIRED', message: 'Admin access required.' } }, 403);
      if (request.method() === 'GET') return reply({ prompts, storageReady: ready, writesEnabled: enabled });
      const body = request.postDataJSON(); writes.push(body);
      const prompt = prompts.find(prompt => prompt.id === body.id)!;
      if (conflict) {
        prompt.body = 'Latest version from another administrator.';
        prompt.revision = '00000000-0000-4000-8000-000000000010'; prompt.customized = true;
        return reply({ error: { code: 'REVISION_CONFLICT', message: 'Another administrator changed this prompt. Copy any edits you want to keep, then load the latest version. Your changes were not saved.' } }, 409);
      }
      Object.assign(prompt, { body: body.body ?? prompt.defaultBody, customized: body.body !== null,
        revision: `00000000-0000-4000-8000-${String(writes.length).padStart(12, '0')}`, updatedAt: '2026-09-30T12:00:00Z', updatedBy: 'admin@wareongo.com' });
      return reply({ prompt });
    }
    return reply({ error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'Only synthetic requests are allowed.' } }, 500);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Connect Claude', exact: true })).toBeVisible();
  return { prompts, writes, errors };
}

test('admin edits shared and per-tool prompts and sees saved content after reloading', async ({ page }, testInfo) => {
  const state = await mockPrompts(page);
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await expect(page.getByLabel('Prompt text')).toHaveValue(PROMPT_DEFINITIONS[0].defaultBody);
  await page.getByLabel('Prompt text').fill('Use the current sources and explain uncertainty.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect(state.writes[0]).toEqual({ id: 'mcp', body: 'Use the current sources and explain uncertainty.', revision: null });
  await page.getByLabel('Search prompts').fill('search_warehouses');
  await page.getByRole('button', { name: 'Search warehouses Default', exact: true }).click();
  await page.getByLabel('Prompt text').fill('Search warehouses by the requested specifications.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled();
  expect(state.writes[1].id).toBe('tool.search_warehouses');
  await page.reload();
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await expect(page.getByLabel('Prompt text')).toHaveValue('Use the current sources and explain uncertainty.');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('prompts-desktop.png'), fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  expect(state.errors).toEqual([]);
});

test('unsaved edits are protected and restoring defaults requires saving', async ({ page }) => {
  const { writes, errors } = await mockPrompts(page);
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByLabel('Prompt text').fill('Saved override.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled();
  await page.getByLabel('Prompt text').fill('Unsaved draft.');
  await page.getByRole('button', { name: 'Analytics instructions Default', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Prompt text')).toHaveValue('Unsaved draft.');
  await page.getByRole('button', { name: 'Connect Claude', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('unsaved changes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Restore default', exact: true }).click();
  await expect(page.getByLabel('Prompt text')).toHaveValue(PROMPT_DEFINITIONS[0].defaultBody);
  expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled();
  expect(writes[1]).toEqual({ id: 'mcp', body: null, revision: '00000000-0000-4000-8000-000000000001' });
  expect(errors).toEqual([]);
});

test('a save conflict keeps the draft until the admin chooses to load the latest version', async ({ page }) => {
  const { errors } = await mockPrompts(page, { conflict: true });
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByLabel('Prompt text').fill('Keep this draft.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Another administrator' })).toBeVisible();
  await expect(page.getByLabel('Prompt text')).toHaveValue('Keep this draft.');
  await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Load latest', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByLabel('Prompt text')).toHaveValue('Latest version from another administrator.');
  expect(errors).toEqual([]);
});

test('the edited REST template is used by the connection page copy action', async ({ page }) => {
  const { errors } = await mockPrompts(page);
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByRole('button', { name: 'REST setup prompt Default', exact: true }).click();
  await page.getByLabel('Prompt text').fill('Use {{apiBaseUrl}}/context and cite the results.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'updated instructions' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Claude', exact: true }).click();
  await page.getByText('Other AI tools & API details', { exact: true }).click();
  await expect(page.getByLabel('REST instructions')).toHaveValue('Use https://context.example.test/api/v1/context and cite the results.');
  await page.getByRole('button', { name: 'Copy instructions', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe('Use https://context.example.test/api/v1/context and cite the results.');
  expect(errors).toEqual([]);
});

test('employees have no prompt editing navigation', async ({ page }) => {
  await mockPrompts(page, { admin: false });
  await expect(page.getByRole('button', { name: 'Prompts', exact: true })).toHaveCount(0);
});

test('prompt setup state is clear and the editor fits a phone', async ({ page }, testInfo) => {
  const { writes, errors } = await mockPrompts(page, { ready: false });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'waiting for workspace setup' })).toBeVisible();
  await page.getByLabel('Prompt text').fill('A prepared draft.');
  await expect(page.getByRole('button', { name: 'Save prompt', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('prompts-mobile.png'), fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  expect(writes).toHaveLength(0); expect(errors).toEqual([]);
});
