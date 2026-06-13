// TalkRunner alarm + resume tests — Talk Runtime v2, Wave 2 PR-A2.
//
// Covers the 1A min-deadline alarm watchdog and the 4A startup/alarm resume in
// REAL workerd SQLite (so getAlarm/setAlarm and alarm() behave as in prod).
//
// HONESTY (see the PR description): this is DO-LOCAL. It drives the step
// machine, the alarm table, and the shared resumeRun via injected stub plans —
// NOT the production path. Hub streaming, write-behind durability, the
// Postgres-backed plan rebuild for cross-eviction resume, per-attempt retry,
// and the adversarial multi-attempt fencing test arrive in A3/PR-B. A2 keeps
// attempt=1: the watchdog neutralises a wedged attempt by flipping its step off
// 'running', so the CAS fence holds without a competing attempt yet.
import { describe, expect, it } from 'vitest';
import {
  env,
  runInDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';

import type { StepKind, TalkRunnerRunPlan } from './talk-runner.js';

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

// A step that announces when it is in-flight (running + deadline armed) and
// then blocks until the test releases it — so a test can arm a deadline, fire
// the alarm, and inspect state while the step is genuinely mid-execute.
// Deadlines passed here are always FUTURE (tests expire a step with a direct
// step_deadlines UPDATE) so the runtime never auto-fires the alarm mid-test.
function blockingStep(opts: { kind?: StepKind; deadlineMs: number }) {
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
      // Resolve on release REGARDLESS of abort — i.e. simulate a provider that
      // ignores the abort signal, so the test proves the CAS fence (not the
      // abort) is what prevents corruption.
      await release.promise;
      return { checkpoint: { done: true } };
    },
  };
  return {
    step,
    ready: ready.promise,
    release: () => release.resolve(),
    wasAborted: () => aborted,
  };
}

