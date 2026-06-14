// TalkRunner — per-Talk Durable Object that owns run execution.
//
// Talk Runtime v2, Wave 2 PR-A1 + PR-A2 (docs/13-talk-runtime-v2.md
// §6.1/§6.3/§6.4; ~/.claude/plans/encapsulated-plotting-mist.md). One instance
// per Talk (idFromName(talkId), D1). Built so far:
//
//   • DO SQLite schema (the plan's sketch, verbatim): runs_local / steps /
//     step_deadlines.                                                  [A1]
//   • The step state machine PENDING → RUNNING → CHECKPOINT → terminal
//     (one LLM streaming call OR one tool batch = one step, 8A).       [A1]
//   • A dev-only route (/dev/run) that drives ONE run end-to-end by reusing
//     GreenfieldTalkExecutor UNCHANGED, inside the DO's own request-scoped
//     DB. Not wired to /chat.                                          [A1]
//   • Reference-based checkpoints with a hard <1MB serialized assert (8A —
//     the DO SQLite value cap is 2MB; an inlined provider message array
//     with PDF pages blows it).                                        [A1]
//   • CAS-fencing-ready writes: every post-await checkpoint/failure write
//     is guarded on (run_id, idx, attempt, status='running'), so a late
//     write from an attempt the watchdog already failed is a no-op.    [A1]
//   • Min-deadline alarm watchdog (1A): the single DO alarm always targets
//     min(step_deadlines.deadline_ms); alarm() fails every expired step and
//     re-arms to the next-earliest. Correct under in-DO concurrency (N
//     parallel runs) because the table — not per-step setAlarm — is the
//     source of truth.                                                 [A2]
//   • Startup + alarm resume (4A): the constructor scans in-flight runs and
//     recovers each through resumeRun, the ONE idempotent recovery function
//     the alarm also uses. Resume re-runs at most the one interrupted step.
//                                                                      [A2]
//   • Cancel RPC (F8): a direct method (no DB polling) that flips the run
//     terminal in the same isolate that owns it, aborts the live attempt, and
//     clears its deadlines.                                            [A3]
//   • Per-attempt fencing: claimStep bumps the step attempt on every (re)entry,
//     and every post-await step write CAS-guards on (run_id, idx, attempt,
//     step.status='running', run.status='running'). An abandoned attempt — one
//     the watchdog retried, or whose run was cancelled — that resolves late
//     writes NOTHING (the durable analog of #609's runAbandoned guard).  [A3]
//   • Watchdog RETRY: on an expired step the alarm re-drives a fresh attempt
//     (bounded by MAX_STEP_ATTEMPTS) instead of only failing; the wedged
//     attempt is disowned and fenced. Needs a rebuildable plan, so in prod it
//     is inert until PR-B wires planProvider (A3 keeps the A2 fail behavior
//     when planProvider is null; tests inject it to exercise the fence). [A3]
//
// EXPLICITLY NOT here yet (do not read this as production-complete):
//   • A rebuildable plan for resume/retry after a real eviction — A3 is
//     DO-LOCAL: planProvider stays null until PR-B wires the Postgres rebuild.
//     Resume/retry of a run it cannot rebuild fails or no-ops and logs
//     (alarm/reconciliation backstop).
//   • Cancel/fencing DURABILITY beyond DO SQLite: cancel correctness here is
//     DO-LOCAL. Visibility to Postgres / UI / the hub / reconciliation is PR-B,
//     and the real /chat route is PR-C — do NOT read A3 as production cancel.
//   • Write-behind batching + insert-before-push hub streaming (3A) — PR-B.
//     The /dev/run route persists run lifecycle SYNCHRONOUSLY via the same
//     v1 accessors the queue consumer uses (markGreenfieldRunRunning /
//     completeGreenfieldRun); that is NOT the v2 write-behind contract. The
//     "event emission" leg of the fence (docs/13 §6.4 PR-A) lands with the
//     emission itself in PR-B, guarded by the same per-attempt CAS pattern.
//
// Mirrors the production DO precedent in user-event-hub.ts: local CF type
// shims (no repo-wide @cloudflare/workers-types), schema + recovery under
// blockConcurrencyWhile in the constructor, alarm() as the durable backstop.

import {
  type DbScopeEnvBindings,
  withNotifyQueueScope,
  withRequestScopedDb,
} from '../../db.js';
import { logger } from '../../logger.js';

import { GreenfieldTalkExecutor } from './greenfield-executor.js';
import {
  completeGreenfieldRun,
  failGreenfieldRun,
  getGreenfieldQueueRunById,
  getGreenfieldRunPromptSnapshotText,
  getGreenfieldTriggerMessageById,
  markGreenfieldRunRunning,
} from './greenfield-run-accessors.js';
import {
  stripInternalTalkResponseText,
  stripLeadingAgentLabel,
} from './internal-tags.js';
import { TalkExecutorError } from './executor.js';
import type {
  TalkExecutionEvent,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';

// ─── Cloudflare DO surface types (minimal local shims) ──────────────────
//
// Mirrors user-event-hub.ts. TalkRunner is the first DO to use the SQL
// storage API (state.storage.sql), so the shim extends the storage shape
// with the `sql` member. Cursors are synchronous in DO SQLite.

interface SqlStorageCursorLike<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
  readonly rowsRead: number;
}

interface SqlStorageLike {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T>;
}

interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike;
  setAlarm(when: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectStateLike {
  readonly id: { readonly name?: string };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  readonly storage: DurableObjectStorageLike;
}

// The DO env carries the same bindings the main Worker env does — Hyperdrive
// (DB), the event-hub URL, the hub namespace, the run queue, and the
// attachments bucket — because DO bindings are script-wide. Only the subset
// the executor's request scope needs is declared.
export interface TalkRunnerEnv extends DbScopeEnvBindings {
  DB: { connectionString: string };
  // Dev-route kill switch. The route is unreachable unless this is set, and
  // it is never set in prod (absent from wrangler.toml [vars]); local dev
  // sets it via .dev.vars. Belt-and-suspenders over the Worker-side auth +
  // env gate that fronts this DO.
  CLAWTALK_DEV_TALK_RUNNER?: string;
}

// ─── Tunables ───────────────────────────────────────────────────────────

// 8A: serialized checkpoint hard ceiling. DO SQLite caps a single value at
// 2MB; checkpoints are reference-based (text/structure + R2 keys, never
// inlined binary), so 1MB is a generous structural guard with headroom.
export const MAX_CHECKPOINT_BYTES = 1_000_000;

// Per-step deadline defaults (recorded into step_deadlines; A2 arms the
// alarm off min(deadline_ms)). An LLM streaming step can be long; a tool
// batch should be quicker. These are the A1 placeholders — the right
// per-step budget table is an open A2 question (docs/13 §9).
const DEFAULT_STEP_DEADLINE_MS: Record<StepKind, number> = {
  llm: 5 * 60 * 1000,
  tools: 60 * 1000,
};

// Max executions of a single step before the watchdog gives up and fails the
// run (1 = the original attempt + 1 retry). Bounds the alarm RETRY path so a
// step that wedges every attempt can't loop forever. A3 keeps this small; the
// right per-kind retry budget is an open PR-B question (docs/13 §9).
const MAX_STEP_ATTEMPTS = 2;

// ─── Step / run model ───────────────────────────────────────────────────

export type StepKind = 'llm' | 'tools';
export type StepStatus = 'pending' | 'running' | 'checkpoint' | 'failed';
// A run is created 'running' and moves straight to a terminal state. ('pending'
// is a STEP state, not a run state.) 'cancelled' is the A3 cancel RPC's terminal
// status; markRunTerminal applies every terminal transition monotonically
// (running → terminal only), so cancel can't be overwritten by a late
// completed/failed, nor vice-versa.
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One unit of run work — a single LLM streaming call or a single tool batch
 * (8A granularity). `execute` does the actual I/O; its return value's
 * `checkpoint` is the reference-based resume payload persisted on success.
 * The plan is built by the caller (the dev route builds a one-step plan
 * around the real executor; tests inject deterministic multi-step plans).
 */
export interface TalkRunnerStep {
  kind: StepKind;
  // Optional per-step budget override; defaults per kind. Recorded now,
  // enforced by the A2 alarm.
  deadlineMs?: number;
  execute(signal: AbortSignal): Promise<TalkRunnerStepResult>;
}

export interface TalkRunnerStepResult {
  // Reference-based (8A): text/structure + R2 keys, NOT inlined blobs.
  // Serialized with a hard <1MB assert before it touches SQLite.
  checkpoint: unknown;
}

export type TalkRunnerRunPlan = TalkRunnerStep[];

/**
 * Rebuilds the step plan for an in-flight run so the resume path (4A) can
 * re-enter the step machine after a DO restart, when the in-memory plan
 * closures are gone. A1/A2 are DO-LOCAL: this stays null in production until
 * PR-B wires it to the Postgres-backed rebuild that `runRealExecutor` already
 * does inline (trigger message / prompt snapshot → executor plan). Tests
 * inject it directly. Returns null when the run can't be rebuilt (left for the
 * alarm backstop / reconciliation cron).
 */
export type TalkRunnerPlanProvider = (
  runId: string,
) => Promise<TalkRunnerRunPlan | null>;

export type RunOutcome =
  | { status: 'completed'; steps: number }
  | { status: 'failed'; failedStepIdx: number }
  // A step's post-await write lost the CAS race: the alarm watchdog, or a
  // competing retry attempt (A3), already settled the step, so this invocation
  // abandons the run to whoever owns the terminal state.
  | { status: 'abandoned'; abandonedStepIdx: number }
  // The run was cancelled out from under this invocation (A3 cancel RPC). Like
  // 'abandoned' (this invocation stops writing) but names the cause, so the
  // caller persists a cancel rather than a failure.
  | { status: 'cancelled' };

// Persisted row shapes (mirror the schema below).
interface RunLocalRow {
  run_id: string;
  status: RunStatus;
  started_at: number;
  updated_at: number;
}
interface StepRow {
  run_id: string;
  idx: number;
  kind: StepKind;
  status: StepStatus;
  attempt: number;
  checkpoint_json: string | null;
  deadline_ms: number | null;
}
interface StepDeadlineRow {
  run_id: string;
  idx: number;
  deadline_ms: number;
}

export class TalkRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TalkRunnerError';
  }
}

// ─── DO class ───────────────────────────────────────────────────────────

export class TalkRunner {
  private state: DurableObjectStateLike;
  private env: TalkRunnerEnv;
  private get sql(): SqlStorageLike {
    return this.state.storage.sql;
  }

