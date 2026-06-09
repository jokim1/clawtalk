import { test, expect, type Page, type Route } from '@playwright/test';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data }),
  });
}

function buildSession() {
  return {
    user: {
      id: 'user-jk',
      email: 'jokim1@gmail.com',
      displayName: 'Joseph Kim',
      role: 'owner',
      createdAt: '2026-06-04T00:00:00.000Z',
    },
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: "Joseph Kim's workspace",
        role: 'owner',
        initials: 'JK',
      },
    ],
    currentWorkspaceId: WORKSPACE_ID,
  };
}

const provider = {
  id: 'provider.anthropic',
  name: 'Claude (Anthropic)',
  providerKind: 'anthropic',
  apiFormat: 'anthropic_messages',
  baseUrl: 'https://api.anthropic.com',
  authScheme: 'x_api_key',
  enabled: true,
  credentialMode: 'api_key',
  hasCredential: true,
  credentialHint: '••••IAAA',
  verificationStatus: 'verified',
  lastVerifiedAt: '2026-06-04T21:57:08.000Z',
  lastVerificationError: null,
  workspaceHasCredential: false,
  workspaceCredentialHint: null,
  workspaceVerificationStatus: 'missing',
  workspaceLastVerifiedAt: null,
  workspaceLastVerificationError: null,
  hasPersonalSubscription: false,
  personalSubscriptionExpiresAt: null,
  hasWorkspaceSubscription: false,
  workspaceSubscriptionExpiresAt: null,
  modelSuggestions: [
    {
      modelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      contextWindowTokens: 200000,
      defaultMaxOutputTokens: 8192,
      supportsTools: true,
      supportsVision: true,
    },
  ],
  liveModelDiscovery: { status: 'ok' },
};

const agentsData = {
  defaultClaudeModelId: 'claude-sonnet-4-6',
  claudeModelSuggestions: provider.modelSuggestions,
  additionalProviders: [
    provider,
    {
      ...provider,
      id: 'provider.openai',
      name: 'OpenAI',
      providerKind: 'openai',
      apiFormat: 'openai_chat_completions',
      authScheme: 'bearer',
      hasCredential: false,
      credentialHint: null,
      verificationStatus: 'missing',
      liveModelDiscovery: undefined,
    },
  ],
};

const registeredAgent = {
  id: 'agent-strategy',
  name: 'Strategy Lead',
  providerId: 'provider.anthropic',
  modelId: 'claude-sonnet-4-6',
  personaRole: 'Strategist',
  description: 'Frames the strongest recommendation first.',
  systemPrompt: 'Lead with the decision.',
  enabled: true,
  credentialMode: null,
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  executionPreview: {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: 'Strategy Lead will use Anthropic direct HTTP with an API key.',
  },
  supportsVision: true,
  modelAutoUpgradedFrom: null,
  modelAutoUpgradedAt: null,
  modelUpdateAvailable: null,
};

async function installMocks(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me*', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config*', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar*', (route) =>
    fulfillJson(route, { items: [], mainTalkId: null, contents: [] }),
  );
  await page.route('**/api/v1/agents*', (route) =>
    fulfillJson(route, agentsData),
  );
  await page.route('**/api/v1/registered-agents*', (route) => {
    if (route.request().url().includes('/registered-agents/main')) {
      return fulfillJson(route, registeredAgent);
    }
    return fulfillJson(route, [registeredAgent]);
  });
  await page.route('**/api/v1/web-search/providers*', (route) =>
    fulfillJson(route, {
      providers: [
        {
          id: 'web_search.brave',
          name: 'Brave Search',
          baseUrl: 'https://api.search.brave.com',
          enabled: true,
          hasCredential: true,
          credentialHint: 'BSA…test',
          isActive: true,
        },
        {
          id: 'web_search.exa',
          name: 'Exa',
          baseUrl: 'https://api.exa.ai',
          enabled: true,
          hasCredential: false,
          credentialHint: null,
          isActive: false,
        },
      ],
      activeProviderId: 'web_search.brave',
    }),
  );
  await page.route('**/api/v1/me/google-account*', (route) =>
    fulfillJson(route, {
      googleAccount: {
        connected: false,
        email: null,
        displayName: null,
        scopes: [],
        accessExpiresAt: null,
      },
    }),
  );
  await page.route('**/api/v1/workspace/connector-channels*', (route) =>
    fulfillJson(route, {
      channels: [
        {
          id: 'channel-slack',
          kind: 'slack',
          displayName: 'Product updates',
          config: { channelName: '#product' },
          hasCredential: true,
          enabled: true,
          boundTalkCount: 2,
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
    }),
  );
  await page.route('**/api/v1/workspace/connector-sources*', (route) =>
    fulfillJson(route, {
      dataConnectors: [
        {
          id: 'source-docs',
          kind: 'google_docs',
          displayName: 'Launch brief',
          config: { documentTitle: 'Launch brief' },
          hasCredential: true,
          enabled: true,
          boundTalkCount: 1,
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
    }),
  );
  await page.route('**/api/v1/workspace/connectors/slack/installs*', (route) =>
    fulfillJson(route, {
      installs: [
        {
          teamId: 'T123',
          teamName: 'ClawTalk',
          botUserId: 'B123',
          appId: 'A123',
          scopes: ['chat:write'],
          installedBy: 'user-jk',
          installedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
          boundChannelCount: 1,
        },
      ],
    }),
  );
}

const tabs = [
  { tab: 'profile', heading: 'Profile', visible: 'Display name' },
  { tab: 'api-keys', heading: 'API keys', visible: 'Personal API Keys' },
  { tab: 'tools', heading: 'Tools', visible: 'Tool catalog' },
  { tab: 'connectors', heading: 'Connectors', visible: 'Google Drive' },
  { tab: 'agents', heading: 'AI agents', visible: 'Registered Agents' },
] as const;

for (const viewport of [
  { label: 'desktop-1280', width: 1280, height: 820 },
  { label: 'mobile-390', width: 390, height: 844 },
] as const) {
  for (const item of tabs) {
    test(`Settings Salon ${item.tab} at ${viewport.label}`, async ({
      page,
    }, testInfo) => {
      await installMocks(page);
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/app/settings?tab=${item.tab}`);

      await expect(
        page.getByRole('heading', { name: item.heading, level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(item.visible).first()).toBeVisible();
      await expect(page.locator('.settings-salon')).toHaveCSS(
        'background-color',
        'rgb(251, 247, 239)',
      );

      await page.screenshot({
        path: testInfo.outputPath(
          `settings-${item.tab}-${viewport.label}.png`,
        ),
        fullPage: true,
      });
    });
  }
}
