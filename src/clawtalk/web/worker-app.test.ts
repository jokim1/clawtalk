// clawtalk Phase 5 PR 2 — worker-app smoke tests.
//
// End-to-end exercise of the Hono app the Worker entry delegates to.
// Mints real ES256 JWTs against a stubbed JWKS, attaches them as
// the eb_at cookie, and asserts the auth-protected route reads back
// the verified userId. Mirrors the JWKS test setup.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';

import { getDbPg, initPgDatabase } from '../../db.js';
import { CLAWTALK_ALLOWED_ORIGINS } from '../config.js';
import { ACCESS_TOKEN_COOKIE, CSRF_TOKEN_COOKIE } from './cookies.js';
import { _resetWorkerAppForTests, getWorkerApp } from './worker-app.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'worker-app-key';
const VALID_ORIGIN = CLAWTALK_ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';
const VALID_JWT_SHAPE =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ' +
  '.eyJzdWIiOiJ4In0' +
  '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_RT = 'vlu4rmwiftyrabc123xyz';
const PROFILE_PATCH_USER_ID = '00000000-0000-4000-8000-0000000000bb';

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

function cookiePairFromSetCookie(setCookies: string[], name: string): string {
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} Set-Cookie header`);
  const [pair] = cookie.split(';', 1);
  return pair ?? '';
}

async function deleteProfilePatchUser(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.settings_kv
    where updated_by = ${PROFILE_PATCH_USER_ID}::uuid
       or value in (
         select a.id::text
         from public.agents a
         join public.workspaces w on w.id = a.workspace_id
         where w.owner_id = ${PROFILE_PATCH_USER_ID}::uuid
       )
  `;
  await db`
    delete from public.workspaces
    where owner_id = ${PROFILE_PATCH_USER_ID}::uuid
  `;
  await db`
    delete from auth.users
    where id = ${PROFILE_PATCH_USER_ID}::uuid
  `;
}

async function seedProfilePatchUser(): Promise<{
  defaultWorkspaceId: string;
  selectedWorkspaceId: string;
}> {
  const db = getDbPg();
  await deleteProfilePatchUser();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${PROFILE_PATCH_USER_ID}::uuid,
      'profile-patch@test.example',
      jsonb_build_object('full_name', 'Profile Patch User')
    )
  `;
  const bootstrapped = await db<Array<{ workspace_id: string }>>`
    select public.ensure_user_workspace_bootstrap(${PROFILE_PATCH_USER_ID}::uuid) as workspace_id
  `;
  const secondary = await db<Array<{ id: string }>>`
    insert into public.workspaces (name, owner_id)
    values ('Selected Workspace', ${PROFILE_PATCH_USER_ID}::uuid)
    returning id
  `;
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (
      ${secondary[0]!.id}::uuid,
      ${PROFILE_PATCH_USER_ID}::uuid,
      'admin'
    )
  `;
  return {
    defaultWorkspaceId: bootstrapped[0]!.workspace_id,
    selectedWorkspaceId: secondary[0]!.id,
  };
}

