import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withNotifyQueueScope,
  withRequestScopedDb,
  withTrustedDbWrites,
  withUserContext,
} from '../../db.js';
import { getOutboxEventsForTopics } from '../db/accessors.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from './greenfield-chat-accessors.js';
import {
  createGreenfieldJob,
  createGreenfieldJobRunNow,
} from './greenfield-job-accessors.js';
import {
  completeGreenfieldRun,
  getGreenfieldQueueRunById,
  markGreenfieldRunRunning,
} from './greenfield-run-accessors.js';
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
  TalkExecutionEvent,
} from './executor.js';
import {
  BlockedBySiblingError,
  processDlqMessage,
  processTalkRunMessage,
} from './queue-consumer.js';
import { MAX_PROVIDER_REPLAY_BYTES } from './provider-replay-budget.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface MockHub {
  env: DbScopeEnvBindings;
  fetchCalls: Array<{ ownerId: string; body: string }>;
}

function makeMockEventHub(): MockHub {
  const fetchCalls: MockHub['fetchCalls'] = [];
  const namespace = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: (id: never) => ({
      fetch: async (input: Request | URL | string) => {
        const body =
          input instanceof Request ? await input.text() : '<no body>';
        fetchCalls.push({
          ownerId: (id as unknown as { __name: string }).__name,
          body,
        });
        return new Response(null, { status: 200 });
      },
    }),
  };
  return { env: { USER_EVENT_HUB: namespace }, fetchCalls };
}

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${email}::text)
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.event_outbox where topic like 'talk:%'`;
  await db`delete from public.workspaces where owner_id = ${OWNER_ID}::uuid`;
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'queue-consumer-test@clawtalk.test');
});

afterAll(async () => {
  await purge();
  await closePgDatabase();
});

beforeEach(async () => {
  await purge();
});

async function setupRun(opts?: {
  agentCount?: number;
  mode?: 'ordered' | 'parallel';
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}): Promise<{
  workspaceId: string;
  talkId: string;
  messageId: string;
  runIds: string[];
  responseGroupId: string;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  return withUserContext(OWNER_ID, async () => {
    const agentIds = (
      await listDefaultTalkAgentIds({
        workspaceId,
      })
    ).slice(0, opts?.agentCount ?? 1);
    const talk = await createGreenfieldTalk({
      workspaceId,
      createdBy: OWNER_ID,
      title: 'Queue Consumer Test Talk',
      agentIds,
      mode: opts?.mode,
    });
    const turn = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId: talk.id,
      userId: OWNER_ID,
      content: 'trigger me',
      targetAgentIds: agentIds,
    });
    if (!turn.ok) {
      throw new Error(`Failed to enqueue greenfield test turn: ${turn.reason}`);
    }
    if (opts?.status && opts.status !== 'queued') {
      const status = opts.status;
      await withTrustedDbWrites(async () => {
        const db = getDbPg();
        await db`
          update public.runs
          set
            status = ${status},
            started_at = case
              when ${status} in ('running', 'completed', 'failed', 'cancelled')
                then coalesce(started_at, now())
              else started_at
            end,
            finished_at = case
              when ${status} in ('completed', 'failed', 'cancelled')
                then coalesce(finished_at, now())
              else finished_at
            end
          where id in ${db(turn.runs.map((run) => run.id))}
        `;
      });
    }
    return {
      workspaceId,
      talkId: talk.id,
      messageId: turn.message.id,
      runIds: turn.runs.map((run) => run.id),
      responseGroupId: turn.runs[0]!.response_group_id!,
    };
  });
}

async function setupJobRun(opts?: { status?: 'queued' | 'running' }): Promise<{
  workspaceId: string;
  talkId: string;
  jobId: string;
  runId: string;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  return withUserContext(OWNER_ID, async () => {
    const agentIds = await listDefaultTalkAgentIds({ workspaceId });
    const talk = await createGreenfieldTalk({
      workspaceId,
      createdBy: OWNER_ID,
      title: 'Queue Consumer Job Test Talk',
      agentIds: [agentIds[0]!],
    });
    const job = await createGreenfieldJob({
      workspaceId,
      talkId: talk.id,
      title: 'DLQ Job',
      prompt: 'DLQ job prompt',
      agentId: agentIds[0]!,
      schedule: { kind: 'interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { allowWeb: false, toolIds: [] },
      createdBy: OWNER_ID,
    });
    const enqueued = await createGreenfieldJobRunNow({
      workspaceId,
      talkId: talk.id,
      jobId: job.id,
      requestedBy: OWNER_ID,
    });
    if (enqueued.status !== 'enqueued') {
      throw new Error(`Failed to enqueue job run: ${enqueued.status}`);
    }
    if (opts?.status === 'running') {
      await withTrustedDbWrites(async () => {
        const db = getDbPg();
        await db`
          update public.runs
          set status = 'running', started_at = now()
          where id = ${enqueued.runId}::uuid
        `;
      });
    }
    return {
      workspaceId,
      talkId: talk.id,
      jobId: job.id,
      runId: enqueued.runId,
    };
  });
}

function makeMockCtx(): {
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

function makeMockExecutor(behavior: {
  output?: Partial<TalkExecutorOutput>;
  throwError?: Error;
  emitEvents?: TalkExecutionEvent[];
  waitFor?: Promise<unknown>;
  onExecuteStart?: () => void;
}): TalkExecutor {
  return {
    async execute(
      _input: TalkExecutorInput,
      signal: AbortSignal,
      emit?: (event: TalkExecutionEvent) => void,
    ): Promise<TalkExecutorOutput> {
      behavior.onExecuteStart?.();
      for (const event of behavior.emitEvents ?? []) {
        emit?.(event);
      }
      if (behavior.waitFor) {
        await Promise.race([
          behavior.waitFor,
          new Promise((_, reject) => {
            const onAbort = () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      }
      if (behavior.throwError) throw behavior.throwError;
      return {
        content: behavior.output?.content ?? 'mock response',
        metadataJson: behavior.output?.metadataJson ?? null,
        agentId: behavior.output?.agentId ?? null,
        agentNickname: behavior.output?.agentNickname ?? null,
        providerId: behavior.output?.providerId ?? null,
        modelId: behavior.output?.modelId ?? null,
        usage: behavior.output?.usage,
        responseSequenceInRun: behavior.output?.responseSequenceInRun ?? null,
      };
    },
  };
}

describe('markGreenfieldRunRunning', () => {
  it('queued to running emits talk_run_started', async () => {
    const { runIds, talkId } = await setupRun();

    const result = await markGreenfieldRunRunning(runIds[0]!);
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.run.status).toBe('running');

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const started = events.find((e) => e.event_type === 'talk_run_started');
    expect(started).toBeTruthy();
    expect(started?.payload).toMatchObject({
      providerId: result.run.provider_id,
      executorModel: result.run.model_id,
    });
  });

  it('returns terminal for completed runs', async () => {
    const { runIds } = await setupRun({ status: 'completed' });
    const result = await markGreenfieldRunRunning(runIds[0]!);
    expect(result.status).toBe('terminal');
  });

  it('returns not_found for missing runs', async () => {
    const result = await markGreenfieldRunRunning(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(result.status).toBe('not_found');
  });

  it('does not re-claim a running row', async () => {
    const { runIds, talkId } = await setupRun();

    const first = await markGreenfieldRunRunning(runIds[0]!);
    expect(first.status).toBe('claimed');
    const baselineCount = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_started').length;

    const second = await markGreenfieldRunRunning(runIds[0]!);
    expect(second.status).toBe('already_running');
    const afterCount = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_started').length;
    expect(afterCount).toBe(baselineCount);
  });

  it('blocks claim when a lower-sequence sibling is still active', async () => {
    const { runIds } = await setupRun({ agentCount: 2 });

    const firstClaim = await markGreenfieldRunRunning(runIds[0]!);
    expect(firstClaim.status).toBe('claimed');

    const secondClaim = await markGreenfieldRunRunning(runIds[1]!);
    expect(secondClaim.status).toBe('blocked_by_sibling');

    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', finished_at = now()
      where id = ${runIds[0]}::uuid
    `;
    const secondClaimAfter = await markGreenfieldRunRunning(runIds[1]!);
    expect(secondClaimAfter.status).toBe('claimed');
  });

  it('does not block sibling claims for parallel talks', async () => {
    const { runIds } = await setupRun({ agentCount: 2, mode: 'parallel' });

    const firstClaim = await markGreenfieldRunRunning(runIds[0]!);
    expect(firstClaim.status).toBe('claimed');

    const secondClaim = await markGreenfieldRunRunning(runIds[1]!);
    expect(secondClaim.status).toBe('claimed');
  });
});

