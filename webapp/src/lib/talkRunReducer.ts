import type { TalkMessage, TalkRun } from './api';
import { stripInternalAssistantText } from './assistantText';
import type {
  TalkProgressUpdateEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkResponseTerminalEvent,
  TalkStreamState,
  TalkToolResultEvent,
} from './talkStream';

const MAX_EVENT_RUN_CACHE = 500;

export type RunView = TalkRun & {
  updatedAt: number;
};

export type LiveResponseView = {
  runId: string;
  rawText: string;
  text: string;
  progressMessage?: string;
  // P1-f tool visibility: latest tool outcome for this run. The result
  // string is already truncated server-side (~500 chars). Rendering is
  // optional — state visibility is the point.
  lastToolResult?: {
    toolName: string;
    result: string;
    isError: boolean;
    durationMs?: number;
  };
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  providerId?: string | null;
  modelId?: string | null;
  errorCode?: string | null;
  errorMessage?: string;
  startedAt: number;
  queuedAt: number;
  pendingStatus?: 'queued' | 'running' | 'reconnecting';
  terminalStatus?: 'completed' | 'failed' | 'cancelled';
  // Queue retry visibility. Set when a `talk_run_retrying` event lands
  // (CF Queues redelivered the message). LiveResponsePanel reads
  // `retryAttempt` to show "Retrying N/maxRetries" instead of "Queued".
  retryAttempt?: number;
  retryMaxRetries?: number;
};

export type OrderedRoundStepTone =
  | 'active'
  | 'success'
  | 'error'
  | 'warning'
  | 'muted';

export type OrderedRoundStepSummary = {
  runId: string;
  stepNumber: number;
  label: string;
  statusLabel: string;
  tone: OrderedRoundStepTone;
  isCurrent: boolean;
  isSynthesis: boolean;
};

export type OrderedRoundSummary = {
  heading: string;
  note: string | null;
  progressLabel: string | null;
  steps: OrderedRoundStepSummary[];
  retryRunId: string | null;
};

export type TalkTimelineEntry =
  | {
      kind: 'message';
      key: string;
      timestamp: number;
      sortOrder: number;
      message: TalkMessage;
    }
  | {
      kind: 'live-response';
      key: string;
      timestamp: number;
      sortOrder: number;
      response: LiveResponseView;
    }
  | {
      kind: 'browser-run';
      key: string;
      timestamp: number;
      sortOrder: number;
      run: RunView;
    };

// PR C (talk-load architecture refactor): server data — talk, messages,
// threads, content — moved to React Query (snapshotQuery). This reducer
// holds only UI state + live streaming/runs state that the WS event
// fan-out needs to render token-by-token without re-rendering the
// snapshot subscriber tree.
export type DetailState = {
  runsById: Record<string, RunView>;
  streamState: TalkStreamState;
  sendState: {
    status: 'idle' | 'posting' | 'error';
    error?: string;
    lastDraft?: string;
  };
  liveResponsesByRunId: Record<string, LiveResponseView>;
  cancelState: {
    status: 'idle' | 'posting' | 'success' | 'error';
    message?: string;
  };
  hasUnreadBelow: boolean;
};

export type DetailAction =
  | { type: 'TALK_RESET' }
  | { type: 'SNAPSHOT_HYDRATED'; runs: TalkRun[] }
  | { type: 'MERGE_HISTORICAL_RUNS'; runs: TalkRun[] }
  | {
      type: 'MESSAGE_LANDED';
      message: TalkMessage;
      wasNearBottom: boolean;
    }
  | {
      type: 'RUN_STARTED';
      runId: string;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_QUEUED';
      runId: string;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_RETRYING';
      runId: string;
      retryAttempt: number;
      maxRetries: number;
    }
  | {
      type: 'RUN_COMPLETED';
      runId: string;
      triggerMessageId: string | null;
      responseMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_FAILED';
      runId: string;
      showInlineFailure: boolean;
      triggerMessageId: string | null;
      errorCode: string;
      errorMessage: string;
      executorAlias?: string | null;
      executorModel?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_CANCELLED_BATCH';
      runIds: string[];
      cancelledBy?: string | null;
    }
  | { type: 'RESPONSE_STARTED'; event: TalkResponseStartedEvent }
  | { type: 'RESPONSE_PROGRESS'; event: TalkProgressUpdateEvent }
  | { type: 'TOOL_RESULT'; event: TalkToolResultEvent }
  | { type: 'RESPONSE_DELTA'; event: TalkResponseDeltaEvent }
  | { type: 'RESPONSE_COMPLETED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_FAILED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_CANCELLED'; event: TalkResponseTerminalEvent }
  | { type: 'STREAM_CONNECTING' }
  | { type: 'STREAM_LIVE' }
  | { type: 'STREAM_RECONNECTING' }
  | { type: 'STREAM_OFFLINE' }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_FAILED'; message: string; lastDraft: string }
  | { type: 'SEND_CLEARED' }
  | { type: 'CANCEL_STARTED' }
  | { type: 'CANCEL_SUCCEEDED'; message: string }
  | { type: 'CANCEL_FAILED'; message: string }
  | { type: 'CLEAR_UNREAD' };

