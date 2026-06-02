// Integration tests for fetchSources readiness with rasterized PDF pages.
//
// A PDF must stay visible to consumption when it has EITHER extracted
// text (status='ready') OR a complete page set. A text-extraction
// failure must not hide a PDF the model can still read via page images
// (Codex #12). The join also surfaces page_image_count + total bytes so
// the consumer can budget the payload without a second query.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

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

import {
  buildAtRefForcedInjection,
  fetchAtRefCandidateRows,
  fetchGoal,
  fetchSources,
  isPageSetComplete,
  loadTalkContext,
} from './context-loader.js';
import { extractSourceReferences } from './source-reference-detection.js';

const USER = '0c333355-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK = '0c333355-cccc-cccc-cccc-ccccccccc0a1';

// One source id per readiness scenario.
const READY_PDF = '0c333355-dddd-dddd-dddd-ddddddddd001';
const READY_TEXT = '0c333355-dddd-dddd-dddd-ddddddddd002';
const FAILED_COMPLETE = '0c333355-dddd-dddd-dddd-ddddddddd003';
const FAILED_INCOMPLETE = '0c333355-dddd-dddd-dddd-ddddddddd004';
const FAILED_NOPAGES = '0c333355-dddd-dddd-dddd-ddddddddd005';
const READY_WITH_PAGES = '0c333355-dddd-dddd-dddd-ddddddddd006';
const NAME_ONLY_GOAL = '0c333355-dddd-dddd-dddd-ddddddddd017';
const HIDDEN_READY = '0c333355-dddd-dddd-dddd-ddddddddd007';
const SUMMARY_ONLY = '0c333355-dddd-dddd-dddd-ddddddddd008';
const WHITESPACE_WITH_SUMMARY = '0c333355-dddd-dddd-dddd-ddddddddd018';
const COLLISION_COMPUTED = '0c333355-dddd-dddd-dddd-ddddddddd009';
const COLLISION_STORED = '0c333355-dddd-dddd-dddd-ddddddddd010';
const DUPLICATE_COMPUTED_A = '0c333355-dddd-dddd-dddd-ddddddddd011';
const DUPLICATE_COMPUTED_B = '0c333355-dddd-dddd-dddd-ddddddddd012';
const NO_STATUS_UNPROCESSED = '0c333355-dddd-dddd-dddd-ddddddddd013';
const NO_STATUS_FAILED = '0c333355-dddd-dddd-dddd-ddddddddd014';
const NO_STATUS_WHITESPACE = '0c333355-dddd-dddd-dddd-ddddddddd015';
const INVALID_FILE_SIZE = '0c333355-dddd-dddd-dddd-ddddddddd016';
const WHITESPACE_GOAL = '0c333355-dddd-dddd-dddd-ddddddddd019';
const WHITESPACE_RULE = '0c333355-dddd-dddd-dddd-ddddddddd020';
const WHITESPACE_GOAL_NAME = '0c333355-dddd-dddd-dddd-ddddddddd021';
const WHITESPACE_RULE_NAME = '0c333355-dddd-dddd-dddd-ddddddddd022';
const LARGE_FILE_SIZE = '0c333355-dddd-dddd-dddd-ddddddddd023';
const STATUS_SLUG_SOURCE = '0c333355-dddd-dddd-dddd-ddddddddd024';
const RAW_ALIAS_COLLIDER = '0c333355-dddd-dddd-dddd-ddddddddd025';
const HISTORY_SNAPSHOT_GROUP = '0c333355-eeee-eeee-eeee-eeeeeeee0001';
const HISTORY_SNAPSHOT = '0c333355-eeee-eeee-eeee-eeeeeeee0002';
const HISTORY_RUN = '0c333355-eeee-eeee-eeee-eeeeeeee0003';
const HISTORY_USER_OLD = '0c333355-eeee-eeee-eeee-eeeeeeee0010';
const HISTORY_AGENT_MESSAGE = '0c333355-eeee-eeee-eeee-eeeeeeee0011';
const HISTORY_USER_AFTER = '0c333355-eeee-eeee-eeee-eeeeeeee0012';
const HISTORY_USER_FUTURE = '0c333355-eeee-eeee-eeee-eeeeeeee0013';
const HISTORY_USER_EMPTY = '0c333355-eeee-eeee-eeee-eeeeeeee0014';
const HISTORY_AGENT_EMPTY = '0c333355-eeee-eeee-eeee-eeeeeeee0015';
const HISTORY_AGENT_OLDER_REPLAY = '0c333355-eeee-eeee-eeee-eeeeeeee0016';
const HISTORY_AGENT_MIDDLE_REPLAY = '0c333355-eeee-eeee-eeee-eeeeeeee0017';
const HISTORY_MISSING_CUTOFF = '0c333355-eeee-eeee-eeee-eeeeeeee9999';
const OTHER_SOURCE_AGENT = '0c333355-eeee-eeee-eeee-eeeeeeee00ff';

