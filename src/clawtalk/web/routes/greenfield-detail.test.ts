import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  deleteGreenfieldMessagesRoute,
  getGreenfieldRunContextRoute,
  getGreenfieldSnapshotRoute,
  listGreenfieldMessagesRoute,
  listGreenfieldRunsRoute,
  searchGreenfieldMessagesRoute,
} from './greenfield-detail.js';

const USER_ID = '0c939393-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GUEST_USER_ID = '0c939393-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: 'greenfield-detail-session',
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(
  userId = USER_ID,
  email = 'greenfield-detail@clawtalk.local',
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${userId}::uuid,
      ${email},
      jsonb_build_object('full_name', 'Detail User')
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteUser(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (${USER_ID}::uuid, ${GUEST_USER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${USER_ID}::uuid, ${GUEST_USER_ID}::uuid)
  `;
}

async function addGuestToWorkspace(workspaceId: string): Promise<void> {
  await seedAuthUser(GUEST_USER_ID, 'greenfield-detail-guest@clawtalk.local');
  const db = getDbPg();
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${GUEST_USER_ID}::uuid, 'guest')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
}

async function createAdditionalWorkspace(name: string): Promise<string> {
  const db = getDbPg();
  const [workspace] = await db<{ id: string }[]>`
    insert into public.workspaces (name, owner_id)
    values (${name}, ${USER_ID}::uuid)
    returning id
  `;
  if (!workspace) throw new Error('Expected workspace insert to return a row');
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspace.id}::uuid, ${USER_ID}::uuid, 'owner')
  `;
  await db`
    insert into public.agents (
      workspace_id, role_key, name, handle, initials, accent, accent_dark,
      model_id, default_model_id, temperature, method, is_default, is_custom,
      is_system, enabled, created_from_template_version
    )
    select
      ${workspace.id}::uuid, t.role_key, t.default_name, t.default_handle,
      t.default_initials, t.default_accent, t.default_accent_dark,
      t.default_model_id, t.default_model_id, t.default_temperature,
      t.method_default, true, false, false, true, t.version
    from public.agent_role_templates t
    where t.role_key in ('strategist', 'critic', 'researcher', 'editor', 'quant')
  `;
  return workspace.id;
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
    body: { title: 'Detail Talk', team: agentIds, rounds: 3 },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id, agentIds };
}

async function seedMessages(input: {
  workspaceId: string;
  talkId: string;
  agentId: string;
}): Promise<{ userMessageId: string; agentMessageId: string; runId: string }> {
  const db = getDbPg();
  const [userMessage] = await db<{ id: string }[]>`
    insert into public.messages (
      workspace_id, talk_id, round, author_kind, author_user_id, body
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      1,
      'user',
      ${USER_ID}::uuid,
      'Can you summarize the launch plan?'
    )
    returning id
  `;
  const [agentMessage] = await db<{ id: string; run_id: string }[]>`
    with source_agent as (
      select a.*, lpm.provider_id
      from public.agents a
      join public.llm_provider_models lpm
        on lpm.model_id = a.model_id
      where a.workspace_id = ${input.workspaceId}::uuid
        and a.id = ${input.agentId}::uuid
      order by lpm.provider_id asc
      limit 1
    ),
    snapshot_group as (
      select gen_random_uuid() as id
    ),
    snapshot as (
      insert into public.talk_agent_snapshots (
        workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
        name, handle, initials, accent, accent_dark, provider_id, model_id, temperature,
        persona, focus, method, sort_order, role_template_version
      )
      select
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        snapshot_group.id,
        source_agent.id,
        source_agent.role_key,
        source_agent.name,
        source_agent.handle,
        source_agent.initials,
        source_agent.accent,
        source_agent.accent_dark,
        source_agent.provider_id,
        source_agent.model_id,
        source_agent.temperature,
        source_agent.persona,
        source_agent.focus,
        source_agent.method,
        0,
        source_agent.created_from_template_version
      from source_agent, snapshot_group
      returning id, snapshot_group_id, model_id
    ),
    run as (
      insert into public.runs (
        workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
        model_id, requested_by, response_group_id, sequence_index, status,
        trigger_message_id, started_at, finished_at
      )
      select
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        1,
        snapshot.snapshot_group_id,
        snapshot.id,
        snapshot.model_id,
        ${USER_ID}::uuid,
        'response-1',
        0,
        'completed',
        ${userMessage!.id}::uuid,
        now(),
        now()
      from snapshot
      returning id, agent_snapshot_id
    )
    insert into public.messages (
      workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
    )
    select
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      1,
      'agent',
      run.agent_snapshot_id,
      run.id,
      'Launch plan summary: focus on onboarding.'
    from run
    returning id, run_id
  `;
  return {
    userMessageId: userMessage!.id,
    agentMessageId: agentMessage!.id,
    runId: agentMessage!.run_id,
  };
}

async function firstDocumentBlock(input: {
  workspaceId: string;
  documentId: string;
}): Promise<{ id: string; tab_id: string; version: number }> {
  const db = getDbPg();
  const [block] = await db<{ id: string; tab_id: string; version: number }[]>`
    select id, tab_id, version
    from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
    order by sort_order asc, id asc
    limit 1
  `;
  if (!block) throw new Error('Expected document block fixture');
  return block;
}

async function insertPendingDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  runId?: string | null;
  op: 'insert' | 'replace' | 'delete';
  blockId?: string | null;
  afterBlockId?: string | null;
  baseBlockVersion?: number | null;
  baseListVersion?: number | null;
  newText?: string | null;
  newKind?: string | null;
}): Promise<string> {
  const db = getDbPg();
  const [edit] = await db<{ id: string }[]>`
    insert into public.document_edits (
      workspace_id,
      document_id,
      tab_id,
      proposed_by_run_id,
      op,
      block_id,
      after_block_id,
      base_block_version,
      base_list_version,
      new_kind,
      new_text
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.documentId}::uuid,
      ${input.tabId}::uuid,
      ${input.runId ?? null}::uuid,
      ${input.op},
      ${input.blockId ?? null}::uuid,
      ${input.afterBlockId ?? null}::uuid,
      ${input.baseBlockVersion ?? null},
      ${input.baseListVersion ?? null},
      ${input.newKind ?? null},
      ${input.newText ?? null}
    )
    returning id
  `;
  if (!edit) throw new Error('Expected pending edit fixture');
  return edit.id;
}

