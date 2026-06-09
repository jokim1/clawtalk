import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import { DocPaneEdgeTab } from '../DocPaneEdgeTab';
import type { SourceMentionOption } from '../SourceMentionPicker';
import { TalkComposer } from '../TalkComposer';
import { TalkDocPane } from './TalkDocPane';
import { TalkTimelineView } from '../TalkTimelineView';
import { ThreadContextMenu } from '../ThreadContextMenu';
import { ThreadRowTitleEditor } from '../ThreadRowTitleEditor';
import { ThreadStartButton } from '../ThreadStartButton';
import { ToolChipsBar } from '../ToolChipsBar';
import type {
  ContextSource,
  NativeDocumentFormat,
  TalkAgent,
  TalkMessage,
  TalkMessageSearchResult,
  TalkConversation,
} from '../../lib/api';
import {
  displayConversationTitle,
  formatConversationLabel,
} from '../../lib/conversationLabels';
import type { TalkAgentExecutionGuardrail } from '../../lib/talkAgents';
import type {
  OrderedRoundSummary,
  RunView,
  TalkTimelineEntry,
} from '../../lib/talkRunReducer';

type ConversationListState = {
  conversations: TalkConversation[];
  loading: boolean;
  error: string | null;
};

type RetryRunState = {
  runId: string;
  status: 'posting' | 'error';
  message: string;
} | null;

type HistoryEditState = {
  status: 'idle' | 'saving' | 'error' | 'success';
  message?: string;
};

type SendState = {
  status: 'idle' | 'posting' | 'error';
  error?: string;
  lastDraft?: string;
};

type CancelState = {
  status: 'idle' | 'posting' | 'success' | 'error';
  message?: string;
};

