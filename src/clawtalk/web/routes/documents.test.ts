import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedTalk,
} from '../../db/test-helpers.js';
import { documentEditMutationLockKey } from '../../documents/edit-locks.js';
import { executeGreenfieldApplyContentEdit } from '../../talks/greenfield-document-tools.js';
import type { AuthContext } from '../types.js';
import {
  acceptAllDocumentEditsRoute,
  createDocumentRoute,
  acceptDocumentEditRoute,
  acceptDocumentEditRunRoute,
  getDocumentRoute,
  listDocumentEditsRoute,
  listDocumentsRoute,
  rejectAllDocumentEditsRoute,
  rejectDocumentEditRoute,
  rejectDocumentEditRunRoute,
} from './documents.js';

const USER_ID = '0c666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GUEST_USER_ID = '0c666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_USER_ID = '0c666666-cccc-cccc-cccc-cccccccccccc';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function auth(userId = USER_ID): AuthContext {
  return {
    sessionId: `documents-${userId}`,
    userId,
    role: 'owner',
    authType: 'bearer',
  };
}

async function workspaceForTalk(talkId: string): Promise<string> {
  const rows = await getDbPg()<Array<{ workspace_id: string }>>`
    select workspace_id
    from public.talks
    where id = ${talkId}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error('Expected talk workspace fixture');
  return row.workspace_id;
}

async function addGuestToWorkspace(workspaceId: string): Promise<void> {
  await getDbPg()`
    insert into public.workspace_members (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${GUEST_USER_ID}::uuid, 'guest')
    on conflict (workspace_id, user_id) do update set role = excluded.role
  `;
}

async function createDocumentFixture(input?: {
  ownerId?: string;
  title?: string;
  linked?: boolean;
}): Promise<{
  workspaceId: string;
  talkId: string;
  documentId: string;
  mainTabId: string;
  secondaryTabId: string;
  mainBlockId: string;
  mainBlockVersion: number;
  mainListVersion: number;
  secondaryBlockId: string;
  secondaryBlockVersion: number;
  secondaryListVersion: number;
}> {
  const ownerId = input?.ownerId ?? USER_ID;
  const talkId = await seedTalk({
    ownerId,
    topicTitle: input?.title ?? 'Native Documents Talk',
  });
  const workspaceId = await workspaceForTalk(talkId);
  const db = getDbPg();
  const [document] = await db<Array<{ id: string }>>`
    insert into public.documents (
      workspace_id, primary_talk_id, title, format, word_count
    )
    values (
      ${workspaceId}::uuid,
      ${input?.linked === false ? null : talkId}::uuid,
      ${input?.title ?? 'Native Draft'},
      'markdown',
      4
    )
    returning id
  `;
  const [mainTab] = await db<Array<{ id: string; list_version: number }>>`
    insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
    values (${workspaceId}::uuid, ${document!.id}::uuid, 'Main', 0)
    returning id, list_version
  `;
  const [secondaryTab] = await db<Array<{ id: string; list_version: number }>>`
    insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
    values (${workspaceId}::uuid, ${document!.id}::uuid, 'Research', 1)
    returning id, list_version
  `;
  const [mainBlock] = await db<Array<{ id: string; version: number }>>`
    insert into public.doc_blocks (
      workspace_id, document_id, tab_id, sort_order, kind, text
    )
    values (
      ${workspaceId}::uuid,
      ${document!.id}::uuid,
      ${mainTab!.id}::uuid,
      0,
      'p',
      'Original paragraph.'
    )
    returning id, version
  `;
  const [secondaryBlock] = await db<Array<{ id: string; version: number }>>`
    insert into public.doc_blocks (
      workspace_id, document_id, tab_id, sort_order, kind, text
    )
    values (
      ${workspaceId}::uuid,
      ${document!.id}::uuid,
      ${secondaryTab!.id}::uuid,
      0,
      'h2',
      'Research notes'
    )
    returning id, version
  `;
  return {
    workspaceId,
    talkId,
    documentId: document!.id,
    mainTabId: mainTab!.id,
    secondaryTabId: secondaryTab!.id,
    mainBlockId: mainBlock!.id,
    mainBlockVersion: mainBlock!.version,
    mainListVersion: mainTab!.list_version,
    secondaryBlockId: secondaryBlock!.id,
    secondaryBlockVersion: secondaryBlock!.version,
    secondaryListVersion: secondaryTab!.list_version,
  };
}

async function insertPendingDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  op: 'insert' | 'replace' | 'delete';
  runId?: string | null;
  blockId?: string | null;
  afterBlockId?: string | null;
  baseBlockVersion?: number | null;
  baseListVersion?: number | null;
  newText?: string | null;
  newKind?: string | null;
}): Promise<string> {
  const [edit] = await getDbPg()<Array<{ id: string }>>`
    insert into public.document_edits (
      workspace_id,
      document_id,
      tab_id,
      proposed_by_run_id,
      op,
      block_id,
      after_block_id,
      base_block_version,
      base_list_version,
      new_kind,
      new_text
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.documentId}::uuid,
      ${input.tabId}::uuid,
      ${input.runId ?? null}::uuid,
      ${input.op},
      ${input.blockId ?? null}::uuid,
      ${input.afterBlockId ?? null}::uuid,
      ${input.baseBlockVersion ?? null},
      ${input.baseListVersion ?? null},
      ${input.newKind ?? null},
      ${input.newText ?? null}
    )
    returning id
  `;
  if (!edit) throw new Error('Expected document edit fixture');
  return edit.id;
}

// Seed a completed run so edits can be grouped under `proposed_by_run_id` for
// the per-run bulk tests. Reuses a default workspace agent (provisioned by the
// workspace bootstrap) to satisfy the run's agent-snapshot FK.
async function seedRun(input: {
  workspaceId: string;
  talkId: string;
}): Promise<string> {
  const db = getDbPg();
  const [run] = await db<Array<{ id: string }>>`
    with source_agent as (
      select a.*, lpm.provider_id
      from public.agents a
      join public.llm_provider_models lpm
        on lpm.model_id = a.model_id
      where a.workspace_id = ${input.workspaceId}::uuid
      order by a.id asc, lpm.provider_id asc
      limit 1
    ),
    snapshot_group as (
      select gen_random_uuid() as id
    ),
    snapshot as (
      insert into public.talk_agent_snapshots (
        workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
        name, handle, initials, accent, accent_dark, provider_id, model_id, temperature,
        persona, focus, method, sort_order, role_template_version
      )
      select
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        snapshot_group.id,
        source_agent.id,
        source_agent.role_key,
        source_agent.name,
        source_agent.handle,
        source_agent.initials,
        source_agent.accent,
        source_agent.accent_dark,
        source_agent.provider_id,
        source_agent.model_id,
        source_agent.temperature,
        source_agent.persona,
        source_agent.focus,
        source_agent.method,
        0,
        source_agent.created_from_template_version
      from source_agent, snapshot_group
      returning id, snapshot_group_id, model_id
    )
    insert into public.runs (
      workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
      model_id, requested_by, response_group_id, sequence_index, status,
      started_at, finished_at
    )
    select
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      1,
      snapshot.snapshot_group_id,
      snapshot.id,
      snapshot.model_id,
      ${USER_ID}::uuid,
      'response-1',
      0,
      'completed',
      now(),
      now()
    from snapshot
    returning id
  `;
  if (!run) throw new Error('Expected run fixture');
  return run.id;
}

async function editStatus(editId: string): Promise<string> {
  const [row] = await getDbPg()<Array<{ status: string }>>`
    select status
    from public.document_edits
    where id = ${editId}::uuid
  `;
  if (!row) throw new Error('Expected document edit row');
  return row.status;
}

async function blockText(blockId: string): Promise<string> {
  const [row] = await getDbPg()<Array<{ text: string }>>`
    select text
    from public.doc_blocks
    where id = ${blockId}::uuid
  `;
  if (!row) throw new Error('Expected document block row');
  return row.text;
}

async function waitForDocumentEditMutationLockHeld(input: {
  workspaceId: string;
  documentId: string;
  timeoutMs?: number;
}): Promise<void> {
  const db = getDbPg();
  const key = documentEditMutationLockKey(input);
  const deadline = Date.now() + (input.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    const [row] = await db<Array<{ acquired: boolean }>>`
      select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
    `;
    if (row?.acquired === false) return;
    if (row?.acquired === true) {
      await db`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for document edit mutation lock');
}

