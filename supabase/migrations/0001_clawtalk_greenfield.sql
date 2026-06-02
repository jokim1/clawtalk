-- 0001_clawtalk_greenfield.sql
--
-- Fresh Supabase baseline for the ClawTalk greenfield cutover.
-- Applies to an empty/reset database. Do not prepend the legacy 0001-0038
-- migration stream and do not add compatibility DROP/ALTER cleanup here.
-- Cutover guardrail: do not run this through `supabase db push` against a
-- database that has recorded legacy migration versions. Reset/recreate the
-- target database and apply this baseline from zero.
-- Source material: docs/11-data-model.md. This file is the canonical
-- executable reset baseline; docs/canonical-greenfield-migration.sql is a
-- non-executable historical pointer kept only for older docs/PR links.

begin;

do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null
     and exists (select 1 from supabase_migrations.schema_migrations) then
    raise exception
      'clawtalk greenfield baseline requires an empty/reset Supabase database; found existing migration history'
      using errcode = 'CT900';
  end if;
end;
$$;

-- =============================================================================
-- STEP 1: Final-state runtime tables recreated directly (§11 §1 / §11 §11)
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

create table public.web_search_providers (
  id text primary key,
  name text not null,
  base_url text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext unique not null,
  name text not null,
  avatar_color text,
  initials text,
  preferred_web_search_provider_id text references public.web_search_providers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_email_idx on public.users (email);

create table public.web_search_provider_secrets (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.web_search_providers(id) on delete cascade,
  enc_key_version integer not null default 1,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id)
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name, created_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email, ''), '@', 1), 'User'),
    coalesce(new.created_at, now())
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create table public.settings_kv (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);

create table public.event_outbox (
  event_id bigserial primary key,
  topic text not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index event_outbox_topic_idx on public.event_outbox (topic, event_id);

create table public.idempotency_cache (
  idempotency_key text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  method text not null,
  path text not null,
  request_hash text not null,
  status_code integer not null,
  response_body text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (idempotency_key, user_id, method, path)
);
create index idempotency_cache_expires_idx on public.idempotency_cache (expires_at);

create table public.llm_providers (
  id text primary key,
  name text not null,
  provider_kind text not null check (provider_kind in ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
  api_format text not null check (api_format in ('anthropic_messages', 'openai_chat_completions', 'codex_responses')),
  base_url text not null,
  auth_scheme text not null check (auth_scheme in ('x_api_key', 'bearer')),
  enabled boolean not null default true,
  core_compatibility text not null default 'none' check (core_compatibility in ('none', 'claude_sdk_proxy')),
  response_start_timeout_ms integer,
  stream_idle_timeout_ms integer,
  absolute_timeout_ms integer,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);

create table public.llm_provider_models (
  provider_id text not null references public.llm_providers(id) on delete cascade,
  model_id text not null,
  display_name text not null,
  context_window_tokens integer not null,
  default_max_output_tokens integer not null,
  default_ttft_timeout_ms integer,
  enabled boolean not null default true,
  capabilities_json jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  primary key (provider_id, model_id)
);
create unique index llm_provider_models_model_id_unique
  on public.llm_provider_models (model_id);

create table public.llm_provider_secrets (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  credential_kind text not null default 'api_key' check (credential_kind in ('api_key', 'subscription')),
  enc_key_version integer not null default 1,
  ciphertext text not null,
  encrypted_refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id, credential_kind)
);

create table public.llm_provider_verifications (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  credential_kind text not null default 'api_key' check (credential_kind in ('api_key', 'subscription')),
  status text not null check (status in ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
  last_verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id, credential_kind)
);

create table public.llm_ttft_stats (
  provider_id text not null,
  model_id text not null,
  sample_count integer not null default 0,
  p50_ms double precision not null default 0,
  p95_ms double precision not null default 0,
  p99_ms double precision not null default 0,
  max_ms double precision not null default 0,
  last_updated_at timestamptz not null default now(),
  primary key (provider_id, model_id),
  foreign key (provider_id, model_id)
    references public.llm_provider_models(provider_id, model_id) on delete cascade
);

insert into public.llm_providers (
  id, name, provider_kind, api_format, base_url, auth_scheme,
  enabled, response_start_timeout_ms, stream_idle_timeout_ms, absolute_timeout_ms
) values
  ('provider.anthropic', 'Claude (Anthropic)', 'anthropic', 'anthropic_messages', 'https://api.anthropic.com', 'x_api_key', true, 60000, 20000, 300000),
  ('provider.openai', 'OpenAI', 'openai', 'openai_chat_completions', 'https://api.openai.com/v1', 'bearer', true, 60000, 20000, 300000),
  ('provider.openai_codex', 'ChatGPT Codex (Subscription)', 'openai', 'codex_responses', 'https://chatgpt.com/backend-api/codex', 'bearer', true, 120000, 60000, 1800000),
  ('provider.gemini', 'Google / Gemini', 'gemini', 'openai_chat_completions', 'https://generativelanguage.googleapis.com/v1beta/openai', 'bearer', true, 90000, 20000, 300000),
  ('provider.nvidia', 'NVIDIA NIM', 'nvidia', 'openai_chat_completions', 'https://integrate.api.nvidia.com/v1', 'bearer', true, 90000, 60000, 300000)
on conflict (id) do update set
  name = excluded.name,
  provider_kind = excluded.provider_kind,
  api_format = excluded.api_format,
  base_url = excluded.base_url,
  auth_scheme = excluded.auth_scheme,
  enabled = excluded.enabled,
  response_start_timeout_ms = excluded.response_start_timeout_ms,
  stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
  absolute_timeout_ms = excluded.absolute_timeout_ms,
  updated_at = now();

insert into public.llm_provider_models (
  provider_id, model_id, display_name, context_window_tokens,
  default_max_output_tokens, default_ttft_timeout_ms, enabled, capabilities_json
) values
  ('provider.anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 200000, 8192, 60000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 200000, 8192, 60000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 200000, 8192, 45000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 8192, 30000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.openai', 'gpt-5-mini', 'GPT-5 Mini', 128000, 4096, 30000, true, '{"supports_tools":false,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":false,"supports_json_schema":false,"supports_long_context":false,"max_images":64,"accepted_image_formats":["image/jpeg","image/png"]}'::jsonb),
  ('provider.openai_codex', 'gpt-5.4', 'GPT-5.4', 128000, 8192, 60000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.openai_codex', 'gpt-5.4-mini', 'GPT-5.4 Mini', 128000, 8192, 45000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.openai_codex', 'gpt-5.3-codex', 'GPT-5.3 Codex', 400000, 128000, 45000, true, '{"supports_tools":true,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":true,"supports_json_schema":false,"supports_long_context":true}'::jsonb),
  ('provider.gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000, 8192, 45000, true, '{"supports_tools":false,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":false,"supports_json_schema":false,"supports_long_context":false,"max_images":64,"accepted_image_formats":["image/jpeg","image/png"]}'::jsonb),
  ('provider.nvidia', 'moonshotai/kimi-k2.6', 'Kimi 2.6 (NVIDIA)', 262144, 16384, 60000, true, '{"supports_tools":false,"supports_streaming":true,"supports_vision":true,"supports_pdf_documents":false,"supports_json_schema":false,"supports_long_context":false,"max_images":4,"accepted_image_formats":["image/jpeg","image/png"]}'::jsonb)
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  capabilities_json = excluded.capabilities_json,
  updated_at = now();

insert into public.settings_kv (key, value)
values ('executor.defaultClaudeModel', 'claude-opus-4-8')
on conflict (key) do update set
  value = excluded.value,
  updated_at = now();

-- =============================================================================
-- STEP 3: Trigger function + RLS helper definitions (§11 §0 / §5 / §8 / §12)
-- =============================================================================

-- 3.1. Universal updated_at toucher (§11 §0)
create or replace function public.tg_touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 3.2. Workspace membership helpers (§11 §12)
-- Use plpgsql (not language sql) so the table reference binds at execution time —
-- workspace_members is created later in this migration.
create or replace function public.is_workspace_member(ws uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare
  found_row boolean;
begin
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = auth.uid()
  ) into found_row;
  return found_row;
end;
$$;

create or replace function public.is_workspace_admin(ws uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare
  found_row boolean;
begin
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws
      and user_id = auth.uid()
      and role in ('owner','admin')
  ) into found_row;
  return found_row;
end;
$$;

create or replace function public.is_workspace_writer(ws uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare
  found_row boolean;
begin
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws
      and user_id = auth.uid()
      and role in ('owner','admin','member')
  ) into found_row;
  return found_row;
end;
$$;

-- 3.3. doc_tabs last-tab guard (§11 §5)
create or replace function public.doc_tabs_block_last_delete() returns trigger
  language plpgsql as $$
declare
  remaining int;
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  select count(*) into remaining from public.doc_tabs
    where document_id = old.document_id and id <> old.id;
  if remaining = 0 then
    raise exception 'cannot delete the last tab of document %', old.document_id
      using errcode = 'CT001';
  end if;
  return old;
end;
$$;

-- 3.4. document_edits CAS bump on accept (§11 §5)
create or replace function public.document_edits_bump_versions_on_accept() returns trigger
  language plpgsql as $$
begin
  if new.status = 'accepted' and (old.status is distinct from 'accepted') then
    if new.op = 'insert' then
      update public.doc_tabs
        set list_version = list_version + 1
        where id = new.tab_id;
      update public.document_edits
        set status = 'superseded', resolved_at = now()
        where tab_id = new.tab_id
          and op = 'insert'
          and status = 'pending'
          and ((new.after_block_id is null and after_block_id is null)
               or after_block_id = new.after_block_id)
          and not (
            new.proposed_by_run_id is not null
            and proposed_by_run_id = new.proposed_by_run_id
          )
          and id <> new.id;
    elsif new.op in ('replace','delete') then
      update public.doc_blocks
        set version = version + 1
        where id = new.block_id;
      update public.document_edits
        set status = 'superseded', resolved_at = now()
        where block_id = new.block_id
          and op in ('replace','delete')
          and status = 'pending'
          and id <> new.id;
    end if;
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

-- 3.5. jobs agent-clear → blocked transition (§11 §8)
create or replace function public.set_job_blocked_agent_missing() returns trigger
  language plpgsql as $$
begin
  new.status := 'blocked';
  new.block_reason := 'agent_missing';
  new.next_due_at := null;
  new.claimed_at := null;
  return new;
end;
$$;

-- 3.6. jobs roster-invariant guard (§11 §8)
create or replace function public.jobs_require_agent_in_roster() returns trigger
  language plpgsql as $$
begin
  if new.agent_id is null then
    return new;  -- nullable agent_id is handled by set_job_blocked_agent_missing
  end if;
  perform 1 from public.talk_agents
    where workspace_id = new.workspace_id
      and talk_id = new.talk_id
      and agent_id = new.agent_id;
  if not found then
    raise exception 'job agent % is not in talk_agents for talk %', new.agent_id, new.talk_id
      using errcode = 'CT002';
  end if;
  return new;
end;
$$;

create or replace function public.jobs_block_identity_change() returns trigger
  language plpgsql as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.talk_id is distinct from old.talk_id
     or new.created_by is distinct from old.created_by then
    raise exception 'job workspace_id, talk_id, and created_by are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- =============================================================================
-- STEP 4: Create greenfield tables in dependency order (§11 §1–§10)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §1 Identity & tenancy
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  owner_id uuid not null references public.users(id) on delete cascade,
  plan text not null default 'team' check (plan in ('team','enterprise')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','guest')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.provider_oauth_states (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.llm_providers(id) on delete cascade,
  scope text not null check (scope in ('user', 'workspace')),
  flow_kind text not null check (flow_kind in ('pkce', 'device_code')),
  state text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  code_verifier text,
  device_auth_id text,
  user_code text,
  return_path text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_id, state)
);
create index provider_oauth_states_user_idx on public.provider_oauth_states (user_id, created_at desc);
create index provider_oauth_states_expires_idx on public.provider_oauth_states (provider_id, expires_at desc);

create table public.oauth_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  state_hash text not null unique,
  nonce_hash text not null,
  code_verifier_hash text not null,
  code_verifier text,
  redirect_uri text not null,
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index oauth_state_expires_at_idx on public.oauth_state (expires_at);
create index oauth_state_user_idx on public.oauth_state (user_id, created_at desc);

create table public.user_tool_permissions (
  user_id uuid not null references public.users(id) on delete cascade,
  tool_id text not null,
  allowed boolean not null default true,
  requires_approval boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool_id)
);
create index user_tool_permissions_user_idx on public.user_tool_permissions (user_id);

-- Workspace-shared LLM credentials are tenant-scoped in the greenfield model.
create table public.workspace_provider_secrets (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  credential_kind text not null default 'api_key' check (credential_kind in ('api_key', 'subscription')),
  enc_key_version integer not null default 1,
  ciphertext text not null,
  encrypted_refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  primary key (workspace_id, provider_id, credential_kind)
);

create table public.workspace_provider_verifications (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  credential_kind text not null default 'api_key' check (credential_kind in ('api_key', 'subscription')),
  status text not null check (status in ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
  last_verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider_id, credential_kind)
);

-- ---------------------------------------------------------------------------
-- §2 Folders
-- ---------------------------------------------------------------------------

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  sort_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index on public.folders (workspace_id, sort_order);

-- ---------------------------------------------------------------------------
-- §3 Talks (talks first; talk_agents/messages/runs/etc. after §4 agents exist)
-- ---------------------------------------------------------------------------

create table public.talks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  folder_id uuid,
  sort_order int not null,
  title text not null,
  mode text not null default 'ordered' check (mode in ('ordered','parallel')),
  rounds_limit int not null default 3 check (rounds_limit in (1,2,3,5)),
  created_by uuid not null references public.users(id) on delete restrict,
  archived_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, folder_id) references public.folders(workspace_id, id) on delete set null (folder_id)
);
create index on public.talks (workspace_id, folder_id, sort_order) where archived_at is null;

