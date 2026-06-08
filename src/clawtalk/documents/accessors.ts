import { getDbPg, withTrustedDbWrites } from '../../db.js';
import {
  acceptGreenfieldDocumentEdit,
  acceptGreenfieldDocumentEdits,
  rejectGreenfieldDocumentEdit,
  type GreenfieldDocumentEditResolveResult,
} from '../talks/greenfield-detail-accessors.js';
import { withDocumentEditMutationLock } from './edit-locks.js';

export type NativeDocumentFormat = 'markdown' | 'html';
export type NativeDocumentBlockKind =
  | 'h1'
  | 'h2'
  | 'p'
  | 'li'
  | 'meta'
  | 'code';
export type NativeDocumentEditOp = 'insert' | 'replace' | 'delete';
export type NativeDocumentEditStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'superseded';
export type NativeDocumentEditSource = 'agent' | 'forge' | 'job';

export interface NativeDocumentSummaryRecord {
  id: string;
  workspace_id: string;
  primary_talk_id: string | null;
  folder_id: string | null;
  title: string;
  format: NativeDocumentFormat;
  word_count: number;
  last_edit_at: string | null;
  created_at: string;
  updated_at: string;
  tab_count: number;
  block_count: number;
  pending_edit_count: number;
}

export interface NativeDocumentBlockRecord {
  id: string;
  workspace_id: string;
  document_id: string;
  tab_id: string;
  sort_order: number;
  version: number;
  kind: NativeDocumentBlockKind;
  text: string;
  attrs_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NativeDocumentTabRecord {
  id: string;
  workspace_id: string;
  document_id: string;
  title: string;
  sort_order: number;
  list_version: number;
  created_at: string;
  updated_at: string;
  blocks: NativeDocumentBlockRecord[];
}

export interface NativeDocumentEditRecord {
  id: string;
  workspace_id: string;
  document_id: string;
  tab_id: string;
  block_id: string | null;
  base_block_version: number | null;
  base_list_version: number | null;
  after_block_id: string | null;
  proposed_by_agent_id: string | null;
  proposed_by_agent_name: string | null;
  proposed_by_run_id: string | null;
  op: NativeDocumentEditOp;
  new_kind: NativeDocumentBlockKind | null;
  new_text: string | null;
  new_attrs_json: Record<string, unknown> | null;
  status: NativeDocumentEditStatus;
  source: NativeDocumentEditSource;
  created_at: string;
  resolved_at: string | null;
}

export interface NativeDocumentRecord extends NativeDocumentSummaryRecord {
  tabs: NativeDocumentTabRecord[];
  pending_edits: NativeDocumentEditRecord[];
}

export type NativeDocumentResolveResult =
  | {
      kind: 'ok';
      document: NativeDocumentRecord;
      editIds: string[];
      runId: string | null;
    }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'invalid_edit'; message: string }
  | { kind: 'edit_set_mismatch'; pendingEditIds: string[] };

/**
 * True when two edit-id lists describe the same set (order-, duplicate-, and
 * case-insensitive). Bulk accept/reject gate the reviewer's rendered set against
 * the server's current pending set with this, so a pending edit created after
 * page load (e.g. a job emitting a fresh proposal) can never be resolved unseen
 * — the sets differ and the action aborts with `edit_set_mismatch`. Ids are
 * lower-cased before comparison: the route validators accept upper-case UUIDs
 * but Postgres returns its `uuid` columns lower-cased, so a raw compare would
 * spuriously mismatch a reviewer who sent canonical-but-upper-case ids.
 */
function sameEditIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map((id) => id.toLowerCase()));
  const right = new Set(b.map((id) => id.toLowerCase()));
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function toNativeResolveResult(
  result: GreenfieldDocumentEditResolveResult,
  document: NativeDocumentRecord | undefined,
): NativeDocumentResolveResult {
  if (result.kind !== 'ok') return result;
  if (!document) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document,
    editIds: result.editIds,
    runId: result.runId,
  };
}

