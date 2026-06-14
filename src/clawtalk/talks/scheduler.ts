// Cron-trigger scheduler.
//
// The greenfield scheduler has two responsibilities:
//   1. fire due rows from `jobs` into normal `runs`,
//   2. maintain the run state machine safety nets every minute.

import {
  getDbPg,
  withNotifyQueueScope,
  withRequestScopedDb,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
} from '../../db.js';
import { logger } from '../../logger.js';
import { claimDueGreenfieldJobRuns } from './greenfield-job-accessors.js';
import {
  failGreenfieldRun,
  findNextGreenfieldRunnableOrderedSibling,
} from './greenfield-run-accessors.js';
import { buildOwnerEmailWorkspaceFilter } from './scheduler-owner-filter.js';
import { dispatchRun } from './queue-producer.js';
import {
  createTalkRunnerReconcileProbe,
  createTalkRunnerRedispatch,
  runTalkRunnerReconciliation,
  type ReconciliationEnv,
} from './talk-runner-reconciliation.js';

// Number of due jobs to claim per tick. Keeps the scheduled hot path bounded.
const JOB_CLAIM_BATCH_SIZE = 10;

const STUCK_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;
const STUCK_RUN_THRESHOLD_MS = 60 * 60 * 1000;
const STUCK_RUN_SWEEP_LIMIT = 100;

const STRANDED_SIBLING_GRACE_MS = 2 * 60 * 1000;
const STRANDED_SIBLING_SWEEP_LIMIT = 100;
let warnedAboutAppliedTestOnlyOwnerFilter = false;
let warnedAboutIgnoredTestOnlyOwnerFilter = false;

export interface ScheduledTickEnv
  extends DbScopeEnvBindings, ReconciliationEnv {
  DB: { connectionString: string };
  TEST_ONLY_OWNER_EMAIL_PATTERN?: string;
}

type StrandedGreenfieldRun = {
  id: string;
  workspace_id: string;
  talk_id: string;
  response_group_id: string;
};

type StuckQueuedGreenfieldRun = Pick<StrandedGreenfieldRun, 'id'>;

type StuckRunningGreenfieldRun = StrandedGreenfieldRun & {
  talk_mode: 'ordered' | 'parallel';
};

export async function runScheduledTick(
  env: ScheduledTickEnv,
  ctx: RequestExecutionContext,
): Promise<void> {
  return withRequestScopedDb(env.DB.connectionString, ctx, env, async () =>
    withNotifyQueueScope(env, ctx, async () => {
      const ownerEmailPattern = resolveTestOnlyOwnerEmailPattern(env);
      await processClaimableJobs(ownerEmailPattern);
      // Queue-path sweeps (runtime='queue' only — see each query). Do-path runs
      // are owned by the reconciliation pass below, so a completed-but-unsynced
      // do-path run is never false-failed by the 1h sweep, and a do-path queued
      // run is never re-dispatched onto the QUEUE.
      await sweepStuckRunningRuns(ownerEmailPattern);
      await sweepStrandedOrderedSiblings(ownerEmailPattern);
      await sweepStuckQueuedRuns(ownerEmailPattern);
      // Talk Runtime v2 PR-B: path-aware reconciliation of do-path runs. A no-op
      // during the flag-OFF soak (no runtime='do' rows). Best-effort.
      try {
        await runTalkRunnerReconciliation({
          probe: createTalkRunnerReconcileProbe(env),
          redispatch: createTalkRunnerRedispatch(env),
        });
      } catch (err) {
        logger.error({ err }, 'scheduler: talk-runner reconciliation failed');
      }
    }),
  );
}

