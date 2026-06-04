import { getDbPg, withTrustedDbWrites, withUserContext } from '../../../db.js';
import {
  autoUpgradeAgentModel,
  clearAgentModelUpgradeNotice,
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  listRegisteredAgents,
  toAgentSnapshot,
  updateRegisteredAgent,
  type RegisteredAgentCredentialMode,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
} from '../../db/agent-accessors.js';
import {
  getDefaultTalkAgentId,
  getDefaultTalkAgentIdOrNull,
  getMainAgentId,
  getMainAgentIdOrNull,
  setMainAgentId,
} from '../../agents/agent-registry.js';
import {
  buildProviderModelSupport,
  resolveRetirementTarget,
  type ProviderModelSupport,
} from '../../agents/agent-model-support.js';
import { resolveModelLifecycle } from '../../agents/model-lifecycle.js';
import { TALK_EXECUTOR_ANTHROPIC_API_KEY } from '../../config.js';
import { modelSupportsVision } from '../../llm/capabilities.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Persona-aware snapshot returned by registered-agent routes.
//
// After the chassis purge, every agent runs through direct HTTP, so the
// execution preview collapses to "do we have a credential for the provider?".
// We still emit the legacy shape (backend / authPath / routeReason etc.) so
// the webapp's existing UI code keeps working without conditional wiring.
// ---------------------------------------------------------------------------

type ExecutionPreview = {
  surface: 'main';
  backend: 'direct_http' | null;
  authPath: 'api_key' | null;
  selectedMode: 'api' | null;
  transport: 'direct' | null;
  reasonCode: string | null;
  routeReason: 'normal' | 'no_valid_path';
  ready: boolean;
  message: string;
};

export type RegisteredAgentApiSnapshot = RegisteredAgentSnapshot & {
  executionPreview: ExecutionPreview;
  // A newer, still-supported model in the same family is available. Purely
  // informational — the user opts in via the normal model-update flow; we
  // never auto-change a supported model. Null when nothing newer exists.
  // (The auto-upgrade case for a RETIRED model is carried by the base
  // snapshot's modelAutoUpgradedFrom/At fields.)
  modelUpdateAvailable: { modelId: string; displayName: string | null } | null;
  // Vision capability is the agent's ground truth — sourced from
  // `resolveModelCapabilities(providerId, modelId)` on the backend. The
  // frontend uses this for the composer's image-attachment guard on the
  // Main slot, where the TalkAgent row stores modelId=null and the
  // additionalProviders model lookup misses for subscription providers
  // whose curated model row isn't materialized into modelSuggestions
  // (e.g. Codex's gpt-5.4 capability is true even when the suggestion
  // list omits it).
  supportsVision: boolean;
};

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveActiveWorkspace(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<
  | { ok: true; workspace: WorkspaceSummaryRecord }
  | { ok: false; result: { statusCode: number; body: ApiEnvelope<never> } }
> {
  if (requestedWorkspaceId && !UUID_RE.test(requestedWorkspaceId)) {
    return {
      ok: false,
      result: envelopeError(
        400,
        'invalid_workspace_id',
        'workspaceId must be a valid UUID.',
      ),
    };
  }
  await ensureWorkspaceBootstrapForUser(auth.userId);
  const workspace = await withUserContext(auth.userId, () =>
    resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId,
    }),
  );
  if (!workspace) {
    return {
      ok: false,
      result: envelopeError(
        requestedWorkspaceId ? 403 : 404,
        requestedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        requestedWorkspaceId
          ? 'Workspace is not available for this user.'
          : 'No workspace exists.',
      ),
    };
  }
  return { ok: true, workspace };
}

async function providerHasCredential(
  providerId: string,
  principalUserId: string,
  workspaceId: string,
): Promise<boolean> {
  const db = getDbPg();
  // Direct HTTP readiness only counts API keys. Subscription rows are valid
  // executor credentials, but they cannot back the direct_http/api_key preview.
  const personal = await db<Array<{ ok: number }>>`
    select 1 as ok from public.llm_provider_secrets
    where provider_id = ${providerId}
      and credential_kind = 'api_key'
      and ${principalUserId}::uuid is not null
      and owner_id = ${principalUserId}::uuid
    limit 1
  `;
  if (personal.length > 0) return true;
  const workspace = await withTrustedDbWrites(
    () => db<Array<{ ok: number }>>`
      select 1 as ok from public.workspace_provider_secrets
      where workspace_id = ${workspaceId}::uuid
        and provider_id = ${providerId}
        and credential_kind = 'api_key'
      limit 1
    `,
  );
  if (workspace.length > 0) return true;
  if (providerId === 'provider.anthropic') {
    return TALK_EXECUTOR_ANTHROPIC_API_KEY.trim().length > 0;
  }
  return false;
}