async function getWorkspaceId(): Promise<string> {
  const db = getDbPg();
  const rows = await db<Array<{ workspace_id: string }>>`
    select workspace_id::text as workspace_id
    from public.talks
    where id = ${TALK}::uuid
    limit 1
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (!workspaceId) throw new Error('seeded Talk workspace not found');
  return workspaceId;
}

async function seedSource(input: {
  id: string;
  sourceRef: string;
  mimeType: string;
  status: string;
  expectedPageCount: number | null;
  includeInPrompt?: boolean;
  extractedText?: string | null;
  summary?: string | null;
  fileSize?: unknown;
}): Promise<void> {
  const db = getDbPg();
  const workspaceId = await getWorkspaceId();
  const sortOrder = Number(input.sourceRef.slice(1)) - 1;
  const metaJson = {
    compatKind: 'source',
    sourceRef: input.sourceRef,
    sourceType: 'file',
    fileName: 'doc.pdf',
    fileSize: input.fileSize ?? 123,
    mimeType: input.mimeType,
    status: input.status,
  };
  const extractedText =
    'extractedText' in input
      ? (input.extractedText ?? null)
      : input.status === 'ready'
        ? `Extracted text ${input.sourceRef}`
        : null;
  await db`
    insert into public.context_sources (
      id, workspace_id, talk_id, kind, name, payload_ref, extracted_text, summary,
      meta_json, expected_page_count, include_in_prompt, sort_order,
      added_by_user_id
    )
    values
      (
        ${input.id}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'file',
        ${`Readiness Source ${input.sourceRef}`},
        ${`attachments/${TALK}/${input.id}.pdf`},
        ${extractedText},
        ${input.summary ?? null},
        ${db.json(metaJson as never)},
        ${input.expectedPageCount},
        ${input.includeInPrompt ?? true},
        ${sortOrder},
        ${USER}::uuid
      )
    on conflict (id) do nothing
  `;
}

async function seedSourceWithoutStoredRef(input: {
  id: string;
  sortOrder: number;
  title: string;
  extractedText: string;
}): Promise<void> {
  const db = getDbPg();
  const workspaceId = await getWorkspaceId();
  await db`
    insert into public.context_sources (
      id, workspace_id, talk_id, kind, name, payload_ref, extracted_text,
      meta_json, expected_page_count, include_in_prompt, sort_order,
      added_by_user_id
    )
    values (
      ${input.id}::uuid,
      ${workspaceId}::uuid,
      ${TALK}::uuid,
      'file',
      ${input.title},
      ${`attachments/${TALK}/${input.id}.txt`},
      ${input.extractedText},
      ${db.json({
        compatKind: 'source',
        sourceType: 'file',
        fileName: `${input.title}.txt`,
        mimeType: 'text/plain',
        status: 'ready',
      } as never)},
      null,
      true,
      ${input.sortOrder},
      ${USER}::uuid
    )
    on conflict (id) do nothing
  `;
}

async function seedUnprocessedSourceWithoutStatus(input: {
  id: string;
  sortOrder: number;
  title: string;
  extractedText?: string | null;
  extractionError?: string | null;
}): Promise<void> {
  const db = getDbPg();
  const workspaceId = await getWorkspaceId();
  await db`
    insert into public.context_sources (
      id, workspace_id, talk_id, kind, name, payload_ref, extracted_text,
      meta_json, expected_page_count, include_in_prompt, sort_order,
      added_by_user_id
    )
    values (
      ${input.id}::uuid,
      ${workspaceId}::uuid,
      ${TALK}::uuid,
      'file',
      ${input.title},
      ${`attachments/${TALK}/${input.id}.txt`},
      ${input.extractedText ?? null},
      ${db.json({
        compatKind: 'source',
        sourceType: 'file',
        fileName: `${input.title}.txt`,
        mimeType: 'text/plain',
        extractionError: input.extractionError ?? null,
      } as never)},
      null,
      true,
      ${input.sortOrder},
      ${USER}::uuid
    )
    on conflict (id) do nothing
  `;
}

async function seedPage(
  sourceId: string,
  pageIndex: number,
  byteSize: number,
): Promise<void> {
  const db = getDbPg();
  const workspaceId = await getWorkspaceId();
  await db`
    insert into public.context_source_pages (
      workspace_id, source_id, page_index, byte_size, payload_ref
    )
    values (
      ${workspaceId}::uuid,
      ${sourceId}::uuid,
      ${pageIndex},
      ${byteSize},
      ${`attachments/${TALK}/${sourceId}/page-${pageIndex}.jpg`}
    )
    on conflict (source_id, page_index) do nothing
  `;
}

async function upsertProviderReplayData(input: {
  workspaceId: string;
  messageId: string;
  runId?: string;
  sourceAgentId: string;
  providerId: string;
  modelId: string;
  providerData: Record<string, unknown>;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.message_provider_replay (
      workspace_id, talk_id, message_id, run_id, source_agent_id,
      provider_id, model_id, provider_data_json
    )
    values (
      ${input.workspaceId}::uuid,
      ${TALK}::uuid,
      ${input.messageId}::uuid,
      ${input.runId ?? HISTORY_RUN}::uuid,
      ${input.sourceAgentId}::uuid,
      ${input.providerId},
      ${input.modelId},
      ${db.json(input.providerData as never)}
    )
    on conflict (workspace_id, message_id) do update set
      source_agent_id = excluded.source_agent_id,
      provider_id = excluded.provider_id,
      model_id = excluded.model_id,
      provider_data_json = excluded.provider_data_json
  `;
}

