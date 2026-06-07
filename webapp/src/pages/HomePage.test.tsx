import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { HomePage } from './HomePage';
import type {
  HomeInboxPayload,
  HomeNewsPayload,
  HomeRecommendationsPayload,
  HomeSummaryPayload,
} from '../lib/api';
import * as api from '../lib/api';

vi.mock('../lib/api', () => ({
  getHomeSummary: vi.fn(),
  listHomeInbox: vi.fn(),
  listHomeRecommendations: vi.fn(),
  listHomeNews: vi.fn(),
}));

const mockApi = vi.mocked(api);

const SUMMARY: HomeSummaryPayload = {
  workspaceId: 'w1',
  curator: {
    kind: 'recommendation',
    title: '2 decisions need you.',
    summary: 'Pricing v2 is mid-stream.',
    itemId: null,
    target: { talkId: 't-pricing' },
  },
  stats: { talks: 5, prompts: 42, tokens: 120_000, words: 8000 },
  counts: {
    inbox: { unread: 3, blocking: 1, action: 1, info: 1 },
    recommendations: 2,
    news: 1,
  },
  algorithmVersions: { inbox: 'v1', recommendations: 'v1', news: 'v1' },
};

const INBOX: HomeInboxPayload = {
  items: [
    {
      id: 'i1',
      type: 'agent_replied',
      title: 'Critic replied in Pricing v2',
      summary: '488 tokens out, 2104 in.',
      reason: null,
      severity: 'action',
      status: 'unread',
      target: { kind: 'talk', talkId: 't-pricing' },
      primaryAction: {
        type: 'open',
        label: 'Open',
        payload: { talkId: 't-pricing' },
      },
      secondaryActions: [],
      score: 80,
      createdAt: '2026-06-06T00:00:00Z',
      algorithmVersion: 'v1',
    },
  ],
  counts: { unread: 3, blocking: 1, action: 1, info: 1 },
  nextCursor: null,
  algorithmVersion: 'v1',
};

const RECS: HomeRecommendationsPayload = {
  items: [],
  hero: {
    id: 'r1',
    kind: 'synthesis',
    title: 'Synthesize Pricing v2',
    why: 'Round 3 finished 2 h ago.',
    priority: 'decide',
    score: 90,
    confidence: 0.8,
    provenance: { talkId: 't-pricing', talkTitle: 'Pricing v2' },
    action: {
      type: 'open',
      label: 'Run synthesis',
      payload: { talkId: 't-pricing' },
    },
    status: 'active',
    stateFingerprint: null,
    rank: 1,
    algorithmVersion: 'v1',
    createdAt: '2026-06-06T00:00:00Z',
    expiresAt: null,
  },
  thenMaybe: [
    {
      id: 'r2',
      kind: 'doc',
      title: 'Draft a decision doc',
      why: 'No doc yet.',
      priority: 'improve',
      score: 70,
      confidence: 0.6,
      provenance: { talkId: 't-launch', talkTitle: 'Launch' },
      action: {
        type: 'open',
        label: 'Draft doc',
        payload: { talkId: 't-launch' },
      },
      status: 'active',
      stateFingerprint: null,
      rank: 2,
      algorithmVersion: 'v1',
      createdAt: '2026-06-06T00:00:00Z',
      expiresAt: null,
    },
  ],
  algorithmVersion: 'v1',
};

const NEWS: HomeNewsPayload = {
  items: [
    {
      id: 'n1',
      headline: 'Notion raises Business pricing 10%',
      source: 'TechCrunch',
      favicon: 'TC',
      age: '4 h',
      excerpt: 'Notion Business moves from $20 to $22/seat.',
      url: 'https://techcrunch.com/x',
      talkId: 't-pricing',
      talkTitle: 'Pricing v2',
      matchedOn: ['pricing'],
      whyItMatters: 'Direct comp for your pricing model.',
      impact: 'updates_competitor',
      score: 60,
      publishedAt: null,
      algorithmVersion: 'v1',
    },
  ],
  nextCursor: null,
  algorithmVersion: 'v1',
};

const EMPTY_INBOX: HomeInboxPayload = {
  items: [],
  counts: { unread: 0, blocking: 0, action: 0, info: 0 },
  nextCursor: null,
  algorithmVersion: 'v1',
};
const EMPTY_RECS: HomeRecommendationsPayload = {
  items: [],
  hero: null,
  thenMaybe: [],
  algorithmVersion: 'v1',
};
const EMPTY_NEWS: HomeNewsPayload = {
  items: [],
  nextCursor: null,
  algorithmVersion: 'v1',
};

function renderHome(): void {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('shows a busy state while the API is in flight', () => {
    mockApi.getHomeSummary.mockReturnValue(new Promise(() => {}));
    mockApi.listHomeInbox.mockResolvedValue(EMPTY_INBOX);
    mockApi.listHomeRecommendations.mockResolvedValue(EMPTY_RECS);
    mockApi.listHomeNews.mockResolvedValue(EMPTY_NEWS);

    renderHome();

    expect(screen.getByLabelText('Loading home')).toBeTruthy();
  });

  it('renders curator, stats, recommendations, inbox, and news when populated', async () => {
    mockApi.getHomeSummary.mockResolvedValue(SUMMARY);
    mockApi.listHomeInbox.mockResolvedValue(INBOX);
    mockApi.listHomeRecommendations.mockResolvedValue(RECS);
    mockApi.listHomeNews.mockResolvedValue(NEWS);

    renderHome();

    expect(await screen.findByText('2 decisions need you.')).toBeTruthy();
    expect(screen.getByText('Synthesize Pricing v2')).toBeTruthy();
    expect(screen.getByText('Draft a decision doc')).toBeTruthy();
    expect(screen.getByText('Critic replied in Pricing v2')).toBeTruthy();
    expect(screen.getByText('Notion raises Business pricing 10%')).toBeTruthy();
    // Stat strip labels.
    expect(screen.getByText('Talks')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    // A navigation-shaped primary action becomes a real link.
    expect(screen.getByRole('link', { name: /Run synthesis/i })).toBeTruthy();
  });

  it('renders empty states for each section when the lists are empty', async () => {
    mockApi.getHomeSummary.mockResolvedValue(SUMMARY);
    mockApi.listHomeInbox.mockResolvedValue(EMPTY_INBOX);
    mockApi.listHomeRecommendations.mockResolvedValue(EMPTY_RECS);
    mockApi.listHomeNews.mockResolvedValue(EMPTY_NEWS);

    renderHome();

    expect(await screen.findByText('No recommendations yet')).toBeTruthy();
    expect(screen.getByText('Inbox zero')).toBeTruthy();
    expect(screen.getByText('No news matched')).toBeTruthy();
  });

  it('shows an error with a working retry when the summary fails', async () => {
    mockApi.getHomeSummary.mockRejectedValueOnce(new Error('network down'));
    mockApi.listHomeInbox.mockResolvedValue(EMPTY_INBOX);
    mockApi.listHomeRecommendations.mockResolvedValue(EMPTY_RECS);
    mockApi.listHomeNews.mockResolvedValue(EMPTY_NEWS);

    renderHome();

    expect(
      await screen.findByText((t) => t.includes('Home') && t.includes('load')),
    ).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();

    // Retry now succeeds.
    mockApi.getHomeSummary.mockResolvedValue(SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('2 decisions need you.')).toBeTruthy();
    expect(mockApi.getHomeSummary).toHaveBeenCalledTimes(2);
  });
});
