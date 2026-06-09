import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedTalk,
  withUserContext,
} from '../db/test-helpers.js';
import { buildToolExecutor, CleanTalkExecutor } from './new-executor.js';

const USER_ID = '0c878787-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c878787-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_ID = '0c878787-cccc-cccc-cccc-cccccccccccc';
const SOURCE_WITH_REF = '0c878787-dddd-dddd-dddd-ddddddddd001';
const SOURCE_WITHOUT_REF = '0c878787-dddd-dddd-dddd-ddddddddd002';
const RASTER_ONLY_PDF = '0c878787-dddd-dddd-dddd-ddddddddd003';
const SUMMARY_SOURCE = '0c878787-dddd-dddd-dddd-ddddddddd004';
const COLLISION_COMPUTED_REF = '0c878787-dddd-dddd-dddd-ddddddddd005';
const COLLISION_STORED_REF = '0c878787-dddd-dddd-dddd-ddddddddd006';
const HIDDEN_SOURCE = '0c878787-dddd-dddd-dddd-ddddddddd007';
const PENDING_STALE_SOURCE = '0c878787-dddd-dddd-dddd-ddddddddd008';
const NO_STATUS_UNPROCESSED_SOURCE = '0c878787-dddd-dddd-dddd-ddddddddd009';

async function workspaceIdForTalk(): Promise<string> {
  const rows = await getDbPg()<Array<{ workspace_id: string }>>`
    select workspace_id::text as workspace_id
    from public.talks
    where id = ${TALK_ID}::uuid
    limit 1
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (!workspaceId) throw new Error('seeded Talk workspace not found');
  return workspaceId;
}

async function seedContextSource(input: {
  id: string;
  name: string;
  sortOrder: number;
  extractedText: string | null;
  summary?: string | null;
  metaJson: Record<string, unknown>;
  kind?: 'file' | 'url' | 'talk';
  expectedPageCount?: number | null;
  includeInPrompt?: boolean;
}): Promise<void> {
  const workspaceId = await workspaceIdForTalk();
  await getDbPg()`
    insert into public.context_sources (
      id, workspace_id, talk_id, kind, name, payload_ref, extracted_text, summary,
      meta_json, expected_page_count, include_in_prompt, sort_order,
      added_by_user_id
    )
    values (
      ${input.id}::uuid,
      ${workspaceId}::uuid,
      ${TALK_ID}::uuid,
      ${input.kind ?? 'file'},
      ${input.name},
      ${`attachments/${TALK_ID}/${input.id}`},
      ${input.extractedText},
      ${input.summary ?? null},
      ${getDbPg().json(input.metaJson as never)},
      ${input.expectedPageCount ?? null},
      ${input.includeInPrompt ?? true},
      ${input.sortOrder},
      ${USER_ID}::uuid
    )
    on conflict (id) do nothing
  `;
}

async function seedSourcePage(
  sourceId: string,
  pageIndex: number,
): Promise<void> {
  const workspaceId = await workspaceIdForTalk();
  await getDbPg()`
    insert into public.context_source_pages (
      workspace_id, source_id, page_index, byte_size, payload_ref
    )
    values (
      ${workspaceId}::uuid,
      ${sourceId}::uuid,
      ${pageIndex},
      100,
      ${`attachments/${TALK_ID}/${sourceId}/page-${pageIndex}.jpg`}
    )
    on conflict (source_id, page_index) do nothing
  `;
}

describe('buildToolExecutor runtime tool gates', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser({
      id: USER_ID,
      email: 'new-executor-runtime@clawtalk.local',
    });
  });

  beforeEach(async () => {
    await purgeUserData([USER_ID]);
    await seedTalk({ ownerId: USER_ID, talkId: TALK_ID });
  });

  afterAll(async () => {
    await purgeUserData([USER_ID]);
    await deleteAuthUsers([USER_ID]);
    await closePgDatabase();
  });

  it('fails closed when the retired CleanTalkExecutor is called directly', async () => {
    const executor = new CleanTalkExecutor();

    await expect(
      executor.execute(
        {
          runId: RUN_ID,
          talkId: TALK_ID,
          requestedBy: USER_ID,
          triggerMessageId: '0c878787-ffff-ffff-ffff-ffffffffffff',
          triggerContent: 'hello',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'LEGACY_EXECUTOR_RETIRED',
      message:
        'CleanTalkExecutor is retired on the greenfield runtime. Use GreenfieldTalkExecutor.',
    });
  });

  it('fails closed for direct read_attachment calls on the greenfield runtime', async () => {
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await expect(
      executeTool('read_attachment', {
        attachmentId: '00000000-0000-4000-8000-000000000aaa',
      }),
    ).resolves.toEqual({
      result:
        'Error: attachments_not_available: Message attachments are not available on the greenfield chat route yet.',
      isError: true,
    });
  });

  it('fails closed for retired state tool calls on the greenfield runtime', async () => {
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );
    const expected = {
      result:
        'Error: state_not_available: Greenfield Talks do not have mutable state in this runtime.',
      isError: true,
    };

    await expect(executeTool('read_state', { key: 'x' })).resolves.toEqual(
      expected,
    );
    await expect(executeTool('list_state', {})).resolves.toEqual(expected);
    await expect(
      executeTool('update_state', {
        key: 'x',
        value: { ok: true },
        expectedVersion: 0,
      }),
    ).resolves.toEqual(expected);
    await expect(
      executeTool('delete_state', { key: 'x', expectedVersion: 1 }),
    ).resolves.toEqual(expected);
  });

  it('reads greenfield context sources by stored ref, raw id, and summary fallback', async () => {
    await seedContextSource({
      id: SOURCE_WITH_REF,
      name: 'Stored source ref',
      sortOrder: 0,
      extractedText: 'Stored ref body',
      metaJson: {
        sourceRef: 'S1',
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    await seedContextSource({
      id: SOURCE_WITHOUT_REF,
      name: 'Source without ref',
      sortOrder: 1,
      extractedText: 'Raw id body',
      metaJson: {
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    await seedContextSource({
      id: SUMMARY_SOURCE,
      name: 'Summary source',
      sortOrder: 3,
      extractedText: null,
      summary: 'Summary fallback body',
      metaJson: {
        sourceRef: 'S4',
        sourceType: 'talk',
        mimeType: 'text/plain',
      },
    });
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 42 }),
      ).resolves.toEqual({
        result: 'Error: sourceRef parameter required',
        isError: true,
      });
      await expect(
        executeTool('read_source', { sourceRef: 's1' }),
      ).resolves.toEqual({ result: 'Stored ref body' });
      await expect(
        executeTool('read_source', {
          sourceRef: SOURCE_WITHOUT_REF.toUpperCase(),
        }),
      ).resolves.toEqual({ result: 'Raw id body' });
      await expect(
        executeTool('read_source', { sourceRef: SOURCE_WITH_REF }),
      ).resolves.toEqual({ result: 'Stored ref body' });
      await expect(
        executeTool('read_source', { sourceRef: 'S4' }),
      ).resolves.toEqual({ result: 'Summary fallback body' });
    });
  });

  it('prefers an explicit stored sourceRef over a missing-ref row with the same sort-derived label', async () => {
    await seedContextSource({
      id: COLLISION_COMPUTED_REF,
      name: 'Computed collision source',
      sortOrder: 8,
      extractedText: 'Computed S9 body',
      metaJson: {
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    await seedContextSource({
      id: COLLISION_STORED_REF,
      name: 'Stored collision source',
      sortOrder: 20,
      extractedText: 'Stored S9 body',
      metaJson: {
        sourceRef: 'S9',
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 's9' }),
      ).resolves.toEqual({ result: 'Stored S9 body' });
    });
  });

  it('reports not-found and no-text sources explicitly', async () => {
    await seedContextSource({
      id: RASTER_ONLY_PDF,
      name: 'Raster only PDF',
      sortOrder: 2,
      extractedText: null,
      expectedPageCount: 2,
      metaJson: {
        sourceRef: 'S3',
        sourceType: 'file',
        mimeType: 'application/pdf',
        status: 'failed',
      },
    });
    await seedSourcePage(RASTER_ONLY_PDF, 0);
    await seedSourcePage(RASTER_ONLY_PDF, 1);
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 'S999' }),
      ).resolves.toEqual({
        result: 'Source S999 not found',
        isError: true,
      });
      await expect(
        executeTool('read_source', { sourceRef: 'S3' }),
      ).resolves.toEqual({
        result:
          'Source S3 has no extracted text. This PDF is available as page images in the current context; read_source only returns extracted text.',
        isError: true,
      });
    });
  });

  it('does not let direct read_source calls bypass prompt visibility', async () => {
    await seedContextSource({
      id: HIDDEN_SOURCE,
      name: 'Hidden source',
      sortOrder: 6,
      extractedText: 'Hidden source body',
      includeInPrompt: false,
      metaJson: {
        sourceRef: 'S7',
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 'S7' }),
      ).resolves.toEqual({
        result: 'Source S7 not found',
        isError: true,
      });
      await expect(
        executeTool('read_source', { sourceRef: HIDDEN_SOURCE }),
      ).resolves.toEqual({
        result: `Source ${HIDDEN_SOURCE} not found`,
        isError: true,
      });
    });
  });

  it('does not return stale extracted text for sources that are not ready', async () => {
    await seedContextSource({
      id: PENDING_STALE_SOURCE,
      name: 'Pending stale URL',
      kind: 'url',
      sortOrder: 7,
      extractedText: 'Stale URL body',
      metaJson: {
        sourceRef: 'S8',
        sourceType: 'url',
        mimeType: 'text/plain',
        status: 'pending',
        sourceUrl: 'https://example.test/stale',
      },
    });
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 'S8' }),
      ).resolves.toEqual({
        result: 'Source S8 is pending; extracted text is not available yet.',
        isError: true,
      });
    });
  });

  it('treats missing-status sources without content as pending for direct reads', async () => {
    await seedContextSource({
      id: NO_STATUS_UNPROCESSED_SOURCE,
      name: 'No status unprocessed file',
      sortOrder: 8,
      extractedText: null,
      metaJson: {
        sourceRef: 'S9',
        sourceType: 'file',
        mimeType: 'text/plain',
      },
    });
    const executeTool = buildToolExecutor(
      TALK_ID,
      USER_ID,
      RUN_ID,
      new AbortController().signal,
    );

    await withUserContext(USER_ID, async () => {
      await expect(
        executeTool('read_source', { sourceRef: 'S9' }),
      ).resolves.toEqual({
        result: 'Source S9 is pending; extracted text is not available yet.',
        isError: true,
      });
    });
  });
});
