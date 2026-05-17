/**
 * execution-resolver.ts
 *
 * Single source of truth for resolving how an agent should be executed
 * via the direct HTTP path (agent-router.ts → llm-client.ts).
 *
 * This module is the ONLY place that merges:
 *   - agent config (registered_agents row)
 *   - provider config (llm_providers row)
 *   - credential source (llm_provider_secrets or env-var fallback)
 *   - auth scheme compatibility
 *
 * agent-router.ts calls `resolveExecution()` and receives a ready-to-use
 * binding, or a hard failure explaining why execution is not possible.
 *
 * ── v1 scope ──
 *
 * The direct HTTP path supports ANY provider with an API key stored in
 * `llm_provider_secrets` (OpenAI, Gemini, DeepSeek, etc.) and the special
 * case of `provider.anthropic` where the API key may also come from the
 * `ANTHROPIC_API_KEY` env var managed by the host layer.
 *
 * Claude subscription/OAuth credentials (CLAUDE_CODE_OAUTH_TOKEN,
 * ANTHROPIC_AUTH_TOKEN) are NOT compatible with the direct HTTP path.
 * They require the container executor or a compatible proxy — both of
 * which are outside the scope of this module.  If a user is in
 * subscription/OAuth mode without a proxy, agent creation through the
 * registered-agents panel for Anthropic is not supported.  The resolver
 * will reject with a clear error rather than sending an invalid auth
 * header to api.anthropic.com.
 */

import { getDbPg, type Sql } from '../../db.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../llm/provider-secret-store.js';
import {
  isAnthropicOauthCredentialExpiring,
  refreshAnthropicOauthToken,
} from '../llm/anthropic-oauth.js';
import {
  isOpenAiCodexCredentialExpiring,
  refreshOpenAiCodexOauthToken,
} from '../llm/openai-codex-oauth.js';
import type { LlmProviderConfig, LlmSecret } from './llm-client.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_BASE_URL,
} from '../config.js';

interface LlmProviderRow {
  id: string;
  base_url: string | null;
  api_format: LlmProviderConfig['apiFormat'];
  auth_scheme: LlmProviderConfig['authScheme'] | null;
  response_start_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  absolute_timeout_ms: number | null;
}

interface LlmProviderModelRow {
  default_max_output_tokens: number;
}

interface LlmProviderSecretRow {
  ciphertext: string;
  credential_kind: 'api_key' | 'subscription';
  encrypted_refresh_token: string | null;
  expires_at: string | null;
}

type CredentialOrigin = 'personal' | 'workspace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionBinding {
  /** Provider config for the LLM client (base URL, api format, auth scheme). */
  providerConfig: LlmProviderConfig;
  /** Credential to send with the request. */
  secret: LlmSecret;
  /** Default output budget configured for this provider/model pair. */
  defaultMaxOutputTokens?: number;
}

export class ExecutionResolverError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ExecutionResolverError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve everything needed to execute the given agent via direct HTTP.
 *
 * Returns a ready-to-use ExecutionBinding or throws an
 * ExecutionResolverError with a machine-readable code.
 */