describe('greenfield detail routes', () => {
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

  it('serves messages, search, runs, snapshot, and a synthetic default thread', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const messages = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(messages.body).toMatchObject({
      ok: true,
      data: {
        talkId,
        messages: [
          { id: seeded.userMessageId, role: 'user' },
          {
            id: seeded.agentMessageId,
            role: 'assistant',
            runId: seeded.runId,
          },
        ],
      },
    });

    const search = await searchGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      query: 'onboarding',
    });
    expect(search.body).toMatchObject({
      ok: true,
      data: {
        results: [{ messageId: seeded.agentMessageId }],
      },
    });

    const runs = await listGreenfieldRunsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(runs.body).toMatchObject({
      ok: true,
      data: {
        runs: [
          {
            id: seeded.runId,
            status: 'completed',
            targetAgentId: agentIds[0],
            providerId: expect.any(String),
          },
        ],
      },
    });

    const missingRunContext = await getGreenfieldRunContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
      runId: seeded.runId,
    });
    expect(missingRunContext.body).toMatchObject({
      ok: true,
      data: {
        talkId,
        runId: seeded.runId,
        context: null,
      },
    });

    const db = getDbPg();
    const promptSnapshotId = '10000000-0000-4000-8000-00000000c0de';
    const [runSnapshotSource] = await db<
      Array<{ agent_snapshot_id: string; model_id: string }>
    >`
      select agent_snapshot_id, model_id
      from public.runs
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and id = ${seeded.runId}::uuid
    `;
    await db`
      insert into public.run_prompt_snapshots (
        id,
        workspace_id,
        run_id,
        talk_id,
        agent_snapshot_id,
        model_id,
        provider,
        prompt_assembly_version,
        tool_manifest_json,
        prompt_text_redacted
      )
      values (
        ${promptSnapshotId}::uuid,
        ${workspaceId}::uuid,
        ${seeded.runId}::uuid,
        ${talkId}::uuid,
        ${runSnapshotSource!.agent_snapshot_id}::uuid,
        ${runSnapshotSource!.model_id},
        'provider.test',
        1,
        ${db.json({
          effectiveTools: [
            {
              toolFamily: 'web',
              runtimeTools: ['web-fetch', 'web-search'],
              enabled: true,
              requiresApproval: false,
            },
            {
              toolFamily: 'gmail_send',
              runtimeTools: ['gmail-send'],
              enabled: false,
              requiresApproval: true,
            },
          ],
        } as never)},
        'Prompt text captured for this run.'
      )
    `;
    await db`
      update public.runs
      set prompt_snapshot_id = ${promptSnapshotId}::uuid
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
        and id = ${seeded.runId}::uuid
    `;

    const runContext = await getGreenfieldRunContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
      runId: seeded.runId,
    });
    expect(runContext.body).toMatchObject({
      ok: true,
      data: {
        talkId,
        runId: seeded.runId,
        context: {
          version: 1,
          personaRole: 'strategist',
          prompt: {
            hasRedactedPrompt: true,
            estimatedTokens: 9,
          },
          tools: { contextToolNames: ['web-fetch', 'web-search'] },
          history: {
            triggerMessageId: seeded.userMessageId,
            turnCount: 1,
          },
        },
      },
    });

    const snapshot = await getGreenfieldSnapshotRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(snapshot.body).toMatchObject({
      ok: true,
      data: {
        talk: { accessRole: 'owner', workspaceId },
        conversations: [{ id: talkId, talkId, messageCount: 2 }],
        messages: [{ id: seeded.userMessageId }, { id: seeded.agentMessageId }],
        runs: [{ id: seeded.runId }],
        agents: [{ agentId: agentIds[0] }, { agentId: agentIds[1] }],
      },
    });
  });

  it('returns eventHighWater as the per-talk outbox high-water, not a timestamp', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    await seedMessages({ workspaceId, talkId, agentId: agentIds[0]! });

    // Two outbox events for this talk plus one for a different talk with a
    // strictly higher id. eventHighWater must be THIS talk's high-water
    // (proves per-topic scoping) on the small outbox-id scale (proves the
    // regression away from Date.parse(updated_at) ~= 1.7e12, which made the
    // client drop every streamed reply).
    const db = getDbPg();
    const talkEvents = await db<{ event_id: number }[]>`
      insert into public.event_outbox (topic, event_type, payload)
      values
        (${`talk:${talkId}`}, 'message_appended', ${db.json({} as never)}),
        (${`talk:${talkId}`}, 'message_appended', ${db.json({} as never)})
      returning event_id::int as event_id
    `;
    const talkHighWater = talkEvents[1]!.event_id;
    const [otherTalkEvent] = await db<{ event_id: number }[]>`
      insert into public.event_outbox (topic, event_type, payload)
      values (${'talk:00000000-0000-0000-0000-000000000000'},
              'message_appended', ${db.json({} as never)})
      returning event_id::int as event_id
    `;
    expect(otherTalkEvent!.event_id).toBeGreaterThan(talkHighWater);

    const snapshot = await getGreenfieldSnapshotRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    if (!snapshot.body.ok) throw new Error('Expected snapshot to succeed');
    // High-water for this talk's topic (excludes the higher-id other-talk
    // event) and far below any epoch-millis timestamp.
    expect(snapshot.body.data.eventHighWater).toBe(talkHighWater);
    expect(snapshot.body.data.eventHighWater).toBeLessThan(
      otherTalkEvent!.event_id,
    );
    expect(snapshot.body.data.eventHighWater).toBeLessThan(1_000_000_000);
  });

  it('resolves omitted workspaceId for talk detail routes from the visible talk', async () => {
    const me = await getGreenfieldMeRoute({ auth: auth() });
    if (!me.body.ok) throw new Error('Expected session route to succeed');
    const defaultWorkspaceId = me.body.data.currentWorkspaceId;
    const workspaceId = await createAdditionalWorkspace(
      'Detail Second Workspace',
    );
    expect(workspaceId).not.toBe(defaultWorkspaceId);

    const { talkId, agentIds } = await createTalkFixture({ workspaceId });
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const snapshot = await getGreenfieldSnapshotRoute({
      auth: auth(),
      talkId,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.body).toMatchObject({
      ok: true,
      data: {
        talk: { workspaceId },
        messages: [{ id: seeded.userMessageId }, { id: seeded.agentMessageId }],
        runs: [{ id: seeded.runId }],
      },
    });

    const runs = await listGreenfieldRunsRoute({
      auth: auth(),
      talkId,
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.body).toMatchObject({
      ok: true,
      data: {
        runs: [
          {
            id: seeded.runId,
            providerId: expect.any(String),
          },
        ],
      },
    });
  });

  it('deletes selected messages from the Talk timeline', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const deleted = await deleteGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      messageIds: [seeded.userMessageId],
    });
    expect(deleted.body).toEqual({
      ok: true,
      data: {
        talkId,
        deletedCount: 1,
        deletedMessageIds: [seeded.userMessageId],
      },
    });

    const messages = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(messages.body).toMatchObject({
      ok: true,
      data: { messages: [{ id: seeded.agentMessageId }] },
    });
    const db = getDbPg();
    const runRows = await db<Array<{ trigger_message_id: string | null }>>`
      select trigger_message_id
      from public.runs
      where id = ${seeded.runId}::uuid
    `;
    expect(runRows[0]?.trigger_message_id).toBeNull();
  });

  it('rejects malformed message delete ids before mutating messages', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const malformedInputs: unknown[] = [
      undefined,
      null,
      'not-an-array',
      [],
      [seeded.userMessageId, 42],
      ['not-a-uuid'],
    ];
    for (const messageIds of malformedInputs) {
      const result = await deleteGreenfieldMessagesRoute({
        auth: auth(),
        workspaceId,
        talkId,
        messageIds,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_message_id' },
      });
    }

    const db = getDbPg();
    const [messageRow] = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.messages
      where id = ${seeded.userMessageId}::uuid
    `;
    expect(messageRow).toEqual({ count: 1 });
  });
});