-- ---------------------------------------------------------------------------
-- §4 Agents (templates, agents, team_compositions, team_composition_agents)
-- ---------------------------------------------------------------------------

create table public.agent_role_templates (
  role_key text primary key
    check (role_key in ('strategist','critic','researcher','editor','quant','forge_rewriter','forge_critic')),
  default_name text not null,
  default_handle text not null,
  default_initials text not null,
  default_accent text not null,
  default_accent_dark text,
  default_model_id text references public.llm_provider_models(model_id),
  default_temperature numeric not null,
  job text not null,
  system_prompt text not null,
  method_default text[] not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role_key text not null references public.agent_role_templates(role_key),
  name text not null,
  handle text not null,
  initials text not null,
  accent text not null,
  accent_dark text,
  model_id text not null references public.llm_provider_models(model_id),
  default_model_id text not null references public.llm_provider_models(model_id),
  temperature numeric not null,
  persona_role text,
  persona text,
  focus text,
  method text[] not null default '{}',
  capabilities text[] not null default '{}',
  is_default boolean not null default false,
  is_custom boolean not null default false,
  is_system boolean not null default false,
  enabled boolean not null default true,
  credential_mode text check (credential_mode in ('api_key','subscription')),
  model_auto_upgraded_from text,
  model_auto_upgraded_at timestamptz,
  created_from_template_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index on public.agents (workspace_id) where is_system = false;
create unique index agents_default_role_unique
  on public.agents (workspace_id, role_key)
  where is_default = true and is_system = false;
create unique index agents_system_role_unique
  on public.agents (workspace_id, role_key)
  where is_system = true;

create table public.team_compositions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  icon text,
  is_default boolean not null default false,
  runs_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index team_compositions_default_name_unique
  on public.team_compositions (workspace_id, name)
  where is_default = true;

create table public.team_composition_agents (
  workspace_id uuid not null,
  team_id uuid not null,
  agent_id uuid not null,
  sort_order int,
  primary key (team_id, agent_id),
  foreign key (workspace_id, team_id)  references public.team_compositions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §3 Talks continued: talk_agents (now agents exists)
-- ---------------------------------------------------------------------------

create table public.talk_agents (
  workspace_id uuid not null,
  talk_id uuid not null,
  agent_id uuid not null,
  sort_order int not null,
  added_at timestamptz not null default now(),
  primary key (talk_id, agent_id),
  unique (talk_id, sort_order),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 talk_agent_snapshots (per-run frozen roster); referenced by messages.agent_snapshot_id
-- ---------------------------------------------------------------------------

create table public.talk_agent_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  snapshot_group_id uuid not null,
  source_agent_id uuid,
  role_key text not null,
  name text,
  handle text,
  initials text,
  accent text,
  accent_dark text,
  provider_id text not null references public.llm_providers(id) on delete restrict,
  model_id text not null references public.llm_provider_models(model_id),
  temperature numeric not null,
  persona text,
  focus text,
  method text[],
  sort_order int not null,
  role_template_version int,
  global_policy_version int,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  unique (workspace_id, talk_id, snapshot_group_id, id),
  unique (snapshot_group_id, source_agent_id),
  foreign key (provider_id, model_id)
    references public.llm_provider_models(provider_id, model_id) on delete restrict,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_agent_id) references public.agents(workspace_id, id) on delete set null (source_agent_id)
);
create index on public.talk_agent_snapshots (snapshot_group_id);

-- ---------------------------------------------------------------------------
-- §3 messages + runs (mutual references; back-edges deferred)
-- ---------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  round int not null,
  author_kind text not null check (author_kind in ('user','agent')),
  author_user_id uuid references public.users(id) on delete restrict,
  agent_snapshot_id uuid,
  run_id uuid,                                                       -- back-edge; FK added later deferrable
  body text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  check (
    (author_kind = 'user'  and author_user_id is not null and agent_snapshot_id is null and run_id is null) or
    (author_kind = 'agent' and author_user_id is null     and agent_snapshot_id is not null and run_id is not null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, agent_snapshot_id)
    references public.talk_agent_snapshots(workspace_id, talk_id, id)
);
create index on public.messages (talk_id, round, created_at);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  round int not null,
  run_kind text not null default 'conversation'
    check (run_kind in ('conversation','content_improvement')),
  snapshot_group_id uuid not null,
  agent_snapshot_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued','running','awaiting','completed','failed','cancelled')),
  model_id text not null references public.llm_provider_models(model_id),
  requested_by uuid not null references public.users(id) on delete restrict,
  trigger_message_id uuid,                                           -- back-edge to messages; deferrable
  job_id uuid,                                                       -- forward FK to jobs; added later deferrable (jobs created in §8)
  trigger text not null default 'user' check (trigger in ('user','scheduler','manual')),
  scheduled_for timestamptz,
  response_group_id text not null
    check (length(response_group_id) between 1 and 64),
  sequence_index int not null check (sequence_index >= 0),
  prompt_snapshot_id uuid,                                           -- forward FK to run_prompt_snapshots; deferrable
  tokens_in int,
  tokens_out int,
  error_json jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  check (
    (trigger = 'user'      and job_id is null and scheduled_for is null) or
    (trigger = 'scheduler' and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is not null) or
    (trigger = 'manual'    and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, snapshot_group_id, agent_snapshot_id)
    references public.talk_agent_snapshots(workspace_id, talk_id, snapshot_group_id, id)
);
create index on public.runs (talk_id, round);
create index on public.runs (status) where status in ('queued','running');
create index on public.runs (response_group_id, sequence_index);
create index on public.runs (job_id, created_at);

-- Partial unique: single-flight per job (one non-terminal run per job at a time)
create unique index runs_one_active_per_job
  on public.runs (job_id) where job_id is not null and status in ('queued','running','awaiting');

-- Partial unique: slot identity per (job, scheduled_for); prevents double-fire
create unique index runs_one_per_job_slot
  on public.runs (job_id, scheduled_for) where job_id is not null and scheduled_for is not null;

-- Back-edge FKs (deferrable) for cycles
alter table public.messages
  add constraint messages_run_id_fkey
  foreign key (workspace_id, talk_id, run_id)
  references public.runs(workspace_id, talk_id, id)
  deferrable initially deferred;

alter table public.runs
  add constraint runs_trigger_message_id_fkey
  foreign key (workspace_id, talk_id, trigger_message_id)
  references public.messages(workspace_id, talk_id, id)
  deferrable initially deferred;

create table public.message_provider_replay (
  workspace_id uuid not null,
  talk_id uuid not null,
  message_id uuid not null,
  run_id uuid not null,
  -- Denormalized audit metadata. Replay reads load by message_id and scope via
  -- the message's agent snapshot, so this intentionally has no secondary index.
  source_agent_id uuid,
  provider_id text not null,
  model_id text not null,
  provider_data_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, message_id),
  foreign key (workspace_id, talk_id, message_id) references public.messages(workspace_id, talk_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, run_id) references public.runs(workspace_id, talk_id, id) on delete cascade,
  foreign key (workspace_id, source_agent_id) references public.agents(workspace_id, id) on delete set null (source_agent_id)
);
create index message_provider_replay_run_idx
  on public.message_provider_replay (workspace_id, talk_id, run_id);

