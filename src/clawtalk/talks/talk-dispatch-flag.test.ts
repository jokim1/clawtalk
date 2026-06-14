// Per-account dispatch flag resolution (Talk Runtime v2, Wave 2 PR-B).
// Node suite — real local Postgres (settings_kv reads/writes).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePgDatabase, getDbPg, initPgDatabase } from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  resolveDispatchRuntime,
  setDefaultDispatchRuntime,
  setWorkspaceDispatchRuntime,
} from './talk-dispatch-flag.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c111111-dddd-dddd-dddd-dddddddddddd';

let workspaceId = '';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text, jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function clearFlagKeys(): Promise<void> {
  await setWorkspaceDispatchRuntime({ workspaceId, runtime: null });
  await setDefaultDispatchRuntime({ runtime: null });
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(USER_ID, 'dispatch-flag-test@clawtalk.test');
  workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  await clearFlagKeys();
});

afterEach(clearFlagKeys);

afterAll(async () => {
  await clearFlagKeys();
  const db = getDbPg();
  await db`delete from public.workspaces where owner_id = ${USER_ID}::uuid`;
  await db`delete from auth.users where id = ${USER_ID}::uuid`;
  await closePgDatabase();
});

describe('resolveDispatchRuntime', () => {
  it('defaults to queue (flag OFF) when no keys are set', async () => {
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('queue');
  });

  it('returns do when the per-workspace override is do', async () => {
    await setWorkspaceDispatchRuntime({ workspaceId, runtime: 'do' });
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('do');
  });

  it('returns do when only the environment default is do', async () => {
    await setDefaultDispatchRuntime({ runtime: 'do' });
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('do');
  });

  it('lets a per-workspace queue override beat a do default (opt-out wins)', async () => {
    await setDefaultDispatchRuntime({ runtime: 'do' });
    await setWorkspaceDispatchRuntime({ workspaceId, runtime: 'queue' });
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('queue');
  });

  it('does not leak one workspace flag onto another account', async () => {
    await setWorkspaceDispatchRuntime({ workspaceId, runtime: 'do' });
    const other = '0c222222-eeee-eeee-eeee-eeeeeeeeeeee';
    expect(await resolveDispatchRuntime({ workspaceId: other })).toBe('queue');
  });

  it('clearing the override falls back to the default', async () => {
    await setWorkspaceDispatchRuntime({ workspaceId, runtime: 'do' });
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('do');
    await setWorkspaceDispatchRuntime({ workspaceId, runtime: null });
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('queue');
  });

  it('ignores malformed stored values and treats them as unset', async () => {
    await getDbPg()`
      insert into public.settings_kv (key, value)
      values (${`talk_runtime_v2:dispatch:workspace:${workspaceId}`}, 'garbage')
      on conflict (key) do update set value = excluded.value
    `;
    expect(await resolveDispatchRuntime({ workspaceId })).toBe('queue');
  });
});
