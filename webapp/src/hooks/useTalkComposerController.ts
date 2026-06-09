import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { QueryClient } from '@tanstack/react-query';

import {
  buildSourceMentionOptions,
  type SourceMentionOption,
} from '../components/SourceMentionPicker';
import {
  cancelTalkRuns,
  sendTalkMessage,
  uploadTalkAttachment,
  UnauthorizedError,
  type ContextSource,
  type Talk,
  type TalkMessage,
} from '../lib/api';
import type { DetailAction, DetailState, RunView } from '../lib/talkRunReducer';
import { appendTalkMessageToSnapshot } from '../lib/wsCacheRouter';
import type { TalkDetailTabKey } from './useTalkDetailTabs';

const TALK_MESSAGE_MAX_CHARS = 20_000;
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 48;
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 240;
const GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED = false;
const ALLOWED_ATTACHMENT_EXTENSIONS =
  '.txt,.md,.csv,.html,.rtf,' +
  '.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.bash,.sql,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.env,.log,' +
  '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp';
const ALLOWED_ATTACHMENT_MIMES = new Set([
  // Text-based (existing)
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  // NEW: RTF
  'text/rtf',
  'application/rtf',
  // NEW: Code / structured data (treated as plain text)
  'text/xml',
  'application/json',
  'application/xml',
  'text/yaml',
  'text/x-yaml',
  'application/x-yaml',
  'text/x-python',
  'text/x-java',
  'text/javascript',
  'application/javascript',
  'text/typescript',
  'text/x-c',
  'text/x-c++',
  'text/x-go',
  'text/x-rust',
  'text/x-shellscript',
  'text/x-sql',
  // Documents (existing + PPTX)
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const IMAGE_ATTACHMENT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 3;

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type RetryRunState = {
  runId: string;
  status: 'posting' | 'error';
  message: string;
} | null;

type MentionState = { atIndex: number; selectedIndex: number } | null;

export type PendingComposerAttachment = {
  localId: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  isImage: boolean;
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  errorMessage?: string;
};

type ComposerInputControllerInput = {
  pageKind: PageKind;
  pageTalk: Talk | null;
  activeConversationId: string | null;
  currentTab: TalkDetailTabKey;
  sendState: DetailState['sendState'];
  dispatch: Dispatch<DetailAction>;
  contextSources: ContextSource[];
  // The Talk's primary native document title for the `@doc` mention, or null
  // when no document is attached. No content body facade is read here.
  documentTitle: string | null;
};

type SendControllerInput = {
  pageKind: PageKind;
  pageTalk: Talk | null;
  activeTalkWorkspaceId: string | null;
  activeConversationId: string | null;
  activeRound: boolean;
  hasUnsavedAgentChanges: boolean;
  composerGuardrailMessage: string | null;
  targetAgentIds: string[];
  toggleTargetAgent: (agentId: string) => void;
  sendState: DetailState['sendState'];
  runsById: Record<string, RunView>;
  pageMessages: TalkMessage[];
  dispatch: Dispatch<DetailAction>;
  queryClient: QueryClient;
  userId: string;
  talkId: string;
  onUnauthorized: () => void;
  openHistoryEditor: () => void;
  followBottomRef: MutableRefObject<boolean>;
  autoStickToBottomRef: MutableRefObject<ScrollBehavior | null>;
  composer: {
    draft: string;
    setDraft: Dispatch<SetStateAction<string>>;
    pendingAttachments: PendingComposerAttachment[];
    setPendingAttachments: Dispatch<
      SetStateAction<PendingComposerAttachment[]>
    >;
    mentionState: MentionState;
    mentionOptions: SourceMentionOption[];
    insertMentionOption: (option: SourceMentionOption) => void;
    setMentionState: Dispatch<SetStateAction<MentionState>>;
  };
};

function hasFileTransfer(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;

  const { types } = dataTransfer;
  if (!types) return false;

  const domTypes = types as unknown as DOMStringList;
  if (typeof domTypes.contains === 'function') {
    return domTypes.contains('Files');
  }

  return Array.from(types as ArrayLike<string>).includes('Files');
}

function inferAttachmentMimeType(file: File): string {
  if (ALLOWED_ATTACHMENT_MIMES.has(file.type)) {
    return file.type;
  }
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return file.type;
}

export function useTalkComposerInputController({
  pageKind,
  pageTalk,
  activeConversationId,
  currentTab,
  sendState,
  dispatch,
  contextSources,
  documentTitle,
}: ComposerInputControllerInput) {
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingComposerAttachment[]
  >([]);
  // Composer `@`-mention typeahead. Tracks the live `@` index in the
  // draft and the active picker selection. Opens when @ lands at a word
  // boundary AND the Talk has an attached doc OR at least one ready
  // saved source. The popover offers `@doc` (if applicable) plus every
  // ready source filtered by the chars typed after `@`.
  const [mentionState, setMentionState] = useState<MentionState>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const dragCounterRef = useRef(0);

  const mentionFilter = useMemo(() => {
    if (!mentionState) return '';
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? draft.length;
    const between = draft.slice(mentionState.atIndex + 1, cursor);
    // The filter is only the word characters / hyphens immediately
    // after `@`. Any whitespace ends the filter (and the mention).
    if (/\s/.test(between)) return between.split(/\s/)[0] ?? '';
    return between;
  }, [draft, mentionState]);

  const mentionOptions = useMemo(
    () =>
      buildSourceMentionOptions({
        sources: contextSources,
        filter: mentionFilter,
        contentTitle: documentTitle,
      }),
    [contextSources, mentionFilter, documentTitle],
  );

  // Keep the highlighted index inside the valid range as the filter
  // text shrinks/grows the option list. When options become empty we
  // dismiss the picker so the user sees their literal `@filter` text.
  useEffect(() => {
    if (!mentionState) return;
    if (mentionOptions.length === 0) {
      setMentionState(null);
      return;
    }
    if (mentionState.selectedIndex >= mentionOptions.length) {
      setMentionState({
        atIndex: mentionState.atIndex,
        selectedIndex: 0,
      });
    }
  }, [mentionOptions.length, mentionState]);

  const insertMentionOption = useCallback(
    (option: SourceMentionOption) => {
      if (!mentionState) return;
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? draft.length;
      const before = draft.slice(0, mentionState.atIndex);
      // Everything from `@` through the cursor (including the filter
      // chars the user typed) is replaced by the canonical insertion.
      const after = draft.slice(cursor);
      const inserted = option.insertion;
      const next = before + inserted + after;
      setDraft(next);
      setMentionState(null);
      requestAnimationFrame(() => {
        const taNow = textareaRef.current;
        if (!taNow) return;
        taNow.focus();
        const nextCursor = before.length + inserted.length;
        taNow.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [draft, mentionState],
  );

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      if (pageKind === 'ready' && sendState.status === 'error') {
        dispatch({ type: 'SEND_CLEARED' });
      }
      // `@` trigger: open the mention picker when the user types `@` at a
      // word boundary AND the Talk has either an attached doc or at least
      // one ready saved source. The literal `@` stays in the textarea;
      // selection replaces the `@filter` slice with the canonical token.
      const hasMentionable =
        !!documentTitle ||
        contextSources.some((source) => source.status === 'ready');
      if (hasMentionable) {
        const ta = textareaRef.current;
        const pos = ta?.selectionStart ?? value.length;
        const atIndex = pos - 1;
        if (atIndex >= 0 && value[atIndex] === '@') {
          const prev = atIndex > 0 ? value[atIndex - 1] : '';
          const atWordBoundary = atIndex === 0 || /\s/.test(prev);
          if (atWordBoundary) {
            setMentionState({ atIndex, selectedIndex: 0 });
            return;
          }
        }
      }
      // Dismiss the picker if the cursor moved past the `@<filter>` span
      // (e.g. the user inserted a space or backspaced over the `@`).
      if (mentionState) {
        const ta = textareaRef.current;
        const cursor = ta?.selectionStart ?? value.length;
        if (
          cursor <= mentionState.atIndex ||
          value[mentionState.atIndex] !== '@'
        ) {
          setMentionState(null);
        }
      }
    },
    [
      contextSources,
      dispatch,
      mentionState,
      pageKind,
      sendState,
      documentTitle,
    ],
  );

  const resizeComposerTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const scrollHeight = Math.max(
      textarea.scrollHeight,
      COMPOSER_TEXTAREA_MIN_HEIGHT_PX,
    );
    const nextHeight = Math.min(scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT_PX);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      scrollHeight > COMPOSER_TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposerTextarea();
  }, [
    activeConversationId,
    currentTab,
    draft,
    resizeComposerTextarea,
    pageKind,
  ]);

  const handleFilesSelected = useCallback(
    async (files: FileList | File[]) => {
      if (!pageTalk || !GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
      const fileArray = Array.from(files);
      const currentCount = pendingAttachments.length;
      if (currentCount + fileArray.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        dispatch({
          type: 'SEND_FAILED',
          message: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
          lastDraft: draft,
        });
        return;
      }

      const currentImageCount = pendingAttachments.filter(
        (attachment) => attachment.isImage,
      ).length;
      const incomingImageCount = fileArray.filter((file) =>
        IMAGE_ATTACHMENT_MIMES.has(inferAttachmentMimeType(file)),
      ).length;
      if (
        currentImageCount + incomingImageCount >
        MAX_IMAGE_ATTACHMENTS_PER_MESSAGE
      ) {
        dispatch({
          type: 'SEND_FAILED',
          message: `You can attach up to ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE} images per message.`,
          lastDraft: draft,
        });
        return;
      }

      for (const file of fileArray) {
        const mimeType = inferAttachmentMimeType(file);
        const isImage = IMAGE_ATTACHMENT_MIMES.has(mimeType);

        if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType) && file.type !== '') {
          dispatch({
            type: 'SEND_FAILED',
            message: `File type "${file.type}" is not supported. Supported: text, markdown, CSV, HTML, RTF, PDF, DOCX, XLSX, PPTX, PNG, JPEG, WEBP, and common code/config files.`,
            lastDraft: draft,
          });
          continue;
        }
        const maxSize = isImage
          ? MAX_IMAGE_ATTACHMENT_SIZE
          : MAX_ATTACHMENT_SIZE;
        if (file.size > maxSize) {
          dispatch({
            type: 'SEND_FAILED',
            message: `"${file.name}" exceeds the ${maxSize / (1024 * 1024)} MB size limit.`,
            lastDraft: draft,
          });
          continue;
        }

        const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
        setPendingAttachments((prev) => [
          ...prev,
          {
            localId,
            file,
            fileName: file.name,
            fileSize: file.size,
            mimeType,
            isImage,
            previewUrl,
            status: 'uploading',
          },
        ]);

        try {
          const result = await uploadTalkAttachment(pageTalk.id, file);
          setPendingAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    status: 'ready' as const,
                    attachmentId: result.attachment.id,
                  }
                : a,
            ),
          );
        } catch (err) {
          setPendingAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    status: 'error' as const,
                    errorMessage:
                      err instanceof Error ? err.message : 'Upload failed',
                  }
                : a,
            ),
          );
        }
      }
    },
    [dispatch, draft, pageTalk, pendingAttachments],
  );

  const handleRemoveAttachment = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const next: typeof prev = [];
      for (const attachment of prev) {
        if (attachment.localId === localId) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
          continue;
        }
        next.push(attachment);
      }
      return next;
    });
  }, []);

  const handleAttachButtonClick = useCallback(() => {
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
        void handleFilesSelected(event.target.files);
        event.target.value = '';
      }
    },
    [handleFilesSelected],
  );

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    dragCounterRef.current += 1;
    if (hasFileTransfer(event.dataTransfer)) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED &&
      hasFileTransfer(event.dataTransfer)
    ) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (
        GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED &&
        event.dataTransfer.files.length > 0
      ) {
        void handleFilesSelected(event.dataTransfer.files);
      }
    },
    [handleFilesSelected],
  );

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  useEffect(() => {
    // Always start a tab visit with a clean drag-overlay state — even
    // when we just switched TO 'talk'. The workspace dragCounter can
    // stick at >0 if a child dropzone in another tab (e.g. the Context
    // tab's SavedSourcesPanel) stops propagation on its own drop,
    // leaving the workspace's matching dragLeave unfired. Without this
    // reset, switching back to the Talk tab would re-render the
    // overlay with no live drag in progress.
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (currentTab !== 'talk') return;

    const preventWindowFileNavigation = (event: DragEvent) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED
          ? 'copy'
          : 'none';
      }
      if (event.type === 'drop') {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };

    window.addEventListener('dragenter', preventWindowFileNavigation, true);
    window.addEventListener('dragover', preventWindowFileNavigation, true);
    window.addEventListener('drop', preventWindowFileNavigation, true);

    return () => {
      window.removeEventListener(
        'dragenter',
        preventWindowFileNavigation,
        true,
      );
      window.removeEventListener('dragover', preventWindowFileNavigation, true);
      window.removeEventListener('drop', preventWindowFileNavigation, true);
    };
  }, [currentTab]);

  const hasPendingImageAttachments = useMemo(
    () => pendingAttachments.some((attachment) => attachment.isImage),
    [pendingAttachments],
  );

  return {
    draft,
    setDraft,
    fileInputRef,
    textareaRef,
    mentionState,
    mentionOptions,
    insertMentionOption,
    setMentionState,
    handleDraftChange,
    pendingAttachments,
    setPendingAttachments,
    handleFileInputChange,
    handleRemoveAttachment,
    handleAttachButtonClick,
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    hasPendingImageAttachments,
    ALLOWED_ATTACHMENT_EXTENSIONS,
    GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED,
    TALK_MESSAGE_MAX_CHARS,
  };
}

