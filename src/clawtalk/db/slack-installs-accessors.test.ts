import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  decryptWorkspaceSlackInstallToken,
  deleteWorkspaceSlackInstall,
  listWorkspaceSlackInstalls,
  upsertWorkspaceSlackInstall,
} from './slack-installs-accessors.js';

const OWNER_ID = '0c888898-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c888898-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${email}::text)
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteFixtureUsers(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
}

async function createFixture(): Promise<{ workspaceId: string }> {
  await seedAuthUser(OWNER_ID, 'slack-install-owner@clawtalk.local');
  await seedAuthUser(MEMBER_ID, 'slack-install-member@clawtalk.local');
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  await getDbPg()`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${MEMBER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  return { workspaceId };
}

describe('greenfield Slack install accessors', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await deleteFixtureUsers();
  });

  afterAll(async () => {
    await deleteFixtureUsers();
    await closePgDatabase();
  });

  it('serializes concurrent upserts for the same workspace team', async () => {
    const { workspaceId } = await createFixture();

    const [first, second] = await Promise.all([
      upsertWorkspaceSlackInstall({
        workspaceId,
        teamId: 'TCONCURRENT',
        teamName: 'Concurrent One',
        botUserId: 'U1',
        appId: 'A1',
        botToken: 'xoxb-one',
        scopes: ['channels:read'],
        installedBy: OWNER_ID,
      }),
      upsertWorkspaceSlackInstall({
        workspaceId,
        teamId: 'TCONCURRENT',
        teamName: 'Concurrent Two',
        botUserId: 'U2',
        appId: 'A2',
        botToken: 'xoxb-two',
        scopes: ['channels:read', 'chat:write'],
        installedBy: OWNER_ID,
      }),
    ]);

    expect(first.id).toBe(second.id);
    const installs = await listWorkspaceSlackInstalls({ workspaceId });
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      id: first.id,
      workspace_id: workspaceId,
      team_id: 'TCONCURRENT',
    });

    const rows = await getDbPg()<
      Array<{ connector_count: number; secret_count: number }>
    >`
      select
        count(*)::int as connector_count,
        (
          select count(*)::int
          from public.connector_secrets cs
          where cs.workspace_id = ${workspaceId}::uuid
        ) as secret_count
      from public.connectors c
      where c.workspace_id = ${workspaceId}::uuid
        and c.service = 'slack'
        and c.config_json->>'compatSurface' = 'slack_install'
        and c.config_json->>'teamId' = 'TCONCURRENT'
    `;
    expect(rows[0]).toEqual({ connector_count: 1, secret_count: 1 });
  });

  it('rotates install secrets and decrypts by scoped workspace/team', async () => {
    const { workspaceId } = await createFixture();
    await upsertWorkspaceSlackInstall({
      workspaceId,
      teamId: 'TSECURE',
      teamName: 'Secure',
      botUserId: 'U1',
      appId: 'A1',
      botToken: 'xoxb-secure',
      scopes: ['channels:read'],
      installedBy: OWNER_ID,
    });
    await upsertWorkspaceSlackInstall({
      workspaceId,
      teamId: 'TSECURE',
      teamName: 'Secure',
      botUserId: 'U1',
      appId: 'A1',
      botToken: 'xoxb-rotated',
      scopes: ['channels:read', 'chat:write'],
      installedBy: OWNER_ID,
    });

    await expect(
      decryptWorkspaceSlackInstallToken('TSECURE', { workspaceId }),
    ).resolves.toBe('xoxb-rotated');
    await expect(
      withUserContext(MEMBER_ID, () =>
        decryptWorkspaceSlackInstallToken('TSECURE', { workspaceId }),
      ),
    ).resolves.toBe('xoxb-rotated');
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceSlackInstallToken('TSECURE', { workspaceId }),
      ),
    ).resolves.toBe('xoxb-rotated');
    const foreignWorkspaceId = await ensureWorkspaceBootstrapForUser(MEMBER_ID);
    await expect(
      decryptWorkspaceSlackInstallToken('TSECURE', {
        workspaceId: foreignWorkspaceId,
      }),
    ).resolves.toBeNull();
    const secretRows = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.connector_secrets
      where workspace_id = ${workspaceId}::uuid
    `;
    expect(secretRows[0]?.count).toBe(1);

    await expect(
      withUserContext(MEMBER_ID, () =>
        deleteWorkspaceSlackInstall('TSECURE', { workspaceId }),
      ),
    ).resolves.toBe(false);
    await expect(
      withUserContext(OWNER_ID, () =>
        deleteWorkspaceSlackInstall('TSECURE', { workspaceId }),
      ),
    ).resolves.toBe(true);
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceSlackInstallToken('TSECURE', { workspaceId }),
      ),
    ).resolves.toBeNull();
  });
});
