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

import { closePgDatabase, getDbPg, initPgDatabase } from '../../../db.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import { CLAWTALK_ALLOWED_ORIGINS } from '../../config.js';
import { ACCESS_TOKEN_COOKIE, CSRF_TOKEN_COOKIE } from '../cookies.js';
import { validateCsrfTokenPg } from '../middleware/csrf.js';
import { _resetWorkerAppForTests, getWorkerApp } from '../worker-app.js';
import type { AuthContext } from '../types.js';
import {
  createTalkGoogleDriveResourceRoute,
  deleteTalkResourceRoute,
  listTalkResourcesRoute,
} from './talk-resources.js';

const USER_ID = '0c666601-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ID = '0c666601-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MEMBER_ID = '0c666601-cccc-cccc-cccc-cccccccccccc';

const AUTH: AuthContext = {
  sessionId: 'session-a',
  userId: USER_ID,
  role: 'owner',
  authType: 'bearer',
};
const OTHER_AUTH: AuthContext = {
  sessionId: 'session-b',
  userId: OTHER_ID,
  role: 'owner',
  authType: 'bearer',
};
const MEMBER_AUTH: AuthContext = {
  sessionId: 'session-c',
  userId: MEMBER_ID,
  role: 'member',
  authType: 'bearer',
};

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${email}::text)
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteFixtureUsers(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (${USER_ID}::uuid, ${OTHER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
  await db`
    delete from auth.users
    where id in (${USER_ID}::uuid, ${OTHER_ID}::uuid, ${MEMBER_ID}::uuid)
  `;
}

async function createFixture(input?: { talkCreatorId?: string }): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  await seedAuthUser(USER_ID, 'resource-owner@clawtalk.local');
  await seedAuthUser(OTHER_ID, 'resource-other@clawtalk.local');
  await seedAuthUser(MEMBER_ID, 'resource-member@clawtalk.local');
  const workspaceId = await ensureWorkspaceBootstrapForUser(USER_ID);
  const db = getDbPg();
  const talkCreatorId = input?.talkCreatorId ?? USER_ID;
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${MEMBER_ID}::uuid, 'member')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
  const talkRows = await db<Array<{ id: string }>>`
    insert into public.talks (workspace_id, sort_order, title, created_by)
    values (${workspaceId}::uuid, 0, 'Resource Test Talk', ${talkCreatorId}::uuid)
    returning id
  `;
  return { workspaceId, talkId: talkRows[0]!.id };
}

beforeAll(async () => {
  await initPgDatabase();
});

afterAll(async () => {
  await deleteFixtureUsers();
  await closePgDatabase();
});

