import {
  getDbPg,
  getOutOfBandSql,
  withTrustedDbWrites,
  type Sql,
} from '../../db.js';

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
  provider_id: string;
  model_id: string;
  error_json: unknown;
}

export interface GreenfieldRunContextSnapshotRecord {
  id: string;
  talk_id: string;
  round: number;
  trigger_message_id: string | null;
  role_key: string | null;
  tool_manifest_json: unknown | null;
  context_manifest_json: unknown | null;
  prompt_text_redacted: string | null;
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
  new_kind: string | null;
  new_text: string | null;
  new_attrs_json: Record<string, unknown> | null;
  block_id: string | null;
  after_block_id: string | null;
  created_at: string;
  base_block_version: number | null;
  base_list_version: number | null;
}

export type GreenfieldDocumentEditResolveResult =
  | {
      kind: 'ok';
      document: GreenfieldDocumentRecord;
      editIds: string[];
      runId: string | null;
    }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'invalid_edit'; message: string };

type GreenfieldDocumentBlockKind = GreenfieldDocumentBlockRecord['kind'];
type GreenfieldDocumentEditRef = { id: string; tab_id: string };

const BLOCK_KINDS = new Set<GreenfieldDocumentBlockKind>([
  'h1',
  'h2',
  'p',
  'li',
  'meta',
  'code',
]);

