import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const connected = {
  employee: { email: 'employee@wareongo.com', name: 'Employee' },
  connection: { connected: true, status: 'active', accountEmail: 'employee@wareongo.com', updatedAt: '2026-10-04T00:00:00.000Z' },
  availability: { enabled: true, configured: true, available: true },
};

test('native Gmail connect preserves Origin and permits the Google consent navigation', async ({ page, context, baseURL }) => {
  // Use the real document headers and native form. Only API responses are mocked.
  // Redirect-chain requests bypass page.route, so take the browser offline before
  // submitting and observe the Google navigation without sending it to Google.
  const origin = new URL(baseURL!).origin;
  const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state';
  let postedOrigin: string | undefined;
  const cspViolations: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('form-action')) cspViolations.push(message.text());
  });
  await page.route('**/api/mail/connection', route => route.fulfill({ json: {
    ...connected, connection: { ...connected.connection, connected: false, status: 'disconnected', accountEmail: null },
  } }));
  await page.route('**/api/mail/google/connect', async route => {
    expect(route.request().method()).toBe('POST');
    postedOrigin = route.request().headers().origin;
    await route.fulfill({ status: 303, headers: { Location: googleUrl, 'Referrer-Policy': 'no-referrer' }, body: '' });
  });
  const response = await page.goto('/mail');
  expect(response?.headers()['referrer-policy']).toBe('same-origin');
  expect(response?.headers()['content-security-policy']).toContain("form-action 'self' https://accounts.google.com");
  await expect(page.getByRole('button', { name: 'Connect work Gmail' })).toBeVisible();
  await context.setOffline(true);
  const requested = page.waitForEvent('request', request => request.url() === googleUrl);
  const failed = page.waitForEvent('requestfailed', request => request.url() === googleUrl);
  await page.getByRole('button', { name: 'Connect work Gmail' }).click({ noWaitAfter: true });
  const outbound = await requested, failure = await failed;
  expect(postedOrigin).toBe(origin);
  expect(outbound.method()).toBe('GET');
  expect(outbound.isNavigationRequest()).toBe(true);
  expect(outbound.frame()).toBe(page.mainFrame());
  expect(outbound.headers().referer).toBeUndefined();
  expect(failure.failure()?.errorText).toBe('net::ERR_INTERNET_DISCONNECTED');
  expect(cspViolations).toEqual([]);
});

test('mail form redirects to unrelated hosts remain blocked', async ({ page, context }) => {
  let externalRequested = false;
  await page.route('**/api/mail/connection', route => route.fulfill({ json: {
    ...connected, connection: { ...connected.connection, connected: false, status: 'needs_reauth' },
  } }));
  await page.route('**/api/mail/google/connect', route => route.fulfill({
    status: 303, headers: { Location: 'https://unrelated.example.test/consent' }, body: '',
  }));
  page.on('request', request => {
    if (new URL(request.url()).origin === 'https://unrelated.example.test') externalRequested = true;
  });
  await page.goto('/mail');
  await page.evaluate(() => {
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'form-action') document.documentElement.dataset.blockedForm = 'true';
    });
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Reconnect Gmail' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-blocked-form', 'true');
  expect(externalRequested).toBe(false);
});

test('browser request failures offer retry without claiming an account mismatch', async ({ page }) => {
  await page.route('**/api/mail/connection', route => route.fulfill({ json: connected }));
  await page.goto('/mail?error=origin');
  await expect(page.getByText('This connection request could not be verified.', { exact: false })).toBeVisible();
  await expect(page.getByText('Connect the same authorized @wareongo.com account', { exact: false })).toHaveCount(0);
});

