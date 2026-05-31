-- clawtalk Phase 5 (PR 1) — initial Postgres schema.
--
-- Mirrors the SQLite tables in src/clawtalk/db/init.ts that are still in use
-- after the Phase 1 chassis purge. Chassis-removed surfaces (channels,
-- browser, data_connectors, talk_channel_*, talk_executor_sessions,
-- talk_llm_policies, run_confirmations, dead_letter_queue) are dropped here
-- rather than ported.
--
-- Auth-side tables (web_sessions, oauth_state-for-auth, device_auth_codes)
-- are replaced by Supabase Auth in PR 2 and so are not ported. The `users`
-- table mirrors auth.users via the on_auth_user_created trigger below.
--
-- RLS posture: RLS is ENABLED on every per-user table here (default-deny).
-- The per-table policies live in 0002_rls_policies.sql so they ship atomic
-- with the `withUserContext` per-tx role-downgrade wrapper in src/db-pg.ts.
-- Migrations run as the `postgres` BYPASSRLS role, so RLS-enabled tables
-- apply cleanly even with zero policies present.

create extension if not exists pgcrypto;

-- ─── Identity ────────────────────────────────────────────────────────

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create index users_email_idx on public.users (email);
alter table public.users enable row level security;

-- Auto-mirror auth.users → public.users on signup. SECURITY DEFINER so the
-- trigger can write public.users even though the caller is `authenticated`.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name, created_at)
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Invites + Google credentials retain the same shape as SQLite; user_invites
-- is per-user (invited_by); user_google_credentials and link requests are
-- per-user too.

create table public.user_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null check (role in ('admin', 'member')),
  invited_by uuid not null references public.users(id) on delete cascade,
  accepted boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz
);
create index user_invites_email_idx on public.user_invites (email);
alter table public.user_invites enable row level security;

create table public.user_google_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  google_subject text not null,
  email text not null,
  display_name text,
  scopes_json jsonb not null,
  ciphertext text not null,
  access_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_google_credentials enable row level security;

create table public.google_oauth_link_requests (
  state_hash text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  scopes_json jsonb not null,
  created_at timestamptz not null default now()
);
create index google_oauth_link_requests_user_idx
  on public.google_oauth_link_requests (user_id, created_at);
alter table public.google_oauth_link_requests enable row level security;

-- Ephemeral OAuth flow state (Google scope-expansion, NOT primary auth —
-- primary auth is Supabase Auth in PR 2). TTL via `expires_at`.
create table public.oauth_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
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
alter table public.oauth_state enable row level security;

-- ─── LLM provider catalog (global — no RLS, system-managed) ─────────

create table public.llm_providers (
  id text primary key,
  name text not null,
  provider_kind text not null
    check (provider_kind in ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
  api_format text not null
    check (api_format in ('anthropic_messages', 'openai_chat_completions')),
  base_url text not null,
  auth_scheme text not null
    check (auth_scheme in ('x_api_key', 'bearer')),
  enabled boolean not null default true,
  core_compatibility text not null default 'none'
    check (core_compatibility in ('none', 'claude_sdk_proxy')),
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
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  primary key (provider_id, model_id)
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

-- ─── LLM provider credentials (per-user, RLS) ───────────────────────

-- Per-user provider credentials. Composite PK on (owner_id, provider_id) so
-- the same user can only have one credential per provider. The SQLite
-- variant was global (single-tenant); cloud port makes it per-user.
create table public.llm_provider_secrets (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  enc_key_version integer not null default 1,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id)
);
alter table public.llm_provider_secrets enable row level security;

create table public.llm_provider_verifications (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  status text not null
    check (status in ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
  last_verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id)
);
alter table public.llm_provider_verifications enable row level security;

-- ─── Agents (personas) ──────────────────────────────────────────────

create table public.registered_agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  provider_id text not null,
  model_id text not null,
  tool_permissions_json jsonb not null default '{}'::jsonb,
  persona_role text,
  system_prompt text,
  description text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index registered_agents_owner_enabled_name_idx
  on public.registered_agents (owner_id, enabled, name);
alter table public.registered_agents enable row level security;

create table public.agent_fallback_steps (
  agent_id uuid not null references public.registered_agents(id) on delete cascade,
  position integer not null,
  provider_id text not null references public.llm_providers(id) on delete cascade,
  model_id text not null,
  owner_id uuid not null references public.users(id) on delete cascade,
  primary key (agent_id, position),
  foreign key (provider_id, model_id)
    references public.llm_provider_models(provider_id, model_id) on delete cascade
);
alter table public.agent_fallback_steps enable row level security;

create table public.user_tool_permissions (
  user_id uuid not null references public.users(id) on delete cascade,
  tool_id text not null,
  allowed boolean not null default true,
  requires_approval boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool_id)
);
create index user_tool_permissions_user_idx on public.user_tool_permissions (user_id);
alter table public.user_tool_permissions enable row level security;

