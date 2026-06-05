import { getDbPg, withTrustedDbWrites } from '../../db.js';
import {
  getEffectiveToolsForAgent,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { getSettingValue } from '../db/core-accessors.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import type { LlmProviderRecord } from '../llm/types.js';
import {
  resolveExecution,
  type ExecutionBinding,
  type ExecutionResolverError,
} from './execution-resolver.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
} from '../config.js';

export const EXECUTOR_MAIN_PROJECT_PATH_KEY = 'executor.mainProjectPath';

export type ExecutionBackend = 'direct_http' | 'container';
export type ExecutionRouteReason =
  | 'normal'
  | 'subscription_fallback'
  | 'browser_fast_lane';
export type ExecutionCredentialSource =
  | 'db_secret'
  | 'env'
  | 'oauth_token'
  | 'auth_token'
  | 'missing';

export interface ContainerCredentialConfig {
  authMode: 'api_key' | 'subscription';
  credentialSource: ExecutionCredentialSource;
  secrets: Record<string, string>;
}

export interface DirectHttpExecutionPlan {
  backend: 'direct_http';
  routeReason: ExecutionRouteReason;
  authPath: 'api_key';
  credentialSource: ExecutionCredentialSource;
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  binding: ExecutionBinding;
}

export interface ContainerExecutionPlan {
  backend: 'container';
  routeReason: ExecutionRouteReason;
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  heavyToolFamilies: string[];
  containerCredential: ContainerCredentialConfig;
}

export type ExecutionPlan = DirectHttpExecutionPlan | ContainerExecutionPlan;

export type MainExecutionPolicy =
  | 'direct_only'
  | 'direct_with_promotion'
  | 'container_only';

export interface MainExecutionPlan {
  policy: MainExecutionPolicy;
  effectiveTools: EffectiveToolAccess[];
  heavyToolFamilies: string[];
  directPlan: DirectHttpExecutionPlan | null;
  containerPlan: ContainerExecutionPlan | null;
}

type ProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export class ExecutionPlannerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CONTAINER_BROWSER_REQUIRES_SHELL'
      | 'CONTAINER_CREDENTIAL_MISSING'
      | 'DIRECT_EXECUTION_UNAVAILABLE',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExecutionPlannerError';
  }
}

export function isAnthropicMissingDirectCredentialCode(code: unknown): boolean {
  return (
    code === 'ANTHROPIC_REQUIRES_API_KEY' ||
    code === 'ANTHROPIC_REQUIRES_CREDENTIAL'
  );
}

export function requiresAnthropicSubscriptionContainer(input: {
  providerId: string;
  configuredAuthMode:
    | 'subscription'
    | 'api_key'
    | 'advanced_bearer'
    | 'none'
    | null;
}): boolean {
  return (
    input.providerId === 'provider.anthropic' &&
    input.configuredAuthMode === 'subscription'
  );
}

