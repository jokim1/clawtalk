import crypto from 'crypto';

import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_DEV_MODE,
  DEVICE_CODE_TTL_SEC,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI,
  INITIAL_OWNER_EMAIL,
  REFRESH_TOKEN_TTL_SEC,
  isPublicMode,
} from '../config.js';
import {
  createDeviceAuthCode,
  createOAuthState,
  createUserInvite,
  consumeOAuthStateByHash,
  getActiveInviteByEmail,
  getOwnerUser,
  getPendingDeviceAuthCodeByDeviceHash,
  getUserByEmail,
  getUserById,
  getWebSessionByRefreshTokenHash,
  markDeviceAuthCodeCompleted,
  markInviteAccepted,
  revokeWebSession,
  revokeWebSessionChain,
  upsertUser,
  upsertWebSession,
  UserRecord,
} from '../db/index.js';
import { hashOpaqueToken } from '../security/hash.js';
import { UserRole } from '../types.js';
import {
  expandGoogleScopeAliases,
  normalizeGoogleScopeAliases,
} from './google-scopes.js';

export interface SessionMaterial {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface LoginResult {
  user: UserRecord;
  session: SessionMaterial;
  returnTo?: string | null;
}

export interface OAuthStartResult {
  state: string;
  authorizationUrl: string;
  expiresInSec: number;
}

export interface GoogleOAuthIdentity {
  googleSubject: string;
  email: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  tokenType: string | null;
  accessExpiresAt: string | null;
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const OAUTH_STATE_TTL_SEC = 600;
const CLOCK_SKEW_SEC = 300;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKEN_INFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

export function startGoogleOAuth(input?: {
  returnTo?: string;
  scopes?: string[];
  redirectUri?: string;
}): OAuthStartResult {
  const state = randomOpaque(24);
  const nonce = randomOpaque(24);
  const codeVerifier = randomOpaque(48);
  const stateHash = hashOpaqueToken(state);
  const nonceHash = hashOpaqueToken(nonce);
  const codeVerifierHash = hashOpaqueToken(codeVerifier);
  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_SEC * 1000,
  ).toISOString();

  const redirectUri =
    input?.redirectUri ||
    GOOGLE_OAUTH_REDIRECT_URI ||
    'http://127.0.0.1:3210/api/v1/auth/google/callback';

  createOAuthState({
    id: crypto.randomUUID(),
    provider: 'google',
    stateHash,
    nonceHash,
    codeVerifierHash,
    codeVerifier,
    redirectUri,
    returnTo: input?.returnTo,
    expiresAt,
  });

  if (AUTH_DEV_MODE) {
    const authorizationUrl = `${redirectUri}?state=${encodeURIComponent(
      state,
    )}&email=owner@example.com&name=Owner`;
    return { state, authorizationUrl, expiresInSec: OAUTH_STATE_TTL_SEC };
  }

  if (!GOOGLE_OAUTH_CLIENT_ID || !redirectUri) {
    throw new AuthError(
      'google_oauth_not_configured',
      'Google OAuth is not configured',
      503,
    );
  }

  const challenge = toCodeChallenge(codeVerifier);
  const requestedScopes = Array.from(
    new Set([
      'openid',
      'email',
      'profile',
      ...expandGoogleScopeAliases(input?.scopes || []),
    ]),
  );
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: requestedScopes.join(' '),
    access_type: 'offline',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    state,
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    expiresInSec: OAUTH_STATE_TTL_SEC,
  };
}

