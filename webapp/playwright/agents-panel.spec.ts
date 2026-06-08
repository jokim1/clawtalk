import { test, expect, type Page, type Route } from '@playwright/test';

// Responsive QA for the Salon-ported Registered Agents panel (lane-o Q1).
// Backend mocked via page.route; drives Settings → Agents.

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
  providerId: 'anthropic',
  modelId: 'claude-opus-4-8',
  personaRole: 'Lead',
  description: 'Plans the work and keeps the Talk on track.',
  enabled: true,
  credentialMode: null,
  executionPreview: { ready: true, message: 'Ready to run.' },
  modelAutoUpgradedFrom: null,
  modelUpdateAvailable: null,
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
    fulfillJson(route, {
      defaultClaudeModelId: '',
      claudeModelSuggestions: [],
      additionalProviders: [],
    }),
  );
  await page.route('**/api/v1/registered-agents/main**', (route) =>
    fulfillJson(route, AGENT),
  );
  await page.route('**/api/v1/registered-agents**', (route) => {
    // /main is handled above (registered later wins in LIFO); this is the list.
    if (route.request().url().includes('/registered-agents/main')) {
      return fulfillJson(route, AGENT);
    }
    return fulfillJson(route, [AGENT]);
  });
}

for (const vp of [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
]) {
  test(`Registered Agents panel renders at ${vp.label}`, async ({
    page,
  }, testInfo) => {
    await installMocks(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/app/settings?tab=agents');

    // The ported panel + its Salon atoms.
    await expect(page.getByText('Registered Agents')).toBeVisible();
    // The agent card renders the name as an <h4> (the main-agent <select> also
    // lists it, hence the role-scoped locator).
    await expect(
      page.getByRole('heading', { name: 'Strategist' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
    // Each card links to the standalone Agent profile route (lane-o item 3).
    const viewLink = page.getByRole('link', { name: 'View' });
    await expect(viewLink).toBeVisible();
    await expect(viewLink).toHaveAttribute('href', '/app/agents/agent-1');

    await page.screenshot({
      path: testInfo.outputPath(`agents-panel-${vp.label}.png`),
      fullPage: true,
    });
  });
}
