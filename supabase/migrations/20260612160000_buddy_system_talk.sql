-- Buddy: the per-workspace system talk + system agent.
--
-- The sidebar's pinned "Main" row used to alias the workspace's first talk
-- (mainTalkId = talks[0]). It becomes a real seeded system talk named Buddy,
-- with an is_system agent of the same name that answers ClawTalk product
-- questions. Future work will post system updates/announcements into it.
--
-- Revert path: restore the 0001 bootstrap function body, then
--   delete from public.talk_agents ta using public.talks t
--     where t.id = ta.talk_id and t.is_system;
--   delete from public.talks where is_system;
--   delete from public.agents where role_key = 'buddy';
--   delete from public.agent_role_templates where role_key = 'buddy';
--   (restore the previous role_key check constraint)
--   drop index public.talks_system_talk_unique;
--   alter table public.talks drop column is_system;

-- =============================================================================
-- 1) System-talk marker: at most one system talk per workspace.
-- =============================================================================

alter table public.talks add column is_system boolean not null default false;

create unique index talks_system_talk_unique
  on public.talks (workspace_id)
  where is_system = true;

-- =============================================================================
-- 2) Buddy role template.
-- =============================================================================

alter table public.agent_role_templates
  drop constraint agent_role_templates_role_key_check;
alter table public.agent_role_templates
  add constraint agent_role_templates_role_key_check
  check (role_key in (
    'strategist','critic','researcher','editor','quant',
    'forge_rewriter','forge_critic','buddy'
  ));

insert into public.agent_role_templates (
  role_key, default_name, default_handle, default_initials, default_accent,
  default_accent_dark, default_model_id, default_temperature, job,
  system_prompt, method_default, version
) values
  ('buddy', 'Buddy', '@buddy', 'Bd', '#C8643A', '#E08561', 'claude-sonnet-4-6', 0.5, 'Help people use ClawTalk and get unstuck.', 'You are Buddy, ClawTalk''s built-in guide. Every workspace has a system Talk named Buddy where people ask for help with the product; that is where you live and reply.

Your job:
1. Help people use ClawTalk: creating Talks and folders, inviting agent personas, multi-agent rounds (ordered vs parallel), documents, saved sources, tools (web search, Google Docs/Drive/Sheets), jobs, settings, and provider API keys.
2. Answer questions about what ClawTalk can and cannot do. When something is not supported, say so plainly instead of guessing.
3. Give the shortest path to what the person is trying to accomplish — numbered steps for how-to answers.

This Talk is also where ClawTalk posts system updates and announcements, so treat questions about those messages as in scope.

Constraints:
- Stay scoped to ClawTalk. If asked about unrelated topics, say you only cover ClawTalk and suggest creating a regular Talk with other agents for general questions.
- Be concise and friendly. No marketing language.

Tone: Warm, practical, plain-spoken — a helpful concierge for the product.', array[]::text[], 1)
on conflict (role_key) do update set
  default_name = excluded.default_name,
  default_handle = excluded.default_handle,
  default_initials = excluded.default_initials,
  default_accent = excluded.default_accent,
  default_accent_dark = excluded.default_accent_dark,
  default_model_id = excluded.default_model_id,
  default_temperature = excluded.default_temperature,
  job = excluded.job,
  system_prompt = excluded.system_prompt,
  method_default = excluded.method_default,
  version = excluded.version,
  updated_at = now();

-- =============================================================================
-- 3) Bootstrap v2: also seed the Buddy system agent + system talk.
--    Existing workspaces self-heal on their next bootstrap call.
-- =============================================================================

