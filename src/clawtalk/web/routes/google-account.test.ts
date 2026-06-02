// Route-level tests for google-account.
//
// These tests cover the parts of the route module that don't require a live
// Postgres connection — the htmlSafeJson helper (D3 XSS regression guard),
// the bare callback paths (no state → invalid response), and the
// picker-token error mapping. Full happy-path callback, auth gate via
// middleware, and rate-limit hits live in google-oauth-service.test.ts and the
// existing integration suite.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() =>
  vi.fn<
    (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<Array<{ workspace_id: string }>>
  >(async (strings: TemplateStringsArray) => {
    throw new Error(
      `Unexpected SQL in google-account.test: ${strings.join('?')}`,
    );
  }),
);

// `withUserContext` from src/db.ts opens a real Postgres transaction. The
// picker-token route only uses the DB when resolving an optional Talk-scoped
// workspace, so mock both the DB handle and withUserContext. This keeps the
// test hermetic — no supabase local stack required.
vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    getDbPg: () => sqlMock,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
  };
});

// Mock the picker-session builder so each test can shape the success /
// error paths it cares about. The service module itself is covered by
// google-tools-service.test.ts (DB-backed).
vi.mock('../../identity/google-tools-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../identity/google-tools-service.js')
  >('../../identity/google-tools-service.js');
  return {
    ...actual,
    buildGooglePickerSession: vi.fn(),
  };
});

vi.mock('../../workspaces/bootstrap.js', () => ({
  ensureWorkspaceBootstrapForUser: vi.fn(async () => 'workspace-1'),
}));

vi.mock('../../workspaces/accessors.js', () => ({
  resolveWorkspaceForUser: vi.fn(async () => ({
    id: '11111111-2222-4222-8222-111111111111',
    name: 'Test',
    role: 'owner',
    initials: 'T',
    created_at: '2026-05-31T00:00:00Z',
    updated_at: '2026-05-31T00:00:00Z',
  })),
}));

import {
  disconnectGoogleAccountRoute,
  expandScopesRoute,
  getGooglePickerTokenRoute,
  getUserGoogleAccountRoute,
  handleGoogleCallback,
  htmlSafeJson,
  startConnectRoute,
} from './google-account.js';
import { buildGooglePickerSession } from '../../identity/google-tools-service.js';
import { GoogleToolCredentialError } from '../../identity/google-tools-errors.js';
import type { AuthContext } from '../types.js';

const AUTH: AuthContext = {
  sessionId: 'session-1',
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'owner',
  authType: 'cookie',
};
const WORKSPACE_ID = '11111111-2222-4222-8222-111111111111';
const TALK_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const mockedBuildPickerSession = vi.mocked(buildGooglePickerSession);

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    throw new Error(
      `Unexpected SQL in google-account.test: ${strings.join('?')}`,
    );
  });
  mockedBuildPickerSession.mockReset();
});

afterEach(() => {
  sqlMock.mockReset();
  mockedBuildPickerSession.mockReset();
});

describe('htmlSafeJson (D3 XSS regression guard)', () => {
  it('escapes </ so the payload cannot close a <script> tag', () => {
    const out = htmlSafeJson({
      type: 'clawtalk:google-account-link',
      status: 'error',
      message: '</script><script>alert(1)</script>',
    });
    // The raw injection string must NOT appear verbatim
    expect(out).not.toContain('</script><script>');
    // The forward slash after < should be escaped
    expect(out).toContain('\\u003c');
  });

  it('escapes ampersands', () => {
    const out = htmlSafeJson({ message: 'a & b' });
    expect(out).toContain('\\u0026');
  });

  it('escapes U+2028 and U+2029 (JS line terminators)', () => {
    const out = htmlSafeJson({ message: 'one two three' });
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    // The raw line separators must not survive into the output
    expect(out).not.toMatch(new RegExp('[\\u2028\\u2029]'));
  });

  it('round-trips safe content untouched (no over-escape)', () => {
    const out = htmlSafeJson({ status: 'success', message: 'hello world' });
    expect(out).toContain('"status":"success"');
    expect(out).toContain('"hello world"');
  });
});

