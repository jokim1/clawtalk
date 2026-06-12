import { test, expect, type Page, type Route } from '@playwright/test';

// Layout regression for the secondary sidebar's Inbox section. Per the Salon
// shell design, Inbox sits directly below the last talk — not pinned to the
// panel bottom. When the tree overflows, the talks scroll and Inbox stays
// anchored (visible) above the Archive footer. Guards the `flex: 0 1 auto`
// tree / `margin-top: auto` foot arrangement in styles.css.

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

const INBOX_DOCS = [
  {
    id: 'doc-weekly',
    talkId: 'talk-weekly',
    title: 'My weekly review',
    updatedAt: '2026-06-10T09:00:00.000Z',
  },
  {
    id: 'doc-scratch',
    talkId: 'talk-scratch',
    title: 'Scratchpad — ideas',
    updatedAt: '2026-06-09T15:00:00.000Z',
  },
];

function talkItem(index: number) {
  return {
    type: 'talk',
    id: `talk-${index}`,
    title: `Talk ${index}`,
    status: 'active',
    sortOrder: index,
  };
}

const FEW_TALKS_SIDEBAR = {
  mainTalkId: null,
  contents: INBOX_DOCS,
  items: [
    {
      type: 'folder',
      id: 'folder-research',
      title: 'Research',
      sortOrder: 0,
      talks: [talkItem(0)],
    },
    talkItem(1),
  ],
};

const MANY_TALKS_SIDEBAR = {
  mainTalkId: null,
  contents: INBOX_DOCS,
  items: Array.from({ length: 40 }, (_, index) => talkItem(index)),
};

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data }),
  });
}

async function installMocks(page: Page, sidebar: unknown): Promise<void> {
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar', (route) =>
    fulfillJson(route, sidebar),
  );
}

async function openTalksPage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/app/talks');
  // Tree is past its loading state once a talk link renders inside it.
  await expect(
    page.locator('.ct-secondary-tree').getByRole('link').first(),
  ).toBeVisible();
}

test('inbox hugs the last talk when the tree is short', async ({
  page,
}, testInfo) => {
  await installMocks(page, FEW_TALKS_SIDEBAR);
  await openTalksPage(page);

  const aside = await page.locator('.ct-secondary').boundingBox();
  const tree = await page.locator('.ct-secondary-tree').boundingBox();
  const inbox = await page.locator('.ct-secondary-content').boundingBox();
  const foot = await page.locator('.ct-secondary-foot').boundingBox();
  if (!aside || !tree || !inbox || !foot)
    throw new Error('layout boxes missing');

  // Inbox starts within a whisker of the tree's bottom edge (its own
  // 0.45rem margin), i.e. it is not pushed down the panel.
  expect(inbox.y - (tree.y + tree.height)).toBeLessThan(24);
  expect(inbox.y).toBeLessThan(aside.y + aside.height / 2);

  // Archive footer stays pinned to the panel bottom.
  expect(aside.y + aside.height - (foot.y + foot.height)).toBeLessThan(8);

  await page
    .locator('.ct-secondary')
    .screenshot({ path: testInfo.outputPath('sidebar-inbox-hug.png') });
});

test('inbox anchors at the bottom and the tree scrolls when talks overflow', async ({
  page,
}, testInfo) => {
  await installMocks(page, MANY_TALKS_SIDEBAR);
  await openTalksPage(page);

  // The tree absorbed the overflow and scrolls internally.
  const treeScrolls = await page
    .locator('.ct-secondary-tree')
    .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(treeScrolls).toBe(true);

  // Inbox stays on-screen at the bottom of the panel instead of scrolling away.
  const inboxLocator = page.locator('.ct-secondary-content');
  await expect(inboxLocator).toBeInViewport();
  const aside = await page.locator('.ct-secondary').boundingBox();
  const inbox = await inboxLocator.boundingBox();
  if (!aside || !inbox) throw new Error('layout boxes missing');
  expect(inbox.y).toBeGreaterThan(aside.y + aside.height / 2);

  await page
    .locator('.ct-secondary')
    .screenshot({ path: testInfo.outputPath('sidebar-inbox-anchored.png') });
});