async function getProviderName(providerId: string): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<Array<{ name: string }>>`
    select name from public.llm_providers
    where id = ${providerId}
    limit 1
  `;
  return rows[0]?.name ?? null;
}

async function buildExecutionPreview(
  record: RegisteredAgentRecord,
  principalUserId: string,
  workspaceId: string,
): Promise<ExecutionPreview> {
  const providerName =
    (await getProviderName(record.provider_id)) || record.provider_id;
  if (
    !(await providerHasCredential(
      record.provider_id,
      principalUserId,
      workspaceId,
    ))
  ) {
    return {
      surface: 'main',
      backend: null,
      authPath: null,
      selectedMode: null,
      transport: null,
      reasonCode: 'credential_missing',
      routeReason: 'no_valid_path',
      ready: false,
      message: `No API credential is configured for ${providerName}. Add one from AI Agents → Provider Setup.`,
    };
  }
  return {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: `Ready to run via ${providerName} direct HTTP.`,
  };
}

async function toApiSnapshot(
  record: RegisteredAgentRecord,
  principalUserId: string,
  workspaceId: string,
  modelUpdateAvailable: RegisteredAgentApiSnapshot['modelUpdateAvailable'] = null,
): Promise<RegisteredAgentApiSnapshot> {
  return {
    ...toAgentSnapshot(record),
    executionPreview: await buildExecutionPreview(
      record,
      principalUserId,
      workspaceId,
    ),
    supportsVision: modelSupportsVision(record.provider_id, record.model_id),
    modelUpdateAvailable,
  };
}

function envelopeOk<T>(data: T): { statusCode: number; body: ApiEnvelope<T> } {
  return { statusCode: 200, body: { ok: true, data } };
}