-- ---------------------------------------------------------------------------
-- §4 run_prompt_snapshots (one per run); back-edge to runs.prompt_snapshot_id deferred
-- ---------------------------------------------------------------------------

create table public.run_prompt_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  talk_id uuid not null,
  agent_snapshot_id uuid not null,
  model_id text not null references public.llm_provider_models(model_id),
  provider text not null,
  global_policy_version int,
  role_template_version int,
  prompt_assembly_version int,
  context_manifest_json jsonb,
  tool_manifest_json jsonb,
  prompt_hash text,
  prompt_text_redacted text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, run_id),
  foreign key (workspace_id, run_id) references public.runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_snapshot_id) references public.talk_agent_snapshots(workspace_id, id)
);

alter table public.runs
  add constraint runs_prompt_snapshot_id_fkey
  foreign key (workspace_id, prompt_snapshot_id)
  references public.run_prompt_snapshots(workspace_id, id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- §3 talk_reads (per-user read state)
-- ---------------------------------------------------------------------------

create table public.talk_reads (
  workspace_id uuid not null,
  talk_id uuid not null,
  user_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (talk_id, user_id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 agent_feedback_events
-- ---------------------------------------------------------------------------

create table public.agent_feedback_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid,
  talk_id uuid,
  message_id uuid,
  kind text not null
    check (kind in ('useful','not_useful','too_verbose','off_role','missed_evidence','wrong_model','accepted_doc_edit','rejected_doc_edit','user_referenced_agent')),
  actor_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, agent_id)   references public.agents(workspace_id, id)   on delete cascade,
  foreign key (workspace_id, talk_id)    references public.talks(workspace_id, id)    on delete cascade,
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 llm_models view (over llm_provider_models)
-- ---------------------------------------------------------------------------

create view public.llm_models as
  select
    model_id              as id,
    provider_id           as provider,
    display_name,
    enabled,
    capabilities_json
  from public.llm_provider_models;

-- ---------------------------------------------------------------------------
-- §5 Documents (tabs, blocks, edits, coeditors)
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  primary_talk_id uuid,
  folder_id uuid,
  title text not null,
  format text not null check (format in ('markdown','html')),
  word_count int not null default 0,
  last_edit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, primary_talk_id) references public.talks(workspace_id, id) on delete set null (primary_talk_id),
  foreign key (workspace_id, folder_id) references public.folders(workspace_id, id) on delete set null (folder_id)
);
create unique index on public.documents (primary_talk_id) where primary_talk_id is not null;

create table public.doc_tabs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  title text not null,
  sort_order int not null,
  list_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, sort_order),
  unique (workspace_id, id),
  unique (workspace_id, document_id, id),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade
);

create table public.doc_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid not null,
  sort_order int not null,
  version int not null default 1,
  kind text not null check (kind in ('h1','h2','p','li','meta','code')),
  text text not null default '',
  attrs_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tab_id, sort_order),
  unique (workspace_id, id),
  unique (workspace_id, document_id, id),
  unique (workspace_id, document_id, tab_id, id),
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade
);
create index on public.doc_blocks (tab_id, sort_order);
create index on public.doc_blocks (document_id);

