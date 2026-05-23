-- 0019_workspace_channels.sql
--
-- Connectors refactor PR 1 — promote per-Talk channel connectors to
-- workspace-global definitions. Each row defines a Slack or Telegram
-- target that any Talk can opt into via `talk_channel_links`. Admins
-- manage the pool from Settings → Connectors; member-owned talks pick
-- via a toggle list.
--
-- Mirrors the `workspace_provider_secrets` (0008) shape:
--   - workspace-scoped row (no `workspace_id` column — YAGNI on
--     multi-tenancy at solo-user MVP).
--   - SELECT for any authenticated user so the executor (PR 4) can
--     pick the row up regardless of which member triggered the run.
--   - INSERT/UPDATE/DELETE gated by
--     `public.current_user_is_workspace_admin()` (SECURITY DEFINER
--     helper introduced in 0008).
--
-- `talk_channel_links` follows the established talk-scoped pattern
-- (`talk_state_entries`, `talk_resource_bindings`, etc.): denormalize
-- `owner_id` and gate RLS on `owner_id = auth.uid()`. Join-through-talks
-- RLS is intentionally avoided — clawtalk has used the denormalized
-- pattern from 0001 and we keep it consistent here.
--
-- No `health_status` / `verification_status` columns in this migration.
-- Verification logic is PR 4 work; PR 1 ships data shape + RLS + CRUD.

-- ── workspace_channels ────────────────────────────────────────────
create table public.workspace_channels (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('slack', 'telegram')),
  display_name text not null,
  config_json jsonb not null default '{}'::jsonb,
  -- Optional credential blob. Nullable because admins may create a
  -- channel definition before pasting the bot token. Encryption uses
  -- the same pipeline as `workspace_provider_secrets.ciphertext`
  -- (`encryptProviderSecret`).
  ciphertext text,
  enc_key_version integer not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null
);
create index workspace_channels_kind_idx
  on public.workspace_channels (kind, display_name);
alter table public.workspace_channels enable row level security;

create policy workspace_channels_read
  on public.workspace_channels
  for select to authenticated
  using (true);

create policy workspace_channels_write
  on public.workspace_channels
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());

grant select, insert, update, delete
  on public.workspace_channels
  to authenticated;

-- ── talk_channel_links ────────────────────────────────────────────
-- Per-Talk opt-in. Presence of a row means the Talk's owner has
-- enabled this workspace-global channel for their Talk. Toggle off
-- deletes the row. `enabled` on `workspace_channels` is a separate
-- admin-side kill switch — PR 2 picker greys out toggles when the
-- workspace row is disabled.
create table public.talk_channel_links (
  talk_id uuid not null references public.talks(id) on delete cascade,
  channel_id uuid not null
    references public.workspace_channels(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (talk_id, channel_id)
);
create index talk_channel_links_channel_idx
  on public.talk_channel_links (channel_id);
alter table public.talk_channel_links enable row level security;

create policy talk_channel_links_owner
  on public.talk_channel_links
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.talk_channel_links
  to authenticated;

-- ── bound-talk-count helper ───────────────────────────────────────
-- SECURITY DEFINER so the count subquery on the Settings page (visible
-- to admins) returns the true global count, not just the rows the
-- caller can SELECT. RLS on `talk_channel_links` filters to
-- `owner_id = auth.uid()`, which would otherwise hide all other users'
-- links from the admin's aggregate.
create or replace function public.workspace_channel_bound_talk_count(
  channel_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint
  from public.talk_channel_links l
  where l.channel_id = workspace_channel_bound_talk_count.channel_id;
$$;
revoke all on function public.workspace_channel_bound_talk_count(uuid)
  from public;
grant execute on function public.workspace_channel_bound_talk_count(uuid)
  to authenticated;
