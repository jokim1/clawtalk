import type { TalkMessage, TalkRun, TalkRunContextSnapshot } from '../lib/api';
import { BrowserBlockedRunCard } from './BrowserBlockedRunCard';
import { ExecutionDecisionSummary } from './ExecutionDecisionSummary';

/** Per-run "View context" disclosure state, page-owned and threaded in. */
export type RunContextPanelState = {
  open: boolean;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  snapshot: TalkRunContextSnapshot | null;
  message?: string;
};

function formatPersonaRoleLabel(
  role: TalkRunContextSnapshot['personaRole'],
): string {
  if (!role) return 'Unspecified';
  return role
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderRunContextSnapshot(
  snapshot: TalkRunContextSnapshot,
): JSX.Element {
  return (
    <div className="run-context-panel">
      <p className="run-context-meta">
        Role: <strong>{formatPersonaRoleLabel(snapshot.personaRole)}</strong>
        {' · '}
        Estimated context: <code>{snapshot.estimatedTokens}</code> tokens
        {' · '}
        History messages: <code>{snapshot.history.turnCount}</code>
      </p>
      {snapshot.roleHint ? (
        <p className="run-context-note">{snapshot.roleHint}</p>
      ) : null}
      {snapshot.activeRules.length > 0 ? (
        <div className="run-context-section">
          <strong>Rules</strong>
          <ul>
            {snapshot.activeRules.map((rule, index) => (
              <li key={`${index}-${rule}`}>{rule}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.stateSnapshot.included.length > 0 ? (
        <div className="run-context-section">
          <strong>State Snapshot</strong>
          <ul>
            {snapshot.stateSnapshot.included.map((entry) => (
              <li key={`${entry.key}-${entry.version}`}>
                <code>{entry.key}</code> v{entry.version}:{' '}
                <code>{JSON.stringify(entry.value)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.retrieval.state.length > 0 ? (
        <div className="run-context-section">
          <strong>Retrieved State</strong>
          <ul>
            {snapshot.retrieval.state.map((entry) => (
              <li key={`${entry.key}-${entry.version}`}>
                <code>{entry.key}</code> v{entry.version}:{' '}
                <code>{JSON.stringify(entry.value)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.retrieval.sources.length > 0 ? (
        <div className="run-context-section">
          <strong>Retrieved Sources</strong>
          <ul>
            {snapshot.retrieval.sources.map((source) => (
              <li key={source.ref}>
                <span>
                  [{source.ref}] {source.title}
                </span>
                <p>{source.excerpt}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.sources.manifest.length > 0 ? (
        <div className="run-context-section">
          <strong>Source Manifest</strong>
          <p className="run-context-meta">
            {snapshot.sources.manifest
              .map((source) => `[${source.ref}] ${source.title}`)
              .join(', ')}
          </p>
        </div>
      ) : null}
      <div className="run-context-section">
        <strong>Available Tools</strong>
        <p className="run-context-meta">
          Context:{' '}
          <code>{snapshot.tools.contextToolNames.join(', ') || 'none'}</code>
        </p>
        <p className="run-context-meta">
          Connectors:{' '}
          <code>{snapshot.tools.connectorToolNames.join(', ') || 'none'}</code>
        </p>
      </div>
    </div>
  );
}

function summarizeMessageForRun(
  message: TalkMessage | undefined,
  messageId: string,
): string {
  if (!message) return messageId;
  const compact = message.content.trim().replace(/\s+/g, ' ');
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  return `${message.role}: ${preview || '(empty)'}`;
}

type TalkRunsPanelProps = {
  runHistory: TalkRun[];
  runContextPanels: Record<string, RunContextPanelState>;
  messageLookup: Map<string, TalkMessage>;
  talkId: string;
  handleOpenRunTrigger: (run: TalkRun) => void;
  handleToggleRunContext: (runId: string) => void;
  handleUnauthorized: () => void;
  refreshBrowserRuns: () => Promise<void> | void;
};

/**
 * Presentational Run History tab. Read-only render over page-derived
 * `runHistory` + `messageLookup`; the per-run "View context" disclosure state
 * (`runContextPanels`) is page-owned and mutated only via the threaded
 * `handleToggleRunContext` callback (the snapshot fetch can resolve after this
 * tab unmounts, so the state must not live here — cf. TalkJobsPanel).
 */
export function TalkRunsPanel({
  runHistory,
  runContextPanels,
  messageLookup,
  talkId,
  handleOpenRunTrigger,
  handleToggleRunContext,
  handleUnauthorized,
  refreshBrowserRuns,
}: TalkRunsPanelProps): JSX.Element {
  return (
    <section
      className="talk-tab-panel run-history-panel"
      aria-label="Run history"
    >
      <h2>Run History</h2>
      {runHistory.length === 0 ? (
        <p className="page-state">No runs yet.</p>
      ) : (
        <ul className="run-history-list">
          {runHistory.map((run) => {
            const runContextPanel = runContextPanels[run.id];
            return (
              <li
                key={run.id}
                id={`run-${run.id}`}
                className="run-history-item"
              >
                <div className="run-history-main">
                  <span
                    className={`run-history-status run-history-status-${run.status}`}
                  >
                    {run.status}
                  </span>
                  <code>{run.id}</code>
                </div>
                {run.targetAgentNickname ? (
                  <p className="run-history-meta">
                    Agent: {run.targetAgentNickname}
                  </p>
                ) : null}
                <div className="run-history-links">
                  {run.triggerMessageId ? (
                    <button
                      type="button"
                      className="run-history-link"
                      onClick={() => handleOpenRunTrigger(run)}
                    >
                      Trigger:{' '}
                      {summarizeMessageForRun(
                        messageLookup.get(run.triggerMessageId),
                        run.triggerMessageId,
                      )}
                    </button>
                  ) : (
                    <span className="run-history-muted">
                      Trigger: not available
                    </span>
                  )}
                  <button
                    type="button"
                    className="secondary-btn run-history-context-toggle"
                    onClick={() => void handleToggleRunContext(run.id)}
                  >
                    {runContextPanel?.status === 'loading'
                      ? 'Loading context…'
                      : runContextPanel?.open
                        ? 'Hide context'
                        : 'View context'}
                  </button>
                </div>
                {run.browserBlock ? (
                  <BrowserBlockedRunCard
                    runId={run.id}
                    browserBlock={run.browserBlock}
                    executionDecision={run.executionDecision}
                    talkId={talkId}
                    onUnauthorized={handleUnauthorized}
                    onStateChanged={refreshBrowserRuns}
                  />
                ) : null}
                {run.status === 'failed' ? (
                  <ExecutionDecisionSummary
                    executionDecision={run.executionDecision}
                  />
                ) : null}
                {runContextPanel?.open ? (
                  <section
                    className="run-context-shell"
                    aria-label={`Context used for run ${run.id}`}
                  >
                    {runContextPanel.status === 'loading' ? (
                      <div className="run-context-panel">
                        <p className="run-context-note">
                          Loading context snapshot…
                        </p>
                      </div>
                    ) : runContextPanel.status === 'error' ? (
                      <div className="run-context-panel">
                        <p className="run-context-note" role="alert">
                          {runContextPanel.message ||
                            'Failed to load run context.'}
                        </p>
                      </div>
                    ) : runContextPanel.snapshot ? (
                      renderRunContextSnapshot(runContextPanel.snapshot)
                    ) : (
                      <div className="run-context-panel">
                        <p className="run-context-note">
                          No saved context snapshot is available for this run.
                        </p>
                      </div>
                    )}
                  </section>
                ) : null}
                {run.status === 'failed' && run.errorMessage ? (
                  <p className="run-history-error">
                    {run.errorCode ? `${run.errorCode}: ` : ''}
                    {run.errorMessage}
                  </p>
                ) : null}
                {run.status === 'cancelled' && run.cancelReason ? (
                  <p className="run-history-muted">
                    Cancel reason: {run.cancelReason}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
