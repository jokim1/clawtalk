// clawtalk Phase 5 (PR 2) — end-to-end test for accessors-pg (slice 1).
//
// Covers talks, folders, members, threads. Messages/runs/outbox/atomic
// ops are in subsequent slices; their own test files will land alongside.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db-pg.js';
import {
  canUserAccessTalk,
  canUserEditTalk,
  countRunningTalkRuns,
  createTalk,
  createTalkFolder,
  createTalkMessage,
  createTalkRun,
  createTalkThread,
  deleteTalkFolderAndMoveTalksToTopLevel,
  deleteTalkForOwner,
  deleteTalkMember,
  deleteTalkThread,
  getOrCreateDefaultThread,
  getRunningTalkRun,
  getTalkById,
  getTalkForUser,
  getTalkIdsAccessibleByUser,
  getTalkMessageById,
  getTalkRunById,
  getTalkRunSelectedMode,
  getTalkRunTaskType,
  hasActiveTalkRuns,
  listQueuedTalkRuns,
  listRunningTalkRuns,
  listTalkFoldersForOwner,
  listTalkMessages,
  listTalkRunsForTalk,
  listTalksForUser,
  listTalkThreads,
  markTalkRunStatus,
  patchTalkMetadata,
  renameTalkFolder,
  resolveThreadIdForTalk,
  searchTalkMessages,
  setTalkRunExecutorProfile,
  setTalkRunMetadata,
  touchTalkUpdatedAt,
  updateTalkProjectPath,
  updateTalkRunMetadata,
  updateTalkThreadMetadata,
  updateTalkThreadTitle,
  upsertTalk,
  upsertTalkMember,
} from './accessors-pg.js';

