import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { NewsPreview } from './NewsPreview';
import type { HomeNewsPayload } from '../../lib/api';

// Regression lock for the "empty Home fixture crash" (goal item 1). The crash
// was a pre-rewrite issue (the historical NewsPreview indexed payload.items
// without an empty guard); the current component renders <HomeEmpty> for an
// empty list and the backend always emits an items array
// (home-accessors mapNewsRow), so this asserts the empty path can never throw
// again.
const EMPTY: HomeNewsPayload = {
  items: [],
  nextCursor: null,
  algorithmVersion: '',
};

const POPULATED: HomeNewsPayload = {
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

function renderNews(payload: HomeNewsPayload): void {
  render(
    <MemoryRouter>
      <NewsPreview payload={payload} />
    </MemoryRouter>,
  );
}

describe('NewsPreview', () => {
  afterEach(cleanup);

  it('renders the empty state without crashing when no items match', () => {
    renderNews(EMPTY);
    expect(screen.getByText('No news matched')).toBeTruthy();
  });

  it('renders a news card with an Open link when items are present', () => {
    renderNews(POPULATED);
    expect(screen.getByText('Notion raises Business pricing 10%')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open/i })).toBeTruthy();
  });
});
