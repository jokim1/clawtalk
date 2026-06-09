import type { RefObject } from 'react';
import { Link } from 'react-router-dom';

import { BrowserBlockedRunCard } from './BrowserBlockedRunCard';
import { InlineEditableTitle } from './InlineEditableTitle';
import { LiveResponsePanel } from './LiveResponsePanel';
import { stripInternalAssistantText } from '../lib/assistantText';
import type { TalkMessage, TalkConversation } from '../lib/api';
import { linkifyText } from '../lib/linkifyText';
import { formatConversationLabel } from '../lib/conversationLabels';
import type {
  OrderedRoundSummary,
  RunView,
  TalkTimelineEntry,
} from '../lib/talkRunReducer';

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
}: TalkTimelineViewProps) {
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
          talkTimeline.map((entry) => {
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
                  }`}
                >
                  <header>
                    <strong>{headerActorLabel}</strong>
                    {orderedStepLabel ? (
                      <span className="message-sequence-badge">
                        {orderedStepLabel}
                      </span>
                    ) : null}
                    {isSynthesis ? (
                      <span className="message-synthesis-badge">Synthesis</span>
                    ) : null}
                    <time>{new Date(message.createdAt).toLocaleString()}</time>
                  </header>
                  <p>
                    {linkifyText(
                      message.role === 'assistant'
                        ? stripInternalAssistantText(message.content)
                        : message.content,
                    )}
                  </p>
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
              <LiveResponsePanel
                key={entry.key}
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
            );
          })
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
