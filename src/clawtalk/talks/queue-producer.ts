// Talk-run queue producer (Queues port U1).
//
// Replaces the Node-mode `opts.runWorker.wake()` call sites. The
// payload is intentionally minimal — `{ runId }`. The DB is the system
// of record for run state, so consumers always re-read fresh state
// when they pick the message up (status: queued / running /
// completed / failed / cancelled). See queues-port-plan §2.
//
// `dispatchRun` swallows send failures and logs — the run row is
// already durably 'queued' by the surrounding tx, and the cron-trigger
// stuck-run sweep (U4) picks up anything the queue loses.

import { getRequestScopeEnvAndCtx } from '../../db.js';
import { logger } from '../../logger.js';

export interface DispatchRunInput {
  runId: string;
}

/**
 * Send `{ runId }` onto TALK_RUN_QUEUE. Pulls the Worker env binding
 * out of the W7-evtsse request scope so accessor / route call sites
 * don't have to thread `env` through their signatures.
 *
 * Failure mode: logs and returns. Callers MUST have already committed
 * the `talk_runs` row to 'queued' state. The cron-trigger sweep picks
 * up any rows the queue dropped on the floor.
 */
export async function dispatchRun(input: DispatchRunInput): Promise<void> {
  const { env } = getRequestScopeEnvAndCtx();
  const queue = env?.TALK_RUN_QUEUE;
  if (!queue) {
    logger.warn(
      { runId: input.runId },
      'dispatchRun called without TALK_RUN_QUEUE binding — run row durable, not dispatched',
    );
    return;
  }
  try {
    await queue.send({ runId: input.runId }, { contentType: 'json' });
  } catch (err) {
    logger.warn(
      { err, runId: input.runId },
      'TALK_RUN_QUEUE.send failed — run row durable, will be retried by sweep',
    );
  }
}
