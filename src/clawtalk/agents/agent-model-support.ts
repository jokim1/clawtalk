/**
 * agent-model-support.ts
 *
 * Integration layer between live discovery and the pure model-lifecycle
 * logic. Resolves a provider's authoritative supported-model set (curated
 * catalog ∪ raw /v1/models discovery) plus a display-name map, so callers
 * can ask `resolveModelLifecycle()` whether an agent's model is retired or
 * has a newer sibling.
 *
 * Anthropic-only for now (the only provider with both discovery and a
 * parseable version scheme). Other providers return an INCOMPLETE set
 * (curated only), which guarantees their agents are never auto-retired.
 */

import { getDbPg } from '../../db.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import { discoverAnthropicModels } from './anthropic-model-discovery.js';
import type { SupportedModels } from './model-lifecycle.js';

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';

export interface ProviderModelSupport {
  supported: SupportedModels;
  /** modelId → friendly label (curated display_name or discovery's). */
  displayNames: Map<string, string>;
}

/** Anthropic API key for the current context — workspace credential wins,
 *  else personal. Returns null when neither is set or decrypt fails. */
async function resolveAnthropicApiKey(): Promise<string | null> {
  const db = getDbPg();
  const wsRows = await db<Array<{ ciphertext: string }>>`
    select ciphertext from public.workspace_provider_secrets
    where provider_id = ${ANTHROPIC_PROVIDER_ID} and credential_kind = 'api_key'
    limit 1
  `;
  const personalRows = wsRows.length
    ? []
    : await db<Array<{ ciphertext: string }>>`
        select ciphertext from public.llm_provider_secrets
        where provider_id = ${ANTHROPIC_PROVIDER_ID}
          and credential_kind = 'api_key'
        limit 1
      `;
  const ciphertext = wsRows[0]?.ciphertext ?? personalRows[0]?.ciphertext;
  if (!ciphertext) return null;
  try {
    const secret = await decryptProviderSecret(ciphertext);
    return secret?.apiKey ?? null;
  } catch {
    return null;
  }
}

async function loadCuratedModels(
  providerId: string,
): Promise<{ ids: Set<string>; displayNames: Map<string, string> }> {
  const db = getDbPg();
  const rows = await db<Array<{ model_id: string; display_name: string }>>`
    select model_id, display_name
    from public.llm_provider_models
    where provider_id = ${providerId}
  `;
  const ids = new Set<string>();
  const displayNames = new Map<string, string>();
  for (const row of rows) {
    ids.add(row.model_id);
    if (row.display_name) displayNames.set(row.model_id, row.display_name);
  }
  return { ids, displayNames };
}

/**
 * Build the authoritative supported-model picture for a provider.
 * `complete` is true only when a successful live discovery backed it —
 * the model-lifecycle resolver requires that before ever flagging a model
 * 'retired', so a missing key or a failed discovery can't trigger an
 * auto-upgrade.
 */
export async function buildProviderModelSupport(
  providerId: string,
): Promise<ProviderModelSupport> {
  const curatedData = await loadCuratedModels(providerId);
  const curated = curatedData.ids;
  const displayNames = curatedData.displayNames;

  // Incomplete picture (non-Anthropic, no key, failed/empty discovery) →
  // served empty + complete:false, so the lifecycle resolver never retires.
  const incomplete = {
    supported: {
      ids: new Set(curated),
      curated,
      served: new Set<string>(),
      complete: false,
    },
    displayNames,
  };

  if (providerId !== ANTHROPIC_PROVIDER_ID) return incomplete;

  const apiKey = await resolveAnthropicApiKey();
  if (!apiKey) return incomplete;

  // Lifecycle decisions MUTATE agent config (auto-upgrade), so this must be
  // a LIVE, uncached /v1/models read — a stale (≤1h) or partial cached list
  // must never drive an auto-upgrade. The AI Agents picker keeps its own
  // cached discovery; only this authoritative path bypasses the cache.
  const discovery = await discoverAnthropicModels(apiKey, {});
  // An `ok` with an empty list is NOT authoritative — Anthropic always
  // serves several Claude models, so treat empty as a failed probe rather
  // than "everything is retired". Guards against a transient/malformed 200.
  if (discovery.status !== 'ok' || discovery.models.length === 0) {
    return incomplete;
  }

  const served = new Set<string>();
  const ids = new Set(curated);
  for (const model of discovery.models) {
    served.add(model.modelId);
    ids.add(model.modelId);
    // Curated display name wins over discovery's (it's the blessed label).
    if (model.displayName && !displayNames.has(model.modelId)) {
      displayNames.set(model.modelId, model.displayName);
    }
  }
  return { supported: { ids, curated, served, complete: true }, displayNames };
}
