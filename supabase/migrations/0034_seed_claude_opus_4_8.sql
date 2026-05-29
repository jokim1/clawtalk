-- 0034_seed_claude_opus_4_8.sql
--
-- Add Claude Opus 4.8 (claude-opus-4-8) to the Anthropic provider's model
-- catalog. Anthropic launched Opus 4.8 on 2026-05-28; this exposes it as a
-- selectable model on the AI Agents card (the picker reads enabled rows
-- from public.llm_provider_models for provider.anthropic).
--
-- llm_provider_models is global + system-managed (no RLS, no per-tenant
-- data), so a static seed row is the right shape — same as 0007. The
-- insert is idempotent: it upserts by (provider_id, model_id), so
-- re-running is a no-op. Mirrors the new entry in
-- src/clawtalk/agents/builtin-additional-providers.ts. Capabilities
-- (tools/vision/pdf/long-context) are derived by the claude- prefix in
-- llm/capabilities.ts — no per-model capability row is needed.
--
-- Revert: delete from public.llm_provider_models
--   where provider_id = 'provider.anthropic' and model_id = 'claude-opus-4-8';

insert into public.llm_provider_models (
  provider_id, model_id, display_name, context_window_tokens,
  default_max_output_tokens, default_ttft_timeout_ms, enabled
) values
  (
    'provider.anthropic', 'claude-opus-4-8', 'Claude Opus 4.8',
    200000, 8192, 60000, true
  )
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  updated_at = now();
