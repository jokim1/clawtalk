import { test, expect, type Page, type Route } from '@playwright/test';

// E2E + responsive QA for the Salon New Talk sheet (lane-o Q3).
//
// Backend is fully mocked via page.route (no Worker / Supabase needed), the
// same self-contained pattern as snappy-load.spec.ts. Verifies the sheet
// opens from the sidebar "+" menu, creates a Talk with the typed title, and
// renders correctly at mobile (390px) and desktop (1280px) widths.

const USER_ID = '33333333-3333-3333-3333-333333333333';
const NEW_TALK_ID = '55555555-5555-5555-5555-555555555555';

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

type CreateCapture = { lastTitle: string | null };

async function installMocks(page: Page, capture: CreateCapture): Promise<void> {
  // Catch-all first (LIFO) so the specific handlers below win.
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar', (route) =>
    fulfillJson(route, { items: [], mainTalkId: null, contents: [] }),
  );
  await page.route('**/api/v1/talks', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { title?: string };
      capture.lastTitle = body?.title ?? null;
      const now = '2026-06-06T00:00:00.000Z';
      return fulfillJson(route, {
        talk: {
          id: NEW_TALK_ID,
          ownerId: USER_ID,
          folderId: null,
          sortOrder: 0,
          title: capture.lastTitle ?? '',
          orchestrationMode: 'ordered',
          status: 'active',
          version: 1,
          createdAt: now,
          updatedAt: now,
          accessRole: 'owner',
        },
      });
    }
    return fulfillJson(route, {
      talks: [],
      page: { limit: 50, offset: 0, count: 0 },
    });
  });
}

async function openSheet(page: Page): Promise<void> {
  // Drive from /app/talks (not /app/home): the sidebar "+" lives in the shared
  // app chrome, and the talks list renders cleanly on an empty mock, whereas
  // HomePage's NewsPreview throws on the empty Home fixture.
  await page.goto('/app/talks');
  const addBtn = page.getByRole('button', { name: 'Create talk or folder' });
  const newTalkBtn = page.getByRole('button', { name: 'New Talk' });
  await addBtn.waitFor({ state: 'visible' });
  // The app shell re-renders during boot; retry opening the create menu
  // idempotently (only click "+" when the menu isn't already open) until the
  // New Talk item is present, then open the sheet.
  await expect(async () => {
    if (!(await newTalkBtn.isVisible())) {
      await addBtn.click({ timeout: 1500 });
    }
    await expect(newTalkBtn).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20000 });
  await newTalkBtn.click();
  await expect(page.getByRole('heading', { name: 'New Talk' })).toBeVisible();
}

test('opens the New Talk sheet and creates a Talk with the typed title', async ({
  page,
}) => {
  const capture: CreateCapture = { lastTitle: null };
  await installMocks(page, capture);

  await openSheet(page);
  const input = page.getByLabel('Title');
  await expect(input).toBeFocused();
  await input.fill('Strategy review');
  await page.getByRole('button', { name: 'Create Talk', exact: true }).click();

  // Sheet closes and the create POST carried the trimmed title.
  await expect(page.getByRole('heading', { name: 'New Talk' })).toHaveCount(0);
  expect(capture.lastTitle).toBe('Strategy review');
});

test('returns focus to the sidebar + trigger when dismissed with Escape', async ({
  page,
}) => {
  const capture: CreateCapture = { lastTitle: null };
  await installMocks(page, capture);

  await openSheet(page);
  await page.keyboard.press('Escape');

  await expect(page.getByRole('heading', { name: 'New Talk' })).toHaveCount(0);
  // The "+" trigger stays mounted, so focus must return to it (not <body>).
  await expect(
    page.getByRole('button', { name: 'Create talk or folder' }),
  ).toBeFocused();
});

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`New Talk sheet renders at ${vp.label}`, async ({ page }, testInfo) => {
    const capture: CreateCapture = { lastTitle: null };
    await installMocks(page, capture);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await openSheet(page);
    await expect(page.getByLabel('Title')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create Talk', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Responsive-render artifact (lands under test-results/, attached to the report).
    await page.screenshot({
      path: testInfo.outputPath(`new-talk-${vp.label}.png`),
    });
  });
}
