import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from './test-helpers.js';
import { getContentByTalkId } from './content-accessors.js';

const USER_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
      await expect(getContentByTalkId(TALK_ID)).resolves.toBeNull();
    });
  });
});
