// Talk-run queue consumer (Queues port U1 — scaffold).
//
// U1 ships the dispatcher skeleton + ack/retry decisions. The real
// `executeRun` port from `run-worker.ts` lands in U3, when the
// processTalkRunMessage body actually claims the run row, opens
// `withUserContext`, and invokes the executor. Until then the
// consumer logs the runId and acks — useful for U1's smoke test
// (`wrangler queues consumer send …`) and CI vitest harness.

import { logger } from '../../logger.js';

export interface ProcessTalkRunMessageInput {
  runId: string;
}

/**
 * Stateless per-message handler. The queue() dispatcher in
 * `src/worker.ts` calls this once per message. U3 replaces the body
 * with the real run executor.
 *
 * Contract:
 * - Throws on transient failure → message.retry() at the caller.
 * - Returns normally on terminal success / no-op (run already
 *   completed, cancelled, missing) → message.ack() at the caller.
 * - Permanent failures should be caught inside the body and recorded
 *   on the run row rather than rethrown — see U3.
 */
export async function processTalkRunMessage(
  input: ProcessTalkRunMessageInput,
): Promise<void> {
  logger.info(
    { runId: input.runId, phase: 'u1-scaffold' },
    'processTalkRunMessage (U1 stub) — acking without execution',
  );
}