const USER_A_ID = '0c555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${displayName}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  // Cascade through talks deletes folders/members/threads/messages.
  await db`
    delete from public.talks
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.talk_folders
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
}

describe('accessors-pg slice 1: talks/folders/members/threads', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'acc-a@clawtalk.local', 'Acc User A');
    await seedAuthUser(USER_B_ID, 'acc-b@clawtalk.local', 'Acc User B');
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  // ── Talks ──────────────────────────────────────────────────────────

  it('createTalk: inserts, bumps sibling sort_order, auto-creates default thread', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t1 = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'First',
      });
      expect(t1.sort_order).toBe(0);
      expect(t1.owner_id).toBe(USER_A_ID);
      expect(t1.status).toBe('active');

      const t2 = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Second',
      });
      expect(t2.sort_order).toBe(0);

      // First talk got bumped to 1.
      const t1Refetched = await getTalkById(t1.id);
      expect(t1Refetched?.sort_order).toBe(1);

      // Default thread auto-created.
      const threads = await listTalkThreads({
        talkId: t1.id,
        ownerId: USER_A_ID,
      });
      expect(threads.length).toBe(1);
      expect(threads[0].is_default).toBe(true);
    });
  });

  it('listTalksForUser: returns own talks, RLS hides cross-user', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createTalk({ ownerId: USER_A_ID, topicTitle: 'A1' });
      await createTalk({ ownerId: USER_A_ID, topicTitle: 'A2' });
    });
    await withUserContext(USER_B_ID, async () => {
      await createTalk({ ownerId: USER_B_ID, topicTitle: 'B1' });
    });

    await withUserContext(USER_A_ID, async () => {
      const list = await listTalksForUser({});
      expect(list.length).toBe(2);
      expect(list.every((t) => t.owner_id === USER_A_ID)).toBe(true);
      expect(list.every((t) => t.access_role === 'owner')).toBe(true);
    });
    await withUserContext(USER_B_ID, async () => {
      const list = await listTalksForUser({});
      expect(list.length).toBe(1);
      expect(list[0].topic_title).toBe('B1');
    });
  });

  it('upsertTalk: creates on first call, bumps version on conflict', async () => {
    const id = '0c555555-1111-1111-1111-111111111111';
    await withUserContext(USER_A_ID, async () => {
      await upsertTalk({
        ownerId: USER_A_ID,
        id,
        topicTitle: 'V1',
      });
      const t1 = await getTalkById(id);
      expect(t1?.version).toBe(1);

      await upsertTalk({
        ownerId: USER_A_ID,
        id,
        topicTitle: 'V2',
      });
      const t2 = await getTalkById(id);
      expect(t2?.version).toBe(2);
      expect(t2?.topic_title).toBe('V2');
    });
  });

  it('patchTalkMetadata: title + orchestrationMode roundtrip; version bumps', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Original',
      });
      const patched = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: 'Renamed',
        orchestrationMode: 'panel',
      });
      expect(patched?.topic_title).toBe('Renamed');
      expect(patched?.orchestration_mode).toBe('panel');
      expect(patched?.version).toBe(t.version + 1);

      // title=null clears.
      const cleared = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: null,
      });
      expect(cleared?.topic_title).toBeNull();
    });
  });

  it('updateTalkProjectPath + touchTalkUpdatedAt + delete', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'P' });
      const updated = await updateTalkProjectPath({
        talkId: t.id,
        projectPath: '/local/repo',
      });
      expect(updated?.project_path).toBe('/local/repo');

      await touchTalkUpdatedAt(t.id);
      const touched = await getTalkById(t.id);
      // No strict assertion on the timestamp diff — just that the row
      // still exists and updated_at parses.
      expect(touched).toBeDefined();
      expect(Date.parse(touched!.updated_at)).toBeGreaterThan(0);

      expect(await deleteTalkForOwner({ talkId: t.id })).toBe(true);
      expect(await getTalkById(t.id)).toBeUndefined();
    });
  });

  it('getTalkForUser returns access_role: owner for own talks', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Mine' });
      const got = await getTalkForUser(t.id);
      expect(got?.access_role).toBe('owner');
    });
  });

  // ── Folders ────────────────────────────────────────────────────────

  it('folders: create, rename, list, delete moves talks to top-level', async () => {
    await withUserContext(USER_A_ID, async () => {
      const folder = await createTalkFolder({
        ownerId: USER_A_ID,
        title: 'My Projects',
      });
      expect(folder.sort_order).toBe(0);

      const renamed = await renameTalkFolder({
        id: folder.id,
        title: 'Renamed',
      });
      expect(renamed?.title).toBe('Renamed');

      const list = await listTalkFoldersForOwner();
      expect(list.length).toBe(1);
      expect(list[0].title).toBe('Renamed');

      // Create a talk inside the folder by direct update (folder-move
      // helper lands in the sidebar slice).
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'In Folder',
      });
      const db = getDbPg();
      await db`
        update public.talks set folder_id = ${folder.id}::uuid
        where id = ${talk.id}::uuid
      `;
      expect(
        await deleteTalkFolderAndMoveTalksToTopLevel({
          id: folder.id,
          ownerId: USER_A_ID,
        }),
      ).toBe(true);
      const reparented = await getTalkById(talk.id);
      expect(reparented?.folder_id).toBeNull();
    });
  });

  // ── Members ────────────────────────────────────────────────────────

  it('members: owner can manage their talk_members rows', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Shared' });
      return t.id;
    });

    // Talk owner adds USER_B as a member. Note: the talk_members RLS
    // policy in 0002 is SELECT-only ("self or talk-owner-can-see"); it
    // doesn't have a WITH CHECK clause for inserts. INSERTs require the
    // separate per-action policy that 0002 doesn't ship yet. Until the
    // sharing feature lands its policy expansion, talk_members writes
    // would fail under RLS. Run this assertion with BYPASSRLS to verify
    // the SQL/shape works — when the policy ships, drop the bypass.
    const adminDb = getDbPg();
    await adminDb`
      insert into public.talk_members (talk_id, user_id, role)
      values (${talkId}::uuid, ${USER_B_ID}::uuid, 'editor')
      on conflict (talk_id, user_id) do update set role = excluded.role
    `;

    // Verify USER_A can see the member row through the SELECT policy.
    await withUserContext(USER_A_ID, async () => {
      const db = getDbPg();
      const rows = await db<{ user_id: string; role: string }[]>`
        select user_id, role from public.talk_members
        where talk_id = ${talkId}::uuid
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].user_id).toBe(USER_B_ID);
      expect(rows[0].role).toBe('editor');
    });
  });

  it('access helpers: canUserAccessTalk / canUserEditTalk reflect RLS', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Owned' });
      return t.id;
    });

    await withUserContext(USER_A_ID, async () => {
      expect(await canUserAccessTalk(talkId)).toBe(true);
      expect(await canUserEditTalk(talkId)).toBe(true);
      const ids = await getTalkIdsAccessibleByUser();
      expect(ids).toContain(talkId);
    });
    await withUserContext(USER_B_ID, async () => {
      // RLS hides A's talk from B entirely.
      expect(await canUserAccessTalk(talkId)).toBe(false);
      expect(await canUserEditTalk(talkId)).toBe(false);
      const ids = await getTalkIdsAccessibleByUser();
      expect(ids).not.toContain(talkId);
    });
  });

  // ── Threads ────────────────────────────────────────────────────────

  it('threads: create non-default, default heal-on-read, update metadata, delete refuses default', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'T' });
      // createTalk already provisioned the default thread.
      const initialThreads = await listTalkThreads({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(initialThreads.length).toBe(1);
      const defaultThreadId = initialThreads[0].id;
      expect(initialThreads[0].is_default).toBe(true);

      // Add a non-default thread.
      const second = await createTalkThread({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: 'Side branch',
      });
      expect(second.is_default).toBe(false);
      expect(second.title).toBe('Side branch');

      // Title update + pin.
      const updated = await updateTalkThreadMetadata({
        talkId: t.id,
        threadId: second.id,
        title: 'Renamed',
        pinned: true,
      });
      expect(updated?.title).toBe('Renamed');
      expect(updated?.is_pinned).toBe(true);

      // updateTalkThreadTitle wrapper.
      const titleOnly = await updateTalkThreadTitle({
        talkId: t.id,
        threadId: second.id,
        title: 'Title only',
      });
      expect(titleOnly?.title).toBe('Title only');

      // Delete non-default — ok.
      expect(
        await deleteTalkThread({ talkId: t.id, threadId: second.id }),
      ).toBe(true);

      // Delete default — refused.
      await expect(
        deleteTalkThread({ talkId: t.id, threadId: defaultThreadId }),
      ).rejects.toThrow(/Cannot delete the default thread/);

      // resolveThreadIdForTalk falls back to default.
      const resolved = await resolveThreadIdForTalk({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(resolved).toBe(defaultThreadId);

      // getOrCreateDefaultThread idempotent.
      const def2 = await getOrCreateDefaultThread({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(def2).toBe(defaultThreadId);
    });
  });

  // ── Messages ───────────────────────────────────────────────────────

  it('messages: create, list (ordered ascending), search, getById', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Msg Talk',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });

      // Explicit timestamps so the ordering assertion isn't at the mercy
      // of UUID tiebreaking when same-tx inserts share a microsecond.
      const m1 = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'hello world',
        createdBy: USER_A_ID,
        createdAt: '2026-05-12T00:00:01.000Z',
      });
      const m2 = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'assistant',
        content: 'goodbye world',
        metadata: { agentNickname: 'Argus' },
        createdAt: '2026-05-12T00:00:02.000Z',
      });
      expect(m1.content).toBe('hello world');
      expect(m2.metadata_json).toEqual({ agentNickname: 'Argus' });

      const list = await listTalkMessages({ talkId: talk.id });
      // Ascending by created_at — m1 first, m2 second.
      expect(list.map((m) => m.id)).toEqual([m1.id, m2.id]);

      const fetched = await getTalkMessageById(m1.id);
      expect(fetched?.content).toBe('hello world');

      const search = await searchTalkMessages({
        talkId: talk.id,
        query: 'world',
      });
      expect(search.length).toBe(2);
      const hello = await searchTalkMessages({
        talkId: talk.id,
        query: 'hello',
      });
      expect(hello.map((r) => r.id)).toEqual([m1.id]);
      const none = await searchTalkMessages({
        talkId: talk.id,
        query: 'nope',
      });
      expect(none.length).toBe(0);
    });
  });

  // ── Runs ───────────────────────────────────────────────────────────

  it('runs: create + status transitions + listing helpers', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Run Talk',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const trigger = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'go',
      });

      const r1 = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
        triggerMessageId: trigger.id,
        idempotencyKey: 'key-1',
      });
      expect(r1.status).toBe('queued');
      expect(r1.owner_id).toBe(USER_A_ID);

      const fetched = await getTalkRunById(r1.id);
      expect(fetched?.id).toBe(r1.id);

      expect((await listQueuedTalkRuns()).map((r) => r.id)).toContain(r1.id);
      expect(await countRunningTalkRuns()).toBe(0);
      expect(
        await hasActiveTalkRuns({ talkId: talk.id, threadId }),
      ).toBe(true);

      // Transition queued → running
      const started = await markTalkRunStatus(r1.id, 'running', {
        startedAt: new Date().toISOString(),
      });
      expect(started?.status).toBe('running');
      expect(started?.started_at).toBeTruthy();
      expect(await getRunningTalkRun(talk.id)).not.toBeNull();
      expect(await countRunningTalkRuns()).toBe(1);
      expect(
        (await listRunningTalkRuns()).map((r) => r.id),
      ).toContain(r1.id);

      // Executor profile + metadata set/merge.
      await setTalkRunExecutorProfile({
        runId: r1.id,
        executorAlias: 'direct_http',
        executorModel: 'claude-opus-4-7',
      });
      await setTalkRunMetadata(r1.id, { stage: 'thinking' });
      const merged = await updateTalkRunMetadata(r1.id, {
        executionDecision: { authPath: 'api_key', backend: 'direct_http' },
      });
      expect(merged?.executor_alias).toBe('direct_http');
      expect(merged?.metadata_json).toMatchObject({
        stage: 'thinking',
        executionDecision: { authPath: 'api_key', backend: 'direct_http' },
      });
      // Derivation helpers walk metadata for fallbacks.
      expect(getTalkRunTaskType(merged!)).toBe('chat');
      expect(getTalkRunSelectedMode(merged!)).toBe('api');

      // Transition running → completed
      const ended = await markTalkRunStatus(r1.id, 'completed', {
        endedAt: new Date().toISOString(),
      });
      expect(ended?.status).toBe('completed');
      expect(ended?.ended_at).toBeTruthy();
      expect(await countRunningTalkRuns()).toBe(0);
      expect(
        await hasActiveTalkRuns({ talkId: talk.id, threadId }),
      ).toBe(false);

      // listTalkRunsForTalk returns most-recent first.
      const runs = await listTalkRunsForTalk(talk.id);
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe(r1.id);
    });
  });

  it('runs: cancel + cancel_reason recorded', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Cancel',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const run = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
      });
      const cancelled = await markTalkRunStatus(run.id, 'cancelled', {
        endedAt: new Date().toISOString(),
        cancelReason: 'user_requested',
      });
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancel_reason).toBe('user_requested');
    });
  });

  // ── RLS gates ──────────────────────────────────────────────────────

  it('RLS gate: cross-user reads and writes blocked', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'A only',
      });
      return t.id;
    });

    await withUserContext(USER_B_ID, async () => {
      // Reads of A's talk return undefined under RLS.
      expect(await getTalkById(talkId)).toBeUndefined();
      // Updates affect zero rows.
      const patched = await patchTalkMetadata({
        ownerId: USER_B_ID,
        talkId,
        title: 'hijack',
      });
      expect(patched).toBeUndefined();
      // Delete returns false (USING filter).
      expect(await deleteTalkForOwner({ talkId })).toBe(false);
    });

    // INSERTs with ownerId=A while in B's context are rejected by WITH CHECK.
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createTalk({ ownerId: USER_A_ID, topicTitle: 'hijack' });
      }),
    ).rejects.toThrow();
  });
});
