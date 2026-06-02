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

vi.mock('../../talks/source-ingestion.js', () => ({
  ingestUrlSource: vi.fn(async () => undefined),
}));

import { DEV_USER_ID } from '../middleware/auth.js';
import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withTrustedDbWrites,
  withRequestScopedDb,
  type AttachmentBucketLike,
  type AttachmentBucketObjectBody,
} from '../../../db.js';
import { logger } from '../../../logger.js';
import { ingestUrlSource } from '../../talks/source-ingestion.js';
import { updateGreenfieldContextSourceExtraction } from '../../talks/greenfield-context-accessors.js';
import { _resetWorkerAppForTests, getWorkerApp } from '../worker-app.js';
import type { AuthContext } from '../types.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  createGreenfieldTalkContextRuleRoute,
  createGreenfieldTalkContextSourceRoute,
  deleteGreenfieldTalkContextSourceRoute,
  deleteGreenfieldTalkStateEntryRoute,
  getGreenfieldTalkContextRoute,
  getGreenfieldTalkContextSourceContentRoute,
  getGreenfieldTalkStateRoute,
  patchGreenfieldTalkContextRuleRoute,
  patchGreenfieldTalkContextSourceRoute,
  retryGreenfieldTalkContextSourceRoute,
  setGreenfieldTalkGoalRoute,
  uploadGreenfieldTalkContextSourcePageImageRoute,
  uploadGreenfieldTalkContextSourceRoute,
} from './greenfield-context.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const USER_ID = '0c949494-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = '0c949494-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GUEST_USER_ID = '0c949494-cccc-cccc-cccc-cccccccccccc';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const JPEG_ALT = Buffer.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x01, 0x02, 0xff, 0xd9,
]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: `greenfield-context-${userId}`,
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

function makeMockBucket(): AttachmentBucketLike & {
  store: Map<string, { body: Buffer; contentType?: string }>;
} {
  const store = new Map<string, { body: Buffer; contentType?: string }>();
  return {
    store,
    async put(key, value, options) {
      const body =
        value instanceof ArrayBuffer
          ? Buffer.from(value)
          : ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.from(String(value));
      store.set(key, { body, contentType: options?.httpMetadata?.contentType });
      return { key, size: body.byteLength };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const buf = entry.body;
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
      const obj: AttachmentBucketObjectBody = {
        key,
        size: buf.byteLength,
        httpMetadata: entry.contentType
          ? { contentType: entry.contentType }
          : undefined,
        arrayBuffer: async () => ab,
      };
      return obj;
    },
    async delete(key) {
      store.delete(key);
    },
    async head(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { key, size: entry.body.byteLength };
    },
  };
}

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

async function deleteUsers(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces
    where owner_id in (
      ${USER_ID}::uuid,
      ${OTHER_USER_ID}::uuid,
      ${GUEST_USER_ID}::uuid,
      ${DEV_USER_ID}::uuid
    )
  `;
  await db`
    delete from auth.users
    where id in (
      ${USER_ID}::uuid,
      ${OTHER_USER_ID}::uuid,
      ${GUEST_USER_ID}::uuid,
      ${DEV_USER_ID}::uuid
    )
  `;
}

async function createTalkFixture(userId = USER_ID): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  const fixtureAuth = auth(userId);
  const me = await getGreenfieldMeRoute({ auth: fixtureAuth });
  if (!me.body.ok) throw new Error('Expected session route to succeed');
  const workspaceId = me.body.data.currentWorkspaceId;
  const agents = await listGreenfieldAgentsRoute({
    auth: fixtureAuth,
    workspaceId,
  });
  if (!agents.body.ok) throw new Error('Expected agents route to succeed');
  const created = await createGreenfieldTalkRoute({
    auth: fixtureAuth,
    workspaceId,
    body: {
      title: 'Context Talk',
      team: agents.body.data.agents.slice(0, 2).map((agent) => agent.id),
    },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id };
}

async function createAdditionalWorkspaceTalk(): Promise<{
  workspaceId: string;
  talkId: string;
}> {
  const db = getDbPg();
  const rows = await db<{ workspace_id: string; talk_id: string }[]>`
    with workspace as (
      insert into public.workspaces (name, owner_id)
      values ('Second Context Workspace', ${USER_ID}::uuid)
      returning id
    ),
    member as (
      insert into public.workspace_members (workspace_id, user_id, role)
      select id, ${USER_ID}::uuid, 'owner'
      from workspace
      returning workspace_id
    ),
    talk as (
      insert into public.talks (workspace_id, sort_order, title, created_by)
      select member.workspace_id, 0, 'Second Workspace Talk', ${USER_ID}::uuid
      from member
      returning workspace_id, id
    )
    select workspace_id, id as talk_id
    from talk
  `;
  const row = rows[0];
  if (!row) throw new Error('Expected additional workspace talk to be created');
  return { workspaceId: row.workspace_id, talkId: row.talk_id };
}

async function addGuestToWorkspace(workspaceId: string): Promise<void> {
  await seedAuthUser(GUEST_USER_ID, 'greenfield-context-guest@clawtalk.local');
  const db = getDbPg();
  await db`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${GUEST_USER_ID}::uuid, 'guest')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
}

