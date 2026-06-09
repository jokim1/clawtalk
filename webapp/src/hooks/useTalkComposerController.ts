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

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type RetryRunState = {
  runId: string;
  status: 'posting' | 'error';
  message: string;
} | null;

type MentionState = { atIndex: number; selectedIndex: number } | null;

type ComposerInputControllerInput = {
  pageKind: PageKind;
  activeConversationId: string | null;
  currentTab: TalkDetailTabKey;
  contextSources: ContextSource[];
  sendState: DetailState['sendState'];
  dispatch: Dispatch<DetailAction>;
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
    mentionState: MentionState;
    mentionOptions: SourceMentionOption[];
    insertMentionOption: (option: SourceMentionOption) => void;
    setMentionState: Dispatch<SetStateAction<MentionState>>;
  };
};

export function useTalkComposerInputController({
  pageKind,
  activeConversationId,
  currentTab,
  contextSources,
  sendState,
  dispatch,
  documentTitle,
}: ComposerInputControllerInput) {
  const [draft, setDraft] = useState('');
  // Composer `@`-mention typeahead. Tracks the live `@` index in the
  // draft and the active picker selection. Opens when @ lands at a word
  // boundary AND the Talk has an attached doc OR at least one ready
  // saved source. The popover offers `@doc` (if applicable) plus every
  // ready source filtered by the chars typed after `@`.
  const [mentionState, setMentionState] = useState<MentionState>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  return {
    draft,
    setDraft,
    textareaRef,
    mentionState,
    mentionOptions,
    insertMentionOption,
    setMentionState,
    handleDraftChange,
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
    async (input: { content: string; targetAgentIds: string[] }) => {
      if (pageKind !== 'ready' || !pageTalk || !activeConversationId) {
        throw new Error('Conversation unavailable.');
      }

      const result = await sendTalkMessage({
        workspaceId: activeTalkWorkspaceId,
        talkId: pageTalk.id,
        content: input.content,
        targetAgentIds: input.targetAgentIds,
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

    dispatch({ type: 'SEND_STARTED' });
    try {
      await queueTalkMessage({
        content,
        targetAgentIds,
      });
      composer.setDraft('');
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
