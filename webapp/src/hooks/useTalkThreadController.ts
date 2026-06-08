import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import type { NavigateFunction } from 'react-router-dom';

import {
  createTalkThread,
  deleteTalkThread,
  listTalkThreads,
  searchTalkMessages,
  updateTalkThread,
  UnauthorizedError,
  type TalkMessageSearchResult,
  type TalkThread,
} from '../lib/api';
import {
  getLastThreadForTalk,
  setLastThreadForTalk,
} from '../lib/lastThreadForTalk';
import { clearThreadScroll } from '../lib/threadScroll';
import { formatThreadLabel } from '../lib/threadTitles';
import {
  buildThreadHref,
  type TalkDetailTabKey,
} from './useTalkDetailTabs';

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

export type ThreadListState = {
  threads: TalkThread[];
  loading: boolean;
  error: string | null;
};

type UseTalkThreadControllerInput = {
  talkId: string;
  requestedThreadId: string | null;
  currentTab: TalkDetailTabKey;
  pageKind: PageKind;
  pageTalkId: string | null;
  canEditThreads: boolean;
  navigate: NavigateFunction;
  pendingComposerFocusRef: MutableRefObject<boolean>;
  onUnauthorized: () => void;
};

export function sortThreads(threads: TalkThread[]): TalkThread[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return Number(right.isPinned) - Number(left.isPinned);
    }
    const leftAt = left.lastMessageAt || left.createdAt;
    const rightAt = right.lastMessageAt || right.createdAt;
    const delta = Date.parse(rightAt) - Date.parse(leftAt);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return rightAt.localeCompare(leftAt);
  });
}

