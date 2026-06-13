/**
 * Native-document load + edit-review state machine, shared by the standalone
 * `DocumentDetailPage` and the in-Talk documents pane.
 *
 * Reads only the native `documents`/`doc_tabs`/`doc_blocks`/`document_edits`
 * shapes — never a markdown/html body facade. Accept/reject is owner-driven:
 * each action calls the native accept/reject API and the returned
 * `NativeDocument` fully replaces local state, so version bumps and pending-edit
 * removal come straight from the server. We never send `expectedContentVersion`:
 * the server's per-edit base-version check is the CAS, and a single value is
 * ambiguous for accept-all (which spans tabs).
 *
 * Bulk actions (accept-all / reject-all / per-run) send the exact set of edit
 * ids on screen; the server aborts the whole action with a 409 `edit_set_mismatch`
 * if its current pending set differs, so an edit created after load can never be
 * resolved unseen. 409 `version_conflict` / `anchor_missing` /
 * `invalid_pending_edit` and 404 (already resolved elsewhere) all recover via a
 * quiet refetch + a notice.
 *
 * The consuming component is expected to be remounted per `documentId` (App.tsx
 * keys `DocumentDetailPage`; the Talk pane keys its inner view), so one hook
 * instance only ever handles a single document and needs no cross-document guard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  acceptAllDocumentEdits,
  acceptDocumentEdit,
  acceptDocumentEditRun,
  getDocument,
  rejectAllDocumentEdits,
  rejectDocumentEdit,
  rejectDocumentEditRun,
  UnauthorizedError,
  updateDocumentTab,
  type NativeDocument,
  type NativeDocumentEdit,
  type NativeDocumentTab,
} from '../lib/api';
import type { PendingRunGroup } from '../components/documents/documentsFormat';

export type NativeDocumentReviewPhase =
  | 'loading'
  | 'ready'
  | 'error'
  | 'not-found';

export interface UseNativeDocumentReviewResult {
  doc: NativeDocument | null;
  phase: NativeDocumentReviewPhase;
  loadError: string;
  setActiveTabId: (tabId: string | null) => void;
  activeTab: NativeDocumentTab | null;
  pendingByBlock: Set<string>;
  actionError: string | null;
  conflictNotice: string | null;
  setActionError: (message: string | null) => void;
  setConflictNotice: (message: string | null) => void;
  busyEditIds: Set<string>;
  busyRunIds: Set<string>;
  savingTabIds: Set<string>;
  allBusy: boolean;
  reload: (options?: { quiet?: boolean }) => Promise<void>;
  saveTabText: (input: {
    tabId: string;
    text: string;
    expectedListVersion: number;
  }) => Promise<boolean>;
  acceptEdit: (edit: NativeDocumentEdit) => Promise<void>;
  rejectEdit: (edit: NativeDocumentEdit) => Promise<void>;
  acceptRun: (group: PendingRunGroup) => Promise<void>;
  rejectRun: (group: PendingRunGroup) => Promise<void>;
  acceptAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
}

function addTo(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function removeFrom(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

export function useNativeDocumentReview(
  documentId: string,
  options?: { workspaceId?: string | null; onUnauthorized?: () => void },
): UseNativeDocumentReviewResult {
  const workspaceId = options?.workspaceId ?? null;
  const onUnauthorized = options?.onUnauthorized;

  const [doc, setDoc] = useState<NativeDocument | null>(null);
  const [phase, setPhase] = useState<NativeDocumentReviewPhase>('loading');
  const [loadError, setLoadError] = useState<string>('');
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [busyEditIds, setBusyEditIds] = useState<Set<string>>(new Set());
  const [busyRunIds, setBusyRunIds] = useState<Set<string>>(new Set());
  const [savingTabIds, setSavingTabIds] = useState<Set<string>>(new Set());
  const [allBusy, setAllBusy] = useState(false);

  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  // Only attach a workspace scope when one is known; standalone callers pass
  // none so their requests stay byte-identical (global `x-workspace-id` header).
  const wsArg = useMemo(
    () => (workspaceId ? { workspaceId } : {}),
    [workspaceId],
  );

  // Apply a server document, keeping the active tab if it still exists.
  const applyDocument = useCallback((next: NativeDocument) => {
    setDoc(next);
    setActiveTabId((current) => {
      if (current && next.tabs.some((tab) => tab.id === current))
        return current;
      return next.tabs[0]?.id ?? null;
    });
  }, []);

  const load = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      if (!documentId) {
        setPhase('not-found');
        return;
      }
      if (activeLoad.current) activeLoad.current.cancelled = true;
      const signal = { cancelled: false };
      activeLoad.current = signal;
      if (!quiet) setPhase('loading');
      try {
        const next = await getDocument({ documentId, ...wsArg });
        if (signal.cancelled) return;
        applyDocument(next);
        setPhase('ready');
      } catch (err) {
        if (signal.cancelled) return;
        if (err instanceof UnauthorizedError && onUnauthorized) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setPhase('not-found');
          return;
        }
        if (quiet) {
          // A background refetch failed; keep the current view but flag it.
          setActionError('Couldn’t refresh this document. Try again.');
          return;
        }
        setLoadError(
          err instanceof Error
            ? err.message
            : 'This document is unavailable right now.',
        );
        setPhase('error');
      }
    },
    [applyDocument, documentId, onUnauthorized, wsArg],
  );

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  // Resolve a mutation failure. The native accept path returns three distinct
  // 409 codes: `version_conflict` is recoverable (the document moved on, so
  // refetch and re-review), while `anchor_missing` / `invalid_pending_edit` mean
  // the edit can never apply against the current document — a plain re-accept
  // would loop, so we tell the reviewer to reject it. A 404 (edit/run already
  // resolved elsewhere) syncs by quiet refetch; anything else is retryable.
  const handleMutationError = useCallback(
    async (err: unknown) => {
      if (err instanceof UnauthorizedError && onUnauthorized) {
        onUnauthorized();
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        if (err.code === 'edit_set_mismatch') {
          // A bulk accept/reject was gated: new pending edits appeared since the
          // reviewer loaded the list, so the server applied nothing. Refresh so
          // the new edits render, then let the reviewer re-check before retrying.
          setConflictNotice(
            'New edits arrived while you were reviewing. We refreshed the list — please re-check before accepting or rejecting in bulk.',
          );
          await load({ quiet: true });
          return;
        }
        const inapplicable =
          err.code === 'anchor_missing' || err.code === 'invalid_pending_edit';
        setConflictNotice(
          inapplicable
            ? 'This proposed change no longer fits the current document — reject it to clear it.'
            : 'This document changed while you were reviewing. We refreshed it — please re-check the remaining edits.',
        );
        await load({ quiet: true });
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        await load({ quiet: true });
        return;
      }
      setActionError('Couldn’t apply that change. Try again.');
    },
    [load, onUnauthorized],
  );

  const acceptEdit = useCallback(
    async (edit: NativeDocumentEdit) => {
      setActionError(null);
      setConflictNotice(null);
      setBusyEditIds((set) => addTo(set, edit.id));
      try {
        const { document } = await acceptDocumentEdit({
          documentId,
          editId: edit.id,
          ...wsArg,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyEditIds((set) => removeFrom(set, edit.id));
      }
    },
    [applyDocument, documentId, handleMutationError, wsArg],
  );

  const saveTabText = useCallback(
    async (input: {
      tabId: string;
      text: string;
      expectedListVersion: number;
    }): Promise<boolean> => {
      setActionError(null);
      setConflictNotice(null);
      setSavingTabIds((set) => addTo(set, input.tabId));
      try {
        const { document } = await updateDocumentTab({
          documentId,
          tabId: input.tabId,
          text: input.text,
          expectedListVersion: input.expectedListVersion,
          ...wsArg,
        });
        applyDocument(document);
        return true;
      } catch (err) {
        if (err instanceof UnauthorizedError && onUnauthorized) {
          onUnauthorized();
          return false;
        }
        if (err instanceof ApiError && err.status === 409) {
          if (err.code === 'pending_edits_exist') {
            setConflictNotice(
              'Resolve the pending suggestions on this tab before editing it directly.',
            );
          } else if (err.code === 'version_conflict') {
            setConflictNotice(
              'This tab changed since you started editing. We refreshed the document; your draft is still open.',
            );
          } else {
            await handleMutationError(err);
            return false;
          }
          await load({ quiet: true });
          return false;
        }
        if (err instanceof ApiError && err.status === 404) {
          await load({ quiet: true });
          return false;
        }
        setActionError('Couldn’t save this document. Try again.');
        return false;
      } finally {
        setSavingTabIds((set) => removeFrom(set, input.tabId));
      }
    },
    [
      applyDocument,
      documentId,
      handleMutationError,
      load,
      onUnauthorized,
      wsArg,
    ],
  );

  const rejectEdit = useCallback(
    async (edit: NativeDocumentEdit) => {
      setActionError(null);
      setConflictNotice(null);
      setBusyEditIds((set) => addTo(set, edit.id));
      try {
        const { document } = await rejectDocumentEdit({
          documentId,
          editId: edit.id,
          ...wsArg,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyEditIds((set) => removeFrom(set, edit.id));
      }
    },
    [applyDocument, documentId, handleMutationError, wsArg],
  );

  const acceptRun = useCallback(
    async (group: PendingRunGroup) => {
      if (group.runId == null) return;
      const runId = group.runId;
      setActionError(null);
      setConflictNotice(null);
      setBusyRunIds((set) => addTo(set, runId));
      try {
        // Gate on exactly the run's edits the reviewer saw, so an edit appended
        // to this run after load can't be accepted unseen.
        const { document } = await acceptDocumentEditRun({
          documentId,
          runId,
          reviewedEditIds: group.edits.map((edit) => edit.id),
          ...wsArg,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyRunIds((set) => removeFrom(set, runId));
      }
    },
    [applyDocument, documentId, handleMutationError, wsArg],
  );

  const rejectRun = useCallback(
    async (group: PendingRunGroup) => {
      if (group.runId == null) return;
      const runId = group.runId;
      setActionError(null);
      setConflictNotice(null);
      setBusyRunIds((set) => addTo(set, runId));
      try {
        const { document } = await rejectDocumentEditRun({
          documentId,
          runId,
          reviewedEditIds: group.edits.map((edit) => edit.id),
          ...wsArg,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyRunIds((set) => removeFrom(set, runId));
      }
    },
    [applyDocument, documentId, handleMutationError, wsArg],
  );

  const acceptAll = useCallback(async () => {
    if (!doc) return;
    // Gate on exactly the pending edits currently on screen; the server aborts
    // with `edit_set_mismatch` if a new one slipped in since this render.
    const reviewedEditIds = doc.pendingEdits.map((edit) => edit.id);
    setActionError(null);
    setConflictNotice(null);
    setAllBusy(true);
    try {
      const { document } = await acceptAllDocumentEdits({
        documentId,
        reviewedEditIds,
        ...wsArg,
      });
      applyDocument(document);
    } catch (err) {
      await handleMutationError(err);
    } finally {
      setAllBusy(false);
    }
  }, [applyDocument, doc, documentId, handleMutationError, wsArg]);

  const rejectAll = useCallback(async () => {
    if (!doc) return;
    const reviewedEditIds = doc.pendingEdits.map((edit) => edit.id);
    setActionError(null);
    setConflictNotice(null);
    setAllBusy(true);
    try {
      const { document } = await rejectAllDocumentEdits({
        documentId,
        reviewedEditIds,
        ...wsArg,
      });
      applyDocument(document);
    } catch (err) {
      await handleMutationError(err);
    } finally {
      setAllBusy(false);
    }
  }, [applyDocument, doc, documentId, handleMutationError, wsArg]);

  const activeTab = useMemo(
    () =>
      doc?.tabs.find((tab) => tab.id === activeTabId) ?? doc?.tabs[0] ?? null,
    [activeTabId, doc],
  );

  const pendingByBlock = useMemo(() => {
    const set = new Set<string>();
    for (const edit of doc?.pendingEdits ?? []) {
      if (edit.blockId) set.add(edit.blockId);
    }
    return set;
  }, [doc]);

  return {
    doc,
    phase,
    loadError,
    setActiveTabId,
    activeTab,
    pendingByBlock,
    actionError,
    conflictNotice,
    setActionError,
    setConflictNotice,
    busyEditIds,
    busyRunIds,
    savingTabIds,
    allBusy,
    reload: load,
    saveTabText,
    acceptEdit,
    rejectEdit,
    acceptRun,
    rejectRun,
    acceptAll,
    rejectAll,
  };
}
