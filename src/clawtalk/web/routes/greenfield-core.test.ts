import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  archiveGreenfieldTalkRoute,
  createGreenfieldFolderRoute,
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  getGreenfieldTalkRoute,
  listGreenfieldAgentsRoute,
  listGreenfieldFoldersRoute,
  listGreenfieldTalkAgentsRoute,
  listGreenfieldTalkSidebarRoute,
  listGreenfieldTalksRoute,
  patchGreenfieldTalkRoute,
} from './greenfield-core.js';

const USER_ID = '0c929292-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c929292-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: `session-${userId}`,
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(
  id: string,
  email: string,
  fullName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${fullName}::text)
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteUsers(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${USER_ID}::uuid, ${OTHER_USER_ID}::uuid)
  `;
}

async function currentWorkspaceId(): Promise<string> {
  const me = await getGreenfieldMeRoute({ auth: auth() });
  expect(me.statusCode).toBe(200);
  if (!me.body.ok) throw new Error('Expected session route to succeed');
  return me.body.data.currentWorkspaceId;
}

describe('greenfield core routes', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await deleteUsers();
    await seedAuthUser(USER_ID, 'greenfield@clawtalk.local', 'Green User');
  });

  afterAll(async () => {
    await deleteUsers();
    await closePgDatabase();
  });

  it('bootstraps session, workspace, agents, and default teams', async () => {
    const me = await getGreenfieldMeRoute({ auth: auth() });

    expect(me.statusCode).toBe(200);
    expect(me.body).toMatchObject({
      ok: true,
      data: {
        user: {
          id: USER_ID,
          email: 'greenfield@clawtalk.local',
          name: 'Green User',
          displayName: 'Green User',
          role: 'owner',
        },
        workspaces: [{ name: "Green User's workspace", role: 'owner' }],
      },
    });
    if (!me.body.ok) throw new Error('Expected session route to succeed');

    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId: me.body.data.currentWorkspaceId,
    });
    expect(agents.statusCode).toBe(200);
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    expect(agents.body.data.agents.map((agent) => agent.roleKey)).toEqual([
      'strategist',
      'critic',
      'researcher',
      'quant',
      'editor',
    ]);
    expect(agents.body.data.teams.map((team) => team.name).sort()).toEqual([
      'Hiring crew',
      'Pricing crew',
      'Research crew',
    ]);
  });

  it('creates and lists folders, talks, sidebar nodes, and talk agents', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const requestedAgentIds = agents.body.data.agents
      .slice(0, 3)
      .map((agent) => agent.id);

    const folder = await createGreenfieldFolderRoute({
      auth: auth(),
      workspaceId,
      title: 'Launch',
    });
    expect(folder.statusCode).toBe(201);
    if (!folder.body.ok) throw new Error('Expected folder route to succeed');

    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Q2 Plan',
        folderId: folder.body.data.folder.id,
        mode: 'parallel',
        rounds: 5,
        team: requestedAgentIds,
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');
    expect(created.body.data.talk).toMatchObject({
      title: 'Q2 Plan',
      folderId: folder.body.data.folder.id,
      orchestrationMode: 'panel',
      rounds: 5,
      status: 'active',
      agents: requestedAgentIds,
    });

    const folders = await listGreenfieldFoldersRoute({
      auth: auth(),
      workspaceId,
    });
    expect(folders.body).toMatchObject({
      ok: true,
      data: { folders: [{ id: folder.body.data.folder.id, title: 'Launch' }] },
    });

    const talksInFolder = await listGreenfieldTalksRoute({
      auth: auth(),
      workspaceId,
      folderId: folder.body.data.folder.id,
    });
    expect(talksInFolder.body).toMatchObject({
      ok: true,
      data: { talks: [{ id: created.body.data.talk.id, title: 'Q2 Plan' }] },
    });

    const fetched = await getGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(fetched.body).toMatchObject({
      ok: true,
      data: { talk: { id: created.body.data.talk.id, title: 'Q2 Plan' } },
    });

    const roster = await listGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(roster.statusCode).toBe(200);
    if (!roster.body.ok) throw new Error('Expected roster route to succeed');
    expect(roster.body.data.agents).toHaveLength(3);
    expect(roster.body.data.agents[0]).toMatchObject({
      sourceKind: 'provider',
      health: 'ready',
    });

    const sidebar = await listGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
    });
    expect(sidebar.body).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            type: 'folder',
            id: folder.body.data.folder.id,
            talks: [{ id: created.body.data.talk.id, title: 'Q2 Plan' }],
          },
        ],
      },
    });

    const moved = await patchGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: {
        title: 'Q2 Plan v2',
        folderId: null,
        orchestrationMode: 'ordered',
      },
    });
    expect(moved.body).toMatchObject({
      ok: true,
      data: {
        talk: {
          title: 'Q2 Plan v2',
          folderId: null,
          orchestrationMode: 'ordered',
        },
      },
    });

    const archived = await archiveGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(archived.body).toEqual({ ok: true, data: { deleted: true } });

    const active = await listGreenfieldTalksRoute({
      auth: auth(),
      workspaceId,
    });
    expect(active.body).toMatchObject({ ok: true, data: { talks: [] } });
    const all = await listGreenfieldTalksRoute({
      auth: auth(),
      workspaceId,
      includeArchived: true,
    });
    expect(all.body).toMatchObject({
      ok: true,
      data: { talks: [{ id: created.body.data.talk.id, status: 'archived' }] },
    });
  });

  it('rejects a workspace id that belongs to another user', async () => {
    await seedAuthUser(
      OTHER_USER_ID,
      'other-greenfield@clawtalk.local',
      'Other User',
    );
    const otherMe = await getGreenfieldMeRoute({ auth: auth(OTHER_USER_ID) });
    if (!otherMe.body.ok) throw new Error('Expected other session to succeed');

    const result = await listGreenfieldTalksRoute({
      auth: auth(),
      workspaceId: otherMe.body.data.currentWorkspaceId,
    });

    expect(result.statusCode).toBe(403);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });
  });

  it('rejects malformed ids before database casts', async () => {
    const workspaceId = await currentWorkspaceId();

    const result = await getGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: 'not-a-uuid',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_id' },
    });
  });
});
