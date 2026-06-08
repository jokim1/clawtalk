import { useCallback, useRef, useState } from 'react';

import type { RunContextPanelState } from '../components/TalkRunsPanel';
import { getTalkRunContext, UnauthorizedError } from '../lib/api';

type UseTalkRunContextControllerInput = {
  talkId: string;
  onUnauthorized: () => void;
};

export function useTalkRunContextController({
  talkId,
  onUnauthorized,
}: UseTalkRunContextControllerInput) {
  const [runContextPanels, setRunContextPanels] = useState<
    Record<string, RunContextPanelState>
  >({});
  const runContextPanelsRef = useRef<Record<string, RunContextPanelState>>({});

  runContextPanelsRef.current = runContextPanels;

  const resetRunContextPanels = useCallback(() => {
    setRunContextPanels({});
  }, []);

  const handleToggleRunContext = useCallback(
    async (runId: string) => {
      const current = runContextPanelsRef.current[runId];
      if (current?.open) {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              context: null,
            }),
            open: false,
          },
        }));
        return;
      }

      if (current?.status === 'loaded') {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              context: null,
            }),
            open: true,
          },
        }));
        return;
      }

      setRunContextPanels((existing) => ({
        ...existing,
        [runId]: {
          open: true,
          status: 'loading',
          context: existing[runId]?.context ?? null,
        },
      }));

      try {
        const context = await getTalkRunContext({ talkId, runId });
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'loaded',
            context,
          },
        }));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'error',
            context: null,
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load run context.',
          },
        }));
      }
    },
    [onUnauthorized, talkId],
  );

  return {
    runContextPanels,
    resetRunContextPanels,
    handleToggleRunContext,
  };
}
