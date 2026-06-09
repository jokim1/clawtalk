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
  type TalkConversation,
} from '../lib/api';
import { formatConversationLabel } from '../lib/conversationLabels';
import {
  buildTalkDetailHref,
  type TalkDetailTabKey,
} from './useTalkDetailTabs';

export type ConversationListState = {
  conversations: TalkConversation[];
  loading: boolean;
  error: string | null;
};

type UseTalkConversationControllerInput = {
  talkId: string;
  currentTab: TalkDetailTabKey;
  canEditConversations: boolean;
  navigate: NavigateFunction;
  pendingComposerFocusRef: MutableRefObject<boolean>;
  onUnauthorized: () => void;
};

export function sortConversations(
  conversations: TalkConversation[],
): TalkConversation[] {
  return [...conversations].sort((left, right) => {
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

export function useTalkConversationController({
  talkId,
  currentTab,
  canEditConversations,
  navigate,
  pendingComposerFocusRef,
  onUnauthorized,
}: UseTalkConversationControllerInput) {
  const [conversationState, setConversationState] =
    useState<ConversationListState>({
      conversations: [],
      loading: true,
      error: null,
    });
  const [editingConversationId, setEditingConversationId] = useState<
    string | null
  >(null);
  const [conversationMenu, setConversationMenu] = useState<{
    conversationId: string;
    x: number;
    y: number;
  } | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TalkMessageSearchResult[]>(
    [],
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searchQueryRef = useRef(searchQuery);
  const conversationStateTalkIdRef = useRef<string | null>(null);

  searchQueryRef.current = searchQuery;

  const sortedConversations = useMemo(
    () => sortConversations(conversationState.conversations),
    [conversationState.conversations],
  );
  const activeConversation = useMemo(
    () =>
      sortedConversations.find(
        (thread) => thread.id === activeConversationId,
      ) || null,
    [activeConversationId, sortedConversations],
  );
  const menuConversation = useMemo(
    () =>
      conversationMenu
        ? conversationState.conversations.find(
            (thread) => thread.id === conversationMenu.conversationId,
          ) || null
        : null,
    [conversationMenu, conversationState.conversations],
  );

  const resetTalkConversations = useCallback(() => {
    conversationStateTalkIdRef.current = null;
    setConversationState({ conversations: [], loading: true, error: null });
    setEditingConversationId(null);
    setConversationMenu(null);
    setActiveConversationId(null);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    setSearchError(null);
  }, []);

  const hydrateTalkConversations = useCallback(
    (conversations: Array<TalkConversation & { isInternal?: boolean }>) => {
      const sorted = sortConversations(
        conversations.filter((conversation) => !conversation.isInternal),
      );
      setConversationState({
        conversations: sorted,
        loading: false,
        error: null,
      });
      conversationStateTalkIdRef.current = talkId;
    },
    [talkId],
  );

  useEffect(() => {
    if (conversationState.loading) return;
    // Bail when conversationState was loaded for a different talkId — happens
    // mid-commit during cross-talk sidebar navigation, where this effect
    // fires before the bootstrap effect's state resets propagate.
    // Without this gate we'd save Talk A's conversations[0] under Talk B's key.
    if (conversationStateTalkIdRef.current !== talkId) return;
    if (conversationState.conversations.length === 0) {
      setActiveConversationId(null);
      return;
    }

    const validConversationId = conversationState.conversations[0]?.id || null;
    if (!validConversationId) return;
    if (activeConversationId !== validConversationId) {
      setActiveConversationId(validConversationId);
    }
  }, [
    activeConversationId,
    talkId,
    conversationState.loading,
    conversationState.conversations,
  ]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError(null);
  }, [activeConversationId]);

  const handleRenameConversation = useCallback(
    async (conversationId: string, _title?: string) => {
      const message =
        'This Talk uses one conversation; rename the Talk instead.';
      setConversationState((current) => ({
        ...current,
        error: message,
      }));
      setEditingConversationId((current) =>
        current === conversationId ? null : current,
      );
      throw new Error(message);
    },
    [],
  );

  const handleDeleteConversation = useCallback(
    async (thread: TalkConversation) => {
      setConversationState((current) => ({
        ...current,
        error: `"${formatConversationLabel(thread)}" is the Talk conversation and cannot be deleted separately.`,
      }));
    },
    [],
  );

  const handleRenameActiveConversation = useCallback(
    async (title: string) => {
      void title;
      if (!activeConversation) return;
      await handleRenameConversation(activeConversation.id, title);
    },
    [activeConversation, handleRenameConversation],
  );

  const handleSelectConversation = useCallback(
    (_conversationId: string) => {
      navigate(buildTalkDetailHref(talkId, currentTab));
    },
    [currentTab, navigate, talkId],
  );

  const openConversationMenu = useCallback(
    (conversationId: string, x: number, y: number) => {
      if (!canEditConversations) return;
      setConversationMenu({ conversationId, x, y });
    },
    [canEditConversations],
  );

  const handleConversationSecondaryClick = useCallback(
    (conversationId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      openConversationMenu(conversationId, event.clientX, event.clientY);
    },
    [openConversationMenu],
  );

  const handleConversationContextMenu = useCallback(
    (conversationId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      openConversationMenu(conversationId, event.clientX, event.clientY);
    },
    [openConversationMenu],
  );

  const handleCreateConversation = useCallback(async () => {
    pendingComposerFocusRef.current = true;
    setConversationState((current) => ({
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

  const closeConversationMenu = useCallback(() => {
    setConversationMenu(null);
  }, []);

  const handleRenameMenuConversation = useCallback(
    (thread: TalkConversation) => {
      setEditingConversationId(thread.id);
    },
    [],
  );

  const handleToggleMenuConversationPin = useCallback(
    (thread: TalkConversation) => {
      setConversationState((current) => ({
        ...current,
        error: `"${formatConversationLabel(thread)}" is always pinned as the Talk conversation.`,
      }));
    },
    [],
  );

  const handleDeleteMenuConversation = useCallback(
    (thread: TalkConversation) => {
      void handleDeleteConversation(thread);
    },
    [handleDeleteConversation],
  );

  return {
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
    handleDeleteConversation,
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
  };
}