export function resolveTestOnlyOwnerEmailPattern(
  env: Pick<ScheduledTickEnv, 'TEST_ONLY_OWNER_EMAIL_PATTERN'>,
): string | undefined {
  const pattern = env.TEST_ONLY_OWNER_EMAIL_PATTERN;
  if (!pattern) return undefined;
  if (process.env.NODE_ENV === 'test') {
    if (!warnedAboutAppliedTestOnlyOwnerFilter) {
      warnedAboutAppliedTestOnlyOwnerFilter = true;
      logger.warn(
        { nodeEnv: process.env.NODE_ENV, ownerEmailPattern: pattern },
        'scheduler: applying TEST_ONLY_OWNER_EMAIL_PATTERN under test runtime',
      );
    }
    return pattern;
  }

  if (!warnedAboutIgnoredTestOnlyOwnerFilter) {
    warnedAboutIgnoredTestOnlyOwnerFilter = true;
    logger.warn(
      { nodeEnv: process.env.NODE_ENV ?? null },
      'scheduler: ignored TEST_ONLY_OWNER_EMAIL_PATTERN outside test runtime',
    );
  }
  return undefined;
}

export async function processClaimableJobs(
  ownerEmailPattern?: string,
): Promise<void> {
  try {
    const result = await claimDueGreenfieldJobRuns({
      limit: JOB_CLAIM_BATCH_SIZE,
      ownerEmailPattern,
      onEnqueuedRun: async (runId) => {
        try {
          await dispatchRun({ runId });
        } catch (err) {
          logger.error(
            { err, runId },
            'scheduler: greenfield run dispatch failed after claim',
          );
        }
      },
    });
    const processedCount =
      result.enqueuedRunIds.length +
      result.blockedJobIds.length +
      result.skippedJobIds.length +
      result.busyJobIds.length +
      result.failedJobIds.length;
    if (processedCount > 0) {
      logger.info(
        {
          enqueuedCount: result.enqueuedRunIds.length,
          blockedCount: result.blockedJobIds.length,
          skippedCount: result.skippedJobIds.length,
          busyCount: result.busyJobIds.length,
          failedCount: result.failedJobIds.length,
        },
        'scheduler: processed greenfield due jobs',
      );
    }
  } catch (err) {
    logger.error({ err }, 'scheduler: greenfield due-job claim failed');
  }
}

