// Route-level tests for slack-installs.
//
// Covers the parts of the route module that don't require a live Postgres
// connection — the htmlSafeJson helper (XSS regression guard), the bare
// callback paths (no state → invalid response), and admin-gating on the
// start/delete routes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../../connectors/slack-oauth-service.js', () => ({
  SlackOAuthError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  completeSlackInstallCallback: vi.fn(),
  startSlackInstall: vi.fn(),
}));

vi.mock('../../db/slack-installs-accessors.js', () => ({
  deleteWorkspaceSlackInstall: vi.fn(),
  listWorkspaceSlackInstalls: vi.fn(),
}));

vi.mock('../../workspaces/accessors.js', () => ({
  resolveWorkspaceForUser: vi.fn(),
}));

vi.mock('../../workspaces/bootstrap.js', () => ({
  ensureWorkspaceBootstrapForUser: vi.fn(),
}));

import {
  deleteWorkspaceSlackInstallRoute,
  handleSlackCallback,
  htmlSafeJson,
  listWorkspaceSlackInstallsRoute,
  startSlackInstallRoute,
} from './slack-installs.js';
import {
  completeSlackInstallCallback,
  startSlackInstall,
} from '../../connectors/slack-oauth-service.js';
import {
  deleteWorkspaceSlackInstall,
  listWorkspaceSlackInstalls,
} from '../../db/slack-installs-accessors.js';
import { resolveWorkspaceForUser } from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { AuthContext } from '../types.js';

const ADMIN_AUTH: AuthContext = {
  sessionId: 'session-1',
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'owner',
  authType: 'cookie',
};

const MEMBER_AUTH: AuthContext = {
  ...ADMIN_AUTH,
  role: 'member',
};

const REQUESTED_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

const startMock = vi.mocked(startSlackInstall);
const completeMock = vi.mocked(completeSlackInstallCallback);
const listMock = vi.mocked(listWorkspaceSlackInstalls);
const deleteMock = vi.mocked(deleteWorkspaceSlackInstall);
const resolveWorkspaceMock = vi.mocked(resolveWorkspaceForUser);
const bootstrapMock = vi.mocked(ensureWorkspaceBootstrapForUser);

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
  startMock.mockReset();
  completeMock.mockReset();
  listMock.mockReset();
  deleteMock.mockReset();
  resolveWorkspaceMock.mockReset();
  bootstrapMock.mockReset();
  bootstrapMock.mockResolvedValue('workspace-1');
  mockWorkspace();
});

afterEach(() => {
  startMock.mockReset();
  completeMock.mockReset();
  listMock.mockReset();
  deleteMock.mockReset();
  resolveWorkspaceMock.mockReset();
  bootstrapMock.mockReset();
});

describe('htmlSafeJson (XSS regression guard)', () => {
  it('escapes </ so the payload cannot close a <script> tag', () => {
    const out = htmlSafeJson({
      type: 'clawtalk:slack-workspace-install',
      status: 'error',
      message: '</script><script>alert(1)</script>',
    });
    expect(out).not.toContain('</script><script>');
    expect(out).toContain('\\u003c');
  });

  it('escapes ampersands and JS line terminators', () => {
    const out = htmlSafeJson({ message: 'a & b c d' });
    expect(out).toContain('\\u0026');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).not.toMatch(new RegExp('[\\u2028\\u2029]'));
  });
});

describe('handleSlackCallback', () => {
  it('returns 400 + error popup when state is missing', async () => {
    const result = await handleSlackCallback({
      state: null,
      code: null,
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('clawtalk:slack-workspace-install');
    expect(result.html).toContain('"status":"error"');
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('returns 200 + success popup on successful completion', async () => {
    completeMock.mockResolvedValueOnce({
      status: 'success',
      teamId: 'T01ABCDE',
      teamName: 'Eng',
    });
    const result = await handleSlackCallback({
      state: 'raw',
      code: 'c',
      error: null,
    });
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('"status":"success"');
    expect(result.html).toContain('"teamName":"Eng"');
  });

  it('renders the error message verbatim on failed completion (escaped)', async () => {
    completeMock.mockResolvedValueOnce({
      status: 'error',
      errorCode: 'state_invalid_or_expired',
      message: 'Install link expired, try again.',
    });
    const result = await handleSlackCallback({
      state: 'raw',
      code: 'c',
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('Install link expired');
  });
});

describe('admin gating', () => {
  it('startSlackInstallRoute returns 403 for non-admins', async () => {
    mockWorkspace('member');
    const result = await startSlackInstallRoute(MEMBER_AUTH, {});
    expect(result.statusCode).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('deleteWorkspaceSlackInstallRoute returns 403 for non-admins', async () => {
    mockWorkspace('member');
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: MEMBER_AUTH,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('listWorkspaceSlackInstallsRoute returns the installs for any authed user', async () => {
    listMock.mockResolvedValueOnce([
      {
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
      },
    ]);
    const result = await listWorkspaceSlackInstallsRoute(MEMBER_AUTH);
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.installs).toHaveLength(1);
    expect(result.body.data.installs[0]).toMatchObject({
      teamId: 'T01',
      teamName: 'Eng',
      boundChannelCount: 0,
    });
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
  });

  it('returns 403 when a requested workspace is not available', async () => {
    resolveWorkspaceMock.mockResolvedValueOnce(undefined);
    const result = await listWorkspaceSlackInstallsRoute(
      MEMBER_AUTH,
      FOREIGN_WORKSPACE_ID,
    );

    expect(result.statusCode).toBe(403);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('workspace_forbidden');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('rejects malformed requested workspace IDs before resolution', async () => {
    const result = await listWorkspaceSlackInstallsRoute(
      MEMBER_AUTH,
      'not-a-uuid',
    );

    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('invalid_workspace_id');
    expect(bootstrapMock).not.toHaveBeenCalled();
    expect(resolveWorkspaceMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the user has no workspace', async () => {
    resolveWorkspaceMock.mockResolvedValueOnce(undefined);
    const result = await listWorkspaceSlackInstallsRoute(MEMBER_AUTH);

    expect(result.statusCode).toBe(404);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('workspace_not_found');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('startSlackInstallRoute uses the requested workspace', async () => {
    startMock.mockResolvedValueOnce({
      authorizationUrl: 'https://slack.example/install',
      expiresInSec: 600,
    });
    const result = await startSlackInstallRoute(
      ADMIN_AUTH,
      { returnTo: '/settings' },
      REQUESTED_WORKSPACE_ID,
    );
    expect(result.statusCode).toBe(200);
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: REQUESTED_WORKSPACE_ID,
        userId: ADMIN_AUTH.userId,
        returnTo: '/settings',
      }),
    );
  });
});

describe('deleteWorkspaceSlackInstallRoute', () => {
  it('returns 404 when the install does not exist', async () => {
    deleteMock.mockResolvedValueOnce(false);
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: ADMIN_AUTH,
      teamId: 'T-missing',
    });
    expect(result.statusCode).toBe(404);
  });

  it('returns 200 with deleted=true on success', async () => {
    deleteMock.mockResolvedValueOnce(true);
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: ADMIN_AUTH,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith('T01', {
      workspaceId: 'workspace-1',
    });
  });
});
