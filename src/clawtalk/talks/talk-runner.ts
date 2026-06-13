// TalkRunner — per-Talk Durable Object that owns run execution.
//
// Talk Runtime v2, Wave 2 PR-A1 (docs/13-talk-runtime-v2.md §6.1/§6.3/§6.4;
// ~/.claude/plans/encapsulated-plotting-mist.md). One instance per Talk
// (idFromName(talkId), D1). This PR is the SKELETON only:
//
//   • DO SQLite schema (the plan's sketch, verbatim): runs_local / steps /
//     step_deadlines.
//   • The step state machine PENDING → RUNNING → CHECKPOINT → terminal
//     (one LLM streaming call OR one tool batch = one step, 8A).
//   • A dev-only route (/dev/run) that drives ONE run end-to-end by reusing
//     GreenfieldTalkExecutor UNCHANGED, inside the DO's own request-scoped
//     DB. Not wired to /chat.
//   • Reference-based checkpoints with a hard <1MB serialized assert (8A —
//     the DO SQLite value cap is 2MB; an inlined provider message array
//     with PDF pages blows it).
//   • CAS-fencing-ready writes: every post-await checkpoint/failure write
//     is guarded on (run_id, idx, attempt, status='running'). A1 only ever
//     runs attempt 1, so the guard is a structural no-op here; it becomes
//     load-bearing in A3 when the alarm spawns a competing retry attempt
//     (the durable analog of the queue consumer's `runAbandoned` guard).
//
// EXPLICITLY NOT in A1 (do not read this as production-complete):
//   • The min-deadline alarm/watchdog (1A) — A2. A1 records deadlines in
//     step_deadlines but arms no alarm.
//   • Startup/alarm resume (4A) — A2.
//   • Cancel RPC + real stale-attempt fencing TEST — A3.
//   • Write-behind batching + insert-before-push hub streaming (3A) — PR-B.
//     The /dev/run route persists run lifecycle SYNCHRONOUSLY via the same
//     v1 accessors the queue consumer uses (markGreenfieldRunRunning /
//     completeGreenfieldRun); that is NOT the v2 write-behind contract.
//
// Mirrors the production DO precedent in user-event-hub.ts: local CF type
// shims (no repo-wide @cloudflare/workers-types), schema setup under
// blockConcurrencyWhile in the constructor.

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
const MAX_CHECKPOINT_BYTES = 1_000_000;

// Per-step deadline defaults (recorded into step_deadlines; A2 arms the
// alarm off min(deadline_ms)). An LLM streaming step can be long; a tool
// batch should be quicker. These are the A1 placeholders — the right
// per-step budget table is an open A2 question (docs/13 §9).
const DEFAULT_STEP_DEADLINE_MS: Record<StepKind, number> = {
  llm: 5 * 60 * 1000,
  tools: 60 * 1000,
};

// ─── Step / run model ───────────────────────────────────────────────────

export type StepKind = 'llm' | 'tools';
export type StepStatus = 'pending' | 'running' | 'checkpoint' | 'failed';
// A run is created 'running' and moves straight to a terminal state. ('pending'
// is a STEP state, not a run state.) 'cancelled' is reserved for the A3 cancel
// RPC — markRunTerminal already accepts it so A3 needs no signature change.
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