export function getOrderedStepTone(run: RunView): OrderedRoundStepTone {
  switch (run.status) {
    case 'running':
    case 'awaiting_confirmation':
      return 'active';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'queued':
    default:
      return 'muted';
  }
}

export function createInitialDetailState(): DetailState {
  return {
    runsById: {},
    streamState: 'connecting',
    sendState: { status: 'idle' },
    liveResponsesByRunId: {},
    cancelState: { status: 'idle' },
    hasUnreadBelow: false,
  };
}

function toRunView(run: TalkRun): RunView {
  return {
    ...run,
    updatedAt:
      Date.parse(run.completedAt || run.startedAt || run.createdAt) ||
      Date.now(),
  };
}

function mapRunsById(runs: TalkRun[]): Record<string, RunView> {
  return runs.reduce<Record<string, RunView>>((acc, run) => {
    acc[run.id] = toRunView(run);
    return acc;
  }, {});
}

function deriveLiveResponsesFromRuns(
  runs: TalkRun[],
): Record<string, LiveResponseView> {
  const result: Record<string, LiveResponseView> = {};
  for (const run of runs) {
    if (!isNonTerminalRunStatus(run.status)) continue;
    const queuedAt = Date.parse(run.createdAt) || Date.now();
    result[run.id] = {
      runId: run.id,
      rawText: '',
      text: '',
      agentId: run.targetAgentId ?? null,
      agentNickname: run.targetAgentNickname ?? null,
      responseGroupId: run.responseGroupId ?? null,
      sequenceIndex: run.sequenceIndex ?? null,
      queuedAt,
      startedAt: run.startedAt
        ? Date.parse(run.startedAt) || queuedAt
        : queuedAt,
      pendingStatus: run.status === 'queued' ? 'queued' : 'running',
    };
  }
  return result;
}

function pruneEventRunCache(
  runsById: Record<string, RunView>,
): Record<string, RunView> {
  const entries = Object.entries(runsById);
  if (entries.length <= MAX_EVENT_RUN_CACHE) {
    return runsById;
  }

  const pinned = entries.filter(([, run]) =>
    ['queued', 'running', 'awaiting_confirmation'].includes(run.status),
  );
  const overflow = Math.max(0, pinned.length - MAX_EVENT_RUN_CACHE);
  const retainedPinned =
    overflow > 0 ? pinned.slice(0, MAX_EVENT_RUN_CACHE) : pinned;
  const remainingSlots = Math.max(
    0,
    MAX_EVENT_RUN_CACHE - retainedPinned.length,
  );
  const recentTerminal = entries
    .filter(
      ([, run]) =>
        !['queued', 'running', 'awaiting_confirmation'].includes(run.status),
    )
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, remainingSlots);

  return Object.fromEntries([...retainedPinned, ...recentTerminal]);
}

function isNonTerminalRunStatus(
  status: TalkRun['status'] | RunView['status'] | undefined,
): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_confirmation'
  );
}

function clearFailedLiveResponses(
  liveResponsesByRunId: Record<string, LiveResponseView>,
): Record<string, LiveResponseView> {
  const next = { ...liveResponsesByRunId };
  for (const [runId, response] of Object.entries(next)) {
    if (response.terminalStatus !== 'failed') continue;
    delete next[runId];
  }
  return next;
}

function shouldShowInlineFailure(input: {
  existing?: LiveResponseView;
  priorRun?: RunView;
  showInlineFailure?: boolean;
}): boolean {
  if (input.showInlineFailure === false) return false;
  return (
    Boolean(input.existing) || isNonTerminalRunStatus(input.priorRun?.status)
  );
}

