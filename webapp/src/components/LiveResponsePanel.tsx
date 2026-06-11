import { memo } from 'react';

import type { LiveResponseView, RunView } from '../lib/talkRunReducer';
import { renderMarkdown } from '../lib/renderMarkdown';
import { ExecutionDecisionSummary } from './ExecutionDecisionSummary';
import { AgentAvatar, RunPill, type RunStatus } from '../salon';
import { agentAccent } from './agents/agentFormat';

export type PillState =
  | 'queued'
  | 'running'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function resolvePillState(
  response: LiveResponseView,
  run: RunView | undefined,
): PillState {
  if (response.terminalStatus === 'failed' || run?.status === 'failed') {
    return 'failed';
  }
  if (response.terminalStatus === 'cancelled' || run?.status === 'cancelled') {
    return 'cancelled';
  }
  if (response.terminalStatus === 'completed' || run?.status === 'completed') {
    return 'completed';
  }
  if (response.pendingStatus === 'reconnecting') return 'reconnecting';
  if (response.pendingStatus === 'queued' || run?.status === 'queued') {
    return 'queued';
  }
  return 'running';
}

export function pillLabelForState(state: PillState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'reconnecting':
      return 'Reconnecting';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function pillClassForState(state: PillState): string {
  switch (state) {
    case 'queued':
    case 'reconnecting':
      return 'run-history-status run-history-status-queued';
    case 'running':
      return 'run-history-status run-history-status-running';
    case 'completed':
      return 'run-history-status run-history-status-completed';
    case 'failed':
      return 'run-history-status run-history-status-failed';
    case 'cancelled':
      return 'run-history-status run-history-status-cancelled';
  }
}

function runStatusForPill(state: PillState): RunStatus {
  if (state === 'reconnecting') return 'running';
  return state;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function bodyFallback(
  state: PillState,
  response: LiveResponseView,
): string | null {
  if (response.text) return response.text;
  if (response.progressMessage) return response.progressMessage;
  switch (state) {
    case 'queued':
      return 'Queued for dispatch';
    case 'running':
      return 'Starting up…';
    case 'reconnecting':
      return 'Reconnecting to stream…';
    case 'completed':
      return 'Done';
    case 'failed':
    case 'cancelled':
      return null;
  }
}

function initialsFor(label: string): string {
  const words = label
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'AI';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}

function handleFor(label: string): string {
  const slug = label
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `@${slug || 'agent'}`;
}

function tokenLabel(run: RunView | undefined): string | null {
  if (typeof run?.tokensIn !== 'number' || typeof run.tokensOut !== 'number') {
    return null;
  }
  return `${run.tokensIn.toLocaleString()} in · ${run.tokensOut.toLocaleString()} out`;
}

export interface LiveResponsePanelProps {
  response: LiveResponseView;
  run: RunView | undefined;
  agentLabel: string;
  isDense: boolean;
  now: number;
  canRetryAgent: boolean;
  retryPosting: boolean;
  retryError: string | null;
  onRetry: () => void;
  onOpenRunHistory: () => void;
  panelKey: string;
}

function LiveResponsePanelImpl(props: LiveResponsePanelProps): JSX.Element {
  const {
    response,
    run,
    agentLabel,
    isDense,
    now,
    canRetryAgent,
    retryPosting,
    retryError,
    onRetry,
    onOpenRunHistory,
  } = props;

  const state = resolvePillState(response, run);
  const isTerminal =
    state === 'completed' || state === 'failed' || state === 'cancelled';
  const elapsedMs = now - response.queuedAt;
  const elapsedLabel = formatElapsed(elapsedMs);
  // Override the pill label to surface CF Queues retry attempts when the
  // queue handler has emitted a `talk_run_retrying` event. Only swap
  // while the run is still queued — once it goes running/terminal, the
  // retry counter is no longer the most informative thing to show.
  const isRetrying =
    state === 'queued' &&
    typeof response.retryAttempt === 'number' &&
    response.retryAttempt > 0;
  const pillLabel = isRetrying
    ? `Retrying ${response.retryAttempt}/${response.retryMaxRetries ?? 3}`
    : pillLabelForState(state);
  // While live-streaming, the body shows only real text (plus a caret) and the
  // status placeholder moves to an accent progress row below, per the design's
  // streaming AgentMessage (shell.jsx: caret + "Composing" pulse line).
  const isLiveStreaming =
    !isRetrying && (state === 'running' || state === 'reconnecting');
  const body = isRetrying
    ? `Waiting on retry ${response.retryAttempt}/${response.retryMaxRetries ?? 3}…`
    : isLiveStreaming
      ? response.text || null
      : bodyFallback(state, response);
  const progressLabel = isLiveStreaming
    ? response.progressMessage ||
      (response.text ? 'Composing' : bodyFallback(state, response))
    : null;
  const articleClass = [
    'message message-assistant message-live salon-message',
    state === 'failed' ? 'message-error' : '',
    isDense && !isTerminal ? 'is-dense' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = `${agentLabel}, ${pillLabel.toLowerCase()}`;
  // Same seed as the persisted-message avatar in TalkTimelineView, so an
  // agent keeps one accent from streaming through persistence (design:
  // shell.jsx AgentMessage streams with the agent's own accent).
  const accent = agentAccent(response.agentId || agentLabel);

  return (
    <article className={articleClass} aria-label={ariaLabel} aria-live="polite">
      <div className="salon-message-grid">
        <div className="salon-message-avatar">
          <AgentAvatar
            initials={initialsFor(agentLabel)}
            accent={accent}
            size={40}
          />
        </div>
        <div
          className="salon-message-body"
          style={{ borderLeftColor: accent }}
        >
          <header className="salon-message-byline">
            <strong title={agentLabel} className="message-live-label">
              {agentLabel}
            </strong>
            <span className="salon-message-handle">
              {handleFor(agentLabel)}
            </span>
            {response.modelId || run?.executorModel ? (
              <span className="salon-message-model">
                {response.modelId || run?.executorModel}
              </span>
            ) : null}
            <RunPill
              status={runStatusForPill(state)}
              label={pillLabel}
              title={elapsedLabel}
            />
            <span aria-hidden="true" className="salon-message-handle elapsed">
              {elapsedLabel}
            </span>
            {tokenLabel(run) ? (
              <span className="salon-message-tokens">{tokenLabel(run)}</span>
            ) : null}
          </header>
          {body ? (
            <div
              className={`salon-message-markdown${
                isLiveStreaming ? ' salon-message-markdown-streaming' : ''
              }`}
            >
              {renderMarkdown(body)}
              {isLiveStreaming ? (
                <span
                  className="ct-caret"
                  style={{ color: accent }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          ) : null}
          {isLiveStreaming ? (
            <div
              className="message-live-progress"
              style={{ color: accent }}
              aria-hidden="true"
            >
              <span
                className="message-live-progress-dot ct-pulse"
                style={{ background: accent }}
              />
              {progressLabel}
            </div>
          ) : null}
        </div>
      </div>
      {response.errorMessage ? (
        <p className="run-history-error">{response.errorMessage}</p>
      ) : null}
      {state === 'failed' ? (
        <ExecutionDecisionSummary executionDecision={run?.executionDecision} />
      ) : null}
      {state === 'failed' ? (
        <div className="run-history-links">
          {canRetryAgent ? (
            <button
              type="button"
              className="run-history-link"
              onClick={onRetry}
              disabled={retryPosting}
            >
              {retryPosting ? 'Retrying…' : 'Retry agent'}
            </button>
          ) : null}
          <button
            type="button"
            className="run-history-link"
            onClick={onOpenRunHistory}
          >
            Open Run History
          </button>
        </div>
      ) : null}
      {retryError ? <p className="run-history-error">{retryError}</p> : null}
    </article>
  );
}

export const LiveResponsePanel = memo(
  LiveResponsePanelImpl,
  (prev, next): boolean => {
    // Re-render whenever response/run identity changes.
    if (prev.response !== next.response) return false;
    if (prev.run !== next.run) return false;
    if (prev.agentLabel !== next.agentLabel) return false;
    if (prev.isDense !== next.isDense) return false;
    if (prev.canRetryAgent !== next.canRetryAgent) return false;
    if (prev.retryPosting !== next.retryPosting) return false;
    if (prev.retryError !== next.retryError) return false;
    if (prev.onRetry !== next.onRetry) return false;
    if (prev.onOpenRunHistory !== next.onOpenRunHistory) return false;
    // Tick `now` only forces re-render when the panel is non-terminal —
    // terminal panels freeze their elapsed display.
    const prevState = resolvePillState(prev.response, prev.run);
    const prevTerminal =
      prevState === 'completed' ||
      prevState === 'failed' ||
      prevState === 'cancelled';
    if (prevTerminal) return true;
    return prev.now === next.now;
  },
);
