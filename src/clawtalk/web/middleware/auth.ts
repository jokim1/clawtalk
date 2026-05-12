import { getWebSessionByAccessTokenHash, getUserById } from '../../db/index.js';
import {
  ACCESS_TOKEN_COOKIE,
  hashSessionToken,
  parseCookieHeader,
} from '../../identity/session.js';
import { AuthContext } from '../types.js';

export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

export function authenticateRequest(headers: {
  authorization?: string;
  cookie?: string;
}): AuthContext | null {
  const bearer = extractBearerToken(headers.authorization);
  if (bearer) {
    return resolveToken(bearer, 'bearer');
  }

  const cookies = parseCookieHeader(headers.cookie);
  const accessToken = cookies[ACCESS_TOKEN_COOKIE];
  if (!accessToken) return null;

  return resolveToken(accessToken, 'cookie');
}

function resolveToken(
  rawToken: string,
  authType: 'cookie' | 'bearer',
): AuthContext | null {
  const tokenHash = hashSessionToken(rawToken);
  const session = getWebSessionByAccessTokenHash(tokenHash);
  if (!session || session.revoked_at) return null;
  const accessExpiry = session.access_expires_at || session.expires_at;
  if (new Date(accessExpiry).getTime() <= Date.now()) return null;

  const user = getUserById(session.user_id);
  if (!user || !user.is_active) return null;

  return {
    sessionId: session.id,
    userId: user.id,
    role: user.role,
    authType,
  };
}
