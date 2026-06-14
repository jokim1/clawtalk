// TalkRunner write-behind ORCHESTRATION tests — Talk Runtime v2, Wave 2 PR-B.
// Runs in REAL workerd SQLite. The workers pool has NO Postgres binding, so the
// DO's only door to Postgres — the RunStatePersister — is injected as a fake.
// This drives the durability cluster the node pool can't reach with a real DO:
//   • terminal flush AWAITED with bounded retry (Postgres-outage case);
//   • flush reads DO truth (cancel that won the CAS flushes cancelled, never a
//     stale completed);
//   • DO restart during flush re-flushes idempotently (no lost / duplicated);
//   • reconcileRun actions.
// The real-accessor + snapshot half is in talk-runner-write-behind.test.ts (node).
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

import {
  COMPLETED_PAYLOAD_KIND,
  type StepKind,
  type TalkRunnerRunPlan,
} from './talk-runner.js';
import type {
  ClaimRunningResult,
  RunCompletedPayload,
  RunStatePersister,
} from './talk-runner-write-behind.js';

function getRunner(name: string) {
  return env.TALK_RUNNER.get(env.TALK_RUNNER.idFromName(name));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type FakeCall = { method: 'completed' | 'failed' | 'cancelled'; runId: string };

// Models the accessors' idempotent + monotonic Postgres CAS: the first terminal
// for a run applies; any later persist is a no-op (applied:false, no event).
// `failNext` simulates a Postgres outage for the next N persist attempts.
class FakePersister implements RunStatePersister {
  calls: FakeCall[] = [];
  failNext = 0;
  readonly pg = new Map<string, FakeCall['method']>();

  async claimRunning(): Promise<ClaimRunningResult> {
    return { status: 'not_found' }; // runOne is not exercised in these tests
  }
  async persistCompleted(
    payload: RunCompletedPayload,
  ): Promise<{ applied: boolean }> {
    return this.record('completed', payload.runId);
  }
  async persistFailed(input: { runId: string }): Promise<{ applied: boolean }> {
    return this.record('failed', input.runId);
  }
  async persistCancelled(input: {
    runId: string;
  }): Promise<{ applied: boolean }> {
    return this.record('cancelled', input.runId);
  }
  private async record(
    method: FakeCall['method'],
    runId: string,
  ): Promise<{ applied: boolean }> {
    this.calls.push({ method, runId });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated postgres outage');
    }
    if (this.pg.has(runId)) return { applied: false };
    this.pg.set(runId, method);
    return { applied: true };
  }
  countOf(method: FakeCall['method'], runId: string): number {
    return this.calls.filter((c) => c.method === method && c.runId === runId)
      .length;
  }
}

function completedPlan(runId: string): TalkRunnerRunPlan {
  const payload: RunCompletedPayload = {
    runId,
    responseMessageId: '11111111-1111-1111-1111-111111111111',
    responseContent: 'flushed answer',
    responseMetadata: null,
    agentId: null,
    agentNickname: 'Agent',
    providerId: 'p',
    modelId: 'm',
    latencyMs: 5,
    usage: null,
    responseSequenceInRun: 0,
  };
  return [
    {
      kind: 'llm',
      execute: async () => ({
        checkpoint: { kind: COMPLETED_PAYLOAD_KIND, payload },
      }),
    },
  ];
}

function readSynced(
  state: {
    storage: {
      sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };
    };
  },
  runId: string,
): number | undefined {
  return (
    state.storage.sql
      .exec('select synced from run_sync where run_id=?', runId)
      .toArray()[0] as { synced: number } | undefined
  )?.synced;
}

