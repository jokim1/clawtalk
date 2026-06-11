import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { RecommendationCard } from './RecommendationCard';
import type { HomeRecommendation } from '../../lib/api';

const REC: HomeRecommendation = {
  id: 'r1',
  kind: 'synthesis',
  title: 'Synthesize Pricing v2',
  why: 'Round 3 finished; Strategy and Critic agree on 3 of 5 points.',
  priority: 'decide',
  score: 90,
  confidence: 0.9,
  provenance: { talkId: 't-pricing', talkTitle: 'Pricing v2' },
  action: { type: 'open_talk', label: 'Run synthesis', payload: { talkId: 't-pricing' } },
  status: 'active',
  stateFingerprint: null,
  rank: 1,
  algorithmVersion: 'v1',
  createdAt: '2026-06-11T00:00:00.000Z',
  expiresAt: null,
};

function renderCard(props: Partial<Parameters<typeof RecommendationCard>[0]>) {
  return render(
    <MemoryRouter>
      <RecommendationCard rec={REC} onDismiss={() => {}} {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('RecommendationCard', () => {
  it('hero renders the context pane with the curator summary and confidence', () => {
    renderCard({ variant: 'hero', curatorSummary: 'Editor has not been kicked.' });
    expect(screen.getByText('Context')).toBeTruthy();
    expect(screen.getByText('Editor has not been kicked.')).toBeTruthy();
    expect(screen.getByText(/90% confidence/i)).toBeTruthy();
    // The pane owns the single talk chip for the hero.
    expect(screen.getAllByText('Pricing v2')).toHaveLength(1);
  });

  it('hero context pane falls back to the why text without a curator summary', () => {
    renderCard({ variant: 'hero' });
    // why renders in the left column and as the pane fallback body.
    expect(screen.getAllByText(REC.why as string).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Context')).toBeTruthy();
  });

  it('compact variant has no context pane and keeps the talk chip', () => {
    renderCard({ variant: 'compact' });
    expect(screen.queryByText('Context')).toBeNull();
    expect(screen.getByText('Pricing v2')).toBeTruthy();
  });
});
