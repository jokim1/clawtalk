// Google account OAuth route handlers.
//
// JSON routes (/api/v1/me/google-account/*) return the standard
// { statusCode, body: ApiEnvelope<T> } shape. The popup callback at
// /api/v1/auth/google/callback returns an HTML Response directly because the
// page runs in the popup window and posts back to window.opener.
//
// All inline HTML interpolation flows through `htmlSafeJson()` (D3) to
// guarantee no user-controllable string can escape the <script> context.

import { getDbPg, withUserContext } from '../../../db.js';
import { GOOGLE_OAUTH_REDIRECT_URI } from '../../config.js';
import { getUserGoogleCredential } from '../../db/talk-tools-accessors.js';
import {
  GoogleOAuthError,
  completeGoogleOAuthCallback,
  disconnectGoogleAccount,
  ensureOidcScopes,
  startGoogleOAuth,
  validateRequestedScopes,
} from '../../identity/google-oauth-service.js';
import { decryptGoogleToolCredential } from '../../identity/google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from '../../identity/google-scopes.js';
import {
  GoogleToolCredentialError,
  buildGooglePickerSession,
} from '../../identity/google-tools-service.js';
import { resolveWorkspaceForUser } from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import { ApiEnvelope, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface JsonRouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

const DEFAULT_TOOL_SCOPES = ['drive.readonly', 'documents', 'spreadsheets'];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResult(
  statusCode: number,
  code: string,
  message: string,
): JsonRouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function fromOAuthError(err: GoogleOAuthError): JsonRouteResult<never> {
  return errorResult(err.status, err.code, err.message);
}

async function withGoogleAccountWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (workspaceId: string) => Promise<JsonRouteResult<T>>,
  requestedTalkId?: string | null,
): Promise<JsonRouteResult<T>> {
  const workspaceIdInput =
    typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId.trim() : '';
  const talkIdInput =
    typeof requestedTalkId === 'string' ? requestedTalkId.trim() : '';
  if (!workspaceIdInput && !talkIdInput) {
    return errorResult(
      400,
      'workspace_scope_required',
      'workspaceId or talkId is required.',
    );
  }
  if (workspaceIdInput && !UUID_RE.test(workspaceIdInput)) {
    return errorResult(
      400,
      'invalid_workspace_id',
      'workspaceId must be a valid UUID.',
    );
  }
  await ensureWorkspaceBootstrapForUser(auth.userId);
  return withUserContext(auth.userId, async () => {
    if (talkIdInput) {
      if (!UUID_RE.test(talkIdInput)) {
        return errorResult(
          400,
          'invalid_talk_id',
          'talkId must be a valid UUID.',
        );
      }
      const db = getDbPg();
      const rows = await db<Array<{ workspace_id: string }>>`
        select t.workspace_id
        from public.talks t
        join public.workspace_members wm
          on wm.workspace_id = t.workspace_id
         and wm.user_id = ${auth.userId}::uuid
        where t.id = ${talkIdInput}::uuid
        limit 1
      `;
      const workspaceId = rows[0]?.workspace_id;
      if (!workspaceId) {
        return errorResult(404, 'talk_not_found', 'Talk not found.');
      }
      if (workspaceIdInput && workspaceIdInput !== workspaceId) {
        return errorResult(
          400,
          'workspace_mismatch',
          'Requested workspace does not match the talk workspace.',
        );
      }
      return fn(workspaceId);
    }

    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId: workspaceIdInput,
    });
    if (!workspace) {
      return errorResult(
        403,
        'workspace_forbidden',
        'Workspace is not available for this user.',
      );
    }
    return fn(workspace.id);
  });
}

// ---------------------------------------------------------------------------
// UserGoogleAccount projection
// ---------------------------------------------------------------------------

export interface UserGoogleAccount {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
}

const DISCONNECTED: UserGoogleAccount = {
  connected: false,
  email: null,
  displayName: null,
  scopes: [],
  accessExpiresAt: null,
};