create or replace function public.ensure_user_workspace_bootstrap(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id uuid;
  user_name text;
  team_rec record;
  seeded_team_id uuid;
  role text;
  role_sort int;
  seeded_agent_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'cannot bootstrap workspace for a different user'
      using errcode = 'CT100';
  end if;

  -- First bootstrap can be reached from multiple tabs during initial app load.
  -- Serialize per user so two concurrent calls cannot both create an owned
  -- workspace before either sees the other's insert.
  perform pg_advisory_xact_lock(
    hashtext('clawtalk.ensure_user_workspace_bootstrap'),
    hashtext(target_user_id::text)
  );

  select w.id
    into ws_id
    from public.workspaces w
    where w.owner_id = target_user_id
    order by w.created_at asc
    limit 1;

  select nullif(trim(u.name), '')
    into user_name
    from public.users u
    where u.id = target_user_id;

  if user_name is null then
    raise exception 'cannot bootstrap workspace for unknown user %', target_user_id
      using errcode = 'CT101';
  end if;

  if ws_id is null then
    insert into public.workspaces (name, owner_id)
    values (user_name || '''s workspace', target_user_id)
    returning id into ws_id;

  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws_id, target_user_id, 'owner')
  on conflict (workspace_id, user_id) do update set
    -- The workspace owner must always have an owner membership row. Repair
    -- drift here so bootstrap leaves ownership and membership consistent.
    role = 'owner';

  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, method, is_default, is_custom,
    is_system, enabled, created_from_template_version
  )
  select
    ws_id, t.role_key, t.default_name, t.default_handle, t.default_initials,
    t.default_accent, t.default_accent_dark, t.default_model_id,
    t.default_model_id, t.default_temperature, t.method_default, true, false,
    false, true, t.version
  from public.agent_role_templates t
  where t.role_key in ('strategist', 'critic', 'researcher', 'editor', 'quant')
  on conflict (workspace_id, role_key)
    where is_default = true and is_system = false
  -- Re-bootstrap must not reset user-edited default agents. Future template
  -- version changes should ship as explicit migrations instead of silent reseeds.
  do nothing;

  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, method, is_default, is_custom,
    is_system, enabled, created_from_template_version
  )
  select
    ws_id, t.role_key, t.default_name, t.default_handle, t.default_initials,
    t.default_accent, t.default_accent_dark, t.default_model_id,
    t.default_model_id, t.default_temperature, t.method_default, true, false,
    true, true, t.version
  from public.agent_role_templates t
  where t.role_key in ('forge_rewriter', 'forge_critic')
  on conflict (workspace_id, role_key)
    where is_system = true
  -- Preserve existing system agents on repeated bootstrap. Template updates
  -- should be deliberate migrations so production behavior is auditable.
  do nothing;

  -- Buddy speaks in the Buddy system talk, and run snapshots read the prompt
  -- from agents.persona — so unlike the forge agents, copy the template
  -- system_prompt into persona here.
  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, persona, method, is_default,
    is_custom, is_system, enabled, created_from_template_version
  )
  select
    ws_id, t.role_key, t.default_name, t.default_handle, t.default_initials,
    t.default_accent, t.default_accent_dark, t.default_model_id,
    t.default_model_id, t.default_temperature, t.system_prompt,
    t.method_default, true, false, true, true, t.version
  from public.agent_role_templates t
  where t.role_key = 'buddy'
  on conflict (workspace_id, role_key)
    where is_system = true
  do nothing;

  insert into public.talks (
    workspace_id, folder_id, sort_order, title, created_by, is_system
  )
  values (ws_id, null, 0, 'Buddy', target_user_id, true)
  on conflict (workspace_id)
    where is_system = true
  do nothing;

  -- The system talk must stay live (it anchors the sidebar's pinned row).
  -- The app blocks archiving it; heal any direct-write drift, since an
  -- archived system talk would otherwise block the seed insert forever.
  update public.talks
  set archived_at = null
  where workspace_id = ws_id
    and is_system = true
    and archived_at is not null;

  -- Re-attach Buddy to the system talk if it ever goes missing. max+1 avoids
  -- colliding with existing (talk_id, sort_order) rows.
  insert into public.talk_agents (workspace_id, talk_id, agent_id, sort_order)
  select
    ws_id, t.id, a.id,
    coalesce((
      select max(ta.sort_order) + 1
      from public.talk_agents ta
      where ta.talk_id = t.id
    ), 0)
  from public.talks t
  join public.agents a
    on a.workspace_id = t.workspace_id
   and a.role_key = 'buddy'
   and a.is_system = true
  where t.workspace_id = ws_id
    and t.is_system = true
  on conflict (talk_id, agent_id) do nothing;

  for team_rec in
    select *
      from (values
        (
          'Pricing crew'::text,
          'Pricing, packaging, anything with money in it.'::text,
          'pricing'::text,
          array['strategist','critic','quant','editor']::text[]
        ),
        (
          'Research crew'::text,
          'Competitive work, teardowns, and factual analysis.'::text,
          'research'::text,
          array['researcher','critic','editor']::text[]
        ),
        (
          'Hiring crew'::text,
          'Loop design, role specs, and structured hiring decisions.'::text,
          'hiring'::text,
          array['researcher','critic','editor']::text[]
        )
      ) as v(name, description, icon, roles)
  loop
    insert into public.team_compositions (
      workspace_id, name, description, icon, is_default
    )
    values (
      ws_id, team_rec.name, team_rec.description, team_rec.icon, true
    )
    on conflict (workspace_id, name)
      where is_default = true
    -- Preserve edited team definitions on repeated bootstrap. Template
    -- membership changes should be handled by explicit migrations.
    do nothing
    returning id into seeded_team_id;

    if seeded_team_id is null then
      select id
        into seeded_team_id
        from public.team_compositions
        where workspace_id = ws_id
          and name = team_rec.name
          and is_default = true
        limit 1;
    end if;

    if seeded_team_id is null then
      continue;
    end if;

    -- Insert missing template roster edges on every bootstrap. Existing roster
    -- rows and extra rows are preserved; this repairs interrupted bootstrap
    -- without silently resetting edited sort_order values.
    role_sort := 0;
    foreach role in array team_rec.roles loop
      role_sort := role_sort + 1;
      select a.id
        into seeded_agent_id
        from public.agents a
        where a.workspace_id = ws_id
          and a.role_key = role
          and a.is_default = true
          and a.is_system = false
        limit 1;

      if seeded_agent_id is not null then
        insert into public.team_composition_agents (
          workspace_id, team_id, agent_id, sort_order
        )
        values (ws_id, seeded_team_id, seeded_agent_id, role_sort)
        on conflict (team_id, agent_id) do nothing;
      end if;
    end loop;
  end loop;

  return ws_id;
end;
$$;

-- =============================================================================
-- 4) Backfill existing workspaces now instead of waiting for each owner's
--    next bootstrap call, so workspace members never see a dead pinned row
--    while the owner is away. Mirrors the function's seeding, set-based.
-- =============================================================================

insert into public.agents (
  workspace_id, role_key, name, handle, initials, accent, accent_dark,
  model_id, default_model_id, temperature, persona, method, is_default,
  is_custom, is_system, enabled, created_from_template_version
)
select
  w.id, t.role_key, t.default_name, t.default_handle, t.default_initials,
  t.default_accent, t.default_accent_dark, t.default_model_id,
  t.default_model_id, t.default_temperature, t.system_prompt,
  t.method_default, true, false, true, true, t.version
from public.workspaces w
cross join public.agent_role_templates t
where t.role_key = 'buddy'
on conflict (workspace_id, role_key)
  where is_system = true
do nothing;

insert into public.talks (
  workspace_id, folder_id, sort_order, title, created_by, is_system
)
select w.id, null, 0, 'Buddy', w.owner_id, true
from public.workspaces w
on conflict (workspace_id)
  where is_system = true
do nothing;

insert into public.talk_agents (workspace_id, talk_id, agent_id, sort_order)
select
  t.workspace_id, t.id, a.id,
  coalesce((
    select max(ta.sort_order) + 1
    from public.talk_agents ta
    where ta.talk_id = t.id
  ), 0)
from public.talks t
join public.agents a
  on a.workspace_id = t.workspace_id
 and a.role_key = 'buddy'
 and a.is_system = true
where t.is_system = true
on conflict (talk_id, agent_id) do nothing;

-- =============================================================================
-- 5) DB-level enforcement: the system talk row and its roster cannot be
--    mutated by the authenticated role, so a direct Supabase client cannot
--    archive, rename, spoof, or re-roster Buddy. The bootstrap function is
--    SECURITY DEFINER (table owner — bypasses RLS) and the app accessors
--    already refuse these writes, so no legitimate path changes behavior.
--    Trusted runtime paths (last_activity_at bumps, queue consumer) run
--    elevated and are unaffected.
--
--    Shape notes:
--    - UPDATE keeps a broad USING because SELECT ... FOR UPDATE row locks
--      (chat-round serialization locks the talk row, including Buddy's)
--      must keep seeing the system talk; WITH CHECK is not evaluated for
--      locking, so writes of system rows still fail.
--    - is_system itself is excluded from the authenticated UPDATE column
--      grant so the flag cannot be flipped in either direction (policies
--      cannot reference OLD, so WITH CHECK alone cannot block un-flagging).
-- =============================================================================

drop policy talks_write on public.talks;
create policy talks_update on public.talks
  for update
  using       (public.is_workspace_writer(workspace_id))
  with check  (public.is_workspace_writer(workspace_id) and is_system = false);
create policy talks_insert on public.talks
  for insert
  with check  (public.is_workspace_writer(workspace_id) and is_system = false);
create policy talks_delete on public.talks
  for delete
  using       (public.is_workspace_writer(workspace_id) and is_system = false);

revoke update on public.talks from authenticated;
grant update (
  title, folder_id, sort_order, mode, rounds_limit, archived_at,
  last_activity_at, updated_at
) on public.talks to authenticated;

drop policy talk_agents_write on public.talk_agents;
create policy talk_agents_write on public.talk_agents
  for all
  using (
    public.is_workspace_writer(workspace_id)
    and not exists (
      select 1
      from public.talks t
      where t.workspace_id = talk_agents.workspace_id
        and t.id = talk_agents.talk_id
        and t.is_system = true
    )
  )
  with check (
    public.is_workspace_writer(workspace_id)
    and not exists (
      select 1
      from public.talks t
      where t.workspace_id = talk_agents.workspace_id
        and t.id = talk_agents.talk_id
        and t.is_system = true
    )
  );