async function seedFinalSchemaMessageHistory(): Promise<{
  sourceAgentId: string;
  providerId: string;
  modelId: string;
}> {
  const db = getDbPg();
  const workspaceId = await getWorkspaceId();
  const agentRows = await db<
    Array<{
      id: string;
      role_key: string;
      name: string | null;
      handle: string | null;
      initials: string | null;
      accent: string | null;
      accent_dark: string | null;
      provider_id: string;
      model_id: string;
      temperature: string | number;
      persona: string | null;
      focus: string | null;
      method: string[] | null;
    }>
  >`
    select
      id::text,
      role_key,
      name,
      handle,
      initials,
      accent,
      accent_dark,
      lpm.provider_id,
      a.model_id,
      temperature,
      persona,
      focus,
      method
    from public.agents a
    join public.llm_provider_models lpm
      on lpm.model_id = a.model_id
    where a.workspace_id = ${workspaceId}::uuid
      and a.is_default = true
      and a.is_system = false
      and a.enabled = true
    order by
      case role_key
        when 'strategist' then 1
        when 'critic' then 2
        when 'researcher' then 3
        when 'quant' then 4
        when 'editor' then 5
        else 50
      end,
      lpm.provider_id asc,
      a.id asc
    limit 1
  `;
  const agent = agentRows[0];
  if (!agent) throw new Error('workspace bootstrap did not seed agents');

  await db`
    insert into public.talk_agent_snapshots (
      id, workspace_id, talk_id, snapshot_group_id, source_agent_id,
      role_key, name, handle, initials, accent, accent_dark, provider_id, model_id,
      temperature, persona, focus, method, sort_order
    )
    values (
      ${HISTORY_SNAPSHOT}::uuid,
      ${workspaceId}::uuid,
      ${TALK}::uuid,
      ${HISTORY_SNAPSHOT_GROUP}::uuid,
      ${agent.id}::uuid,
      ${agent.role_key},
      ${agent.name},
      ${agent.handle},
      ${agent.initials},
      ${agent.accent},
      ${agent.accent_dark},
      ${agent.provider_id},
      ${agent.model_id},
      ${agent.temperature},
      ${agent.persona},
      ${agent.focus},
      ${agent.method},
      0
    )
    on conflict (id) do nothing
  `;
  await db`
    insert into public.runs (
      id, workspace_id, talk_id, round, run_kind, snapshot_group_id,
      agent_snapshot_id, status, model_id, requested_by, trigger,
      response_group_id, sequence_index
    )
    values (
      ${HISTORY_RUN}::uuid,
      ${workspaceId}::uuid,
      ${TALK}::uuid,
      1,
      'conversation',
      ${HISTORY_SNAPSHOT_GROUP}::uuid,
      ${HISTORY_SNAPSHOT}::uuid,
      'completed',
      ${agent.model_id},
      ${USER}::uuid,
      'user',
      'history-regression',
      0
    )
    on conflict (id) do nothing
  `;
  await db`
    insert into public.messages (
      id, workspace_id, talk_id, round, author_kind, author_user_id,
      agent_snapshot_id, run_id, body, metadata_json, created_at
    )
    values
      (
        ${HISTORY_USER_OLD}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        1,
        'user',
        ${USER}::uuid,
        null,
        null,
        'Earlier user body',
        ${db.json({} as never)},
        '2026-05-26T09:59:00Z'::timestamptz
      ),
      (
        ${HISTORY_AGENT_MESSAGE}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        1,
        'agent',
        null,
        ${HISTORY_SNAPSHOT}::uuid,
        ${HISTORY_RUN}::uuid,
        'Assistant history body',
        ${db.json({
          providerId: 'provider.anthropic',
          modelId: agent.model_id,
        } as never)},
        '2026-05-26T10:00:00Z'::timestamptz
      ),
      (
        ${HISTORY_USER_AFTER}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        1,
        'user',
        ${USER}::uuid,
        null,
        null,
        'Same-time user body',
        ${db.json({} as never)},
        '2026-05-26T10:00:00Z'::timestamptz
      ),
      (
        ${HISTORY_USER_FUTURE}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        1,
        'user',
        ${USER}::uuid,
        null,
        null,
        'Future user body',
        ${db.json({} as never)},
        '2026-05-26T10:01:00Z'::timestamptz
      )
    on conflict (id) do nothing
  `;
  await upsertProviderReplayData({
    workspaceId,
    messageId: HISTORY_AGENT_MESSAGE,
    sourceAgentId: agent.id,
    providerId: 'provider.anthropic',
    modelId: agent.model_id,
    providerData: {
      codexReasoningItems: [
        {
          encrypted_content: 'reasoning-ciphertext',
          summary: [],
        },
      ],
      codexMessageItems: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Assistant history body' }],
          status: 'completed',
        },
      ],
    },
  });
  return {
    sourceAgentId: agent.id,
    providerId: 'provider.anthropic',
    modelId: agent.model_id,
  };
}

