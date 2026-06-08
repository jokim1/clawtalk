// Retired `contents` table compatibility accessors.
//
// Caller contract: every function below must run inside a
// `withUserContext(userId, ...)` block. RLS on both tables gates by
// thread-owner = auth.uid() (joined via talk_threads); the surrounding
// `withRequestScopedDb` scope opens the notify queue so outbox emits
// get flushed post-commit.
//
// Native Documents now own document creation, editing, and review. This module
// only keeps the old executor fallback's read path and HTML anchor-map helper
// until that fallback is retired.

import { getDbPg, type Sql } from '../../db.js';
import {
  type AnchorEntry,
  type AnchorMap,
  extractOutline,
  sha256Hex,
} from '../../shared/rich-text/index.js';

// 10 MB — enough for ~20 medium-sized inline base64 images that arrive
// from a Google Docs paste. Postgres TEXT handles this fine; the LLM
// outline path already truncates to its own 20 KB budget so a large
// body doesn't blow the agent context. v2 follow-up: upload image data
// URLs to R2 on paste so the body stays text-only.
export const CONTENT_BODY_BYTE_LIMIT = 10_000_000;

export type ContentFormat = 'markdown' | 'html';

const CONTENT_RECORD_COLUMNS = `
  id, owner_id, talk_id, thread_id, title, content_kind, content_format,
  body_markdown, body_html, body_version, anchor_map_json,
  created_at, updated_at,
  created_by_user_id, updated_by_user_id, updated_by_run_id
`;

export interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  thread_id: string;
  title: string;
  content_kind: string;
  content_format: ContentFormat;
  body_markdown: string;
  body_html: string | null;
  body_version: number;
  anchor_map_json: AnchorMap;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface Content {
  id: string;
  ownerId: string;
  talkId: string;
  threadId: string;
  title: string;
  contentKind: string;
  contentFormat: ContentFormat;
  bodyMarkdown: string;
  bodyHtml: string | null;
  bodyVersion: number;
  anchorMap: AnchorMap;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

let contentsTableExists: boolean | null = null;

async function hasContentsTable(db: Sql): Promise<boolean> {
  if (contentsTableExists !== null) return contentsTableExists;
  const rows = await db<{ exists: boolean }[]>`
    select to_regclass('public.contents') is not null as exists
  `;
  contentsTableExists = rows[0]?.exists === true;
  return contentsTableExists;
}

function toContent(row: ContentRecord): Content {
  return {
    id: row.id,
    ownerId: row.owner_id,
    talkId: row.talk_id,
    threadId: row.thread_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyHtml: row.body_html,
    bodyVersion: row.body_version,
    anchorMap: row.anchor_map_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

const HTML_ANCHOR_PREVIEW_MAX = 60;

/**
 * Build the `anchor_map_json` payload for an HTML body. Walks the
 * top-level blocks via the shared outline extractor and produces the
 * same `AnchorEntry` shape the markdown path uses — kind=tag,
 * sort_order=index, preview=first 60 chars of plain text,
 * content_hash=SHA-256(plain text).
 *
 * Caller contract: `html` must already have anchors stamped (use
 * `insertAnchors` before calling this). Returns `null` when the HTML
 * fails to parse — caller surfaces as a save-time error.
 */
export async function computeHtmlAnchorMap(
  html: string,
): Promise<AnchorMap | null> {
  const outline = extractOutline(html);
  if (!outline.ok) return null;
  const map: AnchorMap = {};
  for (let i = 0; i < outline.value.length; i++) {
    const entry = outline.value[i];
    const preview = entry.textExcerpt.slice(0, HTML_ANCHOR_PREVIEW_MAX);
    const contentHash = await sha256Hex(entry.textExcerpt);
    const anchorEntry: AnchorEntry = {
      kind: entry.tag,
      sort_order: i,
      preview,
      content_hash: contentHash,
    };
    map[entry.anchorId] = anchorEntry;
  }
  return map;
}

// ── content read shim ────────────────────────────────────────────────

/**
 * Legacy entrypoint for the retired `contents` table. The old executor fallback
 * still calls this before failing closed when the table is absent.
 */
export async function getContentByTalkId(
  talkId: string,
): Promise<Content | null> {
  const db = getDbPg();
  if (!(await hasContentsTable(db))) return null;
  const rows = await db<ContentRecord[]>`
    select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
    from public.contents
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}