export async function completeGoogleOAuthCallback(input: {
  state: string;
  code?: string;
  email?: string;
  displayName?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<LoginResult> {
  const completed = await completeGoogleOAuthIdentityCallback(input);
  const user = resolveUserForLogin({
    email: completed.identity.email,
    displayName: completed.identity.displayName,
  });
  const session = createSessionForUser(user.id, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { user, session, returnTo: completed.returnTo };
}

export function refreshSession(refreshToken: string): LoginResult {
  if (!refreshToken) {
    throw new AuthError(
      'missing_refresh_token',
      'Refresh token is required',
      401,
    );
  }

  const refreshHash = hashOpaqueToken(refreshToken);
  const current = getWebSessionByRefreshTokenHash(refreshHash);
  if (!current) {
    throw new AuthError(
      'invalid_refresh_token',
      'Refresh token is invalid',
      401,
    );
  }

  const user = getUserById(current.user_id);
  if (!user || user.is_active !== 1) {
    throw new AuthError(
      'invalid_refresh_token',
      'Refresh token is invalid',
      401,
    );
  }

  revokeWebSession(current.id);

  const session = createSessionForUser(user.id, {
    rotatedFrom: current.id,
    deviceId: current.device_id || undefined,
    ipAddress: current.ip_address || undefined,
    userAgent: current.user_agent || undefined,
  });

  return { user, session };
}

export function logoutSession(sessionId: string): void {
  revokeWebSessionChain(sessionId);
}

export function startDeviceAuthFlow(): DeviceStartResult {
  const deviceCode = randomOpaque(32);
  const userCode = randomUserCode();
  const expiresAt = new Date(
    Date.now() + DEVICE_CODE_TTL_SEC * 1000,
  ).toISOString();

  createDeviceAuthCode({
    id: crypto.randomUUID(),
    deviceCodeHash: hashOpaqueToken(deviceCode),
    userCodeHash: hashOpaqueToken(userCode),
    expiresAt,
  });

  return {
    deviceCode,
    userCode,
    verificationUri: '/api/v1/auth/device/complete',
    expiresInSec: DEVICE_CODE_TTL_SEC,
    intervalSec: 5,
  };
}

export function completeDeviceAuthFlow(input: {
  deviceCode: string;
  email: string;
  displayName?: string;
  ipAddress?: string;
  userAgent?: string;
}): LoginResult {
  const deviceCode = input.deviceCode?.trim();
  const email = input.email?.trim().toLowerCase();
  if (!deviceCode || !email) {
    throw new AuthError(
      'invalid_device_completion',
      'deviceCode and email are required',
      400,
    );
  }

  const row = getPendingDeviceAuthCodeByDeviceHash(hashOpaqueToken(deviceCode));
  if (!row) {
    throw new AuthError(
      'invalid_device_code',
      'Device code is invalid or expired',
      401,
    );
  }

  const displayName =
    input.displayName?.trim() || email.split('@')[0] || 'User';
  const user = resolveUserForLogin({ email, displayName });
  markDeviceAuthCodeCompleted({ id: row.id, userId: user.id });

  const session = createSessionForUser(user.id, {
    deviceId: `device:${row.id}`,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { user, session };
}

export function createInvite(input: {
  inviterUserId: string;
  role: 'admin' | 'member';
  email: string;
}): { inviteId: string; expiresAt: string } {
  const inviteId = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  createUserInvite({
    id: inviteId,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    invitedBy: input.inviterUserId,
    expiresAt,
  });
  return { inviteId, expiresAt };
}

function resolveUserForLogin(input: {
  email: string;
  displayName: string;
}): UserRecord {
  const normalizedEmail = input.email.trim().toLowerCase();

  const existing = getUserByEmail(normalizedEmail);
  if (existing) {
    if (existing.is_active !== 1) {
      throw new AuthError('user_inactive', 'Account is inactive', 403);
    }
    return existing;
  }

  const owner = getOwnerUser();
  if (!owner) {
    if (isPublicMode) {
      if (!INITIAL_OWNER_EMAIL || normalizedEmail !== INITIAL_OWNER_EMAIL) {
        throw new AuthError(
          'invite_required',
          'This email is not approved for this installation',
          403,
        );
      }
    }

    // Single-process runtime with synchronous better-sqlite3 keeps this
    // owner-claim path effectively serialized. Multi-instance hardening
    // (DB-level uniqueness/locking) is intentionally deferred.
    const userId = crypto.randomUUID();
    upsertUser({
      id: userId,
      email: normalizedEmail,
      displayName: input.displayName,
      role: 'owner',
    });
    const claimed = getUserById(userId);
    if (!claimed) {
      throw new AuthError(
        'owner_claim_failed',
        'Failed to claim owner account',
        500,
      );
    }
    return claimed;
  }

  const invite = getActiveInviteByEmail(normalizedEmail);
  if (!invite) {
    throw new AuthError(
      'invite_required',
      'This email is not approved for this installation',
      403,
    );
  }

  const userId = crypto.randomUUID();
  const role: UserRole = invite.role === 'admin' ? 'admin' : 'member';
  upsertUser({
    id: userId,
    email: normalizedEmail,
    displayName: input.displayName,
    role,
  });
  markInviteAccepted(invite.id);

  const invitedUser = getUserById(userId);
  if (!invitedUser) {
    throw new AuthError(
      'invite_accept_failed',
      'Failed to create invited user',
      500,
    );
  }
  return invitedUser;
}

function createSessionForUser(
  userId: string,
  input?: {
    rotatedFrom?: string;
    deviceId?: string;
    ipAddress?: string;
    userAgent?: string;
  },
): SessionMaterial {
  const sessionId = crypto.randomUUID();
  const accessToken = randomOpaque(32);
  const refreshToken = randomOpaque(32);
  const csrfToken = randomOpaque(16);

  const now = Date.now();
  const accessExpiresAt = new Date(
    now + ACCESS_TOKEN_TTL_SEC * 1000,
  ).toISOString();
  const refreshExpiresAt = new Date(
    now + REFRESH_TOKEN_TTL_SEC * 1000,
  ).toISOString();

  upsertWebSession({
    id: sessionId,
    userId,
    accessTokenHash: hashOpaqueToken(accessToken),
    refreshTokenHash: hashOpaqueToken(refreshToken),
    accessExpiresAt,
    expiresAt: refreshExpiresAt,
    rotatedFrom: input?.rotatedFrom,
    deviceId: input?.deviceId,
    ipAddress: input?.ipAddress,
    userAgent: input?.userAgent,
  });

  return {
    sessionId,
    accessToken,
    refreshToken,
    csrfToken,
    accessExpiresAt,
    refreshExpiresAt,
  };
}

function consumeOAuthState(state: string): {
  id: string;
  nonceHash: string;
  codeVerifier: string | null;
  redirectUri: string;
  returnTo: string | null;
} | null {
  const row = consumeOAuthStateByHash(hashOpaqueToken(state));
  if (!row) return null;
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    returnTo: row.return_to,
  };
}

function randomOpaque(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomUserCode(): string {
  return randomOpaque(6)
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}

function toCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

async function exchangeGoogleCodeForIdentity(input: {
  code: string;
  consumed: {
    id: string;
    nonceHash: string;
    codeVerifier: string | null;
    redirectUri: string;
  };
}): Promise<GoogleOAuthIdentity> {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new AuthError(
      'google_oauth_not_configured',
      'Google OAuth is not configured',
      503,
    );
  }
  if (!input.consumed.codeVerifier) {
    throw new AuthError(
      'invalid_state',
      'OAuth state is missing PKCE verifier',
      400,
    );
  }

  const tokenParams = new URLSearchParams({
    code: input.code,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: input.consumed.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.consumed.codeVerifier,
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: tokenParams,
  });
  if (!tokenRes.ok) {
    throw new AuthError(
      'google_token_exchange_failed',
      'Failed to exchange Google authorization code',
      401,
    );
  }

  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    id_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  };
  const idToken = tokenBody.id_token;
  if (!idToken) {
    throw new AuthError(
      'google_token_exchange_failed',
      'Google token response did not include id_token',
      401,
    );
  }

  const claims = decodeJwtPayload(idToken);
  const nonceClaim = readStringClaim(claims, 'nonce');
  if (!nonceClaim || hashOpaqueToken(nonceClaim) !== input.consumed.nonceHash) {
    throw new AuthError(
      'google_nonce_mismatch',
      'Google ID token nonce mismatch',
      401,
    );
  }

  const tokenInfoRes = await fetch(
    `${GOOGLE_TOKEN_INFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`,
  );
  if (!tokenInfoRes.ok) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token validation failed',
      401,
    );
  }
  const tokenInfo = (await tokenInfoRes.json()) as {
    iss?: string;
    aud?: string;
    exp?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
  };

  const issuer = tokenInfo.iss || readStringClaim(claims, 'iss');
  if (!issuer || !GOOGLE_ISSUERS.has(issuer)) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token issuer is invalid',
      401,
    );
  }

  const aud = tokenInfo.aud || readStringClaim(claims, 'aud');
  if (!aud || aud !== GOOGLE_OAUTH_CLIENT_ID) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token audience is invalid',
      401,
    );
  }

  const expRaw = tokenInfo.exp || readStringClaim(claims, 'exp');
  const expSeconds = expRaw ? parseInt(expRaw, 10) : Number.NaN;
  if (
    !Number.isFinite(expSeconds) ||
    expSeconds + CLOCK_SKEW_SEC <= Math.floor(Date.now() / 1000)
  ) {
    throw new AuthError(
      'google_id_token_expired',
      'Google ID token has expired',
      401,
    );
  }

  const email = (tokenInfo.email || readStringClaim(claims, 'email') || '')
    .trim()
    .toLowerCase();
  if (!email) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token does not include email',
      401,
    );
  }

  const emailVerified = tokenInfo.email_verified ?? claims.email_verified;
  if (!(emailVerified === true || emailVerified === 'true')) {
    throw new AuthError(
      'google_email_not_verified',
      'Google account email is not verified',
      403,
    );
  }

  const displayName = (
    tokenInfo.name ||
    readStringClaim(claims, 'name') ||
    email.split('@')[0] ||
    'User'
  ).trim();

  const googleSubject = readStringClaim(claims, 'sub') || '';
  if (!googleSubject) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token does not include subject',
      401,
    );
  }

  const accessToken = tokenBody.access_token || '';
  if (!accessToken) {
    throw new AuthError(
      'google_token_exchange_failed',
      'Google token response did not include access_token',
      401,
    );
  }

  return {
    googleSubject,
    email,
    displayName,
    accessToken,
    refreshToken: tokenBody.refresh_token || null,
    scopes:
      typeof tokenBody.scope === 'string'
        ? normalizeGoogleScopeAliases(
            tokenBody.scope
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
          )
        : [],
    tokenType:
      typeof tokenBody.token_type === 'string' ? tokenBody.token_type : null,
    accessExpiresAt:
      typeof tokenBody.expires_in === 'number' &&
      Number.isFinite(tokenBody.expires_in)
        ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString()
        : null,
  };
}

