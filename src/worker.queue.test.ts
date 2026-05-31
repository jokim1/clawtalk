import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./clawtalk/web/worker-app.js', () => ({
  createWorkerApp: vi.fn(() => ({
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
  })),
}));

vi.mock('./db.js', () => ({
  withNotifyQueueScope: vi.fn(
    async (_env: unknown, _ctx: unknown, fn: () => unknown) => fn(),
  ),
  withRequestScopedDb: vi.fn(
    async (_url: unknown, _ctx: unknown, _env: unknown, fn: () => unknown) =>
      fn(),
  ),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./clawtalk/talks/queue-consumer.js', () => {
  class BlockedBySiblingError extends Error {
    readonly runId: string;
    constructor(runId: string) {
      super(`run ${runId} blocked by lower-sequence-index sibling`);
      this.name = 'BlockedBySiblingError';
      this.runId = runId;
    }
  }
  return {
    BlockedBySiblingError,
    processDlqMessage: vi.fn(),
    processTalkRunMessage: vi.fn(),
  };
});

import worker from './worker.js';
import { processDlqMessage } from './clawtalk/talks/queue-consumer.js';

const processDlqMessageMock = vi.mocked(processDlqMessage);

function makeMessage() {
  return {
    id: 'msg-1',
    body: { runId: '11111111-1111-1111-1111-111111111111' },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

const env = {
  DB: { connectionString: 'postgresql://test' },
} as never;

const ctx = {
  waitUntil: vi.fn(),
} as never;

describe('worker queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acks DLQ messages after successful finalization', async () => {
    const message = makeMessage();
    processDlqMessageMock.mockResolvedValueOnce(undefined);

    await worker.queue(
      { queue: 'clawtalk-talk-runs-dlq', messages: [message] } as never,
      env,
      ctx,
    );

    expect(processDlqMessageMock).toHaveBeenCalledWith({
      runId: message.body.runId,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries DLQ messages when finalization throws', async () => {
    const message = makeMessage();
    processDlqMessageMock.mockRejectedValueOnce(new Error('db unavailable'));

    await worker.queue(
      { queue: 'clawtalk-talk-runs-dlq', messages: [message] } as never,
      env,
      ctx,
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});
