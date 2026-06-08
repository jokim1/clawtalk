import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Link } from 'react-router-dom';

import type { Talk, TalkAgent } from '../../lib/api';
import {
  buildAgentLabel,
  type TalkAgentExecutionGuardrail,
} from '../../lib/talkAgents';
import type {
  TalkDetailTabKey,
  TalkDetailTabLinks,
} from '../../hooks/useTalkDetailTabs';

type TalkOrchestrationMode = Talk['orchestrationMode'];

const ORCHESTRATION_MODE_OPTIONS: ReadonlyArray<{
  value: TalkOrchestrationMode;
  label: string;
}> = [
  { value: 'ordered', label: 'Ordered' },
  { value: 'panel', label: 'Parallel' },
];

const ORCHESTRATION_MODE_TOOLTIP =
  'Ordered is turn based synthesis focused multi-agent response. Parallel is fast independent response.';

function getOrchestrationModeLabel(mode: TalkOrchestrationMode): string {
  return mode === 'ordered' ? 'Ordered' : 'Parallel';
}

function OrchestrationModeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M2.25 4.5A1.75 1.75 0 0 1 4 2.75h5.25A1.75 1.75 0 0 1 11 4.5v1.75A1.75 1.75 0 0 1 9.25 8H6.64L3.8 10.12a.5.5 0 0 1-.8-.4V8.97A1.75 1.75 0 0 1 2.25 7.3V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <path
        d="M6.25 6.75h5.25A1.25 1.25 0 0 1 12.75 8v1.1A1.25 1.25 0 0 1 11.5 10.35H9.52l-1.97 1.47a.5.5 0 0 1-.8-.4v-1.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function OrchestrationChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="m4.25 6.5 3.75 3.5 3.75-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function OrchestrationCheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M3.5 8.25 6.4 11.1 12.5 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

type TalkDetailShellProps = {
  talkId: string;
  displayedTitle: string;
  isRenaming: boolean;
  renameDraft: { talkId: string; draft: string } | null;
  titleInputRef: RefObject<HTMLInputElement>;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  currentTab: TalkDetailTabKey;
  tabLinks: TalkDetailTabLinks;
  activeRuleCount: number;
  showOrchestrationSelector: boolean;
  orchestrationMenuRef: RefObject<HTMLDivElement>;
  orchestrationMenuOpen: boolean;
  setOrchestrationMenuOpen: Dispatch<SetStateAction<boolean>>;
  orchestrationMode: TalkOrchestrationMode;
  orchestrationState: {
    status: 'idle' | 'saving' | 'error';
    message?: string;
  };
  onOrchestrationModeChange: (mode: TalkOrchestrationMode) => void;
  currentThreadHasContent: boolean;
  openDocModal: () => void;
  effectiveAgents: TalkAgent[];
  talkAgentExecutionGuardrailsById: Record<string, TalkAgentExecutionGuardrail>;
};