export async function listNativeDocuments(input: {
  workspaceId: string;
  includeUnlinked?: boolean;
  limit?: number;
}): Promise<NativeDocumentSummaryRecord[]> {
  const db = getDbPg();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const includeUnlinked = input.includeUnlinked === true;
  return db<NativeDocumentSummaryRecord[]>`
    with tab_counts as (
      select workspace_id, document_id, count(*)::int as tab_count
      from public.doc_tabs
      where workspace_id = ${input.workspaceId}::uuid
      group by workspace_id, document_id
    ),
    block_counts as (
      select workspace_id, document_id, count(*)::int as block_count
      from public.doc_blocks
      where workspace_id = ${input.workspaceId}::uuid
      group by workspace_id, document_id
    ),
    pending_counts as (
      select workspace_id, document_id, count(*)::int as pending_edit_count
      from public.document_edits
      where workspace_id = ${input.workspaceId}::uuid
        and status = 'pending'
      group by workspace_id, document_id
    )
    select
      d.id,
      d.workspace_id,
      d.primary_talk_id,
      d.folder_id,
      d.title,
      d.format,
      d.word_count,
      d.last_edit_at,
      d.created_at,
      d.updated_at,
      coalesce(tc.tab_count, 0)::int as tab_count,
      coalesce(bc.block_count, 0)::int as block_count,
      coalesce(pc.pending_edit_count, 0)::int as pending_edit_count
    from public.documents d
    left join tab_counts tc
      on tc.workspace_id = d.workspace_id
     and tc.document_id = d.id
    left join block_counts bc
      on bc.workspace_id = d.workspace_id
     and bc.document_id = d.id
    left join pending_counts pc
      on pc.workspace_id = d.workspace_id
     and pc.document_id = d.id
    where d.workspace_id = ${input.workspaceId}::uuid
      and (${includeUnlinked}::boolean or d.primary_talk_id is not null)
    order by coalesce(d.last_edit_at, d.updated_at, d.created_at) desc, d.id desc
    limit ${limit}
  `;
}

async function getNativeDocumentSummary(input: {
  workspaceId: string;
  documentId: string;
}): Promise<NativeDocumentSummaryRecord | undefined> {
  const db = getDbPg();
  const rows = await db<NativeDocumentSummaryRecord[]>`
    with tab_counts as (
      select workspace_id, document_id, count(*)::int as tab_count
      from public.doc_tabs
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
      group by workspace_id, document_id
    ),
    block_counts as (
      select workspace_id, document_id, count(*)::int as block_count
      from public.doc_blocks
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
      group by workspace_id, document_id
    ),
    pending_counts as (
      select workspace_id, document_id, count(*)::int as pending_edit_count
      from public.document_edits
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and status = 'pending'
      group by workspace_id, document_id
    )
    select
      d.id,
      d.workspace_id,
      d.primary_talk_id,
      d.folder_id,
      d.title,
      d.format,
      d.word_count,
      d.last_edit_at,
      d.created_at,
      d.updated_at,
      coalesce(tc.tab_count, 0)::int as tab_count,
      coalesce(bc.block_count, 0)::int as block_count,
      coalesce(pc.pending_edit_count, 0)::int as pending_edit_count
    from public.documents d
    left join tab_counts tc
      on tc.workspace_id = d.workspace_id
     and tc.document_id = d.id
    left join block_counts bc
      on bc.workspace_id = d.workspace_id
     and bc.document_id = d.id
    left join pending_counts pc
      on pc.workspace_id = d.workspace_id
     and pc.document_id = d.id
    where d.workspace_id = ${input.workspaceId}::uuid
      and d.id = ${input.documentId}::uuid
    limit 1
  `;
  return rows[0];
}

export async function getNativeDocument(input: {
  workspaceId: string;
  documentId: string;
}): Promise<NativeDocumentRecord | undefined> {
  const document = await getNativeDocumentSummary(input);
  if (!document) return undefined;

  const db = getDbPg();
  const tabs = await db<Array<Omit<NativeDocumentTabRecord, 'blocks'>>>`
    select
      id,
      workspace_id,
      document_id,
      title,
      sort_order,
      list_version,
      created_at,
      updated_at
    from public.doc_tabs
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
    order by sort_order asc, id asc
  `;
  const blocks = await db<NativeDocumentBlockRecord[]>`
    select
      id,
      workspace_id,
      document_id,
      tab_id,
      sort_order,
      version,
      kind,
      text,
      attrs_json,
      created_at,
      updated_at
    from public.doc_blocks
    where workspace_id = ${input.workspaceId}::uuid
      and document_id = ${input.documentId}::uuid
    order by tab_id asc, sort_order asc, id asc
  `;
  const blocksByTab = new Map<string, NativeDocumentBlockRecord[]>();
  for (const block of blocks) {
    const tabBlocks = blocksByTab.get(block.tab_id) ?? [];
    tabBlocks.push(block);
    blocksByTab.set(block.tab_id, tabBlocks);
  }
  const pendingEdits = await listNativeDocumentEdits({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    status: 'pending',
  });
  return {
    ...document,
    tabs: tabs.map((tab) => ({
      ...tab,
      blocks: blocksByTab.get(tab.id) ?? [],
    })),
    pending_edits: pendingEdits,
  };
}

