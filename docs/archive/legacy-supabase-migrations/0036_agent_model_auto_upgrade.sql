-- 0036_agent_model_auto_upgrade.sql
--
-- Track when an agent's configured model was auto-upgraded because the
-- provider retired the old one. The AI Agents UI reads these to show a
-- "Model retired — upgraded to X" badge until the user acknowledges it.
--
-- model_auto_upgraded_from: the retired model id the agent was moved off
--   (non-null = show the badge; null = nothing to show).
-- model_auto_upgraded_at:   when the auto-upgrade happened (for the badge
--   copy + ordering).
--
-- Both are cleared when the user dismisses the notice or manually changes
-- the agent's model. "Update available" (a newer-but-still-supported model)
-- is computed live and needs no persistence — it is NOT recorded here.
--
-- registered_agents already has RLS (0002) scoping rows to the owner;
-- adding nullable columns needs no policy/grant change.
--
-- Revert:
--   alter table public.registered_agents
--     drop column if exists model_auto_upgraded_from,
--     drop column if exists model_auto_upgraded_at;

alter table public.registered_agents
  add column if not exists model_auto_upgraded_from text,
  add column if not exists model_auto_upgraded_at timestamptz;
