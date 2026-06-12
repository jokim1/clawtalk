import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { openTalkStream } from '../lib/talkStream';
import type {
  MessageAppendedEvent,
  TalkBrowserBlockedEvent,
  TalkBrowserUnblockedEvent,
  TalkHistoryEditedEvent,
  TalkProgressUpdateEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkResponseTerminalEvent,
  TalkResponseUsageEvent,
  TalkRunCancelledEvent,
  TalkRunCompletedEvent,
  TalkRunFailedEvent,
  TalkRunRetryingEvent,
  TalkRunStartedEvent,
  TalkToolResultEvent,
} from '../lib/talkStream';
import { applyMessageAppendedDelta } from '../lib/wsCacheRouter';
import type { WsCacheRouter } from '../lib/wsCacheRouter';
import type { DetailAction } from '../lib/talkRunReducer';

// Grace window before refetching when MESSAGE_APPENDED never lands after
// RUN_COMPLETED (moved verbatim from TalkDetailPage with the effect).
const MISSING_PERSISTED_MESSAGE_REFETCH_MS = 3_000;

/**
 * Streaming driver for a Talk's live run timeline.
 *
 * Encapsulates the long-lived `openTalkStream` subscription effect that
 * translates server WebSocket events into reducer dispatches. This is a
 * BEHAVIOR-PRESERVING relocation of the effect that lived inline in
 * `TalkDetailPage`: the effect body and its dependency array are unchanged.
 *
 * `useReducer` intentionally stays on the page rather than moving in here:
 * `resyncTalkState` (a closure dep of this effect) itself calls `dispatch`,
 * so a hook that both produced `dispatch` and consumed `resyncTalkState`
 * would be a temporal-dead-zone cycle at the call site. The page owns the
 * reducer and threads `dispatch` + the effect's closure deps in as params.
 *
 * Refs and state setters are stable by construction (the page creates them
 * via `useRef`/`useState`), so they are deliberately omitted from the
 * dependency array — exactly as in the original inline effect.
 */
export type UseTalkRunStreamParams = {
  dispatch: Dispatch<DetailAction>;
  talkId: string;
  userId: string;
  pageKind: 'loading' | 'ready' | 'unavailable' | 'error';
  queryClient: QueryClient;
  // Page callbacks the stream handlers invoke (in the effect dep array).
  handleUnauthorized: () => void;
  isNearBottom: () => boolean;
  rememberDeletedMessageIds: (messageIds: string[]) => void;
  resyncTalkState: () => Promise<void>;
  // Bump the native doc pane's reload signal when an agent content-edit
  // stream event lands, so `TalkDocumentView` refetches the native document.
  bumpDocReload: () => void;
  // Page-owned refs the stream handlers read/write (stable; not deps).
  deletedMessageIdsRef: MutableRefObject<Set<string>>;
  persistedRunMessageIdsRef: MutableRefObject<Set<string>>;
  pendingMessageRefetchTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  autoStickToBottomRef: MutableRefObject<ScrollBehavior | null>;
  wsCacheRouterRef: MutableRefObject<WsCacheRouter>;
  // Page-owned state setters (stable; not deps).
  setToolsRefreshKey: Dispatch<SetStateAction<number>>;
};

