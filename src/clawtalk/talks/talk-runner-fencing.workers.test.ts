// TalkRunner cancel + stale-attempt fencing tests — Talk Runtime v2, Wave 2
// PR-A3. Runs in REAL workerd SQLite (so the per-attempt CAS fence, the
// run-status fence, and alarm-driven retry behave exactly as in prod).
//
// HONESTY (see the PR description): this is DO-LOCAL. It proves the fence and
// cancel correctness inside one DO isolate. Visibility of cancel to Postgres /
// UI / the hub / reconciliation is PR-B, and the real /chat route is PR-C —
// this is NOT yet production cancel correctness.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

import type { StepKind } from './talk-runner.js';

function getRunner(name: string) {
  return env.TALK_RUNNER.get(env.TALK_RUNNER.idFromName(name));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A step that announces when it is in-flight (running + deadline armed) and then
// blocks until the test releases it, returning a CONFIGURABLE checkpoint. It
// resolves on release REGARDLESS of abort — i.e. it models a provider that
// ignores the abort signal, so the test proves the durable CAS fence (not the
// in-memory abort) is what prevents a stale write. Deadlines are always FUTURE
// (tests expire a step with a direct step_deadlines UPDATE) so the runtime
// never auto-fires the alarm mid-test.
function gateStep(opts: {
  kind?: StepKind;
  deadlineMs: number;
  checkpoint: unknown;
}) {
  const ready = deferred();
  const release = deferred();
  let aborted = false;
  const step = {
    kind: opts.kind ?? ('llm' as StepKind),
    deadlineMs: opts.deadlineMs,
    execute: async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      ready.resolve();
      await release.promise;
      return { checkpoint: opts.checkpoint };
    },
  };
  return {
    step,
    ready: ready.promise,
    release: () => release.resolve(),
    wasAborted: () => aborted,
  };
}

// Read step 0's (attempt, status, checkpoint) — the fence-relevant durable cols.
function readStep0(
  state: {
    storage: { sql: { exec(q: string, ...b: unknown[]): { one(): unknown } } };
  },
  runId: string,
) {
  return state.storage.sql
    .exec(
      'select attempt, status, checkpoint_json from steps where run_id=? and idx=0',
      runId,
    )
    .one() as {
    attempt: number;
    status: string;
    checkpoint_json: string | null;
  };
}

