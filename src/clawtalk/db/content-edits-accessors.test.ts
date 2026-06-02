import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from './test-helpers.js';
import {
  acceptPendingEdit,
  acceptPendingRun,
  deletePendingEdit,
  deletePendingEditsByRun,
  getPendingEditById,
  getPendingEditsByContent,
  insertPendingEdit,
  rejectPendingEdit,
  rejectPendingRun,
  updatePendingEdit,
} from './content-edits-accessors.js';
import { executeApplyContentEdit } from '../talks/content-apply-handler.js';

const USER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONTENT_ID = '0c888888-cccc-cccc-cccc-cccccccccccc';
const EDIT_ID = '0c888888-dddd-dddd-dddd-dddddddddddd';
const RUN_ID = 'legacy-run';

describe('legacy content-edits accessors against the greenfield baseline', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  afterAll(async () => {
    await closePgDatabase();
  });

  it('runs against a baseline that no longer creates public.content_edits', async () => {
    await expect(
      getDbPg()<Array<{ exists: boolean }>>`
        select to_regclass('public.content_edits') is not null as exists
      `,
    ).resolves.toEqual([{ exists: false }]);
  });

  it('degrades retired pending-edit reads to empty results', async () => {
    await withUserContext(USER_ID, async () => {
      await expect(getPendingEditsByContent(CONTENT_ID)).resolves.toEqual([]);
      await expect(getPendingEditById(EDIT_ID)).resolves.toBeNull();
    });
  });

  it('fails closed for retired pending-edit writes and resolutions', async () => {
    await withUserContext(USER_ID, async () => {
      await expect(
        insertPendingEdit({
          contentId: CONTENT_ID,
          runId: RUN_ID,
          agentId: null,
          agentNickname: null,
          messageId: null,
          kind: 'insert',
          baseContentVersion: 1,
          targetAnchorId: null,
          newMarkdown: 'legacy edit',
          rationale: null,
        }),
      ).rejects.toThrow('legacy_content_edits_not_available');

      await expect(
        updatePendingEdit({
          editId: EDIT_ID,
          kind: 'replace',
          targetAnchorId: null,
          newMarkdown: 'legacy edit',
          rationale: null,
        }),
      ).rejects.toThrow('legacy_content_edits_not_available');

      await expect(deletePendingEdit(EDIT_ID)).rejects.toThrow(
        'legacy_content_edits_not_available',
      );
      await expect(
        deletePendingEditsByRun({ contentId: CONTENT_ID, runId: RUN_ID }),
      ).rejects.toThrow('legacy_content_edits_not_available');
      await expect(
        acceptPendingEdit({ editId: EDIT_ID, userId: USER_ID }),
      ).rejects.toThrow('legacy_content_edits_not_available');
      await expect(
        rejectPendingEdit({ editId: EDIT_ID, userId: USER_ID }),
      ).rejects.toThrow('legacy_content_edits_not_available');
      await expect(
        acceptPendingRun({
          contentId: CONTENT_ID,
          runId: RUN_ID,
          userId: USER_ID,
        }),
      ).rejects.toThrow('legacy_content_edits_not_available');
      await expect(
        rejectPendingRun({
          contentId: CONTENT_ID,
          runId: RUN_ID,
          userId: USER_ID,
        }),
      ).rejects.toThrow('legacy_content_edits_not_available');
    });
  });

  it('keeps the retired apply_content_edit handler from touching missing legacy tables', async () => {
    await withUserContext(USER_ID, async () => {
      await expect(
        executeApplyContentEdit({
          talkId: TALK_ID,
          userId: USER_ID,
          runId: RUN_ID,
          agentId: null,
          agentNickname: null,
          messageId: null,
          args: {
            kind: 'append',
            markdown: 'legacy edit',
          },
        }),
      ).resolves.toEqual({
        result:
          'Error: this Talk has no attached document. Cannot apply an edit.',
        isError: true,
      });
    });
  });
});
