// Cron-trigger scheduler.
//
// The greenfield scheduler has two responsibilities:
//   1. fire due rows from `jobs` into normal `runs` (next slice),
//   2. maintain the run state machine safety nets every minute.
//
// This slice ports the safety nets off the removed legacy tables. The tick no
// longer references `talk_jobs`, `talk_runs`, or threads, so enabling the fresh
// baseline does not make cron spam table-missing errors.

import {
  getDbPg,
  type Sql,
  withNotifyQueueScope,
  withRequestScopedDb,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
} from '../../db.js';
import { logger } from '../../logger.js';
import {
  failGreenfieldRun,
  findNextGreenfieldRunnableOrderedSibling,
  getGreenfieldQueueRunById,
} from './greenfield-run-accessors.js';
import { emitOutboxEventOnSql, enqueueOutboxNotify } from './outbox-emit.js';
import { dispatchRun } from './queue-producer.js';

// Number of due jobs to inspect per tick once job firing lands. Kept here so
// the scheduled hot path has a fixed cap before the full §12 Path A port.
const JOB_CLAIM_BATCH_SIZE = 10;

const STUCK_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;
const STUCK_RUN_THRESHOLD_MS = 60 * 60 * 1000;
const STUCK_RUN_SWEEP_LIMIT = 100;

const STRANDED_SIBLING_GRACE_MS = 2 * 60 * 1000;
const STRANDED_SIBLING_SWEEP_LIMIT = 100;

export interface ScheduledTickEnv extends DbScopeEnvBindings {
  DB: { connectionString: string };
}

type StrandedGreenfieldRun = {
  id: string;
  workspace_id: string;
  talk_id: string;
  response_group_id: string;
};

type StuckQueuedGreenfieldRun = StrandedGreenfieldRun & {
  talk_mode: 'ordered' | 'parallel';
};

type StuckRunningGreenfieldRun = StrandedGreenfieldRun & {
  talk_mode: 'ordered' | 'parallel';
};

export async function runScheduledTick(
  env: ScheduledTickEnv,
  ctx: RequestExecutionContext,
): Promise<void> {
  return withRequestScopedDb(env.DB.connectionString, ctx, env, async () =>
    withNotifyQueueScope(env, ctx, async () => {
      await processClaimableJobs();
      await sweepStuckRunningRuns();
      await sweepStrandedOrderedSiblings();
      await sweepStuckQueuedRuns();
    }),
  );
}

export async function processClaimableJobs(): Promise<void> {
  try {
    const db = getDbPg();
    const due = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.jobs
      where status = 'active'
        and archived_at is null
        and next_due_at is not null
        and next_due_at <= now()
      limit ${JOB_CLAIM_BATCH_SIZE}
    `;
    const dueCount = due[0]?.count ?? 0;
    if (dueCount > 0) {
      logger.warn(
        { dueCount },
        'scheduler: greenfield job firing is not wired yet; due jobs left untouched',
      );
    }
  } catch (err) {
    logger.error({ err }, 'scheduler: greenfield due-job probe failed');
  }
}

async function sweepStuckRunningRuns(): Promise<void> {
  const threshold = new Date(Date.now() - STUCK_RUN_THRESHOLD_MS).toISOString();
  let stuck: StuckRunningGreenfieldRun[];
  try {
    const db = getDbPg();
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
        and r.started_at is not null
        and r.started_at < ${threshold}::timestamptz
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
        await markGreenfieldJobRunFinished(run.id, 'failed');
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

async function sweepStrandedOrderedSiblings(): Promise<void> {
  const finishedBefore = new Date(
    Date.now() - STRANDED_SIBLING_GRACE_MS,
  ).toISOString();
  let stranded: StrandedGreenfieldRun[];
  try {
    const db = getDbPg();
    stranded = await db<StrandedGreenfieldRun[]>`
      select r.id, r.workspace_id, r.talk_id, r.response_group_id
      from public.runs r
      join public.talks t
        on t.workspace_id = r.workspace_id
       and t.id = r.talk_id
      where r.status = 'queued'
        and t.mode = 'ordered'
        and r.sequence_index > 0
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

async function sweepStuckQueuedRuns(): Promise<void> {
  const threshold = new Date(
    Date.now() - STUCK_QUEUED_THRESHOLD_MS,
  ).toISOString();
  let stuck: StuckQueuedGreenfieldRun[];
  try {
    const db = getDbPg();
    stuck = await db<StuckQueuedGreenfieldRun[]>`
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
      where r.status = 'queued'
        and (t.mode = 'parallel' or r.sequence_index = 0)
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
      if (await failQueuedGreenfieldRun(run.id)) {
        await markGreenfieldJobRunFinished(run.id, 'failed');
        if (run.talk_mode === 'ordered') {
          await dispatchNextOrderedSibling(run);
        }
      }
    } catch (err) {
      logger.warn(
        { err, runId: run.id },
        'scheduler: stuck-queued reap or sibling promotion failed',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { sweptCount: stuck.length },
      'scheduler: stuck-queued sweep flipped runs to failed',
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

async function failQueuedGreenfieldRun(runId: string): Promise<boolean> {
  const db = getDbPg();
  const run = await getGreenfieldQueueRunById(runId);
  if (!run || run.status !== 'queued') return false;

  const pendingNotify = await db.begin(async (tx) => {
    const txSql = tx as unknown as Sql;
    const updated = await txSql<Array<{ id: string }>>`
      update public.runs
      set
        status = 'failed',
        finished_at = now(),
        error_json = jsonb_build_object(
          'code', 'stuck_queued_swept',
          'message', 'Run exceeded the 5m stuck-queued threshold and was reaped by the scheduler'
        )
      where id = ${runId}::uuid
        and status = 'queued'
      returning id
    `;
    if (updated.length !== 1) return null;

    const eventId = await emitOutboxEventOnSql(txSql, {
      topic: `talk:${run.talk_id}`,
      eventType: 'talk_run_failed',
      payload: {
        talkId: run.talk_id,
        threadId: run.talk_id,
        runId: run.id,
        runKind: run.run_kind,
        triggerMessageId: run.trigger_message_id,
        responseGroupId: run.response_group_id,
        sequenceIndex: run.sequence_index,
        errorCode: 'stuck_queued_swept',
        errorMessage:
          'Run exceeded the 5m stuck-queued threshold and was reaped by the scheduler',
        executorAlias: run.target_agent_name,
        executorModel: run.model_id,
      },
      ownerIds: run.owner_ids,
    });
    return {
      topic: `talk:${run.talk_id}`,
      eventId,
      ownerIds: run.owner_ids,
    };
  });
  if (!pendingNotify) return false;
  enqueueOutboxNotify(pendingNotify);
  return true;
}

async function markGreenfieldJobRunFinished(
  runId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  const db = getDbPg();
  await db`
    update public.jobs j
    set
      last_run_at = r.finished_at,
      last_run_status = ${status},
      run_count = run_count + 1
    from public.runs r
    where r.id = ${runId}::uuid
      and r.job_id = j.id
      and r.finished_at is not null
  `;
}
