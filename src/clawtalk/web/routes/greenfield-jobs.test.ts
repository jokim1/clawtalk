import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withNotifyQueueScope,
  withRequestScopedDb,
  withUserContext,
} from '../../../db.js';
import { upsertUserGoogleCredential } from '../../db/talk-tools-accessors.js';
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from '../../talks/executor.js';
import { processTalkRunMessage } from '../../talks/queue-consumer.js';
import { claimDueGreenfieldJobRuns } from '../../talks/greenfield-job-accessors.js';
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
const GDRIVE_READ_SCOPE_ALIASES = [
  'drive.readonly',
  'documents',
  'spreadsheets',
];

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

async function authorizeGoogleToolsConnector(
  workspaceId: string,
  userId = USER_ID,
  scopes: string[] = GDRIVE_READ_SCOPE_ALIASES,
): Promise<void> {
  const db = getDbPg();
  await db`
    with secret as (
      insert into public.connector_secrets (workspace_id, ciphertext)
      values (${workspaceId}::uuid, 'greenfield-jobs-google-ciphertext')
      returning id
    )
    insert into public.connectors (
      workspace_id,
      service,
      authorized,
      authorized_at,
      secret_ref,
      config_json
    )
    select
      ${workspaceId}::uuid,
      'gdrive',
      true,
      now(),
      secret.id,
      jsonb_build_object(
        'compatSurface', 'google_tools',
        'authorizedByUserId', ${userId}::text,
        'scopes', ${db.json(scopes as never)}
      )
    from secret
    on conflict (workspace_id, service, (coalesce(config_json->>'authorizedByUserId', '')))
      where config_json->>'compatSurface' = 'google_tools'
    do update set
      authorized = true,
      authorized_at = coalesce(public.connectors.authorized_at, now()),
      secret_ref = excluded.secret_ref,
      config_json = excluded.config_json,
      updated_at = now()
  `;
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

async function createMemberTalkFixture(): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  const me = await getGreenfieldMeRoute({ auth: auth() });
  if (!me.body.ok) throw new Error('Expected session route to succeed');
  const workspaceId = me.body.data.currentWorkspaceId;
  await getDbPg()`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  const agents = await listGreenfieldAgentsRoute({
    auth: auth(OTHER_USER_ID),
    workspaceId,
  });
  if (!agents.body.ok) throw new Error('Expected agents route to succeed');
  const agentIds = agents.body.data.agents.slice(0, 2).map((agent) => agent.id);
  const created = await createGreenfieldTalkRoute({
    auth: auth(OTHER_USER_ID),
    workspaceId,
    body: {
      title: 'Member Jobs Talk',
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

function makeMockEventHub(): {
  env: DbScopeEnvBindings;
  notifiedOwnerIds: string[];
} {
  const notifiedOwnerIds: string[] = [];
  type MockUserEventHubId = { __brand: 'UserEventHubId'; __name: string };
  const namespace = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: (id: MockUserEventHubId) => ({
      fetch: async () => {
        notifiedOwnerIds.push(id.__name);
        return new Response(null, { status: 200 });
      },
    }),
  };
  return {
    env: { USER_EVENT_HUB: namespace as DbScopeEnvBindings['USER_EVENT_HUB'] },
    notifiedOwnerIds,
  };
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

  it('blocks guest talk creators from job mutations', async () => {
    const { workspaceId, talkId, agentIds } = await createMemberTalkFixture();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      title: 'Member job',
      prompt: 'Run safely.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 12 },
      timezone: 'UTC',
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('seed failed');
    const jobId = created.body.data.job.id;

    await getDbPg()`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;

    const deniedCreate = await createGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      title: 'Guest job',
      prompt: 'Should fail.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 12 },
      timezone: 'UTC',
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedPatch = await patchGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId,
      title: 'Guest patched',
    });
    expect(deniedPatch.statusCode).toBe(403);

    const deniedRun = await runGreenfieldTalkJobNowRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId,
    });
    expect(deniedRun.statusCode).toBe(403);

    const deniedDelete = await deleteGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId,
    });
    expect(deniedDelete.statusCode).toBe(403);
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

  it('fans out manual job queue notifications to all workspace members', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Fanout run now job',
      prompt: 'Notify everyone.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }
    const jobId = created.body.data.job.id;

    const { ctx, drain } = makeMockCtx();
    const { env, notifiedOwnerIds } = makeMockEventHub();
    let statusCode = 0;
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      const runNow = await withNotifyQueueScope(env, ctx, () =>
        runGreenfieldTalkJobNowRoute({
          auth: auth(),
          workspaceId,
          talkId,
          jobId,
        }),
      );
      statusCode = runNow.statusCode;
    });
    await drain();

    expect(statusCode).toBe(202);
    expect(new Set(notifiedOwnerIds)).toEqual(
      new Set([USER_ID, OTHER_USER_ID]),
    );
  });

  it('fans out scheduled job queue notifications to all workspace members', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Fanout scheduled job',
      prompt: 'Notify everyone later.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }
    const jobId = created.body.data.job.id;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and id = ${jobId}::uuid
    `;

    const { ctx, drain } = makeMockCtx();
    const { env, notifiedOwnerIds } = makeMockEventHub();
    let enqueuedCount = 0;
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      const result = await withNotifyQueueScope(env, ctx, () =>
        claimDueGreenfieldJobRuns({ limit: 1 }),
      );
      enqueuedCount = result.enqueuedRunIds.length;
    });
    await drain();

    expect(enqueuedCount).toBe(1);
    expect(new Set(notifiedOwnerIds)).toEqual(
      new Set([USER_ID, OTHER_USER_ID]),
    );
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
      message: 'Web search is not enabled for this talk.',
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

  it('requires exact web-search enablement for web-enabled jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;

    const rejected = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Web brief without search',
      prompt: 'Summarize current launch news.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { allowWeb: true, toolIds: [] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.ok ? null : rejected.body.error).toMatchObject({
      code: 'invalid_job',
      message: 'Web search is not enabled for this talk.',
    });

    await db`
      update public.talk_tools
      set enabled = true
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and tool_id = 'web-search'
    `;

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Web brief',
      prompt: 'Summarize current launch news.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { allowWeb: true, toolIds: [] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.ok && created.body.data.job.sourceScope.allowWeb).toBe(
      true,
    );
  });

  it('requires the job creator web_search runtime permission for web jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await db`
      insert into public.user_tool_permissions
        (user_id, tool_id, allowed, requires_approval)
      values (${USER_ID}::uuid, 'web_search', false, false)
      on conflict (user_id, tool_id) do update set
        allowed = excluded.allowed,
        requires_approval = excluded.requires_approval
    `;

    const rejected = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Permission-blocked web brief',
      prompt: 'Summarize current launch news.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { allowWeb: true, toolIds: [] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.ok ? null : rejected.body.error).toMatchObject({
      code: 'invalid_job',
      message:
        "Tool web-search is disabled by the job creator's tool permissions.",
    });

    await db`
      update public.user_tool_permissions
      set allowed = true
      where user_id = ${USER_ID}::uuid
        and tool_id = 'web_search'
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Permission-allowed web brief',
      prompt: 'Summarize current launch news.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { allowWeb: true, toolIds: [] },
    });
    expect(created.statusCode).toBe(201);
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
      insert into public.connectors (
        workspace_id,
        service,
        authorized,
        authorized_at,
        config_json
      )
      values (
        ${workspaceId}::uuid,
        'gdrive',
        true,
        now(),
        jsonb_build_object('compatSurface', 'talk_resource')
      )
    `;
    const wrongSurface = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive job without tool credential',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(wrongSurface.statusCode).toBe(400);
    expect(wrongSurface.body.ok ? null : wrongSurface.body.error).toMatchObject(
      {
        code: 'invalid_job',
        message: 'Connector gdrive is not authorized for this workspace.',
      },
    );

    await authorizeGoogleToolsConnector(workspaceId, OTHER_USER_ID);
    const wrongUser = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive job with another user credential',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(wrongUser.statusCode).toBe(400);
    expect(wrongUser.body.ok ? null : wrongUser.body.error).toMatchObject({
      code: 'invalid_job',
      message: 'Connector gdrive is not authorized for this workspace.',
    });

    await authorizeGoogleToolsConnector(workspaceId, USER_ID, ['documents']);
    const wrongScope = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive job with Docs-only credential',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.body.ok ? null : wrongScope.body.error).toMatchObject({
      code: 'invalid_job',
      message: 'Connector gdrive is not authorized for this workspace.',
    });

    await authorizeGoogleToolsConnector(workspaceId, USER_ID, [
      'drive.readonly',
    ]);
    const driveOnlyScope = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Drive job with Drive-only credential',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(driveOnlyScope.statusCode).toBe(400);
    expect(
      driveOnlyScope.body.ok ? null : driveOnlyScope.body.error,
    ).toMatchObject({
      code: 'invalid_job',
      message: 'Connector gdrive is not authorized for this workspace.',
    });

    await authorizeGoogleToolsConnector(workspaceId);
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

  it('requires the job creator Google runtime permissions for scoped tool jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    await db`
      insert into public.user_tool_permissions
        (user_id, tool_id, allowed, requires_approval)
      values (${USER_ID}::uuid, 'google_drive_search', false, false)
      on conflict (user_id, tool_id) do update set
        allowed = excluded.allowed,
        requires_approval = excluded.requires_approval
    `;

    const rejected = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Permission-blocked Drive brief',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.ok ? null : rejected.body.error).toMatchObject({
      code: 'invalid_job',
      message:
        "Tool gdrive-read is disabled by the job creator's tool permissions.",
    });

    await db`
      update public.user_tool_permissions
      set allowed = true
      where user_id = ${USER_ID}::uuid
        and tool_id = 'google_drive_search'
    `;
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Permission-allowed Drive brief',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    expect(created.statusCode).toBe(201);
  });

  it('preserves existing tool ids when patching only allowWeb source scope', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Patchable scoped job',
      prompt: 'Use Drive, then web.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const patched = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      sourceScope: { allowWeb: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.ok && patched.body.data.job.sourceScope).toMatchObject({
      allowWeb: true,
      toolIds: ['gdrive-read'],
    });
  });

  it('rejects Gmail jobs until the greenfield Gmail runtime exists', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gmail-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;

    await withUserContext(USER_ID, () =>
      upsertUserGoogleCredential({
        workspaceId,
        userId: USER_ID,
        googleSubject: 'gmail-sub',
        email: 'owner@gmail.com',
        displayName: 'Owner Gmail',
        scopes: ['gmail.send'],
        ciphertext: 'gmail-send-only-ciphertext',
      }),
    );
    const rejected = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Gmail brief',
      prompt: 'Summarize recent customer emails.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gmail-read'] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.ok ? null : rejected.body.error).toMatchObject({
      code: 'invalid_job',
      message:
        'Tool gmail-read is not supported by the greenfield jobs runtime yet.',
    });
  });

  it('blocks workspace admins from mutating creator-owned jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'admin')
      on conflict (workspace_id, user_id) do update set
        role = excluded.role
    `;
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId, USER_ID);

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(USER_ID),
      workspaceId,
      talkId,
      title: 'Owner Drive brief',
      prompt: 'Summarize Drive sources.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
      sourceScope: { toolIds: ['gdrive-read'] },
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    const patched = await patchGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      title: 'Admin retitled Drive brief',
    });
    expect(patched.statusCode).toBe(403);
    expect(patched.body.ok ? null : patched.body.error).toMatchObject({
      code: 'forbidden',
      message: 'Only the job creator can modify or run this job.',
    });

    const paused = await pauseGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(paused.statusCode).toBe(403);
    expect(paused.body.ok ? null : paused.body.error).toMatchObject({
      code: 'forbidden',
      message: 'Only the job creator can modify or run this job.',
    });

    const resumed = await resumeGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(resumed.statusCode).toBe(403);
    expect(resumed.body.ok ? null : resumed.body.error).toMatchObject({
      code: 'forbidden',
      message: 'Only the job creator can modify or run this job.',
    });

    const runNow = await runGreenfieldTalkJobNowRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runNow.statusCode).toBe(403);
    expect(runNow.body.ok ? null : runNow.body.error).toMatchObject({
      code: 'forbidden',
      message: 'Only the job creator can modify or run this job.',
    });

    const deleted = await deleteGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(deleted.statusCode).toBe(403);
    expect(deleted.body.ok ? null : deleted.body.error).toMatchObject({
      code: 'forbidden',
      message: 'Only the job creator can modify or run this job.',
    });

    const jobs = await listGreenfieldTalkJobsRoute({
      auth: auth(USER_ID),
      workspaceId,
      talkId,
    });
    expect(jobs.body.ok && jobs.body.data.jobs[0]).toMatchObject({
      id: created.body.data.job.id,
      title: 'Owner Drive brief',
      status: 'active',
    });
  });

  it('lets downgraded job creators run their own job without talk edit access', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'admin')
      on conflict (workspace_id, user_id) do update set
        role = excluded.role
    `;

    const created = await createGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      title: 'Former admin job',
      prompt: 'Run my own job after losing edit access.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 6 },
      timezone: 'UTC',
    });
    if (!created.body.ok) {
      throw new Error(JSON.stringify(created.body.error));
    }

    await db`
      update public.workspace_members
      set role = 'member'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;

    const deniedPatch = await patchGreenfieldTalkJobRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      title: 'Should not retitle without edit access',
    });
    expect(deniedPatch.statusCode).toBe(403);
    expect(deniedPatch.body.ok ? null : deniedPatch.body.error).toMatchObject({
      code: 'forbidden',
      message: 'You do not have permission to edit jobs for this talk.',
    });

    const runNow = await runGreenfieldTalkJobNowRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
    });
    expect(runNow.statusCode).toBe(202);
    expect(runNow.body.ok && runNow.body.data.triggerMessageId).toBeNull();
    expect(runNow.body.ok && runNow.body.data.job.createdBy).toBe(
      OTHER_USER_ID,
    );
  });

  it('clears unsupported connector and channel scoped source ids', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const createdWithLegacyScope = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Connector scope',
      prompt: 'Persist only supported greenfield source scope.',
      targetAgentId: agentIds[0],
      schedule: { kind: 'hourly_interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { connectorIds: ['conn_1'] },
    });
    expect(createdWithLegacyScope.statusCode).toBe(201);
    expect(
      createdWithLegacyScope.body.ok
        ? createdWithLegacyScope.body.data.job.sourceScope
        : null,
    ).toEqual({
      toolIds: [],
      allowWeb: false,
    });
    const db = getDbPg();
    const rawCreatedScope = await db<Array<{ source_scope_json: unknown }>>`
      select source_scope_json
      from public.jobs
      where id = ${createdWithLegacyScope.body.ok ? createdWithLegacyScope.body.data.job.id : ''}::uuid
    `;
    expect(rawCreatedScope[0]?.source_scope_json).toEqual({
      allow_web: false,
      tool_ids: [],
    });

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

    const patchedWithLegacyScope = await patchGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      jobId: created.body.data.job.id,
      sourceScope: { channelBindingIds: ['binding_1'] },
    });
    expect(patchedWithLegacyScope.statusCode).toBe(200);
    expect(
      patchedWithLegacyScope.body.ok
        ? patchedWithLegacyScope.body.data.job.sourceScope
        : null,
    ).toEqual({
      toolIds: [],
      allowWeb: false,
    });
    const rawPatchedScope = await db<Array<{ source_scope_json: unknown }>>`
      select source_scope_json
      from public.jobs
      where id = ${created.body.data.job.id}::uuid
    `;
    expect(rawPatchedScope[0]?.source_scope_json).toEqual({
      allow_web: false,
      tool_ids: [],
    });
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
      message:
        'Tool gmail-send is not supported by the greenfield jobs runtime yet.',
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
    await authorizeGoogleToolsConnector(workspaceId);
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

  it('does not let workspace admins cancel creator-owned job runs through chat cancel', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    const created = await createGreenfieldTalkJobRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Admin cancel controlled job',
      prompt: 'Only the job creator can cancel this run.',
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
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'admin')
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