describe('greenfield talk resource compatibility routes', () => {
  beforeEach(async () => {
    await deleteFixtureUsers();
  });

  it('creates, lists, and deletes Drive resource bindings via connector_bindings', async () => {
    const { talkId } = await createFixture();

    const created = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'file-1',
        displayName: 'Launch Notes',
        metadata: { mimeType: 'application/vnd.google-apps.document' },
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('expected ok');
    expect(created.body.data.binding).toMatchObject({
      kind: 'google_drive_file',
      externalId: 'file-1',
      displayName: 'Launch Notes',
      metadata: { mimeType: 'application/vnd.google-apps.document' },
      createdBy: USER_ID,
    });

    const list = await listTalkResourcesRoute({ auth: AUTH, talkId });
    expect(list.statusCode).toBe(200);
    if (!list.body.ok) throw new Error('expected ok');
    expect(
      list.body.data.bindings.map((binding) => binding.externalId),
    ).toEqual(['file-1']);

    const dbRows = await getDbPg()<
      Array<{ service: string; target: string | null; surface: string | null }>
    >`
      select c.service, cb.target, cb.meta_json->>'compatSurface' as surface
      from public.connector_bindings cb
      join public.connectors c
        on c.workspace_id = cb.workspace_id
       and c.id = cb.connector_id
      where cb.id = ${created.body.data.binding.id}::uuid
    `;
    expect(dbRows[0]).toEqual({
      service: 'gdrive',
      target: 'file-1',
      surface: 'talk_resource',
    });

    const deleted = await deleteTalkResourceRoute({
      auth: AUTH,
      talkId,
      resourceId: created.body.data.binding.id,
    });
    expect(deleted.statusCode).toBe(200);
    const after = await listTalkResourcesRoute({ auth: AUTH, talkId });
    if (!after.body.ok) throw new Error('expected ok');
    expect(after.body.data.bindings).toHaveLength(0);
  });

  it('is idempotent for the same Talk target and supports multiple targets', async () => {
    const { talkId } = await createFixture();
    const first = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'same-file',
        displayName: 'First Name',
      },
    });
    const second = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'same-file',
        displayName: 'Second Name',
      },
    });
    const third = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_folder',
        externalId: 'folder-1',
        displayName: 'Folder',
      },
    });
    if (!first.body.ok || !second.body.ok || !third.body.ok) {
      throw new Error('expected ok');
    }
    expect(second.body.data.binding.id).toBe(first.body.data.binding.id);

    const list = await listTalkResourcesRoute({ auth: AUTH, talkId });
    if (!list.body.ok) throw new Error('expected ok');
    expect(
      list.body.data.bindings.map((binding) => binding.externalId).sort(),
    ).toEqual(['folder-1', 'same-file']);
  });

  it('lists only resources for the requested Talk', async () => {
    const { workspaceId, talkId } = await createFixture();
    const otherTalkRows = await getDbPg()<Array<{ id: string }>>`
      insert into public.talks (workspace_id, sort_order, title, created_by)
      values (${workspaceId}::uuid, 1, 'Sibling Resource Talk', ${USER_ID}::uuid)
      returning id
    `;
    const otherTalkId = otherTalkRows[0]!.id;

    const first = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'talk-a-file',
        displayName: 'Talk A File',
      },
    });
    const second = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId: otherTalkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'talk-b-file',
        displayName: 'Talk B File',
      },
    });
    if (!first.body.ok || !second.body.ok) throw new Error('seed failed');

    const listA = await listTalkResourcesRoute({ auth: AUTH, talkId });
    const listB = await listTalkResourcesRoute({
      auth: AUTH,
      talkId: otherTalkId,
    });
    if (!listA.body.ok || !listB.body.ok) throw new Error('expected ok');
    expect(
      listA.body.data.bindings.map((binding) => binding.externalId),
    ).toEqual(['talk-a-file']);
    expect(
      listB.body.data.bindings.map((binding) => binding.externalId),
    ).toEqual(['talk-b-file']);
  });

  it('keeps same-target resource bindings separate by editor and resource kind', async () => {
    const { workspaceId, talkId } = await createFixture();
    const db = getDbPg();
    await db`
      insert into public.workspace_members (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${OTHER_ID}::uuid, 'admin')
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `;

    const ownerFile = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'same-target',
        displayName: 'Owner File',
      },
    });
    const otherFile = await createTalkGoogleDriveResourceRoute({
      auth: OTHER_AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'same-target',
        displayName: 'Other File',
      },
    });
    const ownerFolder = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_folder',
        externalId: 'same-target',
        displayName: 'Owner Folder',
      },
    });
    if (!ownerFile.body.ok || !otherFile.body.ok || !ownerFolder.body.ok) {
      throw new Error('expected ok');
    }
    expect(
      new Set([
        ownerFile.body.data.binding.id,
        otherFile.body.data.binding.id,
        ownerFolder.body.data.binding.id,
      ]).size,
    ).toBe(3);

    const list = await listTalkResourcesRoute({ auth: AUTH, talkId });
    if (!list.body.ok) throw new Error('expected ok');
    expect(
      list.body.data.bindings.filter(
        (binding) => binding.externalId === 'same-target',
      ),
    ).toHaveLength(3);
  });

  it('blocks non-editor members from creating or deleting resource bindings', async () => {
    const { talkId } = await createFixture();
    const created = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'owner-file',
        displayName: 'Owner File',
      },
    });
    if (!created.body.ok) throw new Error('seed failed');

    const deniedCreate = await createTalkGoogleDriveResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'member-file',
        displayName: 'Member File',
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedDelete = await deleteTalkResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      resourceId: created.body.data.binding.id,
    });
    expect(deniedDelete.statusCode).toBe(403);

    const list = await listTalkResourcesRoute({ auth: AUTH, talkId });
    if (!list.body.ok) throw new Error('expected ok');
    expect(list.body.data.bindings).toHaveLength(1);
  });

  it('lets a member creator manage resource bindings on their Talk', async () => {
    const { talkId } = await createFixture({ talkCreatorId: MEMBER_ID });
    const created = await createTalkGoogleDriveResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'creator-file',
        displayName: 'Creator File',
      },
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('expected ok');

    const deleted = await deleteTalkResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      resourceId: created.body.data.binding.id,
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('blocks guest talk creators from resource mutations', async () => {
    const { workspaceId, talkId } = await createFixture({
      talkCreatorId: MEMBER_ID,
    });
    await getDbPg()`
      update public.workspace_members
      set role = 'guest'
      where workspace_id = ${workspaceId}::uuid
        and user_id = ${MEMBER_ID}::uuid
    `;

    const deniedCreate = await createTalkGoogleDriveResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'guest-file',
        displayName: 'Guest File',
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedDelete = await deleteTalkResourceRoute({
      auth: MEMBER_AUTH,
      talkId,
      resourceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(deniedDelete.statusCode).toBe(403);
  });

  it('blocks callers outside the Talk workspace', async () => {
    const { talkId } = await createFixture();
    const denied = await createTalkGoogleDriveResourceRoute({
      auth: OTHER_AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'private-file',
        displayName: 'Private File',
      },
    });
    expect([403, 404]).toContain(denied.statusCode);
  });

  it('rejects invalid resource payloads', async () => {
    const { talkId } = await createFixture();
    const invalidKind = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: { kind: 'gmail_message', externalId: 'x', displayName: 'Y' },
    });
    const invalidMetadata = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'x',
        displayName: 'Y',
        metadata: 'nope',
      },
    });
    const blankExternalId = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: '   ',
        displayName: 'Y',
      },
    });
    const blankDisplayName = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'x',
        displayName: '   ',
      },
    });
    expect(invalidKind.statusCode).toBe(400);
    expect(invalidMetadata.statusCode).toBe(400);
    expect(blankExternalId.statusCode).toBe(400);
    expect(blankDisplayName.statusCode).toBe(400);
  });

  it('returns stable 400s for malformed resource route UUID params', async () => {
    const { talkId } = await createFixture();

    const badList = await listTalkResourcesRoute({
      auth: AUTH,
      talkId: 'not-a-uuid',
    });
    expect(badList.statusCode).toBe(400);
    if (badList.body.ok) throw new Error('expected error');
    expect(badList.body.error.code).toBe('invalid_talk_id');

    const badCreate = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId: 'not-a-uuid',
      body: {
        kind: 'google_drive_file',
        externalId: 'file-1',
        displayName: 'File',
      },
    });
    expect(badCreate.statusCode).toBe(400);
    if (badCreate.body.ok) throw new Error('expected error');
    expect(badCreate.body.error.code).toBe('invalid_talk_id');

    const badDeleteResource = await deleteTalkResourceRoute({
      auth: AUTH,
      talkId,
      resourceId: 'not-a-uuid',
    });
    expect(badDeleteResource.statusCode).toBe(400);
    if (badDeleteResource.body.ok) throw new Error('expected error');
    expect(badDeleteResource.body.error.code).toBe('invalid_resource_id');

    const badDeleteTalk = await deleteTalkResourceRoute({
      auth: AUTH,
      talkId: 'not-a-uuid',
      resourceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(badDeleteTalk.statusCode).toBe(400);
    if (badDeleteTalk.body.ok) throw new Error('expected error');
    expect(badDeleteTalk.body.error.code).toBe('invalid_talk_id');
  });

  it('returns 404 when deleting a missing resource binding', async () => {
    const { talkId } = await createFixture();
    const missing = await deleteTalkResourceRoute({
      auth: AUTH,
      talkId,
      resourceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('does not delete a resource binding from a different Talk', async () => {
    const { workspaceId, talkId } = await createFixture();
    const db = getDbPg();
    const otherTalkRows = await db<Array<{ id: string }>>`
      insert into public.talks (workspace_id, sort_order, title, created_by)
      values (${workspaceId}::uuid, 1, 'Other Resource Talk', ${USER_ID}::uuid)
      returning id
    `;
    const otherTalkId = otherTalkRows[0]!.id;
    const otherBinding = await createTalkGoogleDriveResourceRoute({
      auth: AUTH,
      talkId: otherTalkId,
      body: {
        kind: 'google_drive_file',
        externalId: 'other-talk-file',
        displayName: 'Other Talk File',
      },
    });
    if (!otherBinding.body.ok) throw new Error('seed failed');

    const deleted = await deleteTalkResourceRoute({
      auth: AUTH,
      talkId,
      resourceId: otherBinding.body.data.binding.id,
    });
    expect(deleted.statusCode).toBe(404);

    const stillThere = await listTalkResourcesRoute({
      auth: AUTH,
      talkId: otherTalkId,
    });
    if (!stillThere.body.ok) throw new Error('expected ok');
    expect(stillThere.body.data.bindings).toHaveLength(1);
  });
});

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'talk-resources-test-key';
const VALID_ORIGIN = CLAWTALK_ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';

let privateKey: KeyLike;
let publicJwk: JWK;
const kvStore = new Map<string, string>();

type ErrorEnvelope = { ok: false; error: { code: string } };
type CreateResourceEnvelope = {
  ok: true;
  data: { binding: { id: string } };
};

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

async function mintJwt(sub: string): Promise<string> {
  return new SignJWT({ session_id: 'session-x', email: 'x@test.example' })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('worker-app integration — greenfield talk resources', () => {
  beforeAll(async () => {
    const kp = await generateKeyPair('ES256', { extractable: true });
    privateKey = kp.privateKey;
    publicJwk = await exportJWK(kp.publicKey);
    publicJwk.kid = KID;
    publicJwk.use = 'sig';
    publicJwk.alg = 'ES256';
  });

  beforeEach(async () => {
    await deleteFixtureUsers();
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

  afterAll(() => {
    vi.unstubAllGlobals();
    _resetWorkerAppForTests();
  });

  it('keeps /resources mounted behind auth and CSRF', async () => {
    const { talkId } = await createFixture();
    const app = getWorkerApp();
    const noAuth = await app.request(
      new Request(`https://app.test/api/v1/talks/${talkId}/resources`, {
        headers: { origin: VALID_ORIGIN },
      }),
      undefined,
      envForWorker(),
    );
    expect(noAuth.status).toBe(401);

    const jwt = await mintJwt(USER_ID);
    const authed = await app.request(
      new Request(`https://app.test/api/v1/talks/${talkId}/resources`, {
        headers: {
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
          origin: VALID_ORIGIN,
        },
      }),
      undefined,
      envForWorker(),
    );
    expect(authed.status).toBe(200);
  });

  it('keeps resource mutators behind auth and cookie CSRF', async () => {
    const { talkId } = await createFixture();
    const app = getWorkerApp();
    const url = `https://app.test/api/v1/talks/${talkId}/resources`;
    const body = JSON.stringify({
      kind: 'google_drive_file',
      externalId: 'worker-file',
      displayName: 'Worker File',
    });

    const noAuthPost = await app.request(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: VALID_ORIGIN,
        },
        body,
      }),
      undefined,
      envForWorker(),
    );
    expect(noAuthPost.status).toBe(401);

    const jwt = await mintJwt(USER_ID);
    const missingCsrfPost = await app.request(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
          origin: VALID_ORIGIN,
        },
        body,
      }),
      undefined,
      envForWorker(),
    );
    expect(missingCsrfPost.status).toBe(403);
    expect(((await missingCsrfPost.json()) as ErrorEnvelope).error.code).toBe(
      'csrf_failed',
    );

    const csrf = 'resource-csrf';
    const created = await app.request(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
          origin: VALID_ORIGIN,
          'x-csrf-token': csrf,
        },
        body,
      }),
      undefined,
      envForWorker(),
    );
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as CreateResourceEnvelope;
    expect(createdJson.ok).toBe(true);
    const resourceId = createdJson.data.binding.id;

    const noAuthDelete = await app.request(
      new Request(`${url}/${resourceId}`, {
        method: 'DELETE',
        headers: { origin: VALID_ORIGIN },
      }),
      undefined,
      envForWorker(),
    );
    expect(noAuthDelete.status).toBe(401);

    const missingCsrfDelete = await app.request(
      new Request(`${url}/${resourceId}`, {
        method: 'DELETE',
        headers: {
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}`,
          origin: VALID_ORIGIN,
        },
      }),
      undefined,
      envForWorker(),
    );
    expect(missingCsrfDelete.status).toBe(403);
    expect(((await missingCsrfDelete.json()) as ErrorEnvelope).error.code).toBe(
      'csrf_failed',
    );

    const deleted = await app.request(
      new Request(`${url}/${resourceId}`, {
        method: 'DELETE',
        headers: {
          cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}; ${CSRF_TOKEN_COOKIE}=${csrf}`,
          origin: VALID_ORIGIN,
          'x-csrf-token': csrf,
        },
      }),
      undefined,
      envForWorker(),
    );
    expect(deleted.status).toBe(200);
  });
});

describe('CSRF helper for resource mutators', () => {
  it('requires a matching double-submit token for cookie mutators', () => {
    expect(
      validateCsrfTokenPg({
        method: 'POST',
        authType: 'cookie',
        cookieHeader: 'eb_csrf=token-xyz',
        csrfHeader: undefined,
      }).ok,
    ).toBe(false);
    expect(
      validateCsrfTokenPg({
        method: 'DELETE',
        authType: 'cookie',
        cookieHeader: 'eb_csrf=token-xyz',
        csrfHeader: 'token-xyz',
      }).ok,
    ).toBe(true);
  });
});
