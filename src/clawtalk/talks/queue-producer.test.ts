import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withRequestScopedDb,
} from '../../db.js';
import { dispatchRun } from './queue-producer.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

interface FakeQueue {
  sends: Array<{ message: unknown; options?: unknown }>;
  shouldFail: boolean;
  send(message: unknown, options?: unknown): Promise<void>;
}

function makeQueue(): FakeQueue {
  return {
    sends: [],
    shouldFail: false,
    async send(message, options) {
      if (this.shouldFail) {
        throw new Error('queue down');
      }
      this.sends.push({ message, options });
    },
  };
}

function makeCtx(): {
  ctx: RequestExecutionContext;
  drain: () => Promise<void>;
} {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p) => promises.push(p) },
    drain: async () => {
      await Promise.all(promises);
    },
  };
}

function scopeWith(env: DbScopeEnvBindings) {
  return env;
}

describe('dispatchRun', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends { runId } to TALK_RUN_QUEUE with contentType json', async () => {
    const queue = makeQueue();
    const { ctx } = makeCtx();

    await withRequestScopedDb(
      TEST_DB_URL,
      ctx,
      scopeWith({ TALK_RUN_QUEUE: queue }),
      async () => {
        await dispatchRun({ runId: 'run-1' });
      },
    );

    expect(queue.sends).toHaveLength(1);
    expect(queue.sends[0]!.message).toEqual({ runId: 'run-1' });
    expect(queue.sends[0]!.options).toEqual({ contentType: 'json' });
  });

  it('no-ops when called without a TALK_RUN_QUEUE binding', async () => {
    const { ctx } = makeCtx();

    await withRequestScopedDb(TEST_DB_URL, ctx, scopeWith({}), async () => {
      await dispatchRun({ runId: 'run-2' });
    });
    // no throw; nothing to send
  });

  it('swallows queue send errors and does not rethrow', async () => {
    const queue = makeQueue();
    queue.shouldFail = true;
    const { ctx } = makeCtx();

    await withRequestScopedDb(
      TEST_DB_URL,
      ctx,
      scopeWith({ TALK_RUN_QUEUE: queue }),
      async () => {
        await expect(dispatchRun({ runId: 'run-3' })).resolves.toBeUndefined();
      },
    );
  });

  it('no-ops outside any request scope', async () => {
    await expect(dispatchRun({ runId: 'run-4' })).resolves.toBeUndefined();
  });
});
