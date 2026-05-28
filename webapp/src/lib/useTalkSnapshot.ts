// useTalkSnapshot — TanStack Query hook fronting GET
// /api/v1/talks/:talkId/snapshot. The hook does two things the route
// doesn't: it canonicalizes the queryKey on the resolved threadId so
// every consumer renders from the same cache entry, and it maintains a
// `(talkId) -> activeThreadId` map used by [[wsCacheRouter]] to map
// incoming WS deltas to the right queryKey in O(1).
//
// Bootstrap flow (URL has no ?threadId=):
//   1. useQuery keyed by ['talk-snapshot-bootstrap', userId, talkId].
//   2. queryFn fetches without threadId; server resolves to the default
//      thread and returns the canonical activeThreadId.
//   3. queryFn pre-populates the canonical ['talk-snapshot', userId,
//      talkId, activeThreadId] entry via setQueryData so subsequent
//      mounts with the resolved threadId hit a warm cache immediately.
//
// Resolved flow (URL has ?threadId=):
//   useQuery keyed by ['talk-snapshot', userId, talkId, threadId] —
//   stable across re-renders, persisted by the IDB persister.

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getTalkSnapshot, TalkSnapshot, UnauthorizedError } from './api';

export type TalkSnapshotQueryKey =
  | readonly ['talk-snapshot', string, string, string]
  | readonly ['talk-snapshot-bootstrap', string, string];

const talkActiveThreadMap = new Map<string, string>();

export function getActiveThreadIdForTalk(talkId: string): string | null {
  return talkActiveThreadMap.get(talkId) ?? null;
}

export function rememberActiveThreadForTalk(
  talkId: string,
  threadId: string,
): void {
  talkActiveThreadMap.set(talkId, threadId);
}

export function clearActiveThreadMemory(): void {
  talkActiveThreadMap.clear();
}

export function snapshotQueryKey(
  userId: string,
  talkId: string,
  threadId: string,
): TalkSnapshotQueryKey {
  return ['talk-snapshot', userId, talkId, threadId] as const;
}

export function snapshotBootstrapQueryKey(
  userId: string,
  talkId: string,
): TalkSnapshotQueryKey {
  return ['talk-snapshot-bootstrap', userId, talkId] as const;
}

type UseTalkSnapshotInput = {
  userId: string | null;
  talkId: string;
  threadId: string | null;
  onUnauthorized?: () => void;
};

export function useTalkSnapshot(input: UseTalkSnapshotInput) {
  const { userId, talkId, threadId, onUnauthorized } = input;
  const queryClient = useQueryClient();

  const enabled = Boolean(userId && talkId);
  const usingBootstrap = enabled && !threadId;

  const queryKey: TalkSnapshotQueryKey = usingBootstrap
    ? snapshotBootstrapQueryKey(userId ?? '', talkId)
    : snapshotQueryKey(userId ?? '', talkId, threadId ?? '');

  const query = useQuery<TalkSnapshot, Error>({
    queryKey: queryKey as readonly unknown[],
    enabled,
    queryFn: async () => {
      try {
        const snapshot = await getTalkSnapshot({ talkId, threadId });
        if (usingBootstrap && userId) {
          // Hydrate the canonical thread-keyed entry too so the next
          // mount (typically right after navigate({ replace: true })
          // adds ?threadId=) reads from the same point-in-time cache,
          // and avoid burning a duplicate network round-trip.
          queryClient.setQueryData<TalkSnapshot>(
            snapshotQueryKey(userId, talkId, snapshot.activeThreadId),
            snapshot,
          );
        }
        if (userId) {
          rememberActiveThreadForTalk(talkId, snapshot.activeThreadId);
        }
        return snapshot;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
        }
        throw err;
      }
    },
  });

  // Whenever the cached snapshot resolves to a new active thread (or a
  // background refetch reshuffles it), refresh the lookup so the WS
  // delta router can find the canonical queryKey for incoming events
  // without React having to be in the loop.
  useEffect(() => {
    if (query.data?.activeThreadId) {
      rememberActiveThreadForTalk(talkId, query.data.activeThreadId);
    }
  }, [query.data?.activeThreadId, talkId]);

  return query;
}
