import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';

const USER_ID = '0c919191-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function seedUserAndWorkspace(): Promise<{ workspaceId: string }> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'schema@clawtalk.local',
      jsonb_build_object('full_name', 'Schema User')
    )
    on conflict (id) do nothing
  `;
  return { workspaceId: await ensureWorkspaceBootstrapForUser(USER_ID) };
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

describe('greenfield schema invariants', () => {
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

  it('has the greenfield catalog active and no legacy core tables', async () => {
    const db = getDbPg();
    const rows = await db<
      { legacy_table: string | null; template_count: number }[]
    >`
      select
        to_regclass('public.talk_threads')::text as legacy_table,
        (select count(*)::int from public.agent_role_templates) as template_count
    `;
    expect(rows[0]).toEqual({ legacy_table: null, template_count: 7 });
  });

  it('blocks deleting the last document tab', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const [doc] = await db<{ id: string }[]>`
      insert into public.documents (workspace_id, title, format)
      values (${workspaceId}::uuid, 'Draft', 'markdown')
      returning id
    `;
    const [tab] = await db<{ id: string }[]>`
      insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
      values (${workspaceId}::uuid, ${doc.id}::uuid, 'Main', 0)
      returning id
    `;

    await expect(
      db`
        delete from public.doc_tabs
        where id = ${tab.id}::uuid
      `,
    ).rejects.toMatchObject({ code: 'CT001' });

    const [secondTab] = await db<{ id: string }[]>`
      insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
      values (${workspaceId}::uuid, ${doc.id}::uuid, 'Second', 1)
      returning id
    `;
    await db`
      delete from public.doc_tabs
      where id = ${secondTab.id}::uuid
    `;
  });

  it('enforces run trigger shape for user-triggered runs', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const [fixture] = await db<
      {
        talk_id: string;
        snapshot_group_id: string;
        snapshot_id: string;
        model_id: string;
      }[]
    >`
      with chosen_agent as (
        select id, role_key, name, handle, initials, accent, accent_dark, model_id, temperature
        from public.agents
        where workspace_id = ${workspaceId}::uuid
          and role_key = 'strategist'
          and is_default = true
          and is_system = false
        limit 1
      ),
      talk as (
        insert into public.talks (workspace_id, sort_order, title, created_by)
        values (${workspaceId}::uuid, 0, 'Run invariant', ${USER_ID}::uuid)
        returning id
      ),
      snapshot_group as (
        select gen_random_uuid() as id
      ),
      snapshot as (
        insert into public.talk_agent_snapshots (
          workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
          name, handle, initials, accent, accent_dark, model_id, temperature,
          sort_order, role_template_version
        )
        select
          ${workspaceId}::uuid, talk.id, snapshot_group.id, chosen_agent.id,
          chosen_agent.role_key, chosen_agent.name, chosen_agent.handle,
          chosen_agent.initials, chosen_agent.accent, chosen_agent.accent_dark,
          chosen_agent.model_id, chosen_agent.temperature, 0, 1
        from talk, chosen_agent, snapshot_group
        returning id, talk_id, snapshot_group_id, model_id
      )
      select
        snapshot.talk_id,
        snapshot.snapshot_group_id,
        snapshot.id as snapshot_id,
        snapshot.model_id
      from snapshot
    `;

    await expect(
      db`
        insert into public.runs (
          workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
          model_id, requested_by, trigger, job_id, response_group_id,
          sequence_index
        )
        values (
          ${workspaceId}::uuid, ${fixture.talk_id}::uuid, 1,
          ${fixture.snapshot_group_id}::uuid, ${fixture.snapshot_id}::uuid,
          ${fixture.model_id}, ${USER_ID}::uuid, 'user',
          ${randomUUID()}::uuid, 'group-1', 0
        )
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('deduplicates home inbox refs without collapsing null refs', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const refId = randomUUID();
    await db`
      insert into public.home_inbox_items (
        workspace_id, type, target_kind, ref_id, severity, title
      )
      values (
        ${workspaceId}::uuid, 'job_output_ready', 'job',
        ${refId}::uuid, 'info', 'Job ready'
      )
    `;
    await expect(
      db`
        insert into public.home_inbox_items (
          workspace_id, type, target_kind, ref_id, severity, title
        )
        values (
          ${workspaceId}::uuid, 'job_output_ready', 'job',
          ${refId}::uuid, 'info', 'Job ready replay'
        )
      `,
    ).rejects.toMatchObject({ code: '23505' });

    await db`
      insert into public.home_inbox_items (
        workspace_id, type, target_kind, severity, title
      )
      values
        (${workspaceId}::uuid, 'job_blocked', 'job', 'blocking', 'Blocked 1'),
        (${workspaceId}::uuid, 'job_blocked', 'job', 'blocking', 'Blocked 2')
    `;
    const rows = await db<{ count: number }[]>`
      select count(*)::int as count
      from public.home_inbox_items
      where workspace_id = ${workspaceId}::uuid
        and type = 'job_blocked'
        and ref_id is null
    `;
    expect(rows[0]?.count).toBe(2);
  });
});