describe('TalkRunner 1A min-deadline alarm (PR-A2)', () => {
  it('arms the single alarm at min(deadline) across N concurrent in-flight steps', async () => {
    const stub = getRunner('alarm-min');
    const a = blockingStep({ deadlineMs: 30_000 });
    const b = blockingStep({ deadlineMs: 10_000 }); // earliest
    const c = blockingStep({ deadlineMs: 20_000 });

    const result = await runInDurableObject(stub, async (instance, state) => {
      const t0 = Date.now();
      const pa = instance.executeRun('run-a', [a.step]);
      const pb = instance.executeRun('run-b', [b.step]);
      const pc = instance.executeRun('run-c', [c.step]);
      // All three steps now running with deadlines armed.
      await Promise.all([a.ready, b.ready, c.ready]);
      const alarm = await state.storage.getAlarm();
      const deadlines = state.storage.sql
        .exec(
          'select run_id, deadline_ms from step_deadlines order by deadline_ms',
        )
        .toArray() as { run_id: string; deadline_ms: number }[];
      a.release();
      b.release();
      c.release();
      await Promise.all([pa, pb, pc]);
      return { alarm, deadlines, t0 };
    });

    const minDeadline = Math.min(...result.deadlines.map((d) => d.deadline_ms));
    // The single alarm targets the EARLIEST in-flight deadline, not a/c.
    expect(result.alarm).toBe(minDeadline);
    expect(result.deadlines[0]!.run_id).toBe('run-b');
    // Sanity: ~10s out, not 20/30.
    expect(result.alarm! - result.t0).toBeGreaterThanOrEqual(9_000);
    expect(result.alarm! - result.t0).toBeLessThan(15_000);
  });

  it('clears the alarm once every in-flight step settles', async () => {
    const stub = getRunner('alarm-clear');
    const result = await runInDurableObject(stub, async (instance, state) => {
      const plan: TalkRunnerRunPlan = [
        { kind: 'llm', execute: async () => ({ checkpoint: { ok: true } }) },
      ];
      await instance.executeRun('run-clear', plan);
      const alarm = await state.storage.getAlarm();
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines')
        .one().n as number;
      return { alarm, openDeadlines };
    });
    // No in-flight steps left → no armed alarm.
    expect(result.openDeadlines).toBe(0);
    expect(result.alarm).toBeNull();
  });

  it('fails only the expired step and re-arms to the next-earliest', async () => {
    const stub = getRunner('alarm-earliest');
    const r1 = blockingStep({ deadlineMs: 10_000 });
    const r2 = blockingStep({ deadlineMs: 20_000 });
    const r3 = blockingStep({ deadlineMs: 30_000 });

    const result = await runInDurableObject(stub, async (instance, state) => {
      const p1 = instance.executeRun('run-1', [r1.step]);
      const p2 = instance.executeRun('run-2', [r2.step]);
      const p3 = instance.executeRun('run-3', [r3.step]);
      await Promise.all([r1.ready, r2.ready, r3.ready]);
      // Expire ONLY run-1 (direct table edit → the runtime's armed alarm stays
      // future and won't auto-fire; we invoke the handler ourselves).
      state.storage.sql.exec(
        'update step_deadlines set deadline_ms=? where run_id=?',
        Date.now() - 1_000,
        'run-1',
      );
      await instance.alarm();
      const runs = state.storage.sql
        .exec('select run_id, status from runs_local order by run_id')
        .toArray() as { run_id: string; status: string }[];
      const steps = state.storage.sql
        .exec(
          "select run_id, status from steps where status='failed' order by run_id",
        )
        .toArray() as { run_id: string; status: string }[];
      const deadlines = state.storage.sql
        .exec(
          'select run_id, deadline_ms from step_deadlines order by deadline_ms',
        )
        .toArray() as { run_id: string; deadline_ms: number }[];
      const alarmAfter = await state.storage.getAlarm();
      r1.release();
      r2.release();
      r3.release();
      await Promise.allSettled([p1, p2, p3]);
      return {
        runs,
        steps,
        deadlines,
        alarmAfter,
        r1Aborted: r1.wasAborted(),
      };
    });

    // run-1 watchdog-failed; run-2/run-3 untouched and still running.
    expect(result.runs).toEqual([
      { run_id: 'run-1', status: 'failed' },
      { run_id: 'run-2', status: 'running' },
      { run_id: 'run-3', status: 'running' },
    ]);
    expect(result.steps).toEqual([{ run_id: 'run-1', status: 'failed' }]);
    // run-1's deadline cleared; run-2 & run-3 remain (run-2 earliest).
    expect(result.deadlines.map((d) => d.run_id)).toEqual(['run-2', 'run-3']);
    // Alarm re-armed to the next-earliest in-flight deadline (run-2).
    expect(result.alarmAfter).toBe(result.deadlines[0]!.deadline_ms);
    // The live attempt was aborted by the watchdog.
    expect(result.r1Aborted).toBe(true);
  });

  it('fails BOTH steps that expire in the same alarm() and re-arms to the survivor', async () => {
    const stub = getRunner('alarm-two-expire');
    const r1 = blockingStep({ deadlineMs: 10_000 });
    const r2 = blockingStep({ deadlineMs: 20_000 });
    const r3 = blockingStep({ deadlineMs: 30_000 });

    const result = await runInDurableObject(stub, async (instance, state) => {
      const p1 = instance.executeRun('run-1', [r1.step]);
      const p2 = instance.executeRun('run-2', [r2.step]);
      const p3 = instance.executeRun('run-3', [r3.step]);
      await Promise.all([r1.ready, r2.ready, r3.ready]);
      // Expire run-1 AND run-2 (run-3 stays future). One alarm() must fail both.
      const now = Date.now();
      state.storage.sql.exec(
        'update step_deadlines set deadline_ms=? where run_id in (?, ?)',
        now - 1_000,
        'run-1',
        'run-2',
      );
      await instance.alarm();
      const runs = state.storage.sql
        .exec('select run_id, status from runs_local order by run_id')
        .toArray() as { run_id: string; status: string }[];
      const deadlines = state.storage.sql
        .exec('select run_id from step_deadlines order by deadline_ms')
        .toArray() as { run_id: string }[];
      const alarmAfter = await state.storage.getAlarm();
      r1.release();
      r2.release();
      r3.release();
      await Promise.allSettled([p1, p2, p3]);
      return { runs, deadlines, alarmAfter };
    });

    expect(result.runs).toEqual([
      { run_id: 'run-1', status: 'failed' },
      { run_id: 'run-2', status: 'failed' },
      { run_id: 'run-3', status: 'running' },
    ]);
    // Only run-3's deadline survives; the alarm re-arms to it.
    expect(result.deadlines).toEqual([{ run_id: 'run-3' }]);
    expect(result.alarmAfter).not.toBeNull();
  });

  it('fires the runtime-armed alarm end-to-end via runDurableObjectAlarm', async () => {
    const stub = getRunner('alarm-runtime-fire');
    const blk = blockingStep({ deadlineMs: 30_000 });
    let runPromise!: Promise<unknown>;

    // Start a run; expire its deadline row but LEAVE the runtime alarm at its
    // natural future time so workerd doesn't auto-fire it first. Then let the
    // pool helper deliver the alarm (it runs a scheduled alarm immediately,
    // regardless of due-time). Proves the armed alarm + alarm() wire together,
    // not just the handler in isolation.
    await runInDurableObject(stub, async (instance, state) => {
      runPromise = instance.executeRun('run-rt', [blk.step]);
      await blk.ready;
      const armed = await state.storage.getAlarm();
      expect(armed).not.toBeNull(); // arming actually scheduled an alarm
      state.storage.sql.exec(
        'update step_deadlines set deadline_ms=? where run_id=?',
        Date.now() - 1_000,
        'run-rt',
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    blk.release();
    await runPromise;

    const after = await runInDurableObject(stub, async (instance, state) => {
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-rt')
        .one() as { status: string };
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines')
        .one().n as number;
      const alarm = await state.storage.getAlarm();
      return { run, openDeadlines, alarm };
    });
    expect(after.run.status).toBe('failed');
    expect(after.openDeadlines).toBe(0);
    expect(after.alarm).toBeNull();
  });

  it('does not corrupt a step when the alarm fires DURING its provider stream', async () => {
    const stub = getRunner('alarm-mid-stream');
    const blk = blockingStep({ deadlineMs: 60_000 });
    let runPromise!: Promise<{ status: string }>;

    const failedState = await runInDurableObject(
      stub,
      async (instance, state) => {
        runPromise = instance.executeRun('run-stream', [blk.step]) as Promise<{
          status: string;
        }>;
        await blk.ready; // step is mid-execute (the "provider stream")
        // Expire it and fire the watchdog while execute() is still pending.
        state.storage.sql.exec(
          'update step_deadlines set deadline_ms=? where run_id=?',
          Date.now() - 1_000,
          'run-stream',
        );
        await instance.alarm();
        // Snapshot the watchdog-failed state BEFORE the late stream resolves.
        const run = state.storage.sql
          .exec('select status from runs_local where run_id=?', 'run-stream')
          .one() as { status: string };
        const step = state.storage.sql
          .exec(
            'select status, checkpoint_json from steps where run_id=? and idx=0',
            'run-stream',
          )
          .one() as { status: string; checkpoint_json: string | null };
        return { run, step };
      },
    );

    // run + step already failed by the watchdog; no checkpoint written.
    expect(failedState.run.status).toBe('failed');
    expect(failedState.step.status).toBe('failed');
    expect(failedState.step.checkpoint_json).toBeNull();

    // Now the provider stream resolves LATE — its checkpoint write must be
    // fenced (CAS on status='running' finds 'failed'), corrupting nothing.
    blk.release();
    const outcome = await runPromise;
    expect(outcome).toEqual({ status: 'abandoned', abandonedStepIdx: 0 });

    const after = await runInDurableObject(stub, async (_i, state) => {
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-stream')
        .one() as { status: string };
      const step = state.storage.sql
        .exec(
          'select status, checkpoint_json from steps where run_id=? and idx=0',
          'run-stream',
        )
        .one() as { status: string; checkpoint_json: string | null };
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines')
        .one().n as number;
      return { run, step, openDeadlines };
    });
    // Durable state UNCHANGED by the late resolve: still failed, still no blob.
    expect(after.run.status).toBe('failed');
    expect(after.step.status).toBe('failed');
    expect(after.step.checkpoint_json).toBeNull();
    expect(after.openDeadlines).toBe(0);
    expect(blk.wasAborted()).toBe(true);
  });
});

describe('TalkRunner 4A resume (PR-A2)', () => {
  // Seed an interrupted run directly in SQLite (as a restart would leave it):
  // step 0 checkpointed, step `runningIdx` left 'running' with a deadline.
  function seedInterruptedRun(
    state: { storage: { sql: { exec(q: string, ...b: unknown[]): unknown } } },
    runId: string,
    opts: { deadlineMs: number },
  ) {
    const now = Date.now();
    const sql = state.storage.sql;
    sql.exec(
      `insert into runs_local (run_id, status, started_at, updated_at) values (?, 'running', ?, ?)`,
      runId,
      now,
      now,
    );
    sql.exec(
      `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
       values (?, 0, 'llm', 'checkpoint', 1, ?, ?)`,
      runId,
      '{"step":0}',
      now,
    );
    sql.exec(
      `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
       values (?, 1, 'tools', 'running', 1, null, ?)`,
      runId,
      opts.deadlineMs,
    );
    sql.exec(
      `insert into step_deadlines (run_id, idx, deadline_ms) values (?, 1, ?)`,
      runId,
      opts.deadlineMs,
    );
  }

  it('re-runs at most ONE step on resume (checkpointed steps are skipped)', async () => {
    const stub = getRunner('resume-one-step');
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedInterruptedRun(state, 'run-resume', {
        deadlineMs: Date.now() + 60_000,
      });
      let step0Calls = 0;
      let step1Calls = 0;
      instance.planProvider = async () => [
        {
          kind: 'llm',
          execute: async () => {
            step0Calls += 1; // must NEVER run — step 0 already checkpointed
            return { checkpoint: { step: 0 } };
          },
        },
        {
          kind: 'tools',
          execute: async () => {
            step1Calls += 1;
            return { checkpoint: { step: 1 } };
          },
        },
      ];
      await instance.resumeRun('run-resume');
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-resume')
        .one() as { status: string };
      const steps = state.storage.sql
        .exec(
          'select status from steps where run_id=? order by idx',
          'run-resume',
        )
        .toArray() as { status: string }[];
      return { step0Calls, step1Calls, run, steps };
    });

    expect(result.step0Calls).toBe(0); // skipped
    expect(result.step1Calls).toBe(1); // re-run exactly once
    expect(result.run.status).toBe('completed');
    expect(result.steps.map((s) => s.status)).toEqual([
      'checkpoint',
      'checkpoint',
    ]);
  });

  it('is idempotent under CONCURRENT resume (two callers → one execution)', async () => {
    const stub = getRunner('resume-concurrent');
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedInterruptedRun(state, 'run-dup', { deadlineMs: Date.now() + 60_000 });
      let step1Calls = 0;
      instance.planProvider = async () => [
        {
          kind: 'llm',
          execute: async () => {
            throw new Error('step 0 must not re-run');
          },
        },
        {
          kind: 'tools',
          execute: async () => {
            step1Calls += 1;
            return { checkpoint: { step: 1 } };
          },
        },
      ];
      // Two resume triggers fire concurrently (startup racing the alarm).
      await Promise.all([
        instance.resumeRun('run-dup'),
        instance.resumeRun('run-dup'),
      ]);
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-dup')
        .one() as { status: string };
      return { step1Calls, run };
    });
    // The interrupted step ran exactly once despite two resume calls.
    expect(result.step1Calls).toBe(1);
    expect(result.run.status).toBe('completed');
  });

  it('is idempotent on a terminal run (resume is a no-op)', async () => {
    const stub = getRunner('resume-terminal');
    const result = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `insert into runs_local (run_id, status, started_at, updated_at) values ('run-done', 'completed', ?, ?)`,
        Date.now(),
        Date.now(),
      );
      let providerCalls = 0;
      instance.planProvider = async () => {
        providerCalls += 1;
        return [{ kind: 'llm', execute: async () => ({ checkpoint: {} }) }];
      };
      await instance.resumeRun('run-done');
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-done')
        .one() as { status: string };
      return { providerCalls, run };
    });
    expect(result.providerCalls).toBe(0); // never even tried to rebuild a plan
    expect(result.run.status).toBe('completed');
  });

  it('fails an EXPIRED pending step and clears its deadline (no re-fire loop)', async () => {
    // A restart can catch a step in 'pending' (between insert and the running
    // update). If it is also past due, the watchdog must fail it and clear the
    // deadline — not leave it armed to re-fire forever with nothing to run.
    const stub = getRunner('resume-pending-expired');
    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `insert into runs_local (run_id, status, started_at, updated_at) values ('run-pend', 'running', ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
         values ('run-pend', 0, 'llm', 'pending', 1, null, ?)`,
        now - 1_000,
      );
      state.storage.sql.exec(
        `insert into step_deadlines (run_id, idx, deadline_ms) values ('run-pend', 0, ?)`,
        now - 1_000,
      );
      // No planProvider set — a resume would be unable to proceed; the watchdog
      // must fail instead of deferring (which would loop).
      await instance.recoverInFlightRuns();
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-pend')
        .one() as { status: string };
      const step = state.storage.sql
        .exec('select status from steps where run_id=? and idx=0', 'run-pend')
        .one() as { status: string };
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines')
        .one().n as number;
      const alarm = await state.storage.getAlarm();
      return { run, step, openDeadlines, alarm };
    });
    expect(result.run.status).toBe('failed');
    expect(result.step.status).toBe('failed');
    expect(result.openDeadlines).toBe(0); // cleared → nothing re-arms
    expect(result.alarm).toBeNull();
  });

  it('reconciles an orphaned failed step (failed step + still-running run) to a failed run', async () => {
    // driveRun (or the watchdog) flips a step to 'failed' but the process dies
    // before markRunTerminal. resumeRun must reconcile the run to failed and
    // clear any lingering deadline — not no-op and strand it 'running'.
    const stub = getRunner('resume-orphan-fail');
    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `insert into runs_local (run_id, status, started_at, updated_at) values ('run-orphan', 'running', ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
         values ('run-orphan', 0, 'llm', 'checkpoint', 1, '{}', ?)`,
        now,
      );
      state.storage.sql.exec(
        `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
         values ('run-orphan', 1, 'tools', 'failed', 1, null, ?)`,
        now,
      );
      // A lingering deadline for the failed step (crash before settleDeadline
      // cleared it) — must not be left to spin the alarm on a dead run.
      state.storage.sql.exec(
        `insert into step_deadlines (run_id, idx, deadline_ms) values ('run-orphan', 1, ?)`,
        now - 1_000,
      );
      let providerCalls = 0;
      instance.planProvider = async () => {
        providerCalls += 1;
        return [{ kind: 'llm', execute: async () => ({ checkpoint: {} }) }];
      };
      await instance.resumeRun('run-orphan');
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-orphan')
        .one() as { status: string };
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines')
        .one().n as number;
      const alarm = await state.storage.getAlarm();
      return { run, openDeadlines, alarm, providerCalls };
    });
    expect(result.run.status).toBe('failed'); // reconciled, not stranded
    expect(result.openDeadlines).toBe(0); // lingering deadline cleared
    expect(result.alarm).toBeNull();
    expect(result.providerCalls).toBe(0); // a failure, never a re-drive
  });

  it('re-drives a run evicted BETWEEN steps (checkpoint done, next step never started) to completion', async () => {
    // step 0 checkpointed; eviction landed before the loop inserted step 1, so
    // there is NO in-flight step — but the run is not done. resumeRun must
    // re-drive via the plan (skip step 0, run the remainder), not strand it.
    const stub = getRunner('resume-between-steps');
    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `insert into runs_local (run_id, status, started_at, updated_at) values ('run-gap', 'running', ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `insert into steps (run_id, idx, kind, status, attempt, checkpoint_json, deadline_ms)
         values ('run-gap', 0, 'llm', 'checkpoint', 1, '{"step":0}', ?)`,
        now,
      );
      // No step 1 row, no deadline — the gap state.
      let step0Calls = 0;
      let step1Calls = 0;
      instance.planProvider = async () => [
        {
          kind: 'llm',
          execute: async () => {
            step0Calls += 1;
            return { checkpoint: { step: 0 } };
          },
        },
        {
          kind: 'tools',
          execute: async () => {
            step1Calls += 1;
            return { checkpoint: { step: 1 } };
          },
        },
      ];
      await instance.resumeRun('run-gap');
      const run = state.storage.sql
        .exec('select status from runs_local where run_id=?', 'run-gap')
        .one() as { status: string };
      const steps = state.storage.sql
        .exec(
          'select idx, status from steps where run_id=? order by idx',
          'run-gap',
        )
        .toArray() as { idx: number; status: string }[];
      return { run, steps, step0Calls, step1Calls };
    });
    expect(result.step0Calls).toBe(0); // already checkpointed → skipped
    expect(result.step1Calls).toBe(1); // the un-run remainder executed
    expect(result.run.status).toBe('completed');
    expect(result.steps).toEqual([
      { idx: 0, status: 'checkpoint' },
      { idx: 1, status: 'checkpoint' },
    ]);
  });

  it('startup-scan resume and alarm-path resume are the SAME function (identical recovery)', async () => {
    // An EXPIRED interrupted run recovered two ways must reach byte-identical
    // durable state, because both triggers funnel through resumeRun.
    function snapshot(state: {
      storage: {
        sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };
      };
    }) {
      const runs = state.storage.sql
        .exec('select run_id, status from runs_local order by run_id')
        .toArray();
      const steps = state.storage.sql
        .exec('select run_id, idx, status from steps order by run_id, idx')
        .toArray();
      const deadlines = state.storage.sql
        .exec('select run_id, idx from step_deadlines order by run_id, idx')
        .toArray();
      return { runs, steps, deadlines };
    }

    const viaStartup = await runInDurableObject(
      getRunner('resume-eq-startup'),
      async (instance, state) => {
        seedInterruptedRun(state, 'run-eq', { deadlineMs: Date.now() - 1_000 });
        await instance.recoverInFlightRuns(); // the startup path
        return snapshot(state);
      },
    );

    const viaAlarm = await runInDurableObject(
      getRunner('resume-eq-alarm'),
      async (instance, state) => {
        seedInterruptedRun(state, 'run-eq', { deadlineMs: Date.now() - 1_000 });
        await instance.alarm(); // the alarm path
        return snapshot(state);
      },
    );

    expect(viaStartup).toEqual(viaAlarm);
    // And the recovery actually happened: the expired step failed the run.
    expect(viaStartup.runs).toEqual([{ run_id: 'run-eq', status: 'failed' }]);
    expect(viaStartup.deadlines).toEqual([]); // deadline cleared
  });
});