function envelopeError(
  statusCode: number,
  code: string,
  message: string,
): { statusCode: number; body: ApiEnvelope<never> } {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function readStringField(
  body: Record<string, unknown> | null,
  key: string,
): string | null | undefined {
  if (!body || !(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * Parse credentialMode out of the request body. Returns the literal
 * 'api_key' / 'subscription' values, `null` to clear the pin (i.e.
 * fall back to the resolver's auto precedence), or undefined when the
 * key is absent (leave the column unchanged on update). Throws a
 * sentinel error for invalid values so the caller can map to a 400.
 */
class InvalidCredentialModeError extends Error {}
function readCredentialModeField(
  body: Record<string, unknown> | null,
): RegisteredAgentCredentialMode | null | undefined {
  if (!body || !('credentialMode' in body)) return undefined;
  const value = body.credentialMode;
  if (value === null) return null;
  if (value === 'api_key' || value === 'subscription') return value;
  throw new InvalidCredentialModeError(
    "credentialMode must be 'api_key', 'subscription', or null.",
  );
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

/**
 * Apply the model-lifecycle policy to one agent:
 *   - retired          → auto-upgrade to the newest same-family model (or
 *                        the provider default if it's still supported),
 *                        persisting the trail; returns the upgraded record.
 *   - update_available → returns the record + a (non-mutating) suggestion.
 *   - ok               → returns the record unchanged.
 */
async function applyModelLifecycle(
  record: RegisteredAgentRecord,
  support: ProviderModelSupport,
): Promise<{
  record: RegisteredAgentRecord;
  updateAvailable: RegisteredAgentApiSnapshot['modelUpdateAvailable'];
}> {
  const lifecycle = resolveModelLifecycle(
    record.provider_id,
    record.model_id,
    support.supported,
  );

  if (lifecycle.status === 'retired') {
    // Shared with the run-time safety net so page-load and run-time can't
    // diverge on the target: newest served same-family ?? served default ?? null.
    const target = await resolveRetirementTarget(record, support);
    if (target && target !== record.model_id) {
      const upgraded = await autoUpgradeAgentModel(
        record.id,
        record.model_id,
        target,
      );
      if (upgraded) return { record: upgraded, updateAvailable: null };
    }
    // No safe target — leave as-is; the run-time net / a clear error
    // surfaces it rather than swapping to another dead model.
    return { record, updateAvailable: null };
  }

  if (lifecycle.status === 'update_available' && lifecycle.suggestedModelId) {
    return {
      record,
      updateAvailable: {
        modelId: lifecycle.suggestedModelId,
        displayName:
          support.displayNames.get(lifecycle.suggestedModelId) ?? null,
      },
    };
  }

  return { record, updateAvailable: null };
}

export async function listAgentsRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot[]>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  return withUserContext(auth.userId, async () => {
    const records = await listRegisteredAgents(workspace.workspace.id);
    // Build the authoritative supported-model picture once per distinct
    // provider, then apply the lifecycle policy (auto-upgrade retired /
    // flag newer) to each agent.
    const providerIds = [...new Set(records.map((r) => r.provider_id))];
    const supportByProvider = new Map<string, ProviderModelSupport>(
      await Promise.all(
        providerIds.map(
          async (pid) =>
            [
              pid,
              await buildProviderModelSupport(pid, {
                principalUserId: auth.userId,
                workspaceId: workspace.workspace.id,
              }),
            ] as const,
        ),
      ),
    );
    const snapshots: RegisteredAgentApiSnapshot[] = [];
    for (const record of records) {
      const support = supportByProvider.get(record.provider_id)!;
      const { record: effective, updateAvailable } = await applyModelLifecycle(
        record,
        support,
      );
      snapshots.push(
        await toApiSnapshot(
          effective,
          auth.userId,
          workspace.workspace.id,
          updateAvailable,
        ),
      );
    }
    return envelopeOk(snapshots);
  });
}

export async function getAgentRoute(
  auth: AuthContext,
  agentId: string,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  return withUserContext(auth.userId, async () => {
    const record = await getRegisteredAgent(agentId, workspace.workspace.id);
    if (!record) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    // Same lifecycle handling as the list route, so a single-agent fetch
    // (detail view, post-update refresh) auto-heals + flags consistently.
    const support = await buildProviderModelSupport(record.provider_id, {
      principalUserId: auth.userId,
      workspaceId: workspace.workspace.id,
    });
    const { record: effective, updateAvailable } = await applyModelLifecycle(
      record,
      support,
    );
    return envelopeOk(
      await toApiSnapshot(
        effective,
        auth.userId,
        workspace.workspace.id,
        updateAvailable,
      ),
    );
  });
}

/**
 * Dismiss the "model retired — auto-upgraded" badge for an agent. Clears
 * the persisted trail; the agent's (already-upgraded) model is untouched.
 */
export async function dismissAgentModelUpgradeRoute(
  auth: AuthContext,
  agentId: string,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  return withUserContext(auth.userId, async () => {
    const record = await getRegisteredAgent(agentId, workspace.workspace.id);
    if (!record) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    await clearAgentModelUpgradeNotice(agentId, workspace.workspace.id);
    const updated = await getRegisteredAgent(agentId, workspace.workspace.id);
    return envelopeOk(
      await toApiSnapshot(
        updated ?? record,
        auth.userId,
        workspace.workspace.id,
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export async function createAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  if (!isAdminLike(workspace.workspace.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to create agents.',
    );
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const providerId =
    typeof body?.providerId === 'string' ? body.providerId.trim() : '';
  const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
  if (!name) {
    return envelopeError(400, 'invalid_input', 'name is required.');
  }
  if (!providerId) {
    return envelopeError(400, 'invalid_input', 'providerId is required.');
  }
  if (!modelId) {
    return envelopeError(400, 'invalid_input', 'modelId is required.');
  }

  const personaRole =
    typeof body?.personaRole === 'string' ? body.personaRole : undefined;
  const systemPrompt =
    typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined;
  const description =
    typeof body?.description === 'string' ? body.description : undefined;
  let credentialMode: RegisteredAgentCredentialMode | null | undefined;
  try {
    credentialMode = readCredentialModeField(body);
  } catch (err) {
    return envelopeError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Invalid credentialMode.',
    );
  }

  return withUserContext(auth.userId, async () => {
    try {
      const record = await createRegisteredAgent({
        ownerId: auth.userId,
        workspaceId: workspace.workspace.id,
        name,
        providerId,
        modelId,
        personaRole,
        systemPrompt,
        description,
        credentialMode,
      });
      return envelopeOk(
        await toApiSnapshot(record, auth.userId, workspace.workspace.id),
      );
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to create agent.',
      );
    }
  });
}

export async function updateAgentRoute(
  auth: AuthContext,
  agentId: string,
  body: Record<string, unknown> | null,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  if (!isAdminLike(workspace.workspace.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agents.',
    );
  }

  const updates: Parameters<typeof updateRegisteredAgent>[1] = {};
  if (typeof body?.name === 'string') updates.name = body.name.trim();
  if (typeof body?.providerId === 'string')
    updates.providerId = body.providerId.trim();
  if (typeof body?.modelId === 'string') updates.modelId = body.modelId.trim();
  const personaRole = readStringField(body, 'personaRole');
  if (personaRole !== undefined) updates.personaRole = personaRole;
  const systemPrompt = readStringField(body, 'systemPrompt');
  if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
  const description = readStringField(body, 'description');
  if (description !== undefined) updates.description = description;
  if (typeof body?.enabled === 'boolean') updates.enabled = body.enabled;
  try {
    const credentialMode = readCredentialModeField(body);
    if (credentialMode !== undefined) updates.credentialMode = credentialMode;
  } catch (err) {
    return envelopeError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Invalid credentialMode.',
    );
  }

  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId, workspace.workspace.id))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    try {
      const updated = await updateRegisteredAgent(
        agentId,
        updates,
        workspace.workspace.id,
      );
      if (!updated) {
        return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
      }
      return envelopeOk(
        await toApiSnapshot(updated, auth.userId, workspace.workspace.id),
      );
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to update agent.',
      );
    }
  });
}

export async function deleteAgentRoute(
  auth: AuthContext,
  agentId: string,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  if (!isAdminLike(workspace.workspace.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to delete agents.',
    );
  }
  return withUserContext(auth.userId, async () => {
    // Use null-safe lookups here — a missing main / default talk agent
    // is a benign "nothing protected yet" state, not a 500. Throwing
    // out of these guards blocks the user from deleting any agent
    // when settings_kv has no defaults configured.
    const protectedMainId = await getMainAgentIdOrNull(workspace.workspace.id);
    if (protectedMainId && agentId === protectedMainId) {
      return envelopeError(
        400,
        'invalid_input',
        'Cannot delete the main agent. Set a different main agent first.',
      );
    }
    const protectedDefaultId = await getDefaultTalkAgentIdOrNull(
      workspace.workspace.id,
    );
    if (protectedDefaultId && agentId === protectedDefaultId) {
      return envelopeError(
        400,
        'invalid_input',
        'Cannot delete the default Talk agent.',
      );
    }
    const deleted = await deleteRegisteredAgent(
      agentId,
      workspace.workspace.id,
    );
    if (!deleted) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ deleted: true } as const);
  });
}

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export async function getMainAgentRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  return withUserContext(auth.userId, async () => {
    try {
      const mainAgentId = await getMainAgentId(workspace.workspace.id);
      const record = await getRegisteredAgent(
        mainAgentId,
        workspace.workspace.id,
      );
      if (!record) {
        return envelopeError(
          404,
          'not_found',
          `Main agent '${mainAgentId}' not found.`,
        );
      }
      return envelopeOk(
        await toApiSnapshot(record, auth.userId, workspace.workspace.id),
      );
    } catch (err) {
      return envelopeError(
        404,
        'not_found',
        err instanceof Error ? err.message : 'Main agent not configured.',
      );
    }
  });
}