export async function completeGoogleOAuthIdentityCallback(input: {
  state: string;
  code?: string;
  email?: string;
  displayName?: string;
  requestedScopes?: string[];
}): Promise<{ identity: GoogleOAuthIdentity; returnTo?: string | null }> {
  if (!input.state) {
    throw new AuthError('invalid_state', 'Missing OAuth state', 400);
  }

  const consumed = consumeOAuthState(input.state);
  if (!consumed) {
    throw new AuthError(
      'invalid_state',
      'OAuth state is invalid or expired',
      400,
    );
  }

  if (input.code) {
    const identity = await exchangeGoogleCodeForIdentity({
      code: input.code,
      consumed,
    });
    return { identity, returnTo: consumed.returnTo };
  }

  const email = (input.email || '').trim().toLowerCase();
  if (!email) {
    if (!AUTH_DEV_MODE) {
      throw new AuthError(
        'authorization_code_required',
        'Missing authorization code',
        400,
      );
    }
    throw new AuthError(
      'email_required',
      'Dev mode callback requires email query parameter',
      400,
    );
  }

  const displayName =
    input.displayName?.trim() || email.split('@')[0] || 'User';
  const requestedScopes = normalizeGoogleScopeAliases(
    input.requestedScopes || [],
  );

  return {
    identity: {
      googleSubject: email,
      email,
      displayName,
      accessToken: 'dev-google-access-token',
      refreshToken: 'dev-google-refresh-token',
      scopes: requestedScopes,
      tokenType: 'Bearer',
      accessExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    },
    returnTo: consumed.returnTo,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token is malformed',
      401,
    );
  }

  try {
    return JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    throw new AuthError(
      'google_id_token_invalid',
      'Google ID token is malformed',
      401,
    );
  }
}

function readStringClaim(
  claims: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = claims[key];
  return typeof value === 'string' ? value : undefined;
}