export async function listNativeDocumentEdits(input: {
  workspaceId: string;
  documentId: string;
  status?: NativeDocumentEditStatus | 'all';
}): Promise<NativeDocumentEditRecord[]> {
  const db = getDbPg();
  const status = input.status ?? 'pending';
  return db<NativeDocumentEditRecord[]>`
    select
      de.id,
      de.workspace_id,
      de.document_id,
      de.tab_id,
      de.block_id,
      de.base_block_version,
      de.base_list_version,
      de.after_block_id,
      de.proposed_by_agent_id,
      a.name as proposed_by_agent_name,
      de.proposed_by_run_id,
      de.op,
      de.new_kind,
      de.new_text,
      de.new_attrs_json,
      de.status,
      de.source,
      de.created_at,
      de.resolved_at
    from public.document_edits de
    left join public.agents a
      on a.workspace_id = de.workspace_id
     and a.id = de.proposed_by_agent_id
    where de.workspace_id = ${input.workspaceId}::uuid
      and de.document_id = ${input.documentId}::uuid
      and (${status === 'all'}::boolean or de.status = ${status})
    order by de.created_at asc, de.id asc
  `;
}

/**
 * Pending edit ids for one run within a document, in canonical pending order
 * (created_at asc, id asc). The run-level bulk accept/reject compute the
 * server's current set for the run with this so it can be gated against the
 * reviewer's rendered set before any edit is resolved.
 */
async function listNativeRunPendingEditIds(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
}): Promise<string[]> {
  const edits = await listNativeDocumentEdits({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    status: 'pending',
  });
  // Compare lower-cased: the route accepts upper-case run-id UUIDs but Postgres
  // returns proposed_by_run_id lower-cased.
  const runId = input.runId.toLowerCase();
  return edits
    .filter((edit) => edit.proposed_by_run_id?.toLowerCase() === runId)
    .map((edit) => edit.id);
}

export async function acceptNativeDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  editId: string;
  expectedContentVersion?: number;
}): Promise<NativeDocumentResolveResult> {
  const result = await acceptGreenfieldDocumentEdit({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    editId: input.editId,
    expectedTargetTabListVersion: input.expectedContentVersion,
  });
  const document =
    result.kind === 'ok'
      ? await getNativeDocument({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
        })
      : undefined;
  return toNativeResolveResult(result, document);
}

export async function acceptNativeDocumentEditRun(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
  reviewedEditIds: string[];
  expectedContentVersion?: number;
}): Promise<NativeDocumentResolveResult> {
  return withDocumentEditMutationLock(input, async () => {
    const runPendingEditIds = await listNativeRunPendingEditIds(input);
    if (!sameEditIdSet(runPendingEditIds, input.reviewedEditIds)) {
      return { kind: 'edit_set_mismatch', pendingEditIds: runPendingEditIds };
    }
    if (runPendingEditIds.length === 0) return { kind: 'not_found' };
    // Accept exactly the run's gated edits by id rather than re-enumerating the
    // run, so an edit appended to the run after page load cannot slip in.
    const result = await acceptGreenfieldDocumentEdits({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      editIds: runPendingEditIds,
      expectedTargetTabListVersion: input.expectedContentVersion,
    });
    const document =
      result.kind === 'ok'
        ? await getNativeDocument({
            workspaceId: input.workspaceId,
            documentId: input.documentId,
          })
        : undefined;
    const native = toNativeResolveResult(result, document);
    return native.kind === 'ok' ? { ...native, runId: input.runId } : native;
  });
}

