import { useCallback, useMemo, useRef } from 'react';

import { ApiError, type Talk, type TalkSnapshot } from '../lib/api';
import { useTalkSnapshot } from '../lib/useTalkSnapshot';

type TalkSnapshotPageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type UseTalkSnapshotPageStateInput = {
  userId: string;
  talkId: string;
  onUnauthorized: () => void;
};

// Stable conversion from the snapshot's wire shape to the webapp's Talk
// type (defaults `title` to '' and `agents` to []) so render-site reads
// against `snapshot.talk` get the same shape the old reducer mirrored.
function snapshotTalkToTalk(snapshotTalk: TalkSnapshot['talk']): Talk {
  return {
    id: snapshotTalk.id,
    ownerId: snapshotTalk.ownerId,
    title: snapshotTalk.title ?? '',
    orchestrationMode: snapshotTalk.orchestrationMode,
    agents: [],
    status: snapshotTalk.status,
    folderId: snapshotTalk.folderId,
    sortOrder: snapshotTalk.sortOrder,
    version: snapshotTalk.version,
    createdAt: snapshotTalk.createdAt,
    updatedAt: snapshotTalk.updatedAt,
    accessRole: snapshotTalk.accessRole,
  };
}

export function useTalkSnapshotPageState({
  userId,
  talkId,
  onUnauthorized,
}: UseTalkSnapshotPageStateInput) {
  const snapshotQuery = useTalkSnapshot({
    userId,
    talkId,
    onUnauthorized,
  });

  // Derived snapshot accessors — PR C: server data lives in React
  // Query. Render-site reads pull from these instead of the reducer.
  //
  // Once the page has rendered with snapshot data, we stay 'ready' even
  // during background refetches and thread-switch rekeys (which drop
  // snapshotQuery.data back to undefined). Flipping pageKind back to
  // 'loading' would unmount the ready-branch tree — replacing the
  // thread rail / composer DOM nodes — which breaks any handler that
  // captured a DOM reference (e.g. handleDeleteThread holding a
  // threadRail node) and causes a visible page-level loading flash.
  const lastSnapshotRef = useRef<TalkSnapshot | null>(null);
  // Only fall back to the last-good snapshot when it belongs to the
  // currently-routed talk. Cross-talk navigation drops the fallback
  // immediately so the previous talk's messages/title can't render
  // against the new talkId — and so handlers reading pageTalk.id can't
  // mutate the previous Talk before the new snapshot resolves.
  if (snapshotQuery.data) {
    lastSnapshotRef.current = snapshotQuery.data;
  } else if (
    lastSnapshotRef.current &&
    lastSnapshotRef.current.talk.id !== talkId
  ) {
    lastSnapshotRef.current = null;
  }

  const resetSnapshotFallback = useCallback(() => {
    lastSnapshotRef.current = null;
  }, []);

  const talkSnapshot = snapshotQuery.data ?? lastSnapshotRef.current;
  const snapshotError = snapshotQuery.error;
  const snapshotIs404 =
    snapshotError instanceof ApiError && snapshotError.status === 404;
  const pageKind: TalkSnapshotPageKind = snapshotIs404
    ? 'unavailable'
    : snapshotError
      ? 'error'
      : !talkSnapshot
        ? 'loading'
        : 'ready';
  const pageErrorMessage: string | null = snapshotIs404
    ? 'Talk not found'
    : snapshotError instanceof Error
      ? snapshotError.message
      : null;
  const pageTalk: Talk | null = useMemo(
    () => (talkSnapshot ? snapshotTalkToTalk(talkSnapshot.talk) : null),
    [talkSnapshot?.talk],
  );
  const activeTalkWorkspaceId = talkSnapshot?.talk.workspaceId ?? null;
  const accessRole = pageKind === 'ready' ? pageTalk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditJobs = canEditAgents;
  const canEditDoc = canEditAgents;
  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';

  return {
    snapshotQuery,
    talkSnapshot,
    pageKind,
    pageErrorMessage,
    pageTalk,
    activeTalkWorkspaceId,
    accessRole,
    canEditAgents,
    canEditJobs,
    canEditDoc,
    canManageTalkConnectors,
    resetSnapshotFallback,
  };
}