describe('TalkRunner stale-attempt fencing (PR-A3)', () => {
  it('fences a stale attempt: attempt 1 times out, attempt 2 runs, attempt 1 resolves late → zero stale writes', async () => {
    const stub = getRunner('fence-attempts');
    const runId = 'run-fence';
    // Attempt 1 wedges (ignores its abort) and resolves only when the test
    // releases it — LATE, while attempt 2 is STILL RUNNING.
    const a1 = gateStep({ deadlineMs: 30_000, checkpoint: { attempt: 1 } });
    // Attempt 2 is what the watchdog re-drives via the rebuilt plan.
    const a2 = gateStep({ deadlineMs: 30_000, checkpoint: { attempt: 2 } });

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    // Phase 1 — attempt 1 wedges; the watchdog RETRIES → attempt 2 starts running.
    const mid = await runInDurableObject(stub, async (instance, state) => {
      p1 = instance.executeRun(runId, [a1.step]);
      await a1.ready; // attempt 1 in-flight (running, deadline armed)
      // The rebuilt plan the watchdog retries with is a FRESH gate (attempt 2).
      instance.planProvider = async () => [a2.step];
      // Expire attempt 1's deadline, then fire the alarm. attempt 1 < MAX_STEP
      // ATTEMPTS and planProvider is set → the watchdog RETRIES (does not fail).
      state.storage.sql.exec(
        'update step_deadlines set deadline_ms=? where run_id=?',
        Date.now() - 1_000,
        runId,
      );
      await instance.alarm();
      // The detached re-drive is now attempt 2; wait for it to be in-flight and
      // grab its completion promise via the executeRun dedup.
      await a2.ready;
      p2 = instance.executeRun(runId, [a2.step]); // dedups to the live re-drive
      return readStep0(state, runId);
    });
    // The watchdog bumped the attempt to 2 and aborted attempt 1.
    expect(mid).toEqual({
      attempt: 2,
      status: 'running',
      checkpoint_json: null,
    });
    expect(a1.wasAborted()).toBe(true);

    // Phase 2 — attempt 1 resolves LATE while attempt 2 is STILL RUNNING. The
    // step row is (attempt 2, status 'running') and the run is 'running', so the
    // ONLY thing that can fence attempt 1's write is the ATTEMPT mismatch. This
    // is what makes the attempt fence uniquely load-bearing here (not the
    // step-status or run-status guard).
    a1.release();
    expect(await p1).toEqual({ status: 'abandoned', abandonedStepIdx: 0 });
    const afterStale = await runInDurableObject(stub, async (_i, state) =>
      readStep0(state, runId),
    );
    // Attempt 1 wrote NOTHING: still attempt 2, still running, no checkpoint.
    expect(afterStale).toEqual({
      attempt: 2,
      status: 'running',
      checkpoint_json: null,
    });

    // Phase 3 — attempt 2 completes; it owns the durable checkpoint + terminal.
    a2.release();
    expect(await p2).toEqual({ status: 'completed', steps: 1 });
    const after = await runInDurableObject(stub, async (_i, state) => {
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one() as { status: string };
      const steps = state.storage.sql
        .exec(
          'select idx, attempt, status, checkpoint_json from steps where run_id=? order by idx',
          runId,
        )
        .toArray() as {
        idx: number;
        attempt: number;
        status: string;
        checkpoint_json: string | null;
      }[];
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines where run_id=?', runId)
        .one().n as number;
      return { run, steps, openDeadlines };
    });
    // EXACTLY ONE step row, owned by attempt 2. Attempt 1's late write landed
    // NOTHING: no duplicate row, no checkpoint, no terminal regression.
    expect(after.run.status).toBe('completed');
    expect(after.steps).toHaveLength(1);
    expect(after.steps[0]!.attempt).toBe(2);
    expect(after.steps[0]!.status).toBe('checkpoint');
    expect(after.steps[0]!.checkpoint_json).toBe('{"attempt":2}'); // NOT attempt 1
    expect(after.openDeadlines).toBe(0);
  });

  it('falls back to FAIL (no retry) when the attempt budget is exhausted', async () => {
    // attempt already at MAX_STEP_ATTEMPTS → the watchdog must fail, not retry,
    // even though a planProvider is available. (Guards the retry budget.)
    const stub = getRunner('fence-budget');
    const runId = 'run-budget';
    const blk = gateStep({ deadlineMs: 60_000, checkpoint: { late: true } });
    let runP!: Promise<unknown>;

    const mid = await runInDurableObject(stub, async (instance, state) => {
      runP = instance.executeRun(runId, [blk.step]);
      await blk.ready;
      // Pretend this is already the final attempt.
      state.storage.sql.exec(
        'update steps set attempt=2 where run_id=? and idx=0',
        runId,
      );
      let providerCalls = 0;
      instance.planProvider = async () => {
        providerCalls += 1;
        return [blk.step];
      };
      state.storage.sql.exec(
        'update step_deadlines set deadline_ms=? where run_id=?',
        Date.now() - 1_000,
        runId,
      );
      await instance.alarm();
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one() as { status: string };
      return { run, providerCalls, aborted: blk.wasAborted() };
    });

    // Budget exhausted → failed, no plan rebuild attempted.
    expect(mid.run.status).toBe('failed');
    expect(mid.providerCalls).toBe(0);
    expect(mid.aborted).toBe(true);

    blk.release();
    expect(await runP).toEqual({ status: 'abandoned', abandonedStepIdx: 0 });
  });
});

