import {
  CSRF_TOKEN_COOKIE,
  parseCookieHeader,
} from '../../identity/session.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function requiresCsrfValidation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function validateCsrfToken(input: {
  method: string;
  authType: 'cookie' | 'bearer';
  cookieHeader?: string;
  csrfHeader?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!requiresCsrfValidation(input.method)) return { ok: true };
  if (input.authType !== 'cookie') return { ok: true };

  // Double-submit CSRF is intentionally stateless: token equality between
  // non-httpOnly cookie and X-CSRF-Token header is the validation rule.
  // There is no server-side CSRF token store in this model.
  const cookies = parseCookieHeader(input.cookieHeader);
  const cookieToken = cookies[CSRF_TOKEN_COOKIE];
  if (!cookieToken) {
    return { ok: false, reason: 'Missing CSRF cookie' };
  }
  if (!input.csrfHeader) {
    return { ok: false, reason: 'Missing X-CSRF-Token header' };
  }
  if (cookieToken !== input.csrfHeader) {
    return { ok: false, reason: 'CSRF token mismatch' };
  }

  return { ok: true };
}
