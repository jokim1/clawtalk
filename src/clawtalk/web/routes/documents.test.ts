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
import type { AuthContext } from '../types.js';
import {
  acceptDocumentEditRoute,
  getDocumentRoute,
  listDocumentEditsRoute,
  listDocumentsRoute,
  rejectDocumentEditRoute,
} from './documents.js';

const USER_ID = '0c666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GUEST_USER_ID = '0c666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_USER_ID = '0c666666-cccc-cccc-cccc-cccccccccccc';

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
});