describe('TalkRunner cancel RPC (PR-A3)', () => {
  it('cancel mid-step aborts promptly and fences the in-flight write (no further checkpoints)', async () => {
    const stub = getRunner('cancel-mid');
    const runId = 'run-cancel';
    const blk = gateStep({
      deadlineMs: 60_000,
      checkpoint: { shouldNotPersist: true },
    });
    const step1Ran = { v: false };
    let runP!: Promise<unknown>;

    const mid = await runInDurableObject(stub, async (instance, state) => {
      runP = instance.executeRun(runId, [
        blk.step,
        {
          kind: 'tools' as StepKind,
          execute: async () => {
            step1Ran.v = true;
            return { checkpoint: { two: true } };
          },
        },
      ]);
      await blk.ready; // step 0 in-flight
      const res = await instance.cancel(runId);
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one() as { status: string };
      const step0 = state.storage.sql
        .exec(
          'select status, checkpoint_json from steps where run_id=? and idx=0',
          runId,
        )
        .one() as { status: string; checkpoint_json: string | null };
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines where run_id=?', runId)
        .one().n as number;
      return { res, run, step0, openDeadlines, aborted: blk.wasAborted() };
    });

    expect(mid.res).toEqual({ cancelled: true, status: 'cancelled' });
    expect(mid.run.status).toBe('cancelled');
    expect(mid.aborted).toBe(true); // prompt cooperative abort
    // Cancel does NOT touch the step row — the run-status guard fences the write.
    expect(mid.step0.status).toBe('running');
    expect(mid.step0.checkpoint_json).toBeNull();
    expect(mid.openDeadlines).toBe(0); // deadlines cleared → watchdog won't fire

    // The wedged step resolves LATE — its checkpoint write must fence because the
    // run is no longer 'running'.
    blk.release();
    expect(await runP).toEqual({ status: 'cancelled' });

    const after = await runInDurableObject(stub, async (_i, state) => {
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one() as { status: string };
      const step0 = state.storage.sql
        .exec(
          'select status, checkpoint_json from steps where run_id=? and idx=0',
          runId,
        )
        .one() as { status: string; checkpoint_json: string | null };
      const stepCount = state.storage.sql
        .exec('select count(*) as n from steps where run_id=?', runId)
        .one().n as number;
      const alarm = await state.storage.getAlarm();
      return { run, step0, stepCount, alarm };
    });

    expect(after.run.status).toBe('cancelled'); // unchanged by the late resolve
    expect(after.step0.checkpoint_json).toBeNull(); // fenced write never landed
    expect(after.stepCount).toBe(1); // step 1 never started
    expect(step1Ran.v).toBe(false); // no further work after cancel
    expect(after.alarm).toBeNull();
  });

  it('cancelling a completed run is a monotonic no-op', async () => {
    const stub = getRunner('cancel-terminal');
    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.executeRun('run-done', [
        {
          kind: 'llm' as StepKind,
          execute: async () => ({ checkpoint: { ok: true } }),
        },
      ]);
      const res = await instance.cancel('run-done');
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-done')
        .one() as { status: string };
      return { res, run };
    });
    // The completed run is NOT flipped to cancelled.
    expect(result.res).toEqual({ cancelled: false, status: 'completed' });
    expect(result.run.status).toBe('completed');
  });

  it('cancelling an unknown run reports not-cancelled', async () => {
    const stub = getRunner('cancel-unknown');
    const res = await runInDurableObject(stub, async (instance) =>
      instance.cancel('run-nope'),
    );
    expect(res).toEqual({ cancelled: false, status: null });
  });
});

describe('TalkRunner 8A reference checkpoint in the machine (PR-A3)', () => {
  it('checkpoints a reference-shaped multi-page-PDF checkpoint under the 1MB cap', async () => {
    const stub = getRunner('ckpt-ref');
    // A reference checkpoint: text/structure + R2 keys for 6 PDF pages, with NO
    // inlined image bytes (mirrors the shape of
    // eval/fixtures/talk-runtime-v2/checkpoint-pdf/reference-checkpoint.json,
    // whose inline-bytes sibling is 4.1MB and blows the 2MB SQLite value cap).
    const referenceCheckpoint = {
      kind: 'provider_messages_ref',
      messages: [
        { role: 'system', content: 'Summarize the report; cite page numbers.' },
        {
          role: 'user',
          content: Array.from({ length: 6 }, (_, i) => ({
            type: 'pdf_page_image_ref',
            mimeType: 'image/jpeg',
            storageKey: `attachments/talk-fixture/report/page-${i}.jpg`,
            pageIndex: i,
            byteLength: 512_000,
          })),
        },
      ],
    };
    const result = await runInDurableObject(stub, async (instance, state) => {
      const outcome = await instance.executeRun('run-ref', [
        {
          kind: 'llm' as StepKind,
          execute: async () => ({ checkpoint: referenceCheckpoint }),
        },
      ]);
      const step = state.storage.sql
        .exec(
          'select status, checkpoint_json from steps where run_id=? and idx=0',
          'run-ref',
        )
        .one() as { status: string; checkpoint_json: string };
      return { outcome, json: step.checkpoint_json, status: step.status };
    });

    expect(result.outcome).toEqual({ status: 'completed', steps: 1 });
    expect(result.status).toBe('checkpoint');
    // Stored, structure preserved, well under the 1MB cap, and crucially with NO
    // inlined image bytes — only R2 refs.
    expect(new TextEncoder().encode(result.json).length).toBeLessThan(
      1_000_000,
    );
    expect(result.json).toContain('pdf_page_image_ref');
    expect(result.json).not.toContain('base64');
  });
});