async function firstEnabledProviderModel(): Promise<{
  providerId: string;
  modelId: string;
}> {
  const db = getDbPg();
  const rows = await db<Array<{ provider_id: string; model_id: string }>>`
    select provider_id, model_id
    from public.llm_provider_models
    where enabled = true
    order by provider_id asc, model_id asc
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error('No enabled provider model is seeded.');
  return { providerId: row.provider_id, modelId: row.model_id };
}

async function enabledModelForProvider(providerId: string): Promise<string> {
  const db = getDbPg();
  const rows = await db<Array<{ model_id: string }>>`
    select model_id
    from public.llm_provider_models
    where provider_id = ${providerId}
      and enabled = true
    order by model_id asc
    limit 1
  `;
  const modelId = rows[0]?.model_id;
  if (!modelId)
    throw new Error(`No enabled model is seeded for ${providerId}.`);
  return modelId;
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
  // Prime the JWKS cache so verifyJwt doesn't have to fetch.
  kvStore.set('supabase-jwks-v1', JSON.stringify({ keys: [publicJwk] }));
  _resetWorkerAppForTests();
  vi.stubGlobal('fetch', async (url: string | URL) => {
    // The worker-app shouldn't reach the JWKS endpoint (cache primed),
    // but if it does, return a valid response so the test still drives.
    if (String(url) === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
      });
    }
    return new Response('not stubbed', { status: 599 });
  });
});

afterEach(async () => {
  await deleteProfilePatchUser();
  vi.unstubAllGlobals();
});

describe('worker-app — public routes', () => {
  it('GET /api/v1/health returns 200 with status ok', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/health'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { status: string; runtime: string; db: boolean };
    };
    expect(body).toMatchObject({
      ok: true,
      data: { status: 'ok', runtime: 'workers' },
    });
    expect(typeof body.data.db).toBe('boolean');
  });

  it('POST /api/v1/auth/callback sets eb_at/eb_rt/eb_csrf', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/auth/callback', {
        method: 'POST',
        headers: {
          origin: VALID_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accessToken: VALID_JWT_SHAPE,
          refreshToken: VALID_RT,
        }),
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(204);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies.some((c) => c.startsWith('eb_at='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_rt='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_csrf='))).toBe(true);
  });

  it('GET /api/v1/_unmapped returns 501 catch-all for unported routes', async () => {
    const app = getWorkerApp();
    // Use a chassis-removed path that hasn't (and won't) be mounted —
    // /api/v1/browser/* sits outside the auth-gated namespaces, so
    // the catch-all is the first matcher to fire.
    const res = await app.request(
      new Request('https://app.test/api/v1/browser/profiles'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_implemented_in_worker');
  });
});

describe('worker-app — auth-protected routes', () => {
  it('GET /api/v1/_protected/whoami returns userId when eb_at verifies', async () => {
    const app = getWorkerApp();
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const jwt = await mintJwt({ sub: userId });
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      data: { userId, authType: 'cookie', role: 'owner' },
    });
  });

  it('returns 401 with WWW-Authenticate: Bearer when eb_at is missing', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('returns 401 with expired challenge when eb_at is past exp', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt({ expSeconds: -60 });
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/expired/);
  });

  it('PATCH /api/v1/session/me preserves the requested workspace payload', async () => {
    const app = getWorkerApp();
    const { defaultWorkspaceId, selectedWorkspaceId } =
      await seedProfilePatchUser();
    expect(selectedWorkspaceId).not.toBe(defaultWorkspaceId);
    const jwt = await mintJwt({ sub: PROFILE_PATCH_USER_ID });

    const res = await app.request(
      new Request(
        `https://app.test/api/v1/session/me?workspaceId=${selectedWorkspaceId}`,
        {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ displayName: 'Renamed Profile User' }),
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data?: {
        user: { displayName: string };
        currentWorkspaceId: string;
        workspaces: Array<{ id: string }>;
      };
    };
    expect(body).toMatchObject({
      ok: true,
      data: {
        user: { displayName: 'Renamed Profile User' },
        currentWorkspaceId: selectedWorkspaceId,
      },
    });
    expect(body.data?.workspaces.map((workspace) => workspace.id)).toContain(
      selectedWorkspaceId,
    );
  });

  it('scopes registered-agent mutations and main-agent settings to the requested workspace', async () => {
    const app = getWorkerApp();
    const { defaultWorkspaceId, selectedWorkspaceId } =
      await seedProfilePatchUser();
    const jwt = await mintJwt({ sub: PROFILE_PATCH_USER_ID });
    const model = await firstEnabledProviderModel();

    async function createAgent(
      workspaceId: string,
      name: string,
    ): Promise<{
      id: string;
      name: string;
    }> {
      const res = await app.request(
        new Request(
          `https://app.test/api/v1/registered-agents?workspaceId=${workspaceId}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${jwt}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name,
              providerId: model.providerId,
              modelId: model.modelId,
            }),
          },
        ),
        undefined,
        envForWorker(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: { id: string; name: string };
      };
      expect(body.ok).toBe(true);
      return body.data;
    }

    const defaultAgent = await createAgent(
      defaultWorkspaceId,
      'Default Workspace Agent',
    );
    const selectedAgent = await createAgent(
      selectedWorkspaceId,
      'Selected Workspace Agent',
    );

    const crossWorkspaceUpdate = await app.request(
      new Request(
        `https://app.test/api/v1/registered-agents/${defaultAgent.id}?workspaceId=${selectedWorkspaceId}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'Cross Workspace Rename' }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(crossWorkspaceUpdate.status).toBe(404);

    const readDefaultAgent = await app.request(
      new Request(
        `https://app.test/api/v1/registered-agents/${defaultAgent.id}?workspaceId=${defaultWorkspaceId}`,
        { headers: { authorization: `Bearer ${jwt}` } },
      ),
      undefined,
      envForWorker(),
    );
    expect(readDefaultAgent.status).toBe(200);
    const readDefaultBody = (await readDefaultAgent.json()) as {
      data: { id: string; name: string };
    };
    expect(readDefaultBody.data).toMatchObject({
      id: defaultAgent.id,
      name: 'Default Workspace Agent',
    });

    for (const [workspaceId, agentId] of [
      [defaultWorkspaceId, defaultAgent.id],
      [selectedWorkspaceId, selectedAgent.id],
    ] as const) {
      const putMain = await app.request(
        new Request(
          `https://app.test/api/v1/registered-agents/main?workspaceId=${workspaceId}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${jwt}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ agentId }),
          },
        ),
        undefined,
        envForWorker(),
      );
      expect(putMain.status).toBe(200);
    }

    for (const [workspaceId, agentId] of [
      [defaultWorkspaceId, defaultAgent.id],
      [selectedWorkspaceId, selectedAgent.id],
    ] as const) {
      const getMain = await app.request(
        new Request(
          `https://app.test/api/v1/registered-agents/main?workspaceId=${workspaceId}`,
          { headers: { authorization: `Bearer ${jwt}` } },
        ),
        undefined,
        envForWorker(),
      );
      expect(getMain.status).toBe(200);
      const body = (await getMain.json()) as { data: { id: string } };
      expect(body.data.id).toBe(agentId);
    }
  });

  it('does not mark registered-agent direct HTTP preview ready from subscription-only credentials', async () => {
    const app = getWorkerApp();
    const { defaultWorkspaceId } = await seedProfilePatchUser();
    const jwt = await mintJwt({ sub: PROFILE_PATCH_USER_ID });
    const providerId = 'provider.openai';
    const modelId = await enabledModelForProvider(providerId);

    const createRes = await app.request(
      new Request(
        `https://app.test/api/v1/registered-agents?workspaceId=${defaultWorkspaceId}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Subscription Preview Agent',
            providerId,
            modelId,
          }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      data: { id: string };
    };

    const db = getDbPg();
    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext, encrypted_refresh_token
      )
      values (
        ${PROFILE_PATCH_USER_ID}::uuid,
        ${providerId},
        'subscription',
        'encrypted-access',
        'encrypted-refresh'
      )
    `;
    await db`
      insert into public.workspace_provider_secrets (
        workspace_id, provider_id, credential_kind, ciphertext, encrypted_refresh_token, updated_by
      )
      values (
        ${defaultWorkspaceId}::uuid,
        ${providerId},
        'subscription',
        'encrypted-workspace-access',
        'encrypted-workspace-refresh',
        ${PROFILE_PATCH_USER_ID}::uuid
      )
    `;

    const subscriptionOnlyRes = await app.request(
      new Request(
        `https://app.test/api/v1/registered-agents/${created.data.id}?workspaceId=${defaultWorkspaceId}`,
        { headers: { authorization: `Bearer ${jwt}` } },
      ),
      undefined,
      envForWorker(),
    );
    expect(subscriptionOnlyRes.status).toBe(200);
    const subscriptionOnly = (await subscriptionOnlyRes.json()) as {
      data: {
        executionPreview: {
          backend: string | null;
          authPath: string | null;
          ready: boolean;
          reasonCode: string | null;
        };
      };
    };
    expect(subscriptionOnly.data.executionPreview).toMatchObject({
      backend: null,
      authPath: null,
      ready: false,
      reasonCode: 'credential_missing',
    });

    await db`
      insert into public.llm_provider_secrets (
        owner_id, provider_id, credential_kind, ciphertext
      )
      values (
        ${PROFILE_PATCH_USER_ID}::uuid,
        ${providerId},
        'api_key',
        'encrypted-api-key'
      )
    `;

    const apiKeyRes = await app.request(
      new Request(
        `https://app.test/api/v1/registered-agents/${created.data.id}?workspaceId=${defaultWorkspaceId}`,
        { headers: { authorization: `Bearer ${jwt}` } },
      ),
      undefined,
      envForWorker(),
    );
    expect(apiKeyRes.status).toBe(200);
    const apiKeyReady = (await apiKeyRes.json()) as {
      data: {
        executionPreview: {
          backend: string | null;
          authPath: string | null;
          ready: boolean;
          reasonCode: string | null;
        };
      };
    };
    expect(apiKeyReady.data.executionPreview).toMatchObject({
      backend: 'direct_http',
      authPath: 'api_key',
      ready: true,
      reasonCode: null,
    });
  });

  it('returns 401 invalid when eb_at is junk', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=not-a-jwt` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });
});

describe('worker-app — chat enqueue mount (Queues port U2)', () => {
  it('POST /api/v1/talks/:talkId/chat is mounted (no longer 501)', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=csrf-chat`,
            'x-csrf-token': 'csrf-chat',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: 'hi' }),
        },
      ),
      undefined,
      envForWorker(),
    );
    // Route is mounted and reaches the greenfield chat handler, not
    // the 501 catch-all or a legacy-schema 500.
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('not_implemented_in_worker');
    expect(body.error?.code).not.toBe('internal_error');
  });

  it('POST /api/v1/talks/:talkId/chat returns 401 without auth', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'hi' }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/talks/:talkId/chat/cancel is mounted (no longer 501)', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-0000-0000-000000000aaa/chat/cancel',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=csrf-cancel`,
            'x-csrf-token': 'csrf-cancel',
            'content-type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('not_implemented_in_worker');
    expect(body.error?.code).not.toBe('internal_error');
  });

  it('POST /api/v1/talks/:talkId/chat rejects non-string content before dispatch', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-chat-content';
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            content: 42,
            targetAgentIds: [],
            attachmentIds: [],
          }),
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('message_required');
  });

  it('POST /api/v1/talks/:talkId/chat rejects non-string targetAgentIds before dispatch', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-chat-targets';
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            content: 'hi',
            targetAgentIds: [123],
          }),
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_target_agent_id');
  });

  it('POST /api/v1/talks/:talkId/chat rejects non-string attachmentIds before dispatch', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-chat-attachments';
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            content: 'hi',
            attachmentIds: [123],
          }),
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_attachment_id');
  });

  it('POST /api/v1/talks/:talkId/chat rejects nonempty attachmentIds as unavailable', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-chat-attachments-unavailable';
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/chat',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            content: 'hi',
            attachmentIds: ['00000000-0000-4000-8000-000000000abc'],
          }),
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('attachments_not_available');
  });
});

describe('worker-app — greenfield attachment guard', () => {
  it('POST /api/v1/talks/:talkId/attachments returns structured unavailable', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-attachments';
    const form = new FormData();
    form.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/attachments',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
          },
          body: form,
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('attachments_not_available');
  });

  it('DELETE /api/v1/talks/:talkId/attachments/:attachmentId returns structured unavailable', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-attachments-delete';

    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-4000-8000-000000000aaa/attachments/00000000-0000-4000-8000-000000000bbb',
        {
          method: 'DELETE',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
          },
        },
      ),
      undefined,
      envForWorker(),
    );

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('attachments_not_available');
  });
});

describe('worker-app — cookie auth CSRF guard', () => {
  it('rejects a non-tools cookie-auth mutation without CSRF before route handling', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request('https://app.test/api/v1/talks', {
        method: 'POST',
        headers: {
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Missing CSRF' }),
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('csrf_failed');
  });

  it('accepts the real eb_csrf cookie issued by auth callback on cookie-auth mutations', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const callback = await app.request(
      new Request('https://app.test/api/v1/auth/callback', {
        method: 'POST',
        headers: {
          origin: VALID_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accessToken: jwt,
          refreshToken: VALID_RT,
        }),
      }),
      undefined,
      envForWorker(),
    );
    expect(callback.status).toBe(204);
    const setCookies = callback.headers.getSetCookie();
    const accessPair = cookiePairFromSetCookie(setCookies, 'eb_at');
    const csrfPair = cookiePairFromSetCookie(setCookies, 'eb_csrf');
    const csrfValue = decodeURIComponent(csrfPair.split('=', 2)[1] ?? '');
    expect(csrfValue).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/10000000-0000-4000-8000-000000000aaa/tools',
        {
          method: 'PATCH',
          headers: {
            cookie: `${accessPair}; ${csrfPair}`,
            'x-csrf-token': csrfValue,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ family: 'web', enabled: true }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('csrf_failed');
  });
});

describe('worker-app — greenfield tools mount', () => {
  it('GET /api/v1/talks/:talkId/tools is mounted (no longer 501)', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/00000000-0000-0000-0000-000000000aaa/tools',
        {
          headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('not_implemented_in_worker');
    expect(body.error?.code).not.toBe('internal_error');
  });

  it('PATCH /api/v1/talks/:talkId/tools rejects cookie auth without CSRF', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/10000000-0000-4000-8000-000000000aaa/tools',
        {
          method: 'PATCH',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ family: 'web', enabled: true }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('csrf_failed');
  });

  it('PATCH /api/v1/talks/:talkId/tools lets bearer auth bypass CSRF', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/10000000-0000-4000-8000-000000000aaa/tools',
        {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ family: 'web', enabled: true }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('csrf_failed');
  });

  it('PATCH /api/v1/talks/:talkId/tools is mounted (no longer 501)', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const csrf = 'csrf-tools';
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/talks/10000000-0000-4000-8000-000000000aaa/tools',
        {
          method: 'PATCH',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ family: 'web', enabled: true }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('not_implemented_in_worker');
    expect(body.error?.code).not.toBe('internal_error');
  });
});

describe('worker-app — greenfield sidebar reorder mount', () => {
  it.each([
    [
      'itemType',
      {
        itemType: 'workspace',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex: 0,
      },
    ],
    [
      'itemId',
      {
        itemType: 'talk',
        itemId: '',
        destinationFolderId: null,
        destinationIndex: 0,
      },
    ],
    [
      'destinationFolderId',
      {
        itemType: 'talk',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: 123,
        destinationIndex: 0,
      },
    ],
    [
      'destinationIndex',
      {
        itemType: 'talk',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex: '0',
      },
    ],
    [
      'negative destinationIndex',
      {
        itemType: 'talk',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex: -1,
      },
    ],
    [
      'fractional destinationIndex',
      {
        itemType: 'talk',
        itemId: '10000000-0000-4000-8000-000000000aaa',
        destinationFolderId: null,
        destinationIndex: 1.5,
      },
    ],
  ])(
    'POST /api/v1/talks/sidebar/reorder keeps malformed %s payloads at structured 400',
    async (_caseName, payload) => {
      const app = getWorkerApp();
      const jwt = await mintJwt();
      const csrf = 'csrf-sidebar-reorder';
      const res = await app.request(
        new Request('https://app.test/api/v1/talks/sidebar/reorder', {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        }),
        undefined,
        envForWorker(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('invalid_sidebar_reorder');
    },
  );
});

describe('worker-app — greenfield content edit compatibility mount', () => {
  it('POST /api/v1/contents/:contentId/edits/:editId/accept is mounted', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/contents/10000000-0000-4000-8000-000000000aaa/edits/10000000-0000-4000-8000-000000000bbb/accept',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ expectedContentVersion: 1 }),
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).not.toBe(501);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('not_implemented_in_worker');
    expect(body.error?.code).not.toBe('internal_error');
  });

  it('POST /api/v1/contents/:contentId/runs/:runId/reject rejects cookie auth without CSRF', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt();
    const res = await app.request(
      new Request(
        'https://app.test/api/v1/contents/10000000-0000-4000-8000-000000000aaa/runs/10000000-0000-4000-8000-000000000ccc/reject',
        {
          method: 'POST',
          headers: {
            cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      ),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('csrf_failed');
  });
});
