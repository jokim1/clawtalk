import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from './test-helpers.js';
import {
  createContent,
  getContentById,
  getContentByTalkId,
  getContentByThreadId,
  listContentsForSidebar,
  updateContentBody,
} from './content-accessors.js';

const USER_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THREAD_ID = '0c444444-cccc-cccc-cccc-cccccccccccc';
const CONTENT_ID = '0c444444-dddd-dddd-dddd-dddddddddddd';

describe('legacy content-accessors against the greenfield baseline', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  afterAll(async () => {
    await closePgDatabase();
  });

  it('runs against a baseline that no longer creates public.contents', async () => {
    await expect(
      getDbPg()<Array<{ exists: boolean }>>`
        select to_regclass('public.contents') is not null as exists
      `,
    ).resolves.toEqual([{ exists: false }]);
  });

  it('degrades retired content reads to empty results', async () => {
    await withUserContext(USER_ID, async () => {
      await expect(listContentsForSidebar()).resolves.toEqual([]);
      await expect(getContentById(CONTENT_ID)).resolves.toBeNull();
      await expect(getContentByTalkId(TALK_ID)).resolves.toBeNull();
      await expect(getContentByThreadId(THREAD_ID)).resolves.toBeNull();
    });
  });

  it('fails closed for retired content writes', async () => {
    await withUserContext(USER_ID, async () => {
      await expect(
        createContent({
          ownerId: USER_ID,
          talkId: TALK_ID,
          threadId: THREAD_ID,
          title: 'Legacy doc',
        }),
      ).rejects.toThrow('legacy_contents_not_available');

      await expect(
        updateContentBody({
          contentId: CONTENT_ID,
          ownerId: USER_ID,
          expectedVersion: 1,
          bodyMarkdown: 'retired writer',
          updatedByUserId: USER_ID,
        }),
      ).rejects.toThrow('legacy_contents_not_available');
    });
  });
});
