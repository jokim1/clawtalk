// Connectors refactor PR 1 — end-to-end tests for connectors-accessors.
//
// Mirrors the agent-accessors test scaffolding (test-helpers.ts contract).
// Runs against the local supabase stack on 127.0.0.1:54432; expects
// migrations 0019/0020/0021 to be applied.
//
// UUID prefix used for this file: 0c888888 (per the test-helpers prefix
// registry convention).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  ConnectorConfigInvalidError,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  decryptWorkspaceChannelCredential,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  getTalkConnectorsView,
  getWorkspaceChannel,
  getWorkspaceDataConnector,
  linkTalkChannel,
  linkTalkDataConnector,
  listTalkChannelLinks,
  listTalkDataConnectorLinks,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  unlinkTalkChannel,
  unlinkTalkDataConnector,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
} from './connectors-accessors.js';

const ADMIN_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_MEMBER_ID = '0c888888-cccc-cccc-cccc-cccccccccccc';

async function seedUser(input: {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${input.id}::uuid,
      ${input.email}::text,
      jsonb_build_object('full_name', ${input.email}::text)
    )
    on conflict (id) do nothing
  `;
  // The on_auth_user_created trigger inserts into public.users with
  // role='member'. Promote admins / owners via direct update from the
  // BYPASSRLS postgres role.
  if (input.role !== 'member') {
    await db`
      update public.users set role = ${input.role}
      where id = ${input.id}::uuid
    `;
  }
}

async function seedTalk(input: {
  ownerId: string;
  talkId?: string;
}): Promise<string> {
  const db = getDbPg();
  const rows = await db<Array<{ id: string }>>`
    insert into public.talks (id, owner_id, topic_title)
    values (
      coalesce(${input.talkId ?? null}::uuid, gen_random_uuid()),
      ${input.ownerId}::uuid,
      'Connectors test talk'
    )
    returning id
  `;
  if (!rows[0]) throw new Error('seedTalk failed');
  return rows[0].id;
}

async function purgeConnectorsData(): Promise<void> {
  const db = getDbPg();
  // talks cascade to talk_*_links via FK; workspace_* rows are global
  // (not user-scoped) — clear them explicitly between tests.
  await db`
    delete from public.talks
    where owner_id in (${ADMIN_ID}::uuid, ${MEMBER_ID}::uuid,
                       ${OTHER_MEMBER_ID}::uuid)
  `;
  await db`delete from public.workspace_channels`;
  await db`delete from public.workspace_data_connectors`;
}

describe('connectors-accessors (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedUser({
      id: ADMIN_ID,
      email: 'connectors-admin@clawtalk.local',
      role: 'admin',
    });
    await seedUser({
      id: MEMBER_ID,
      email: 'connectors-member@clawtalk.local',
      role: 'member',
    });
    await seedUser({
      id: OTHER_MEMBER_ID,
      email: 'connectors-other@clawtalk.local',
      role: 'member',
    });
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users
      where id in (${ADMIN_ID}::uuid, ${MEMBER_ID}::uuid,
                   ${OTHER_MEMBER_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purgeConnectorsData();
  });

  it('schema preconditions: RLS enabled + policies present on new tables', async () => {
    const db = getDbPg();
    const rows = await db<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'workspace_channels', 'talk_channel_links',
          'workspace_data_connectors', 'talk_data_connector_links'
        )
    `;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
    }
    const policies = await db<{ tablename: string; policyname: string }[]>`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'workspace_channels', 'talk_channel_links',
          'workspace_data_connectors', 'talk_data_connector_links'
        )
    `;
    const tablesWithPolicy = new Set(policies.map((p) => p.tablename));
    expect(tablesWithPolicy.has('workspace_channels')).toBe(true);
    expect(tablesWithPolicy.has('talk_channel_links')).toBe(true);
    expect(tablesWithPolicy.has('workspace_data_connectors')).toBe(true);
    expect(tablesWithPolicy.has('talk_data_connector_links')).toBe(true);
  });

  it('T2: createWorkspaceChannel as admin succeeds', async () => {
    const created = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Engineering',
        config: { workspace_id: 'W123', channel_id: 'C456' },
        createdBy: ADMIN_ID,
      }),
    );
    expect(created.kind).toBe('slack');
    expect(created.display_name).toBe('Engineering');
    expect(created.config_json).toMatchObject({
      workspace_id: 'W123',
      channel_id: 'C456',
    });
    expect(created.has_credential).toBe(false);
    expect(created.enabled).toBe(true);
    expect(created.bound_talk_count).toBe(0);
  });

  it('T1: listWorkspaceChannels returns rows for any auth user (member can read)', async () => {
    await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Eng',
        createdBy: ADMIN_ID,
      }),
    );
    const seen = await withUserContext(MEMBER_ID, async () =>
      listWorkspaceChannels(),
    );
    expect(seen.map((c) => c.display_name)).toContain('Eng');
  });

  it('T3: createWorkspaceChannel as member → RLS rejects', async () => {
    await expect(
      withUserContext(MEMBER_ID, async () =>
        createWorkspaceChannel({
          kind: 'slack',
          displayName: 'Should not insert',
          createdBy: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });

  it('T4: createWorkspaceChannel without ciphertext stores has_credential=false', async () => {
    const created = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'telegram',
        displayName: 'Alerts',
        config: { bot_id: 'B1', chat_id: 'C9' },
        createdBy: ADMIN_ID,
      }),
    );
    expect(created.has_credential).toBe(false);
  });

  it('T5: createWorkspaceChannel with invalid config_json → Zod rejects', async () => {
    await expect(
      withUserContext(ADMIN_ID, async () =>
        createWorkspaceChannel({
          kind: 'slack',
          displayName: 'Bad config',
          // workspace_id must be string when present; pass a number to trip Zod
          config: { workspace_id: 123 },
          createdBy: ADMIN_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);
  });

  it('T6: updateWorkspaceChannel patches display_name', async () => {
    const created = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Original',
        createdBy: ADMIN_ID,
      }),
    );
    const updated = await withUserContext(ADMIN_ID, async () =>
      updateWorkspaceChannel(created.id, {
        displayName: 'Renamed',
        updatedBy: ADMIN_ID,
      }),
    );
    expect(updated?.display_name).toBe('Renamed');
  });

  it('T7: deleteWorkspaceChannel cascades to talk_channel_links', async () => {
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Cascade test',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    expect(
      (await withUserContext(MEMBER_ID, () => listTalkChannelLinks(talkId)))
        .length,
    ).toBe(1);

    await withUserContext(ADMIN_ID, () => deleteWorkspaceChannel(channel.id));

    expect(
      (await withUserContext(MEMBER_ID, () => listTalkChannelLinks(talkId)))
        .length,
    ).toBe(0);
  });

  it('T8: linkTalkChannel is idempotent on conflict', async () => {
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Idempotent',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    // Second click must not throw and must not produce a duplicate row.
    await withUserContext(MEMBER_ID, async () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    const links = await withUserContext(MEMBER_ID, () =>
      listTalkChannelLinks(talkId),
    );
    expect(links.length).toBe(1);
  });

  it('T9: unlinkTalkChannel removes the row', async () => {
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Toggle off',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () => {
      await linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      });
      const removed = await unlinkTalkChannel({
        talkId,
        channelId: channel.id,
      });
      expect(removed).toBe(true);
      const links = await listTalkChannelLinks(talkId);
      expect(links.length).toBe(0);
    });
  });

  it('T10/T11: getTalkConnectorsView annotates linked + workspace.enabled', async () => {
    const linked = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Linked channel',
        createdBy: ADMIN_ID,
      }),
    );
    const unlinked = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'telegram',
        displayName: 'Unlinked channel',
        enabled: false,
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () =>
      linkTalkChannel({
        talkId,
        channelId: linked.id,
        ownerId: MEMBER_ID,
      }),
    );
    const view = await withUserContext(MEMBER_ID, () =>
      getTalkConnectorsView(talkId),
    );
    const linkedRow = view.channels.find((c) => c.id === linked.id);
    const unlinkedRow = view.channels.find((c) => c.id === unlinked.id);
    expect(linkedRow?.linked).toBe(true);
    expect(linkedRow?.enabled).toBe(true);
    expect(unlinkedRow?.linked).toBe(false);
    expect(unlinkedRow?.enabled).toBe(false);
  });

  it('T12: linkTalkChannel rejects ownerId mismatch with auth.uid()', async () => {
    // Talk-ownership enforcement is the ROUTE layer's job (see
    // connectors.ts: lookup talk + reject if owner != caller). The RLS
    // policy on `talk_channel_links` is `owner_id = auth.uid()`, which
    // catches the simpler attack of stamping a different user's id as
    // owner. Verify that the policy fires for that case here.
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Owner check',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await expect(
      withUserContext(OTHER_MEMBER_ID, async () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });

  it('T14: listWorkspaceChannels returns bound_talk_count', async () => {
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Bound count',
        createdBy: ADMIN_ID,
      }),
    );
    const talkA = await seedTalk({ ownerId: MEMBER_ID });
    const talkB = await seedTalk({ ownerId: OTHER_MEMBER_ID });
    await withUserContext(MEMBER_ID, () =>
      linkTalkChannel({
        talkId: talkA,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    await withUserContext(OTHER_MEMBER_ID, () =>
      linkTalkChannel({
        talkId: talkB,
        channelId: channel.id,
        ownerId: OTHER_MEMBER_ID,
      }),
    );
    const channels = await withUserContext(ADMIN_ID, () =>
      listWorkspaceChannels(),
    );
    const row = channels.find((c) => c.id === channel.id);
    expect(row?.bound_talk_count).toBe(2);
  });

  it('setWorkspaceChannelCredential round-trips through encryption pipeline', async () => {
    const channel = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Credential',
        createdBy: ADMIN_ID,
      }),
    );
    const updated = await withUserContext(ADMIN_ID, () =>
      setWorkspaceChannelCredential(
        channel.id,
        { apiKey: 'xoxb-secret-1234' },
        ADMIN_ID,
      ),
    );
    expect(updated?.has_credential).toBe(true);
    const decrypted = await withUserContext(ADMIN_ID, () =>
      decryptWorkspaceChannelCredential(channel.id),
    );
    expect(decrypted?.apiKey).toBe('xoxb-secret-1234');

    // Clearing the credential
    const cleared = await withUserContext(ADMIN_ID, () =>
      setWorkspaceChannelCredential(channel.id, null, ADMIN_ID),
    );
    expect(cleared?.has_credential).toBe(false);
  });

  it('getWorkspaceChannel returns null for unknown id', async () => {
    const row = await withUserContext(ADMIN_ID, () =>
      getWorkspaceChannel('00000000-0000-0000-0000-000000000000'),
    );
    expect(row).toBeNull();
  });

  // ── T13: Same set parameterized for workspace_data_connectors ────────

  it('T13a: createWorkspaceDataConnector as admin succeeds', async () => {
    const created = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Prod analytics',
        config: { project_id: '250736', host: 'https://app.posthog.com' },
        createdBy: ADMIN_ID,
      }),
    );
    expect(created.kind).toBe('posthog');
    expect(created.display_name).toBe('Prod analytics');
    expect(created.bound_talk_count).toBe(0);
  });

  it('T13b: createWorkspaceDataConnector as member → RLS rejects', async () => {
    await expect(
      withUserContext(MEMBER_ID, async () =>
        createWorkspaceDataConnector({
          kind: 'posthog',
          displayName: 'Should not insert',
          createdBy: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });

  it('T13c: createWorkspaceDataConnector with bad host URL → Zod rejects', async () => {
    await expect(
      withUserContext(ADMIN_ID, async () =>
        createWorkspaceDataConnector({
          kind: 'posthog',
          displayName: 'Bad host',
          config: { host: 'not-a-url' },
          createdBy: ADMIN_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);
  });

  it('T13d: updateWorkspaceDataConnector patches display_name', async () => {
    const created = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'google_docs',
        displayName: 'Original docs',
        createdBy: ADMIN_ID,
      }),
    );
    const updated = await withUserContext(ADMIN_ID, async () =>
      updateWorkspaceDataConnector(created.id, {
        displayName: 'Renamed docs',
        updatedBy: ADMIN_ID,
      }),
    );
    expect(updated?.display_name).toBe('Renamed docs');
  });

  it('T13e: deleteWorkspaceDataConnector cascades to talk_data_connector_links', async () => {
    const dc = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'google_sheets',
        displayName: 'Sheets cascade',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, () =>
      linkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      }),
    );
    await withUserContext(ADMIN_ID, () => deleteWorkspaceDataConnector(dc.id));
    const links = await withUserContext(MEMBER_ID, () =>
      listTalkDataConnectorLinks(talkId),
    );
    expect(links.length).toBe(0);
  });

  it('T13f: linkTalkDataConnector is idempotent', async () => {
    const dc = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Idempotent DC',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () => {
      await linkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      });
      await linkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      });
    });
    const links = await withUserContext(MEMBER_ID, () =>
      listTalkDataConnectorLinks(talkId),
    );
    expect(links.length).toBe(1);
  });

  it('T13g: unlinkTalkDataConnector removes the row', async () => {
    const dc = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Toggle off DC',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () => {
      await linkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      });
      const removed = await unlinkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
      });
      expect(removed).toBe(true);
    });
    const links = await withUserContext(MEMBER_ID, () =>
      listTalkDataConnectorLinks(talkId),
    );
    expect(links.length).toBe(0);
  });

  it('T13h: linkTalkDataConnector rejects ownerId mismatch with auth.uid()', async () => {
    // Parallel to T12 — RLS owner_id = auth.uid() catches the spoof.
    // Talk-ownership enforcement is at the route layer.
    const dc = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Owner check DC',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await expect(
      withUserContext(OTHER_MEMBER_ID, async () =>
        linkTalkDataConnector({
          talkId,
          dataConnectorId: dc.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });

  it('T13i: setWorkspaceDataConnectorCredential clears via null', async () => {
    const dc = await withUserContext(ADMIN_ID, async () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Cred DC',
        createdBy: ADMIN_ID,
      }),
    );
    const set = await withUserContext(ADMIN_ID, () =>
      setWorkspaceDataConnectorCredential(
        dc.id,
        { apiKey: 'ph_api_key_secret' },
        ADMIN_ID,
      ),
    );
    expect(set?.has_credential).toBe(true);
    const cleared = await withUserContext(ADMIN_ID, () =>
      setWorkspaceDataConnectorCredential(dc.id, null, ADMIN_ID),
    );
    expect(cleared?.has_credential).toBe(false);
  });

  it('T13j: getTalkConnectorsView merges channels + data connectors', async () => {
    const channel = await withUserContext(ADMIN_ID, () =>
      createWorkspaceChannel({
        kind: 'slack',
        displayName: 'Combined slack',
        createdBy: ADMIN_ID,
      }),
    );
    const dc = await withUserContext(ADMIN_ID, () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'Combined posthog',
        createdBy: ADMIN_ID,
      }),
    );
    const talkId = await seedTalk({ ownerId: MEMBER_ID });
    await withUserContext(MEMBER_ID, async () => {
      await linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      });
      await linkTalkDataConnector({
        talkId,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      });
    });
    const view = await withUserContext(MEMBER_ID, () =>
      getTalkConnectorsView(talkId),
    );
    expect(view.channels.find((c) => c.id === channel.id)?.linked).toBe(true);
    expect(view.dataConnectors.find((d) => d.id === dc.id)?.linked).toBe(true);
  });

  it('listWorkspaceDataConnectors returns bound_talk_count', async () => {
    const dc = await withUserContext(ADMIN_ID, () =>
      createWorkspaceDataConnector({
        kind: 'posthog',
        displayName: 'DC count',
        createdBy: ADMIN_ID,
      }),
    );
    const talkA = await seedTalk({ ownerId: MEMBER_ID });
    const talkB = await seedTalk({ ownerId: OTHER_MEMBER_ID });
    await withUserContext(MEMBER_ID, () =>
      linkTalkDataConnector({
        talkId: talkA,
        dataConnectorId: dc.id,
        ownerId: MEMBER_ID,
      }),
    );
    await withUserContext(OTHER_MEMBER_ID, () =>
      linkTalkDataConnector({
        talkId: talkB,
        dataConnectorId: dc.id,
        ownerId: OTHER_MEMBER_ID,
      }),
    );
    const all = await withUserContext(ADMIN_ID, () =>
      listWorkspaceDataConnectors(),
    );
    expect(all.find((d) => d.id === dc.id)?.bound_talk_count).toBe(2);
  });

  it('getWorkspaceDataConnector returns null for unknown id', async () => {
    const row = await withUserContext(ADMIN_ID, () =>
      getWorkspaceDataConnector('00000000-0000-0000-0000-000000000000'),
    );
    expect(row).toBeNull();
  });
});