describe('handleGoogleCallback — missing state', () => {
  it('returns 400 with an error popup HTML when state is missing', async () => {
    const result = await handleGoogleCallback({
      state: null,
      code: 'whatever',
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('clawtalk:google-account-link');
    expect(result.html).toContain('"status":"error"');
    expect(result.html).toContain('Connection link is invalid');
  });

  it('returns HTML that does not let attacker-controlled message escape <script>', async () => {
    // The "message" field is server-controlled in the no-state path, so this
    // exercises the rendering pipeline end-to-end rather than the message
    // content itself. Any future code that interpolates user-controlled
    // message values must still flow through htmlSafeJson.
    const result = await handleGoogleCallback({
      state: null,
      code: null,
      error: null,
    });
    expect(result.html).toContain('window.opener.postMessage');
    // Verify the HTML uses a JSON.parse-style embed — no raw template
    // interpolation of strings into <script>.
    expect(result.html).toContain('var payload =');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/me/google-account/picker-token
// ---------------------------------------------------------------------------

describe('getGooglePickerTokenRoute', () => {
  it('returns oauthToken + developerKey + appId on the happy path', async () => {
    mockedBuildPickerSession.mockResolvedValueOnce({
      oauthToken: 'access-from-credential',
      developerKey: 'picker-key',
      appId: 'picker-app',
    });
    const result = await getGooglePickerTokenRoute(AUTH, WORKSPACE_ID);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      data: {
        oauthToken: 'access-from-credential',
        developerKey: 'picker-key',
        appId: 'picker-app',
      },
    });
    expect(mockedBuildPickerSession).toHaveBeenCalledWith(AUTH.userId, {
      workspaceId: WORKSPACE_ID,
    });
  });

  it.each([
    ['account read', () => getUserGoogleAccountRoute(AUTH)],
    ['connect', () => startConnectRoute(AUTH, { scopes: ['drive.readonly'] })],
    ['expand', () => expandScopesRoute(AUTH, { scopes: ['drive.readonly'] })],
    ['disconnect', () => disconnectGoogleAccountRoute(AUTH)],
    ['picker token', () => getGooglePickerTokenRoute(AUTH)],
  ])(
    'rejects missing workspace/talk scope for %s',
    async (_caseName, runRoute) => {
      const result = await runRoute();

      expect(result.statusCode).toBe(400);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) {
        expect(result.body.error.code).toBe('workspace_scope_required');
      }
      expect(mockedBuildPickerSession).not.toHaveBeenCalled();
      expect(sqlMock).not.toHaveBeenCalled();
    },
  );

  it('uses the talk workspace when a picker session is requested for a Talk', async () => {
    const talkId = '22222222-2222-4222-8222-222222222222';
    sqlMock.mockResolvedValueOnce([{ workspace_id: TALK_WORKSPACE_ID }]);
    mockedBuildPickerSession.mockResolvedValueOnce({
      oauthToken: 'access-from-talk-workspace',
      developerKey: 'picker-key',
      appId: 'picker-app',
    });

    const result = await getGooglePickerTokenRoute(AUTH, null, talkId);

    expect(result.statusCode).toBe(200);
    expect(mockedBuildPickerSession).toHaveBeenCalledWith(AUTH.userId, {
      workspaceId: TALK_WORKSPACE_ID,
    });
  });

  it('rejects mismatched workspace and talk picker-session requests', async () => {
    const talkId = '22222222-2222-4222-8222-222222222222';
    sqlMock.mockResolvedValueOnce([{ workspace_id: TALK_WORKSPACE_ID }]);

    const result = await getGooglePickerTokenRoute(AUTH, WORKSPACE_ID, talkId);

    expect(result.statusCode).toBe(400);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('workspace_mismatch');
    }
    expect(mockedBuildPickerSession).not.toHaveBeenCalled();
  });

  it('rejects malformed requested workspace IDs before resolution', async () => {
    const result = await getGooglePickerTokenRoute(AUTH, 'not-a-uuid');

    expect(result.statusCode).toBe(400);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('invalid_workspace_id');
    }
    expect(mockedBuildPickerSession).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('returns 404 google_account_not_connected when no credential exists', async () => {
    mockedBuildPickerSession.mockRejectedValueOnce(
      new GoogleToolCredentialError(
        'google_account_not_connected',
        'Google account is not connected.',
        404,
      ),
    );
    const result = await getGooglePickerTokenRoute(AUTH, WORKSPACE_ID);
    expect(result.statusCode).toBe(404);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('google_account_not_connected');
    }
  });

  it('returns 400 google_scopes_missing with missingScopes detail', async () => {
    mockedBuildPickerSession.mockRejectedValueOnce(
      new GoogleToolCredentialError(
        'google_scopes_missing',
        'Google account is missing required scopes: drive.readonly',
        400,
        { missingScopes: ['drive.readonly'] },
      ),
    );
    const result = await getGooglePickerTokenRoute(AUTH, WORKSPACE_ID);
    expect(result.statusCode).toBe(400);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('google_scopes_missing');
      expect(result.body.error.details).toEqual({
        missingScopes: ['drive.readonly'],
      });
    }
  });

  it('returns 503 google_picker_not_configured when picker env vars are empty (C11)', async () => {
    // The service mints this error directly when GOOGLE_PICKER_API_KEY or
    // GOOGLE_PICKER_APP_ID is empty. Configured via a mocked rejection so
    // we exercise the route's error-mapping path even when the test
    // process loaded real (or test-stubbed) values.
    mockedBuildPickerSession.mockRejectedValueOnce(
      new GoogleToolCredentialError(
        'google_picker_not_configured',
        'Google Picker is not configured on this server.',
        503,
      ),
    );
    const result = await getGooglePickerTokenRoute(AUTH, WORKSPACE_ID);
    expect(result.statusCode).toBe(503);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('google_picker_not_configured');
    }
  });

  it('re-throws non-typed errors so they surface as 500 via Hono onError', async () => {
    mockedBuildPickerSession.mockRejectedValueOnce(new Error('boom'));
    await expect(getGooglePickerTokenRoute(AUTH, WORKSPACE_ID)).rejects.toThrow(
      'boom',
    );
  });
});