create table public.document_edits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid not null,
  block_id uuid,
  base_block_version int,
  base_list_version int,
  after_block_id uuid,
  proposed_by_agent_id uuid,
  proposed_by_run_id uuid,
  op text not null check (op in ('insert','replace','delete')),
  new_kind text,
  new_text text,
  new_attrs_json jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  source text not null default 'agent' check (source in ('agent','forge','job')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (
    (op = 'insert'  and block_id is null     and base_list_version  is not null and new_kind is not null and new_text is not null) or
    (op = 'replace' and block_id is not null and base_block_version is not null and new_text is not null) or
    (op = 'delete'  and block_id is not null and base_block_version is not null)
  ),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id) references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id, block_id)
    references public.doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id, after_block_id)
    references public.doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,
  foreign key (workspace_id, proposed_by_agent_id) references public.agents(workspace_id, id) on delete set null (proposed_by_agent_id),
  foreign key (workspace_id, proposed_by_run_id) references public.runs(workspace_id, id) on delete set null (proposed_by_run_id)
);
create index on public.document_edits (document_id) where status = 'pending';

create table public.doc_tab_coeditors (
  workspace_id uuid not null,
  tab_id uuid not null,
  agent_id uuid not null,
  primary key (tab_id, agent_id),
  foreign key (workspace_id, tab_id) references public.doc_tabs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §6 Context, tools, connectors
-- ---------------------------------------------------------------------------

create table public.context_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  kind text not null check (kind in ('document','url','file','past_talk','rule','news')),
  name text not null,
  source_document_id uuid,
  source_talk_id uuid,
  payload_ref text,
  extracted_text text,
  summary text,
  meta_json jsonb not null default '{}',
  expected_page_count int,                     -- PDF page-rasterization: # page images expected; completeness = count(context_source_pages) = this. null for non-PDFs.
  include_in_prompt boolean not null default true,
  sort_order int,
  added_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'document'  and source_document_id is not null and source_talk_id is null) or
    (kind = 'past_talk' and source_talk_id is not null     and source_document_id is null) or
    (kind in ('url','file','rule','news') and source_document_id is null and source_talk_id is null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_talk_id) references public.talks(workspace_id, id) on delete cascade,
  unique (workspace_id, id)
);
-- Optional compatibility aliases only. Active greenfield source refs are
-- context_sources.id::text; creation paths do not write meta_json.sourceRef.
create unique index context_sources_legacy_source_ref_unique
  on public.context_sources (workspace_id, talk_id, (upper(meta_json->>'sourceRef')))
  where kind <> 'rule' and meta_json ? 'sourceRef';
create index context_sources_prompt_lookup_idx
  on public.context_sources (talk_id, sort_order, created_at, id)
  where kind <> 'rule' and include_in_prompt = true;
create unique index context_sources_goal_unique
  on public.context_sources (workspace_id, talk_id)
  where kind = 'rule' and meta_json->>'compatKind' = 'goal';

-- PDF page-rasterization: one row per page JPEG for vision-but-not-PDF models
-- (gpt-5-mini, gemini-2.5-flash, kimi-k2.6). Attached alongside extracted_text
-- (raster is pixels-only; the text keeps exact quotes). Per `11` §6 design note.
create table public.context_source_pages (
  workspace_id uuid not null,
  source_id uuid not null,
  page_index int not null check (page_index >= 0),
  byte_size int not null check (byte_size >= 0),
  payload_ref text not null,                   -- R2 key: attachments/{talk_id}/{source_id}/page-{page_index}.jpg
  created_at timestamptz not null default now(),
  primary key (source_id, page_index),
  foreign key (workspace_id, source_id) references public.context_sources(workspace_id, id) on delete cascade
);

create table public.talk_tools (
  workspace_id uuid not null,
  talk_id uuid not null,
  tool_id text not null,
  enabled boolean not null default false,
  primary key (talk_id, tool_id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);

create table public.connector_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  enc_key_version int not null default 1,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  service text not null check (service in ('slack','gdrive','gmail','linear','github','notion')),
  authorized boolean not null default false,
  authorized_at timestamptz,
  secret_ref uuid,
  config_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, secret_ref) references public.connector_secrets(workspace_id, id) on delete set null (secret_ref)
);
create unique index connectors_talk_resource_singleton_uniq
  on public.connectors(workspace_id, service)
  where config_json->>'compatSurface' = 'talk_resource';
create unique index connectors_google_tools_user_uniq
  on public.connectors(
    workspace_id,
    service,
    (coalesce(config_json->>'authorizedByUserId', ''))
  )
  where config_json->>'compatSurface' = 'google_tools';
create unique index connectors_slack_install_team_uniq
  on public.connectors(
    workspace_id,
    service,
    (coalesce(config_json->>'teamId', config_json->>'workspace_id'))
  )
  where service = 'slack' and config_json->>'compatSurface' = 'slack_install';
create unique index connectors_slack_channel_target_uniq
  on public.connectors(
    workspace_id,
    service,
    (coalesce(config_json->>'teamId', config_json->>'workspace_id')),
    (config_json->>'channel_id')
  )
  where service = 'slack'
    and config_json->>'compatSurface' = 'channel'
    and coalesce(config_json->>'teamId', config_json->>'workspace_id') is not null
    and config_json->>'channel_id' is not null;
-- OAuth-service singleton rows are only the final native connector shape.
-- Compatibility data_connector/google_tools/talk_resource/slack_install rows
-- carry explicit compatSurface values and are intentionally excluded.
create unique index connectors_oauth_service_uniq
  on public.connectors(workspace_id, service)
  where config_json->>'compatSurface' is null;

create table public.connector_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connector_id uuid not null,
  talk_id uuid not null,
  target text,
  scope text[] not null default '{}',
  enabled boolean not null default true,
  display_name text,
  meta_json jsonb not null default '{}',
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, connector_id) references public.connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);
create unique index connector_bindings_default_target_uniq
  on public.connector_bindings(connector_id, talk_id)
  where target is null;
-- Upserts must name the matching partial-conflict target:
--   ON CONFLICT (connector_id, talk_id) WHERE target IS NULL
-- for default Talk links, and the full target tuple below for resource links.
create unique index connector_bindings_target_uniq
  on public.connector_bindings(
    connector_id,
    talk_id,
    target,
    created_by_user_id,
    (coalesce(meta_json->>'resourceKind', ''))
  )
  where target is not null;

-- ---------------------------------------------------------------------------
-- §8 Jobs (before §7 home_inbox_items which references jobs)
-- ---------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  talk_id uuid not null,
  created_by uuid not null references public.users(id) on delete restrict,
  title text not null,
  prompt text not null,
  agent_id uuid,
  schedule_json jsonb not null,
  timezone text not null,
  emit_talk_message bool not null default true,
  emit_document_append bool not null default false,
  check (emit_talk_message or emit_document_append),
  source_scope_json jsonb not null default '{"allow_web":false,"tool_ids":[]}',
  status text not null default 'active' check (status in ('active','paused','blocked')),
  block_reason text
    check (block_reason is null or block_reason in ('agent_missing','model_disabled','no_primary_document','tool_not_enabled','connector_not_authorized')),
  catch_up text not null default 'skip' check (catch_up in ('skip','run_once')),
  next_due_at timestamptz,
  claimed_at timestamptz,
  archived_at timestamptz,
  last_run_at timestamptz,
  last_run_status text check (last_run_status is null or last_run_status in ('completed','failed','cancelled')),
  run_count int not null default 0 check (run_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (archived_at is not null) or
    (status = 'active' and next_due_at is not null) or
    (status in ('paused','blocked') and next_due_at is null)
  ),
  unique (workspace_id, id),
  foreign key (workspace_id, talk_id)  references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete set null (agent_id)
);
create index jobs_due_unclaimed_idx
  on public.jobs (next_due_at, created_at, id)
  include (workspace_id, talk_id)
  where status = 'active' and archived_at is null and claimed_at is null;
create index jobs_due_retry_ready_idx
  on public.jobs (claimed_at, next_due_at, created_at, id)
  include (workspace_id, talk_id)
  where status = 'active' and archived_at is null and claimed_at is not null;

-- Now wire runs.job_id FK (jobs exists)
alter table public.runs
  add constraint runs_job_id_fkey
  foreign key (workspace_id, job_id) references public.jobs(workspace_id, id) on delete restrict;

-- RLS-preserving view for active jobs hot path
create view public.jobs_active with (security_invoker = true) as
  select * from public.jobs where archived_at is null;

-- ---------------------------------------------------------------------------
-- §7 Home (activity_events, home_inbox_items, recommendations, news, ranking, algorithms)
-- ---------------------------------------------------------------------------

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','agent','system','scheduler')),
  actor_id uuid,
  event_type text not null,
  talk_id uuid,
  document_id uuid,
  run_id uuid,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)     references public.talks(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id)      references public.runs(workspace_id, id)      on delete cascade
);
create index on public.activity_events (workspace_id, created_at desc);

