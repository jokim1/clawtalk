import type { RefObject } from 'react';
import { Link } from 'react-router-dom';

import { BrowserBlockedRunCard } from './BrowserBlockedRunCard';
import { InlineEditableTitle } from './InlineEditableTitle';
import { LiveResponsePanel } from './LiveResponsePanel';
import { AgentAvatar, RunPill, type RunStatus } from '../salon';
import { getUserAvatar } from './shell/userAvatar';
import { stripInternalAssistantText } from '../lib/assistantText';
import type { SessionUser, TalkMessage, TalkConversation } from '../lib/api';
import { formatConversationLabel } from '../lib/conversationLabels';
import { renderMarkdown } from '../lib/renderMarkdown';
import type {
  OrderedRoundSummary,
  RunView,
  TalkTimelineEntry,
} from '../lib/talkRunReducer';

const AGENT_ACCENTS = [
  '#3f6b5c',
  '#8e3b59',
  '#3d5688',
  '#c8643a',
  '#2a6f7e',
];

function compactDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relativeDayLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  const today = new Date();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).valueOf();
  const parsedMidnight = new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  ).valueOf();
  const diffDays = Math.round((todayMidnight - parsedMidnight) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return parsed.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}

function agentAccent(id: string | null | undefined, label: string): string {
  const source = id || label;
  let hash = 0;
  for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AGENT_ACCENTS[Math.abs(hash) % AGENT_ACCENTS.length]!;
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

function runStatus(status: RunView['status'] | undefined): RunStatus | null {
  if (!status) return null;
  return status === 'awaiting_confirmation' ? 'awaiting' : status;
}

function tokenLabel(run: RunView | null | undefined): string | null {
  const input = run?.tokensIn;
  const output = run?.tokensOut;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return `${input.toLocaleString()} in · ${output.toLocaleString()} out`;
}

function metadataString(
  message: TalkMessage,
  key: string,
): string | null {
  const value = message.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timelineEntryGroupKey(
  entry: TalkTimelineEntry,
  runsById: Record<string, RunView>,
  triggerGroupByMessageId: Record<string, string>,
): string | null {
  if (entry.kind === 'message') {
    if (!entry.message.runId) {
      return triggerGroupByMessageId[entry.message.id] ?? null;
    }
    return runsById[entry.message.runId]?.responseGroupId ?? null;
  }
  if (entry.kind === 'live-response') {
    return entry.response.responseGroupId ?? null;
  }
  if (entry.kind === 'browser-run') return entry.run.responseGroupId ?? null;
  return null;
}

function RoundDivider({ label }: { label: string }): JSX.Element {
  return (
    <div className="talk-round-divider" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}

interface TalkTimelineViewProps {
  timelineRef: RefObject<HTMLDivElement>;
  endRef: RefObject<HTMLDivElement>;
  setMessageElementRef: (
    messageId: string,
    element: HTMLElement | null,
  ) => void;
  activeConversation: TalkConversation | null;
  handleRenameActiveConversation: (title: string) => Promise<void>;
  openHistoryEditor: () => void;
  canEditHistory: boolean;
  activeOrderedProgress: { label: string } | null;
  latestOrderedRound: OrderedRoundSummary | null;
  handleRetryAgentRun: (runId: string) => Promise<void>;
  retryRunState: {
    runId: string;
    status: 'posting' | 'error';
    message: string;
  } | null;
  isSnapshotPending: boolean;
  olderMessagesAvailable: boolean;
  loadingOlderMessages: boolean;
  pageMessages: TalkMessage[];
  handleLoadOlderMessages: () => Promise<void>;
  talkTimeline: TalkTimelineEntry[];
  agentsTabHref: string;
  runsById: Record<string, RunView>;
  orderedGroupSizesById: Record<string, number>;
  agentLabelById: Record<string, string>;
  talkId: string;
  handleUnauthorized: () => void;
  refreshBrowserRuns: () => Promise<void> | void;
  isDenseRound: boolean;
  nowTick: number;
  handleOpenRunHistory: (runId: string) => void;
  hasUnreadBelow: boolean;
  handleClearUnread: () => void;
  currentUser: Pick<SessionUser, 'id' | 'displayName'> | null;
}

export function TalkTimelineView({
  timelineRef,
  endRef,
  setMessageElementRef,
  activeConversation,
  handleRenameActiveConversation,
  openHistoryEditor,
  canEditHistory,
  activeOrderedProgress,
  latestOrderedRound,
  handleRetryAgentRun,
  retryRunState,
  isSnapshotPending,
  olderMessagesAvailable,
  loadingOlderMessages,
  pageMessages,
  handleLoadOlderMessages,
  talkTimeline,
  agentsTabHref,
  runsById,
  orderedGroupSizesById,
  agentLabelById,
  talkId,
  handleUnauthorized,
  refreshBrowserRuns,
  isDenseRound,
  nowTick,
  handleOpenRunHistory,
  hasUnreadBelow,
  handleClearUnread,
  currentUser,
}: TalkTimelineViewProps) {
  const triggerGroupByMessageId = Object.values(runsById).reduce<
    Record<string, string>
  >((groups, run) => {
    if (run.triggerMessageId && run.responseGroupId) {
      groups[run.triggerMessageId] = run.responseGroupId;
    }
    return groups;
  }, {});
  const currentUserName = currentUser?.displayName.trim() || null;
  const currentUserAvatar = currentUser ? getUserAvatar(currentUser) : null;

  return (
    <div
      ref={timelineRef}
      className="talk-thread-scroll"
      aria-label="Talk timeline"
    >
      <div className="talk-thread-detail-header">
        <div>
          {activeConversation ? (
            <InlineEditableTitle
              title={formatConversationLabel(activeConversation)}
              onSave={handleRenameActiveConversation}
              buttonClassName="thread-detail-title-button"
              inputClassName="thread-detail-title-input"
              errorClassName="thread-detail-title-error"
            />
          ) : (
            <h2>New conversation</h2>
          )}
          <p className="policy-muted">
            Use <code>/edit</code> or the button here to remove old messages
            from this conversation.
          </p>
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={openHistoryEditor}
          disabled={!canEditHistory}
        >
          Edit history
        </button>
      </div>

      {activeOrderedProgress ? (
        <div className="talk-ordered-progress" role="status">
          {activeOrderedProgress.label}
        </div>
      ) : null}
      {latestOrderedRound ? (
        <section
          className="talk-ordered-summary"
          aria-label="Ordered round summary"
        >
          <div className="talk-ordered-summary-header">
            <strong className="talk-ordered-summary-title">
              {latestOrderedRound.heading}
            </strong>
            {latestOrderedRound.note ? (
              <span className="talk-ordered-summary-note">
                {latestOrderedRound.note}
              </span>
            ) : null}
            {latestOrderedRound.retryRunId ? (
              <button
                type="button"
                className="run-history-link"
                onClick={() =>
                  void handleRetryAgentRun(latestOrderedRound.retryRunId!)
                }
                disabled={
                  retryRunState?.runId === latestOrderedRound.retryRunId &&
                  retryRunState.status === 'posting'
                }
              >
                {retryRunState?.runId === latestOrderedRound.retryRunId &&
                retryRunState.status === 'posting'
                  ? 'Retrying…'
                  : 'Retry agent'}
              </button>
            ) : null}
          </div>
          <div className="talk-ordered-summary-steps">
            {latestOrderedRound.steps.map((step) => (
              <span
                key={step.runId}
                className={`talk-ordered-step talk-ordered-step-${step.tone}${
                  step.isCurrent ? ' talk-ordered-step-current' : ''
                }`}
                aria-current={step.isCurrent ? 'step' : undefined}
              >
                <span className="talk-ordered-step-index">
                  {step.stepNumber}
                </span>
                <span className="talk-ordered-step-label">{step.label}</span>
                {step.isSynthesis ? (
                  <span className="talk-ordered-step-tag">Synthesis</span>
                ) : null}
                <span className="talk-ordered-step-status">
                  {step.statusLabel}
                </span>
              </span>
            ))}
          </div>
          {latestOrderedRound.retryRunId &&
          retryRunState?.runId === latestOrderedRound.retryRunId &&
          retryRunState.status === 'error' ? (
            <p className="run-history-error">{retryRunState.message}</p>
          ) : null}
        </section>
      ) : null}

      <div className="timeline talk-thread-timeline">
        {!isSnapshotPending &&
        activeConversation &&
        olderMessagesAvailable &&
        !loadingOlderMessages &&
        pageMessages.length > 0 ? (
          <button
            type="button"
            className="timeline-load-earlier"
            onClick={() => void handleLoadOlderMessages()}
          >
            Load earlier messages
          </button>
        ) : null}
        {loadingOlderMessages ? (
          <p className="page-state">Loading earlier…</p>
        ) : null}
        {isSnapshotPending ? (
          <p className="page-state">Loading conversation…</p>
        ) : !activeConversation ? (
          <p className="page-state">No conversation selected.</p>
        ) : talkTimeline.length === 0 ? (
          <div className="talk-onboarding-banner">
            <p>
              This Talk is using the default agent with all tools enabled.{' '}
              <Link to={agentsTabHref} className="talk-onboarding-link">
                Customize →
              </Link>
            </p>
            <p className="page-state">No messages yet.</p>
          </div>
        ) : (
          (() => {
            let lastGroupKey: string | null = null;
            let roundCount = 0;
            return talkTimeline.map((entry, index) => {
              const entryGroupKey = timelineEntryGroupKey(
                entry,
                runsById,
                triggerGroupByMessageId,
              );
              const groupKey = entryGroupKey ?? `solo-${index}`;
              const shouldShowRound =
                index === 0 || (entryGroupKey && groupKey !== lastGroupKey);
              if (shouldShowRound) {
                roundCount += 1;
              }
              lastGroupKey = groupKey;
              const round = shouldShowRound ? (
                <RoundDivider label={`Round ${roundCount}`} />
              ) : null;

            if (entry.kind === 'message') {
              const { message } = entry;
              const isSynthesis = message.metadata?.isSynthesis === true;
              const orderedRun = message.runId ? runsById[message.runId] : null;
              const orderedGroupSize = orderedRun?.responseGroupId
                ? (orderedGroupSizesById[orderedRun.responseGroupId] ?? null)
                : null;
              const orderedStepLabel =
                orderedRun?.sequenceIndex != null &&
                orderedGroupSize &&
                orderedGroupSize > 1
                  ? `Step ${orderedRun.sequenceIndex + 1} of ${orderedGroupSize}`
                  : null;
              const agentLabel =
                (message.agentId && agentLabelById[message.agentId]) ||
                message.agentNickname ||
                null;
              const actorLabel =
                message.role === 'user'
                  ? currentUserName || metadataString(message, 'author') || 'You'
                  : message.role === 'assistant' && agentLabel
                    ? agentLabel
                    : agentLabel || message.role;
              const modelLabel =
                orderedRun?.executorModel ||
                metadataString(message, 'modelId') ||
                metadataString(message, 'model') ||
                null;
              const status = runStatus(orderedRun?.status);
              const tokens = tokenLabel(orderedRun);
              const headerActorLabel =
                message.role === 'assistant' && agentLabel
                  ? agentLabel
                  : agentLabel
                    ? `${agentLabel} · ${message.role}`
                    : message.role;
              return (
                <article
                  key={entry.key}
                  id={`message-${message.id}`}
                  ref={(element) => setMessageElementRef(message.id, element)}
                  className={`message message-${message.role}${
                    isSynthesis ? ' message-synthesis' : ''
                  } salon-message`}
                >
                  {round}
                  <div className="salon-message-grid">
                    <div className="salon-message-avatar">
                      <AgentAvatar
                        initials={
                          message.role === 'user' && currentUserAvatar
                            ? currentUserAvatar.initials
                            : initialsFor(actorLabel)
                        }
                        accent={
                          message.role === 'user'
                            ? currentUserAvatar?.color || '#1f1b16'
                            : agentAccent(message.agentId, actorLabel)
                        }
                        size={40}
                        title={actorLabel}
                      />
                    </div>
                    <div className="salon-message-body">
                      <header className="salon-message-byline">
                        <strong>{actorLabel}</strong>
                        {message.role === 'assistant' ? (
                          <span className="salon-message-handle">
                            {handleFor(headerActorLabel)}
                          </span>
                        ) : (
                          <>
                            <span className="salon-message-handle">
                              {relativeDayLabel(message.createdAt)}
                            </span>
                            <span className="salon-message-handle">
                              @all-agents
                            </span>
                          </>
                        )}
                        {modelLabel ? (
                          <span className="salon-message-model">
                            {modelLabel}
                          </span>
                        ) : null}
                        {status ? <RunPill status={status} /> : null}
                        {orderedStepLabel ? (
                          <span className="message-sequence-badge">
                            {orderedStepLabel}
                          </span>
                        ) : null}
                        {isSynthesis ? (
                          <span className="message-synthesis-badge">
                            Synthesis
                          </span>
                        ) : null}
                        {message.role === 'assistant' ? (
                          <time>{compactDateTime(message.createdAt)}</time>
                        ) : null}
                        {tokens ? (
                          <span className="salon-message-tokens">{tokens}</span>
                        ) : null}
                      </header>
                      <div className="salon-message-markdown">
                        {renderMarkdown(
                          message.role === 'assistant'
                            ? stripInternalAssistantText(message.content)
                            : message.content,
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              );
            }

            if (entry.kind === 'browser-run') {
              const { run } = entry;
              return run.browserBlock ? (
                <article
                  key={entry.key}
                  className="message message-system main-run-chip"
                >
                  <header>
                    <strong>{run.targetAgentNickname || 'Browser'}</strong>
                    <time>
                      {new Date(
                        run.browserBlock.updatedAt || run.createdAt,
                      ).toLocaleString()}
                    </time>
                  </header>
                  <BrowserBlockedRunCard
                    runId={run.id}
                    browserBlock={run.browserBlock}
                    executionDecision={run.executionDecision}
                    talkId={talkId}
                    onUnauthorized={handleUnauthorized}
                    onStateChanged={refreshBrowserRuns}
                  />
                </article>
              ) : null;
            }

            const { response } = entry;
            const label =
              (response.agentId && agentLabelById[response.agentId]) ||
              response.agentNickname ||
              'Assistant';
            const failedRun = runsById[response.runId];
            const canRetryAgent =
              response.terminalStatus === 'failed' &&
              failedRun?.errorCode === 'incomplete_response' &&
              Boolean(failedRun.triggerMessageId && failedRun.targetAgentId);
            const retryPosting =
              retryRunState?.runId === response.runId &&
              retryRunState.status === 'posting';
            const retryError =
              retryRunState?.runId === response.runId &&
              retryRunState.status === 'error'
                ? retryRunState.message
                : null;
            return (
              <div key={entry.key}>
                {round}
                <LiveResponsePanel
                  panelKey={entry.key}
                  response={response}
                  run={failedRun}
                  agentLabel={label}
                  isDense={isDenseRound}
                  now={nowTick}
                  canRetryAgent={canRetryAgent}
                  retryPosting={retryPosting}
                  retryError={retryError}
                  onRetry={() => void handleRetryAgentRun(response.runId)}
                  onOpenRunHistory={() => handleOpenRunHistory(response.runId)}
                />
              </div>
            );
            });
          })()
        )}
      </div>

      {hasUnreadBelow ? (
        <button
          type="button"
          className="timeline-new-indicator"
          onClick={handleClearUnread}
        >
          New messages
        </button>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
