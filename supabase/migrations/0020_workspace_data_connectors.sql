-- 0020_workspace_data_connectors.sql
--
-- Connectors refactor PR 1 — workspace-global data connector
-- definitions for PostHog and Google Docs/Sheets. Direct analog of
-- 0019_workspace_channels.sql; same RLS shape, same talk-link table
-- pattern.
--
-- Note on `google_docs` / `google_sheets`: these stay in the
-- data-connector enum even though `talk_resource_bindings` already
-- supports `google_drive_folder` / `google_drive_file`. The execution
-- model collision (which path Google content executes through) is a
-- PR 4 decision. Until then, workspace `google_docs` / `google_sheets`
-- rows are pure-config containers — the folder ID lives on
-- `config_json` and the picker exposes them as toggles.

-- ── workspace_data_connectors ─────────────────────────────────────
create table public.workspace_data_connectors (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('posthog', 'google_docs', 'google_sheets')),
  display_name text not null,
  config_json jsonb not null default '{}'::jsonb,
  ciphertext text,
  enc_key_version integer not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null
);
create index workspace_data_connectors_kind_idx
  on public.workspace_data_connectors (kind, display_name);
alter table public.workspace_data_connectors enable row level security;

create policy workspace_data_connectors_read
  on public.workspace_data_connectors
  for select to authenticated
  using (true);

create policy workspace_data_connectors_write
  on public.workspace_data_connectors
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());

grant select, insert, update, delete
  on public.workspace_data_connectors
  to authenticated;

-- ── talk_data_connector_links ─────────────────────────────────────
create table public.talk_data_connector_links (
  talk_id uuid not null references public.talks(id) on delete cascade,
  data_connector_id uuid not null
    references public.workspace_data_connectors(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (talk_id, data_connector_id)
);
create index talk_data_connector_links_connector_idx
  on public.talk_data_connector_links (data_connector_id);
alter table public.talk_data_connector_links enable row level security;

create policy talk_data_connector_links_owner
  on public.talk_data_connector_links
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.talk_data_connector_links
  to authenticated;

-- ── bound-talk-count helper ───────────────────────────────────────
-- Mirrors `workspace_channel_bound_talk_count` (0019). See that
-- migration for the SECURITY DEFINER rationale.
create or replace function public.workspace_data_connector_bound_talk_count(
  data_connector_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint
  from public.talk_data_connector_links l
  where l.data_connector_id =
    workspace_data_connector_bound_talk_count.data_connector_id;
$$;
revoke all on function public.workspace_data_connector_bound_talk_count(uuid)
  from public;
grant execute on function public.workspace_data_connector_bound_talk_count(uuid)
  to authenticated;
