import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withNotifyQueueScope,
  withRequestScopedDb,
} from '../../../db.js';
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from '../../talks/executor.js';
import { processTalkRunMessage } from '../../talks/queue-consumer.js';
import type { AuthContext } from '../types.js';
import {
  cancelGreenfieldChatRoute,
  enqueueGreenfieldChatRoute,
} from './greenfield-chat.js';
import { cancelGreenfieldTalkRuns } from '../../talks/greenfield-chat-accessors.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  createGreenfieldTalkJobRoute,
  deleteGreenfieldTalkJobRoute,
  getGreenfieldTalkJobRoute,
  listGreenfieldTalkJobRunsRoute,
  listGreenfieldTalkJobsRoute,
  patchGreenfieldTalkJobRoute,
  pauseGreenfieldTalkJobRoute,
  resumeGreenfieldTalkJobRoute,
  runGreenfieldTalkJobNowRoute,
} from './greenfield-jobs.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c949494-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_USER_ID = '0c949494-cccc-cccc-cccc-cccccccccccc';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: `greenfield-jobs-${userId}`,
    userId,
    role: 'owner',
    authType: 'bearer',
  };
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

async function deleteUsers(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.event_outbox where topic like 'talk:%'`;
  await db`delete from public.workspaces where owner_id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)`;
  await db`delete from auth.users where id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)`;
}

async function createTalkFixture(): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  const me = await getGreenfieldMeRoute({ auth: auth() });
  if (!me.body.ok) throw new Error('Expected session route to succeed');
  const workspaceId = me.body.data.currentWorkspaceId;
  const agents = await listGreenfieldAgentsRoute({ auth: auth(), workspaceId });
  if (!agents.body.ok) throw new Error('Expected agents route to succeed');
  const agentIds = agents.body.data.agents.slice(0, 2).map((agent) => agent.id);
  const created = await createGreenfieldTalkRoute({
    auth: auth(),
    workspaceId,
    body: {
      title: 'Jobs Talk',
      team: agentIds,
      rounds: 3,
      mode: 'ordered',
    },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id, agentIds };
}

function makeMockCtx(): {
  ctx: RequestExecutionContext;
  drain: () => Promise<void>;
} {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (promise) => promises.push(promise) },
    drain: async () => {
      await Promise.all(promises);
    },
  };
}

function makeMockEventHub(): { env: DbScopeEnvBindings } {
  const namespace = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: () => ({
      fetch: async () => new Response(null, { status: 200 }),
    }),
  };
  return { env: { USER_EVENT_HUB: namespace } };
}

function makePromptRecordingExecutor(prompts: string[]): TalkExecutor {
  return {
    async execute(input: TalkExecutorInput): Promise<TalkExecutorOutput> {
      prompts.push(input.triggerContent);
      return {
        content: `Job response: ${input.triggerContent}`,
        agentId: input.targetAgentId,
        agentNickname: 'Job Agent',
        responseSequenceInRun: 1,
      };
    },
  };
}

async function setWebTools(input: {
  workspaceId: string;
  talkId: string;
  enabled: boolean;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
    values
      (${input.workspaceId}::uuid, ${input.talkId}::uuid, 'web-search', ${input.enabled}),
      (${input.workspaceId}::uuid, ${input.talkId}::uuid, 'web-fetch', ${input.enabled}),
      (${input.workspaceId}::uuid, ${input.talkId}::uuid, 'news-monitor', ${input.enabled})
    on conflict (talk_id, tool_id) do update set
      enabled = excluded.enabled
  `;
}

