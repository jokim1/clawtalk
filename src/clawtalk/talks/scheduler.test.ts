import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  type DbScopeEnvBindings,
  getDbPg,
  initPgDatabase,
  type RequestExecutionContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import { enqueueGreenfieldChatTurn } from './greenfield-chat-accessors.js';
import { runScheduledTick, type ScheduledTickEnv } from './scheduler.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c898989-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface FakeQueue {
  sends: Array<{ runId: string }>;
  send(message: unknown): Promise<void>;
}

interface MockHub {
  env: Pick<DbScopeEnvBindings, 'USER_EVENT_HUB'>;
  fetchCalls: Array<{ ownerId: string; body: string }>;
}

function makeQueue(): FakeQueue {
  return {
    sends: [],
    async send(message) {
      this.sends.push(message as { runId: string });
    },
  };
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

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'scheduler-greenfield@clawtalk.local',
      jsonb_build_object('full_name', 'Scheduler User')
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteUser(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.event_outbox where topic like 'talk:%'`;
  await db`delete from public.workspaces where owner_id = ${USER_ID}::uuid`;
  await db`delete from auth.users where id = ${USER_ID}::uuid`;
}

async function createTalkFixture(options?: {
  agentCount?: number;
  mode?: 'ordered' | 'parallel';
}): Promise<{
  workspaceId: string;
  talkId: string;
  runIds: string[];
  responseGroupId: string;
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
    0,
    options?.agentCount ?? 1,
  );
  const talk = await createGreenfieldTalk({
    workspaceId,
    createdBy: USER_ID,
    title: 'Scheduler Talk',
    mode: options?.mode ?? 'ordered',
    roundsLimit: 3,
    agentIds,
  });
  const enqueued = await enqueueGreenfieldChatTurn({
    workspaceId,
    talkId: talk.id,
    userId: USER_ID,
    content: 'Scheduled maintenance prompt',
    targetAgentIds: agentIds,
  });
  if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);
  return {
    workspaceId,
    talkId: talk.id,
    runIds: enqueued.runs.map((run) => run.id),
    responseGroupId: enqueued.runs[0]!.response_group_id!,
  };
}

async function runTick(
  queue = makeQueue(),
  envPatch: Pick<DbScopeEnvBindings, 'USER_EVENT_HUB'> = {},
): Promise<FakeQueue> {
  const env: ScheduledTickEnv = {
    DB: { connectionString: TEST_DB_URL },
    TALK_RUN_QUEUE: queue,
    ...envPatch,
  };
  const { ctx, drain } = makeMockCtx();
  await runScheduledTick(env, ctx);
  await drain();
  return queue;
}

describe('greenfield scheduled tick safety sweeps', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
  });

  beforeEach(async () => {
    await deleteUser();
    await seedAuthUser();
  });

  afterAll(async () => {
    await deleteUser();
    await closePgDatabase();
  });

  it('fails running runs older than the 1h stuck threshold', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now() - interval '2 hours'
      where id = ${runId}::uuid
    `;

    await runTick();

    const rows = await db<
      Array<{ status: string; error_json: { code?: string } }>
    >`
      select status, error_json
      from public.runs
      where id = ${runId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error_json: { code: 'stuck_running_swept' },
    });
  });

  it('promotes the next ordered sibling after reaping a stuck running step', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now() - interval '2 hours'
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    const rows = await db<Array<{ status: string }>>`
      select status
      from public.runs
      where id = ${firstRunId}::uuid
    `;
    expect(rows[0]?.status).toBe('failed');
    expect(queue.sends).toContainEqual({ runId: secondRunId });
  });

  it('does not promote a parallel sibling after reaping a stuck running step', async () => {
    const { runIds } = await createTalkFixture({
      agentCount: 2,
      mode: 'parallel',
    });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now() - interval '2 hours'
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    const rows = await db<Array<{ status: string }>>`
      select status
      from public.runs
      where id = ${firstRunId}::uuid
    `;
    expect(rows[0]?.status).toBe('failed');
    expect(queue.sends).not.toContainEqual({ runId: secondRunId });
  });

  it('notifies subscribers after reaping a stuck running step', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now() - interval '2 hours'
      where id = ${runId}::uuid
    `;
    const hub = makeMockEventHub();

    await runTick(makeQueue(), hub.env);

    expect(hub.fetchCalls).toHaveLength(1);
    expect(hub.fetchCalls[0]?.ownerId).toBe(USER_ID);
    const payload = JSON.parse(hub.fetchCalls[0]!.body) as {
      entries: Array<{ topic: string; eventId: number }>;
    };
    expect(payload.entries).toHaveLength(1);
  });

  it('leaves fresh running runs alone', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now()
      where id = ${runId}::uuid
    `;

    await runTick();

    const rows = await db<Array<{ status: string }>>`
      select status
      from public.runs
      where id = ${runId}::uuid
    `;
    expect(rows[0]?.status).toBe('running');
  });

  it('redispatches ordered siblings whose lower steps are terminal', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed',
          started_at = now() - interval '10 minutes',
          finished_at = now() - interval '3 minutes'
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toContainEqual({ runId: secondRunId });
    const rows = await db<Array<{ status: string }>>`
      select status
      from public.runs
      where id = ${secondRunId}::uuid
    `;
    expect(rows[0]?.status).toBe('queued');
  });

  it('does not redispatch an ordered sibling inside the grace window', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed',
          started_at = now() - interval '90 seconds',
          finished_at = now() - interval '20 seconds'
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).not.toContainEqual({ runId: secondRunId });
  });

  it('does not redispatch an ordered sibling while a lower step is active', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'running',
          started_at = now()
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).not.toContainEqual({ runId: secondRunId });
  });

  it('fails first queued steps older than the 5m stuck threshold', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${runId}::uuid
    `;

    await runTick();

    const rows = await db<
      Array<{ status: string; error_json: { code?: string } }>
    >`
      select status, error_json
      from public.runs
      where id = ${runId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error_json: { code: 'stuck_queued_swept' },
    });
  });

  it('promotes the next ordered sibling after failing a stale first queued step', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${firstRunId}::uuid
    `;

    const queue = await runTick();

    const rows = await db<Array<{ status: string }>>`
      select status
      from public.runs
      where id = ${firstRunId}::uuid
    `;
    expect(rows[0]?.status).toBe('failed');
    expect(queue.sends).toContainEqual({ runId: secondRunId });
  });

  it('fails any stale queued step in parallel talks', async () => {
    const { runIds } = await createTalkFixture({
      agentCount: 2,
      mode: 'parallel',
    });
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${secondRunId}::uuid
    `;

    await runTick();

    const rows = await db<
      Array<{ status: string; error_json: { code?: string } }>
    >`
      select status, error_json
      from public.runs
      where id = ${secondRunId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error_json: { code: 'stuck_queued_swept' },
    });
  });
});
