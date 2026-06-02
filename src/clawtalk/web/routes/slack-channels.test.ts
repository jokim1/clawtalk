// Route-level tests for slack-channels (PR 2 picker).
//
// Covers admin gating, install/credential validation, alreadyAdded
// deduplication, and the Slack API error path mapping. The actual Slack
// fetch is mocked; the DB accessors are mocked. No live Postgres or
// network connection required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../../connectors/slack-client.js', () => ({
  SlackApiError: class extends Error {
    slackError: string;
    httpStatus: number;
    constructor(slackError: string, message: string, httpStatus = 400) {
      super(message);
      this.slackError = slackError;
      this.httpStatus = httpStatus;
    }
  },
  listSlackConversations: vi.fn(),
}));

vi.mock('../../db/connectors-accessors.js', () => ({
  createWorkspaceChannel: vi.fn(),
  listWorkspaceChannels: vi.fn(),
}));

vi.mock('../../db/slack-installs-accessors.js', () => ({
  decryptWorkspaceSlackInstallToken: vi.fn(),
  getWorkspaceSlackInstall: vi.fn(),
}));

vi.mock('../../workspaces/accessors.js', () => ({
  resolveWorkspaceForUser: vi.fn(),
}));

vi.mock('../../workspaces/bootstrap.js', () => ({
  ensureWorkspaceBootstrapForUser: vi.fn(),
}));

import {
  bulkAddSlackChannelsRoute,
  listSlackInstallChannelsRoute,
} from './slack-channels.js';
import {
  SlackApiError,
  listSlackConversations,
} from '../../connectors/slack-client.js';
import {
  createWorkspaceChannel,
  listWorkspaceChannels,
} from '../../db/connectors-accessors.js';
import {
  decryptWorkspaceSlackInstallToken,
  getWorkspaceSlackInstall,
} from '../../db/slack-installs-accessors.js';
import { resolveWorkspaceForUser } from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { AuthContext } from '../types.js';

const ADMIN: AuthContext = {
  sessionId: 's',
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'owner',
  authType: 'cookie',
};
const MEMBER: AuthContext = { ...ADMIN, role: 'member' };
const REQUESTED_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

const listChannelsMock = vi.mocked(listSlackConversations);
const listWorkspaceChannelsMock = vi.mocked(listWorkspaceChannels);
const createWorkspaceChannelMock = vi.mocked(createWorkspaceChannel);
const getInstallMock = vi.mocked(getWorkspaceSlackInstall);
const decryptTokenMock = vi.mocked(decryptWorkspaceSlackInstallToken);
const resolveWorkspaceMock = vi.mocked(resolveWorkspaceForUser);
const bootstrapMock = vi.mocked(ensureWorkspaceBootstrapForUser);

const FAKE_INSTALL = {
  id: 'install-1',
  workspace_id: 'workspace-1',
  team_id: 'T01',
  team_name: 'Eng',
  bot_user_id: 'U1',
  app_id: 'A1',
  scopes: ['channels:read'],
  enc_key_version: 1,
  installed_by: 'user-1',
  installed_at: '2026-05-24T00:00:00Z',
  updated_at: '2026-05-24T00:00:00Z',
  bound_channel_count: 0,
};

function mockWorkspace(role: 'owner' | 'admin' | 'member' | 'guest' = 'owner') {
  resolveWorkspaceMock.mockImplementation(async ({ requestedWorkspaceId }) => ({
    id: requestedWorkspaceId ?? 'workspace-1',
    name: 'Workspace',
    role,
    initials: 'WO',
    created_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
  }));
}

beforeEach(() => {
  listChannelsMock.mockReset();
  listWorkspaceChannelsMock.mockReset();
  createWorkspaceChannelMock.mockReset();
  getInstallMock.mockReset();
  decryptTokenMock.mockReset();
  resolveWorkspaceMock.mockReset();
  bootstrapMock.mockReset();
  bootstrapMock.mockResolvedValue('workspace-1');
  decryptTokenMock.mockResolvedValue('xoxb-token');
  listChannelsMock.mockResolvedValue([
    {
      id: 'C1',
      name: 'general',
      is_private: false,
      is_member: true,
      num_members: 50,
    },
    {
      id: 'C2',
      name: 'random',
      is_private: false,
      is_member: true,
      num_members: 30,
    },
  ]);
  mockWorkspace();
});

