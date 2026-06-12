import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { Link } from 'react-router-dom';

import type { Talk, TalkAgent } from '../../lib/api';
import {
  buildAgentLabel,
  type TalkAgentExecutionGuardrail,
} from '../../lib/talkAgents';
import type { TalkDetailTabKey } from '../../hooks/useTalkDetailTabs';
import { CTIcon, Popover } from '../../salon';
import { TalkToolsPill } from './TalkToolsPill';

type TalkOrchestrationMode = Talk['orchestrationMode'];

export const TALK_SIDE_PANEL_KEYS = [
  'agents',
  'context',
  'connectors',
  'jobs',
] as const;

export type TalkSidePanelKey = (typeof TALK_SIDE_PANEL_KEYS)[number];

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
  /** Sidebar folder containing this talk; null = loose (Inbox). */
  folderTitle: string | null;
  toolsRefreshKey: number;
  isRenaming: boolean;
  renameDraft: { talkId: string; draft: string } | null;
  titleInputRef: RefObject<HTMLInputElement>;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  currentTab: TalkDetailTabKey;
  runHistoryHref: string;
  sidePanel: TalkSidePanelKey | null;
  onToggleSidePanel: (panel: TalkSidePanelKey) => void;
  onToggleDocuments: () => void;
  documentsOpen: boolean;
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
  currentConversationHasContent: boolean;
  effectiveAgents: TalkAgent[];
  talkAgentExecutionGuardrailsById: Record<string, TalkAgentExecutionGuardrail>;
};