describe('TalkRunner write-behind flush (PR-B, fake persister)', () => {
  it('flushes a completed run to the persister and marks it synced', async () => {
    const fake = new FakePersister();
    const runId = 'wb-completed';
    const synced = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, completedPlan(runId));
        expect(readSynced(state, runId)).toBe(0); // terminal, not yet flushed
        await instance.flushPendingSync();
        return readSynced(state, runId);
      },
    );
    expect(synced).toBe(1);
    expect(fake.countOf('completed', runId)).toBe(1);
    expect(fake.pg.get(runId)).toBe('completed');
  });

  it('retries the terminal persist on a transient outage, then succeeds', async () => {
    const fake = new FakePersister();
    fake.failNext = 1; // first attempt throws, retry succeeds
    const runId = 'wb-retry';
    const synced = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, completedPlan(runId));
        await instance.flushPendingSync();
        return readSynced(state, runId);
      },
    );
    expect(synced).toBe(1);
    expect(fake.countOf('completed', runId)).toBe(2); // 1 failed + 1 succeeded
    expect(fake.pg.get(runId)).toBe('completed');
  });

  it('leaves the run unsynced when the outage outlasts the retry budget (reconciliation backstop)', async () => {
    const fake = new FakePersister();
    fake.failNext = 99; // every attempt fails
    const runId = 'wb-exhausted';
    const synced = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, completedPlan(runId));
        await instance.flushPendingSync();
        return readSynced(state, runId);
      },
    );
    expect(synced).toBe(0); // NOT lost — still pending for the backstop
    expect(fake.pg.has(runId)).toBe(false); // nothing applied
  });

  it('DO restart during flush: a re-flush after the outage clears is idempotent (no lost/duplicated state)', async () => {
    const fake = new FakePersister();
    fake.failNext = 99;
    const runId = 'wb-restart';
    const result = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, completedPlan(runId));
        await instance.flushPendingSync(); // interrupted flush: all attempts fail
        const afterCrash = readSynced(state, runId);
        // "Restart": the outage clears; the next-invocation re-flush succeeds.
        fake.failNext = 0;
        await instance.flushPendingSync();
        const afterRestart = readSynced(state, runId);
        // A third flush has nothing pending → no further persist call.
        await instance.flushPendingSync();
        return { afterCrash, afterRestart };
      },
    );
    expect(result.afterCrash).toBe(0);
    expect(result.afterRestart).toBe(1);
    // Applied EXACTLY once despite many attempts — no duplicate terminal state.
    expect(fake.pg.get(runId)).toBe('completed');
    expect(
      fake.calls.filter((c) => c.runId === runId && c.method === 'completed')
        .length,
    ).toBeGreaterThanOrEqual(2);
    // The map only ever held one terminal for this run (idempotent).
    expect([...fake.pg.values()].filter((v) => v === 'completed')).toHaveLength(
      1,
    );
  });

  it('cancel racing the terminal flush: the flush reads DO truth and persists cancelled, never completed', async () => {
    const fake = new FakePersister();
    const runId = 'wb-cancel-race';
    const gate = deferred();
    let runP!: Promise<unknown>;
    const outcome = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        // Two steps: step 0 checkpoints a COMPLETED payload, step 1 blocks. Cancel
        // arrives during step 1, so even though a completed-payload checkpoint
        // exists, the run is cancelled — the flush must follow the run status.
        const plan: TalkRunnerRunPlan = [
          completedPlan(runId)[0]!,
          {
            kind: 'tools' as StepKind,
            execute: async () => {
              gate.resolve();
              await new Promise((r) => setTimeout(r, 50));
              return { checkpoint: { late: true } };
            },
          },
        ];
        runP = instance.executeRun(runId, plan);
        await gate.promise; // step 1 in-flight
        await instance.cancel(runId);
        const o = await runP;
        await instance.flushPendingSync();
        return { o, synced: readSynced(state, runId) };
      },
    );
    expect((outcome.o as { status: string }).status).toBe('cancelled');
    expect(outcome.synced).toBe(1);
    expect(fake.countOf('cancelled', runId)).toBe(1);
    expect(fake.countOf('completed', runId)).toBe(0); // DO truth wins
    expect(fake.pg.get(runId)).toBe('cancelled');
  });

  it('fails (does not poison-spin) a completed run whose checkpoint carries no payload', async () => {
    // Defensive: a 'completed' DO run whose last checkpoint is not a
    // completed_run_payload_v2 (corruption / unexpected plan shape) → cannot
    // persist as completed. It must be FAILED + synced, never left unsynced to
    // re-flush forever as a reconciliation poison run.
    const fake = new FakePersister();
    const runId = 'wb-no-payload';
    const synced = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, [
          {
            kind: 'llm',
            execute: async () => ({ checkpoint: { kind: 'not_a_payload' } }),
          },
        ]);
        await instance.flushPendingSync();
        return readSynced(state, runId);
      },
    );
    expect(synced).toBe(1); // synced — not left to poison-spin
    expect(fake.countOf('failed', runId)).toBe(1);
    expect(fake.countOf('completed', runId)).toBe(0);
    expect(fake.pg.get(runId)).toBe('failed');
  });

  it('flushes a watchdog-failed run as failed', async () => {
    const fake = new FakePersister();
    const runId = 'wb-failed';
    const synced = await runInDurableObject(
      getRunner(runId),
      async (instance, state) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(runId, [
          {
            kind: 'llm',
            execute: async () => {
              throw new Error('step blew up');
            },
          },
        ]);
        await instance.flushPendingSync();
        return readSynced(state, runId);
      },
    );
    expect(synced).toBe(1);
    expect(fake.countOf('failed', runId)).toBe(1);
    expect(fake.pg.get(runId)).toBe('failed');
  });

  it('reconcileRun: flushes an unsynced terminal, then is a noop, and reports running / no_record', async () => {
    const fake = new FakePersister();
    const done = 'wb-rec-done';
    const running = 'wb-rec-running';
    const gate = deferred();
    let runningP!: Promise<unknown>;
    const result = await runInDurableObject(
      getRunner('wb-rec'),
      async (instance) => {
        instance.persister = fake;
        instance.flushRetryDelayMs = 0;
        await instance.executeRun(done, completedPlan(done));
        const flushed = await instance.reconcileRun(done); // unsynced terminal → flush
        const noop = await instance.reconcileRun(done); // now synced
        // A genuinely in-flight run reconciles to noop_running.
        runningP = instance.executeRun(running, [
          {
            kind: 'llm',
            execute: async () => {
              gate.resolve();
              await new Promise((r) => setTimeout(r, 50));
              return { checkpoint: {} };
            },
          },
        ]);
        await gate.promise;
        const runningAction = await instance.reconcileRun(running);
        const unknown = await instance.reconcileRun('wb-rec-nope');
        await runningP;
        return { flushed, noop, runningAction, unknown };
      },
    );
    expect(result.flushed).toEqual({ action: 'flushed', status: 'completed' });
    expect(result.noop).toEqual({ action: 'noop_synced', status: 'completed' });
    expect(result.runningAction.action).toBe('noop_running');
    expect(result.unknown).toEqual({ action: 'no_record', status: null });
    expect(fake.countOf('completed', done)).toBe(1); // flushed exactly once
  });
});
