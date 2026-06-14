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
//     attempt is disowned and fenced. Needs a rebuildable plan — now wired in
//     PR-B (planProvider → buildResumePlan); A3 kept the A2 fail behavior when
//     planProvider was null, tests still inject stub plans.               [A3]
//   • Write-behind to Postgres (the system of record): the DO mirrors its
//     durable terminal truth via an injectable RunStatePersister
//     (talk-runner-write-behind.ts). Terminal flush is AWAITED with bounded
//     retry and reads runs_local.status, so a cancel that won the DO CAS
//     flushes 'cancelled', never a stale 'completed'. Idempotent + monotonic
//     (accessor `where status='running'` CAS), durable across eviction via the
//     run_sync table (markRunTerminal marks synced=0; flush sets 1; restart /
//     alarm / reconciliation re-flush). The completed payload lives in the
//     reference-based checkpoint, so a re-flush needs no executor re-run.  [B]
//   • 3A hub streaming: runOne forwards the executor's events to the hub via
//     emitOutboxEventOutsideTx (insert-before-push), gated on the run still
//     'running' so post-cancel zombie deltas are dropped. Streaming events are
//     NOT batched — replay stays gap-free.                                 [B]
//   • Production plan rebuild (planProvider → buildResumePlan) for cross-
//     eviction resume/retry, with 8A R2-ref rehydration via attachment-storage;
//     the re-drive is DETACHED so DO startup never blocks on a whole run.  [B]
//   • start(runIds): the production dispatch entry PR-C flips /chat to; the
//     reconcileRun() / flushPendingSync() backstops.                       [B]
//
// EXPLICITLY NOT here yet (do not read this as production-complete):
//   • The /chat dispatch flip to start(runIds) + the cancel-route flip to the
//     cancel RPC — PR-C. PR-B lands start()/the persister/the flag plumbing but
//     leaves dispatch on the queue (the per-account flag defaults OFF).
//   • Finer 8A step granularity (per-LLM-call / per-tool-batch). The executor
//     is still ONE opaque step; resume re-runs that one step.
//   • Retiring the queue path + #609 watchdog + shrinking the sweeps — PR-D.
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
  getGreenfieldQueueRunById,
  getGreenfieldRunPromptSnapshotText,
  getGreenfieldTriggerMessageById,
  type GreenfieldQueueRunRecord,
} from './greenfield-run-accessors.js';
import {
  createTalkResponseStreamSanitizer,
  stripInternalTalkResponseText,
  stripLeadingAgentLabel,
  type TalkResponseStreamSanitizer,
} from './internal-tags.js';
import { emitOutboxEventOutsideTx } from './outbox-emit.js';
import { loadAttachmentFile } from './attachment-storage.js';
import {
  createDefaultRunStatePersister,
  withBoundedRetry,
  type RunCompletedPayload,
  type RunStatePersister,
} from './talk-runner-write-behind.js';
import { TalkExecutorError } from './executor.js';
import type { TalkExecutionEvent, TalkExecutorInput } from './executor.js';

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
  // Keeps the DO alive until `promise` settles, past the response that started
  // it. start() detaches runs so /chat returns fast (the run must NOT be tied to
  // the caller's lifetime — that would re-impose the 30s ceiling 6A removed); we
  // hand those detached runs to waitUntil so the runtime doesn't evict the DO
  // mid-run. Optional in the shim so older test harnesses without it degrade to
  // a plain detached promise.
  waitUntil?(promise: Promise<unknown>): void;
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

// PR-B write-behind: bounded retries for the AWAITED terminal Postgres persist
// (docs/13 §6.3 "terminal persist AWAITED with bounded retry"). A transient
// Postgres blip during the terminal flush is retried this many times before the
// DO gives up and leaves the run unsynced (run_sync.synced=0) for the
// reconciliation cron / next-invocation re-flush backstop. The terminal event
// is emitted ONLY on a successful persist, so a failed flush never makes the
// snapshot lie.
const TERMINAL_FLUSH_ATTEMPTS = 4;

// The checkpoint `kind` for a completed executor run. The checkpoint doubles as
// the DURABLE terminal-flush payload (reference-based: text/metadata + a stable
// response message id), so a restart re-flushes a completed run from SQLite
// without re-running the executor. Exported for the workers-pool write-behind
// test (it builds completed-payload checkpoints via stub plans).
export const COMPLETED_PAYLOAD_KIND = 'completed_run_payload_v2';

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

