import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TalkMessage } from '../lib/api';
import {
  getOrderedStepTone,
  type LiveResponseView,
  type OrderedRoundSummary,
  type RunView,
  type TalkTimelineEntry,
} from '../lib/talkRunReducer';
import type { TalkDetailTabKey } from './useTalkDetailTabs';

type PageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type UseTalkRunViewModelInput = {
  agentLabelById: Record<string, string>;
  currentTab: TalkDetailTabKey;
  liveResponsesByRunId: Record<string, LiveResponseView>;
  pageKind: PageKind;
  pageMessages: TalkMessage[];
  pendingRunHistoryScrollRef: MutableRefObject<string | null>;
  runsById: Record<string, RunView>;
};

function getOrderedStepStatusLabel(run: RunView, totalSteps: number): string {
  switch (run.status) {
    case 'running':
      return run.sequenceIndex === totalSteps - 1
        ? 'synthesizing'
        : 'responding';
    case 'awaiting_confirmation':
      return 'awaiting confirmation';
    case 'queued':
      return 'queued';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return run.cancelReason === 'blocked_by_prior_failure'
        ? 'blocked by prior failure'
        : 'cancelled';
    default:
      return run.status;
  }
}

export function useTalkRunViewModel({
  agentLabelById,
  currentTab,
  liveResponsesByRunId,
  pageKind,
  pageMessages,
  pendingRunHistoryScrollRef,
  runsById,
}: UseTalkRunViewModelInput) {
  const runHistory = useMemo(
    () =>
      Object.values(runsById).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    [runsById],
  );

  const persistedMessageRunIds = useMemo(
    () =>
      new Set(
        pageMessages
          .map((message) => message.runId)
          .filter((id): id is string => Boolean(id)),
      ),
    [pageMessages],
  );

  const liveResponses = useMemo(
    () =>
      Object.values(liveResponsesByRunId)
        .filter((response) => !persistedMessageRunIds.has(response.runId))
        .sort((left, right) => left.startedAt - right.startedAt),
    [liveResponsesByRunId, persistedMessageRunIds],
  );

  useEffect(() => {
    if (currentTab !== 'runs') return;
    const runId = pendingRunHistoryScrollRef.current;
    if (!runId) return;
    const row = document.getElementById(`run-${runId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pendingRunHistoryScrollRef.current = null;
  }, [currentTab, pendingRunHistoryScrollRef, runHistory]);

  const orderedRunsByGroup = useMemo(
    () =>
      Object.values(runsById)
        .filter(
          (run) => Boolean(run.responseGroupId) && run.sequenceIndex != null,
        )
        .reduce<Record<string, RunView[]>>((acc, run) => {
          const groupId = run.responseGroupId!;
          (acc[groupId] ||= []).push(run);
          return acc;
        }, {}),
    [runsById],
  );

  const orderedGroupSizesById = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(orderedRunsByGroup).map(([groupId, groupRuns]) => [
          groupId,
          groupRuns.length,
        ]),
      ),
    [orderedRunsByGroup],
  );

  const latestOrderedRound = useMemo<OrderedRoundSummary | null>(() => {
    const groupRuns = Object.values(orderedRunsByGroup)
      .filter((candidate) => candidate.length > 1)
      .sort((left, right) => {
        const leftAt = Math.max(...left.map((run) => run.updatedAt));
        const rightAt = Math.max(...right.map((run) => run.updatedAt));
        return rightAt - leftAt;
      })[0];
    if (!groupRuns) return null;

    const orderedGroupRuns = [...groupRuns].sort(
      (left, right) => (left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0),
    );
    const totalSteps = orderedGroupRuns.length;
    const currentRun =
      orderedGroupRuns.find((run) => run.status === 'running') ||
      orderedGroupRuns.find((run) => run.status === 'awaiting_confirmation') ||
      orderedGroupRuns.find((run) => run.status === 'queued');
    const completedCount = orderedGroupRuns.filter(
      (run) => run.status === 'completed',
    ).length;
    const failedRun = orderedGroupRuns.find((run) => run.status === 'failed');
    const failedSequenceIndex = failedRun?.sequenceIndex ?? null;
    const cancelledRun = orderedGroupRuns.find(
      (run) => run.status === 'cancelled',
    );
    const runsAfterFailure =
      failedSequenceIndex == null
        ? []
        : orderedGroupRuns.filter(
            (run) =>
              (run.sequenceIndex ?? Number.NEGATIVE_INFINITY) >
              failedSequenceIndex,
          );
    const continuedAfterFailure = runsAfterFailure.some(
      (run) =>
        run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'awaiting_confirmation' ||
        run.status === 'completed',
    );
    const allCompleted = orderedGroupRuns.every(
      (run) => run.status === 'completed',
    );

    let heading = 'Ordered round';
    if (currentRun) {
      heading = failedRun
        ? `Ordered round continuing after a failed step · ${completedCount} of ${totalSteps} finished`
        : `Ordered round in progress · ${completedCount} of ${totalSteps} finished`;
    } else if (failedRun && continuedAfterFailure) {
      heading = 'Ordered round finished with a failed step';
    } else if (failedRun) {
      heading = 'Ordered round failed';
    } else if (cancelledRun) {
      heading = 'Ordered round cancelled';
    } else if (allCompleted) {
      heading = 'Ordered round finished';
    }

    const currentLabel =
      currentRun &&
      (currentRun.targetAgentNickname ||
        (currentRun.targetAgentId
          ? agentLabelById[currentRun.targetAgentId]
          : null) ||
        liveResponsesByRunId[currentRun.id]?.agentNickname ||
        'Agent');
    const progressStatus =
      currentRun && currentRun.sequenceIndex != null
        ? currentRun.status === 'awaiting_confirmation'
          ? 'awaiting confirmation…'
          : currentRun.status === 'queued'
            ? 'queued…'
            : currentRun.sequenceIndex === totalSteps - 1
              ? 'synthesizing…'
              : 'responding…'
        : null;
    const progressLabel =
      currentRun && currentRun.sequenceIndex != null && currentLabel
        ? `Agent ${currentRun.sequenceIndex + 1} of ${totalSteps} · ${currentLabel} ${progressStatus}`
        : null;

    let note: string | null = null;
    if (failedRun) {
      const failedLabel =
        failedRun.targetAgentNickname ||
        (failedRun.targetAgentId
          ? agentLabelById[failedRun.targetAgentId]
          : null) ||
        'Agent';
      note = continuedAfterFailure
        ? `${failedLabel} failed, so later agents continued without using its unfinished output.`
        : `${failedLabel} failed. Open Run History for diagnostics.`;
    } else if (cancelledRun?.cancelReason === 'blocked_by_prior_failure') {
      note = 'Later agents were blocked after an earlier step failed.';
    } else if (allCompleted) {
      note =
        'Each agent in the latest ordered round finished and saved a response.';
    }

    return {
      heading,
      note,
      progressLabel,
      retryRunId:
        failedRun?.errorCode === 'incomplete_response' &&
        failedRun.targetAgentId &&
        failedRun.triggerMessageId
          ? failedRun.id
          : null,
      steps: orderedGroupRuns.map((run, index) => {
        const liveResponse = liveResponsesByRunId[run.id];
        const label =
          run.targetAgentNickname ||
          (run.targetAgentId ? agentLabelById[run.targetAgentId] : null) ||
          liveResponse?.agentNickname ||
          'Agent';
        return {
          runId: run.id,
          stepNumber: index + 1,
          label,
          statusLabel: getOrderedStepStatusLabel(run, totalSteps),
          tone: getOrderedStepTone(run),
          isCurrent: run.id === currentRun?.id,
          isSynthesis: index === totalSteps - 1,
        };
      }),
    };
  }, [agentLabelById, liveResponsesByRunId, orderedRunsByGroup]);

  const activeOrderedProgress = latestOrderedRound?.progressLabel
    ? { label: latestOrderedRound.progressLabel }
    : null;

  const talkTimeline = useMemo<TalkTimelineEntry[]>(
    () =>
      [
        ...pageMessages.map((message, index) => ({
          kind: 'message' as const,
          key: message.id,
          timestamp: Date.parse(message.createdAt) || 0,
          sortOrder: index,
          message,
        })),
        ...liveResponses.map((response, index) => {
          const run = runsById[response.runId];
          const triggerMessageId = run?.triggerMessageId ?? null;
          const triggerMessage = triggerMessageId
            ? pageMessages.find((m) => m.id === triggerMessageId)
            : undefined;
          const anchorTimestamp = Date.parse(
            triggerMessage?.createdAt || run?.startedAt || run?.createdAt || '',
          );
          return {
            kind: 'live-response' as const,
            key: response.runId,
            timestamp:
              Number.isFinite(anchorTimestamp) && anchorTimestamp > 0
                ? anchorTimestamp
                : response.queuedAt || response.startedAt,
            sortOrder: pageMessages.length + index,
            response,
          };
        }),
        ...Object.values(runsById)
          .filter(
            (run) =>
              run.status === 'awaiting_confirmation' &&
              Boolean(run.browserBlock),
          )
          .map((run, index) => {
            const updatedAt = Date.parse(
              run.browserBlock?.updatedAt || run.startedAt || run.createdAt,
            );
            return {
              kind: 'browser-run' as const,
              key: `browser-run-${run.id}`,
              timestamp:
                Number.isFinite(updatedAt) && updatedAt > 0
                  ? updatedAt
                  : Date.parse(run.createdAt) || 0,
              sortOrder: pageMessages.length + liveResponses.length + index,
              run,
            };
          }),
      ].sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.sortOrder - right.sortOrder,
      ),
    [liveResponses, orderedGroupSizesById, pageMessages, runsById],
  );

  const activeRound = useMemo(
    () =>
      Object.values(runsById).some(
        (run) =>
          run.status === 'queued' ||
          run.status === 'running' ||
          run.status === 'awaiting_confirmation',
      ),
    [runsById],
  );

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!activeRound) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeRound]);

  const isDenseRound = useMemo(
    () =>
      liveResponses.length >= 4 &&
      liveResponses.every(
        (r) => !r.text && !r.progressMessage && !r.terminalStatus,
      ),
    [liveResponses],
  );

  const canEditHistory = useMemo(
    () =>
      pageKind === 'ready' &&
      !activeRound &&
      pageMessages.some((message) => message.role !== 'system'),
    [activeRound, pageKind, pageMessages],
  );

  const resolveMessageActorLabel = useCallback(
    (message: TalkMessage): string | null => {
      return (
        (message.agentId ? agentLabelById[message.agentId] : null) ||
        message.agentNickname ||
        null
      );
    },
    [agentLabelById],
  );

  return {
    runHistory,
    liveResponses,
    orderedGroupSizesById,
    latestOrderedRound,
    activeOrderedProgress,
    talkTimeline,
    activeRound,
    nowTick,
    isDenseRound,
    canEditHistory,
    resolveMessageActorLabel,
  };
}
