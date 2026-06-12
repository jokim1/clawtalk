-- Explicit multi-workspace creation.
--
-- First sign-in remains idempotent through ensure_user_workspace_bootstrap().
-- Creating an additional workspace is intentionally a separate function so the
-- app can later gate this operation on billing entitlement without changing the
-- workspace seed contract.

create or replace function public.seed_workspace_defaults(
  target_workspace_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_owner_id uuid;
  team_rec record;
  seeded_team_id uuid;
  role text;
  role_sort int;
  seeded_agent_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'cannot seed workspace for a different user'
      using errcode = 'CT100';
  end if;

  select w.owner_id
    into ws_owner_id
    from public.workspaces w
    where w.id = target_workspace_id
    limit 1;

  if ws_owner_id is null then
    raise exception 'workspace % does not exist', target_workspace_id
      using errcode = 'CT102';
  end if;

  if ws_owner_id <> target_user_id then
    raise exception 'workspace % is not owned by user %', target_workspace_id, target_user_id
      using errcode = 'CT103';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (target_workspace_id, target_user_id, 'owner')
  on conflict (workspace_id, user_id) do update set
    role = 'owner';

  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, method, is_default, is_custom,
    is_system, enabled, created_from_template_version
  )
  select
    target_workspace_id, t.role_key, t.default_name, t.default_handle,
    t.default_initials, t.default_accent, t.default_accent_dark,
    t.default_model_id, t.default_model_id, t.default_temperature,
    t.method_default, true, false, false, true, t.version
  from public.agent_role_templates t
  where t.role_key in ('strategist', 'critic', 'researcher', 'editor', 'quant')
  on conflict (workspace_id, role_key)
    where is_default = true and is_system = false
  do nothing;

  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, method, is_default, is_custom,
    is_system, enabled, created_from_template_version
  )
  select
    target_workspace_id, t.role_key, t.default_name, t.default_handle,
    t.default_initials, t.default_accent, t.default_accent_dark,
    t.default_model_id, t.default_model_id, t.default_temperature,
    t.method_default, true, false, true, true, t.version
  from public.agent_role_templates t
  where t.role_key in ('forge_rewriter', 'forge_critic')
  on conflict (workspace_id, role_key)
    where is_system = true
  do nothing;

  insert into public.agents (
    workspace_id, role_key, name, handle, initials, accent, accent_dark,
    model_id, default_model_id, temperature, persona, method, is_default,
    is_custom, is_system, enabled, created_from_template_version
  )
  select
    target_workspace_id, t.role_key, t.default_name, t.default_handle,
    t.default_initials, t.default_accent, t.default_accent_dark,
    t.default_model_id, t.default_model_id, t.default_temperature,
    t.system_prompt, t.method_default, true, false, true, true, t.version
  from public.agent_role_templates t
  where t.role_key = 'buddy'
  on conflict (workspace_id, role_key)
    where is_system = true
  do nothing;

  insert into public.talks (
    workspace_id, folder_id, sort_order, title, created_by, is_system
  )
  values (target_workspace_id, null, 0, 'Buddy', target_user_id, true)
  on conflict (workspace_id)
    where is_system = true
  do nothing;

  update public.talks
  set archived_at = null
  where workspace_id = target_workspace_id
    and is_system = true
    and archived_at is not null;

  insert into public.talk_agents (workspace_id, talk_id, agent_id, sort_order)
  select
    target_workspace_id, t.id, a.id,
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
  where t.workspace_id = target_workspace_id
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
    seeded_team_id := null;

    insert into public.team_compositions (
      workspace_id, name, description, icon, is_default
    )
    values (
      target_workspace_id, team_rec.name, team_rec.description,
      team_rec.icon, true
    )
    on conflict (workspace_id, name)
      where is_default = true
    do nothing
    returning id into seeded_team_id;

    if seeded_team_id is null then
      select id
        into seeded_team_id
        from public.team_compositions
        where workspace_id = target_workspace_id
          and name = team_rec.name
          and is_default = true
        limit 1;
    end if;

    if seeded_team_id is null then
      continue;
    end if;

    role_sort := 0;
    foreach role in array team_rec.roles loop
      role_sort := role_sort + 1;
      select a.id
        into seeded_agent_id
        from public.agents a
        where a.workspace_id = target_workspace_id
          and a.role_key = role
          and a.is_default = true
          and a.is_system = false
        limit 1;

      if seeded_agent_id is not null then
        insert into public.team_composition_agents (
          workspace_id, team_id, agent_id, sort_order
        )
        values (target_workspace_id, seeded_team_id, seeded_agent_id, role_sort)
        on conflict (team_id, agent_id) do nothing;
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.ensure_user_workspace_bootstrap(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id uuid;
  user_name text;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'cannot bootstrap workspace for a different user'
      using errcode = 'CT100';
  end if;

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

  perform public.seed_workspace_defaults(ws_id, target_user_id);

  return ws_id;
end;
$$;

create or replace function public.create_user_workspace(
  target_user_id uuid,
  workspace_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id uuid;
  normalized_name text;
  user_exists boolean;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'cannot create workspace for a different user'
      using errcode = 'CT100';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('clawtalk.create_user_workspace'),
    hashtext(target_user_id::text)
  );

  select exists(
    select 1 from public.users u where u.id = target_user_id
  ) into user_exists;

  if not user_exists then
    raise exception 'cannot create workspace for unknown user %', target_user_id
      using errcode = 'CT101';
  end if;

  normalized_name := nullif(btrim(workspace_name), '');
  if normalized_name is null or char_length(normalized_name) > 120 then
    raise exception 'workspace name must be between 1 and 120 characters'
      using errcode = 'CT104';
  end if;

  insert into public.workspaces (name, owner_id)
  values (normalized_name, target_user_id)
  returning id into ws_id;

  perform public.seed_workspace_defaults(ws_id, target_user_id);

  return ws_id;
end;
$$;

revoke all on function public.seed_workspace_defaults(uuid, uuid) from public;
revoke all on function public.create_user_workspace(uuid, text) from public;
grant execute on function public.create_user_workspace(uuid, text) to authenticated;
grant execute on function public.ensure_user_workspace_bootstrap(uuid) to authenticated;