  // Live runs owned by THIS isolate. Two jobs: (1) the alarm/cancel path
  // reaches the in-flight AbortController to abort a wedged step; (2) a
  // concurrent executeRun for the same run dedups to the live promise instead
  // of starting a second invocation (the re-entry/idempotency guard). Empty
  // after a restart — recovery then runs from durable SQLite, not memory.
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; done: Promise<RunOutcome> }
  >();

  // 4A resume seam. Null in A1/A2 (DO-local); PR-B sets it to the Postgres
  // rebuild. The resume path no-ops (and logs) a run it cannot rebuild.
  public planProvider: TalkRunnerPlanProvider | null = null;

  constructor(state: DurableObjectStateLike, env: TalkRunnerEnv) {
    this.state = state;
    this.env = env;
    // Schema must exist before any method touches storage, and the 4A startup
    // resume scan must run before any incoming fetch()/RPC sees stale in-flight
    // rows. blockConcurrencyWhile defers all delivery (including alarm()) until
    // both finish. NB: never throw out of this block — it resets the DO
    // (user-event-hub.ts precedent); recoverInFlightRuns swallows per-run errors.
    void this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      await this.recoverInFlightRuns();
    });
  }

  // DO SQLite schema — verbatim from the plan sketch (encapsulated-plotting-mist.md):
  //   runs_local(run_id pk, status, started_at, updated_at)
  //   steps(run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms, pk(run_id,idx))
  //   step_deadlines(run_id, idx, deadline_ms, pk(run_id,idx))   -- 1A: alarm = min(deadline_ms)
  private ensureSchema(): void {
    this.sql.exec(
      `create table if not exists runs_local (
         run_id text primary key,
         status text not null,
         started_at integer not null,
         updated_at integer not null
       )`,
    );
    this.sql.exec(
      `create table if not exists steps (
         run_id text not null,
         idx integer not null,
         kind text not null,
         status text not null,
         attempt integer not null,
         checkpoint_json text,
         deadline_ms integer,
         primary key (run_id, idx)
       )`,
    );
    this.sql.exec(
      `create table if not exists step_deadlines (
         run_id text not null,
         idx integer not null,
         deadline_ms integer not null,
         primary key (run_id, idx)
       )`,
    );
  }

  // ─── HTTP surface ──────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/dev/run':
        return this.handleDevRun(request);
      case '/debug/state':
        // F2: dump the live state machine for a run. Read-only.
        return jsonResponse({
          ok: true,
          data: this.debugState(url.searchParams.get('runId') ?? ''),
        });
      case '/health':
        return new Response('ok', { status: 200 });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ─── Core state machine (public: tests drive it via runInDurableObject) ──
  //
  // Drives `plan` through the per-step lifecycle, persisting every transition
  // to DO SQLite. Returns when the run reaches a terminal state. Executor-
  // agnostic — the same path runs the real executor (one step) and test stub
  // plans (N steps).
  //
  // Concurrency contract: several runs (distinct runIds) may execute
  // CONCURRENTLY inside one per-Talk DO — that is parallel talk mode (§6.3),
  // and every durable row is keyed by run_id so the runs don't collide. Steps
  // WITHIN a run are sequential (driveRun awaits each). The DO is single-
  // threaded for compute but interleaves at awaits, so this is re-entry-safe
  // (idempotent): re-entering a terminal run is a no-op, an already-
  // checkpointed step is skipped, and a CONCURRENT executeRun for the same run
  // dedups to the one live invocation rather than starting a second (so resume
  // — startup scan or alarm — can never double-execute a step). A3 adds
  // per-run cancel via the AbortController; the alarm aborts it on watchdog
  // failure (resumeRun below).
  async executeRun(
    runId: string,
    plan: TalkRunnerRunPlan,
  ): Promise<RunOutcome> {
    // A live invocation in THIS isolate already owns the run → return its
    // promise. Two callers (e.g. the resume scan racing a still-running
    // invocation) then observe ONE execution, not two. Checked before any
    // await so the set below wins the race synchronously.
    const live = this.inFlight.get(runId);
    if (live) return live.done;

    // Terminal runs stay terminal — re-running would re-execute completed work
    // and rewind the step log.
    const existing = this.readRun(runId);
    if (existing && isTerminalRunStatus(existing.status)) {
      return this.outcomeFromState(runId, existing.status, plan.length);
    }

    // Register synchronously (no await between the get() above and here) so a
    // concurrent executeRun sees the entry. The AbortController is reachable
    // by the alarm/cancel path via this map.
    const controller = new AbortController();
    const entry = {
      controller,
      done: undefined as unknown as Promise<RunOutcome>,
    };
    this.inFlight.set(runId, entry);
    entry.done = (async () => {
      try {
        return await this.driveRun(runId, plan, controller.signal);
      } finally {
        // Disown only if still OUR entry. A watchdog RETRY (retryRun) disowns a
        // wedged invocation by replacing this map slot with a fresh re-drive;
        // an unguarded delete here would evict that new owner when the wedged
        // attempt finally unwinds.
        if (this.inFlight.get(runId) === entry) this.inFlight.delete(runId);
      }
    })();
    return entry.done;
  }

  // The actual per-step loop, run by exactly one invocation per run (executeRun
  // enforces that via inFlight). Skips already-checkpointed steps on resume.
  private async driveRun(
    runId: string,
    plan: TalkRunnerRunPlan,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const now = Date.now();
    this.sql.exec(
      `insert into runs_local (run_id, status, started_at, updated_at)
       values (?, 'running', ?, ?)
       on conflict(run_id) do update set status='running', updated_at=excluded.updated_at`,
      runId,
      now,
      now,
    );

    for (let idx = 0; idx < plan.length; idx += 1) {
      const outcome = await this.runStep(runId, idx, plan[idx]!, signal);
      if (outcome === 'failed') {
        // Monotonic: if a cancel raced and already flipped the run terminal, our
        // 'failed' loses — report the durable truth, don't claim a failure.
        if (this.markRunTerminal(runId, 'failed')) {
          return { status: 'failed', failedStepIdx: idx };
        }
        return this.fencedOutcome(runId, idx);
      }
      if (outcome === 'fenced') {
        // A competing writer won the CAS race on this step — the alarm watchdog,
        // a retry attempt that bumped the attempt, or cancel flipping the run
        // terminal. This invocation writes nothing more; report the durable
        // truth (cancelled vs abandoned) so the caller persists the right thing.
        return this.fencedOutcome(runId, idx);
      }
    }

    // Every step checkpointed. CAS the terminal so a cancel that raced the last
    // step can't be clobbered by 'completed' (markRunTerminal is monotonic).
    if (this.markRunTerminal(runId, 'completed')) {
      return { status: 'completed', steps: plan.length };
    }
    return this.fencedOutcome(runId, plan.length - 1);
  }

  // Map a fenced step (this invocation lost ownership) to the run's durable
  // outcome: a cancelled run reports 'cancelled', anything else 'abandoned'.
  private fencedOutcome(runId: string, idx: number): RunOutcome {
    if (this.readRun(runId)?.status === 'cancelled')
      return { status: 'cancelled' };
    return { status: 'abandoned', abandonedStepIdx: idx };
  }

  private readRun(runId: string): RunLocalRow | null {
    return (
      this.sql
        .exec<RunLocalRow>(`select * from runs_local where run_id=?`, runId)
        .toArray()[0] ?? null
    );
  }

  // Reconstruct a RunOutcome for an already-terminal run (idempotent re-entry).
  private outcomeFromState(
    runId: string,
    status: RunStatus,
    planLength: number,
  ): RunOutcome {
    if (status === 'cancelled') return { status: 'cancelled' };
    if (status === 'failed') {
      const failed = this.sql
        .exec<{
          idx: number;
        }>(
          `select idx from steps where run_id=? and status='failed' order by idx limit 1`,
          runId,
        )
        .toArray()[0];
      return { status: 'failed', failedStepIdx: failed?.idx ?? 0 };
    }
    // 'completed' (A1 never produces 'cancelled'; A3 will extend this).
    const done = this.sql
      .exec<{
        n: number;
      }>(
        `select count(*) as n from steps where run_id=? and status='checkpoint'`,
        runId,
      )
      .one().n;
    return {
      status: 'completed',
      steps: typeof done === 'number' ? done : planLength,
    };
  }

  // One step: claim an attempt → arm deadline → RUNNING → (CHECKPOINT | FAILED).
  // Every post-await write goes through casStepWrite, which fences on (attempt,
  // step.status='running', run.status='running') so a late-resolving abandoned
  // attempt — retried, watchdog-failed, or cancelled — writes nothing.
  private async runStep(
    runId: string,
    idx: number,
    step: TalkRunnerStep,
    signal: AbortSignal,
  ): Promise<'checkpoint' | 'failed' | 'fenced'> {
    // Re-entry: a step already checkpointed on a prior invocation is done.
    // Skip it — never reset it to pending or re-run its work (resume-safe).
    const prior = this.sql
      .exec<{
        status: StepStatus;
      }>(`select status from steps where run_id=? and idx=?`, runId, idx)
      .toArray()[0];
    if (prior?.status === 'checkpoint') return 'checkpoint';

    // Prompt cancel: if the run was aborted between steps (cancel, or a watchdog
    // that disowned this invocation), do no work and write nothing. This is the
    // in-isolate fast path — the run-status CAS in casStepWrite is the DURABLE
    // guarantee that survives even when this check is skipped (e.g. cancel lands
    // mid-execute, after the check).
    if (signal.aborted) return 'fenced';

    const deadlineMs =
      Date.now() + (step.deadlineMs ?? DEFAULT_STEP_DEADLINE_MS[step.kind]);
    // Claim the step under a fresh attempt (fences any prior attempt's writes).
    // null ⇒ it checkpointed between the read above and here (resume race) — done.
    const attempt = this.claimStep(runId, idx, step.kind, deadlineMs);
    if (attempt == null) return 'checkpoint';
    // Re-point the single DO alarm at the new min(deadline_ms) (1A). The claim
    // above ran with no await, so the alarm is computed against this step's
    // freshly-armed deadline (race analysis in reconcileAlarm).
    await this.reconcileAlarm();

    try {
      const result = await step.execute(signal);
      // Serialize + assert BEFORE the CAS write so an oversized checkpoint
      // surfaces as a failed step (visible), never a silent truncation.
      const checkpointJson = serializeCheckpoint(result.checkpoint);
      const written = this.casStepWrite(
        runId,
        idx,
        attempt,
        'checkpoint',
        checkpointJson,
      );
      // Fenced (written===0): a competing writer settled this step first (retry
      // bump, watchdog fail, or cancel). Do NOT touch the deadline — the winner
      // already cleared it; re-clearing/re-arming here would race its alarm
      // bookkeeping.
      if (written === 0) return 'fenced';
      await this.settleDeadline(runId, idx);
      return 'checkpoint';
    } catch (err) {
      const written = this.casStepWrite(runId, idx, attempt, 'failed', null);
      logger.warn(
        {
          err,
          runId,
          idx,
          kind: step.kind,
          attempt,
          talkId: this.state.id.name,
        },
        'TalkRunner step failed',
      );
      // A late abandoned attempt that lost the CAS race must not be treated as
      // this run's failure, and must not touch the winner's deadline/alarm.
      if (written === 0) return 'fenced';
      await this.settleDeadline(runId, idx);
      return 'failed';
    }
  }

  // Claim a step for execution under a FRESH attempt, atomically (no await), so a
  // late write from a prior attempt fences on the attempt mismatch. A fresh step
  // claims attempt 1; a retry / re-drive of an interrupted step claims prior+1.
  // Returns the claimed attempt, or null if the step is already checkpointed.
  private claimStep(
    runId: string,
    idx: number,
    kind: StepKind,
    deadlineMs: number,
  ): number | null {
    const prior = this.sql
      .exec<{
        status: StepStatus;
        attempt: number;
      }>(
        `select status, attempt from steps where run_id=? and idx=?`,
        runId,
        idx,
      )
      .toArray()[0];
    if (prior?.status === 'checkpoint') return null;
    // ADOPT a pre-claimed 'pending' attempt (retryRun's synchronous claim already
    // bumped it — don't bump again); otherwise bump past the prior attempt
    // (fresh ⇒ 1, an interrupted 'running'/'failed' attempt ⇒ prior+1). Bumping
    // is what fences the prior attempt's eventual CAS writes.
    const attempt =
      prior?.status === 'pending' ? prior.attempt : (prior?.attempt ?? 0) + 1;
    // → PENDING for THIS attempt (replaces any interrupted prior attempt's row).
    this.sql.exec(
      `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
       values (?, ?, ?, 'pending', ?, null, ?)
       on conflict(run_id, idx) do update set
         kind=excluded.kind, status='pending', attempt=excluded.attempt,
         checkpoint_json=null, deadline_ms=excluded.deadline_ms`,
      runId,
      idx,
      kind,
      attempt,
      deadlineMs,
    );
    // Arm the deadline (1A table) for the claimed attempt.
    this.sql.exec(
      `insert into step_deadlines (run_id, idx, deadline_ms) values (?, ?, ?)
       on conflict(run_id, idx) do update set deadline_ms=excluded.deadline_ms`,
      runId,
      idx,
      deadlineMs,
    );
    // → RUNNING (before arming the alarm: the watchdog only fails 'running'
    // steps, so the step must be RUNNING the instant its deadline is live).
    this.sql.exec(
      `update steps set status='running'
       where run_id=? and idx=? and attempt=? and status='pending'`,
      runId,
      idx,
      attempt,
    );
    return attempt;
  }

  // The fence. A post-await step write lands only while ALL THREE hold:
  //   • the step row is still on THIS attempt   → fences a retried attempt (A3)
  //   • the step is still 'running'             → fences a watchdog-failed step
  //   • the run is still 'running'              → fences a cancelled run (A3)
  // Any abandoned attempt — one the watchdog retried/failed, or whose run was
  // cancelled — writes 0 rows. Returns rowsWritten (0 ⇒ fenced). The run-status
  // guard is bound by runId rather than correlated so the predicate is explicit.
  private casStepWrite(
    runId: string,
    idx: number,
    attempt: number,
    status: 'checkpoint' | 'failed',
    checkpointJson: string | null,
  ): number {
    return this.sql.exec(
      `update steps set status=?, checkpoint_json=?
       where run_id=? and idx=? and attempt=? and status='running'
         and (select status from runs_local where run_id=?)='running'`,
      status,
      checkpointJson,
      runId,
      idx,
      attempt,
      runId,
    ).rowsWritten;
  }

  // Monotonic terminal transition: a run moves running → terminal exactly once
  // and never terminal → terminal. So cancel can't be clobbered by a late
  // completed/failed (and vice-versa). Returns whether THIS call won.
  private markRunTerminal(runId: string, status: RunStatus): boolean {
    return (
      this.sql.exec(
        `update runs_local set status=?, updated_at=?
         where run_id=? and status='running'`,
        status,
        Date.now(),
        runId,
      ).rowsWritten > 0
    );
  }

  private clearDeadline(runId: string, idx: number): void {
    this.sql.exec(
      `delete from step_deadlines where run_id=? and idx=?`,
      runId,
      idx,
    );
  }

  // ─── Cancel RPC (F8) ─────────────────────────────────────────────────────
  //
  // The direct, poll-free replacement for v1's DB-polled cooperative cancel
  // (queue-consumer.ts). Runs in the same isolate that owns the run:
  //   • flips the run terminal ('cancelled') — every in-flight step's post-await
  //     write then fences on the run-status guard in casStepWrite, so a wedged
  //     provider that ignores the abort corrupts nothing;
  //   • aborts the live attempt's signal for a prompt cooperative stop;
  //   • clears the run's deadlines so the watchdog won't fire on a cancelled run.
  // Monotonic + idempotent: cancelling a terminal run is a no-op (a completed run
  // stays completed). DO-LOCAL in A3 — Postgres / UI / hub visibility is PR-B and
  // the real route is PR-C, so this is not yet production cancel.
  async cancel(
    runId: string,
  ): Promise<{ cancelled: boolean; status: RunStatus | null }> {
    const run = this.readRun(runId);
    if (!run) return { cancelled: false, status: null };
    if (isTerminalRunStatus(run.status)) {
      return { cancelled: run.status === 'cancelled', status: run.status };
    }
    // No await between the read above and this CAS, so the status can't drift
    // out from under us (single-threaded isolate, interleaves only at awaits).
    const won = this.markRunTerminal(runId, 'cancelled');
    // Abort the live attempt + drop deadlines regardless of who won the CAS: this
    // only tears down our own bookkeeping, and the run-status guard already does
    // the durable fencing.
    this.inFlight.get(runId)?.controller.abort('cancelled');
    this.sql.exec(`delete from step_deadlines where run_id=?`, runId);
    await this.reconcileAlarm();
    const status = this.readRun(runId)?.status ?? null;
    return { cancelled: won && status === 'cancelled', status };
  }

  // ─── Alarm watchdog + resume (1A / 4A) ──────────────────────────────────
  //
  // The single DO alarm always targets min(step_deadlines.deadline_ms). It is
  // re-pointed after every change to that table (arm on step start, clear on
  // settle, clear on watchdog-fail). Because alarm() fires in a FRESH
  // invocation, a step wedged on an await can never block its own watchdog —
  // the property v1's single-invocation runtime fundamentally cannot have.
  private async reconcileAlarm(): Promise<void> {
    const min = this.sql
      .exec<{
        m: number | null;
      }>(`select min(deadline_ms) as m from step_deadlines`)
      .one().m;
    // Unconditional set/delete (no getAlarm() compare). setAlarm applies its
    // value synchronously at call-time, so within the await-free
    // (mutate-table → read-min → setAlarm) window the value reflects the
    // current table; the LAST such call in program order wins and carries the
    // true global min. A redundant set to the same time is a firing no-op.
    if (min == null) {
      await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(min);
    }
  }

  // The watchdog. Fires when the earliest in-flight deadline passes; fails
  // EVERY expired step (parallel mode can leave several past-due at once via
  // distinct runs), then re-arms to the next-earliest. Each expired run is
  // recovered through the shared resumeRun (here always its FAIL branch). The
  // runtime clears the alarm slot before calling this; resumeRun re-arms it.
  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      const expired = this.sql
        .exec<{
          run_id: string;
        }>(
          `select run_id from step_deadlines where deadline_ms <= ? order by deadline_ms, run_id`,
          now,
        )
        .toArray();
      for (const { run_id } of expired) {
        // Per-run isolation: one run's recovery throwing must not abandon the
        // others still past-due, nor (with the finally below) skip the re-arm.
        try {
          await this.resumeRun(run_id);
        } catch (err) {
          logger.error(
            { err, runId: run_id, talkId: this.state.id.name },
            'TalkRunner alarm resume failed',
          );
        }
      }
    } finally {
      // ALWAYS re-point the alarm — even if the scan threw — so a transient
      // error can't strand the watchdog with no future alarm (the remaining
      // deadlines stay in the table; the next mutation would otherwise be the
      // only thing to re-arm).
      try {
        await this.reconcileAlarm();
      } catch (err) {
        logger.error(
          { err, talkId: this.state.id.name },
          'TalkRunner alarm re-arm failed',
        );
      }
    }
  }

  // 4A startup scan — re-drives every run still 'running' in durable SQLite
  // (the in-memory inFlight map is empty after a restart). Shares resumeRun
  // with the alarm path, so recovery behaves identically however it is
  // triggered. Runs inside the constructor's blockConcurrencyWhile; per-run
  // errors are swallowed so one bad run can't reset the DO.
  //
  // A2 is DO-LOCAL: planProvider is null, so every resumeRun here either FAILS
  // an expired step or DEFERS (logs) a resumable one — both are O(1), so the
  // constructor stays brief. PR-B WIRES planProvider; when it does it MUST make
  // the resume RE-RUN path detached (don't `await` a full executeRun inside
  // blockConcurrencyWhile, or DO startup blocks on the whole run, up to the 30s
  // ceiling). The dedup in executeRun makes a detached resume safe against
  // racing inbound traffic.
  async recoverInFlightRuns(): Promise<void> {
    const runs = this.sql
      .exec<{
        run_id: string;
      }>(
        `select run_id from runs_local where status='running' order by started_at, run_id`,
      )
      .toArray();
    for (const { run_id } of runs) {
      try {
        await this.resumeRun(run_id);
      } catch (err) {
        logger.error(
          { err, runId: run_id, talkId: this.state.id.name },
          'TalkRunner startup resume failed',
        );
      }
    }
  }

  // resumeRun — THE one idempotent recovery function shared by startup (4A) and
  // the alarm (1A). Given a 'running' run it drives the durable state to a
  // consistent place, handling EVERY way driveRun can be interrupted:
  //   • TERMINAL  — already completed/failed/cancelled → no-op.
  //   • ORPHANED-FAIL — a step is 'failed' but the run row never flipped (a
  //               crash between the step-fail write and markRunTerminal):
  //               reconcile the run to failed, clear its deadlines.
  //   • WATCHDOG-FAIL — the active in-flight step (running OR pending) is past
  //               its deadline: CAS-fail the step, fail the run, abort any live
  //               attempt (per the §6.3 diagram: expiry → FAILED).
  //   • RE-DRIVE  — otherwise the run is still 'running' with work left: an
  //               interrupted-but-not-expired step, or NO in-flight step at all
  //               because eviction landed between a checkpoint and the next
  //               step (or just before the terminal mark). Re-enter the step
  //               machine via the rebuilt plan; executeRun skips checkpointed
  //               steps, runs the remainder, and marks the run terminal — so a
  //               between-steps eviction can never strand a run.
  // Idempotent under concurrency: a live invocation owns the run (inFlight) so
  // the re-drive branch defers to it rather than double-executing a step.
  async resumeRun(runId: string): Promise<void> {
    const run = this.readRun(runId);
    if (!run || isTerminalRunStatus(run.status)) return;

    // ORPHANED-FAIL: a 'failed' step on a still-'running' run means driveRun (or
    // the watchdog) flipped the step but crashed before the run row. driveRun
    // stops at the first failure, so any failed step ⇒ the run failed. Clear
    // lingering deadlines so the alarm can't spin on a now-terminal run.
    const failedStep = this.sql
      .exec<{
        idx: number;
      }>(
        `select idx from steps where run_id=? and status='failed' order by idx limit 1`,
        runId,
      )
      .toArray()[0];
    if (failedStep) {
      this.markRunTerminal(runId, 'failed');
      this.sql.exec(`delete from step_deadlines where run_id=?`, runId);
      await this.reconcileAlarm();
      return;
    }

    const active = this.sql
      .exec<{
        idx: number;
        attempt: number;
        status: StepStatus;
      }>(
        `select idx, attempt, status from steps
         where run_id=? and status in ('pending','running') order by idx limit 1`,
        runId,
      )
      .toArray()[0];

    // WATCHDOG-FAIL. The live deadline comes from step_deadlines — the SAME
    // table the alarm fires on (cleared on settle), so the watchdog decision
    // can't drift from what armed the alarm. Expiry covers both 'running' and
    // 'pending' (a restart can leave a step 'pending' and past due) — either
    // way the budget is blown.
    if (active) {
      const deadline = this.sql
        .exec<{
          deadline_ms: number;
        }>(
          `select deadline_ms from step_deadlines where run_id=? and idx=?`,
          runId,
          active.idx,
        )
        .toArray()[0];
      if (deadline != null && deadline.deadline_ms <= Date.now()) {
        // RETRY if budget remains AND the plan can be rebuilt; otherwise FAIL.
        // A3 is DO-LOCAL: planProvider is null in prod, so this is always the
        // FAIL path (the A2 behavior) until PR-B wires the rebuild — tests inject
        // planProvider to exercise the retry + the cross-attempt fence.
        if (active.attempt < MAX_STEP_ATTEMPTS && this.planProvider) {
          await this.retryRun(runId, active.idx, active.attempt);
        } else {
          // CAS on (attempt, status in running|pending) so a step that just
          // settled to 'checkpoint' wins the race (then failed===false and the
          // run is NOT failed). Abort the live attempt's signal — even if its
          // await never unwinds, the CAS fence already makes its eventual
          // checkpoint write a no-op.
          const failed = this.failStepAndRun(runId, active.idx, active.attempt);
          if (failed) this.inFlight.get(runId)?.controller.abort();
          await this.reconcileAlarm();
        }
        return;
      }
    }

    // RE-DRIVE: an interrupted-not-expired step, or no in-flight step but the
    // run is still 'running' (evicted between a checkpoint and the next step,
    // or just before the terminal mark). A live invocation already owns the run
    // → let it finish. Otherwise rebuild the plan and re-enter the machine,
    // which skips checkpointed steps and marks the run terminal.
    if (this.inFlight.has(runId)) return;
    const plan = this.planProvider ? await this.planProvider(runId) : null;
    if (!plan) {
      logger.warn(
        { runId, talkId: this.state.id.name },
        'TalkRunner resume: no plan provider (DO-local A2); deferring to alarm/reconciliation',
      );
      return;
    }
    // Re-check after the await: a live invocation may have started meanwhile.
    if (this.inFlight.has(runId)) return;
    await this.executeRun(runId, plan);
  }

  // Fail an expired step and, if WE won the CAS (the step was still in-flight on
  // a still-running run), the run. The run-status guard makes a watchdog fail a
  // no-op once cancel (or any terminal write) has won — so a cancelled run can't
  // pick up a stale failed step. Always clears the step's deadline so the alarm
  // won't re-fire on it. Returns whether this call failed a live step.
  private failStepAndRun(runId: string, idx: number, attempt: number): boolean {
    const written = this.sql.exec(
      `update steps set status='failed'
       where run_id=? and idx=? and attempt=? and status in ('running','pending')
         and (select status from runs_local where run_id=?)='running'`,
      runId,
      idx,
      attempt,
      runId,
    ).rowsWritten;
    this.clearDeadline(runId, idx);
    if (written > 0) {
      this.markRunTerminal(runId, 'failed');
      logger.warn(
        { runId, idx, attempt, talkId: this.state.id.name },
        'TalkRunner watchdog failed expired step',
      );
      return true;
    }
    return false;
  }

  // Synchronous, durable RETRY CLAIM — the fence that must be in place before any
  // await. Moves the expired RUNNING attempt to a fresh PENDING attempt+1 and
  // re-arms its deadline, all in one await-free CAS keyed on (idx, attempt,
  // status='running'). Two effects:
  //   • the wedged attempt's eventual write now misses BOTH on the bumped attempt
  //     AND on status (no longer 'running') — so it fences even while we go on to
  //     rebuild the plan over an await;
  //   • exactly ONE caller wins (rowsWritten>0), so concurrent watchdog/resume
  //     callers can't double-drive or blow past MAX_STEP_ATTEMPTS.
  // Returns the new attempt, or null if we lost the claim (already superseded).
  private claimRetry(
    runId: string,
    idx: number,
    attempt: number,
  ): number | null {
    const next = attempt + 1;
    const kind = (this.sql
      .exec<{
        kind: StepKind;
      }>(`select kind from steps where run_id=? and idx=?`, runId, idx)
      .toArray()[0]?.kind ?? 'llm') as StepKind;
    const deadlineMs = Date.now() + DEFAULT_STEP_DEADLINE_MS[kind];
    const won =
      this.sql.exec(
        `update steps set status='pending', attempt=?, checkpoint_json=null, deadline_ms=?
         where run_id=? and idx=? and attempt=? and status='running'`,
        next,
        deadlineMs,
        runId,
        idx,
        attempt,
      ).rowsWritten > 0;
    if (!won) return null;
    this.sql.exec(
      `insert into step_deadlines (run_id, idx, deadline_ms) values (?, ?, ?)
       on conflict(run_id, idx) do update set deadline_ms=excluded.deadline_ms`,
      runId,
      idx,
      deadlineMs,
    );
    return next;
  }

  // Watchdog RETRY (bounded by MAX_STEP_ATTEMPTS). The expired attempt may be
  // wedged on an await that ignores its abort (a provider that never unwinds), so
  // we cannot wait for it. Order is load-bearing: FENCE FIRST (claimRetry, fully
  // synchronous), THEN abort/disown, THEN rebuild + re-drive. Establishing the
  // fence before the planProvider await is what stops the wedged attempt from
  // slipping a write through while the plan rebuilds. The re-drive is DETACHED so
  // a fresh alarm invocation returns promptly (PR-B inherits this rule).
  private async retryRun(
    runId: string,
    idx: number,
    attempt: number,
  ): Promise<void> {
    // FENCE (synchronous). null ⇒ another retry/cancel already moved past this
    // attempt — bow out (single-winner, budget-safe).
    const next = this.claimRetry(runId, idx, attempt);
    if (next == null) return;
    await this.reconcileAlarm(); // re-point the alarm at the re-armed deadline
    // Disown the wedged invocation so the re-drive below doesn't dedup to it.
    const wedged = this.inFlight.get(runId);
    if (wedged) {
      wedged.controller.abort('superseded_by_retry');
      this.inFlight.delete(runId);
    }
    const plan = this.planProvider ? await this.planProvider(runId) : null;
    if (!plan) {
      // Can't rebuild → fail the now-pending attempt (run-status-fenced, so a
      // cancel that raced the rebuild leaves the run cancelled, not failed).
      const failed = this.failStepAndRun(runId, idx, next);
      if (failed) this.inFlight.get(runId)?.controller.abort();
      await this.reconcileAlarm();
      return;
    }
    // Re-drive detached; errors logged. executeRun's terminal gate drops a run
    // cancelled during the rebuild; claimStep ADOPTS the pending attempt (no
    // re-bump). The fence from claimRetry already holds regardless of timing.
    void this.executeRun(runId, plan).catch((err) =>
      logger.error(
        { err, runId, idx, talkId: this.state.id.name },
        'TalkRunner retry re-drive failed',
      ),
    );
  }

  // Clear a settled step's deadline and re-point the alarm at the next-earliest
  // in-flight deadline (or clear it if this was the last).
  private async settleDeadline(runId: string, idx: number): Promise<void> {
    this.clearDeadline(runId, idx);
    await this.reconcileAlarm();
  }

  private debugState(runId: string): {
    run: RunLocalRow | null;
    steps: StepRow[];
    deadlines: StepDeadlineRow[];
  } {
    const run =
      this.sql
        .exec<RunLocalRow>(`select * from runs_local where run_id=?`, runId)
        .toArray()[0] ?? null;
    const steps = this.sql
      .exec<StepRow>(`select * from steps where run_id=? order by idx`, runId)
      .toArray();
    const deadlines = this.sql
      .exec<StepDeadlineRow>(
        `select * from step_deadlines where run_id=? order by idx`,
        runId,
      )
      .toArray();
    return { run, steps, deadlines };
  }

  // ─── Dev-only route: real executor, one step, end-to-end ─────────────────
  //
  // Proves the DO can host GreenfieldTalkExecutor UNCHANGED and drive it to a
  // terminal step. The Worker-side route that forwards here is auth + env
  // gated; this second env check is defence in depth.
  private async handleDevRun(request: Request): Promise<Response> {
    if (this.env.CLAWTALK_DEV_TALK_RUNNER !== '1') {
      return new Response('not found', { status: 404 });
    }
    let runId = '';
    try {
      const body = (await request.json()) as { runId?: unknown };
      if (typeof body.runId === 'string') runId = body.runId;
    } catch {
      /* fall through to the empty-runId guard */
    }
    if (!runId) {
      return jsonResponse(
        {
          ok: false,
          error: { code: 'invalid_request', message: 'runId required' },
        },
        400,
      );
    }

    const envBindings: DbScopeEnvBindings = {
      DB_EVENT_HUB_URL: this.env.DB_EVENT_HUB_URL,
      USER_EVENT_HUB: this.env.USER_EVENT_HUB,
      TALK_RUN_QUEUE: this.env.TALK_RUN_QUEUE,
      ATTACHMENTS: this.env.ATTACHMENTS,
    };

    // The DO establishes its OWN request scope from the script-wide Hyperdrive
    // binding — there is no inbound HTTP request scope to inherit. ctx is null,
    // so withRequestScopedDb awaits its closes/flushes inline at scope end.
    const data = await withRequestScopedDb(
      this.env.DB.connectionString,
      null,
      envBindings,
      () =>
        withNotifyQueueScope(envBindings, null, () =>
          this.runRealExecutor(runId),
        ),
    );
    return jsonResponse({ ok: true, data });
  }

  private async runRealExecutor(
    runId: string,
  ): Promise<Record<string, unknown>> {
    // Per-Talk DO isolation: this DO is idFromName(talkId), so id.name IS the
    // talkId. Verify the run belongs to THIS talk BEFORE claiming — a wrong
    // talkId in the dev request would otherwise flip another talk's run to
    // 'running' under this DO and strand its step log here (mirrors the D8
    // cross-DO guard in user-event-hub.ts).
    const doTalkId = this.state.id.name;
    const pre = await getGreenfieldQueueRunById(runId);
    if (!pre) return { devStatus: 'not_found' };
    if (doTalkId !== undefined && pre.talk_id !== doTalkId) {
      return {
        devStatus: 'talk_mismatch',
        expectedTalkId: doTalkId,
        actualTalkId: pre.talk_id,
      };
    }

    // Reuse the v1 claim accessor verbatim — the executor refuses to run
    // unless the row is 'running'. (Synchronous PG lifecycle here mirrors the
    // queue consumer; it is NOT the v2 write-behind contract — that is PR-B.
    // NB: A1's dev path has NO watchdog — a wedged executor here is not failed
    // until A2 adds the alarm; do not read this route as proof the production
    // DO path inherits the queue consumer's wedge containment.)
    const claim = await markGreenfieldRunRunning(runId);
    if (claim.status !== 'claimed') {
      return { devStatus: 'not_claimable', claim: claim.status };
    }
    const run = claim.run;

    const promptInput = run.trigger_message_id
      ? await getGreenfieldTriggerMessageById(run.trigger_message_id)
      : {
          id: null,
          workspace_id: run.workspace_id,
          talk_id: run.talk_id,
          body: await getGreenfieldRunPromptSnapshotText(run.id),
        };
    if (!promptInput?.body) {
      await failGreenfieldRun({
        runId: run.id,
        errorCode: 'prompt_snapshot_missing',
        errorMessage: 'Run missing trigger message / prompt snapshot text',
      });
      return { devStatus: 'prompt_missing' };
    }

    const input: TalkExecutorInput = {
      runId: run.id,
      talkId: run.talk_id,
      requestedBy: run.requested_by,
      triggerMessageId: promptInput.id ?? '',
      triggerContent: promptInput.body,
      jobId: run.job_id ?? null,
      targetAgentId: run.target_agent_id,
      responseGroupId: run.response_group_id ?? null,
      sequenceIndex: run.sequence_index ?? null,
    };

    const executor = new GreenfieldTalkExecutor();
    // A1 does not wire live streaming through the hub (3A is PR-B); deltas are
    // logged, not emitted. Run lifecycle (started/completed) still reaches the
    // UI via the reused accessors' own outbox events.
    const emit = (event: TalkExecutionEvent): void => {
      logger.debug(
        { runId: run.id, eventType: event.type },
        'TalkRunner dev emit (not forwarded to hub in A1)',
      );
    };

    let captured: TalkExecutorOutput | null = null;
    // Capture the executor's real error so the failure persist below records
    // the executor's code/message (like the queue consumer) instead of a
    // generic one. runStep stays executor-agnostic — it only sees the throw.
    let capturedError: unknown = null;
    const startedAt = Date.now();
    const plan: TalkRunnerRunPlan = [
      {
        kind: 'llm',
        execute: async (signal) => {
          // A1 honesty: the whole opaque executor.execute() is ONE step. True
          // per-LLM-call / per-tool-batch decomposition (8A granularity) needs
          // the executor to surface step boundaries — later Phase 2 work.
          try {
            const output = await executor.execute(input, signal, emit);
            captured = output;
            return {
              checkpoint: {
                kind: 'executor_output',
                // Reference-based: text/structure only, no inlined binary.
                text: output.content,
                agentId: output.agentId ?? null,
                providerId: output.providerId ?? null,
                modelId: output.modelId ?? null,
              },
            };
          } catch (err) {
            capturedError = err;
            throw err; // let the state machine record the step failure
          }
        },
      },
    ];

    const outcome = await this.executeRun(run.id, plan);

    if (outcome.status === 'completed' && captured) {
      const output: TalkExecutorOutput = captured;
      const responseContent = stripLeadingAgentLabel(
        stripInternalTalkResponseText(output.content),
        output.agentNickname,
      );
      const responseMetadata = output.metadataJson
        ? (JSON.parse(output.metadataJson) as Record<string, unknown>)
        : null;
      await completeGreenfieldRun({
        runId: run.id,
        responseMessageId: crypto.randomUUID(),
        responseContent,
        responseMetadata,
        agentId: output.agentId,
        agentNickname: output.agentNickname,
        providerId: output.providerId,
        modelId: output.modelId,
        latencyMs: Date.now() - startedAt,
        usage: output.usage,
        responseSequenceInRun: output.responseSequenceInRun,
      });
    } else if (outcome.status === 'failed') {
      await failGreenfieldRun({
        runId: run.id,
        errorCode:
          capturedError instanceof TalkExecutorError
            ? capturedError.code
            : 'talk_runner_step_failed',
        errorMessage:
          capturedError instanceof Error
            ? capturedError.message
            : 'Step failed under the TalkRunner dev route',
      });
    } else if (outcome.status === 'abandoned') {
      // The alarm watchdog (A2) failed this run's step out from under the live
      // executor — the step's CAS write then lost the race, so executeRun
      // returned 'abandoned' while the LOCAL run is already 'failed'. Fail the
      // outer Postgres run too, or the Greenfield queue row is stranded
      // 'running'. (A1 deemed 'abandoned' unreachable; the A2 watchdog makes it
      // reachable on the dev path.) The durable cause is ALWAYS the watchdog —
      // capturedError, if any, is the late executor unwind (an aborted/cleaning-
      // up provider), a red herring — so record watchdog semantics
      // unconditionally rather than a misleading provider error.
      await failGreenfieldRun({
        runId: run.id,
        errorCode: 'talk_runner_watchdog_abandoned',
        errorMessage:
          'Run step exceeded its deadline and was failed by the TalkRunner watchdog',
      });
    } else if (outcome.status === 'cancelled') {
      // Unreachable on the dev route (it never calls cancel), but the union is
      // exhaustive: a cancelled run must not strand the Greenfield row 'running'.
      // Real cancel persistence (status='cancelled', not a failure) is PR-B/PR-C;
      // here we record a terminal failure so the dev row doesn't leak.
      await failGreenfieldRun({
        runId: run.id,
        errorCode: 'talk_runner_cancelled',
        errorMessage: 'Run was cancelled via the TalkRunner cancel RPC',
      });
    }

    return { devStatus: outcome.status, outcome };
  }
}

