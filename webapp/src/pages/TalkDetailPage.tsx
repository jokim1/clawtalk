import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  DocumentSidebarItem,
  getTalk,
  getTalkAgents,
  getTalkRuns,
  listTalkMessages,
  TalkMessage,
  TalkRun,
  TalkSnapshot,
  UnauthorizedError,
  type SessionUser,
} from '../lib/api';
import { TalkToolsPanel } from '../components/TalkToolsPanel';
import { SavedSourcesPanel } from '../components/SavedSourcesPanel';
import { TalkContextPanel } from '../components/TalkContextPanel';
import { TalkJobsPanel } from '../components/TalkJobsPanel';
import { TalkConnectorsPanel } from '../components/connectors/TalkConnectorsPanel';
import { TalkAgentsPanel } from '../components/TalkAgentsPanel';
import { TalkRunsPanel } from '../components/TalkRunsPanel';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import {
  TALK_SIDE_PANEL_KEYS,
  TalkDetailShell,
  type TalkSidePanelKey,
} from '../components/Talk/TalkDetailShell';
import { TalkDocumentCreateModal } from '../components/Talk/TalkDocumentCreateModal';
import { TalkDocumentsPanel } from '../components/Talk/TalkDocumentsPanel';
import { TalkSidePanelShell } from '../components/Talk/TalkSidePanelShell';
import { TalkTabContent } from '../components/Talk/TalkTabContent';
import { loadTalkScroll, saveTalkScroll } from '../lib/talkScroll';
import { useTalkRunStream } from '../hooks/useTalkRunStream';
import {
  buildTalkDetailHref,
  useTalkDetailRouteState,
  useTalkDetailTabLinks,
} from '../hooks/useTalkDetailTabs';
import { useTalkDocPaneController } from '../hooks/useTalkDocPaneController';
import { useTalkRunViewModel } from '../hooks/useTalkRunViewModel';
import { useTalkContextController } from '../hooks/useTalkContextController';
import { useTalkJobsController } from '../hooks/useTalkJobsController';
import { useTalkOrchestrationController } from '../hooks/useTalkOrchestrationController';
import { useTalkHistoryController } from '../hooks/useTalkHistoryController';
import { useTalkAgentsController } from '../hooks/useTalkAgentsController';
import { useTalkConversationController } from '../hooks/useTalkConversationController';
import {
  useTalkComposerInputController,
  useTalkSendController,
} from '../hooks/useTalkComposerController';
import { useTalkRunContextController } from '../hooks/useTalkRunContextController';
import { useTalkSnapshotPageState } from '../hooks/useTalkSnapshotPageState';
import { createInitialDetailState, detailReducer } from '../lib/talkRunReducer';
import { useQueryClient } from '@tanstack/react-query';
import { snapshotQueryKey } from '../lib/useTalkSnapshot';
import {
  createWsCacheRouter,
  prependOlderTalkMessagesToSnapshot,
} from '../lib/wsCacheRouter';

const SCROLL_STICK_THRESHOLD_PX = 120;

const EMPTY_MESSAGES: TalkMessage[] = [];

const TALK_SIDE_PANEL_KEY_SET = new Set<string>(TALK_SIDE_PANEL_KEYS);

function parseTalkSidePanel(value: string | null): TalkSidePanelKey | null {
  if (value && TALK_SIDE_PANEL_KEY_SET.has(value)) {
    return value as TalkSidePanelKey;
  }
  return null;
}

function snapshotRunsToTalkRuns(snapshotRuns: TalkSnapshot['runs']): TalkRun[] {
  return snapshotRuns.map((row) => ({
    id: row.id,
    responseGroupId: row.responseGroupId,
    sequenceIndex: row.sequenceIndex,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.endedAt,
    triggerMessageId: row.triggerMessageId,
    targetAgentId: row.targetAgentId,
    targetAgentNickname: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    executorAlias: row.executorAlias,
    executorModel: row.executorModel,
    providerId: row.providerId ?? null,
    tokensIn: row.tokensIn ?? null,
    tokensOut: row.tokensOut ?? null,
  }));
}