afterEach(() => {
  listChannelsMock.mockReset();
  listWorkspaceChannelsMock.mockReset();
  createWorkspaceChannelMock.mockReset();
  getInstallMock.mockReset();
  decryptTokenMock.mockReset();
  resolveWorkspaceMock.mockReset();
  bootstrapMock.mockReset();
});

describe('listSlackInstallChannelsRoute', () => {
  it('returns 403 for non-admins', async () => {
    mockWorkspace('member');
    const result = await listSlackInstallChannelsRoute({
      auth: MEMBER,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(403);
    expect(getInstallMock).not.toHaveBeenCalled();
  });

  it('returns 403 when a requested workspace is not available', async () => {
    resolveWorkspaceMock.mockResolvedValueOnce(undefined);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      requestedWorkspaceId: FOREIGN_WORKSPACE_ID,
    });

    expect(result.statusCode).toBe(403);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('workspace_forbidden');
    expect(getInstallMock).not.toHaveBeenCalled();
  });

  it('rejects malformed requested workspace IDs before resolution', async () => {
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      requestedWorkspaceId: 'not-a-uuid',
    });

    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('invalid_workspace_id');
    expect(bootstrapMock).not.toHaveBeenCalled();
    expect(resolveWorkspaceMock).not.toHaveBeenCalled();
    expect(getInstallMock).not.toHaveBeenCalled();
  });

  it('returns 404 when install is missing', async () => {
    getInstallMock.mockResolvedValueOnce(null);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(404);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('install_not_found');
  });

  it('returns 409 when credential is missing', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce(null);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(409);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('install_credential_missing');
  });

  it('maps token_revoked SlackApiError to 401', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce('xoxb-token');
    listChannelsMock.mockRejectedValueOnce(
      new SlackApiError('token_revoked', 'token revoked', 401),
    );
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(401);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('slack_token_revoked');
  });

  it('returns sorted channels with alreadyAdded flag', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce('xoxb-token');
    listChannelsMock.mockResolvedValueOnce([
      {
        id: 'C2',
        name: 'random',
        is_private: false,
        is_member: true,
        num_members: 30,
      },
      {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_member: true,
        num_members: 50,
      },
    ]);
    listWorkspaceChannelsMock.mockResolvedValueOnce([
      {
        id: 'row-1',
        workspace_id: 'workspace-1',
        kind: 'slack',
        display_name: 'General',
        config_json: { workspace_id: 'T01', channel_id: 'C1' },
        has_credential: false,
        enc_key_version: 1,
        enabled: true,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        created_by: null,
        updated_by: null,
        bound_talk_count: 0,
      },
    ]);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    const channels = result.body.data.channels;
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ id: 'C1', alreadyAdded: true });
    expect(channels[1]).toMatchObject({ id: 'C2', alreadyAdded: false });
    expect(getInstallMock).toHaveBeenCalledWith('T01', {
      workspaceId: 'workspace-1',
    });
    expect(decryptTokenMock).toHaveBeenCalledWith('T01', {
      workspaceId: 'workspace-1',
    });
    expect(listWorkspaceChannelsMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
  });
});

