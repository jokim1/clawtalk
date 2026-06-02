import type { LlmToolDefinition } from '../agents/llm-client.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';

export function buildAllowedRuntimeToolSet(
  effectiveTools?: EffectiveToolAccess[] | null,
): Set<string> | null {
  if (!effectiveTools) return null;
  const allowed = new Set<string>();
  for (const access of effectiveTools) {
    if (!access.enabled) continue;
    for (const toolName of access.runtimeTools) {
      allowed.add(toolName);
    }
  }
  return allowed;
}

export function isRuntimeToolAllowed(
  allowedRuntimeTools: Set<string> | null,
  toolName: string,
): boolean {
  return !allowedRuntimeTools || allowedRuntimeTools.has(toolName);
}

export function filterRuntimeToolDefinitions(
  tools: LlmToolDefinition[],
  allowedRuntimeTools: Set<string> | null,
): LlmToolDefinition[] {
  if (!allowedRuntimeTools) return tools;
  return tools.filter((tool) => allowedRuntimeTools.has(tool.name));
}