export async function resolveExecution(
  agent: RegisteredAgentRecord,
): Promise<ExecutionBinding> {
  const db: Sql = getDbPg();

  // --- Step 1: Load provider row ---
  const providerRows = await db<LlmProviderRow[]>`
    select id, base_url, api_format, auth_scheme,
           response_start_timeout_ms, stream_idle_timeout_ms,
           absolute_timeout_ms
    from public.llm_providers
    where id = ${agent.provider_id}
    limit 1
  `;
  const providerRecord = providerRows[0];

  if (!providerRecord) {
    throw new ExecutionResolverError(
      `Provider ${agent.provider_id} not found`,
      'PROVIDER_NOT_FOUND',
    );
  }

  // --- Step 2: Resolve credentials ---
  const secret = await resolveSecret(agent, db);

  // --- Step 3: Build provider config ---
  // For provider.anthropic, honour the ANTHROPIC_BASE_URL env var override
  // so the host layer can point agents at a proxy without touching the DB.
  const baseUrl =
    agent.provider_id === 'provider.anthropic' &&
    TALK_EXECUTOR_ANTHROPIC_BASE_URL
      ? TALK_EXECUTOR_ANTHROPIC_BASE_URL
      : (providerRecord.base_url ?? '');

  const providerConfig: LlmProviderConfig = {
    providerId: agent.provider_id,
    baseUrl,
    apiFormat: providerRecord.api_format,
    authScheme: providerRecord.auth_scheme ?? 'x_api_key',
    responseStartTimeoutMs:
      providerRecord.response_start_timeout_ms ?? undefined,
    streamIdleTimeoutMs: providerRecord.stream_idle_timeout_ms ?? undefined,
    absoluteTimeoutMs: providerRecord.absolute_timeout_ms ?? undefined,
  };

  const modelRows = await db<LlmProviderModelRow[]>`
    select default_max_output_tokens
    from public.llm_provider_models
    where provider_id = ${agent.provider_id} and model_id = ${agent.model_id}
    limit 1
  `;

  return {
    providerConfig,
    secret,
    defaultMaxOutputTokens: modelRows[0]?.default_max_output_tokens,
  };
}

/**
 * Check whether direct HTTP execution is possible for `provider.anthropic`.
 *
 * This is intended for the frontend to determine whether to show Claude as
 * a ready provider in the registered-agents panel.  Returns true only when
 * an Anthropic API key is available (directly or via env var).
 *
 * Subscription/OAuth credentials are NOT sufficient for direct HTTP
 * execution and this function returns false for them.
 */