export function useTalkRunStream({
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
}: UseTalkRunStreamParams): void {
  useEffect(() => {
    if (pageKind !== 'ready') return;
    const stream = openTalkStream({
      talkId,
      onUnauthorized: handleUnauthorized,
      onMessageAppended: (event: MessageAppendedEvent) => {
        if (event.talkId !== talkId) return;
        if (deletedMessageIdsRef.current.has(event.messageId)) return;
        if (event.runId) {
          persistedRunMessageIdsRef.current.add(event.runId);
          const pendingTimer = pendingMessageRefetchTimersRef.current.get(
            event.runId,
          );
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingMessageRefetchTimersRef.current.delete(event.runId);
          }
        }
        // Surgical RQ cache patch — keeps the persisted IDB snapshot
        // exact across reloads even when no React consumer is mounted.
        applyMessageAppendedDelta({ queryClient, userId, event });
        if (!event.content || !event.createdAt) {
          void resyncTalkState();
          return;
        }
        const nearBottom = isNearBottom();
        if (nearBottom) {
          autoStickToBottomRef.current = 'auto';
        }
        dispatch({
          type: 'MESSAGE_LANDED',
          wasNearBottom: nearBottom,
          message: {
            id: event.messageId,
            role: event.role,
            content: event.content,
            createdBy: event.createdBy,
            createdAt: event.createdAt,
            runId: event.runId,
            agentId: event.agentId,
            agentNickname: event.agentNickname,
            metadata: event.metadata,
          },
        });
      },
      onRunStarted: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: event.status === 'queued' ? 'RUN_QUEUED' : 'RUN_STARTED',
          runId: event.runId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunQueued: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: 'RUN_QUEUED',
          runId: event.runId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onResponseStarted: (event: TalkResponseStartedEvent) => {
        if (event.talkId !== talkId) return;
        // If the user is parked at the bottom (typical right after a
        // send), stay stuck so the "Thinking…" placeholder is visible
        // when the agent starts streaming. Mirrors onResponseDelta.
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = 'auto';
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onProgressUpdate: (event: TalkProgressUpdateEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_PROGRESS', event });
      },
      onToolResult: (event: TalkToolResultEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'TOOL_RESULT', event });
      },
      onResponseDelta: (event: TalkResponseDeltaEvent) => {
        if (event.talkId !== talkId) return;
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = 'auto';
        dispatch({ type: 'RESPONSE_DELTA', event });
      },
      onResponseUsage: (_event: TalkResponseUsageEvent) => {
        // Reserved for later usage surfacing.
      },
      onResponseCompleted: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_COMPLETED', event });
      },
      onResponseFailed: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onResponseCancelled: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_CANCELLED', event });
      },
      onRunCompleted: (event: TalkRunCompletedEvent) => {
        if (event.talkId !== talkId) return;
        // If MESSAGE_APPENDED never arrives for this run, the timeline
        // shows nothing for the response (RUN_COMPLETED deletes the
        // liveResponse buffer). Schedule a refetch fallback that fires
        // after a short grace window if the persisted message hasn't
        // landed yet. Scoped to the user's active thread — refetching
        // is a no-op otherwise, and the message arrives via
        // THREAD_MESSAGES_LOADING when they navigate back.
        if (!persistedRunMessageIdsRef.current.has(event.runId)) {
          const existingTimer = pendingMessageRefetchTimersRef.current.get(
            event.runId,
          );
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            pendingMessageRefetchTimersRef.current.delete(event.runId);
            if (persistedRunMessageIdsRef.current.has(event.runId)) return;
            void resyncTalkState();
          }, MISSING_PERSISTED_MESSAGE_REFETCH_MS);
          pendingMessageRefetchTimersRef.current.set(event.runId, timer);
        }
        dispatch({
          type: 'RUN_COMPLETED',
          runId: event.runId,
          triggerMessageId: event.triggerMessageId,
          responseMessageId: event.responseMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunFailed: (event: TalkRunFailedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: 'RUN_FAILED',
          runId: event.runId,
          showInlineFailure: true,
          triggerMessageId: event.triggerMessageId,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunCancelled: (event: TalkRunCancelledEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: 'RUN_CANCELLED_BATCH',
          runIds: event.runIds,
          cancelledBy: event.cancelledBy,
        });
      },
      onHistoryEdited: (event: TalkHistoryEditedEvent) => {
        if (event.talkId !== talkId) return;
        rememberDeletedMessageIds(event.deletedMessageIds || []);
        void resyncTalkState();
      },
      onBrowserBlocked: (event: TalkBrowserBlockedEvent) => {
        if (event.talkId !== talkId) return;
        void resyncTalkState();
      },
      onBrowserUnblocked: (event: TalkBrowserUnblockedEvent) => {
        if (event.talkId !== talkId) return;
        void resyncTalkState();
      },
      onContentUpdated: () => {
        // A document changed (title/blocks). Invalidate the shared cache and
        // signal the native doc pane to reload — it is the version-of-record
        // now and refetches the native document on each bump.
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        bumpDocReload();
      },
      onContentEditRunStarted: () => {
        // An agent began an edit run against this Talk's document; reload so
        // the incoming pending edits surface in the native review list.
        bumpDocReload();
      },
      onContentEditRunAborted: () => {
        bumpDocReload();
      },
      onContentEditApplied: () => {
        // The apply created a pending edit row — invalidate the shared cache
        // and reload the native pane so it appears for review.
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        bumpDocReload();
      },
      onContentEditResolved: () => {
        // An edit/run was accepted or rejected (possibly in another tab);
        // reconcile the native pane against the server-authoritative document.
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        bumpDocReload();
      },
      onTalkToolsChanged: () => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // Cross-tab sync: another tab toggled a tool chip. Bumping
        // refreshKey causes ToolChipsBar to refetch and reflect the
        // post-toggle active set. Talk streams are now scoped at the Talk
        // boundary, so every open tab for this Talk should reconcile chips.
        setToolsRefreshKey((k) => k + 1);
      },
      onTalkRunRetrying: (event: TalkRunRetryingEvent) => {
        // CF Queues redelivered the run message — surface "Retrying
        // N/M" in the LiveResponsePanel pill so the user knows the
        // queue is alive and waiting (vs. the stale "Queued · 2:30"
        // badge that looked dead).
        dispatch({
          type: 'RUN_RETRYING',
          runId: event.runId,
          retryAttempt: event.retryAttempt,
          maxRetries: event.maxRetries,
        });
      },
      onReplayGap: async () => {
        await resyncTalkState();
      },
      onStateChange: (streamState) => {
        switch (streamState) {
          case 'connecting':
            dispatch({ type: 'STREAM_CONNECTING' });
            break;
          case 'live':
            // Coming back online (or first live tick on mount) — mark
            // every cached snapshot stale so any other open Talk pulls
            // the latest the next time it renders, and the active one
            // refetches immediately. Debounced so a reconnect replay
            // backlog collapses to one round-trip.
            wsCacheRouterRef.current.scheduleInvalidateAllSnapshots();
            dispatch({ type: 'STREAM_LIVE' });
            break;
          case 'reconnecting':
            dispatch({ type: 'STREAM_RECONNECTING' });
            break;
          case 'offline':
            dispatch({ type: 'STREAM_OFFLINE' });
            break;
          default:
            break;
        }
      },
    });

    return () => {
      stream.close();
      dispatch({ type: 'STREAM_OFFLINE' });
      for (const timer of pendingMessageRefetchTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingMessageRefetchTimersRef.current.clear();
    };
  }, [
    bumpDocReload,
    handleUnauthorized,
    isNearBottom,
    queryClient,
    rememberDeletedMessageIds,
    resyncTalkState,
    pageKind,
    talkId,
    userId,
  ]);
}
