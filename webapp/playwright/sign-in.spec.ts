import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the Salon-ported SignInView (lane-o). The pre-auth surface
// renders when /session/me is 401; backend mocked via page.route. Dev mode is
// enabled so the screenshot also covers the Salon Input fields in the dev form.

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(
      status >= 400
        ? { ok: false, error: { message: 'unauthorized' } }
        : { ok: true, data },
    ),
  });
}

async function installMocks(page: Page): Promise<void> {
  // Catch-all first; specific routes registered after win (Playwright LIFO).
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me', (route) =>
    fulfillJson(route, null, 401),
  );
  await page.route('**/api/v1/auth/config', (route) =>
    fulfillJson(route, { devMode: true }),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Sign-in renders at ${vp.label}`, async ({ page }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/app/talks');

    await expect(page.getByRole('heading', { name: 'ClawTalk' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Continue With Google' }),
    ).toBeVisible();
    // Dev quick-login form (Salon Input fields) shown under dev mode.
    await expect(
      page.getByRole('heading', { name: 'Developer Quick Login' }),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`sign-in-${vp.label}.png`),
      fullPage: true,
    });
  });
}