describe('native document routes', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await purgeUserData([USER_ID, GUEST_USER_ID, OTHER_USER_ID]);
    await seedAuthUser({ id: USER_ID, email: 'documents@clawtalk.local' });
    await seedAuthUser({
      id: GUEST_USER_ID,
      email: 'documents-guest@clawtalk.local',
    });
    await seedAuthUser({
      id: OTHER_USER_ID,
      email: 'documents-other@clawtalk.local',
    });
  });

  afterAll(async () => {
    await purgeUserData([USER_ID, GUEST_USER_ID, OTHER_USER_ID]);
    await deleteAuthUsers([USER_ID, GUEST_USER_ID, OTHER_USER_ID]);
    await closePgDatabase();
  });

  it('lists linked documents by default and includes unlinked documents on request', async () => {
    const linked = await createDocumentFixture({ title: 'Linked Draft' });
    const unlinked = await createDocumentFixture({
      title: 'Loose Draft',
      linked: false,
    });

    const linkedOnly = await listDocumentsRoute({
      auth: auth(),
      workspaceId: linked.workspaceId,
    });
    expect(linkedOnly.body).toMatchObject({
      ok: true,
      data: {
        documents: [
          expect.objectContaining({
            id: linked.documentId,
            title: 'Linked Draft',
            primaryTalkId: linked.talkId,
            tabCount: 2,
            blockCount: 2,
          }),
        ],
      },
    });
    if (!linkedOnly.body.ok) throw new Error('Expected list to succeed');
    expect(linkedOnly.body.data.documents.map((doc) => doc.id)).not.toContain(
      unlinked.documentId,
    );

    const allDocuments = await listDocumentsRoute({
      auth: auth(),
      workspaceId: linked.workspaceId,
      includeUnlinked: true,
    });
    expect(allDocuments.body).toMatchObject({
      ok: true,
      data: {
        documents: expect.arrayContaining([
          expect.objectContaining({ id: linked.documentId }),
          expect.objectContaining({
            id: unlinked.documentId,
            primaryTalkId: null,
          }),
        ]),
      },
    });
  });

  it('creates a primary native document for a talk through the native route', async () => {
    const talkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Native Create Talk',
    });
    const workspaceId = await workspaceForTalk(talkId);

    const created = await createDocumentRoute({
      auth: auth(),
      threadId: talkId,
      title: 'Native Create Draft',
      format: 'html',
    });

    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      ok: true,
      data: {
        document: {
          primaryTalkId: talkId,
          workspaceId,
          title: 'Native Create Draft',
          format: 'html',
          tabCount: 1,
          blockCount: 0,
          pendingEditCount: 0,
          tabs: [
            {
              title: 'Main',
              sortOrder: 0,
              listVersion: 1,
              blocks: [],
            },
          ],
          pendingEdits: [],
        },
      },
    });
  });

  it('creates the primary document idempotently when one already exists', async () => {
    const talkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Existing Native Create Talk',
    });
    const workspaceId = await workspaceForTalk(talkId);

    const first = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'First Native Draft',
    });
    const second = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Second Native Draft',
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    if (!first.body.ok || !second.body.ok) {
      throw new Error('Expected native create to succeed');
    }
    expect(second.body.data.document.id).toBe(first.body.data.document.id);
    expect(second.body.data.document.title).toBe('First Native Draft');

    const [counts] = await getDbPg()<
      Array<{ document_count: number; tab_count: number; block_count: number }>
    >`
      select
        count(distinct d.id)::int as document_count,
        count(distinct dt.id)::int as tab_count,
        count(distinct db.id)::int as block_count
      from public.documents d
      left join public.doc_tabs dt
        on dt.workspace_id = d.workspace_id
       and dt.document_id = d.id
      left join public.doc_blocks db
        on db.workspace_id = d.workspace_id
       and db.document_id = d.id
      where d.workspace_id = ${workspaceId}::uuid
        and d.primary_talk_id = ${talkId}::uuid
    `;
    expect(counts).toEqual({
      document_count: 1,
      tab_count: 1,
      block_count: 0,
    });
  });

  it('rejects invalid native create payloads before writing', async () => {
    const talkId = await seedTalk({
      ownerId: USER_ID,
      topicTitle: 'Invalid Native Create Talk',
    });
    const workspaceId = await workspaceForTalk(talkId);

    const emptyTitle = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: ' ',
    });
    expect(emptyTitle.statusCode).toBe(400);
    expect(emptyTitle.body).toMatchObject({
      ok: false,
      error: { code: 'title_required' },
    });

    const badFormat = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Bad Format',
      format: 'plain',
    });
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_format' },
    });

    const missingTalk = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      title: 'Missing Talk',
    });
    expect(missingTalk.statusCode).toBe(400);
    expect(missingTalk.body).toMatchObject({
      ok: false,
      error: { code: 'talk_id_required' },
    });

    const badThread = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      threadId: 'not-a-uuid',
      title: 'Bad Thread',
    });
    expect(badThread.statusCode).toBe(400);
    expect(badThread.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_thread_id' },
    });

    const mismatch = await createDocumentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: OTHER_USER_ID,
      title: 'Mismatched Thread',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toMatchObject({
      ok: false,
      error: { code: 'thread_talk_mismatch' },
    });

    const [count] = await getDbPg()<Array<{ count: number }>>`
      select count(*)::int as count
      from public.documents
      where workspace_id = ${workspaceId}::uuid
        and primary_talk_id = ${talkId}::uuid
    `;
    expect(count).toEqual({ count: 0 });
  });

  it('allows guest reads but denies native document creation', async () => {
    const fixture = await createDocumentFixture();
    await addGuestToWorkspace(fixture.workspaceId);

    const read = await getDocumentRoute({
      auth: auth(GUEST_USER_ID),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
    });
    expect(read.statusCode).toBe(200);

    const denied = await createDocumentRoute({
      auth: auth(GUEST_USER_ID),
      workspaceId: fixture.workspaceId,
      talkId: fixture.talkId,
      title: 'Guest Native Draft',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_writer_required' },
    });
  });

  it('reads native tabs, blocks, and pending edit proposals', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.mainTabId,
      op: 'replace',
      blockId: fixture.mainBlockId,
      baseBlockVersion: fixture.mainBlockVersion,
      newText: 'Proposed replacement.',
    });

    const detail = await getDocumentRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
    });
    expect(detail.body).toMatchObject({
      ok: true,
      data: {
        document: {
          id: fixture.documentId,
          pendingEditCount: 1,
          tabs: [
            {
              id: fixture.mainTabId,
              listVersion: fixture.mainListVersion,
              blocks: [
                {
                  id: fixture.mainBlockId,
                  kind: 'p',
                  text: 'Original paragraph.',
                },
              ],
            },
            {
              id: fixture.secondaryTabId,
              title: 'Research',
              blocks: [{ kind: 'h2', text: 'Research notes' }],
            },
          ],
          pendingEdits: [
            {
              id: editId,
              documentId: fixture.documentId,
              tabId: fixture.mainTabId,
              blockId: fixture.mainBlockId,
              baseBlockVersion: fixture.mainBlockVersion,
              op: 'replace',
              newText: 'Proposed replacement.',
              status: 'pending',
            },
          ],
        },
      },
    });

    const pending = await listDocumentEditsRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
    });
    expect(pending.body).toMatchObject({
      ok: true,
      data: { edits: [expect.objectContaining({ id: editId })] },
    });
  });

  it('accepts a pending edit and returns the refreshed native document', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.mainTabId,
      op: 'replace',
      blockId: fixture.mainBlockId,
      baseBlockVersion: fixture.mainBlockVersion,
      newText: 'Accepted replacement.',
    });

    const accepted = await acceptDocumentEditRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      editId,
    });
    expect(accepted.body).toMatchObject({
      ok: true,
      data: {
        editId,
        document: {
          id: fixture.documentId,
          pendingEditCount: 0,
          pendingEdits: [],
          tabs: [
            {
              id: fixture.mainTabId,
              listVersion: fixture.mainListVersion + 1,
              blocks: [
                {
                  id: fixture.mainBlockId,
                  version: fixture.mainBlockVersion + 1,
                  text: 'Accepted replacement.',
                },
              ],
            },
            expect.any(Object),
          ],
        },
      },
    });
    expect(await editStatus(editId)).toBe('accepted');
  });

  it('checks expected versions against the target native tab', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.secondaryTabId,
      op: 'replace',
      blockId: fixture.secondaryBlockId,
      baseBlockVersion: fixture.secondaryBlockVersion,
      newText: 'Secondary accepted with native CAS.',
    });
    await getDbPg()`
      update public.doc_tabs
      set list_version = list_version + 1
      where id = ${fixture.mainTabId}::uuid
    `;

    const accepted = await acceptDocumentEditRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      editId,
      expectedContentVersion: fixture.secondaryListVersion,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      data: {
        document: {
          tabs: expect.arrayContaining([
            expect.objectContaining({
              id: fixture.secondaryTabId,
              listVersion: fixture.secondaryListVersion + 1,
              blocks: [
                expect.objectContaining({
                  id: fixture.secondaryBlockId,
                  text: 'Secondary accepted with native CAS.',
                }),
              ],
            }),
          ]),
        },
      },
    });
    expect(await editStatus(editId)).toBe('accepted');
  });

  it('rejects a pending edit without changing the target block', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.mainTabId,
      op: 'delete',
      blockId: fixture.mainBlockId,
      baseBlockVersion: fixture.mainBlockVersion,
    });

    const rejected = await rejectDocumentEditRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      editId,
    });
    expect(rejected.body).toMatchObject({
      ok: true,
      data: {
        editId,
        document: {
          id: fixture.documentId,
          pendingEditCount: 0,
          pendingEdits: [],
        },
      },
    });
    expect(await editStatus(editId)).toBe('rejected');
    expect(await blockText(fixture.mainBlockId)).toBe('Original paragraph.');
  });

  it('returns a conflict when an edit target version is stale', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.mainTabId,
      op: 'replace',
      blockId: fixture.mainBlockId,
      baseBlockVersion: fixture.mainBlockVersion,
      newText: 'Stale replacement.',
    });
    await getDbPg()`
      update public.doc_blocks
      set version = version + 1
      where id = ${fixture.mainBlockId}::uuid
    `;

    const stale = await acceptDocumentEditRoute({
      auth: auth(),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      editId,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      ok: false,
      error: {
        code: 'version_conflict',
        details: { currentVersion: fixture.mainBlockVersion + 1 },
      },
    });
    expect(await editStatus(editId)).toBe('pending');
  });

  it('allows guest reads but denies edit resolution', async () => {
    const fixture = await createDocumentFixture();
    const editId = await insertPendingDocumentEdit({
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      tabId: fixture.mainTabId,
      op: 'replace',
      blockId: fixture.mainBlockId,
      baseBlockVersion: fixture.mainBlockVersion,
      newText: 'Guest must not apply this.',
    });
    await addGuestToWorkspace(fixture.workspaceId);

    const read = await getDocumentRoute({
      auth: auth(GUEST_USER_ID),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
    });
    expect(read.statusCode).toBe(200);

    const denied = await acceptDocumentEditRoute({
      auth: auth(GUEST_USER_ID),
      workspaceId: fixture.workspaceId,
      documentId: fixture.documentId,
      editId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      ok: false,
      error: { code: 'workspace_writer_required' },
    });
    expect(await editStatus(editId)).toBe('pending');
  });

  it('returns not-found for missing rows and inaccessible documents', async () => {
    const own = await createDocumentFixture({ title: 'Own Draft' });
    const other = await createDocumentFixture({
      ownerId: OTHER_USER_ID,
      title: 'Other Draft',
    });
    const missingDocumentId = randomUUID();
    const missingEditId = randomUUID();

    const missingDocument = await getDocumentRoute({
      auth: auth(),
      workspaceId: own.workspaceId,
      documentId: missingDocumentId,
    });
    expect(missingDocument.statusCode).toBe(404);
    expect(missingDocument.body).toMatchObject({
      ok: false,
      error: { code: 'document_not_found' },
    });

    const inaccessible = await getDocumentRoute({
      auth: auth(),
      documentId: other.documentId,
    });
    expect(inaccessible.statusCode).toBe(404);
    expect(inaccessible.body).toMatchObject({
      ok: false,
      error: { code: 'document_not_found' },
    });

    const missingEdit = await acceptDocumentEditRoute({
      auth: auth(),
      workspaceId: own.workspaceId,
      documentId: own.documentId,
      editId: missingEditId,
    });
    expect(missingEdit.statusCode).toBe(404);
    expect(missingEdit.body).toMatchObject({
      ok: false,
      error: { code: 'pending_edit_not_found' },
    });
  });

  describe('bulk accept/reject gate on the reviewed edit set', () => {
    it('accept-all aborts and applies nothing when an unseen pending edit slipped in', async () => {
      const fixture = await createDocumentFixture();
      const seenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Reviewed replacement.',
      });
      // The reviewer loaded the page seeing only [seenEditId]; a job then
      // appends a brand-new pending edit they never saw.
      const unseenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'insert',
        baseListVersion: fixture.mainListVersion,
        newKind: 'p',
        newText: 'Unseen appended paragraph.',
      });

      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [seenEditId],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: {
          code: 'edit_set_mismatch',
          details: {
            pendingEditIds: expect.arrayContaining([seenEditId, unseenEditId]),
          },
        },
      });
      // Nothing resolved — not the seen edit, and crucially not the unseen one.
      expect(await editStatus(seenEditId)).toBe('pending');
      expect(await editStatus(unseenEditId)).toBe('pending');
      expect(await blockText(fixture.mainBlockId)).toBe('Original paragraph.');
    });

    it('accept-all applies every edit when the reviewed set matches the server', async () => {
      const fixture = await createDocumentFixture();
      const editA = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'A applied.',
      });
      const editB = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.secondaryTabId,
        op: 'replace',
        blockId: fixture.secondaryBlockId,
        baseBlockVersion: fixture.secondaryBlockVersion,
        newText: 'B applied.',
      });

      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [editA, editB],
      });

      expect(result.statusCode).toBe(200);
      if (!result.body.ok) throw new Error('Expected accept-all to succeed');
      expect(result.body.data.editIds).toEqual(
        expect.arrayContaining([editA, editB]),
      );
      expect(result.body.data.document.pendingEditCount).toBe(0);
      expect(await editStatus(editA)).toBe('accepted');
      expect(await editStatus(editB)).toBe('accepted');
    });

    it('keeps a concurrent same-block proposal pending instead of superseding it during accept', async () => {
      const fixture = await createDocumentFixture();
      const acceptedEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Accepted replacement.',
      });
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const db = getDbPg();

      let acceptPromise:
        | ReturnType<typeof acceptAllDocumentEditsRoute>
        | undefined;
      let proposalPromise:
        | ReturnType<typeof executeGreenfieldApplyContentEdit>
        | undefined;

      await db.begin(async (tx) => {
        await tx`
          select id
          from public.doc_blocks
          where id = ${fixture.mainBlockId}::uuid
          for update
        `;

        acceptPromise = acceptAllDocumentEditsRoute({
          auth: auth(),
          workspaceId: fixture.workspaceId,
          documentId: fixture.documentId,
          reviewedEditIds: [acceptedEditId],
        });
        await waitForDocumentEditMutationLockHeld({
          workspaceId: fixture.workspaceId,
          documentId: fixture.documentId,
        });

        proposalPromise = executeGreenfieldApplyContentEdit({
          workspaceId: fixture.workspaceId,
          talkId: fixture.talkId,
          runId,
          agentId: null,
          agentNickname: null,
          args: {
            kind: 'replace',
            anchor: fixture.mainBlockId,
            markdown: 'Concurrent proposal.',
            rationale: 'Race regression coverage.',
          },
        });

        const proposalState = await Promise.race([
          proposalPromise.then(() => 'completed' as const),
          delay(75).then(() => 'blocked' as const),
        ]);
        expect(proposalState).toBe('blocked');
      });

      if (!acceptPromise || !proposalPromise) {
        throw new Error('Expected accept and proposal promises to be started');
      }
      const accepted = await acceptPromise;
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toMatchObject({
        ok: true,
        data: { editIds: [acceptedEditId] },
      });

      const proposal = await proposalPromise;
      expect(proposal.isError).not.toBe(true);
      const proposalBody = JSON.parse(proposal.result) as { editIds: string[] };
      const proposalEditId = proposalBody.editIds[0];
      expect(proposalEditId).toBeTruthy();
      expect(await editStatus(acceptedEditId)).toBe('accepted');
      expect(await editStatus(proposalEditId!)).toBe('pending');
      expect(await blockText(fixture.mainBlockId)).toBe(
        'Accepted replacement.',
      );
    });

    it('reject-all aborts and rejects nothing when an unseen pending edit slipped in', async () => {
      const fixture = await createDocumentFixture();
      const seenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Reviewed replacement.',
      });
      const unseenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'insert',
        baseListVersion: fixture.mainListVersion,
        newKind: 'p',
        newText: 'Unseen appended paragraph.',
      });

      const result = await rejectAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [seenEditId],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'edit_set_mismatch' },
      });
      expect(await editStatus(seenEditId)).toBe('pending');
      expect(await editStatus(unseenEditId)).toBe('pending');
    });

    it('per-run accept aborts when the run gained an edit the reviewer never saw', async () => {
      const fixture = await createDocumentFixture();
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const seenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Run change A.',
      });
      const unseenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'insert',
        baseListVersion: fixture.mainListVersion,
        newKind: 'p',
        newText: 'Run change B (unseen).',
      });

      const result = await acceptDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId,
        reviewedEditIds: [seenEditId],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: {
          code: 'edit_set_mismatch',
          details: {
            pendingEditIds: expect.arrayContaining([seenEditId, unseenEditId]),
          },
        },
      });
      expect(await editStatus(seenEditId)).toBe('pending');
      expect(await editStatus(unseenEditId)).toBe('pending');
    });

    it('per-run accept applies exactly the reviewed run edits', async () => {
      const fixture = await createDocumentFixture();
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const editA = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Run A applied.',
      });
      const editB = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.secondaryTabId,
        runId,
        op: 'replace',
        blockId: fixture.secondaryBlockId,
        baseBlockVersion: fixture.secondaryBlockVersion,
        newText: 'Run B applied.',
      });

      const result = await acceptDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId,
        reviewedEditIds: [editA, editB],
      });

      expect(result.statusCode).toBe(200);
      if (!result.body.ok) throw new Error('Expected accept-run to succeed');
      expect(result.body.data.runId).toBe(runId);
      expect(result.body.data.editIds).toEqual(
        expect.arrayContaining([editA, editB]),
      );
      expect(await editStatus(editA)).toBe('accepted');
      expect(await editStatus(editB)).toBe('accepted');
    });

    it('per-run reject aborts when the run gained an edit the reviewer never saw', async () => {
      const fixture = await createDocumentFixture();
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const seenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Run change A.',
      });
      const unseenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'insert',
        baseListVersion: fixture.mainListVersion,
        newKind: 'p',
        newText: 'Run change B (unseen).',
      });

      const result = await rejectDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId,
        reviewedEditIds: [seenEditId],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'edit_set_mismatch' },
      });
      expect(await editStatus(seenEditId)).toBe('pending');
      expect(await editStatus(unseenEditId)).toBe('pending');
    });

    it('per-run reject rejects exactly the reviewed run edits and leaves blocks intact', async () => {
      const fixture = await createDocumentFixture();
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const editA = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'delete',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
      });
      const editB = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.secondaryTabId,
        runId,
        op: 'replace',
        blockId: fixture.secondaryBlockId,
        baseBlockVersion: fixture.secondaryBlockVersion,
        newText: 'Run B rejected.',
      });

      const result = await rejectDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId,
        reviewedEditIds: [editA, editB],
      });

      expect(result.statusCode).toBe(200);
      if (!result.body.ok) throw new Error('Expected reject-run to succeed');
      expect(result.body.data.editIds).toEqual(
        expect.arrayContaining([editA, editB]),
      );
      expect(await editStatus(editA)).toBe('rejected');
      expect(await editStatus(editB)).toBe('rejected');
      expect(await blockText(fixture.mainBlockId)).toBe('Original paragraph.');
    });

    it('rejects a bulk request whose reviewedEditIds is missing or malformed', async () => {
      const fixture = await createDocumentFixture();

      const missing = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_reviewed_edit_ids' },
      });

      const malformed = await rejectAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: ['not-a-uuid'],
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_reviewed_edit_ids' },
      });
    });

    it('rejects a per-run bulk request whose reviewedEditIds is missing or malformed', async () => {
      const fixture = await createDocumentFixture();
      // Validation precedes the workspace/accessor, so a syntactically valid
      // (unused) run id is enough — no run fixture needed. reject-run is checked
      // explicitly because its route has a different early-return shape.
      const acceptMissing = await acceptDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId: randomUUID(),
      });
      expect(acceptMissing.statusCode).toBe(400);
      expect(acceptMissing.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_reviewed_edit_ids' },
      });

      const rejectMalformed = await rejectDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId: randomUUID(),
        reviewedEditIds: ['not-a-uuid'],
      });
      expect(rejectMalformed.statusCode).toBe(400);
      expect(rejectMalformed.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_reviewed_edit_ids' },
      });
    });

    it('accept-all aborts when the reviewer saw zero edits but a job created the first one', async () => {
      const fixture = await createDocumentFixture();
      // The reviewer opened a document with no pending edits (reviewedEditIds:
      // []), then a job proposed the very first edit. An empty reviewed set must
      // still gate — this is the unseen-edit bug for a zero-edit reviewer.
      const unseenEditId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'First proposal, never seen.',
      });

      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: {
          code: 'edit_set_mismatch',
          details: { pendingEditIds: [unseenEditId] },
        },
      });
      expect(await editStatus(unseenEditId)).toBe('pending');
    });

    it('accept-all on a document with no pending edits is a no-op when the reviewed set is also empty', async () => {
      const fixture = await createDocumentFixture();

      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [],
      });

      expect(result.statusCode).toBe(200);
      if (!result.body.ok) throw new Error('Expected accept-all to succeed');
      expect(result.body.data.editIds).toEqual([]);
      expect(result.body.data.document.pendingEditCount).toBe(0);
    });

    it('accept-all aborts when a reviewed edit was resolved by someone else (server set shrank)', async () => {
      const fixture = await createDocumentFixture();
      const editA = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Still-pending change.',
      });
      const editB = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.secondaryTabId,
        op: 'replace',
        blockId: fixture.secondaryBlockId,
        baseBlockVersion: fixture.secondaryBlockVersion,
        newText: 'Concurrently resolved change.',
      });
      // The reviewer saw [editA, editB]; editB was rejected by a concurrent
      // action, so the server's pending set has shrunk to [editA].
      await getDbPg()`
        update public.document_edits
        set status = 'rejected', resolved_at = now()
        where id = ${editB}::uuid
      `;

      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [editA, editB],
      });

      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        ok: false,
        error: {
          code: 'edit_set_mismatch',
          details: { pendingEditIds: [editA] },
        },
      });
      // The still-pending edit was not applied — the reviewer must re-check.
      expect(await editStatus(editA)).toBe('pending');
    });

    it('accept-all matches case-insensitively: upper-case reviewed ids gate against lower-case server ids', async () => {
      const fixture = await createDocumentFixture();
      const editId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Case-insensitive accept.',
      });

      // Postgres returns the edit id lower-cased; the route accepts upper-case
      // UUIDs, so a client sending the canonical-but-upper-case id must still
      // match (no spurious edit_set_mismatch).
      const result = await acceptAllDocumentEditsRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        reviewedEditIds: [editId.toUpperCase()],
      });

      expect(result.statusCode).toBe(200);
      expect(await editStatus(editId)).toBe('accepted');
    });

    it('per-run accept matches case-insensitively on both the run id and reviewed ids', async () => {
      const fixture = await createDocumentFixture();
      const runId = await seedRun({
        workspaceId: fixture.workspaceId,
        talkId: fixture.talkId,
      });
      const editId = await insertPendingDocumentEdit({
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        tabId: fixture.mainTabId,
        runId,
        op: 'replace',
        blockId: fixture.mainBlockId,
        baseBlockVersion: fixture.mainBlockVersion,
        newText: 'Case-insensitive run accept.',
      });

      const result = await acceptDocumentEditRunRoute({
        auth: auth(),
        workspaceId: fixture.workspaceId,
        documentId: fixture.documentId,
        runId: runId.toUpperCase(),
        reviewedEditIds: [editId.toUpperCase()],
      });

      expect(result.statusCode).toBe(200);
      if (!result.body.ok) throw new Error('Expected accept-run to succeed');
      expect(result.body.data.editIds).toEqual([editId]);
      expect(await editStatus(editId)).toBe('accepted');
    });
  });
});