export type RunOutcome =
  | { status: 'completed'; steps: number }
  | { status: 'failed'; failedStepIdx: number }
  // A step's post-await write lost the CAS race against a competing attempt.
  // Unreachable in A1 (single attempt); surfaced so A3 can assert it.
  | { status: 'abandoned'; abandonedStepIdx: number };

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

  constructor(state: DurableObjectStateLike, env: TalkRunnerEnv) {
    this.state = state;
    this.env = env;
    // Schema must exist before any method touches storage. blockConcurrencyWhile
    // defers all incoming fetch()/RPC until this resolves (the A2 startup
    // resume scan will join this same block).
    void this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
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
  // WITHIN a run are sequential (this loop awaits each). The DO is single-
  // threaded for compute but interleaves at awaits, so this method is written
  // re-entry-safe (idempotent): re-entering a terminal run is a no-op, and an
  // already-checkpointed step is skipped rather than re-run. A2 wires the
  // startup/alarm scan that re-invokes this on resume; A3 adds per-run cancel
  // via the AbortController below and per-run alarms off step_deadlines.
  async executeRun(
    runId: string,
    plan: TalkRunnerRunPlan,
  ): Promise<RunOutcome> {
    // Re-entry guard: a run that already reached a terminal state stays there.
    // Re-running would re-execute completed work and rewind the step log
    // (a duplicate invocation, or A2 resume racing a still-live attempt).
    const existing = this.readRun(runId);
    if (existing && isTerminalRunStatus(existing.status)) {
      return this.outcomeFromState(runId, existing.status, plan.length);
    }

    const now = Date.now();
    this.sql.exec(
      `insert into runs_local (run_id, status, started_at, updated_at)
       values (?, 'running', ?, ?)
       on conflict(run_id) do update set status='running', updated_at=excluded.updated_at`,
      runId,
      now,
      now,
    );

    // A1 has no cancellation; the controller exists so A3 can wire the cancel
    // RPC to abort in-flight steps in this same isolate.
    const controller = new AbortController();

    for (let idx = 0; idx < plan.length; idx += 1) {
      const outcome = await this.runStep(
        runId,
        idx,
        plan[idx]!,
        controller.signal,
      );
      if (outcome === 'failed') {
        this.markRunTerminal(runId, 'failed');
        return { status: 'failed', failedStepIdx: idx };
      }
      if (outcome === 'fenced') {
        // A competing attempt won the CAS race; this attempt writes nothing
        // and the run is abandoned to whoever owns the live attempt. Cannot
        // happen in A1 (single attempt) — guarded for A3.
        return { status: 'abandoned', abandonedStepIdx: idx };
      }
    }

    this.markRunTerminal(runId, 'completed');
    return { status: 'completed', steps: plan.length };
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

  // One step: PENDING → arm deadline → RUNNING → (CHECKPOINT | FAILED).
  // Every post-await write is CAS-guarded on (run_id, idx, attempt,
  // status='running') so a late-resolving abandoned attempt writes nothing.
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

    // A1 runs only attempt 1; A3 bumps this when the alarm retries a step.
    const attempt = 1;
    const deadlineMs =
      Date.now() + (step.deadlineMs ?? DEFAULT_STEP_DEADLINE_MS[step.kind]);

    // → PENDING. Already-checkpointed steps were skipped above, so this only
    // (re)writes a not-yet-done step: fresh on first entry, or re-arming a
    // step interrupted mid-flight (re-run is correct — it never checkpointed).
    // A2/A3 add the live-attempt fencing for a step still 'running' on a
    // concurrent attempt; the CAS-guarded writes below already make a stale
    // attempt's late write a no-op.
    this.sql.exec(
      `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
       values (?, ?, ?, 'pending', ?, null, ?)
       on conflict(run_id, idx) do update set
         kind=excluded.kind, status='pending', attempt=excluded.attempt,
         checkpoint_json=null, deadline_ms=excluded.deadline_ms`,
      runId,
      idx,
      step.kind,
      attempt,
      deadlineMs,
    );
    // Arm the deadline (1A table). A1 records it; A2's alarm() targets
    // min(deadline_ms) across in-flight steps.
    this.sql.exec(
      `insert into step_deadlines (run_id, idx, deadline_ms) values (?, ?, ?)
       on conflict(run_id, idx) do update set deadline_ms=excluded.deadline_ms`,
      runId,
      idx,
      deadlineMs,
    );
    // → RUNNING.
    this.sql.exec(
      `update steps set status='running'
       where run_id=? and idx=? and attempt=? and status='pending'`,
      runId,
      idx,
      attempt,
    );

    try {
      const result = await step.execute(signal);
      // Serialize + assert BEFORE the CAS write so an oversized checkpoint
      // surfaces as a failed step (visible), never a silent truncation.
      const checkpointJson = serializeCheckpoint(result.checkpoint);
      const written = this.sql.exec(
        `update steps set status='checkpoint', checkpoint_json=?
         where run_id=? and idx=? and attempt=? and status='running'`,
        checkpointJson,
        runId,
        idx,
        attempt,
      ).rowsWritten;
      // Fenced (written===0): a competing attempt owns this step now. Do NOT
      // clear the deadline — it belongs to the live attempt. Clearing it would
      // erase the live attempt's only watchdog entry and strand it (A3).
      if (written === 0) return 'fenced';
      this.clearDeadline(runId, idx);
      return 'checkpoint';
    } catch (err) {
      const written = this.sql.exec(
        `update steps set status='failed'
         where run_id=? and idx=? and attempt=? and status='running'`,
        runId,
        idx,
        attempt,
      ).rowsWritten;
      logger.warn(
        {
          err,
          runId,
          idx,
          kind: step.kind,
          talkId: this.state.id.name,
        },
        'TalkRunner step failed',
      );
      // A late abandoned attempt that lost the CAS race must not be treated as
      // this run's failure, and must not clear the live attempt's deadline.
      if (written === 0) return 'fenced';
      this.clearDeadline(runId, idx);
      return 'failed';
    }
  }

  private markRunTerminal(runId: string, status: RunStatus): void {
    this.sql.exec(
      `update runs_local set status=?, updated_at=? where run_id=?`,
      status,
      Date.now(),
      runId,
    );
  }

  private clearDeadline(runId: string, idx: number): void {
    this.sql.exec(
      `delete from step_deadlines where run_id=? and idx=?`,
      runId,
      idx,
    );
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

function serializeCheckpoint(checkpoint: unknown): string {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
