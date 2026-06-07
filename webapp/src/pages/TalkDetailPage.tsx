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
  ApiError,
  ContentSidebarItem,
  getTalk,
  getTalkAgents,
  getTalkRuns,
  listTalkThreads,
  listTalkMessages,
  Talk,
  TalkMessage,
  TalkRun,
  TalkSnapshot,
  UnauthorizedError,
} from '../lib/api';
import { TalkToolsPanel } from '../components/TalkToolsPanel';
import { SavedSourcesPanel } from '../components/SavedSourcesPanel';
import { TalkContextPanel } from '../components/TalkContextPanel';
import { TalkJobsPanel } from '../components/TalkJobsPanel';
import { TalkConnectorsPanel } from '../components/connectors/TalkConnectorsPanel';
import { TalkAgentsPanel } from '../components/TalkAgentsPanel';
import { TalkRunsPanel } from '../components/TalkRunsPanel';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { TalkDetailShell } from '../components/Talk/TalkDetailShell';
import { TalkTabContent } from '../components/Talk/TalkTabContent';
import { getLastThreadForTalk } from '../lib/lastThreadForTalk';
import {
  loadThreadScroll,
  saveThreadScroll,
} from '../lib/threadScroll';
import { useTalkRunStream } from '../hooks/useTalkRunStream';
import {
  buildThreadHref,
  useTalkDetailRouteState,
  useTalkDetailTabLinks,
} from '../hooks/useTalkDetailTabs';
import { useTalkDocumentController } from '../hooks/useTalkDocumentController';
import { useTalkRunViewModel } from '../hooks/useTalkRunViewModel';
import { useTalkContextController } from '../hooks/useTalkContextController';
import { useTalkJobsController } from '../hooks/useTalkJobsController';
import { useTalkOrchestrationController } from '../hooks/useTalkOrchestrationController';
import { useTalkHistoryController } from '../hooks/useTalkHistoryController';
import { useTalkAgentsController } from '../hooks/useTalkAgentsController';
import { useTalkThreadController } from '../hooks/useTalkThreadController';
import {
  useTalkComposerInputController,
  useTalkSendController,
} from '../hooks/useTalkComposerController';
import { useTalkRunContextController } from '../hooks/useTalkRunContextController';
import { createInitialDetailState, detailReducer } from '../lib/talkRunReducer';
import { useQueryClient } from '@tanstack/react-query';
import {
  rememberActiveThreadForTalk,
  snapshotQueryKey,
  useTalkSnapshot,
} from '../lib/useTalkSnapshot';
import {
  createWsCacheRouter,
  prependOlderTalkMessagesToSnapshot,
} from '../lib/wsCacheRouter';

const SCROLL_STICK_THRESHOLD_PX = 120;

const EMPTY_MESSAGES: TalkMessage[] = [];

// Stable conversion from the snapshot's wire shape to the webapp's Talk
// type (defaults `title` to '' and `agents` to []) so render-site reads
// against `snapshot.talk` get the same shape the old reducer mirrored.
function snapshotTalkToTalk(snapshotTalk: TalkSnapshot['talk']): Talk {
  return {
    id: snapshotTalk.id,
    ownerId: snapshotTalk.ownerId,
    title: snapshotTalk.title ?? '',
    orchestrationMode: snapshotTalk.orchestrationMode,
    agents: [],
    status: snapshotTalk.status,
    folderId: snapshotTalk.folderId,
    sortOrder: snapshotTalk.sortOrder,
    version: snapshotTalk.version,
    createdAt: snapshotTalk.createdAt,
    updatedAt: snapshotTalk.updatedAt,
    accessRole: snapshotTalk.accessRole,
  };
}

function snapshotRunsToTalkRuns(snapshotRuns: TalkSnapshot['runs']): TalkRun[] {
  return snapshotRuns.map((row) => ({
    id: row.id,
    threadId: row.threadId,
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
  }));
}

