import type { QueryClient } from '@tanstack/react-query';
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import type { DocPaneMode } from '../components/DocPaneHeader';
import type { RichTextEditorSaveStatus } from '../components/rich-text/RichTextEditor';
import {
  ApiError,
  createTalkContent,
  createThreadContent,
  getTalkContent,
  getThreadContent,
  patchContent,
  UnauthorizedError,
  type Content,
  type ContentEditSummary,
  type ContentFormat,
  type TalkSnapshot,
} from '../lib/api';
import {
  getContentSplitRatio,
  setContentSplitRatio,
} from '../lib/contentSplitRatio';
import { snapshotQueryKey } from '../lib/useTalkSnapshot';
import { buildThreadHref, type TalkDetailTabKey } from './useTalkDetailTabs';

type UseTalkDocumentControllerInput = {
  talkId: string;
  userId: string;
  activeThreadId: string | null;
  activeThreadIdRef: MutableRefObject<string | null>;
  currentTab: TalkDetailTabKey;
  locationParams: URLSearchParams;
  currentThreadHasContent: boolean;
  queryClient: QueryClient;
  navigate: NavigateFunction;
  onUnauthorized: () => void;
  onSidebarChanged: () => Promise<void> | void;
};

export function useTalkDocumentController({
  talkId,
  userId,
  activeThreadId,
  activeThreadIdRef,
  currentTab,
  locationParams,
  currentThreadHasContent,
  queryClient,
  navigate,
  onUnauthorized,
  onSidebarChanged,
}: UseTalkDocumentControllerInput) {
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModalTitle, setDocModalTitle] = useState('');
  const [docModalFormat, setDocModalFormat] =
    useState<ContentFormat>('markdown');
  const [docModalSubmitting, setDocModalSubmitting] = useState(false);
  const [docModalError, setDocModalError] = useState<string | null>(null);
  const docModalInputRef = useRef<HTMLInputElement | null>(null);
  const [talkContent, setTalkContent] = useState<Content | null>(null);
  const [talkContentLoading, setTalkContentLoading] = useState(false);
  const [talkContentError, setTalkContentError] = useState<string | null>(null);
  const [talkContentPendingEdits, setTalkContentPendingEdits] = useState<
    ContentEditSummary[]
  >([]);
  const [pendingEditStreamingByRunId, setPendingEditStreamingByRunId] =
    useState<Map<string, string | null>>(() => new Map());
  // Sidecar timestamps so the streaming-banner TTL sweep can age out stuck
  // entries when the server never emits a terminal event.
  const pendingEditStreamingStartedAtRef = useRef<Map<string, number>>(
    new Map(),
  );
  const [pendingEditInFlight, setPendingEditInFlight] = useState<Set<string>>(
    () => new Set(),
  );
  const [talkContentSaveStatus, setTalkContentSaveStatus] =
    useState<RichTextEditorSaveStatus>('idle');
  const [talkContentConflict, setTalkContentConflict] = useState(false);
  const talkContentRef = useRef<Content | null>(null);
  const talkContentSaveStatusRef = useRef<RichTextEditorSaveStatus>('idle');

  useEffect(() => {
    talkContentRef.current = talkContent;
  }, [talkContent]);

  useEffect(() => {
    talkContentSaveStatusRef.current = talkContentSaveStatus;
  }, [talkContentSaveStatus]);

  // Doc-pane visibility + HTML Preview/Source mode. Persisted per thread via
  // localStorage key `clawtalk_doc_state:{threadId}` so the user's last layout
  // choice survives reload + thread switch.
  const [docPaneHidden, setDocPaneHidden] = useState<boolean>(false);
  const [htmlMode, setHtmlMode] = useState<DocPaneMode>('preview');
  // Tracks whether we've already auto-flipped this doc from Source to Preview
  // after the first AI generation. Sticky for the lifetime of the page mount.
  const htmlAutoFlippedRef = useRef<Set<string>>(new Set());
  const [htmlSourceDraft, setHtmlSourceDraft] = useState<string>('');
  const htmlSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const htmlSavingRef = useRef<boolean>(false);
  const htmlLastSavedRef = useRef<string>('');
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
        const created = activeThreadId
          ? await createThreadContent({
              threadId: activeThreadId,
              title: trimmed,
              format: docModalFormat,
            })
          : await createTalkContent({
              talkId,
              title: trimmed,
              format: docModalFormat,
            });

        const threadKey = snapshotQueryKey(userId, talkId, created.threadId);
        await queryClient.cancelQueries({ queryKey: threadKey });
        queryClient.setQueryData<TalkSnapshot>(threadKey, (old) =>
          old ? { ...old, content: created, pendingEdits: [] } : old,
        );

        setTalkContent(created);
        setTalkContentPendingEdits([]);
        setTalkContentError(null);
        setTalkContentConflict(false);
        setTalkContentSaveStatus('idle');
        setTalkContentLoading(false);
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
        if (err instanceof ApiError && err.code === 'content_already_exists') {
          await onSidebarChanged();
        }
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

  useEffect(() => {
    setTalkContent(null);
    setTalkContentError(null);
    setTalkContentConflict(false);
    setTalkContentSaveStatus('idle');
    setTalkContentPendingEdits([]);
    setPendingEditStreamingByRunId(new Map());
    pendingEditStreamingStartedAtRef.current.clear();
    setPendingEditInFlight(new Set());
    setTalkContentLoading(false);
  }, [talkId]);

  useEffect(() => {
    const STREAMING_TTL_MS = 90_000;
    const interval = setInterval(() => {
      const now = Date.now();
      const stale: string[] = [];
      for (const [
        runId,
        startedAt,
      ] of pendingEditStreamingStartedAtRef.current) {
        if (now - startedAt > STREAMING_TTL_MS) stale.push(runId);
      }
      if (stale.length === 0) return;
      setPendingEditStreamingByRunId((prev) => {
        let next: Map<string, string | null> | null = null;
        for (const runId of stale) {
          if (prev.has(runId)) {
            if (next === null) next = new Map(prev);
            next.delete(runId);
          }
        }
        return next ?? prev;
      });
      for (const runId of stale) {
        pendingEditStreamingStartedAtRef.current.delete(runId);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  const docStateHydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeThreadId) return;
    if (typeof window === 'undefined') return;
    if (docStateHydratedForRef.current === activeThreadId) return;
    docStateHydratedForRef.current = activeThreadId;
    try {
      const raw = window.localStorage.getItem(
        `clawtalk_doc_state:${activeThreadId}`,
      );
      if (raw) {
        const parsed = JSON.parse(raw) as {
          hidden?: boolean;
          mode?: DocPaneMode;
        };
        setDocPaneHidden(parsed.hidden === true);
        setHtmlMode(parsed.mode === 'source' ? 'source' : 'preview');
        return;
      }
    } catch {
      // Malformed entry; fall through to defaults.
    }
    setDocPaneHidden(false);
    setHtmlMode('preview');
  }, [activeThreadId]);

  const docFirstLoadModeAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!talkContent) return;
    if (docFirstLoadModeAppliedRef.current === talkContent.id) return;
    docFirstLoadModeAppliedRef.current = talkContent.id;
    if (talkContent.contentFormat !== 'html') return;
    const body = talkContent.bodyHtml ?? '';
    if (body.length > 0) return;
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
      );
      if (raw) return;
    } catch {
      // Ignore localStorage read failures.
    }
    setHtmlMode('source');
    try {
      window.localStorage.setItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
        JSON.stringify({ hidden: false, mode: 'source' }),
      );
    } catch {
      // Quota / private mode; silently ignore.
    }
  }, [talkContent]);

  useEffect(() => {
    if (!talkContent) return;
    if (typeof window === 'undefined') return;
    if (!activeThreadId) return;
    if (docStateHydratedForRef.current !== activeThreadId) return;
    if (docFirstLoadModeAppliedRef.current !== talkContent.id) return;
    try {
      window.localStorage.setItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
        JSON.stringify({ hidden: docPaneHidden, mode: htmlMode }),
      );
    } catch {
      // Quota / private mode; silently ignore.
    }
  }, [activeThreadId, docPaneHidden, htmlMode, talkContent]);

  useEffect(() => {
    if (!talkContent) {
      setHtmlSourceDraft('');
      htmlLastSavedRef.current = '';
      return;
    }
    if (talkContent.contentFormat !== 'html') return;
    const body = talkContent.bodyHtml ?? '';
    setHtmlSourceDraft(body);
    htmlLastSavedRef.current = body;
  }, [talkContent]);

  useEffect(() => {
    return () => {
      if (htmlSaveTimerRef.current !== null) {
        clearTimeout(htmlSaveTimerRef.current);
        htmlSaveTimerRef.current = null;
      }
    };
  }, []);

  const performHtmlSave = useCallback(
    async (next: string): Promise<void> => {
      const cur = talkContentRef.current;
      if (!cur) return;
      if (cur.contentFormat !== 'html') return;
      if (next === htmlLastSavedRef.current) return;
      if (htmlSavingRef.current) return;
      htmlSavingRef.current = true;
      setTalkContentSaveStatus('saving');
      try {
        const result = await patchContent({
          contentId: cur.id,
          expectedVersion: cur.bodyVersion,
          bodyHtml: next,
        });
        htmlLastSavedRef.current = result.content.bodyHtml ?? '';
        setTalkContent(result.content);
        setTalkContentSaveStatus('saved');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          setTalkContentConflict(true);
          setTalkContentSaveStatus('error');
          return;
        }
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setTalkContentSaveStatus('error');
        setTalkContentError(
          err instanceof Error ? err.message : 'Failed to save document.',
        );
      } finally {
        htmlSavingRef.current = false;
      }
    },
    [onUnauthorized],
  );

  const handleHtmlSourceChange = useCallback((next: string) => {
    setHtmlSourceDraft(next);
    setTalkContentSaveStatus('pending');
  }, []);

  const handleHtmlSourceSave = useCallback(
    (next: string) => {
      void performHtmlSave(next);
    },
    [performHtmlSave],
  );

  const handleDocTitleSave = useCallback(
    async (nextTitle: string): Promise<void> => {
      const cur = talkContentRef.current;
      if (!cur) return;
      const trimmed = nextTitle.trim();
      if (!trimmed) throw new Error('Title cannot be empty.');
      if (trimmed === cur.title) return;
      try {
        const result = await patchContent({
          contentId: cur.id,
          expectedVersion: cur.bodyVersion,
          title: trimmed,
        });
        setTalkContent(result.content);
        void onSidebarChanged();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'version_conflict') {
          setTalkContentConflict(true);
          throw new Error('Document changed elsewhere. Reload to retry.');
        }
        throw err instanceof Error ? err : new Error('Failed to update title.');
      }
    },
    [onSidebarChanged, onUnauthorized],
  );

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

  const refetchTalkContent = useCallback(async (): Promise<Content | null> => {
    if (!talkId) return null;
    try {
      const threadId = activeThreadIdRef.current;
      const payload = threadId
        ? await getThreadContent(threadId)
        : await getTalkContent(talkId);
      setTalkContent(payload.content);
      setTalkContentPendingEdits(payload.pendingEdits ?? []);
      setTalkContentError(null);
      return payload.content;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      setTalkContentError(
        err instanceof Error ? err.message : 'Failed to load document.',
      );
      return null;
    }
  }, [activeThreadIdRef, onUnauthorized, talkId]);

  const hydrateDocumentFromSnapshot = useCallback((snapshot: TalkSnapshot) => {
    setTalkContent(snapshot.content);
    setTalkContentPendingEdits(
      snapshot.pendingEdits.map((edit) => ({
        id: edit.id,
        contentId: edit.contentId,
        runId: edit.runId,
        agentId: edit.agentId,
        agentNickname: edit.agentNickname,
        messageId: edit.messageId,
        kind: edit.kind,
        baseContentVersion: edit.baseContentVersion,
        targetAnchorId: edit.targetAnchorId,
        newMarkdown: edit.newMarkdown,
        rationale: edit.rationale,
        createdAt: edit.createdAt,
      })),
    );
    setTalkContentError(null);
    setTalkContentLoading(false);
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
  }, [applyChatRatio, currentThreadHasContent, talkContent]);

  return {
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
    talkContent,
    setTalkContent,
    talkContentLoading,
    talkContentError,
    setTalkContentError,
    talkContentPendingEdits,
    setTalkContentPendingEdits,
    pendingEditStreamingByRunId,
    setPendingEditStreamingByRunId,
    pendingEditStreamingStartedAtRef,
    pendingEditInFlight,
    setPendingEditInFlight,
    talkContentSaveStatus,
    setTalkContentSaveStatus,
    talkContentConflict,
    setTalkContentConflict,
    talkContentRef,
    talkContentSaveStatusRef,
    docPaneHidden,
    setDocPaneHidden,
    htmlMode,
    setHtmlMode,
    htmlAutoFlippedRef,
    htmlSourceDraft,
    docBodyRef,
    docNarrowShowBtnRef,
    chatRatio,
    isNarrowViewport,
    mobilePane,
    setMobilePane,
    splitContainerRef,
    splitHandleRef,
    handleResizeHandleKeyDown,
    handleHtmlSourceChange,
    handleHtmlSourceSave,
    handleDocTitleSave,
    handleHideDocPane,
    handleShowDocPane,
    refetchTalkContent,
    hydrateDocumentFromSnapshot,
  };
}
