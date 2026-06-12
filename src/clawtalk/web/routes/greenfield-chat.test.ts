import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  DATABASE_URL_ENV,
  getDbPg,
  initPgDatabase,
  withNotifyQueueScope,
  withRequestScopedDb,
  withUserContext,
} from '../../../db.js';
import type { AuthContext } from '../types.js';
import { cancelGreenfieldTalkRuns } from '../../talks/greenfield-chat-accessors.js';
import { mountGreenfieldApiRoutes } from './greenfield-api.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  cancelGreenfieldChatRoute,
  enqueueGreenfieldChatRoute,
} from './greenfield-chat.js';

const USER_ID = '0c949494-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c949494-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: 'greenfield-chat-session',
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(
  userId = USER_ID,
  email = 'greenfield-chat@clawtalk.local',
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${userId}::uuid,
      ${email},
      jsonb_build_object('full_name', 'Chat User')
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
  await db`delete from public.workspaces where owner_id = ${OTHER_USER_ID}::uuid`;
  await db`delete from auth.users where id = ${USER_ID}::uuid`;
  await db`delete from auth.users where id = ${OTHER_USER_ID}::uuid`;
}

async function seedWorkspaceWithDefaultAgents(name: string): Promise<string> {
  const db = getDbPg();
  const rows = await db<Array<{ id: string }>>`
    insert into public.workspaces (name, owner_id)
    values (${name}, ${USER_ID}::uuid)
    returning id
  `;
  const workspaceId = rows[0]!.id;
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${USER_ID}::uuid, 'owner')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  await db`
    insert into public.agents (
      workspace_id, role_key, name, handle, initials, accent, accent_dark,
      model_id, default_model_id, temperature, method, is_default, is_custom,
      is_system, enabled, created_from_template_version
    )
    select
      ${workspaceId}::uuid,
      t.role_key,
      t.default_name,
      t.default_handle,
      t.default_initials,
      t.default_accent,
      t.default_accent_dark,
      t.default_model_id,
      t.default_model_id,
      t.default_temperature,
      t.method_default,
      true,
      false,
      false,
      true,
      t.version
    from public.agent_role_templates t
    where t.role_key in ('strategist', 'critic', 'researcher', 'editor', 'quant')
  `;
  return workspaceId;
}

async function createTalkFixture(input?: { workspaceId?: string }): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  let workspaceId = input?.workspaceId;
  if (!workspaceId) {
    const me = await getGreenfieldMeRoute({ auth: auth() });
    if (!me.body.ok) throw new Error('Expected session route to succeed');
    workspaceId = me.body.data.currentWorkspaceId;
  }
  const agents = await listGreenfieldAgentsRoute({ auth: auth(), workspaceId });
  if (!agents.body.ok) throw new Error('Expected agents route to succeed');
  const agentIds = agents.body.data.agents.slice(0, 2).map((agent) => agent.id);
  const created = await createGreenfieldTalkRoute({
    auth: auth(),
    workspaceId,
    body: {
      title: 'Chat Talk',
      team: agentIds,
      rounds: 3,
      mode: 'ordered',
    },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id, agentIds };
}

async function assignDisabledModelToAgent(input: {
  workspaceId: string;
  agentId: string;
}): Promise<void> {
  const db = getDbPg();
  const modelId = `disabled-chat-snapshot-${input.agentId.slice(0, 8)}`;
  await db`
    insert into public.llm_provider_models (
      provider_id, model_id, display_name, context_window_tokens,
      default_max_output_tokens, default_ttft_timeout_ms, enabled,
      capabilities_json
    )
    values (
      'provider.openai',
      ${modelId},
      'Disabled chat snapshot regression model',
      128000,
      4096,
      30000,
      false,
      '{}'::jsonb
    )
    on conflict (provider_id, model_id) do update set
      enabled = false,
      display_name = excluded.display_name
  `;
  await db`
    update public.agents
    set model_id = ${modelId}
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.agentId}::uuid
  `;
}