export function TalkDetailShell({
  talkId,
  displayedTitle,
  folderTitle,
  toolsRefreshKey,
  isRenaming,
  renameDraft,
  titleInputRef,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  currentTab,
  runHistoryHref,
  sidePanel,
  onToggleSidePanel,
  onToggleDocuments,
  documentsOpen,
  activeRuleCount,
  showOrchestrationSelector,
  orchestrationMenuRef,
  orchestrationMenuOpen,
  setOrchestrationMenuOpen,
  orchestrationMode,
  orchestrationState,
  onOrchestrationModeChange,
  currentConversationHasContent,
  effectiveAgents,
  talkAgentExecutionGuardrailsById,
}: TalkDetailShellProps): JSX.Element {
  const orchestrationModeLabel = getOrchestrationModeLabel(orchestrationMode);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchorRect, setMoreAnchorRect] = useState<DOMRect | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const activePanel =
    currentTab === 'agents'
      ? 'agents'
      : currentTab === 'context'
        ? 'context'
        : currentTab === 'connectors'
          ? 'connectors'
          : currentTab === 'jobs'
            ? 'jobs'
            : sidePanel;
  const commandButtonClass = (active: boolean) =>
    `talk-tab talk-command-tab${active ? ' talk-tab-active' : ''}`;
  const handleMoreSidePanel = (panel: TalkSidePanelKey) => {
    setMoreOpen(false);
    onToggleSidePanel(panel);
  };
  const handleMoreDocuments = () => {
    setMoreOpen(false);
    onToggleDocuments();
  };

  return (
    <div className="talk-workspace-header">
      <header className="page-header talk-page-header">
        <div className="talk-page-heading">
          <div className="talk-breadcrumb" aria-label="Talk location">
            <CTIcon name="folder" size={12} strokeWidth={1.6} />
            <span className="talk-breadcrumb-folder">
              {folderTitle ?? 'Inbox'}
            </span>
            <CTIcon name="chevron-r" size={10} strokeWidth={1.8} />
            <span className="talk-breadcrumb-meta">
              {orchestrationModeLabel} mode · {effectiveAgents.length}{' '}
              {effectiveAgents.length === 1 ? 'agent' : 'agents'}
            </span>
          </div>
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
              <nav className="talk-tabs-row" aria-label="Talk controls">
                <div className="talk-tabs talk-tabs-primary">
                  <button
                    type="button"
                    className={commandButtonClass(activePanel === 'agents')}
                    onClick={() => onToggleSidePanel('agents')}
                    aria-pressed={activePanel === 'agents'}
                    title="Open the Room panel"
                  >
                    <CTIcon name="sparkle" size={13} strokeWidth={1.7} />
                    Agents
                    <span className="talk-tab-badge" aria-hidden="true">
                      {effectiveAgents.length}
                    </span>
                  </button>
                </div>
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
                {/* key remounts per talk so a slow fetch can't show the
                    previous talk's tool count. */}
                <TalkToolsPill
                  key={talkId}
                  talkId={talkId}
                  refreshKey={toolsRefreshKey}
                />
                <button
                  type="button"
                  className={commandButtonClass(activePanel === 'context')}
                  onClick={() => onToggleSidePanel('context')}
                  aria-pressed={activePanel === 'context'}
                  aria-label={`Context, ${activeRuleCount} active ${
                    activeRuleCount === 1 ? 'rule' : 'rules'
                  }`}
                  title="Open Context panel"
                >
                  <CTIcon name="bolt" size={13} strokeWidth={1.7} />
                  Context
                  <span className="talk-tab-badge" aria-hidden="true">
                    {activeRuleCount}
                  </span>
                </button>
                <button
                  type="button"
                  className={commandButtonClass(activePanel === 'connectors')}
                  onClick={() => onToggleSidePanel('connectors')}
                  aria-pressed={activePanel === 'connectors'}
                  title="Open Connectors panel"
                >
                  <CTIcon name="globe" size={13} strokeWidth={1.7} />
                  Connectors
                </button>
                <button
                  type="button"
                  className={commandButtonClass(activePanel === 'jobs')}
                  onClick={() => onToggleSidePanel('jobs')}
                  aria-pressed={activePanel === 'jobs'}
                  title="Open Jobs placeholder"
                >
                  <CTIcon name="clock" size={13} strokeWidth={1.7} />
                  Jobs
                  <span
                    className="talk-tab-badge talk-tab-badge-muted"
                    aria-hidden="true"
                  >
                    Soon
                  </span>
                </button>
                <div className="talk-tabs-far-actions">
                  <button
                    type="button"
                    className={commandButtonClass(
                      documentsOpen || currentTab === 'documents',
                    )}
                    onClick={onToggleDocuments}
                    aria-pressed={documentsOpen || currentTab === 'documents'}
                    title={
                      currentConversationHasContent
                        ? 'Open or close the document pane'
                        : 'Add a document to this conversation'
                    }
                  >
                    <CTIcon name="doc" size={13} strokeWidth={1.7} />
                    Documents
                  </button>
                  <button
                    ref={moreButtonRef}
                    type="button"
                    className={`talk-tab talk-command-tab talk-more-trigger${
                      moreOpen || currentTab === 'runs'
                        ? ' talk-tab-active'
                        : ''
                    }`}
                    onClick={() => {
                      setMoreAnchorRect(
                        moreButtonRef.current?.getBoundingClientRect() ?? null,
                      );
                      setMoreOpen((current) => !current);
                    }}
                    aria-haspopup="dialog"
                    aria-expanded={moreOpen}
                    aria-label="More Talk actions"
                    title="More Talk actions"
                  >
                    <CTIcon name="more" size={14} strokeWidth={1.8} />
                  </button>
                  {moreOpen ? (
                    <Popover
                      anchorRect={moreAnchorRect}
                      onClose={() => setMoreOpen(false)}
                      width={240}
                      ariaLabel="More Talk actions"
                    >
                      <div className="talk-more-menu">
                        <div className="talk-more-menu-mobile-actions">
                          <button
                            type="button"
                            className="talk-more-menu-item"
                            onClick={() => handleMoreSidePanel('agents')}
                          >
                            <CTIcon
                              name="sparkle"
                              size={13}
                              strokeWidth={1.7}
                            />
                            Agents
                          </button>
                          <button
                            type="button"
                            className="talk-more-menu-item"
                            onClick={() => handleMoreSidePanel('context')}
                          >
                            <CTIcon name="bolt" size={13} strokeWidth={1.7} />
                            Context
                          </button>
                          <button
                            type="button"
                            className="talk-more-menu-item"
                            onClick={() => handleMoreSidePanel('connectors')}
                          >
                            <CTIcon name="globe" size={13} strokeWidth={1.7} />
                            Connectors
                          </button>
                          <button
                            type="button"
                            className="talk-more-menu-item"
                            onClick={() => handleMoreSidePanel('jobs')}
                          >
                            <CTIcon name="clock" size={13} strokeWidth={1.7} />
                            Jobs
                          </button>
                          <button
                            type="button"
                            className="talk-more-menu-item"
                            onClick={handleMoreDocuments}
                          >
                            <CTIcon name="doc" size={13} strokeWidth={1.7} />
                            Documents
                          </button>
                        </div>
                        <Link
                          to={runHistoryHref}
                          className="talk-more-menu-item"
                          onClick={() => setMoreOpen(false)}
                        >
                          <CTIcon name="clock" size={13} strokeWidth={1.7} />
                          Run History
                        </Link>
                      </div>
                    </Popover>
                  ) : null}
                </div>
              </nav>
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
