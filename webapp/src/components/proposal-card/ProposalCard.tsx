// ProposalCard — agent's `propose_content_append` and
// `propose_content_replace` tool calls rendered as a UI surface inline
// in the chat timeline. Five states drive the render branch:
// streaming (tool_call_started before result), pending (full card
// awaiting user decision), accepted (1-line summary), rejected
// (1-line summary), and stale (target/anchor no longer in doc).
//
// The card is the visible end of the agent ↔ user handshake state
// machine; Accept calls into the optimistic flow in TalkDetailPage,
// which applies the patch to the local doc immediately and reconciles
// on the server response.
//
// Sibling: `tool-card-registry.ts` (lookup keyed by tool name).

import { Copy, FileEdit, FilePlus, Replace } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { ContentProposalSummary } from '../../lib/api';

export type ProposalCardAgent = {
  id: string | null;
  label: string;
  monogram: string;
  colorToken: string;
};

export type ProposalCardTargetPreview = {
  anchorId: string;
  kind: string | null;
  text: string;
} | null;

export type ProposalCardState =
  | { kind: 'streaming'; toolName: string }
  | {
      kind: 'pending';
      proposal: ContentProposalSummary;
      acceptInFlight: boolean;
      acceptDisabled: boolean;
      acceptDisabledReason?: string;
      targetPreview?: ProposalCardTargetPreview;
    }
  | {
      kind: 'accepted';
      proposal: ContentProposalSummary;
      driftDetected?: boolean;
    }
  | { kind: 'rejected'; proposal: ContentProposalSummary }
  | { kind: 'stale'; proposal: ContentProposalSummary };

export type ProposalCardProps = {
  agent: ProposalCardAgent;
  state: ProposalCardState;
  onAccept?: () => void;
  onReject?: () => void;
  onCopyMarkdown?: () => void;
};

function formatResolvedTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function PreviewMarkdown({ markdown }: { markdown: string }): JSX.Element {
  return (
    <pre className="proposal-card-preview" aria-label="Proposed markdown">
      {markdown}
    </pre>
  );
}

function AgentMonogram({ agent }: { agent: ProposalCardAgent }): JSX.Element {
  return (
    <span
      className="proposal-card-monogram"
      data-color={agent.colorToken}
      aria-hidden="true"
    >
      {agent.monogram}
    </span>
  );
}

