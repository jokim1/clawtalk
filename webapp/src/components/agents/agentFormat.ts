/**
 * Agent profile — pure formatting/resolution helpers.
 *
 * The standalone profile route loads a single RegisteredAgent and (optionally)
 * the AiAgents catalog to turn raw provider/model ids into friendly labels.
 * These helpers degrade gracefully: with no catalog (the enrichment call
 * failed) they fall back to humanized ids so the page still renders.
 */
import type { AiAgentsPageData, RegisteredAgent } from '../../lib/api';

/**
 * "provider.anthropic" → "Anthropic", "kimi_k2" → "Kimi K2". Generic fallback
 * for when the catalog doesn't list the id (e.g. the implicit Claude main
 * provider, which lives outside additionalProviders).
 */
export function humanizeProviderId(providerId: string): string {
  const bare = providerId
    .replace(/^provider\./, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!bare) return providerId;
  return bare
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Friendly provider name from the catalog, else a humanized id. */
export function resolveProviderName(
  ai: AiAgentsPageData | null,
  providerId: string,
): string {
  const fromCatalog = ai?.additionalProviders.find((p) => p.id === providerId);
  return fromCatalog?.name ?? humanizeProviderId(providerId);
}

/** Model display name from any catalog list (provider suggestions or the
 *  Claude main list), else the raw model id. */
export function resolveModelLabel(
  ai: AiAgentsPageData | null,
  modelId: string,
): string {
  if (!ai) return modelId;
  const fromProviders = ai.additionalProviders
    .flatMap((p) => p.modelSuggestions)
    .find((m) => m.modelId === modelId);
  if (fromProviders) return fromProviders.displayName;
  const fromClaude = ai.claudeModelSuggestions.find(
    (m) => m.modelId === modelId,
  );
  return fromClaude?.displayName ?? modelId;
}

/** ISO timestamp → "YYYY-MM-DD" (stable, no locale/tz drift). "—" when empty. */
export function formatAgentDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1] : iso;
}

/** Credential-mode pill label. null = the resolver-driven auto mode. */
export function credentialModeLabel(
  mode: RegisteredAgent['credentialMode'],
): string {
  if (mode === 'api_key') return 'API key';
  if (mode === 'subscription') return 'Subscription';
  return 'Auto';
}