-- home_news_items: shared global pool — NO workspace_id
create table public.home_news_items (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null,
  title text not null,
  source text,
  source_domain text,
  published_at timestamptz,
  excerpt text,
  raw_provider_json jsonb,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (content_hash)
);
create index on public.home_news_items (published_at desc);

create table public.home_news_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  talk_id uuid not null,
  summary text not null,
  mode text not null check (mode in ('work_context','topic_feed','balanced')),
  decision_type text not null check (decision_type in ('pricing','launch','research','hiring','product','technical','market','other')),
  keywords_json jsonb not null default '[]',
  entities_json jsonb not null default '[]',
  source_domains_json jsonb not null default '[]',
  negative_terms_json jsonb not null default '[]',
  freshness_horizon_days int not null default 14,
  sensitivity text not null default 'normal' check (sensitivity in ('normal','private','do_not_search')),
  confidence numeric,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);

create table public.home_news_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  news_item_id uuid not null references public.home_news_items(id) on delete cascade,
  topic_id uuid not null,
  talk_id uuid not null,
  matched_on_json jsonb not null default '{}',
  impact text not null check (impact in ('changes_assumption','adds_evidence','updates_competitor','introduces_risk','provides_tactic','topic_update','community_signal','background_only')),
  why_it_matters text,
  score numeric,
  confidence numeric,
  status text not null default 'active' check (status in ('active','snoozed','added_to_context','not_relevant','expired')),
  algorithm_version text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, topic_id) references public.home_news_topics(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)  references public.talks(workspace_id, id)             on delete cascade,
  unique (workspace_id, news_item_id, topic_id)
);
create index on public.home_news_matches (workspace_id, status, score desc);

create table public.home_inbox_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null check (type in (
    'agent_replied','round_completed','agent_asks_user','run_failed','doc_edits_ready',
    'connector_needs_auth','news_context_added','long_running_run','system_limit_reached',
    'forge_run_needs_review','job_output_ready','job_blocked'
  )),
  target_kind text check (target_kind in ('talk','document','connector','news','job','system')),
  target_json jsonb not null default '{}',
  talk_id uuid,
  document_id uuid,
  run_id uuid,
  tab_id uuid,
  news_item_id uuid,
  connector_id uuid,
  job_id uuid,
  ref_id uuid,
  severity text not null check (severity in ('info','action','blocking')),
  status text not null default 'unread' check (status in ('unread','read','resolved','dismissed','snoozed','expired')),
  title text not null,
  summary text,
  reason text,
  primary_action_json jsonb,
  secondary_actions_json jsonb not null default '[]',
  source_event_ids_json jsonb not null default '[]',
  group_key text,
  score numeric,
  algorithm_version text,
  snoozed_until timestamptz,
  resolved_at timestamptz,
  due_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)     references public.talks(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id)      references public.runs(workspace_id, id)      on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, connector_id) references public.connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, job_id)       references public.jobs(workspace_id, id)       on delete restrict,
  foreign key (news_item_id)               references public.home_news_items(id)           on delete cascade
);
create unique index home_inbox_items_dedup
  on public.home_inbox_items (workspace_id, type, ref_id) where ref_id is not null;
create index on public.home_inbox_items (workspace_id, status, created_at desc);

create table public.home_recommendation_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),
  state_fingerprint text not null,
  provenance_json jsonb not null default '{}',
  action_json jsonb not null default '{}',
  features_json jsonb not null default '{}',
  confidence numeric,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, kind, state_fingerprint)
);

create table public.home_recommendations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.home_recommendation_candidates(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),
  title text not null,
  why text,
  priority text not null check (priority in ('decide','improve','tidy')),
  score numeric,
  rank int,
  surface text not null default 'recommendations' check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'active' check (status in ('active','dismissed','completed','expired','snoozed')),
  algorithm_version text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, id)
);
create index on public.home_recommendations (workspace_id, status, surface, rank);

create table public.home_recommendation_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recommendation_id uuid not null references public.home_recommendations(id) on delete cascade,
  event_type text not null check (event_type in ('surfaced','clicked','dismissed','completed','expired')),
  position int,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.home_recommendation_events (workspace_id, created_at desc);

create table public.home_interaction_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  item_id uuid,
  event_type text not null,
  rank int,
  algorithm_version text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.home_interaction_events (workspace_id, surface, created_at desc);

create table public.home_ranking_profiles (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  version int not null default 1,
  recommendation_kind_weights_json jsonb not null default '{}',
  recommendation_action_weights_json jsonb not null default '{}',
  news_source_weights_json jsonb not null default '{}',
  news_topic_weights_json jsonb not null default '{}',
  inbox_type_weights_json jsonb not null default '{}',
  cleanup_aggressiveness numeric not null default 0.5,
  novelty_preference numeric not null default 0.5,
  source_diversity_preference numeric not null default 0.5,
  news_exploration_rate numeric not null default 0.1,
  news_initial_page_size int not null default 8,
  news_next_page_size int not null default 6,
  news_target_pool_size int not null default 24,
  news_max_session_cards int not null default 40,
  news_mode_by_talk_id_json jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.home_optimization_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','pending_review','accepted','rejected','applied')),
  problem_statement text not null,
  evidence_json jsonb not null default '{}',
  proposed_change text not null,
  affected_parameters_json jsonb not null default '{}',
  risk text not null default 'low' check (risk in ('low','medium','high')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table public.home_algorithm_versions (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','staging','active','paused','retired')),
  description text,
  config_json jsonb not null default '{}',
  config_hash text not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  unique (surface, config_hash)
);

create table public.home_algorithm_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  algorithm_version_id uuid not null references public.home_algorithm_versions(id) on delete cascade,
  assignment_reason text not null check (assignment_reason in ('rollout','staging','control','experiment','forced')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (workspace_id, surface, ended_at)
);
create index on public.home_algorithm_assignments (algorithm_version_id);

create table public.home_activation_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  has_provider_access boolean not null default false,
  has_created_talk boolean not null default false,
  has_selected_team_or_agents boolean not null default false,
  has_sent_prompt boolean not null default false,
  has_completed_agent_run boolean not null default false,
  has_created_or_linked_document boolean not null default false,
  has_customized_agent boolean not null default false,
  has_added_context_or_news boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- §9 Forge (SSR, audiences, improvement_runs, document_versions)
-- ---------------------------------------------------------------------------

create table public.ssr_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_org_id text not null,
  secret_ref uuid,
  scopes text[] not null,
  connected_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id),
  unique (workspace_id, id),
  foreign key (workspace_id, secret_ref) references public.connector_secrets(workspace_id, id) on delete set null (secret_ref)
);

create table public.forge_personas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  name text,
  title text,
  segment text,
  initials text,
  accent text,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_reference_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  name text,
  version text,
  anchor_count int,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  text text,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_audiences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  note text,
  reference_set_id uuid,
  question_id uuid,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, reference_set_id) references public.forge_reference_sets(workspace_id, id) on delete set null (reference_set_id),
  foreign key (workspace_id, question_id) references public.forge_questions(workspace_id, id) on delete set null (question_id)
);
create unique index forge_audiences_one_default_per_workspace
  on public.forge_audiences (workspace_id) where is_default;

create table public.forge_audience_personas (
  workspace_id uuid not null,
  audience_id uuid not null,
  persona_id uuid not null,
  sort_order int,
  added_at timestamptz not null default now(),
  primary key (audience_id, persona_id),
  foreign key (workspace_id, audience_id) references public.forge_audiences(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id) references public.forge_personas(workspace_id, id) on delete cascade
);

create table public.improvement_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid,
  target_block_id uuid,
  talk_id uuid,
  owner_id uuid not null references public.users(id) on delete restrict,
  audience_id uuid,
  objective_json jsonb not null,
  search_config_json jsonb not null,
  target_score numeric,
  max_iterations int,
  budget_usd numeric,
  baseline_score numeric,
  status text not null default 'pending'
    check (status in ('pending','running','completed','plateaued','budget_exhausted','cancelled','failed')),
  stop_reason text,
  ssr_connection_id uuid,
  best_version_id uuid,                                              -- back-edge to document_versions; deferrable
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, document_id, target_block_id)
    references public.doc_blocks(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete set null (talk_id),
  foreign key (workspace_id, audience_id) references public.forge_audiences(workspace_id, id) on delete set null (audience_id),
  foreign key (workspace_id, ssr_connection_id) references public.ssr_connections(workspace_id, id) on delete set null (ssr_connection_id)
);

