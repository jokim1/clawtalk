import { useCallback, useEffect, useState, type MutableRefObject } from 'react';

import {
  ApiError,
  deleteTalkMessages,
  UnauthorizedError,
  type Talk,
  type TalkMessage,
} from '../lib/api';

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type HistoryEditState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string };

type UseTalkHistoryControllerInput = {
  talkId: string;
  pageKind: PageKind;
  pageTalk: Talk | null;
  activeThreadId: string | null;
  hasActiveRound: boolean;
  pageMessages: TalkMessage[];
  threadCacheEpochRef: MutableRefObject<number>;
  rememberDeletedMessageIds: (messageIds: string[]) => void;
  resyncTalkState: (options?: { refreshThreads?: boolean }) => Promise<void>;
  onUnauthorized: () => void;
};

export function useTalkHistoryController({
  talkId,
  pageKind,
  pageTalk,
  activeThreadId,
  hasActiveRound,
  pageMessages,
  threadCacheEpochRef,
  rememberDeletedMessageIds,
  resyncTalkState,
  onUnauthorized,
}: UseTalkHistoryControllerInput) {
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false);
  const [historyEditState, setHistoryEditState] = useState<HistoryEditState>({
    status: 'idle',
  });

  useEffect(() => {
    setHistoryEditorOpen(false);
    setHistoryEditState({ status: 'idle' });
  }, [talkId]);

  const openHistoryEditor = useCallback(() => {
    if (pageKind !== 'ready') return;
    if (hasActiveRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current round to finish or cancel it before editing history.',
      });
      return;
    }
    if (!pageMessages.some((message) => message.role !== 'system')) {
      setHistoryEditState({
        status: 'error',
        message: 'There are no editable messages in this Talk yet.',
      });
      return;
    }
    setHistoryEditState({ status: 'idle' });
    setHistoryEditorOpen(true);
  }, [hasActiveRound, pageKind, pageMessages]);

  const handleCloseHistoryEditor = useCallback(() => {
    if (historyEditState.status === 'saving') return;
    setHistoryEditorOpen(false);
    setHistoryEditState((current) =>
      current.status === 'success' ? current : { status: 'idle' },
    );
  }, [historyEditState.status]);

  const handleDeleteHistoryMessages = useCallback(
    async (messageIds: string[]) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      const threadId = activeThreadId;
      if (!threadId) return;
      if (messageIds.length === 0) {
        setHistoryEditState({
          status: 'error',
          message: 'Select at least one message to delete.',
        });
        return;
      }
      const confirmed = window.confirm(
        `Delete ${messageIds.length} selected message${
          messageIds.length === 1 ? '' : 's'
        } from this Talk history?`,
      );
      if (!confirmed) return;

      setHistoryEditState({ status: 'saving' });
      try {
        const result = await deleteTalkMessages({
          talkId: pageTalk.id,
          messageIds,
        });
        threadCacheEpochRef.current += 1;
        rememberDeletedMessageIds(result.deletedMessageIds);
        await resyncTalkState({ refreshThreads: true });
        setHistoryEditorOpen(false);
        setHistoryEditState({
          status: 'success',
          message: `Deleted ${result.deletedCount} message${
            result.deletedCount === 1 ? '' : 's'
          } from this Talk history.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'message_not_found') {
          threadCacheEpochRef.current += 1;
          rememberDeletedMessageIds(messageIds);
          void resyncTalkState({ refreshThreads: true });
        }
        setHistoryEditState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Unable to edit Talk history.',
        });
      }
    },
    [
      activeThreadId,
      onUnauthorized,
      pageKind,
      pageTalk,
      rememberDeletedMessageIds,
      resyncTalkState,
      threadCacheEpochRef,
    ],
  );

  return {
    historyEditorOpen,
    historyEditState,
    openHistoryEditor,
    handleCloseHistoryEditor,
    handleDeleteHistoryMessages,
  };
}