export function useTalkThreadController({
  talkId,
  requestedThreadId,
  currentTab,
  pageKind,
  pageTalkId,
  canEditThreads,
  navigate,
  pendingComposerFocusRef,
  onUnauthorized,
}: UseTalkThreadControllerInput) {
  const [threadState, setThreadState] = useState<ThreadListState>({
    threads: [],
    loading: true,
    error: null,
  });
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    threadId: string;
    x: number;
    y: number;
  } | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TalkMessageSearchResult[]>(
    [],
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const threadRefreshInFlightRef = useRef(false);
  const threadRefreshDirtyRef = useRef(false);
  const activeThreadIdRef = useRef<string | null>(null);
  const threadStateRef = useRef<ThreadListState>(threadState);
  const searchQueryRef = useRef(searchQuery);
  const threadStateTalkIdRef = useRef<string | null>(null);

  activeThreadIdRef.current = activeThreadId;
  threadStateRef.current = threadState;
  searchQueryRef.current = searchQuery;

  useEffect(
    () => () => {
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = null;
      }
      threadRefreshDirtyRef.current = false;
      threadRefreshInFlightRef.current = false;
    },
    [],
  );

  const sortedThreads = useMemo(
    () => sortThreads(threadState.threads),
    [threadState.threads],
  );
  const activeThread = useMemo(
    () => sortedThreads.find((thread) => thread.id === activeThreadId) || null,
    [activeThreadId, sortedThreads],
  );
  const menuThread = useMemo(
    () =>
      threadMenu
        ? threadState.threads.find(
            (thread) => thread.id === threadMenu.threadId,
          ) || null
        : null,
    [threadMenu, threadState.threads],
  );

  const resetTalkThreads = useCallback(() => {
    threadStateTalkIdRef.current = null;
    setThreadState({ threads: [], loading: true, error: null });
    setEditingThreadId(null);
    setThreadMenu(null);
    setActiveThreadId(null);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    setSearchError(null);
    if (threadRefreshTimerRef.current) {
      clearTimeout(threadRefreshTimerRef.current);
      threadRefreshTimerRef.current = null;
    }
    threadRefreshDirtyRef.current = false;
    threadRefreshInFlightRef.current = false;
  }, []);

  const hydrateTalkThreads = useCallback(
    (threads: Array<TalkThread & { isInternal?: boolean }>) => {
      const sorted = sortThreads(
        threads.filter((thread) => !thread.isInternal),
      );
      setThreadState({ threads: sorted, loading: false, error: null });
      threadStateTalkIdRef.current = talkId;
    },
    [talkId],
  );

  const replaceThreadList = useCallback((threads: TalkThread[]) => {
    threadStateTalkIdRef.current = talkId;
    setThreadState({
      threads: sortThreads(threads),
      loading: false,
      error: null,
    });
  }, [talkId]);

  const refreshThreadListNow = useCallback(async () => {
    if (threadRefreshInFlightRef.current) {
      threadRefreshDirtyRef.current = true;
      return;
    }
    threadRefreshInFlightRef.current = true;
    try {
      const next = sortThreads(await listTalkThreads(talkId));
      threadStateTalkIdRef.current = talkId;
      setThreadState({ threads: next, loading: false, error: null });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load threads.',
      }));
    } finally {
      threadRefreshInFlightRef.current = false;
      if (threadRefreshDirtyRef.current) {
        threadRefreshDirtyRef.current = false;
        void refreshThreadListNow();
      }
    }
  }, [onUnauthorized, talkId]);

  const scheduleThreadListRefresh = useCallback(() => {
    threadRefreshDirtyRef.current = true;
    if (threadRefreshTimerRef.current) return;
    threadRefreshTimerRef.current = setTimeout(() => {
      threadRefreshTimerRef.current = null;
      if (!threadRefreshDirtyRef.current) return;
      threadRefreshDirtyRef.current = false;
      void refreshThreadListNow();
    }, 500);
  }, [refreshThreadListNow]);

  const ensureKnownThread = useCallback(
    (threadId?: string | null): boolean => {
      if (!threadId) return false;
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
      }
      return known;
    },
    [scheduleThreadListRefresh],
  );

  const bumpThreadSummaryFromMessage = useCallback(
    (threadId: string, createdAt: string) => {
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
        return;
      }
      setThreadState((current) => {
        const threads = current.threads.map((thread) => {
          if (thread.id !== threadId) return thread;
          return {
            ...thread,
            messageCount: thread.messageCount + 1,
            lastMessageAt: createdAt,
          };
        });
        return { ...current, threads: sortThreads(threads) };
      });
    },
    [scheduleThreadListRefresh],
  );

  useEffect(() => {
    if (threadState.loading) return;
    // Bail when threadState was loaded for a different talkId — happens
    // mid-commit during cross-talk sidebar navigation, where this effect
    // fires before the bootstrap effect's state resets propagate.
    // Without this gate we'd save Talk A's threads[0] under Talk B's key.
    if (threadStateTalkIdRef.current !== talkId) return;
    if (threadState.threads.length === 0) {
      setActiveThreadId(null);
      return;
    }

    // Resolution order: URL ?thread= → saved-last-thread for this Talk
    // (localStorage) → most-recent-by-activity (threads[0]). Saved id is
    // dropped if the thread no longer exists.
    let validThreadId: string | null = null;
    if (
      requestedThreadId &&
      threadState.threads.some((thread) => thread.id === requestedThreadId)
    ) {
      validThreadId = requestedThreadId;
    } else {
      const saved = getLastThreadForTalk(talkId);
      if (saved && threadState.threads.some((thread) => thread.id === saved)) {
        validThreadId = saved;
      } else {
        validThreadId = threadState.threads[0]?.id || null;
      }
    }
    if (!validThreadId) return;
    if (requestedThreadId !== validThreadId) {
      navigate(buildThreadHref(talkId, validThreadId, currentTab), {
        replace: true,
      });
    }
    if (activeThreadId !== validThreadId) {
      setActiveThreadId(validThreadId);
    }
    // Persist the (talkId, threadId) pairing here — this is the only
    // place we know threadState has been loaded for the CURRENT talkId,
    // so a sidebar click to another Talk can't race a stale activeThreadId
    // into the wrong key.
    setLastThreadForTalk(talkId, validThreadId);
  }, [
    activeThreadId,
    currentTab,
    navigate,
    requestedThreadId,
    talkId,
    threadState.loading,
    threadState.threads,
  ]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError(null);
  }, [activeThreadId]);

  const updateThreadMetadata = useCallback(
    async (
      threadId: string,
      patch: {
        title?: string;
        pinned?: boolean;
      },
    ) => {
      if (pageKind !== 'ready' || !pageTalkId) {
        throw new Error('Talk not ready.');
      }
      try {
        const updated = await updateTalkThread({
          talkId: pageTalkId,
          threadId,
          ...patch,
        });
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.map((thread) =>
            thread.id === updated.id
              ? {
                  ...thread,
                  title: updated.title,
                  isPinned: updated.isPinned,
                  updatedAt: updated.updatedAt,
                }
              : thread,
          ),
        }));
        return updated;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [onUnauthorized, pageKind, pageTalkId],
  );

  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      await updateThreadMetadata(threadId, { title });
      setEditingThreadId((current) => (current === threadId ? null : current));
    },
    [updateThreadMetadata],
  );

  const handleDeleteThread = useCallback(
    async (thread: TalkThread) => {
      if (pageKind !== 'ready' || !pageTalkId) return;
      const confirmed = window.confirm(
        `Delete "${formatThreadLabel(thread)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteTalkThread({
          talkId: pageTalkId,
          threadId: thread.id,
        });
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(`clawtalk_doc_pane:${thread.id}`);
          } catch {
            // Quota / private mode — ignore.
          }
        }
        clearThreadScroll(pageTalkId, thread.id);
        const remaining = sortThreads(
          threadState.threads.filter((candidate) => candidate.id !== thread.id),
        );
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.filter(
            (candidate) => candidate.id !== thread.id,
          ),
        }));
        setEditingThreadId((current) =>
          current === thread.id ? null : current,
        );
        if (activeThreadId === thread.id) {
          const fallbackThreadId = remaining[0]?.id || null;
          if (fallbackThreadId) {
            navigate(buildThreadHref(talkId, fallbackThreadId, currentTab));
          }
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setThreadState((current) => ({
          ...current,
          error:
            err instanceof Error ? err.message : 'Failed to delete thread.',
        }));
      }
    },
    [
      activeThreadId,
      currentTab,
      navigate,
      onUnauthorized,
      pageKind,
      pageTalkId,
      talkId,
      threadState.threads,
    ],
  );

  const handleRenameActiveThread = useCallback(
    async (title: string) => {
      if (!activeThread) return;
      await handleRenameThread(activeThread.id, title);
    },
    [activeThread, handleRenameThread],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      navigate(buildThreadHref(talkId, threadId, currentTab));
    },
    [currentTab, navigate, talkId],
  );

  const openThreadMenu = useCallback(
    (threadId: string, x: number, y: number) => {
      if (!canEditThreads) return;
      setThreadMenu({ threadId, x, y });
    },
    [canEditThreads],
  );

  const handleThreadSecondaryClick = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleThreadContextMenu = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleCreateThread = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalkId) return;
    try {
      const nextThread = await createTalkThread({ talkId: pageTalkId });
      setThreadState((current) => ({
        ...current,
        threads: sortThreads([nextThread, ...current.threads]),
      }));
      pendingComposerFocusRef.current = true;
      navigate(buildThreadHref(talkId, nextThread.id, currentTab));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        error: err instanceof Error ? err.message : 'Failed to create thread.',
      }));
    }
  }, [
    currentTab,
    navigate,
    onUnauthorized,
    pageKind,
    pageTalkId,
    pendingComposerFocusRef,
    talkId,
  ]);

  const handleSearch = useCallback(async () => {
    const query = searchQueryRef.current.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await searchTalkMessages({ talkId, query });
      setSearchResults(results);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSearchError(
        err instanceof Error ? err.message : 'Failed to search talk messages.',
      );
    } finally {
      setSearchLoading(false);
    }
  }, [onUnauthorized, talkId]);

  const handleSearchResultSelect = useCallback(
    (result: TalkMessageSearchResult) => {
      setSearchResults([]);
      navigate(buildThreadHref(talkId, result.threadId));
    },
    [navigate, talkId],
  );

  const closeThreadMenu = useCallback(() => {
    setThreadMenu(null);
  }, []);

  const handleRenameMenuThread = useCallback((thread: TalkThread) => {
    setEditingThreadId(thread.id);
  }, []);

  const handleToggleMenuThreadPin = useCallback(
    (thread: TalkThread) => {
      void updateThreadMetadata(thread.id, {
        pinned: !thread.isPinned,
      }).catch((err) => {
        setThreadState((current) => ({
          ...current,
          error:
            err instanceof Error ? err.message : 'Failed to update thread.',
        }));
      });
    },
    [updateThreadMetadata],
  );

  const handleDeleteMenuThread = useCallback(
    (thread: TalkThread) => {
      void handleDeleteThread(thread);
    },
    [handleDeleteThread],
  );

  return {
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
    handleDeleteThread,
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
  };
}
