import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  archiveGreenfieldTalkRoute,
  unarchiveGreenfieldTalkRoute,
  createGreenfieldFolderRoute,
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  getGreenfieldTalkRoute,
  getGreenfieldTalkToolsRoute,
  inviteWorkspaceMemberRoute,
  listGreenfieldAgentsRoute,
  listGreenfieldFoldersRoute,
  listGreenfieldTalkAgentsRoute,
  listGreenfieldTalkSidebarRoute,
  listGreenfieldTalksRoute,
  listWorkspaceMembersRoute,
  deleteGreenfieldFolderRoute,
  patchGreenfieldFolderRoute,
  patchGreenfieldTalkRoute,
  reorderGreenfieldTalkSidebarRoute,
  removeWorkspaceMemberRoute,
  transferWorkspaceOwnershipRoute,
  updateGreenfieldTalkAgentsRoute,
  updateGreenfieldTalkToolRoute,
  updateWorkspaceMemberRoleRoute,
} from './greenfield-core.js';

const USER_ID = '0c929292-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c929292-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPECTED_TALK_TOOL_FAMILIES = [
  'web',
  'connectors',
  'google_read',
  'google_write',
  'gmail_read',
  'gmail_send',
  'messaging',
];
const EXPECTED_TALK_TOOL_IDS_BY_FAMILY: Record<string, string[]> = {
  web: ['web-search', 'web-fetch', 'news-monitor'],
  connectors: ['linear', 'github-read', 'notion-read'],
  google_read: ['gdrive-read'],
  google_write: ['gdrive-write'],
  gmail_read: ['gmail-read'],
  gmail_send: ['gmail-send'],
  messaging: ['messaging'],
};

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

    const db = getDbPg();
    await db`
      insert into public.messages (
        workspace_id, talk_id, round, author_kind, author_user_id, body
      )
      values
        (
          ${workspaceId}::uuid,
          ${created.body.data.talk.id}::uuid,
          1,
          'user',
          ${USER_ID}::uuid,
          'First message'
        ),
        (
          ${workspaceId}::uuid,
          ${created.body.data.talk.id}::uuid,
          2,
          'user',
          ${USER_ID}::uuid,
          'Second message'
        )
    `;
    const fetchedWithMessages = await getGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(fetchedWithMessages.statusCode).toBe(200);
    if (!fetchedWithMessages.body.ok) {
      throw new Error('Expected talk route to succeed after messages');
    }
    expect(fetchedWithMessages.body.data.talk.agents).toEqual(
      requestedAgentIds,
    );
    expect(fetchedWithMessages.body.data.talk.messageCount).toBe(2);

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

    const restored = await unarchiveGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(restored.body).toEqual({ ok: true, data: { restored: true } });

    const activeAgain = await listGreenfieldTalksRoute({
      auth: auth(),
      workspaceId,
    });
    expect(activeAgain.body).toMatchObject({
      ok: true,
      data: { talks: [{ id: created.body.data.talk.id, status: 'active' }] },
    });
  });

  it('seeds the Buddy system talk: pinned id, hidden from lists, immutable', async () => {
    const workspaceId = await currentWorkspaceId();

    const sidebar = await listGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
    });
    expect(sidebar.statusCode).toBe(200);
    if (!sidebar.body.ok) throw new Error('Expected sidebar route to succeed');
    const buddyTalkId = sidebar.body.data.buddyTalkId;
    if (!buddyTalkId) throw new Error('Expected a seeded Buddy talk id');
    expect(
      sidebar.body.data.items.some((item) => item.id === buddyTalkId),
    ).toBe(false);

    const talks = await listGreenfieldTalksRoute({ auth: auth(), workspaceId });
    if (!talks.body.ok) throw new Error('Expected talks route to succeed');
    expect(talks.body.data.talks.some((talk) => talk.id === buddyTalkId)).toBe(
      false,
    );

    const detail = await getGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: buddyTalkId,
    });
    expect(detail.body).toMatchObject({
      ok: true,
      data: { talk: { id: buddyTalkId, title: 'Buddy' } },
    });

    const roster = await listGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: buddyTalkId,
    });
    expect(roster.statusCode).toBe(200);
    if (!roster.body.ok) throw new Error('Expected roster route to succeed');
    expect(roster.body.data.agents).toHaveLength(1);
    expect(roster.body.data.agents[0]).toMatchObject({ nickname: 'Buddy' });

    const archived = await archiveGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: buddyTalkId,
    });
    expect(archived.statusCode).toBe(404);

    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const replaced = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: buddyTalkId,
      agents: [agents.body.data.agents[0]!.id],
    });
    expect(replaced.statusCode).toBe(404);

    const renamed = await patchGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: buddyTalkId,
      body: { title: 'Not Buddy' },
    });
    expect(renamed.statusCode).toBe(404);
  });

  it('returns 404 unarchiving an unknown talk and 400 on a bad id', async () => {
    const workspaceId = await currentWorkspaceId();
    const missing = await unarchiveGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      // Valid RFC-4122 v4 UUID (version 4 / variant 8) that does not exist —
      // greenfield's isUuid requires the version+variant nibbles.
      talkId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const bad = await unarchiveGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: 'not-a-uuid',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_id' },
    });
  });

  it('reports talk access roles from the resolved workspace membership', async () => {
    const workspaceId = await currentWorkspaceId();
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Shared Access Talk' },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');
    expect(created.body.data.talk.accessRole).toBe('owner');
    const talkId = created.body.data.talk.id;

    await seedAuthUser(
      OTHER_USER_ID,
      'shared-access@clawtalk.local',
      'Shared Access',
    );
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    const memberList = await listGreenfieldTalksRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
    });
    expect(memberList.statusCode).toBe(200);
    if (!memberList.body.ok) {
      throw new Error('Expected member list route to succeed');
    }
    expect(
      memberList.body.data.talks.find((talk) => talk.id === talkId)?.accessRole,
    ).toBe('editor');

    const memberGet = await getGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(memberGet.statusCode).toBe(200);
    if (!memberGet.body.ok) throw new Error('Expected member get to succeed');
    expect(memberGet.body.data.talk.accessRole).toBe('editor');

    await db`
      update public.workspace_members
      set role = 'admin'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;
    const adminGet = await getGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(adminGet.statusCode).toBe(200);
    if (!adminGet.body.ok) throw new Error('Expected admin get to succeed');
    expect(adminGet.body.data.talk.accessRole).toBe('admin');

    await db`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;
    const guestList = await listGreenfieldTalksRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
    });
    expect(guestList.statusCode).toBe(200);
    if (!guestList.body.ok) {
      throw new Error('Expected guest list route to succeed');
    }
    expect(
      guestList.body.data.talks.find((talk) => talk.id === talkId)?.accessRole,
    ).toBe('viewer');

    const guestGet = await getGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(guestGet.statusCode).toBe(200);
    if (!guestGet.body.ok) throw new Error('Expected guest get to succeed');
    expect(guestGet.body.data.talk.accessRole).toBe('viewer');
  });

  it('manages existing signed-in workspace members and transfers ownership', async () => {
    const workspaceId = await currentWorkspaceId();
    await seedAuthUser(
      OTHER_USER_ID,
      'member-admin@clawtalk.local',
      'Member Admin',
    );

    const invited = await inviteWorkspaceMemberRoute({
      auth: auth(),
      workspaceId,
      body: {
        email: 'member-admin@clawtalk.local',
        role: 'member',
      },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.body).toMatchObject({
      ok: true,
      data: {
        member: {
          userId: OTHER_USER_ID,
          email: 'member-admin@clawtalk.local',
          name: 'Member Admin',
          role: 'member',
        },
      },
    });

    const updated = await updateWorkspaceMemberRoleRoute({
      auth: auth(),
      workspaceId,
      userId: OTHER_USER_ID,
      body: { role: 'admin' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toMatchObject({
      ok: true,
      data: { member: { userId: OTHER_USER_ID, role: 'admin' } },
    });

    const removed = await removeWorkspaceMemberRoute({
      auth: auth(),
      workspaceId,
      userId: OTHER_USER_ID,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.body).toMatchObject({
      ok: true,
      data: { removed: true },
    });

    const readded = await inviteWorkspaceMemberRoute({
      auth: auth(),
      workspaceId,
      body: {
        email: 'member-admin@clawtalk.local',
        role: 'admin',
      },
    });
    expect(readded.statusCode).toBe(201);

    const transferred = await transferWorkspaceOwnershipRoute({
      auth: auth(),
      workspaceId,
      body: { newOwnerUserId: OTHER_USER_ID },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.body).toMatchObject({
      ok: true,
      data: {
        workspaceId,
        newOwnerUserId: OTHER_USER_ID,
        members: expect.arrayContaining([
          expect.objectContaining({ userId: USER_ID, role: 'admin' }),
          expect.objectContaining({ userId: OTHER_USER_ID, role: 'owner' }),
        ]),
      },
    });

    const ownerSession = await getGreenfieldMeRoute({
      auth: auth(OTHER_USER_ID),
      requestedWorkspaceId: workspaceId,
    });
    expect(ownerSession.statusCode).toBe(200);
    expect(ownerSession.body).toMatchObject({
      ok: true,
      data: { user: { role: 'owner' } },
    });

    const previousOwnerSession = await getGreenfieldMeRoute({
      auth: auth(),
      requestedWorkspaceId: workspaceId,
    });
    expect(previousOwnerSession.statusCode).toBe(200);
    expect(previousOwnerSession.body).toMatchObject({
      ok: true,
      data: { user: { role: 'admin' } },
    });
  });

  it('enforces workspace member management role gates', async () => {
    const workspaceId = await currentWorkspaceId();
    await seedAuthUser(
      OTHER_USER_ID,
      'member-gate@clawtalk.local',
      'Member Gate',
    );
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'member')
    `;

    const listed = await listWorkspaceMembersRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
    });
    expect(listed.statusCode).toBe(200);
    if (!listed.body.ok) throw new Error('Expected member list to succeed');
    expect(
      listed.body.data.members.map((member) => member.userId).sort(),
    ).toEqual([OTHER_USER_ID, USER_ID].sort());

    const deniedInvite = await inviteWorkspaceMemberRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      body: { email: 'owner@example.com', role: 'member' },
    });
    expect(deniedInvite.statusCode).toBe(403);
    expect(deniedInvite.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_admin_required' },
    });

    const ownerRoleUpdate = await updateWorkspaceMemberRoleRoute({
      auth: auth(),
      workspaceId,
      userId: USER_ID,
      body: { role: 'admin' },
    });
    expect(ownerRoleUpdate.statusCode).toBe(409);
    expect(ownerRoleUpdate.body).toMatchObject({
      ok: false,
      error: { code: 'owner_transfer_required' },
    });

    const selfRemove = await removeWorkspaceMemberRoute({
      auth: auth(),
      workspaceId,
      userId: USER_ID,
    });
    expect(selfRemove.statusCode).toBe(400);
    expect(selfRemove.body).toMatchObject({
      ok: false,
      error: { code: 'self_remove_not_supported' },
    });

    const unknownInvite = await inviteWorkspaceMemberRoute({
      auth: auth(),
      workspaceId,
      body: { email: 'not-yet@clawtalk.local', role: 'member' },
    });
    expect(unknownInvite.statusCode).toBe(404);
    expect(unknownInvite.body).toMatchObject({
      ok: false,
      error: { code: 'user_not_found' },
    });
  });

  it('resolves omitted workspaceId for talk-scoped core routes from the visible talk', async () => {
    const defaultWorkspaceId = await currentWorkspaceId();
    const workspaceId = await createAdditionalWorkspace('Second Workspace');
    expect(workspaceId).not.toBe(defaultWorkspaceId);

    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    expect(agents.statusCode).toBe(200);
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const agentIds = agents.body.data.agents
      .slice(0, 2)
      .map((agent) => agent.id);

    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Second Workspace Talk', team: agentIds },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');
    const talkId = created.body.data.talk.id;

    const fetched = await getGreenfieldTalkRoute({ auth: auth(), talkId });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toMatchObject({
      ok: true,
      data: { talk: { id: talkId, title: 'Second Workspace Talk' } },
    });

    const roster = await listGreenfieldTalkAgentsRoute({
      auth: auth(),
      talkId,
    });
    expect(roster.statusCode).toBe(200);
    if (!roster.body.ok) throw new Error('Expected roster route to succeed');
    expect(roster.body.data.agents.map((agent) => agent.id)).toEqual(agentIds);

    const updatedTools = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      talkId,
      body: { family: 'web', enabled: true },
    });
    expect(updatedTools.statusCode).toBe(200);
    expect(updatedTools.body).toMatchObject({
      ok: true,
      data: { talkId, active: { web: true } },
    });

    const updatedRoster = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      talkId,
      agents: [agentIds[0]],
    });
    expect(updatedRoster.statusCode).toBe(200);
    expect(updatedRoster.body).toMatchObject({
      ok: true,
      data: { talkId, agents: [{ id: agentIds[0] }] },
    });
  });

  it('reorders greenfield sidebar folders and talks without legacy schema', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const team = agents.body.data.agents.slice(0, 1).map((agent) => agent.id);

    const folderA = await createGreenfieldFolderRoute({
      auth: auth(),
      workspaceId,
      title: 'Folder A',
    });
    const folderB = await createGreenfieldFolderRoute({
      auth: auth(),
      workspaceId,
      title: 'Folder B',
    });
    if (!folderA.body.ok || !folderB.body.ok) {
      throw new Error('Expected folder routes to succeed');
    }
    const rootTalk = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Root Talk', team },
    });
    const nestedTalk = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Nested Talk',
        folderId: folderA.body.data.folder.id,
        team,
      },
    });
    if (!rootTalk.body.ok || !nestedTalk.body.ok) {
      throw new Error('Expected talk routes to succeed');
    }

    const intoFolder = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
      itemType: 'talk',
      itemId: rootTalk.body.data.talk.id,
      destinationFolderId: folderB.body.data.folder.id,
      destinationIndex: 0,
    });
    expect(intoFolder.body).toEqual({ ok: true, data: { reordered: true } });

    const folderToTop = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
      itemType: 'folder',
      itemId: folderB.body.data.folder.id,
      destinationFolderId: null,
      destinationIndex: 0,
    });
    expect(folderToTop.body).toEqual({ ok: true, data: { reordered: true } });

    const sidebar = await listGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
    });
    expect(sidebar.statusCode).toBe(200);
    if (!sidebar.body.ok) throw new Error('Expected sidebar route to succeed');
    expect(sidebar.body.data.items[0]).toMatchObject({
      type: 'folder',
      id: folderB.body.data.folder.id,
      talks: [{ id: rootTalk.body.data.talk.id, title: 'Root Talk' }],
    });
    expect(sidebar.body.data.items[1]).toMatchObject({
      type: 'folder',
      id: folderA.body.data.folder.id,
      talks: [{ id: nestedTalk.body.data.talk.id, title: 'Nested Talk' }],
    });

    // Root-level drops use indices computed against the visible list — the
    // hidden Buddy system talk (seeded at root sort_order 0) must neither
    // shift them nor get renumbered by the reorder.
    const rootTwo = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Root Two', team },
    });
    if (!rootTwo.body.ok) throw new Error('Expected talk route to succeed');
    const midList = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
      itemType: 'talk',
      itemId: rootTwo.body.data.talk.id,
      destinationFolderId: null,
      destinationIndex: 1,
    });
    expect(midList.body).toEqual({ ok: true, data: { reordered: true } });
    const reorderedSidebar = await listGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
    });
    if (!reorderedSidebar.body.ok) {
      throw new Error('Expected sidebar route to succeed');
    }
    expect(reorderedSidebar.body.data.items[1]?.id).toBe(
      rootTwo.body.data.talk.id,
    );
    const db = getDbPg();
    const buddyRows = await db<
      { folder_id: string | null; sort_order: number }[]
    >`
      select folder_id, sort_order
      from public.talks
      where workspace_id = ${workspaceId}::uuid
        and is_system = true
    `;
    expect(buddyRows).toEqual([{ folder_id: null, sort_order: 0 }]);

    const invalidFolderNest = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
      itemType: 'folder',
      itemId: folderA.body.data.folder.id,
      destinationFolderId: folderB.body.data.folder.id,
      destinationIndex: 0,
    });
    expect(invalidFolderNest.statusCode).toBe(400);
    expect(invalidFolderNest.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_sidebar_reorder' },
    });

    const outOfRangeIndex = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId,
      itemType: 'folder',
      itemId: folderA.body.data.folder.id,
      destinationFolderId: null,
      destinationIndex: 99,
    });
    expect(outOfRangeIndex.statusCode).toBe(400);
    expect(outOfRangeIndex.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_sidebar_reorder' },
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])(
    'rejects %s sidebar reorder destinationIndex values',
    async (_caseName, destinationIndex) => {
      const result = await reorderGreenfieldTalkSidebarRoute({
        auth: auth(),
        workspaceId: '10000000-0000-4000-8000-000000000001',
        itemType: 'talk',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex,
      });

      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_sidebar_reorder' },
      });
    },
  );

  it('resolves omitted workspaceId for secondary-workspace folder mutations', async () => {
    const secondaryWorkspaceId = await createAdditionalWorkspace('Secondary');
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId: secondaryWorkspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const team = agents.body.data.agents.slice(0, 1).map((agent) => agent.id);

    const folderA = await createGreenfieldFolderRoute({
      auth: auth(),
      workspaceId: secondaryWorkspaceId,
      title: 'Secondary A',
    });
    const folderB = await createGreenfieldFolderRoute({
      auth: auth(),
      workspaceId: secondaryWorkspaceId,
      title: 'Secondary B',
    });
    if (!folderA.body.ok || !folderB.body.ok) {
      throw new Error('Expected secondary folder routes to succeed');
    }
    await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId: secondaryWorkspaceId,
      body: {
        title: 'Secondary Talk',
        folderId: folderA.body.data.folder.id,
        team,
      },
    });

    const renamed = await patchGreenfieldFolderRoute({
      auth: auth(),
      folderId: folderB.body.data.folder.id,
      title: 'Secondary B Renamed',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body).toMatchObject({
      ok: true,
      data: {
        folder: {
          id: folderB.body.data.folder.id,
          workspaceId: secondaryWorkspaceId,
          title: 'Secondary B Renamed',
        },
      },
    });

    const reordered = await reorderGreenfieldTalkSidebarRoute({
      auth: auth(),
      itemType: 'folder',
      itemId: folderB.body.data.folder.id,
      destinationFolderId: null,
      destinationIndex: 0,
    });
    expect(reordered.statusCode).toBe(200);

    const sidebar = await listGreenfieldTalkSidebarRoute({
      auth: auth(),
      workspaceId: secondaryWorkspaceId,
    });
    expect(sidebar.statusCode).toBe(200);
    if (!sidebar.body.ok) throw new Error('Expected sidebar route to succeed');
    expect(sidebar.body.data.items[0]).toMatchObject({
      type: 'folder',
      id: folderB.body.data.folder.id,
      title: 'Secondary B Renamed',
    });

    const deleted = await deleteGreenfieldFolderRoute({
      auth: auth(),
      folderId: folderB.body.data.folder.id,
    });
    expect(deleted.body).toEqual({ ok: true, data: { deleted: true } });
  });

  it('replaces a talk roster using greenfield agents and display order', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const initialAgentIds = agents.body.data.agents
      .slice(0, 3)
      .map((agent) => agent.id);
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Roster Talk', team: initialAgentIds },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const expectedAgentIds = [
      agents.body.data.agents[4]!.id,
      agents.body.data.agents[3]!.id,
    ];
    const updated = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [
        { id: expectedAgentIds[1], displayOrder: 1 },
        { id: expectedAgentIds[0], displayOrder: 0 },
      ],
    });

    expect(updated.statusCode).toBe(200);
    if (!updated.body.ok) throw new Error('Expected roster update to succeed');
    expect(updated.body.data.agents.map((agent) => agent.id)).toEqual(
      expectedAgentIds,
    );
    expect(updated.body.data.agents.map((agent) => agent.displayOrder)).toEqual(
      [0, 1],
    );

    const listed = await listGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(listed.statusCode).toBe(200);
    if (!listed.body.ok) throw new Error('Expected roster route to succeed');
    expect(listed.body.data.agents.map((agent) => agent.id)).toEqual(
      expectedAgentIds,
    );

    const fetched = await getGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(fetched.body).toMatchObject({
      ok: true,
      data: { talk: { agents: expectedAgentIds } },
    });
  });

  it('rejects invalid or unavailable greenfield talk roster updates', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const initialAgentIds = agents.body.data.agents
      .slice(0, 2)
      .map((agent) => agent.id);
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Roster Validation Talk', team: initialAgentIds },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const duplicate = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [initialAgentIds[0], initialAgentIds[0]],
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_agents' },
    });

    const empty = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [],
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_agents' },
    });

    const tooMany = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000005',
        '10000000-0000-4000-8000-000000000006',
      ],
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_agents' },
    });

    const missingTalk = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: '10000000-0000-4000-8000-000000000099',
      agents: [initialAgentIds[0]],
    });
    expect(missingTalk.statusCode).toBe(404);
    expect(missingTalk.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const db = getDbPg();
    const systemAgents = await db<Array<{ id: string }>>`
      select id
      from public.agents
      where workspace_id = ${workspaceId}::uuid
        and is_system = true
      order by id asc
      limit 1
    `;
    expect(systemAgents).toHaveLength(1);
    const systemAgent = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [systemAgents[0]!.id],
    });
    expect(systemAgent.statusCode).toBe(400);
    expect(systemAgent.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_agents' },
    });

    await seedAuthUser(
      OTHER_USER_ID,
      'other-greenfield@clawtalk.local',
      'Other User',
    );
    const otherMe = await getGreenfieldMeRoute({ auth: auth(OTHER_USER_ID) });
    if (!otherMe.body.ok) throw new Error('Expected other session to succeed');
    const otherAgents = await listGreenfieldAgentsRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId: otherMe.body.data.currentWorkspaceId,
    });
    if (!otherAgents.body.ok) {
      throw new Error('Expected other agent route to succeed');
    }

    const foreign = await updateGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [otherAgents.body.data.agents[0]!.id],
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_agents' },
    });

    const listed = await listGreenfieldTalkAgentsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    if (!listed.body.ok) throw new Error('Expected roster route to succeed');
    expect(listed.body.data.agents.map((agent) => agent.id)).toEqual(
      initialAgentIds,
    );
  });

  it('serves and updates greenfield talk tools from talk_tools', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Tools Facade Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const initial = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.body).toEqual({
      ok: true,
      data: {
        talkId: created.body.data.talk.id,
        active: {},
        activeToolIds: [],
        available: EXPECTED_TALK_TOOL_FAMILIES,
      },
    });

    const db = getDbPg();
    const beforeRows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.event_outbox
      where event_type = 'talk_tools_changed'
    `;
    const beforeCount = beforeRows[0]?.count ?? 0;

    const enabled = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { family: 'web', enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.body).toMatchObject({
      ok: true,
      data: {
        talkId: created.body.data.talk.id,
        active: { web: true },
        activeToolIds: ['web-search', 'web-fetch', 'news-monitor'],
        available: EXPECTED_TALK_TOOL_FAMILIES,
      },
    });

    const persistedOn = await db<Array<{ tool_id: string; enabled: boolean }>>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${created.body.data.talk.id}::uuid
      order by tool_id asc
    `;
    expect(persistedOn).toEqual([
      { tool_id: 'news-monitor', enabled: true },
      { tool_id: 'web-fetch', enabled: true },
      { tool_id: 'web-search', enabled: true },
    ]);

    const disabled = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { family: 'web', enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.body).toMatchObject({
      ok: true,
      data: { active: { web: false }, activeToolIds: [] },
    });

    const afterRows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.event_outbox
      where event_type = 'talk_tools_changed'
    `;
    expect((afterRows[0]?.count ?? 0) - beforeCount).toBe(2);
    const latest = await db<
      Array<{ payload: { talkId: string; active: Record<string, boolean> } }>
    >`
      select payload
      from public.event_outbox
      where event_type = 'talk_tools_changed'
      order by event_id desc
      limit 1
    `;
    expect(latest[0]?.payload).toEqual({
      talkId: created.body.data.talk.id,
      active: { web: false },
    });
  });

  it('updates individual greenfield talk tool ids', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Per Tool Toggle Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const enabled = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { toolId: 'web-search', enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.body).toMatchObject({
      ok: true,
      data: {
        active: { web: true },
        activeToolIds: ['web-search'],
        available: EXPECTED_TALK_TOOL_FAMILIES,
      },
    });

    const db = getDbPg();
    const persisted = await db<Array<{ tool_id: string; enabled: boolean }>>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${created.body.data.talk.id}::uuid
      order by tool_id asc
    `;
    expect(persisted).toEqual([{ tool_id: 'web-search', enabled: true }]);

    const disabled = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { toolId: 'web-search', enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.body).toMatchObject({
      ok: true,
      data: {
        active: { web: false },
        activeToolIds: [],
      },
    });
  });

  it('returns 403 before upserting talk tools for guest workspace members', async () => {
    const workspaceId = await currentWorkspaceId();
    await seedAuthUser(
      OTHER_USER_ID,
      'tool-guest@clawtalk.local',
      'Tool Guest',
    );
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
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      body: {
        title: 'Guest Tool Toggle Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    await db`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${OTHER_USER_ID}::uuid
    `;

    const denied = await updateGreenfieldTalkToolRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { family: 'web', enabled: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_writer_required' },
    });

    const rows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.talk_tools
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${created.body.data.talk.id}::uuid
    `;
    expect(rows[0]?.count ?? 0).toBe(0);
  });

  it('persists every talk tool family using the canonical greenfield tool ids', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Canonical Tool Id Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    for (const family of EXPECTED_TALK_TOOL_FAMILIES) {
      const result = await updateGreenfieldTalkToolRoute({
        auth: auth(),
        workspaceId,
        talkId: created.body.data.talk.id,
        body: { family, enabled: true },
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        data: {
          active: { [family]: true },
          available: EXPECTED_TALK_TOOL_FAMILIES,
        },
      });
    }

    const db = getDbPg();
    const persisted = await db<Array<{ tool_id: string; enabled: boolean }>>`
      select tool_id, enabled
      from public.talk_tools
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${created.body.data.talk.id}::uuid
      order by tool_id asc
    `;
    const expectedToolIds = EXPECTED_TALK_TOOL_FAMILIES.flatMap(
      (family) => EXPECTED_TALK_TOOL_IDS_BY_FAMILY[family] ?? [],
    ).sort();
    expect(persisted).toEqual(
      expectedToolIds.map((toolId) => ({ tool_id: toolId, enabled: true })),
    );
  });

  it('reports a compound talk tool family active when any canonical tool is enabled', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Partial Tools Facade Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const db = getDbPg();
    await db`
      insert into public.talk_tools (workspace_id, talk_id, tool_id, enabled)
      values
        (${workspaceId}::uuid, ${created.body.data.talk.id}::uuid, 'web-search', true),
        (${workspaceId}::uuid, ${created.body.data.talk.id}::uuid, 'web-fetch', false),
        (${workspaceId}::uuid, ${created.body.data.talk.id}::uuid, 'news-monitor', false)
    `;

    const result = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { active: { web: true }, activeToolIds: ['web-search'] },
    });
  });

  it('rejects invalid greenfield talk tool requests', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: {
        title: 'Tools Validation Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const unknown = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { family: 'shell', enabled: true },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_tool_toggle' },
    });

    const missingFamily = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { enabled: true },
    });
    expect(missingFamily.statusCode).toBe(400);
    expect(missingFamily.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_tool_toggle' },
    });

    const missingEnabled = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      body: { family: 'web' },
    });
    expect(missingEnabled.statusCode).toBe(400);
    expect(missingEnabled.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_tool_toggle' },
    });

    const missingTalk = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: '10000000-0000-4000-8000-000000000099',
      body: { family: 'web', enabled: true },
    });
    expect(missingTalk.statusCode).toBe(404);
    expect(missingTalk.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const missingTalkGet = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId,
      talkId: '10000000-0000-4000-8000-000000000099',
    });
    expect(missingTalkGet.statusCode).toBe(404);
    expect(missingTalkGet.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const malformedId = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId,
      talkId: 'not-a-uuid',
    });
    expect(malformedId.statusCode).toBe(400);
    expect(malformedId.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_talk_id' },
    });
  });

  it('rejects cross-workspace greenfield talk tools access', async () => {
    const workspaceId = await currentWorkspaceId();
    await seedAuthUser(
      OTHER_USER_ID,
      'other-tools@clawtalk.local',
      'Other Tools User',
    );
    const otherMe = await getGreenfieldMeRoute({ auth: auth(OTHER_USER_ID) });
    if (!otherMe.body.ok) throw new Error('Expected other session to succeed');
    const otherAgents = await listGreenfieldAgentsRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId: otherMe.body.data.currentWorkspaceId,
    });
    if (!otherAgents.body.ok) {
      throw new Error('Expected other agent route to succeed');
    }
    const otherTalk = await createGreenfieldTalkRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId: otherMe.body.data.currentWorkspaceId,
      body: {
        title: 'Other Workspace Tools Talk',
        team: otherAgents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    if (!otherTalk.body.ok) throw new Error('Expected other talk to succeed');

    const forbiddenWorkspace = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId: otherMe.body.data.currentWorkspaceId,
      talkId: otherTalk.body.data.talk.id,
    });
    expect(forbiddenWorkspace.statusCode).toBe(403);
    expect(forbiddenWorkspace.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });

    const hiddenTalkGet = await getGreenfieldTalkToolsRoute({
      auth: auth(),
      workspaceId,
      talkId: otherTalk.body.data.talk.id,
    });
    expect(hiddenTalkGet.statusCode).toBe(404);
    expect(hiddenTalkGet.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const hiddenTalkPatch = await updateGreenfieldTalkToolRoute({
      auth: auth(),
      workspaceId,
      talkId: otherTalk.body.data.talk.id,
      body: { family: 'web', enabled: true },
    });
    expect(hiddenTalkPatch.statusCode).toBe(404);
    expect(hiddenTalkPatch.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
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
