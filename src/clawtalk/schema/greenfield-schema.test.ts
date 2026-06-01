import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
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

  it('rejects direct authenticated writes into trusted runtime tables', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const [fixture] = await db<
      {
        talk_id: string;
        message_id: string;
        snapshot_group_id: string;
        snapshot_id: string;
        run_id: string;
        agent_id: string;
        model_id: string;
        provider_id: string;
      }[]
    >`
      with chosen_agent as (
        select
          a.id,
          a.role_key,
          a.name,
          a.handle,
          a.initials,
          a.accent,
          a.accent_dark,
          a.model_id,
          a.temperature,
          lpm.provider_id
        from public.agents a
        join public.llm_provider_models lpm
          on lpm.model_id = a.model_id
        where a.workspace_id = ${workspaceId}::uuid
          and a.role_key = 'strategist'
          and a.is_default = true
          and a.is_system = false
        order by lpm.provider_id asc
        limit 1
      ),
      talk as (
        insert into public.talks (workspace_id, sort_order, title, created_by)
        values (${workspaceId}::uuid, 0, 'Runtime RLS', ${USER_ID}::uuid)
        returning id
      ),
      message as (
        insert into public.messages (
          workspace_id, talk_id, round, author_kind, author_user_id, body
        )
        select
          ${workspaceId}::uuid, talk.id, 1, 'user', ${USER_ID}::uuid, 'hello'
        from talk
        returning id, talk_id
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
        returning id, talk_id, snapshot_group_id
      ),
      run as (
        insert into public.runs (
          workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
          status, model_id, requested_by, trigger_message_id, trigger,
          response_group_id, sequence_index
        )
        select
          ${workspaceId}::uuid, snapshot.talk_id, 1, snapshot.snapshot_group_id,
          snapshot.id, 'queued', chosen_agent.model_id, ${USER_ID}::uuid,
          message.id, 'user', 'runtime-rls-fixture', 0
        from snapshot, chosen_agent, message
        returning id
      )
      select
        snapshot.talk_id,
        message.id as message_id,
        snapshot.snapshot_group_id,
        snapshot.id as snapshot_id,
        run.id as run_id,
        chosen_agent.id as agent_id,
        chosen_agent.model_id,
        chosen_agent.provider_id
      from snapshot, run, chosen_agent, message
    `;

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          insert into public.talk_agent_snapshots (
            workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
            model_id, temperature, sort_order
          )
          values (
            ${workspaceId}::uuid, ${fixture.talk_id}::uuid,
            ${randomUUID()}::uuid, ${fixture.agent_id}::uuid, 'strategist',
            ${fixture.model_id}, 0.5, 0
          )
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          update public.runs
          set status = 'cancelled',
              finished_at = now(),
              error_json = jsonb_build_object('code', 'forged_cancel')
          where workspace_id = ${workspaceId}::uuid
            and id = ${fixture.run_id}::uuid
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          insert into public.runs (
            workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
            status, model_id, requested_by, trigger, trigger_message_id,
            response_group_id, sequence_index
          )
          values (
            ${workspaceId}::uuid, ${fixture.talk_id}::uuid, 2,
            ${fixture.snapshot_group_id}::uuid, ${fixture.snapshot_id}::uuid,
            'queued', ${fixture.model_id}, ${USER_ID}::uuid, 'user',
            ${fixture.message_id}::uuid, 'runtime-rls-forged', 0
          )
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          insert into public.run_prompt_snapshots (
            workspace_id, run_id, talk_id, agent_snapshot_id, model_id,
            provider, prompt_assembly_version, tool_manifest_json
          )
          values (
            ${workspaceId}::uuid, ${fixture.run_id}::uuid,
            ${fixture.talk_id}::uuid, ${fixture.snapshot_id}::uuid,
            ${fixture.model_id}, ${fixture.provider_id}, 1,
            jsonb_build_object('effectiveTools', jsonb_build_array())
          )
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          insert into public.audit_events (
            workspace_id, actor_user_id, entity_type, entity_id, action,
            payload_json
          )
          values (
            ${workspaceId}::uuid, ${USER_ID}::uuid, 'run',
            ${fixture.run_id}::uuid, 'forged_audit',
            jsonb_build_object('trusted', false)
          )
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });
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

  it('keeps runtime snapshot tables out of blanket member-write RLS', () => {
    const migrationSql = readFileSync(
      new URL(
        '../../../supabase/migrations/0001_clawtalk_greenfield.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const memberWriteBlock =
      migrationSql.match(
        /member_write_tables text\[] := array\[[\s\S]*?\];/,
      )?.[0] ?? '';

    for (const tableName of [
      'runs',
      'talk_agent_snapshots',
      'run_prompt_snapshots',
      'audit_events',
    ]) {
      expect(memberWriteBlock).not.toContain(`'${tableName}'`);
    }
    expect(migrationSql).not.toContain('create policy runs_insert_member');
    expect(migrationSql).not.toContain('create policy runs_cancel_member');
    expect(migrationSql).not.toContain(
      'create policy talk_agent_snapshots_insert_member',
    );
    expect(migrationSql).not.toContain(
      'create policy run_prompt_snapshots_insert_member',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.runs from authenticated',
    );
    expect(migrationSql).not.toContain(
      'grant update (status, finished_at, error_json) on public.runs to authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.talk_agent_snapshots from authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.run_prompt_snapshots from authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.audit_events from authenticated',
    );
    expect(migrationSql).toContain('create policy audit_events_read');
  });
});
