import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from './bootstrap.js';

const USER_ID = '0c909090-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c909090-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(
  id = USER_ID,
  email = 'bootstrap@clawtalk.local',
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${email}::text)
    )
    on conflict (id) do nothing
  `;
}

async function deleteUser(): Promise<void> {
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

describe('workspace bootstrap', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await deleteUser();
  });

  afterAll(async () => {
    await deleteUser();
    await closePgDatabase();
  });

  it('creates one owned workspace with default agents and teams idempotently', async () => {
    await seedAuthUser();

    const firstWorkspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const secondWorkspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    expect(secondWorkspaceId).toBe(firstWorkspaceId);

    const db = getDbPg();
    const memberships = await db<{ role: string }[]>`
      select role
      from public.workspace_members
      where workspace_id = ${firstWorkspaceId}::uuid
        and user_id = ${USER_ID}::uuid
    `;
    expect(memberships).toEqual([{ role: 'owner' }]);

    const agents = await db<{ role_key: string; is_system: boolean }[]>`
      select role_key, is_system
      from public.agents
      where workspace_id = ${firstWorkspaceId}::uuid
      order by role_key asc
    `;
    expect(agents).toHaveLength(8);
    expect(agents.filter((agent) => agent.is_system)).toHaveLength(3);
    expect(agents.map((agent) => agent.role_key).sort()).toEqual([
      'buddy',
      'critic',
      'editor',
      'forge_critic',
      'forge_rewriter',
      'quant',
      'researcher',
      'strategist',
    ]);

    // Buddy speaks in the system talk, so its persona must carry the template
    // prompt (run snapshots read agents.persona, not the template).
    const buddyAgents = await db<
      { persona: string | null; is_system: boolean }[]
    >`
      select persona, is_system
      from public.agents
      where workspace_id = ${firstWorkspaceId}::uuid
        and role_key = 'buddy'
    `;
    expect(buddyAgents).toHaveLength(1);
    expect(buddyAgents[0]?.is_system).toBe(true);
    expect(buddyAgents[0]?.persona).toContain('Buddy');

    const buddyTalks = await db<
      { id: string; title: string; roster_roles: string[] }[]
    >`
      select
        t.id,
        t.title,
        coalesce((
          select array_agg(a.role_key order by ta.sort_order asc)
          from public.talk_agents ta
          join public.agents a
            on a.workspace_id = ta.workspace_id
           and a.id = ta.agent_id
          where ta.talk_id = t.id
        ), '{}'::text[]) as roster_roles
      from public.talks t
      where t.workspace_id = ${firstWorkspaceId}::uuid
        and t.is_system = true
    `;
    expect(buddyTalks).toHaveLength(1);
    expect(buddyTalks[0]?.title).toBe('Buddy');
    expect(buddyTalks[0]?.roster_roles).toEqual(['buddy']);

    const teamRows = await db<{ name: string; roles: string[] }[]>`
      select
        tc.name,
        array_agg(a.role_key order by tca.sort_order asc) as roles
      from public.team_compositions tc
      join public.team_composition_agents tca
        on tca.workspace_id = tc.workspace_id
       and tca.team_id = tc.id
      join public.agents a
        on a.workspace_id = tca.workspace_id
       and a.id = tca.agent_id
      where tc.workspace_id = ${firstWorkspaceId}::uuid
        and tc.is_default = true
      group by tc.name
      order by tc.name asc
    `;
    expect(teamRows).toEqual([
      { name: 'Hiring crew', roles: ['researcher', 'critic', 'editor'] },
      {
        name: 'Pricing crew',
        roles: ['strategist', 'critic', 'quant', 'editor'],
      },
      { name: 'Research crew', roles: ['researcher', 'critic', 'editor'] },
    ]);

    const counts = await db<
      {
        workspaces: number;
        agents: number;
        teams: number;
      }[]
    >`
      select
        (select count(*)::int from public.workspaces where owner_id = ${USER_ID}::uuid) as workspaces,
        (select count(*)::int from public.agents where workspace_id = ${firstWorkspaceId}::uuid) as agents,
        (select count(*)::int from public.team_compositions where workspace_id = ${firstWorkspaceId}::uuid) as teams
    `;
    expect(counts[0]).toEqual({ workspaces: 1, agents: 8, teams: 3 });
  });

  it('unarchives the system talk if direct writes archived it', async () => {
    await seedAuthUser();

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      update public.talks
      set archived_at = now()
      where workspace_id = ${workspaceId}::uuid
        and is_system = true
    `;

    await ensureWorkspaceBootstrapForUser(USER_ID);

    const rows = await db<{ archived_at: string | null }[]>`
      select archived_at
      from public.talks
      where workspace_id = ${workspaceId}::uuid
        and is_system = true
    `;
    expect(rows).toEqual([{ archived_at: null }]);
  });

  it('re-attaches Buddy to the system talk if the roster row goes missing', async () => {
    await seedAuthUser();

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      delete from public.talk_agents ta
      using public.talks t
      where t.workspace_id = ta.workspace_id
        and t.id = ta.talk_id
        and t.workspace_id = ${workspaceId}::uuid
        and t.is_system = true
    `;

    await ensureWorkspaceBootstrapForUser(USER_ID);

    const rows = await db<{ role_key: string }[]>`
      select a.role_key
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
    expect(rows).toEqual([{ role_key: 'buddy' }]);
  });

  it('serializes concurrent first bootstrap calls into one owned workspace', async () => {
    await seedAuthUser();

    const workspaceIds = await Promise.all(
      Array.from({ length: 5 }, () => ensureWorkspaceBootstrapForUser(USER_ID)),
    );

    expect(new Set(workspaceIds).size).toBe(1);
    const db = getDbPg();
    const counts = await db<Array<{ workspaces: number; members: number }>>`
      select
        (select count(*)::int
         from public.workspaces
         where owner_id = ${USER_ID}::uuid) as workspaces,
        (select count(*)::int
         from public.workspace_members
         where user_id = ${USER_ID}::uuid
           and role = 'owner') as members
    `;
    expect(counts[0]).toEqual({ workspaces: 1, members: 1 });
  });

  it('repairs the owned workspace membership role to owner on re-bootstrap', async () => {
    await seedAuthUser();

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      update public.workspace_members
      set role = 'member'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${USER_ID}::uuid
    `;

    await ensureWorkspaceBootstrapForUser(USER_ID);

    const rows = await db<Array<{ role: string }>>`
      select role
      from public.workspace_members
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${USER_ID}::uuid
    `;
    expect(rows[0]?.role).toBe('owner');
  });

  it('does not overwrite existing seeded agents or teams on later bootstrap calls', async () => {
    await seedAuthUser();

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      update public.agents
      set name = 'Custom Strategist',
          enabled = false,
          is_custom = true
      where workspace_id = ${workspaceId}::uuid
        and role_key = 'strategist'
        and is_default = true
        and is_system = false
    `;
    await db`
      update public.team_compositions
      set description = 'Custom team description'
      where workspace_id = ${workspaceId}::uuid
        and name = 'Pricing crew'
        and is_default = true
    `;
    await db`
      delete from public.team_composition_agents
      where workspace_id = ${workspaceId}::uuid
        and team_id in (
          select id
          from public.team_compositions
          where workspace_id = ${workspaceId}::uuid
            and name = 'Pricing crew'
            and is_default = true
        )
    `;

    await ensureWorkspaceBootstrapForUser(USER_ID);

    const agents = await db<
      Array<{ name: string; enabled: boolean; is_custom: boolean }>
    >`
      select name, enabled, is_custom
      from public.agents
      where workspace_id = ${workspaceId}::uuid
        and role_key = 'strategist'
        and is_default = true
        and is_system = false
    `;
    expect(agents[0]).toEqual({
      name: 'Custom Strategist',
      enabled: false,
      is_custom: true,
    });

    const teams = await db<Array<{ description: string | null }>>`
      select description
      from public.team_compositions
      where workspace_id = ${workspaceId}::uuid
        and name = 'Pricing crew'
        and is_default = true
    `;
    expect(teams[0]?.description).toBe('Custom team description');

    const repairedTeamRows = await db<{ roles: string[] }[]>`
      select array_agg(a.role_key order by tca.sort_order asc) as roles
      from public.team_compositions tc
      join public.team_composition_agents tca
        on tca.workspace_id = tc.workspace_id
       and tca.team_id = tc.id
      join public.agents a
        on a.workspace_id = tca.workspace_id
       and a.id = tca.agent_id
      where tc.workspace_id = ${workspaceId}::uuid
        and tc.name = 'Pricing crew'
        and tc.is_default = true
      group by tc.id
    `;
    expect(repairedTeamRows[0]?.roles).toEqual([
      'strategist',
      'critic',
      'quant',
      'editor',
    ]);
  });

  it('repairs missing default team roster edges without overwriting existing rows', async () => {
    await seedAuthUser();

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    const db = getDbPg();
    await db`
      update public.team_composition_agents tca
      set sort_order = 99
      from public.team_compositions tc
      join public.agents a
        on a.workspace_id = tc.workspace_id
       and a.role_key = 'strategist'
       and a.is_default = true
       and a.is_system = false
      where tca.workspace_id = tc.workspace_id
        and tca.team_id = tc.id
        and tca.agent_id = a.id
        and tc.workspace_id = ${workspaceId}::uuid
        and tc.name = 'Pricing crew'
        and tc.is_default = true
    `;
    await db`
      delete from public.team_composition_agents tca
      using public.team_compositions tc, public.agents a
      where tca.workspace_id = tc.workspace_id
        and tca.team_id = tc.id
        and tca.workspace_id = a.workspace_id
        and tca.agent_id = a.id
        and tc.workspace_id = ${workspaceId}::uuid
        and tc.name = 'Pricing crew'
        and tc.is_default = true
        and a.role_key = 'quant'
        and a.is_default = true
        and a.is_system = false
    `;

    await ensureWorkspaceBootstrapForUser(USER_ID);

    const rows = await db<
      Array<{ role_key: string; sort_order: number | null }>
    >`
      select a.role_key, tca.sort_order
      from public.team_compositions tc
      join public.team_composition_agents tca
        on tca.workspace_id = tc.workspace_id
       and tca.team_id = tc.id
      join public.agents a
        on a.workspace_id = tca.workspace_id
       and a.id = tca.agent_id
      where tc.workspace_id = ${workspaceId}::uuid
        and tc.name = 'Pricing crew'
        and tc.is_default = true
      order by a.role_key asc
    `;
    const sortByRole = new Map(
      rows.map((row) => [row.role_key, row.sort_order]),
    );
    expect(sortByRole.get('quant')).toBe(3);
    expect(sortByRole.get('strategist')).toBe(99);
  });

  it('bootstraps an owned workspace instead of seeding a workspace where the user is only a member', async () => {
    await seedAuthUser();
    await seedAuthUser(OTHER_USER_ID, 'other-bootstrap@clawtalk.local');

    const db = getDbPg();
    const sharedWorkspaces = await db<Array<{ id: string }>>`
      insert into public.workspaces (name, owner_id)
      values ('Shared workspace', ${OTHER_USER_ID}::uuid)
      returning id
    `;
    const sharedWorkspaceId = sharedWorkspaces[0]!.id;
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values
        (${sharedWorkspaceId}::uuid, ${OTHER_USER_ID}::uuid, 'owner'),
        (${sharedWorkspaceId}::uuid, ${USER_ID}::uuid, 'member')
    `;

    const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
    expect(workspaceId).not.toBe(sharedWorkspaceId);

    const ownedRows = await db<Array<{ owner_id: string; role: string }>>`
      select w.owner_id::text, wm.role
      from public.workspaces w
      join public.workspace_members wm
        on wm.workspace_id = w.id
       and wm.user_id = ${USER_ID}::uuid
      where w.id = ${workspaceId}::uuid
    `;
    expect(ownedRows[0]).toEqual({ owner_id: USER_ID, role: 'owner' });

    const sharedAgents = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.agents
      where workspace_id = ${sharedWorkspaceId}::uuid
    `;
    expect(sharedAgents[0]?.count).toBe(0);
  });

  it('rejects authenticated attempts to bootstrap another user', async () => {
    await seedAuthUser();
    await seedAuthUser(OTHER_USER_ID, 'other-bootstrap@clawtalk.local');

    await expect(
      withUserContext(USER_ID, () =>
        ensureWorkspaceBootstrapForUser(OTHER_USER_ID),
      ),
    ).rejects.toMatchObject({ code: 'CT100' });

    const db = getDbPg();
    const rows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.workspaces
      where owner_id = ${OTHER_USER_ID}::uuid
    `;
    expect(rows[0]?.count).toBe(0);
  });
});
