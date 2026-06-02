import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  claimedRows: [] as Array<Record<string, unknown>>,
  adminRows: [] as Array<Record<string, unknown>>,
}));

const sqlMock = vi.hoisted(() =>
  vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('delete from public.oauth_state')) {
      return dbState.claimedRows;
    }
    if (query.includes('from public.workspace_members')) {
      return dbState.adminRows;
    }
    throw new Error(`Unexpected SQL in slack-oauth-service.test: ${query}`);
  }),
);

const upsertWorkspaceSlackInstallMock = vi.hoisted(() => vi.fn());

vi.mock('../../db.js', () => ({
  getDbPg: () => sqlMock,
}));

vi.mock('../config.js', () => ({
  SLACK_CLIENT_ID: 'slack-client-id',
  SLACK_CLIENT_SECRET: 'slack-client-secret',
}));

vi.mock('../db/slack-installs-accessors.js', () => ({
  upsertWorkspaceSlackInstall: upsertWorkspaceSlackInstallMock,
}));

import { completeSlackInstallCallback } from './slack-oauth-service.js';
import { upsertWorkspaceSlackInstall } from '../db/slack-installs-accessors.js';

const upsertMock = vi.mocked(upsertWorkspaceSlackInstall);

beforeEach(() => {
  sqlMock.mockClear();
  upsertWorkspaceSlackInstallMock.mockReset();
  upsertWorkspaceSlackInstallMock.mockResolvedValue({
    id: 'install-1',
    workspace_id: 'workspace-2',
    team_id: 'T02',
    team_name: 'Product',
    bot_user_id: 'UBOT',
    app_id: 'AAPP',
    scopes: ['channels:read'],
    enc_key_version: 1,
    installed_by: '11111111-1111-1111-1111-111111111111',
    installed_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
    bound_channel_count: 0,
  });
  dbState.claimedRows = [
    {
      id: 'state-1',
      user_id: '11111111-1111-1111-1111-111111111111',
      workspace_id: 'workspace-2',
      provider: 'slack_app_install',
      redirect_uri: 'https://clawtalk.test/api/v1/auth/slack/callback',
      return_to: null,
      expires_at: '2026-05-24T00:10:00Z',
    },
  ];
  dbState.adminRows = [{ role: 'admin' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ok: true,
        access_token: 'xoxb-token',
        token_type: 'bot',
        scope: 'channels:read,chat:write',
        bot_user_id: 'UBOT',
        app_id: 'AAPP',
        team: { id: 'T02', name: 'Product' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('completeSlackInstallCallback', () => {
  it('persists the Slack install in the workspace from OAuth state', async () => {
    const result = await completeSlackInstallCallback({
      rawState: 'raw-state',
      code: 'oauth-code',
      slackError: null,
    });

    expect(result).toMatchObject({
      status: 'success',
      teamId: 'T02',
      teamName: 'Product',
    });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-2',
        teamId: 'T02',
        teamName: 'Product',
        botToken: 'xoxb-token',
        installedBy: '11111111-1111-1111-1111-111111111111',
      }),
    );
  });

  it('rejects callbacks when the initiating user is no longer workspace admin', async () => {
    dbState.adminRows = [];

    const result = await completeSlackInstallCallback({
      rawState: 'raw-state',
      code: 'oauth-code',
      slackError: null,
    });

    expect(result).toMatchObject({
      status: 'error',
      errorCode: 'workspace_admin_required',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