create table public.improvement_run_held_out_personas (
  workspace_id uuid not null,
  run_id uuid not null,
  persona_id uuid not null,
  primary key (run_id, persona_id),
  foreign key (workspace_id, run_id) references public.improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id) references public.forge_personas(workspace_id, id) on delete cascade
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  iteration int not null,
  candidate_id text not null,
  parent_version_id uuid,
  body_markdown text not null,
  mutation_strategy text,
  composite_score numeric,
  held_out_score numeric,
  per_persona_json jsonb,
  ssr_job_id text,
  decision text check (decision in ('keep','discard','frontier','winner')),
  decision_reason text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (run_id, candidate_id),
  foreign key (workspace_id, run_id) references public.improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_version_id) references public.document_versions(workspace_id, id) on delete set null (parent_version_id)
);

-- improvement_runs.best_version_id back-edge (deferrable cycle)
alter table public.improvement_runs
  add constraint improvement_runs_best_version_id_fkey
  foreign key (workspace_id, best_version_id) references public.document_versions(workspace_id, id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- §10 Audit & analytics
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  actor_user_id uuid references public.users(id) on delete set null,
  entity_type text,
  entity_id uuid,
  action text,
  payload_json jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_events (workspace_id, created_at desc);
create index on public.audit_events (workspace_id, entity_type, entity_id, created_at desc);

-- =============================================================================
-- STEP 5: Updated_at touch triggers (per-table)
-- =============================================================================

create trigger touch_updated_at before update on public.users
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.web_search_providers
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.web_search_provider_secrets
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.workspaces
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.folders
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.talks
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.agent_role_templates
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.agents
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.team_compositions
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.documents
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.doc_tabs
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.doc_blocks
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.context_sources
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.connector_secrets
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.connectors
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.connector_bindings
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.jobs
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_news_topics
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_inbox_items
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_ranking_profiles
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_activation_state
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.ssr_connections
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.forge_audiences
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.improvement_runs
  for each row execute function public.tg_touch_updated_at();

-- =============================================================================
-- STEP 6: Business triggers
-- =============================================================================

-- Last-tab guard
create trigger doc_tabs_block_last_delete
  before delete on public.doc_tabs
  for each row execute function public.doc_tabs_block_last_delete();

-- Edit-CAS bump on accept
create trigger document_edits_bump_versions_on_accept
  before update on public.document_edits
  for each row execute function public.document_edits_bump_versions_on_accept();

-- Job agent-clear → blocked atomic
create trigger jobs_block_on_agent_clear
  before update of agent_id on public.jobs
  for each row when (new.agent_id is null and old.agent_id is not null)
  execute function public.set_job_blocked_agent_missing();

-- Jobs roster invariant
create trigger jobs_require_agent_in_roster
  before insert or update of talk_id, agent_id on public.jobs
  for each row execute function public.jobs_require_agent_in_roster();

-- Jobs cannot be moved between talks/workspaces or reassigned to another creator.
create trigger jobs_block_identity_change
  before update of workspace_id, talk_id, created_by on public.jobs
  for each row execute function public.jobs_block_identity_change();


-- =============================================================================
-- STEP 6.5: Seed runtime catalogs (§11 §4 / docs/03-agents.md)
-- =============================================================================

-- The five user-facing prompts are copied from docs/03-agents.md. Model defaults
-- are normalized to the live provider catalog seeded above so workspace bootstrap
-- never points at retired or unseeded model ids.
insert into public.web_search_providers (id, name, base_url) values
  ('web_search.tavily', 'Tavily', 'https://api.tavily.com'),
  ('web_search.brave', 'Brave Search', 'https://api.search.brave.com'),
  ('web_search.firecrawl', 'Firecrawl', 'https://api.firecrawl.dev'),
  ('web_search.exa', 'Exa', 'https://api.exa.ai')
on conflict (id) do update set
  name = excluded.name,
  base_url = excluded.base_url,
  updated_at = now();

insert into public.agent_role_templates (
  role_key, default_name, default_handle, default_initials, default_accent,
  default_accent_dark, default_model_id, default_temperature, job,
  system_prompt, method_default, version
) values
  ('strategist', 'Strategy Lead', '@strat', 'SL', '#C8643A', '#E08561', 'claude-opus-4-8', 0.6, 'Frame the strongest defensible position on the user''s question.', 'You are the Strategist in a ClawTalk room — a structured multi-agent debate. Your job is to frame the strongest defensible position on the user''s question.

EVERY response follows this structure:
1. THESIS: State your position in exactly one sentence.
2. CLAIMS: Defend it with exactly 3 supporting claims, ordered by how load-bearing they are. Lead with the strongest.
3. CONFIDENCE: Rate your confidence 1–5 and name the single most likely thing that would change your mind.

Constraints:
- Be direct and declarative. No hedging language ("I think", "perhaps", "it might be").
- If the question is unclear, restate it sharply before answering — don''t paper over ambiguity.
- Don''t pre-rebut yourself. The Critic will do that.
- Don''t summarize prior turns. Take a position.
- If you''ve already responded and a later agent has pushed back, hold your position OR concede explicitly with a one-line reason. Never wishy-wash.

You are speaking in a room. Other agents (Critic, Researcher, Editor, optionally Quant) will respond. Address them by handle (@critic, @research, @editor, @quant) when replying to a specific point. The user ({{user_name}}) is the asker — address them when answering the original question, not the room.

Tone: Direct, confident, MBA-trained. Loves frameworks, impatient with handwaves. Speaks in declarative sentences.', array['State your thesis in one sentence.', 'Defend it with exactly 3 supporting claims, ordered by load-bearing weight.', 'Rate your confidence (1–5) and name what would change your mind.']::text[], 1),
  ('critic', 'Devil''s Advocate', '@critic', 'DA', '#8E3B59', '#B85478', 'gpt-5-mini', 0.7, 'Find where the argument breaks before the user does.', 'You are the Devil''s Advocate in a ClawTalk room. Your job is to find where the argument breaks before the user does. You are not here to be balanced; you are here to be useful by being skeptical.

EVERY response follows this structure:
1. WEAKEST PREMISE: Name the single most fragile claim in the most recent turn.
2. QUOTE: Paste the exact text you''re criticizing.
3. FAILURE MODE: Describe how this breaks. What''s the worst case? Who actually pushes back, and why?
4. REPAIR (optional): Either propose one concrete fix, OR argue why it can''t be saved.

Constraints:
- Never agree just to be agreeable. If everyone in the room has converged, you should suspect groupthink and dig harder.
- Quote text verbatim. Don''t paraphrase what you''re attacking.
- Attack at most one premise per turn. Resist the urge to enumerate everything wrong; pick the weakest.
- Cite the agent''s handle (@strat, @research, @editor) when criticizing their specific claim.
- If the most recent turn is from the user (not an agent), point at the question''s hidden assumptions instead.

Tone: Adversarial but professional. Cuts past politeness. Never sneers. Never agrees just to be agreeable.', array['Identify the single weakest premise in the most recent claim.', 'Quote the exact text being criticized.', 'Propose the failure mode — how does this break? What''s the worst case?', 'Suggest one concrete repair, or argue why it can''t be saved.']::text[], 1),
  ('researcher', 'Researcher', '@research', 'Rs', '#3F6B5C', '#5E8E7E', 'gemini-2.5-flash', 0.4, 'Bring outside evidence to ground the conversation.', 'You are the Researcher in a ClawTalk room. Your job is to bring outside evidence to ground the conversation. You are the only agent that should ever cite a URL.

EVERY response includes:
- At least 3 sources you''ve consulted (or attempted to consult).
- Inline citations: [Source Name — 1-line summary of what they said].
- A "I FOUND" section and (separately) an "I INFER" section. Never blur them.

Constraints:
- Use web search and web fetch tools when they''re available. If they''re disabled in this Talk, say so explicitly and proceed with prior-knowledge only — clearly labeled.
- Flag contradictions across sources. Don''t average them.
- Quantify when you can. "Linear charges $45/seat" beats "Linear is expensive."
- If you don''t find evidence, say so. Don''t manufacture sources.
- If a prior agent (@strat, @critic) made an empirical claim, your job is to verify or refute it. Cite them when you do.

Tone: Curious, methodical. Always shows sources. Comfortable saying "I don''t know yet — let me look."', array['Search for ≥ 3 sources before responding.', 'Synthesize across sources; flag contradictions explicitly.', 'Cite inline with source name + 1-line summary.', 'Distinguish "I found X" from "I infer X."']::text[], 1),
  ('editor', 'Editor', '@editor', 'Ed', '#3D5688', '#6178A6', 'claude-sonnet-4-6', 0.3, 'Close the round into a single recommendation.', 'You are the Editor in a ClawTalk room. Your job is to close each round into a single recommendation the user can act on. You are not here to participate; you are here to synthesize.

EVERY response (typically the last in a round) follows this structure:
1. AGREEMENT: Bullet list of points where Strategist, Critic, and Researcher converged. Cite who said what.
2. DISAGREEMENT: Bullet list of where they did not. Cite the specific claims that conflict.
3. RECOMMENDATION: A single proposed answer to the user''s original question, with confidence (1–5).
4. OPEN QUESTIONS: Things still unresolved. If a doc is linked to this Talk, format these as actionable TODOs in markdown that can be inserted into the doc.

Constraints:
- Be neutral. Do not insert your own argument; you are a mirror, not a participant.
- Never break the structure above. Users rely on it for scanability.
- If the round produced no useful disagreement, say so and recommend re-running with a more provocative question.
- Be concise. Each bullet is one line. Recommendation is ≤ 3 sentences.
- When you suggest doc edits, output them inside a fenced ```diff``` block so the UI can show pending edits.

Tone: Concise, structured. Closes rounds cleanly. Reads like a managing editor, not a participant.', array['List points of agreement across agents (cite who).', 'List points of disagreement (cite who and what they said).', 'Propose a recommendation with confidence.', 'Surface open questions as TODOs in the primary document (if one exists).']::text[], 1),
  ('quant', 'Quant', '@quant', 'Qt', '#2A6F7E', '#4A95A5', 'gpt-5-mini', 0.2, 'Verify the math the others handwave through.', 'You are the Quant in a ClawTalk room. Your job is to verify the math the other agents handwave through. You are the agent that says "wait, where did $32 come from?"

EVERY response includes:
1. EXTRACTED CLAIMS: Every numerical claim from the recent round, listed with attribution (e.g. "@strat: $32/seat").
2. VERIFICATION: For each, either confirm the math (show your work) or flag what''s missing.
3. RANGES: Convert any point estimate into a sensible range with stated uncertainty. "$32 ± $5" beats "$32".
4. MISSING DATA: What you''d need to evaluate the remaining claims.

Constraints:
- Show every calculation step. Don''t black-box the math.
- Round numbers are suspicious by default. If someone says "10M tokens," ask where that came from.
- If no numerical claims were made in the round, say so and propose 1–2 quantitative questions that *should* have been asked.
- Don''t make up data. If you need a number you don''t have, ask for it explicitly.
- You are not the Critic — you don''t argue about strategy. You argue about arithmetic and units.

Tone: Skeptical of numbers without provenance. Shows ranges, not point estimates. Quietly suspicious of round numbers.', array['Extract every numerical claim from the round.', 'Run the actual computation; show your work.', 'Flag missing data needed to evaluate a claim.', 'Propose ranges instead of point estimates when uncertainty is real.']::text[], 1),
  ('forge_rewriter', 'Forge Rewriter', '@forge-rewriter', 'FR', '#5B62A8', '#838ADF', 'claude-sonnet-4-6', 0.4, 'Generate constrained candidate revisions for Forge improvement runs.', 'You are the Forge Rewriter in ClawTalk. Your job is to generate candidate revisions for the selected document scope using the audience, scoring rubric, parent candidate, and critic brief. Preserve constraints, avoid unrelated rewrites, and make changes traceable to the requested improvement target. This is a placeholder system prompt until Joseph authors the production Forge prompt.', array['Read the target document scope and immutable surrounding context.', 'Apply the audience, rubric, parent candidate, and critic brief to propose a bounded revision.', 'Preserve factual commitments unless the brief explicitly requires a change.', 'Return the revised candidate plus a concise change rationale.']::text[], 1),
  ('forge_critic', 'Forge Critic', '@forge-critic', 'FC', '#6D5478', '#9B79AA', 'claude-sonnet-4-6', 0.2, 'Turn Forge scoring feedback into concrete revision briefs.', 'You are the Forge Critic in ClawTalk. Your job is to read persona feedback, scores, and candidate lineage, then produce the shortest useful revision brief for the next Forge mutation step. Name the weakest issue, cite the evidence that proves it, and avoid vague taste feedback. This is a placeholder system prompt until Joseph authors the production Forge prompt.', array['Read the scored candidate and qualitative persona feedback.', 'Identify the single weakest repairable issue.', 'Write a concrete revision brief with evidence and expected impact.', 'Call out when the candidate should stop rather than mutate again.']::text[], 1)
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
-- STEP 7: RLS enable + policies (§11 §12)
-- =============================================================================

-- Workspaces + members
alter table public.workspaces enable row level security;
create policy workspaces_read on public.workspaces
  for select using (public.is_workspace_member(id));
create policy workspaces_write on public.workspaces
  for all
  using       (public.is_workspace_admin(id))
  with check  (public.is_workspace_admin(id));

alter table public.workspace_members enable row level security;
create policy workspace_members_read on public.workspace_members
  for select using (user_id = auth.uid());
create policy workspace_members_write on public.workspace_members
  for all
  using       (public.is_workspace_admin(workspace_id))
  with check  (public.is_workspace_admin(workspace_id));

alter table public.user_tool_permissions enable row level security;
create policy user_tool_permissions_owner on public.user_tool_permissions
  for all
  using       (user_id = auth.uid())
  with check  (user_id = auth.uid());

-- Member-write tables (the canonical pattern)
do $$
declare
  tbl text;
  member_write_tables text[] := array[
    'folders','talks','talk_agents','talk_tools','talk_reads',
    'agent_feedback_events',
    'team_compositions','team_composition_agents','improvement_runs',
    'improvement_run_held_out_personas','forge_audiences','forge_audience_personas',
    'forge_personas','forge_reference_sets','forge_questions','home_inbox_items','home_recommendations',
    'home_recommendation_candidates','home_recommendation_events','home_news_topics','home_news_matches',
    'home_interaction_events','home_activation_state','activity_events'
  ];
begin
  foreach tbl in array member_write_tables loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('create policy %I_read on public.%I for select using (public.is_workspace_member(workspace_id))', tbl, tbl);
    execute format(
      'create policy %I_write on public.%I for all using (public.is_workspace_writer(workspace_id)) with check (public.is_workspace_writer(workspace_id))',
      tbl, tbl);
  end loop;
end $$;

-- Server-authored workflow tables. Workspace members can read these through
-- RLS, but all mutations must go through the Worker/API trusted-write path so
-- direct Supabase clients cannot forge chat history, source ingestion state, or
-- document content outside the validated route contracts.
do $$
declare
  tbl text;
  trusted_write_tables text[] := array[
    'messages',
    'context_sources','context_source_pages',
    'documents','doc_tabs','doc_blocks','doc_tab_coeditors','document_versions'
  ];
begin
  foreach tbl in array trusted_write_tables loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('create policy %I_read on public.%I for select using (public.is_workspace_member(workspace_id))', tbl, tbl);
  end loop;
end $$;

alter table public.document_edits enable row level security;
create policy document_edits_read on public.document_edits
  for select using (public.is_workspace_member(workspace_id));

alter table public.jobs enable row level security;
create policy jobs_read on public.jobs
  for select using (public.is_workspace_member(workspace_id));

-- Provider replay blobs can contain opaque encrypted reasoning/message items.
-- They are trusted execution inputs only, not client-readable message metadata.
alter table public.message_provider_replay enable row level security;

-- Runtime/snapshot tables are trusted execution inputs. Members can read them.
-- Runtime row materialization and cancellation are service/trusted-app only so
-- direct authenticated clients cannot forge prompts, snapshots, tools, audit
-- rows, or cancellation side effects.
alter table public.runs enable row level security;
create policy runs_read on public.runs
  for select using (public.is_workspace_member(workspace_id));

alter table public.talk_agent_snapshots enable row level security;
create policy talk_agent_snapshots_read on public.talk_agent_snapshots
  for select using (public.is_workspace_member(workspace_id));

alter table public.run_prompt_snapshots enable row level security;
create policy run_prompt_snapshots_read on public.run_prompt_snapshots
  for select using (public.is_workspace_member(workspace_id));

alter table public.audit_events enable row level security;
create policy audit_events_read on public.audit_events
  for select using (public.is_workspace_member(workspace_id));

-- Admin-write exception tables (member-read, admin-write)
do $$
declare
  tbl text;
  admin_write_tables text[] := array[
    'agents',
    'connector_bindings','ssr_connections',
    'home_optimization_proposals','home_algorithm_versions','home_algorithm_assignments',
    'home_ranking_profiles'
  ];
begin
  foreach tbl in array admin_write_tables loop
    execute format('alter table public.%I enable row level security', tbl);
    -- home_algorithm_versions has no workspace_id (global table); skip member-read policy
    if tbl = 'home_algorithm_versions' then
      execute format('create policy %I_read on public.%I for select using (true)', tbl, tbl);
      execute format(
        'create policy %I_write on public.%I for all using (false) with check (false)',
        tbl, tbl);
    else
      execute format('create policy %I_read on public.%I for select using (public.is_workspace_member(workspace_id))', tbl, tbl);
      execute format(
        'create policy %I_write on public.%I for all using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id))',
        tbl, tbl);
    end if;
  end loop;
end $$;

alter table public.connectors enable row level security;
create policy connectors_read on public.connectors
  for select using (
    public.is_workspace_member(workspace_id)
    and (
      config_json->>'compatSurface' is distinct from 'google_tools'
      or config_json->>'authorizedByUserId' = auth.uid()::text
    )
  );
create policy connectors_insert on public.connectors
  for insert with check (
    public.is_workspace_admin(workspace_id)
    and config_json->>'compatSurface' is distinct from 'google_tools'
  );
create policy connectors_update on public.connectors
  for update using (
    public.is_workspace_admin(workspace_id)
    and config_json->>'compatSurface' is distinct from 'google_tools'
  )
  with check (
    public.is_workspace_admin(workspace_id)
    and config_json->>'compatSurface' is distinct from 'google_tools'
  );
create policy connectors_delete on public.connectors
  for delete using (
    public.is_workspace_admin(workspace_id)
    and config_json->>'compatSurface' is distinct from 'google_tools'
  );

alter table public.connector_secrets enable row level security;
create policy connector_secrets_read on public.connector_secrets
  for select using (false);
create policy connector_secrets_write on public.connector_secrets
  for all using (false) with check (false);

-- Shared pool: home_news_items (no workspace_id)
alter table public.home_news_items enable row level security;
create policy home_news_items_read on public.home_news_items
  for select using (true);
-- No write policy → only service role (bypassrls) can insert/update

-- agent_role_templates: global runtime catalog (no workspace_id)
alter table public.agent_role_templates enable row level security;
create policy agent_role_templates_read on public.agent_role_templates
  for select using (true);
-- No write policy → only service role can update (versioning is admin/migration concern)


-- Runtime table RLS and grants retained across the greenfield cutover.
alter table public.users enable row level security;
create policy users_self_select on public.users
  for select to authenticated
  using (id = auth.uid());
create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant select on public.users to authenticated;
grant update (name, avatar_color, initials, preferred_web_search_provider_id, updated_at) on public.users to authenticated;

alter table public.web_search_providers enable row level security;
create policy web_search_providers_read on public.web_search_providers
  for select using (true);

alter table public.web_search_provider_secrets enable row level security;
create policy web_search_provider_secrets_owner on public.web_search_provider_secrets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

alter table public.llm_provider_secrets enable row level security;
create policy llm_provider_secrets_owner on public.llm_provider_secrets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

alter table public.llm_provider_verifications enable row level security;
create policy llm_provider_verifications_owner on public.llm_provider_verifications
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

alter table public.provider_oauth_states enable row level security;
create policy provider_oauth_states_owner on public.provider_oauth_states
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.oauth_state enable row level security;
create policy oauth_state_owner on public.oauth_state
  for all to authenticated
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  )
  with check (
    user_id = auth.uid()
    and (
      (provider = 'slack_app_install' and public.is_workspace_admin(workspace_id))
      or (provider <> 'slack_app_install' and public.is_workspace_member(workspace_id))
    )
  );

alter table public.idempotency_cache enable row level security;
create policy idempotency_cache_owner on public.idempotency_cache
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.workspace_provider_secrets enable row level security;
-- Shared LLM ciphertext is server-only. Admins can create/update/delete
-- credentials only through trusted server routes; authenticated browser sessions
-- cannot read or mutate ciphertext directly through Supabase.

alter table public.workspace_provider_verifications enable row level security;
create policy workspace_provider_verifications_read on public.workspace_provider_verifications
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy workspace_provider_verifications_write on public.workspace_provider_verifications
  for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

grant select on public.llm_providers to authenticated;
grant select on public.llm_provider_models to authenticated;
grant select on public.web_search_providers to authenticated;
grant select, insert, update, delete on public.web_search_provider_secrets to authenticated;
grant select on public.settings_kv to authenticated;
grant select on public.llm_ttft_stats to authenticated;
grant select, insert, update, delete on public.llm_provider_secrets to authenticated;
grant select, insert, update, delete on public.llm_provider_verifications to authenticated;
grant select, insert, update, delete on public.provider_oauth_states to authenticated;
grant select, insert, update, delete on public.oauth_state to authenticated;
grant select, insert, update, delete on public.idempotency_cache to authenticated;
grant select, insert, update, delete on public.workspace_provider_verifications to authenticated;
revoke all on function public.ensure_user_workspace_bootstrap(uuid) from public;
grant execute on function public.ensure_user_workspace_bootstrap(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clawtalk_event_hub') then
    create role clawtalk_event_hub with login;
  end if;
end
$$;

revoke all on public.event_outbox from authenticated;
revoke all on sequence public.event_outbox_event_id_seq from authenticated;
grant select on public.event_outbox to clawtalk_event_hub;

-- Supabase's authenticated role needs table privileges in addition to RLS policies.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Tighten service/system-owned tables after the broad grant above.
revoke all on public.event_outbox from authenticated;
revoke all on sequence public.event_outbox_event_id_seq from authenticated;
revoke all on public.workspace_provider_secrets from authenticated;
revoke all on public.message_provider_replay from authenticated;
revoke insert, update, delete on public.llm_providers from authenticated;
revoke insert, update, delete on public.llm_provider_models from authenticated;
revoke insert, update, delete on public.web_search_providers from authenticated;
revoke insert, update, delete on public.home_news_items from authenticated;
revoke insert, update, delete on public.agent_role_templates from authenticated;
revoke insert, update, delete on public.home_algorithm_versions from authenticated;
revoke insert, update, delete on public.messages from authenticated;
revoke insert, update, delete on public.context_sources from authenticated;
revoke insert, update, delete on public.context_source_pages from authenticated;
revoke insert, update, delete on public.documents from authenticated;
revoke insert, update, delete on public.doc_tabs from authenticated;
revoke insert, update, delete on public.doc_blocks from authenticated;
revoke insert, update, delete on public.doc_tab_coeditors from authenticated;
revoke insert, update, delete on public.document_versions from authenticated;
revoke insert, update, delete on public.document_edits from authenticated;
revoke insert, update, delete on public.jobs from authenticated;
revoke insert, update, delete on public.runs from authenticated;
revoke insert, update, delete on public.talk_agent_snapshots from authenticated;
revoke insert, update, delete on public.run_prompt_snapshots from authenticated;
revoke insert, update, delete on public.audit_events from authenticated;
revoke insert, update, delete on public.settings_kv from authenticated;
revoke insert, update, delete on public.llm_ttft_stats from authenticated;
revoke update on public.users from authenticated;
grant update (name, avatar_color, initials, preferred_web_search_provider_id, updated_at) on public.users to authenticated;

commit;
