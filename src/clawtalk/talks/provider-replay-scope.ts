import type { LlmMessage } from '../agents/llm-client.js';
import {
  MAX_PROVIDER_REPLAY_BYTES,
  providerReplaySizeBytes,
} from './provider-replay-budget.js';

export interface ProviderReplayScope {
  sourceAgentId: string | null;
  providerId: string;
  modelId: string;
}

export interface ProviderReplayCandidate {
  id: string;
  source_agent_id: string | null;
  snapshot_provider_id: string | null;
  snapshot_model_id: string | null;
  replay_provider_id: string | null;
  replay_model_id: string | null;
  provider_data_json: Record<string, unknown> | null;
}

export function extractAssistantProviderData(
  metadata: Record<string, unknown> | null,
): LlmMessage['providerData'] | undefined {
  if (!metadata) return undefined;
  const reasoning = metadata.codexReasoningItems;
  const message = metadata.codexMessageItems;
  const out: LlmMessage['providerData'] = {};
  if (Array.isArray(reasoning) && reasoning.length > 0) {
    out.codexReasoningItems = reasoning as Array<Record<string, unknown>>;
  }
  if (Array.isArray(message) && message.length > 0) {
    out.codexMessageItems = message as Array<Record<string, unknown>>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function shouldReplayAssistantProviderData(
  row: ProviderReplayCandidate,
  scope?: ProviderReplayScope,
): boolean {
  if (!scope?.sourceAgentId) return false;
  if (row.source_agent_id !== scope.sourceAgentId) return false;
  if (row.snapshot_provider_id !== scope.providerId) return false;
  if (row.snapshot_model_id !== scope.modelId) return false;
  return (
    row.replay_provider_id === row.snapshot_provider_id &&
    row.replay_model_id === row.snapshot_model_id
  );
}

export function selectProviderReplayMessageIds(
  rowsChronological: ProviderReplayCandidate[],
  scope?: ProviderReplayScope,
): Set<string> {
  const ids = new Set<string>();
  let remainingBytes = MAX_PROVIDER_REPLAY_BYTES;
  for (let i = rowsChronological.length - 1; i >= 0; i--) {
    const row = rowsChronological[i]!;
    if (!shouldReplayAssistantProviderData(row, scope)) continue;
    const providerData = extractAssistantProviderData(row.provider_data_json);
    if (!providerData) continue;
    const sizeBytes = providerReplaySizeBytes(providerData);
    if (sizeBytes > remainingBytes) break;
    ids.add(row.id);
    remainingBytes -= sizeBytes;
  }
  return ids;
}
