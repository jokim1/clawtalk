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
  searchTalkMessages,
  UnauthorizedError,
  type TalkMessageSearchResult,
  type TalkThread,
} from '../lib/api';
import { formatThreadLabel } from '../lib/threadTitles';
import {
  buildTalkDetailHref,
  type TalkDetailTabKey,
} from './useTalkDetailTabs';

export type ThreadListState = {
  threads: TalkThread[];
  loading: boolean;
  error: string | null;
};

type UseTalkThreadControllerInput = {
  talkId: string;
  currentTab: TalkDetailTabKey;
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
  currentTab,
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

  const searchQueryRef = useRef(searchQuery);
  const threadStateTalkIdRef = useRef<string | null>(null);

  searchQueryRef.current = searchQuery;

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

    const validThreadId = threadState.threads[0]?.id || null;
    if (!validThreadId) return;
    if (activeThreadId !== validThreadId) {
      setActiveThreadId(validThreadId);
    }
  }, [activeThreadId, talkId, threadState.loading, threadState.threads]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError(null);
  }, [activeThreadId]);

  const handleRenameThread = useCallback(
    async (threadId: string, _title?: string) => {
      const message =
        'This Talk uses one conversation; rename the Talk instead.';
      setThreadState((current) => ({
        ...current,
        error: message,
      }));
      setEditingThreadId((current) => (current === threadId ? null : current));
      throw new Error(message);
    },
    [],
  );

  const handleDeleteThread = useCallback(async (thread: TalkThread) => {
    setThreadState((current) => ({
      ...current,
      error: `"${formatThreadLabel(thread)}" is the Talk conversation and cannot be deleted separately.`,
    }));
  }, []);

  const handleRenameActiveThread = useCallback(
    async (title: string) => {
      void title;
      if (!activeThread) return;
      await handleRenameThread(activeThread.id, title);
    },
    [activeThread, handleRenameThread],
  );

  const handleSelectThread = useCallback(
    (_threadId: string) => {
      navigate(buildTalkDetailHref(talkId, currentTab));
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
    pendingComposerFocusRef.current = true;
    setThreadState((current) => ({
      ...current,
      error:
        'This Talk already has one conversation. Continue in the timeline below.',
    }));
  }, [pendingComposerFocusRef]);

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
      void result;
      setSearchResults([]);
      navigate(buildTalkDetailHref(talkId));
    },
    [navigate, talkId],
  );

  const closeThreadMenu = useCallback(() => {
    setThreadMenu(null);
  }, []);

  const handleRenameMenuThread = useCallback((thread: TalkThread) => {
    setEditingThreadId(thread.id);
  }, []);

  const handleToggleMenuThreadPin = useCallback((thread: TalkThread) => {
    setThreadState((current) => ({
      ...current,
      error: `"${formatThreadLabel(thread)}" is always pinned as the Talk conversation.`,
    }));
  }, []);

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