-- ─── Talks ──────────────────────────────────────────────────────────

create table public.talk_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talk_folders_owner_sort_idx
  on public.talk_folders (owner_id, sort_order, updated_at);
alter table public.talk_folders enable row level security;

create table public.talks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  folder_id uuid references public.talk_folders(id) on delete set null,
  topic_title text,
  project_path text,
  orchestration_mode text not null default 'ordered'
    check (orchestration_mode in ('ordered', 'panel')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  sort_order double precision not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talks_owner_folder_sort_idx
  on public.talks (owner_id, folder_id, sort_order, updated_at);
alter table public.talks enable row level security;

create table public.talk_members (
  talk_id uuid not null references public.talks(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (talk_id, user_id)
);
create index talk_members_user_idx on public.talk_members (user_id);
alter table public.talk_members enable row level security;

create table public.talk_threads (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  title text,
  is_default boolean not null default false,
  is_internal boolean not null default false,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talk_threads_talk_idx on public.talk_threads (talk_id);
alter table public.talk_threads enable row level security;

create table public.talk_messages (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references public.talks(id) on delete cascade,
  thread_id uuid not null,
  owner_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  agent_id uuid references public.registered_agents(id) on delete set null,
  run_id uuid,
  sequence_in_run integer,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata_json jsonb
);
create index talk_messages_talk_created_idx on public.talk_messages (talk_id, created_at);
create index talk_messages_thread_idx on public.talk_messages (thread_id);
alter table public.talk_messages enable row level security;

create table public.talk_agents (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  registered_agent_id uuid references public.registered_agents(id) on delete set null,
  source_kind text not null default 'provider'
    check (source_kind in ('claude_default', 'provider')),
  provider_id text,
  model_id text,
  nickname text,
  nickname_mode text not null default 'auto'
    check (nickname_mode in ('auto', 'custom')),
  persona_role text,
  is_primary boolean not null default false,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talk_agents_talk_sort_idx
  on public.talk_agents (talk_id, sort_order, created_at);
create index talk_agents_registered_agent_idx
  on public.talk_agents (registered_agent_id);
alter table public.talk_agents enable row level security;

-- ─── Runs (multi-agent execution state) ─────────────────────────────

create table public.talk_runs (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  requested_by uuid not null references public.users(id),
  status text not null
    check (status in ('queued', 'running', 'awaiting_confirmation', 'cancelled', 'completed', 'failed')),
  trigger_message_id uuid references public.talk_messages(id),
  job_id uuid,
  target_agent_id uuid,
  agent_id uuid references public.registered_agents(id) on delete set null,
  executor_alias text,
  executor_model text,
  thread_id uuid not null,
  run_kind text not null default 'conversation'
    check (run_kind in ('conversation', 'instruction_review')),
  idempotency_key text,
  response_group_id text,
  sequence_index integer,
  source_binding_id text,
  source_external_message_id text,
  source_thread_key text,
  task_type text check (task_type in ('chat', 'browser')),
  selected_mode text check (selected_mode in ('api', 'subscription')),
  transport text check (transport in ('direct', 'subscription')),
  timeout_phase text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  cancel_reason text,
  metadata_json jsonb
);
create index talk_runs_talk_status_idx on public.talk_runs (talk_id, status, created_at);
create index talk_runs_status_created_idx on public.talk_runs (status, created_at);
create index talk_runs_group_sequence_idx
  on public.talk_runs (response_group_id, sequence_index, created_at);
create index talk_runs_thread_status_idx
  on public.talk_runs (thread_id, status, created_at);
alter table public.talk_runs enable row level security;

-- ─── Talk context (goal / rules / sources / state / outputs) ────────

create table public.talk_context_summary (
  talk_id uuid primary key references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  summary_text text not null,
  covers_through_message_id uuid references public.talk_messages(id),
  updated_at timestamptz not null default now()
);
alter table public.talk_context_summary enable row level security;

create table public.talk_context_goal (
  talk_id uuid primary key references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  goal_text text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.talk_context_goal enable row level security;

create table public.talk_context_rules (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  rule_text text not null,
  sort_order double precision not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index talk_context_rules_talk_sort_idx
  on public.talk_context_rules (talk_id, sort_order, created_at);
alter table public.talk_context_rules enable row level security;

create table public.talk_context_sources (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  source_ref text not null,
  source_type text not null check (source_type in ('url', 'file', 'text')),
  title text,
  note text,
  sort_order double precision not null default 0,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  source_url text,
  file_name text,
  file_size bigint,
  mime_type text,
  storage_key text,
  extracted_text text,
  extracted_at timestamptz,
  last_fetched_at timestamptz,
  extraction_error text,
  fetch_strategy text check (fetch_strategy in ('http', 'browser', 'managed')),
  is_truncated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null
);
create index talk_context_sources_talk_sort_idx
  on public.talk_context_sources (talk_id, sort_order, created_at);
create unique index talk_context_sources_ref_idx
  on public.talk_context_sources (talk_id, source_ref);
alter table public.talk_context_sources enable row level security;

create table public.talk_context_source_ref_counter (
  talk_id uuid primary key references public.talks(id) on delete cascade,
  next_ref_number integer not null default 1
);
alter table public.talk_context_source_ref_counter enable row level security;

create table public.talk_state_entries (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  value_json jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references public.users(id) on delete set null,
  updated_by_run_id uuid references public.talk_runs(id) on delete set null,
  unique (talk_id, key)
);
create index talk_state_entries_talk_updated_idx
  on public.talk_state_entries (talk_id, updated_at desc, key);
alter table public.talk_state_entries enable row level security;

create table public.talk_outputs (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  content_markdown text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references public.users(id) on delete set null,
  updated_by_user_id uuid references public.users(id) on delete set null,
  updated_by_run_id uuid references public.talk_runs(id) on delete set null
);
create index talk_outputs_talk_updated_idx
  on public.talk_outputs (talk_id, updated_at desc, id);
alter table public.talk_outputs enable row level security;

create table public.talk_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  binding_kind text not null
    check (binding_kind in ('google_drive_folder', 'google_drive_file', 'data_connector', 'saved_source', 'message_attachment')),
  external_id text not null,
  display_name text not null,
  metadata_json jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null
);
create index talk_resource_bindings_talk_idx
  on public.talk_resource_bindings (talk_id, created_at, id);
create unique index talk_resource_bindings_unique_scope_idx
  on public.talk_resource_bindings (talk_id, binding_kind, external_id);
alter table public.talk_resource_bindings enable row level security;

create table public.talk_message_attachments (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references public.talks(id) on delete cascade,
  message_id uuid references public.talk_messages(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  file_name text not null,
  file_size bigint,
  mime_type text,
  storage_key text not null,
  extracted_text text,
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'ready', 'failed')),
  extraction_error text,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null
);
create index talk_message_attachments_message_idx
  on public.talk_message_attachments (message_id);
create index talk_message_attachments_talk_idx
  on public.talk_message_attachments (talk_id, created_at);
alter table public.talk_message_attachments enable row level security;

-- ─── Main channel ───────────────────────────────────────────────────

create table public.main_threads (
  thread_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index main_threads_user_updated_idx
  on public.main_threads (user_id, updated_at);
alter table public.main_threads enable row level security;

create table public.main_thread_summaries (
  thread_id uuid primary key references public.main_threads(thread_id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  summary_text text not null,
  covers_through_message_id uuid references public.talk_messages(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.main_thread_summaries enable row level security;

-- ─── Scheduled jobs + run telemetry ─────────────────────────────────

create table public.talk_jobs (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  prompt text not null,
  target_agent_id uuid references public.registered_agents(id) on delete set null,
  status text not null check (status in ('active', 'paused', 'blocked')),
  schedule_json jsonb not null,
  timezone text not null,
  deliverable_kind text not null check (deliverable_kind in ('thread', 'report')),
  report_output_id uuid references public.talk_outputs(id) on delete set null,
  source_scope_json jsonb not null,
  thread_id uuid not null references public.talk_threads(id) on delete cascade,
  last_run_at timestamptz,
  last_run_status text,
  next_due_at timestamptz,
  run_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.users(id)
);
create index talk_jobs_talk_updated_idx
  on public.talk_jobs (talk_id, updated_at desc, created_at desc, id);
create index talk_jobs_due_status_idx
  on public.talk_jobs (status, next_due_at, created_at);
alter table public.talk_jobs enable row level security;

create table public.llm_attempts (
  id bigserial primary key,
  run_id uuid not null references public.talk_runs(id) on delete cascade,
  talk_id uuid references public.talks(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid references public.registered_agents(id) on delete set null,
  provider_id text references public.llm_providers(id) on delete set null,
  model_id text not null,
  status text not null check (status in ('success', 'failed', 'skipped', 'cancelled')),
  failure_class text,
  latency_ms integer,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);
create index llm_attempts_run_idx on public.llm_attempts (run_id);
create index llm_attempts_talk_created_idx
  on public.llm_attempts (talk_id, created_at);
alter table public.llm_attempts enable row level security;

-- ─── System tables (no RLS — system/admin scoped) ───────────────────

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
