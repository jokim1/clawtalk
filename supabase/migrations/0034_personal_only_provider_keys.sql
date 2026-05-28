-- 0034_personal_only_provider_keys.sql
--
-- Collapse the half-built personal/workspace BYOK split to personal-only.
-- Joseph is the sole user; the workspace concept will be redesigned from
-- scratch when real org/workspace requirements arrive, so the existing
-- workspace_provider_* tables and the provider_oauth_states.scope column
-- carry plumbing without value today.
--
-- Drops:
--   - public.workspace_provider_verifications (added in 0008)
--   - public.workspace_provider_secrets       (added in 0008, altered in 0010)
--   - public.provider_oauth_states.scope      (added in 0010)
--
-- Kept:
--   - public.current_user_is_workspace_admin() — still used by
--     workspace_channels (0019), workspace_data_connectors (0020),
--     and workspace_slack_installs (0023) RLS policies. The connector
--     surface is a separate stub and is out of scope for this migration.
--
-- Revert path: restore the table DDL from 0008, re-apply the 0010
-- ALTER TABLE blocks that added credential_kind / encrypted_refresh_token
-- / expires_at to the workspace tables, and re-add the
-- `scope text not null check (scope in ('user','workspace'))` column on
-- provider_oauth_states. Application code branched on `scope === 'workspace'`
-- can be recovered from the diff that landed alongside this migration.

drop table if exists public.workspace_provider_verifications;
drop table if exists public.workspace_provider_secrets;

alter table public.provider_oauth_states
  drop column if exists scope;