export function TalkDetailPage({
  userId,
  currentUser,
  onUnauthorized,
  titleOverride,
  folderTitle,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  onSidebarChanged,
  sidebarContents,
}: {
  userId: string;
  currentUser: Pick<SessionUser, 'id' | 'displayName'> | null;
  onUnauthorized: () => void;
  titleOverride?: string | null;
  folderTitle?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  onSidebarChanged: () => Promise<void> | void;
  sidebarContents: DocumentSidebarItem[];
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const navigate = useNavigate();
  const { currentTab, locationParams } = useTalkDetailRouteState(talkId);
  const sidePanel =
    currentTab === 'talk'
      ? parseTalkSidePanel(locationParams.get('panel'))
      : null;
  const queryClient = useQueryClient();
  const {
    snapshotQuery,
    talkSnapshot,
    pageKind,
    pageErrorMessage,
    pageTalk,
    activeTalkWorkspaceId,
    canEditAgents,
    canEditJobs,
    canEditDoc,
    canManageTalkConnectors,
    resetSnapshotFallback,
  } = useTalkSnapshotPageState({
    userId,
    talkId,
    onUnauthorized,
  });
  const wsCacheRouterRef = useRef(createWsCacheRouter(queryClient));
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
  );

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const pendingComposerFocusRef = useRef(false);
  const pendingRunHistoryScrollRef = useRef<string | null>(null);
  const deletedMessageIdsRef = useRef<Set<string>>(new Set());
  // Bumped whenever deleted ids are recorded so memoized message lists
  // re-run the deleted-id filter even if the messages array itself is
  // unchanged (a stale resync can return the pre-delete list verbatim).
  const [deletedIdsVersion, setDeletedIdsVersion] = useState(0);
  // Tracks every runId we've ever seen on MESSAGE_APPENDED. Used by the
  // "missing persisted message" timer below to decide whether to refetch.
  const persistedRunMessageIdsRef = useRef<Set<string>>(new Set());
  // Timer per runId that fires if RUN_COMPLETED arrives but the matching
  // MESSAGE_APPENDED never lands. Without this, a dropped persistence event
  // leaves the timeline empty until the user reloads or switches threads.
  const pendingMessageRefetchTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Tracks whether the server has more history past the current view.
  // Initial value follows snapshot.hasOlderMessages; flips to false the
  // moment a `?before=<oldest>` page comes back short, so the
  // Load-earlier button hides once history is exhausted.
  const [olderMessagesAvailable, setOlderMessagesAvailable] = useState(false);
  // Bumped each time a `talk_tools_changed` event arrives. Triggers
  // ToolChipsBar to refetch its active set so chip state syncs across
  // tabs without us threading the payload through.
  const [toolsRefreshKey, setToolsRefreshKey] = useState(0);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const messageElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const autoStickToBottomRef = useRef<ScrollBehavior | null>(null);
  // Whether the user is currently following the bottom of the timeline.
  // Driven by the scroll-restore decision + every user scroll; consulted by
  // the bottom-stick ResizeObserver so growth only re-pins when at the bottom.
  const followBottomRef = useRef(true);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const handleUnauthorized = useCallback(() => {
    onUnauthorizedRef.current();
  }, []);

  const {
    conversationState,
    editingConversationId,
    setEditingConversationId,
    conversationMenu,
    activeConversationId,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    searchError,
    sortedConversations,
    activeConversation,
    menuConversation,
    resetTalkConversations,
    hydrateTalkConversations,
    handleRenameConversation,
    handleRenameActiveConversation,
    handleSelectConversation,
    handleConversationSecondaryClick,
    handleConversationContextMenu,
    handleCreateConversation,
    handleSearch,
    handleSearchResultSelect,
    closeConversationMenu,
    handleRenameMenuConversation,
    handleToggleMenuConversationPin,
    handleDeleteMenuConversation,
  } = useTalkConversationController({
    talkId,
    currentTab,
    canEditConversations: canEditAgents,
    navigate,
    pendingComposerFocusRef,
    onUnauthorized: handleUnauthorized,
  });

  const { runContextPanels, resetRunContextPanels, handleToggleRunContext } =
    useTalkRunContextController({
      talkId,
      onUnauthorized: handleUnauthorized,
    });

  const currentConversationHasContent = useMemo(
    () => Boolean(talkSnapshot?.primaryDocument),
    [talkSnapshot?.primaryDocument],
  );

  const {
    docModalOpen,
    docModalTitle,
    setDocModalTitle,
    docModalFormat,
    setDocModalFormat,
    docModalSubmitting,
    docModalError,
    docModalInputRef,
    openDocModal,
    closeDocModal,
    handleCreateDoc,
    docPaneHidden,
    setDocPaneHidden,
    docBodyRef,
    docNarrowShowBtnRef,
    chatRatio,
    isNarrowViewport,
    mobilePane,
    setMobilePane,
    splitContainerRef,
    splitHandleRef,
    handleResizeHandleKeyDown,
    handleHideDocPane,
    handleShowDocPane,
  } = useTalkDocPaneController({
    talkId,
    userId,
    currentTab,
    locationParams,
    currentConversationHasContent,
    queryClient,
    navigate,
    onUnauthorized,
    onSidebarChanged,
  });

  // Native primary-document metadata derived from the snapshot — id/title/
  // format only, never a flat content body read.
  const primaryDocumentId = talkSnapshot?.primaryDocument?.id ?? null;
  const primaryDocumentTitle = talkSnapshot?.primaryDocument?.title ?? '';
  const primaryDocumentFormat =
    talkSnapshot?.primaryDocument?.format ?? 'markdown';

  // Bumped on each content-edit stream event so the native doc pane reloads
  // its blocks/pending edits in place (replaces the legacy content refetch).
  const [docReloadSignal, setDocReloadSignal] = useState(0);
  const bumpDocReload = useCallback(() => setDocReloadSignal((n) => n + 1), []);

  const isNearBottom = useCallback((): boolean => {
    const container = timelineRef.current;
    if (!container) return true;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distanceToBottom <= SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', shouldStillScroll?: () => boolean) => {
      // Drive timelineRef.scrollTop directly instead of
      // endRef.scrollIntoView. The latter walks every overflow-scrollable
      // ancestor and the talk shell has two of them (.talk-workspace-scroll
      // wraps .talk-thread-scroll). In nested scroll containers,
      // scrollIntoView can end up scrolling the outer wrapper to put endRef
      // at the bottom of the viewport — which visually leaves the inner
      // scroll at the top showing the oldest messages. Targeting the inner
      // container alone is unambiguous. requestAnimationFrame defers the
      // write to the next frame so scrollHeight reflects the newly
      // committed message.
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as unknown as {
          __clawtalkScrollToBottomCount?: number;
        };
        w.__clawtalkScrollToBottomCount =
          (w.__clawtalkScrollToBottomCount ?? 0) + 1;
      }
      const apply = () => {
        // Deferred to the next frame, so re-check at write time: a caller (the
        // streaming auto-stick) may pass a guard that turns false if the user
        // scrolled away before this ran, and we must not yank them back.
        if (shouldStillScroll && !shouldStillScroll()) return;
        const container = timelineRef.current;
        if (!container) return;
        const target = container.scrollHeight - container.clientHeight;
        if (target <= 0) return;
        if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
          container.scrollTo({ top: target, behavior: 'smooth' });
        } else {
          container.scrollTop = target;
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(apply);
      } else {
        apply();
      }
    },
    [],
  );

  const setMessageElementRef = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) {
        messageElementRefs.current.set(messageId, element);
        return;
      }
      messageElementRefs.current.delete(messageId);
    },
    [],
  );

  const {
    activeRuleCount,
    contextGoal,
    setContextGoal,
    contextRules,
    setContextRules,
    contextSources,
    setContextSources,
    contextStatus,
    setContextStatus,
    goalDraft,
    setGoalDraft,
    newRuleText,
    setNewRuleText,
    ruleDrafts,
    setRuleDrafts,
  } = useTalkContextController({
    talkId,
    contextSurfaceActive: currentTab === 'context' || sidePanel === 'context',
    pageKind,
    onUnauthorized: handleUnauthorized,
  });

  const composerInput = useTalkComposerInputController({
    pageKind,
    activeConversationId,
    currentTab,
    contextSources,
    sendState: state.sendState,
    dispatch,
    documentTitle: primaryDocumentId !== null ? primaryDocumentTitle : null,
  });

  const {
    agents,
    agentDrafts,
    agentState,
    agentsCatalogError,
    registeredAgentsCatalog,
    targetAgentIds,
    effectiveAgents,
    jobAgentOptions,
    hasUnsavedAgentChanges,
    talkAgentExecutionGuardrailsById,
    agentLabelById,
    selectedTargetAgentCount,
    selectedGuardrailAgentIds,
    composerGuardrailMessage,
    sendBlockedByGuardrail,
    hasVisionNonDocAgent,
    resetTalkAgents,
    hydrateTalkAgents,
    toggleTargetAgent,
    handleSetPrimaryAgent,
    handleRemoveAgent,
    handleAddAgent,
    handleSaveAgents,
  } = useTalkAgentsController({
    pageKind,
    pageTalkId: pageTalk?.id ?? null,
    activeTalkWorkspaceId,
    canEditAgents,
    onUnauthorized: handleUnauthorized,
  });

  const rememberDeletedMessageIds = useCallback((messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const next = new Set(deletedMessageIdsRef.current);
    for (const messageId of messageIds) {
      const normalized = messageId.trim();
      if (normalized) {
        next.add(normalized);
      }
    }
    deletedMessageIdsRef.current = next;
    // Re-run memoized message filters even if the messages array doesn't
    // change — otherwise a racing execution resync that returns the
    // pre-delete rows verbatim would flash the just-deleted messages back.
    setDeletedIdsVersion((v) => v + 1);
  }, []);

  const filterDeletedMessages = useCallback((messages: TalkMessage[]) => {
    if (deletedMessageIdsRef.current.size === 0) return messages;
    return messages.filter(
      (message) => !deletedMessageIdsRef.current.has(message.id),
    );
  }, []);

  // PR C: cached message timeline derived from the snapshot. The wsCacheRouter
  // appends new messages via setQueryData; this memo re-derives whenever the
  // identity of `talkSnapshot.messages` changes (mutation, refetch, delete).
  const pageMessages: TalkMessage[] = useMemo(
    () => filterDeletedMessages(talkSnapshot?.messages ?? EMPTY_MESSAGES),
    [deletedIdsVersion, filterDeletedMessages, talkSnapshot?.messages],
  );
  const pageMessageIds = useMemo(
    () => new Set(pageMessages.map((m) => m.id)),
    [pageMessages],
  );

  const handleLoadOlderMessages = useCallback(async (): Promise<void> => {
    if (loadingOlderMessages) return;
    const oldest = pageKind === 'ready' ? pageMessages[0] : null;
    if (!oldest) return;
    setLoadingOlderMessages(true);
    const pageSize = 200;
    try {
      const older = await listTalkMessages(talkId, {
        before: oldest.createdAt,
        limit: pageSize,
      });
      const filtered = filterDeletedMessages(older);
      // Server returned fewer than we asked for → no more history. Patch
      // the snapshot's `hasOlderMessages` in the same setQueryData so a
      // background refetch can't mirror the stale `true` back into the
      // page state (Codex #466 P2 + Codex #462 P3).
      const isFinalPage = older.length < pageSize;
      prependOlderTalkMessagesToSnapshot({
        queryClient,
        userId,
        talkId,
        messages: filtered,
        hasOlderMessages: isFinalPage ? false : undefined,
      });
      if (isFinalPage) {
        setOlderMessagesAvailable(false);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
      }
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [
    filterDeletedMessages,
    handleUnauthorized,
    loadingOlderMessages,
    pageKind,
    pageMessages,
    queryClient,
    talkId,
    userId,
  ]);

  const resyncTalkState = useCallback(async () => {
    // PR C: messages + active runs come from the snapshot query —
    // invalidate it and let RQ refetch. Historical runs are still
    // separate; re-fetch them in parallel so the Runs tab updates.
    // The conversation list stays on its component-local state.
    void queryClient.invalidateQueries({
      queryKey: snapshotQueryKey(userId, talkId),
    });
    // A resync runs when we may have missed live frames (replay gap,
    // reconnect, content-less message). The snapshot refetch only updates
    // the native document's metadata (id/title); its blocks + pending edits
    // come from getDocument, so bump the reload signal to refetch them too —
    // otherwise the in-Talk doc pane can show stale blocks after a
    // disconnect (parity with the old hydrateDocumentFromSnapshot path).
    bumpDocReload();
    try {
      const runs = await getTalkRuns(talkId);
      dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
      autoStickToBottomRef.current = 'smooth';
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
      }
    }
  }, [bumpDocReload, handleUnauthorized, queryClient, talkId, userId]);

  const refreshBrowserRuns = useCallback(
    async () => resyncTalkState(),
    [resyncTalkState],
  );

  const {
    talkJobs,
    setTalkJobs,
    talkJobsLoaded,
    setTalkJobsLoaded,
    talkJobsStatus,
    setTalkJobsStatus,
    selectedJobId,
    setSelectedJobId,
    creatingJob,
    setCreatingJob,
    jobDraft,
    setJobDraft,
    selectedJobRuns,
    setSelectedJobRuns,
    selectedJobRunsStatus,
    setSelectedJobRunsStatus,
    handleJobRunSettled,
  } = useTalkJobsController({
    talkId,
    resyncTalkState,
  });

  // Tracks the last (talkId, activeConversationId) we fully hydrated from the
  // snapshot. PR C: same-talk refetches no longer dispatch into the
  // reducer at all — the snapshot owns messages/talk/content — but we
  // still gate the run-side SNAPSHOT_HYDRATED so we don't re-seed active
  // runs on every background refetch.
  const hydratedKeyRef = useRef<string | null>(null);

  // Reset every per-talk slice when talkId changes. The snapshot query
  // and the runs/agents fetch below re-hydrate them; the rest stay at
  // their defaults until the user opens the corresponding tab.
  useEffect(() => {
    dispatch({ type: 'TALK_RESET' });
    hydratedKeyRef.current = null;
    resetSnapshotFallback();
    messageElementRefs.current.clear();
    deletedMessageIdsRef.current = new Set();
    resetTalkConversations();
    resetTalkAgents();
    resetRunContextPanels();
  }, [
    resetRunContextPanels,
    resetSnapshotFallback,
    resetTalkAgents,
    resetTalkConversations,
    talkId,
  ]);

  // Hydrate non-RQ side-effects the moment the snapshot resolves: the
  // conversation list (kept in component state because the rail edits
  // it independently), the doc panel useState bridges (kept until a
  // future PR migrates them to RQ), and the reducer's runs slice via
  // SNAPSHOT_HYDRATED. Same-thread refetches re-run only the bridges,
  // never the reducer dispatch, so an inbound `setQueryData` patch
  // doesn't clobber live-streaming state.
  useEffect(() => {
    if (snapshotQuery.error) return;
    const snapshot = snapshotQuery.data;
    if (!snapshot) return;
    if (snapshot.talk.id !== talkId) return;
    const hydrationKey = talkId;
    const isFirstHydration = hydratedKeyRef.current !== hydrationKey;
    hydrateTalkConversations(snapshot.conversations);
    // Doc state is derived reactively from `talkSnapshot.content` (native
    // metadata) and the in-pane native fetch — no imperative content
    // hydration here anymore.
    setOlderMessagesAvailable(snapshot.hasOlderMessages);
    if (!isFirstHydration) return;
    hydratedKeyRef.current = hydrationKey;
    dispatch({
      type: 'SNAPSHOT_HYDRATED',
      runs: snapshotRunsToTalkRuns(snapshot.runs),
    });
  }, [
    hydrateTalkConversations,
    snapshotQuery.data,
    snapshotQuery.error,
    talkId,
  ]);

  // Rich runs (historical) + rich agents (provider/model/health) come
  // from these two existing endpoints — kept out of the snapshot wire
  // shape to keep that payload tight. Fire in parallel with the
  // snapshot so they don't gate the first paint. PR C: both ordering
  // cases (parallel-first or snapshot-first) merge cleanly because
  // SNAPSHOT_HYDRATED and MERGE_HISTORICAL_RUNS are both pure overlays
  // on `runsById` that preserve any live-state already accumulated.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [runs, talkAgents] = await Promise.all([
          getTalkRuns(talkId),
          getTalkAgents(talkId),
        ]);
        if (cancelled) return;
        hydrateTalkAgents(talkAgents);
        // MERGE_HISTORICAL_RUNS is a pure overlay — order-independent
        // vs the snapshot effect's SNAPSHOT_HYDRATED, since neither
        // clobbers in-flight live state on existing run ids.
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized, hydrateTalkAgents, talkId]);

  // Talk timeline scroll: restore the saved offset if the user had scrolled
  // up to read history; otherwise park at the bottom.
  useEffect(() => {
    if (pageKind !== 'ready') return;
    const saved = loadTalkScroll(talkId);
    const rafId = requestAnimationFrame(() => {
      if (pendingComposerFocusRef.current) {
        pendingComposerFocusRef.current = false;
        composerInput.textareaRef.current?.focus();
      }
      if (saved && !saved.atBottom) {
        const container = timelineRef.current;
        if (container) {
          const maxOffset = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          container.scrollTop = Math.min(saved.offset, maxOffset);
        }
        followBottomRef.current = false;
      } else {
        scrollToBottom('auto');
        followBottomRef.current = true;
      }
      dispatch({ type: 'CLEAR_UNREAD' });
    });
    // StrictMode in dev runs the mount effect twice; cancelling the
    // first rAF on cleanup ensures the second setup wins and we don't
    // scroll twice on warm-cache mounts where the gate passes on the
    // very first render.
    return () => cancelAnimationFrame(rafId);
  }, [scrollToBottom, pageKind, talkId]);

  // Persist scroll position + at-bottom flag on user scroll, debounced
  // ~200ms. Owns the localStorage write end of the Talk timeline scroll
  // memory so the next mount can restore.
  useEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    if (pageKind !== 'ready') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const capturedTalkId = talkId;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const el = timelineRef.current;
        if (!el) return;
        saveTalkScroll(capturedTalkId, {
          offset: el.scrollTop,
          atBottom: isNearBottom(),
        });
      }, 200);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [isNearBottom, pageKind, talkId]);

  // Reset the follow flag whenever the Talk changes: default to "not
  // following" until the scroll-restore effect above decides. This keeps the
  // reflow stick inert during a cold Talk switch, so it can never pin to the
  // bottom over a restored mid-scroll position.
  useEffect(() => {
    followBottomRef.current = false;
  }, [talkId]);

  // Robust bottom-stick through reflow. The per-event stick + scrollToBottom
  // compute their scroll target in a single rAF, so when the timeline grows a
  // frame later — a streamed token, the live→settled markdown swap, a just-
  // sent message — the view lands short of the true bottom. Track whether the
  // user is following the bottom (followBottomRef: set by the restore decision,
  // updated on every user scroll) and, on each content resize, re-pin to the
  // true bottom. The ResizeObserver fires after layout, so scrollHeight is
  // already current and we write scrollTop directly — no deferred rAF that
  // could yank a user who scrolled away in the meantime. We pin only while
  // following (never yanks a reader), skip the first/initial-size callback (so
  // a remount or tab switch can't auto-scroll), and bind to the Talk tab
  // only — the timeline unmounts on other tabs, so the effect must re-bind on
  // tab re-entry.
  useEffect(() => {
    if (
      pageKind !== 'ready' ||
      !activeConversationId ||
      currentTab !== 'talk'
    ) {
      return;
    }
    const container = timelineRef.current;
    if (!container) return;
    const onScroll = () => {
      followBottomRef.current = isNearBottom();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver === 'undefined') {
      return () => container.removeEventListener('scroll', onScroll);
    }
    const content = container.querySelector<HTMLElement>(
      '.talk-thread-timeline',
    );
    let initialized = false;
    const observer = new ResizeObserver(() => {
      if (!initialized) {
        initialized = true;
        return;
      }
      if (!followBottomRef.current) return;
      const el = timelineRef.current;
      if (!el) return;
      const target = el.scrollHeight - el.clientHeight;
      if (target > 0) el.scrollTop = target;
    });
    if (content) observer.observe(content);
    return () => {
      container.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [activeConversationId, currentTab, isNearBottom, pageKind]);

  useTalkRunStream({
    dispatch,
    talkId,
    userId,
    pageKind,
    queryClient,
    handleUnauthorized,
    isNearBottom,
    rememberDeletedMessageIds,
    resyncTalkState,
    bumpDocReload,
    deletedMessageIdsRef,
    persistedRunMessageIdsRef,
    pendingMessageRefetchTimersRef,
    autoStickToBottomRef,
    wsCacheRouterRef,
    setToolsRefreshKey,
  });

  useEffect(() => {
    if (pageKind !== 'ready') return;
    // autoStickToBottomRef carries the scroll BEHAVIOR, not just a boolean:
    // 'smooth' for one-shot discrete scrolls (user send, history load) and
    // 'auto' (instant) for the streaming follow. Instant matters during
    // streaming — a 'smooth' animation chases a bottom that keeps growing as
    // tokens arrive, so isNearBottom() reads false mid-animation, the stick
    // disarms, and the view lands short of the true bottom.
    const stickBehavior = autoStickToBottomRef.current;
    if (!stickBehavior) return;
    autoStickToBottomRef.current = null;
    // The scroll is deferred a frame, so guard it on the live follow state —
    // the user may scroll up before it runs and must not be yanked back. This
    // applies to BOTH 'auto' (streaming) and 'smooth' (e.g. a non-user
    // resyncTalkState stream-recovery scroll). Genuine user jumps (send,
    // clear-unread) set followBottomRef = true first, so their scroll still
    // goes through.
    scrollToBottom(stickBehavior, () => followBottomRef.current);
    dispatch({ type: 'CLEAR_UNREAD' });
    // Also depends on liveResponsesByRunId so the effect re-runs on
    // RESPONSE_STARTED (placeholder appears) and on each RESPONSE_DELTA
    // (text grows). The talkStream handlers re-set autoStickToBottomRef
    // every event if the user is still near the bottom, so this becomes
    // a continuous "stick" during streaming. If the user scrolls away,
    // nearBottom flips false, the handlers stop setting the ref, and
    // this effect skips the scroll until they scroll back down.
  }, [
    scrollToBottom,
    pageKind,
    pageMessages.length,
    state.liveResponsesByRunId,
  ]);

  const {
    orchestrationMenuRef,
    orchestrationMenuOpen,
    setOrchestrationMenuOpen,
    orchestrationMode,
    orchestrationState,
    showOrchestrationSelector,
    handleOrchestrationModeChange,
  } = useTalkOrchestrationController({
    talkId,
    userId,
    pageKind,
    pageTalk,
    agentCount: agents.length,
    queryClient,
    onUnauthorized: handleUnauthorized,
  });
  const composerTargetHelp = useMemo(() => {
    if (selectedTargetAgentCount <= 1) {
      return 'Only the selected agent will respond.';
    }
    if (orchestrationMode === 'ordered') {
      return 'Selected agents will respond in order, with the final response synthesizing earlier perspectives.';
    }
    return 'Selected agents will each respond independently.';
  }, [orchestrationMode, selectedTargetAgentCount]);
  const messageLookup = useMemo(
    () =>
      new Map(pageMessages.map((message) => [message.id, message] as const)),
    [pageMessages],
  );
  const {
    runHistory,
    liveResponses,
    orderedGroupSizesById,
    latestOrderedRound,
    activeOrderedProgress,
    talkTimeline,
    activeRound,
    nowTick,
    isDenseRound,
    canEditHistory,
    resolveMessageActorLabel,
  } = useTalkRunViewModel({
    agentLabelById,
    currentTab,
    liveResponsesByRunId: state.liveResponsesByRunId,
    pageKind,
    pageMessages,
    pendingRunHistoryScrollRef,
    runsById: state.runsById,
  });
  const { talkTabHref, agentsTabHref, runsTabHref, manageAgentsHref } =
    useTalkDetailTabLinks({ talkId });
  const handleOpenRunHistory = useCallback(
    (runId: string) => {
      pendingRunHistoryScrollRef.current = runId;
      navigate(runsTabHref);
    },
    [navigate, runsTabHref],
  );
  const {
    historyEditorOpen,
    historyEditState,
    openHistoryEditor,
    handleCloseHistoryEditor,
    handleDeleteHistoryMessages,
  } = useTalkHistoryController({
    talkId,
    pageKind,
    pageTalk,
    hasActiveRound: Boolean(activeRound),
    pageMessages,
    rememberDeletedMessageIds,
    resyncTalkState,
    onUnauthorized: handleUnauthorized,
  });
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;

  const handleToggleSidePanel = useCallback(
    (panel: TalkSidePanelKey) => {
      if (currentTab === 'talk' && sidePanel === panel) {
        navigate(talkTabHref);
        return;
      }
      navigate(`${talkTabHref}?panel=${panel}`);
    },
    [currentTab, navigate, sidePanel, talkTabHref],
  );

  const handleCloseSidePanel = useCallback(() => {
    navigate(talkTabHref);
  }, [navigate, talkTabHref]);

  const handleToggleDocuments = useCallback(() => {
    if (primaryDocumentId === null) {
      navigate(talkTabHref);
      openDocModal();
      return;
    }
    if (currentTab !== 'talk' || sidePanel !== null) {
      navigate(`${talkTabHref}?doc=1`);
      setDocPaneHidden(false);
      if (isNarrowViewport) setMobilePane('doc');
      return;
    }
    if (isNarrowViewport) {
      setDocPaneHidden(false);
      setMobilePane('doc');
      navigate(`${talkTabHref}?doc=1`);
      return;
    }
    setDocPaneHidden((hidden) => !hidden);
  }, [
    currentTab,
    isNarrowViewport,
    navigate,
    openDocModal,
    primaryDocumentId,
    setDocPaneHidden,
    setMobilePane,
    sidePanel,
    talkTabHref,
  ]);

  const composerSend = useTalkSendController({
    pageKind,
    pageTalk,
    activeTalkWorkspaceId,
    activeConversationId,
    activeRound,
    hasUnsavedAgentChanges,
    composerGuardrailMessage,
    targetAgentIds,
    toggleTargetAgent,
    sendState: state.sendState,
    runsById: state.runsById,
    pageMessages,
    dispatch,
    queryClient,
    userId,
    talkId,
    onUnauthorized: handleUnauthorized,
    openHistoryEditor,
    followBottomRef,
    autoStickToBottomRef,
    composer: composerInput,
  });

  const handleClearUnread = () => {
    // User chose to jump to the newest — resume following.
    followBottomRef.current = true;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const jumpToMessage = (messageId: string) => {
    const element = messageElementRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleOpenRunTrigger = useCallback((run: TalkRun) => {
    if (run.triggerMessageId) {
      jumpToMessage(run.triggerMessageId);
    }
  }, []);

  useEffect(() => {
    if (!isRenaming) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isRenaming]);

  if (pageKind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (pageKind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>{pageErrorMessage || 'Talk not found.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (pageKind === 'error' || !pageTalk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{pageErrorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = pageTalk;
  const displayedTitle = titleOverride || talk.title;
  const renderAgentsPanel = (options?: { sidePanel?: boolean }) => (
    <TalkAgentsPanel
      agentDrafts={agentDrafts}
      agentState={agentState}
      agentsCatalogError={agentsCatalogError}
      registeredAgentsCatalog={registeredAgentsCatalog}
      canEditAgents={canEditAgents}
      hasUnsavedAgentChanges={hasUnsavedAgentChanges}
      manageAgentsHref={manageAgentsHref}
      showPanelHeader={options?.sidePanel !== true}
      handleSetPrimaryAgent={handleSetPrimaryAgent}
      handleRemoveAgent={handleRemoveAgent}
      handleAddAgent={handleAddAgent}
      handleSaveAgents={handleSaveAgents}
    />
  );
  const renderContextPanel = () => (
    <section
      className="talk-context-shell ct-screen-enter ct-thin-scroll"
      aria-label="Talk context"
    >
      {contextStatus.status === 'loading' ? (
        <p className="talk-context-empty">Loading context…</p>
      ) : contextStatus.status === 'error' ? (
        <p className="talk-context-status talk-context-status-error">
          {contextStatus.message}
        </p>
      ) : (
        <>
          <TalkContextPanel
            key={talkId}
            talkId={talkId}
            goal={contextGoal}
            rules={contextRules}
            setGoal={setContextGoal}
            setRules={setContextRules}
            status={contextStatus}
            setStatus={setContextStatus}
            goalDraft={goalDraft}
            setGoalDraft={setGoalDraft}
            newRuleText={newRuleText}
            setNewRuleText={setNewRuleText}
            ruleDrafts={ruleDrafts}
            setRuleDrafts={setRuleDrafts}
            canEdit={canEditAgents}
            onUnauthorized={handleUnauthorized}
          />

          <SavedSourcesPanel
            talkId={talkId}
            sources={contextSources}
            setSources={setContextSources}
            canEdit={canEditAgents}
            hasVisionNonDocAgent={hasVisionNonDocAgent}
            onUnauthorized={handleUnauthorized}
          />

          {/* Drive Resources */}
          <TalkToolsPanel talkId={talkId} />

          {contextStatus.status === 'success' && contextStatus.message ? (
            <p className="talk-context-status">{contextStatus.message}</p>
          ) : null}
        </>
      )}
    </section>
  );
  const renderConnectorsPanel = () => (
    <TalkConnectorsPanel talkId={talkId} onUnauthorized={handleUnauthorized} />
  );
  const renderJobsPlaceholder = () => (
    <section className="talk-side-panel-placeholder" aria-label="Talk jobs">
      <h3>Jobs</h3>
      <p>This surface is reserved for Talk jobs.</p>
      <span>Placeholder</span>
    </section>
  );
  const sidePanelMeta =
    sidePanel === 'agents'
      ? {
          title: 'The Room',
          subtitle: `${effectiveAgents.length} ${
            effectiveAgents.length === 1 ? 'agent' : 'agents'
          } in this Talk`,
          icon: 'sparkle' as const,
          content: renderAgentsPanel({ sidePanel: true }),
        }
      : sidePanel === 'context'
        ? {
            title: 'Context',
            subtitle: `${activeRuleCount} active ${
              activeRuleCount === 1 ? 'rule' : 'rules'
            }`,
            icon: 'bolt' as const,
            content: renderContextPanel(),
          }
        : sidePanel === 'connectors'
          ? {
              title: 'Connectors',
              subtitle: 'Workspace connections for this Talk',
              icon: 'globe' as const,
              content: renderConnectorsPanel(),
            }
          : sidePanel === 'jobs'
            ? {
                title: 'Jobs',
                subtitle: 'Placeholder',
                icon: 'clock' as const,
                content: renderJobsPlaceholder(),
              }
            : null;
  const docPaneSuppressed = sidePanel !== null;

  return (
    <section className="page-shell talk-detail-shell">
      <div className="talk-workspace">
        <TalkDetailShell
          talkId={talkId}
          displayedTitle={displayedTitle}
          folderTitle={folderTitle ?? null}
          toolsRefreshKey={toolsRefreshKey}
          isRenaming={isRenaming}
          renameDraft={renameDraft}
          titleInputRef={titleInputRef}
          onRenameDraftChange={onRenameDraftChange}
          onRenameDraftCancel={onRenameDraftCancel}
          onRenameDraftCommit={onRenameDraftCommit}
          currentTab={currentTab}
          runHistoryHref={runsTabHref}
          sidePanel={sidePanel}
          onToggleSidePanel={handleToggleSidePanel}
          onToggleDocuments={handleToggleDocuments}
          documentsOpen={
            currentTab === 'talk' &&
            !docPaneSuppressed &&
            primaryDocumentId !== null &&
            (isNarrowViewport ? mobilePane === 'doc' : !docPaneHidden)
          }
          activeRuleCount={activeRuleCount}
          showOrchestrationSelector={showOrchestrationSelector}
          orchestrationMenuRef={orchestrationMenuRef}
          orchestrationMenuOpen={orchestrationMenuOpen}
          setOrchestrationMenuOpen={setOrchestrationMenuOpen}
          orchestrationMode={orchestrationMode}
          orchestrationState={orchestrationState}
          onOrchestrationModeChange={(mode) => {
            void handleOrchestrationModeChange(mode);
          }}
          currentConversationHasContent={currentConversationHasContent}
          effectiveAgents={effectiveAgents}
          talkAgentExecutionGuardrailsById={talkAgentExecutionGuardrailsById}
        />

        <div
          className={`talk-workspace-scroll${
            currentTab === 'talk' ? ' talk-workspace-scroll-talk' : ''
          }`}
        >
          {currentTab === 'agents' ? renderAgentsPanel() : null}

          {currentTab === 'context' ? renderContextPanel() : null}

          {currentTab === 'connectors' ? renderConnectorsPanel() : null}

          {currentTab === 'jobs' ? (
            <TalkJobsPanel
              key={talkId}
              talkId={talkId}
              canEditJobs={canEditJobs}
              agentOptions={jobAgentOptions}
              jobDraft={jobDraft}
              setJobDraft={setJobDraft}
              creatingJob={creatingJob}
              setCreatingJob={setCreatingJob}
              selectedJobId={selectedJobId}
              setSelectedJobId={setSelectedJobId}
              talkJobs={talkJobs}
              setTalkJobs={setTalkJobs}
              talkJobsLoaded={talkJobsLoaded}
              setTalkJobsLoaded={setTalkJobsLoaded}
              selectedJobRuns={selectedJobRuns}
              setSelectedJobRuns={setSelectedJobRuns}
              selectedJobRunsStatus={selectedJobRunsStatus}
              setSelectedJobRunsStatus={setSelectedJobRunsStatus}
              status={talkJobsStatus}
              setStatus={setTalkJobsStatus}
              onUnauthorized={handleUnauthorized}
              onJobRunSettled={handleJobRunSettled}
            />
          ) : null}

          {currentTab === 'runs' ? (
            <TalkRunsPanel
              runHistory={runHistory}
              runContextPanels={runContextPanels}
              messageLookup={messageLookup}
              talkId={talkId}
              handleOpenRunTrigger={handleOpenRunTrigger}
              handleToggleRunContext={handleToggleRunContext}
              handleUnauthorized={handleUnauthorized}
              refreshBrowserRuns={refreshBrowserRuns}
            />
          ) : null}

          {currentTab === 'documents' ? (
            <TalkDocumentsPanel
              talkId={talkId}
              workspaceId={activeTalkWorkspaceId}
              canEditDoc={canEditDoc}
              onUnauthorized={handleUnauthorized}
            />
          ) : null}

          {currentTab === 'talk' ? (
            <>
              <TalkTabContent
                talkId={talkId}
                splitContainerRef={splitContainerRef}
                splitHandleRef={splitHandleRef}
                docBodyRef={docBodyRef}
                docNarrowShowBtnRef={docNarrowShowBtnRef}
                timelineRef={timelineRef}
                endRef={endRef}
                setMessageElementRef={setMessageElementRef}
                textareaRef={composerInput.textareaRef}
                primaryDocumentId={primaryDocumentId}
                primaryDocumentTitle={primaryDocumentTitle}
                primaryDocumentFormat={primaryDocumentFormat}
                workspaceId={activeTalkWorkspaceId}
                docReloadSignal={docReloadSignal}
                isNarrowViewport={isNarrowViewport}
                mobilePane={mobilePane}
                setMobilePane={setMobilePane}
                docPaneHidden={docPaneHidden}
                docPaneSuppressed={docPaneSuppressed}
                setDocPaneHidden={setDocPaneHidden}
                chatRatio={chatRatio}
                handleResizeHandleKeyDown={handleResizeHandleKeyDown}
                conversationState={conversationState}
                sortedConversations={sortedConversations}
                editingConversationId={editingConversationId}
                setEditingConversationId={setEditingConversationId}
                activeConversationId={activeConversationId}
                activeConversation={activeConversation}
                conversationMenu={conversationMenu}
                menuConversation={menuConversation}
                handleCreateConversation={handleCreateConversation}
                handleSearch={handleSearch}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                searchLoading={searchLoading}
                searchError={searchError}
                searchResults={searchResults}
                handleSearchResultSelect={handleSearchResultSelect}
                handleConversationSecondaryClick={
                  handleConversationSecondaryClick
                }
                handleConversationContextMenu={handleConversationContextMenu}
                handleRenameConversation={handleRenameConversation}
                handleSelectConversation={handleSelectConversation}
                closeConversationMenu={closeConversationMenu}
                onRenameMenuConversation={handleRenameMenuConversation}
                onToggleMenuConversationPin={handleToggleMenuConversationPin}
                onDeleteMenuConversation={handleDeleteMenuConversation}
                handleRenameActiveConversation={handleRenameActiveConversation}
                openHistoryEditor={openHistoryEditor}
                canEditHistory={canEditHistory}
                activeOrderedProgress={activeOrderedProgress}
                latestOrderedRound={latestOrderedRound}
                handleRetryAgentRun={composerSend.handleRetryAgentRun}
                retryRunState={composerSend.retryRunState}
                isSnapshotPending={snapshotQuery.isPending}
                olderMessagesAvailable={olderMessagesAvailable}
                loadingOlderMessages={loadingOlderMessages}
                pageMessages={pageMessages}
                handleLoadOlderMessages={handleLoadOlderMessages}
                talkTimeline={talkTimeline}
                agentsTabHref={agentsTabHref}
                runsById={state.runsById}
                orderedGroupSizesById={orderedGroupSizesById}
                agentLabelById={agentLabelById}
                handleUnauthorized={handleUnauthorized}
                refreshBrowserRuns={refreshBrowserRuns}
                isDenseRound={isDenseRound}
                nowTick={nowTick}
                handleOpenRunHistory={handleOpenRunHistory}
                hasUnreadBelow={state.hasUnreadBelow}
                handleClearUnread={handleClearUnread}
                toolsRefreshKey={toolsRefreshKey}
                handleSend={composerSend.handleSend}
                effectiveAgents={effectiveAgents}
                targetAgentIds={targetAgentIds}
                talkAgentExecutionGuardrailsById={
                  talkAgentExecutionGuardrailsById
                }
                selectedGuardrailAgentIds={selectedGuardrailAgentIds}
                handleToggleTarget={composerSend.handleToggleTarget}
                sendState={state.sendState}
                composerTargetHelp={composerTargetHelp}
                composerModeLabel={
                  pageTalk?.orchestrationMode === 'panel'
                    ? 'Parallel'
                    : 'Ordered'
                }
                composerRoundsLabel={
                  latestOrderedRound
                    ? `${Math.max(1, latestOrderedRound.steps.length)} rounds`
                    : '1 round'
                }
                draft={composerInput.draft}
                TALK_MESSAGE_MAX_CHARS={composerInput.TALK_MESSAGE_MAX_CHARS}
                composerGuardrailMessage={composerGuardrailMessage}
                mentionState={composerInput.mentionState}
                mentionOptions={composerInput.mentionOptions}
                insertMentionOption={composerInput.insertMentionOption}
                setMentionState={composerInput.setMentionState}
                handleDraftChange={composerInput.handleDraftChange}
                handleComposerKeyDown={composerSend.handleComposerKeyDown}
                contextSources={contextSources}
                activeRound={activeRound}
                hasUnsavedAgentChanges={hasUnsavedAgentChanges}
                canEditAgents={canEditAgents}
                handleCancelRuns={composerSend.handleCancelRuns}
                cancelState={state.cancelState}
                sendBlockedByGuardrail={sendBlockedByGuardrail}
                historyEditState={historyEditState}
                handleShowDocPane={handleShowDocPane}
                handleHideDocPane={handleHideDocPane}
                canEditDoc={canEditDoc}
                currentUser={currentUser}
              />
              {sidePanelMeta ? (
                <TalkSidePanelShell
                  title={sidePanelMeta.title}
                  subtitle={sidePanelMeta.subtitle}
                  icon={sidePanelMeta.icon}
                  onClose={handleCloseSidePanel}
                >
                  {sidePanelMeta.content}
                </TalkSidePanelShell>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <TalkHistoryEditor
        isOpen={historyEditorOpen}
        messages={pageMessages}
        busy={historyEditState.status === 'saving'}
        errorMessage={
          historyEditorOpen && historyEditState.status === 'error'
            ? historyEditState.message || null
            : null
        }
        onClose={handleCloseHistoryEditor}
        onConfirm={handleDeleteHistoryMessages}
        resolveActorLabel={resolveMessageActorLabel}
      />
      {docModalOpen ? (
        <TalkDocumentCreateModal
          title={docModalTitle}
          format={docModalFormat}
          submitting={docModalSubmitting}
          error={docModalError}
          inputRef={docModalInputRef}
          onTitleChange={setDocModalTitle}
          onFormatChange={setDocModalFormat}
          onClose={closeDocModal}
          onSubmit={handleCreateDoc}
        />
      ) : null}
    </section>
  );
}
