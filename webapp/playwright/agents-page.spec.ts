import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the standalone Agents roster route. Backend mocked via
// page.route; drives /app/agents straight to the card grid.

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

function buildAgent(id: string, name: string, role: string, ready = true) {
  return {
    id,
    name,
    providerId: 'provider.openai',
    modelId: 'gpt-5',
    personaRole: role,
    systemPrompt: 'Prompt.',
    description: `${name} keeps the Talk honest about ${role.toLowerCase()} concerns.`,
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
      ready,
      message: ready ? 'Ready to run via direct HTTP.' : 'Missing API key.',
    },
    supportsVision: true,
    modelAutoUpgradedFrom: null,
    modelAutoUpgradedAt: null,
    modelUpdateAvailable: null,
  };
}

const AGENTS = [
  buildAgent('agent-1', 'Strategist', 'Lead'),
  buildAgent('agent-2', 'Critic', 'Skeptic'),
  buildAgent('agent-3', 'Researcher', 'Evidence', false),
];

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
  await page.route('**/api/v1/agents**', (route) =>
    fulfillJson(route, CATALOG),
  );
  await page.route('**/api/v1/registered-agents**', (route) =>
    fulfillJson(route, AGENTS),
  );
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Agents roster renders at ${vp.label}`, async ({ page }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/app/agents');

    await expect(
      page.getByRole('link', { name: 'Strategist — view profile' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Critic — view profile' }),
    ).toBeVisible();
    // Catalog-resolved model label + readiness chips.
    await expect(page.getByText('GPT-5').first()).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();
    // The add-slot routes management to Settings.
    await expect(
      page.getByRole('link', { name: /Add a new agent/i }),
    ).toBeVisible();
    // The grid must shrink into the narrow column — no horizontal overflow.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath(`agents-page-${vp.label}.png`),
      fullPage: true,
    });
  });
}
