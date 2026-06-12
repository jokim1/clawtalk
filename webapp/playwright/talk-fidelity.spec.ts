import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const SCREENS_DIR = 'playwright/__screens__';
const TALK_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const WORKSPACE_ID = '55555555-5555-5555-5555-555555555555';
const NOW = '2026-06-08T14:14:00.000Z';

type TalkState = 'populated' | 'empty' | 'active';

function buildSession() {
  return {
    user: {
      id: USER_ID,
      email: 'samira@clawtalk.test',
      displayName: 'Samira',
      role: 'owner',
      createdAt: NOW,
      currentWorkspaceId: WORKSPACE_ID,
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: "Samira's workspace",
          role: 'owner',
          initials: 'SR',
        },
        {
          id: '66666666-6666-4666-8666-666666666666',
          name: 'Research Ops',
          role: 'admin',
          initials: 'RO',
        },
        {
          id: '77777777-7777-4777-8777-777777777777',
          name: 'Longreads Lab',
          role: 'member',
          initials: 'LL',
        },
      ],
    },
  };
}

function buildAgents() {
  return [
    {
      id: 'agent-research',
      nickname: 'Researcher',
      nicknameMode: 'custom',
      sourceKind: 'provider',
      role: 'analyst',
      isPrimary: true,
      displayOrder: 0,
      health: 'ready',
      providerId: 'provider.gemini',
      modelId: 'gemini-2.5-pro',
      modelDisplayName: 'gemini-2.5-pro',
      supportsVision: true,
      supportsPdfDocuments: true,
    },
    {
      id: 'agent-critic',
      nickname: "Devil's Advocate",
      nicknameMode: 'custom',
      sourceKind: 'provider',
      role: 'critic',
      isPrimary: false,
      displayOrder: 1,
      health: 'ready',
      providerId: 'provider.openai',
      modelId: 'gpt-5-pro',
      modelDisplayName: 'gpt-5-pro',
      supportsVision: true,
      supportsPdfDocuments: true,
    },
  ];
}

function buildRuns(state: TalkState) {
  const completed = [
    {
      id: 'run-research',
      responseGroupId: 'round-2',
      sequenceIndex: 0,
      status: 'completed',
      createdAt: '2026-06-08T14:15:00.000Z',
      startedAt: '2026-06-08T14:15:01.000Z',
      completedAt: '2026-06-08T14:15:08.000Z',
      endedAt: '2026-06-08T14:15:08.000Z',
      triggerMessageId: 'msg-user',
      targetAgentId: 'agent-research',
      targetAgentNickname: 'Researcher',
      errorCode: null,
      errorMessage: null,
      cancelReason: null,
      executorAlias: 'Researcher',
      executorModel: 'gemini-2.5-pro',
      providerId: 'provider.gemini',
      tokensIn: 1620,
      tokensOut: 520,
    },
    {
      id: 'run-critic',
      responseGroupId: 'round-2',
      sequenceIndex: 1,
      status: 'completed',
      createdAt: '2026-06-08T14:16:00.000Z',
      startedAt: '2026-06-08T14:16:01.000Z',
      completedAt: '2026-06-08T14:16:07.000Z',
      endedAt: '2026-06-08T14:16:07.000Z',
      triggerMessageId: 'msg-user',
      targetAgentId: 'agent-critic',
      targetAgentNickname: "Devil's Advocate",
      errorCode: null,
      errorMessage: null,
      cancelReason: null,
      executorAlias: "Devil's Advocate",
      executorModel: 'gpt-5-pro',
      providerId: 'provider.openai',
      tokensIn: 1840,
      tokensOut: 290,
    },
  ];

  if (state !== 'active') return completed;
  return [
    ...completed,
    {
      id: 'run-live',
      responseGroupId: 'round-3',
      sequenceIndex: 0,
      status: 'running',
      createdAt: '2026-06-08T14:17:00.000Z',
      startedAt: '2026-06-08T14:17:01.000Z',
      completedAt: null,
      endedAt: null,
      triggerMessageId: 'msg-user-2',
      targetAgentId: 'agent-research',
      targetAgentNickname: 'Researcher',
      errorCode: null,
      errorMessage: null,
      cancelReason: null,
      executorAlias: 'Researcher',
      executorModel: 'gemini-2.5-pro',
      providerId: 'provider.gemini',
      tokensIn: null,
      tokensOut: null,
    },
  ];
}