export async function isAnthropicDirectHttpReady(): Promise<boolean> {
  if (TALK_EXECUTOR_ANTHROPIC_API_KEY) return true;

  const db: Sql = getDbPg();
  const personalRows = await db`
    select 1 as one
    from public.llm_provider_secrets
    where provider_id = ${'provider.anthropic'}
    limit 1
  `;
  if (personalRows.length > 0) return true;

  const workspaceRows = await db`
    select 1 as one
    from public.workspace_provider_secrets
    where provider_id = ${'provider.anthropic'}
    limit 1
  `;
  return workspaceRows.length > 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve the API credential for an agent.
 *
 * 1. Try llm_provider_secrets (works for all providers).
 * 2. For provider.anthropic only: fall back to ANTHROPIC_API_KEY env var.
 *    OAuth/auth tokens are NOT used — they are incompatible with the
 *    x-api-key auth scheme required by api.anthropic.com.
 * 3. If nothing found, throw a clear error.
 */
async function resolveSecret(
  agent: RegisteredAgentRecord,
  db: Sql,
): Promise<LlmSecret> {
  // Order precedence:
  //   1. Personal api_key
  //   2. Personal subscription (OAuth)
  //   3. Workspace api_key
  //   4. Workspace subscription (OAuth)
  //   5. Env var (Anthropic only)
  //
  // Per-user RLS scopes the personal queries to auth.uid() automatically.
  const personalRows = await db<LlmProviderSecretRow[]>`
    select ciphertext, credential_kind, encrypted_refresh_token,
           expires_at::text as expires_at
    from public.llm_provider_secrets
    where provider_id = ${agent.provider_id}
    order by case credential_kind
      when 'api_key' then 0
      when 'subscription' then 1
    end asc
    limit 2
  `;

  for (const row of personalRows) {
    const secret = await tryUseSecretRow({
      providerId: agent.provider_id,
      origin: 'personal',
      row,
    });
    if (secret) return secret;
  }

  const workspaceRows = await db<LlmProviderSecretRow[]>`
    select ciphertext, credential_kind, encrypted_refresh_token,
           expires_at::text as expires_at
    from public.workspace_provider_secrets
    where provider_id = ${agent.provider_id}
    order by case credential_kind
      when 'api_key' then 0
      when 'subscription' then 1
    end asc
    limit 2
  `;

  for (const row of workspaceRows) {
    const secret = await tryUseSecretRow({
      providerId: agent.provider_id,
      origin: 'workspace',
      row,
    });
    if (secret) return secret;
  }

  // For provider.anthropic: fall back to the API key env var ONLY.
  if (
    agent.provider_id === 'provider.anthropic' &&
    TALK_EXECUTOR_ANTHROPIC_API_KEY
  ) {
    return {
      apiKey: TALK_EXECUTOR_ANTHROPIC_API_KEY,
      credentialKind: 'api_key',
    };
  }

  if (agent.provider_id === 'provider.anthropic') {
    throw new ExecutionResolverError(
      'No Anthropic credentials configured. Add an Anthropic API key in ' +
        'Settings → API Keys, or connect a Claude subscription.',
      'ANTHROPIC_REQUIRES_CREDENTIAL',
    );
  }

  throw new ExecutionResolverError(
    `No API credentials found for provider ${agent.provider_id}`,
    'PROVIDER_SECRET_MISSING',
  );
}

async function tryUseSecretRow(input: {
  providerId: string;
  origin: CredentialOrigin;
  row: LlmProviderSecretRow;
}): Promise<LlmSecret | null> {
  const { providerId, origin, row } = input;

  if (row.credential_kind === 'subscription') {
    return resolveSubscriptionSecret({ providerId, origin, row });
  }

  try {
    const decrypted = await decryptProviderSecret(row.ciphertext);
    return { ...decrypted, credentialKind: 'api_key' };
  } catch {
    throw new ExecutionResolverError(
      `Failed to decrypt provider secret for ${providerId}`,
      'SECRET_DECRYPTION_FAILED',
    );
  }
}

async function resolveSubscriptionSecret(input: {
  providerId: string;
  origin: CredentialOrigin;
  row: LlmProviderSecretRow;
}): Promise<LlmSecret> {
  const { providerId, origin, row } = input;

  const expiring =
    providerId === 'provider.openai_codex'
      ? isOpenAiCodexCredentialExpiring(row.expires_at)
      : providerId === 'provider.anthropic'
        ? isAnthropicOauthCredentialExpiring(row.expires_at)
        : false;

  if (expiring && row.encrypted_refresh_token) {
    const refreshedAccess = await refreshAndPersist({
      providerId,
      origin,
      encryptedRefreshToken: row.encrypted_refresh_token,
    });
    return { apiKey: refreshedAccess, credentialKind: 'subscription' };
  }

  try {
    const decrypted = await decryptProviderSecret(row.ciphertext);
    return { apiKey: decrypted.apiKey, credentialKind: 'subscription' };
  } catch {
    throw new ExecutionResolverError(
      `Failed to decrypt subscription credential for ${providerId}`,
      'SECRET_DECRYPTION_FAILED',
    );
  }
}

async function refreshAndPersist(input: {
  providerId: string;
  origin: CredentialOrigin;
  encryptedRefreshToken: string;
}): Promise<string> {
  const refreshTokenPayload = await decryptProviderSecret(
    input.encryptedRefreshToken,
  );
  const refreshed =
    input.providerId === 'provider.openai_codex'
      ? await refreshOpenAiCodexOauthToken(refreshTokenPayload.apiKey)
      : await refreshAnthropicOauthToken(refreshTokenPayload.apiKey);

  const encryptedAccess = await encryptProviderSecret({
    apiKey: refreshed.accessToken,
  });
  const encryptedRefresh = await encryptProviderSecret({
    apiKey: refreshed.refreshToken,
  });

  const db = getDbPg();
  if (input.origin === 'workspace') {
    await db`
      update public.workspace_provider_secrets
      set ciphertext = ${encryptedAccess},
          encrypted_refresh_token = ${encryptedRefresh},
          expires_at = ${refreshed.expiresAtIso}::timestamptz,
          updated_at = now()
      where provider_id = ${input.providerId}
        and credential_kind = 'subscription'
    `;
  } else {
    await db`
      update public.llm_provider_secrets
      set ciphertext = ${encryptedAccess},
          encrypted_refresh_token = ${encryptedRefresh},
          expires_at = ${refreshed.expiresAtIso}::timestamptz,
          updated_at = now()
      where provider_id = ${input.providerId}
        and credential_kind = 'subscription'
    `;
  }
  return refreshed.accessToken;
}
