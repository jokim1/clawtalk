// Write-behind persistence for the TalkRunner DO (Talk Runtime v2, Wave 2
// PR-B). docs/13-talk-runtime-v2.md §6.1 / §6.3 (write-behind contract, 3A).
//
// The DO's SQLite state machine (A1–A3) is the liveness spine and the source of
// truth for execution progress. Postgres is the SYSTEM OF RECORD for everything
// user-facing (runs.status, messages) — but no longer the liveness spine: a
// Postgres blip delays persistence, never the conversation. This module mirrors
// the DO's durable terminal truth into Postgres.
//
// The contract (docs/13 §6.3 "Write-behind contract"):
//   • Every Postgres write is idempotent + MONOTONIC (running → terminal once,
//     never terminal → terminal, never terminal → running). The reuse of the
//     existing accessors gives this for free: each guards on
//     `where status='running'` (or `in ('queued','running','awaiting')` for
//     cancel) inside its tx, so a re-flush after a committed terminal is a
//     no-op (applied:false) with NO second outbox event.
//   • The terminal persist is AWAITED with bounded retry BEFORE the terminal
//     event is emitted. Because the accessors insert the terminal event in the
//     SAME tx as the state change (insert-before-push, 3A) and only on a winning
//     CAS, "state persisted" and "event emitted" are atomic — there is no window
//     where the snapshot lies (event seen but PG still running). A Postgres
//     outage just means the persist throws and is retried; nothing is emitted
//     until it commits.
//
// The DO talks to Postgres ONLY through this seam (a RunStatePersister). The
// default implementation wraps the accessors; tests inject a fake, because the
// workers test pool has no Postgres binding (DO SQLite only). That split is what
// lets the DO-orchestration tests (retry / ordering / cancel-race / restart
// re-flush) run in the workers pool while the real-accessor + snapshot
// behaviour is proven in the node pool against local Postgres.

import { logger } from '../../logger.js';
import type { TalkExecutionUsage } from './executor.js';
import {
  cancelGreenfieldRunForDo,
  completeGreenfieldRun,
  failGreenfieldRun,
  markGreenfieldRunRunning,
  type GreenfieldQueueRunRecord,
} from './greenfield-run-accessors.js';

// The payload needed to persist a completed run + its response message. Stored
// reference-based in the step checkpoint (text/metadata only, never inlined
// binary), so a restart can re-flush WITHOUT re-running the executor. The
// responseMessageId is generated once and reused across re-flushes so the
// message insert is stable (the accessor's status-CAS already dedups, this is
// belt-and-suspenders).
export interface RunCompletedPayload {
  runId: string;
  responseMessageId: string;
  responseContent: string;
  responseMetadata: Record<string, unknown> | null;
  agentId: string | null;
  agentNickname: string | null;
  providerId: string | null;
  modelId: string | null;
  latencyMs: number | null;
  usage: TalkExecutionUsage | null;
  responseSequenceInRun: number | null;
}

export type ClaimRunningResult =
  | { status: 'claimed'; run: GreenfieldQueueRunRecord }
  | { status: 'blocked_by_sibling' }
  | { status: 'already_running' }
  | { status: 'terminal' }
  | { status: 'not_found' };

/**
 * The DO's only door to Postgres for run/message state. Every method is
 * idempotent + monotonic at the Postgres layer (see module header). The default
 * implementation wraps the accessors; tests inject fakes.
 */
export interface RunStatePersister {
  // Non-terminal: claim queued → running (+ talk_run_started). Returns the run
  // record the executor needs. Eager (before streaming) so talk_run_started
  // precedes the response deltas — matching the v1 event order (zero frontend
  // changes).
  claimRunning(runId: string): Promise<ClaimRunningResult>;
  // Terminal flushes (awaited + bounded-retried by the caller). Each returns
  // whether THIS call applied the transition; false = already terminal in PG
  // (idempotent no-op, no event re-emitted).
  persistCompleted(payload: RunCompletedPayload): Promise<{ applied: boolean }>;
  persistFailed(input: {
    runId: string;
    errorCode: string;
    errorMessage: string;
    metadataPatch?: Record<string, unknown> | null;
  }): Promise<{ applied: boolean }>;
  persistCancelled(input: {
    runId: string;
    cancelledBy?: string | null;
  }): Promise<{ applied: boolean }>;
}

/**
 * Production persister: thin wrappers over the accessors. failGreenfieldRun is
 * called with requeueOnError:false (the DO owns the run; it must not be handed
 * back to the queue — see the accessor's comment).
 */
export function createDefaultRunStatePersister(): RunStatePersister {
  return {
    claimRunning: (runId) => markGreenfieldRunRunning(runId),
    persistCompleted: (payload) => completeGreenfieldRun(payload),
    persistFailed: (input) =>
      failGreenfieldRun({ ...input, requeueOnError: false }),
    persistCancelled: (input) => cancelGreenfieldRunForDo(input),
  };
}

export interface BoundedRetryOptions {
  // Total attempts (>=1). The terminal flush gives up after this many and
  // leaves the DO row unsynced for the reconciliation cron / next-invocation
  // re-flush backstop.
  attempts: number;
  baseDelayMs?: number;
  label: string;
  // Test seam — replace the real delay so retries don't add wall-clock to tests.
  sleep?: (ms: number) => Promise<void>;
  onAttemptError?: (err: unknown, attempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with bounded retry on throw. Returns its result on the first
 * success; rethrows the last error after exhausting all attempts. Used to wrap
 * the AWAITED terminal persist so a transient Postgres failure (the outage
 * case) is retried before the DO leaves the row unsynced.
 *
 * NOTE: this retries on THROWN errors only. A persister returning
 * `{applied:false}` (an idempotent no-op — already terminal in PG) is a
 * SUCCESS, not a retryable failure.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  opts: BoundedRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts);
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttemptError?.(err, attempt);
      logger.warn(
        { err, attempt, attempts, label: opts.label },
        'write-behind persist attempt failed',
      );
      if (attempt < attempts) {
        // Linear backoff; small by design (this is the interactive terminal
        // flush, not a batch job).
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  throw lastErr;
}