function buildMessages(state: TalkState) {
  if (state === 'empty') return [];
  const followUp =
    state === 'active'
      ? [
          {
            id: 'msg-user-2',
            role: 'user',
            content: 'Keep going — pull the actual latency comparison next.',
            createdBy: USER_ID,
            createdAt: '2026-06-08T14:17:00.000Z',
            runId: null,
            metadata: { author: 'Samira' },
          },
        ]
      : [];
  return [
    {
      id: 'msg-user',
      role: 'user',
      content:
        "Tear down Notion AI's current product — features, pricing, where they win, where they lose.",
      createdBy: USER_ID,
      createdAt: '2026-06-08T14:14:00.000Z',
      runId: null,
      metadata: { author: 'Samira' },
    },
    {
      id: 'msg-research',
      role: 'assistant',
      content:
        'Three product surfaces: (1) inline page AI, (2) Q&A across workspace, (3) writing autocomplete. Pricing is **$10/seat** as an add-on. They win on distribution (75M Notion users); they lose on multi-document reasoning and on power-user latency.',
      createdBy: null,
      createdAt: '2026-06-08T14:15:08.000Z',
      runId: 'run-research',
      agentId: 'agent-research',
      agentNickname: 'Researcher',
      metadata: { modelId: 'gemini-2.5-pro' },
    },
    {
      id: 'msg-critic',
      role: 'assistant',
      content:
        '"They lose on power-user latency" needs a number, not a vibe. Notion AI median is **3.2s**, p95 is **8.4s** in my last measurement. We are currently 2.1s / 5.8s — that is the gap to anchor on.',
      createdBy: null,
      createdAt: '2026-06-08T14:16:07.000Z',
      runId: 'run-critic',
      agentId: 'agent-critic',
      agentNickname: "Devil's Advocate",
      metadata: { modelId: 'gpt-5-pro' },
    },
    ...followUp,
  ];
}

function buildSnapshot(state: TalkState) {
  const messages = buildMessages(state);
  return {
    talk: {
      id: TALK_ID,
      ownerId: USER_ID,
      workspaceId: WORKSPACE_ID,
      folderId: null,
      sortOrder: 0,
      title: state === 'empty' ? 'Empty Talk' : 'Notion AI teardown',
      orchestrationMode: 'ordered',
      status: 'active',
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      accessRole: 'owner',
    },
    conversations: [
      {
        id: CONVERSATION_ID,
        talkId: TALK_ID,
        title: 'Main',
        isDefault: true,
        isInternal: false,
        isPinned: false,
        createdAt: NOW,
        updatedAt: NOW,
        messageCount: messages.length,
        lastMessageAt: messages.at(-1)?.createdAt ?? NOW,
      },
    ],
    messages,
    hasOlderMessages: false,
    primaryDocument: null,
    pendingEdits: [],
    runs: buildRuns(state),
    agents: [],
    eventHighWater: 1,
  };
}

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data }),
  });
}

