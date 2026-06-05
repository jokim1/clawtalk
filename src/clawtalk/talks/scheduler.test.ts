import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  type DbScopeEnvBindings,
  getDbPg,
  initPgDatabase,
  type RequestExecutionContext,
  withUserContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  createGreenfieldTalk,
  listDefaultTalkAgentIds,
} from './greenfield-accessors.js';
import {
  cancelGreenfieldTalkRuns,
  enqueueGreenfieldChatTurn,
} from './greenfield-chat-accessors.js';
import {
  claimDueGreenfieldJobRuns,
  createGreenfieldJob,
  createGreenfieldJobRunNow,
  googleToolCredentialHasRequiredScopes,
  patchGreenfieldJob,
} from './greenfield-job-accessors.js';
import {
  completeGreenfieldRun,
  failGreenfieldRun,
} from './greenfield-run-accessors.js';
import { runScheduledTick, type ScheduledTickEnv } from './scheduler.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c898989-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c898989-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GDRIVE_READ_SCOPE_ALIASES = [
  'drive.readonly',
  'documents',
  'spreadsheets',
];

interface FakeQueue {
  attempts: number;
  sends: Array<{ runId: string; observedCommittedRun?: boolean }>;
  send(
    message: unknown,
    options?: { contentType?: string; delaySeconds?: number },
  ): Promise<void>;
}

interface MockHub {
  env: Pick<DbScopeEnvBindings, 'USER_EVENT_HUB'>;
  fetchCalls: Array<{ ownerId: string; body: string }>;
}

