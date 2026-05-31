import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import type { AuthContext } from '../types.js';
import {
  archiveGreenfieldTalkRoute,
  createGreenfieldFolderRoute,
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  getGreenfieldTalkPolicyRoute,
  getGreenfieldTalkRoute,
  getGreenfieldTalkToolsRoute,
  listGreenfieldAgentsRoute,
  listGreenfieldFoldersRoute,
  listGreenfieldTalkAgentsRoute,
  listGreenfieldTalkSidebarRoute,
  listGreenfieldTalksRoute,
  patchGreenfieldTalkRoute,
  updateGreenfieldTalkAgentsRoute,
  updateGreenfieldTalkPolicyRoute,
  updateGreenfieldTalkToolRoute,
} from './greenfield-core.js';

const USER_ID = '0c929292-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c929292-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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
      data: { active: { web: false } },
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
      data: { active: { web: true } },
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

  it('serves the legacy talk policy facade from the greenfield roster', async () => {
    const workspaceId = await currentWorkspaceId();
    const agents = await listGreenfieldAgentsRoute({
      auth: auth(),
      workspaceId,
    });
    if (!agents.body.ok) throw new Error('Expected agent route to succeed');
    const initialAgentIds = agents.body.data.agents
      .slice(0, 2)
      .map((agent) => agent.id);
    const initialAgentNames = agents.body.data.agents
      .slice(0, 2)
      .map((agent) => agent.name);
    const created = await createGreenfieldTalkRoute({
      auth: auth(),
      workspaceId,
      body: { title: 'Policy Facade Talk', team: initialAgentIds },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const fetched = await getGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toEqual({
      ok: true,
      data: {
        talkId: created.body.data.talk.id,
        agents: initialAgentNames,
        limits: { maxAgents: 5, maxAgentChars: 80 },
      },
    });

    const updated = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: ['  Alpha  ', 'Alpha', 'Beta'],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toEqual({
      ok: true,
      data: {
        talkId: created.body.data.talk.id,
        agents: initialAgentNames,
        limits: { maxAgents: 5, maxAgentChars: 80 },
      },
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

    const empty = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: [],
    });
    expect(empty.body).toEqual(fetched.body);

    const legacySizedPayload = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    });
    expect(legacySizedPayload.statusCode).toBe(200);
    expect(legacySizedPayload.body).toEqual(fetched.body);
  });

  it('rejects invalid greenfield talk policy requests', async () => {
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
        title: 'Policy Validation Talk',
        team: agents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected talk route to succeed');

    const nonArray = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: 'Alpha',
    });
    expect(nonArray.statusCode).toBe(400);
    expect(nonArray.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_agents' },
    });

    const legacyLoosePayload = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: ['Alpha', 12, null, 'x'.repeat(81)],
    });
    expect(legacyLoosePayload.statusCode).toBe(200);
    expect(legacyLoosePayload.body).toMatchObject({
      ok: true,
      data: { talkId: created.body.data.talk.id },
    });

    const tooMany = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: created.body.data.talk.id,
      agents: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_agents' },
    });

    const missingTalk = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: '10000000-0000-4000-8000-000000000099',
      agents: ['Alpha'],
    });
    expect(missingTalk.statusCode).toBe(404);
    expect(missingTalk.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const missingTalkGet = await getGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: '10000000-0000-4000-8000-000000000099',
    });
    expect(missingTalkGet.statusCode).toBe(404);
    expect(missingTalkGet.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const malformedId = await getGreenfieldTalkPolicyRoute({
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

  it('rejects cross-workspace greenfield talk policy access', async () => {
    const workspaceId = await currentWorkspaceId();
    await seedAuthUser(
      OTHER_USER_ID,
      'other-policy@clawtalk.local',
      'Other Policy User',
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
        title: 'Other Workspace Policy Talk',
        team: otherAgents.body.data.agents.slice(0, 1).map((agent) => agent.id),
      },
    });
    if (!otherTalk.body.ok) throw new Error('Expected other talk to succeed');

    const forbiddenWorkspace = await getGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId: otherMe.body.data.currentWorkspaceId,
      talkId: otherTalk.body.data.talk.id,
    });
    expect(forbiddenWorkspace.statusCode).toBe(403);
    expect(forbiddenWorkspace.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_forbidden' },
    });

    const hiddenTalkGet = await getGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: otherTalk.body.data.talk.id,
    });
    expect(hiddenTalkGet.statusCode).toBe(404);
    expect(hiddenTalkGet.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    const hiddenTalkPut = await updateGreenfieldTalkPolicyRoute({
      auth: auth(),
      workspaceId,
      talkId: otherTalk.body.data.talk.id,
      agents: ['Alpha'],
    });
    expect(hiddenTalkPut.statusCode).toBe(404);
    expect(hiddenTalkPut.body).toMatchObject({
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