describe('processTalkRunMessage', () => {
  it('emits retry visibility with the run thread id on queue redelivery', async () => {
    const { runIds, talkId } = await setupRun();
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        attempts: 3,
        maxRetries: 5,
        executor: makeMockExecutor({ output: { content: 'retried response' } }),
        cancelPollIntervalMs: 50_000,
      });
    });
    await drain();

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const retrying = events.find((e) => e.event_type === 'talk_run_retrying');
    expect(retrying?.payload).toMatchObject({
      talkId,
      threadId: talkId,
      runId: runIds[0]!,
      retryAttempt: 2,
      maxRetries: 5,
    });
  });

  it('runs the executor to completion and flips status to completed', async () => {
    const { runIds, talkId } = await setupRun();
    const { ctx, drain } = makeMockCtx();
    const { env, fetchCalls } = makeMockEventHub();

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, () =>
        processTalkRunMessage({
          runId: runIds[0]!,
          executor: makeMockExecutor({
            output: {
              content: 'all done',
              metadataJson: JSON.stringify({
                providerId: 'provider.mismatched',
                modelId: 'mismatched-model',
                codexReasoningItems: [{ encrypted_content: 'ciphertext' }],
              }),
              providerId: 'provider.mismatched',
              modelId: 'mismatched-model',
            },
          }),
          cancelPollIntervalMs: 50_000,
        }),
      );
    });
    await drain();

    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('completed');

    const db = getDbPg();
    const messages = await db<
      Array<{
        author_kind: string;
        body: string | null;
        metadata_json: Record<string, unknown>;
        provider_data: Record<string, unknown> | null;
      }>
    >`
      select
        m.author_kind,
        m.body,
        m.metadata_json,
        mpr.provider_data_json as provider_data
      from public.messages m
      left join public.message_provider_replay mpr
        on mpr.workspace_id = m.workspace_id
       and mpr.talk_id = m.talk_id
       and mpr.message_id = m.id
      where m.talk_id = ${talkId}::uuid
      order by m.created_at asc
    `;
    expect(messages).toMatchObject([
      { author_kind: 'user', body: 'trigger me' },
      { author_kind: 'agent', body: 'all done' },
    ]);
    expect(messages[1]?.metadata_json).not.toHaveProperty(
      'codexReasoningItems',
    );
    expect(messages[1]?.metadata_json).toMatchObject({
      providerId: run!.provider_id,
      modelId: run!.model_id,
    });
    expect(messages[1]?.metadata_json).not.toMatchObject({
      providerId: 'provider.mismatched',
      modelId: 'mismatched-model',
    });
    expect(messages[1]?.provider_data).toMatchObject({
      codexReasoningItems: [{ encrypted_content: 'ciphertext' }],
    });

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('talk_run_started');
    expect(types).toContain('message_appended');
    expect(types).toContain('talk_run_completed');
    const appended = events.find(
      (event) =>
        event.event_type === 'message_appended' &&
        event.payload.runId === run!.id,
    );
    const appendedMetadata = appended?.payload.metadata;
    expect(
      Boolean(
        appendedMetadata &&
        typeof appendedMetadata === 'object' &&
        'codexReasoningItems' in appendedMetadata,
      ),
    ).toBe(false);
    expect(appendedMetadata).toMatchObject({
      providerId: run!.provider_id,
      modelId: run!.model_id,
    });
    const started = events.find(
      (event) => event.event_type === 'talk_run_started',
    );
    expect(started?.payload).toMatchObject({
      providerId: run!.provider_id,
      executorModel: run!.model_id,
    });
    const completed = events.find(
      (event) => event.event_type === 'talk_run_completed',
    );
    expect(completed?.payload).toMatchObject({
      providerId: run!.provider_id,
      executorModel: run!.model_id,
    });

    expect(fetchCalls).toHaveLength(2);
    const startEntries = JSON.parse(fetchCalls[0]!.body).entries;
    const completionEntries = JSON.parse(fetchCalls[1]!.body).entries;
    expect(startEntries).toHaveLength(1);
    expect(completionEntries).toHaveLength(2);
  });

  it('drops over-budget provider replay while keeping the completed message client-safe', async () => {
    const { runIds, talkId } = await setupRun();
    const { ctx, drain } = makeMockCtx();
    const { env } = makeMockEventHub();

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, () =>
        processTalkRunMessage({
          runId: runIds[0]!,
          executor: makeMockExecutor({
            output: {
              content: 'large replay response',
              metadataJson: JSON.stringify({
                codexReasoningItems: [
                  { encrypted_content: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES) },
                ],
              }),
            },
          }),
          cancelPollIntervalMs: 50_000,
        }),
      );
    });
    await drain();

    const db = getDbPg();
    const messages = await db<
      Array<{
        body: string | null;
        metadata_json: Record<string, unknown>;
        provider_data: Record<string, unknown> | null;
      }>
    >`
      select
        m.body,
        m.metadata_json,
        mpr.provider_data_json as provider_data
      from public.messages m
      left join public.message_provider_replay mpr
        on mpr.workspace_id = m.workspace_id
       and mpr.talk_id = m.talk_id
       and mpr.message_id = m.id
      where m.talk_id = ${talkId}::uuid
        and m.author_kind = 'agent'
      order by m.created_at asc
    `;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      body: 'large replay response',
      provider_data: null,
    });
    expect(messages[0]?.metadata_json).not.toHaveProperty(
      'codexReasoningItems',
    );
  });

  it('flushes talk_run_started before executor completion', async () => {
    const { runIds, talkId } = await setupRun();
    const { ctx, drain } = makeMockCtx();
    const { env, fetchCalls } = makeMockEventHub();
    let releaseExecutor: () => void = () => {};
    let markExecutorStarted: () => void = () => {};
    const executorBlock = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const executorStarted = new Promise<void>((resolve) => {
      markExecutorStarted = resolve;
    });

    const runPromise = withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, () =>
        processTalkRunMessage({
          runId: runIds[0]!,
          executor: makeMockExecutor({
            waitFor: executorBlock,
            onExecuteStart: () => {
              markExecutorStarted();
              expect(fetchCalls).toHaveLength(1);
            },
          }),
          cancelPollIntervalMs: 50_000,
        }),
      );
    });

    await executorStarted;

    expect(fetchCalls).toHaveLength(1);
    const earlyEntries = JSON.parse(fetchCalls[0]!.body).entries as Array<{
      eventId: number;
    }>;
    expect(earlyEntries).toHaveLength(1);
    const earlyEvents = await getOutboxEventsForTopics(
      [`talk:${talkId}`],
      earlyEntries[0]!.eventId - 1,
    );
    expect(earlyEvents[0]?.event_type).toBe('talk_run_started');

    releaseExecutor();
    await runPromise;
    await drain();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('rolls back completion when assistant message persistence fails', async () => {
    const { runIds, messageId, talkId } = await setupRun();

    const claim = await markGreenfieldRunRunning(runIds[0]!);
    expect(claim.status).toBe('claimed');

    // completeGreenfieldRun uses responseMessageId as the inserted assistant
    // message primary key, so reusing the user-turn message id forces a
    // duplicate-key error after the run update inside the same transaction.
    await expect(
      completeGreenfieldRun({
        runId: runIds[0]!,
        responseMessageId: messageId,
        responseContent: 'duplicate message id should abort completion',
      }),
    ).rejects.toBeTruthy();

    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('running');

    const db = getDbPg();
    const agentMessages = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.messages
      where talk_id = ${talkId}::uuid
        and author_kind = 'agent'
    `;
    expect(agentMessages[0]?.count).toBe(0);
  });

  it('throws BlockedBySiblingError when a sibling is still active', async () => {
    const { runIds } = await setupRun({ agentCount: 2 });

    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    let thrown: unknown;
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      try {
        await processTalkRunMessage({
          runId: runIds[1]!,
          executor: makeMockExecutor({ output: { content: 'should not run' } }),
        });
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(BlockedBySiblingError);
  });

  it('processes a parallel sibling while a lower-sequence sibling is running', async () => {
    const { runIds } = await setupRun({ agentCount: 2, mode: 'parallel' });
    const firstClaim = await markGreenfieldRunRunning(runIds[0]!);
    expect(firstClaim.status).toBe('claimed');

    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, () =>
        processTalkRunMessage({
          runId: runIds[1]!,
          executor: makeMockExecutor({ output: { content: 'parallel done' } }),
          cancelPollIntervalMs: 50_000,
        }),
      );
    });
    await drain();

    expect(
      await getGreenfieldQueueRunById(runIds[0]!).then((r) => r?.status),
    ).toBe('running');
    expect(
      await getGreenfieldQueueRunById(runIds[1]!).then((r) => r?.status),
    ).toBe('completed');
  });

  it('returns without error when the run is already terminal', async () => {
    const { runIds } = await setupRun({ status: 'completed' });
    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        executor: makeMockExecutor({
          throwError: new Error('should not be called'),
        }),
      });
    });
  });

  it('acks without executing when the run is already running', async () => {
    const { runIds } = await setupRun({ status: 'running' });
    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        executor: makeMockExecutor({
          throwError: new Error('duplicate delivery must not execute'),
        }),
      });
    });
    expect(
      await getGreenfieldQueueRunById(runIds[0]!).then((r) => r?.status),
    ).toBe('running');
  });

  it('aborts execution and ack-returns when status flips to cancelled mid-run', async () => {
    const { runIds } = await setupRun();
    const { ctx, drain } = makeMockCtx();

    let releaseExecutor: () => void = () => {};
    const executorBlock = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });

    const env: DbScopeEnvBindings = {};
    const runPromise = withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        executor: makeMockExecutor({ waitFor: executorBlock }),
        cancelPollIntervalMs: 50,
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'cancelled', finished_at = now()
      where id = ${runIds[0]}::uuid
    `;
    releaseExecutor();

    await expect(runPromise).resolves.toBeUndefined();
    await drain();

    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('cancelled');
  });

  it('promotes the next ordered sibling after a run completes', async () => {
    const { runIds } = await setupRun({ agentCount: 2 });
    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        executor: makeMockExecutor({ output: { content: 'step 0 done' } }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    expect(
      await getGreenfieldQueueRunById(runIds[0]!).then((r) => r?.status),
    ).toBe('completed');
    expect(dispatched).toEqual([runIds[1]]);
  });

  it('promotes the next ordered sibling even when the run fails', async () => {
    const { runIds } = await setupRun({ agentCount: 2 });
    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[0]!,
        executor: makeMockExecutor({
          throwError: new Error('provider upstream timed out'),
        }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    expect(
      await getGreenfieldQueueRunById(runIds[0]!).then((r) => r?.status),
    ).toBe('failed');
    expect(dispatched).toEqual([runIds[1]]);
  });

  it('does not promote when the finished run is the last ordered step', async () => {
    const { runIds } = await setupRun({ agentCount: 2 });
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed', started_at = now(), finished_at = now()
      where id = ${runIds[0]}::uuid
    `;

    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: runIds[1]!,
        executor: makeMockExecutor({ output: { content: 'final step' } }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    expect(dispatched).toEqual([]);
  });
});

describe('processDlqMessage', () => {
  it('flips a queued run to failed with dlq_exhausted and emits talk_run_failed', async () => {
    const { runIds, talkId } = await setupRun({ status: 'queued' });

    await processDlqMessage({ runId: runIds[0]! });

    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('failed');
    expect(run?.error_json).toMatchObject({ code: 'dlq_exhausted' });

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const failed = events.find((e) => e.event_type === 'talk_run_failed');
    expect(failed).toBeTruthy();
    expect((failed?.payload as { errorCode?: string }).errorCode).toBe(
      'dlq_exhausted',
    );
    expect(failed?.payload).toMatchObject({
      providerId: run!.provider_id,
      executorModel: run!.model_id,
    });
  });

  it('throws and preserves the run when DLQ outbox finalization fails', async () => {
    const { runIds, talkId } = await setupRun({ status: 'queued' });
    const db = getDbPg();
    const topic = `talk:${talkId}`;

    await db`
      create table if not exists public.queue_consumer_test_outbox_fail_topics (
        topic text primary key
      )
    `;
    await db`
      create or replace function public.queue_consumer_test_fail_marked_outbox()
      returns trigger
      language plpgsql
      as $$
      begin
        if exists (
          select 1
          from public.queue_consumer_test_outbox_fail_topics
          where topic = new.topic
        ) then
          raise exception 'forced event_outbox failure for test topic %', new.topic;
        end if;
        return new;
      end;
      $$
    `;
    await db`
      drop trigger if exists queue_consumer_test_fail_marked_outbox
      on public.event_outbox
    `;
    await db`
      create trigger queue_consumer_test_fail_marked_outbox
      before insert on public.event_outbox
      for each row
      execute function public.queue_consumer_test_fail_marked_outbox()
    `;
    await db`
      insert into public.queue_consumer_test_outbox_fail_topics (topic)
      values (${topic})
      on conflict (topic) do nothing
    `;

    try {
      await expect(processDlqMessage({ runId: runIds[0]! })).rejects.toThrow(
        /forced event_outbox failure/,
      );

      const run = await getGreenfieldQueueRunById(runIds[0]!);
      expect(run?.status).toBe('queued');

      const events = await getOutboxEventsForTopics([topic], 0);
      expect(events.some((e) => e.event_type === 'talk_run_failed')).toBe(
        false,
      );
    } finally {
      await db`
        delete from public.queue_consumer_test_outbox_fail_topics
        where topic = ${topic}
      `;
      await db`
        drop trigger if exists queue_consumer_test_fail_marked_outbox
        on public.event_outbox
      `;
      await db`
        drop function if exists public.queue_consumer_test_fail_marked_outbox()
      `;
      await db`drop table if exists public.queue_consumer_test_outbox_fail_topics`;
    }
  });

  it('flips a running run to failed', async () => {
    const { runIds } = await setupRun({ status: 'running' });
    await processDlqMessage({ runId: runIds[0]! });
    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('failed');
  });

  it('updates the parent job summary when a job run exhausts DLQ retries', async () => {
    const { jobId, runId } = await setupJobRun();

    await processDlqMessage({ runId });

    const db = getDbPg();
    const rows = await db<
      Array<{
        run_count: number;
        last_run_status: string | null;
        last_run_at: string | null;
      }>
    >`
      select run_count, last_run_status, last_run_at
      from public.jobs
      where id = ${jobId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      run_count: 1,
      last_run_status: 'failed',
    });
    expect(rows[0]?.last_run_at).not.toBeNull();
  });

  it('is a no-op on an already-terminal run', async () => {
    const { runIds } = await setupRun({ status: 'completed' });
    await processDlqMessage({ runId: runIds[0]! });
    const run = await getGreenfieldQueueRunById(runIds[0]!);
    expect(run?.status).toBe('completed');
  });

  it('is a no-op for a missing runId', async () => {
    await expect(
      processDlqMessage({ runId: '11111111-1111-1111-1111-111111111111' }),
    ).resolves.toBeUndefined();
  });
});
