// Typed accessors for the `content_edits` table (edit-log architecture
// per Section B of ~/.claude/plans/silly-gathering-charm.md).
//
// content_edits was the staging table for pending agent edits. Native
// `document_edits` now owns accept/reject semantics. This module only keeps the
// old executor fallback's read/write helpers until that fallback is retired.
//
// Caller contract: every function must run inside a
// `withUserContext(userId, ...)` block. RLS gates by the content's
// owner_id (see migration 0028).
//
// The final greenfield baseline retires `content_edits` in favor of
// `document_edits`. Reads degrade for mounted compatibility surfaces; writers
// fail closed so an accidental legacy edit path is caught immediately.

import { getDbPg, type Sql } from '../../db.js';
import {
  type ContentEditRow,
  type ContentEditKind,
} from '../../shared/rich-text/index.js';

// ── Row shape (DB → TS) ───────────────────────────────────────────────

export interface ContentEditRecord {
  id: string;
  content_id: string;
  run_id: string;
  agent_id: string | null;
  agent_nickname: string | null;
  message_id: string | null;
  kind: ContentEditKind;
  base_content_version: number;
  target_anchor_id: string | null;
  new_markdown: string | null;
  new_html: string | null;
  rationale: string | null;
  created_at: string;
}

const EDIT_COLUMNS = `
  id, content_id, run_id, agent_id, agent_nickname,
  message_id, kind, base_content_version,
  target_anchor_id, new_markdown, new_html, rationale, created_at
`;

function toContentEdit(row: ContentEditRecord): ContentEditRow {
  return {
    id: row.id,
    contentId: row.content_id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentNickname: row.agent_nickname,
    messageId: row.message_id,
    kind: row.kind,
    baseContentVersion: row.base_content_version,
    targetAnchorId: row.target_anchor_id,
    newMarkdown: row.new_markdown,
    newHtml: row.new_html ?? null,
    rationale: row.rationale,
    createdAt: row.created_at,
  };
}

let contentEditsTableExists: boolean | null = null;

async function hasContentEditsTable(db: Sql): Promise<boolean> {
  if (contentEditsTableExists !== null) return contentEditsTableExists;
  const rows = await db<{ exists: boolean }[]>`
    select to_regclass('public.content_edits') is not null as exists
  `;
  contentEditsTableExists = rows[0]?.exists === true;
  return contentEditsTableExists;
}

async function assertContentEditsTable(db: Sql): Promise<void> {
  if (!(await hasContentEditsTable(db))) {
    throw new Error('legacy_content_edits_not_available');
  }
}

// ── Read ──────────────────────────────────────────────────────────────

export async function getPendingEditsByContent(
  contentId: string,
): Promise<ContentEditRow[]> {
  const db = getDbPg();
  if (!(await hasContentEditsTable(db))) return [];
  const rows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where content_id = ${contentId}::uuid
    order by created_at asc, id asc
  `;
  return rows.map(toContentEdit);
}

// ── Insert (apply) ────────────────────────────────────────────────────

export interface InsertPendingEditInput {
  contentId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId: string | null;
  kind: ContentEditKind;
  baseContentVersion: number;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  // Optional; populated by the apply handler for HTML-format docs.
  // Exactly one of newMarkdown / newHtml is non-null per row except
  // kind='delete' (both null) — the DB CHECK enforces it.
  newHtml?: string | null;
  rationale: string | null;
}

export async function insertPendingEdit(
  input: InsertPendingEditInput,
): Promise<ContentEditRow> {
  const db = getDbPg();
  await assertContentEditsTable(db);
  const rows = await db<ContentEditRecord[]>`
    insert into public.content_edits
      (content_id, run_id, agent_id, agent_nickname, message_id,
       kind, base_content_version, target_anchor_id,
       new_markdown, new_html, rationale)
    values
      (${input.contentId}::uuid, ${input.runId},
       ${input.agentId}::uuid, ${input.agentNickname},
       ${input.messageId}::uuid, ${input.kind},
       ${input.baseContentVersion}, ${input.targetAnchorId},
       ${input.newMarkdown}, ${input.newHtml ?? null}, ${input.rationale})
    returning ${db.unsafe(EDIT_COLUMNS)}
  `;
  return toContentEdit(rows[0]);
}

export async function updatePendingEdit(input: {
  editId: string;
  kind: ContentEditKind;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  newHtml?: string | null;
  rationale: string | null;
}): Promise<ContentEditRow | null> {
  const db = getDbPg();
  await assertContentEditsTable(db);
  const rows = await db<ContentEditRecord[]>`
    update public.content_edits
    set kind = ${input.kind},
        target_anchor_id = ${input.targetAnchorId},
        new_markdown = ${input.newMarkdown},
        new_html = ${input.newHtml ?? null},
        rationale = ${input.rationale}
    where id = ${input.editId}::uuid
    returning ${db.unsafe(EDIT_COLUMNS)}
  `;
  return rows[0] ? toContentEdit(rows[0]) : null;
}

export async function deletePendingEdit(editId: string): Promise<boolean> {
  const db = getDbPg();
  await assertContentEditsTable(db);
  const rows = await db<{ id: string }[]>`
    delete from public.content_edits
    where id = ${editId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function deletePendingEditsByRun(input: {
  contentId: string;
  runId: string;
}): Promise<string[]> {
  const db = getDbPg();
  await assertContentEditsTable(db);
  const rows = await db<{ id: string }[]>`
    delete from public.content_edits
    where content_id = ${input.contentId}::uuid
      and run_id = ${input.runId}
    returning id
  `;
  return rows.map((r) => r.id);
}
