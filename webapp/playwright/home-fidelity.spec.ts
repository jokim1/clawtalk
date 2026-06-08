import { test, type Page, type Route } from '@playwright/test';

/**
 * Visual-fidelity capture harness for the Salon Home surface.
 *
 * This is NOT an assertion test — it exists to (re)generate stable screenshots
 * that an evaluator agent compares against the design mockup
 * (docs/02-visual-system.md + prototype/home-*.jsx). Backend is fully mocked via
 * page.route (no Worker / Supabase / OAuth / auth), modelled on home.spec.ts.
 *
 * It renders Home at a fixed desktop viewport in two states:
 *   - populated: stats + curator hero ("Do this next") + then-maybe + inbox + news
 *   - empty:     idle curator + zeroed stats + empty sections
 *
 * Output (stable paths, overwritten each run):
 *   playwright/__screens__/home-populated.png
 *   playwright/__screens__/home-empty.png
 *
 * Run: npx playwright test home-fidelity
 */

const SCREENS_DIR = 'playwright/__screens__';
const VIEWPORT = { width: 1440, height: 1400 } as const;
const USER_ID = '33333333-3333-3333-3333-333333333333';

function buildSession() {
  return {
    user: {
      id: USER_ID,
      email: 'samira@clawtalk.test',
      displayName: 'Samira',
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

// ---- populated fixtures: mirror the design mockup (Samira / Pricing v2) ----

const POPULATED_STATS = { talks: 7, prompts: 7, tokens: 20_300, words: 564 };

const HERO_REC = {
  id: 'rec-hero',
  kind: 'synthesis',
  title: 'Synthesize Pricing v2',
  why: "Round 3 finished 2 h ago, Editor hasn't been kicked. Strategy and Critic agree on 3 of 5 points.",
  priority: 'decide',
  score: 96,
  confidence: 0.9,
  provenance: {
    talkId: 'talk-1',
    talkTitle: 'Pricing & packaging for v2 launch',
  },
  action: {
    type: 'run_synthesis',
    label: 'Run synthesis',
    payload: { talkId: 'talk-1' },
  },
  status: 'active',
  stateFingerprint: null,
  rank: 1,
  algorithmVersion: 'v1',
  createdAt: '2026-06-08T10:00:00.000Z',
  expiresAt: null,
};

const THEN_MAYBE = [
  {
    id: 'rec-2',
    kind: 'cross-link',
    title: 'Pull Notion teardown into Pricing v2',
    why: 'Strategy Lead cites Notion comp numbers from memory that already live in your Notion teardown doc.',
    priority: 'decide',
    score: 82,
    confidence: 0.8,
    provenance: { talkId: 'talk-1' },
    action: {
      type: 'add_context',
      label: 'Add as context',
      payload: { talkId: 'talk-1' },
    },
    status: 'active',
    stateFingerprint: null,
    rank: 2,
    algorithmVersion: 'v1',
    createdAt: '2026-06-08T09:00:00.000Z',
    expiresAt: null,
  },
  {
    id: 'rec-3',
    kind: 'doc',
    title: 'Generate a decision doc for Launch comms',
    why: 'Four rounds in, no document. PH-vs-HN choice is scattered across messages and will be lost.',
    priority: 'improve',
    score: 74,
    confidence: 0.75,
    provenance: { talkId: 'talk-2' },
    action: {
      type: 'draft_doc',
      label: 'Draft doc',
      payload: { talkId: 'talk-2' },
    },
    status: 'active',
    stateFingerprint: null,
    rank: 3,
    algorithmVersion: 'v1',
    createdAt: '2026-06-08T08:00:00.000Z',
    expiresAt: null,
  },
  {
    id: 'rec-4',
    kind: 'unresolved',
    title: "Resolve Critic's objection in Pricing v2",
    why: '"No usage cap" was raised twice and never addressed. Editor will synthesize over it.',
    priority: 'improve',
    score: 68,
    confidence: 0.7,
    provenance: { talkId: 'talk-1' },
    action: {
      type: 'open_at_turn',
      label: 'Open at turn',
      payload: { talkId: 'talk-1' },
    },
    status: 'active',
    stateFingerprint: null,
    rank: 4,
    algorithmVersion: 'v1',
    createdAt: '2026-06-08T07:00:00.000Z',
    expiresAt: null,
  },
];

const POPULATED_INBOX = [
  {
    id: 'i1',
    type: 'job_output_ready',
    title: 'My weekly review',
    summary: 'A scheduled job produced output that needs review.',
    reason: null,
    severity: 'action',
    status: 'unread',
    target: { kind: 'talk', talkId: 'talk-3' },
    primaryAction: {
      type: 'open_talk',
      label: 'Open',
      payload: { talkId: 'talk-3' },
    },
    secondaryActions: [],
    score: 80,
    createdAt: '2026-06-08T06:00:00.000Z',
    algorithmVersion: 'v1',
  },
  {
    id: 'i2',
    type: 'run_failed',
    title: 'Scratchpad — ideas',
    summary: '7 new items captured since you last looked.',
    reason: null,
    severity: 'info',
    status: 'unread',
    target: { kind: 'talk', talkId: 'talk-4' },
    primaryAction: {
      type: 'open_talk',
      label: 'Open',
      payload: { talkId: 'talk-4' },
    },
    secondaryActions: [],
    score: 60,
    createdAt: '2026-06-08T05:00:00.000Z',
    algorithmVersion: 'v1',
  },
];

const POPULATED_NEWS = [
  {
    id: 'n1',
    headline: 'Notion AI ships usage-based pricing tier',
    source: 'TechCrunch',
    favicon: null,
    age: '4 h',
    excerpt:
      'The change reshapes the competitive comparison for your v2 pricing.',
    url: 'https://news.example/notion-pricing',
    talkId: 'talk-1',
    talkTitle: 'Pricing & packaging for v2 launch',
    matchedOn: ['pricing', 'notion'],
    whyItMatters: 'It changes the seat-anchor assumption in Pricing v2.',
    impact: 'changes_assumption',
    score: 88,
    publishedAt: null,
    algorithmVersion: 'v1',
  },
];

type HomeState = 'populated' | 'empty';

async function installMocks(page: Page, state: HomeState): Promise<void> {
  const populated = state === 'populated';

  // Catch-all so an unmocked endpoint never hangs the render.
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
      curator: populated
        ? {
            kind: 'recommendation',
            title: HERO_REC.title,
            summary: HERO_REC.why,
            itemId: HERO_REC.id,
            target: { talkId: 'talk-1' },
          }
        : {
            kind: 'idle',
            title: 'Start a Talk',
            summary: null,
            itemId: null,
            target: null,
          },
      stats: populated
        ? POPULATED_STATS
        : { talks: 0, prompts: 0, tokens: 0, words: 0 },
      counts: {
        inbox: populated
          ? { unread: 2, blocking: 0, action: 1, info: 1 }
          : { unread: 0, blocking: 0, action: 0, info: 0 },
        recommendations: populated ? 1 + THEN_MAYBE.length : 0,
        news: populated ? POPULATED_NEWS.length : 0,
      },
      algorithmVersions: { inbox: 'v1', recommendations: 'v1', news: 'v1' },
    }),
  );

  await page.route('**/api/v1/home/inbox*', (route) =>
    fulfillJson(route, {
      items: populated ? POPULATED_INBOX : [],
      counts: populated
        ? { unread: 2, blocking: 0, action: 1, info: 1 }
        : { unread: 0, blocking: 0, action: 0, info: 0 },
      nextCursor: null,
      algorithmVersion: 'v1',
    }),
  );

  await page.route('**/api/v1/home/recommendations*', (route) =>
    fulfillJson(route, {
      items: populated ? [HERO_REC, ...THEN_MAYBE] : [],
      hero: populated ? HERO_REC : null,
      thenMaybe: populated ? THEN_MAYBE : [],
      algorithmVersion: 'v1',
    }),
  );

  await page.route('**/api/v1/home/news*', (route) =>
    fulfillJson(route, {
      items: populated ? POPULATED_NEWS : [],
      nextCursor: null,
      algorithmVersion: 'v1',
    }),
  );
}

for (const state of ['populated', 'empty'] as const) {
  test(`capture Home — ${state}`, async ({ page }) => {
    await installMocks(page, state);
    await page.setViewportSize(VIEWPORT);
    await page.goto('/app/home');
    // Wait for the Home spine to render (heading is always present once ready).
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    // Settle fonts + any enter animation before capture.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${SCREENS_DIR}/home-${state}.png`,
      fullPage: true,
    });
  });
}
