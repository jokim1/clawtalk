-- 0007_seed_builtin_llm_providers.sql
--
-- Seed the builtin LLM provider catalog so the AI Agents UI can render
-- per-provider credential cards. Before this migration, `llm_providers`
-- was empty on cloud Worker deployments (no bootstrap mechanism) so
-- `GET /api/v1/agents` returned an empty `additionalProviders` list and
-- users couldn't save any API keys — every per-provider write was
-- blocked by the foreign-key reference to a missing row.
--
-- Both tables are global, system-managed (no RLS, no per-tenant data),
-- so a static seed is the right shape. Inserts are idempotent: provider
-- rows upsert by id, model rows upsert by (provider_id, model_id).
--
-- Provider list mirrors BUILTIN_ADDITIONAL_PROVIDERS in
-- src/clawtalk/agents/builtin-additional-providers.ts. Anthropic was
-- previously managed via the chassis-era /api/v1/settings/executor API
-- (501 on Workers); it now lives here so it gets a credential card in
-- the AI Agents UI like every other provider.

insert into public.llm_providers (
  id, name, provider_kind, api_format, base_url, auth_scheme,
  enabled, response_start_timeout_ms, stream_idle_timeout_ms,
  absolute_timeout_ms
) values
  (
    'provider.anthropic', 'Claude (Anthropic)', 'anthropic',
    'anthropic_messages', 'https://api.anthropic.com', 'x_api_key',
    true, 60000, 20000, 300000
  ),
  (
    'provider.openai', 'OpenAI', 'openai',
    'openai_chat_completions', 'https://api.openai.com/v1', 'bearer',
    true, 60000, 20000, 300000
  ),
  (
    'provider.gemini', 'Google / Gemini', 'gemini',
    'openai_chat_completions',
    'https://generativelanguage.googleapis.com/v1beta/openai', 'bearer',
    true, 90000, 20000, 300000
  ),
  (
    'provider.nvidia', 'NVIDIA Kimi2.5', 'nvidia',
    'openai_chat_completions',
    'https://integrate.api.nvidia.com/v1', 'bearer',
    true, 90000, 20000, 300000
  )
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
  default_max_output_tokens, default_ttft_timeout_ms, enabled
) values
  (
    'provider.anthropic', 'claude-opus-4-7', 'Claude Opus 4.7',
    200000, 8192, 60000, true
  ),
  (
    'provider.anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6',
    200000, 8192, 45000, true
  ),
  (
    'provider.anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5',
    200000, 8192, 30000, true
  ),
  (
    'provider.openai', 'gpt-5-mini', 'GPT-5 Mini',
    128000, 4096, 30000, true
  ),
  (
    'provider.gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash',
    1000000, 8192, 45000, true
  ),
  (
    'provider.nvidia', 'moonshotai/kimi-k2.5', 'Kimi 2.5 (NVIDIA)',
    262144, 16384, 60000, true
  )
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  updated_at = now();
