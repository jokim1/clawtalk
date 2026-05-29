/**
 * nvidia-model-discovery.ts
 *
 * Live discovery of chat-capable models from the NVIDIA NIM catalog
 * (https://integrate.api.nvidia.com/v1/models). Surfaces alongside the
 * curated `llm_provider_models` rows so users with a configured NVIDIA key
 * can pick any model their catalog exposes, not just what we hardcoded.
 *
 * Thin adapter over the shared discovery infrastructure in
 * model-discovery.ts — this file owns only the NVIDIA endpoint shape +
 * the non-chat model filter. Caching, timeout, and status mapping are
 * shared.
 */

import {
  discoverModels,
  invalidateDiscovery,
  type DiscoveredModel,
  type DiscoveryCacheLike,
  type DiscoveryOptions,
  type DiscoveryResult,
  type ModelsEndpoint,
} from './model-discovery.js';

// Re-export the shared types so existing importers (ai-agents route, tests)
// keep resolving them from here.
export type {
  DiscoveredModel,
  DiscoveryCacheLike,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryStatus,
} from './model-discovery.js';

const NVIDIA_DISCOVERY_NAMESPACE = 'nvidia-discovery';

// Heuristic blocklist for non-chat models. NVIDIA's /v1/models endpoint
// returns embedding, reranker, ASR, TTS, vision-encoder, and safety
// classifier models alongside chat-capable LLMs without a capability field.
// Filter conservatively — false-positive (showing a non-chat model) is worse
// than false-negative (hiding a chat model the user can re-add via a future
// curated row). Tokens are matched as case-insensitive substrings on the
// model id.
const NON_CHAT_ID_TOKENS = [
  'embed',
  'embedding',
  'rerank',
  'reranker',
  'guard',
  'nemoguard',
  'asr',
  'parakeet',
  'tts',
  'audio',
  'vision-encoder',
  'speaker',
] as const;

function isChatCapable(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return !NON_CHAT_ID_TOKENS.some((token) => lower.includes(token));
}

interface NvidiaModelsResponse {
  data?: Array<{ id?: string }>;
}

function parseNvidiaModels(raw: unknown): DiscoveredModel[] {
  const payload = raw as NvidiaModelsResponse;
  if (!payload || !Array.isArray(payload.data)) return [];
  return payload.data
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .filter(isChatCapable)
    .map((modelId) => ({ modelId }));
}

const NVIDIA_ENDPOINT: ModelsEndpoint = {
  namespace: NVIDIA_DISCOVERY_NAMESPACE,
  url: 'https://integrate.api.nvidia.com/v1/models',
  label: 'NVIDIA',
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  keyHelp: 'Generate a new key at build.nvidia.com.',
  parse: parseNvidiaModels,
};

export function discoverNvidiaModels(
  apiKey: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  return discoverModels(NVIDIA_ENDPOINT, apiKey, opts);
}

export function invalidateNvidiaDiscovery(
  apiKey: string,
  cache: DiscoveryCacheLike | null | undefined,
): Promise<void> {
  return invalidateDiscovery(NVIDIA_DISCOVERY_NAMESPACE, apiKey, cache);
}
