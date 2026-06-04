import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../workspaces/bootstrap.js';
import {
  ConnectorConfigInvalidError,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  decryptWorkspaceChannelCredential,
  decryptWorkspaceDataConnectorCredential,
  getTalkConnectorsView,
  getWorkspaceChannel,
  getWorkspaceDataConnector,
  linkTalkChannel,
  linkTalkDataConnector,
  listTalkChannelLinks,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  unlinkTalkChannel,
  unlinkTalkDataConnector,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
} from './connectors-accessors.js';
import { upsertWorkspaceSlackInstall } from './slack-installs-accessors.js';

const OWNER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_ID = '0c888888-cccc-cccc-cccc-cccccccccccc';

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
    where owner_id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid, ${OTHER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${OWNER_ID}::uuid, ${MEMBER_ID}::uuid, ${OTHER_ID}::uuid)
  `;
}

async function createFixture(): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  await seedAuthUser(OWNER_ID, 'connector-accessor-owner@clawtalk.local');
  await seedAuthUser(MEMBER_ID, 'connector-accessor-member@clawtalk.local');
  await seedAuthUser(OTHER_ID, 'connector-accessor-other@clawtalk.local');
  const workspaceId = await ensureWorkspaceBootstrapForUser(OWNER_ID);
  const db = getDbPg();
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${MEMBER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  const talkRows = await db<Array<{ id: string }>>`
    insert into public.talks (workspace_id, sort_order, title, created_by)
    values (${workspaceId}::uuid, 0, 'Accessor Connector Talk', ${MEMBER_ID}::uuid)
    returning id
  `;
  return { workspaceId, talkId: talkRows[0]!.id };
}

async function createTalkInWorkspace(input: {
  workspaceId: string;
  sortOrder: number;
  createdBy: string;
  title?: string;
}): Promise<string> {
  const rows = await getDbPg()<Array<{ id: string }>>`
    insert into public.talks (workspace_id, sort_order, title, created_by)
    values (
      ${input.workspaceId}::uuid,
      ${input.sortOrder},
      ${input.title ?? 'Accessor Connector Talk 2'},
      ${input.createdBy}::uuid
    )
    returning id
  `;
  return rows[0]!.id;
}

describe('greenfield connector accessors', () => {
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

  it('creates and lists channel connectors from final connectors table', async () => {
    const { workspaceId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Eng',
        config: { workspace_id: 'W1', channel_id: 'C1' },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      }),
    );
    expect(channel).toMatchObject({
      kind: 'slack',
      display_name: 'Eng',
      enabled: true,
      has_credential: false,
    });

    const rows = await withUserContext(MEMBER_ID, () =>
      listWorkspaceChannels({ workspaceId }),
    );
    expect(rows.map((row) => row.id)).toEqual([channel.id]);

    await expect(
      withUserContext(MEMBER_ID, () =>
        createWorkspaceChannel({
          workspaceId,
          kind: 'slack',
          displayName: 'Member write',
          createdBy: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });

  it('validates retired connector kinds and malformed configs', async () => {
    const { workspaceId } = await createFixture();
    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceChannel({
          workspaceId,
          kind: 'telegram',
          displayName: 'Telegram',
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toThrow('Unsupported channel kind');

    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceChannel({
          workspaceId,
          kind: 'slack',
          displayName: 'Bad',
          config: { workspace_id: 1234 },
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);

    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceChannel({
          workspaceId,
          kind: 'slack',
          displayName: 'Secret passthrough',
          config: { apiKey: 'xoxb-should-not-store' },
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);

    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceDataConnector({
          workspaceId,
          kind: 'google_docs',
          displayName: 'Secret data config',
          config: { folder_id: 'F1', token: 'google-should-not-store' },
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);
  });

  it('rejects unvalidated Slack channel targets outside the Slack importer', async () => {
    const { workspaceId } = await createFixture();

    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceChannel({
          workspaceId,
          kind: 'slack',
          displayName: 'Spoofed target',
          config: { workspace_id: 'T1', channel_id: 'C1' },
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);

    const channel = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Editable name only',
        createdBy: OWNER_ID,
      }),
    );
    await expect(
      withUserContext(OWNER_ID, () =>
        updateWorkspaceChannel(
          channel.id,
          {
            config: { workspace_id: 'T1', channel_id: 'C1' },
            updatedBy: OWNER_ID,
          },
          { workspaceId },
        ),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError);
  });

  it('round-trips connector credentials through connector_secrets', async () => {
    const { workspaceId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Secrets',
        createdBy: OWNER_ID,
      }),
    );
    const set = await withUserContext(OWNER_ID, () =>
      setWorkspaceChannelCredential(
        channel.id,
        { apiKey: 'xoxb-secret', organizationId: 'W1' },
        OWNER_ID,
        { workspaceId },
      ),
    );
    expect(set?.has_credential).toBe(true);
    const decrypted = await withUserContext(OWNER_ID, () =>
      decryptWorkspaceChannelCredential(channel.id, { workspaceId }),
    );
    expect(decrypted).toEqual({ apiKey: 'xoxb-secret', organizationId: 'W1' });
    await expect(
      decryptWorkspaceChannelCredential(channel.id, { workspaceId }),
    ).resolves.toEqual({ apiKey: 'xoxb-secret', organizationId: 'W1' });
    await expect(
      withUserContext(MEMBER_ID, () =>
        decryptWorkspaceChannelCredential(channel.id, { workspaceId }),
      ),
    ).resolves.toEqual({ apiKey: 'xoxb-secret', organizationId: 'W1' });
    const foreignWorkspaceId = await ensureWorkspaceBootstrapForUser(OTHER_ID);
    await expect(
      decryptWorkspaceChannelCredential(channel.id, {
        workspaceId: foreignWorkspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceDataConnectorCredential(channel.id, { workspaceId }),
      ),
    ).resolves.toBeNull();

    const withSecret = await getDbPg()<
      Array<{ secret_ref: string | null; secret_count: number }>
    >`
      select c.secret_ref,
             (
               select count(*)::int
               from public.connector_secrets cs
               where cs.workspace_id = c.workspace_id
                 and cs.id = c.secret_ref
             ) as secret_count
      from public.connectors c
      where c.id = ${channel.id}::uuid
    `;
    expect(withSecret[0]?.secret_ref).toBeTruthy();
    expect(withSecret[0]?.secret_count).toBe(1);

    const cleared = await withUserContext(OWNER_ID, () =>
      setWorkspaceChannelCredential(channel.id, null, OWNER_ID, {
        workspaceId,
      }),
    );
    expect(cleared?.has_credential).toBe(false);
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceChannelCredential(channel.id, { workspaceId }),
      ),
    ).resolves.toBeNull();
    const withoutSecret = await getDbPg()<
      Array<{ secret_ref: string | null; secret_count: number }>
    >`
      select c.secret_ref,
             (
               select count(*)::int
               from public.connector_secrets cs
               where cs.workspace_id = c.workspace_id
             ) as secret_count
      from public.connectors c
      where c.id = ${channel.id}::uuid
    `;
    expect(withoutSecret[0]).toEqual({ secret_ref: null, secret_count: 0 });
  });

  it('uses trusted writes for per-Talk connector bindings after caller auth', async () => {
    const { workspaceId, talkId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, async () => {
      const row = await createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Bindable',
        createdBy: OWNER_ID,
      });
      await setWorkspaceChannelCredential(
        row.id,
        { apiKey: 'xoxb' },
        OWNER_ID,
        {
          workspaceId,
        },
      );
      return row;
    });

    await withUserContext(MEMBER_ID, () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    await expect(
      withUserContext(OTHER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: OTHER_ID,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: OWNER_ID,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(true);

    await withUserContext(MEMBER_ID, () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    await expect(
      withUserContext(OWNER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: OWNER_ID,
        }),
      ),
    ).resolves.toBe(true);

    const links = await withUserContext(MEMBER_ID, () =>
      listTalkChannelLinks(talkId),
    );
    expect(links).toHaveLength(1);
    const bindingCreators = await getDbPg()<Array<{ created_by: string }>>`
      select created_by_user_id::text as created_by
      from public.connector_bindings
      where talk_id = ${talkId}::uuid
        and connector_id = ${channel.id}::uuid
        and target is null
    `;
    expect(bindingCreators).toEqual([{ created_by: MEMBER_ID }]);

    const view = await withUserContext(MEMBER_ID, () =>
      getTalkConnectorsView({ workspaceId, talkId }),
    );
    expect(view.channels).toMatchObject([
      { id: channel.id, enabled: true, hasCredential: true, linked: true },
    ]);

    const listed = await withUserContext(OWNER_ID, () =>
      listWorkspaceChannels({ workspaceId }),
    );
    expect(listed).toMatchObject([{ id: channel.id, bound_talk_count: 1 }]);

    const secondTalkId = await createTalkInWorkspace({
      workspaceId,
      sortOrder: 1,
      createdBy: MEMBER_ID,
    });
    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId: secondTalkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      withUserContext(OWNER_ID, () => listWorkspaceChannels({ workspaceId })),
    ).resolves.toMatchObject([{ id: channel.id, bound_talk_count: 2 }]);

    await expect(
      withUserContext(MEMBER_ID, () =>
        unlinkTalkChannel({ talkId, channelId: channel.id }),
      ),
    ).resolves.toBe(true);
    expect(
      await withUserContext(MEMBER_ID, () => listTalkChannelLinks(talkId)),
    ).toEqual([]);
  });

  it('blocks guest talk creators from per-Talk connector bindings', async () => {
    const { workspaceId, talkId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, async () => {
      const row = await createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Guest denied channel',
        createdBy: OWNER_ID,
      });
      await setWorkspaceChannelCredential(
        row.id,
        { apiKey: 'xoxb' },
        OWNER_ID,
        {
          workspaceId,
        },
      );
      return row;
    });

    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(true);
    await getDbPg()`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${MEMBER_ID}::uuid
    `;

    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      withUserContext(MEMBER_ID, () =>
        unlinkTalkChannel({ talkId, channelId: channel.id }),
      ),
    ).resolves.toBe(false);
  });

  it('links Slack install-backed channels without a direct channel secret', async () => {
    const { workspaceId, talkId } = await createFixture();
    await upsertWorkspaceSlackInstall({
      workspaceId,
      teamId: 'T1',
      teamName: 'Team One',
      botUserId: 'U1',
      appId: 'A1',
      botToken: 'xoxb-team-one',
      scopes: ['channels:read'],
      installedBy: OWNER_ID,
    });
    const channel = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Slack delegated',
        authorized: true,
        config: {
          workspace_id: 'T1',
          channel_id: 'C1',
        },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      }),
    );
    expect(channel.has_credential).toBe(true);

    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkChannel({
          talkId,
          channelId: channel.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(true);

    const links = await withUserContext(MEMBER_ID, () =>
      listTalkChannelLinks(talkId),
    );
    expect(links).toMatchObject([{ channelId: channel.id }]);

    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceChannelCredential(channel.id, { workspaceId }),
      ),
    ).resolves.toEqual({ apiKey: 'xoxb-team-one' });

    await getDbPg()`
      delete from public.connectors
      where workspace_id = ${workspaceId}::uuid
        and service = 'slack'
        and config_json->>'compatSurface' = 'slack_install'
        and config_json->>'teamId' = 'T1'
    `;
    await expect(
      withUserContext(OWNER_ID, () =>
        getWorkspaceChannel(channel.id, { workspaceId }),
      ),
    ).resolves.toMatchObject({ has_credential: false });
  });

  it('updates channels and cascades deleted channel links', async () => {
    const { workspaceId, talkId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, async () => {
      const row = await createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Cascade',
        config: { workspace_id: 'T1', channel_id: 'C1' },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      });
      await setWorkspaceChannelCredential(
        row.id,
        { apiKey: 'xoxb' },
        OWNER_ID,
        {
          workspaceId,
        },
      );
      return row;
    });

    await withUserContext(MEMBER_ID, () =>
      linkTalkChannel({
        talkId,
        channelId: channel.id,
        ownerId: MEMBER_ID,
      }),
    );
    await expect(
      withUserContext(OWNER_ID, () =>
        updateWorkspaceChannel(
          channel.id,
          {
            displayName: 'Cascade renamed',
            config: { workspace_id: 'T1', channel_id: 'C2' },
            updatedBy: OWNER_ID,
            allowSlackChannelImport: true,
          },
          { workspaceId },
        ),
      ),
    ).resolves.toMatchObject({
      display_name: 'Cascade renamed',
      config_json: expect.objectContaining({ channel_id: 'C2' }),
    });
    await expect(
      withUserContext(OWNER_ID, () =>
        getWorkspaceChannel('00000000-0000-0000-0000-000000000000', {
          workspaceId,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      withUserContext(OWNER_ID, () =>
        deleteWorkspaceChannel(channel.id, { workspaceId }),
      ),
    ).resolves.toBe(true);
    await expect(
      withUserContext(MEMBER_ID, () => listTalkChannelLinks(talkId)),
    ).resolves.toEqual([]);
  });

  it('strips client-supplied Slack delegation without an authorized install', async () => {
    const { workspaceId } = await createFixture();
    const channel = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Injected',
        authorized: true,
        config: {
          workspace_id: 'T-missing',
          channel_id: 'C1',
          credentialSource: 'workspace_slack_install',
        },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      }),
    );

    expect(channel.has_credential).toBe(false);
    expect(channel.config_json.credentialSource).toBeUndefined();
  });

  it('keeps duplicate Slack channel creates idempotent without clobbering display config', async () => {
    const { workspaceId } = await createFixture();
    const first = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Original channel',
        config: {
          workspace_id: 'T1',
          channel_id: 'C1',
          channel_name: 'original',
        },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      }),
    );
    await upsertWorkspaceSlackInstall({
      workspaceId,
      teamId: 'T1',
      teamName: 'Team One',
      botUserId: 'U1',
      appId: 'A1',
      botToken: 'xoxb-team-one',
      scopes: ['channels:read'],
      installedBy: OWNER_ID,
    });

    const second = await withUserContext(OWNER_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Attempted rename',
        config: {
          workspace_id: 'T1',
          channel_id: 'C1',
          channel_name: 'renamed',
        },
        createdBy: OWNER_ID,
        allowSlackChannelImport: true,
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      display_name: 'Original channel',
      has_credential: true,
      config_json: expect.objectContaining({
        displayName: 'Original channel',
        channel_name: 'original',
        credentialSource: 'workspace_slack_install',
      }),
    });
  });

  it('maps Google Docs/Sheets compatibility rows to gdrive connectors', async () => {
    const { workspaceId, talkId } = await createFixture();
    const docs = await withUserContext(OWNER_ID, () =>
      createWorkspaceDataConnector({
        workspaceId,
        kind: 'google_docs',
        displayName: 'Docs',
        config: { folder_id: 'F1' },
        createdBy: OWNER_ID,
      }),
    );
    expect(docs).toMatchObject({
      kind: 'google_docs',
      display_name: 'Docs',
      has_credential: true,
    });
    await withUserContext(MEMBER_ID, () =>
      linkTalkDataConnector({
        talkId,
        dataConnectorId: docs.id,
        ownerId: MEMBER_ID,
      }),
    );
    const authorized = await withUserContext(OWNER_ID, () =>
      setWorkspaceDataConnectorCredential(
        docs.id,
        { apiKey: 'google-token' },
        OWNER_ID,
        { workspaceId },
      ),
    );
    expect(authorized?.has_credential).toBe(true);
    const sheets = await withUserContext(OWNER_ID, () =>
      createWorkspaceDataConnector({
        workspaceId,
        kind: 'google_sheets',
        displayName: 'Sheets',
        config: { folder_id: 'F2' },
        createdBy: OWNER_ID,
      }),
    );
    expect(sheets).toMatchObject({
      kind: 'google_sheets',
      display_name: 'Sheets',
    });
    const connectorRows = await getDbPg()<
      Array<{ id: string; service: string; surface: string }>
    >`
      select id, service, config_json->>'compatSurface' as surface
      from public.connectors
      where id in (${docs.id}::uuid, ${sheets.id}::uuid)
      order by config_json->>'dataConnectorKind' asc
    `;
    expect(connectorRows).toEqual([
      { id: docs.id, service: 'gdrive', surface: 'data_connector' },
      { id: sheets.id, service: 'gdrive', surface: 'data_connector' },
    ]);
    await expect(
      withUserContext(MEMBER_ID, () =>
        decryptWorkspaceDataConnectorCredential(docs.id, { workspaceId }),
      ),
    ).resolves.toEqual({ apiKey: 'google-token' });
    const foreignWorkspaceId = await ensureWorkspaceBootstrapForUser(OTHER_ID);
    await expect(
      decryptWorkspaceDataConnectorCredential(docs.id, {
        workspaceId: foreignWorkspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceChannelCredential(docs.id, { workspaceId }),
      ),
    ).resolves.toBeNull();

    const cleared = await withUserContext(OWNER_ID, () =>
      setWorkspaceDataConnectorCredential(docs.id, null, OWNER_ID, {
        workspaceId,
      }),
    );
    expect(cleared?.has_credential).toBe(true);
    await expect(
      withUserContext(OWNER_ID, () =>
        decryptWorkspaceDataConnectorCredential(docs.id, { workspaceId }),
      ),
    ).resolves.toBeNull();
    const view = await withUserContext(MEMBER_ID, () =>
      getTalkConnectorsView({ workspaceId, talkId }),
    );
    expect(view.dataConnectors).toMatchObject([
      {
        id: docs.id,
        kind: 'google_docs',
        enabled: true,
        hasCredential: true,
        linked: true,
      },
      {
        id: sheets.id,
        kind: 'google_sheets',
        enabled: true,
        hasCredential: true,
        linked: false,
      },
    ]);

    const secondTalkId = await createTalkInWorkspace({
      workspaceId,
      sortOrder: 1,
      createdBy: MEMBER_ID,
    });
    await expect(
      withUserContext(MEMBER_ID, () =>
        linkTalkDataConnector({
          talkId: secondTalkId,
          dataConnectorId: docs.id,
          ownerId: MEMBER_ID,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      withUserContext(OWNER_ID, () =>
        listWorkspaceDataConnectors({ workspaceId }),
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: docs.id, bound_talk_count: 2 }),
        expect.objectContaining({ id: sheets.id, bound_talk_count: 0 }),
      ]),
    );

    await expect(
      withUserContext(MEMBER_ID, () =>
        unlinkTalkDataConnector({ talkId, dataConnectorId: docs.id }),
      ),
    ).resolves.toBe(true);
    await expect(
      withUserContext(OWNER_ID, () =>
        updateWorkspaceDataConnector(
          sheets.id,
          { displayName: 'Sheets renamed', updatedBy: OWNER_ID },
          { workspaceId },
        ),
      ),
    ).resolves.toMatchObject({
      display_name: 'Sheets renamed',
      has_credential: true,
    });
    await expect(
      withUserContext(OWNER_ID, () =>
        getWorkspaceDataConnector('00000000-0000-0000-0000-000000000000', {
          workspaceId,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      withUserContext(OWNER_ID, () =>
        deleteWorkspaceDataConnector(sheets.id, { workspaceId }),
      ),
    ).resolves.toBe(true);

    await expect(
      withUserContext(OWNER_ID, () =>
        createWorkspaceDataConnector({
          workspaceId,
          kind: 'posthog',
          displayName: 'PostHog',
          createdBy: OWNER_ID,
        }),
      ),
    ).rejects.toThrow('Unsupported data connector kind');

    await expect(
      withUserContext(MEMBER_ID, () =>
        createWorkspaceDataConnector({
          workspaceId,
          kind: 'google_docs',
          displayName: 'Member Docs',
          createdBy: MEMBER_ID,
        }),
      ),
    ).rejects.toThrow();
  });
});
