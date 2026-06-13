// TalkRunner smoke test — Talk Runtime v2, Wave 2 PR-A1.
//
// HONESTY (see the PR description): this proves the DO-LOCAL HAPPY PATH of the
// step state machine in REAL workerd SQLite via an injected stub plan. It does
// NOT exercise the production path — durability/write-behind, hub streaming,
// the min-deadline alarm/watchdog, startup resume, cancel, and stale-attempt
// fencing arrive in A2/A3/PR-B and get their own tests there. The real
// GreenfieldTalkExecutor (DB + provider) is driven only by the manual dev
// route, never here.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

import type { TalkRunnerRunPlan } from './talk-runner.js';

function getRunner(name: string) {
  return env.TALK_RUNNER.get(env.TALK_RUNNER.idFromName(name));
}

describe('TalkRunner DO-local happy path (PR-A1)', () => {
  it('drives a multi-step run through PENDING→RUNNING→CHECKPOINT to a terminal completed run', async () => {
    const stub = getRunner('talk-completed');
    const runId = 'run-completed-1';

    const result = await runInDurableObject(stub, async (instance, state) => {
      const plan: TalkRunnerRunPlan = [
        { kind: 'llm', execute: async () => ({ checkpoint: { step: 0 } }) },
        { kind: 'tools', execute: async () => ({ checkpoint: { step: 1 } }) },
        { kind: 'llm', execute: async () => ({ checkpoint: { step: 2 } }) },
      ];
      const outcome = await instance.executeRun(runId, plan);
      const runStatus = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one().status;
      const steps = state.storage.sql
        .exec(
          'select idx, kind, status, checkpoint_json from steps where run_id=? order by idx',
          runId,
        )
        .toArray();
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines where run_id=?', runId)
        .one().n;
      return { outcome, runStatus, steps, openDeadlines };
    });

    expect(result.outcome).toEqual({ status: 'completed', steps: 3 });
    expect(result.runStatus).toBe('completed');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => s.status)).toEqual([
      'checkpoint',
      'checkpoint',
      'checkpoint',
    ]);
    expect(result.steps.map((s) => s.kind)).toEqual(['llm', 'tools', 'llm']);
    // Each step's reference-based checkpoint was persisted.
    expect(result.steps.map((s) => s.checkpoint_json)).toEqual([
      '{"step":0}',
      '{"step":1}',
      '{"step":2}',
    ]);
    // 1A: the deadline row is cleared as each step settles — none left open.
    expect(result.openDeadlines).toBe(0);
  });

  it('fails the run at the throwing step and skips the rest', async () => {
    const stub = getRunner('talk-step-failure');
    const runId = 'run-failed-1';

    const result = await runInDurableObject(stub, async (instance, state) => {
      const plan: TalkRunnerRunPlan = [
        { kind: 'llm', execute: async () => ({ checkpoint: { ok: true } }) },
        {
          kind: 'tools',
          execute: async () => {
            throw new Error('tool batch blew up');
          },
        },
        // Must never run — the run is terminal after step 1 fails.
        { kind: 'llm', execute: async () => ({ checkpoint: { ok: true } }) },
      ];
      const outcome = await instance.executeRun(runId, plan);
      const runStatus = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one().status;
      const steps = state.storage.sql
        .exec(
          'select idx, status from steps where run_id=? order by idx',
          runId,
        )
        .toArray();
      const openDeadlines = state.storage.sql
        .exec('select count(*) as n from step_deadlines where run_id=?', runId)
        .one().n;
      return { outcome, runStatus, steps, openDeadlines };
    });

    expect(result.outcome).toEqual({ status: 'failed', failedStepIdx: 1 });
    expect(result.runStatus).toBe('failed');
    // Step 0 checkpointed, step 1 failed, step 2 was never created.
    expect(result.steps).toEqual([
      { idx: 0, status: 'checkpoint' },
      { idx: 1, status: 'failed' },
    ]);
    // The failed step's deadline is cleared too.
    expect(result.openDeadlines).toBe(0);
  });

  it('fails a step whose checkpoint exceeds the 1MB cap (8A assert)', async () => {
    const stub = getRunner('talk-oversized-checkpoint');
    const runId = 'run-oversized-1';

    const result = await runInDurableObject(stub, async (instance, state) => {
      const plan: TalkRunnerRunPlan = [
        {
          kind: 'llm',
          // ~1.1MB serialized — over the 1MB guard. Must surface as a failed
          // step, never a silent truncation.
          execute: async () => ({
            checkpoint: { blob: 'x'.repeat(1_100_000) },
          }),
        },
      ];
      const outcome = await instance.executeRun(runId, plan);
      const step = state.storage.sql
        .exec(
          'select status, checkpoint_json from steps where run_id=? and idx=0',
          runId,
        )
        .one();
      return { outcome, step };
    });

    expect(result.outcome).toEqual({ status: 'failed', failedStepIdx: 0 });
    expect(result.step.status).toBe('failed');
    // Nothing oversized was written.
    expect(result.step.checkpoint_json).toBeNull();
  });

  it('is idempotent on re-entry: a terminal run is not re-executed', async () => {
    const stub = getRunner('talk-reentry');
    const runId = 'run-reentry-1';

    const result = await runInDurableObject(stub, async (instance, state) => {
      let calls = 0;
      const firstPlan: TalkRunnerRunPlan = [
        {
          kind: 'llm',
          execute: async () => {
            calls += 1;
            return { checkpoint: { c: calls } };
          },
        },
        {
          kind: 'tools',
          execute: async () => {
            calls += 1;
            return { checkpoint: { c: calls } };
          },
        },
      ];
      const first = await instance.executeRun(runId, firstPlan);
      const callsAfterFirst = calls;
      // Re-enter with closures that THROW if invoked — they must be skipped
      // because the run is already terminal.
      const second = await instance.executeRun(runId, [
        {
          kind: 'llm',
          execute: async () => {
            throw new Error('step 0 must not re-run');
          },
        },
        {
          kind: 'tools',
          execute: async () => {
            throw new Error('step 1 must not re-run');
          },
        },
      ]);
      const runStatus = state.storage.sql
        .exec('select status from runs_local where run_id=?', runId)
        .one().status;
      const steps = state.storage.sql
        .exec('select status from steps where run_id=? order by idx', runId)
        .toArray();
      return { first, second, callsAfterFirst, calls, runStatus, steps };
    });

    expect(result.first).toEqual({ status: 'completed', steps: 2 });
    expect(result.callsAfterFirst).toBe(2);
    // Re-entry returns the same outcome and invoked ZERO step closures.
    expect(result.second).toEqual({ status: 'completed', steps: 2 });
    expect(result.calls).toBe(2);
    expect(result.runStatus).toBe('completed');
    expect(result.steps.map((s) => s.status)).toEqual([
      'checkpoint',
      'checkpoint',
    ]);
  });

  it('exposes live state via the /debug/state route', async () => {
    const stub = getRunner('talk-debug-state');
    const runId = 'run-debug-1';

    await runInDurableObject(stub, async (instance) => {
      const plan: TalkRunnerRunPlan = [
        { kind: 'llm', execute: async () => ({ checkpoint: { step: 0 } }) },
      ];
      await instance.executeRun(runId, plan);
    });

    const res = await stub.fetch(
      `https://talk-runner.internal/debug/state?runId=${runId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { run: { status: string } | null; steps: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.run?.status).toBe('completed');
    expect(body.data.steps).toHaveLength(1);
  });
});
