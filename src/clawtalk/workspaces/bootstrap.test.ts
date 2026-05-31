import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from './bootstrap.js';

const USER_ID = '0c909090-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'bootstrap@clawtalk.local',
      jsonb_build_object('full_name', 'Bootstrap User')
    )
    on conflict (id) do nothing
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
    expect(agents).toHaveLength(7);
    expect(agents.filter((agent) => agent.is_system)).toHaveLength(2);
    expect(agents.map((agent) => agent.role_key).sort()).toEqual([
      'critic',
      'editor',
      'forge_critic',
      'forge_rewriter',
      'quant',
      'researcher',
      'strategist',
    ]);

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
    expect(counts[0]).toEqual({ workspaces: 1, agents: 7, teams: 3 });
  });
});
