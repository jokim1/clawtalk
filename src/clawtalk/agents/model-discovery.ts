/**
 * model-discovery.ts
 *
 * Shared infrastructure for live LLM model discovery — hitting a provider's
 * /models endpoint and surfacing the result alongside the curated
 * `llm_provider_models` rows in the AI Agents picker. Provider-specific
 * modules (nvidia-model-discovery.ts, anthropic-model-discovery.ts) supply
 * the URL, auth headers, and response parser via a `ModelsEndpoint`; this
 * module owns the cache policy, request timeout, HTTP-status mapping, and
 * per-key cache isolation so adding a new provider is a ~20-line adapter.
 *
 * Caching (Cloudflare Workers Cache API; injectable for tests):
 *   ok          → 1 hour
 *   auth_error  → never cached (immediate feedback when the key is fixed)
 *   unavailable → 60s (brief backoff on transient network/timeout)
 *   rate_limited→ 5 min (respect 429 with longer backoff)
 *
 * The cache key is an SHA-256 fingerprint of the API key (first 16 hex
 * chars), namespaced per provider, so workspace-scoped credentials stay
 * isolated from each other and the raw key is never logged.
 */

export type DiscoveryStatus =
  | 'ok'
  | 'auth_error'
  | 'unavailable'
  | 'rate_limited';

export interface DiscoveredModel {
  modelId: string;
  /**
   * Friendly label when the provider's /models endpoint returns one
   * (Anthropic does; NVIDIA doesn't). The picker falls back to the raw
   * modelId when absent.
   */
  displayName?: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  status: DiscoveryStatus;
  message?: string;
}

/**
 * Structural subset of the Cloudflare Workers Cache API we depend on. Lets
 * tests pass a Map-backed fake without pulling @cloudflare/workers-types
 * into the project tsconfig.
 */
export interface DiscoveryCacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface DiscoveryOptions {
  cache?: DiscoveryCacheLike | null;
  fetcher?: typeof fetch;
}

/**
 * Provider-specific description of a /models endpoint. Everything that
 * differs between providers lives here; the cache + fetch machinery is
 * shared.
 */
export interface ModelsEndpoint {
  /** Stable cache namespace, e.g. 'nvidia-discovery'. */
  namespace: string;
  /** Full /models URL (may include a query string). */
  url: string;
  /** Provider label used in user-facing status messages. */
  label: string;
  /** Auth headers built from the API key (an `accept` header is added). */
  headers: (apiKey: string) => Record<string, string>;
  /** Optional hint appended to the auth-rejected message. */
  keyHelp?: string;
  /** Parse the raw JSON body into discovered models. */
  parse: (raw: unknown) => DiscoveredModel[];
}

const FETCH_TIMEOUT_MS = 5_000;
const TTL_SUCCESS_S = 3_600;
const TTL_UNAVAILABLE_S = 60;
const TTL_RATE_LIMITED_S = 5 * 60;

interface CachedPayload {
  result: DiscoveryResult;
  cachedAt: number;
}

async function fingerprintApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildCacheKey(
  namespace: string,
  apiKey: string,
): Promise<string> {
  const fp = await fingerprintApiKey(apiKey);
  return `https://${namespace}.internal/models?fp=${fp}`;
}

function ttlForStatus(status: DiscoveryStatus): number {
  switch (status) {
    case 'ok':
      return TTL_SUCCESS_S;
    case 'rate_limited':
      return TTL_RATE_LIMITED_S;
    case 'unavailable':
      return TTL_UNAVAILABLE_S;
    case 'auth_error':
      return 0;
  }
}

async function readFromCache(
  cache: DiscoveryCacheLike,
  cacheKey: string,
): Promise<DiscoveryResult | undefined> {
  const hit = await cache.match(cacheKey);
  if (!hit) return undefined;
  try {
    const payload = (await hit.json()) as CachedPayload;
    return payload.result;
  } catch {
    return undefined;
  }
}

async function writeToCache(
  cache: DiscoveryCacheLike,
  cacheKey: string,
  result: DiscoveryResult,
  ttlSeconds: number,
): Promise<void> {
  const payload: CachedPayload = { result, cachedAt: Date.now() };
  const response = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ttlSeconds}`,
    },
  });
  await cache.put(cacheKey, response);
}

async function fetchModels(
  endpoint: ModelsEndpoint,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<DiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetcher(endpoint.url, {
      method: 'GET',
      headers: { accept: 'application/json', ...endpoint.headers(apiKey) },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        models: [],
        status: 'auth_error',
        message: `${endpoint.label} API key was rejected.${
          endpoint.keyHelp ? ` ${endpoint.keyHelp}` : ''
        }`,
      };
    }
    if (response.status === 429) {
      return {
        models: [],
        status: 'rate_limited',
        message: `${endpoint.label} rate limit hit. Retrying in a few minutes.`,
      };
    }
    if (!response.ok) {
      return {
        models: [],
        status: 'unavailable',
        message: `${endpoint.label} ${pathOf(endpoint.url)} returned ${response.status}.`,
      };
    }

    const payload = (await response.json()) as unknown;
    return { models: endpoint.parse(payload), status: 'ok' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        models: [],
        status: 'unavailable',
        message: `${endpoint.label} ${pathOf(endpoint.url)} timed out after ${FETCH_TIMEOUT_MS}ms.`,
      };
    }
    return {
      models: [],
      status: 'unavailable',
      message:
        err instanceof Error ? err.message : `${endpoint.label} fetch failed.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Run a cached model-discovery for `endpoint`. Returns `auth_error`
 * (without a fetch) when the API key is empty.
 */
export async function discoverModels(
  endpoint: ModelsEndpoint,
  apiKey: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  if (!apiKey) {
    return {
      models: [],
      status: 'auth_error',
      message: `No ${endpoint.label} API key configured.`,
    };
  }

  const cache = opts.cache ?? null;
  const fetcher = opts.fetcher ?? fetch;
  const cacheKey = cache ? await buildCacheKey(endpoint.namespace, apiKey) : '';

  if (cache) {
    const cached = await readFromCache(cache, cacheKey);
    if (cached) return cached;
  }

  const result = await fetchModels(endpoint, apiKey, fetcher);

  if (cache) {
    const ttl = ttlForStatus(result.status);
    if (ttl > 0) {
      await writeToCache(cache, cacheKey, result, ttl);
    }
  }

  return result;
}

/**
 * Drop the cached discovery for a given (namespace, API key). Called from
 * the credential-save route so a user who updates their key sees fresh
 * results on the next provider-card load.
 *
 * The Cloudflare Cache API doesn't expose a public delete, but writing a
 * zero-TTL entry achieves the same effect (the cached response immediately
 * fails the max-age check).
 */
export async function invalidateDiscovery(
  namespace: string,
  apiKey: string,
  cache: DiscoveryCacheLike | null | undefined,
): Promise<void> {
  if (!cache || !apiKey) return;
  const cacheKey = await buildCacheKey(namespace, apiKey);
  const expired = new Response('{}', {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=0',
    },
  });
  await cache.put(cacheKey, expired);
}
