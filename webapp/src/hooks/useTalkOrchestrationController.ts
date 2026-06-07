import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { QueryClient } from '@tanstack/react-query';

import { patchTalkMetadata, UnauthorizedError, type Talk } from '../lib/api';
import { patchTalkInSnapshot } from '../lib/wsCacheRouter';

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';
type TalkOrchestrationMode = Talk['orchestrationMode'];

type UseTalkOrchestrationControllerInput = {
  talkId: string;
  userId: string;
  pageKind: PageKind;
  pageTalk: Talk | null;
  agentCount: number;
  activeThreadIdRef: MutableRefObject<string | null>;
  queryClient: QueryClient;
  onUnauthorized: () => void;
};

export function useTalkOrchestrationController({
  talkId,
  userId,
  pageKind,
  pageTalk,
  agentCount,
  activeThreadIdRef,
  queryClient,
  onUnauthorized,
}: UseTalkOrchestrationControllerInput) {
  const orchestrationMenuRef = useRef<HTMLDivElement | null>(null);
  const [orchestrationState, setOrchestrationState] = useState<{
    status: 'idle' | 'saving' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [orchestrationMenuOpen, setOrchestrationMenuOpen] = useState(false);

  const orchestrationMode: TalkOrchestrationMode =
    pageKind === 'ready' && pageTalk ? pageTalk.orchestrationMode : 'ordered';
  const showOrchestrationSelector = agentCount >= 2;

  useEffect(() => {
    setOrchestrationState({ status: 'idle' });
  }, [talkId]);

  useEffect(() => {
    if (showOrchestrationSelector && orchestrationState.status !== 'saving') {
      return;
    }
    setOrchestrationMenuOpen(false);
  }, [orchestrationState.status, showOrchestrationSelector]);

  useEffect(() => {
    if (!orchestrationMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        orchestrationMenuRef.current &&
        !orchestrationMenuRef.current.contains(event.target as Node)
      ) {
        setOrchestrationMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOrchestrationMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [orchestrationMenuOpen]);

  const handleOrchestrationModeChange = useCallback(
    async (nextMode: TalkOrchestrationMode) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      if (pageTalk.orchestrationMode === nextMode) return;

      setOrchestrationState({ status: 'saving' });
      try {
        const updatedTalk = await patchTalkMetadata({
          talkId: pageTalk.id,
          orchestrationMode: nextMode,
        });
        patchTalkInSnapshot({
          queryClient,
          userId,
          talkId,
          threadId: activeThreadIdRef.current,
          patch: {
            orchestrationMode: updatedTalk.orchestrationMode,
            title: updatedTalk.title,
            version: updatedTalk.version,
            updatedAt: updatedTalk.updatedAt,
          },
        });
        setOrchestrationState({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setOrchestrationState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to update response mode.',
        });
      }
    },
    [
      activeThreadIdRef,
      onUnauthorized,
      pageKind,
      pageTalk,
      queryClient,
      talkId,
      userId,
    ],
  );

  return {
    orchestrationMenuRef,
    orchestrationMenuOpen,
    setOrchestrationMenuOpen,
    orchestrationMode,
    orchestrationState,
    showOrchestrationSelector,
    handleOrchestrationModeChange,
  };
}
