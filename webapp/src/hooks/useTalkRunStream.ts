import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { openTalkStream } from '../lib/talkStream';
import type {
  MessageAppendedEvent,
  TalkBrowserBlockedEvent,
  TalkBrowserUnblockedEvent,
  TalkContentEditAppliedEvent,
  TalkContentEditResolvedEvent,
  TalkContentEditRunAbortedEvent,
  TalkContentEditRunStartedEvent,
  TalkContentUpdatedEvent,
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
} from '../lib/talkStream';
import { applyMessageAppendedDelta } from '../lib/wsCacheRouter';
import type { WsCacheRouter } from '../lib/wsCacheRouter';
import type { DetailAction } from '../lib/talkRunReducer';
import type { Content, ContentEditSummary } from '../lib/api';
import type { DocPaneMode } from '../components/DocPaneHeader';
import type { RichTextEditorSaveStatus } from '../components/rich-text/RichTextEditor';

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
  ensureKnownThread: (threadId?: string | null) => boolean;
  bumpThreadSummaryFromMessage: (threadId: string, createdAt: string) => void;
  isNearBottom: () => boolean;
  rememberDeletedMessageIds: (messageIds: string[]) => void;
  scheduleThreadListRefresh: () => void;
  resyncTalkState: (options?: { refreshThreads?: boolean }) => Promise<void>;
  refetchTalkContent: () => Promise<Content | null>;
  // Page-owned refs the stream handlers read/write (stable; not deps).
  deletedMessageIdsRef: MutableRefObject<Set<string>>;
  persistedRunMessageIdsRef: MutableRefObject<Set<string>>;
  pendingMessageRefetchTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  activeThreadIdRef: MutableRefObject<string | null>;
  autoStickToBottomRef: MutableRefObject<ScrollBehavior | null>;
  talkContentRef: MutableRefObject<Content | null>;
  talkContentSaveStatusRef: MutableRefObject<RichTextEditorSaveStatus>;
  pendingEditStreamingStartedAtRef: MutableRefObject<Map<string, number>>;
  htmlAutoFlippedRef: MutableRefObject<Set<string>>;
  wsCacheRouterRef: MutableRefObject<WsCacheRouter>;
  // Page-owned state setters (stable; not deps).
  setTalkContentConflict: Dispatch<SetStateAction<boolean>>;
  setPendingEditStreamingByRunId: Dispatch<
    SetStateAction<Map<string, string | null>>
  >;
  setHtmlMode: Dispatch<SetStateAction<DocPaneMode>>;
  setTalkContentPendingEdits: Dispatch<SetStateAction<ContentEditSummary[]>>;
  setToolsRefreshKey: Dispatch<SetStateAction<number>>;
};