export async function acceptAllNativeDocumentEdits(input: {
  workspaceId: string;
  documentId: string;
  reviewedEditIds: string[];
  expectedContentVersion?: number;
}): Promise<NativeDocumentResolveResult> {
  return withDocumentEditMutationLock(input, async () => {
    const edits = await listNativeDocumentEdits({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      status: 'pending',
    });
    const pendingEditIds = edits.map((edit) => edit.id);
    if (!sameEditIdSet(pendingEditIds, input.reviewedEditIds)) {
      return { kind: 'edit_set_mismatch', pendingEditIds };
    }
    if (pendingEditIds.length === 0) {
      const document = await getNativeDocument(input);
      if (!document) return { kind: 'not_found' };
      return { kind: 'ok', document, editIds: [], runId: null };
    }
    // Apply exactly the gated set, in the server's canonical pending order
    // (created_at asc, id asc) so insert ordering matches the prior behavior.
    const result = await acceptGreenfieldDocumentEdits({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      editIds: pendingEditIds,
      expectedTargetTabListVersion: input.expectedContentVersion,
    });
    const document =
      result.kind === 'ok'
        ? await getNativeDocument({
            workspaceId: input.workspaceId,
            documentId: input.documentId,
          })
        : undefined;
    return toNativeResolveResult(result, document);
  });
}

export async function rejectNativeDocumentEdit(input: {
  workspaceId: string;
  documentId: string;
  editId: string;
}): Promise<
  | {
      kind: 'ok';
      document: NativeDocumentRecord;
      editId: string;
      runId: string | null;
    }
  | { kind: 'not_found' }
> {
  const result = await rejectGreenfieldDocumentEdit(input);
  if (result.kind === 'not_found') return result;
  const document = await getNativeDocument(input);
  if (!document) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document,
    editId: result.editId,
    runId: result.runId,
  };
}

export async function rejectNativeDocumentEditRun(input: {
  workspaceId: string;
  documentId: string;
  runId: string;
  reviewedEditIds: string[];
}): Promise<
  | {
      kind: 'ok';
      document: NativeDocumentRecord;
      runId: string;
      editIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'edit_set_mismatch'; pendingEditIds: string[] }
> {
  const runPendingEditIds = await listNativeRunPendingEditIds(input);
  if (!sameEditIdSet(runPendingEditIds, input.reviewedEditIds)) {
    return { kind: 'edit_set_mismatch', pendingEditIds: runPendingEditIds };
  }
  if (runPendingEditIds.length === 0) return { kind: 'not_found' };
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<Array<{ id: string }>>`
      update public.document_edits
      set status = 'rejected',
          resolved_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and id in ${db(runPendingEditIds)}
        and status = 'pending'
      returning id
    `,
  );
  const document = await getNativeDocument(input);
  if (!document) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document,
    runId: input.runId,
    editIds: rows.map((row) => row.id),
  };
}

export async function rejectAllNativeDocumentEdits(input: {
  workspaceId: string;
  documentId: string;
  reviewedEditIds: string[];
}): Promise<
  | {
      kind: 'ok';
      document: NativeDocumentRecord;
      editIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'edit_set_mismatch'; pendingEditIds: string[] }
> {
  const existing = await getNativeDocument(input);
  if (!existing) return { kind: 'not_found' };
  const pendingEditIds = existing.pending_edits.map((edit) => edit.id);
  if (!sameEditIdSet(pendingEditIds, input.reviewedEditIds)) {
    return { kind: 'edit_set_mismatch', pendingEditIds };
  }
  if (pendingEditIds.length === 0) {
    return { kind: 'ok', document: existing, editIds: [] };
  }
  const db = getDbPg();
  const rows = await withTrustedDbWrites(
    () => db<Array<{ id: string }>>`
      update public.document_edits
      set status = 'rejected',
          resolved_at = now()
      where workspace_id = ${input.workspaceId}::uuid
        and document_id = ${input.documentId}::uuid
        and id in ${db(pendingEditIds)}
        and status = 'pending'
      returning id
    `,
  );
  const document = await getNativeDocument(input);
  if (!document) return { kind: 'not_found' };
  return {
    kind: 'ok',
    document,
    editIds: rows.map((row) => row.id),
  };
}
