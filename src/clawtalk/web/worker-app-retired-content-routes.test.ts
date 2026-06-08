import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';

import { _resetWorkerAppForTests, getWorkerApp } from './worker-app.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'retired-content-routes-key';

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

function envForWorker(): Record<string, unknown> {
  return {
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_PUBLISHABLE_KEY: 'pk_test',
    JWKS_CACHE: fakeKv,
  };
}

async function mintJwt(): Promise<string> {
  return await new SignJWT({
    session_id: 'session-x',
    email: 'x@test.example',
  })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject('00000000-0000-0000-0000-0000000000aa')
    .setExpirationTime('1h')
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
});

beforeEach(() => {
  kvStore.clear();
  kvStore.set('supabase-jwks-v1', JSON.stringify({ keys: [publicJwk] }));
  _resetWorkerAppForTests();
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url) === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
      });
    }
    return new Response('not stubbed', { status: 599 });
  });
});

describe('worker-app retired flat-content compatibility routes', () => {
  it('falls through deleted flat-content routes to the worker catch-all', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const routeChecks = [
      {
        method: 'GET',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/content',
      },
      {
        method: 'POST',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/content',
      },
      {
        method: 'GET',
        path: '/api/v1/threads/10000000-0000-4000-8000-000000000aaa/content',
      },
      {
        method: 'POST',
        path: '/api/v1/threads/10000000-0000-4000-8000-000000000aaa/content',
      },
      {
        method: 'PATCH',
        path: '/api/v1/contents/10000000-0000-4000-8000-000000000aaa',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/10000000-0000-4000-8000-000000000aaa/edits/10000000-0000-4000-8000-000000000bbb/accept',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/10000000-0000-4000-8000-000000000aaa/edits/10000000-0000-4000-8000-000000000bbb/reject',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/10000000-0000-4000-8000-000000000aaa/runs/10000000-0000-4000-8000-000000000ccc/accept',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/10000000-0000-4000-8000-000000000aaa/runs/10000000-0000-4000-8000-000000000ccc/reject',
      },
    ] as const;

    for (const check of routeChecks) {
      const res = await app.request(
        new Request(`https://app.test${check.path}`, {
          method: check.method,
          headers: { authorization: `Bearer ${jwt}` },
        }),
        undefined,
        envForWorker(),
      );
      expect(res.status, `${check.method} ${check.path}`).toBe(501);
      const body = (await res.json()) as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(body.error?.code, `${check.method} ${check.path}`).toBe(
        'not_implemented_in_worker',
      );
    }
  });

  it('falls through deleted thread REST routes to the worker catch-all', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const routeChecks = [
      {
        method: 'GET',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/threads',
      },
      {
        method: 'POST',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/threads',
      },
      {
        method: 'PATCH',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/threads/10000000-0000-4000-8000-000000000bbb',
      },
      {
        method: 'DELETE',
        path: '/api/v1/talks/10000000-0000-4000-8000-000000000aaa/threads/10000000-0000-4000-8000-000000000bbb',
      },
    ] as const;

    for (const check of routeChecks) {
      const res = await app.request(
        new Request(`https://app.test${check.path}`, {
          method: check.method,
          headers: { authorization: `Bearer ${jwt}` },
        }),
        undefined,
        envForWorker(),
      );
      expect(res.status, `${check.method} ${check.path}`).toBe(501);
      const body = (await res.json()) as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(body.error?.code, `${check.method} ${check.path}`).toBe(
        'not_implemented_in_worker',
      );
    }
  });
});
