import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { createWorkspaceChannel } from '../../db/connectors-accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { AuthContext } from '../types.js';
import {
  createWorkspaceChannelRoute,
  createWorkspaceDataConnectorRoute,
  deleteWorkspaceChannelRoute,
  deleteWorkspaceDataConnectorRoute,
  deleteTalkChannelLinkRoute,
  deleteTalkDataConnectorLinkRoute,
  getTalkConnectorsRoute,
  listWorkspaceChannelsRoute,
  listWorkspaceDataConnectorsRoute,
  setTalkChannelLinkRoute,
  setTalkDataConnectorLinkRoute,
  setWorkspaceChannelCredentialRoute,
  setWorkspaceDataConnectorCredentialRoute,
  updateWorkspaceChannelRoute,
  updateWorkspaceDataConnectorRoute,
} from './connectors.js';

const ADMIN_ID = '0c888899-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c888899-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_ID = '0c888899-cccc-cccc-cccc-cccccccccccc';

const AUTH_ADMIN: AuthContext = {
  sessionId: 'session-admin',
  userId: ADMIN_ID,
  role: 'owner',
  authType: 'bearer',
};
const AUTH_MEMBER: AuthContext = {
  sessionId: 'session-member',
  userId: MEMBER_ID,
  role: 'member',
  authType: 'bearer',
};
const AUTH_OTHER: AuthContext = {
  sessionId: 'session-other',
  userId: OTHER_ID,
  role: 'member',
  authType: 'bearer',
};

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
    where owner_id in (${ADMIN_ID}::uuid, ${MEMBER_ID}::uuid, ${OTHER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${ADMIN_ID}::uuid, ${MEMBER_ID}::uuid, ${OTHER_ID}::uuid)
  `;
}

async function createFixture(): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  await seedAuthUser(ADMIN_ID, 'connector-admin@clawtalk.local');
  await seedAuthUser(MEMBER_ID, 'connector-member@clawtalk.local');
  await seedAuthUser(OTHER_ID, 'connector-other@clawtalk.local');
  const workspaceId = await ensureWorkspaceBootstrapForUser(ADMIN_ID);
  const db = getDbPg();
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${MEMBER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  const talkRows = await db<Array<{ id: string }>>`
    insert into public.talks (workspace_id, sort_order, title, created_by)
    values (${workspaceId}::uuid, 0, 'Connector Test Talk', ${MEMBER_ID}::uuid)
    returning id
  `;
  return { workspaceId, talkId: talkRows[0]!.id };
}

describe('greenfield connector compatibility routes', () => {
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

  it('stores workspace channels in final connectors and gates admin writes', async () => {
    await createFixture();

    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Eng',
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('expected ok');
    expect(created.body.data.channel).toMatchObject({
      kind: 'slack',
      displayName: 'Eng',
      enabled: true,
      hasCredential: false,
    });
    expect(created.body.data.channel.config).toEqual({});

    const memberCreate = await createWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      body: { kind: 'slack', displayName: 'Nope' },
    });
    expect(memberCreate.statusCode).toBe(403);
    if (memberCreate.body.ok) throw new Error('expected error');
    expect(memberCreate.body.error.code).toBe('forbidden');

    const listed = await listWorkspaceChannelsRoute(AUTH_MEMBER);
    expect(listed.statusCode).toBe(200);
    if (!listed.body.ok) throw new Error('expected ok');
    expect(
      listed.body.data.channels.map((channel) => channel.displayName),
    ).toEqual(['Eng']);
    expect(listed.body.data.channels[0]?.config).toEqual({});

    const rows = await getDbPg()<Array<{ service: string; surface: string }>>`
      select service, config_json->>'compatSurface' as surface
      from public.connectors
      where id = ${created.body.data.channel.id}::uuid
    `;
    expect(rows[0]).toEqual({ service: 'slack', surface: 'channel' });
  });

  it('redacts non-public connector config keys from workspace lists', async () => {
    const { workspaceId } = await createFixture();
    await getDbPg()`
      insert into public.connectors (
        workspace_id,
        service,
        authorized,
        config_json
      )
      values (
        ${workspaceId}::uuid,
        'slack',
        false,
        jsonb_build_object(
          'compatSurface', 'channel',
          'kind', 'slack',
          'displayName', 'Raw Slack',
          'workspace_id', 'T01',
          'channel_id', 'C1',
          'apiKey', 'xoxb-leaked',
          'credentialSource', 'workspace_slack_install'
        )
      ),
      (
        ${workspaceId}::uuid,
        'gdrive',
        false,
        jsonb_build_object(
          'compatSurface', 'data_connector',
          'dataConnectorKind', 'google_docs',
          'displayName', 'Raw Docs',
          'folder_id', 'F1',
          'refresh_token', 'google-leaked'
        )
      )
    `;

    const channels = await listWorkspaceChannelsRoute(AUTH_MEMBER);
    expect(channels.statusCode).toBe(200);
    if (!channels.body.ok) throw new Error('expected ok');
    expect(channels.body.data.channels[0]?.config).toEqual({
      workspace_id: 'T01',
      channel_id: 'C1',
    });

    const dataConnectors = await listWorkspaceDataConnectorsRoute(AUTH_MEMBER);
    expect(dataConnectors.statusCode).toBe(200);
    if (!dataConnectors.body.ok) throw new Error('expected ok');
    expect(dataConnectors.body.data.dataConnectors[0]?.config).toEqual({
      folder_id: 'F1',
    });
  });

  it('validates privileged connector create bodies after admin authorization', async () => {
    await createFixture();

    const badKind = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'telegram', displayName: 'Telegram' },
    });
    expect(badKind.statusCode).toBe(400);
    if (badKind.body.ok) throw new Error('expected error');
    expect(badKind.body.error.code).toBe('invalid_kind');

    const badDisplayName = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: '   ' },
    });
    expect(badDisplayName.statusCode).toBe(400);
    if (badDisplayName.body.ok) throw new Error('expected error');
    expect(badDisplayName.body.error.code).toBe('display_name_required');

    const badConfig = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Bad config',
        config: { workspace_id: 1234 },
      },
    });
    expect(badConfig.statusCode).toBe(400);
    if (badConfig.body.ok) throw new Error('expected error');
    expect(badConfig.body.error.code).toBe('invalid_config');

    const secretChannelConfig = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Secret config',
        config: { apiKey: 'xoxb-should-not-store' },
      },
    });
    expect(secretChannelConfig.statusCode).toBe(400);
    if (secretChannelConfig.body.ok) throw new Error('expected error');
    expect(secretChannelConfig.body.error.code).toBe('invalid_config');

    const secretDataConfig = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'google_docs',
        displayName: 'Secret data config',
        config: { folder_id: 'F1', token: 'google-should-not-store' },
      },
    });
    expect(secretDataConfig.statusCode).toBe(400);
    if (secretDataConfig.body.ok) throw new Error('expected error');
    expect(secretDataConfig.body.error.code).toBe('invalid_config');

    const unvalidatedSlackTarget = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Unvalidated Slack target',
        config: { workspace_id: 'T01', channel_id: 'C1' },
      },
    });
    expect(unvalidatedSlackTarget.statusCode).toBe(400);
    if (unvalidatedSlackTarget.body.ok) throw new Error('expected error');
    expect(unvalidatedSlackTarget.body.error.code).toBe('invalid_config');

    const memberBadKind = await createWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      body: { kind: 'telegram', displayName: 'Nope' },
    });
    expect(memberBadKind.statusCode).toBe(403);
    if (memberBadKind.body.ok) throw new Error('expected error');
    expect(memberBadKind.body.error.code).toBe('forbidden');
  });

  it('rejects non-admin workspace connector writes', async () => {
    await createFixture();
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Admin only channel' },
    });
    const dataConnector = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'google_docs', displayName: 'Admin only docs' },
    });
    if (!channel.body.ok || !dataConnector.body.ok) {
      throw new Error('seed failed');
    }

    const memberChannelCredential = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_MEMBER,
      channelId: channel.body.data.channel.id,
      body: { apiKey: 'xoxb-member' },
    });
    expect(memberChannelCredential.statusCode).toBe(403);
    if (memberChannelCredential.body.ok) throw new Error('expected error');
    expect(memberChannelCredential.body.error.code).toBe('forbidden');

    const memberChannelUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      channelId: channel.body.data.channel.id,
      body: { displayName: 'Hacked' },
    });
    expect(memberChannelUpdate.statusCode).toBe(403);
    if (memberChannelUpdate.body.ok) throw new Error('expected error');
    expect(memberChannelUpdate.body.error.code).toBe('forbidden');

    const memberCreateData = await createWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      body: { kind: 'google_docs', displayName: 'Nope' },
    });
    expect(memberCreateData.statusCode).toBe(403);
    if (memberCreateData.body.ok) throw new Error('expected error');
    expect(memberCreateData.body.error.code).toBe('forbidden');

    const memberDataCredential = await setWorkspaceDataConnectorCredentialRoute(
      {
        auth: AUTH_MEMBER,
        connectorId: dataConnector.body.data.dataConnector.id,
        body: { apiKey: 'google-member' },
      },
    );
    expect(memberDataCredential.statusCode).toBe(403);
    if (memberDataCredential.body.ok) throw new Error('expected error');
    expect(memberDataCredential.body.error.code).toBe('forbidden');

    const memberDataUpdate = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      connectorId: dataConnector.body.data.dataConnector.id,
      body: { displayName: 'Hacked' },
    });
    expect(memberDataUpdate.statusCode).toBe(403);
    if (memberDataUpdate.body.ok) throw new Error('expected error');
    expect(memberDataUpdate.body.error.code).toBe('forbidden');

    const memberChannelDelete = await deleteWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      channelId: channel.body.data.channel.id,
    });
    expect(memberChannelDelete.statusCode).toBe(403);
    if (memberChannelDelete.body.ok) throw new Error('expected error');
    expect(memberChannelDelete.body.error.code).toBe('forbidden');

    const memberDataDelete = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      connectorId: dataConnector.body.data.dataConnector.id,
    });
    expect(memberDataDelete.statusCode).toBe(403);
    if (memberDataDelete.body.ok) throw new Error('expected error');
    expect(memberDataDelete.body.error.code).toBe('forbidden');
  });

  it('returns stable 400s for malformed connector route UUID params', async () => {
    const { talkId } = await createFixture();

    const badTalk = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId: 'not-a-uuid',
    });
    expect(badTalk.statusCode).toBe(400);
    if (badTalk.body.ok) throw new Error('expected error');
    expect(badTalk.body.error.code).toBe('invalid_talk_id');

    const badChannelUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: 'not-a-uuid',
      body: { displayName: 'No cast error' },
    });
    expect(badChannelUpdate.statusCode).toBe(400);
    if (badChannelUpdate.body.ok) throw new Error('expected error');
    expect(badChannelUpdate.body.error.code).toBe('invalid_channel_id');

    const badChannelCredential = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: 'not-a-uuid',
      body: { apiKey: 'xoxb-test' },
    });
    expect(badChannelCredential.statusCode).toBe(400);

    const badChannelDelete = await deleteWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: 'not-a-uuid',
    });
    expect(badChannelDelete.statusCode).toBe(400);

    const badChannelLink = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: 'not-a-uuid',
    });
    expect(badChannelLink.statusCode).toBe(400);

    const badChannelUnlink = await deleteTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: 'not-a-uuid',
    });
    expect(badChannelUnlink.statusCode).toBe(400);

    const badDataUpdate = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: 'not-a-uuid',
      body: { displayName: 'No cast error' },
    });
    expect(badDataUpdate.statusCode).toBe(400);
    if (badDataUpdate.body.ok) throw new Error('expected error');
    expect(badDataUpdate.body.error.code).toBe('invalid_connector_id');

    const badDataCredential = await setWorkspaceDataConnectorCredentialRoute({
      auth: AUTH_ADMIN,
      connectorId: 'not-a-uuid',
      body: { apiKey: 'google-token' },
    });
    expect(badDataCredential.statusCode).toBe(400);

    const badDataDelete = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: 'not-a-uuid',
    });
    expect(badDataDelete.statusCode).toBe(400);

    const badDataLink = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: 'not-a-uuid',
    });
    expect(badDataLink.statusCode).toBe(400);

    const badDataUnlink = await deleteTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: 'not-a-uuid',
    });
    expect(badDataUnlink.statusCode).toBe(400);

    const badWorkspace = await listWorkspaceChannelsRoute(
      AUTH_ADMIN,
      'not-a-uuid',
    );
    expect(badWorkspace.statusCode).toBe(400);
    if (badWorkspace.body.ok) throw new Error('expected error');
    expect(badWorkspace.body.error.code).toBe('invalid_workspace_id');
  });

  it('updates workspace connectors through final connectors and validates patches', async () => {
    await createFixture();
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Original channel' },
    });
    const dataConnector = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'google_docs', displayName: 'Original docs' },
    });
    if (!channel.body.ok || !dataConnector.body.ok) {
      throw new Error('seed failed');
    }

    const channelUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: channel.body.data.channel.id,
      body: {
        displayName: 'Updated channel',
        enabled: false,
      },
    });
    expect(channelUpdate.statusCode).toBe(200);
    if (!channelUpdate.body.ok) throw new Error('expected ok');
    expect(channelUpdate.body.data.channel).toMatchObject({
      displayName: 'Updated channel',
      enabled: false,
      config: {},
    });

    const dataUpdate = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: dataConnector.body.data.dataConnector.id,
      body: {
        displayName: 'Updated docs',
        enabled: false,
        config: { folder_id: 'F2' },
      },
    });
    expect(dataUpdate.statusCode).toBe(200);
    if (!dataUpdate.body.ok) throw new Error('expected ok');
    expect(dataUpdate.body.data.dataConnector).toMatchObject({
      displayName: 'Updated docs',
      enabled: false,
      config: { folder_id: 'F2' },
    });
    expect(dataUpdate.body.data.dataConnector.config).toEqual({
      folder_id: 'F2',
    });

    const badEnabled = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: channel.body.data.channel.id,
      body: { enabled: 'false' },
    });
    expect(badEnabled.statusCode).toBe(400);
    if (badEnabled.body.ok) throw new Error('expected error');
    expect(badEnabled.body.error.code).toBe('invalid_enabled');

    const badChannelConfig = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: channel.body.data.channel.id,
      body: { config: { channel_id: 1234 } },
    });
    expect(badChannelConfig.statusCode).toBe(400);
    if (badChannelConfig.body.ok) throw new Error('expected error');
    expect(badChannelConfig.body.error.code).toBe('invalid_config');

    const badDataConfig = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: dataConnector.body.data.dataConnector.id,
      body: { config: { folder_id: 1234 } },
    });
    expect(badDataConfig.statusCode).toBe(400);
    if (badDataConfig.body.ok) throw new Error('expected error');
    expect(badDataConfig.body.error.code).toBe('invalid_config');
  });

  it('preserves Slack install delegation across public config round trips', async () => {
    const { workspaceId, talkId } = await createFixture();
    const db = getDbPg();
    await db`
      with secret as (
        insert into public.connector_secrets (workspace_id, ciphertext)
        values (${workspaceId}::uuid, 'route-test-slack-install-token')
        returning id
      )
      insert into public.connectors (
        workspace_id,
        service,
        authorized,
        authorized_at,
        secret_ref,
        config_json
      )
      select
        ${workspaceId}::uuid,
        'slack',
        true,
        now(),
        secret.id,
        jsonb_build_object(
          'compatSurface', 'slack_install',
          'teamId', 'T01',
          'teamName', 'Team One'
        )
      from secret
    `;
    const created = await withUserContext(ADMIN_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Delegated',
        config: {
          workspace_id: 'T01',
          channel_id: 'C1',
          channel_name: 'general',
          credentialSource: 'workspace_slack_install',
        },
        createdBy: ADMIN_ID,
        allowSlackChannelImport: true,
      }),
    );
    await db`
      update public.connectors
      set authorized = true,
          authorized_at = now()
      where id = ${created.id}::uuid
    `;

    const listed = await listWorkspaceChannelsRoute(AUTH_MEMBER);
    expect(listed.statusCode).toBe(200);
    if (!listed.body.ok) throw new Error('expected ok');
    const publicConfig = listed.body.data.channels[0]?.config;
    expect(publicConfig).toEqual({
      workspace_id: 'T01',
      channel_id: 'C1',
      channel_name: 'general',
    });

    const updated = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: created.id,
      body: { displayName: 'Delegated renamed' },
    });
    expect(updated.statusCode).toBe(200);
    if (!updated.body.ok) throw new Error('expected ok');
    expect(updated.body.data.channel.hasCredential).toBe(true);
    expect(updated.body.data.channel.config).toEqual(publicConfig);

    const linked = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: created.id,
    });
    expect(linked.statusCode).toBe(200);

    const raw = await db<Array<{ credential_source: string | null }>>`
      select config_json->>'credentialSource' as credential_source
      from public.connectors
      where id = ${created.id}::uuid
    `;
    expect(raw[0]?.credential_source).toBe('workspace_slack_install');
  });

  it('rejects Slack channel target updates through generic channel routes', async () => {
    const { workspaceId } = await createFixture();
    const imported = await withUserContext(ADMIN_ID, () =>
      createWorkspaceChannel({
        workspaceId,
        kind: 'slack',
        displayName: 'Imported Slack channel',
        config: { workspace_id: 'T01', channel_id: 'C1' },
        createdBy: ADMIN_ID,
        allowSlackChannelImport: true,
      }),
    );

    const rejected = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: imported.id,
      body: { config: { workspace_id: 'T01', channel_id: 'C2' } },
    });
    expect(rejected.statusCode).toBe(400);
    if (rejected.body.ok) throw new Error('expected error');
    expect(rejected.body.error.code).toBe('invalid_config');

    const renamed = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: imported.id,
      body: { displayName: 'Imported renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    if (!renamed.body.ok) throw new Error('expected ok');
    expect(renamed.body.data.channel.config).toEqual({
      workspace_id: 'T01',
      channel_id: 'C1',
    });
  });

  it('scopes trusted workspace mutations to the approved admin workspace', async () => {
    await createFixture();
    const otherWorkspaceId = await ensureWorkspaceBootstrapForUser(OTHER_ID);
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${otherWorkspaceId}::uuid, ${ADMIN_ID}::uuid, 'member')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    const foreignChannel = await createWorkspaceChannelRoute({
      auth: AUTH_OTHER,
      body: { kind: 'slack', displayName: 'Other workspace channel' },
    });
    const foreignDataConnector = await createWorkspaceDataConnectorRoute({
      auth: AUTH_OTHER,
      body: { kind: 'google_docs', displayName: 'Other workspace docs' },
    });
    if (!foreignChannel.body.ok || !foreignDataConnector.body.ok) {
      throw new Error('seed failed');
    }

    const channelCredential = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: foreignChannel.body.data.channel.id,
      body: { apiKey: 'xoxb-hijack' },
    });
    expect(channelCredential.statusCode).toBe(404);

    const dataCredential = await setWorkspaceDataConnectorCredentialRoute({
      auth: AUTH_ADMIN,
      connectorId: foreignDataConnector.body.data.dataConnector.id,
      body: { apiKey: 'google-hijack' },
    });
    expect(dataCredential.statusCode).toBe(404);

    const channelUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: foreignChannel.body.data.channel.id,
      body: { displayName: 'Hijacked' },
    });
    expect(channelUpdate.statusCode).toBe(404);

    const dataUpdate = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: foreignDataConnector.body.data.dataConnector.id,
      body: { displayName: 'Hijacked' },
    });
    expect(dataUpdate.statusCode).toBe(404);

    const channelDelete = await deleteWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: foreignChannel.body.data.channel.id,
    });
    expect(channelDelete.statusCode).toBe(404);

    const dataDelete = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      connectorId: foreignDataConnector.body.data.dataConnector.id,
    });
    expect(dataDelete.statusCode).toBe(404);

    const rows = await db<Array<{ authorized: boolean; count: number }>>`
      select bool_or(authorized) as authorized, count(*)::int as count
      from public.connectors
      where id in (
        ${foreignChannel.body.data.channel.id}::uuid,
        ${foreignDataConnector.body.data.dataConnector.id}::uuid
      )
    `;
    expect(rows[0]).toEqual({ authorized: false, count: 2 });
  });

  it('honors requested workspace id on workspace connector routes', async () => {
    const { workspaceId } = await createFixture();
    const otherWorkspaceId = await ensureWorkspaceBootstrapForUser(OTHER_ID);
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${otherWorkspaceId}::uuid, ${ADMIN_ID}::uuid, 'admin')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    const defaultChannel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: workspaceId,
      body: { kind: 'slack', displayName: 'Default workspace channel' },
    });
    const otherChannel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      body: { kind: 'slack', displayName: 'Requested workspace channel' },
    });
    const otherDataConnector = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      body: { kind: 'google_docs', displayName: 'Requested workspace docs' },
    });
    if (!defaultChannel.body.ok || !otherChannel.body.ok) {
      throw new Error('channel seed failed');
    }
    if (!otherDataConnector.body.ok) throw new Error('data seed failed');

    const defaultList = await listWorkspaceChannelsRoute(
      AUTH_ADMIN,
      workspaceId,
    );
    const otherChannelList = await listWorkspaceChannelsRoute(
      AUTH_ADMIN,
      otherWorkspaceId,
    );
    const otherDataList = await listWorkspaceDataConnectorsRoute(
      AUTH_ADMIN,
      otherWorkspaceId,
    );
    if (
      !defaultList.body.ok ||
      !otherChannelList.body.ok ||
      !otherDataList.body.ok
    ) {
      throw new Error('expected ok');
    }
    expect(
      defaultList.body.data.channels.map((channel) => channel.displayName),
    ).toEqual(['Default workspace channel']);
    expect(
      otherChannelList.body.data.channels.map((channel) => channel.displayName),
    ).toEqual(['Requested workspace channel']);
    expect(
      otherDataList.body.data.dataConnectors.map(
        (connector) => connector.displayName,
      ),
    ).toEqual(['Requested workspace docs']);

    const wrongWorkspaceUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: workspaceId,
      channelId: otherChannel.body.data.channel.id,
      body: { displayName: 'Wrong workspace' },
    });
    expect(wrongWorkspaceUpdate.statusCode).toBe(404);

    const otherChannelUpdate = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      channelId: otherChannel.body.data.channel.id,
      body: { displayName: 'Updated requested channel' },
    });
    expect(otherChannelUpdate.statusCode).toBe(200);
    if (!otherChannelUpdate.body.ok) throw new Error('expected ok');
    expect(otherChannelUpdate.body.data.channel.displayName).toBe(
      'Updated requested channel',
    );

    const otherChannelCredential = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      channelId: otherChannel.body.data.channel.id,
      body: { apiKey: 'xoxb-requested' },
    });
    expect(otherChannelCredential.statusCode).toBe(200);
    if (!otherChannelCredential.body.ok) throw new Error('expected ok');
    expect(otherChannelCredential.body.data.channel.hasCredential).toBe(true);

    const otherDataCredential = await setWorkspaceDataConnectorCredentialRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      connectorId: otherDataConnector.body.data.dataConnector.id,
      body: { apiKey: 'google-requested' },
    });
    expect(otherDataCredential.statusCode).toBe(200);
    if (!otherDataCredential.body.ok) throw new Error('expected ok');
    expect(otherDataCredential.body.data.dataConnector.hasCredential).toBe(
      true,
    );

    const wrongWorkspaceDelete = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: workspaceId,
      connectorId: otherDataConnector.body.data.dataConnector.id,
    });
    expect(wrongWorkspaceDelete.statusCode).toBe(404);

    const deletedDataConnector = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      connectorId: otherDataConnector.body.data.dataConnector.id,
    });
    expect(deletedDataConnector.statusCode).toBe(200);

    const deletedChannel = await deleteWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      requestedWorkspaceId: otherWorkspaceId,
      channelId: otherChannel.body.data.channel.id,
    });
    expect(deletedChannel.statusCode).toBe(200);

    const deletedRows = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.connectors
      where id in (
        ${otherDataConnector.body.data.dataConnector.id}::uuid,
        ${otherChannel.body.data.channel.id}::uuid
      )
    `;
    expect(deletedRows[0]?.count).toBe(0);

    const memberOtherList = await listWorkspaceChannelsRoute(
      AUTH_MEMBER,
      otherWorkspaceId,
    );
    expect(memberOtherList.statusCode).toBe(404);
    if (memberOtherList.body.ok) throw new Error('expected error');
    expect(memberOtherList.body.error.code).toBe('workspace_not_found');
  });

  it('sets and clears connector credentials through connector_secrets', async () => {
    await createFixture();
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Credentialed' },
    });
    if (!created.body.ok) throw new Error('seed failed');

    const set = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: created.body.data.channel.id,
      body: { apiKey: 'xoxb-test' },
    });
    expect(set.statusCode).toBe(200);
    if (!set.body.ok) throw new Error('expected ok');
    expect(set.body.data.channel.hasCredential).toBe(true);

    const cleared = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: created.body.data.channel.id,
      body: { apiKey: '' },
    });
    expect(cleared.statusCode).toBe(200);
    if (!cleared.body.ok) throw new Error('expected ok');
    expect(cleared.body.data.channel.hasCredential).toBe(false);
  });

  it('binds authorized channels to Talks via connector_bindings', async () => {
    const { talkId } = await createFixture();
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Bindable' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const channelId = created.body.data.channel.id;

    const unauthorized = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId,
    });
    expect(unauthorized.statusCode).toBe(409);
    if (unauthorized.body.ok) throw new Error('expected error');
    expect(unauthorized.body.error.code).toBe('connector_not_authorized');

    const missingChannel = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missingChannel.statusCode).toBe(404);
    if (missingChannel.body.ok) throw new Error('expected error');
    expect(missingChannel.body.error.code).toBe('not_found');

    await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId,
      body: { apiKey: 'xoxb-test' },
    });
    const first = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId,
    });
    const second = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const view = await getTalkConnectorsRoute({ auth: AUTH_MEMBER, talkId });
    expect(view.statusCode).toBe(200);
    if (!view.body.ok) throw new Error('expected ok');
    expect(view.body.data.channels).toMatchObject([
      { id: channelId, enabled: true, hasCredential: true, linked: true },
    ]);

    const bindingRows = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.connector_bindings
      where talk_id = ${talkId}::uuid
        and connector_id = ${channelId}::uuid
        and target is null
    `;
    expect(bindingRows[0]?.count).toBe(1);

    const deleted = await deleteTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId,
    });
    expect(deleted.statusCode).toBe(200);

    const afterDelete = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId,
    });
    expect(afterDelete.statusCode).toBe(200);
    if (!afterDelete.body.ok) throw new Error('expected ok');
    expect(afterDelete.body.data.channels).toMatchObject([
      { id: channelId, enabled: true, hasCredential: true, linked: false },
    ]);
    const rowsAfterDelete = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.connector_bindings
      where talk_id = ${talkId}::uuid
        and connector_id = ${channelId}::uuid
        and target is null
    `;
    expect(rowsAfterDelete[0]?.count).toBe(0);
  });

  it('blocks guest talk creators from changing Talk connector links', async () => {
    const { workspaceId, talkId } = await createFixture();
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Guest denied' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: channel.body.data.channel.id,
      body: { apiKey: 'xoxb-test' },
    });
    await getDbPg()`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${MEMBER_ID}::uuid
    `;

    const linked = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: channel.body.data.channel.id,
    });
    expect(linked.statusCode).toBe(403);
    if (linked.body.ok) throw new Error('expected error');
    expect(linked.body.error.code).toBe('forbidden');

    const unlinked = await deleteTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      channelId: channel.body.data.channel.id,
    });
    expect(unlinked.statusCode).toBe(403);
    if (unlinked.body.ok) throw new Error('expected error');
    expect(unlinked.body.error.code).toBe('forbidden');
  });

  it('blocks binding attempts from non-members of the Talk workspace', async () => {
    const { talkId } = await createFixture();
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Private' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: channel.body.data.channel.id,
      body: { apiKey: 'xoxb-test' },
    });

    const denied = await setTalkChannelLinkRoute({
      auth: AUTH_OTHER,
      talkId,
      channelId: channel.body.data.channel.id,
    });
    expect([403, 404]).toContain(denied.statusCode);

    const bindingRows = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.connector_bindings
      where talk_id = ${talkId}::uuid
        and connector_id = ${channel.body.data.channel.id}::uuid
    `;
    expect(bindingRows[0]?.count).toBe(0);

    const view = await getTalkConnectorsRoute({ auth: AUTH_OTHER, talkId });
    expect(view.statusCode).toBe(404);
  });

  it('supports Google Drive data connector compatibility and rejects retired kinds', async () => {
    const { talkId } = await createFixture();
    const invalid = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'Retired' },
    });
    expect(invalid.statusCode).toBe(400);
    if (invalid.body.ok) throw new Error('expected error');
    expect(invalid.body.error.code).toBe('invalid_kind');

    const created = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'google_docs',
        displayName: 'Docs',
        config: { folder_id: 'F1' },
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('expected ok');
    expect(created.body.data.dataConnector.hasCredential).toBe(true);

    const linked = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: created.body.data.dataConnector.id,
    });
    const linkedAgain = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: created.body.data.dataConnector.id,
    });
    expect(linked.statusCode).toBe(200);
    expect(linkedAgain.statusCode).toBe(200);

    const missing = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
    if (missing.body.ok) throw new Error('expected error');
    expect(missing.body.error.code).toBe('not_found');

    const view = await getTalkConnectorsRoute({ auth: AUTH_MEMBER, talkId });
    if (!view.body.ok) throw new Error('expected ok');
    expect(view.body.data.dataConnectors).toMatchObject([
      {
        kind: 'google_docs',
        enabled: true,
        hasCredential: true,
        linked: true,
      },
    ]);

    const deleted = await deleteTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId,
      connectorId: created.body.data.dataConnector.id,
    });
    expect(deleted.statusCode).toBe(200);

    const afterDelete = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId,
    });
    if (!afterDelete.body.ok) throw new Error('expected ok');
    expect(afterDelete.body.data.dataConnectors).toMatchObject([
      { kind: 'google_docs', linked: false },
    ]);
  });
});