export function useTalkSendController({
  pageKind,
  pageTalk,
  activeTalkWorkspaceId,
  activeConversationId,
  activeRound,
  hasUnsavedAgentChanges,
  composerGuardrailMessage,
  targetAgentIds,
  toggleTargetAgent,
  sendState,
  runsById,
  pageMessages,
  dispatch,
  queryClient,
  userId,
  talkId,
  onUnauthorized,
  openHistoryEditor,
  followBottomRef,
  autoStickToBottomRef,
  composer,
}: SendControllerInput) {
  const [retryRunState, setRetryRunState] = useState<RetryRunState>(null);

  useEffect(() => {
    setRetryRunState(null);
  }, [activeConversationId]);

  const handleToggleTarget = useCallback(
    (agentId: string) => {
      toggleTargetAgent(agentId);
      if (pageKind === 'ready' && sendState.status === 'error') {
        dispatch({ type: 'SEND_CLEARED' });
      }
    },
    [dispatch, pageKind, sendState.status, toggleTargetAgent],
  );

  const queueTalkMessage = useCallback(
    async (input: {
      content: string;
      targetAgentIds: string[];
      attachmentIds?: string[];
    }) => {
      if (pageKind !== 'ready' || !pageTalk || !activeConversationId) {
        throw new Error('Conversation unavailable.');
      }

      const result = await sendTalkMessage({
        workspaceId: activeTalkWorkspaceId,
        talkId: pageTalk.id,
        content: input.content,
        targetAgentIds: input.targetAgentIds,
        attachmentIds: input.attachmentIds,
      });
      // The user just submitted — show them where their message landed, even
      // if they were scrolled up reading earlier history. Mark them following
      // so the guarded auto-stick scroll goes through; subsequent agent
      // responses still go through the usual nearBottom gate, so a user who
      // scrolls away mid-stream won't get yanked back.
      followBottomRef.current = true;
      autoStickToBottomRef.current = 'smooth';
      appendTalkMessageToSnapshot({
        queryClient,
        userId,
        talkId,
        message: result.message,
      });
      dispatch({
        type: 'MESSAGE_LANDED',
        wasNearBottom: true,
        message: result.message,
      });
      for (const run of result.runs) {
        dispatch({
          type: 'RUN_QUEUED',
          runId: run.id,
          triggerMessageId: run.triggerMessageId,
          createdAt: run.createdAt,
          targetAgentId: run.targetAgentId,
          targetAgentNickname: run.targetAgentNickname,
          responseGroupId: run.responseGroupId,
          sequenceIndex: run.sequenceIndex,
          executorAlias: run.executorAlias,
          executorModel: run.executorModel,
        });
      }
      return result;
    },
    [
      activeTalkWorkspaceId,
      activeConversationId,
      autoStickToBottomRef,
      dispatch,
      followBottomRef,
      pageKind,
      pageTalk,
      queryClient,
      talkId,
      userId,
    ],
  );

  const submitDraft = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeConversationId) return;

    const content = composer.draft.trim();
    if (!content) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Message content is required.',
        lastDraft: composer.draft,
      });
      return;
    }
    if (content === '/edit') {
      composer.setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
      openHistoryEditor();
      return;
    }
    if (content.length > TALK_MESSAGE_MAX_CHARS) {
      dispatch({
        type: 'SEND_FAILED',
        message: `Message exceeds ${TALK_MESSAGE_MAX_CHARS} characters.`,
        lastDraft: content,
      });
      return;
    }
    if (activeRound) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for the current round to finish or cancel it first.',
        lastDraft: content,
      });
      return;
    }
    if (hasUnsavedAgentChanges) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Save agent changes before sending a message.',
        lastDraft: content,
      });
      return;
    }
    if (composerGuardrailMessage) {
      dispatch({
        type: 'SEND_FAILED',
        message: composerGuardrailMessage,
        lastDraft: content,
      });
      return;
    }

    // Collect ready attachment IDs
    const readyAttachments = composer.pendingAttachments.filter(
      (a) => a.status === 'ready' && a.attachmentId,
    );
    const stillUploading = composer.pendingAttachments.some(
      (a) => a.status === 'uploading',
    );
    if (stillUploading) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for file uploads to finish before sending.',
        lastDraft: content,
      });
      return;
    }

    dispatch({ type: 'SEND_STARTED' });
    try {
      await queueTalkMessage({
        content,
        targetAgentIds,
        attachmentIds: readyAttachments.map((a) => a.attachmentId!),
      });
      composer.pendingAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      composer.setDraft('');
      composer.setPendingAttachments([]);
      dispatch({ type: 'SEND_CLEARED' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      dispatch({
        type: 'SEND_FAILED',
        message: err instanceof Error ? err.message : 'Failed to send message',
        lastDraft: content,
      });
    }
  }, [
    activeRound,
    activeConversationId,
    composer,
    composerGuardrailMessage,
    dispatch,
    hasUnsavedAgentChanges,
    onUnauthorized,
    openHistoryEditor,
    pageKind,
    pageTalk,
    queueTalkMessage,
    targetAgentIds,
  ]);

  const handleRetryAgentRun = useCallback(
    async (runId: string) => {
      if (pageKind !== 'ready' || !pageTalk || !activeConversationId) return;
      if (activeRound) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Wait for the current round to finish or cancel it first.',
        });
        return;
      }
      if (hasUnsavedAgentChanges) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Save agent changes before retrying this agent.',
        });
        return;
      }

      const run = runsById[runId];
      const triggerMessage = pageMessages.find(
        (message) =>
          message.id === run?.triggerMessageId && message.role === 'user',
      );
      if (!run?.targetAgentId || !triggerMessage?.content.trim()) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'The original prompt is unavailable for this retry.',
        });
        return;
      }

      setRetryRunState({
        runId,
        status: 'posting',
        message: 'Retrying this agent from the original prompt…',
      });
      try {
        await queueTalkMessage({
          content: triggerMessage.content,
          targetAgentIds: [run.targetAgentId],
        });
        setRetryRunState(null);
        dispatch({ type: 'SEND_CLEARED' });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          setRetryRunState(null);
          onUnauthorized();
          return;
        }
        setRetryRunState({
          runId,
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to retry this agent.',
        });
      }
    },
    [
      activeRound,
      activeConversationId,
      dispatch,
      hasUnsavedAgentChanges,
      onUnauthorized,
      pageKind,
      pageMessages,
      pageTalk,
      queueTalkMessage,
      runsById,
    ],
  );

  const handleSend = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void submitDraft();
    },
    [submitDraft],
  );

  const handleComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (composer.mentionState && composer.mentionOptions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          composer.setMentionState({
            atIndex: composer.mentionState.atIndex,
            selectedIndex: Math.min(
              composer.mentionState.selectedIndex + 1,
              composer.mentionOptions.length - 1,
            ),
          });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          composer.setMentionState({
            atIndex: composer.mentionState.atIndex,
            selectedIndex: Math.max(composer.mentionState.selectedIndex - 1, 0),
          });
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const option =
            composer.mentionOptions[composer.mentionState.selectedIndex];
          if (option) composer.insertMentionOption(option);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          composer.setMentionState(null);
          return;
        }
      }
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      void submitDraft();
    },
    [composer, submitDraft],
  );

  const handleCancelRuns = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeConversationId) return;
    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(pageTalk.id, {
        workspaceId: activeTalkWorkspaceId,
      });
      dispatch({
        type: 'CANCEL_SUCCEEDED',
        message: `Cancelled ${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      dispatch({
        type: 'CANCEL_FAILED',
        message: err instanceof Error ? err.message : 'Failed to cancel runs',
      });
    }
  }, [
    activeTalkWorkspaceId,
    activeConversationId,
    dispatch,
    onUnauthorized,
    pageKind,
    pageTalk,
  ]);

  return {
    handleToggleTarget,
    handleRetryAgentRun,
    retryRunState,
    handleSend,
    handleComposerKeyDown,
    handleCancelRuns,
  };
}