export function TalkDetailPage({
  userId,
  onUnauthorized,
  titleOverride,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  onSidebarChanged,
  sidebarContents,
}: {
  userId: string;
  onUnauthorized: () => void;
  titleOverride?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  onSidebarChanged: () => Promise<void> | void;
  sidebarContents: ContentSidebarItem[];
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const navigate = useNavigate();
  const { currentTab, locationParams } = useTalkDetailRouteState(talkId);
  const requestedThreadId = locationParams.get('thread')?.trim() || null;
  // If the URL hasn't pinned a thread yet, ride the saved last-viewed
  // thread for this Talk so the snapshot warms straight to the UX the
  // user expects (avoids the bootstrap → refetch-on-resolve double-hop).
  const initialResolvedThreadId =
    requestedThreadId ?? getLastThreadForTalk(talkId);
  const queryClient = useQueryClient();
  const snapshotQuery = useTalkSnapshot({
    userId,
    talkId,
    threadId: initialResolvedThreadId,
    onUnauthorized,
  });
  const wsCacheRouterRef = useRef(createWsCacheRouter(queryClient));
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
  );

  // Derived snapshot accessors — PR C: server data lives in React
  // Query. Render-site reads pull from these instead of the reducer.
  //
  // Once the page has rendered with snapshot data, we stay 'ready' even
  // during background refetches and thread-switch rekeys (which drop
  // snapshotQuery.data back to undefined). Flipping pageKind back to
  // 'loading' would unmount the ready-branch tree — replacing the
  // thread rail / composer DOM nodes — which breaks any handler that
  // captured a DOM reference (e.g. handleDeleteThread holding a
  // threadRail node) and causes a visible page-level loading flash.
  const lastSnapshotRef = useRef<TalkSnapshot | null>(null);
  // Only fall back to the last-good snapshot when it belongs to the
  // currently-routed talk. Cross-talk navigation drops the fallback
  // immediately so the previous talk's messages/title can't render
  // against the new talkId — and so handlers reading pageTalk.id can't
  // mutate the previous Talk before the new snapshot resolves.
  if (snapshotQuery.data) {
    lastSnapshotRef.current = snapshotQuery.data;
  } else if (
    lastSnapshotRef.current &&
    lastSnapshotRef.current.talk.id !== talkId
  ) {
    lastSnapshotRef.current = null;
  }
  const talkSnapshot = snapshotQuery.data ?? lastSnapshotRef.current;
  const snapshotError = snapshotQuery.error;
  const snapshotIs404 =
    snapshotError instanceof ApiError && snapshotError.status === 404;
  const pageKind: 'loading' | 'ready' | 'unavailable' | 'error' = snapshotIs404
    ? 'unavailable'
    : snapshotError
      ? 'error'
      : !talkSnapshot
        ? 'loading'
        : 'ready';
  const pageErrorMessage: string | null = snapshotIs404
    ? 'Talk not found'
    : snapshotError instanceof Error
      ? snapshotError.message
      : null;
  const pageTalk: Talk | null = useMemo(
    () => (talkSnapshot ? snapshotTalkToTalk(talkSnapshot.talk) : null),
    [talkSnapshot?.talk],
  );
  const activeTalkWorkspaceId = talkSnapshot?.talk.workspaceId ?? null;
  const accessRole = pageKind === 'ready' ? pageTalk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditJobs = canEditAgents;
  const canEditDoc = canEditAgents;
  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const pendingComposerFocusRef = useRef(false);
  const pendingRunHistoryScrollRef = useRef<string | null>(null);
  const threadSnapshotVersionRef = useRef(0);
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
    threadState,
    editingThreadId,
    setEditingThreadId,
    threadMenu,
    activeThreadId,
    activeThreadIdRef,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    searchError,
    sortedThreads,
    activeThread,
    menuThread,
    resetTalkThreads,
    hydrateTalkThreads,
    replaceThreadList,
    scheduleThreadListRefresh,
    ensureKnownThread,
    bumpThreadSummaryFromMessage,
    handleRenameThread,
    handleRenameActiveThread,
    handleSelectThread,
    handleThreadSecondaryClick,
    handleThreadContextMenu,
    handleCreateThread,
    handleSearch,
    handleSearchResultSelect,
    closeThreadMenu,
    handleRenameMenuThread,
    handleToggleMenuThreadPin,
    handleDeleteMenuThread,
  } = useTalkThreadController({
    talkId,
    requestedThreadId,
    currentTab,
    pageKind,
    pageTalkId: pageTalk?.id ?? null,
    canEditThreads: canEditAgents,
    navigate,
    pendingComposerFocusRef,
    onUnauthorized: handleUnauthorized,
  });

  const {
    runContextPanels,
    resetRunContextPanels,
    handleToggleRunContext,
  } = useTalkRunContextController({
    talkId,
    onUnauthorized: handleUnauthorized,
  });

  useEffect(() => {
    threadSnapshotVersionRef.current += 1;
  }, [activeThreadId]);

  // PR C: keep the reducer's selectedThreadId in lockstep with the
  // page's activeThreadId useState. Several actions (RUN_QUEUED,
  // RUN_STARTED, RESPONSE_FAILED) guard on this to decide whether a
  // live-response panel belongs in the currently-rendered thread.
  useEffect(() => {
    dispatch({ type: 'THREAD_SELECTED', threadId: activeThreadId });
  }, [activeThreadId]);

  const currentThreadHasContent = useMemo(
    () =>
      activeThreadId !== null &&
      sidebarContents.some((c) => c.threadId === activeThreadId),
    [activeThreadId, sidebarContents],
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
    talkContent,
    setTalkContent,
    talkContentLoading,
    talkContentError,
    setTalkContentError,
    talkContentPendingEdits,
    setTalkContentPendingEdits,
    pendingEditStreamingByRunId,
    setPendingEditStreamingByRunId,
    pendingEditStreamingStartedAtRef,
    pendingEditInFlight,
    setPendingEditInFlight,
    talkContentSaveStatus,
    setTalkContentSaveStatus,
    talkContentConflict,
    setTalkContentConflict,
    talkContentRef,
    talkContentSaveStatusRef,
    docPaneHidden,
    setDocPaneHidden,
    htmlMode,
    setHtmlMode,
    htmlAutoFlippedRef,
    htmlSourceDraft,
    docBodyRef,
    docNarrowShowBtnRef,
    chatRatio,
    isNarrowViewport,
    mobilePane,
    setMobilePane,
    splitContainerRef,
    splitHandleRef,
    handleResizeHandleKeyDown,
    handleHtmlSourceChange,
    handleHtmlSourceSave,
    handleDocTitleSave,
    handleHideDocPane,
    handleShowDocPane,
    refetchTalkContent,
    hydrateDocumentFromSnapshot,
  } = useTalkDocumentController({
    talkId,
    userId,
    activeThreadId,
    activeThreadIdRef,
    currentTab,
    locationParams,
    currentThreadHasContent,
    queryClient,
    navigate,
    onUnauthorized,
    onSidebarChanged,
  });

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
    currentTab,
    pageKind,
    onUnauthorized: handleUnauthorized,
  });

  const composerInput = useTalkComposerInputController({
    pageKind,
    pageTalk,
    activeThreadId,
    currentTab,
    sendState: state.sendState,
    dispatch,
    contextSources,
    talkContent,
  });

  const {
    agents,
    agentDrafts,
    setAgentDrafts,
    newAgentDraft,
    setNewAgentDraft,
    agentState,
    setAgentState,
    agentsCatalogError,
    registeredAgentsCatalog,
    targetAgentIds,
    effectiveAgents,
    jobAgentOptions,
    hasPendingFooterAgentSelection,
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
    handleAgentNicknameChange,
    handleAgentRoleChange,
    handleSetPrimaryAgent,
    handleResetNickname,
    handleRemoveAgent,
    handleAddAgent,
    handleSaveAgents,
  } = useTalkAgentsController({
    pageKind,
    pageTalkId: pageTalk?.id ?? null,
    activeTalkWorkspaceId,
    canEditAgents,
    hasPendingImageAttachments: composerInput.hasPendingImageAttachments,
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
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    if (loadingOlderMessages) return;
    const oldest = pageKind === 'ready' ? pageMessages[0] : null;
    if (!oldest) return;
    setLoadingOlderMessages(true);
    const pageSize = 200;
    try {
      const older = await listTalkMessages(talkId, {
        threadId,
        before: oldest.createdAt,
        limit: pageSize,
      });
      if (activeThreadIdRef.current !== threadId) return;
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
        threadId,
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

  const resyncTalkState = useCallback(
    async (options?: { refreshThreads?: boolean }) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const snapshotVersion = threadSnapshotVersionRef.current;
      // PR C: messages + active runs come from the snapshot query —
      // invalidate it and let RQ refetch. Historical runs are still
      // separate; re-fetch them in parallel so the Runs tab updates.
      // The threads list stays on its component-local state.
      void queryClient.invalidateQueries({
        queryKey: snapshotQueryKey(userId, talkId, threadId),
      });
      try {
        const [threads, runs] = await Promise.all([
          options?.refreshThreads === false
            ? Promise.resolve(null)
            : listTalkThreads(talkId),
          getTalkRuns(talkId),
        ]);
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (threads) {
          replaceThreadList(threads);
        }
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
        autoStickToBottomRef.current = 'smooth';
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    },
    [handleUnauthorized, queryClient, replaceThreadList, talkId, userId],
  );

  const refreshBrowserRuns = useCallback(
    async () => resyncTalkState({ refreshThreads: true }),
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
    activeThreadIdRef,
    resyncTalkState,
  });

  // Tracks the last (talkId, activeThreadId) we fully hydrated from the
  // snapshot. PR C: same-thread refetches no longer dispatch into the
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
    lastSnapshotRef.current = null;
    messageElementRefs.current.clear();
    deletedMessageIdsRef.current = new Set();
    resetTalkThreads();
    resetTalkAgents();
    resetRunContextPanels();
  }, [resetRunContextPanels, resetTalkAgents, resetTalkThreads, talkId]);

  // Hydrate non-RQ side-effects the moment the snapshot resolves: the
  // thread list (kept in component state because the threads tab edits
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
    const hydrationKey = `${talkId}::${snapshot.activeThreadId}`;
    const isFirstHydration = hydratedKeyRef.current !== hydrationKey;
    hydrateTalkThreads(snapshot.threads);
    // Always reconcile doc state — it advances independently of the
    // message timeline (content_updated/applied/resolved invalidates).
    hydrateDocumentFromSnapshot(snapshot);
    rememberActiveThreadForTalk(talkId, snapshot.activeThreadId);
    setOlderMessagesAvailable(snapshot.hasOlderMessages);
    if (!isFirstHydration) return;
    hydratedKeyRef.current = hydrationKey;
    dispatch({
      type: 'SNAPSHOT_HYDRATED',
      threadId: snapshot.activeThreadId,
      runs: snapshotRunsToTalkRuns(snapshot.runs),
    });
  }, [
    hydrateDocumentFromSnapshot,
    hydrateTalkThreads,
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

  // Thread-show scroll: restore the saved offset for this (talkId,
  // threadId) if the user had scrolled up to read history; otherwise
  // park at the bottom.
  //
  // We gate on the snapshot's activeThreadId matching the current
  // activeThreadId so a thread switch waits for the new snapshot to
  // land before scrolling — pageKind stays 'ready' across switches via
  // lastSnapshotRef, so the previous thread's DOM is what's mounted
  // until the new snapshot resolves. snapshotActiveThreadId is a
  // primitive derived from the cached snapshot, so background refetches
  // for the same thread don't re-trigger this effect.
  const snapshotActiveThreadId = snapshotQuery.data?.activeThreadId ?? null;
  useEffect(() => {
    if (pageKind !== 'ready' || !activeThreadId) return;
    if (snapshotActiveThreadId !== activeThreadId) return;
    const saved = loadThreadScroll(talkId, activeThreadId);
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
  }, [
    activeThreadId,
    scrollToBottom,
    pageKind,
    snapshotActiveThreadId,
    talkId,
  ]);

  // Persist scroll position + at-bottom flag on user scroll, debounced
  // ~200ms. Owns the localStorage write end of the per-thread scroll
  // memory so the next mount can restore.
  useEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    if (pageKind !== 'ready' || !activeThreadId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const capturedTalkId = talkId;
    const capturedThreadId = activeThreadId;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const el = timelineRef.current;
        if (!el) return;
        saveThreadScroll(capturedTalkId, capturedThreadId, {
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
  }, [activeThreadId, isNearBottom, pageKind, talkId]);

  // Reset the follow flag whenever the thread changes: default to "not
  // following" until the per-thread scroll-restore effect above decides. This
  // keeps the reflow stick inert during a cold thread-switch fetch (when the
  // restore effect is gated out waiting on the snapshot), so it can never pin
  // to the bottom over a restored mid-scroll position.
  useEffect(() => {
    followBottomRef.current = false;
  }, [activeThreadId]);

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
  // a remount or thread switch can't auto-scroll), and bind to the Talk tab
  // only — the timeline unmounts on other tabs, so the effect must re-bind on
  // tab re-entry (and per thread).
  useEffect(() => {
    if (pageKind !== 'ready' || !activeThreadId || currentTab !== 'talk') {
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
  }, [activeThreadId, currentTab, isNearBottom, pageKind]);

  useTalkRunStream({
    dispatch,
    talkId,
    userId,
    pageKind,
    queryClient,
    handleUnauthorized,
    ensureKnownThread,
    bumpThreadSummaryFromMessage,
    isNearBottom,
    rememberDeletedMessageIds,
    scheduleThreadListRefresh,
    resyncTalkState,
    refetchTalkContent,
    deletedMessageIdsRef,
    persistedRunMessageIdsRef,
    pendingMessageRefetchTimersRef,
    activeThreadIdRef,
    autoStickToBottomRef,
    talkContentRef,
    talkContentSaveStatusRef,
    pendingEditStreamingStartedAtRef,
    htmlAutoFlippedRef,
    wsCacheRouterRef,
    setTalkContentConflict,
    setPendingEditStreamingByRunId,
    setHtmlMode,
    setTalkContentPendingEdits,
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
    activeThreadIdRef,
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
    activeThreadId,
    agentLabelById,
    currentTab,
    liveResponsesByRunId: state.liveResponsesByRunId,
    pageKind,
    pageMessages,
    pendingRunHistoryScrollRef,
    runsById: state.runsById,
  });
  const {
    threadAwareTalkTabHref,
    agentsTabHref,
    contextTabHref,
    workspaceConnectorsTabHref,
    jobsTabHref,
    runsTabHref,
    manageAgentsHref,
  } = useTalkDetailTabLinks({ talkId, activeThreadId });
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
    activeThreadId,
    hasActiveRound: Boolean(activeRound),
    pageMessages,
    threadSnapshotVersionRef,
    rememberDeletedMessageIds,
    resyncTalkState,
    onUnauthorized: handleUnauthorized,
  });
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;

  const composerSend = useTalkSendController({
    pageKind,
    pageTalk,
    activeTalkWorkspaceId,
    activeThreadId,
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

  const handleOpenRunTrigger = useCallback(
    (run: TalkRun) => {
      if (!run.threadId) return;
      if (run.threadId !== activeThreadId) {
        navigate(buildThreadHref(talkId, run.threadId));
        return;
      }
      if (run.triggerMessageId) {
        jumpToMessage(run.triggerMessageId);
      }
    },
    [activeThreadId, navigate, talkId],
  );

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

  return (
    <section className="page-shell talk-detail-shell">
      <div
        className={`talk-workspace${composerInput.isDragOver ? ' talk-workspace-drag-over' : ''}`}
        onDragEnter={composerInput.handleDragEnter}
        onDragLeave={composerInput.handleDragLeave}
        onDragOver={composerInput.handleDragOver}
        onDrop={composerInput.handleDrop}
      >
        {composerInput.isDragOver ? (
          <div className="talk-workspace-drop-overlay">
            Drop files to attach
          </div>
        ) : null}
        <TalkDetailShell
          talkId={talkId}
          displayedTitle={displayedTitle}
          isRenaming={isRenaming}
          renameDraft={renameDraft}
          titleInputRef={titleInputRef}
          onRenameDraftChange={onRenameDraftChange}
          onRenameDraftCancel={onRenameDraftCancel}
          onRenameDraftCommit={onRenameDraftCommit}
          currentTab={currentTab}
          tabLinks={{
            threadAwareTalkTabHref,
            agentsTabHref,
            contextTabHref,
            workspaceConnectorsTabHref,
            jobsTabHref,
            runsTabHref,
            manageAgentsHref,
          }}
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
          currentThreadHasContent={currentThreadHasContent}
          openDocModal={openDocModal}
          effectiveAgents={effectiveAgents}
          talkAgentExecutionGuardrailsById={talkAgentExecutionGuardrailsById}
        />

        <div
          className={`talk-workspace-scroll${
            currentTab === 'talk' ? ' talk-workspace-scroll-talk' : ''
          }`}
        >
          {currentTab === 'agents' ? (
            <TalkAgentsPanel
              agentDrafts={agentDrafts}
              setAgentDrafts={setAgentDrafts}
              newAgentDraft={newAgentDraft}
              setNewAgentDraft={setNewAgentDraft}
              agentState={agentState}
              setAgentState={setAgentState}
              agentsCatalogError={agentsCatalogError}
              registeredAgentsCatalog={registeredAgentsCatalog}
              canEditAgents={canEditAgents}
              hasPendingFooterAgentSelection={hasPendingFooterAgentSelection}
              manageAgentsHref={manageAgentsHref}
              handleAgentNicknameChange={handleAgentNicknameChange}
              handleAgentRoleChange={handleAgentRoleChange}
              handleSetPrimaryAgent={handleSetPrimaryAgent}
              handleResetNickname={handleResetNickname}
              handleRemoveAgent={handleRemoveAgent}
              handleAddAgent={handleAddAgent}
              handleSaveAgents={handleSaveAgents}
            />
          ) : null}

          {currentTab === 'context' ? (
            <section className="talk-tab-panel" aria-label="Talk context">
              {contextStatus.status === 'loading' ? (
                <p className="page-state">Loading context…</p>
              ) : contextStatus.status === 'error' ? (
                <p className="page-state error">{contextStatus.message}</p>
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

                  {contextStatus.status === 'success' &&
                  contextStatus.message ? (
                    <p className="page-state">{contextStatus.message}</p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'connectors' ? (
            <TalkConnectorsPanel
              talkId={talkId}
              onUnauthorized={handleUnauthorized}
            />
          ) : null}

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

          {currentTab === 'talk' ? (
            <TalkTabContent
              talkId={talkId}
              splitContainerRef={splitContainerRef}
              splitHandleRef={splitHandleRef}
              docBodyRef={docBodyRef}
              docNarrowShowBtnRef={docNarrowShowBtnRef}
              timelineRef={timelineRef}
              endRef={endRef}
              setMessageElementRef={setMessageElementRef}
              fileInputRef={composerInput.fileInputRef}
              textareaRef={composerInput.textareaRef}
              talkContent={talkContent}
              setTalkContent={setTalkContent}
              isNarrowViewport={isNarrowViewport}
              mobilePane={mobilePane}
              setMobilePane={setMobilePane}
              docPaneHidden={docPaneHidden}
              setDocPaneHidden={setDocPaneHidden}
              chatRatio={chatRatio}
              handleResizeHandleKeyDown={handleResizeHandleKeyDown}
              threadState={threadState}
              sortedThreads={sortedThreads}
              editingThreadId={editingThreadId}
              setEditingThreadId={setEditingThreadId}
              activeThreadId={activeThreadId}
              activeThread={activeThread}
              threadMenu={threadMenu}
              menuThread={menuThread}
              handleCreateThread={handleCreateThread}
              handleSearch={handleSearch}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchLoading={searchLoading}
              searchError={searchError}
              searchResults={searchResults}
              handleSearchResultSelect={handleSearchResultSelect}
              handleThreadSecondaryClick={handleThreadSecondaryClick}
              handleThreadContextMenu={handleThreadContextMenu}
              handleRenameThread={handleRenameThread}
              handleSelectThread={handleSelectThread}
              closeThreadMenu={closeThreadMenu}
              onRenameMenuThread={handleRenameMenuThread}
              onToggleMenuThreadPin={handleToggleMenuThreadPin}
              onDeleteMenuThread={handleDeleteMenuThread}
              handleRenameActiveThread={handleRenameActiveThread}
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
              ALLOWED_ATTACHMENT_EXTENSIONS={
                composerInput.ALLOWED_ATTACHMENT_EXTENSIONS
              }
              handleFileInputChange={composerInput.handleFileInputChange}
              GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED={
                composerInput.GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED
              }
              effectiveAgents={effectiveAgents}
              targetAgentIds={targetAgentIds}
              talkAgentExecutionGuardrailsById={
                talkAgentExecutionGuardrailsById
              }
              selectedGuardrailAgentIds={selectedGuardrailAgentIds}
              handleToggleTarget={composerSend.handleToggleTarget}
              sendState={state.sendState}
              composerTargetHelp={composerTargetHelp}
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
              pendingAttachments={composerInput.pendingAttachments}
              handleRemoveAttachment={composerInput.handleRemoveAttachment}
              handleAttachButtonClick={composerInput.handleAttachButtonClick}
              canEditAgents={canEditAgents}
              handleCancelRuns={composerSend.handleCancelRuns}
              cancelState={state.cancelState}
              sendBlockedByGuardrail={sendBlockedByGuardrail}
              historyEditState={historyEditState}
              handleShowDocPane={handleShowDocPane}
              handleHideDocPane={handleHideDocPane}
              handleDocTitleSave={handleDocTitleSave}
              talkContentSaveStatus={talkContentSaveStatus}
              talkContentLoading={talkContentLoading}
              htmlMode={htmlMode}
              setHtmlMode={setHtmlMode}
              talkContentConflict={talkContentConflict}
              setTalkContentConflict={setTalkContentConflict}
              setTalkContentSaveStatus={setTalkContentSaveStatus}
              refetchTalkContent={refetchTalkContent}
              talkContentError={talkContentError}
              htmlSourceDraft={htmlSourceDraft}
              handleHtmlSourceChange={handleHtmlSourceChange}
              handleHtmlSourceSave={handleHtmlSourceSave}
              canEditDoc={canEditDoc}
              talkContentPendingEdits={talkContentPendingEdits}
              setTalkContentPendingEdits={setTalkContentPendingEdits}
              pendingEditStreamingByRunId={pendingEditStreamingByRunId}
              pendingEditInFlight={pendingEditInFlight}
              setPendingEditInFlight={setPendingEditInFlight}
              setTalkContentError={setTalkContentError}
            />
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
        <div
          className="doc-promote-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doc-promote-modal-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDocModal();
          }}
        >
          <form className="doc-promote-modal" onSubmit={handleCreateDoc}>
            <h3 id="doc-promote-modal-title">Add a document</h3>
            <label
              className="doc-promote-modal-label"
              htmlFor="doc-promote-modal-input"
            >
              Title
            </label>
            <input
              id="doc-promote-modal-input"
              ref={docModalInputRef}
              type="text"
              className="doc-promote-modal-input"
              value={docModalTitle}
              onChange={(event) => setDocModalTitle(event.target.value)}
              placeholder="Untitled document"
              maxLength={160}
              disabled={docModalSubmitting}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeDocModal();
                }
              }}
            />
            <fieldset
              className="doc-promote-modal-format"
              disabled={docModalSubmitting}
            >
              <legend className="doc-promote-modal-label">Format</legend>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="markdown"
                  checked={docModalFormat === 'markdown'}
                  onChange={() => setDocModalFormat('markdown')}
                />
                Markdown
              </label>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="html"
                  checked={docModalFormat === 'html'}
                  onChange={() => setDocModalFormat('html')}
                />
                HTML
              </label>
            </fieldset>
            {docModalError ? (
              <p className="doc-promote-modal-error" role="alert">
                {docModalError}
              </p>
            ) : null}
            <div className="doc-promote-modal-actions">
              <button
                type="button"
                className="doc-promote-modal-cancel"
                onClick={closeDocModal}
                disabled={docModalSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="doc-promote-modal-submit"
                disabled={docModalSubmitting || !docModalTitle.trim()}
              >
                {docModalSubmitting ? 'Creating…' : 'Create document'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
