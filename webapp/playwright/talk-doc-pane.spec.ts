import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the migrated in-Talk split-editor doc PANE (lane-o
// de-facade). On the `talk` tab, when the active thread has a primary document
// the page renders the native read+review pane (TalkDocPane → TalkDocumentView)
// beside the conversation — no legacy bodyMarkdown/bodyHtml editor. Everything
// is mocked via page.route so the suite needs no Worker / Supabase / auth.

const TALK_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const WORKSPACE_ID = '55555555-5555-5555-5555-555555555555';
const NOW = '2026-06-08T00:00:00.000Z';

function buildSession() {
  return {
    user: {
      id: USER_ID,
      email: 'playwright@clawtalk.test',
      displayName: 'Playwright',
      role: 'owner',
      createdAt: NOW,
    },
  };
}

// Snapshot whose active thread HAS a primary document. `content.id` is the
// native document id the pane resolves; the body fields are ignored by the
// migrated pane (it fetches native blocks via /api/v1/documents/:id).
function buildSnapshot() {
  return {
    talk: {
      id: TALK_ID,
      ownerId: USER_ID,
      workspaceId: WORKSPACE_ID,
      folderId: null,
      sortOrder: 0,
      title: 'In-Talk doc pane fixture',
      orchestrationMode: 'ordered' as const,
      status: 'active' as const,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      accessRole: 'owner' as const,
    },
    conversations: [
      {
        id: THREAD_ID,
        talkId: TALK_ID,
        title: 'Main',
        isDefault: true,
        isInternal: false,
        isPinned: false,
        createdAt: NOW,
        updatedAt: NOW,
        messageCount: 0,
        lastMessageAt: NOW,
      },
    ],
    messages: [],
    hasOlderMessages: false,
    primaryDocument: {
      id: 'doc-1',
      talkId: TALK_ID,
      title: 'Launch brief',
      format: 'markdown',
      listVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    pendingEdits: [],
    runs: [],
    agents: [],
    eventHighWater: 1,
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
  lastEditAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
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
      createdAt: NOW,
      updatedAt: NOW,
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
          createdAt: NOW,
          updatedAt: NOW,
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
          createdAt: NOW,
          updatedAt: NOW,
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
      createdAt: NOW,
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

test('desktop doc pane hides without rendering a floating edge tab', async ({
  page,
}) => {
  await installMocks(page);
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/app/talks/${TALK_ID}/talk?thread=${THREAD_ID}&doc=1`);

  const docPane = page.getByRole('region', { name: /talk document/i });
  await expect(docPane).toBeVisible();

  await page.getByRole('button', { name: /hide document pane/i }).click();

  await expect(docPane).toBeHidden();
  await expect(
    page.getByRole('button', { name: /show launch brief document/i }),
  ).toHaveCount(0);

  const documentsButton = page
    .getByRole('navigation', { name: 'Talk controls' })
    .getByRole('button', { name: 'Documents' });
  await expect(documentsButton).toHaveAttribute('aria-pressed', 'true');

  await documentsButton.click();
  await expect(docPane).toBeVisible();
});

async function installMocks(page: Page): Promise<void> {
  // LIFO: catch-all first, specific handlers below win.
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me*', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config*', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar*', (route) =>
    fulfillJson(route, {
      items: [],
      mainTalkId: TALK_ID,
      contents: [
        {
          id: 'doc-1',
          talkId: TALK_ID,
          title: 'Launch brief',
          updatedAt: NOW,
        },
      ],
    }),
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
  await page.route(`**/api/v1/talks/${TALK_ID}/tools*`, (route) =>
    fulfillJson(route, { tools: [] }),
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
  await page.route('**/api/v1/documents/doc-1**', (route) =>
    fulfillJson(route, { document: DOCUMENT }),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`in-Talk doc pane renders natively beside chat at ${vp.label}`, async ({
    page,
  }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // The `talk` tab with ?doc=1 opens the document pane.
    await page.goto(`/app/talks/${TALK_ID}/talk?thread=${THREAD_ID}&doc=1`);

    // The native doc pane region renders with the document's native blocks —
    // no legacy rich-text editor / HTML source surface.
    const docPane = page.getByRole('region', { name: /talk document/i });
    await expect(docPane).toBeVisible();
    await expect(
      docPane.getByRole('heading', { name: 'Launch brief' }).first(),
    ).toBeVisible();
    await expect(
      docPane
        .locator('article')
        .getByText('Original paragraph about the launch.'),
    ).toBeVisible();

    // The pending-edit review console is offered to the owner.
    await expect(
      docPane.getByRole('heading', { name: 'Pending edits' }),
    ).toBeVisible();

    if (vp.width >= 768) {
      // Desktop: chat + doc are shown side by side, so the composer is visible
      // alongside the doc pane.
      await expect(
        page.getByPlaceholder(/Send a message to this conversation/),
      ).toBeVisible();
    } else {
      // Mobile: the layout is a Chat ↔ Doc toggle; with ?doc=1 the Doc pane is
      // shown and the toggle is offered to switch back to the conversation.
      await expect(
        page.getByRole('tablist', { name: /talk or document/i }),
      ).toBeVisible();
    }

    await page.screenshot({
      path: testInfo.outputPath(`talk-doc-pane-${vp.label}.png`),
      fullPage: true,
    });
  });
}