function makeQueue(options?: {
  requireCommittedRun?: boolean;
  failSend?: boolean;
}): FakeQueue {
  const sends: FakeQueue['sends'] = [];
  return {
    attempts: 0,
    sends,
    async send(message) {
      this.attempts += 1;
      if (options?.failSend) {
        throw new Error('queue down');
      }
      const payload = message as { runId: string };
      if (options?.requireCommittedRun) {
        const db = getDbPg();
        const rows = await db<Array<{ run_id: string; snapshot_id: string }>>`
          select r.id as run_id, rps.id as snapshot_id
          from public.runs r
          join public.run_prompt_snapshots rps
            on rps.workspace_id = r.workspace_id
           and rps.run_id = r.id
          where r.id = ${payload.runId}::uuid
            and r.status = 'queued'
        `;
        if (rows.length !== 1) {
          throw new Error(
            'Run and prompt snapshot must commit before dispatch',
          );
        }
        sends.push({ ...payload, observedCommittedRun: true });
        return;
      }
      sends.push(payload);
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

async function authorizeGoogleToolsConnector(
  workspaceId: string,
  userId = USER_ID,
  scopes: string[] = GDRIVE_READ_SCOPE_ALIASES,
): Promise<void> {
  const db = getDbPg();
  await db`
    with secret as (
      insert into public.connector_secrets (workspace_id, ciphertext)
      values (${workspaceId}::uuid, 'scheduler-test-google-ciphertext')
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
  `;
}

async function seedWorkspaceProviderSecret(
  workspaceId: string,
  credentialKind: 'api_key' | 'subscription' = 'api_key',
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.workspace_provider_secrets (
      workspace_id, provider_id, credential_kind, ciphertext, updated_by
    )
    values (
      ${workspaceId}::uuid, 'provider.anthropic', ${credentialKind},
      'scheduler-test-provider-secret', ${USER_ID}::uuid
    )
    on conflict (workspace_id, provider_id, credential_kind) do update set
      ciphertext = excluded.ciphertext,
      updated_by = excluded.updated_by,
      updated_at = now()
  `;
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
  await db`
    delete from public.workspaces
    where owner_id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)
  `;
}

async function createTalkFixture(options?: {
  agentCount?: number;
  mode?: 'ordered' | 'parallel';
}): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
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
    agentIds,
    runIds: enqueued.runs.map((run) => run.id),
    responseGroupId: enqueued.runs[0]!.response_group_id!,
  };
}

async function createIdleTalkFixture(options?: {
  agentCount?: number;
  mode?: 'ordered' | 'parallel';
}): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  const agentIds = (await listDefaultTalkAgentIds({ workspaceId })).slice(
    0,
    options?.agentCount ?? 1,
  );
  const talk = await createGreenfieldTalk({
    workspaceId,
    createdBy: USER_ID,
    title: 'Scheduler Job Talk',
    mode: options?.mode ?? 'ordered',
    roundsLimit: 3,
    agentIds,
  });
  return { workspaceId, talkId: talk.id, agentIds };
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

async function createQueuedJobRunFixture(): Promise<{
  workspaceId: string;
  talkId: string;
  jobId: string;
  runId: string;
}> {
  const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
  const job = await withUserContext(USER_ID, () =>
    createGreenfieldJob({
      workspaceId,
      talkId,
      title: 'Terminal Bookkeeping Job',
      prompt: 'Verify terminal bookkeeping.',
      agentId: agentIds[0]!,
      schedule: { kind: 'interval', everyHours: 1 },
      timezone: 'UTC',
      sourceScope: { allowWeb: false, toolIds: [] },
      createdBy: USER_ID,
    }),
  );
  const enqueued = await withUserContext(USER_ID, () =>
    createGreenfieldJobRunNow({
      workspaceId,
      talkId,
      jobId: job.id,
      requestedBy: USER_ID,
    }),
  );
  if (enqueued.status !== 'enqueued') {
    throw new Error(`Expected job run to enqueue, got ${enqueued.status}`);
  }
  return { workspaceId, talkId, jobId: job.id, runId: enqueued.runId };
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

  it('fires due jobs into scheduled runs and dispatches after commit', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'news-monitor', false),
        (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true),
        (${workspaceId}::uuid, ${talkId}::uuid, 'github-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Daily Summary',
        prompt: 'Summarize the account activity.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { allowWeb: true, toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick(makeQueue({ requireCommittedRun: true }));

    expect(queue.sends).toHaveLength(1);
    expect(queue.sends[0]?.observedCommittedRun).toBe(true);
    const runId = queue.sends[0]!.runId;
    const runRows = await db<
      Array<{
        trigger: string;
        scheduled_for: string | null;
        trigger_message_id: string | null;
        requested_by: string | null;
        job_id: string | null;
        status: string;
        prompt_text_redacted: string;
        tool_manifest_json: {
          active?: Record<string, boolean>;
          effectiveTools?: Array<{
            toolFamily: string;
            runtimeTools: string[];
            enabled: boolean;
            requiresApproval: boolean;
          }>;
          jobSourceScope?: { allow_web: boolean; tool_ids: string[] };
        } | null;
      }>
    >`
      select
        r.trigger,
        r.scheduled_for,
        r.trigger_message_id,
        r.requested_by,
        r.job_id,
        r.status,
        rps.prompt_text_redacted,
        rps.tool_manifest_json
      from public.runs r
      join public.run_prompt_snapshots rps
        on rps.workspace_id = r.workspace_id
       and rps.run_id = r.id
      where r.id = ${runId}::uuid
    `;
    expect(runRows[0]).toMatchObject({
      trigger: 'scheduler',
      trigger_message_id: null,
      requested_by: USER_ID,
      job_id: job.id,
      status: 'queued',
      prompt_text_redacted: 'Summarize the account activity.',
    });
    expect(runRows[0]?.scheduled_for).not.toBeNull();
    expect(runRows[0]?.tool_manifest_json?.jobSourceScope).toEqual({
      allow_web: true,
      tool_ids: ['gdrive-read'],
    });
    expect(runRows[0]?.tool_manifest_json?.active).toEqual({
      web: true,
      google_read: true,
    });
    expect(runRows[0]?.tool_manifest_json?.effectiveTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolFamily: 'web',
          runtimeTools: ['web_search'],
          enabled: true,
        }),
        expect.objectContaining({
          toolFamily: 'google_read',
          enabled: true,
        }),
        expect.objectContaining({
          toolFamily: 'connectors',
          enabled: false,
        }),
      ]),
    );

    const jobRows = await db<
      Array<{ next_due_is_future: boolean; claimed_at: string | null }>
    >`
      select next_due_at > now() as next_due_is_future, claimed_at
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(jobRows[0]).toMatchObject({
      next_due_is_future: true,
      claimed_at: null,
    });
  });

  it('freezes the resolved workspace credential kind for scheduled job runs', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await seedWorkspaceProviderSecret(workspaceId, 'api_key');
    await db`
      update public.agents
      set credential_mode = null
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Scheduled Credential Snapshot',
        prompt: 'Use the workspace credential path.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { allowWeb: false, toolIds: [] },
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({ limit: 1 });

    expect(claim.enqueuedRunIds).toHaveLength(1);
    const runId = claim.enqueuedRunIds[0]!;
    await db`
      update public.agents
      set credential_mode = 'subscription'
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
    `;
    const snapshots = await db<Array<{ agent_credential_mode: string | null }>>`
      select rps.tool_manifest_json->>'agentCredentialMode' as agent_credential_mode
      from public.run_prompt_snapshots rps
      where rps.workspace_id = ${workspaceId}::uuid
        and rps.run_id = ${runId}::uuid
    `;
    expect(snapshots[0]?.agent_credential_mode).toBe('api_key');
  });

  it('leaves due jobs untouched while the talk has an active run', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Busy Talk Job',
        prompt: 'Wait for the active turn.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;
    const enqueued = await enqueueGreenfieldChatTurn({
      workspaceId,
      talkId,
      userId: USER_ID,
      content: 'A user turn is still active.',
      targetAgentIds: agentIds,
    });
    if (!enqueued.ok) throw new Error(`enqueue failed: ${enqueued.reason}`);

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<
      Array<{ still_due: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at <= now() as still_due,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
       and r.trigger = 'scheduler'
      where j.id = ${job.id}::uuid
      group by j.id
    `;
    expect(rows[0]).toMatchObject({
      still_due: true,
      scheduled_run_count: 0,
    });
  });

  it('returns busy instead of waiting when the talk row is locked', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Locked Talk Job',
        prompt: 'Do not wait on the Talk row lock.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    await db.begin(async (tx) => {
      await tx`
        select 1
        from public.talks
        where workspace_id = ${workspaceId}::uuid
          and id = ${talkId}::uuid
        for update
      `;

      const claim = await claimDueGreenfieldJobRuns({ limit: 1 });

      expect(claim.enqueuedRunIds).toHaveLength(0);
      expect(claim.blockedJobIds).toHaveLength(0);
      expect(claim.skippedJobIds).toHaveLength(0);
      expect(claim.busyJobIds).toEqual([job.id]);
      expect(claim.failedJobIds).toHaveLength(0);
    });

    const rows = await db<
      Array<{ still_due: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at <= now() as still_due,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
       and r.trigger = 'scheduler'
      where j.id = ${job.id}::uuid
      group by j.id
    `;
    expect(rows[0]).toMatchObject({
      still_due: true,
      scheduled_run_count: 0,
    });
  });

  it('leaves overdue skip jobs due when the talk row is locked', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Overdue Locked Talk Job',
        prompt: 'Do not skip while unrelated Talk work is active.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        catchUp: 'skip',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '3 hours'
      where id = ${job.id}::uuid
    `;

    await db.begin(async (tx) => {
      await tx`
        select 1
        from public.talks
        where workspace_id = ${workspaceId}::uuid
          and id = ${talkId}::uuid
        for update
      `;

      const claim = await claimDueGreenfieldJobRuns({ limit: 1 });

      expect(claim.enqueuedRunIds).toHaveLength(0);
      expect(claim.blockedJobIds).toHaveLength(0);
      expect(claim.skippedJobIds).toHaveLength(0);
      expect(claim.busyJobIds).toEqual([job.id]);
      expect(claim.failedJobIds).toHaveLength(0);
    });

    const rows = await db<
      Array<{ still_due: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at <= now() as still_due,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
       and r.trigger = 'scheduler'
      where j.id = ${job.id}::uuid
      group by j.id
    `;
    expect(rows[0]).toMatchObject({
      still_due: true,
      scheduled_run_count: 0,
    });
  });

  it('pages past busy due jobs so later idle jobs still fire', async () => {
    const db = getDbPg();
    const busyJobIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const { workspaceId, talkId, agentIds } = await createTalkFixture();
      const job = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Busy Page Job ${i}`,
          prompt: 'This job is due but its Talk is already active.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      busyJobIds.push(job.id);
    }
    await db`
      update public.jobs
      set next_due_at = now() - interval '10 minutes'
      where id in ${db(busyJobIds)}
    `;

    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const idleJob = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Idle Page Job',
        prompt: 'This job should not starve behind busy jobs.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '5 minutes'
      where id = ${idleJob.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(1);
    const runRows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id = ${queue.sends[0]!.runId}::uuid
    `;
    expect(runRows[0]?.job_id).toBe(idleJob.id);
    const busyRows = await db<
      Array<{ due_count: number; scheduled_run_count: number }>
    >`
      select
        count(*) filter (where j.next_due_at <= now())::int as due_count,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
       and r.trigger = 'scheduler'
      where j.id in ${db(busyJobIds)}
    `;
    expect(busyRows[0]).toMatchObject({
      due_count: 10,
      scheduled_run_count: 0,
    });
  });

  it('counts talk-busy candidates against the due-job scan budget', async () => {
    const db = getDbPg();
    const busyJobIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const { workspaceId, talkId, agentIds } = await createTalkFixture();
      const job = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Busy Budget Job ${i}`,
          prompt: 'This busy job should consume scan budget.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      busyJobIds.push(job.id);
    }
    await db`
      update public.jobs
      set next_due_at = now() - interval '10 minutes'
      where id in ${db(busyJobIds)}
    `;

    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const idleJob = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Idle Budget Job',
        prompt: 'This row must wait for a later tick budget.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '1 minute'
      where id = ${idleJob.id}::uuid
    `;

    const firstNow = new Date().toISOString();
    const claim = await claimDueGreenfieldJobRuns({ limit: 1, now: firstNow });

    expect(claim.enqueuedRunIds).toHaveLength(0);
    expect(claim.busyJobIds).toHaveLength(10);
    expect(new Set(claim.busyJobIds)).toEqual(new Set(busyJobIds));
    const idleRows = await db<
      Array<{ still_due: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at <= now() as still_due,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
      where j.id = ${idleJob.id}::uuid
      group by j.id
    `;
    expect(idleRows[0]).toMatchObject({
      still_due: true,
      scheduled_run_count: 0,
    });

    const deferredRows = await db<Array<{ deferred_count: number }>>`
      select count(*)::int as deferred_count
      from public.jobs
      where id in ${db(busyJobIds)}
        and claimed_at is not null
    `;
    expect(deferredRows[0]?.deferred_count).toBe(10);

    const secondNow = new Date(
      new Date(firstNow).getTime() + 60_000,
    ).toISOString();
    const nextClaim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: secondNow,
    });

    expect(nextClaim.busyJobIds).toHaveLength(0);
    expect(nextClaim.enqueuedRunIds).toHaveLength(1);
    const runRows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id = ${nextClaim.enqueuedRunIds[0]!}::uuid
    `;
    expect(runRows[0]?.job_id).toBe(idleJob.id);
  });

  it('skips a large fresh-claim prefix without starving an eligible due job', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const firstNow = new Date('2026-01-15T12:00:00.000Z');
    const freshClaimedJobIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const job = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Fresh Claim Prefix Job ${i}`,
          prompt: 'This row should stay in short backoff.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      freshClaimedJobIds.push(job.id);
    }
    const eligible = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Eligible Behind Fresh Prefix',
        prompt: 'This row must be reachable while earlier rows are fresh.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = ${new Date(
        firstNow.getTime() - 10 * 60 * 1000,
      ).toISOString()}::timestamptz,
          claimed_at = ${firstNow.toISOString()}::timestamptz
      where id in ${db(freshClaimedJobIds)}
    `;
    await db`
      update public.jobs
      set next_due_at = ${new Date(
        firstNow.getTime() - 60 * 1000,
      ).toISOString()}::timestamptz
      where id = ${eligible.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: new Date(firstNow.getTime() + 60 * 1000),
    });

    expect(claim.busyJobIds).toHaveLength(0);
    expect(claim.failedJobIds).toHaveLength(0);
    expect(claim.enqueuedRunIds).toHaveLength(1);
    const rows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id = ${claim.enqueuedRunIds[0]!}::uuid
    `;
    expect(rows[0]?.job_id).toBe(eligible.id);
  });

  it('reaches untouched due jobs despite retry-ready hot rows at limit one', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const firstNow = new Date('2026-01-15T12:00:00.000Z');
    const retryReadyJobIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const job = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Retry Ready Prefix Job ${i}`,
          prompt: 'This row should not starve untouched due work.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      retryReadyJobIds.push(job.id);
    }
    const eligible = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Untouched Due Behind Retry Prefix',
        prompt: 'This untouched row should be claimed first.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set schedule_json = '{"kind":"invalid"}'::jsonb,
          next_due_at = ${new Date(
            firstNow.getTime() - 10 * 60 * 1000,
          ).toISOString()}::timestamptz,
          claimed_at = ${new Date(
            firstNow.getTime() - 10 * 60 * 1000,
          ).toISOString()}::timestamptz
      where id in ${db(retryReadyJobIds)}
    `;
    await db`
      update public.jobs
      set next_due_at = ${new Date(
        firstNow.getTime() - 60 * 1000,
      ).toISOString()}::timestamptz
      where id = ${eligible.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: firstNow,
    });

    expect(claim.failedJobIds).toHaveLength(1);
    expect(retryReadyJobIds).toContain(claim.failedJobIds[0]);
    expect(claim.enqueuedRunIds).toHaveLength(1);
    const rows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id = ${claim.enqueuedRunIds[0]!}::uuid
    `;
    expect(rows[0]?.job_id).toBe(eligible.id);
  });

  it('reserves batch capacity for retry-ready rows under fresh due load', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const firstNow = new Date('2026-01-15T12:00:00.000Z');
    const retryReady = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Expired Retry Job',
        prompt: 'This retry-ready row must still be visited.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    const freshDueJobIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const job = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Fresh Due Job ${i}`,
          prompt: 'This row represents a steady fresh due backlog.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      freshDueJobIds.push(job.id);
    }
    await db`
      update public.jobs
      set schedule_json = '{"kind":"invalid"}'::jsonb,
          next_due_at = ${new Date(
            firstNow.getTime() - 10 * 60 * 1000,
          ).toISOString()}::timestamptz,
          claimed_at = ${new Date(
            firstNow.getTime() - 10 * 60 * 1000,
          ).toISOString()}::timestamptz
      where id = ${retryReady.id}::uuid
    `;
    await db`
      update public.jobs
      set next_due_at = ${new Date(
        firstNow.getTime() - 60 * 1000,
      ).toISOString()}::timestamptz
      where id in ${db(freshDueJobIds)}
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 4,
      now: firstNow,
    });

    expect(claim.failedJobIds).toContain(retryReady.id);
    expect(claim.enqueuedRunIds).toHaveLength(1);
    const runRows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id in ${db(claim.enqueuedRunIds)}
    `;
    expect(freshDueJobIds).toContain(runRows[0]?.job_id);
  });

  it('blocks due jobs when the target agent leaves the talk roster', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Missing Agent Job',
        prompt: 'This target will leave.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      delete from public.talk_agents
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and agent_id = ${agentIds[0]}::uuid
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<
      Array<{
        status: string;
        block_reason: string | null;
        next_due_at: string | null;
      }>
    >`
      select status, block_reason, next_due_at
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'agent_missing',
      next_due_at: null,
    });
    const inboxRows = await db<
      Array<{
        type: string;
        target_kind: string | null;
        severity: string;
        title: string;
        reason: string | null;
        job_id: string | null;
        talk_id: string | null;
        ref_id: string | null;
      }>
    >`
      select type, target_kind, severity, title, reason, job_id, talk_id, ref_id
      from public.home_inbox_items
      where workspace_id = ${workspaceId}::uuid
        and type = 'job_blocked'
    `;
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toMatchObject({
      type: 'job_blocked',
      target_kind: 'job',
      severity: 'blocking',
      title: 'Missing Agent Job is blocked',
      reason: 'block_reason=agent_missing',
      job_id: job.id,
      talk_id: talkId,
      ref_id: null,
    });
  });

  it('blocks due jobs when the target agent model is disabled', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const modelRows = await db<Array<{ model_id: string }>>`
      select model_id
      from public.agents
      where workspace_id = ${workspaceId}::uuid
        and id = ${agentIds[0]}::uuid
      limit 1
    `;
    const modelId = modelRows[0]?.model_id;
    if (!modelId) throw new Error('Expected target agent model');
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Disabled Model Job',
        prompt: 'This target model will be disabled.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;
    await db`
      update public.llm_provider_models
      set enabled = false
      where model_id = ${modelId}
    `;

    try {
      const queue = await runTick();

      expect(queue.sends).toHaveLength(0);
      const rows = await db<
        Array<{
          status: string;
          block_reason: string | null;
          next_due_at: string | null;
          run_count: number;
        }>
      >`
        select j.status, j.block_reason, j.next_due_at, count(r.id)::int as run_count
        from public.jobs j
        left join public.runs r
          on r.workspace_id = j.workspace_id
         and r.job_id = j.id
        where j.id = ${job.id}::uuid
        group by j.id
      `;
      expect(rows[0]).toMatchObject({
        status: 'blocked',
        block_reason: 'model_disabled',
        next_due_at: null,
        run_count: 0,
      });
      const inboxRows = await db<
        Array<{
          type: string;
          severity: string;
          summary: string | null;
          reason: string | null;
          job_id: string | null;
          ref_id: string | null;
        }>
      >`
        select type, severity, summary, reason, job_id, ref_id
        from public.home_inbox_items
        where workspace_id = ${workspaceId}::uuid
          and type = 'job_blocked'
          and job_id = ${job.id}::uuid
      `;
      expect(inboxRows).toHaveLength(1);
      expect(inboxRows[0]).toMatchObject({
        type: 'job_blocked',
        severity: 'blocking',
        summary: 'The selected agent model or provider is not available.',
        reason: 'block_reason=model_disabled',
        job_id: job.id,
        ref_id: null,
      });
    } finally {
      await db`
        update public.llm_provider_models
        set enabled = true
        where model_id = ${modelId}
      `;
    }
  });

  it('blocks due jobs when a fire-time source dependency is revoked', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Drive Dependency Job',
        prompt: 'Summarize Drive changes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.connectors
      set authorized = false
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<
      Array<{
        status: string;
        block_reason: string | null;
        next_due_at: string | null;
      }>
    >`
      select status, block_reason, next_due_at
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'connector_not_authorized',
      next_due_at: null,
    });
    const inboxRows = await db<
      Array<{
        type: string;
        severity: string;
        summary: string | null;
        reason: string | null;
        job_id: string | null;
        talk_id: string | null;
        ref_id: string | null;
      }>
    >`
      select type, severity, summary, reason, job_id, talk_id, ref_id
      from public.home_inbox_items
      where workspace_id = ${workspaceId}::uuid
        and type = 'job_blocked'
        and job_id = ${job.id}::uuid
    `;
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toMatchObject({
      type: 'job_blocked',
      severity: 'blocking',
      summary: 'Connector gdrive is not authorized for this workspace.',
      reason: 'block_reason=connector_not_authorized',
      job_id: job.id,
      talk_id: talkId,
      ref_id: null,
    });
  });

  it('blocks due gdrive-read jobs when the credential lacks Docs and Sheets scopes', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Drive Scope Regression Job',
        prompt: 'Read Drive, Docs, and Sheets sources.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.connectors
      set config_json = jsonb_set(
        config_json,
        '{scopes}',
        ${db.json(['drive.readonly'] as never)}::jsonb,
        true
      )
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
        and config_json->>'compatSurface' = 'google_tools'
        and config_json->>'authorizedByUserId' = ${USER_ID}
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<Array<{ status: string; block_reason: string }>>`
      select status, block_reason
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'connector_not_authorized',
    });
  });

  it('requires the full runtime Google scope set for gdrive-read and gdrive-write credentials', () => {
    expect(
      googleToolCredentialHasRequiredScopes({
        scopes: ['drive.readonly'],
        toolId: 'gdrive-read',
      }),
    ).toBe(false);
    expect(
      googleToolCredentialHasRequiredScopes({
        scopes: ['drive.readonly', 'documents', 'spreadsheets'],
        toolId: 'gdrive-read',
      }),
    ).toBe(true);
    expect(
      googleToolCredentialHasRequiredScopes({
        scopes: ['drive.readonly'],
        toolId: 'gdrive-write',
      }),
    ).toBe(false);
    expect(
      googleToolCredentialHasRequiredScopes({
        scopes: ['documents', 'spreadsheets'],
        toolId: 'gdrive-write',
      }),
    ).toBe(true);
  });

  it('blocks due jobs when only another user has the Google tools credential', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Wrong User Drive Job',
        prompt: 'Summarize Drive changes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );
    await db`
      delete from public.connectors
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
        and config_json->>'compatSurface' = 'google_tools'
        and config_json->>'authorizedByUserId' = ${USER_ID}
    `;
    await authorizeGoogleToolsConnector(workspaceId, OTHER_USER_ID);
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<Array<{ status: string; block_reason: string }>>`
      select status, block_reason
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'connector_not_authorized',
    });
  });

  it('does not let admins manually run jobs under another creator credential', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into auth.users (id, email, raw_user_meta_data)
      values (
        ${OTHER_USER_ID}::uuid,
        'scheduler-admin@clawtalk.local',
        jsonb_build_object('full_name', 'Scheduler Admin')
      )
      on conflict (id) do update set
        email = excluded.email,
        raw_user_meta_data = excluded.raw_user_meta_data
    `;
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
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Admin Run Now Drive Job',
        prompt: 'Summarize Drive changes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );

    const result = await withUserContext(OTHER_USER_ID, () =>
      createGreenfieldJobRunNow({
        workspaceId,
        talkId,
        jobId: job.id,
        requestedBy: OTHER_USER_ID,
      }),
    );

    expect(result).toMatchObject({
      status: 'forbidden',
      job: expect.objectContaining({ id: job.id, createdBy: USER_ID }),
    });
    const runRows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where job_id = ${job.id}::uuid
    `;
    expect(runRows[0]?.count).toBe(0);
  });

  it('records a distinct inbox item when a healed job blocks again', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Repeat Block Job',
        prompt: 'Summarize Drive changes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );

    await db`
      update public.connectors
      set authorized = false
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    await runTick();

    await db`
      update public.connectors
      set authorized = true,
          authorized_at = now()
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    const healed = await withUserContext(USER_ID, () =>
      patchGreenfieldJob({
        workspaceId,
        talkId,
        jobId: job.id,
        title: 'Repeat Block Job Healed',
      }),
    );
    expect(healed?.status).toBe('active');
    await db`
      update public.connectors
      set authorized = false
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    await runTick();

    const inboxRows = await db<
      Array<{
        id: string;
        ref_id: string | null;
        group_key: string | null;
      }>
    >`
      select id, ref_id, group_key
      from public.home_inbox_items
      where workspace_id = ${workspaceId}::uuid
        and type = 'job_blocked'
        and job_id = ${job.id}::uuid
      order by created_at asc, id asc
    `;
    expect(inboxRows).toHaveLength(2);
    expect(new Set(inboxRows.map((row) => row.id)).size).toBe(2);
    expect(inboxRows.map((row) => row.ref_id)).toEqual([null, null]);
    expect(inboxRows.map((row) => row.group_key)).toEqual([
      `job:${job.id}:blocked`,
      `job:${job.id}:blocked`,
    ]);
    const jobRows = await db<Array<{ status: string; block_reason: string }>>`
      select status, block_reason
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(jobRows[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'connector_not_authorized',
    });
  });

  it('does not block dependency-revoked jobs while a prior job run is active', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values (${workspaceId}::uuid, ${talkId}::uuid, 'gdrive-read', true)
      on conflict (talk_id, tool_id) do update set
        enabled = excluded.enabled
    `;
    await authorizeGoogleToolsConnector(workspaceId);
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Busy Dependency Job',
        prompt: 'This should wait for its active run first.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { toolIds: ['gdrive-read'] },
        createdBy: USER_ID,
      }),
    );
    const active = await createGreenfieldJobRunNow({
      workspaceId,
      talkId,
      jobId: job.id,
      requestedBy: USER_ID,
    });
    expect(active.status).toBe('enqueued');
    await db`
      update public.connectors
      set authorized = false
      where workspace_id = ${workspaceId}::uuid
        and service = 'gdrive'
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '30 seconds'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<
      Array<{
        status: string;
        block_reason: string | null;
        next_due_is_future: boolean;
      }>
    >`
      select status, block_reason, next_due_at > now() as next_due_is_future
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'active',
      block_reason: null,
      next_due_is_future: true,
    });
    const inboxRows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.home_inbox_items
      where workspace_id = ${workspaceId}::uuid
        and type = 'job_blocked'
        and job_id = ${job.id}::uuid
    `;
    expect(inboxRows[0]?.count).toBe(0);
  });

  it('continues processing due jobs after one claim fails', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const poison = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Poison Job',
        prompt: 'This row has a bad schedule after creation.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    const valid = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Valid Job',
        prompt: 'This row should still enqueue.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set schedule_json = '{"kind":"invalid"}'::jsonb,
          next_due_at = now() - interval '2 minutes'
      where id = ${poison.id}::uuid
    `;
    await db`
      update public.jobs
      set next_due_at = now() - interval '1 minute'
      where id = ${valid.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(1);
    const runRows = await db<Array<{ job_id: string | null }>>`
      select job_id
      from public.runs
      where id = ${queue.sends[0]!.runId}::uuid
    `;
    expect(runRows[0]?.job_id).toBe(valid.id);
    const poisonRows = await db<
      Array<{
        status: string;
        still_due: boolean;
        scheduled_run_count: number;
      }>
    >`
      select
        j.status,
        j.next_due_at <= now() as still_due,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
      where j.id = ${poison.id}::uuid
      group by j.id
    `;
    expect(poisonRows[0]).toMatchObject({
      status: 'active',
      still_due: true,
      scheduled_run_count: 0,
    });
  });

  it('caps due-job scan attempts when poison rows stay hot', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const firstNow = new Date('2026-01-15T12:00:00.000Z');
    const poisonJobIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const poison = await withUserContext(USER_ID, () =>
        createGreenfieldJob({
          workspaceId,
          talkId,
          title: `Poison Budget Job ${i}`,
          prompt: 'This row stays hot because its schedule was corrupted.',
          agentId: agentIds[0]!,
          schedule: { kind: 'interval', everyHours: 1 },
          timezone: 'UTC',
          createdBy: USER_ID,
        }),
      );
      poisonJobIds.push(poison.id);
    }
    const valid = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Valid Budget Job',
        prompt: 'This row must wait for the next tick budget.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set schedule_json = '{"kind":"invalid"}'::jsonb,
          next_due_at = ${new Date(
            firstNow.getTime() - 10 * 60 * 1000,
          ).toISOString()}::timestamptz
      where id in ${db(poisonJobIds)}
    `;
    await db`
      update public.jobs
      set next_due_at = ${new Date(
        firstNow.getTime() - 60 * 1000,
      ).toISOString()}::timestamptz
      where id = ${valid.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: firstNow,
    });

    expect(claim.failedJobIds).toHaveLength(10);
    expect(new Set(claim.failedJobIds).size).toBe(10);
    expect(claim.enqueuedRunIds).toHaveLength(0);
    const poisonRows = await db<Array<{ deferred_count: number }>>`
      select count(*)::int as deferred_count
      from public.jobs
      where id in ${db(poisonJobIds)}
        and claimed_at = ${firstNow.toISOString()}::timestamptz
    `;
    expect(poisonRows[0]?.deferred_count).toBe(10);

    const nextClaim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: new Date(firstNow.getTime() + 60 * 1000),
    });

    expect(nextClaim.failedJobIds).toHaveLength(0);
    expect(nextClaim.enqueuedRunIds).toHaveLength(1);
    const validRows = await db<
      Array<{ next_due_is_future: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at > ${firstNow.toISOString()}::timestamptz as next_due_is_future,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
      where j.id = ${valid.id}::uuid
      group by j.id
    `;
    expect(validRows[0]).toMatchObject({
      next_due_is_future: true,
      scheduled_run_count: 1,
    });
  });

  it('skips missed slots for skip catch-up jobs', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Catch Up Skip Job',
        prompt: 'Only run on a current slot.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        catchUp: 'skip',
        createdBy: USER_ID,
      }),
    );
    await db`
      update public.jobs
      set next_due_at = now() - interval '3 hours'
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(0);
    const rows = await db<
      Array<{
        status: string;
        next_due_is_future: boolean;
        scheduled_run_count: number;
      }>
    >`
      select
        j.status,
        j.next_due_at > now() as next_due_is_future,
        count(r.id)::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
       and r.trigger = 'scheduler'
      where j.id = ${job.id}::uuid
      group by j.id
    `;
    expect(rows[0]).toMatchObject({
      status: 'active',
      next_due_is_future: true,
      scheduled_run_count: 0,
    });
  });

  it('fires one missed slot for run_once jobs after the prior run terminates', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Catch Up Run Once Job',
        prompt: 'Run one missed slot after the active run finishes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        catchUp: 'run_once',
        createdBy: USER_ID,
      }),
    );
    const active = await withUserContext(USER_ID, () =>
      createGreenfieldJobRunNow({
        workspaceId,
        talkId,
        jobId: job.id,
        requestedBy: USER_ID,
      }),
    );
    if (active.status !== 'enqueued') {
      throw new Error(`Expected active run to enqueue, got ${active.status}`);
    }
    await db`
      update public.jobs
      set next_due_at = now() - interval '3 hours'
      where id = ${job.id}::uuid
    `;

    const blockedQueue = await runTick();

    expect(blockedQueue.sends).toHaveLength(0);
    const blockedRows = await db<
      Array<{ still_due: boolean; scheduled_run_count: number }>
    >`
      select
        j.next_due_at <= now() as still_due,
        count(r.id) filter (where r.trigger = 'scheduler')::int as scheduled_run_count
      from public.jobs j
      left join public.runs r
        on r.workspace_id = j.workspace_id
       and r.job_id = j.id
      where j.id = ${job.id}::uuid
      group by j.id
    `;
    expect(blockedRows[0]).toMatchObject({
      still_due: true,
      scheduled_run_count: 0,
    });
    await db`
      update public.runs
      set status = 'completed',
          started_at = coalesce(started_at, now()),
          finished_at = now()
      where id = ${active.runId}::uuid
    `;
    await db`
      update public.jobs
      set claimed_at = null
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toHaveLength(1);
    const firedRows = await db<
      Array<{
        trigger: string;
        job_id: string | null;
        scheduled_for_is_past: boolean;
        next_due_is_future: boolean;
      }>
    >`
      select
        r.trigger,
        r.job_id,
        r.scheduled_for <= now() as scheduled_for_is_past,
        j.next_due_at > now() as next_due_is_future
      from public.runs r
      join public.jobs j
        on j.workspace_id = r.workspace_id
       and j.id = r.job_id
      where r.id = ${queue.sends[0]!.runId}::uuid
    `;
    expect(firedRows[0]).toMatchObject({
      trigger: 'scheduler',
      job_id: job.id,
      scheduled_for_is_past: true,
      next_due_is_future: true,
    });
  });

  it('advances daily fall-back jobs past the duplicate local slot', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'DST Fall Back Job',
        prompt: 'Do not double fire the repeated wall-clock minute.',
        agentId: agentIds[0]!,
        schedule: { kind: 'daily', hour: 1, minute: 30 },
        timezone: 'America/Los_Angeles',
        createdBy: USER_ID,
      }),
    );
    const firstFallBackSlot = '2026-11-01T08:30:00.000Z';
    const duplicateFallBackSlot = '2026-11-01T09:30:00.000Z';
    const nextDaySlot = '2026-11-02T09:30:00.000Z';
    await db`
      update public.jobs
      set next_due_at = ${firstFallBackSlot}::timestamptz
      where id = ${job.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: '2026-11-01T08:31:00.000Z',
    });

    expect(claim.enqueuedRunIds).toHaveLength(1);
    const rows = await db<
      Array<{
        fired_first_slot: boolean;
        advanced_to_next_day: boolean;
        skipped_duplicate_slot: boolean;
      }>
    >`
      select
        r.scheduled_for = ${firstFallBackSlot}::timestamptz as fired_first_slot,
        j.next_due_at = ${nextDaySlot}::timestamptz as advanced_to_next_day,
        j.next_due_at > ${duplicateFallBackSlot}::timestamptz as skipped_duplicate_slot
      from public.runs r
      join public.jobs j
        on j.workspace_id = r.workspace_id
       and j.id = r.job_id
      where r.id = ${claim.enqueuedRunIds[0]!}::uuid
    `;
    expect(rows[0]).toMatchObject({
      fired_first_slot: true,
      advanced_to_next_day: true,
      skipped_duplicate_slot: true,
    });
  });

  it('skips daily spring-forward wall-clock gaps', async () => {
    const { workspaceId, talkId, agentIds } = await createIdleTalkFixture();
    const db = getDbPg();
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'DST Spring Forward Job',
        prompt: 'Skip nonexistent local wall-clock minutes.',
        agentId: agentIds[0]!,
        schedule: { kind: 'daily', hour: 2, minute: 30 },
        timezone: 'America/Los_Angeles',
        createdBy: USER_ID,
      }),
    );
    const priorDaySlot = '2026-03-07T10:30:00.000Z';
    const nextValidSlot = '2026-03-09T09:30:00.000Z';
    await db`
      update public.jobs
      set next_due_at = ${priorDaySlot}::timestamptz
      where id = ${job.id}::uuid
    `;

    const claim = await claimDueGreenfieldJobRuns({
      limit: 1,
      now: '2026-03-07T10:31:00.000Z',
    });

    expect(claim.enqueuedRunIds).toHaveLength(1);
    const rows = await db<
      Array<{
        fired_prior_day: boolean;
        skipped_gap_day: boolean;
      }>
    >`
      select
        r.scheduled_for = ${priorDaySlot}::timestamptz as fired_prior_day,
        j.next_due_at = ${nextValidSlot}::timestamptz as skipped_gap_day
      from public.runs r
      join public.jobs j
        on j.workspace_id = r.workspace_id
       and j.id = r.job_id
      where r.id = ${claim.enqueuedRunIds[0]!}::uuid
    `;
    expect(rows[0]).toMatchObject({
      fired_prior_day: true,
      skipped_gap_day: true,
    });
  });

  it('clears job claim backoff when a job run completes', async () => {
    const { jobId, runId } = await createQueuedJobRunFixture();
    const db = getDbPg();
    await db`
      update public.jobs
      set claimed_at = now()
      where id = ${jobId}::uuid
    `;
    await db`
      update public.runs
      set status = 'running',
          started_at = now()
      where id = ${runId}::uuid
    `;

    const completed = await completeGreenfieldRun({
      runId,
      responseMessageId: randomUUID(),
      responseContent: 'Done.',
    });

    expect(completed.applied).toBe(true);
    const rows = await db<
      Array<{
        claim_cleared: boolean;
        last_run_status: string | null;
        run_count: number;
      }>
    >`
      select
        claimed_at is null as claim_cleared,
        last_run_status,
        run_count
      from public.jobs
      where id = ${jobId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      claim_cleared: true,
      last_run_status: 'completed',
      run_count: 1,
    });
  });

  it('clears job claim backoff when a job run fails', async () => {
    const { jobId, runId } = await createQueuedJobRunFixture();
    const db = getDbPg();
    await db`
      update public.jobs
      set claimed_at = now()
      where id = ${jobId}::uuid
    `;
    await db`
      update public.runs
      set status = 'running',
          started_at = now()
      where id = ${runId}::uuid
    `;

    const failed = await failGreenfieldRun({
      runId,
      errorCode: 'test_failure',
      errorMessage: 'Synthetic failure.',
    });

    expect(failed.applied).toBe(true);
    const rows = await db<
      Array<{
        claim_cleared: boolean;
        last_run_status: string | null;
        run_count: number;
      }>
    >`
      select
        claimed_at is null as claim_cleared,
        last_run_status,
        run_count
      from public.jobs
      where id = ${jobId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      claim_cleared: true,
      last_run_status: 'failed',
      run_count: 1,
    });
  });

  it('clears job claim backoff when a job run is cancelled', async () => {
    const { workspaceId, talkId, jobId } = await createQueuedJobRunFixture();
    const db = getDbPg();
    await db`
      update public.jobs
      set claimed_at = now()
      where id = ${jobId}::uuid
    `;

    const cancelled = await cancelGreenfieldTalkRuns({
      workspaceId,
      talkId,
      userId: USER_ID,
      includeJobRuns: true,
    });

    expect(cancelled.cancelledRuns).toBe(1);
    const rows = await db<
      Array<{
        claim_cleared: boolean;
        last_run_status: string | null;
        run_count: number;
      }>
    >`
      select
        claimed_at is null as claim_cleared,
        last_run_status,
        run_count
      from public.jobs
      where id = ${jobId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      claim_cleared: true,
      last_run_status: 'cancelled',
      run_count: 1,
    });
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

  it('records one terminal bookkeeping update for a stuck running job run', async () => {
    const { workspaceId, talkId, agentIds, runIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed',
          started_at = coalesce(started_at, now()),
          finished_at = now()
      where id in ${db(runIds)}
    `;
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Swept Job',
        prompt: 'Sweep me',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { allowWeb: false, toolIds: [] },
        createdBy: USER_ID,
      }),
    );
    const enqueued = await withUserContext(USER_ID, () =>
      createGreenfieldJobRunNow({
        workspaceId,
        talkId,
        jobId: job.id,
        requestedBy: USER_ID,
      }),
    );
    if (enqueued.status !== 'enqueued') {
      throw new Error(`Expected job run to enqueue, got ${enqueued.status}`);
    }
    const runId = enqueued.runId;
    await db`
      update public.runs
      set status = 'running',
          started_at = now() - interval '2 hours'
      where id = ${runId}::uuid
    `;
    await db`
      update public.jobs
      set claimed_at = now()
      where id = ${job.id}::uuid
    `;

    await runTick();

    const rows = await db<
      Array<{
        run_count: number;
        last_run_status: string | null;
        last_run_at: string | null;
        claim_cleared: boolean;
      }>
    >`
      select run_count, last_run_status, last_run_at, claimed_at is null as claim_cleared
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      run_count: 1,
      last_run_status: 'failed',
      claim_cleared: true,
    });
    expect(rows[0]?.last_run_at).not.toBeNull();
  });

  it('redispatches stale queued job runs without terminal bookkeeping', async () => {
    const { workspaceId, talkId, agentIds, runIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed',
          started_at = coalesce(started_at, now()),
          finished_at = now()
      where id in ${db(runIds)}
    `;
    const job = await withUserContext(USER_ID, () =>
      createGreenfieldJob({
        workspaceId,
        talkId,
        title: 'Queued Sweep Job',
        prompt: 'Sweep queued',
        agentId: agentIds[0]!,
        schedule: { kind: 'interval', everyHours: 1 },
        timezone: 'UTC',
        sourceScope: { allowWeb: false, toolIds: [] },
        createdBy: USER_ID,
      }),
    );
    const enqueued = await withUserContext(USER_ID, () =>
      createGreenfieldJobRunNow({
        workspaceId,
        talkId,
        jobId: job.id,
        requestedBy: USER_ID,
      }),
    );
    if (enqueued.status !== 'enqueued') {
      throw new Error(`Expected job run to enqueue, got ${enqueued.status}`);
    }
    const runId = enqueued.runId;
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${runId}::uuid
    `;
    await db`
      update public.jobs
      set claimed_at = now()
      where id = ${job.id}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toContainEqual({ runId });

    const rows = await db<
      Array<{
        run_count: number;
        last_run_status: string | null;
        last_run_at: string | null;
        claimed_at: string | null;
      }>
    >`
      select run_count, last_run_status, last_run_at, claimed_at
      from public.jobs
      where id = ${job.id}::uuid
    `;
    expect(rows[0]).toMatchObject({
      run_count: 0,
      last_run_status: null,
    });
    expect(rows[0]?.last_run_at).toBeNull();
    expect(rows[0]?.claimed_at).not.toBeNull();
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

  it('redispatches first queued steps older than the 5m stuck threshold', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${runId}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toContainEqual({ runId });

    const rows = await db<
      Array<{ status: string; error_json: { code?: string } | null }>
    >`
      select status, error_json
      from public.runs
      where id = ${runId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'queued',
      error_json: null,
    });
  });

  it('does not fail stale queued steps when redispatch send fails', async () => {
    const { runIds } = await createTalkFixture();
    const runId = runIds[0]!;
    const db = getDbPg();
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${runId}::uuid
    `;

    const queue = await runTick(makeQueue({ failSend: true }));

    expect(queue.attempts).toBe(1);
    const rows = await db<
      Array<{ status: string; error_json: { code?: string } | null }>
    >`
      select status, error_json
      from public.runs
      where id = ${runId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'queued',
      error_json: null,
    });
  });

  it('does not promote the next ordered sibling while redispatching a stale first queued step', async () => {
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
    expect(rows[0]?.status).toBe('queued');
    expect(queue.sends).toContainEqual({ runId: firstRunId });
    expect(queue.sends).not.toContainEqual({ runId: secondRunId });
  });

  it('redispatches stale ordered siblings after lower steps are terminal', async () => {
    const { runIds } = await createTalkFixture({ agentCount: 2 });
    const firstRunId = runIds[0]!;
    const secondRunId = runIds[1]!;
    const db = getDbPg();
    await db`
      update public.runs
      set status = 'completed',
          started_at = coalesce(started_at, now() - interval '12 minutes'),
          finished_at = now() - interval '11 minutes'
      where id = ${firstRunId}::uuid
    `;
    await db`
      update public.runs
      set created_at = now() - interval '10 minutes'
      where id = ${secondRunId}::uuid
    `;

    const queue = await runTick();

    expect(queue.sends).toContainEqual({ runId: secondRunId });
    expect(queue.sends).not.toContainEqual({ runId: firstRunId });
  });

  it('redispatches any stale queued step in parallel talks', async () => {
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

    const queue = await runTick();

    expect(queue.sends).toContainEqual({ runId: secondRunId });

    const rows = await db<
      Array<{ status: string; error_json: { code?: string } | null }>
    >`
      select status, error_json
      from public.runs
      where id = ${secondRunId}::uuid
    `;
    expect(rows[0]).toMatchObject({
      status: 'queued',
      error_json: null,
    });
  });
});