export async function updateMainAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  if (!isAdminLike(workspace.workspace.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update the main agent.',
    );
  }
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) {
    return envelopeError(400, 'invalid_input', 'agentId is required.');
  }
  return withUserContext(auth.userId, async () => {
    try {
      await setMainAgentId(agentId, workspace.workspace.id, auth.userId);
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to set main agent.',
      );
    }
    const record = await getRegisteredAgent(agentId, workspace.workspace.id);
    if (!record) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk(
      await toApiSnapshot(record, auth.userId, workspace.workspace.id),
    );
  });
}

// ---------------------------------------------------------------------------
// Fallback steps — Phase 2 keeps these as read-empty / write-noop so the
// webapp routes don't 410. Wire real fallback when we revisit it.
// ---------------------------------------------------------------------------

export async function getAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId, workspace.workspace.id))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ agentId, steps: [] as [] });
  });
}

export async function setAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
  _body: Record<string, unknown> | null,
  requestedWorkspaceId?: string | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
}> {
  const workspace = await resolveActiveWorkspace(auth, requestedWorkspaceId);
  if (!workspace.ok) return workspace.result;
  if (!isAdminLike(workspace.workspace.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agent fallback.',
    );
  }
  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId, workspace.workspace.id))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ agentId, steps: [] as [] });
  });
}
