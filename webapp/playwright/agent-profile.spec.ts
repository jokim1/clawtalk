import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the standalone Agent profile route (lane-o). Backend mocked
// via page.route; drives /app/agents/:agentId straight to the detail view.

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

const AGENT = {
  id: 'agent-1',
  name: 'Strategist',
  providerId: 'provider.openai',
  modelId: 'gpt-5',
  personaRole: 'Lead',
  systemPrompt: 'You are the strategist. Keep the Talk on track.',
  description: 'Plans the work and keeps the Talk on track.',
  enabled: true,
  credentialMode: 'api_key',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-06T00:00:00.000Z',
  executionPreview: {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: 'Ready to run via direct HTTP.',
  },
  supportsVision: true,
  modelAutoUpgradedFrom: null,
  modelAutoUpgradedAt: null,
  modelUpdateAvailable: null,
};

const CATALOG = {
  defaultClaudeModelId: '',
  claudeModelSuggestions: [],
  additionalProviders: [
    {
      id: 'provider.openai',
      name: 'OpenAI',
      modelSuggestions: [
        {
          modelId: 'gpt-5',
          displayName: 'GPT-5',
          contextWindowTokens: 0,
          defaultMaxOutputTokens: 0,
        },
      ],
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
  // Catalog enrichment (provider/model labels). Registered after the catch-all
  // and before the agent route; LIFO means the most specific wins.
  await page.route('**/api/v1/agents**', (route) =>
    fulfillJson(route, CATALOG),
  );
  await page.route('**/api/v1/registered-agents/agent-1**', (route) =>
    fulfillJson(route, AGENT),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Agent profile renders at ${vp.label}`, async ({ page }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/app/agents/agent-1');

    await expect(
      page.getByRole('heading', { name: 'Strategist' }),
    ).toBeVisible();
    // Resolved model label + keyboard-accessible primary action.
    await expect(page.getByText('GPT-5')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Edit in Settings' }),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`agent-profile-${vp.label}.png`),
      fullPage: true,
    });
  });
}
