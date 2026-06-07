import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the Salon-ported Talks list page (lane-o). Backend mocked
// via page.route; drives /app/talks with a populated sidebar tree so the rich
// row metadata (active run, attached doc, message count) is exercised.

const USER_ID = '44444444-4444-4444-4444-444444444444';

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

const SIDEBAR = {
  mainTalkId: null,
  contents: [],
  items: [
    {
      type: 'talk',
      id: 'talk-pricing',
      title: 'Pricing v2',
      status: 'active',
      sortOrder: 0,
      hasActiveRun: true,
      hasContent: true,
      messageCount: 12,
      lastMessageAt: '2026-06-07T11:30:00.000Z',
    },
    {
      type: 'folder',
      id: 'folder-research',
      title: 'Research',
      sortOrder: 1,
      talks: [
        {
          type: 'talk',
          id: 'talk-interviews',
          title: 'Customer Interviews',
          status: 'active',
          sortOrder: 0,
          messageCount: 3,
          lastMessageAt: '2026-06-05T09:00:00.000Z',
        },
      ],
    },
    {
      type: 'talk',
      id: 'talk-bare',
      title: 'Untitled scratchpad',
      status: 'active',
      sortOrder: 2,
    },
  ],
};

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
    fulfillJson(route, SIDEBAR),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Talks list renders at ${vp.label}`, async ({ page }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/app/talks');

    // Salon page header.
    await expect(page.getByRole('heading', { name: 'Talks' })).toBeVisible();

    // Each flattened talk (top-level + nested) renders as a link into the Talk.
    await expect(
      page.getByRole('link', { name: /Pricing v2/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Customer Interviews/i }).first(),
    ).toBeVisible();

    // Rich metadata: streaming pill + message count for the active talk.
    await expect(page.getByText('Streaming').first()).toBeVisible();
    await expect(page.getByText('12 messages')).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`talk-list-${vp.label}.png`),
      fullPage: true,
    });
  });
}