const BASE_CONTAINER_ALLOWED_TOOLS = [
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;

async function getProviderRecord(
  providerId: string,
): Promise<LlmProviderRecord | undefined> {
  const db = getDbPg();
  const rows = await db<LlmProviderRecord[]>`
    select * from public.llm_providers where id = ${providerId} limit 1
  `;
  return rows[0];
}

async function resolvePlanningWorkspaceId(opts?: {
  workspaceId?: string | null;
  talkId?: string;
}): Promise<string | null> {
  if (opts?.workspaceId) return opts.workspaceId;
  if (!opts?.talkId) return null;
  const db = getDbPg();
  const rows = await db<Array<{ workspace_id: string | null }>>`
    select workspace_id::text as workspace_id
    from public.talks
    where id = ${opts.talkId}::uuid
    limit 1
  `;
  return rows[0]?.workspace_id ?? null;
}

export async function getProviderVerificationStatus(
  providerId: string,
  input: { principalUserId: string | null; workspaceId: string | null },
): Promise<ProviderVerificationStatus | null> {
  const db = getDbPg();

  const normalizeStatus = (
    status: string | null | undefined,
  ): ProviderVerificationStatus | null => {
    if (
      status === 'missing' ||
      status === 'not_verified' ||
      status === 'verifying' ||
      status === 'verified' ||
      status === 'invalid' ||
      status === 'unavailable'
    ) {
      return status;
    }
    return null;
  };

  const personalRows = await db<{ status: string | null }[]>`
    select v.status
    from public.llm_provider_secrets s
    left join public.llm_provider_verifications v
      on v.owner_id = s.owner_id
      and v.provider_id = s.provider_id
      and v.credential_kind = s.credential_kind
    where s.provider_id = ${providerId}
      and s.credential_kind = 'api_key'
      and ${input.principalUserId}::uuid is not null
      and s.owner_id = ${input.principalUserId}::uuid
    limit 1
  `;
  if (personalRows[0]) {
    return normalizeStatus(personalRows[0].status);
  }

  const workspaceRows = await withTrustedDbWrites(
    () => db<{ status: string | null }[]>`
      select v.status
      from public.workspace_provider_secrets s
      left join public.workspace_provider_verifications v
        on v.workspace_id = s.workspace_id
        and v.provider_id = s.provider_id
        and v.credential_kind = s.credential_kind
      where s.provider_id = ${providerId}
        and s.credential_kind = 'api_key'
        and ${input.workspaceId}::uuid is not null
        and s.workspace_id = ${input.workspaceId}::uuid
      limit 1
    `,
  );
  if (workspaceRows[0]) {
    return normalizeStatus(workspaceRows[0].status);
  }

  if (providerId === 'provider.anthropic' && TALK_EXECUTOR_ANTHROPIC_API_KEY) {
    return 'verified';
  }

  return null;
}

export async function getAnthropicApiKeyFromDb(input: {
  principalUserId: string | null;
  workspaceId: string | null;
}): Promise<string | null> {
  const db = getDbPg();
  // Precedence: the explicit execution principal's personal key first, then
  // the workspace-shared key set by an admin. Queue/service-role paths bypass
  // user RLS, so the personal lookup must carry an owner predicate.
  const personalRows = await db<{ ciphertext: string }[]>`
    select ciphertext from public.llm_provider_secrets
    where provider_id = 'provider.anthropic'
      and credential_kind = 'api_key'
      and ${input.principalUserId}::uuid is not null
      and owner_id = ${input.principalUserId}::uuid
    limit 1
  `;
  const personalCiphertext = personalRows[0]?.ciphertext ?? null;
  if (personalCiphertext) {
    try {
      return (await decryptProviderSecret(personalCiphertext)).apiKey.trim();
    } catch {
      // fall through to workspace key
    }
  }

  const workspaceRows = await withTrustedDbWrites(
    () => db<{ ciphertext: string }[]>`
      select ciphertext from public.workspace_provider_secrets
      where ${input.workspaceId}::uuid is not null
        and workspace_id = ${input.workspaceId}::uuid
        and provider_id = 'provider.anthropic'
        and credential_kind = 'api_key'
      limit 1
    `,
  );
  const workspaceCiphertext = workspaceRows[0]?.ciphertext ?? null;
  if (!workspaceCiphertext) {
    return null;
  }

  try {
    return (await decryptProviderSecret(workspaceCiphertext)).apiKey.trim();
  } catch {
    return null;
  }
}

export async function getConfiguredExecutorAuthMode(): Promise<
  'subscription' | 'api_key' | 'advanced_bearer' | 'none' | null
> {
  const mode = (await getSettingValue('executor.authMode'))?.trim() || '';
  if (
    mode === 'subscription' ||
    mode === 'api_key' ||
    mode === 'advanced_bearer' ||
    mode === 'none'
  ) {
    return mode;
  }
  return null;
}

export async function resolveContainerCredential(input?: {
  preferredAuthMode?: 'api_key' | 'subscription';
  principalUserId?: string | null;
  workspaceId?: string | null;
}): Promise<ContainerCredentialConfig> {
  const configuredAuthMode =
    (await getConfiguredExecutorAuthMode()) || undefined;
  const dbOauth =
    (await getSettingValue('executor.claudeOauthToken'))?.trim() || null;
  const dbAuth =
    (await getSettingValue('executor.anthropicAuthToken'))?.trim() || null;
  const envOauth = TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.trim() || null;
  const envAuth = TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.trim() || null;
  const dbApiKey = await getAnthropicApiKeyFromDb({
    principalUserId: input?.principalUserId ?? null,
    workspaceId: input?.workspaceId ?? null,
  });
  const apiKey = dbApiKey || TALK_EXECUTOR_ANTHROPIC_API_KEY;
  const normalizedApiKey = apiKey?.trim() || null;

  const inferredAuthMode =
    input?.preferredAuthMode ||
    configuredAuthMode ||
    (normalizedApiKey
      ? 'api_key'
      : dbOauth || envOauth || dbAuth || envAuth
        ? 'subscription'
        : 'none');

  if (inferredAuthMode === 'api_key') {
    if (!normalizedApiKey) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an Anthropic API key in executor settings or env.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'api_key',
      credentialSource: dbApiKey ? 'db_secret' : 'env',
      secrets: {
        ANTHROPIC_API_KEY: normalizedApiKey,
      },
    };
  }

  if (inferredAuthMode === 'subscription') {
    const secrets: Record<string, string> = {};
    const oauthToken = dbOauth || envOauth;
    if (oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
    const authToken = dbAuth || envAuth;
    if (authToken) {
      secrets.ANTHROPIC_AUTH_TOKEN = authToken;
    }
    if (Object.keys(secrets).length === 0) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an executor OAuth/auth token when subscription mode is selected.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'subscription',
      credentialSource: oauthToken ? 'oauth_token' : 'auth_token',
      secrets,
    };
  }

  throw new ExecutionPlannerError(
    'Container execution is not configured. Set executor Claude credentials before routing heavy-tool agents to the container backend.',
    'CONTAINER_CREDENTIAL_MISSING',
  );
}

