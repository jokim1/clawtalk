/**
 * web-search/registry.ts
 *
 * Adapter registry + active-provider router. Callers (the
 * `web_search` tool executor) hand us a user id and a query; we
 * resolve that user's preferred provider + decrypted API key and
 * dispatch to the matching adapter.
 *
 * One active provider per user. Set via PUT /api/v1/web-search/active;
 * stored as `users.preferred_web_search_provider_id`. If nothing is
 * configured, this module throws `WebSearchError` with `statusCode:0`
 * so the tool can return a friendly "configure a search provider in
 * Settings" message rather than 500'ing the run.
 */

import { getDbPg } from '../../db.js';
import { logger } from '../../logger.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import { braveSearch } from './brave.js';
import { exaSearch } from './exa.js';
import { firecrawlSearch } from './firecrawl.js';
import { tavilySearch } from './tavily.js';
import {
  WebSearchError,
  type WebSearchAdapter,
  type WebSearchOptions,
  type WebSearchProviderId,
  type WebSearchResponse,
} from './types.js';

const ADAPTERS: Record<WebSearchProviderId, WebSearchAdapter> = {
  'web_search.tavily': tavilySearch,
  'web_search.brave': braveSearch,
  'web_search.firecrawl': firecrawlSearch,
  'web_search.exa': exaSearch,
};

// Server-side bound on this module's own DB reads. The caller's abort signal
// only cancels the provider fetch (postgres.js queries are not abortable), so
// a stalled query here would otherwise hold the per-call transaction — and
// the request scope's only connection — until the scheduler's 1h stuck-run
// sweep. Applied with set_config(..., is_local=true): dies with the
// enclosing transaction.
const DB_STATEMENT_TIMEOUT_MS = 10_000;

export function isKnownWebSearchProviderId(
  id: string,
): id is WebSearchProviderId {
  return id in ADAPTERS;
}

export const WEB_SEARCH_PROVIDER_IDS = Object.keys(
  ADAPTERS,
) as WebSearchProviderId[];

/**
 * Run a web search for the given user. Resolves their active provider
 * + credential, then dispatches.
 *
 * Throws `WebSearchError` (statusCode 0) when the user hasn't picked
 * a provider or hasn't stored a key for the picked provider — the
 * caller should turn that into a tool-result-style "configure web
 * search first" message rather than a hard 500.
 */
export async function runWebSearchForUser(
  query: string,
  options?: WebSearchOptions,
): Promise<WebSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new WebSearchError(
      'web_search query is empty.',
      'web_search.tavily',
      0,
    );
  }

  options?.signal?.throwIfAborted();

  const db = getDbPg();
  await db`select set_config('statement_timeout', ${String(DB_STATEMENT_TIMEOUT_MS)}, true)`;
  // Wedge-diagnosis breadcrumbs (2026-06-12 incidents): with Workers Logs
  // enabled, the last line before silence pinpoints which leg hung.
  logger.info('web_search registry: tx ready, statement_timeout set');
  // `withUserContext` (set by the caller, e.g. the talk-executor's
  // request-scoped DB) gates these reads to the current user via RLS.
  const userRows = await db<
    Array<{ preferred_web_search_provider_id: string | null }>
  >`
    select preferred_web_search_provider_id
    from public.users
    where id = auth.uid()
    limit 1
  `;
  const preferredId = userRows[0]?.preferred_web_search_provider_id ?? null;
  if (!preferredId) {
    throw new WebSearchError(
      'No web search provider is configured. Add a key under Settings → Tools → Web Search (your first key is activated automatically).',
      'web_search.tavily',
      0,
    );
  }

  if (!isKnownWebSearchProviderId(preferredId)) {
    throw new WebSearchError(
      `Unknown web search provider '${preferredId}'. Pick another in Settings.`,
      'web_search.tavily',
      0,
    );
  }

  const secretRows = await db<Array<{ ciphertext: string }>>`
    select ciphertext from public.web_search_provider_secrets
    where provider_id = ${preferredId}
    limit 1
  `;
  const ciphertext = secretRows[0]?.ciphertext ?? null;
  if (!ciphertext) {
    throw new WebSearchError(
      `No API key stored for ${preferredId}. Add one under Settings → Tools → Web Search.`,
      preferredId,
      0,
    );
  }

  const { apiKey } = await decryptProviderSecret(ciphertext);
  const adapter = ADAPTERS[preferredId];
  options?.signal?.throwIfAborted();
  logger.info(
    { providerId: preferredId },
    'web_search registry: dispatching provider fetch',
  );
  const results = await adapter(apiKey, trimmed, options);
  logger.info(
    { providerId: preferredId, resultCount: results.length },
    'web_search registry: provider fetch returned',
  );
  return {
    query: trimmed,
    providerId: preferredId,
    results,
  };
}
