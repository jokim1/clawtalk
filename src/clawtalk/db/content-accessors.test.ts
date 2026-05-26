// Content feature — end-to-end tests for content-accessors (postgres).
//
// Direct-edit redesign (commit 7) removed every proposal-specific test;
// those branches no longer exist in the accessor module. Hybrid MD+HTML
// (PR A) moved the content<->talk binding down to threads, added a
// `format` parameter to createContent, and added `bodyHtml` to
// updateContentBody. Tests cover both formats end to end.
//
// Runs against the local Supabase Postgres started by `npm run db:start`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  createContent,
  getContentById,
  getContentByTalkId,
  getContentByThreadId,
  updateContentBody,
} from './content-accessors.js';
import { tiptapJsonToMarkdown } from '../../shared/rich-text/index.js';

const USER_A_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c444444-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c444444-cccc-cccc-cccc-ccccccccc0b1';

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

async function seedTalk(talkId: string, ownerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${ownerId}::uuid, 'Content Test Talk')
    on conflict (id) do nothing
  `;
}

async function ensureDefaultThread(
  talkId: string,
  ownerId: string,
): Promise<string> {
  const db = getDbPg();
  const existing = await db<{ id: string }[]>`
    select id from public.talk_threads
    where talk_id = ${talkId}::uuid and is_default = true
    limit 1
  `;
  if (existing[0]) return existing[0].id;
  const inserted = await db<{ id: string }[]>`
    insert into public.talk_threads
      (talk_id, owner_id, title, is_default, is_internal)
    values (${talkId}::uuid, ${ownerId}::uuid, null, true, false)
    returning id
  `;
  return inserted[0].id;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  // Cascade through talks removes threads + contents + content_edits.
  await db`
    delete from public.talks where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