describe('bulkAddSlackChannelsRoute', () => {
  it('returns 403 for non-admins', async () => {
    mockWorkspace('member');
    const result = await bulkAddSlackChannelsRoute({
      auth: MEMBER,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });
    expect(result.statusCode).toBe(403);
    expect(createWorkspaceChannelMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the user has no workspace', async () => {
    resolveWorkspaceMock.mockResolvedValueOnce(undefined);
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });

    expect(result.statusCode).toBe(404);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('workspace_not_found');
    expect(getInstallMock).not.toHaveBeenCalled();
    expect(createWorkspaceChannelMock).not.toHaveBeenCalled();
  });

  it('authorizes bulk add from the requested workspace role, not AuthContext.role', async () => {
    mockWorkspace('admin');
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    listWorkspaceChannelsMock.mockResolvedValueOnce([]);
    createWorkspaceChannelMock.mockResolvedValueOnce({
      id: 'row-new',
      workspace_id: REQUESTED_WORKSPACE_ID,
      kind: 'slack',
      display_name: 'general',
      config_json: {
        workspace_id: 'T01',
        channel_id: 'C1',
        channel_name: 'general',
        is_private: false,
      },
      has_credential: true,
      enc_key_version: 1,
      enabled: true,
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
      created_by: null,
      updated_by: null,
      bound_talk_count: 0,
    });

    const result = await bulkAddSlackChannelsRoute({
      auth: MEMBER,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'spoofed-name' }] },
      requestedWorkspaceId: REQUESTED_WORKSPACE_ID,
    });

    expect(result.statusCode).toBe(201);
    expect(createWorkspaceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: REQUESTED_WORKSPACE_ID,
        displayName: 'general',
        createdBy: MEMBER.userId,
        allowSlackChannelImport: true,
        config: expect.objectContaining({
          channel_id: 'C1',
          channel_name: 'general',
          is_private: false,
        }),
      }),
    );
  });

  it('returns 400 when channels array is empty', async () => {
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [] },
    });
    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('channels_required');
  });

  it('returns 400 when a channel entry is missing channelId', async () => {
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelName: 'general' }] as never },
    });
    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('invalid_channel_entry');
  });

  it('returns 404 when install is missing', async () => {
    getInstallMock.mockResolvedValueOnce(null);
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });
    expect(result.statusCode).toBe(404);
  });

  it('skips already-added channels and creates the rest', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    listWorkspaceChannelsMock.mockResolvedValueOnce([
      {
        id: 'row-existing',
        workspace_id: 'workspace-1',
        kind: 'slack',
        display_name: 'General',
        config_json: { workspace_id: 'T01', channel_id: 'C1' },
        has_credential: false,
        enc_key_version: 1,
        enabled: true,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        created_by: null,
        updated_by: null,
        bound_talk_count: 0,
      },
    ]);
    createWorkspaceChannelMock.mockResolvedValueOnce({
      id: 'row-new',
      workspace_id: 'workspace-1',
      kind: 'slack',
      display_name: 'random',
      config_json: {
        workspace_id: 'T01',
        channel_id: 'C2',
        channel_name: 'random',
        is_private: false,
      },
      has_credential: false,
      enc_key_version: 1,
      enabled: true,
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
      created_by: null,
      updated_by: null,
      bound_talk_count: 0,
    });

    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: {
        channels: [
          { channelId: 'C1', channelName: 'general' },
          { channelId: 'C2', channelName: 'random' },
          { channelId: 'C2', channelName: 'random' },
        ],
      },
    });
    expect(result.statusCode).toBe(201);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.created).toHaveLength(1);
    expect(result.body.data.created[0]).toMatchObject({
      channelId: 'C2',
      displayName: 'random',
    });
    expect(createWorkspaceChannelMock).toHaveBeenCalledTimes(1);
    expect(getInstallMock).toHaveBeenCalledWith('T01', {
      workspaceId: 'workspace-1',
    });
    expect(listWorkspaceChannelsMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
    expect(createWorkspaceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        authorized: true,
        displayName: 'random',
        allowSlackChannelImport: true,
        config: expect.objectContaining({
          workspace_id: 'T01',
          channel_id: 'C2',
          channel_name: 'random',
          is_private: false,
        }),
      }),
    );
  });

  it('rejects bulk add when a submitted channel is not visible to Slack', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    listChannelsMock.mockResolvedValueOnce([
      {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_member: true,
      },
    ]);
    listWorkspaceChannelsMock.mockResolvedValueOnce([]);

    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C999', channelName: 'spoofed' }] },
    });

    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('channel_not_available');
    expect(createWorkspaceChannelMock).not.toHaveBeenCalled();
  });

  it('rejects bulk add when the Slack bot has not joined the channel', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    listChannelsMock.mockResolvedValueOnce([
      {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_member: false,
      },
    ]);
    listWorkspaceChannelsMock.mockResolvedValueOnce([]);

    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });

    expect(result.statusCode).toBe(409);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('channel_not_joined');
    expect(createWorkspaceChannelMock).not.toHaveBeenCalled();
  });
});
