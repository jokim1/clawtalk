/**
 * anthropic-model-discovery.ts
 *
 * Live discovery of Claude models from the Anthropic catalog
 * (https://api.anthropic.com/v1/models). Surfaces alongside the curated
 * `llm_provider_models` rows so a newly-released Claude model (e.g. a
 * future Opus) appears in the AI Agents picker automatically — no
 * migration, no manual catalog edit.
 *
 * Thin adapter over the shared discovery infrastructure in
 * model-discovery.ts. Capabilities for any `claude-*` model are derived by
 * prefix in llm/capabilities.ts, so a discovered model is immediately
 * usable (tools + vision + pdf). Anthropic's /v1/models returns a
 * `display_name`, so discovered models get a friendly label too.
 *
 * Requires an Anthropic API key — the subscription/OAuth token is scoped to
 * /v1/messages and is not guaranteed to authenticate /v1/models. With no
 * API key the discovery degrades gracefully (auth_error → the card just
 * shows the curated rows).
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

const ANTHROPIC_DISCOVERY_NAMESPACE = 'anthropic-discovery';

// Anthropic's /v1/models returns only Claude models, but it includes the
// superseded legacy generations. Drop claude-1 / claude-2 / claude-3 /
// claude-instant so the picker stays focused on the current flagship line
// (the curated rows already cover 4.x). Matching by known-old prefix —
// rather than an allowlist — keeps this robust to future generations
// (claude-5, claude-6, …): only what we know to be legacy is hidden.
const LEGACY_ID_PREFIXES = [
  'claude-1',
  'claude-2',
  'claude-3',
  'claude-instant',
] as const;

function isCurrentGeneration(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('claude-')) return false;
  return !LEGACY_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string; display_name?: string }>;
}

function parseAnthropicModels(raw: unknown): DiscoveredModel[] {
  const payload = raw as AnthropicModelsResponse;
  if (!payload || !Array.isArray(payload.data)) return [];
  const out: DiscoveredModel[] = [];
  for (const entry of payload.data) {
    const id = entry?.id;
    if (typeof id !== 'string' || !id) continue;
    if (!isCurrentGeneration(id)) continue;
    const displayName =
      typeof entry?.display_name === 'string' && entry.display_name
        ? entry.display_name
        : undefined;
    out.push(displayName ? { modelId: id, displayName } : { modelId: id });
  }
  return out;
}

const ANTHROPIC_ENDPOINT: ModelsEndpoint = {
  namespace: ANTHROPIC_DISCOVERY_NAMESPACE,
  // limit=1000 (the max) returns every model in one page — there are only a
  // few dozen, so no pagination loop is needed.
  url: 'https://api.anthropic.com/v1/models?limit=1000',
  label: 'Anthropic',
  headers: (apiKey) => ({
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }),
  keyHelp: 'Check your key at console.anthropic.com.',
  parse: parseAnthropicModels,
};

export function discoverAnthropicModels(
  apiKey: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  return discoverModels(ANTHROPIC_ENDPOINT, apiKey, opts);
}

export function invalidateAnthropicDiscovery(
  apiKey: string,
  cache: DiscoveryCacheLike | null | undefined,
): Promise<void> {
  return invalidateDiscovery(ANTHROPIC_DISCOVERY_NAMESPACE, apiKey, cache);
}