export function ProposalCard({
  agent,
  state,
  onAccept,
  onReject,
  onCopyMarkdown,
}: ProposalCardProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus is managed by the timeline; we just need keyboard shortcuts
  // when the card itself is focused.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (state.kind !== 'pending') return;
      if (event.target !== cardRef.current) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!state.acceptDisabled && !state.acceptInFlight) {
          onAccept?.();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onReject?.();
      }
    },
    [onAccept, onReject, state],
  );

  // When the card transitions away from `pending`, ensure focus doesn't
  // stay on disabled buttons. The timeline returns focus to the
  // composer; this is just defensive cleanup.
  useEffect(() => {
    if (state.kind === 'pending') return;
    if (!cardRef.current) return;
    if (cardRef.current.contains(document.activeElement)) {
      cardRef.current.blur();
    }
  }, [state.kind]);

  if (state.kind === 'streaming') {
    const isReplace = state.toolName === 'propose_content_replace';
    const StreamingIcon = isReplace ? Replace : FileEdit;
    return (
      <div className="proposal-card proposal-card-streaming" role="status">
        <div className="proposal-card-header">
          <StreamingIcon
            size={14}
            className="proposal-card-icon"
            aria-hidden="true"
          />
          <span className="proposal-card-label">
            {isReplace ? 'Replacement proposal' : 'Proposal'}
          </span>
          <AgentMonogram agent={agent} />
          <span className="proposal-card-agent-name">{agent.label}</span>
        </div>
        <div className="proposal-card-streaming-body">
          <span className="proposal-card-streaming-text">
            Preparing proposal…
          </span>
          <div
            className="proposal-card-skeleton-lines"
            aria-hidden="true"
          >
            <span className="proposal-card-skeleton-line" />
            <span className="proposal-card-skeleton-line proposal-card-skeleton-line-short" />
            <span className="proposal-card-skeleton-line" />
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'accepted') {
    const { proposal, driftDetected } = state;
    const isReplace = proposal.kind === 'replace';
    const verbPhrase = isReplace ? 'rewrote a section' : 'added a section';
    const driftLabel =
      isReplace && driftDetected
        ? 'Your edit was overwritten'
        : 'Surroundings shifted';
    const driftTitle =
      isReplace && driftDetected
        ? "You edited this block between when the proposal was written and when you accepted it. The agent's version overwrote yours."
        : 'Surrounding text changed since the proposal was written';
    return (
      <div className="proposal-card proposal-card-accepted">
        <div className="proposal-card-summary-row">
          <AgentMonogram agent={agent} />
          <span className="proposal-card-summary-text">
            {agent.label} {verbPhrase}
            {proposal.rationale ? `: ${proposal.rationale}` : ''} — accepted{' '}
            {formatResolvedTime(proposal.resolvedAt)}
          </span>
          {driftDetected ? (
            <span
              className="proposal-card-drift-pill"
              data-replace={isReplace ? 'true' : 'false'}
              title={driftTitle}
            >
              {driftLabel}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (state.kind === 'rejected') {
    const { proposal } = state;
    return (
      <div className="proposal-card proposal-card-rejected">
        <span className="proposal-card-rejected-text">
          Rejected at {formatResolvedTime(proposal.resolvedAt)}
        </span>
      </div>
    );
  }

  if (state.kind === 'stale') {
    const { proposal } = state;
    const isReplace = proposal.kind === 'replace';
    const StaleIcon = isReplace ? Replace : FilePlus;
    const staleLabel = isReplace
      ? 'Target block no longer in document'
      : 'Anchor no longer in document';
    return (
      <div className="proposal-card proposal-card-stale" aria-disabled="true">
        <div className="proposal-card-header">
          <StaleIcon
            size={14}
            className="proposal-card-icon"
            aria-hidden="true"
          />
          <span className="proposal-card-label">
            {isReplace ? 'Replacement proposal' : 'Proposal'}
          </span>
          <AgentMonogram agent={agent} />
          <span className="proposal-card-agent-name">{agent.label}</span>
          <span className="proposal-card-stale-pill">{staleLabel}</span>
        </div>
        {proposal.rationale ? (
          <p className="proposal-card-rationale">{proposal.rationale}</p>
        ) : null}
        <PreviewMarkdown markdown={proposal.insertedMarkdown} />
        <div className="proposal-card-actions">
          <button
            type="button"
            className="proposal-card-copy-button"
            onClick={onCopyMarkdown}
          >
            <Copy size={12} aria-hidden="true" />
            <span>Copy markdown</span>
          </button>
        </div>
      </div>
    );
  }

  const {
    proposal,
    acceptInFlight,
    acceptDisabled,
    acceptDisabledReason,
    targetPreview,
  } = state;
  const isReplace = proposal.kind === 'replace';
  const PendingIcon = isReplace ? Replace : FilePlus;
  const titleId = `proposal-card-title-${proposal.id}`;
  const rationaleId = proposal.rationale
    ? `proposal-card-rationale-${proposal.id}`
    : undefined;
  const acceptLabel = acceptInFlight ? 'Accepting…' : 'Accept';
  const previewFirstWords = proposal.insertedMarkdown
    .replace(/[#*_`>-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  const acceptAriaLabel = `Accept proposal from ${agent.label}: ${previewFirstWords || 'new content'}`;
  const targetTextTrimmed = targetPreview?.text?.trim() ?? '';
  // Pre-accept drift warning: target block's text doesn't match what the
  // agent saw (target_anchor_baseline_json was a different shape). The
  // amber post-accept pill covers structural drift the server detects.
  const showPreAcceptDriftWarning =
    isReplace && proposal.targetAnchorId !== null && proposal.driftDetected;

  return (
    <div
      ref={cardRef}
      className="proposal-card proposal-card-pending"
      data-kind={proposal.kind}
      role="article"
      aria-labelledby={titleId}
      aria-describedby={rationaleId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="proposal-card-header">
        <PendingIcon
          size={14}
          className="proposal-card-icon"
          aria-hidden="true"
        />
        <span className="proposal-card-label" id={titleId}>
          {isReplace ? 'Replacement proposal' : 'Proposal'}
        </span>
        <AgentMonogram agent={agent} />
        <span className="proposal-card-agent-name">{agent.label}</span>
      </div>
      {proposal.rationale ? (
        <p className="proposal-card-rationale" id={rationaleId}>
          {proposal.rationale}
        </p>
      ) : null}
      {isReplace && targetPreview ? (
        <div className="proposal-card-target-preview">
          <span className="proposal-card-target-label">Replaces:</span>
          <span className="proposal-card-target-text" title={targetTextTrimmed}>
            {targetTextTrimmed.length > 120
              ? `${targetTextTrimmed.slice(0, 117)}…`
              : targetTextTrimmed || '(empty block)'}
          </span>
        </div>
      ) : null}
      {showPreAcceptDriftWarning ? (
        <p className="proposal-card-drift-warning" role="status">
          You edited this block after the agent wrote this proposal. Accepting
          will overwrite your changes.
        </p>
      ) : null}
      <PreviewMarkdown markdown={proposal.insertedMarkdown} />
      <div className="proposal-card-actions">
        <button
          type="button"
          className="proposal-card-accept-button"
          onClick={onAccept}
          disabled={acceptDisabled || acceptInFlight}
          title={acceptDisabled ? acceptDisabledReason : undefined}
          aria-label={acceptAriaLabel}
        >
          {acceptLabel}
        </button>
        <button
          type="button"
          className="proposal-card-reject-button"
          onClick={onReject}
          disabled={acceptInFlight}
          aria-label={`Reject proposal from ${agent.label}`}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
