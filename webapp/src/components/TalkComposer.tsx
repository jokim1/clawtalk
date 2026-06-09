import type {
  Dispatch,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  SetStateAction,
} from 'react';

import type { ContextSource, TalkAgent } from '../lib/api';
import {
  buildAgentLabel,
  type TalkAgentExecutionGuardrail,
} from '../lib/talkAgents';
import {
  SourceMentionPicker,
  type SourceMentionOption,
} from './SourceMentionPicker';

// Prop-contract copies of page-owned reducer/state shapes. Kept structural so
// the composer imports nothing back from TalkDetailPage (no cycle); the call
// site type-checks against the page's actual values.
type ComposerSendState = {
  status: 'idle' | 'posting' | 'error';
  error?: string;
  lastDraft?: string;
};
type ComposerCancelState = {
  status: 'idle' | 'posting' | 'success' | 'error';
  message?: string;
};
type ComposerHistoryEditState = {
  status: 'idle' | 'saving' | 'error' | 'success';
  message?: string;
};
type ComposerMentionState = { atIndex: number; selectedIndex: number } | null;

function ComposerCancelRunsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.4 5.4 10.6 10.6M10.6 5.4 5.4 10.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ComposerSendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M2 13.2 14 8 2 2.8l1.53 4.08L9.2 8l-5.67 1.12L2 13.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function buildAgentChipLabel(agent: Pick<TalkAgent, 'nickname'>): string {
  return agent.nickname;
}

type TalkComposerProps = {
  handleSend: (event: FormEvent) => void;
  effectiveAgents: TalkAgent[];
  targetAgentIds: string[];
  talkAgentExecutionGuardrailsById: Record<string, TalkAgentExecutionGuardrail>;
  selectedGuardrailAgentIds: Set<string>;
  handleToggleTarget: (agentId: string) => void;
  sendState: ComposerSendState;
  composerTargetHelp: string;
  composerModeLabel: string;
  composerRoundsLabel: string;
  draft: string;
  TALK_MESSAGE_MAX_CHARS: number;
  composerGuardrailMessage: string | null;
  mentionState: ComposerMentionState;
  mentionOptions: SourceMentionOption[];
  insertMentionOption: (option: SourceMentionOption) => void;
  setMentionState: Dispatch<SetStateAction<ComposerMentionState>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  handleDraftChange: (value: string) => void;
  handleComposerKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  hasDocument: boolean;
  contextSources: ContextSource[];
  activeRound: boolean;
  hasUnsavedAgentChanges: boolean;
  activeConversationId: string | null;
  canEditAgents: boolean;
  handleCancelRuns: () => void;
  cancelState: ComposerCancelState;
  sendBlockedByGuardrail: boolean;
  historyEditState: ComposerHistoryEditState;
};

/**
 * Presentational message composer (target chips, char count, guardrail banner,
 * @-mention textarea, cancel/send actions). Mutation-written state stays
 * page-owned and is threaded in; the page also keeps the textarea ref because
 * the @-mention cursor math and autosize effects read it.
 */