async function installMocks(page: Page, state: TalkState): Promise<void> {
  const agents = buildAgents();
  const messageCount = buildMessages(state).length;
  // Freeze wall-clock just after the live run starts so elapsed labels render
  // a realistic "0:30" instead of the days since the fixture's NOW.
  await page.clock.setFixedTime(new Date('2026-06-08T14:17:30.000Z'));
  await page.addInitScript(
    ({ activeTalkId, activeTalkMessageCount, now }) => {
      window.localStorage.setItem(
        'clawtalk.talkReadMarkers',
        JSON.stringify({
          [activeTalkId]: {
            messageCount: activeTalkMessageCount,
            lastMessageAt: now,
          },
          'launch-pricing': { messageCount: 8, lastMessageAt: now },
          'launch-comms': {
            messageCount: 10,
            lastMessageAt: '2026-06-08T14:10:00.000Z',
          },
          'research-hiring': { messageCount: 2, lastMessageAt: now },
        }),
      );
    },
    { activeTalkId: TALK_ID, activeTalkMessageCount: messageCount, now: NOW },
  );
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me*', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config*', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar*', (route) =>
    fulfillJson(route, {
      items: [
        {
          type: 'folder',
          id: 'folder-launches',
          title: 'Q1 Launches',
          sortOrder: 0,
          talks: [
            {
              type: 'talk',
              id: 'launch-pricing',
              title: 'Pricing & packaging for v2 launch',
              status: 'active',
              sortOrder: 0,
              lastMessageAt: NOW,
              messageCount: 8,
              hasActiveRun: false,
              hasContent: true,
            },
            {
              type: 'talk',
              id: 'launch-comms',
              title: 'Launch week — comms checklist',
              status: 'active',
              sortOrder: 1,
              lastMessageAt: NOW,
              messageCount: 13,
              unreadCount: 3,
              hasActiveRun: false,
              hasContent: true,
            },
          ],
        },
        {
          type: 'folder',
          id: 'folder-research',
          title: 'Research & Longreads',
          sortOrder: 1,
          talks: [
            {
              type: 'talk',
              id: TALK_ID,
              title: state === 'empty' ? 'Empty Talk' : 'Notion AI teardown',
              status: 'active',
              sortOrder: 0,
              lastMessageAt: NOW,
              messageCount,
              hasActiveRun: state === 'active',
              hasContent: true,
            },
            {
              type: 'talk',
              id: 'research-hiring',
              title: 'Eng hiring loop notes',
              status: 'active',
              sortOrder: 1,
              lastMessageAt: NOW,
              messageCount: 2,
              hasActiveRun: false,
              hasContent: false,
            },
          ],
        },
      ],
      mainTalkId: 'main-talk',
      contents: [
        {
          id: 'content-weekly',
          talkId: TALK_ID,
          title: 'My weekly review',
          updatedAt: NOW,
        },
        {
          id: 'content-ideas',
          talkId: 'research-hiring',
          title: 'Scratchpad — ideas',
          updatedAt: NOW,
        },
      ],
    }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/snapshot*`, (route) =>
    fulfillJson(route, buildSnapshot(state)),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/runs*`, (route) =>
    fulfillJson(route, { talkId: TALK_ID, runs: buildRuns(state) }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/agents*`, (route) =>
    fulfillJson(route, { talkId: TALK_ID, agents }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/context*`, (route) =>
    fulfillJson(route, { goal: null, rules: [], sources: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/tools*`, (route) =>
    fulfillJson(route, {
      talkId: TALK_ID,
      active: { web: true, connectors: true },
      available: ['web', 'connectors', 'google_read', 'gmail_read'],
    }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/connector-bindings*`, (route) =>
    fulfillJson(route, {
      channels: [
        {
          id: 'channel-pricing',
          kind: 'slack',
          displayName: '#pricing',
          enabled: true,
          hasCredential: true,
          linked: true,
        },
        {
          id: 'channel-launch',
          kind: 'slack',
          displayName: '#launch',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
      ],
      dataConnectors: [
        {
          id: 'drive-pricing',
          kind: 'google_docs',
          displayName: '/pricing-v2/',
          enabled: true,
          hasCredential: true,
          linked: true,
        },
        {
          id: 'drive-research',
          kind: 'google_sheets',
          displayName: 'Research sheet',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
        {
          id: 'drive-model',
          kind: 'google_docs',
          displayName: 'Pricing model',
          enabled: true,
          hasCredential: true,
          linked: false,
        },
      ],
    }),
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
}

mkdirSync(SCREENS_DIR, { recursive: true });

for (const state of ['populated', 'empty', 'active'] as const) {
  for (const vp of [
    { label: 'desktop-1280', width: 1280, height: 800 },
    { label: 'mobile-390', width: 390, height: 844 },
  ]) {
    test(`Talk Salon fidelity ${state} at ${vp.label}`, async ({ page }) => {
      await installMocks(page, state);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/app/talks/${TALK_ID}`);

      await expect(page.locator('.talk-title-button')).toContainText(
        state === 'empty' ? 'Empty Talk' : 'Notion AI teardown',
      );
      await expect(
        page.getByRole('navigation', { name: 'Talk controls' }),
      ).toBeVisible();

      if (vp.width >= 1024) {
        await expect(page.getByText('Q1 Launches')).toBeVisible();
        // Scoped to the sidebar — the header breadcrumb names the folder too.
        await expect(
          page
            .locator('.clawtalk-sidebar-folder-title')
            .getByText('Research & Longreads'),
        ).toBeVisible();
        await expect(page.getByLabel('3 unread messages')).toBeVisible();
        await expect(page.locator('.ct-secondary-content-label')).toContainText(
          'Inbox 2',
        );
        await expect(page.getByText('Scratchpad — ideas')).toBeVisible();
        // Breadcrumb row: folder › mode · agent count (uppercased via CSS).
        await expect(page.locator('.talk-breadcrumb')).toContainText(
          'Research & Longreads',
        );
        await expect(page.locator('.talk-breadcrumb')).toContainText(
          'Ordered mode · 2 agents',
        );
        // Tools pill reflecting the mocked families expanded into menu items.
        await expect(
          page.getByRole('button', { name: 'Tools, 5 of 7 on' }),
        ).toBeVisible();
        const connectorsButton = page.getByRole('button', {
          name: 'Connectors, 2 of 5 bound',
        });
        await expect(connectorsButton).toBeVisible();
        await connectorsButton.click();
        await expect(
          page.getByRole('dialog', { name: 'Connectors in this Talk' }),
        ).toBeVisible();
        await expect(page.getByText('Slack · #pricing')).toBeVisible();
        await expect(
          page.getByRole('link', { name: /Add connection/ }),
        ).toHaveAttribute('href', '/app/settings?tab=connectors');
        await page.getByRole('button', { name: 'Done' }).click();
      }

      if (state === 'empty') {
        await expect(page.getByText('No messages yet.')).toBeVisible();
      } else {
        await expect(page.getByText('Round 1')).toBeVisible();
        if (state === 'active') {
          await expect(page.getByText('Round 2')).toBeVisible();
        }
        await expect(page.getByText('1,620 in · 520 out')).toBeVisible();
        await expect(page.getByText('$10/seat')).toBeVisible();
      }

      if (state === 'active') {
        await expect(page.getByText('Running')).toBeVisible();
        await expect(page.getByText('Starting up…')).toBeVisible();
        await expect(page.getByText('Round 2 · live')).toBeVisible();
        // Bring the live panel into frame (scrolls whichever ancestor is the
        // real scroller at this viewport) and assert it actually made it —
        // an out-of-frame capture silently hides streaming-chrome regressions.
        await page.locator('.message-live').scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        await expect(page.locator('.message-live')).toBeInViewport();
      }

      await page.screenshot({
        path: `${SCREENS_DIR}/talk-${state}-${vp.label}.png`,
        fullPage: true,
      });
    });
  }
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Salon profile menu fidelity at ${vp.label}`, async ({ page }) => {
    await installMocks(page, 'populated');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/app/talks/${TALK_ID}`);

    await page
      .getByRole('button', { name: /Samira — account and workspace menu/ })
      .click();

    await expect(
      page.getByRole('menu', { name: 'Account and workspace menu' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Workspaces' }),
    ).toBeVisible();
    await expect(page.getByLabel('3 workspaces')).toBeVisible();
    await expect(
      page.getByRole('menuitemradio', { name: /Samira's workspace/ }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.getByRole('menuitem', {
        name: "Invite people to Samira's workspace",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'API keys' }),
    ).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();

    await page.screenshot({
      path: `${SCREENS_DIR}/profile-menu-${vp.label}.png`,
      fullPage: true,
    });
  });
}
