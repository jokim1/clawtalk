// Connectors refactor PR 1 — route-handler tests.
//
// Covers admin-gating, talk-ownership gating, validation, and the
// combined GET /talks/:talkId/connectors view. Mirrors the
// talk-resources.test.ts pattern: direct handler invocations against
// a live local supabase stack.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { listWorkspaceChannels } from '../../db/connectors-accessors.js';
import type { AuthContext } from '../types.js';

import {
  createWorkspaceChannelRoute,
  createWorkspaceDataConnectorRoute,
  deleteTalkChannelLinkRoute,
  deleteTalkDataConnectorLinkRoute,
  deleteWorkspaceChannelRoute,
  deleteWorkspaceDataConnectorRoute,
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

// Unique 6-digit prefix per the test-helpers harness convention.
const ADMIN_ID = '0c888899-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = '0c888899-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_MEMBER_ID = '0c888899-cccc-cccc-cccc-cccccccccccc';
const TALK_MEMBER_ID = '0c888899-dddd-dddd-dddd-dddddddddd01';
const TALK_OTHER_ID = '0c888899-dddd-dddd-dddd-dddddddddd02';

const AUTH_ADMIN: AuthContext = {
  sessionId: 'session-admin',
  userId: ADMIN_ID,
  role: 'admin',
  authType: 'cookie',
};

const AUTH_MEMBER: AuthContext = {
  sessionId: 'session-member',
  userId: MEMBER_ID,
  role: 'member',
  authType: 'cookie',
};

const AUTH_OTHER_MEMBER: AuthContext = {
  sessionId: 'session-other',
  userId: OTHER_MEMBER_ID,
  role: 'member',
  authType: 'cookie',
};

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
  if (input.role !== 'member') {
    await db`
      update public.users set role = ${input.role}
      where id = ${input.id}::uuid
    `;
  }
}

async function seedTalk(input: {
  talkId: string;
  ownerId: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${input.talkId}::uuid, ${input.ownerId}::uuid,
            'Connectors route test')
    on conflict (id) do nothing
  `;
}

async function purgeData(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.workspace_channels`;
  await db`delete from public.workspace_data_connectors`;
  // Talks survive across tests; talk_*_links cascade.
}

beforeAll(async () => {
  await initPgDatabase();
  await seedUser({
    id: ADMIN_ID,
    email: 'route-admin@clawtalk.local',
    role: 'admin',
  });
  await seedUser({
    id: MEMBER_ID,
    email: 'route-member@clawtalk.local',
    role: 'member',
  });
  await seedUser({
    id: OTHER_MEMBER_ID,
    email: 'route-other@clawtalk.local',
    role: 'member',
  });
  await seedTalk({ talkId: TALK_MEMBER_ID, ownerId: MEMBER_ID });
  await seedTalk({ talkId: TALK_OTHER_ID, ownerId: OTHER_MEMBER_ID });
});

afterAll(async () => {
  const db = getDbPg();
  await db`
    delete from public.talks
    where id in (${TALK_MEMBER_ID}::uuid, ${TALK_OTHER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${ADMIN_ID}::uuid, ${MEMBER_ID}::uuid,
                 ${OTHER_MEMBER_ID}::uuid)
  `;
  await closePgDatabase();
});

beforeEach(async () => {
  await purgeData();
});

// ---------------------------------------------------------------------------
// Workspace channels — admin gate + validation
// ---------------------------------------------------------------------------

