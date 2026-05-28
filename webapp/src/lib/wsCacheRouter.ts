// wsCacheRouter — maps incoming WS events to RQ cache mutations.
//
// Two strategies:
//
// 1. **Surgical `setQueryData`** for events we can patch into the cache
//    exactly (right now: just `message_appended` on the active thread).
//    Cheap and avoids a network round-trip; per-event check vs.
//    snapshot.snapshotVersion drops deltas the snapshot already
//    incorporates so we don't double-append on a fresh load.
//
// 2. **Debounced `invalidateQueries`** for events that need a refetch
//    to reconcile (content updates, edit applies/resolves, thread
//    deletes, tool-toggle changes). Debounce burst-coalesces a flurry
//    of related events into one network round-trip.
//
// On WS reconnect: invalidate ALL snapshot queries. The active one
// refetches now; others lazy-refetch when their consumer mounts. The
// 50ms debounce gives the WS backlog a moment to drain so we don't
// fire an invalidate per replayed event.

import type { QueryClient } from '@tanstack/react-query';

import { MessageAppendedEvent } from './talkStream';
import { getActiveThreadIdForTalk, snapshotQueryKey } from './useTalkSnapshot';
import type { TalkSnapshot, TalkMessage } from './api';

const INVALIDATE_DEBOUNCE_MS = 50;

type TalkSnapshotCacheKey = readonly ['talk-snapshot', string, string, string];

function resolveCacheKey(
  userId: string,
  talkId: string,
  threadId?: string | null,
): TalkSnapshotCacheKey | null {
  const resolved = threadId || getActiveThreadIdForTalk(talkId);
  if (!resolved) return null;
  const key = snapshotQueryKey(userId, talkId, resolved);
  // Hook always returns the canonical thread-keyed shape when the
  // resolved threadId is non-null — narrowing for the type system.
  return key as TalkSnapshotCacheKey;
}

export function applyMessageAppendedDelta(input: {
  queryClient: QueryClient;
  userId: string;
  event: MessageAppendedEvent;
}): void {
  const { queryClient, userId, event } = input;
  const key = resolveCacheKey(userId, event.talkId, event.threadId);
  if (!key) return;

  queryClient.setQueryData<TalkSnapshot | undefined>(key, (prev) => {
    if (!prev) return prev;
    // Drop deltas the snapshot already includes — they would arrive on
    // a fresh page-load while the WS replay buffer is catching up.
    if (
      typeof event.eventId === 'number' &&
      event.eventId <= prev.snapshotVersion
    ) {
      return prev;
    }
    // Drop duplicate IDs — same event arriving twice during a
    // reconnect-replay races.
    if (prev.messages.some((m) => m.id === event.messageId)) {
      return prev;
    }
    if (!event.content || !event.createdAt) return prev;
    const appended: TalkMessage = {
      id: event.messageId,
      threadId: event.threadId || prev.activeThreadId,
      role: event.role,
      content: event.content,
      createdBy: event.createdBy,
      createdAt: event.createdAt,
      runId: event.runId,
      agentId: event.agentId ?? null,
      agentNickname: event.agentNickname ?? null,
      metadata: event.metadata ?? null,
    };
    return {
      ...prev,
      messages: [...prev.messages, appended],
      // Advance the snapshotVersion in lock-step so subsequent deltas
      // with eventId<=this don't get re-appended.
      snapshotVersion:
        typeof event.eventId === 'number' &&
        event.eventId > prev.snapshotVersion
          ? event.eventId
          : prev.snapshotVersion,
    };
  });
}

export function createWsCacheRouter(queryClient: QueryClient): {
  scheduleInvalidate: (input: {
    userId: string;
    talkId: string;
    threadId?: string | null;
  }) => void;
  invalidateAllSnapshots: () => void;
  scheduleInvalidateAllSnapshots: () => void;
} {
  let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingKeys = new Set<string>();
  let pendingTargetsTouched = 0;

  const flush = (): void => {
    invalidateTimer = null;
    const keys = pendingKeys;
    const touched = pendingTargetsTouched;
    pendingKeys = new Set();
    pendingTargetsTouched = 0;

    if (touched === -1) {
      void queryClient.invalidateQueries({ queryKey: ['talk-snapshot'] });
      return;
    }
    for (const serialized of keys) {
      const key = JSON.parse(serialized) as readonly unknown[];
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const ensureTimer = (): void => {
    if (invalidateTimer) return;
    invalidateTimer = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
  };

  return {
    scheduleInvalidate: (input) => {
      const key = resolveCacheKey(input.userId, input.talkId, input.threadId);
      if (!key) {
        pendingKeys.add(JSON.stringify(['talk-snapshot']));
      } else {
        pendingKeys.add(JSON.stringify(key));
      }
      ensureTimer();
    },
    invalidateAllSnapshots: () => {
      void queryClient.invalidateQueries({ queryKey: ['talk-snapshot'] });
    },
    scheduleInvalidateAllSnapshots: () => {
      pendingTargetsTouched = -1;
      ensureTimer();
    },
  };
}

export type WsCacheRouter = ReturnType<typeof createWsCacheRouter>;
