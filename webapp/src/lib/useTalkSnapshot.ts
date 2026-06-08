// useTalkSnapshot — TanStack Query hook fronting GET
// /api/v1/talks/:talkId/snapshot. The greenfield model has one
// conversation per Talk, so the stable cache identity is just
// ['talk-snapshot', userId, talkId].

import { useQuery } from '@tanstack/react-query';

import { getTalkSnapshot, TalkSnapshot, UnauthorizedError } from './api';

export type TalkSnapshotQueryKey = readonly ['talk-snapshot', string, string];

export function clearActiveThreadMemory(): void {
  // Kept as a no-op export for tests that reset global talk cache helpers.
}

export function snapshotQueryKey(
  userId: string,
  talkId: string,
): TalkSnapshotQueryKey {
  return ['talk-snapshot', userId, talkId] as const;
}

type UseTalkSnapshotInput = {
  userId: string | null;
  talkId: string;
  onUnauthorized?: () => void;
};

export function useTalkSnapshot(input: UseTalkSnapshotInput) {
  const { userId, talkId, onUnauthorized } = input;

  const enabled = Boolean(userId && talkId);
  const queryKey = snapshotQueryKey(userId ?? '', talkId);

  const query = useQuery<TalkSnapshot, Error>({
    queryKey: queryKey as readonly unknown[],
    enabled,
    queryFn: async () => {
      try {
        return await getTalkSnapshot({ talkId });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
        }
        throw err;
      }
    },
  });

  return query;
}
