// Path-aware reconciliation pass (Talk Runtime v2, Wave 2 PR-B).
//
// docs/13 §6.1 / §6.3: "A reconciliation cron replaces today's sweeps: it flags
// queued/running rows in Postgres whose DO state disagrees." It is PATH-AWARE —
// it touches ONLY runtime='do' runs. Queue-path runs (runtime='queue') stay
// owned by the existing scheduler sweeps; during the flag-OFF soak EVERY run is
// queue-path, so this pass scans nothing (zero false alarms — the core
// requirement: "queue-path runs have NO DO state — do NOT flag them").
//
// For each do-path run Postgres still shows queued/running past a grace, it
// pings the run's TalkRunner DO (/reconcile). The DO is the source of truth:
//   • terminal-in-DO-but-unsynced → the DO re-flushes it ('flushed');
//   • still running in the DO       → 'noop_running' (leave it in flight);
//   • the DO has NO record (orphaned)→ fail the run (flag it visible).
// Probing also triggers DO startup recovery (constructing the DO scans in-flight
// runs), so a recoverable run RESUMES rather than being flagged.

import { getDbPg } from '../../db.js';
import { logger } from '../../logger.js';
import { failGreenfieldRunOrphaned } from './greenfield-run-accessors.js';

export type ReconcileAction =
  | 'flushed'
  | 'noop_synced'
  | 'noop_running'
  | 'flush_failed'
  | 'no_record'
  | 'probe_error';

// Probe a single run's DO. Injectable so the node-pool test can drive the pass
// without a real DO (the workers pool has no Postgres, and node has no DO).
export interface ReconcileProbe {
  (input: { talkId: string; runId: string }): Promise<{
    action: ReconcileAction;
    status: string | null;
  }>;
}

// Re-dispatch a forgotten do-path run to its DO (DO /start with one run).
// Injectable for the same reason as the probe. Used to RE-DRIVE — not flag — a
// no_record QUEUED head run: an ordered sibling the DO forgot when it was
// evicted mid-round (its in-memory loop is gone, and startup recovery only
// resumes the run that had a runs_local row). Re-driving recovers it; failing it
// would kill a valid ordered run.
export interface ReconcileRedispatch {
  (input: { talkId: string; runId: string }): Promise<void>;
}

export interface ReconciliationEnv {
  TALK_RUNNER?: {
    idFromName(name: string): unknown;
    get(id: unknown): {
      fetch(input: string, init?: RequestInit): Promise<Response>;
    };
  };
}

const DEFAULT_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_LIMIT = 100;

// Production probe: fetch the per-Talk DO's /reconcile route (idFromName(talkId)).
export function createTalkRunnerReconcileProbe(
  env: ReconciliationEnv,
): ReconcileProbe {
  return async ({ talkId, runId }) => {
    const ns = env.TALK_RUNNER;
    if (!ns) return { action: 'probe_error', status: null };
    try {
      const stub = ns.get(ns.idFromName(talkId));
      const res = await stub.fetch(
        `https://talk-runner.internal/reconcile?runId=${encodeURIComponent(runId)}`,
      );
      const body = (await res.json()) as {
        ok?: boolean;
        data?: { action?: ReconcileAction; status?: string | null };
      };
      if (!body.ok || !body.data?.action) {
        return { action: 'probe_error', status: null };
      }
      return { action: body.data.action, status: body.data.status ?? null };
    } catch (err) {
      logger.warn({ err, talkId, runId }, 'reconciliation probe failed');
      return { action: 'probe_error', status: null };
    }
  };
}

// Production re-dispatch: DO /start with the single forgotten run.
export function createTalkRunnerRedispatch(
  env: ReconciliationEnv,
): ReconcileRedispatch {
  return async ({ talkId, runId }) => {
    const ns = env.TALK_RUNNER;
    if (!ns) return;
    const stub = ns.get(ns.idFromName(talkId));
    await stub.fetch('https://talk-runner.internal/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [runId] }),
    });
  };
}

interface ReconcileCandidate {
  id: string;
  talk_id: string;
  status: string;
}

export interface ReconciliationResult {
  scanned: number;
  flushed: number;
  flagged: number;
  redispatched: number;
  noopRunning: number;
  other: number;
}

/**
 * Run one reconciliation pass over do-path runs. Reads via getDbPg (the caller —
 * the scheduler tick — provides the request scope). Returns tallies for
 * observability. Never throws (a probe/fail error on one run does not abort the
 * rest; the next tick retries).
 */