describe('workspace channels routes', () => {
  it('createWorkspaceChannelRoute as admin returns 201', async () => {
    const res = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Eng',
        config: { workspace_id: 'W1', channel_id: 'C1' },
      },
    });
    expect(res.statusCode).toBe(201);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.channel.kind).toBe('slack');
    expect(res.body.data.channel.displayName).toBe('Eng');
    expect(res.body.data.channel.boundTalkCount).toBe(0);
  });

  it('createWorkspaceChannelRoute as member returns 403', async () => {
    const res = await createWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      body: { kind: 'slack', displayName: 'No' },
    });
    expect(res.statusCode).toBe(403);
    if (res.body.ok) throw new Error('expected error');
    expect(res.body.error.code).toBe('forbidden');
  });

  it('createWorkspaceChannelRoute rejects invalid kind with 400', async () => {
    const res = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'whatsapp', displayName: 'Future' },
    });
    expect(res.statusCode).toBe(400);
    if (res.body.ok) throw new Error('expected error');
    expect(res.body.error.code).toBe('invalid_kind');
  });

  it('createWorkspaceChannelRoute rejects empty displayName with 400', async () => {
    const res = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: '   ' },
    });
    expect(res.statusCode).toBe(400);
    if (res.body.ok) throw new Error('expected error');
    expect(res.body.error.code).toBe('display_name_required');
  });

  it('createWorkspaceChannelRoute surfaces Zod issues as 400 invalid_config', async () => {
    const res = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'slack',
        displayName: 'Bad config',
        config: { workspace_id: 1234 },
      },
    });
    expect(res.statusCode).toBe(400);
    if (res.body.ok) throw new Error('expected error');
    expect(res.body.error.code).toBe('invalid_config');
  });

  it('listWorkspaceChannelsRoute as member returns the pool', async () => {
    await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Listed' },
    });
    const res = await listWorkspaceChannelsRoute(AUTH_MEMBER);
    expect(res.statusCode).toBe(200);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.channels.map((c) => c.displayName)).toContain(
      'Listed',
    );
  });

  it('updateWorkspaceChannelRoute as member returns 403', async () => {
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Protected' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const id = created.body.data.channel.id;

    const res = await updateWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      channelId: id,
      body: { displayName: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('updateWorkspaceChannelRoute returns 404 for unknown id', async () => {
    const res = await updateWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: '00000000-0000-0000-0000-000000000000',
      body: { displayName: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deleteWorkspaceChannelRoute as admin removes the row', async () => {
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Will delete' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const id = created.body.data.channel.id;

    const res = await deleteWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      channelId: id,
    });
    expect(res.statusCode).toBe(200);
    const after = await withUserContext(ADMIN_ID, () =>
      listWorkspaceChannels(),
    );
    expect(after.find((c) => c.id === id)).toBeUndefined();
  });

  it('deleteWorkspaceChannelRoute as member returns 403', async () => {
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Protected delete' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const res = await deleteWorkspaceChannelRoute({
      auth: AUTH_MEMBER,
      channelId: created.body.data.channel.id,
    });
    expect(res.statusCode).toBe(403);
  });

  it('setWorkspaceChannelCredentialRoute as admin sets/clears credential', async () => {
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Credential test' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const id = created.body.data.channel.id;

    const set = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: id,
      body: { apiKey: 'xoxb-token-99' },
    });
    expect(set.statusCode).toBe(200);
    if (!set.body.ok) throw new Error('expected ok');
    expect(set.body.data.channel.hasCredential).toBe(true);

    const cleared = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_ADMIN,
      channelId: id,
      body: { apiKey: '' },
    });
    expect(cleared.statusCode).toBe(200);
    if (!cleared.body.ok) throw new Error('expected ok');
    expect(cleared.body.data.channel.hasCredential).toBe(false);
  });

  it('setWorkspaceChannelCredentialRoute as member returns 403', async () => {
    const created = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Cred gate' },
    });
    if (!created.body.ok) throw new Error('seed failed');

    const res = await setWorkspaceChannelCredentialRoute({
      auth: AUTH_MEMBER,
      channelId: created.body.data.channel.id,
      body: { apiKey: 'xoxb-leak' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Workspace data connectors — parallel surface
// ---------------------------------------------------------------------------

describe('workspace data connectors routes', () => {
  it('createWorkspaceDataConnectorRoute as admin returns 201', async () => {
    const res = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'posthog',
        displayName: 'Prod PostHog',
        config: { project_id: '250736', host: 'https://app.posthog.com' },
      },
    });
    expect(res.statusCode).toBe(201);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.dataConnector.kind).toBe('posthog');
  });

  it('createWorkspaceDataConnectorRoute as member returns 403', async () => {
    const res = await createWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      body: { kind: 'posthog', displayName: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('createWorkspaceDataConnectorRoute rejects invalid host with 400 invalid_config', async () => {
    const res = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: {
        kind: 'posthog',
        displayName: 'Bad host',
        config: { host: 'not-a-url' },
      },
    });
    expect(res.statusCode).toBe(400);
    if (res.body.ok) throw new Error('expected error');
    expect(res.body.error.code).toBe('invalid_config');
  });

  it('listWorkspaceDataConnectorsRoute lists for any auth user', async () => {
    await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'Visible to all' },
    });
    const res = await listWorkspaceDataConnectorsRoute(AUTH_MEMBER);
    expect(res.statusCode).toBe(200);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.data.dataConnectors.map((d) => d.displayName)).toContain(
      'Visible to all',
    );
  });

  it('updateWorkspaceDataConnectorRoute as member returns 403', async () => {
    const created = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'google_docs', displayName: 'Docs' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const res = await updateWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      connectorId: created.body.data.dataConnector.id,
      body: { displayName: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('deleteWorkspaceDataConnectorRoute as member returns 403', async () => {
    const created = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'google_sheets', displayName: 'Sheets' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const res = await deleteWorkspaceDataConnectorRoute({
      auth: AUTH_MEMBER,
      connectorId: created.body.data.dataConnector.id,
    });
    expect(res.statusCode).toBe(403);
  });

  it('setWorkspaceDataConnectorCredentialRoute round-trips set/clear', async () => {
    const created = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'Cred DC' },
    });
    if (!created.body.ok) throw new Error('seed failed');
    const id = created.body.data.dataConnector.id;
    const set = await setWorkspaceDataConnectorCredentialRoute({
      auth: AUTH_ADMIN,
      connectorId: id,
      body: { apiKey: 'ph-secret' },
    });
    expect(set.statusCode).toBe(200);
    if (!set.body.ok) throw new Error('expected ok');
    expect(set.body.data.dataConnector.hasCredential).toBe(true);

    const cleared = await setWorkspaceDataConnectorCredentialRoute({
      auth: AUTH_ADMIN,
      connectorId: id,
      body: { apiKey: '' },
    });
    expect(cleared.statusCode).toBe(200);
    if (!cleared.body.ok) throw new Error('expected ok');
    expect(cleared.body.data.dataConnector.hasCredential).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-Talk picker + toggles — talk-ownership gate
// ---------------------------------------------------------------------------

describe('per-talk connector toggles', () => {
  it('getTalkConnectorsRoute returns combined view with linked annotations', async () => {
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Slack pool' },
    });
    const dc = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'PostHog pool' },
    });
    if (!channel.body.ok || !dc.body.ok) throw new Error('seed failed');
    const channelId = channel.body.data.channel.id;
    const dcId = dc.body.data.dataConnector.id;

    // Member toggles slack ON, leaves posthog OFF.
    await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId,
    });

    const view = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
    });
    expect(view.statusCode).toBe(200);
    if (!view.body.ok) throw new Error('expected ok');
    const channelRow = view.body.data.channels.find((c) => c.id === channelId);
    const dcRow = view.body.data.dataConnectors.find((d) => d.id === dcId);
    expect(channelRow?.linked).toBe(true);
    expect(channelRow?.enabled).toBe(true);
    expect(dcRow?.linked).toBe(false);
  });

  it('getTalkConnectorsRoute on someone elses talk returns 404', async () => {
    const res = await getTalkConnectorsRoute({
      auth: AUTH_OTHER_MEMBER,
      talkId: TALK_MEMBER_ID,
    });
    // Talk RLS hides MEMBER's talk from OTHER_MEMBER, so the talk lookup
    // returns null and the route 404s — same shape as talk-resources.
    expect(res.statusCode).toBe(404);
  });

  it('setTalkChannelLinkRoute as the talk owner returns 200', async () => {
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Owner-OK' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    const res = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId: channel.body.data.channel.id,
    });
    expect(res.statusCode).toBe(200);
  });

  it('setTalkChannelLinkRoute as non-owner of the talk is blocked (403 or 404)', async () => {
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Owner-Block' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    const res = await setTalkChannelLinkRoute({
      auth: AUTH_OTHER_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId: channel.body.data.channel.id,
    });
    // canEditTalk relies on RLS-visible getTalkById; OTHER_MEMBER can't
    // see MEMBER's talk, so 404 fires first.
    expect([403, 404]).toContain(res.statusCode);
  });

  it('setTalkChannelLinkRoute on unknown channel returns 404', async () => {
    const res = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('setTalkChannelLinkRoute is idempotent (repeat toggle ON)', async () => {
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Idemp toggle' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    const channelId = channel.body.data.channel.id;
    const first = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId,
    });
    expect(first.statusCode).toBe(200);
    const second = await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId,
    });
    expect(second.statusCode).toBe(200);

    const view = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
    });
    if (!view.body.ok) throw new Error('expected ok');
    expect(
      view.body.data.channels.filter((c) => c.id === channelId).length,
    ).toBe(1);
  });

  it('deleteTalkChannelLinkRoute toggles a link off', async () => {
    const channel = await createWorkspaceChannelRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'slack', displayName: 'Toggle off' },
    });
    if (!channel.body.ok) throw new Error('seed failed');
    const channelId = channel.body.data.channel.id;
    await setTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId,
    });
    const res = await deleteTalkChannelLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      channelId,
    });
    expect(res.statusCode).toBe(200);
    const view = await getTalkConnectorsRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
    });
    if (!view.body.ok) throw new Error('expected ok');
    expect(
      view.body.data.channels.find((c) => c.id === channelId)?.linked,
    ).toBe(false);
  });

  it('setTalkDataConnectorLinkRoute happy path + idempotency', async () => {
    const dc = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'DC toggle' },
    });
    if (!dc.body.ok) throw new Error('seed failed');
    const dcId = dc.body.data.dataConnector.id;
    const first = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: dcId,
    });
    expect(first.statusCode).toBe(200);
    const second = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: dcId,
    });
    expect(second.statusCode).toBe(200);
  });

  it('deleteTalkDataConnectorLinkRoute removes link', async () => {
    const dc = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'DC delete' },
    });
    if (!dc.body.ok) throw new Error('seed failed');
    const dcId = dc.body.data.dataConnector.id;
    await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: dcId,
    });
    const res = await deleteTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: dcId,
    });
    expect(res.statusCode).toBe(200);
  });

  it('setTalkDataConnectorLinkRoute on unknown data connector returns 404', async () => {
    const res = await setTalkDataConnectorLinkRoute({
      auth: AUTH_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('setTalkDataConnectorLinkRoute as non-owner of the talk is blocked', async () => {
    const dc = await createWorkspaceDataConnectorRoute({
      auth: AUTH_ADMIN,
      body: { kind: 'posthog', displayName: 'DC owner block' },
    });
    if (!dc.body.ok) throw new Error('seed failed');
    const res = await setTalkDataConnectorLinkRoute({
      auth: AUTH_OTHER_MEMBER,
      talkId: TALK_MEMBER_ID,
      connectorId: dc.body.data.dataConnector.id,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});