type MentionState = { atIndex: number; selectedIndex: number } | null;

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function ThreadPinIcon(): JSX.Element {
  return (
    <span className="thread-pin-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M10.9 1.8a.75.75 0 0 1 1.06 0l2.24 2.24a.75.75 0 0 1 0 1.06L12.7 6.6v2.02a.75.75 0 0 1-.22.53L9.9 11.73v2.77a.75.75 0 0 1-1.28.53l-1.8-1.8a.75.75 0 0 1-.22-.53v-.97H5.6a.75.75 0 0 1-.53-.22l-1.8-1.8a.75.75 0 0 1 .53-1.28h2.77l2.58-2.58a.75.75 0 0 1 .53-.22h2.02l1.2-1.2-1.18-1.18-1.2 1.2H8.5a.75.75 0 0 1-.53-.22L6.3 2.56a.75.75 0 0 1 0-1.06l1.8-1.8a.75.75 0 0 1 1.06 0l1.74 1.74h.02Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

type TalkTabContentProps = {
  talkId: string;
  splitContainerRef: RefObject<HTMLDivElement>;
  splitHandleRef: RefObject<HTMLDivElement>;
  docBodyRef: RefObject<HTMLDivElement>;
  docNarrowShowBtnRef: RefObject<HTMLButtonElement>;
  timelineRef: RefObject<HTMLDivElement>;
  endRef: RefObject<HTMLDivElement>;
  setMessageElementRef: (
    messageId: string,
    element: HTMLElement | null,
  ) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  // Native primary-document metadata (no flat content facade). `null` id means
  // the active conversation has no document, so the split layout collapses to chat.
  primaryDocumentId: string | null;
  primaryDocumentTitle: string;
  primaryDocumentFormat: NativeDocumentFormat;
  workspaceId: string | null;
  docReloadSignal: number;
  isNarrowViewport: boolean;
  mobilePane: 'chat' | 'doc';
  setMobilePane: Dispatch<SetStateAction<'chat' | 'doc'>>;
  docPaneHidden: boolean;
  setDocPaneHidden: Dispatch<SetStateAction<boolean>>;
  chatRatio: number;
  handleResizeHandleKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  conversationState: ConversationListState;
  sortedConversations: TalkConversation[];
  editingConversationId: string | null;
  setEditingConversationId: Dispatch<SetStateAction<string | null>>;
  activeConversationId: string | null;
  activeConversation: TalkConversation | null;
  conversationMenu: { conversationId: string; x: number; y: number } | null;
  menuConversation: TalkConversation | null;
  handleCreateConversation: () => Promise<void>;
  handleSearch: () => Promise<void>;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  searchLoading: boolean;
  searchError: string | null;
  searchResults: TalkMessageSearchResult[];
  handleSearchResultSelect: (result: TalkMessageSearchResult) => void;
  handleConversationSecondaryClick: (
    conversationId: string,
  ) => (event: ReactMouseEvent<HTMLElement>) => void;
  handleConversationContextMenu: (
    conversationId: string,
  ) => (event: ReactMouseEvent<HTMLElement>) => void;
  handleRenameConversation: (
    conversationId: string,
    title: string,
  ) => Promise<void>;
  handleSelectConversation: (conversationId: string) => void;
  closeConversationMenu: () => void;
  onRenameMenuConversation: (conversation: TalkConversation) => void;
  onToggleMenuConversationPin: (conversation: TalkConversation) => void;
  onDeleteMenuConversation: (conversation: TalkConversation) => void;
  handleRenameActiveConversation: (title: string) => Promise<void>;
  openHistoryEditor: () => void;
  canEditHistory: boolean;
  activeOrderedProgress: { label: string } | null;
  latestOrderedRound: OrderedRoundSummary | null;
  handleRetryAgentRun: (runId: string) => Promise<void>;
  retryRunState: RetryRunState;
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
  handleUnauthorized: () => void;
  refreshBrowserRuns: () => Promise<void> | void;
  isDenseRound: boolean;
  nowTick: number;
  handleOpenRunHistory: (runId: string) => void;
  hasUnreadBelow: boolean;
  handleClearUnread: () => void;
  toolsRefreshKey: number;
  handleSend: (event: FormEvent) => void;
  effectiveAgents: TalkAgent[];
  targetAgentIds: string[];
  talkAgentExecutionGuardrailsById: Record<string, TalkAgentExecutionGuardrail>;
  selectedGuardrailAgentIds: Set<string>;
  handleToggleTarget: (agentId: string) => void;
  sendState: SendState;
  composerTargetHelp: string;
  draft: string;
  TALK_MESSAGE_MAX_CHARS: number;
  composerGuardrailMessage: string | null;
  mentionState: MentionState;
  mentionOptions: SourceMentionOption[];
  insertMentionOption: (option: SourceMentionOption) => void;
  setMentionState: Dispatch<SetStateAction<MentionState>>;
  handleDraftChange: (value: string) => void;
  handleComposerKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  contextSources: ContextSource[];
  activeRound: boolean;
  hasUnsavedAgentChanges: boolean;
  canEditAgents: boolean;
  handleCancelRuns: () => void;
  cancelState: CancelState;
  sendBlockedByGuardrail: boolean;
  historyEditState: HistoryEditState;
  handleShowDocPane: () => void;
  handleHideDocPane: () => void;
  canEditDoc: boolean;
};

export function TalkTabContent({
  talkId,
  splitContainerRef,
  splitHandleRef,
  docBodyRef,
  docNarrowShowBtnRef,
  timelineRef,
  endRef,
  setMessageElementRef,
  textareaRef,
  primaryDocumentId,
  primaryDocumentTitle,
  primaryDocumentFormat,
  workspaceId,
  docReloadSignal,
  isNarrowViewport,
  mobilePane,
  setMobilePane,
  docPaneHidden,
  setDocPaneHidden,
  chatRatio,
  handleResizeHandleKeyDown,
  conversationState,
  sortedConversations,
  editingConversationId,
  setEditingConversationId,
  activeConversationId,
  activeConversation,
  conversationMenu,
  menuConversation,
  handleCreateConversation,
  handleSearch,
  searchQuery,
  setSearchQuery,
  searchLoading,
  searchError,
  searchResults,
  handleSearchResultSelect,
  handleConversationSecondaryClick,
  handleConversationContextMenu,
  handleRenameConversation,
  handleSelectConversation,
  closeConversationMenu,
  onRenameMenuConversation,
  onToggleMenuConversationPin,
  onDeleteMenuConversation,
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
  handleUnauthorized,
  refreshBrowserRuns,
  isDenseRound,
  nowTick,
  handleOpenRunHistory,
  hasUnreadBelow,
  handleClearUnread,
  toolsRefreshKey,
  handleSend,
  effectiveAgents,
  targetAgentIds,
  talkAgentExecutionGuardrailsById,
  selectedGuardrailAgentIds,
  handleToggleTarget,
  sendState,
  composerTargetHelp,
  draft,
  TALK_MESSAGE_MAX_CHARS,
  composerGuardrailMessage,
  mentionState,
  mentionOptions,
  insertMentionOption,
  setMentionState,
  handleDraftChange,
  handleComposerKeyDown,
  contextSources,
  activeRound,
  hasUnsavedAgentChanges,
  canEditAgents,
  handleCancelRuns,
  cancelState,
  sendBlockedByGuardrail,
  historyEditState,
  handleShowDocPane,
  handleHideDocPane,
  canEditDoc,
}: TalkTabContentProps): JSX.Element {
  const hasDocument = primaryDocumentId !== null;
  return (
    <div
      ref={splitContainerRef}
      className={[
        'talk-tab-content',
        hasDocument ? 'talk-tab-content-split' : '',
        hasDocument && isNarrowViewport ? 'talk-tab-content-split-narrow' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasDocument && isNarrowViewport ? (
        <div
          className="talk-tab-mobile-toggle"
          role="tablist"
          aria-label="Talk or document"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'chat'}
            className={`talk-tab-mobile-toggle-btn${
              mobilePane === 'chat' ? ' talk-tab-mobile-toggle-btn-active' : ''
            }`}
            onClick={() => setMobilePane('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'doc'}
            className={`talk-tab-mobile-toggle-btn${
              mobilePane === 'doc' ? ' talk-tab-mobile-toggle-btn-active' : ''
            }`}
            onClick={() => {
              if (docPaneHidden) setDocPaneHidden(false);
              setMobilePane('doc');
            }}
          >
            Doc
          </button>
          {docPaneHidden && mobilePane === 'chat' ? (
            <button
              ref={docNarrowShowBtnRef}
              type="button"
              className="talk-tab-mobile-show-doc"
              onClick={() => {
                setDocPaneHidden(false);
                setMobilePane('doc');
              }}
            >
              Show doc
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className={[
          'talk-tab-chat-pane',
          hasDocument && isNarrowViewport && mobilePane !== 'chat'
            ? 'talk-tab-pane-hidden'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={
          hasDocument && !isNarrowViewport
            ? { flex: `${chatRatio} 1 0` }
            : undefined
        }
      >
        <div className="talk-thread-shell">
          <aside className="talk-thread-rail" aria-label="Talk conversations">
            <div className="talk-thread-rail-header">
              <h2>Conversations</h2>
              <ThreadStartButton
                onClick={() => void handleCreateConversation()}
              />
            </div>
            <form
              className="talk-thread-search"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSearch();
              }}
            >
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search conversations"
                aria-label="Search Talk messages"
              />
              <button
                type="submit"
                className="secondary-btn"
                disabled={searchLoading}
              >
                {searchLoading ? 'Searching…' : 'Search'}
              </button>
            </form>
            {searchError ? (
              <p className="talk-thread-search-error" role="alert">
                {searchError}
              </p>
            ) : null}
            {searchResults.length > 0 ? (
              <ul className="talk-thread-search-results">
                {searchResults.map((result) => (
                  <li key={result.messageId}>
                    <button
                      type="button"
                      className="talk-thread-search-result"
                      onClick={() => handleSearchResultSelect(result)}
                    >
                      <strong>
                        {displayConversationTitle(result.threadTitle)}
                      </strong>
                      <span>{result.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {conversationState.error ? (
              <p className="page-state" role="alert">
                {conversationState.error}
              </p>
            ) : null}
            {conversationState.loading ? (
              <p className="page-state">Loading conversations…</p>
            ) : sortedConversations.length === 0 ? (
              <p className="page-state">No conversations yet.</p>
            ) : (
              <ul className="talk-thread-items">
                {sortedConversations.map((thread) => (
                  <li key={thread.id}>
                    {editingConversationId === thread.id ? (
                      <div
                        className={`talk-thread-item${
                          thread.id === activeConversationId
                            ? ' talk-thread-item-active'
                            : ''
                        } talk-thread-item-editing`}
                        onMouseDown={handleConversationSecondaryClick(
                          thread.id,
                        )}
                        onContextMenu={handleConversationContextMenu(thread.id)}
                      >
                        <ThreadRowTitleEditor
                          title={formatConversationLabel(thread)}
                          isEditing={true}
                          onSave={(title) =>
                            handleRenameConversation(thread.id, title)
                          }
                          onCancel={() => setEditingConversationId(null)}
                          staticClassName="talk-thread-item-title"
                          inputClassName="thread-row-title-input"
                          errorClassName="thread-row-title-error"
                          leadingVisual={
                            thread.isPinned ? <ThreadPinIcon /> : undefined
                          }
                        />
                        <span className="talk-thread-item-meta">
                          {thread.messageCount} message
                          {thread.messageCount === 1 ? '' : 's'} ·{' '}
                          {formatDateTime(
                            thread.lastMessageAt || thread.createdAt,
                          )}
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={`talk-thread-item${
                          thread.id === activeConversationId
                            ? ' talk-thread-item-active'
                            : ''
                        }`}
                        onClick={() => handleSelectConversation(thread.id)}
                        onMouseDown={handleConversationSecondaryClick(
                          thread.id,
                        )}
                        onContextMenu={handleConversationContextMenu(thread.id)}
                      >
                        <ThreadRowTitleEditor
                          title={formatConversationLabel(thread)}
                          isEditing={false}
                          onSave={() => undefined}
                          onCancel={() => undefined}
                          staticClassName="talk-thread-item-title"
                          inputClassName="thread-row-title-input"
                          errorClassName="thread-row-title-error"
                          leadingVisual={
                            thread.isPinned ? <ThreadPinIcon /> : undefined
                          }
                        />
                        <span className="talk-thread-item-meta">
                          {thread.messageCount} message
                          {thread.messageCount === 1 ? '' : 's'} ·{' '}
                          {formatDateTime(
                            thread.lastMessageAt || thread.createdAt,
                          )}
                        </span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <div className="talk-thread-detail">
            <TalkTimelineView
              timelineRef={timelineRef}
              endRef={endRef}
              setMessageElementRef={setMessageElementRef}
              activeConversation={activeConversation}
              handleRenameActiveConversation={handleRenameActiveConversation}
              openHistoryEditor={openHistoryEditor}
              canEditHistory={canEditHistory}
              activeOrderedProgress={activeOrderedProgress}
              latestOrderedRound={latestOrderedRound}
              handleRetryAgentRun={handleRetryAgentRun}
              retryRunState={retryRunState}
              isSnapshotPending={isSnapshotPending}
              olderMessagesAvailable={olderMessagesAvailable}
              loadingOlderMessages={loadingOlderMessages}
              pageMessages={pageMessages}
              handleLoadOlderMessages={handleLoadOlderMessages}
              talkTimeline={talkTimeline}
              agentsTabHref={agentsTabHref}
              runsById={runsById}
              orderedGroupSizesById={orderedGroupSizesById}
              agentLabelById={agentLabelById}
              talkId={talkId}
              handleUnauthorized={handleUnauthorized}
              refreshBrowserRuns={refreshBrowserRuns}
              isDenseRound={isDenseRound}
              nowTick={nowTick}
              handleOpenRunHistory={handleOpenRunHistory}
              hasUnreadBelow={hasUnreadBelow}
              handleClearUnread={handleClearUnread}
            />

            <ToolChipsBar talkId={talkId} refreshKey={toolsRefreshKey} />

            <TalkComposer
              handleSend={handleSend}
              effectiveAgents={effectiveAgents}
              targetAgentIds={targetAgentIds}
              talkAgentExecutionGuardrailsById={
                talkAgentExecutionGuardrailsById
              }
              selectedGuardrailAgentIds={selectedGuardrailAgentIds}
              handleToggleTarget={handleToggleTarget}
              sendState={sendState}
              composerTargetHelp={composerTargetHelp}
              draft={draft}
              TALK_MESSAGE_MAX_CHARS={TALK_MESSAGE_MAX_CHARS}
              composerGuardrailMessage={composerGuardrailMessage}
              mentionState={mentionState}
              mentionOptions={mentionOptions}
              insertMentionOption={insertMentionOption}
              setMentionState={setMentionState}
              textareaRef={textareaRef}
              handleDraftChange={handleDraftChange}
              handleComposerKeyDown={handleComposerKeyDown}
              hasDocument={hasDocument}
              contextSources={contextSources}
              activeRound={activeRound}
              hasUnsavedAgentChanges={hasUnsavedAgentChanges}
              activeConversationId={activeConversationId}
              canEditAgents={canEditAgents}
              handleCancelRuns={handleCancelRuns}
              cancelState={cancelState}
              sendBlockedByGuardrail={sendBlockedByGuardrail}
              historyEditState={historyEditState}
            />
          </div>
          {conversationMenu && menuConversation ? (
            <ThreadContextMenu
              x={conversationMenu.x}
              y={conversationMenu.y}
              isPinned={menuConversation.isPinned}
              canDelete={!menuConversation.isDefault}
              onClose={closeConversationMenu}
              onRename={() => onRenameMenuConversation(menuConversation)}
              onTogglePin={() => onToggleMenuConversationPin(menuConversation)}
              onDelete={() => onDeleteMenuConversation(menuConversation)}
            />
          ) : null}
        </div>
      </div>
      {hasDocument && !isNarrowViewport && !docPaneHidden ? (
        <div
          ref={splitHandleRef}
          className="talk-tab-split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(chatRatio * 100)}
          aria-label="Resize chat and document panes"
          tabIndex={0}
          onKeyDown={handleResizeHandleKeyDown}
        />
      ) : null}
      {hasDocument && docPaneHidden && !isNarrowViewport ? (
        <DocPaneEdgeTab
          docTitle={primaryDocumentTitle}
          format={primaryDocumentFormat}
          onClick={handleShowDocPane}
        />
      ) : null}
      {primaryDocumentId !== null ? (
        <section
          className={[
            'talk-tab-doc-pane',
            (isNarrowViewport && mobilePane !== 'doc') ||
            (!isNarrowViewport && docPaneHidden)
              ? 'talk-tab-pane-hidden'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={
            !isNarrowViewport && !docPaneHidden
              ? { flex: `${1 - chatRatio} 1 0` }
              : undefined
          }
          aria-label="Talk document"
        >
          <TalkDocPane
            documentId={primaryDocumentId}
            workspaceId={workspaceId}
            canEditDoc={canEditDoc}
            onUnauthorized={handleUnauthorized}
            reloadSignal={docReloadSignal}
            onHidePane={handleHideDocPane}
            docBodyRef={docBodyRef}
          />
        </section>
      ) : null}
    </div>
  );
}