export function TalkComposer({
  handleSend,
  effectiveAgents,
  targetAgentIds,
  talkAgentExecutionGuardrailsById,
  selectedGuardrailAgentIds,
  handleToggleTarget,
  sendState,
  composerTargetHelp,
  composerModeLabel,
  composerRoundsLabel,
  draft,
  TALK_MESSAGE_MAX_CHARS,
  composerGuardrailMessage,
  mentionState,
  mentionOptions,
  insertMentionOption,
  setMentionState,
  textareaRef,
  handleDraftChange,
  handleComposerKeyDown,
  hasDocument,
  contextSources,
  activeRound,
  hasUnsavedAgentChanges,
  activeConversationId,
  canEditAgents,
  handleCancelRuns,
  cancelState,
  sendBlockedByGuardrail,
  historyEditState,
}: TalkComposerProps): JSX.Element {
  return (
    <form className="composer talk-workspace-composer" onSubmit={handleSend}>
      <div
        className="composer-targets"
        role="group"
        aria-label="Selected agents"
      >
        <span className="composer-targets-label">Address to</span>
        {effectiveAgents.map((agent) => {
          const selected = targetAgentIds.includes(agent.id);
          const guardrail = talkAgentExecutionGuardrailsById[agent.id];
          const hasGuardrailViolation = selectedGuardrailAgentIds.has(agent.id);
          const agentLabel = buildAgentLabel(agent);
          const chipStateLabel = selected
            ? `Addressed to ${agentLabel}`
            : `Not addressed to ${agentLabel}. Click to include this agent.`;
          return (
            <button
              key={agent.id}
              type="button"
              className={`composer-target-chip${
                selected
                  ? ' composer-target-chip-selected'
                  : ' composer-target-chip-unselected'
              }${hasGuardrailViolation ? ' composer-target-chip-warning' : ''}`}
              onClick={() => handleToggleTarget(agent.id)}
              disabled={sendState.status === 'posting'}
              aria-pressed={selected}
              aria-label={
                agent.isPrimary
                  ? `${chipStateLabel} Primary`
                  : chipStateLabel
              }
              title={
                guardrail?.message ||
                (selected
                  ? 'This agent is addressed for the next message.'
                  : 'This agent is not addressed. Click to include it.')
              }
            >
              <span
                className={`talk-status-dot talk-status-dot-${agent.health}`}
                aria-hidden="true"
              />
              <span>{buildAgentChipLabel(agent)}</span>
              {guardrail?.badgeLabel ? (
                <span
                  className={`talk-status-constraint talk-status-constraint-${guardrail.kind}`}
                >
                  {guardrail.badgeLabel}
                </span>
              ) : null}
              {agent.isPrimary ? (
                <span className="talk-status-primary">Primary</span>
              ) : null}
            </button>
          );
        })}
        <span className="composer-chip composer-mode-chip">
          {composerModeLabel}
        </span>
        <span className="composer-chip composer-rounds-chip">
          {composerRoundsLabel}
        </span>
      </div>
      <div className="composer-meta-row">
        <p className="composer-target-help">{composerTargetHelp}</p>
        <span className="composer-count">
          {draft.length}/{TALK_MESSAGE_MAX_CHARS}
        </span>
      </div>
      {composerGuardrailMessage ? (
        <div
          className="inline-banner inline-banner-warning"
          role="status"
          aria-live="polite"
        >
          {composerGuardrailMessage}
        </div>
      ) : null}

      <div className="composer-input-shell" style={{ position: 'relative' }}>
        {mentionState && mentionOptions.length > 0 ? (
          <SourceMentionPicker
            options={mentionOptions}
            selectedIndex={mentionState.selectedIndex}
            onSelect={(option) => insertMentionOption(option)}
            onDismiss={() => setMentionState(null)}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={
            hasDocument || contextSources.some((s) => s.status === 'ready')
              ? 'Send a message to this conversation. Type @ to reference a saved source or the doc.'
              : 'Send a message to this conversation.'
          }
          rows={1}
          maxLength={TALK_MESSAGE_MAX_CHARS}
          disabled={
            sendState.status === 'posting' ||
            activeRound ||
            hasUnsavedAgentChanges ||
            !activeConversationId
          }
        />

        <div className="composer-controls">
          <div className="composer-tool-buttons">
            {canEditAgents && activeRound ? (
              <button
                type="button"
                className="composer-icon-btn composer-cancel-btn"
                onClick={handleCancelRuns}
                disabled={cancelState.status === 'posting'}
                aria-label="Cancel Runs"
                title={
                  cancelState.status === 'posting'
                    ? 'Cancelling runs…'
                    : 'Cancel runs'
                }
              >
                <ComposerCancelRunsIcon />
              </button>
            ) : null}
          </div>
          <button
            type="submit"
            className="composer-icon-btn composer-send-btn"
            disabled={
              sendState.status === 'posting' ||
              activeRound ||
              hasUnsavedAgentChanges ||
              !activeConversationId ||
              sendBlockedByGuardrail
            }
            aria-label="Send"
            title={sendState.status === 'posting' ? 'Sending…' : 'Send'}
          >
            <span className="composer-send-label">Send to room</span>
            <ComposerSendIcon />
          </button>
        </div>
      </div>

      {activeRound ? (
        <div className="inline-banner inline-banner-warning" role="status">
          Wait for the current round to finish or cancel it before sending
          another message.
        </div>
      ) : null}

      {!activeRound && hasUnsavedAgentChanges ? (
        <div className="inline-banner inline-banner-warning" role="status">
          Save agent changes before sending a message.
        </div>
      ) : null}

      {sendState.status === 'error' ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {sendState.error || 'Unable to send message.'}
        </div>
      ) : null}

      {historyEditState.status === 'success' ? (
        <div className="inline-banner inline-banner-success" role="status">
          {historyEditState.message}
        </div>
      ) : null}

      {historyEditState.status === 'error' ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {historyEditState.message}
        </div>
      ) : null}

      {cancelState.status === 'success' ? (
        <div className="inline-banner inline-banner-success" role="status">
          {cancelState.message}
        </div>
      ) : null}

      {cancelState.status === 'error' ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {cancelState.message}
        </div>
      ) : null}
    </form>
  );
}
