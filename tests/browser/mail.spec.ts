import { expect, test } from '@playwright/test';

const connected = {
  employee: { email: 'employee@wareongo.com', name: 'Employee' },
  connection: { connected: true, accountEmail: 'employee@wareongo.com', updatedAt: '2026-10-04T00:00:00.000Z' },
  availability: { enabled: true, configured: true, available: true },
};
test('mail setup signs in, explains draft-only behavior, and preserves a clear Gmail handoff', async ({ page }) => {
  await page.route('**/api/mail/connection', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CONSOLE_UNAUTHENTICATED' } }) }));
  await page.goto('/mail');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', '/api/mail/login');
  await expect(page.getByText('It does not send email.', { exact: false })).toBeVisible();
  await page.goto('/mail?connected=1');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByText('Gmail connected. You can return to Ramesh on WhatsApp.')).toHaveCount(0);
  await page.unroute('**/api/mail/connection');
  await page.route('**/api/mail/connection', route => route.fulfill({ json: connected }));
  await page.goto('/mail?connected=1');
  await expect(page.getByRole('heading', { name: 'Gmail is connected' })).toBeVisible();
  await expect(page.getByText('Google bundles managing drafts and sending email', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Gmail' })).toBeEnabled();
  await expect(page.getByText('Find prepared messages in Gmail’s Drafts folder.', { exact: false })).toBeVisible();
  await expect(page).toHaveURL('/mail');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('disconnect stays usable when drafting is disabled, removes local access and reports the Google grant distinction', async ({ page }) => {
  let isConnected = true;
  await page.route('**/api/mail/connection', async route => {
    if (route.request().method() === 'POST') {
      isConnected = false;
      await route.fulfill({ json: { disconnected: true, googleGrantRevoked: false } });
    } else await route.fulfill({ json: { ...connected, connection: { ...connected.connection, connected: isConnected },
      availability: { enabled: false, configured: false, available: false } } });
  });
  await page.goto('/mail');
  await expect(page.getByText('Gmail drafts are not enabled or configured yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect Gmail' }).click();
  await expect(page.getByText('Disconnected from Ramesh.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Gmail' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Manage Google account permissions' })).toHaveAttribute('href', 'https://myaccount.google.com/connections');
});