export async function runTalkRunnerReconciliation(input: {
  probe: ReconcileProbe;
  redispatch: ReconcileRedispatch;
  graceMs?: number;
  limit?: number;
}): Promise<ReconciliationResult> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const threshold = new Date(Date.now() - graceMs).toISOString();
  const result: ReconciliationResult = {
    scanned: 0,
    flushed: 0,
    flagged: 0,
    redispatched: 0,
    noopRunning: 0,
    other: 0,
  };

  let candidates: ReconcileCandidate[];
  try {
    const db = getDbPg();
    // PATH-AWARENESS lives in this WHERE clause: only runtime='do'. (Mutation-
    // verified in the test — dropping the runtime filter flags queue-path runs.)
    //
    // The grace is per-STATUS to avoid orphan-failing a just-started run: a
    // 'running' run is graced on started_at (there is an await gap after runOne
    // claims Postgres 'running' before driveRun writes runs_local; probing in
    // that window returns no_record), a 'queued' run on created_at. Gating
    // running on created_at would make an ordered sibling that only just became
    // running — but whose round started long ago — instantly eligible and
    // permanently orphan-failed.
    //
    // Ordered-sibling safety: in an ordered do-path round the DO runs the round's
    // runs SEQUENTIALLY, so a later sibling sits 'queued' with NO DO record until
    // the loop reaches it — it is legitimately blocked, not orphaned. Exclude a
    // queued run that still has an earlier non-terminal sibling in its response
    // group (mirrors the queue-path stranded-sibling sweep).
    candidates = await db<ReconcileCandidate[]>`
      select r.id, r.talk_id, r.status
      from public.runs r
      where r.runtime = 'do'
        and (
          (
            r.status = 'running'
            and r.started_at is not null
            and r.started_at < ${threshold}::timestamptz
          )
          or (
            r.status = 'queued'
            and r.created_at < ${threshold}::timestamptz
            and not exists (
              select 1
              from public.runs prior
              where prior.workspace_id = r.workspace_id
                and prior.talk_id = r.talk_id
                and prior.response_group_id = r.response_group_id
                and prior.sequence_index < r.sequence_index
                and prior.status not in ('completed', 'failed', 'cancelled')
            )
          )
        )
      order by r.created_at asc, r.id asc
      limit ${limit}
    `;
  } catch (err) {
    logger.error({ err }, 'reconciliation: candidate query failed');
    return result;
  }

  result.scanned = candidates.length;
  for (const run of candidates) {
    let action: ReconcileAction;
    try {
      ({ action } = await input.probe({ talkId: run.talk_id, runId: run.id }));
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'reconciliation: probe threw');
      result.other += 1;
      continue;
    }
    if (action === 'flushed') {
      result.flushed += 1;
    } else if (action === 'no_record') {
      if (run.status === 'queued') {
        // The DO has no record of a QUEUED do-path run. Candidate selection
        // already excluded blocked siblings, so this is the head — a run the DO
        // forgot (an ordered sibling lost to eviction mid-round; the in-memory
        // loop is gone and startup recovery only resumes runs with a runs_local
        // row) or one whose /start never reached the DO. RE-DRIVE it rather than
        // failing it; runOne's claim is idempotent if it has actually started.
        try {
          await input.redispatch({ talkId: run.talk_id, runId: run.id });
          result.redispatched += 1;
        } catch (err) {
          logger.warn(
            { err, runId: run.id },
            'reconciliation: re-dispatch failed; will retry next tick',
          );
        }
      } else {
        // A RUNNING do-path run the DO lost: it started but its step log is gone.
        // Re-running a partially-streamed turn risks duplicate output, so flag it
        // failed (the user retries) rather than re-drive.
        try {
          const failed = await failGreenfieldRunOrphaned({ runId: run.id });
          if (failed.applied) result.flagged += 1;
        } catch (err) {
          logger.warn(
            { err, runId: run.id },
            'reconciliation: orphan flag failed',
          );
        }
      }
    } else if (action === 'noop_running') {
      result.noopRunning += 1;
    } else {
      // noop_synced (a PG-vs-DO anomaly worth surfacing), flush_failed (retry
      // next tick), probe_error (DO unreachable) — leave for the next tick.
      if (action === 'noop_synced') {
        logger.warn(
          { runId: run.id },
          'reconciliation: DO reports synced but PG still active',
        );
      }
      result.other += 1;
    }
  }

  if (result.scanned > 0) {
    logger.info(result, 'reconciliation: do-path pass complete');
  }
  return result;
}
