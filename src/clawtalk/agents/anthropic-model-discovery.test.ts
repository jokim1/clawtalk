import { describe, expect, it, vi } from 'vitest';

import {
  discoverAnthropicModels,
  invalidateAnthropicDiscovery,
} from './anthropic-model-discovery.js';
import type { DiscoveryCacheLike } from './model-discovery.js';

// Map-backed Cache fake — honors `cache-control: max-age=N` so we can
// exercise the TTL policy. Mirrors the helper in nvidia-model-discovery.test.
function makeFakeCache(): {
  cache: DiscoveryCacheLike;
  size: () => number;
  advance: (ms: number) => void;
} {
  const store = new Map<string, { body: string; expiresAt: number }>();
  let now = 1_000_000;
  return {
    cache: {
      async match(key: string) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= now) {
          store.delete(key);
          return undefined;
        }
        return new Response(entry.body, {
          headers: { 'content-type': 'application/json' },
        });
      },
      async put(key: string, response: Response) {
        const cc = response.headers.get('cache-control') || '';
        const m = /max-age=(\d+)/.exec(cc);
        const maxAge = m ? parseInt(m[1], 10) : 0;
        const body = await response.text();
        store.set(key, {
          body,
          expiresAt: maxAge <= 0 ? now - 1 : now + maxAge * 1000,
        });
      },
    },
    size: () => store.size,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discoverAnthropicModels', () => {
  it('parses models and captures the API display_name', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            type: 'model',
            id: 'claude-opus-4-8-20260528',
            display_name: 'Claude Opus 4.8',
          },
          {
            type: 'model',
            id: 'claude-sonnet-4-6-20260514',
            display_name: 'Claude Sonnet 4.6',
          },
        ],
      }),
    );
    const result = await discoverAnthropicModels('sk-ant-test', { fetcher });
    expect(result.status).toBe('ok');
    expect(result.models).toEqual([
      { modelId: 'claude-opus-4-8-20260528', displayName: 'Claude Opus 4.8' },
      {
        modelId: 'claude-sonnet-4-6-20260514',
        displayName: 'Claude Sonnet 4.6',
      },
    ]);
  });

  it('sends Anthropic auth headers (x-api-key + anthropic-version)', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [] }));
    await discoverAnthropicModels('sk-ant-headers', { fetcher });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-headers');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('drops superseded legacy generations (claude-1/2/3, instant)', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'claude-opus-4-8-20260528', display_name: 'Claude Opus 4.8' },
          {
            id: 'claude-3-7-sonnet-20250219',
            display_name: 'Claude 3.7 Sonnet',
          },
          {
            id: 'claude-3-5-sonnet-20241022',
            display_name: 'Claude 3.5 Sonnet',
          },
          { id: 'claude-2.1', display_name: 'Claude 2.1' },
          { id: 'claude-instant-1.2', display_name: 'Claude Instant' },
        ],
      }),
    );
    const result = await discoverAnthropicModels('sk-ant-test', { fetcher });
    expect(result.models.map((m) => m.modelId)).toEqual([
      'claude-opus-4-8-20260528',
    ]);
  });

  it('keeps a hypothetical future generation (claude-5)', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 'claude-opus-5-20270101', display_name: 'Claude Opus 5' }],
      }),
    );
    const result = await discoverAnthropicModels('sk-ant-test', { fetcher });
    expect(result.models.map((m) => m.modelId)).toEqual([
      'claude-opus-5-20270101',
    ]);
  });

  it('falls back to modelId when display_name is absent', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-opus-4-9-20260901' }] }),
    );
    const result = await discoverAnthropicModels('sk-ant-test', { fetcher });
    expect(result.models).toEqual([{ modelId: 'claude-opus-4-9-20260901' }]);
  });

  it('serves a cache hit without re-fetching', async () => {
    const { cache } = makeFakeCache();
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-opus-4-8', display_name: 'X' }] }),
    );
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats 401/403 as auth_error and does not cache it', async () => {
    const { cache, size } = makeFakeCache();
    const fetcher = vi.fn(async () => jsonResponse({}, 401));
    const result = await discoverAnthropicModels('sk-ant-bad', {
      cache,
      fetcher,
    });
    expect(result.status).toBe('auth_error');
    expect(size()).toBe(0);
    await discoverAnthropicModels('sk-ant-bad', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches 429 rate_limited for 5 minutes', async () => {
    const { cache, advance } = makeFakeCache();
    const fetcher = vi.fn(async () => jsonResponse({}, 429));
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    advance(4 * 60 * 1000);
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(2 * 60 * 1000);
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports a thrown network error as unavailable', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const result = await discoverAnthropicModels('sk-ant-test', { fetcher });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('socket hang up');
  });

  it('returns auth_error early for an empty key without a fetch', async () => {
    const fetcher = vi.fn();
    const result = await discoverAnthropicModels('', {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.status).toBe('auth_error');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('isolates cache entries per API key', async () => {
    const { cache } = makeFakeCache();
    const fetcherA = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-opus-4-8', display_name: 'A' }] }),
    );
    const fetcherB = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-sonnet-4-6', display_name: 'B' }] }),
    );
    const a = await discoverAnthropicModels('sk-ant-A', {
      cache,
      fetcher: fetcherA,
    });
    const b = await discoverAnthropicModels('sk-ant-B', {
      cache,
      fetcher: fetcherB,
    });
    expect(a.models[0].modelId).toBe('claude-opus-4-8');
    expect(b.models[0].modelId).toBe('claude-sonnet-4-6');
  });
});

describe('invalidateAnthropicDiscovery', () => {
  it('forces the next call to re-fetch after invalidation', async () => {
    const { cache } = makeFakeCache();
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-opus-4-8', display_name: 'X' }] }),
    );
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await invalidateAnthropicDiscovery('sk-ant-test', cache);
    await discoverAnthropicModels('sk-ant-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('no-ops when no cache is provided', async () => {
    await expect(
      invalidateAnthropicDiscovery('sk-ant-test', null),
    ).resolves.toBeUndefined();
  });
});

// Integration test against the real Anthropic endpoint. Skipped unless
// ANTHROPIC_TEST_KEY is set so CI stays hermetic.
const ANTHROPIC_TEST_KEY = process.env.ANTHROPIC_TEST_KEY;

describe.skipIf(!ANTHROPIC_TEST_KEY)(
  'discoverAnthropicModels [integration: real Anthropic endpoint]',
  () => {
    it('returns a non-empty Claude model list', async () => {
      const result = await discoverAnthropicModels(ANTHROPIC_TEST_KEY!);
      expect(result.status).toBe('ok');
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.every((m) => m.modelId.startsWith('claude-'))).toBe(
        true,
      );
    }, 15_000);
  },
);
