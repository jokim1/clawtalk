-- 0035_default_claude_model_opus_4_8.sql
--
-- Make Claude Opus 4.8 (claude-opus-4-8, added in 0034) the default Claude
-- model. The AI Agents page resolves its preselected Claude model from
-- settings_kv['executor.defaultClaudeModel'] (see ai-agents.ts
-- getSavedDefaultClaudeModelId); seeding it here promotes Opus 4.8 in prod.
--
-- settings_kv is a global key/value config table (no RLS, no per-tenant
-- data). This is a one-shot seed: each migration applies exactly once, so a
-- later change via the AI Agents UI (which upserts the same key) persists
-- and is NOT clobbered on subsequent deploys.
--
-- Revert: update public.settings_kv set value = 'claude-opus-4-7'
--           where key = 'executor.defaultClaudeModel';
--         (or delete the row to fall back to the resolver default)

insert into public.settings_kv (key, value)
values ('executor.defaultClaudeModel', 'claude-opus-4-8')
on conflict (key) do update set
  value = excluded.value,
  updated_at = now();