async function assignDisabledProviderModelToAgent(input: {
  workspaceId: string;
  agentId: string;
}): Promise<void> {
  const db = getDbPg();
  const suffix = input.agentId.slice(0, 8);
  const providerId = `test.disabled-chat-provider-${suffix}`;
  const modelId = `disabled-chat-provider-model-${suffix}`;
  await db`
    insert into public.llm_providers (
      id, name, provider_kind, api_format, base_url, auth_scheme, enabled
    )
    values (
      ${providerId},
      'Disabled chat provider',
      'custom',
      'openai_chat_completions',
      'mock://disabled-chat-provider',
      'bearer',
      false
    )
    on conflict (id) do update set
      enabled = false,
      name = excluded.name
  `;
  await db`
    insert into public.llm_provider_models (
      provider_id, model_id, display_name, context_window_tokens,
      default_max_output_tokens, default_ttft_timeout_ms, enabled,
      capabilities_json
    )
    values (
      ${providerId},
      ${modelId},
      'Disabled-provider chat regression model',
      128000,
      4096,
      30000,
      true,
      '{}'::jsonb
    )
    on conflict (provider_id, model_id) do update set
      enabled = true,
      display_name = excluded.display_name
  `;
  await db`
    update public.agents
    set model_id = ${modelId}
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.agentId}::uuid
  `;
}