export function TalkDetailShell({
  talkId,
  displayedTitle,
  isRenaming,
  renameDraft,
  titleInputRef,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  currentTab,
  tabLinks,
  activeRuleCount,
  showOrchestrationSelector,
  orchestrationMenuRef,
  orchestrationMenuOpen,
  setOrchestrationMenuOpen,
  orchestrationMode,
  orchestrationState,
  onOrchestrationModeChange,
  currentThreadHasContent,
  openDocModal,
  effectiveAgents,
  talkAgentExecutionGuardrailsById,
}: TalkDetailShellProps): JSX.Element {
  const orchestrationModeLabel = getOrchestrationModeLabel(orchestrationMode);

  return (
    <div className="talk-workspace-header">
      <header className="page-header talk-page-header">
        <div className="talk-page-heading">
          <div className="talk-page-topbar">
            {isRenaming ? (
              <input
                ref={titleInputRef}
                className="talk-title-input"
                type="text"
                value={renameDraft?.draft ?? ''}
                onChange={(event) =>
                  onRenameDraftChange(talkId, event.target.value)
                }
                onKeyDown={async (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    await onRenameDraftCommit(talkId, renameDraft?.draft ?? '');
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onRenameDraftCancel(talkId);
                  }
                }}
                onBlur={() => {
                  void onRenameDraftCommit(talkId, renameDraft?.draft ?? '');
                }}
                aria-label="Talk title"
              />
            ) : (
              <h1 className="talk-title">
                <button
                  type="button"
                  className="talk-title-button"
                  onClick={() => onRenameDraftChange(talkId, displayedTitle)}
                  aria-label="Rename talk title"
                  title="Rename talk title"
                >
                  {displayedTitle}
                </button>
              </h1>
            )}
            <div className="talk-tabs-stack">
              <div className="talk-tabs-row">
                <nav className="talk-tabs" aria-label="Talk sections">
                  <Link
                    to={tabLinks.threadAwareTalkTabHref}
                    className={`talk-tab ${currentTab === 'talk' ? 'talk-tab-active' : ''}`}
                  >
                    Talk
                  </Link>
                  <Link
                    to={tabLinks.documentsTabHref}
                    className={`talk-tab ${currentTab === 'documents' ? 'talk-tab-active' : ''}`}
                  >
                    Documents
                  </Link>
                  <Link
                    to={tabLinks.agentsTabHref}
                    className={`talk-tab ${currentTab === 'agents' ? 'talk-tab-active' : ''}`}
                  >
                    Agents
                  </Link>
                  <Link
                    to={tabLinks.contextTabHref}
                    className={`talk-tab ${currentTab === 'context' ? 'talk-tab-active' : ''}`}
                  >
                    Context
                    <span
                      className="talk-tab-badge"
                      aria-label={`${activeRuleCount} active rules`}
                    >
                      {activeRuleCount}
                    </span>
                  </Link>
                  <Link
                    to={tabLinks.workspaceConnectorsTabHref}
                    className={`talk-tab ${currentTab === 'connectors' ? 'talk-tab-active' : ''}`}
                  >
                    Connectors
                  </Link>
                  <Link
                    to={tabLinks.jobsTabHref}
                    className={`talk-tab ${currentTab === 'jobs' ? 'talk-tab-active' : ''}`}
                  >
                    Jobs
                  </Link>
                  <Link
                    to={tabLinks.runsTabHref}
                    className={`talk-tab ${currentTab === 'runs' ? 'talk-tab-active' : ''}`}
                  >
                    Run History
                  </Link>
                </nav>
                {showOrchestrationSelector ? (
                  <div
                    className="talk-orchestration-menu"
                    ref={orchestrationMenuRef}
                  >
                    <button
                      type="button"
                      className={`talk-orchestration-trigger${
                        orchestrationMenuOpen
                          ? ' talk-orchestration-trigger-open'
                          : ''
                      }`}
                      onClick={() =>
                        setOrchestrationMenuOpen((current) => !current)
                      }
                      aria-expanded={orchestrationMenuOpen}
                      aria-haspopup="menu"
                      aria-label={`Response mode, ${orchestrationModeLabel}`}
                      title={ORCHESTRATION_MODE_TOOLTIP}
                      disabled={orchestrationState.status === 'saving'}
                    >
                      <span
                        className="talk-orchestration-trigger-icon"
                        aria-hidden="true"
                      >
                        <OrchestrationModeIcon />
                      </span>
                      <span className="talk-orchestration-trigger-text">
                        {orchestrationModeLabel}
                      </span>
                      <span
                        className="talk-orchestration-trigger-chevron"
                        aria-hidden="true"
                      >
                        <OrchestrationChevronIcon />
                      </span>
                    </button>
                    {orchestrationMenuOpen ? (
                      <div
                        className="talk-orchestration-dropdown"
                        role="menu"
                        aria-label="Response mode options"
                      >
                        {ORCHESTRATION_MODE_OPTIONS.map((option) => {
                          const selected = orchestrationMode === option.value;
                          return (
                            <button
                              type="button"
                              key={option.value}
                              className={`talk-orchestration-option${
                                selected
                                  ? ' talk-orchestration-option-selected'
                                  : ''
                              }`}
                              role="menuitemradio"
                              aria-checked={selected}
                              onClick={() => {
                                setOrchestrationMenuOpen(false);
                                onOrchestrationModeChange(option.value);
                              }}
                            >
                              <span>{option.label}</span>
                              {selected ? (
                                <span
                                  className="talk-orchestration-option-check"
                                  aria-hidden="true"
                                >
                                  <OrchestrationCheckIcon />
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {!currentThreadHasContent ? (
                  <button
                    type="button"
                    className="talk-tabs-add-doc"
                    onClick={openDocModal}
                    aria-label="Add a document to this thread"
                    title="Add a document to this thread"
                  >
                    + Doc
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {effectiveAgents.length > 0 ? (
            <div
              className="talk-status-strip"
              role="list"
              aria-label="Talk agent status"
            >
              {effectiveAgents.map((agent) => {
                const guardrail = talkAgentExecutionGuardrailsById[agent.id];
                return (
                  <span
                    key={agent.id}
                    className={`talk-status-pill talk-status-pill-${agent.health}`}
                    role="listitem"
                    title={guardrail?.message || undefined}
                  >
                    <span
                      className={`talk-status-dot talk-status-dot-${agent.health}`}
                      aria-hidden="true"
                    />
                    <span>{buildAgentLabel(agent)}</span>
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
                  </span>
                );
              })}
            </div>
          ) : null}
          {orchestrationState.status === 'error' ? (
            <p className="talk-thread-search-error" role="alert">
              {orchestrationState.message}
            </p>
          ) : null}
        </div>
      </header>
    </div>
  );
}
