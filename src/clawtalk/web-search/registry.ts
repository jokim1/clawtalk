/**
 * web-search/registry.ts
 *
 * Adapter registry + active-provider router. Callers (the
 * `web_search` tool executor) hand us a user id and a query; we
 * resolve that user's preferred provider + decrypted API key and
 * dispatch to the matching adapter.
 *
 * Transaction split (Talk Runtime v2 amendment P1-0): credential
 * resolution runs in its own SHORT `withUserContext` RLS transaction
 * that COMMITS before the provider fetch starts. The fetch therefore
 * never holds the run's max:1 request-scoped connection — a hung
 * provider can no longer block run persistence (the 2026-06-12 wedge
 * class). Corollary: `runWebSearchForUser` must NOT be called inside
 * an enclosing `withUserContext` — same-user re-entrancy silently
 * reuses the OUTER transaction (no commit before the fetch) and leaks
 * this module's 10s statement_timeout into it. Enforced at runtime by
 * the guard in `resolveWebSearchExecution`.
 *
 * One active provider per user. Set via PUT /api/v1/web-search/active;
 * stored as `users.preferred_web_search_provider_id`. If nothing is
 * configured, this module throws `WebSearchError` with `statusCode:0`
 * so the tool can return a friendly "configure a search provider in
 * Settings" message rather than 500'ing the run.
 */

import { getCurrentUserId, getDbPg, withUserContext } from '../../db.js';
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
// a stalled query here would otherwise hold the resolution transaction — and
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

interface ResolvedWebSearchExecution {
  providerId: WebSearchProviderId;
  apiKey: string;
  adapter: WebSearchAdapter;
}

/**
 * Resolve the user's active provider + decrypted API key. The DB reads
 * run in a short `withUserContext` RLS transaction that commits before
 * this function returns; the decrypt is pure WebCrypto and runs after
 * the commit. Throws `WebSearchError` (statusCode 0) for the
 * not-configured cases. Module-private: it mints an RLS context from a
 * caller-supplied userId and returns a decrypted key — route-side reuse
 * would also trip the re-entrancy guard below.
 */
async function resolveWebSearchExecution(
  userId: string,
): Promise<ResolvedWebSearchExecution> {
  // P1-0 invariant, enforced: same-user withUserContext re-entry would
  // silently reuse the caller's OUTER tx (db.ts returns fn() without a
  // commit), putting the provider fetch back inside a transaction and
  // leaking the statement_timeout below into the enclosing tx. Fail loud
  // instead — cross-user nesting already throws in withUserContext.
  if (getCurrentUserId() !== null) {
    throw new Error(
      'runWebSearchForUser must not be called inside withUserContext: the P1-0 tx split requires the credential tx to commit before the provider fetch',
    );
  }
  const resolved = await withUserContext(userId, async () => {
    const db = getDbPg();
    await db`select set_config('statement_timeout', ${String(DB_STATEMENT_TIMEOUT_MS)}, true)`;
    // Wedge-diagnosis breadcrumbs (2026-06-12 incidents): with Workers Logs
    // enabled, the last line before silence pinpoints which leg hung.
    logger.info(
      { userId },
      'web_search registry: tx ready, statement_timeout set',
    );
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
        and owner_id = auth.uid()
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

    return { providerId: preferredId, ciphertext };
  });

  // Credential tx committed above; decrypt is CPU-only WebCrypto.
  const { apiKey } = await decryptProviderSecret(resolved.ciphertext);
  return {
    providerId: resolved.providerId,
    apiKey,
    adapter: ADAPTERS[resolved.providerId],
  };
}

/**
 * Run a web search for the given user. Resolves their active provider
 * + credential in a short committed transaction, then dispatches the
 * provider fetch outside any transaction (see module header).
 *
 * Throws `WebSearchError` (statusCode 0) when the user hasn't picked
 * a provider or hasn't stored a key for the picked provider — the
 * caller should turn that into a tool-result-style "configure web
 * search first" message rather than a hard 500.
 */
export async function runWebSearchForUser(
  userId: string,
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

  const { providerId, apiKey, adapter } =
    await resolveWebSearchExecution(userId);

  options?.signal?.throwIfAborted();
  logger.info(
    { providerId },
    'web_search registry: dispatching provider fetch',
  );
  const results = await adapter(apiKey, trimmed, options);
  logger.info(
    { providerId, resultCount: results.length },
    'web_search registry: provider fetch returned',
  );
  return {
    query: trimmed,
    providerId,
    results,
  };
}