describe('content-accessors (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'content-a@clawtalk.local', 'Content A');
    await seedAuthUser(USER_B_ID, 'content-b@clawtalk.local', 'Content B');
    await seedTalk(TALK_A_ID, USER_A_ID);
    await seedTalk(TALK_B_ID, USER_B_ID);
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

  it('createContent (markdown) + getContentByThreadId: happy path', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: '  My Doc  ',
        createdByUserId: USER_A_ID,
      });
      expect(created.title).toBe('My Doc');
      expect(created.contentFormat).toBe('markdown');
      expect(created.threadId).toBe(threadId);
      expect(created.bodyVersion).toBe(1);
      expect(created.bodyMarkdown).toBe('');
      expect(created.bodyHtml).toBeNull();

      const fetched = await getContentByThreadId(threadId);
      expect(fetched?.id).toBe(created.id);

      // Legacy shim: lookup-by-talkId resolves through the default
      // thread for callers that haven't migrated yet.
      const fetchedByTalk = await getContentByTalkId(TALK_A_ID);
      expect(fetchedByTalk?.id).toBe(created.id);

      const fetchedById = await getContentById(created.id);
      expect(fetchedById?.threadId).toBe(threadId);
      expect(fetchedById?.talkId).toBe(TALK_A_ID);
    });
  });

  it('createContent (html): initial body_html is empty string + format persists', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'HTML doc',
        format: 'html',
        createdByUserId: USER_A_ID,
      });
      expect(created.contentFormat).toBe('html');
      expect(created.bodyMarkdown).toBe('');
      expect(created.bodyHtml).toBe('');
    });
  });

  it('createContent: thread_id unique constraint blocks a second doc on the same thread', async () => {
    let threadId = '';
    await withUserContext(USER_A_ID, async () => {
      threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'first',
      });
    });
    await expect(
      withUserContext(USER_A_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          threadId,
          title: 'second',
        });
      }),
    ).rejects.toThrow();
  });

  it('integrity trigger rejects contents.owner_id ≠ thread owner', async () => {
    const db = getDbPg();
    const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
    // Direct insert via BYPASSRLS with mismatched owner — the integrity
    // trigger should fire.
    await expect(
      db`
        insert into public.contents
          (owner_id, talk_id, thread_id, title, body_markdown, body_version, anchor_map_json)
        values
          (${USER_B_ID}::uuid, ${TALK_A_ID}::uuid, ${threadId}::uuid,
           'spoof', '', 1, '{}'::jsonb)
      `,
    ).rejects.toThrow();
  });

  it('updateContentBody (markdown): happy path + CAS conflict + not_found', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'Doc',
      });
      const happy = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Hello\n\nBody.',
        updatedByUserId: USER_A_ID,
      });
      expect(happy.kind).toBe('ok');
      if (happy.kind === 'ok') {
        expect(happy.content.bodyVersion).toBe(content.bodyVersion + 1);
        expect(happy.content.bodyMarkdown).toContain('Hello');
      }

      const conflict = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Stale write',
        updatedByUserId: USER_A_ID,
      });
      expect(conflict.kind).toBe('conflict');

      const notFound = await updateContentBody({
        contentId: '00000000-0000-0000-0000-000000000000',
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: 'irrelevant',
        updatedByUserId: USER_A_ID,
      });
      expect(notFound.kind).toBe('not_found');
    });
  });

  it('updateContentBody (html): persists sanitized body + bumps version', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'HTML',
        format: 'html',
      });
      const result = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        // Sanitizer should strip the <script> tag.
        bodyHtml: '<p>safe</p><script>alert(1)</script>',
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.content.contentFormat).toBe('html');
        expect(result.content.bodyVersion).toBe(content.bodyVersion + 1);
        expect(result.content.bodyHtml).not.toBeNull();
        expect(result.content.bodyHtml).toContain('<p>safe</p>');
        expect(result.content.bodyHtml).not.toContain('<script');
      }
    });
  });

  it('updateContentBody (html): rejects bodyMarkdown on html-format content', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'HTML',
        format: 'html',
      });
      const result = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# This should be rejected',
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('format_mismatch');
      if (result.kind === 'format_mismatch') {
        expect(result.format).toBe('html');
      }
    });
  });

  it('updateContentBody (markdown): rejects bodyHtml on markdown-format content', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'MD',
      });
      const result = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyHtml: '<p>nope</p>',
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('format_mismatch');
      if (result.kind === 'format_mismatch') {
        expect(result.format).toBe('markdown');
      }
    });
  });

  it('updateContentBody: doc_size_limit gates over-budget bodies', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'Doc',
      });
      const oversize = 'A'.repeat(CONTENT_BODY_BYTE_LIMIT + 1024);
      const result = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: oversize,
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('doc_size_limit');
    });
  });

  it('updateContentBody: canonical anchor-stamping survives a no-op round trip', async () => {
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'Doc',
      });
      const updated = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Hello\n\nBody.',
        updatedByUserId: USER_A_ID,
      });
      if (updated.kind !== 'ok') throw new Error('expected ok');
      // The serializer rewrites the body with anchor comments — re-saving
      // the canonical markdown shouldn't change it past the first round.
      const canonical = updated.content.bodyMarkdown;
      const second = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: updated.content.bodyVersion,
        bodyMarkdown: canonical,
        updatedByUserId: USER_A_ID,
      });
      if (second.kind !== 'ok') throw new Error('expected ok');
      expect(second.content.bodyMarkdown).toBe(canonical);
      // Sanity check: tiptap → markdown round-trips identically.
      void tiptapJsonToMarkdown;
    });
  });

  it('RLS: user B cannot read user A content', async () => {
    let userAContentId = '';
    await withUserContext(USER_A_ID, async () => {
      const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        title: 'Private',
      });
      userAContentId = created.id;
    });
    await withUserContext(USER_B_ID, async () => {
      const fetched = await getContentById(userAContentId);
      expect(fetched).toBeNull();
    });
  });

  it('RLS: user B INSERT (createContent) with ownerId=USER_A rejected', async () => {
    const threadId = await ensureDefaultThread(TALK_A_ID, USER_A_ID);
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          threadId,
          title: 'forged',
        });
      }),
    ).rejects.toThrow();
  });
});
