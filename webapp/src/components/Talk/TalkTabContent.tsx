import {
  Component,
  lazy,
  Suspense,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';

import { CopyExportMenu } from '../CopyExportMenu';
import { DocPaneEdgeTab } from '../DocPaneEdgeTab';
import { DocPaneHeader, type DocPaneMode } from '../DocPaneHeader';
import { PendingEditDocSurface } from '../PendingEditDocSurface';
import { SafeHtml } from '../SafeHtml';
import type { SourceMentionOption } from '../SourceMentionPicker';
import { TalkComposer } from '../TalkComposer';
import { TalkThreadView } from '../TalkThreadView';
import { ThreadContextMenu } from '../ThreadContextMenu';
import { ThreadRowTitleEditor } from '../ThreadRowTitleEditor';
import { ThreadStartButton } from '../ThreadStartButton';
import { ToolChipsBar } from '../ToolChipsBar';
import type { RichTextEditorSaveStatus } from '../rich-text/RichTextEditor';
import { legacyContentExportProjection } from '../../lib/doc-export';
import type {
  Content,
  ContentEditSummary,
  ContextSource,
  TalkAgent,
  TalkMessage,
  TalkMessageSearchResult,
  TalkThread,
} from '../../lib/api';
import { displayThreadTitle, formatThreadLabel } from '../../lib/threadTitles';
import type { TalkAgentExecutionGuardrail } from '../../lib/talkAgents';
import type {
  OrderedRoundSummary,
  RunView,
  TalkTimelineEntry,
} from '../../lib/talkRunReducer';

type ThreadListState = {
  threads: TalkThread[];
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

type PendingAttachment = {
  localId: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  isImage: boolean;
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  errorMessage?: string;
};

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

const LazyHtmlSourceEditor = lazy(() =>
  import('../HtmlSourceEditor').then((mod) => ({
    default: mod.HtmlSourceEditor,
  })),
);

class HtmlEditorErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="talk-tab-doc-body" role="alert">
          Editor failed to load.{' '}
          <button
            type="button"
            className="talk-tab-doc-conflict-button"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
  fileInputRef: RefObject<HTMLInputElement>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  talkContent: Content | null;
  setTalkContent: Dispatch<SetStateAction<Content | null>>;
  isNarrowViewport: boolean;
  mobilePane: 'chat' | 'doc';
  setMobilePane: Dispatch<SetStateAction<'chat' | 'doc'>>;
  docPaneHidden: boolean;
  setDocPaneHidden: Dispatch<SetStateAction<boolean>>;
  chatRatio: number;
  handleResizeHandleKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  threadState: ThreadListState;
  sortedThreads: TalkThread[];
  editingThreadId: string | null;
  setEditingThreadId: Dispatch<SetStateAction<string | null>>;
  activeThreadId: string | null;
  activeThread: TalkThread | null;
  threadMenu: { threadId: string; x: number; y: number } | null;
  menuThread: TalkThread | null;
  handleCreateThread: () => Promise<void>;
  handleSearch: () => Promise<void>;
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  searchLoading: boolean;
  searchError: string | null;
  searchResults: TalkMessageSearchResult[];
  handleSearchResultSelect: (result: TalkMessageSearchResult) => void;
  handleThreadSecondaryClick: (
    threadId: string,
  ) => (event: ReactMouseEvent<HTMLElement>) => void;
  handleThreadContextMenu: (
    threadId: string,
  ) => (event: ReactMouseEvent<HTMLElement>) => void;
  handleRenameThread: (threadId: string, title: string) => Promise<void>;
  handleSelectThread: (threadId: string) => void;
  closeThreadMenu: () => void;
  onRenameMenuThread: (thread: TalkThread) => void;
  onToggleMenuThreadPin: (thread: TalkThread) => void;
  onDeleteMenuThread: (thread: TalkThread) => void;
  handleRenameActiveThread: (title: string) => Promise<void>;
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
  ALLOWED_ATTACHMENT_EXTENSIONS: string;
  handleFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED: boolean;
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
  pendingAttachments: PendingAttachment[];
  handleRemoveAttachment: (localId: string) => void;
  handleAttachButtonClick: () => void;
  canEditAgents: boolean;
  handleCancelRuns: () => void;
  cancelState: CancelState;
  sendBlockedByGuardrail: boolean;
  historyEditState: HistoryEditState;
  handleShowDocPane: () => void;
  handleHideDocPane: () => void;
  handleDocTitleSave: (nextTitle: string) => Promise<void>;
  talkContentSaveStatus: RichTextEditorSaveStatus;
  talkContentLoading: boolean;
  htmlMode: DocPaneMode;
  setHtmlMode: Dispatch<SetStateAction<DocPaneMode>>;
  talkContentConflict: boolean;
  setTalkContentConflict: Dispatch<SetStateAction<boolean>>;
  setTalkContentSaveStatus: Dispatch<SetStateAction<RichTextEditorSaveStatus>>;
  refetchTalkContent: () => Promise<Content | null>;
  talkContentError: string | null;
  htmlSourceDraft: string;
  handleHtmlSourceChange: (next: string) => void;
  handleHtmlSourceSave: (next: string) => void;
  canEditDoc: boolean;
  talkContentPendingEdits: ContentEditSummary[];
  setTalkContentPendingEdits: Dispatch<SetStateAction<ContentEditSummary[]>>;
  pendingEditStreamingByRunId: Map<string, string | null>;
  pendingEditInFlight: Set<string>;
  setPendingEditInFlight: Dispatch<SetStateAction<Set<string>>>;
  setTalkContentError: Dispatch<SetStateAction<string | null>>;
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
  fileInputRef,
  textareaRef,
  talkContent,
  setTalkContent,
  isNarrowViewport,
  mobilePane,
  setMobilePane,
  docPaneHidden,
  setDocPaneHidden,
  chatRatio,
  handleResizeHandleKeyDown,
  threadState,
  sortedThreads,
  editingThreadId,
  setEditingThreadId,
  activeThreadId,
  activeThread,
  threadMenu,
  menuThread,
  handleCreateThread,
  handleSearch,
  searchQuery,
  setSearchQuery,
  searchLoading,
  searchError,
  searchResults,
  handleSearchResultSelect,
  handleThreadSecondaryClick,
  handleThreadContextMenu,
  handleRenameThread,
  handleSelectThread,
  closeThreadMenu,
  onRenameMenuThread,
  onToggleMenuThreadPin,
  onDeleteMenuThread,
  handleRenameActiveThread,
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
  ALLOWED_ATTACHMENT_EXTENSIONS,
  handleFileInputChange,
  GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED,
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
  pendingAttachments,
  handleRemoveAttachment,
  handleAttachButtonClick,
  canEditAgents,
  handleCancelRuns,
  cancelState,
  sendBlockedByGuardrail,
  historyEditState,
  handleShowDocPane,
  handleHideDocPane,
  handleDocTitleSave,
  talkContentSaveStatus,
  talkContentLoading,
  htmlMode,
  setHtmlMode,
  talkContentConflict,
  setTalkContentConflict,
  setTalkContentSaveStatus,
  refetchTalkContent,
  talkContentError,
  htmlSourceDraft,
  handleHtmlSourceChange,
  handleHtmlSourceSave,
  canEditDoc,
  talkContentPendingEdits,
  setTalkContentPendingEdits,
  pendingEditStreamingByRunId,
  pendingEditInFlight,
  setPendingEditInFlight,
  setTalkContentError,
}: TalkTabContentProps): JSX.Element {
  return (
    <div
      ref={splitContainerRef}
      className={[
        'talk-tab-content',
        talkContent ? 'talk-tab-content-split' : '',
        talkContent && isNarrowViewport ? 'talk-tab-content-split-narrow' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {talkContent && isNarrowViewport ? (
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
          talkContent && isNarrowViewport && mobilePane !== 'chat'
            ? 'talk-tab-pane-hidden'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={
          talkContent && !isNarrowViewport
            ? { flex: `${chatRatio} 1 0` }
            : undefined
        }
      >
        <div className="talk-thread-shell">
          <aside className="talk-thread-rail" aria-label="Talk threads">
            <div className="talk-thread-rail-header">
              <h2>Threads</h2>
              <ThreadStartButton onClick={() => void handleCreateThread()} />
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
                placeholder="Search threads"
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
                      <strong>{displayThreadTitle(result.threadTitle)}</strong>
                      <span>{result.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {threadState.error ? (
              <p className="page-state" role="alert">
                {threadState.error}
              </p>
            ) : null}
            {threadState.loading ? (
              <p className="page-state">Loading threads…</p>
            ) : sortedThreads.length === 0 ? (
              <p className="page-state">No threads yet.</p>
            ) : (
              <ul className="talk-thread-items">
                {sortedThreads.map((thread) => (
                  <li key={thread.id}>
                    {editingThreadId === thread.id ? (
                      <div
                        className={`talk-thread-item${
                          thread.id === activeThreadId
                            ? ' talk-thread-item-active'
                            : ''
                        } talk-thread-item-editing`}
                        onMouseDown={handleThreadSecondaryClick(thread.id)}
                        onContextMenu={handleThreadContextMenu(thread.id)}
                      >
                        <ThreadRowTitleEditor
                          title={formatThreadLabel(thread)}
                          isEditing={true}
                          onSave={(title) =>
                            handleRenameThread(thread.id, title)
                          }
                          onCancel={() => setEditingThreadId(null)}
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
                          thread.id === activeThreadId
                            ? ' talk-thread-item-active'
                            : ''
                        }`}
                        onClick={() => handleSelectThread(thread.id)}
                        onMouseDown={handleThreadSecondaryClick(thread.id)}
                        onContextMenu={handleThreadContextMenu(thread.id)}
                      >
                        <ThreadRowTitleEditor
                          title={formatThreadLabel(thread)}
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
            <TalkThreadView
              timelineRef={timelineRef}
              endRef={endRef}
              setMessageElementRef={setMessageElementRef}
              activeThread={activeThread}
              handleRenameActiveThread={handleRenameActiveThread}
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
              fileInputRef={fileInputRef}
              ALLOWED_ATTACHMENT_EXTENSIONS={ALLOWED_ATTACHMENT_EXTENSIONS}
              handleFileInputChange={handleFileInputChange}
              GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED={
                GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED
              }
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
              talkContent={talkContent}
              contextSources={contextSources}
              activeRound={activeRound}
              hasUnsavedAgentChanges={hasUnsavedAgentChanges}
              activeThreadId={activeThreadId}
              pendingAttachments={pendingAttachments}
              handleRemoveAttachment={handleRemoveAttachment}
              handleAttachButtonClick={handleAttachButtonClick}
              canEditAgents={canEditAgents}
              handleCancelRuns={handleCancelRuns}
              cancelState={cancelState}
              sendBlockedByGuardrail={sendBlockedByGuardrail}
              historyEditState={historyEditState}
            />
          </div>
          {threadMenu && menuThread ? (
            <ThreadContextMenu
              x={threadMenu.x}
              y={threadMenu.y}
              isPinned={menuThread.isPinned}
              canDelete={!menuThread.isDefault}
              onClose={closeThreadMenu}
              onRename={() => onRenameMenuThread(menuThread)}
              onTogglePin={() => onToggleMenuThreadPin(menuThread)}
              onDelete={() => onDeleteMenuThread(menuThread)}
            />
          ) : null}
        </div>
      </div>
      {talkContent && !isNarrowViewport && !docPaneHidden ? (
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
      {talkContent && docPaneHidden && !isNarrowViewport ? (
        <DocPaneEdgeTab
          docTitle={talkContent.title}
          format={talkContent.contentFormat}
          onClick={handleShowDocPane}
        />
      ) : null}
      {talkContent ? (
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
          <DocPaneHeader
            title={talkContent.title}
            onTitleSave={handleDocTitleSave}
            format={talkContent.contentFormat}
            saveStatus={talkContentSaveStatus}
            loading={talkContentLoading}
            mode={talkContent.contentFormat === 'html' ? htmlMode : undefined}
            onModeChange={
              talkContent.contentFormat === 'html' ? setHtmlMode : undefined
            }
            copyExportSlot={
              <CopyExportMenu
                source={legacyContentExportProjection({
                  format: talkContent.contentFormat,
                  markdown: talkContent.bodyMarkdown,
                  html: talkContent.bodyHtml,
                })}
                documentTitle={talkContent.title}
              />
            }
            onHidePane={handleHideDocPane}
            sanitizeWarning={null}
          />
          {talkContentConflict ? (
            <div
              className="talk-tab-doc-conflict"
              role="alert"
              aria-live="assertive"
            >
              <span>
                This document changed elsewhere. Reload to see the latest
                version — your unsaved edits will be lost.
              </span>
              <button
                type="button"
                className="talk-tab-doc-conflict-button"
                onClick={() => {
                  setTalkContentConflict(false);
                  setTalkContentSaveStatus('idle');
                  void refetchTalkContent();
                }}
              >
                Reload
              </button>
            </div>
          ) : null}
          {talkContentError ? (
            <p className="page-state" role="alert">
              {talkContentError}
            </p>
          ) : talkContent.contentFormat === 'html' ? (
            htmlMode === 'source' ? (
              <HtmlEditorErrorBoundary>
                <Suspense
                  fallback={
                    <div className="talk-tab-doc-body" aria-busy="true">
                      Loading editor…
                    </div>
                  }
                >
                  <div
                    className="talk-tab-doc-body"
                    ref={docBodyRef}
                    tabIndex={-1}
                  >
                    <LazyHtmlSourceEditor
                      value={htmlSourceDraft}
                      onChange={handleHtmlSourceChange}
                      onSave={
                        canEditDoc && !talkContentConflict
                          ? handleHtmlSourceSave
                          : undefined
                      }
                      readOnly={!canEditDoc || talkContentConflict}
                      placeholder="Ask an agent to generate, or type HTML"
                    />
                  </div>
                </Suspense>
              </HtmlEditorErrorBoundary>
            ) : (
              <div
                ref={docBodyRef}
                tabIndex={-1}
                className="talk-tab-doc-body-wrap"
              >
                <SafeHtml
                  html={talkContent.bodyHtml ?? ''}
                  className="talk-tab-doc-body"
                />
              </div>
            )
          ) : (
            <div className="talk-tab-doc-body" ref={docBodyRef} tabIndex={-1}>
              <PendingEditDocSurface
                content={talkContent}
                pendingEdits={talkContentPendingEdits}
                streamingByRunId={pendingEditStreamingByRunId}
                inFlightEditIds={pendingEditInFlight}
                canEditDoc={canEditDoc}
                conflict={talkContentConflict}
                onSaved={(content) =>
                  setTalkContent((current) =>
                    current && current.id === content.id ? content : current,
                  )
                }
                onConflict={() => setTalkContentConflict(true)}
                onError={(err) => setTalkContentError(err.message)}
                onStatusChange={setTalkContentSaveStatus}
                setPendingEdits={setTalkContentPendingEdits}
                setInFlightEditIds={setPendingEditInFlight}
                refetchTalkContent={refetchTalkContent}
              />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
