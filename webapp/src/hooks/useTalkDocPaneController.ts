/**
 * Doc-pane LAYOUT + lifecycle controller for the Talk detail surface.
 *
 * This is NOT the old flat-content body facade controller — it
 * owns only the split-pane layout (visibility, resize ratio, mobile pane,
 * refs), the persisted "hidden" preference, and the create-document affordance.
 * The document body itself is read natively by `TalkDocPane` →
 * `TalkDocumentView` over `documents`/`doc_tabs`/`doc_blocks`, so no flat
 * content state, HTML source editing, title saving, or snapshot content
 * hydration lives here anymore.
 *
 * The page derives the primary document id from the snapshot's native document
 * metadata (`snapshot.primaryDocument?.id`) and drives the pane with it; this hook never
 * reads a document body.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import {
  createDocument,
  UnauthorizedError,
  type NativeDocument,
  type NativeDocumentFormat,
  type TalkSnapshot,
  type TalkSnapshotDocument,
} from '../lib/api';
import {
  getContentSplitRatio,
  setContentSplitRatio,
} from '../lib/contentSplitRatio';
import { snapshotQueryKey } from '../lib/useTalkSnapshot';
import { buildThreadHref, type TalkDetailTabKey } from './useTalkDetailTabs';

type UseTalkDocPaneControllerInput = {
  talkId: string;
  userId: string;
  activeThreadId: string | null;
  currentTab: TalkDetailTabKey;
  locationParams: URLSearchParams;
  currentThreadHasContent: boolean;
  queryClient: QueryClient;
  navigate: NavigateFunction;
  onUnauthorized: () => void;
  onSidebarChanged: () => Promise<void> | void;
};

function snapshotDocumentFromNativeDocument(
  document: NativeDocument,
  input: { talkId: string; threadId: string },
): TalkSnapshotDocument {
  return {
    id: document.id,
    talkId: document.primaryTalkId ?? input.talkId,
    threadId: input.threadId,
    title: document.title,
    format: document.format,
    listVersion: document.tabs[0]?.listVersion ?? 1,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function useTalkDocPaneController({
  talkId,
  userId,
  activeThreadId,
  currentTab,
  locationParams,
  currentThreadHasContent,
  queryClient,
  navigate,
  onUnauthorized,
  onSidebarChanged,
}: UseTalkDocPaneControllerInput) {
  // ---- Create-document modal -------------------------------------------
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModalTitle, setDocModalTitle] = useState('');
  const [docModalFormat, setDocModalFormat] =
    useState<NativeDocumentFormat>('markdown');
  const [docModalSubmitting, setDocModalSubmitting] = useState(false);
  const [docModalError, setDocModalError] = useState<string | null>(null);
  const docModalInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Split-pane layout -----------------------------------------------
  // Visibility persists per thread via localStorage key
  // `clawtalk_doc_pane:{threadId}` so the user's last layout choice survives
  // reload + thread switch.
  const [docPaneHidden, setDocPaneHidden] = useState<boolean>(false);
  const docBodyRef = useRef<HTMLDivElement | null>(null);
  const docEdgeTabRef = useRef<HTMLButtonElement | null>(null);
  const docNarrowShowBtnRef = useRef<HTMLButtonElement | null>(null);
  const [chatRatio, setChatRatio] = useState(0.5);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  const initialDocParam = locationParams.get('doc') === '1';
  const [mobilePane, setMobilePane] = useState<'chat' | 'doc'>(
    initialDocParam ? 'doc' : 'chat',
  );
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitHandleRef = useRef<HTMLDivElement | null>(null);
  const splitDraggingRef = useRef(false);

  const openDocModal = useCallback(() => {
    setDocModalTitle('');
    setDocModalFormat('markdown');
    setDocModalError(null);
    setDocModalOpen(true);
  }, []);

  const closeDocModal = useCallback(() => {
    if (docModalSubmitting) return;
    setDocModalOpen(false);
    setDocModalError(null);
  }, [docModalSubmitting]);

  const handleCreateDoc = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (docModalSubmitting) return;
      const trimmed = docModalTitle.trim();
      if (!trimmed) {
        setDocModalError('Please enter a title.');
        return;
      }
      setDocModalSubmitting(true);
      setDocModalError(null);
      try {
        // The create route writes a native `documents` row and returns its
        // native tabs/blocks shape. This controller adapts only metadata into
        // the still-compatible snapshot cache so the pane can resolve the new
        // document id instantly; no flat body projection is read.
        const document = await createDocument({
          talkId,
          title: trimmed,
          format: docModalFormat,
        });
        const created = snapshotDocumentFromNativeDocument(document, {
          talkId,
          threadId: activeThreadId ?? document.primaryTalkId ?? talkId,
        });

        const threadKey = snapshotQueryKey(userId, talkId, created.threadId);
        await queryClient.cancelQueries({ queryKey: threadKey });
        queryClient.setQueryData<TalkSnapshot>(threadKey, (old) =>
          old ? { ...old, primaryDocument: created, pendingEdits: [] } : old,
        );

        setDocPaneHidden(false);
        setDocModalOpen(false);
        setDocModalTitle('');
        void onSidebarChanged();
        navigate(
          `${buildThreadHref(talkId, created.threadId, currentTab)}&doc=1`,
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to create document.';
        setDocModalError(message);
      } finally {
        setDocModalSubmitting(false);
      }
    },
    [
      activeThreadId,
      currentTab,
      docModalFormat,
      docModalSubmitting,
      docModalTitle,
      navigate,
      onSidebarChanged,
      onUnauthorized,
      queryClient,
      talkId,
      userId,
    ],
  );

  useEffect(() => {
    if (!docModalOpen) return;
    docModalInputRef.current?.focus();
  }, [docModalOpen]);

  // Reset the pane-visibility hydration guard when the Talk changes so the
  // per-thread preference re-reads for the new Talk.
  const docStateHydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    docStateHydratedForRef.current = null;
    setDocPaneHidden(false);
  }, [talkId]);

  useEffect(() => {
    if (!activeThreadId) return;
    if (typeof window === 'undefined') return;
    if (docStateHydratedForRef.current === activeThreadId) return;
    docStateHydratedForRef.current = activeThreadId;
    try {
      const raw = window.localStorage.getItem(
        `clawtalk_doc_pane:${activeThreadId}`,
      );
      if (raw) {
        const parsed = JSON.parse(raw) as { hidden?: boolean };
        setDocPaneHidden(parsed.hidden === true);
        return;
      }
    } catch {
      // Malformed entry; fall through to default.
    }
    setDocPaneHidden(false);
  }, [activeThreadId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!activeThreadId) return;
    if (docStateHydratedForRef.current !== activeThreadId) return;
    try {
      window.localStorage.setItem(
        `clawtalk_doc_pane:${activeThreadId}`,
        JSON.stringify({ hidden: docPaneHidden }),
      );
    } catch {
      // Quota / private mode; silently ignore.
    }
  }, [activeThreadId, docPaneHidden]);

  const handleHideDocPane = useCallback(() => {
    setDocPaneHidden(true);
    requestAnimationFrame(() => {
      docEdgeTabRef.current?.focus();
      docNarrowShowBtnRef.current?.focus();
    });
  }, []);

  const handleShowDocPane = useCallback(() => {
    setDocPaneHidden(false);
    requestAnimationFrame(() => {
      docBodyRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!talkId) return;
    setChatRatio(getContentSplitRatio(talkId));
  }, [talkId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) =>
      setIsNarrowViewport(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (initialDocParam) setMobilePane('doc');
  }, [initialDocParam]);

  const clampRatio = useCallback((value: number) => {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0.2, Math.min(0.8, value));
  }, []);

  const applyChatRatio = useCallback(
    (nextRaw: number) => {
      const next = clampRatio(nextRaw);
      setChatRatio(next);
      if (talkId) setContentSplitRatio(talkId, next);
    },
    [clampRatio, talkId],
  );

  const handleResizeHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyChatRatio(chatRatio - 0.05);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyChatRatio(chatRatio + 0.05);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyChatRatio(0.2);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyChatRatio(0.8);
      }
    },
    [applyChatRatio, chatRatio],
  );

  useEffect(() => {
    const handle = splitHandleRef.current;
    if (!handle) return;
    const onPointerDown = (event: PointerEvent) => {
      splitDraggingRef.current = true;
      handle.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!splitDraggingRef.current) return;
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      applyChatRatio((event.clientX - rect.left) / rect.width);
    };
    const onPointerUp = (event: PointerEvent) => {
      splitDraggingRef.current = false;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    };
  }, [applyChatRatio, currentThreadHasContent]);

  return {
    // Create-document modal
    docModalOpen,
    setDocModalOpen,
    docModalTitle,
    setDocModalTitle,
    docModalFormat,
    setDocModalFormat,
    docModalSubmitting,
    docModalError,
    docModalInputRef,
    openDocModal,
    closeDocModal,
    handleCreateDoc,
    // Split-pane layout
    docPaneHidden,
    setDocPaneHidden,
    docBodyRef,
    docEdgeTabRef,
    docNarrowShowBtnRef,
    chatRatio,
    isNarrowViewport,
    mobilePane,
    setMobilePane,
    splitContainerRef,
    splitHandleRef,
    handleResizeHandleKeyDown,
    handleHideDocPane,
    handleShowDocPane,
  };
}
