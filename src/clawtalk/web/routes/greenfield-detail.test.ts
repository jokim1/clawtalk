import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { replaceGreenfieldDocumentBlocks } from '../../talks/greenfield-detail-accessors.js';
import type { AuthContext } from '../types.js';
import {
  createGreenfieldTalkRoute,
  getGreenfieldMeRoute,
  listGreenfieldAgentsRoute,
} from './greenfield-core.js';
import {
  acceptGreenfieldContentEditRoute,
  acceptGreenfieldContentEditRunRoute,
  createGreenfieldTalkContentRoute,
  createGreenfieldThreadRoute,
  deleteGreenfieldMessagesRoute,
  getGreenfieldSnapshotRoute,
  getGreenfieldThreadContentRoute,
  listGreenfieldMessagesRoute,
  listGreenfieldRunsRoute,
  listGreenfieldThreadsRoute,
  patchGreenfieldContentRoute,
  rejectGreenfieldContentEditRoute,
  rejectGreenfieldContentEditRunRoute,
  searchGreenfieldMessagesRoute,
} from './greenfield-detail.js';

const USER_ID = '0c939393-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function auth(): AuthContext {
  return {
    sessionId: 'greenfield-detail-session',
    userId: USER_ID,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${USER_ID}::uuid,
      'greenfield-detail@clawtalk.local',
      jsonb_build_object('full_name', 'Detail User')
    )
    on conflict (id) do update set
      email = excluded.email,
      raw_user_meta_data = excluded.raw_user_meta_data
  `;
}

async function deleteUser(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspaces where owner_id = ${USER_ID}::uuid
  `;
  await db`
    delete from auth.users where id = ${USER_ID}::uuid
  `;
}

async function createTalkFixture(): Promise<{
  workspaceId: string;
  talkId: string;
  agentIds: string[];
}> {
  const me = await getGreenfieldMeRoute({ auth: auth() });
  if (!me.body.ok) throw new Error('Expected session route to succeed');
  const workspaceId = me.body.data.currentWorkspaceId;
  const agents = await listGreenfieldAgentsRoute({ auth: auth(), workspaceId });
  if (!agents.body.ok) throw new Error('Expected agents route to succeed');
  const agentIds = agents.body.data.agents.slice(0, 2).map((agent) => agent.id);
  const created = await createGreenfieldTalkRoute({
    auth: auth(),
    workspaceId,
    body: { title: 'Detail Talk', team: agentIds, rounds: 3 },
  });
  if (!created.body.ok) throw new Error('Expected talk route to succeed');
  return { workspaceId, talkId: created.body.data.talk.id, agentIds };
}

async function seedMessages(input: {
  workspaceId: string;
  talkId: string;
  agentId: string;
}): Promise<{ userMessageId: string; agentMessageId: string; runId: string }> {
  const db = getDbPg();
  const [userMessage] = await db<{ id: string }[]>`
    insert into public.messages (
      workspace_id, talk_id, round, author_kind, author_user_id, body
    )
    values (
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      1,
      'user',
      ${USER_ID}::uuid,
      'Can you summarize the launch plan?'
    )
    returning id
  `;
  const [agentMessage] = await db<{ id: string; run_id: string }[]>`
    with source_agent as (
      select *
      from public.agents
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.agentId}::uuid
      limit 1
    ),
    snapshot_group as (
      select gen_random_uuid() as id
    ),
    snapshot as (
      insert into public.talk_agent_snapshots (
        workspace_id, talk_id, snapshot_group_id, source_agent_id, role_key,
        name, handle, initials, accent, accent_dark, model_id, temperature,
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
        source_agent.model_id,
        source_agent.temperature,
        source_agent.persona,
        source_agent.focus,
        source_agent.method,
        0,
        source_agent.created_from_template_version
      from source_agent, snapshot_group
      returning id, snapshot_group_id, model_id
    ),
    run as (
      insert into public.runs (
        workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
        model_id, requested_by, response_group_id, sequence_index, status,
        trigger_message_id, started_at, finished_at
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
        ${userMessage!.id}::uuid,
        now(),
        now()
      from snapshot
      returning id, agent_snapshot_id
    )
    insert into public.messages (
      workspace_id, talk_id, round, author_kind, agent_snapshot_id, run_id, body
    )
    select
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      1,
      'agent',
      run.agent_snapshot_id,
      run.id,
      'Launch plan summary: focus on onboarding.'
    from run
    returning id, run_id
  `;
  return {
    userMessageId: userMessage!.id,
    agentMessageId: agentMessage!.id,
    runId: agentMessage!.run_id,
  };
}

