// Worker → DO upgrade-forward route tests.
//
// Uses the same JWT-minting fixture as worker-app.test.ts. Mocks
// USER_EVENT_HUB on env to capture the forwarded Request and inspect
// the headers + URL. Doesn't exercise the DO itself (that's U3); just
// the Worker-side clone+mutate flow.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';

import { initPgDatabase } from '../../../db.js';
import { CLAWTALK_ALLOWED_ORIGINS } from '../../config.js';
import { ACCESS_TOKEN_COOKIE } from '../cookies.js';
import { _resetWorkerAppForTests, getWorkerApp } from '../worker-app.js';
import { parseJwtExpFromCookie } from './events-upgrade.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'events-upgrade-test-key';
const VALID_ORIGIN = CLAWTALK_ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';

let privateKey: KeyLike;
let publicJwk: JWK;
const kvStore = new Map<string, string>();

const fakeKv = {
  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const val = kvStore.get(key);
    if (val === undefined) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  },
  async put(key: string, value: string): Promise<void> {
    kvStore.set(key, value);
  },
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  ownerId: string;
}

function makeMockEventHub(): {
  binding: unknown;
  captured: CapturedRequest[];
  response: { current: Response };
} {
  const captured: CapturedRequest[] = [];
  // Node's Response constructor rejects status 101 (reserved for WS
  // upgrades by the runtime). Use 200 as the test "DO returned
  // successfully" sentinel — the Worker pipes whatever the DO returns,
  // so the status is what the test inspects.
  const response = { current: new Response(null, { status: 200 }) };
  const binding = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: (id: never) => ({
      fetch: async (input: Request | URL | string) => {
        const req = input instanceof Request ? input : new Request(input);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        captured.push({
          url: req.url,
          headers,
          ownerId: (id as unknown as { __name: string }).__name,
        });
        return response.current;
      },
    }),
  };
  return { binding, captured, response };
}

function envForWorker(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_PUBLISHABLE_KEY: 'pk_test',
    JWKS_CACHE: fakeKv,
    ...extra,
  };
}

async function mintJwt(opts?: {
  sub?: string;
  expSeconds?: number;
}): Promise<string> {
  return await new SignJWT({
    session_id: 'session-x',
    email: 'x@test.example',
  })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject(opts?.sub ?? '00000000-0000-0000-0000-0000000000aa')
    .setExpirationTime(
      opts?.expSeconds === undefined
        ? '1h'
        : Math.floor(Date.now() / 1000) + opts.expSeconds,
    )
    .sign(privateKey);
}