// ─── module helpers ─────────────────────────────────────────────────────

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

export function serializeCheckpoint(checkpoint: unknown): string {
  // Reject inlined binary BEFORE the size check. A raw ArrayBuffer/Blob
  // JSON.stringifies to `{}` and a typed array to an index map — so a checkpoint
  // that inlines bytes can SILENTLY pass the <1MB assert while dropping the bytes
  // on resume. 8A requires R2 refs, never inlined binary, so this is a bug, not a
  // big payload: fail it loudly. (Base64-STRING inlining under the cap stays the
  // executor's reference-shape contract — not detectable here without false
  // positives on legitimate text.)
  assertNoInlinedBinary(checkpoint);
  const json = JSON.stringify(checkpoint ?? null);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_CHECKPOINT_BYTES) {
    throw new TalkRunnerError(
      'checkpoint_too_large',
      `Step checkpoint is ${bytes}B, over the ${MAX_CHECKPOINT_BYTES}B cap (8A: store R2 refs, not inlined blobs)`,
    );
  }
  return json;
}

function assertNoInlinedBinary(checkpoint: unknown): void {
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (
      node instanceof ArrayBuffer ||
      ArrayBuffer.isView(node) || // typed arrays + DataView + Node Buffer
      (typeof Blob !== 'undefined' && node instanceof Blob)
    ) {
      throw new TalkRunnerError(
        'checkpoint_inlined_binary',
        'Step checkpoint contains an inlined binary value (ArrayBuffer/typed array/Blob); store an R2 ref (8A), not bytes',
      );
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(checkpoint);
}

// 8A reference-checkpoint rehydration. A reference checkpoint stores text +
// structure plus R2 keys for binary blocks (PDF page images) instead of inlining
// the bytes — that is what keeps it under the 1MB cap. On resume, the rebuilt
// plan must pull those bytes back from R2. This walker collects every page-image
// ref so the resume path can load each (PR-B binds the loader to
// attachment-storage's loadAttachmentFile / loadPageImage; the byte round-trip
// is what `talk-runner-checkpoint.test.ts` proves against the multi-page-PDF
// fixture).
export interface CheckpointImageRef {
  storageKey: string;
  pageIndex?: number;
  byteLength?: number;
  sha256?: string;
  mimeType?: string;
}

export function collectCheckpointImageRefs(
  checkpoint: unknown,
): CheckpointImageRef[] {
  const out: CheckpointImageRef[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (
        rec.type === 'pdf_page_image_ref' &&
        typeof rec.storageKey === 'string'
      ) {
        out.push({
          storageKey: rec.storageKey,
          pageIndex:
            typeof rec.pageIndex === 'number' ? rec.pageIndex : undefined,
          byteLength:
            typeof rec.byteLength === 'number' ? rec.byteLength : undefined,
          sha256: typeof rec.sha256 === 'string' ? rec.sha256 : undefined,
          mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : undefined,
        });
      }
      for (const value of Object.values(rec)) visit(value);
    }
  };
  visit(checkpoint);
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
