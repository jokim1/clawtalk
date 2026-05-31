import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  createGreenfieldTalkContentRoute,
  createGreenfieldThreadRoute,
  deleteGreenfieldMessagesRoute,
  getGreenfieldSnapshotRoute,
  getGreenfieldThreadContentRoute,
  listGreenfieldMessagesRoute,
  listGreenfieldRunsRoute,
  listGreenfieldThreadsRoute,
  patchGreenfieldContentRoute,
  searchGreenfieldMessagesRoute,
} from './greenfield-detail.js';

const USER_ID = '0c939393-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function auth(): AuthContext {
  return {
    sessionId: 'greenfield-detail-session',
    userId: USER_ID,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'greenfield-detail@clawtalk.local',
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
    delete from public.workspaces where owner_id = ${USER_ID}::uuid
  `;
  await db`
    delete from auth.users where id = ${USER_ID}::uuid
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
      select *
      from public.agents
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.agentId}::uuid
      limit 1
    ),
    snapshot_group as (
      select gen_random_uuid() as id
    ),
    snapshot as (
      insert into public.talk_agent_snapshots (
        workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
        name, handle, initials, accent, accent_dark, model_id, temperature,
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
        started_at, finished_at
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
      threadId: talkId,
    });
    expect(messages.body).toMatchObject({
      ok: true,
      data: {
        talkId,
        messages: [
          { id: seeded.userMessageId, role: 'user', threadId: talkId },
          {
            id: seeded.agentMessageId,
            role: 'assistant',
            runId: seeded.runId,
            threadId: talkId,
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
        results: [{ messageId: seeded.agentMessageId, threadId: talkId }],
      },
    });

    const threads = await listGreenfieldThreadsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(threads.body).toMatchObject({
      ok: true,
      data: { threads: [{ id: talkId, talk_id: talkId, is_default: 1 }] },
    });

    const createdThread = await createGreenfieldThreadRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(createdThread.statusCode).toBe(201);
    expect(createdThread.body).toMatchObject({
      ok: true,
      data: { thread: { id: talkId, talk_id: talkId } },
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
            threadId: talkId,
            targetAgentId: agentIds[0],
          },
        ],
      },
    });

    const snapshot = await getGreenfieldSnapshotRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: talkId,
    });
    expect(snapshot.body).toMatchObject({
      ok: true,
      data: {
        activeThreadId: talkId,
        threads: [{ id: talkId, talkId, messageCount: 2 }],
        messages: [{ id: seeded.userMessageId }, { id: seeded.agentMessageId }],
        runs: [{ id: seeded.runId }],
        agents: [{ agentId: agentIds[0] }, { agentId: agentIds[1] }],
      },
    });
  });

  it('creates, patches, and reads primary document content through talk and thread endpoints', async () => {
    const { workspaceId, talkId } = await createTalkFixture();

    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    expect(created.body.data.content).toMatchObject({
      talkId,
      threadId: talkId,
      title: 'Launch Draft',
      bodyVersion: 1,
    });

    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
      title: 'Launch Draft v2',
    });
    expect(patched.body).toMatchObject({
      ok: true,
      data: {
        content: {
          title: 'Launch Draft v2',
          bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
          bodyVersion: 2,
        },
      },
    });

    const byThread = await getGreenfieldThreadContentRoute({
      auth: auth(),
      workspaceId,
      threadId: talkId,
    });
    expect(byThread.body).toMatchObject({
      ok: true,
      data: {
        content: {
          id: created.body.data.content.id,
          bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
        },
        pendingEdits: [],
      },
    });

    const stale = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: 1,
      bodyMarkdown: 'stale',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      ok: false,
      error: { code: 'version_conflict' },
    });
  });

  it('deletes selected messages and rejects non-default thread ids', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const wrongThread = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: '00000000-0000-4000-8000-000000000001',
    });
    expect(wrongThread.statusCode).toBe(404);
    expect(wrongThread.body).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' },
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
  });
});
