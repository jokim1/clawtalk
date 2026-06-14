import {
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Link } from 'react-router-dom';

import type { Talk, TalkAgent } from '../../lib/api';
import {
  buildAgentLabel,
  type TalkAgentExecutionGuardrail,
} from '../../lib/talkAgents';
import type { TalkDetailTabKey } from '../../hooks/useTalkDetailTabs';
import { CTIcon, Popover } from '../../salon';
import { TalkConnectorsPill } from '../connectors/TalkConnectorsPill';
import { TalkToolsPill } from './TalkToolsPill';

type TalkOrchestrationMode = Talk['orchestrationMode'];

export const TALK_SIDE_PANEL_KEYS = [
  'agents',
  'context',
  'jobs',
] as const;

export type TalkSidePanelKey = (typeof TALK_SIDE_PANEL_KEYS)[number];

function getOrchestrationModeLabel(mode: TalkOrchestrationMode): string {
  return mode === 'ordered' ? 'Ordered' : 'Parallel';
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
  onUnauthorized: () => void;
  documentsOpen: boolean;
  activeRuleCount: number;
  orchestrationMode: TalkOrchestrationMode;
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
  onUnauthorized,
  documentsOpen,
  activeRuleCount,
  orchestrationMode,
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
                <TalkConnectorsPill
                  talkId={talkId}
                  onUnauthorized={onUnauthorized}
                />
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
        </div>
      </header>
    </div>
  );
}
