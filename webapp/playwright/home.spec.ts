import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive smoke for the Salon Home surface. Backend is mocked through
// page.route so this covers rendered Home lifecycle behavior without Worker,
// Supabase, OAuth, or manual auth.

const USER_ID = '33333333-3333-3333-3333-333333333333';
const INBOX_TITLE = 'Review blocked output';
const NEWS_TITLE = 'Market signal changed';

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
    fulfillJson(route, { items: [], mainTalkId: null, contents: [] }),
  );
  await page.route('**/api/v1/home/summary', (route) =>
    fulfillJson(route, {
      workspaceId: 'ws-1',
      curator: {
        kind: 'inbox',
        title: INBOX_TITLE,
        summary: 'A scheduled job needs review.',
        itemId: 'i1',
        target: { kind: 'talk', talkId: 'talk-1' },
      },
      stats: { talks: 3, prompts: 18, tokens: 42_000, words: 1200 },
      counts: {
        inbox: { unread: 1, blocking: 0, action: 1, info: 0 },
        recommendations: 0,
        news: 1,
      },
      algorithmVersions: { inbox: 'v1', recommendations: 'v1', news: 'v1' },
    }),
  );
  await page.route('**/api/v1/home/inbox*', (route) =>
    fulfillJson(route, {
      items: [
        {
          id: 'i1',
          type: 'job_output_ready',
          title: INBOX_TITLE,
          summary: 'A scheduled job needs review.',
          reason: null,
          severity: 'action',
          status: 'unread',
          target: { kind: 'talk', talkId: 'talk-1' },
          primaryAction: {
            type: 'open_talk',
            label: 'Open',
            payload: { talkId: 'talk-1' },
          },
          secondaryActions: [],
          score: 80,
          createdAt: '2026-06-06T00:00:00.000Z',
          algorithmVersion: 'v1',
        },
      ],
      counts: { unread: 1, blocking: 0, action: 1, info: 0 },
      nextCursor: null,
      algorithmVersion: 'v1',
    }),
  );
  await page.route('**/api/v1/home/recommendations*', (route) =>
    fulfillJson(route, {
      items: [],
      hero: null,
      thenMaybe: [],
      algorithmVersion: 'v1',
    }),
  );
  await page.route('**/api/v1/home/news*', (route) =>
    fulfillJson(route, {
      items: [
        {
          id: 'n1',
          headline: NEWS_TITLE,
          source: 'Example News',
          favicon: null,
          age: '4 h',
          excerpt: 'A relevant market update landed.',
          url: 'https://news.example/market-signal',
          talkId: 'talk-1',
          talkTitle: 'Launch',
          matchedOn: ['launch'],
          whyItMatters: 'It changes the launch recommendation.',
          impact: 'changes_assumption',
          score: 75,
          publishedAt: null,
          algorithmVersion: 'v1',
        },
      ],
      nextCursor: null,
      algorithmVersion: 'v1',
    }),
  );
  await page.route('**/api/v1/home/inbox/i1/dismiss', (route) =>
    fulfillJson(route, { id: 'i1', status: 'dismissed' }),
  );
  await page.route('**/api/v1/home/news/n1/add-to-context', (route) =>
    fulfillJson(route, {
      id: 'n1',
      status: 'added_to_context',
      sourceId: 'source-1',
    }),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Home optimistic dismiss stays coherent at ${vp.label}`, async ({
    page,
  }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await page.goto('/app/home');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expect(page.getByText(INBOX_TITLE)).toHaveCount(2);

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(page.getByText(INBOX_TITLE)).toHaveCount(0);
    await expect(page.getByText(NEWS_TITLE)).toHaveCount(2);

    await page.getByRole('button', { name: 'Add to context' }).click();

    await expect(page.getByText(NEWS_TITLE)).toHaveCount(0);
    await expect(page.getByText('Start a Talk')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`home-${vp.label}.png`),
      fullPage: true,
    });
  });
}
