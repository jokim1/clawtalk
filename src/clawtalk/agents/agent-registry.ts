/**
 * Agent Registry — main/default agent pointer resolution.
 *
 * Stores and resolves the "main agent" and "default Talk agent" pointers in
 * `settings_kv`, validating candidates against the greenfield `agents`
 * surface (`agent-accessors.ts`). The legacy per-Talk mention/heal helpers
 * and the registered-agent CRUD re-exports were retired with the rest of the
 * pre-greenfield talk runtime; live callers import the greenfield agent CRUD
 * directly from `agent-accessors.ts`.
 *
 * Callers MUST run within `withUserContext(userId, async () => ...)` so that
 * RLS gates writes on `auth.uid()`.
 */

import { getSettingValue, upsertSettingValue } from '../db/core-accessors.js';
import { getRegisteredAgent } from '../db/agent-accessors.js';

// ---------------------------------------------------------------------------
// Main Agent Resolution
// ---------------------------------------------------------------------------

const MAIN_AGENT_SETTING_KEY = 'system.mainAgentId';
const DEFAULT_TALK_AGENT_SETTING_KEY = 'system.defaultTalkAgentId';
const DEFAULT_TALK_AGENT_FALLBACK_ID = 'agent.talk';

function workspaceMainAgentSettingKey(workspaceId?: string | null): string {
  return workspaceId
    ? `workspace.${workspaceId}.mainAgentId`
    : MAIN_AGENT_SETTING_KEY;
}

/**
 * Returns the main agent ID from settings_kv.
 */
export async function getMainAgentId(
  workspaceId?: string | null,
): Promise<string> {
  const value = await getSettingValue(
    workspaceMainAgentSettingKey(workspaceId),
  );
  if (!value) {
    throw new Error(
      workspaceId
        ? `Main agent not configured for workspace ${workspaceId}.`
        : 'Main agent not configured. Check settings_kv for system.mainAgentId.',
    );
  }
  return value;
}

/**
 * Returns the main agent ID, or null when the setting is absent.
 *
 * Use this instead of `getMainAgentId()` when you only need the ID to
 * compare against (e.g. "don't delete the main agent") and a missing
 * main is a benign state rather than an error.
 */
export async function getMainAgentIdOrNull(
  workspaceId?: string | null,
): Promise<string | null> {
  const value = await getSettingValue(
    workspaceMainAgentSettingKey(workspaceId),
  );
  return value ? value : null;
}

/**
 * Returns the default Talk agent ID from settings_kv.
 * Falls back to the direct-safe seeded Talk agent when the setting is absent,
 * and then to the main agent if the fallback agent has been removed.
 */
export async function getDefaultTalkAgentId(
  workspaceId?: string | null,
): Promise<string> {
  const value = await getSettingValue(DEFAULT_TALK_AGENT_SETTING_KEY);
  const candidate = value?.trim() || DEFAULT_TALK_AGENT_FALLBACK_ID;
  const agent = await getRegisteredAgent(candidate, workspaceId);
  if (agent && agent.enabled === true) {
    return candidate;
  }
  return getMainAgentId(workspaceId);
}

/**
 * Null-safe variant of `getDefaultTalkAgentId()`. Returns the
 * configured fallback when present, the main agent ID when set,
 * otherwise null. Used by DELETE-side guards that just need a
 * "protected agent" comparison and shouldn't 500 when no defaults
 * exist yet.
 */
export async function getDefaultTalkAgentIdOrNull(
  workspaceId?: string | null,
): Promise<string | null> {
  const value = await getSettingValue(DEFAULT_TALK_AGENT_SETTING_KEY);
  const candidate = value?.trim() || DEFAULT_TALK_AGENT_FALLBACK_ID;
  const agent = await getRegisteredAgent(candidate, workspaceId);
  if (agent && agent.enabled === true) {
    return candidate;
  }
  return getMainAgentIdOrNull(workspaceId);
}

// ---------------------------------------------------------------------------
// Main Agent Write Path
// ---------------------------------------------------------------------------

/**
 * Set the main agent ID. Greenfield callers pass a workspace id so the pointer
 * is stored per workspace; legacy callers without one still use the global key.
 * Validates the agent exists and is enabled before writing.
 */
export async function setMainAgentId(
  agentId: string,
  workspaceId?: string | null,
  updatedBy?: string | null,
): Promise<void> {
  const agent = await getRegisteredAgent(agentId, workspaceId);
  if (!agent) {
    throw new Error(`Agent '${agentId}' not found in agents.`);
  }
  if (agent.enabled !== true) {
    throw new Error(
      `Agent '${agentId}' is disabled — cannot set as main agent.`,
    );
  }
  await upsertSettingValue({
    key: workspaceMainAgentSettingKey(workspaceId),
    value: agentId,
    updatedBy,
  });
}
