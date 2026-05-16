// Worker → DurableObject upgrade forwarders for the W7 live-events
// feature.
//
// Two scopes:
//   - GET /api/v1/events                     — user-scope WS (cross-talk).
//   - GET /api/v1/talks/:talkId/events       — talk-scope WS.
//
// Both pre-flight auth (the surrounding middleware), validate scope
// (canUserAccessTalk for talk-scope, resolveThreadIdForTalk if a
// threadId qs is present), then clone the original `c.req.raw` so
// the handshake headers (Sec-WebSocket-Key/Version/Extensions) survive
// the forward (G9), strip cookie + CSRF, and set the x-clawtalk-*
// auth-pass-through headers. The DO handles the actual WS upgrade.
//
// The cap (F8) lives in the DO so a coordinated multi-tab burst
// can't race the Worker's count — Worker just translates 429 from
// the DO into 429 to the client.

import type { Context } from 'hono';

import { withUserContext } from '../../../db.js';
import {
  canUserAccessTalk,
  resolveThreadIdForTalk,
  TalkThreadValidationError,
} from '../../db/accessors.js';
import type { AuthContext } from '../types.js';

export interface UserEventHubBindings {
  USER_EVENT_HUB?: {
    idFromName(name: string): { readonly __brand: 'UserEventHubId' };
    get(id: { readonly __brand: 'UserEventHubId' }): {
      fetch(
        input: Request | URL | string,
        init?: RequestInit,
      ): Promise<Response>;
    };
  };
}

type RouteContext = Context<{
  Variables: { auth: AuthContext };
}>;

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * Extract the `exp` claim from the `eb_at` access-token cookie.
 *
 * The auth middleware already verified the cookie's signature + exp;
 * we only need the timestamp here so the DO can close hibernated
 * sockets when their JWT expires (R8). Decoding without verification
 * is safe — we trust the upstream verification.
 */
export function parseJwtExpFromCookie(cookieHeader: string | null): number {
  if (!cookieHeader) return 0;
  const cookies = cookieHeader.split(/;\s*/);
  let token: string | null = null;
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === 'eb_at') {
      token = c.slice(eq + 1).trim();
      break;
    }
  }
  if (!token) return 0;
  const parts = token.split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp : 0;
  } catch {
    return 0;
  }
}

function buildUpgradeRequest(input: {
  source: Request;
  headers: Record<string, string>;
}): Request {
  // G9: clone-and-mutate from c.req.raw so the WebSocket handshake
  // headers (Sec-WebSocket-Key/Version/Extensions) survive intact.
  const upgradeUrl = new URL(
    '/upgrade',
    new URL(input.source.url).origin,
  ).toString();
  const upgrade = new Request(upgradeUrl, input.source);
  upgrade.headers.delete('cookie');
  upgrade.headers.delete('x-csrf-token');
  for (const [k, v] of Object.entries(input.headers)) {
    upgrade.headers.set(k, v);
  }
  return upgrade;
}

function forwardToDo(
  c: RouteContext,
  upgrade: Request,
  userId: string,
): Promise<Response> {
  const env = c.env as UserEventHubBindings;
  if (!env.USER_EVENT_HUB) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'do_not_configured' },
        }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  const id = env.USER_EVENT_HUB.idFromName(userId);
  const stub = env.USER_EVENT_HUB.get(id);
  return stub.fetch(upgrade);
}

export async function userEventsUpgradeRoute(
  c: RouteContext,
): Promise<Response> {
  const auth = c.get('auth');
  const lastEventId = parsePositiveInt(c.req.query('lastEventId')) ?? 0;
  const jwtExp = parseJwtExpFromCookie(c.req.header('cookie') ?? null);

  const upgrade = buildUpgradeRequest({
    source: c.req.raw,
    headers: {
      'x-clawtalk-userid': auth.userId,
      'x-clawtalk-scope': 'user',
      'x-clawtalk-topic': `user:${auth.userId}`,
      'x-clawtalk-last-event-id': String(lastEventId),
      'x-clawtalk-jwt-exp': String(jwtExp),
    },
  });
  return forwardToDo(c, upgrade, auth.userId);
}

export async function talkEventsUpgradeRoute(
  c: RouteContext,
): Promise<Response> {
  const auth = c.get('auth');
  const talkId = c.req.param('talkId');
  if (!talkId) {
    return c.json({ ok: false, error: { code: 'invalid_talk_id' } }, 400);
  }

  const access = await withUserContext(auth.userId, () =>
    canUserAccessTalk(talkId),
  );
  if (!access) {
    return c.json({ ok: false, error: { code: 'not_found' } }, 404);
  }

  const requestedThreadId = (c.req.query('threadId') || '').trim() || null;
  let threadId: string | null = null;
  if (requestedThreadId) {
    try {
      threadId = await withUserContext(auth.userId, () =>
        resolveThreadIdForTalk({
          talkId,
          threadId: requestedThreadId,
          ownerId: auth.userId,
        }),
      );
    } catch (err) {
      if (err instanceof TalkThreadValidationError) {
        return c.json({ ok: false, error: { code: 'invalid_thread_id' } }, 400);
      }
      throw err;
    }
  }

  const lastEventId = parsePositiveInt(c.req.query('lastEventId')) ?? 0;
  const jwtExp = parseJwtExpFromCookie(c.req.header('cookie') ?? null);

  const upgrade = buildUpgradeRequest({
    source: c.req.raw,
    headers: {
      'x-clawtalk-userid': auth.userId,
      'x-clawtalk-scope': 'talk',
      'x-clawtalk-topic': `talk:${talkId}`,
      'x-clawtalk-talk-id': talkId,
      'x-clawtalk-thread-id': threadId ?? '',
      'x-clawtalk-last-event-id': String(lastEventId),
      'x-clawtalk-jwt-exp': String(jwtExp),
    },
  });
  return forwardToDo(c, upgrade, auth.userId);
}