async function withExistingOrNewTransaction<T>(
  db: Sql,
  fn: (txSql: Sql) => Promise<T>,
): Promise<T> {
  const maybeTransaction = db as Sql & { savepoint?: unknown };
  if (
    typeof maybeTransaction.savepoint === 'function' ||
    typeof maybeTransaction.begin !== 'function'
  ) {
    return fn(db);
  }
  return (await maybeTransaction.begin(async (tx) =>
    fn(tx as unknown as Sql),
  )) as T;
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
  return withTrustedDbWrites(async () => {
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
  });
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

/**
 * Per-talk outbox high-water mark — `coalesce(max(event_id), 0)` over the
 * talk's `talk:<id>` topic. This is the snapshot's `snapshotVersion`: the
 * webapp's `applyMessageAppendedDelta` drops any streamed `message_appended`
 * whose outbox `eventId` is <= this cursor (already folded into the
 * snapshot's `messages`) and appends the rest. It therefore MUST live on the
 * same monotonic scale as the streamed `eventId` (`event_outbox.event_id`),
 * NOT a wall-clock timestamp — a timestamp-scaled version is astronomically
 * larger than any outbox id, so every streamed delta would be dropped and
 * the just-persisted reply would vanish from the live thread until a reload.
 *
 * Read on the BYPASSRLS out-of-band connection: migration 0001 revokes
 * SELECT on `public.event_outbox` from `authenticated`, so the RLS-scoped
 * request connection (`getDbPg`) can't read it. Mirrors the retired legacy
 * `public.get_talk_snapshot_version` SECURITY DEFINER helper.
 *
 * Callers MUST read this BEFORE loading the snapshot's messages so the
 * cursor stays a lower bound consistent with (a subset-time of) the returned
 * messages — every event counted here committed atomically with its message,
 * so a later message load is a superset. Reading it after the load could
 * raise the cursor past a message a concurrent commit added mid-load, which
 * the client would then drop.
 */
export async function getTalkSnapshotVersion(input: {
  talkId: string;
}): Promise<number> {
  const db = getOutOfBandSql();
  const rows = await db<{ event_id: number }[]>`
    select coalesce(max(event_id), 0)::int as event_id
    from public.event_outbox
    where topic = ${`talk:${input.talkId}`}
  `;
  return rows[0]?.event_id ?? 0;
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
      tas.provider_id,
      tas.model_id,
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

export async function getGreenfieldRunContextSnapshotRecord(input: {
  workspaceId: string;
  talkId: string;
  runId: string;
}): Promise<GreenfieldRunContextSnapshotRecord | undefined> {
  const db = getDbPg();
  const rows = await db<GreenfieldRunContextSnapshotRecord[]>`
    select
      r.id,
      r.talk_id,
      r.round,
      r.trigger_message_id,
      tas.role_key,
      rps.tool_manifest_json,
      rps.context_manifest_json,
      rps.prompt_text_redacted
    from public.runs r
    join public.talk_agent_snapshots tas
      on tas.workspace_id = r.workspace_id
     and tas.talk_id = r.talk_id
     and tas.id = r.agent_snapshot_id
    left join public.run_prompt_snapshots rps
      on rps.workspace_id = r.workspace_id
     and rps.id = r.prompt_snapshot_id
    where r.workspace_id = ${input.workspaceId}::uuid
      and r.talk_id = ${input.talkId}::uuid
      and r.id = ${input.runId}::uuid
    limit 1
  `;
  return rows[0];
}

async function selectGreenfieldDocumentForTalk(
  db: Sql,
  input: {
    workspaceId: string;
    talkId: string;
  },
): Promise<GreenfieldDocumentRecord | undefined> {
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

export async function getGreenfieldDocumentForTalk(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldDocumentRecord | undefined> {
  const db = getDbPg();
  return selectGreenfieldDocumentForTalk(db, input);
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
  const db = getDbPg();
  const created = await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (tx) => {
      const existing = await selectGreenfieldDocumentForTalk(tx, input);
      if (existing) return existing;

      const inserted = await tx<{ id: string }[]>`
      insert into public.documents (workspace_id, primary_talk_id, title, format)
      values (
        ${input.workspaceId}::uuid,
        ${input.talkId}::uuid,
        ${input.title},
        ${input.format}
      )
      on conflict (primary_talk_id) where primary_talk_id is not null do nothing
      returning id
    `;
      const documentId =
        inserted[0]?.id ??
        (
          await tx<{ id: string }[]>`
          select id
          from public.documents
          where workspace_id = ${input.workspaceId}::uuid
            and primary_talk_id = ${input.talkId}::uuid
          limit 1
        `
        )[0]?.id;
      if (!documentId) {
        throw new Error(
          `Document for talk ${input.talkId} could not be created`,
        );
      }

      await tx`
      select id
      from public.documents
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${documentId}::uuid
      for update
    `;
      await tx`
      insert into public.doc_tabs (workspace_id, document_id, title, sort_order)
      select ${input.workspaceId}::uuid, ${documentId}::uuid, 'Main', 0
      where not exists (
        select 1
        from public.doc_tabs
        where workspace_id = ${input.workspaceId}::uuid
          and document_id = ${documentId}::uuid
      )
    `;
      const document = await selectGreenfieldDocumentForTalk(tx, input);
      if (!document) {
        throw new Error(
          `Created document for talk ${input.talkId} could not load`,
        );
      }
      return document;
    }),
  );
  return created;
}

export async function replaceGreenfieldDocumentBlocks(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  blocks: Array<{ kind: GreenfieldDocumentBlockRecord['kind']; text: string }>;
  skipListVersionBump?: boolean;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(() =>
    withExistingOrNewTransaction(db, async (tx) => {
      await tx`
      delete from public.doc_blocks
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and tab_id = ${input.tabId}::uuid
    `;
      if (input.blocks.length > 0) {
        const rows = input.blocks.map((block, index) => ({
          workspace_id: input.workspaceId,
          document_id: input.documentId,
          tab_id: input.tabId,
          sort_order: index,
          kind: block.kind,
          text: block.text,
        }));
        await tx`
        insert into public.doc_blocks
        ${tx(rows, 'workspace_id', 'document_id', 'tab_id', 'sort_order', 'kind', 'text')}
      `;
      }
      await tx`
      update public.documents
      set last_edit_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.documentId}::uuid
    `;
      if (input.skipListVersionBump !== true) {
        await tx`
        update public.doc_tabs
        set list_version = list_version + 1
        where workspace_id = ${input.workspaceId}::uuid
          and document_id = ${input.documentId}::uuid
          and id = ${input.tabId}::uuid
      `;
      }
    }),
  );
}

export async function bumpGreenfieldDocumentPatchVersion(input: {
  workspaceId: string;
  documentId: string;
  tabId: string;
  expectedListVersion: number;
}): Promise<
  | { kind: 'ok'; listVersion: number }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'not_found' }
> {
  const db = getDbPg();
  const bumpedRows = await withTrustedDbWrites(
    () => db<{ list_version: number }[]>`
      update public.doc_tabs
      set list_version = list_version + 1
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and id = ${input.tabId}::uuid
        and list_version = ${input.expectedListVersion}
      returning list_version
    `,
  );
  const bumped = bumpedRows[0];
  if (bumped) return { kind: 'ok', listVersion: bumped.list_version };

  const currentRows = await db<{ list_version: number }[]>`
    select list_version
    from public.doc_tabs
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
      and id = ${input.tabId}::uuid
    limit 1
  `;
  const current = currentRows[0];
  if (!current) return { kind: 'not_found' };
  return {
    kind: 'version_conflict',
    currentVersion: current.list_version,
  };
}

export async function updateGreenfieldDocumentTitle(input: {
  workspaceId: string;
  documentId: string;
  title: string;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(async () => {
    await db`
      update public.documents
      set title = ${input.title}
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.documentId}::uuid
    `;
  });
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
      de.new_kind,
      de.new_text,
      de.new_attrs_json,
      de.block_id,
      de.after_block_id,
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

function normalizeBlockKind(
  kind: string | null,
): GreenfieldDocumentBlockKind | null {
  if (!kind) return null;
  return BLOCK_KINDS.has(kind as GreenfieldDocumentBlockKind)
    ? (kind as GreenfieldDocumentBlockKind)
    : null;
}

async function loadPendingGreenfieldDocumentEditForUpdate(input: {
  workspaceId: string;
  documentId: string;
  editId: string;
}): Promise<GreenfieldDocumentEditRecord | undefined> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<GreenfieldDocumentEditRecord[]>`
      select
        de.id,
        de.document_id,
        de.tab_id,
        de.proposed_by_agent_id,
        a.name as proposed_by_agent_name,
        de.proposed_by_run_id,
        de.op,
        de.new_kind,
        de.new_text,
        de.new_attrs_json,
        de.block_id,
        de.after_block_id,
        de.created_at,
        de.base_block_version,
        de.base_list_version
      from public.document_edits de
      left join public.agents a
        on a.workspace_id = de.workspace_id
       and a.id = de.proposed_by_agent_id
      where de.workspace_id = ${input.workspaceId}::uuid
        and de.document_id = ${input.documentId}::uuid
        and de.id = ${input.editId}::uuid
        and de.status = 'pending'
      for update of de
    `,
  );
  return rows[0];
}

async function listPendingGreenfieldDocumentEditRefs(input: {
  workspaceId: string;
  documentId: string;
  editIds: string[];
}): Promise<GreenfieldDocumentEditRef[]> {
  if (input.editIds.length === 0) return [];
  const db = getDbPg();
  return db<GreenfieldDocumentEditRef[]>`
    select id, tab_id
    from public.document_edits
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
      and id in ${db(input.editIds)}
      and status = 'pending'
  `;
}

async function listPendingGreenfieldDocumentEditsByRun(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
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
      de.new_kind,
      de.new_text,
      de.new_attrs_json,
      de.block_id,
      de.after_block_id,
      de.created_at,
      de.base_block_version,
      de.base_list_version
    from public.document_edits de
    left join public.agents a
      on a.workspace_id = de.workspace_id
     and a.id = de.proposed_by_agent_id
    where de.workspace_id = ${input.workspaceId}::uuid
      and de.document_id = ${input.documentId}::uuid
      and de.proposed_by_run_id = ${input.runId}::uuid
      and de.status = 'pending'
    order by de.created_at asc, de.id asc
  `;
}

async function markDocumentEditSuperseded(input: {
  workspaceId: string;
  editId: string;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(async () => {
    await db`
      update public.document_edits
      set status = 'superseded',
          resolved_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.editId}::uuid
        and status = 'pending'
    `;
  });
}

async function touchDocumentAfterEdit(input: {
  workspaceId: string;
  documentId: string;
}): Promise<void> {
  const db = getDbPg();
  await withTrustedDbWrites(async () => {
    await db`
      update public.documents
      set last_edit_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and id = ${input.documentId}::uuid
    `;
  });
}

async function validateGreenfieldDocumentEdit(
  edit: GreenfieldDocumentEditRecord,
  workspaceId: string,
): Promise<
  | { kind: 'ok' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'invalid_edit'; message: string }
> {
  const db = getDbPg();

  if (edit.op === 'insert') {
    const newKind = normalizeBlockKind(edit.new_kind);
    if (!newKind || edit.new_text === null || edit.base_list_version === null) {
      return {
        kind: 'invalid_edit',
        message: 'Pending insert edit is missing its required payload.',
      };
    }
    const tabRows = await db<{ list_version: number }[]>`
      select list_version
      from public.doc_tabs
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and id = ${edit.tab_id}::uuid
      for update
    `;
    const tab = tabRows[0];
    if (!tab) {
      return { kind: 'anchor_missing', anchorId: edit.tab_id };
    }
    if (tab.list_version !== edit.base_list_version) {
      return { kind: 'version_conflict', currentVersion: tab.list_version };
    }
    if (edit.after_block_id !== null) {
      const anchorRows = await db<{ id: string }[]>`
        select id
        from public.doc_blocks
        where workspace_id = ${workspaceId}::uuid
          and document_id = ${edit.document_id}::uuid
          and tab_id = ${edit.tab_id}::uuid
          and id = ${edit.after_block_id}::uuid
        for update
      `;
      if (!anchorRows[0]) {
        return { kind: 'anchor_missing', anchorId: edit.after_block_id };
      }
    }
    return { kind: 'ok' };
  }

  if (edit.block_id === null || edit.base_block_version === null) {
    return {
      kind: 'invalid_edit',
      message: `Pending ${edit.op} edit is missing its target block.`,
    };
  }
  if (edit.op === 'replace' && edit.new_text === null) {
    return {
      kind: 'invalid_edit',
      message: 'Pending replace edit is missing replacement text.',
    };
  }
  const newKind = normalizeBlockKind(edit.new_kind);
  if (edit.op === 'replace' && edit.new_kind !== null && !newKind) {
    return {
      kind: 'invalid_edit',
      message: 'Pending replace edit has an invalid block kind.',
    };
  }
  const blockRows = await db<{ version: number }[]>`
    select version
    from public.doc_blocks
    where workspace_id = ${workspaceId}::uuid
      and document_id = ${edit.document_id}::uuid
      and tab_id = ${edit.tab_id}::uuid
      and id = ${edit.block_id}::uuid
    for update
  `;
  const block = blockRows[0];
  if (!block) {
    return { kind: 'anchor_missing', anchorId: edit.block_id };
  }
  if (block.version !== edit.base_block_version) {
    return { kind: 'version_conflict', currentVersion: block.version };
  }
  return { kind: 'ok' };
}

async function applyGreenfieldDocumentEdit(
  edit: GreenfieldDocumentEditRecord,
  workspaceId: string,
  options: {
    allowSupersededStatus?: boolean;
    ignoreInsertListVersionConflict?: boolean;
    insertOrderOffset?: number;
    supersedeOnConflict?: boolean;
  } = {},
): Promise<
  | { kind: 'ok' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'invalid_edit'; message: string }
> {
  const db = getDbPg();

  if (edit.op === 'insert') {
    const newKind = normalizeBlockKind(edit.new_kind);
    if (!newKind || edit.new_text === null || edit.base_list_version === null) {
      return {
        kind: 'invalid_edit',
        message: 'Pending insert edit is missing its required payload.',
      };
    }
    const tabRows = await db<{ list_version: number }[]>`
      select list_version
      from public.doc_tabs
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and id = ${edit.tab_id}::uuid
      for update
    `;
    const tab = tabRows[0];
    if (!tab) {
      return { kind: 'anchor_missing', anchorId: edit.tab_id };
    }
    if (
      tab.list_version !== edit.base_list_version &&
      options.ignoreInsertListVersionConflict !== true
    ) {
      if (options.supersedeOnConflict === true) {
        await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
      }
      return { kind: 'version_conflict', currentVersion: tab.list_version };
    }

    let insertOrder = options.insertOrderOffset ?? 0;
    if (edit.after_block_id !== null) {
      const anchorRows = await db<{ sort_order: number }[]>`
        select sort_order
        from public.doc_blocks
        where workspace_id = ${workspaceId}::uuid
          and document_id = ${edit.document_id}::uuid
          and tab_id = ${edit.tab_id}::uuid
          and id = ${edit.after_block_id}::uuid
        for update
      `;
      const anchor = anchorRows[0];
      if (!anchor) {
        if (options.supersedeOnConflict === true) {
          await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
        }
        return { kind: 'anchor_missing', anchorId: edit.after_block_id };
      }
      insertOrder = anchor.sort_order + 1 + (options.insertOrderOffset ?? 0);
    }

    await db`
      update public.doc_blocks
      set sort_order = -sort_order - 1000000
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and sort_order >= ${insertOrder}
    `;
    await db`
      insert into public.doc_blocks (
        workspace_id, document_id, tab_id, sort_order, kind, text, attrs_json
      )
      values (
        ${workspaceId}::uuid,
        ${edit.document_id}::uuid,
        ${edit.tab_id}::uuid,
        ${insertOrder},
        ${newKind},
        ${edit.new_text},
        ${db.json((edit.new_attrs_json ?? {}) as never)}
      )
    `;
    // Insert accepts rely on document_edits_bump_versions_on_accept for the
    // tab list_version bump; replace/delete bump list_version in this layer.
    await db`
      update public.doc_blocks
      set sort_order = -sort_order - 999999
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and sort_order <= ${-insertOrder - 1000000}
    `;
  } else if (edit.op === 'replace') {
    if (edit.block_id === null || edit.base_block_version === null) {
      return {
        kind: 'invalid_edit',
        message: 'Pending replace edit is missing its target block.',
      };
    }
    if (edit.new_text === null) {
      return {
        kind: 'invalid_edit',
        message: 'Pending replace edit is missing replacement text.',
      };
    }
    const blockRows = await db<{ version: number }[]>`
      select version
      from public.doc_blocks
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and id = ${edit.block_id}::uuid
      for update
    `;
    const block = blockRows[0];
    if (!block) {
      if (options.supersedeOnConflict === true) {
        await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
      }
      return { kind: 'anchor_missing', anchorId: edit.block_id };
    }
    if (block.version !== edit.base_block_version) {
      if (options.supersedeOnConflict === true) {
        await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
      }
      return { kind: 'version_conflict', currentVersion: block.version };
    }
    const newKind = normalizeBlockKind(edit.new_kind);
    if (edit.new_kind !== null && !newKind) {
      return {
        kind: 'invalid_edit',
        message: 'Pending replace edit has an invalid block kind.',
      };
    }
    await db`
      update public.doc_blocks
      set text = ${edit.new_text},
          kind = coalesce(${newKind}, kind),
          attrs_json = coalesce(
            ${edit.new_attrs_json === null ? null : db.json(edit.new_attrs_json as never)},
            attrs_json
          )
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and id = ${edit.block_id}::uuid
    `;
  } else {
    if (edit.block_id === null || edit.base_block_version === null) {
      return {
        kind: 'invalid_edit',
        message: 'Pending delete edit is missing its target block.',
      };
    }
    const blockRows = await db<{ version: number }[]>`
      select version
      from public.doc_blocks
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and id = ${edit.block_id}::uuid
      for update
    `;
    const block = blockRows[0];
    if (!block) {
      if (options.supersedeOnConflict === true) {
        await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
      }
      return { kind: 'anchor_missing', anchorId: edit.block_id };
    }
    if (block.version !== edit.base_block_version) {
      if (options.supersedeOnConflict === true) {
        await markDocumentEditSuperseded({ workspaceId, editId: edit.id });
      }
      return { kind: 'version_conflict', currentVersion: block.version };
    }
  }

  const acceptedRows = await withTrustedDbWrites(() =>
    options.allowSupersededStatus === true
      ? db<{ id: string }[]>`
          update public.document_edits
          set status = 'accepted'
          where workspace_id = ${workspaceId}::uuid
            and id = ${edit.id}::uuid
            and status in ('pending', 'superseded')
          returning id
        `
      : db<{ id: string }[]>`
          update public.document_edits
          set status = 'accepted'
          where workspace_id = ${workspaceId}::uuid
            and id = ${edit.id}::uuid
            and status = 'pending'
          returning id
        `,
  );
  if (acceptedRows.length === 0) {
    return { kind: 'anchor_missing', anchorId: edit.id };
  }

  if (edit.op === 'delete' && edit.block_id !== null) {
    await db`
      delete from public.doc_blocks
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and tab_id = ${edit.tab_id}::uuid
        and id = ${edit.block_id}::uuid
    `;
    await db`
      update public.doc_tabs
      set list_version = list_version + 1
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and id = ${edit.tab_id}::uuid
    `;
  } else if (edit.op === 'replace') {
    await db`
      update public.doc_tabs
      set list_version = list_version + 1
      where workspace_id = ${workspaceId}::uuid
        and document_id = ${edit.document_id}::uuid
        and id = ${edit.tab_id}::uuid
    `;
  }

  await touchDocumentAfterEdit({
    workspaceId,
    documentId: edit.document_id,
  });
  return { kind: 'ok' };
}

async function checkGreenfieldDocumentTabVersionsForUpdate(input: {
  workspaceId: string;
  documentId: string;
  tabIds: string[];
  expectedContentVersion?: number;
}): Promise<
  | { kind: 'ok' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'not_found' }
> {
  const tabIds = Array.from(new Set(input.tabIds)).sort();
  if (tabIds.length === 0) return { kind: 'not_found' };
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string; list_version: number }[]>`
      select id, list_version
      from public.doc_tabs
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and id in ${db(tabIds)}
      order by id asc
      for update
    `,
  );
  if (rows.length !== tabIds.length) return { kind: 'not_found' };
  if (input.expectedContentVersion !== undefined) {
    const conflict = rows.find(
      (row) => row.list_version !== input.expectedContentVersion,
    );
    if (conflict) {
      return {
        kind: 'version_conflict',
        currentVersion: conflict.list_version,
      };
    }
  }
  return { kind: 'ok' };
}

export async function acceptGreenfieldDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  editId: string;
  expectedContentVersion?: number;
}): Promise<GreenfieldDocumentEditResolveResult> {
  const document = await getGreenfieldDocumentById(input);
  if (!document) return { kind: 'not_found' };
  if (
    input.expectedContentVersion !== undefined &&
    document.list_version !== input.expectedContentVersion
  ) {
    return {
      kind: 'version_conflict',
      currentVersion: document.list_version,
    };
  }
  const refs = await listPendingGreenfieldDocumentEditRefs({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    editIds: [input.editId],
  });
  const ref = refs[0];
  if (!ref) return { kind: 'not_found' };
  const versionCheck = await checkGreenfieldDocumentTabVersionsForUpdate({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    tabIds: [ref.tab_id],
  });
  if (versionCheck.kind !== 'ok') return versionCheck;
  const edit = await loadPendingGreenfieldDocumentEditForUpdate(input);
  if (!edit) return { kind: 'not_found' };

  const applied = await withTrustedDbWrites(() =>
    applyGreenfieldDocumentEdit(edit, input.workspaceId),
  );
  if (applied.kind !== 'ok') return applied;
  const updated = await getGreenfieldDocumentById(input);
  if (!updated) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document: updated,
    editIds: [edit.id],
    runId: edit.proposed_by_run_id,
  };
}

export async function acceptGreenfieldDocumentEdits(input: {
  workspaceId: string;
  documentId: string;
  editIds: string[];
  expectedContentVersion?: number;
}): Promise<GreenfieldDocumentEditResolveResult> {
  const document = await getGreenfieldDocumentById(input);
  if (!document) return { kind: 'not_found' };
  if (
    input.expectedContentVersion !== undefined &&
    document.list_version !== input.expectedContentVersion
  ) {
    return {
      kind: 'version_conflict',
      currentVersion: document.list_version,
    };
  }
  const refs = await listPendingGreenfieldDocumentEditRefs({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    editIds: input.editIds,
  });
  const refsById = new Map(refs.map((ref) => [ref.id, ref]));
  for (const editId of input.editIds) {
    if (!refsById.has(editId)) return { kind: 'not_found' };
  }
  const versionCheck = await checkGreenfieldDocumentTabVersionsForUpdate({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    tabIds: refs.map((ref) => ref.tab_id),
  });
  if (versionCheck.kind !== 'ok') return versionCheck;

  const acceptedEditIds: string[] = [];
  let runId: string | null = null;
  const edits: GreenfieldDocumentEditRecord[] = [];
  for (const editId of input.editIds) {
    const edit = await loadPendingGreenfieldDocumentEditForUpdate({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      editId,
    });
    if (!edit) return { kind: 'not_found' };
    const validation = await withTrustedDbWrites(() =>
      validateGreenfieldDocumentEdit(edit, input.workspaceId),
    );
    if (validation.kind !== 'ok') return validation;
    edits.push(edit);
  }

  const insertOffsets = new Map<string, number>();
  for (const edit of edits) {
    if (edit.op === 'insert') {
      const offsetKey = `${edit.tab_id}:${edit.after_block_id ?? ''}`;
      const insertOrderOffset = insertOffsets.get(offsetKey) ?? 0;
      insertOffsets.set(offsetKey, insertOrderOffset + 1);
      const applied = await withTrustedDbWrites(() =>
        applyGreenfieldDocumentEdit(edit, input.workspaceId, {
          allowSupersededStatus: true,
          ignoreInsertListVersionConflict: true,
          insertOrderOffset,
          supersedeOnConflict: acceptedEditIds.length > 0,
        }),
      );
      if (applied.kind !== 'ok') {
        if (acceptedEditIds.length > 0) continue;
        return applied;
      }
      acceptedEditIds.push(edit.id);
      runId ??= edit.proposed_by_run_id;
      continue;
    }
    const pending = await loadPendingGreenfieldDocumentEditForUpdate({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      editId: edit.id,
    });
    if (!pending) continue;
    const applied = await withTrustedDbWrites(() =>
      applyGreenfieldDocumentEdit(pending, input.workspaceId, {
        supersedeOnConflict: acceptedEditIds.length > 0,
      }),
    );
    if (applied.kind !== 'ok') {
      if (acceptedEditIds.length > 0) continue;
      return applied;
    }
    acceptedEditIds.push(pending.id);
    runId ??= pending.proposed_by_run_id;
  }

  const updated = await getGreenfieldDocumentById(input);
  if (!updated) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document: updated,
    editIds: acceptedEditIds,
    runId,
  };
}

export async function acceptGreenfieldDocumentEditRun(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
  expectedContentVersion?: number;
}): Promise<GreenfieldDocumentEditResolveResult> {
  const edits = await listPendingGreenfieldDocumentEditsByRun(input);
  if (edits.length === 0) return { kind: 'not_found' };
  const result = await acceptGreenfieldDocumentEdits({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    editIds: edits.map((edit) => edit.id),
    expectedContentVersion: input.expectedContentVersion,
  });
  if (result.kind !== 'ok') return result;
  return { ...result, runId: input.runId };
}

export async function rejectGreenfieldDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  editId: string;
}): Promise<
  { kind: 'ok'; editId: string; runId: string | null } | { kind: 'not_found' }
> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<Array<{ id: string; proposed_by_run_id: string | null }>>`
      update public.document_edits
      set status = 'rejected',
          resolved_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and id = ${input.editId}::uuid
        and status = 'pending'
      returning id, proposed_by_run_id
    `,
  );
  const row = rows[0];
  if (!row) return { kind: 'not_found' };
  return { kind: 'ok', editId: row.id, runId: row.proposed_by_run_id };
}

export async function rejectGreenfieldDocumentEditRun(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
}): Promise<
  { kind: 'ok'; runId: string; editIds: string[] } | { kind: 'not_found' }
> {
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<{ id: string }[]>`
      update public.document_edits
      set status = 'rejected',
          resolved_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and proposed_by_run_id = ${input.runId}::uuid
        and status = 'pending'
      returning id
    `,
  );
  if (rows.length === 0) return { kind: 'not_found' };
  return {
    kind: 'ok',
    runId: input.runId,
    editIds: rows.map((row) => row.id),
  };
}