describe('greenfield jobs compatibility routes', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
  });

  beforeEach(async () => {
    await deleteUsers();
    await seedAuthUser(USER_ID, 'greenfield-jobs@clawtalk.local');
    await seedAuthUser(OTHER_USER_ID, 'greenfield-jobs-other@clawtalk.local');
  });

  afterAll(async () => {
    await deleteUsers();
    await closePgDatabase();
  });

  it('creates, patches, pauses, resumes, lists, and archives jobs in the final jobs table', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await setWebTools({ workspaceId, talkId, enabled: true });

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Morning brief',
      prompt: 'Summarize the plan.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'America/Los_Angeles',
      sourceScope: { allowWeb: true },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }
    expect(created.body.data.job).toMatchObject({
      title: 'Morning brief',
      prompt: 'Summarize the plan.',
      targetAgentId: agentIds[0],
      status: 'active',
      threadId: talkId,
      sourceScope: { allowWeb: true, toolIds: [] },
    });
    expect(created.body.data.job.nextDueAt).toBeTruthy();
    const jobId = created.body.data.job.id;

    const list = await listGreenfieldTalkJobsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(list.body.ok && list.body.data.jobs.map((job) => job.id)).toEqual([
      jobId,
    ]);

    const patched = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId,
      title: 'Daily brief',
      prompt: 'Write the daily brief.',
      scheduleJson: { kind: 'daily', hour: 9, minute: 30 },
      timezone: 'UTC',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.ok && patched.body.data.job).toMatchObject({
      title: 'Daily brief',
      prompt: 'Write the daily brief.',
      schedule: { kind: 'daily', hour: 9, minute: 30 },
    });

    const paused = await pauseGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId,
    });
    expect(paused.body.ok && paused.body.data.job).toMatchObject({
      status: 'paused',
      nextDueAt: null,
    });

    const resumed = await resumeGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId,
    });
    expect(resumed.body.ok && resumed.body.data.job.status).toBe('active');
    expect(resumed.body.ok && resumed.body.data.job.nextDueAt).toBeTruthy();

    const deleted = await deleteGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId,
    });
    expect(deleted.body).toEqual({
      ok: true,
      data: { deleted: true },
    });
    const afterDelete = await listGreenfieldTalkJobsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(afterDelete.body.ok && afterDelete.body.data.jobs).toEqual([]);

    const db = getDbPg();
    const rows = await db<{ archived_at: string | null }[]>`
      select archived_at
      from public.jobs
      where workspace_id = ${workspaceId}::uuid
        and id = ${jobId}::uuid
    `;
    expect(rows[0]?.archived_at).toBeTruthy();
  });

  it('creates manual run-now jobs with prompt snapshots and executes from the snapshot', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Run now job',
      prompt: 'Use this frozen job prompt.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'weekly', weekdays: ['mon'], hour: 8, minute: 0 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const runNow = await runGreenfieldTalkJobNowRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runNow.statusCode).toBe(202);
    if (!runNow.body.ok) throw new Error('Expected run-now to succeed');
    expect(runNow.body.data.triggerMessageId).toBeNull();

    const runRows = await db<
      Array<{
        requested_by: string;
        trigger: string;
        trigger_message_id: string | null;
        prompt_text_redacted: string | null;
        tool_manifest_json: unknown;
      }>
    >`
      select
        r.requested_by,
        r.trigger,
        r.trigger_message_id,
        rps.prompt_text_redacted,
        rps.tool_manifest_json
      from public.runs r
      join public.run_prompt_snapshots rps
        on rps.workspace_id = r.workspace_id
       and rps.id = r.prompt_snapshot_id
      where r.id = ${runNow.body.data.runId}::uuid
      limit 1
    `;
    expect(runRows[0]).toMatchObject({
      requested_by: USER_ID,
      trigger: 'manual',
      trigger_message_id: null,
      prompt_text_redacted: 'Use this frozen job prompt.',
    });
    const manifest = runRows[0]?.tool_manifest_json as {
      active?: Record<string, boolean>;
      effectiveTools?: Array<{ toolFamily: string; enabled: boolean }>;
      jobSourceScope?: { allow_web?: boolean; tool_ids?: string[] };
    };
    expect(manifest.jobSourceScope).toEqual({
      allow_web: false,
      tool_ids: [],
    });
    expect(manifest.active?.web).toBeUndefined();
    expect(
      manifest.effectiveTools?.find((tool) => tool.toolFamily === 'web')
        ?.enabled,
    ).toBe(false);

    const prompts: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const { env } = makeMockEventHub();
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, () =>
        processTalkRunMessage({
          runId: runNow.body.ok ? runNow.body.data.runId : '',
          executor: makePromptRecordingExecutor(prompts),
          cancelPollIntervalMs: 50_000,
        }),
      );
    });
    await drain();
    expect(prompts).toEqual(['Use this frozen job prompt.']);

    const runs = await listGreenfieldTalkJobRunsRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runs.body.ok && runs.body.data.runs[0]).toMatchObject({
      id: runNow.body.data.runId,
      status: 'completed',
      responseExcerpt: 'Job response: Use this frozen job prompt.',
      triggerMessageId: null,
    });

    const job = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(job.body.ok && job.body.data.job).toMatchObject({
      runCount: 1,
      lastRunStatus: 'completed',
    });
  });

  it('cancelled manual job runs update terminal job bookkeeping', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Cancelable job',
      prompt: 'This queued job will be cancelled.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const runNow = await runGreenfieldTalkJobNowRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runNow.statusCode).toBe(202);

    const cancelled = await cancelGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(cancelled.statusCode).toBe(200);

    const job = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(job.body.ok && job.body.data.job).toMatchObject({
      runCount: 1,
      lastRunStatus: 'cancelled',
    });
    const outbox = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.event_outbox
      where topic = ${`talk:${talkId}`}
        and event_type = 'talk_run_cancelled'
    `;
    expect(outbox[0]?.count).toBe(1);
  });

  it('serializes concurrent run-now requests for the same job', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Concurrent run now job',
      prompt: 'Run at most once.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const [first, second] = await Promise.all([
      runGreenfieldTalkJobNowRoute({
        auth: auth(),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
      runGreenfieldTalkJobNowRoute({
        auth: auth(),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const db = getDbPg();
    const rows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where job_id = ${created.body.data.job.id}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it('rejects run-now while the talk already has an active round', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Blocked by active chat',
      prompt: 'Run after the active round.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const activeRound = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Keep this round active.',
      targetAgentIds: [agentIds[0]!],
    });
    expect(activeRound.statusCode).toBe(202);

    const blocked = await runGreenfieldTalkJobNowRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.ok ? null : blocked.body.error.code).toBe(
      'thread_busy',
    );
    const db = getDbPg();
    const jobRuns = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where job_id = ${created.body.data.job.id}::uuid
    `;
    expect(jobRuns[0]?.count).toBe(0);
  });

  it('serializes concurrent chat enqueue and job run-now on the same talk', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Competes with chat enqueue',
      prompt: 'Run only if the talk is idle.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const [chat, jobRun] = await Promise.all([
      enqueueGreenfieldChatRoute({
        auth: auth(),
        workspaceId,
        talkId,
        content: 'Race this chat turn with run-now.',
        targetAgentIds: [agentIds[0]!],
      }),
      runGreenfieldTalkJobNowRoute({
        auth: auth(),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
    ]);

    expect([chat.statusCode, jobRun.statusCode].sort()).toEqual([202, 409]);
    if (chat.statusCode === 409) {
      expect(chat.body.ok ? null : chat.body.error.code).toBe(
        'talk_round_active',
      );
    }
    if (jobRun.statusCode === 409) {
      expect(jobRun.body.ok ? null : jobRun.body.error.code).toBe(
        'thread_busy',
      );
    }
    const db = getDbPg();
    const activeRuns = await db<
      Array<{ active_count: number; active_rounds: number }>
    >`
      select
        count(*)::int as active_count,
        count(distinct round)::int as active_rounds
      from public.runs
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    expect(activeRuns[0]).toMatchObject({
      active_count: 1,
      active_rounds: 1,
    });
  });

  it('blocks allow-web jobs when the Talk web tools are disabled', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await setWebTools({ workspaceId, talkId, enabled: true });
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Web job',
      prompt: 'Use web if enabled.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { allowWeb: true },
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    await setWebTools({ workspaceId, talkId, enabled: false });
    const blocked = await runGreenfieldTalkJobNowRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.ok ? null : blocked.body.error).toMatchObject({
      code: 'job_blocked',
      message: 'Web tools are not enabled for this talk.',
    });

    const detail = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(detail.body.ok && detail.body.data.job).toMatchObject({
      status: 'blocked',
      blockReason: 'tool_not_enabled',
      nextDueAt: null,
    });
  });

  it('requires authorized connectors for connector-scoped job tools', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;

    const blocked = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive brief',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body.ok ? null : blocked.body.error).toMatchObject({
      code: 'invalid_job',
      message: 'Connector gdrive is not authorized for this workspace.',
    });

    await db`
      insert into public.connectors (workspace_id, service, authorized, authorized_at)
      values (${workspaceId}::uuid, 'gdrive', true, now())
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive brief',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(created.statusCode).toBe(201);
    expect(
      created.body.ok && created.body.data.job.sourceScope.toolIds,
    ).toEqual(['gdrive-read']);
  });

  it('rejects unsupported connector and channel scoped source ids', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const rejectedConnectorScope = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Connector scope',
      prompt: 'Do not silently broaden this source scope.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { connectorIds: ['conn_1'] },
    });
    expect(rejectedConnectorScope.statusCode).toBe(400);
    expect(
      rejectedConnectorScope.body.ok
        ? null
        : rejectedConnectorScope.body.error.message,
    ).toBe(
      'Connector-id scoped job sources are not supported by the greenfield jobs runtime yet.',
    );

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Safe scope',
      prompt: 'Patch should reject channel scope.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const rejectedChannelScope = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      sourceScope: { channelBindingIds: ['binding_1'] },
    });
    expect(rejectedChannelScope.statusCode).toBe(400);
    expect(
      rejectedChannelScope.body.ok
        ? null
        : rejectedChannelScope.body.error.message,
    ).toBe(
      'Channel-binding scoped job sources are not supported by the greenfield jobs runtime yet.',
    );
  });

  it('rejects external mutation tools for read-only jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-write', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'gmail-send', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;

    const rejectedCreate = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Unsafe writer',
      prompt: 'Update the spreadsheet.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-write'] },
    });
    expect(rejectedCreate.statusCode).toBe(400);
    expect(
      rejectedCreate.body.ok ? null : rejectedCreate.body.error,
    ).toMatchObject({
      code: 'invalid_job',
      message: 'Tool gdrive-write is not available for read-only jobs.',
    });

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Safe reader',
      prompt: 'Summarize read-only sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const rejectedPatch = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      sourceScope: { toolIds: ['gmail-send'] },
    });
    expect(rejectedPatch.statusCode).toBe(400);
    expect(
      rejectedPatch.body.ok ? null : rejectedPatch.body.error,
    ).toMatchObject({
      code: 'invalid_job',
      message: 'Tool gmail-send is not available for read-only jobs.',
    });

    const detail = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(detail.body.ok && detail.body.data.job.sourceScope.toolIds).toEqual(
      [],
    );
  });

  it('does not let pause and resume bypass blocked dependencies', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Blocking job',
      prompt: 'Use Drive later.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const blocked = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(blocked.body.ok && blocked.body.data.job).toMatchObject({
      status: 'blocked',
      blockReason: 'connector_not_authorized',
      nextDueAt: null,
    });

    const paused = await pauseGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(paused.body.ok && paused.body.data.job).toMatchObject({
      status: 'blocked',
      blockReason: 'connector_not_authorized',
      nextDueAt: null,
    });

    const resumed = await resumeGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.body.ok ? null : resumed.body.error.code).toBe(
      'job_blocked',
    );
  });

  it('rechecks paused job dependencies before resuming', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await db`
      insert into public.connectors (workspace_id, service, authorized, authorized_at)
      values (${workspaceId}::uuid, 'gdrive', true, now())
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Paused dependency check',
      prompt: 'Use Drive while authorized.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const paused = await pauseGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(paused.body.ok && paused.body.data.job.status).toBe('paused');

    await db`
      update public.connectors
      set authorized = false
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    const resumed = await resumeGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.body.ok ? null : resumed.body.error.code).toBe(
      'job_blocked',
    );

    const detail = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(detail.body.ok && detail.body.data.job).toMatchObject({
      status: 'blocked',
      blockReason: 'connector_not_authorized',
      nextDueAt: null,
    });
  });

  it('lets workspace members read jobs but denies job mutations without edit access', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Owner controlled job',
      prompt: 'Only the owner can mutate this job.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set
        role = excluded.role
    `;

    const readable = await listGreenfieldTalkJobsRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.body.ok && readable.body.data.jobs).toHaveLength(1);

    const mutationResults = await Promise.all([
      createGreenfieldTalkJobRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        title: 'Unauthorized job',
        prompt: 'Should not be created.',
        targetAgentId: agentIds[0],
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
      }),
      patchGreenfieldTalkJobRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
        title: 'Unauthorized patch',
      }),
      pauseGreenfieldTalkJobRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
      resumeGreenfieldTalkJobRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
      runGreenfieldTalkJobNowRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
      deleteGreenfieldTalkJobRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        jobId: created.body.data.job.id,
      }),
    ]);
    for (const result of mutationResults) {
      expect(result.statusCode).toBe(403);
      expect(result.body.ok ? null : result.body.error.code).toBe('forbidden');
    }

    const jobs = await listGreenfieldTalkJobsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(jobs.body.ok && jobs.body.data.jobs).toHaveLength(1);
    expect(jobs.body.ok && jobs.body.data.jobs[0]).toMatchObject({
      id: created.body.data.job.id,
      title: 'Owner controlled job',
      status: 'active',
    });
  });

  it('does not let read-only workspace members cancel owner job runs through chat cancel', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Owner cancel controlled job',
      prompt: 'Only a job editor can cancel this run.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const runNow = await runGreenfieldTalkJobNowRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runNow.statusCode).toBe(202);

    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set
        role = excluded.role
    `;

    const directDeniedCancel = await cancelGreenfieldTalkRuns({
      workspaceId,
      talkId,
      userId: OTHER_USER_ID,
      includeJobRuns: true,
    });
    expect(directDeniedCancel).toEqual({
      cancelledRuns: 0,
      cancelledRunIds: [],
    });

    const deniedCancel = await cancelGreenfieldChatRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(deniedCancel.statusCode).toBe(404);
    expect(deniedCancel.body.ok ? null : deniedCancel.body.error.code).toBe(
      'no_active_run',
    );

    const activeRuns = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where job_id = ${created.body.data.job.id}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    expect(activeRuns[0]?.count).toBe(1);

    const job = await getGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(job.body.ok && job.body.data.job).toMatchObject({
      runCount: 0,
      lastRunStatus: null,
    });
  });

  it('denies job access outside workspace membership', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Private job',
      prompt: 'Private prompt.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const deniedList = await listGreenfieldTalkJobsRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(deniedList.statusCode).toBe(403);

    const deniedRun = await runGreenfieldTalkJobNowRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(deniedRun.statusCode).toBe(403);

    const hiddenWithoutWorkspace = await listGreenfieldTalkJobsRoute({
      auth: auth(OTHER_USER_ID),
      talkId,
    });
    expect(hiddenWithoutWorkspace.statusCode).toBe(404);
    expect(
      hiddenWithoutWorkspace.body.ok
        ? null
        : hiddenWithoutWorkspace.body.error.code,
    ).toBe('not_found');
  });
});