// Diagnostic result of runOne (the production single-run path). `devStatus` is
// the outcome status or an early-exit reason; the rest is context for the dev
// route response / start() aggregation.
type RunOneResult = {
  devStatus: string;
  outcome?: RunOutcome;
  claim?: string;
  expectedTalkId?: string;
  actualTalkId?: string;
};

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

  // 4A resume seam. PR-B sets it (in the constructor) to the Postgres-backed
  // rebuild so a resumed/retried run re-enters the executor; tests inject stub
  // plans. The resume path no-ops (and logs) a run it cannot rebuild.
  public planProvider: TalkRunnerPlanProvider | null = null;

  // PR-B write-behind seam (docs/13 §6.3). The DO mirrors its durable terminal
  // truth to Postgres ONLY through this. Null → the default accessor-backed
  // persister (lazily built, needs a request scope). Tests inject a fake so the
  // workers pool (no Postgres) can drive the DO orchestration end-to-end.
  public persister: RunStatePersister | null = null;

  // Test seam: base backoff for the bounded terminal-flush retry. Undefined →
  // the withBoundedRetry default. Tests set 0 so retry cases don't add wall-clock.
  public flushRetryDelayMs?: number;

  constructor(state: DurableObjectStateLike, env: TalkRunnerEnv) {
    this.state = state;
    this.env = env;
    // PR-B: wire the production plan rebuild for cross-eviction resume/retry.
    // Loads the run + prompt from Postgres and returns a one-step executor plan
    // (the same shape runOne builds), opening its own request scope (resume/alarm
    // callers have none) plus a fresh scope inside the step for the executor.
    // GATED on a DB binding: the rebuild needs Postgres, so it stays null when
    // there is none (the workers test pool) — exactly the DO-local fallback the
    // alarm watchdog already handles (fail an expired step it can't rebuild).
    // Tests with their own stub plans overwrite this after construction.
    if (
      (this.env as { DB?: { connectionString?: string } }).DB?.connectionString
    ) {
      this.planProvider = (runId) => this.buildResumePlan(runId);
    }
    // Schema must exist before any method touches storage, and the 4A startup
    // resume scan must run before any incoming fetch()/RPC sees stale in-flight
    // rows. blockConcurrencyWhile defers all delivery (including alarm()) until
    // both finish. NB: never throw out of this block — it resets the DO
    // (user-event-hub.ts precedent); recoverInFlightRuns swallows per-run errors.
    void this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      await this.recoverInFlightRuns();
    });
    // PR-B: best-effort re-flush of any run that reached terminal in DO SQLite
    // but whose Postgres write didn't confirm before the eviction/restart
    // (run_sync.synced=0). DETACHED — never block constructor delivery on a
    // Postgres round-trip (the §6.3 liveness rule). flushPendingSync no-ops
    // without opening a scope when nothing is pending; the reconciliation cron
    // is the durable backstop if this is cut short by another eviction.
    void this.flushPendingSync().catch((err) =>
      logger.error(
        { err, talkId: this.state.id.name },
        'TalkRunner startup re-flush failed',
      ),
    );
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
    // PR-B write-behind durability: tracks whether a run that reached terminal
    // in DO SQLite has had its terminal state CONFIRMED in Postgres. markRunTerminal
    // inserts synced=0 on the winning transition; the terminal flush sets synced=1
    // on a confirmed persist. A restart / reconciliation re-flushes synced=0 rows
    // (the completed-run payload lives durably in the last step checkpoint, so a
    // re-flush needs no executor re-run).
    this.sql.exec(
      `create table if not exists run_sync (
         run_id text primary key,
         synced integer not null default 0,
         updated_at integer not null
       )`,
    );
  }

  // ─── HTTP surface ──────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/start':
        // PR-B: the production dispatch entry. PR-C flips /chat to call this
        // (replacing the queue send); dormant until then (the flag is OFF).
        return this.handleStart(request);
      case '/reconcile':
        // PR-B: the reconciliation cron pings this for a do-path run that
        // Postgres still shows queued/running, to flush any pending DO terminal.
        return this.handleReconcile(url.searchParams.get('runId') ?? '');
      case '/cancel':
        // PR-B: /chat/cancel pings this for a do-path run so the DO (whose
        // streaming guard reads DO SQLite, not Postgres) observes the cancel and
        // stops streaming. Dormant until PR-C routes cancels here.
        return this.handleCancel(request);
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
  //
  // PR-B: the SINGLE terminal chokepoint (driveRun, cancel, failStepAndRun,
  // resumeRun all flip terminal here), so it is also where a run is registered
  // as needing a Postgres write-behind flush. On the winning transition it
  // upserts run_sync(synced=0); the terminal flush later sets synced=1. Done
  // synchronously with the status flip so a crash immediately after still leaves
  // a durable "needs flush" marker for the restart/reconciliation backstop.
  private markRunTerminal(runId: string, status: RunStatus): boolean {
    const now = Date.now();
    const won =
      this.sql.exec(
        `update runs_local set status=?, updated_at=?
         where run_id=? and status='running'`,
        status,
        now,
        runId,
      ).rowsWritten > 0;
    if (won) {
      this.sql.exec(
        `insert into run_sync (run_id, synced, updated_at) values (?, 0, ?)
         on conflict(run_id) do nothing`,
        runId,
        now,
      );
    }
    return won;
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
      // PR-B: a watchdog-failed run is now terminal-in-DO but unsynced — push it
      // to Postgres so the UI/snapshot reflects the failure promptly rather than
      // waiting for the reconciliation cron. Best-effort (the cron backstops).
      await this.flushPendingSync().catch((err) =>
        logger.error(
          { err, talkId: this.state.id.name },
          'TalkRunner alarm flush failed',
        ),
      );
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
  // PR-B WIRES planProvider, so a resumable run here can RE-DRIVE. The re-drive
  // is DETACHED (detachRedrive:true): an expired step still fails O(1) inline,
  // but a full re-run must NOT block the constructor's blockConcurrencyWhile (it
  // would stall DO startup on the whole run, up to the 30s ceiling). The dedup
  // in executeRun makes a detached resume safe against racing inbound traffic;
  // the detached re-drive re-flushes Postgres when it lands.
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
        await this.resumeRun(run_id, { detachRedrive: true });
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
  //
  // PR-B: `detachRedrive` makes the RE-DRIVE branch fire-and-forget. The
  // constructor (recoverInFlightRuns) passes true so DO startup never blocks its
  // blockConcurrencyWhile on a whole re-run (the rule the A2 header flagged for
  // when PR-B wires planProvider). The alarm/direct callers leave it false: the
  // alarm only ever hits the FAIL/RETRY branches for an expired step (never the
  // awaited RE-DRIVE), and the A2 tests await the re-drive to assert completion.
  async resumeRun(
    runId: string,
    opts?: { detachRedrive?: boolean },
  ): Promise<void> {
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
        // RETRY only a wedged RUNNING attempt (the case retryRun/claimRetry is
        // built for — a provider stuck on an await), and only with budget left
        // AND a rebuildable plan. A 'pending' expired step (a restart caught it
        // mid-claim) is NOT retryable: claimRetry CASes on status='running', so
        // routing it to retryRun would bail without clearing the deadline and the
        // watchdog would spin — fail it like A2 instead. A3 is DO-LOCAL:
        // planProvider is null in prod, so this is always the FAIL path until
        // PR-B wires the rebuild; tests inject planProvider to exercise retry.
        if (
          active.status === 'running' &&
          active.attempt < MAX_STEP_ATTEMPTS &&
          this.planProvider
        ) {
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
        'TalkRunner resume: plan rebuild returned null; deferring to alarm/reconciliation',
      );
      return;
    }
    // Re-check after the await: a live invocation may have started meanwhile.
    if (this.inFlight.has(runId)) return;
    if (opts?.detachRedrive) {
      // Constructor path: do NOT await the whole re-run (it would block DO
      // startup). keepAlive (not bare void) so a short instantiating invocation
      // (e.g. a reconcile probe) can't have the runtime evict this recovery
      // re-drive after its response. Re-flush the terminal state once it lands;
      // errors are the reconciliation cron's problem, not the constructor's.
      this.keepAlive(
        this.executeRun(runId, plan)
          .then(() => this.flushPendingSync())
          .catch((err) =>
            logger.error(
              { err, runId, talkId: this.state.id.name },
              'TalkRunner detached resume re-drive failed',
            ),
          ),
      );
      return;
    }
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
    // PR-B: re-flush Postgres once the retried run lands terminal, and keepAlive
    // so the alarm invocation doesn't let the DO evict the re-drive mid-flight.
    this.keepAlive(
      this.executeRun(runId, plan)
        .then(() => this.flushPendingSync())
        .catch((err) =>
          logger.error(
            { err, runId, idx, talkId: this.state.id.name },
            'TalkRunner retry re-drive failed',
          ),
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

  // ─── Request scope + persister seams (PR-B) ─────────────────────────────

  private dbScopeBindings(): DbScopeEnvBindings {
    return {
      DB_EVENT_HUB_URL: this.env.DB_EVENT_HUB_URL,
      USER_EVENT_HUB: this.env.USER_EVENT_HUB,
      TALK_RUN_QUEUE: this.env.TALK_RUN_QUEUE,
      ATTACHMENTS: this.env.ATTACHMENTS,
    };
  }

  // The DO establishes its OWN request scope from the script-wide Hyperdrive
  // binding — there is no inbound HTTP request scope to inherit. ctx is null, so
  // withRequestScopedDb awaits its closes/flushes inline at scope end.
  private withDoRequestScope<T>(fn: () => Promise<T>): Promise<T> {
    const bindings = this.dbScopeBindings();
    return withRequestScopedDb(
      this.env.DB.connectionString,
      null,
      bindings,
      () => withNotifyQueueScope(bindings, null, fn),
    );
  }

  private getPersister(): RunStatePersister {
    return this.persister ?? createDefaultRunStatePersister();
  }

  // Run `fn` where the persister can reach Postgres. An INJECTED persister
  // (tests) needs no scope — run inline (the workers pool has no DB binding).
  // The default persister uses getDbPg, so open the DO request scope.
  private withPersisterScope<T>(fn: () => Promise<T>): Promise<T> {
    if (this.persister) return fn();
    return this.withDoRequestScope(fn);
  }

  // The AWAITED terminal persist wrapper (docs/13 §6.3 "bounded retry").
  private boundedFlush<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return withBoundedRetry(fn, {
      attempts: TERMINAL_FLUSH_ATTEMPTS,
      baseDelayMs: this.flushRetryDelayMs,
      label,
    });
  }

  // ─── Production dispatch entry (PR-B) ─────────────────────────────────────
  //
  // start(runIds): what PR-C flips /chat to call instead of the queue send
  // (docs/13 §6.1 — "TalkRunner.start(runIds) replaces dispatch"). Dormant in
  // PR-B (the per-account flag is OFF).
  //
  // DECOUPLED FROM THE CALLER (critical): runs are kicked off DETACHED and start
  // returns fast. /chat (or PR-C's dispatch) must NOT hold the DO invocation
  // open for the run's duration — that would re-impose the ~30s caller ceiling
  // 6A removed. The DO keeps each run alive via its inFlight promise + the step
  // alarm; if an eviction cuts a run short, startup recovery (4A) re-drives it
  // and the reconciliation cron backstops. Parallel-mode runs run concurrently
  // (the DO interleaves at awaits, §6.3); ordered-mode runs run sequentially.
  // Each run gets its own request scope; runOne flushes its own terminal. (The
  // full /chat-during-eviction retry contract is the PR-C smoke — docs/13 §9.)
  async start(runIds: string[]): Promise<{ started: string[] }> {
    if (runIds.length === 0) return { started: [] };
    const first = await this.withDoRequestScope(() =>
      getGreenfieldQueueRunById(runIds[0]!),
    );
    const mode = first?.talk_mode ?? 'ordered';
    const runDetached = (runId: string): Promise<void> =>
      this.withDoRequestScope(() => this.runOne(runId))
        .then(() => undefined)
        .catch((err) =>
          logger.error(
            { err, runId, talkId: this.state.id.name },
            'TalkRunner start: run failed',
          ),
        );
    // keepAlive (not bare void): the runtime must not evict the DO while these
    // detached runs are in flight, or a run is cut short before its terminal
    // flush (startup recovery / reconciliation would then backstop, but at the
    // cost of a wasted turn). waitUntil keeps the DO awake for the run's life
    // without holding the /start response open.
    if (mode === 'parallel') {
      for (const runId of runIds) this.keepAlive(runDetached(runId));
    } else {
      this.keepAlive(
        (async () => {
          for (const runId of runIds) await runDetached(runId);
        })(),
      );
    }
    return { started: runIds };
  }

  // Keep the DO alive until `promise` settles (waitUntil when the runtime
  // exposes it; a bare detached promise otherwise — e.g. test harnesses).
  private keepAlive(promise: Promise<unknown>): void {
    if (this.state.waitUntil) this.state.waitUntil(promise);
    else void promise;
  }

  private async handleStart(request: Request): Promise<Response> {
    let runIds: string[] = [];
    try {
      const body = (await request.json()) as { runIds?: unknown };
      if (Array.isArray(body.runIds)) {
        runIds = body.runIds.filter((r): r is string => typeof r === 'string');
      }
    } catch {
      /* fall through to the empty guard */
    }
    if (runIds.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: { code: 'invalid_request', message: 'runIds required' },
        },
        400,
      );
    }
    const result = await this.start(runIds);
    return jsonResponse({ ok: true, data: result });
  }

  private async handleReconcile(runId: string): Promise<Response> {
    if (!runId) {
      return jsonResponse(
        {
          ok: false,
          error: { code: 'invalid_request', message: 'runId required' },
        },
        400,
      );
    }
    const result = await this.reconcileRun(runId);
    return jsonResponse({ ok: true, data: result });
  }

  // PR-B: cancel do-path runs from the /chat/cancel route. The cancel route
  // already flips Postgres → cancelled + emits talk_run_cancelled; this makes the
  // DO observe it (its streaming guard reads DO SQLite, not Postgres) so it stops
  // streaming and abandons the work. cancel() is the A3 RPC; flushPendingSync
  // then reconciles run_sync (persistCancelled no-ops against the already-cancelled
  // PG row, so there is NO duplicate cancel event).
  private async handleCancel(request: Request): Promise<Response> {
    let runIds: string[] = [];
    try {
      const body = (await request.json()) as { runIds?: unknown };
      if (Array.isArray(body.runIds)) {
        runIds = body.runIds.filter((r): r is string => typeof r === 'string');
      }
    } catch {
      /* fall through to the empty guard */
    }
    if (runIds.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: { code: 'invalid_request', message: 'runIds required' },
        },
        400,
      );
    }
    const results: Array<{
      runId: string;
      cancelled: boolean;
      status: RunStatus | null;
    }> = [];
    for (const runId of runIds) {
      results.push({ runId, ...(await this.cancel(runId)) });
    }
    // Persist the DO cancellations (clears run_sync; PG is already cancelled by
    // the route, so this is a no-op flush — no double event).
    await this.flushPendingSync().catch((err) =>
      logger.error(
        { err, talkId: this.state.id.name },
        'TalkRunner cancel flush failed',
      ),
    );
    return jsonResponse({ ok: true, data: { results } });
  }

  // The production single-run path: claim queued→running (+ talk_run_started) →
  // stream the executor's events live to the hub (3A) → execute the executor as
  // ONE step → flush the terminal state to Postgres (awaited, bounded retry),
  // which emits the terminal event. Assumes the CALLER opened the request scope
  // (handleDevRun / start). Reuses GreenfieldTalkExecutor unchanged.
  private async runOne(runId: string): Promise<RunOneResult> {
    // Cross-talk guard (this DO is idFromName(talkId)): never run another talk's
    // run under this DO and strand its step log here.
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

    // Eager running write (claim) — done before streaming so talk_run_started
    // precedes the response deltas (matches v1 ordering; zero frontend changes).
    const claim = await this.getPersister().claimRunning(runId);
    if (claim.status !== 'claimed') {
      return { devStatus: 'not_claimable', claim: claim.status };
    }
    const run = claim.run;

    const promptInput = run.trigger_message_id
      ? await getGreenfieldTriggerMessageById(run.trigger_message_id)
      : {
          id: null,
          body: await getGreenfieldRunPromptSnapshotText(run.id),
        };
    if (!promptInput?.body) {
      await this.boundedFlush(
        () =>
          this.getPersister().persistFailed({
            runId: run.id,
            errorCode: 'prompt_snapshot_missing',
            errorMessage: 'Run missing trigger message / prompt snapshot text',
          }),
        'persistFailed(prompt)',
      ).catch((err) =>
        logger.error(
          { err, runId: run.id, talkId: this.state.id.name },
          'TalkRunner: failed to persist prompt-missing failure',
        ),
      );
      return { devStatus: 'prompt_missing' };
    }

    const { emit, drain } = this.buildStreamingEmit(run);
    const { plan, getCapturedError } = this.buildExecutorPlan(
      run,
      promptInput.id ?? '',
      promptInput.body,
      emit,
      drain,
      false,
    );
    // The step drains the streamed inserts in its finally (before the run goes
    // terminal), so by here every delta's event_id is below the terminal event's.
    const outcome = await this.executeRun(run.id, plan);
    await this.flushTerminal(run.id, {
      capturedError: getCapturedError(),
      outcomeStatus: outcome.status,
    });
    return { devStatus: outcome.status, outcome };
  }

  // Build the one-step executor plan. The step's checkpoint IS the durable
  // terminal-flush payload (text/metadata + a stable response message id, never
  // inlined binary), so a restart re-flushes a completed run from SQLite without
  // re-running the executor. selfScope=true wraps the executor in its OWN request
  // scope (the resume path has no ambient scope); false assumes the caller's.
  private buildExecutorPlan(
    run: GreenfieldQueueRunRecord,
    triggerMessageId: string,
    triggerContent: string,
    emit: (event: TalkExecutionEvent) => void,
    drain: () => Promise<void>,
    selfScope: boolean,
  ): { plan: TalkRunnerRunPlan; getCapturedError: () => unknown } {
    const input: TalkExecutorInput = {
      runId: run.id,
      talkId: run.talk_id,
      requestedBy: run.requested_by,
      triggerMessageId,
      triggerContent,
      jobId: run.job_id ?? null,
      targetAgentId: run.target_agent_id,
      responseGroupId: run.response_group_id ?? null,
      sequenceIndex: run.sequence_index ?? null,
    };
    let capturedError: unknown = null;
    const runStep = async (
      signal: AbortSignal,
    ): Promise<TalkRunnerStepResult> => {
      // 8A honesty: the whole opaque executor.execute() is ONE step. Per-LLM /
      // per-tool-batch decomposition (finer 8A granularity) needs the executor
      // to surface step boundaries — later Phase 2 work.
      const startedAt = Date.now();
      try {
        const output = await new GreenfieldTalkExecutor().execute(
          input,
          signal,
          emit,
        );
        const responseContent = stripLeadingAgentLabel(
          stripInternalTalkResponseText(output.content),
          output.agentNickname,
        );
        const responseMetadata = output.metadataJson
          ? (JSON.parse(output.metadataJson) as Record<string, unknown>)
          : null;
        const payload: RunCompletedPayload = {
          runId: run.id,
          // Stable across re-flush-from-checkpoint; a re-RUN gets a new id but
          // the persister's status CAS prevents a duplicate message either way.
          responseMessageId: crypto.randomUUID(),
          responseContent,
          responseMetadata,
          agentId: output.agentId ?? null,
          agentNickname: output.agentNickname ?? null,
          providerId: output.providerId ?? null,
          modelId: output.modelId ?? null,
          latencyMs: Date.now() - startedAt,
          usage: output.usage ?? null,
          responseSequenceInRun: output.responseSequenceInRun ?? null,
        };
        // Reference-based (8A): text/metadata only. serializeCheckpoint rejects
        // inlined binary, so a base64-bytes regression fails loudly here.
        return { checkpoint: { kind: COMPLETED_PAYLOAD_KIND, payload } };
      } catch (err) {
        capturedError = err;
        throw err; // let the state machine record the step failure
      } finally {
        // Drain the streamed outbox inserts INSIDE the step — before the run can
        // go terminal and the terminal event is emitted — so the terminal
        // event_id is always above every delta's (gap-free replay, 3A). In the
        // finally so it covers BOTH success and failure, and BOTH the runOne and
        // resume/retry paths (whose terminal flush is a separate flushPendingSync
        // that can't see this emit's pending set).
        await drain();
      }
    };
    const plan: TalkRunnerRunPlan = [
      {
        kind: 'llm',
        execute: selfScope
          ? (signal) => this.withDoRequestScope(() => runStep(signal))
          : runStep,
      },
    ];
    return { plan, getCapturedError: () => capturedError };
  }

  // 3A: forward the executor's stream events to the hub via the SAME
  // insert-before-push path the queue consumer uses (emitOutboxEventOutsideTx —
  // durable INSERT then coalesced notify). Streaming events are NOT
  // write-behind-batched: each is inserted immediately so replay stays gap-free
  // (only run/message STATE is batched). Each emit is GATED on the run still
  // being 'running' in DO SQLite, so after cancel/watchdog flips it terminal a
  // zombie provider's late deltas are dropped — the durable analog of the queue
  // consumer's runAbandoned guard (same run-status fence as casStepWrite).
  //
  // Returns `drain`: each emit's outbox INSERT is fire-and-forget (the executor
  // emits synchronously), but they run on the out-of-band connection while the
  // terminal flush runs on the request-scoped one — different connections, so a
  // pending delta could otherwise commit a HIGHER event_id than the terminal
  // event, reordering replay. runOne awaits drain() before flushTerminal so every
  // streamed event's event_id is below the terminal event's (gap-free replay).
  private buildStreamingEmit(run: GreenfieldQueueRunRecord): {
    emit: (event: TalkExecutionEvent) => void;
    drain: () => Promise<void>;
  } {
    let sanitizer: TalkResponseStreamSanitizer | null = null;
    const pending: Promise<unknown>[] = [];
    const emit = (event: TalkExecutionEvent): void => {
      if (this.readRun(run.id)?.status !== 'running') return;
      let routed: TalkExecutionEvent = event;
      if (event.type === 'talk_response_started') {
        sanitizer = createTalkResponseStreamSanitizer(run.target_agent_name);
      } else if (event.type === 'talk_response_delta') {
        if (!sanitizer) {
          sanitizer = createTalkResponseStreamSanitizer(run.target_agent_name);
        }
        const deltaText = sanitizer.push(event.deltaText);
        if (!deltaText) return;
        routed = { ...event, deltaText };
      } else if (
        event.type === 'talk_response_completed' ||
        event.type === 'talk_response_failed' ||
        event.type === 'talk_response_cancelled'
      ) {
        sanitizer = null;
      }
      pending.push(
        emitOutboxEventOutsideTx({
          topic: `talk:${routed.talkId}`,
          eventType: routed.type,
          payload: routed as unknown as Record<string, unknown>,
          ownerIds: run.owner_ids,
        }).catch((err) =>
          logger.warn(
            { err, eventType: routed.type },
            'TalkRunner outbox emit failed',
          ),
        ),
      );
    };
    return {
      emit,
      drain: async () => void (await Promise.allSettled(pending)),
    };
  }

  // ─── Write-behind terminal flush (PR-B) ─────────────────────────────────

  // Mirror the DO's durable terminal truth into Postgres (awaited, bounded
  // retry). Reads runs_local.status — NOT the in-memory outcome — so a cancel
  // that won the DO CAS flushes 'cancelled', never a stale 'completed'. The
  // accessors are idempotent + monotonic (their `where status='running'` CAS),
  // so a re-flush after a committed terminal is a no-op with NO duplicate event.
  // On success, mark synced=1; on exhaustion, leave it 0 for the backstop.
  // Assumes an ambient persister scope (the caller provides it).
  private async flushTerminal(
    runId: string,
    hint?: { capturedError?: unknown; outcomeStatus?: string },
  ): Promise<void> {
    const run = this.readRun(runId);
    if (!run || !isTerminalRunStatus(run.status)) return;
    const persister = this.getPersister();
    try {
      if (run.status === 'completed') {
        const payload = this.readCompletedPayload(runId);
        if (!payload) {
          // A 'completed' run with no durable response payload (checkpoint
          // corruption / an unexpected plan shape — the production plan always
          // writes one). We cannot persist it as completed, and returning would
          // leave it unsynced forever → a per-minute reconciliation poison-spin.
          // Fail it in Postgres instead so the run reaches a terminal state, the
          // UI moves on, and run_sync is marked (no spin).
          logger.error(
            { runId, talkId: this.state.id.name },
            'TalkRunner: completed run has no payload checkpoint; failing it in PG to avoid a reconciliation poison-spin',
          );
          await this.boundedFlush(
            () =>
              persister.persistFailed({
                runId,
                errorCode: 'talk_runner_missing_payload',
                errorMessage:
                  'Completed run had no durable response payload to persist',
              }),
            'persistFailed(missing-payload)',
          );
          this.markSynced(runId);
          return;
        }
        await this.boundedFlush(
          () => persister.persistCompleted(payload),
          'persistCompleted',
        );
      } else if (run.status === 'failed') {
        const { code, message } = failureReason(
          hint?.capturedError,
          hint?.outcomeStatus,
        );
        await this.boundedFlush(
          () =>
            persister.persistFailed({
              runId,
              errorCode: code,
              errorMessage: message,
            }),
          'persistFailed',
        );
      } else if (run.status === 'cancelled') {
        await this.boundedFlush(
          () => persister.persistCancelled({ runId }),
          'persistCancelled',
        );
      }
      this.markSynced(runId);
    } catch (err) {
      logger.error(
        { err, runId, status: run.status, talkId: this.state.id.name },
        'TalkRunner terminal flush exhausted retries; left unsynced for reconciliation',
      );
    }
  }

  private readCompletedPayload(runId: string): RunCompletedPayload | null {
    const row = this.sql
      .exec<{
        checkpoint_json: string | null;
      }>(
        `select checkpoint_json from steps where run_id=? and status='checkpoint' order by idx desc limit 1`,
        runId,
      )
      .toArray()[0];
    if (!row?.checkpoint_json) return null;
    try {
      const parsed = JSON.parse(row.checkpoint_json) as {
        kind?: string;
        payload?: RunCompletedPayload;
      };
      if (
        parsed?.kind === COMPLETED_PAYLOAD_KIND &&
        parsed.payload?.runId === runId
      ) {
        return parsed.payload;
      }
    } catch {
      /* fall through → null */
    }
    return null;
  }

  private markSynced(runId: string): void {
    this.sql.exec(
      `update run_sync set synced=1, updated_at=? where run_id=?`,
      Date.now(),
      runId,
    );
  }

  // Re-flush every run terminal-in-DO but unconfirmed in Postgres
  // (run_sync.synced=0): the DO eviction/restart backstop + the alarm/retry/cron
  // follow-up. Idempotent (the persister no-ops an already-terminal PG row).
  // Cheap: opens NO scope when nothing is pending, and skips entirely when no
  // Postgres is reachable (workers tests without an injected persister) — the
  // reconciliation cron is the durable backstop.
  async flushPendingSync(): Promise<void> {
    const pending = this.sql
      .exec<{ run_id: string }>(
        `select rs.run_id from run_sync rs
         join runs_local r on r.run_id = rs.run_id
         where rs.synced = 0 and r.status in ('completed','failed','cancelled')`,
      )
      .toArray();
    if (pending.length === 0) return;
    const conn = (this.env as { DB?: { connectionString?: string } }).DB
      ?.connectionString;
    if (!this.persister && !conn) {
      logger.debug(
        { talkId: this.state.id.name, pending: pending.length },
        'TalkRunner flushPendingSync: no Postgres reachable; deferring to reconciliation',
      );
      return;
    }
    await this.withPersisterScope(async () => {
      for (const { run_id } of pending) {
        try {
          await this.flushTerminal(run_id);
        } catch (err) {
          logger.error(
            { err, runId: run_id, talkId: this.state.id.name },
            'TalkRunner pending flush failed',
          );
        }
      }
    });
  }

  // Reconciliation entry for the PATH-AWARE cron (it pings this for a do-path run
  // Postgres still shows queued/running). Returns the action so the cron can
  // decide whether to flag a genuinely stuck run (no_record after the grace).
  async reconcileRun(runId: string): Promise<{
    action:
      | 'flushed'
      | 'noop_synced'
      | 'noop_running'
      | 'flush_failed'
      | 'no_record';
    status: RunStatus | null;
  }> {
    const run = this.readRun(runId);
    if (!run) return { action: 'no_record', status: null };
    if (!isTerminalRunStatus(run.status)) {
      return { action: 'noop_running', status: run.status };
    }
    const synced = this.sql
      .exec<{
        synced: number;
      }>(`select synced from run_sync where run_id=?`, runId)
      .toArray()[0]?.synced;
    if (synced === 1) return { action: 'noop_synced', status: run.status };
    await this.withPersisterScope(() => this.flushTerminal(runId));
    const after = this.sql
      .exec<{
        synced: number;
      }>(`select synced from run_sync where run_id=?`, runId)
      .toArray()[0]?.synced;
    return {
      action: after === 1 ? 'flushed' : 'flush_failed',
      status: run.status,
    };
  }

  // PR-B production plan rebuild (the planProvider seam). Loads the run + prompt
  // from Postgres in its OWN scope (resume/alarm callers have none) and returns a
  // one-step executor plan whose step opens a FRESH scope (selfScope). Rehydrates
  // any R2 page-image refs the latest checkpoint carries via attachment-storage
  // before re-drive (a no-op for the current text-only output checkpoints; the
  // 8A seam the multi-page-PDF round-trip exercises). null ⇒ can't rebuild
  // (missing row / wrong talk / no prompt) → resumeRun defers to the cron.
  private async buildResumePlan(
    runId: string,
  ): Promise<TalkRunnerRunPlan | null> {
    const built = await this.withDoRequestScope(async () => {
      const run = await getGreenfieldQueueRunById(runId);
      if (!run) return null;
      if (
        this.state.id.name !== undefined &&
        run.talk_id !== this.state.id.name
      ) {
        return null;
      }
      const promptInput = run.trigger_message_id
        ? await getGreenfieldTriggerMessageById(run.trigger_message_id)
        : { id: null, body: await getGreenfieldRunPromptSnapshotText(run.id) };
      if (!promptInput?.body) return null;
      await this.rehydrateCheckpointImageRefs(runId);
      return {
        run,
        triggerMessageId: promptInput.id ?? '',
        triggerContent: promptInput.body,
      };
    });
    if (!built) return null;
    // Resume re-streams: the step's finally drains these inserts before the run
    // goes terminal, so the resume path's terminal flush (flushPendingSync) is
    // also gap-free — same guarantee as runOne.
    const { emit, drain } = this.buildStreamingEmit(built.run);
    return this.buildExecutorPlan(
      built.run,
      built.triggerMessageId,
      built.triggerContent,
      emit,
      drain,
      true,
    ).plan;
  }

  // 8A resume rehydration: load (and thereby confirm the presence of) every R2
  // page-image ref the latest checkpoint carries, via attachment-storage's
  // loadAttachmentFile (the production loader the checkpoint test stands in for
  // with a fake). No-op for text-only output checkpoints. Failures throw → the
  // plan rebuild returns null and resumeRun defers rather than re-driving over
  // missing blobs. Must run inside a request scope (loadAttachmentFile needs the
  // ATTACHMENTS binding).
  private async rehydrateCheckpointImageRefs(runId: string): Promise<void> {
    const row = this.sql
      .exec<{
        checkpoint_json: string | null;
      }>(
        `select checkpoint_json from steps where run_id=? and status='checkpoint' order by idx desc limit 1`,
        runId,
      )
      .toArray()[0];
    if (!row?.checkpoint_json) return;
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(row.checkpoint_json);
    } catch {
      return;
    }
    for (const ref of collectCheckpointImageRefs(checkpoint)) {
      await loadAttachmentFile(ref.storageKey);
    }
  }

  // ─── Dev-only route ──────────────────────────────────────────────────────
  //
  // Drives ONE run end-to-end through the production runOne path (write-behind +
  // 3A streaming). Auth + env gated by the Worker route; this env check is
  // defence in depth. The manual "full streamed turn against the local stack"
  // smoke (docs/13 §6.4 PR-B) runs through here.
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
    const data = await this.withDoRequestScope(() => this.runOne(runId));
    return jsonResponse({ ok: true, data });
  }
}

// ─── module helpers ─────────────────────────────────────────────────────

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

// Map a DO 'failed' run to the Postgres failure code/message for the flush. An
// 'abandoned' outcome means the alarm watchdog won the CAS, so the durable cause
// is the watchdog — capturedError (a late executor unwind) is a red herring and
// is ignored. A re-flush after a restart has no in-memory error → a generic
// code. Mirrors the queue consumer's failRun semantics.
function failureReason(
  capturedError: unknown,
  outcomeStatus?: string,
): { code: string; message: string } {
  if (outcomeStatus === 'abandoned') {
    return {
      code: 'talk_runner_watchdog_abandoned',
      message:
        'Run step exceeded its deadline and was failed by the TalkRunner watchdog',
    };
  }
  if (capturedError instanceof TalkExecutorError) {
    return { code: capturedError.code, message: capturedError.message };
  }
  if (capturedError instanceof Error && capturedError.message) {
    return { code: 'talk_runner_step_failed', message: capturedError.message };
  }
  return {
    code: 'talk_runner_step_failed',
    message: 'Run step failed under the TalkRunner',
  };
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