beforeAll(async () => {
  await initPgDatabase();
  const kp = await generateKeyPair('ES256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
});

afterAll(async () => {
  _resetWorkerAppForTests();
});

beforeEach(() => {
  kvStore.clear();
  kvStore.set('supabase-jwks-v1', JSON.stringify({ keys: [publicJwk] }));
  _resetWorkerAppForTests();
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = url.toString();
    if (u === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
});

// ─── parseJwtExpFromCookie (pure) ─────────────────────────────────────

describe('parseJwtExpFromCookie', () => {
  it('returns 0 for null/empty cookie header', () => {
    expect(parseJwtExpFromCookie(null)).toBe(0);
    expect(parseJwtExpFromCookie('')).toBe(0);
  });

  it('returns 0 when eb_at cookie is missing', () => {
    expect(parseJwtExpFromCookie('foo=bar; eb_rt=zzz')).toBe(0);
  });

  it('extracts exp from a real signed JWT in the cookie', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setSubject('user-x')
      .setExpirationTime(exp)
      .sign(privateKey);
    expect(parseJwtExpFromCookie(`eb_at=${token}; eb_rt=...`)).toBe(exp);
  });

  it('returns 0 on malformed token', () => {
    expect(parseJwtExpFromCookie('eb_at=not-a-jwt')).toBe(0);
    expect(parseJwtExpFromCookie('eb_at=a.b.c')).toBe(0);
  });
});

// ─── /api/v1/events — user-scope ──────────────────────────────────────

describe('GET /api/v1/events (user-scope)', () => {
  it('returns 401 when eb_at is missing (auth middleware short-circuits before DO)', async () => {
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    const res = await app.request(
      '/api/v1/events',
      { headers: { origin: VALID_ORIGIN } },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it('forwards to DO with x-clawtalk-* headers; cookie+CSRF stripped (G9)', async () => {
    const sub = '00000000-0000-0000-0000-0000000000bb';
    const token = await mintJwt({ sub });
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    const res = await app.request(
      '/api/v1/events?lastEventId=42',
      {
        headers: {
          origin: VALID_ORIGIN,
          cookie: `${ACCESS_TOKEN_COOKIE}=${token}; eb_rt=xyz`,
          'x-csrf-token': 'should-be-stripped',
          upgrade: 'websocket',
          'sec-websocket-key': 'aGVsbG8=',
          'sec-websocket-version': '13',
          'sec-websocket-extensions': 'permessage-deflate',
        },
      },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(res.status).toBe(200); // mock DO sentinel; prod returns 101
    expect(captured).toHaveLength(1);
    const fwd = captured[0]!;
    expect(fwd.ownerId).toBe(sub);
    expect(fwd.url).toMatch(/\/upgrade$/);
    // x-clawtalk-* auth-pass-through headers set
    expect(fwd.headers['x-clawtalk-userid']).toBe(sub);
    expect(fwd.headers['x-clawtalk-scope']).toBe('user');
    expect(fwd.headers['x-clawtalk-topic']).toBe(`user:${sub}`);
    expect(fwd.headers['x-clawtalk-last-event-id']).toBe('42');
    expect(Number(fwd.headers['x-clawtalk-jwt-exp'])).toBeGreaterThan(0);
    // Cookie + CSRF stripped
    expect(fwd.headers['cookie']).toBeUndefined();
    expect(fwd.headers['x-csrf-token']).toBeUndefined();
    // WebSocket handshake headers survived
    expect(fwd.headers['upgrade']).toBe('websocket');
    expect(fwd.headers['sec-websocket-key']).toBe('aGVsbG8=');
    expect(fwd.headers['sec-websocket-version']).toBe('13');
    expect(fwd.headers['sec-websocket-extensions']).toBe('permessage-deflate');
  });

  it('overrides any client-supplied x-clawtalk-userid with the authenticated user', async () => {
    const sub = '00000000-0000-0000-0000-0000000000cc';
    const token = await mintJwt({ sub });
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    await app.request(
      '/api/v1/events',
      {
        headers: {
          origin: VALID_ORIGIN,
          cookie: `${ACCESS_TOKEN_COOKIE}=${token}`,
          'x-clawtalk-userid': 'spoofed-different-user',
        },
      },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(captured[0]!.headers['x-clawtalk-userid']).toBe(sub);
    expect(captured[0]!.ownerId).toBe(sub);
  });

  it('defaults lastEventId to 0 when not supplied', async () => {
    const token = await mintJwt();
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    await app.request(
      '/api/v1/events',
      {
        headers: {
          origin: VALID_ORIGIN,
          cookie: `${ACCESS_TOKEN_COOKIE}=${token}`,
        },
      },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(captured[0]!.headers['x-clawtalk-last-event-id']).toBe('0');
  });

  it('returns DO 429 unchanged when the cap fires (F8 cooperation)', async () => {
    const token = await mintJwt();
    const { binding, response } = makeMockEventHub();
    response.current = new Response('too many sockets', { status: 429 });
    const app = getWorkerApp();
    const res = await app.request(
      '/api/v1/events',
      {
        headers: {
          origin: VALID_ORIGIN,
          cookie: `${ACCESS_TOKEN_COOKIE}=${token}`,
        },
      },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(res.status).toBe(429);
  });
});

// ─── /api/v1/talks/:talkId/events — talk-scope ─────────────────────────

describe('GET /api/v1/talks/:talkId/events (talk-scope)', () => {
  it("returns 404 when canUserAccessTalk denies (e.g., talkId doesn't exist for this user)", async () => {
    const token = await mintJwt();
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    // Random UUID for a non-existent talk — canUserAccessTalk returns
    // false under RLS for the authenticated user.
    const res = await app.request(
      '/api/v1/talks/00000000-0000-0000-0000-0000000000ff/events',
      {
        headers: {
          origin: VALID_ORIGIN,
          cookie: `${ACCESS_TOKEN_COOKIE}=${token}`,
        },
      },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it('returns 401 when eb_at is missing', async () => {
    const { binding, captured } = makeMockEventHub();
    const app = getWorkerApp();
    const res = await app.request(
      '/api/v1/talks/abc/events',
      { headers: { origin: VALID_ORIGIN } },
      envForWorker({ USER_EVENT_HUB: binding }),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });
});
