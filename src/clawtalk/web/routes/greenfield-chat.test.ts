import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import type { AuthContext } from '../types.js';
import { cancelGreenfieldTalkRuns } from '../../talks/greenfield-chat-accessors.js';
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
      title: 'Chat Talk',
      team: agentIds,
      rounds: 3,
      mode: 'ordered',
    },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id, agentIds };
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
      threadId: talkId,
    });

    expect(result.statusCode).toBe(202);
    if (!result.body.ok) throw new Error('Expected chat enqueue to succeed');
    expect(result.body.data.message).toMatchObject({
      role: 'user',
      threadId: talkId,
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
      data: { talkId, threadId: null, cancelledRuns: 2 },
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
});