describe('greenfield chat routes', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await deleteUser();
    await seedAuthUser();
  });

  afterAll(async () => {
    await deleteUser();
    await closePgDatabase();
  });

  it('enqueues a message, freezes the roster, and creates queued runs', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'What should we do this week?',
      targetAgentIds: agentIds,
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) throw new Error('Expected chat enqueue to succeed');
    expect(result.body.data.message).toMatchObject({
      role: 'user',
      content: 'What should we do this week?',
    });
    expect(result.body.data.runs).toHaveLength(2);
    expect(result.body.data.runs.map((run) => run.status)).toEqual([
      'queued',
      'queued',
    ]);
    expect(result.body.data.runs.map((run) => run.sequenceIndex)).toEqual([
      0, 1,
    ]);
    expect(result.body.data.runs.map((run) => run.targetAgentId)).toEqual(
      agentIds,
    );
    expect(
      new Set(result.body.data.runs.map((run) => run.responseGroupId)).size,
    ).toBe(1);

    const db = getDbPg();
    const rows = await db<
      Array<{
        message_count: number;
        run_count: number;
        snapshot_count: number;
        snapshot_group_count: number;
        trigger_message_ids: string[];
      }>
    >`
      select
        (select count(*)::int from public.messages where talk_id = ${talkId}::uuid) as message_count,
        (select count(*)::int from public.runs where talk_id = ${talkId}::uuid) as run_count,
        (select count(*)::int from public.talk_agent_snapshots where talk_id = ${talkId}::uuid) as snapshot_count,
        (select count(distinct snapshot_group_id)::int from public.runs where talk_id = ${talkId}::uuid) as snapshot_group_count,
        array(
          select distinct trigger_message_id::text
          from public.runs
          where talk_id = ${talkId}::uuid
        ) as trigger_message_ids
    `;
    expect(rows[0]).toMatchObject({
      message_count: 1,
      run_count: 2,
      snapshot_count: 2,
      snapshot_group_count: 1,
      trigger_message_ids: [result.body.data.message.id],
    });
  });

  it('lets Buddy reply in the system talk', async () => {
    const me = await getGreenfieldMeRoute({ auth: auth() });
    if (!me.body.ok) throw new Error('Expected session route to succeed');
    const workspaceId = me.body.data.currentWorkspaceId;

    const db = getDbPg();
    const buddy = await db<{ talk_id: string; agent_id: string }[]>`
      select t.id as talk_id, a.id as agent_id
      from public.talks t
      join public.talk_agents ta
        on ta.workspace_id = t.workspace_id
       and ta.talk_id = t.id
      join public.agents a
        on a.workspace_id = ta.workspace_id
       and a.id = ta.agent_id
      where t.workspace_id = ${workspaceId}::uuid
        and t.is_system = true
    `;
    expect(buddy).toHaveLength(1);

    // The roster predicate allows the system agent because the talk is a
    // system talk; without that carve-out this enqueue would 404.
    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId: buddy[0]!.talk_id,
      content: 'How do I add an agent to a talk?',
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) {
      throw new Error('Expected Buddy chat enqueue to succeed');
    }
    expect(result.body.data.runs).toHaveLength(1);
    expect(result.body.data.runs[0]).toMatchObject({
      status: 'queued',
      targetAgentId: buddy[0]!.agent_id,
    });
  });

  it('rejects chat enqueue when a targeted agent model is disabled', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await assignDisabledModelToAgent({ workspaceId, agentId: agentIds[0]! });

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Should not enqueue against a disabled model.',
      targetAgentIds: [agentIds[0]!],
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'agent_model_not_found',
    });

    // Fails closed at enqueue: no message, run, or frozen snapshot is created.
    const db = getDbPg();
    const counts = await db<
      Array<{
        message_count: number;
        run_count: number;
        snapshot_count: number;
      }>
    >`
      select
        (select count(*)::int from public.messages where talk_id = ${talkId}::uuid) as message_count,
        (select count(*)::int from public.runs where talk_id = ${talkId}::uuid) as run_count,
        (select count(*)::int from public.talk_agent_snapshots where talk_id = ${talkId}::uuid) as snapshot_count
    `;
    expect(counts[0]).toMatchObject({
      message_count: 0,
      run_count: 0,
      snapshot_count: 0,
    });
  });

  it('rejects chat enqueue when a targeted agent provider is disabled', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await assignDisabledProviderModelToAgent({
      workspaceId,
      agentId: agentIds[0]!,
    });

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Should not enqueue against a disabled provider.',
      targetAgentIds: [agentIds[0]!],
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.ok ? null : result.body.error).toMatchObject({
      code: 'agent_model_not_found',
    });

    const db = getDbPg();
    const counts = await db<
      Array<{
        message_count: number;
        run_count: number;
        snapshot_count: number;
      }>
    >`
      select
        (select count(*)::int from public.messages where talk_id = ${talkId}::uuid) as message_count,
        (select count(*)::int from public.runs where talk_id = ${talkId}::uuid) as run_count,
        (select count(*)::int from public.talk_agent_snapshots where talk_id = ${talkId}::uuid) as snapshot_count
    `;
    expect(counts[0]).toMatchObject({
      message_count: 0,
      run_count: 0,
      snapshot_count: 0,
    });
  });

  it('still enqueues for an enabled agent when a non-targeted agent model is disabled', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await assignDisabledModelToAgent({ workspaceId, agentId: agentIds[0]! });

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Target the still-enabled agent only.',
      targetAgentIds: [agentIds[1]!],
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) throw new Error('Expected chat enqueue to succeed');
    expect(result.body.data.runs).toHaveLength(1);
    expect(result.body.data.runs[0]?.targetAgentId).toBe(agentIds[1]);
  });

  it('rejects malformed chat enqueue payload fields without throwing', async () => {
    const talkId = '11111111-1111-4111-8111-111111111111';
    const cases: Array<{
      body: {
        content: unknown;
        targetAgentIds?: unknown;
      };
      code: string;
    }> = [
      {
        body: { content: 42, targetAgentIds: [] },
        code: 'message_required',
      },
      {
        body: { content: 'hello', targetAgentIds: 'bad' },
        code: 'invalid_target_agent_id',
      },
      {
        body: { content: 'hello', targetAgentIds: [123] },
        code: 'invalid_target_agent_id',
      },
    ];

    for (const testCase of cases) {
      const result = await enqueueGreenfieldChatRoute({
        auth: auth(),
        talkId,
        ...testCase.body,
      });

      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
    }
  });

  it('resolves omitted chat workspace from the talk id', async () => {
    const me = await getGreenfieldMeRoute({ auth: auth() });
    if (!me.body.ok) throw new Error('Expected session route to succeed');
    const defaultWorkspaceId = me.body.data.currentWorkspaceId;
    const selectedWorkspaceId = await seedWorkspaceWithDefaultAgents(
      'Selected Chat Workspace',
    );
    expect(selectedWorkspaceId).not.toBe(defaultWorkspaceId);
    const { talkId, agentIds } = await createTalkFixture({
      workspaceId: selectedWorkspaceId,
    });

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      talkId,
      content: 'Send without an explicit workspace id.',
      targetAgentIds: agentIds,
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) throw new Error('Expected chat enqueue to succeed');
    expect(result.body.data.talkId).toBe(talkId);

    const cancelled = await cancelGreenfieldChatRoute({
      auth: auth(),
      talkId,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toEqual({
      ok: true,
      data: { talkId, cancelledRuns: 2 },
    });
  });

  it('fans out queued chat notifications to all workspace members', async () => {
    await seedAuthUser(OTHER_USER_ID, 'greenfield-chat-other@clawtalk.local');
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    const notifiedOwners: string[] = [];
    const env = {
      USER_EVENT_HUB: {
        idFromName(ownerId: string) {
          return { ownerId } as never;
        },
        get(id: { ownerId: string }) {
          return {
            fetch: async () => {
              notifiedOwners.push(id.ownerId);
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    };

    await withNotifyQueueScope(env as never, null, async () => {
      const result = await enqueueGreenfieldChatRoute({
        auth: auth(),
        workspaceId,
        talkId,
        content: 'Notify everyone watching this talk.',
        targetAgentIds: agentIds.slice(0, 1),
      });
      expect(result.statusCode).toBe(202);
    });

    expect(new Set(notifiedOwners)).toEqual(new Set([USER_ID, OTHER_USER_ID]));
  });

  it('fans out cancellation notifications to all workspace members', async () => {
    await seedAuthUser(OTHER_USER_ID, 'greenfield-chat-other@clawtalk.local');
    const { workspaceId, talkId } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;
    const first = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Cancel this turn for every watcher.',
    });
    expect(first.statusCode).toBe(202);

    const notifiedOwners: string[] = [];
    const env = {
      USER_EVENT_HUB: {
        idFromName(ownerId: string) {
          return { ownerId } as never;
        },
        get(id: { ownerId: string }) {
          return {
            fetch: async () => {
              notifiedOwners.push(id.ownerId);
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    };

    await withNotifyQueueScope(env as never, null, async () => {
      const cancelled = await cancelGreenfieldChatRoute({
        auth: auth(),
        workspaceId,
        talkId,
      });
      expect(cancelled.statusCode).toBe(200);
    });

    expect(new Set(notifiedOwners)).toEqual(new Set([USER_ID, OTHER_USER_ID]));
  });

  it('honors selected target agents', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();

    const result = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Only one agent should answer.',
      targetAgentIds: [agentIds[1]!],
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) throw new Error('Expected chat enqueue to succeed');
    expect(result.body.data.runs).toHaveLength(1);
    expect(result.body.data.runs[0]).toMatchObject({
      targetAgentId: agentIds[1],
      sequenceIndex: 0,
      providerId: expect.any(String),
    });
  });

  it('blocks a second round until active runs are cancelled', async () => {
    const { workspaceId, talkId } = await createTalkFixture();

    const first = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'First turn',
    });
    expect(first.statusCode).toBe(202);

    const blocked = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Second turn',
    });
    expect(blocked.body).toMatchObject({
      ok: false,
      error: { code: 'talk_round_active' },
    });

    const cancelled = await cancelGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(cancelled.body).toEqual({
      ok: true,
      data: { talkId, cancelledRuns: 2 },
    });

    const retried = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Second turn',
    });
    expect(retried.statusCode).toBe(202);
    if (!retried.body.ok) throw new Error('Expected retry to succeed');
    expect(retried.body.data.message.metadata).toMatchObject({ round: 2 });
  });

  it('does not let a user-scoped accessor cancel another workspace talk', async () => {
    await seedAuthUser(OTHER_USER_ID, 'greenfield-chat-other@clawtalk.local');
    const { workspaceId, talkId } = await createTalkFixture();
    const first = await enqueueGreenfieldChatRoute({
      auth: auth(),
      workspaceId,
      talkId,
      content: 'Keep these runs active',
    });
    expect(first.statusCode).toBe(202);

    const directCancelled = await cancelGreenfieldTalkRuns({
      workspaceId,
      talkId,
      userId: OTHER_USER_ID,
      includeJobRuns: true,
    });
    expect(directCancelled).toEqual({
      cancelledRuns: 0,
      cancelledRunIds: [],
    });

    const cancelled = await withUserContext(OTHER_USER_ID, () =>
      cancelGreenfieldTalkRuns({
        workspaceId,
        talkId,
        userId: OTHER_USER_ID,
        includeJobRuns: true,
      }),
    );

    expect(cancelled).toEqual({ cancelledRuns: 0, cancelledRunIds: [] });
    const db = getDbPg();
    const activeRuns = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    expect(activeRuns[0]?.count).toBe(2);
  });

  it('blocks guest talk creators from cancelling active chat runs', async () => {
    await seedAuthUser(OTHER_USER_ID, 'greenfield-chat-other@clawtalk.local');
    const { workspaceId } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected member creator agents');
    const agentIds = agents.body.data.agents
      .slice(0, 2)
      .map((agent) => agent.id);
    const created = await createGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      body: {
        title: 'Guest creator cancellation talk',
        team: agentIds,
        rounds: 3,
        mode: 'ordered',
      },
    });
    if (!created.body.ok) throw new Error('Expected guest creator talk');
    const talkId = created.body.data.talk.id;
    const queued = await enqueueGreenfieldChatRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      content: 'Keep this active after downgrade.',
    });
    expect(queued.statusCode).toBe(202);

    await db`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;

    const directCancelled = await withUserContext(OTHER_USER_ID, () =>
      cancelGreenfieldTalkRuns({
        workspaceId,
        talkId,
        userId: OTHER_USER_ID,
        includeJobRuns: true,
      }),
    );
    expect(directCancelled).toEqual({
      cancelledRuns: 0,
      cancelledRunIds: [],
    });

    const routeCancelled = await cancelGreenfieldChatRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(routeCancelled.statusCode).toBe(403);
    expect(routeCancelled.body.ok ? null : routeCancelled.body.error.code).toBe(
      'workspace_writer_required',
    );

    const activeRuns = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.runs
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and status in ('queued', 'running', 'awaiting')
    `;
    expect(activeRuns[0]?.count).toBe(2);
  });

  // Regression for Talk Runtime v2 decision 6A: the former T7 bypass ran
  // single-run chats in-process under ctx.waitUntil (30s ceiling, no
  // surviving watchdog). Every accepted run must dispatch via
  // TALK_RUN_QUEUE, single-run included.
  it('dispatches every accepted run through TALK_RUN_QUEUE, single-run included', async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', auth());
      await next();
    });
    mountGreenfieldApiRoutes(app);

    const sent: string[] = [];
    const queue = {
      send: async (message: unknown): Promise<void> => {
        sent.push((message as { runId: string }).runId);
      },
    };
    const dbUrl =
      process.env[DATABASE_URL_ENV]?.trim() ||
      'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
    const postChat = (
      talkId: string,
      workspaceId: string,
      body: Record<string, unknown>,
    ) =>
      withRequestScopedDb(dbUrl, null, { TALK_RUN_QUEUE: queue }, async () =>
        app.request(
          new Request(`https://app.test/api/v1/talks/${talkId}/chat`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-workspace-id': workspaceId,
            },
            body: JSON.stringify(body),
          }),
        ),
      );

    // Single-run: the exact shape the bypass used to capture.
    const singleFixture = await createTalkFixture();
    const single = await postChat(
      singleFixture.talkId,
      singleFixture.workspaceId,
      {
        content: 'Single-run dispatch check',
        targetAgentIds: [singleFixture.agentIds[0]],
      },
    );
    expect(single.status).toBe(202);
    const singleBody = (await single.json()) as {
      ok: boolean;
      data: { runs: Array<{ id: string }> };
    };
    expect(singleBody.ok).toBe(true);
    expect(singleBody.data.runs).toHaveLength(1);
    expect(sent).toEqual(singleBody.data.runs.map((run) => run.id));

    // Multi-run keeps one queue send per accepted run.
    sent.length = 0;
    const multiFixture = await createTalkFixture({
      workspaceId: singleFixture.workspaceId,
    });
    const multi = await postChat(
      multiFixture.talkId,
      multiFixture.workspaceId,
      { content: 'Multi-run dispatch check' },
    );
    expect(multi.status).toBe(202);
    const multiBody = (await multi.json()) as {
      ok: boolean;
      data: { runs: Array<{ id: string }> };
    };
    expect(multiBody.ok).toBe(true);
    expect(multiBody.data.runs.length).toBeGreaterThan(1);
    expect(sent).toEqual(multiBody.data.runs.map((run) => run.id));
  });
});
