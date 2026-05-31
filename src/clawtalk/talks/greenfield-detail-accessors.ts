import { getDbPg } from '../../db.js';

export interface GreenfieldMessageRecord {
  id: string;
  workspace_id: string;
  talk_id: string;
  round: number;
  author_kind: 'user' | 'agent';
  author_user_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_role_key: string | null;
  run_id: string | null;
  body: string | null;
  attachments_json: unknown;
  created_at: string;
}

export interface GreenfieldThreadMetrics {
  talk_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
}

export interface GreenfieldRunRecord {
  id: string;
  talk_id: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  response_group_id: string | null;
  sequence_index: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  trigger_message_id: string | null;
  target_agent_id: string | null;
  target_agent_name: string | null;
  model_id: string;
  error_json: unknown;
}

export interface GreenfieldDocumentBlockRecord {
  id: string;
  sort_order: number;
  version: number;
  kind: 'h1' | 'h2' | 'p' | 'li' | 'meta' | 'code';
  text: string;
  attrs_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface GreenfieldDocumentRecord {
  id: string;
  workspace_id: string;
  primary_talk_id: string | null;
  owner_id: string | null;
  title: string;
  format: 'markdown' | 'html';
  created_at: string;
  updated_at: string;
  tab_id: string;
  tab_title: string;
  list_version: number;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
  blocks: GreenfieldDocumentBlockRecord[];
}

export interface GreenfieldDocumentEditRecord {
  id: string;
  document_id: string;
  tab_id: string;
  proposed_by_agent_id: string | null;
  proposed_by_agent_name: string | null;
  proposed_by_run_id: string | null;
  op: 'insert' | 'replace' | 'delete';
  new_text: string | null;
  block_id: string | null;
  created_at: string;
  base_block_version: number | null;
  base_list_version: number | null;
}

export async function listGreenfieldMessages(input: {
  workspaceId: string;
  talkId: string;
  beforeCreatedAt?: string;
  limit?: number;
}): Promise<GreenfieldMessageRecord[]> {
  const db = getDbPg();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  return db<GreenfieldMessageRecord[]>`
    select *
    from (
      select
        m.id,
        m.workspace_id,
        m.talk_id,
        m.round,
        m.author_kind,
        m.author_user_id,
        tas.source_agent_id as agent_id,
        tas.name as agent_name,
        tas.role_key as agent_role_key,
        m.run_id,
        m.body,
        m.attachments_json,
        m.created_at
      from public.messages m
      left join public.talk_agent_snapshots tas
        on tas.workspace_id = m.workspace_id
       and tas.talk_id = m.talk_id
       and tas.id = m.agent_snapshot_id
      where m.workspace_id = ${input.workspaceId}::uuid
        and m.talk_id = ${input.talkId}::uuid
        and (
          ${input.beforeCreatedAt ?? null}::timestamptz is null
          or m.created_at < ${input.beforeCreatedAt ?? null}::timestamptz
        )
      order by m.created_at desc, m.id desc
      limit ${limit}
    ) page
    order by created_at asc, id asc
  `;
}

export async function searchGreenfieldMessages(input: {
  workspaceId: string;
  talkId: string;
  query: string;
  limit?: number;
}): Promise<GreenfieldMessageRecord[]> {
  const db = getDbPg();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return db<GreenfieldMessageRecord[]>`
    select
      m.id,
      m.workspace_id,
      m.talk_id,
      m.round,
      m.author_kind,
      m.author_user_id,
      tas.source_agent_id as agent_id,
      tas.name as agent_name,
      tas.role_key as agent_role_key,
      m.run_id,
      m.body,
      m.attachments_json,
      m.created_at
    from public.messages m
    left join public.talk_agent_snapshots tas
      on tas.workspace_id = m.workspace_id
     and tas.talk_id = m.talk_id
     and tas.id = m.agent_snapshot_id
    where m.workspace_id = ${input.workspaceId}::uuid
      and m.talk_id = ${input.talkId}::uuid
      and coalesce(m.body, '') ilike ${`%${input.query}%`}
    order by m.created_at desc, m.id desc
    limit ${limit}
  `;
}

export async function deleteGreenfieldMessages(input: {
  workspaceId: string;
  talkId: string;
  messageIds: string[];
}): Promise<string[]> {
  if (input.messageIds.length === 0) return [];
  const db = getDbPg();
  await db`
    update public.runs
    set trigger_message_id = null
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and trigger_message_id in ${db(input.messageIds)}
  `;
  const rows = await db<{ id: string }[]>`
    delete from public.messages
    where workspace_id = ${input.workspaceId}::uuid
      and talk_id = ${input.talkId}::uuid
      and id in ${db(input.messageIds)}
    returning id
  `;
  return rows.map((row) => row.id);
}

export async function getGreenfieldThreadMetrics(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldThreadMetrics | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldThreadMetrics[]>`
    select
      t.id as talk_id,
      null::text as title,
      t.created_at,
      t.updated_at,
      count(m.id)::int as message_count,
      max(m.created_at) as last_message_at
    from public.talks t
    left join public.messages m
      on m.workspace_id = t.workspace_id
     and m.talk_id = t.id
    where t.workspace_id = ${input.workspaceId}::uuid
      and t.id = ${input.talkId}::uuid
    group by t.id
    limit 1
  `;
  return rows[0];
}

export async function listGreenfieldRuns(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldRunRecord[]> {
  const db = getDbPg();
  return db<GreenfieldRunRecord[]>`
    select
      r.id,
      r.talk_id,
      r.status,
      r.response_group_id,
      r.sequence_index,
      r.created_at,
      r.started_at,
      r.finished_at,
      r.trigger_message_id,
      tas.source_agent_id as target_agent_id,
      tas.name as target_agent_name,
      r.model_id,
      r.error_json
    from public.runs r
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.talk_id = ${input.talkId}::uuid
    order by r.created_at desc, r.sequence_index asc, r.id asc
  `;
}

export async function getGreenfieldDocumentForTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldDocumentRecord | undefined> {
  const db = getDbPg();
  const rows = await db<Omit<GreenfieldDocumentRecord, 'blocks'>[]>`
    select
      d.id,
      d.workspace_id,
      d.primary_talk_id,
      t.created_by as owner_id,
      d.title,
      d.format,
      d.created_at,
      d.updated_at,
      dt.id as tab_id,
      dt.title as tab_title,
      dt.list_version,
      null::uuid as created_by_user_id,
      null::uuid as updated_by_user_id,
      null::uuid as updated_by_run_id
    from public.documents d
    left join public.talks t
      on t.workspace_id = d.workspace_id
     and t.id = d.primary_talk_id
    join public.doc_tabs dt
      on dt.workspace_id = d.workspace_id
     and dt.document_id = d.id
    where d.workspace_id = ${input.workspaceId}::uuid
      and d.primary_talk_id = ${input.talkId}::uuid
    order by dt.sort_order asc, dt.id asc
    limit 1
  `;
  const document = rows[0];
  if (!document) return undefined;
  const blocks = await db<GreenfieldDocumentBlockRecord[]>`
    select id, sort_order, version, kind, text, attrs_json, created_at, updated_at
    from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${document.id}::uuid
      and tab_id = ${document.tab_id}::uuid
    order by sort_order asc, id asc
  `;
  return { ...document, blocks };
}

export async function getGreenfieldDocumentById(input: {
  workspaceId: string;
  documentId: string;
}): Promise<GreenfieldDocumentRecord | undefined> {
  const db = getDbPg();
  const rows = await db<Omit<GreenfieldDocumentRecord, 'blocks'>[]>`
    select
      d.id,
      d.workspace_id,
      d.primary_talk_id,
      t.created_by as owner_id,
      d.title,
      d.format,
      d.created_at,
      d.updated_at,
      dt.id as tab_id,
      dt.title as tab_title,
      dt.list_version,
      null::uuid as created_by_user_id,
      null::uuid as updated_by_user_id,
      null::uuid as updated_by_run_id
    from public.documents d
    left join public.talks t
      on t.workspace_id = d.workspace_id
     and t.id = d.primary_talk_id
    join public.doc_tabs dt
      on dt.workspace_id = d.workspace_id
     and dt.document_id = d.id
    where d.workspace_id = ${input.workspaceId}::uuid
      and d.id = ${input.documentId}::uuid
    order by dt.sort_order asc, dt.id asc
    limit 1
  `;
  const document = rows[0];
  if (!document) return undefined;
  const blocks = await db<GreenfieldDocumentBlockRecord[]>`
    select id, sort_order, version, kind, text, attrs_json, created_at, updated_at
    from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${document.id}::uuid
      and tab_id = ${document.tab_id}::uuid
    order by sort_order asc, id asc
  `;
  return { ...document, blocks };
}

export async function createGreenfieldDocumentForTalk(input: {
  workspaceId: string;
  talkId: string;
  title: string;
  format: 'markdown' | 'html';
}): Promise<GreenfieldDocumentRecord> {
  const existing = await getGreenfieldDocumentForTalk(input);
  if (existing) return existing;

  const db = getDbPg();
  const [document] = await db<{ id: string }[]>`
    insert into public.documents (workspace_id, primary_talk_id, title, format)
    values (
      ${input.workspaceId}::uuid,
      ${input.talkId}::uuid,
      ${input.title},
      ${input.format}
    )
    returning id
  `;
  await db`
    insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
    values (${input.workspaceId}::uuid, ${document!.id}::uuid, 'Main', 0)
  `;
  const created = await getGreenfieldDocumentForTalk(input);
  if (!created) {
    throw new Error(`Created document for talk ${input.talkId} could not load`);
  }
  return created;
}

export async function replaceGreenfieldDocumentBlocks(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  blocks: Array<{ kind: GreenfieldDocumentBlockRecord['kind']; text: string }>;
}): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
      and tab_id = ${input.tabId}::uuid
  `;
  for (const [index, block] of input.blocks.entries()) {
    await db`
      insert into public.doc_blocks (
        workspace_id, document_id, tab_id, sort_order, kind, text
      )
      values (
        ${input.workspaceId}::uuid,
        ${input.documentId}::uuid,
        ${input.tabId}::uuid,
        ${index},
        ${block.kind},
        ${block.text}
      )
    `;
  }
  await db`
    update public.doc_tabs
    set list_version = list_version + 1
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
      and id = ${input.tabId}::uuid
  `;
  await db`
    update public.documents
    set last_edit_at = now()
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.documentId}::uuid
  `;
}

export async function updateGreenfieldDocumentTitle(input: {
  workspaceId: string;
  documentId: string;
  title: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    update public.documents
    set title = ${input.title}
    where workspace_id = ${input.workspaceId}::uuid
      and id = ${input.documentId}::uuid
  `;
}

export async function listPendingGreenfieldDocumentEdits(input: {
  workspaceId: string;
  documentId: string;
}): Promise<GreenfieldDocumentEditRecord[]> {
  const db = getDbPg();
  return db<GreenfieldDocumentEditRecord[]>`
    select
      de.id,
      de.document_id,
      de.tab_id,
      de.proposed_by_agent_id,
      a.name as proposed_by_agent_name,
      de.proposed_by_run_id,
      de.op,
      de.new_text,
      de.block_id,
      de.created_at,
      de.base_block_version,
      de.base_list_version
    from public.document_edits de
    left join public.agents a
      on a.workspace_id = de.workspace_id
     and a.id = de.proposed_by_agent_id
    where de.workspace_id = ${input.workspaceId}::uuid
      and de.document_id = ${input.documentId}::uuid
      and de.status = 'pending'
    order by de.created_at asc, de.id asc
  `;
}