function withRun(
  state: DetailState,
  runId: string,
  patch: Partial<RunView> & Pick<RunView, 'status'>,
): Record<string, RunView> {
  const now = Date.now();
  const current = state.runsById[runId];
  return pruneEventRunCache({
    ...state.runsById,
    [runId]: {
      id: runId,
      status: patch.status,
      createdAt:
        patch.createdAt ?? current?.createdAt ?? new Date(now).toISOString(),
      startedAt:
        patch.startedAt !== undefined
          ? patch.startedAt
          : (current?.startedAt ?? null),
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : (current?.completedAt ?? null),
      triggerMessageId:
        patch.triggerMessageId !== undefined
          ? patch.triggerMessageId
          : (current?.triggerMessageId ?? null),
      responseGroupId:
        patch.responseGroupId !== undefined
          ? patch.responseGroupId
          : (current?.responseGroupId ?? null),
      sequenceIndex:
        patch.sequenceIndex !== undefined
          ? patch.sequenceIndex
          : (current?.sequenceIndex ?? null),
      targetAgentId:
        patch.targetAgentId !== undefined
          ? patch.targetAgentId
          : (current?.targetAgentId ?? null),
      targetAgentNickname:
        patch.targetAgentNickname !== undefined
          ? patch.targetAgentNickname
          : (current?.targetAgentNickname ?? null),
      errorCode:
        patch.errorCode !== undefined
          ? patch.errorCode
          : (current?.errorCode ?? null),
      errorMessage:
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : (current?.errorMessage ?? null),
      cancelReason:
        patch.cancelReason !== undefined
          ? patch.cancelReason
          : (current?.cancelReason ?? null),
      executorAlias:
        patch.executorAlias !== undefined
          ? patch.executorAlias
          : (current?.executorAlias ?? null),
      executorModel:
        patch.executorModel !== undefined
          ? patch.executorModel
          : (current?.executorModel ?? null),
      updatedAt: now,
    },
  });
}