function withBucket<T>(
  bucket: AttachmentBucketLike,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequestScopedDb(TEST_DB_URL, null, { ATTACHMENTS: bucket }, fn);
}

describe('greenfield context compatibility routes', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteUsers();
    await seedAuthUser(USER_ID, 'greenfield-context@clawtalk.local');
    await seedAuthUser(
      OTHER_USER_ID,
      'greenfield-context-other@clawtalk.local',
    );
    await seedAuthUser(DEV_USER_ID, 'greenfield-context-dev@clawtalk.local');
  });

  afterEach(() => {
    _resetWorkerAppForTests();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await deleteUsers();
    await closePgDatabase();
  });

  it('stores goal and house rules in context_sources', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const empty = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body.ok && empty.body.data).toMatchObject({
      goal: null,
      rules: [],
      sources: [],
    });

    const goal = await setGreenfieldTalkGoalRoute({
      auth: auth(),
      workspaceId,
      talkId,
      goalText: 'Keep the memo practical.',
    });
    expect(goal.statusCode).toBe(200);
    expect(goal.body.ok && goal.body.data.goal?.goalText).toBe(
      'Keep the memo practical.',
    );

    const rule = await createGreenfieldTalkContextRuleRoute({
      auth: auth(),
      workspaceId,
      talkId,
      ruleText: 'Cite context by source ref.',
    });
    expect(rule.statusCode).toBe(201);
    if (!rule.body.ok) throw new Error('Expected rule create to succeed');

    const patched = await patchGreenfieldTalkContextRuleRoute({
      auth: auth(),
      workspaceId,
      talkId,
      ruleId: rule.body.data.rule.id,
      ruleText: 'Cite specific source refs.',
      isActive: false,
      sortOrder: 7,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.ok && patched.body.data.rule).toMatchObject({
      ruleText: 'Cite specific source refs.',
      isActive: false,
      sortOrder: 7,
    });

    const context = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(context.body.ok && context.body.data.goal?.goalText).toBe(
      'Keep the memo practical.',
    );
    expect(context.body.ok && context.body.data.rules).toHaveLength(1);
    expect(context.body.ok && context.body.data.sources).toHaveLength(0);

    const rows = await getDbPg()<
      {
        kind: string;
        compat_kind: string | null;
        include_in_prompt: boolean;
      }[]
    >`
      select kind, meta_json->>'compatKind' as compat_kind, include_in_prompt
      from public.context_sources
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
      order by sort_order asc nulls last
    `;
    expect(rows).toEqual([
      { kind: 'rule', compat_kind: 'goal', include_in_prompt: true },
      { kind: 'rule', compat_kind: 'rule', include_in_prompt: false },
    ]);

    const cleared = await setGreenfieldTalkGoalRoute({
      auth: auth(),
      workspaceId,
      talkId,
      goalText: '   ',
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.ok && cleared.body.data.goal).toBeNull();
    const afterClear = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(afterClear.body.ok && afterClear.body.data.goal).toBeNull();
  });

  it('serves text and URL sources from greenfield context rows', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const text = await createGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceType: 'text',
      title: 'Launch notes',
      extractedText: 'First line\nSecond line',
    });
    expect(text.statusCode).toBe(201);
    if (!text.body.ok) throw new Error('Expected text source to succeed');
    expect(text.body.data.source).toMatchObject({
      sourceRef: 'S1',
      sourceType: 'text',
      status: 'ready',
      extractedTextLength: 22,
    });

    const content = await getGreenfieldTalkContextSourceContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: text.body.data.source.id,
    });
    expect(content.statusCode).toBe(200);
    if ('headers' in content) {
      expect(content.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(content.body).toBe('First line\nSecond line');
    }

    const patched = await patchGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: text.body.data.source.id,
      title: 'Edited notes',
      extractedText: 'Updated source text',
      sortOrder: 5,
    });
    expect(patched.body.ok && patched.body.data.source).toMatchObject({
      title: 'Edited notes',
      sortOrder: 5,
      extractedTextLength: 19,
    });

    const url = await createGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceType: 'url',
      title: 'External brief',
      sourceUrl: 'https://example.com/brief',
    });
    expect(url.statusCode).toBe(201);
    if (!url.body.ok) throw new Error('Expected url source to succeed');
    const urlSourceId = url.body.data.source.id;
    expect(url.body.data.source).toMatchObject({
      sourceRef: 'S2',
      sourceType: 'url',
      status: 'pending',
      sourceUrl: 'https://example.com/brief',
    });

    const retry = await retryGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: urlSourceId,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.body.ok && retry.body.data.source.status).toBe('pending');

    await updateGreenfieldContextSourceExtraction({
      workspaceId,
      talkId,
      sourceId: urlSourceId,
      extractedText: null,
      extractionError: null,
      fetchStrategy: 'http',
    });
    const afterEmptyExtraction = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(
      afterEmptyExtraction.body.ok &&
        afterEmptyExtraction.body.data.sources.find(
          (source) => source.id === urlSourceId,
        ),
    ).toMatchObject({
      status: 'failed',
      extractionError: 'No extracted text returned.',
    });

    await updateGreenfieldContextSourceExtraction({
      workspaceId,
      talkId,
      sourceId: urlSourceId,
      extractedText: 'Cached URL body',
      extractionError: null,
      mimeType: 'text/html',
      fetchStrategy: 'http',
    });
    const patchedUrl = await patchGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: urlSourceId,
      title: 'External brief v2',
    });
    expect(patchedUrl.body.ok && patchedUrl.body.data.source).toMatchObject({
      title: 'External brief v2',
      extractedTextLength: 15,
    });
    const invalidUrlTextPatch = await patchGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: urlSourceId,
      extractedText: 'Should not replace URL cache',
    });
    expect(invalidUrlTextPatch.statusCode).toBe(400);
    expect(
      invalidUrlTextPatch.body.ok ? null : invalidUrlTextPatch.body.error.code,
    ).toBe('source_content_not_editable');
    const urlContent = await getGreenfieldTalkContextSourceContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: urlSourceId,
    });
    expect(urlContent.statusCode).toBe(200);
    if ('headers' in urlContent) {
      expect(urlContent.body).toBe('Cached URL body');
    }
    const retryAfterReady = await retryGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceId: urlSourceId,
    });
    expect(
      retryAfterReady.body.ok && retryAfterReady.body.data.source.status,
    ).toBe('pending');
    await updateGreenfieldContextSourceExtraction({
      workspaceId,
      talkId,
      sourceId: url.body.data.source.id,
      extractedText: null,
      extractionError: 'refetch failed',
      fetchStrategy: 'http',
    });
    const afterFailedRetry = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(
      afterFailedRetry.body.ok &&
        afterFailedRetry.body.data.sources.find(
          (source) => source.id === urlSourceId,
        ),
    ).toMatchObject({
      status: 'ready',
      extractionError: 'refetch failed',
    });

    const rows = await getDbPg()<
      {
        kind: string;
        source_type: string | null;
        payload_ref: string | null;
      }[]
    >`
      select kind, meta_json->>'sourceType' as source_type, payload_ref
      from public.context_sources
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
      order by created_at asc
    `;
    expect(rows).toEqual([
      { kind: 'file', source_type: 'text', payload_ref: null },
      {
        kind: 'url',
        source_type: 'url',
        payload_ref: 'https://example.com/brief',
      },
    ]);
  });

  it('allocates source refs after fallback-only greenfield sources', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const db = getDbPg();
    await db`
      insert into public.context_sources (
        workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${workspaceId}::uuid,
        ${talkId}::uuid,
        'file',
        'Pre-compat source',
        'Existing source without a stored sourceRef.',
        ${db.json({ compatKind: 'source', sourceType: 'text' } as never)},
        true,
        0,
        ${USER_ID}::uuid
      )
    `;

    const created = await createGreenfieldTalkContextSourceRoute({
      auth: auth(),
      workspaceId,
      talkId,
      sourceType: 'text',
      title: 'New source',
      extractedText: 'New content',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.ok && created.body.data.source.sourceRef).toBe('S2');

    const context = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(
      context.body.ok &&
        context.body.data.sources.map((source) => source.sourceRef),
    ).toEqual(['S1', 'S2']);
  });

  it('resolves context routes by talk id when the workspace header is omitted', async () => {
    const defaultTalk = await createTalkFixture();
    const secondTalk = await createAdditionalWorkspaceTalk();

    const empty = await getGreenfieldTalkContextRoute({
      auth: auth(),
      talkId: secondTalk.talkId,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body.ok && empty.body.data.sources).toEqual([]);

    const created = await createGreenfieldTalkContextSourceRoute({
      auth: auth(),
      talkId: secondTalk.talkId,
      sourceType: 'text',
      title: 'Second workspace note',
      extractedText: 'Second workspace content',
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected source create to succeed');
    expect(created.body.data.source).toMatchObject({
      sourceRef: 'S1',
      title: 'Second workspace note',
    });

    const content = await getGreenfieldTalkContextSourceContentRoute({
      auth: auth(),
      talkId: secondTalk.talkId,
      sourceId: created.body.data.source.id,
    });
    expect(content.statusCode).toBe(200);
    if ('headers' in content) {
      expect(content.body).toBe('Second workspace content');
    }

    const wrongWorkspace = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId: defaultTalk.workspaceId,
      talkId: secondTalk.talkId,
    });
    expect(wrongWorkspace.statusCode).toBe(404);
    expect(secondTalk.workspaceId).not.toBe(defaultTalk.workspaceId);
  });

  it('denies context read, mutation, and raw content outside workspace membership', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const bucket = makeMockBucket();
    const uploaded = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'private.txt',
          data: Buffer.from('workspace private file'),
          type: 'text/plain',
        },
      }),
    );
    expect(uploaded.statusCode).toBe(201);
    if (!uploaded.body.ok) throw new Error('Expected upload to succeed');
    const sourceId = uploaded.body.data.source.id;

    const deniedRead = await getGreenfieldTalkContextRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
    });
    expect(deniedRead.statusCode).toBe(403);
    expect(deniedRead.body.ok).toBe(false);

    const deniedCreate = await createGreenfieldTalkContextSourceRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      sourceType: 'text',
      title: 'Cross-tenant write',
      extractedText: 'Should not be stored.',
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedDelete = await deleteGreenfieldTalkContextSourceRoute({
      auth: auth(OTHER_USER_ID),
      workspaceId,
      talkId,
      sourceId,
    });
    expect(deniedDelete.statusCode).toBe(403);

    const deniedContent = await withBucket(bucket, () =>
      getGreenfieldTalkContextSourceContentRoute({
        auth: auth(OTHER_USER_ID),
        workspaceId,
        talkId,
        sourceId,
      }),
    );
    expect(deniedContent.statusCode).toBe(403);
  });

  it('allows guest context reads and denies context writes with structured errors', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    await addGuestToWorkspace(workspaceId);
    const guest = auth(GUEST_USER_ID);

    const read = await getGreenfieldTalkContextRoute({
      auth: guest,
      workspaceId,
      talkId,
    });
    expect(read.statusCode).toBe(200);
    expect(read.body.ok && read.body.data.sources).toEqual([]);

    for (const result of [
      await setGreenfieldTalkGoalRoute({
        auth: guest,
        workspaceId,
        talkId,
        goalText: 'Guest goal',
      }),
      await createGreenfieldTalkContextRuleRoute({
        auth: guest,
        workspaceId,
        talkId,
        ruleText: 'Guest rule',
      }),
      await createGreenfieldTalkContextSourceRoute({
        auth: guest,
        workspaceId,
        talkId,
        sourceType: 'text',
        title: 'Guest source',
        extractedText: 'Guest text',
      }),
      await deleteGreenfieldTalkStateEntryRoute({
        auth: guest,
        workspaceId,
        talkId,
        key: 'guest.key',
      }),
    ]) {
      expect(result.statusCode).toBe(403);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'workspace_writer_required' },
      });
    }

    const bucket = makeMockBucket();
    const deniedUpload = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: guest,
        workspaceId,
        talkId,
        file: {
          name: 'guest.txt',
          data: Buffer.from('guest upload'),
          type: 'text/plain',
        },
      }),
    );
    expect(deniedUpload.statusCode).toBe(403);
    expect(deniedUpload.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_writer_required' },
    });
    expect(bucket.store.size).toBe(0);

    const db = getDbPg();
    const [rows] = await db<Array<{ count: number }>>`
      select count(*)::int as count
      from public.context_sources
      where workspace_id = ${workspaceId}::uuid
        and talk_id = ${talkId}::uuid
    `;
    expect(rows).toEqual({ count: 0 });
  });

  it('schedules URL ingestion from the HTTP mount in a fresh DB scope', async () => {
    vi.stubEnv('CLAWTALK_DEV_STUB_ENABLED', 'true');
    const { workspaceId, talkId } = await createTalkFixture(DEV_USER_ID);
    const waitUntilCalls: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilCalls.push(promise);
      },
    };
    vi.mocked(ingestUrlSource).mockImplementationOnce(
      async (sourceId, _sourceUrl, deps) => {
        await deps?.updateExtraction?.({
          sourceId,
          extractedText: 'Scheduled body',
          extractionError: null,
          mimeType: 'text/html',
          fetchStrategy: 'http',
        });
      },
    );

    const app = getWorkerApp();
    const response = await app.request(
      new Request(`https://app.test/api/v1/talks/${talkId}/context/sources`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workspace-id': workspaceId,
        },
        body: JSON.stringify({
          sourceType: 'url',
          title: 'Scheduled URL',
          sourceUrl: 'https://example.com/scheduled',
        }),
      }),
      undefined,
      { DB: { connectionString: TEST_DB_URL } },
      executionCtx as never,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data?: { source: { id: string } };
    };
    expect(body.ok).toBe(true);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);
    expect(ingestUrlSource).toHaveBeenCalledWith(
      body.data?.source.id,
      'https://example.com/scheduled',
      expect.objectContaining({ updateExtraction: expect.any(Function) }),
    );
    const context = await getGreenfieldTalkContextRoute({
      auth: auth(DEV_USER_ID),
      workspaceId,
      talkId,
    });
    expect(context.body.ok && context.body.data.sources[0]).toMatchObject({
      status: 'ready',
      extractedTextLength: 14,
    });
  });

  it('uploads files, PDF page images, and cleans R2 objects on delete', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const bucket = makeMockBucket();
    const uploaded = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'brief.txt',
          data: Buffer.from('plain file body'),
          type: 'text/plain',
        },
      }),
    );
    expect(uploaded.statusCode).toBe(201);
    if (!uploaded.body.ok) throw new Error('Expected upload to succeed');
    expect(uploaded.body.data.source).toMatchObject({
      sourceType: 'file',
      status: 'ready',
      fileName: 'brief.txt',
      fileSize: 15,
    });

    const fileContent = await withBucket(bucket, () =>
      getGreenfieldTalkContextSourceContentRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: uploaded.body.ok ? uploaded.body.data.source.id : '',
      }),
    );
    expect(fileContent.statusCode).toBe(200);
    if ('headers' in fileContent) {
      expect(fileContent.headers['content-type']).toBe('text/plain');
      expect(Buffer.isBuffer(fileContent.body)).toBe(true);
      expect(fileContent.body.toString()).toBe('plain file body');
    }

    const pdf = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'deck.pdf',
          data: Buffer.from('%PDF-1.4\nnot a real pdf'),
          type: 'application/pdf',
        },
      }),
    );
    expect(pdf.statusCode).toBe(201);
    if (!pdf.body.ok) throw new Error('Expected pdf upload to succeed');
    expect(pdf.body.data.source.mimeType).toBe('application/pdf');
    if (pdf.body.data.source.status === 'failed') {
      expect(pdf.body.data.source.extractedAt).toBeNull();
    }

    const invalidPage = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '0',
        total: '1',
        data: PNG,
      }),
    );
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.body.ok).toBe(false);

    const page0 = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '0',
        total: '2',
        data: JPEG,
      }),
    );
    expect(page0.body.ok && page0.body.data).toEqual({
      uploaded: 1,
      expected: 2,
      complete: false,
    });
    const duplicatePage0 = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '0',
        total: '2',
        data: JPEG,
      }),
    );
    expect(duplicatePage0.body.ok && duplicatePage0.body.data).toEqual({
      uploaded: 1,
      expected: 2,
      complete: false,
    });
    const outOfRangePage = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '2',
        total: '2',
        data: JPEG,
      }),
    );
    expect(outOfRangePage.statusCode).toBe(400);
    const mismatchedTotal = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '0',
        total: '1',
        data: JPEG,
      }),
    );
    expect(mismatchedTotal.statusCode).toBe(409);
    const page1 = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId: pdf.body.ok ? pdf.body.data.source.id : '',
        index: '1',
        total: '2',
        data: JPEG,
      }),
    );
    expect(page1.body.ok && page1.body.data.complete).toBe(true);

    const context = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(
      context.body.ok &&
        context.body.data.sources.find(
          (source) => pdf.body.ok && source.id === pdf.body.data.source.id,
        ),
    ).toMatchObject({
      expectedPageCount: 2,
      pageImageCount: 2,
      pageSetComplete: true,
    });

    const sourceId = pdf.body.data.source.id;
    const originalKey = `attachments/${talkId}/${sourceId}.pdf`;
    expect(bucket.store.has(originalKey)).toBe(true);
    expect(
      bucket.store.has(`attachments/${talkId}/${sourceId}/page-0.jpg`),
    ).toBe(true);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let deleted: Awaited<
      ReturnType<typeof deleteGreenfieldTalkContextSourceRoute>
    > | null = null;
    try {
      deleted = await withBucket(bucket, () =>
        deleteGreenfieldTalkContextSourceRoute({
          auth: auth(),
          workspaceId,
          talkId,
          sourceId,
        }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(deleted?.statusCode).toBe(200);
    expect(bucket.store.has(originalKey)).toBe(false);
    expect(
      bucket.store.has(`attachments/${talkId}/${sourceId}/page-0.jpg`),
    ).toBe(false);
    expect(
      bucket.store.has(`attachments/${talkId}/${sourceId}/page-1.jpg`),
    ).toBe(false);
  });

  it('treats source R2 cleanup as best effort after deleting source metadata', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const bucket = makeMockBucket();

    const pdf = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'cleanup.pdf',
          data: Buffer.from('%PDF-1.4\ncleanup'),
          type: 'application/pdf',
        },
      }),
    );
    expect(pdf.statusCode).toBe(201);
    if (!pdf.body.ok) throw new Error('Expected pdf upload to succeed');

    const sourceId = pdf.body.data.source.id;
    const fileKey = `attachments/${talkId}/${sourceId}.pdf`;
    const pageKey = `attachments/${talkId}/${sourceId}/page-0.jpg`;
    const page = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId,
        index: '0',
        total: '1',
        data: JPEG,
      }),
    );
    expect(page.statusCode).toBe(201);
    expect(bucket.store.has(fileKey)).toBe(true);
    expect(bucket.store.has(pageKey)).toBe(true);

    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = vi.fn(async (key: string) => {
      if (key === fileKey) throw new Error('simulated r2 file delete failure');
      await originalDelete(key);
    });

    const deleted = await withBucket(bucket, () =>
      deleteGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId,
      }),
    );
    expect(deleted.statusCode).toBe(200);
    expect(bucket.store.has(fileKey)).toBe(true);
    expect(bucket.store.has(pageKey)).toBe(false);

    const context = await getGreenfieldTalkContextRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(
      context.body.ok &&
        context.body.data.sources.some((source) => source.id === sourceId),
    ).toBe(false);
  });

  it('cleans up a saved page image when page metadata insert fails', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const bucket = makeMockBucket();

    const pdf = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'orphan.pdf',
          data: Buffer.from('%PDF-1.4\norphan'),
          type: 'application/pdf',
        },
      }),
    );
    expect(pdf.statusCode).toBe(201);
    if (!pdf.body.ok) throw new Error('Expected pdf upload to succeed');

    const sourceId = pdf.body.data.source.id;
    const pageKey = `attachments/${talkId}/${sourceId}/page-0.jpg`;
    const originalPut = bucket.put.bind(bucket);
    bucket.put = vi.fn(async (key, value, options) => {
      const result = await originalPut(key, value, options);
      if (key === pageKey) {
        await withTrustedDbWrites(async () => {
          await getDbPg()`
            delete from public.context_sources
            where workspace_id = ${workspaceId}::uuid
              and talk_id = ${talkId}::uuid
              and id = ${sourceId}::uuid
          `;
        });
      }
      return result;
    });

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        withBucket(bucket, () =>
          uploadGreenfieldTalkContextSourcePageImageRoute({
            auth: auth(),
            workspaceId,
            talkId,
            sourceId,
            index: '0',
            total: '1',
            data: JPEG,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      consoleError.mockRestore();
    }
    expect(bucket.store.has(pageKey)).toBe(false);
  });

  it('treats duplicate page-image uploads as idempotent without rewriting R2 bytes', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const bucket = makeMockBucket();

    const pdf = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourceRoute({
        auth: auth(),
        workspaceId,
        talkId,
        file: {
          name: 'retry.pdf',
          data: Buffer.from('%PDF-1.4\nretry'),
          type: 'application/pdf',
        },
      }),
    );
    expect(pdf.statusCode).toBe(201);
    if (!pdf.body.ok) throw new Error('Expected pdf upload to succeed');

    const sourceId = pdf.body.data.source.id;
    const pageKey = `attachments/${talkId}/${sourceId}/page-0.jpg`;
    const firstUpload = await withBucket(bucket, () =>
      uploadGreenfieldTalkContextSourcePageImageRoute({
        auth: auth(),
        workspaceId,
        talkId,
        sourceId,
        index: '0',
        total: '1',
        data: JPEG,
      }),
    );
    expect(firstUpload.statusCode).toBe(201);
    expect(bucket.store.has(pageKey)).toBe(true);
    expect(bucket.store.get(pageKey)?.body.equals(JPEG)).toBe(true);

    const put = vi.spyOn(bucket, 'put');
    try {
      const duplicate = await withBucket(bucket, () =>
        uploadGreenfieldTalkContextSourcePageImageRoute({
          auth: auth(),
          workspaceId,
          talkId,
          sourceId,
          index: '0',
          total: '1',
          data: JPEG_ALT,
        }),
      );
      expect(duplicate.statusCode).toBe(201);
      expect(duplicate.body.ok && duplicate.body.data).toEqual({
        uploaded: 1,
        expected: 1,
        complete: true,
      });
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
    expect(bucket.store.get(pageKey)?.body.equals(JPEG)).toBe(true);
  });

  it('keeps the removed talk-state table as an empty compatibility surface', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const state = await getGreenfieldTalkStateRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(state.statusCode).toBe(200);
    expect(state.body.ok && state.body.data.entries).toEqual([]);

    const invalid = await deleteGreenfieldTalkStateEntryRoute({
      auth: auth(),
      workspaceId,
      talkId,
      key: 'bad key',
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await deleteGreenfieldTalkStateEntryRoute({
      auth: auth(),
      workspaceId,
      talkId,
      key: 'valid:key',
    });
    expect(missing.statusCode).toBe(404);
  });
});