describe('fetchSources readiness with page images', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser({ id: USER, email: 'readiness@clawtalk.local' });
  });

  afterAll(async () => {
    await purgeUserData([USER]);
    await deleteAuthUsers([USER]);
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purgeUserData([USER]);
    await seedTalk({ ownerId: USER, talkId: TALK });
    await seedSource({
      id: READY_PDF,
      sourceRef: 'S1',
      mimeType: 'application/pdf',
      status: 'ready',
      expectedPageCount: null,
    });
    await seedSource({
      id: READY_TEXT,
      sourceRef: 'S2',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
    });
    await seedSource({
      id: FAILED_COMPLETE,
      sourceRef: 'S3',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: 2,
    });
    await seedPage(FAILED_COMPLETE, 0, 100);
    await seedPage(FAILED_COMPLETE, 1, 200);
    await seedSource({
      id: FAILED_INCOMPLETE,
      sourceRef: 'S4',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: 2,
    });
    await seedPage(FAILED_INCOMPLETE, 0, 100);
    await seedSource({
      id: FAILED_NOPAGES,
      sourceRef: 'S5',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: null,
    });
    await seedSource({
      id: READY_WITH_PAGES,
      sourceRef: 'S6',
      mimeType: 'application/pdf',
      status: 'ready',
      expectedPageCount: 1,
    });
    await seedPage(READY_WITH_PAGES, 0, 500);
    await seedSource({
      id: HIDDEN_READY,
      sourceRef: 'S7',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      includeInPrompt: false,
    });
    await seedSource({
      id: SUMMARY_ONLY,
      sourceRef: 'S8',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      extractedText: null,
      summary: 'Summary text S8',
    });
    await seedSource({
      id: WHITESPACE_WITH_SUMMARY,
      sourceRef: 'S18',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      extractedText: '   ',
      summary: 'Summary text S18',
    });
    await seedSourceWithoutStoredRef({
      id: COLLISION_COMPUTED,
      sortOrder: 8,
      title: 'Computed collision',
      extractedText: 'Computed collision text',
    });
    await seedSource({
      id: COLLISION_STORED,
      sourceRef: 'S9',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      extractedText: 'Stored collision text',
    });
    await seedSourceWithoutStoredRef({
      id: DUPLICATE_COMPUTED_A,
      sortOrder: 42,
      title: 'Duplicate computed A',
      extractedText: 'Duplicate computed text A',
    });
    await seedSourceWithoutStoredRef({
      id: DUPLICATE_COMPUTED_B,
      sortOrder: 42,
      title: 'Duplicate computed B',
      extractedText: 'Duplicate computed text B',
    });
    await seedUnprocessedSourceWithoutStatus({
      id: NO_STATUS_UNPROCESSED,
      sortOrder: 99,
      title: 'No Status Unprocessed',
    });
    await seedUnprocessedSourceWithoutStatus({
      id: NO_STATUS_FAILED,
      sortOrder: 100,
      title: 'No Status Failed',
      extractionError: 'Extractor failed.',
    });
    await seedUnprocessedSourceWithoutStatus({
      id: NO_STATUS_WHITESPACE,
      sortOrder: 101,
      title: 'No Status Whitespace',
      extractedText: '   ',
    });
    await seedSource({
      id: INVALID_FILE_SIZE,
      sourceRef: 'S16',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      extractedText: 'Invalid file size body',
      fileSize: 'not-a-number',
    });
    await seedSource({
      id: LARGE_FILE_SIZE,
      sourceRef: 'S17',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
      extractedText: 'Large file size body',
      fileSize: 3_000_000_000,
    });
  });

  afterEach(async () => {
    await purgeUserData([USER]);
  });

  it('includes ready sources and raster-only PDFs, hides incomplete ones', async () => {
    await withUserContext(USER, async () => {
      const refs = (await fetchSources(getDbPg(), TALK)).map(
        (r) => r.source_ref,
      );
      expect(refs).toContain(READY_PDF); // ready PDF
      expect(refs).toContain(READY_TEXT); // ready text
      expect(refs).toContain(FAILED_COMPLETE); // failed extraction, complete pages
      expect(refs).toContain(READY_WITH_PAGES); // ready + pages
      expect(refs).toContain(SUMMARY_ONLY); // summary-only source content
      expect(refs).toContain(WHITESPACE_WITH_SUMMARY); // whitespace text falls back to summary
      expect(refs).toContain(INVALID_FILE_SIZE); // invalid fileSize meta does not abort
      expect(refs).toContain(LARGE_FILE_SIZE); // >2GB fileSize meta does not overflow
      expect(refs).not.toContain(NO_STATUS_UNPROCESSED); // no text/status yet
      expect(refs).not.toContain(NO_STATUS_FAILED); // failed without text/pages
      expect(refs).not.toContain(NO_STATUS_WHITESPACE); // whitespace-only text
      expect(refs).not.toContain(FAILED_INCOMPLETE); // failed, incomplete pages
      expect(refs).not.toContain(FAILED_NOPAGES); // failed, no pages
      expect(refs).not.toContain(HIDDEN_READY); // hidden from automatic prompt injection
    });
  });

  it('normalizes explicit statuses and resolves title slugs with the shared SQL expression', async () => {
    await seedSource({
      id: STATUS_SLUG_SOURCE,
      sourceRef: 'S19',
      mimeType: 'text/plain',
      status: ' READY ',
      expectedPageCount: null,
      extractedText: 'Case-normalized status body',
    });
    await getDbPg()`
      update public.context_sources
      set name = 'Café Budget 2026'
      where id = ${STATUS_SLUG_SOURCE}::uuid
    `;

    await withUserContext(USER, async () => {
      const rows = await fetchSources(getDbPg(), TALK);
      const row = rows.find((candidate) => candidate.id === STATUS_SLUG_SOURCE);
      expect(row).toMatchObject({
        status: 'ready',
        title_slug: 'caf-budget-2026',
      });

      const bySlug = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        [],
        ['caf-budget-2026'],
      );
      expect(bySlug.map((candidate) => candidate.id)).toContain(
        STATUS_SLUG_SOURCE,
      );
    });
  });

  it('treats missing-status sources without content as pending', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        [NO_STATUS_UNPROCESSED],
        [],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.extracted_text).toBeNull();
    });
  });

  it('treats missing-status whitespace-only content as pending', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        [NO_STATUS_WHITESPACE],
        [],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.extracted_text).toBeNull();
    });
  });

  it('guards non-numeric fileSize metadata and preserves large numeric file sizes', async () => {
    await withUserContext(USER, async () => {
      const manifestRows = await fetchSources(getDbPg(), TALK);
      expect(
        manifestRows.find((row) => row.id === INVALID_FILE_SIZE)?.file_size,
      ).toBeNull();
      expect(
        manifestRows.find((row) => row.id === LARGE_FILE_SIZE)?.file_size,
      ).toBe(3_000_000_000);

      const atRefRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        ['S16', 'S17'],
        [],
      );
      expect(
        atRefRows.find((row) => row.id === INVALID_FILE_SIZE)?.file_size,
      ).toBeNull();
      expect(
        atRefRows.find((row) => row.id === LARGE_FILE_SIZE)?.file_size,
      ).toBe(3_000_000_000);
    });
  });

  it('treats missing-status extraction errors as failed', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        [NO_STATUS_FAILED],
        [],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.extracted_text).toBeNull();
    });
  });

  it('surfaces page_image_count and total bytes from the join', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchSources(getDbPg(), TALK);
      const s3 = rows.find((r) => r.id === FAILED_COMPLETE);
      expect(s3?.page_image_count).toBe(2);
      expect(s3?.page_image_total_bytes).toBe(300);
      expect(s3?.expected_page_count).toBe(2);
      expect(isPageSetComplete(s3!)).toBe(true);

      // A ready PDF with no rasterized pages reports zero, not null.
      const s1 = rows.find((r) => r.id === READY_PDF);
      expect(s1?.page_image_count).toBe(0);
      expect(s1?.page_image_total_bytes).toBe(0);
      expect(isPageSetComplete(s1!)).toBe(false);
    });
  });

  // The raster consumer (Lane B) resolves @-ref'd PDFs via
  // fetchAtRefCandidateRows, which array_aggs the page indices + byte
  // sizes so the budget guard can pick pages without a second query.
  it('fetchAtRefCandidateRows joins page indices + byte sizes in page order', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(getDbPg(), TALK, ['S3'], []);
      const s3 = rows.find((r) => r.id === FAILED_COMPLETE);
      expect(s3?.page_image_count).toBe(2);
      expect(s3?.page_indices).toEqual([0, 1]);
      expect(s3?.page_byte_sizes).toEqual([100, 200]);
      expect(s3?.expected_page_count).toBe(2);
    });
  });

  it('fetchAtRefCandidateRows returns empty page arrays for an un-rasterized PDF', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(getDbPg(), TALK, ['S1'], []);
      const s1 = rows.find((r) => r.id === READY_PDF);
      expect(s1?.page_image_count).toBe(0);
      expect(s1?.page_indices).toEqual([]);
      expect(s1?.page_byte_sizes).toEqual([]);
    });
  });

  it('fetchAtRefCandidateRows does not resolve hidden sources by explicit ref', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchAtRefCandidateRows(getDbPg(), TALK, ['S7'], []);
      expect(rows).toEqual([]);
    });
  });

  it('uses source summaries when extracted text is absent', async () => {
    await withUserContext(USER, async () => {
      const manifestRows = await fetchSources(getDbPg(), TALK);
      expect(
        manifestRows.find((row) => row.id === SUMMARY_ONLY)?.extracted_text,
      ).toBe('Summary text S8');

      const atRefRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        ['S8'],
        [],
      );
      expect(atRefRows[0]?.extracted_text).toBe('Summary text S8');
    });
  });

  it('uses source summaries when extracted text is whitespace-only', async () => {
    await withUserContext(USER, async () => {
      const manifestRows = await fetchSources(getDbPg(), TALK);
      expect(
        manifestRows.find((row) => row.id === WHITESPACE_WITH_SUMMARY)
          ?.extracted_text,
      ).toBe('Summary text S18');

      const atRefRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        ['S18'],
        [],
      );
      expect(atRefRows[0]?.status).toBe('ready');
      expect(atRefRows[0]?.extracted_text).toBe('Summary text S18');
    });
  });

  it('uses the goal name when greenfield goal extracted text is absent', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${NAME_ONLY_GOAL}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'rule',
        'Name-only goal text',
        null,
        ${db.json({ compatKind: 'goal' } as never)},
        true,
        -2000,
        ${USER}::uuid
      )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      await expect(fetchGoal(getDbPg(), TALK)).resolves.toBe(
        'Name-only goal text',
      );
    });
  });

  it('uses the goal name when greenfield goal extracted text is whitespace-only', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${WHITESPACE_GOAL}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'rule',
        'Whitespace goal fallback',
        '   ',
        ${db.json({ compatKind: 'goal' } as never)},
        true,
        -2000,
        ${USER}::uuid
      )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      await expect(fetchGoal(getDbPg(), TALK)).resolves.toBe(
        'Whitespace goal fallback',
      );
    });
  });

  it('skips a greenfield goal whose extracted text and name are whitespace-only', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${WHITESPACE_GOAL_NAME}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'rule',
        '   ',
        '   ',
        ${db.json({ compatKind: 'goal' } as never)},
        true,
        -2000,
        ${USER}::uuid
      )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      await expect(fetchGoal(getDbPg(), TALK)).resolves.toBeNull();
    });
  });

  it('uses the rule name when greenfield rule extracted text is whitespace-only', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${WHITESPACE_RULE}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'rule',
        'Whitespace rule fallback',
        '   ',
        ${db.json({ compatKind: 'rule' } as never)},
        true,
        0,
        ${USER}::uuid
      )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(TALK, 8000, null, null, USER, {
        effectiveTools: [],
      });
      expect(context.systemPrompt).toContain('Whitespace rule fallback');
    });
  });

  it('skips a greenfield rule whose extracted text and name are whitespace-only', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, extracted_text, meta_json,
        include_in_prompt, sort_order, added_by_user_id
      )
      values (
        ${WHITESPACE_RULE_NAME}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'rule',
        '   ',
        '   ',
        ${db.json({ compatKind: 'rule' } as never)},
        true,
        0,
        ${USER}::uuid
      )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(TALK, 8000, null, null, USER, {
        effectiveTools: [],
      });
      expect(context.systemPrompt).not.toContain('**Rules:**');
    });
  });

  it('loads final-schema message history with role mapping and cutoff ordering', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        {
          role: 'assistant',
          content: 'Assistant history body',
          providerData: {
            codexReasoningItems: [
              {
                encrypted_content: 'reasoning-ciphertext',
                summary: [],
              },
            ],
            codexMessageItems: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'Assistant history body' },
                ],
                status: 'completed',
              },
            ],
          },
        },
      ]);
      expect(
        context.history.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Future user body'),
        ),
      ).toBe(false);
      expect(
        context.history.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Same-time user body'),
        ),
      ).toBe(false);
    });
  });

  it('replays all matching final-schema provider data rows within the byte budget', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();
    const workspaceId = await getWorkspaceId();
    const db = getDbPg();
    await db`
      insert into public.messages (
        id, workspace_id, talk_id, round, author_kind, author_user_id,
        agent_snapshot_id, run_id, body, metadata_json, created_at
      )
      values (
        ${HISTORY_AGENT_OLDER_REPLAY}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        1,
        'agent',
        null,
        ${HISTORY_SNAPSHOT}::uuid,
        ${HISTORY_RUN}::uuid,
        'Older assistant body',
        ${db.json({} as never)},
        '2026-05-26T09:59:30Z'::timestamptz
      )
      on conflict (id) do nothing
    `;
    await upsertProviderReplayData({
      workspaceId,
      messageId: HISTORY_AGENT_OLDER_REPLAY,
      sourceAgentId: providerReplayScope.sourceAgentId,
      providerId: providerReplayScope.providerId,
      modelId: providerReplayScope.modelId,
      providerData: {
        codexReasoningItems: [
          {
            encrypted_content: 'older-reasoning-ciphertext',
            summary: [],
          },
        ],
        codexMessageItems: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Older assistant body' }],
            status: 'completed',
          },
        ],
      },
    });

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      const encryptedItems = context.history.flatMap(
        (message) =>
          message.providerData?.codexReasoningItems?.map(
            (item) => item.encrypted_content,
          ) ?? [],
      );
      expect(encryptedItems).toEqual([
        'older-reasoning-ciphertext',
        'reasoning-ciphertext',
      ]);
    });
  });

  it('keeps provider replay as a contiguous newest tail when the budget fills', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();
    const workspaceId = await getWorkspaceId();
    const db = getDbPg();
    await db`
      insert into public.messages (
        id, workspace_id, talk_id, round, author_kind, author_user_id,
        agent_snapshot_id, run_id, body, metadata_json, created_at
      )
      values
        (
          ${HISTORY_AGENT_OLDER_REPLAY}::uuid,
          ${workspaceId}::uuid,
          ${TALK}::uuid,
          1,
          'agent',
          null,
          ${HISTORY_SNAPSHOT}::uuid,
          ${HISTORY_RUN}::uuid,
          'Older assistant body',
          ${db.json({} as never)},
          '2026-05-26T09:59:20Z'::timestamptz
        ),
        (
          ${HISTORY_AGENT_MIDDLE_REPLAY}::uuid,
          ${workspaceId}::uuid,
          ${TALK}::uuid,
          1,
          'agent',
          null,
          ${HISTORY_SNAPSHOT}::uuid,
          ${HISTORY_RUN}::uuid,
          'Middle assistant body',
          ${db.json({} as never)},
          '2026-05-26T09:59:30Z'::timestamptz
        )
      on conflict (id) do nothing
    `;
    await upsertProviderReplayData({
      workspaceId,
      messageId: HISTORY_AGENT_OLDER_REPLAY,
      sourceAgentId: providerReplayScope.sourceAgentId,
      providerId: providerReplayScope.providerId,
      modelId: providerReplayScope.modelId,
      providerData: {
        codexReasoningItems: [
          {
            encrypted_content: 'older-reasoning-ciphertext',
            summary: [],
          },
        ],
      },
    });
    await upsertProviderReplayData({
      workspaceId,
      messageId: HISTORY_AGENT_MIDDLE_REPLAY,
      sourceAgentId: providerReplayScope.sourceAgentId,
      providerId: providerReplayScope.providerId,
      modelId: providerReplayScope.modelId,
      providerData: {
        codexReasoningItems: [
          {
            encrypted_content: 'm'.repeat(60_000),
            summary: [],
          },
        ],
      },
    });
    await upsertProviderReplayData({
      workspaceId,
      messageId: HISTORY_AGENT_MESSAGE,
      sourceAgentId: providerReplayScope.sourceAgentId,
      providerId: providerReplayScope.providerId,
      modelId: providerReplayScope.modelId,
      providerData: {
        codexReasoningItems: [
          {
            encrypted_content: 'n'.repeat(10_000),
            summary: [],
          },
        ],
      },
    });

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      const encryptedItems = context.history.flatMap(
        (message) =>
          message.providerData?.codexReasoningItems?.map(
            (item) => item.encrypted_content,
          ) ?? [],
      );
      expect(encryptedItems).toEqual(['n'.repeat(10_000)]);
      expect(
        context.history.map((message) =>
          typeof message.content === 'string' ? message.content : '',
        ),
      ).toEqual(
        expect.arrayContaining([
          'Older assistant body',
          'Middle assistant body',
          'Assistant history body',
        ]),
      );
    });
  });

  it('preserves nullable-body message turns and aligned history ids', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();
    const workspaceId = await getWorkspaceId();
    const db = getDbPg();
    await db`
      insert into public.messages (
        id, workspace_id, talk_id, round, author_kind, author_user_id,
        agent_snapshot_id, run_id, body, metadata_json, created_at
      )
      values
        (
          ${HISTORY_USER_EMPTY}::uuid,
          ${workspaceId}::uuid,
          ${TALK}::uuid,
          1,
          'user',
          ${USER}::uuid,
          null,
          null,
          null,
          ${db.json({} as never)},
          '2026-05-26T09:59:15Z'::timestamptz
        ),
        (
          ${HISTORY_AGENT_EMPTY}::uuid,
          ${workspaceId}::uuid,
          ${TALK}::uuid,
          1,
          'agent',
          null,
          ${HISTORY_SNAPSHOT}::uuid,
          ${HISTORY_RUN}::uuid,
          '',
          ${db.json({} as never)},
          '2026-05-26T09:59:30Z'::timestamptz
        )
      on conflict (id) do nothing
    `;

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      expect(context.history.map((message) => message.role)).toEqual([
        'user',
        'user',
        'assistant',
        'assistant',
      ]);
      expect(context.history.map((message) => message.content)).toEqual([
        'Earlier user body',
        '[No text content in this turn]',
        '[No text content in this turn]',
        'Assistant history body',
      ]);
      expect(context.metadata.historyMessageIds).toEqual([
        HISTORY_USER_OLD,
        HISTORY_USER_EMPTY,
        HISTORY_AGENT_EMPTY,
        HISTORY_AGENT_MESSAGE,
      ]);
    });
  });

  it('drops final-schema provider data when provider replay scope does not match', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        {
          effectiveTools: [],
          providerReplayScope: {
            ...providerReplayScope,
            modelId: 'different-model',
          },
        },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        { role: 'assistant', content: 'Assistant history body' },
      ]);
    });
  });

  it('drops final-schema provider data when the source agent does not match', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        {
          effectiveTools: [],
          providerReplayScope: {
            ...providerReplayScope,
            sourceAgentId: OTHER_SOURCE_AGENT,
          },
        },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        { role: 'assistant', content: 'Assistant history body' },
      ]);
      expect(context.history.some((message) => message.providerData)).toBe(
        false,
      );
    });
  });

  it('drops final-schema provider data when the provider does not match', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        {
          effectiveTools: [],
          providerReplayScope: {
            ...providerReplayScope,
            providerId: 'provider.openai',
          },
        },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        { role: 'assistant', content: 'Assistant history body' },
      ]);
      expect(context.history.some((message) => message.providerData)).toBe(
        false,
      );
    });
  });

  it('drops final-schema provider data when the message snapshot identity drifts', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();
    const db = getDbPg();
    const [alternateModel] = await db<
      Array<{ provider_id: string; model_id: string }>
    >`
      select provider_id, model_id
      from public.llm_provider_models
      where (provider_id, model_id) <> (
        ${providerReplayScope.providerId},
        ${providerReplayScope.modelId}
      )
      order by provider_id asc, model_id asc
      limit 1
    `;
    if (!alternateModel) throw new Error('alternate provider model missing');
    await db`
      update public.talk_agent_snapshots
      set provider_id = ${alternateModel.provider_id},
          model_id = ${alternateModel.model_id}
      where id = ${HISTORY_SNAPSHOT}::uuid
    `;

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        { role: 'assistant', content: 'Assistant history body' },
      ]);
      expect(context.history.some((message) => message.providerData)).toBe(
        false,
      );
    });
  });

  it('skips oversized final-schema provider data while keeping transcript text', async () => {
    const providerReplayScope = await seedFinalSchemaMessageHistory();
    const workspaceId = await getWorkspaceId();
    await upsertProviderReplayData({
      workspaceId,
      messageId: HISTORY_AGENT_MESSAGE,
      sourceAgentId: providerReplayScope.sourceAgentId,
      providerId: providerReplayScope.providerId,
      modelId: providerReplayScope.modelId,
      providerData: {
        codexReasoningItems: [
          {
            encrypted_content: 'x'.repeat(70_000),
            summary: [],
          },
        ],
      },
    });

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_AGENT_MESSAGE,
        USER,
        { effectiveTools: [], providerReplayScope },
      );

      expect(context.history).toEqual([
        { role: 'user', content: 'Earlier user body' },
        { role: 'assistant', content: 'Assistant history body' },
      ]);
      expect(context.history.some((message) => message.providerData)).toBe(
        false,
      );
    });
  });

  it('does not load full history when the requested cutoff message is missing', async () => {
    await seedFinalSchemaMessageHistory();

    await withUserContext(USER, async () => {
      const context = await loadTalkContext(
        TALK,
        50000,
        null,
        HISTORY_MISSING_CUTOFF,
        USER,
        { effectiveTools: [] },
      );

      expect(context.history).toEqual([]);
    });
  });

  it('avoids fallback source-ref collisions with explicit stored refs', async () => {
    await withUserContext(USER, async () => {
      const manifestRows = await fetchSources(getDbPg(), TALK);
      expect(
        manifestRows.filter((row) => row.source_ref === 'S9'),
      ).toHaveLength(0);
      expect(
        manifestRows.find((row) => row.id === COLLISION_STORED)?.source_ref,
      ).toBe(COLLISION_STORED);
      expect(
        manifestRows.find((row) => row.id === COLLISION_COMPUTED)?.source_ref,
      ).toBe(COLLISION_COMPUTED);

      const atRefRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        ['S9'],
        [],
      );
      expect(atRefRows.map((row) => row.id)).toEqual([COLLISION_STORED]);
      expect(atRefRows[0]?.source_ref).toBe(COLLISION_STORED);
    });
  });

  it('uses raw ids for sources without stored refs instead of ambiguous computed refs', async () => {
    await withUserContext(USER, async () => {
      const manifestRows = await fetchSources(getDbPg(), TALK);
      expect(
        manifestRows.find((row) => row.id === DUPLICATE_COMPUTED_A)?.source_ref,
      ).toBe(DUPLICATE_COMPUTED_A);
      expect(
        manifestRows.find((row) => row.id === DUPLICATE_COMPUTED_B)?.source_ref,
      ).toBe(DUPLICATE_COMPUTED_B);
      expect(
        manifestRows.filter((row) => row.source_ref === 'S43'),
      ).toHaveLength(0);

      const computedRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        ['S43'],
        [],
      );
      expect(computedRows).toEqual([]);

      const rawRows = await fetchAtRefCandidateRows(
        getDbPg(),
        TALK,
        [DUPLICATE_COMPUTED_A],
        [],
      );
      expect(rawRows.map((row) => row.id)).toEqual([DUPLICATE_COMPUTED_A]);
    });
  });

  it('resolves raw UUID fallback refs through the real @-mention path', async () => {
    await withUserContext(USER, async () => {
      const parsed = extractSourceReferences(
        `Please use @${DUPLICATE_COMPUTED_A.toUpperCase()}.`,
      );
      expect(parsed).toEqual({
        refs: [DUPLICATE_COMPUTED_A],
        slugs: [],
      });

      const result = await buildAtRefForcedInjection(
        getDbPg(),
        TALK,
        parsed.refs,
        parsed.slugs,
      );

      expect(result.text).toContain(
        `[${DUPLICATE_COMPUTED_A}] Duplicate computed A`,
      );
      expect(result.text).toContain('Duplicate computed text A');
    });
  });

  it('resolves raw UUID refs for sources that also have stored sourceRefs', async () => {
    await withUserContext(USER, async () => {
      const parsed = extractSourceReferences(
        `Please use @${READY_TEXT.toUpperCase()}.`,
      );
      expect(parsed).toEqual({
        refs: [READY_TEXT],
        slugs: [],
      });

      const result = await buildAtRefForcedInjection(
        getDbPg(),
        TALK,
        parsed.refs,
        parsed.slugs,
      );

      expect(result.text).toContain(`[${READY_TEXT}] Readiness Source S2`);
      expect(result.text).toContain('Extracted text S2');
    });
  });

  it('prefers raw UUID refs over conflicting legacy sourceRef aliases', async () => {
    const db = getDbPg();
    const workspaceId = await getWorkspaceId();
    await db`
      insert into public.context_sources (
        id, workspace_id, talk_id, kind, name, payload_ref, extracted_text,
        meta_json, expected_page_count, include_in_prompt, sort_order,
        added_by_user_id
      )
      values (
        ${RAW_ALIAS_COLLIDER}::uuid,
        ${workspaceId}::uuid,
        ${TALK}::uuid,
        'file',
        'Legacy alias collider',
        ${`attachments/${TALK}/${RAW_ALIAS_COLLIDER}.txt`},
        'Legacy alias collider text',
        ${db.json({
          compatKind: 'source',
          sourceRef: READY_TEXT.toUpperCase(),
          sourceType: 'file',
          fileName: 'legacy-alias-collider.txt',
          mimeType: 'text/plain',
          status: 'ready',
        } as never)},
        null,
        true,
        200,
        ${USER}::uuid
      )
    `;

    await withUserContext(USER, async () => {
      const candidateRows = await fetchAtRefCandidateRows(
        db,
        TALK,
        [READY_TEXT.toUpperCase()],
        [],
      );
      expect(candidateRows.map((row) => row.id)).toEqual(
        expect.arrayContaining([READY_TEXT, RAW_ALIAS_COLLIDER]),
      );

      const result = await buildAtRefForcedInjection(
        db,
        TALK,
        [READY_TEXT.toUpperCase()],
        [],
      );

      expect(result.text).toContain(`[${READY_TEXT}] Readiness Source S2`);
      expect(result.text).toContain('Extracted text S2');
      expect(result.text).not.toContain('Legacy alias collider');
    });
  });

  it('resolves failed-extraction PDF slugs for native document attachment', async () => {
    await withUserContext(USER, async () => {
      const result = await buildAtRefForcedInjection(
        getDbPg(),
        TALK,
        [],
        ['readiness-source-s3'],
        { agentSupportsDocuments: true },
      );

      expect(result.forcedPdfDocuments.map((row) => row.id)).toEqual([
        FAILED_COMPLETE,
      ]);
      expect(result.text).toContain(`[${FAILED_COMPLETE}] Readiness Source S3`);
      expect(result.text).toContain('native document block');
    });
  });
});
