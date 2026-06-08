import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the in-Talk Documents tab (lane-o). Renders the Talk detail
// page's new Documents tab over the native /api/v1/documents routes, with the
// Talk snapshot + supporting routes mocked via page.route so the suite needs no
// Worker / Supabase. Drives desktop + mobile and captures screenshots.

const TALK_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const WORKSPACE_ID = '55555555-5555-5555-5555-555555555555';

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

function buildSnapshot() {
  const now = '2026-05-27T00:00:00.000Z';
  return {
    talk: {
      id: TALK_ID,
      ownerId: USER_ID,
      workspaceId: WORKSPACE_ID,
      folderId: null,
      sortOrder: 0,
      title: 'In-Talk doc fixture',
      orchestrationMode: 'ordered' as const,
      status: 'active' as const,
      version: 1,
      createdAt: now,
      updatedAt: now,
      accessRole: 'owner' as const,
    },
    threads: [
      {
        id: THREAD_ID,
        talkId: TALK_ID,
        title: 'Main',
        isDefault: true,
        isInternal: false,
        isPinned: false,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessageAt: now,
      },
    ],
    activeThreadId: THREAD_ID,
    messages: [],
    hasOlderMessages: false,
    content: null,
    pendingEdits: [],
    runs: [],
    agents: [],
    snapshotVersion: 1,
  };
}

const SUMMARY = {
  id: 'doc-1',
  workspaceId: WORKSPACE_ID,
  primaryTalkId: TALK_ID,
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
  // LIFO: register the catch-all first so specific handlers below win. The
  // Talk's workspace makes the client append `?workspaceId=…` to scoped
  // requests, so every specific pattern ends in `*` to match with a query.
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me*', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config*', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar*', (route) =>
    fulfillJson(route, { items: [], mainTalkId: TALK_ID, contents: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/snapshot*`, (route) =>
    fulfillJson(route, buildSnapshot()),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/runs*`, (route) =>
    fulfillJson(route, { runs: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/agents*`, (route) =>
    fulfillJson(route, { agents: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/context*`, (route) =>
    fulfillJson(route, { goal: null, rules: [], sources: [] }),
  );
  await page.route('**/api/v1/agents*', (route) =>
    fulfillJson(route, {
      defaultClaudeModelId: '',
      claudeModelSuggestions: [],
      additionalProviders: [],
    }),
  );
  await page.route('**/api/v1/registered-agents*', (route) =>
    fulfillJson(route, []),
  );
  // Document list, then detail registered last so the more specific detail
  // route wins (LIFO).
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
  test(`Talk Documents tab renders at ${vp.label}`, async ({
    page,
  }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await page.goto(`/app/talks/${TALK_ID}/documents?thread=${THREAD_ID}`);

    // The Documents tab is present and active in the Talk shell.
    await expect(page.getByRole('link', { name: 'Documents' })).toBeVisible();

    // The native document renders: its title + a body block (scoped to the
    // article so it doesn't collide with the edit's "Current" preview).
    await expect(
      page.getByRole('heading', { name: 'Launch brief' }).first(),
    ).toBeVisible();
    await expect(
      page.locator('article').getByText('Original paragraph about the launch.'),
    ).toBeVisible();

    // The pending-edit review console (owner can edit).
    await expect(
      page.getByRole('heading', { name: 'Pending edits' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Accept replace paragraph' }),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`talk-documents-${vp.label}.png`),
      fullPage: true,
    });
  });
}
