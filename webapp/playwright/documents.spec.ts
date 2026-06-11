import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the native Documents surface (lane-o). Backend mocked via
// page.route over the native /api/v1/documents list + detail routes; drives the
// Documents index and the document viewer/review console at desktop + mobile.

const USER_ID = '33333333-3333-3333-3333-333333333333';

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

const SUMMARY = {
  id: 'doc-1',
  workspaceId: 'ws-1',
  primaryTalkId: 'talk-1',
  folderId: null,
  title: 'Launch brief',
  format: 'markdown',
  wordCount: 240,
  lastEditAt: '2026-06-02T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  tabCount: 1,
  blockCount: 2,
  pendingEditCount: 1,
};

const DOCUMENT = {
  ...SUMMARY,
  tabs: [
    {
      id: 'tab-1',
      documentId: 'doc-1',
      title: 'Main',
      sortOrder: 0,
      listVersion: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      blocks: [
        {
          id: 'block-1',
          documentId: 'doc-1',
          tabId: 'tab-1',
          sortOrder: 0,
          version: 1,
          kind: 'h1',
          text: 'Launch brief',
          attrs: {},
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 'block-2',
          documentId: 'doc-1',
          tabId: 'tab-1',
          sortOrder: 1,
          version: 1,
          kind: 'p',
          text: 'Original paragraph about the launch.',
          attrs: {},
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    },
  ],
  pendingEdits: [
    {
      id: 'edit-1',
      documentId: 'doc-1',
      tabId: 'tab-1',
      blockId: 'block-2',
      baseBlockVersion: 1,
      baseListVersion: null,
      afterBlockId: null,
      proposedByAgentId: 'agent-1',
      proposedByAgentName: 'Strategist',
      proposedByRunId: 'run-1',
      op: 'replace',
      newKind: null,
      newText: 'Revised paragraph about the launch timeline.',
      newAttrs: null,
      status: 'pending',
      source: 'agent',
      createdAt: '2026-06-02T00:00:00.000Z',
      resolvedAt: null,
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
    fulfillJson(route, { items: [], mainTalkId: null, contents: [] }),
  );
  // List, then detail registered last so the more specific detail wins (LIFO).
  await page.route('**/api/v1/documents**', (route) =>
    fulfillJson(route, { documents: [SUMMARY] }),
  );
  await page.route('**/api/v1/documents/doc-1**', (route) =>
    fulfillJson(route, { document: DOCUMENT }),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Documents index + viewer render at ${vp.label}`, async ({
    page,
  }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // Index: the document and its pending-edit badge.
    await page.goto('/app/documents');
    await expect(
      page.getByRole('heading', { name: 'Documents' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Launch brief' })).toBeVisible();
    await expect(page.getByText('1 pending')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`documents-index-${vp.label}.png`),
      fullPage: true,
    });

    // Viewer: native blocks + the pending-edit review console. The block text
    // appears both in the body article and as the edit's "Current" preview, so
    // scope the body assertion to the article to stay unambiguous.
    await page.getByRole('link', { name: 'Launch brief' }).click();
    await expect(
      page.locator('article').getByText('Original paragraph about the launch.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Pending edits' }),
    ).toBeVisible();
    await expect(page.getByText('Replace paragraph')).toBeVisible();
    await expect(
      page.getByText('Revised paragraph about the launch timeline.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Accept replace paragraph' }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`documents-viewer-${vp.label}.png`),
      fullPage: true,
    });
  });
}
