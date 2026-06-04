import { afterEach, describe, expect, it } from 'vitest';

import {
  persistedCacheBuster,
  QUERY_CACHE_BUSTER,
  rememberActiveWorkspace,
} from './queryClient';

describe('persistedCacheBuster', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('returns the base buster when no workspace is recorded', () => {
    expect(persistedCacheBuster()).toBe(QUERY_CACHE_BUSTER);
  });

  it('folds the active workspace into the buster so a switch invalidates the persisted cache', () => {
    rememberActiveWorkspace('ws-a');
    const inA = persistedCacheBuster();
    rememberActiveWorkspace('ws-b');
    const inB = persistedCacheBuster();

    expect(inA).toBe(`${QUERY_CACHE_BUSTER}:ws-a`);
    expect(inB).toBe(`${QUERY_CACHE_BUSTER}:ws-b`);
    // Different busters => PersistQueryClientProvider drops the prior
    // workspace's persisted cache on hydration.
    expect(inA).not.toBe(inB);
  });

  it('clears the workspace marker when passed null', () => {
    rememberActiveWorkspace('ws-a');
    rememberActiveWorkspace(null);
    expect(persistedCacheBuster()).toBe(QUERY_CACHE_BUSTER);
  });
});
