-- clawtalk Phase 5 (PR 1) — per-table RLS policies.
--
-- All per-user tables have RLS enabled since 0001 (default-deny). This file
-- adds permissive policies for the `authenticated` role that enforce
-- `owner_id = auth.uid()` (or analogous identity check). The
-- `withUserContext` wrapper in src/db-pg.ts opens a transaction, downgrades
-- to `authenticated`, and binds `request.jwt.claims->>'sub'` so `auth.uid()`
-- returns the caller's userId. The two halves ship atomically — policies
-- without the wrapper default-deny every authenticated query; the wrapper
-- without policies would still default-deny since RLS is on.
--
-- Migrations themselves run as the BYPASSRLS `postgres` role, so this
-- migration applies cleanly without granting `authenticated` write rights
-- to the policy tables.
--
-- Talk-scoped child tables denormalize owner_id at write time (rows are
-- inserted by the route handler inside `withUserContext`, so the helper
-- knows the user). RLS reads owner_id directly rather than walking the
-- talks FK — fewer joins, cleaner policy bodies.

-- ── users (special-case: id IS the user id) ─────────────────────────
create policy users_self_select on public.users
  for select to authenticated
  using (id = auth.uid());

-- Profile updates (display name, etc.) flow through SECURITY DEFINER
-- helpers, not direct UPDATEs from authenticated, so no UPDATE policy
-- here. INSERT happens via the on_auth_user_created trigger which runs
-- SECURITY DEFINER.

-- ── Identity (per-user records) ─────────────────────────────────────
create policy user_invites_owner on public.user_invites
  for all to authenticated
  using (invited_by = auth.uid())
  with check (invited_by = auth.uid());

create policy user_google_credentials_owner on public.user_google_credentials
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy google_oauth_link_requests_owner on public.google_oauth_link_requests
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy oauth_state_owner on public.oauth_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── LLM provider credentials ────────────────────────────────────────
create policy llm_provider_secrets_owner on public.llm_provider_secrets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy llm_provider_verifications_owner on public.llm_provider_verifications
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ── Agents (personas) ───────────────────────────────────────────────
create policy registered_agents_owner on public.registered_agents
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy agent_fallback_steps_owner on public.agent_fallback_steps
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy user_tool_permissions_owner on public.user_tool_permissions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Talks ───────────────────────────────────────────────────────────
create policy talk_folders_owner on public.talk_folders
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talks_owner on public.talks
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- talk_members: a user can see the membership row if they ARE the user
-- referenced, or if they own the talk. The talk-owner check enables the
-- talk owner to list co-editors / viewers. (When sharing-with-others
-- lands, this policy will need OR'd with a talk-owner UPDATE policy.)
create policy talk_members_self on public.talk_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or talk_id in (select id from public.talks where owner_id = auth.uid())
  );

create policy talk_threads_owner on public.talk_threads
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_messages_owner on public.talk_messages
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_agents_owner on public.talk_agents
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_runs_owner on public.talk_runs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ── Talk context ────────────────────────────────────────────────────
create policy talk_context_summary_owner on public.talk_context_summary
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_context_goal_owner on public.talk_context_goal
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_context_rules_owner on public.talk_context_rules
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_context_sources_owner on public.talk_context_sources
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ref counter follows the talk's owner; row is created lazily next to the
-- first source insert. Authenticated user reads through their owned talks.
create policy talk_context_source_ref_counter_via_talk on public.talk_context_source_ref_counter
  for all to authenticated
  using (talk_id in (select id from public.talks where owner_id = auth.uid()))
  with check (talk_id in (select id from public.talks where owner_id = auth.uid()));

create policy talk_state_entries_owner on public.talk_state_entries
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_outputs_owner on public.talk_outputs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_resource_bindings_owner on public.talk_resource_bindings
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy talk_message_attachments_owner on public.talk_message_attachments
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ── Main channel ────────────────────────────────────────────────────
create policy main_threads_owner on public.main_threads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy main_thread_summaries_owner on public.main_thread_summaries
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ── Jobs + telemetry ────────────────────────────────────────────────
create policy talk_jobs_owner on public.talk_jobs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy llm_attempts_owner on public.llm_attempts
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- llm_providers, llm_provider_models, llm_ttft_stats, settings_kv,
-- event_outbox, idempotency_cache are NOT in this file because they're
-- system-managed. The authenticated role can SELECT the provider catalog
-- via an explicit grant added below; everything else stays BYPASSRLS-only
-- (handled by the worker via direct queries from the pooled connection
-- before withUserContext enters the picture).

grant select on public.llm_providers to authenticated;
grant select on public.llm_provider_models to authenticated;
grant select on public.llm_ttft_stats to authenticated;