async function firstDocumentBlock(input: {
  workspaceId: string;
  documentId: string;
}): Promise<{ id: string; tab_id: string; version: number }> {
  const db = getDbPg();
  const [block] = await db<{ id: string; tab_id: string; version: number }[]>`
    select id, tab_id, version
    from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
    order by sort_order asc, id asc
    limit 1
  `;
  if (!block) throw new Error('Expected document block fixture');
  return block;
}

async function insertPendingDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  runId?: string | null;
  op: 'insert' | 'replace' | 'delete';
  blockId?: string | null;
  afterBlockId?: string | null;
  baseBlockVersion?: number | null;
  baseListVersion?: number | null;
  newText?: string | null;
  newKind?: string | null;
}): Promise<string> {
  const db = getDbPg();
  const [edit] = await db<{ id: string }[]>`
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
  if (!edit) throw new Error('Expected pending edit fixture');
  return edit.id;
}

describe('greenfield detail routes', () => {
  beforeAll(async () => {
    await initPgDatabase();
  });

  beforeEach(async () => {
    await deleteUser();
    await seedAuthUser();
  });

  afterAll(async () => {
    await deleteUser();
    await closePgDatabase();
  });

  it('serves messages, search, runs, snapshot, and a synthetic default thread', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const messages = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: talkId,
    });
    expect(messages.body).toMatchObject({
      ok: true,
      data: {
        talkId,
        messages: [
          { id: seeded.userMessageId, role: 'user', threadId: talkId },
          {
            id: seeded.agentMessageId,
            role: 'assistant',
            runId: seeded.runId,
            threadId: talkId,
          },
        ],
      },
    });

    const search = await searchGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      query: 'onboarding',
    });
    expect(search.body).toMatchObject({
      ok: true,
      data: {
        results: [{ messageId: seeded.agentMessageId, threadId: talkId }],
      },
    });

    const threads = await listGreenfieldThreadsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(threads.body).toMatchObject({
      ok: true,
      data: { threads: [{ id: talkId, talk_id: talkId, is_default: 1 }] },
    });

    const createdThread = await createGreenfieldThreadRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(createdThread.statusCode).toBe(201);
    expect(createdThread.body).toMatchObject({
      ok: true,
      data: { thread: { id: talkId, talk_id: talkId } },
    });

    const runs = await listGreenfieldRunsRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(runs.body).toMatchObject({
      ok: true,
      data: {
        runs: [
          {
            id: seeded.runId,
            status: 'completed',
            threadId: talkId,
            targetAgentId: agentIds[0],
          },
        ],
      },
    });

    const snapshot = await getGreenfieldSnapshotRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: talkId,
    });
    expect(snapshot.body).toMatchObject({
      ok: true,
      data: {
        activeThreadId: talkId,
        threads: [{ id: talkId, talkId, messageCount: 2 }],
        messages: [{ id: seeded.userMessageId }, { id: seeded.agentMessageId }],
        runs: [{ id: seeded.runId }],
        agents: [{ agentId: agentIds[0] }, { agentId: agentIds[1] }],
      },
    });
  });

  it('creates, patches, and reads primary document content through talk and thread endpoints', async () => {
    const { workspaceId, talkId } = await createTalkFixture();

    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    expect(created.statusCode).toBe(201);
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    expect(created.body.data.content).toMatchObject({
      talkId,
      threadId: talkId,
      title: 'Launch Draft',
      bodyVersion: 1,
    });
    const db = getDbPg();
    const [outboxStart] = await db<Array<{ event_id: number }>>`
      select coalesce(max(event_id), 0)::int as event_id
      from public.event_outbox
    `;

    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
      title: 'Launch Draft v2',
    });
    expect(patched.body).toMatchObject({
      ok: true,
      data: {
        content: {
          title: 'Launch Draft v2',
          bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
          bodyVersion: 2,
        },
      },
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const patchEvents = await db<
      Array<{ event_type: string; payload: Record<string, unknown> }>
    >`
      select event_type, payload
      from public.event_outbox
      where event_id > ${outboxStart!.event_id}
        and topic = ${`talk:${talkId}`}
      order by event_id
    `;
    expect(patchEvents).toHaveLength(1);
    expect(patchEvents[0]).toMatchObject({
      event_type: 'content_updated',
      payload: {
        contentId: created.body.data.content.id,
        version: patched.body.data.content.bodyVersion,
        format: 'markdown',
        appliedAnchorIds: [],
      },
    });

    const byThread = await getGreenfieldThreadContentRoute({
      auth: auth(),
      workspaceId,
      threadId: talkId,
    });
    expect(byThread.body).toMatchObject({
      ok: true,
      data: {
        content: {
          id: created.body.data.content.id,
          bodyMarkdown: '# Launch Draft\n\nShip the first greenfield slice.',
        },
        pendingEdits: [],
      },
    });

    const titled = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      title: 'Title-only bump',
    });
    expect(titled.body).toMatchObject({
      ok: true,
      data: {
        content: {
          title: 'Title-only bump',
          bodyVersion: patched.body.data.content.bodyVersion + 1,
        },
      },
    });
    if (!titled.body.ok) throw new Error('Expected title patch to succeed');

    const empty = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: titled.body.data.content.bodyVersion,
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toMatchObject({
      ok: false,
      error: { code: 'empty_patch' },
    });

    const stale = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      bodyMarkdown: 'stale',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      ok: false,
      error: { code: 'version_conflict' },
    });
  });

  it('keeps the direct block replacement version bump contract', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const contentId = created.body.data.content.id;
    const db = getDbPg();
    const [tab] = await db<Array<{ id: string; list_version: number }>>`
      select id, list_version
      from public.doc_tabs
      where document_id = ${contentId}::uuid
      limit 1
    `;
    if (!tab) throw new Error('Expected primary document tab');

    await withUserContext(USER_ID, async () => {
      await replaceGreenfieldDocumentBlocks({
        workspaceId,
        documentId: contentId,
        tabId: tab.id,
        blocks: [{ kind: 'p', text: 'Direct replacement.' }],
      });
    });

    const [updatedTab] = await db<Array<{ list_version: number }>>`
      select list_version
      from public.doc_tabs
      where id = ${tab.id}::uuid
    `;
    expect(updatedTab).toEqual({ list_version: tab.list_version + 1 });
    const content = await getGreenfieldThreadContentRoute({
      auth: auth(),
      workspaceId,
      threadId: talkId,
    });
    expect(content.body).toMatchObject({
      ok: true,
      data: {
        content: {
          bodyMarkdown: 'Direct replacement.',
          bodyVersion: tab.list_version + 1,
        },
      },
    });
  });

  it('rejects PATCH body format mismatches', async () => {
    const markdownFixture = await createTalkFixture();
    const markdownContent = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId: markdownFixture.workspaceId,
      talkId: markdownFixture.talkId,
      title: 'Markdown Draft',
      format: 'markdown',
    });
    if (!markdownContent.body.ok) {
      throw new Error('Expected markdown content create to succeed');
    }
    const htmlPatch = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId: markdownFixture.workspaceId,
      contentId: markdownContent.body.data.content.id,
      expectedVersion: markdownContent.body.data.content.bodyVersion,
      bodyHtml: '<p>Wrong shape.</p>',
    });
    expect(htmlPatch.statusCode).toBe(400);
    expect(htmlPatch.body).toMatchObject({
      ok: false,
      error: { code: 'format_mismatch' },
    });

    const htmlFixture = await createTalkFixture();
    const htmlContent = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId: htmlFixture.workspaceId,
      talkId: htmlFixture.talkId,
      title: 'HTML Draft',
      format: 'html',
    });
    if (!htmlContent.body.ok) {
      throw new Error('Expected html content create to succeed');
    }
    const markdownPatch = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId: htmlFixture.workspaceId,
      contentId: htmlContent.body.data.content.id,
      expectedVersion: htmlContent.body.data.content.bodyVersion,
      bodyMarkdown: 'Wrong shape.',
    });
    expect(markdownPatch.statusCode).toBe(400);
    expect(markdownPatch.body).toMatchObject({
      ok: false,
      error: { code: 'format_mismatch' },
    });
  });

  it('accepts a pending document edit through the greenfield compatibility route', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Original paragraph.',
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const block = await firstDocumentBlock({
      workspaceId,
      documentId: created.body.data.content.id,
    });
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: block.tab_id,
      runId: seeded.runId,
      op: 'replace',
      blockId: block.id,
      baseBlockVersion: block.version,
      newText: 'Accepted paragraph.',
    });
    const invalidExpected = await acceptGreenfieldContentEditRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      editId,
      expectedContentVersion: String(patched.body.data.content.bodyVersion),
    });
    expect(invalidExpected.statusCode).toBe(400);
    expect(invalidExpected.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_expected_version' },
    });

    const accepted = await acceptGreenfieldContentEditRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      editId,
      expectedContentVersion: patched.body.data.content.bodyVersion,
    });

    expect(accepted.body).toMatchObject({
      ok: true,
      data: {
        editId,
        runId: seeded.runId,
        content: {
          bodyMarkdown: 'Accepted paragraph.',
          bodyVersion: patched.body.data.content.bodyVersion + 1,
        },
      },
    });
    const stalePatch = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      bodyMarkdown: 'Stale overwrite.',
    });
    expect(stalePatch.statusCode).toBe(409);
    expect(stalePatch.body).toMatchObject({
      ok: false,
      error: { code: 'version_conflict' },
    });
    const db = getDbPg();
    const rows = await db<Array<{ status: string; version: number }>>`
      select de.status, db.version
      from public.document_edits de
      join public.doc_blocks db on db.id = ${block.id}::uuid
      where de.id = ${editId}::uuid
    `;
    expect(rows[0]).toMatchObject({ status: 'accepted', version: 2 });
  });

  it('leaves a single pending edit pending when accept hits a stale block version', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Original paragraph.',
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const block = await firstDocumentBlock({
      workspaceId,
      documentId: created.body.data.content.id,
    });
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: block.tab_id,
      op: 'replace',
      blockId: block.id,
      baseBlockVersion: block.version + 1,
      newText: 'Stale replacement.',
    });

    const accepted = await acceptGreenfieldContentEditRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      editId,
      expectedContentVersion: patched.body.data.content.bodyVersion,
    });

    expect(accepted.statusCode).toBe(409);
    expect(accepted.body).toMatchObject({
      ok: false,
      error: { code: 'version_conflict' },
    });
    const db = getDbPg();
    const rows = await db<Array<{ status: string }>>`
      select status
      from public.document_edits
      where id = ${editId}::uuid
    `;
    expect(rows[0]).toEqual({ status: 'pending' });
  });

  it('accepts pending edits through PATCH acceptPendingEditIds before saving the body', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'First paragraph.',
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const block = await firstDocumentBlock({
      workspaceId,
      documentId: created.body.data.content.id,
    });
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: block.tab_id,
      op: 'replace',
      blockId: block.id,
      baseBlockVersion: block.version,
      newText: 'Implicitly accepted paragraph.',
    });

    const invalid = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      acceptPendingEditIds: [editId],
      title: ' ',
    });
    expect(invalid.statusCode).toBe(400);
    const db = getDbPg();
    const stillPending = await db<Array<{ status: string }>>`
      select status from public.document_edits where id = ${editId}::uuid
    `;
    expect(stillPending[0]).toEqual({ status: 'pending' });

    const invalidBodies = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      acceptPendingEditIds: [editId],
      bodyMarkdown: 'Markdown body.',
      bodyHtml: '<p>HTML body.</p>',
    });
    expect(invalidBodies.statusCode).toBe(400);
    expect(invalidBodies.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_patch' },
    });
    const stillPendingAfterInvalidBodies = await db<Array<{ status: string }>>`
      select status from public.document_edits where id = ${editId}::uuid
    `;
    expect(stillPendingAfterInvalidBodies[0]).toEqual({ status: 'pending' });

    const saved = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: patched.body.data.content.bodyVersion,
      acceptPendingEditIds: [editId],
      bodyMarkdown: 'User save wins after implicit accept.',
    });

    expect(saved.body).toMatchObject({
      ok: true,
      data: {
        acceptedPendingEditIds: [editId],
        content: {
          bodyMarkdown: 'User save wins after implicit accept.',
        },
      },
    });
    const pendingRows = await db<Array<{ id: string }>>`
      select id
      from public.document_edits
      where id = ${editId}::uuid
        and status = 'pending'
    `;
    expect(pendingRows).toHaveLength(0);
  });

  it('accepts and rejects pending document edits by run id', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const contentId = created.body.data.content.id;
    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Anchor paragraph.',
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const block = await firstDocumentBlock({
      workspaceId,
      documentId: contentId,
    });
    const tabId = block.tab_id;
    const db = getDbPg();
    const [tab] = await db<Array<{ list_version: number }>>`
      select list_version
      from public.doc_tabs
      where id = ${tabId}::uuid
    `;
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: contentId,
      tabId,
      runId: seeded.runId,
      op: 'insert',
      baseListVersion: tab!.list_version,
      newKind: 'p',
      newText: 'Inserted by run.',
    });
    const invalidRunExpected = await acceptGreenfieldContentEditRunRoute({
      auth: auth(),
      workspaceId,
      contentId,
      runId: seeded.runId,
      expectedContentVersion: String(tab!.list_version),
    });
    expect(invalidRunExpected.statusCode).toBe(400);
    expect(invalidRunExpected.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_expected_version' },
    });
    const [outboxStart] = await db<Array<{ event_id: number }>>`
      select coalesce(max(event_id), 0)::int as event_id
      from public.event_outbox
    `;

    const acceptedRun = await acceptGreenfieldContentEditRunRoute({
      auth: auth(),
      workspaceId,
      contentId,
      runId: seeded.runId,
      expectedContentVersion: tab!.list_version,
    });
    expect(acceptedRun.body).toMatchObject({
      ok: true,
      data: {
        runId: seeded.runId,
        editIds: [editId],
        content: {
          bodyMarkdown: expect.stringContaining('Inserted by run.'),
          bodyVersion: tab!.list_version + 1,
        },
      },
    });
    if (!acceptedRun.body.ok) throw new Error('Expected run accept to succeed');
    const acceptedVersion = acceptedRun.body.data.content.bodyVersion;

    const rejectRunId = '10000000-0000-4000-8000-00000000abcd';
    const [manualRun] = await db<Array<{ id: string }>>`
      insert into public.runs (
        id, workspace_id, talk_id, round, snapshot_group_id, agent_snapshot_id,
        model_id, requested_by, status, response_group_id, sequence_index
      )
      select
        ${rejectRunId}::uuid,
        workspace_id,
        talk_id,
        2,
        snapshot_group_id,
        agent_snapshot_id,
        model_id,
        requested_by,
        'completed',
        'response-reject',
        0
      from public.runs
      where id = ${seeded.runId}::uuid
      returning id
    `;
    const rejectEditId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: contentId,
      tabId,
      runId: manualRun!.id,
      op: 'insert',
      baseListVersion: acceptedVersion,
      newKind: 'p',
      newText: 'Rejected by run.',
    });

    const rejectedRun = await rejectGreenfieldContentEditRunRoute({
      auth: auth(),
      workspaceId,
      contentId,
      runId: manualRun!.id,
    });
    expect(rejectedRun.body).toMatchObject({
      ok: true,
      data: { runId: manualRun!.id, editIds: [rejectEditId] },
    });

    const singleEditId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: contentId,
      tabId,
      op: 'insert',
      baseListVersion: acceptedVersion,
      newKind: 'p',
      newText: 'Rejected singly.',
    });
    const rejectedSingle = await rejectGreenfieldContentEditRoute({
      auth: auth(),
      workspaceId,
      contentId,
      editId: singleEditId,
    });
    expect(rejectedSingle.statusCode).toBe(200);
    expect(rejectedSingle.body).toMatchObject({
      ok: true,
      data: { editId: singleEditId, runId: '' },
    });
    const singleRejectRows = await db<Array<{ status: string }>>`
      select status
      from public.document_edits
      where id = ${singleEditId}::uuid
    `;
    expect(singleRejectRows[0]).toEqual({ status: 'rejected' });
    const events = await db<
      Array<{ event_type: string; payload: Record<string, unknown> }>
    >`
      select event_type, payload
      from public.event_outbox
      where event_id > ${outboxStart!.event_id}
        and topic = ${`talk:${talkId}`}
      order by event_id
    `;
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      event_type: 'content_edit_resolved',
      payload: {
        contentId,
        runId: seeded.runId,
        editIds: [editId],
        resolution: 'accepted',
        version: acceptedVersion,
      },
    });
    expect(events[1]).toMatchObject({
      event_type: 'content_updated',
      payload: {
        contentId,
        version: acceptedVersion,
        format: 'markdown',
        appliedAnchorIds: [],
      },
    });
    expect(events[2]).toMatchObject({
      event_type: 'content_edit_resolved',
      payload: {
        contentId,
        runId: manualRun!.id,
        editIds: [rejectEditId],
        resolution: 'rejected',
        version: acceptedVersion,
      },
    });
    expect(events[3]).toMatchObject({
      event_type: 'content_edit_resolved',
      payload: {
        contentId,
        runId: '',
        editIds: [singleEditId],
        resolution: 'rejected',
        version: acceptedVersion,
      },
    });
  });

  it('preserves multiple accepted inserts from the same run batch', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const patched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Anchor paragraph.',
    });
    if (!patched.body.ok) throw new Error('Expected content patch to succeed');
    const block = await firstDocumentBlock({
      workspaceId,
      documentId: created.body.data.content.id,
    });
    const firstEditId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: block.tab_id,
      runId: seeded.runId,
      op: 'insert',
      afterBlockId: block.id,
      baseListVersion: patched.body.data.content.bodyVersion,
      newKind: 'p',
      newText: 'First insert wins.',
    });
    const secondEditId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: block.tab_id,
      runId: seeded.runId,
      op: 'insert',
      afterBlockId: block.id,
      baseListVersion: patched.body.data.content.bodyVersion,
      newKind: 'p',
      newText: 'Second insert is preserved.',
    });
    const pendingContent = await getGreenfieldThreadContentRoute({
      auth: auth(),
      workspaceId,
      threadId: talkId,
    });
    expect(pendingContent.body).toMatchObject({
      ok: true,
      data: {
        pendingEdits: expect.arrayContaining([
          expect.objectContaining({
            id: firstEditId,
            kind: 'insert',
            targetAnchorId: block.id,
          }),
          expect.objectContaining({
            id: secondEditId,
            kind: 'insert',
            targetAnchorId: block.id,
          }),
        ]),
      },
    });

    const acceptedRun = await acceptGreenfieldContentEditRunRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      runId: seeded.runId,
      expectedContentVersion: patched.body.data.content.bodyVersion,
    });

    expect(acceptedRun.body).toMatchObject({
      ok: true,
      data: {
        runId: seeded.runId,
        editIds: [firstEditId, secondEditId],
        content: {
          bodyMarkdown: expect.stringContaining('First insert wins.'),
        },
      },
    });
    if (!acceptedRun.body.ok) throw new Error('Expected run accept to succeed');
    expect(
      acceptedRun.body.data.content.bodyMarkdown.indexOf('First insert wins.'),
    ).toBeLessThan(
      acceptedRun.body.data.content.bodyMarkdown.indexOf(
        'Second insert is preserved.',
      ),
    );
    const db = getDbPg();
    const rows = await db<Array<{ id: string; status: string }>>`
      select id, status
      from public.document_edits
      where id in (${firstEditId}::uuid, ${secondEditId}::uuid)
      order by id
    `;
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: firstEditId, status: 'accepted' },
        { id: secondEditId, status: 'accepted' },
      ]),
    );
  });

  it('accepts a pending edit against a secondary tab version', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const primaryPatched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Primary body.',
    });
    if (!primaryPatched.body.ok) {
      throw new Error('Expected primary patch to succeed');
    }
    const db = getDbPg();
    const [secondaryTab] = await db<
      Array<{ id: string; list_version: number }>
    >`
      insert into public.doc_tabs (
        workspace_id, document_id, title, sort_order
      )
      values (
        ${workspaceId}::uuid,
        ${created.body.data.content.id}::uuid,
        'Secondary',
        2
      )
      returning id, list_version
    `;
    const [secondaryBlock] = await db<Array<{ id: string; version: number }>>`
      insert into public.doc_blocks (
        workspace_id, document_id, tab_id, sort_order, kind, text
      )
      values (
        ${workspaceId}::uuid,
        ${created.body.data.content.id}::uuid,
        ${secondaryTab!.id}::uuid,
        0,
        'p',
        'Secondary original.'
      )
      returning id, version
    `;
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: secondaryTab!.id,
      op: 'replace',
      blockId: secondaryBlock!.id,
      baseBlockVersion: secondaryBlock!.version,
      newText: 'Secondary accepted.',
    });
    const [outboxStart] = await db<Array<{ event_id: number }>>`
      select coalesce(max(event_id), 0)::int as event_id
      from public.event_outbox
    `;

    const accepted = await acceptGreenfieldContentEditRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      editId,
      expectedContentVersion: primaryPatched.body.data.content.bodyVersion,
    });
    expect(accepted.body).toMatchObject({
      ok: true,
      data: {
        editId,
        content: {
          bodyVersion: primaryPatched.body.data.content.bodyVersion,
        },
      },
    });
    const rows = await db<
      Array<{
        text: string;
        block_version: number;
        tab_version: number;
        edit_status: string;
      }>
    >`
      select
        b.text,
        b.version as block_version,
        t.list_version as tab_version,
        e.status as edit_status
      from public.doc_blocks b
      join public.doc_tabs t on t.id = b.tab_id
      join public.document_edits e on e.id = ${editId}::uuid
      where b.id = ${secondaryBlock!.id}::uuid
    `;
    expect(rows[0]).toEqual({
      text: 'Secondary accepted.',
      block_version: 2,
      tab_version: 2,
      edit_status: 'accepted',
    });
    const events = await db<
      Array<{ event_type: string; payload: Record<string, unknown> }>
    >`
      select event_type, payload
      from public.event_outbox
      where event_id > ${outboxStart!.event_id}
        and topic = ${`talk:${talkId}`}
      order by event_id
    `;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event_type: 'content_edit_resolved',
      payload: {
        contentId: created.body.data.content.id,
        runId: '',
        editIds: [editId],
        resolution: 'accepted',
        version: primaryPatched.body.data.content.bodyVersion,
      },
    });
    expect(events[1]).toMatchObject({
      event_type: 'content_updated',
      payload: {
        contentId: created.body.data.content.id,
        version: primaryPatched.body.data.content.bodyVersion,
        format: 'markdown',
        appliedAnchorIds: [],
      },
    });
  });

  it('accepts a secondary tab pending edit through PATCH implicit accept', async () => {
    const { workspaceId, talkId } = await createTalkFixture();
    const created = await createGreenfieldTalkContentRoute({
      auth: auth(),
      workspaceId,
      talkId,
      title: 'Launch Draft',
      format: 'markdown',
    });
    if (!created.body.ok) throw new Error('Expected content create to succeed');
    const primaryPatched = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: created.body.data.content.bodyVersion,
      bodyMarkdown: 'Primary body.',
    });
    if (!primaryPatched.body.ok) {
      throw new Error('Expected primary patch to succeed');
    }
    const db = getDbPg();
    const [secondaryTab] = await db<
      Array<{ id: string; list_version: number }>
    >`
      insert into public.doc_tabs (
        workspace_id, document_id, title, sort_order
      )
      values (
        ${workspaceId}::uuid,
        ${created.body.data.content.id}::uuid,
        'Secondary',
        2
      )
      returning id, list_version
    `;
    const [secondaryBlock] = await db<Array<{ id: string; version: number }>>`
      insert into public.doc_blocks (
        workspace_id, document_id, tab_id, sort_order, kind, text
      )
      values (
        ${workspaceId}::uuid,
        ${created.body.data.content.id}::uuid,
        ${secondaryTab!.id}::uuid,
        0,
        'p',
        'Secondary original.'
      )
      returning id, version
    `;
    const editId = await insertPendingDocumentEdit({
      workspaceId,
      documentId: created.body.data.content.id,
      tabId: secondaryTab!.id,
      op: 'replace',
      blockId: secondaryBlock!.id,
      baseBlockVersion: secondaryBlock!.version,
      newText: 'Secondary implicitly accepted.',
    });

    const accepted = await patchGreenfieldContentRoute({
      auth: auth(),
      workspaceId,
      contentId: created.body.data.content.id,
      expectedVersion: primaryPatched.body.data.content.bodyVersion,
      acceptPendingEditIds: [editId],
    });
    expect(accepted.body).toMatchObject({
      ok: true,
      data: {
        acceptedPendingEditIds: [editId],
        content: {
          bodyVersion: primaryPatched.body.data.content.bodyVersion,
        },
      },
    });
    const rows = await db<
      Array<{
        text: string;
        block_version: number;
        tab_version: number;
        edit_status: string;
      }>
    >`
      select
        b.text,
        b.version as block_version,
        t.list_version as tab_version,
        e.status as edit_status
      from public.doc_blocks b
      join public.doc_tabs t on t.id = b.tab_id
      join public.document_edits e on e.id = ${editId}::uuid
      where b.id = ${secondaryBlock!.id}::uuid
    `;
    expect(rows[0]).toEqual({
      text: 'Secondary implicitly accepted.',
      block_version: 2,
      tab_version: 2,
      edit_status: 'accepted',
    });
  });

  it('deletes selected messages and rejects non-default thread ids', async () => {
    const { workspaceId, talkId, agentIds } = await createTalkFixture();
    const seeded = await seedMessages({
      workspaceId,
      talkId,
      agentId: agentIds[0]!,
    });

    const wrongThread = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      threadId: '00000000-0000-4000-8000-000000000001',
    });
    expect(wrongThread.statusCode).toBe(404);
    expect(wrongThread.body).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' },
    });

    const deleted = await deleteGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
      messageIds: [seeded.userMessageId],
    });
    expect(deleted.body).toEqual({
      ok: true,
      data: {
        talkId,
        deletedCount: 1,
        deletedMessageIds: [seeded.userMessageId],
      },
    });

    const messages = await listGreenfieldMessagesRoute({
      auth: auth(),
      workspaceId,
      talkId,
    });
    expect(messages.body).toMatchObject({
      ok: true,
      data: { messages: [{ id: seeded.agentMessageId }] },
    });
    const db = getDbPg();
    const runRows = await db<Array<{ trigger_message_id: string | null }>>`
      select trigger_message_id
      from public.runs
      where id = ${seeded.runId}::uuid
    `;
    expect(runRows[0]?.trigger_message_id).toBeNull();
  });
});
