// TanStack Query client + IDB-backed persister for the webapp. Persists
// snapshot caches across reloads so a returning user gets a sub-100ms
// warm-cache first paint when they reopen a Talk they've recently
// visited. Cache lifetime is bounded by `gcTime` (24h) — entries older
// than that are dropped on next mount, and the persister itself drops
// stale buster keys on bump.

import { QueryClient } from '@tanstack/react-query';
import type {
  PersistedClient,
  Persister,
} from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const IDB_KEY = 'clawtalk.tanstack-query.v1';

// Bump this string whenever the snapshot wire format changes in a way
// that would make older cached entries incorrect to render. The
// PersistQueryClientProvider compares it and silently drops mismatched
// caches on hydration.
export const QUERY_CACHE_BUSTER = 'snapshot-v1';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache must outlive the persistence window or persisted entries
      // get garbage-collected before they're restored. 24h matches the
      // upstream PersistQueryClientProvider example.
      gcTime: 1000 * 60 * 60 * 24,
      // Snapshots are kept fresh by WS deltas and reconnect-invalidate.
      // No need to refetch on every focus/mount.
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function createIDBPersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      await set(IDB_KEY, client);
    },
    restoreClient: async () => {
      return (await get<PersistedClient>(IDB_KEY)) ?? undefined;
    },
    removeClient: async () => {
      await del(IDB_KEY);
    },
  };
}

export const idbPersister = createIDBPersister();

// Called from the auth-logout flow so a different user signing in on
// the same device can't see the previous user's cached snapshots.
// Per-user queryKey prefix already prevents accidental cross-user reads
// across reloads, but clearing IDB on logout is the belt-and-braces
// move that also drops MRU residue for privacy.
export async function clearPersistedQueryCache(): Promise<void> {
  queryClient.clear();
  // Best-effort: never let a cache-clear failure break sign-out. IndexedDB
  // can be unavailable (private browsing, blocked, quota) or absent entirely
  // (jsdom in tests), and a rejected removeClient() would otherwise abort the
  // caller's sign-out flow before it clears auth state.
  try {
    await idbPersister.removeClient();
  } catch {
    // ignore
  }
}

const ACTIVE_WORKSPACE_STORAGE_KEY = 'clawtalk.active-workspace';

// Record the active workspace so persistedCacheBuster() can fold it into the
// persist buster. Called on every session load and on workspace switch.
export function rememberActiveWorkspace(workspaceId: string | null): void {
  try {
    if (workspaceId) {
      localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    } else {
      localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
  } catch {
    // ignore (storage unavailable, e.g. private mode)
  }
}

// The persisted snapshot key is user-scoped, not workspace-scoped, so a stale
// cache from a previous workspace could otherwise rehydrate after a switch.
// Folding the active workspace into the buster makes PersistQueryClientProvider
// drop the prior workspace's cache on hydration — the robust cross-tenant
// boundary, independent of the best-effort IDB wipe. Read synchronously at
// provider setup, before the session loads.
// Read the active workspace marker. The api client sends it as the
// `x-workspace-id` header so the backend (which has no persisted active
// workspace) scopes each request to the workspace the user last selected.
export function getActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function persistedCacheBuster(): string {
  const workspaceId = getActiveWorkspaceId();
  return workspaceId
    ? `${QUERY_CACHE_BUSTER}:${workspaceId}`
    : QUERY_CACHE_BUSTER;
}