test('mail setup signs in and shows a minimal success screen only after verifying the connection', async ({ page }) => {
  await page.route('**/api/mail/connection', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CONSOLE_UNAUTHENTICATED' } }) }));
  await page.goto('/mail');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', '/api/mail/login');
  await expect(page.getByText('It does not send email.', { exact: false })).toBeVisible();
  await expect(page.getByText('If Google sign-in is blocked inside WhatsApp', { exact: false })).toBeVisible();
  await page.goto('/mail?connected=1');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gmail connected', exact: true })).toHaveCount(0);
  await page.unroute('**/api/mail/connection');
  await page.route('**/api/mail/connection', route => route.fulfill({ json: connected }));
  await page.goto('/mail?connected=1');
  await expect(page.getByRole('heading', { name: 'Gmail connected', exact: true })).toBeVisible();
  await expect(page.getByText('You can close this screen.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Gmail' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reconnect Gmail' })).toHaveCount(0);
  await expect(page.getByText('Google bundles managing drafts and sending email', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your email drafts, ready to review.' })).toHaveCount(0);
  await expect(page).toHaveURL('/mail');
  await mkdir('previews', { recursive: true });
  await page.screenshot({ path: 'previews/gmail-connected-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'previews/gmail-connected-mobile.png', fullPage: true });
});

test('disconnect stays usable when drafting is disabled and reports completed Google revocation', async ({ page }) => {
  let isConnected = true;
  await page.route('**/api/mail/connection', async route => {
    if (route.request().method() === 'POST') {
      isConnected = false;
      await route.fulfill({ json: { disconnected: true, googleGrantRevoked: true, revocationPending: false } });
    } else await route.fulfill({ json: { ...connected, connection: { ...connected.connection, connected: isConnected, status: isConnected ? 'active' : 'disconnected' },
      availability: { enabled: false, configured: false, available: false } } });
  });
  await page.goto('/mail');
  await expect(page.getByText('Gmail drafts are not enabled or configured yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect Gmail' }).click();
  await expect(page.getByText('Disconnected from Ramesh and removed the app’s Google access.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Gmail' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Manage Google account permissions' })).toHaveAttribute('href', 'https://myaccount.google.com/connections');
});

test('revoked access offers reconnection without claiming the mailbox is connected', async ({ page }) => {
  await page.route('**/api/mail/connection', route => route.fulfill({ json: {
    ...connected, connection: { ...connected.connection, connected: false, status: 'needs_reauth' },
  } }));
  await page.goto('/mail');
  await expect(page.getByRole('heading', { name: 'Reconnect Gmail' })).toBeVisible();
  await expect(page.getByText('Google access expired or was removed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Gmail' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Disconnect Gmail' })).toBeEnabled();
});

test('pending Google revocation stays locally disabled, blocks reconnect and can be retried', async ({ page }) => {
  let status = 'active', attempts = 0;
  await page.route('**/api/mail/connection', async route => {
    if (route.request().method() === 'POST') {
      attempts += 1;
      status = attempts === 1 ? 'revoking' : 'disconnected';
      await route.fulfill({ status: attempts === 1 ? 202 : 200, json: {
        disconnected: true, googleGrantRevoked: attempts > 1, revocationPending: attempts === 1,
      } });
    } else await route.fulfill({ json: { ...connected, connection: { ...connected.connection, connected: status === 'active', status } } });
  });
  await page.goto('/mail');
  await page.getByRole('button', { name: 'Disconnect Gmail' }).click();
  await expect(page.getByRole('heading', { name: 'Finish disconnecting Gmail' })).toBeVisible();
  await expect(page.getByText('Ramesh has stopped using this mailbox, but Google could not finish removing access.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Gmail' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect work Gmail' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry disconnect' }).click();
  await expect(page.getByText('Disconnected from Ramesh and removed the app’s Google access.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect work Gmail' })).toBeEnabled();
});

for (const status of [503, 401]) {
  test(`manual Google cleanup remains visible when the connection check returns ${status}`, async ({ page }) => {
    await page.route('**/api/mail/connection', route => route.fulfill({ status, json: { error: { code: 'UNAVAILABLE' } } }));
    await page.goto('/mail?error=cleanup_required');
    await expect(page.getByText('Google may still have granted this app access', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage Google account permissions' })).toHaveAttribute('href', 'https://myaccount.google.com/connections');
    if (status === 503) {
      await expect(page.getByText('Could not check your Gmail connection.', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Check again' }).click();
      await expect(page.getByText('Google may still have granted this app access', { exact: false })).toBeVisible();
    } else await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page).toHaveURL('/mail');
  });
}