// ---------------------------------------------------------------------------
// GET /api/v1/me/google-account
// ---------------------------------------------------------------------------

export async function getUserGoogleAccountRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<JsonRouteResult<{ googleAccount: UserGoogleAccount }>> {
  return withGoogleAccountWorkspace(
    auth,
    requestedWorkspaceId,
    async (workspaceId) => {
      const cred = await getUserGoogleCredential({ workspaceId });
      if (!cred) {
        return {
          statusCode: 200,
          body: { ok: true, data: { googleAccount: DISCONNECTED } },
        };
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            googleAccount: {
              connected: true,
              email: cred.email,
              displayName: cred.displayName,
              scopes: normalizeGoogleScopeAliases(cred.scopes),
              accessExpiresAt: cred.accessExpiresAt,
            },
          },
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/connect
// ---------------------------------------------------------------------------

export async function startConnectRoute(
  auth: AuthContext,
  body: { returnTo?: unknown; scopes?: unknown },
  requestedWorkspaceId?: string | null,
): Promise<
  JsonRouteResult<{ authorizationUrl: string; expiresInSec: number }>
> {
  let requested: string[];
  try {
    requested = validateRequestedScopes(
      Array.isArray(body.scopes)
        ? (body.scopes as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : DEFAULT_TOOL_SCOPES,
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
  const finalScopes = ensureOidcScopes(
    requested.length === 0 ? DEFAULT_TOOL_SCOPES : requested,
  );

  const returnTo =
    typeof body.returnTo === 'string' && body.returnTo.length > 0
      ? body.returnTo
      : null;

  try {
    return await withGoogleAccountWorkspace(
      auth,
      requestedWorkspaceId,
      async (workspaceId) => {
        const result = await startGoogleOAuth({
          workspaceId,
          userId: auth.userId,
          scopes: finalScopes,
          redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
          returnTo,
        });
        return { statusCode: 200, body: { ok: true, data: result } };
      },
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/expand-scopes
// ---------------------------------------------------------------------------

export async function expandScopesRoute(
  auth: AuthContext,
  body: { returnTo?: unknown; scopes?: unknown },
  requestedWorkspaceId?: string | null,
): Promise<
  JsonRouteResult<{ authorizationUrl: string; expiresInSec: number }>
> {
  let requested: string[];
  try {
    requested = validateRequestedScopes(
      Array.isArray(body.scopes)
        ? (body.scopes as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : [],
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
  if (requested.length === 0) {
    return errorResult(
      400,
      'scopes_required',
      'scopes array must be non-empty.',
    );
  }

  const returnTo =
    typeof body.returnTo === 'string' && body.returnTo.length > 0
      ? body.returnTo
      : null;

  // Require existing credential; merge persisted aliases into the request
  // (C8: persisted scopes never shrink, even if user re-consents with fewer).
  try {
    return await withGoogleAccountWorkspace(
      auth,
      requestedWorkspaceId,
      async (workspaceId) => {
        const cred = await getUserGoogleCredential({ workspaceId });
        if (!cred) {
          throw new GoogleOAuthError(
            'not_connected',
            'Google account is not connected. Connect first, then expand scopes.',
            403,
          );
        }
        const merged = Array.from(new Set([...cred.scopes, ...requested]));
        const result = await startGoogleOAuth({
          workspaceId,
          userId: auth.userId,
          scopes: ensureOidcScopes(merged),
          redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
          returnTo,
        });
        return { statusCode: 200, body: { ok: true, data: result } };
      },
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/disconnect
// ---------------------------------------------------------------------------

export async function disconnectGoogleAccountRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
): Promise<JsonRouteResult<{ disconnected: boolean }>> {
  return withGoogleAccountWorkspace(
    auth,
    requestedWorkspaceId,
    async (workspaceId) => {
      const removed = await disconnectGoogleAccount({ workspaceId });
      return {
        statusCode: 200,
        body: { ok: true, data: { disconnected: removed } },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/me/google-account/picker-token
// ---------------------------------------------------------------------------

/**
 * Mints the short-lived OAuth token + Picker SDK developer key + GCP appId
 * the webapp needs to open the Google Picker. Token is the user's current
 * Google access token (refreshed transparently if expired). Lifetime is
 * tied to the credential's `expiryDate` — typically ~1h.
 *
 * Errors are mapped from `GoogleToolCredentialError.code`:
 *   - `google_account_not_connected`   → 404
 *   - `google_scopes_missing`          → 400 (includes `missingScopes`)
 *   - `google_picker_not_configured`   → 503 (env vars empty on this Worker)
 *   - other typed codes propagate through their carried `status`.
 */
export async function getGooglePickerTokenRoute(
  auth: AuthContext,
  requestedWorkspaceId?: string | null,
  requestedTalkId?: string | null,
): Promise<
  JsonRouteResult<{ oauthToken: string; developerKey: string; appId: string }>
> {
  try {
    return await withGoogleAccountWorkspace(
      auth,
      requestedWorkspaceId,
      async (workspaceId) => {
        const session = await buildGooglePickerSession(auth.userId, {
          workspaceId,
        });
        return { statusCode: 200, body: { ok: true, data: session } };
      },
      requestedTalkId,
    );
  } catch (err) {
    if (err instanceof GoogleToolCredentialError) {
      const body: ApiEnvelope<never> = {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.missingScopes
            ? { details: { missingScopes: err.missingScopes } }
            : {}),
        },
      };
      return { statusCode: err.status, body };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/google/callback
// ---------------------------------------------------------------------------

/**
 * D3: serialize a JSON payload safely for embedding inside <script>...</script>.
 * `JSON.stringify` already escapes most special characters, but we still must
 * neutralize the three sequences that can break out of a script context:
 *   - `</`         → could close the script tag
 *   - U+2028/2029  → JavaScript treats these as line terminators
 *   - `&`          → defensive against HTML entity tricks in some browsers
 */
export function htmlSafeJson(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

function renderCallbackHtml(payload: {
  type: 'clawtalk:google-account-link';
  status: 'success' | 'error';
  message?: string | null;
}): string {
  const serialized = htmlSafeJson(payload);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Google connection</title></head>
<body>
<p>Closing window…</p>
<script>
(function () {
  var payload = ${serialized};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, 50);
})();
</script>
</body></html>`;
}

export async function handleGoogleCallback(rawQuery: {
  state: string | null;
  code: string | null;
  error: string | null;
}): Promise<{ html: string; statusCode: number }> {
  if (!rawQuery.state) {
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: 'Connection link is invalid.',
      }),
      statusCode: 400,
    };
  }

  try {
    const result = await completeGoogleOAuthCallback({
      rawState: rawQuery.state,
      code: rawQuery.code,
      googleError: rawQuery.error,
    });
    if (result.status === 'success') {
      return {
        html: renderCallbackHtml({
          type: 'clawtalk:google-account-link',
          status: 'success',
        }),
        statusCode: 200,
      };
    }
    // 'denied' and 'error' both surface as `status: 'error'` to the opener
    // with a user-readable message. The error code is logged server-side via
    // the calling route (worker-app.ts attaches the logger).
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: result.message ?? 'Could not complete connection.',
      }),
      statusCode: result.status === 'denied' ? 200 : 400,
    };
  } catch (err) {
    // Defensive: anything thrown out of completeGoogleOAuthCallback shows up
    // here. Don't leak the message to the popup (XSS surface mitigated, but
    // attacker-controllable strings should still not appear in the popup
    // verbatim).
    const code = err instanceof GoogleOAuthError ? err.code : 'callback_failed';
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: 'Could not complete connection.',
      }),
      statusCode: err instanceof GoogleOAuthError ? err.status : 500,
    };
  }
}

// ---------------------------------------------------------------------------
// Decrypt helper exposed for tests
// ---------------------------------------------------------------------------

export function _decryptForTests(ciphertext: string) {
  return decryptGoogleToolCredential(ciphertext);
}
