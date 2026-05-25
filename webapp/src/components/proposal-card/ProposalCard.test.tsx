import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContentProposalSummary } from '../../lib/api';
import {
  ProposalCard,
  type ProposalCardAgent,
  type ProposalCardState,
} from './ProposalCard';
import { getToolCard } from './tool-card-registry';

afterEach(() => {
  cleanup();
});

const agent: ProposalCardAgent = {
  id: 'agent-1',
  label: 'Marcus',
  monogram: 'M',
  colorToken: 'green-500',
};

function makeProposal(
  override: Partial<ContentProposalSummary> = {},
): ContentProposalSummary {
  return {
    id: 'proposal-1',
    contentId: 'content-1',
    proposedByRunId: 'run-1',
    proposedByAgentId: 'agent-1',
    proposedByMessageId: 'msg-1',
    kind: 'append',
    afterAnchorId: 'anchor-1',
    insertedMarkdown: '## New section\n\nSome body text here.',
    rationale: 'Captures the missing summary.',
    status: 'pending',
    statusReason: null,
    baseContentVersion: 1,
    baseAnchorContentHash: null,
    appliedAnchorIds: [],
    createdAt: '2026-05-25T00:00:00Z',
    resolvedAt: null,
    resolvedByUserId: null,
    ...override,
  };
}

describe('ProposalCard', () => {
  it('renders the streaming placeholder before a proposal lands', () => {
    const state: ProposalCardState = {
      kind: 'streaming',
      toolName: 'propose_content_append',
    };
    render(<ProposalCard agent={agent} state={state} />);
    expect(screen.getByText('Preparing proposal…')).toBeTruthy();
    expect(screen.getByText('Proposal')).toBeTruthy();
    expect(screen.getByText('Marcus')).toBeTruthy();
  });

  it('renders the pending state with Accept + Reject buttons', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const state: ProposalCardState = {
      kind: 'pending',
      proposal: makeProposal(),
      acceptInFlight: false,
      acceptDisabled: false,
    };
    render(
      <ProposalCard
        agent={agent}
        state={state}
        onAccept={onAccept}
        onReject={onReject}
      />,
    );
    expect(screen.getByText('Captures the missing summary.')).toBeTruthy();
    const accept = screen.getByRole('button', { name: /Accept proposal from Marcus/ });
    const reject = screen.getByRole('button', { name: /Reject proposal from Marcus/ });
    fireEvent.click(accept);
    fireEvent.click(reject);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('shows "Accepting…" + disables Accept while in flight', () => {
    const state: ProposalCardState = {
      kind: 'pending',
      proposal: makeProposal(),
      acceptInFlight: true,
      acceptDisabled: false,
    };
    render(<ProposalCard agent={agent} state={state} />);
    const accept = screen.getByRole('button', {
      name: /Accept proposal from Marcus/,
    }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.textContent).toContain('Accepting…');
  });

  it('respects the acceptDisabled flag with a tooltip reason', () => {
    const state: ProposalCardState = {
      kind: 'pending',
      proposal: makeProposal(),
      acceptInFlight: false,
      acceptDisabled: true,
      acceptDisabledReason: 'Saving edits…',
    };
    render(<ProposalCard agent={agent} state={state} />);
    const accept = screen.getByRole('button', {
      name: /Accept proposal from Marcus/,
    }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.title).toBe('Saving edits…');
  });

  it('Enter on the focused card triggers Accept; Escape triggers Reject', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const state: ProposalCardState = {
      kind: 'pending',
      proposal: makeProposal(),
      acceptInFlight: false,
      acceptDisabled: false,
    };
    render(
      <ProposalCard
        agent={agent}
        state={state}
        onAccept={onAccept}
        onReject={onReject}
      />,
    );
    const card = screen.getByRole('article');
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('Enter does not Accept while the action is disabled', () => {
    const onAccept = vi.fn();
    const state: ProposalCardState = {
      kind: 'pending',
      proposal: makeProposal(),
      acceptInFlight: false,
      acceptDisabled: true,
      acceptDisabledReason: 'Saving edits…',
    };
    render(<ProposalCard agent={agent} state={state} onAccept={onAccept} />);
    const card = screen.getByRole('article');
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('renders the accepted summary with optional drift pill', () => {
    const state: ProposalCardState = {
      kind: 'accepted',
      proposal: makeProposal({
        status: 'accepted',
        resolvedAt: '2026-05-25T12:43:00Z',
      }),
      driftDetected: true,
    };
    render(<ProposalCard agent={agent} state={state} />);
    expect(screen.getByText(/Marcus added a section/)).toBeTruthy();
    expect(screen.getByText(/Surroundings shifted/)).toBeTruthy();
  });

  it('renders the rejected one-liner', () => {
    const state: ProposalCardState = {
      kind: 'rejected',
      proposal: makeProposal({
        status: 'rejected',
        resolvedAt: '2026-05-25T12:44:00Z',
      }),
    };
    render(<ProposalCard agent={agent} state={state} />);
    expect(screen.getByText(/Rejected at/)).toBeTruthy();
  });

  it('renders the stale fallback with a copy-markdown button', () => {
    const onCopy = vi.fn();
    const state: ProposalCardState = {
      kind: 'stale',
      proposal: makeProposal({
        status: 'stale',
        statusReason: 'anchor_removed',
      }),
    };
    render(
      <ProposalCard agent={agent} state={state} onCopyMarkdown={onCopy} />,
    );
    expect(screen.getByText(/Anchor no longer in document/)).toBeTruthy();
    const copy = screen.getByRole('button', { name: /Copy markdown/ });
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('tool-card-registry resolves propose_content_append to ProposalCard', () => {
    expect(getToolCard('propose_content_append')).toBe(ProposalCard);
    expect(getToolCard('unknown_tool')).toBeNull();
  });
});
