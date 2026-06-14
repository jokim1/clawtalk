// Per-account dispatch-runtime flag (Talk Runtime v2, Wave 2 PR-B).
//
// docs/13-talk-runtime-v2.md §6.4 (PR-B lands the flag + resolution so "PR-C is
// just the dispatch flip"). A chat turn dispatches either onto TALK_RUN_QUEUE
// (v1 queue path) or directly to the per-Talk TalkRunner DO (v2). This module
// resolves WHICH path for a given account, read at dispatch time.
//
// Default OFF (`'queue'`) — PR-B ships dormant. PR-C flips the flag (a
// settings_kv write, ops-controlled, no code change) and switches the dispatch
// call; PR-D removes the queue branch entirely.
//
// Storage: settings_kv (a global key/value table). `authenticated` has SELECT
// (the dispatch path reads it under withUserContext RLS); writes are revoked
// from `authenticated` and go through withTrustedDbWrites (ops / tests). A
// per-workspace key overrides a global default key.

import { getDbPg, withTrustedDbWrites } from '../../db.js';

export type DispatchRuntime = 'queue' | 'do';

// settings_kv key namespace. The default key flips a whole environment; the
// per-workspace key is the per-account override the rollout actually uses.
const DEFAULT_KEY = 'talk_runtime_v2:dispatch:default';
function workspaceKey(workspaceId: string): string {
  return `talk_runtime_v2:dispatch:workspace:${workspaceId}`;
}

function normalizeRuntime(
  value: string | null | undefined,
): DispatchRuntime | null {
  if (value === 'do') return 'do';
  if (value === 'queue') return 'queue';
  return null;
}

/**
 * Resolve the dispatch runtime for an account. A per-workspace override wins
 * over the global default; absent both, the runtime is `'queue'` (flag OFF).
 *
 * Both keys are read in ONE query. Reads run on the request-scoped (or
 * node-scoped) client via getDbPg, so the caller must already be inside a DB
 * scope (the chat route is, under withUserContext).
 */
export async function resolveDispatchRuntime(input: {
  workspaceId: string;
}): Promise<DispatchRuntime> {
  const db = getDbPg();
  const wsKey = workspaceKey(input.workspaceId);
  const rows = await db<{ key: string; value: string | null }[]>`
    select key, value
    from public.settings_kv
    where key in (${wsKey}, ${DEFAULT_KEY})
  `;
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  // Per-workspace override (including an explicit 'queue' opt-out) wins.
  const workspaceOverride = normalizeRuntime(byKey.get(wsKey));
  if (workspaceOverride) return workspaceOverride;
  return normalizeRuntime(byKey.get(DEFAULT_KEY)) ?? 'queue';
}

/**
 * Set the per-workspace dispatch runtime (ops / tests / PR-C rollout). Writes
 * go through withTrustedDbWrites because `authenticated` cannot mutate
 * settings_kv. Passing `null` clears the override (falls back to the default).
 */
export async function setWorkspaceDispatchRuntime(input: {
  workspaceId: string;
  runtime: DispatchRuntime | null;
  updatedBy?: string | null;
}): Promise<void> {
  const db = getDbPg();
  const key = workspaceKey(input.workspaceId);
  await withTrustedDbWrites(async () => {
    if (input.runtime === null) {
      await db`delete from public.settings_kv where key = ${key}`;
      return;
    }
    await db`
      insert into public.settings_kv (key, value, updated_by)
      values (${key}, ${input.runtime}, ${input.updatedBy ?? null}::uuid)
      on conflict (key) do update set
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
  });
}

/**
 * Set the environment-wide default dispatch runtime (ops). Used by PR-C to flip
 * the whole environment, or to set a baseline that per-workspace keys override.
 */
export async function setDefaultDispatchRuntime(input: {
  runtime: DispatchRuntime | null;
  updatedBy?: string | null;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(async () => {
    if (input.runtime === null) {
      await db`delete from public.settings_kv where key = ${DEFAULT_KEY}`;
      return;
    }
    await db`
      insert into public.settings_kv (key, value, updated_by)
      values (${DEFAULT_KEY}, ${input.runtime}, ${input.updatedBy ?? null}::uuid)
      on conflict (key) do update set
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
  });
}
