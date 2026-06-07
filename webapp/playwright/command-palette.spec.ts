import { test, expect, type Page, type Route } from '@playwright/test';

// E2E + responsive QA for the ⌘K command palette (lane-o Q2).
//
// Backend fully mocked via page.route (self-contained). Verifies the palette
// opens via Ctrl/Cmd+K and via the header search field, filters, navigates to
// a Talk and to a Settings tab, closes on Escape, and renders at 390/1280.

const USER_ID = '33333333-3333-3333-3333-333333333333';
const TALK_ID = '66666666-6666-6666-6666-666666666666';

function buildSession() {
  return {
    user: {
      id: USER_ID,
      email: 'playwright@clawtalk.test',
      displayName: 'Playwright',
      role: 'owner',
      createdAt: '2026-05-27T00:00:00.000Z',
    },
  };
}

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data }),
  });
}

async function installMocks(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar', (route) =>
    fulfillJson(route, {
      items: [
        {
          type: 'talk',
          id: TALK_ID,
          title: 'Strategy review',
          status: 'active',
          sortOrder: 0,
        },
      ],
      mainTalkId: null,
      contents: [],
    }),
  );
}

async function openPalette(page: Page): Promise<void> {
  await page.goto('/app/talks');
  // Settle the app shell, then open via keyboard (handler accepts ctrl or meta).
  await page
    .getByRole('button', { name: 'Create talk or folder' })
    .waitFor({ state: 'visible' });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(
      page.getByRole('combobox', { name: 'Search commands and Talks' }),
    ).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20000 });
}

test('opens with Ctrl/Cmd+K and navigates to a Talk', async ({ page }) => {
  await installMocks(page);
  await openPalette(page);

  await page
    .getByRole('combobox', { name: 'Search commands and Talks' })
    .fill('strategy');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/talks/${TALK_ID}`));
});

test('navigates to a Settings tab via the palette', async ({ page }) => {
  await installMocks(page);
  await openPalette(page);

  await page
    .getByRole('combobox', { name: 'Search commands and Talks' })
    .fill('agents');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/settings\?tab=agents/);
});

test('opens from the header search field and closes on Escape', async ({
  page,
}) => {
  await installMocks(page);
  await page.goto('/app/talks');
  await page.getByRole('searchbox', { name: 'Search' }).click();
  const combo = page.getByRole('combobox', {
    name: 'Search commands and Talks',
  });
  await expect(combo).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(combo).toHaveCount(0);
});

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`command palette renders at ${vp.label}`, async ({ page }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openPalette(page);
    await expect(
      page.getByRole('listbox', { name: 'Commands and Talks' }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`command-palette-${vp.label}.png`),
    });
  });
}