export function useTalkRunStream({
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
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (!event.content || !event.createdAt) {
          if (event.threadId && event.threadId === activeThreadIdRef.current) {
            void resyncTalkState({ refreshThreads: true });
          } else {
            scheduleThreadListRefresh();
          }
          return;
        }
        if (event.threadId) {
          bumpThreadSummaryFromMessage(event.threadId, event.createdAt);
        }
        if (!event.threadId || event.threadId !== activeThreadIdRef.current) {
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
            threadId: event.threadId || activeThreadIdRef.current || '',
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
        ensureKnownThread(event.threadId);
        dispatch({
          type: event.status === 'queued' ? 'RUN_QUEUED' : 'RUN_STARTED',
          runId: event.runId,
          threadId: event.threadId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunQueued: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        dispatch({
          type: 'RUN_QUEUED',
          runId: event.runId,
          threadId: event.threadId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onResponseStarted: (event: TalkResponseStartedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        // If the user is parked at the bottom (typical right after a
        // send), stay stuck so the "Thinking…" placeholder is visible
        // when the agent starts streaming. Mirrors onResponseDelta.
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = 'auto';
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onProgressUpdate: (event: TalkProgressUpdateEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_PROGRESS', event });
      },
      onResponseDelta: (event: TalkResponseDeltaEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = 'auto';
        dispatch({ type: 'RESPONSE_DELTA', event });
      },
      onResponseUsage: (_event: TalkResponseUsageEvent) => {
        // Reserved for later usage surfacing.
      },
      onResponseCompleted: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_COMPLETED', event });
      },
      onResponseFailed: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onResponseCancelled: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_CANCELLED', event });
      },
      onRunCompleted: (event: TalkRunCompletedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        // If MESSAGE_APPENDED never arrives for this run, the timeline
        // shows nothing for the response (RUN_COMPLETED deletes the
        // liveResponse buffer). Schedule a refetch fallback that fires
        // after a short grace window if the persisted message hasn't
        // landed yet. Scoped to the user's active thread — refetching
        // is a no-op otherwise, and the message arrives via
        // THREAD_MESSAGES_LOADING when they navigate back.
        if (
          event.threadId === activeThreadIdRef.current &&
          !persistedRunMessageIdsRef.current.has(event.runId)
        ) {
          const existingTimer = pendingMessageRefetchTimersRef.current.get(
            event.runId,
          );
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            pendingMessageRefetchTimersRef.current.delete(event.runId);
            if (persistedRunMessageIdsRef.current.has(event.runId)) return;
            void resyncTalkState({ refreshThreads: false });
          }, MISSING_PERSISTED_MESSAGE_REFETCH_MS);
          pendingMessageRefetchTimersRef.current.set(event.runId, timer);
        }
        dispatch({
          type: 'RUN_COMPLETED',
          runId: event.runId,
          threadId: event.threadId,
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
        ensureKnownThread(event.threadId);
        dispatch({
          type: 'RUN_FAILED',
          runId: event.runId,
          threadId: event.threadId,
          showInlineFailure: event.threadId === activeThreadIdRef.current,
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
        if (event.threadIds?.includes(activeThreadIdRef.current || '')) {
          rememberDeletedMessageIds(event.deletedMessageIds || []);
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onBrowserBlocked: (event: TalkBrowserBlockedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (event.threadId && event.threadId === activeThreadIdRef.current) {
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onBrowserUnblocked: (event: TalkBrowserUnblockedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (event.threadId && event.threadId === activeThreadIdRef.current) {
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onContentUpdated: (event: TalkContentUpdatedEvent) => {
        // Mark the snapshot stale across consumers; tab-local refetch
        // still happens inline so the editor reconciles right away.
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // The DO scopes events to the current talk-room subscription, so
        // the contentId here always belongs to this Talk. Bail when the
        // user hasn't loaded the doc yet — no local version to compare.
        const current = talkContentRef.current;
        if (!current || current.id !== event.contentId) return;
        if (event.version <= current.bodyVersion) return;
        const status = talkContentSaveStatusRef.current;
        const hasUnsavedEdits =
          status === 'pending' || status === 'saving' || status === 'error';
        if (hasUnsavedEdits) {
          setTalkContentConflict(true);
          return;
        }
        void refetchTalkContent();
      },
      onContentEditRunStarted: (event: TalkContentEditRunStartedEvent) => {
        // No guard on talkContentRef — these events fire during the
        // tx that just created the row, so the local content state may
        // not have hydrated yet (sidebar-driven load races the
        // WebSocket arrival). Banner state is keyed on contentId so a
        // mismatched/stale ref doesn't corrupt anything; refetch fills
        // in the rest.
        setPendingEditStreamingByRunId((prev) => {
          if (prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.set(event.runId, event.agentNickname ?? null);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.set(event.runId, Date.now());
        void refetchTalkContent();
      },
      onContentEditRunAborted: (event: TalkContentEditRunAbortedEvent) => {
        setPendingEditStreamingByRunId((prev) => {
          if (!prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.delete(event.runId);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.delete(event.runId);
      },
      onContentEditApplied: (event: TalkContentEditAppliedEvent) => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // Always refetch — the apply just created a pending row that
        // the UI must surface. The prior `current.id !== event.contentId`
        // guard caused a missed-update bug when the WebSocket event
        // arrived before talkContent had hydrated.
        setPendingEditStreamingByRunId((prev) => {
          if (!prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.delete(event.runId);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.delete(event.runId);
        // First AI edit on an empty HTML doc auto-flips Source ➜
        // Preview so the user immediately sees the rendered result.
        // Sticky: each doc id only flips once per page mount.
        const cur = talkContentRef.current;
        if (
          cur &&
          cur.id === event.contentId &&
          cur.contentFormat === 'html' &&
          (cur.bodyHtml ?? '').length === 0 &&
          !htmlAutoFlippedRef.current.has(cur.id)
        ) {
          htmlAutoFlippedRef.current.add(cur.id);
          setHtmlMode('preview');
        }
        void refetchTalkContent();
      },
      onContentEditResolved: (event: TalkContentEditResolvedEvent) => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        setTalkContentPendingEdits((prev) =>
          prev.filter((edit) => !event.editIds.includes(edit.id)),
        );
        // Refetch in all cases so the banner / body reconcile against
        // the server-authoritative snapshot — including rejected runs
        // (the row went away, the cached state should reflect it).
        void refetchTalkContent();
      },
      onTalkToolsChanged: () => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // Cross-tab sync: another tab toggled a tool chip. Bumping
        // refreshKey causes ToolChipsBar to refetch and reflect the
        // post-toggle active set. The event filter at
        // src/clawtalk/talks/event-filters.ts allowlists this event
        // for thread-scoped subscriptions (T7).
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
        await resyncTalkState({ refreshThreads: true });
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
    bumpThreadSummaryFromMessage,
    ensureKnownThread,
    handleUnauthorized,
    isNearBottom,
    queryClient,
    refetchTalkContent,
    rememberDeletedMessageIds,
    resyncTalkState,
    scheduleThreadListRefresh,
    pageKind,
    talkId,
    userId,
  ]);
}