export function detailReducer(
  state: DetailState,
  action: DetailAction,
): DetailState {
  switch (action.type) {
    case 'TALK_RESET':
      // Cross-talk navigation: previously BOOTSTRAP_LOADING cleared the
      // full reducer state because the snapshot hydrate replaced it.
      // PR C kept the existing run cache so a parallel-fetch race
      // wouldn't drop in-flight runs — but on a fresh talkId the old
      // talk's runs/live state must not survive into the new one.
      return createInitialDetailState();
    case 'SNAPSHOT_HYDRATED': {
      // First snapshot hydration for a Talk. Seed runsById
      // from the snapshot's active runs while preserving any live-state
      // already accumulated from WS deltas that beat the snapshot. The
      // first-paint scroll position is owned by talkScroll — the
      // thread-show effect restores it on mount.
      const incoming = mapRunsById(action.runs);
      const merged = { ...incoming };
      for (const [runId, view] of Object.entries(state.runsById)) {
        merged[runId] = { ...merged[runId], ...view };
      }
      const seededLive = deriveLiveResponsesFromRuns(action.runs);
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const [runId, view] of Object.entries(seededLive)) {
        if (!liveResponsesByRunId[runId]) liveResponsesByRunId[runId] = view;
      }
      return {
        ...state,
        runsById: pruneEventRunCache(merged),
        liveResponsesByRunId,
        hasUnreadBelow: false,
      };
    }
    case 'MERGE_HISTORICAL_RUNS': {
      // Server-authoritative refresh: every run in `action.runs` carries
      // the latest persisted shape (status, browserBlock, errorMessage,
      // etc.). Incoming wins for matched run ids so a resync (e.g. after
      // approving a browser confirmation) clears stale fields like
      // browserBlock. Runs that are only in local state — typically
      // ephemeral entries the live stream just minted — are preserved so
      // a parallel fetch racing a fresh RUN_QUEUED doesn't drop the
      // in-flight panel.
      const merged = mapRunsById(action.runs);
      for (const [runId, view] of Object.entries(state.runsById)) {
        if (!(runId in merged)) {
          merged[runId] = view;
        }
      }
      return { ...state, runsById: merged };
    }
    case 'MESSAGE_LANDED': {
      // The snapshot cache holds the message itself (router setQueryData
      // already appended it). This action only updates the
      // streaming/runs slices: drop the live placeholder for the
      // run, clear any failed live cards if this is a user turn, and
      // bump the unread-below pill if the user wasn't near bottom.
      let liveResponsesByRunId = { ...state.liveResponsesByRunId };
      if (action.message.runId) {
        delete liveResponsesByRunId[action.message.runId];
      }
      if (action.message.role === 'user') {
        liveResponsesByRunId = clearFailedLiveResponses(liveResponsesByRunId);
      }
      return {
        ...state,
        liveResponsesByRunId,
        hasUnreadBelow: action.wasNearBottom
          ? false
          : state.hasUnreadBelow || true,
      };
    }
    case 'RUN_STARTED': {
      const runsById = withRun(state, action.runId, {
        status: 'running',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        createdAt: action.createdAt || undefined,
        startedAt: new Date().toISOString(),
        targetAgentId: action.targetAgentId,
        targetAgentNickname: action.targetAgentNickname,
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      const existing = state.liveResponsesByRunId[action.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          runId: action.runId,
          rawText: existing?.rawText ?? '',
          text: existing?.text ?? '',
          progressMessage: existing?.progressMessage,
          lastToolResult: existing?.lastToolResult,
          agentId: existing?.agentId ?? action.targetAgentId ?? null,
          agentNickname:
            existing?.agentNickname ?? action.targetAgentNickname ?? null,
          responseGroupId:
            existing?.responseGroupId ?? action.responseGroupId ?? null,
          sequenceIndex:
            existing?.sequenceIndex ?? action.sequenceIndex ?? null,
          providerId: existing?.providerId,
          modelId: existing?.modelId,
          errorMessage: existing?.errorMessage,
          queuedAt,
          startedAt: existing?.startedAt ?? queuedAt,
          pendingStatus: 'running' as const,
          terminalStatus: existing?.terminalStatus,
        },
      };
      return { ...state, runsById, liveResponsesByRunId };
    }
    case 'RUN_QUEUED': {
      const runsById = withRun(state, action.runId, {
        status: 'queued',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        createdAt: action.createdAt || undefined,
        targetAgentId: action.targetAgentId,
        targetAgentNickname: action.targetAgentNickname,
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      const existing = state.liveResponsesByRunId[action.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          runId: action.runId,
          rawText: existing?.rawText ?? '',
          text: existing?.text ?? '',
          progressMessage: existing?.progressMessage,
          lastToolResult: existing?.lastToolResult,
          agentId: existing?.agentId ?? action.targetAgentId ?? null,
          agentNickname:
            existing?.agentNickname ?? action.targetAgentNickname ?? null,
          responseGroupId:
            existing?.responseGroupId ?? action.responseGroupId ?? null,
          sequenceIndex:
            existing?.sequenceIndex ?? action.sequenceIndex ?? null,
          providerId: existing?.providerId,
          modelId: existing?.modelId,
          queuedAt,
          startedAt: existing?.startedAt ?? queuedAt,
          pendingStatus: 'queued' as const,
          terminalStatus: existing?.terminalStatus,
        },
      };
      return { ...state, runsById, liveResponsesByRunId };
    }
    case 'RUN_RETRYING': {
      const existing = state.liveResponsesByRunId[action.runId];
      // Only stamp retry visibility onto a live response we already
      // know about — no point synthesizing one if we never saw the
      // RUN_QUEUED frame.
      if (!existing) return state;
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          ...existing,
          retryAttempt: action.retryAttempt,
          retryMaxRetries: action.maxRetries,
        },
      };
      return { ...state, liveResponsesByRunId };
    }
    case 'RUN_COMPLETED': {
      const runsById = withRun(state, action.runId, {
        status: 'completed',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        completedAt: new Date().toISOString(),
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      // Keep the live panel visible with terminalStatus='completed' until
      // MESSAGE_APPENDED replaces it — prevents the panel from vanishing
      // before the persisted assistant message renders. The dedup at
      // MESSAGE_APPENDED removes it once the message lands; the 3 s
      // MISSING_PERSISTED_MESSAGE_REFETCH_MS backstop covers event drops.
      const existing = state.liveResponsesByRunId[action.runId];
      if (!existing) {
        return { ...state, runsById };
      }
      return {
        ...state,
        runsById,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.runId]: {
            ...existing,
            pendingStatus: undefined,
            terminalStatus: 'completed' as const,
          },
        },
      };
    }
    case 'RUN_FAILED': {
      const existing = state.liveResponsesByRunId[action.runId];
      const priorRun = state.runsById[action.runId];
      const runsById = withRun(state, action.runId, {
        status: 'failed',
        triggerMessageId: action.triggerMessageId,
        errorCode: action.errorCode,
        errorMessage: action.errorMessage,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        completedAt: new Date().toISOString(),
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      if (
        !shouldShowInlineFailure({
          existing,
          priorRun,
          showInlineFailure: action.showInlineFailure,
        })
      ) {
        return {
          ...state,
          runsById,
        };
      }
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.runId]: {
            runId: action.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            agentId: existing?.agentId,
            agentNickname: existing?.agentNickname,
            responseGroupId: existing?.responseGroupId,
            sequenceIndex: existing?.sequenceIndex,
            providerId: existing?.providerId,
            modelId: existing?.modelId,
            errorCode: action.errorCode,
            errorMessage: action.errorMessage,
            queuedAt: existing?.queuedAt ?? Date.now(),
            startedAt: existing?.startedAt || Date.now(),
            terminalStatus: 'failed',
          },
        },
        runsById,
      };
    }
    case 'RUN_CANCELLED_BATCH': {
      if (action.runIds.length === 0) return state;
      // Keep cancelled panels visible with terminalStatus='cancelled' so the
      // user sees "Cancelled · Ns" with retained elapsed. Previously these
      // were deleted on cancel — which silently removed feedback.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const runId of action.runIds) {
        const existing = liveResponsesByRunId[runId];
        if (existing) {
          liveResponsesByRunId[runId] = {
            ...existing,
            pendingStatus: undefined,
            terminalStatus: 'cancelled' as const,
          };
        }
      }
      const runsById = { ...state.runsById };
      for (const runId of action.runIds) {
        runsById[runId] = {
          ...(runsById[runId] || {
            id: runId,
            status: 'cancelled',
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            triggerMessageId: null,
            responseGroupId: null,
            sequenceIndex: null,
            targetAgentId: null,
            targetAgentNickname: null,
            errorCode: null,
            errorMessage: null,
            cancelReason: null,
            executorAlias: null,
            executorModel: null,
            updatedAt: Date.now(),
          }),
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          cancelReason:
            runsById[runId]?.cancelReason ??
            (action.cancelledBy === 'system' &&
            runsById[runId]?.responseGroupId &&
            runsById[runId]?.sequenceIndex != null
              ? 'blocked_by_prior_failure'
              : null),
          updatedAt: Date.now(),
        };
      }
      return {
        ...state,
        liveResponsesByRunId,
        runsById: pruneEventRunCache(runsById),
      };
    }
    case 'RESPONSE_STARTED': {
      // Upsert: refine the queued/running placeholder created at RUN_QUEUED
      // with provider details; do NOT clobber existing text/queuedAt.
      const existing = state.liveResponsesByRunId[action.event.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText ?? '',
            text: existing?.text ?? '',
            progressMessage: existing?.progressMessage,
            lastToolResult: existing?.lastToolResult,
            agentId: action.event.agentId ?? existing?.agentId ?? null,
            agentNickname:
              action.event.agentNickname ?? existing?.agentNickname ?? null,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId ?? existing?.providerId,
            modelId: action.event.modelId ?? existing?.modelId,
            queuedAt,
            startedAt: existing?.startedAt ?? Date.now(),
            pendingStatus: 'running' as const,
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_PROGRESS': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            progressMessage: action.event.message,
            lastToolResult: existing?.lastToolResult,
            agentId: action.event.agentId ?? existing?.agentId,
            agentNickname:
              action.event.agentNickname ?? existing?.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId ?? existing?.providerId,
            modelId: action.event.modelId ?? existing?.modelId,
            queuedAt,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            pendingStatus: existing?.pendingStatus ?? 'running',
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'TOOL_RESULT': {
      // P1-f: record the latest tool outcome on the live run entry.
      // Mirrors RESPONSE_PROGRESS — same lifecycle, different field.
      const existing = state.liveResponsesByRunId[action.event.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            progressMessage: existing?.progressMessage,
            lastToolResult: {
              toolName: action.event.toolName,
              result: action.event.result,
              isError: action.event.isError,
              durationMs: action.event.durationMs,
            },
            agentId: action.event.agentId ?? existing?.agentId,
            agentNickname:
              action.event.agentNickname ?? existing?.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId ?? existing?.providerId,
            modelId: action.event.modelId ?? existing?.modelId,
            queuedAt,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            pendingStatus: existing?.pendingStatus ?? 'running',
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_DELTA': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      // If RUN_COMPLETED already deleted the in-flight liveResponse, drop
      // late deltas. Without this guard, the next delta re-creates a
      // "zombie" liveResponse seeded with just the trailing chunk(s) — which
      // surfaces as a truncated message marked "Done" (mid-sentence header
      // + missing prefix) while the real content waits on MESSAGE_APPENDED.
      // We only block creation; if the liveResponse already exists (e.g. a
      // reconnect replays started+delta+failed against a failed-from-DB
      // run), deltas keep appending normally.
      if (!existing) {
        const trackedRun = state.runsById[action.event.runId];
        if (trackedRun && !isNonTerminalRunStatus(trackedRun.status)) {
          return state;
        }
      }
      const rawText = `${existing?.rawText || ''}${action.event.deltaText}`;
      const queuedAtDelta = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText,
            text: stripInternalAssistantText(rawText),
            progressMessage: existing?.progressMessage,
            lastToolResult: existing?.lastToolResult,
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            queuedAt: queuedAtDelta,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            pendingStatus: existing?.pendingStatus ?? 'running',
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_COMPLETED':
      return state;
    case 'RESPONSE_FAILED': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      const priorRun = state.runsById[action.event.runId];
      if (
        !shouldShowInlineFailure({
          existing,
          priorRun,
        })
      ) {
        return state;
      }
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            queuedAt: existing?.queuedAt ?? Date.now(),
            startedAt: existing?.startedAt || Date.now(),
            progressMessage: existing?.progressMessage,
            lastToolResult: existing?.lastToolResult,
            errorMessage: action.event.errorMessage,
            terminalStatus: 'failed',
          },
        },
      };
    }
    case 'RESPONSE_CANCELLED': {
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.event.runId];
      return { ...state, liveResponsesByRunId };
    }
    case 'STREAM_CONNECTING':
      return { ...state, streamState: 'connecting' };
    case 'STREAM_LIVE': {
      // Revert any panels stuck in 'reconnecting' back to 'running'.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      let changed = false;
      for (const [runId, entry] of Object.entries(liveResponsesByRunId)) {
        if (entry.pendingStatus === 'reconnecting') {
          liveResponsesByRunId[runId] = { ...entry, pendingStatus: 'running' };
          changed = true;
        }
      }
      return {
        ...state,
        streamState: 'live',
        liveResponsesByRunId: changed
          ? liveResponsesByRunId
          : state.liveResponsesByRunId,
      };
    }
    case 'STREAM_RECONNECTING': {
      // Flip all non-terminal panels to 'reconnecting' so the UI shows the SSE drop.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      let changed = false;
      for (const [runId, entry] of Object.entries(liveResponsesByRunId)) {
        if (entry.terminalStatus) continue;
        if (entry.pendingStatus === 'reconnecting') continue;
        liveResponsesByRunId[runId] = {
          ...entry,
          pendingStatus: 'reconnecting',
        };
        changed = true;
      }
      return {
        ...state,
        streamState: 'reconnecting',
        liveResponsesByRunId: changed
          ? liveResponsesByRunId
          : state.liveResponsesByRunId,
      };
    }
    case 'STREAM_OFFLINE':
      return { ...state, streamState: 'offline' };
    case 'SEND_STARTED':
      return { ...state, sendState: { status: 'posting' } };
    case 'SEND_FAILED':
      return {
        ...state,
        sendState: {
          status: 'error',
          error: action.message,
          lastDraft: action.lastDraft,
        },
      };
    case 'SEND_CLEARED':
      return { ...state, sendState: { status: 'idle' } };
    case 'CANCEL_STARTED':
      return { ...state, cancelState: { status: 'posting' } };
    case 'CANCEL_SUCCEEDED':
      return {
        ...state,
        cancelState: { status: 'success', message: action.message },
      };
    case 'CANCEL_FAILED':
      return {
        ...state,
        cancelState: { status: 'error', message: action.message },
      };
    case 'CLEAR_UNREAD':
      return {
        ...state,
        hasUnreadBelow: false,
      };
    default:
      return state;
  }
}
