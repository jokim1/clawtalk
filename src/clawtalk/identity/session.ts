import { hashOpaqueToken } from '../security/hash.js';

export const ACCESS_TOKEN_COOKIE = 'cr_access_token';
export const REFRESH_TOKEN_COOKIE = 'cr_refresh_token';
export const CSRF_TOKEN_COOKIE = 'cr_csrf_token';

export function hashSessionToken(token: string): string {
  return hashOpaqueToken(token);
}

export function parseCookieHeader(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
  }
  return cookies;
}
