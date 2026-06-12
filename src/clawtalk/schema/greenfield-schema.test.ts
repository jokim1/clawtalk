import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withTrustedDbWrites,
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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    expect(rows[0]).toEqual({ legacy_table: null, template_count: 8 });
  });

  it('keeps server-authored workflow tables read-only for authenticated clients', async () => {
    const db = getDbPg();
    const protectedTables = [
      'messages',
      'context_sources',
      'context_source_pages',
      'documents',
      'doc_tabs',
      'doc_blocks',
      'doc_tab_coeditors',
      'document_versions',
    ];
    const directDmlGrants = await db<
      Array<{ table_name: string; privilege_type: string }>
    >`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'authenticated'
        and table_name in ${db(protectedTables)}
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      order by table_name asc, privilege_type asc
    `;
    expect(directDmlGrants).toEqual([]);

    const writePolicies = await db<Array<{ tablename: string; cmd: string }>>`
      select tablename, cmd
      from pg_policies
      where schemaname = 'public'
        and tablename in ${db(protectedTables)}
        and cmd <> 'SELECT'
      order by tablename asc, cmd asc
    `;
    expect(writePolicies).toEqual([]);
  });

  it('keeps provider replay blobs private from authenticated clients', async () => {
    const db = getDbPg();
    const tableRows = await db<{ exists: boolean }[]>`
      select to_regclass('public.message_provider_replay') is not null as exists
    `;
    expect(tableRows[0]?.exists).toBe(true);

    const directGrants = await db<
      Array<{ table_name: string; privilege_type: string }>
    >`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'authenticated'
        and table_name = 'message_provider_replay'
      order by privilege_type asc
    `;
    expect(directGrants).toEqual([]);

    const policies = await db<Array<{ tablename: string; cmd: string }>>`
      select tablename, cmd
      from pg_policies
      where schemaname = 'public'
        and tablename = 'message_provider_replay'
      order by cmd asc
    `;
    expect(policies).toEqual([]);
  });

  it('indexes provider replay rows by run for cascade maintenance', async () => {
    const db = getDbPg();
    const indexes = await db<Array<{ indexdef: string }>>`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'message_provider_replay'
        and indexname = 'message_provider_replay_run_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef.toLowerCase()).toContain(
      '(workspace_id, talk_id, run_id)',
    );
  });

  it('indexes prompt-visible context source lookups', async () => {
    const db = getDbPg();
    const indexes = await db<Array<{ indexdef: string }>>`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'context_sources'
        and indexname = 'context_sources_prompt_lookup_idx'
    `;
    expect(indexes).toHaveLength(1);
    const indexDef = indexes[0]!.indexdef.toLowerCase();
    // Serves greenfield-executor's per-run context load: equality on
    // (workspace_id, talk_id) + the sort_order/created_at/id ordering. Rules are
    // NOT excluded — the injection query includes kind='rule' rows.
    expect(indexDef).toContain(
      '(workspace_id, talk_id, sort_order, created_at, id)',
    );
    expect(indexDef).toContain('include_in_prompt = true');
  });

  it('keeps legacy source aliases unique under case-insensitive runtime lookup', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const [talk] = await db<{ id: string }[]>`
      insert into public.talks (workspace_id, sort_order, title, created_by)
      values (${workspaceId}::uuid, 0, 'Alias uniqueness', ${USER_ID}::uuid)
      returning id
    `;

    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talk.id}::uuid,
        'file',
        'Upper legacy alias',
        'Upper body',
        ${db.json({ compatKind: 'source', sourceRef: 'S1' } as never)},
        true,
        0,
        ${USER_ID}::uuid
      )
    `;

    await expect(
      db`
        insert into public.context_sources (
          workspace_id, talk_id, kind, name, extracted_text, meta_json,
          include_in_prompt, sort_order, added_by_user_id
        )
        values (
          ${workspaceId}::uuid,
          ${talk.id}::uuid,
          'file',
          'Lower legacy alias',
          'Lower body',
          ${db.json({ compatKind: 'source', sourceRef: 's1' } as never)},
          true,
          1,
          ${USER_ID}::uuid
        )
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('guarantees each run model resolves to one frozen provider/model pair', async () => {
    const db = getDbPg();
    const uniqueIndexes = await db<Array<{ indexname: string }>>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'llm_provider_models'
        and indexname = 'llm_provider_models_model_id_unique'
        and indexdef ilike '%unique%'
        and indexdef ilike '%(model_id)%'
    `;
    expect(uniqueIndexes).toHaveLength(1);

    const runModelFks = await db<
      Array<{ target_table: string; target_column: string }>
    >`
      select
        confrelid::regclass::text as target_table,
        a2.attname as target_column
      from pg_constraint c
      join pg_attribute a1
        on a1.attrelid = c.conrelid
       and a1.attnum = any(c.conkey)
      join pg_attribute a2
        on a2.attrelid = c.confrelid
       and a2.attnum = any(c.confkey)
      where c.conrelid = 'public.runs'::regclass
        and c.contype = 'f'
        and a1.attname = 'model_id'
    `;
    expect(runModelFks).toEqual([
      {
        target_table: 'llm_provider_models',
        target_column: 'model_id',
      },
    ]);

    const snapshotProviderModelFks = await db<
      Array<{
        target_table: string;
        source_columns: string[];
        target_columns: string[];
      }>
    >`
      select
        c.confrelid::regclass::text as target_table,
        array_agg(a1.attname order by cols.ordinality)::text[] as source_columns,
        array_agg(a2.attname order by cols.ordinality)::text[] as target_columns
      from pg_constraint c
      join unnest(c.conkey, c.confkey) with ordinality as cols(conkey, confkey, ordinality)
        on true
      join pg_attribute a1
        on a1.attrelid = c.conrelid
       and a1.attnum = cols.conkey
      join pg_attribute a2
        on a2.attrelid = c.confrelid
       and a2.attnum = cols.confkey
      where c.conrelid = 'public.talk_agent_snapshots'::regclass
        and c.contype = 'f'
      group by c.oid, c.confrelid
      having array_agg(a1.attname order by cols.ordinality)::text[] =
        array['provider_id', 'model_id']::text[]
    `;
    expect(snapshotProviderModelFks).toEqual([
      {
        target_table: 'llm_provider_models',
        source_columns: ['provider_id', 'model_id'],
        target_columns: ['provider_id', 'model_id'],
      },
    ]);
  });

  it('keeps nested trusted writes elevated until the outer scope finishes', async () => {
    await seedUserAndWorkspace();
    await withUserContext(USER_ID, async () => {
      const db = getDbPg();
      await withTrustedDbWrites(async () => {
        const roleRows = await db<{ role: string }[]>`
          select current_role as role
        `;
        expect(roleRows[0]?.role).toBe('postgres');

        await withTrustedDbWrites(async () => {
          const nestedRoleRows = await db<{ role: string }[]>`
            select current_role as role
          `;
          expect(nestedRoleRows[0]?.role).toBe('postgres');
        });

        const roleAfterNestedRows = await db<{ role: string }[]>`
          select current_role as role
        `;
        expect(roleAfterNestedRows[0]?.role).toBe('postgres');
      });

      const finalRoleRows = await db<{ role: string }[]>`
        select current_role as role
      `;
      expect(finalRoleRows[0]?.role).toBe('authenticated');
    });
  });

  it('rejects overlapping trusted writes and blocks non-trusted queries while elevated', async () => {
    await seedUserAndWorkspace();
    await withUserContext(USER_ID, async () => {
      const db = getDbPg();
      const firstEntered = deferred();
      const releaseFirst = deferred();

      const first = withTrustedDbWrites(async () => {
        const roleRows = await db<{ role: string }[]>`
          select current_role as role
        `;
        expect(roleRows[0]?.role).toBe('postgres');
        firstEntered.resolve();
        await releaseFirst.promise;
      });

      void first.catch(firstEntered.reject);
      await firstEntered.promise;

      try {
        expect(() => {
          void db<{ role: string }[]>`
            select current_role as role
          `;
        }).toThrow(/outside the trusted callback/);

        await expect(
          withTrustedDbWrites(async () => {
            await db`select 1`;
          }),
        ).rejects.toThrow(/Concurrent trusted DB writes/);
      } finally {
        releaseFirst.resolve();
      }
      await first;

      const finalRoleRows = await db<{ role: string }[]>`
        select current_role as role
      `;
      expect(finalRoleRows[0]?.role).toBe('authenticated');
    });
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
        select
          a.id, a.role_key, a.name, a.handle, a.initials, a.accent,
          a.accent_dark, a.model_id, a.temperature, lpm.provider_id
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
        values (${workspaceId}::uuid, 0, 'Run invariant', ${USER_ID}::uuid)
        returning id
      ),
      snapshot_group as (
        select gen_random_uuid() as id
      ),
      snapshot as (
        insert into public.talk_agent_snapshots (
          workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
          name, handle, initials, accent, accent_dark, provider_id, model_id,
          temperature, sort_order, role_template_version
        )
        select
          ${workspaceId}::uuid, talk.id, snapshot_group.id, chosen_agent.id,
          chosen_agent.role_key, chosen_agent.name, chosen_agent.handle,
          chosen_agent.initials, chosen_agent.accent, chosen_agent.accent_dark,
          chosen_agent.provider_id, chosen_agent.model_id,
          chosen_agent.temperature, 0, 1
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
          name, handle, initials, accent, accent_dark, provider_id, model_id,
          temperature, sort_order, role_template_version
        )
        select
          ${workspaceId}::uuid, talk.id, snapshot_group.id, chosen_agent.id,
          chosen_agent.role_key, chosen_agent.name, chosen_agent.handle,
          chosen_agent.initials, chosen_agent.accent, chosen_agent.accent_dark,
          chosen_agent.provider_id, chosen_agent.model_id,
          chosen_agent.temperature, 0, 1
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
            provider_id, model_id, temperature, sort_order
          )
          values (
            ${workspaceId}::uuid, ${fixture.talk_id}::uuid,
            ${randomUUID()}::uuid, ${fixture.agent_id}::uuid, 'strategist',
            ${fixture.provider_id}, ${fixture.model_id}, 0.5, 0
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
          insert into public.event_outbox (topic, event_type, payload)
          values (
            ${`talk:${fixture.talk_id}`}, 'forged_event',
            jsonb_build_object('trusted', false)
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

  it('rejects direct authenticated writes into document edit provenance rows', async () => {
    const { workspaceId } = await seedUserAndWorkspace();
    const db = getDbPg();
    const [fixture] = await db<
      Array<{
        talk_id: string;
        document_id: string;
        tab_id: string;
        block_id: string;
        list_version: number;
      }>
    >`
      with talk as (
        insert into public.talks (workspace_id, sort_order, title, created_by)
        values (${workspaceId}::uuid, 0, 'Document edit RLS', ${USER_ID}::uuid)
        returning id
      ),
      document as (
        insert into public.documents (workspace_id, primary_talk_id, title, format)
        select ${workspaceId}::uuid, talk.id, 'Draft', 'markdown'
        from talk
        returning id, primary_talk_id
      ),
      tab as (
        insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
        select ${workspaceId}::uuid, document.id, 'Main', 0
        from document
        returning id, document_id, list_version
      ),
      block as (
        insert into public.doc_blocks (
          workspace_id, document_id, tab_id, sort_order, kind, text
        )
        select ${workspaceId}::uuid, tab.document_id, tab.id, 0, 'p', 'Original'
        from tab
        returning id, tab_id, document_id
      )
      select
        document.primary_talk_id as talk_id,
        document.id as document_id,
        tab.id as tab_id,
        block.id as block_id,
        tab.list_version
      from document, tab, block
    `;

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          insert into public.document_edits (
            workspace_id, document_id, tab_id, after_block_id,
            base_list_version, op, new_kind, new_text, new_attrs_json
          )
          values (
            ${workspaceId}::uuid, ${fixture.document_id}::uuid,
            ${fixture.tab_id}::uuid, ${fixture.block_id}::uuid,
            ${fixture.list_version}, 'insert', 'p', 'Forged edit',
            '{}'::jsonb
          )
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    const [edit] = await db<{ id: string }[]>`
      insert into public.document_edits (
        workspace_id, document_id, tab_id, after_block_id, base_list_version,
        op, new_kind, new_text, new_attrs_json
      )
      values (
        ${workspaceId}::uuid, ${fixture.document_id}::uuid,
        ${fixture.tab_id}::uuid, ${fixture.block_id}::uuid,
        ${fixture.list_version}, 'insert', 'p', 'Trusted edit',
        '{}'::jsonb
      )
      returning id
    `;

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          update public.document_edits
          set status = 'accepted'
          where id = ${edit.id}::uuid
        `;
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withUserContext(USER_ID, async () => {
        const scopedDb = getDbPg();
        await scopedDb`
          delete from public.document_edits
          where id = ${edit.id}::uuid
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
    const adminWriteBlock =
      migrationSql.match(
        /admin_write_tables text\[] := array\[[\s\S]*?\];/,
      )?.[0] ?? '';
    expect(migrationSql).toContain(
      'create or replace function public.is_workspace_writer',
    );
    expect(migrationSql).toContain(
      'create policy %I_write on public.%I for all using (public.is_workspace_writer(workspace_id)) with check (public.is_workspace_writer(workspace_id))',
    );
    expect(migrationSql).toContain(
      'clawtalk greenfield baseline requires an empty/reset Supabase database',
    );
    expect(migrationSql).toContain('create policy jobs_read on public.jobs');
    expect(migrationSql).not.toContain('create policy jobs_insert');
    expect(migrationSql).not.toContain('create policy jobs_update');
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.jobs from authenticated',
    );
    expect(migrationSql).toContain('create trigger jobs_block_identity_change');

    for (const tableName of [
      'jobs',
      'runs',
      'talk_agent_snapshots',
      'run_prompt_snapshots',
      'audit_events',
      'document_edits',
      'agents',
    ]) {
      expect(memberWriteBlock).not.toContain(`'${tableName}'`);
    }
    expect(adminWriteBlock).toContain("'agents'");
    expect(migrationSql).toContain(
      'create policy %I_write on public.%I for all using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id))',
    );
    expect(migrationSql).toContain(
      'create policy document_edits_read on public.document_edits',
    );
    expect(migrationSql).toContain(
      'new.proposed_by_run_id is not null\n            and proposed_by_run_id = new.proposed_by_run_id',
    );
    expect(migrationSql).not.toContain('create policy runs_insert_member');
    expect(migrationSql).not.toContain('create policy runs_cancel_member');
    expect(migrationSql).not.toContain(
      'create policy talk_agent_snapshots_insert_member',
    );
    expect(migrationSql).not.toContain(
      'create policy run_prompt_snapshots_insert_member',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.jobs from authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.document_edits from authenticated',
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
    expect(migrationSql).toContain(
      'grant select on public.settings_kv to authenticated',
    );
    expect(migrationSql).toContain('create table public.web_search_providers');
    expect(migrationSql).toContain(
      'preferred_web_search_provider_id text references public.web_search_providers(id) on delete set null',
    );
    expect(migrationSql).toContain(
      'create table public.web_search_provider_secrets',
    );
    expect(migrationSql).toContain(
      'create policy web_search_provider_secrets_owner on public.web_search_provider_secrets',
    );
    expect(migrationSql).toContain(
      "('web_search.exa', 'Exa', 'https://api.exa.ai')",
    );
    expect(migrationSql).toContain(
      'grant select, insert, update, delete on public.web_search_provider_secrets to authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.web_search_providers from authenticated',
    );
    expect(migrationSql).toContain(
      'grant update (name, avatar_color, initials, preferred_web_search_provider_id, updated_at) on public.users to authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.settings_kv from authenticated',
    );
    expect(migrationSql).toContain(
      'revoke insert, update, delete on public.llm_ttft_stats from authenticated',
    );
    expect(migrationSql).not.toContain(
      'create policy workspace_provider_secrets_read',
    );
    expect(migrationSql).not.toContain(
      'grant select, insert, update, delete on public.workspace_provider_secrets to authenticated',
    );
    expect(migrationSql).not.toContain(
      'grant insert, update, delete on public.workspace_provider_secrets to authenticated',
    );
    expect(migrationSql).toContain(
      'revoke all on public.workspace_provider_secrets from authenticated',
    );
    expect(migrationSql).not.toContain(
      'create policy workspace_provider_secrets_insert on public.workspace_provider_secrets',
    );
    expect(migrationSql).not.toContain(
      'create policy workspace_provider_secrets_update on public.workspace_provider_secrets',
    );
    expect(migrationSql).not.toContain(
      'create policy workspace_provider_secrets_delete on public.workspace_provider_secrets',
    );
    expect(migrationSql).toContain('create policy audit_events_read');
    expect(migrationSql).toContain('create policy connectors_insert');
    expect(migrationSql).toContain(
      "and config_json->>'compatSurface' is distinct from 'google_tools'",
    );
    expect(migrationSql).toContain('create policy connectors_update');
    expect(migrationSql).toContain('create policy connectors_delete');
  });

  it('creates public foreign-key targets before referencing them', () => {
    const migrationSql = readFileSync(
      new URL(
        '../../../supabase/migrations/0001_clawtalk_greenfield.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const createdTables = new Set<string>();

    migrationSql.split('\n').forEach((line, index) => {
      const createMatch = line.match(
        /^\s*create\s+table\s+public\.([a-z_][a-z0-9_]*)\b/i,
      );
      if (createMatch) {
        createdTables.add(`public.${createMatch[1]}`);
      }

      for (const referenceMatch of line.matchAll(
        /\breferences\s+public\.([a-z_][a-z0-9_]*)\b/gi,
      )) {
        const referencedTable = `public.${referenceMatch[1]}`;
        expect(
          createdTables.has(referencedTable),
          `line ${index + 1} references ${referencedTable} before it is created`,
        ).toBe(true);
      }
    });
  });
});