function resolveHeavyToolFamilies(
  effectiveTools: EffectiveToolAccess[],
): string[] {
  const enabled = new Set(
    effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );

  const heavyFamilies: string[] = [];
  if (enabled.has('shell')) heavyFamilies.push('shell');
  if (enabled.has('filesystem')) heavyFamilies.push('filesystem');
  return heavyFamilies;
}

function isContainerCompatibleProvider(
  provider: LlmProviderRecord | undefined,
): boolean {
  return Boolean(
    provider &&
    provider.api_format === 'anthropic_messages' &&
    provider.core_compatibility === 'claude_sdk_proxy',
  );
}

export function getContainerAllowedTools(input: {
  effectiveTools: EffectiveToolAccess[];
  includeConnectorTools?: boolean;
}): string[] {
  const enabled = new Set(
    input.effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const allowed = new Set<string>(BASE_CONTAINER_ALLOWED_TOOLS);

  if (enabled.has('shell')) {
    allowed.add('Bash');
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
  }

  if (enabled.has('filesystem')) {
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
    allowed.add('Write');
    allowed.add('Edit');
  }

  if (enabled.has('web')) {
    allowed.add('WebSearch');
    allowed.add('WebFetch');
  }

  if (enabled.has('browser') || input.includeConnectorTools) {
    allowed.add('mcp__clawtalk__*');
  }

  return Array.from(allowed);
}

async function tryResolveDirectExecutionPlan(input: {
  agent: RegisteredAgentRecord;
  userId: string;
  workspaceId?: string | null;
  effectiveTools: EffectiveToolAccess[];
  provider: LlmProviderRecord | undefined;
  configuredAuthMode: Awaited<ReturnType<typeof getConfiguredExecutorAuthMode>>;
  allowAnthropicDirectWhenSubscriptionMode?: boolean;
}): Promise<DirectHttpExecutionPlan | null> {
  if (
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode === 'subscription' &&
    input.allowAnthropicDirectWhenSubscriptionMode !== true
  ) {
    return null;
  }

  if (
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode === 'subscription' &&
    input.allowAnthropicDirectWhenSubscriptionMode === true
  ) {
    const verificationStatus = await getProviderVerificationStatus(
      input.agent.provider_id,
      {
        principalUserId: input.userId,
        workspaceId: input.workspaceId ?? null,
      },
    );
    if (verificationStatus !== 'verified') {
      return null;
    }
  }

  try {
    const binding = await resolveExecution(input.agent, {
      credentialScope: {
        principalUserId: input.userId,
        workspaceId: input.workspaceId ?? null,
      },
    });
    if (binding.secret.credentialKind === 'subscription') {
      return null;
    }
    const dbApiKey =
      input.agent.provider_id === 'provider.anthropic'
        ? await getAnthropicApiKeyFromDb({
            principalUserId: input.userId,
            workspaceId: input.workspaceId ?? null,
          })
        : null;
    return {
      backend: 'direct_http',
      routeReason: 'normal',
      authPath: 'api_key',
      credentialSource:
        input.agent.provider_id === 'provider.anthropic'
          ? dbApiKey
            ? 'db_secret'
            : TALK_EXECUTOR_ANTHROPIC_API_KEY
              ? 'env'
              : 'missing'
          : 'db_secret',
      effectiveTools: input.effectiveTools,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
      binding,
    };
  } catch (error) {
    const resolverError = error as ExecutionResolverError;
    if (
      isAnthropicMissingDirectCredentialCode(resolverError?.code) &&
      isContainerCompatibleProvider(input.provider) &&
      input.configuredAuthMode !== 'api_key'
    ) {
      return null;
    }
    throw new ExecutionPlannerError(
      resolverError.message || 'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
      {
        resolverCode:
          resolverError && typeof resolverError === 'object'
            ? resolverError.code
            : undefined,
      },
    );
  }
}

async function tryResolveContainerExecutionPlan(input: {
  agent: RegisteredAgentRecord;
  userId: string;
  workspaceId?: string | null;
  effectiveTools: EffectiveToolAccess[];
  heavyToolFamilies: string[];
  provider: LlmProviderRecord | undefined;
  configuredAuthMode: Awaited<ReturnType<typeof getConfiguredExecutorAuthMode>>;
}): Promise<ContainerExecutionPlan | null> {
  if (!isContainerCompatibleProvider(input.provider)) {
    // Heavy tool families always resolve to [] now (the Claude container is
    // gone and getEffectiveToolsForAgent forces heavy families off), so an
    // incompatible provider simply has no container plan to build.
    return null;
  }

  const preferredAuthMode =
    input.heavyToolFamilies.length === 0 &&
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode !== 'api_key'
      ? 'subscription'
      : undefined;

  try {
    const containerCredential = await resolveContainerCredential({
      ...(preferredAuthMode ? { preferredAuthMode } : {}),
      principalUserId: input.userId,
      workspaceId: input.workspaceId ?? null,
    });
    return {
      backend: 'container',
      routeReason:
        preferredAuthMode === 'subscription'
          ? 'subscription_fallback'
          : 'normal',
      effectiveTools: input.effectiveTools,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
      heavyToolFamilies: input.heavyToolFamilies,
      containerCredential,
    };
  } catch (error) {
    if (error instanceof ExecutionPlannerError) {
      if (input.heavyToolFamilies.length > 0) {
        throw error;
      }
      return null;
    }
    throw error;
  }
}

export async function planExecution(
  agent: RegisteredAgentRecord,
  userId: string,
  opts?: {
    talkId?: string;
    workspaceId?: string | null;
    activeFamilies?: Record<string, boolean>;
  },
): Promise<ExecutionPlan> {
  const effectiveTools = await getEffectiveToolsForAgent(agent.id, opts);
  const browserEnabled = effectiveTools.some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  const heavyToolFamilies = resolveHeavyToolFamilies(effectiveTools);
  const provider = await getProviderRecord(agent.provider_id);
  const configuredAuthMode = await getConfiguredExecutorAuthMode();
  const workspaceId = await resolvePlanningWorkspaceId(opts);

  if (browserEnabled) {
    const directPlan = await tryResolveDirectExecutionPlan({
      agent,
      userId,
      workspaceId,
      effectiveTools,
      provider,
      configuredAuthMode,
    });
    const shouldPreferSubscriptionContainer =
      requiresAnthropicSubscriptionContainer({
        providerId: agent.provider_id,
        configuredAuthMode,
      });
    const containerPlan = await tryResolveContainerExecutionPlan({
      agent,
      userId,
      effectiveTools,
      heavyToolFamilies,
      provider,
      configuredAuthMode,
      workspaceId,
    });

    if (heavyToolFamilies.length > 0) {
      if (containerPlan) return containerPlan;
      if (directPlan) return directPlan;
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }

    if (shouldPreferSubscriptionContainer && containerPlan) {
      return {
        ...containerPlan,
        routeReason: 'normal',
      };
    }
    if (shouldPreferSubscriptionContainer && !containerPlan) {
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    if (directPlan) {
      return directPlan;
    }
    if (containerPlan) {
      return containerPlan;
    }
    throw new ExecutionPlannerError(
      'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }
  if (
    heavyToolFamilies.length === 0 &&
    agent.provider_id === 'provider.anthropic' &&
    isContainerCompatibleProvider(provider) &&
    configuredAuthMode === 'subscription'
  ) {
    const containerPlan = await tryResolveContainerExecutionPlan({
      agent,
      userId,
      effectiveTools,
      heavyToolFamilies: [],
      provider,
      configuredAuthMode,
      workspaceId,
    });
    if (containerPlan) {
      return {
        ...containerPlan,
        routeReason: 'normal',
      };
    }
    throw new ExecutionPlannerError(
      'Container execution is not configured for this agent.',
      'CONTAINER_CREDENTIAL_MISSING',
    );
  }

  if (heavyToolFamilies.length === 0) {
    const directPlan = await tryResolveDirectExecutionPlan({
      agent,
      userId,
      workspaceId,
      effectiveTools,
      provider,
      configuredAuthMode,
    });
    if (directPlan) return directPlan;

    const containerPlan = await tryResolveContainerExecutionPlan({
      agent,
      userId,
      effectiveTools,
      heavyToolFamilies: [],
      provider,
      configuredAuthMode,
      workspaceId,
    });
    if (containerPlan) return containerPlan;

    throw new ExecutionPlannerError(
      'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  const containerPlan = await tryResolveContainerExecutionPlan({
    agent,
    userId,
    effectiveTools,
    heavyToolFamilies,
    provider,
    configuredAuthMode,
    workspaceId,
  });
  if (!containerPlan) {
    throw new ExecutionPlannerError(
      'Container execution is not configured for this agent.',
      'CONTAINER_CREDENTIAL_MISSING',
    );
  }
  return containerPlan;
}

export async function planMainExecution(
  agent: RegisteredAgentRecord,
  userId: string,
  opts?: {
    talkId?: string;
    workspaceId?: string | null;
    activeFamilies?: Record<string, boolean>;
  },
): Promise<MainExecutionPlan> {
  const effectiveTools = await getEffectiveToolsForAgent(agent.id, opts);
  const browserEnabled = effectiveTools.some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  const heavyToolFamilies = resolveHeavyToolFamilies(effectiveTools);
  const provider = await getProviderRecord(agent.provider_id);
  const configuredAuthMode = await getConfiguredExecutorAuthMode();
  const workspaceId = await resolvePlanningWorkspaceId(opts);

  let directPlan: DirectHttpExecutionPlan | null = null;
  try {
    directPlan = await tryResolveDirectExecutionPlan({
      agent,
      userId,
      workspaceId,
      effectiveTools,
      provider,
      configuredAuthMode,
      allowAnthropicDirectWhenSubscriptionMode: browserEnabled,
    });
  } catch (error) {
    if (
      !(error instanceof ExecutionPlannerError) ||
      error.code !== 'DIRECT_EXECUTION_UNAVAILABLE'
    ) {
      throw error;
    }
  }
  const containerPlan = await tryResolveContainerExecutionPlan({
    agent,
    userId,
    effectiveTools,
    heavyToolFamilies,
    provider,
    configuredAuthMode,
    workspaceId,
  });
  const shouldRequireSubscriptionContainer =
    requiresAnthropicSubscriptionContainer({
      providerId: agent.provider_id,
      configuredAuthMode,
    });

  if (browserEnabled && heavyToolFamilies.length === 0) {
    if (directPlan) {
      return {
        policy: 'direct_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan,
        containerPlan,
      };
    }
    if (containerPlan) {
      return {
        policy: 'container_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan: null,
        containerPlan,
      };
    }
    if (shouldRequireSubscriptionContainer) {
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    throw new ExecutionPlannerError(
      'No valid Main execution path is currently configured for this agent.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  if (heavyToolFamilies.length === 0) {
    if (directPlan) {
      return {
        policy: 'direct_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan,
        containerPlan,
      };
    }
    if (containerPlan) {
      return {
        policy: 'container_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan: null,
        containerPlan,
      };
    }
    if (shouldRequireSubscriptionContainer) {
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    throw new ExecutionPlannerError(
      'No valid Main execution path is currently configured for this agent.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  if (directPlan && containerPlan) {
    return {
      policy: 'direct_with_promotion',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan,
    };
  }

  if (containerPlan) {
    return {
      policy: 'container_only',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan,
    };
  }

  if (directPlan) {
    return {
      policy: 'direct_only',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan: null,
    };
  }

  throw new ExecutionPlannerError(
    'No valid Main execution path is currently configured for this agent.',
    'DIRECT_EXECUTION_UNAVAILABLE',
  );
}