async function sweepStuckRunningRuns(
  ownerEmailPattern?: string,
): Promise<void> {
  const threshold = new Date(Date.now() - STUCK_RUN_THRESHOLD_MS).toISOString();
  let stuck: StuckRunningGreenfieldRun[];
  try {
    const db = getDbPg();
    const ownerFilter = buildOwnerEmailWorkspaceFilter(
      db,
      ownerEmailPattern,
      'runs',
    );
    stuck = await db<StuckRunningGreenfieldRun[]>`
      select
        r.id,
        r.workspace_id,
        r.talk_id,
        r.response_group_id,
        t.mode as talk_mode
      from public.runs r
      join public.talks t
        on t.workspace_id = r.workspace_id
       and t.id = r.talk_id
      where r.status = 'running'
        -- PR-B: queue-path only. Do-path runs are reconciled against DO truth;
        -- a completed-but-unsynced do-path run must NOT be false-failed here.
        and r.runtime = 'queue'
        and r.started_at is not null
        and r.started_at < ${threshold}::timestamptz
        ${ownerFilter}
      order by r.started_at asc, r.id asc
      limit ${STUCK_RUN_SWEEP_LIMIT}
    `;
  } catch (err) {
    logger.error({ err }, 'scheduler: stuck-running list query failed');
    return;
  }

  for (const run of stuck) {
    try {
      const result = await failGreenfieldRun({
        runId: run.id,
        errorCode: 'stuck_running_swept',
        errorMessage:
          'Run exceeded the 1h stuck-running threshold and was reaped by the scheduler',
      });
      if (result.applied) {
        if (run.talk_mode === 'ordered') {
          await dispatchNextOrderedSibling(run);
        }
      }
    } catch (err) {
      logger.warn(
        { err, runId: run.id },
        'scheduler: stuck-running reap or sibling promotion failed',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { sweptCount: stuck.length },
      'scheduler: stuck-running sweep flipped runs to failed',
    );
  }
}

async function sweepStrandedOrderedSiblings(
  ownerEmailPattern?: string,
): Promise<void> {
  const finishedBefore = new Date(
    Date.now() - STRANDED_SIBLING_GRACE_MS,
  ).toISOString();
  let stranded: StrandedGreenfieldRun[];
  try {
    const db = getDbPg();
    const ownerFilter = buildOwnerEmailWorkspaceFilter(
      db,
      ownerEmailPattern,
      'runs',
    );
    stranded = await db<StrandedGreenfieldRun[]>`
      select r.id, r.workspace_id, r.talk_id, r.response_group_id
      from public.runs r
      join public.talks t
        on t.workspace_id = r.workspace_id
       and t.id = r.talk_id
      where r.status = 'queued'
        -- PR-B: queue-path only. A do-path stranded sibling is the DO's job, not
        -- the queue's (re-dispatching it onto TALK_RUN_QUEUE would bypass the DO).
        and r.runtime = 'queue'
        and t.mode = 'ordered'
        and r.sequence_index > 0
        ${ownerFilter}
        and not exists (
          select 1
          from public.runs prior
          where prior.workspace_id = r.workspace_id
            and prior.talk_id = r.talk_id
            and prior.response_group_id = r.response_group_id
            and prior.sequence_index < r.sequence_index
            and prior.status not in ('completed', 'failed', 'cancelled')
        )
        and (
          select max(prior.finished_at)
          from public.runs prior
          where prior.workspace_id = r.workspace_id
            and prior.talk_id = r.talk_id
            and prior.response_group_id = r.response_group_id
            and prior.sequence_index < r.sequence_index
        ) < ${finishedBefore}::timestamptz
      order by r.created_at asc, r.id asc
      limit ${STRANDED_SIBLING_SWEEP_LIMIT}
    `;
  } catch (err) {
    logger.error({ err }, 'scheduler: stranded-sibling list query failed');
    return;
  }

  for (const run of stranded) {
    await dispatchRun({ runId: run.id });
  }

  if (stranded.length > 0) {
    logger.warn(
      { redispatchedCount: stranded.length },
      'scheduler: re-dispatched ordered siblings stranded by a lost promotion',
    );
  }
}

async function sweepStuckQueuedRuns(ownerEmailPattern?: string): Promise<void> {
  const threshold = new Date(
    Date.now() - STUCK_QUEUED_THRESHOLD_MS,
  ).toISOString();
  let stuck: StuckQueuedGreenfieldRun[];
  try {
    const db = getDbPg();
    const ownerFilter = buildOwnerEmailWorkspaceFilter(
      db,
      ownerEmailPattern,
      'runs',
    );
    stuck = await db<StuckQueuedGreenfieldRun[]>`
      select r.id
      from public.runs r
      join public.talks t
        on t.workspace_id = r.workspace_id
       and t.id = r.talk_id
      where r.status = 'queued'
        -- PR-B: queue-path only (do-path queued runs are re-driven by the DO /
        -- reconciliation, not re-dispatched onto TALK_RUN_QUEUE).
        and r.runtime = 'queue'
        ${ownerFilter}
        and (
          t.mode = 'parallel'
          or not exists (
            select 1
            from public.runs prior
            where prior.workspace_id = r.workspace_id
              and prior.talk_id = r.talk_id
              and prior.response_group_id = r.response_group_id
              and prior.sequence_index < r.sequence_index
              and prior.status in ('queued', 'running', 'awaiting')
          )
        )
        and r.created_at < ${threshold}::timestamptz
      order by r.created_at asc, r.id asc
      limit ${STUCK_RUN_SWEEP_LIMIT}
    `;
  } catch (err) {
    logger.error({ err }, 'scheduler: stuck-queued list query failed');
    return;
  }

  for (const run of stuck) {
    try {
      await dispatchRun({ runId: run.id });
    } catch (err) {
      logger.error(
        { err, runId: run.id },
        'scheduler: stale queued run redispatch failed',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { redispatchedCount: stuck.length },
      'scheduler: re-dispatched queued runs stranded by lost queue delivery',
    );
  }
}

async function dispatchNextOrderedSibling(input: {
  workspace_id: string;
  talk_id: string;
  response_group_id: string;
}): Promise<void> {
  const nextRunId = await findNextGreenfieldRunnableOrderedSibling({
    workspaceId: input.workspace_id,
    talkId: input.talk_id,
    responseGroupId: input.response_group_id,
  });
  if (nextRunId) await dispatchRun({ runId: nextRunId });
}
