-- 0032_agent_credential_mode.sql
--
-- Credential-mode UX redesign (plan:
-- ~/.claude/plans/wait-where-do-i-jaunty-metcalfe.md PR B section).
-- Lets users pin a registered agent to a specific credential mode
-- (api_key vs subscription) so the resolver's precedence walk can't
-- silently pick the "wrong" credential when both modes are configured
-- for the same provider.
--
-- Two columns:
--
-- 1. `registered_agents.credential_mode` — user's pinned choice for
--    this agent. NULL preserves the legacy precedence walk so existing
--    agents keep working without intervention.
--
-- 2. `talk_runs.credential_kind_snapshot` — credential kind resolved
--    AT ENQUEUE TIME. The executor reads this snapshot rather than
--    re-resolving live, so editing an agent's credential_mode while a
--    run is queued can't flip auth mid-flight. Null on legacy rows;
--    consumers fall back to live resolution (which respects the
--    agent's current credential_mode).
--
-- RLS: both columns inherit the existing row policies
-- (`registered_agents_owner`, `talk_runs_owner` in
-- supabase/migrations/0002_rls_policies.sql). No new grants needed.

alter table public.registered_agents
  add column credential_mode text;

alter table public.registered_agents
  add constraint registered_agents_credential_mode_check
    check (credential_mode is null
           or credential_mode in ('api_key', 'subscription'));

alter table public.talk_runs
  add column credential_kind_snapshot text;

alter table public.talk_runs
  add constraint talk_runs_credential_kind_snapshot_check
    check (credential_kind_snapshot is null
           or credential_kind_snapshot in ('api_key', 'subscription'));
