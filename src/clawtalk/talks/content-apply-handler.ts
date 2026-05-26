// Tool handler for the new `apply_content_edit` direct-edit surface.
//
// Replaces the propose/accept abstraction (content-tool-handlers.ts).
// The agent calls `apply_content_edit({kind, anchor?, markdown, rationale?})`;
// the handler stages the edit as a row in `content_edits`. body_markdown
// is NOT mutated until the user clicks Accept (or auto-accept fires
// when a new run lands).
//
// Per-doc invariant: only one pending run can exist at a time. When a
// new run lands (different runId from any existing pending row), the
// prior run is auto-accepted — its edits are materialized into
// body_markdown in one CAS bump and the rows are deleted. Mirrors the
// "you can only have one open suggestion thread" mental model from
// Google Docs Suggested Edits.
//
// Same-run repeat calls collapse per the table in plan Section C:
// agent edits the same anchor twice in one turn → single row updated
// in place. bulk + anything-else in one run is rejected as
// `bulk_already_in_run` to keep the storage shape simple.

import {
  CONTENT_BODY_BYTE_LIMIT,
  computeHtmlAnchorMap,
  getContentByTalkId,
} from '../db/content-accessors.js';
import {
  deletePendingEdit,
  deletePendingEditsByRun,
  getPendingEditsByContent,
  insertPendingEdit,
  updatePendingEdit,
  type ContentEditRecord,
} from '../db/content-edits-accessors.js';
import { getDbPg } from '../../db.js';
import {
  ALLOWED_TAGS,
  type ContentEditKind,
  type ContentEditRow,
  computeAnchorMap,
  ensureAnchorIds,
  insertAnchors,
  markdownToTiptapJson,
  materializeEdits,
  materializeEditsHtml,
  sanitizeHtmlServer,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  stripAnchorCommentsFromMarkdown,
  tiptapJsonToMarkdown,
} from '../../shared/rich-text/index.js';
import { emitOutboxEvent } from './outbox-emit.js';

export interface ApplyContentEditToolInput {
  talkId: string;
  userId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId?: string | null;
  args: Record<string, unknown>;
}

export type ToolResult = {
  result: string;
  isError?: boolean;
};

const EDIT_COLUMNS_SELECT = `
  id, content_id, run_id, agent_id, agent_nickname,
  message_id, kind, base_content_version,
  target_anchor_id, new_markdown, new_html, rationale, created_at
`;

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function toEditRow(record: ContentEditRecord): ContentEditRow {
  return {
    id: record.id,
    contentId: record.content_id,
    runId: record.run_id,
    agentId: record.agent_id,
    agentNickname: record.agent_nickname,
    messageId: record.message_id,
    kind: record.kind,
    baseContentVersion: record.base_content_version,
    targetAnchorId: record.target_anchor_id,
    newMarkdown: record.new_markdown,
    newHtml: record.new_html ?? null,
    rationale: record.rationale,
    createdAt: record.created_at,
  };
}

export async function executeApplyContentEdit(
  input: ApplyContentEditToolInput,
): Promise<ToolResult> {
  const rawKind = input.args.kind;
  const rawAnchor = input.args.anchor;
  const rawMarkdown = input.args.markdown;
  const rawRationale = input.args.rationale;

  if (
    rawKind !== 'append' &&
    rawKind !== 'replace' &&
    rawKind !== 'bulk' &&
    rawKind !== 'delete'
  ) {
    return {
      result:
        "Error: `kind` must be one of 'append', 'replace', 'bulk', or 'delete'.",
      isError: true,
    };
  }

  // Map agent-facing 'append' to internal 'insert'. The agent surface
  // uses 'append' to match the natural-language description in the tool
  // schema; the storage layer uses 'insert' (it can also prepend at top
  // when anchor is null).
  const internalKind: ContentEditKind =
    rawKind === 'append' ? 'insert' : (rawKind as ContentEditKind);

  if (internalKind !== 'delete') {
    if (typeof rawMarkdown !== 'string' || rawMarkdown.trim().length === 0) {
      return {
        result:
          'Error: apply_content_edit requires a non-empty `markdown` string for this kind.',
        isError: true,
      };
    }
  }

  if (
    rawAnchor !== null &&
    rawAnchor !== undefined &&
    typeof rawAnchor !== 'string'
  ) {
    return {
      result:
        'Error: `anchor` must be a string anchor ID (from the DOC outline) or omitted.',
      isError: true,
    };
  }

  if (
    rawRationale !== null &&
    rawRationale !== undefined &&
    typeof rawRationale !== 'string'
  ) {
    return {
      result: 'Error: `rationale` must be a string when provided.',
      isError: true,
    };
  }

  const content = await getContentByTalkId(input.talkId);
  if (!content) {
    return {
      result:
        'Error: this Talk has no attached document. Cannot apply an edit.',
      isError: true,
    };
  }

  const targetAnchorId =
    typeof rawAnchor === 'string' && rawAnchor.length > 0 ? rawAnchor : null;

  // Validate kind/anchor pairing.
  if (internalKind === 'replace' || internalKind === 'delete') {
    if (targetAnchorId === null) {
      return {
        result: `Error: '${rawKind}' requires an \`anchor\` (the block to act on).`,
        isError: true,
      };
    }
  }
  if (internalKind === 'bulk' && targetAnchorId !== null) {
    return {
      result:
        "Error: 'bulk' replaces the entire body — omit `anchor` and put the whole new doc in `markdown`.",
      isError: true,
    };
  }

  // Sanitize the agent's payload. Format-aware:
  //   - markdown docs route through stripAnchorCommentsFromMarkdown
  //     + sanitizeMarkdown + Tiptap parse + non-empty check.
  //   - HTML docs route through validateHtmlPayload (server sanitizer
  //     plus two guards: format-mismatch on plain-text input and
  //     empty-after-sanitize when every tag is stripped).
  let sanitizedMarkdown: string | null = null;
  let sanitizedHtml: string | null = null;
  if (internalKind !== 'delete') {
    if (content.contentFormat === 'html') {
      const validation = validateHtmlPayload(
        typeof rawMarkdown === 'string' ? rawMarkdown : '',
      );
      if (!validation.ok) {
        return { result: validation.error, isError: true };
      }
      sanitizedHtml = validation.sanitized;
      if (byteLengthOf(sanitizedHtml) > CONTENT_BODY_BYTE_LIMIT) {
        return {
          result: `Error: the supplied HTML exceeds the document size limit (${byteLengthOf(sanitizedHtml)} bytes).`,
          isError: true,
        };
      }
    } else {
      const stripped = stripAnchorCommentsFromMarkdown(
        typeof rawMarkdown === 'string' ? rawMarkdown : '',
      );
      sanitizedMarkdown = sanitizeMarkdown(stripped);
      const parsed = sanitizeRichTextDocument(
        markdownToTiptapJson(sanitizedMarkdown),
      );
      if (parsed.content.length === 0) {
        return {
          result:
            'Error: the supplied markdown is empty after sanitization. Provide real content.',
          isError: true,
        };
      }
      if (byteLengthOf(sanitizedMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
        return {
          result: `Error: the supplied markdown exceeds the document size limit (${byteLengthOf(sanitizedMarkdown)} bytes).`,
          isError: true,
        };
      }
    }
  }

  // Validate anchor exists in current body (for replace/delete).
  if (
    (internalKind === 'replace' || internalKind === 'delete') &&
    targetAnchorId !== null
  ) {
    const anchorMap = content.anchorMap ?? {};
    if (!anchorMap[targetAnchorId]) {
      return {
        result: `Error: anchor "${targetAnchorId}" is not in the current document. Re-read the DOC outline and use a current anchor.`,
        isError: true,
      };
    }
  }
  if (
    internalKind === 'insert' &&
    targetAnchorId !== null &&
    !(content.anchorMap ?? {})[targetAnchorId]
  ) {
    return {
      result: `Error: anchor "${targetAnchorId}" is not in the current document. Re-read the DOC outline and use a current anchor, or omit \`anchor\` to prepend at the top.`,
      isError: true,
    };
  }

  const db = getDbPg();

  // Load existing pending edits for this content and partition by run.
  const existing = await getPendingEditsByContent(content.id);
  const priorRunIds = Array.from(
    new Set(existing.map((e) => e.runId).filter((id) => id !== input.runId)),
  );

  // Auto-accept any prior run BEFORE inserting our new edit so the
  // "one pending run per doc" invariant holds. The materialized body
  // shape depends on the parent content's format — markdown round-trips
  // through Tiptap, HTML through linkedom + the shared sanitizer + the
  // idempotent anchor stamp.
  let workingMarkdown = content.bodyMarkdown;
  let workingHtml = content.bodyHtml ?? '';
  let workingVersion = content.bodyVersion;

  for (const priorRunId of priorRunIds) {
    const priorEdits = existing.filter((e) => e.runId === priorRunId);
    if (priorEdits.length === 0) continue;

    let nextMarkdown = workingMarkdown;
    let nextHtml: string | null = workingHtml;
    let nextAnchorMap: Record<string, unknown> = {};

    if (content.contentFormat === 'html') {
      const materialized = materializeEditsHtml(workingHtml, priorEdits);
      if (!materialized.ok) {
        return {
          result: `Error: server could not parse the HTML body while auto-accepting the prior pending run (${materialized.message}). Resolve manually.`,
          isError: true,
        };
      }
      const sanitized = sanitizeHtmlServer(materialized.html);
      const stamped = insertAnchors(sanitized.clean);
      if (!stamped.ok) {
        return {
          result: `Error: server could not stamp HTML anchors after auto-accept (${stamped.message}). Resolve manually.`,
          isError: true,
        };
      }
      const computed = await computeHtmlAnchorMap(stamped.value);
      if (computed === null) {
        return {
          result:
            'Error: server could not build the HTML anchor map after auto-accept. Resolve manually.',
          isError: true,
        };
      }
      if (byteLengthOf(stamped.value) > CONTENT_BODY_BYTE_LIMIT) {
        return {
          result: `Error: auto-accepting the prior pending run would push the document past the size limit (${byteLengthOf(stamped.value)} bytes). Resolve the prior run manually first.`,
          isError: true,
        };
      }
      nextHtml = stamped.value;
      nextAnchorMap = computed;
    } else {
      const nextDoc = ensureAnchorIds(
        materializeEdits(workingMarkdown, priorEdits),
      );
      nextMarkdown = tiptapJsonToMarkdown(nextDoc);
      if (byteLengthOf(nextMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
        return {
          result: `Error: auto-accepting the prior pending run would push the document past the size limit (${byteLengthOf(nextMarkdown)} bytes). Resolve the prior run manually first.`,
          isError: true,
        };
      }
      nextAnchorMap = await computeAnchorMap(nextDoc);
    }

    const updatedRows = await db<{ body_version: number; talk_id: string }[]>`
      update public.contents
      set body_markdown = ${nextMarkdown},
          body_html = ${nextHtml},
          body_version = body_version + 1,
          anchor_map_json = ${db.json(nextAnchorMap as never)},
          updated_at = now(),
          updated_by_user_id = ${input.userId}::uuid,
          updated_by_run_id = null
      where id = ${content.id}::uuid
        and body_version = ${workingVersion}
      returning body_version, talk_id
    `;
    if (updatedRows.length === 0) {
      return {
        result:
          'Error: the document was modified by another process while auto-accepting prior pending edits. Re-read the doc and try again.',
        isError: true,
      };
    }
    workingMarkdown = nextMarkdown;
    workingHtml = nextHtml ?? '';
    workingVersion = updatedRows[0].body_version;

    const priorEditIds = await deletePendingEditsByRun({
      contentId: content.id,
      runId: priorRunId,
    });

    await emitOutboxEvent({
      topic: `talk:${content.talkId}`,
      eventType: 'content_edit_resolved',
      payload: {
        contentId: content.id,
        runId: priorRunId,
        editIds: priorEditIds,
        resolution: 'auto-accepted',
        reason: 'superseded_by_new_run',
        version: workingVersion,
      },
      ownerIds: [content.ownerId],
    });
  }
  if (priorRunIds.length > 0) {
    await emitOutboxEvent({
      topic: `talk:${content.talkId}`,
      eventType: 'content_updated',
      payload: {
        contentId: content.id,
        version: workingVersion,
        appliedAnchorIds: [],
      },
      ownerIds: [content.ownerId],
    });
  }

  // Look for an existing row in the SAME run that targets the SAME
  // anchor (collapsing semantics — plan Section C table).
  const sameRunEdits = existing.filter((e) => e.runId === input.runId);
  const sameRunBulk = sameRunEdits.find((e) => e.kind === 'bulk');
  const sameRunSameAnchor =
    targetAnchorId !== null
      ? sameRunEdits.find(
          (e) =>
            e.kind !== 'bulk' &&
            e.targetAnchorId === targetAnchorId &&
            (e.kind === 'insert' ||
              e.kind === 'replace' ||
              e.kind === 'delete'),
        )
      : sameRunEdits.find(
          (e) => e.kind === 'insert' && e.targetAnchorId === null,
        );

  // bulk → any-non-bulk in same run = error.
  if (sameRunBulk && internalKind !== 'bulk') {
    return {
      result:
        "Error: a bulk edit was already applied in this turn — the whole body is being replaced. Don't issue additional granular edits in the same turn.",
      isError: true,
    };
  }

  // any-non-bulk → bulk: delete the per-anchor rows for this run and
  // insert one bulk row. (Implemented by deleting everything for the
  // run and falling through to insert.)
  if (internalKind === 'bulk' && sameRunEdits.length > 0) {
    await deletePendingEditsByRun({
      contentId: content.id,
      runId: input.runId,
    });
  }

  let resultingEditId: string;

  if (sameRunSameAnchor && internalKind !== 'bulk') {
    // Collapse into the existing row. Format-aware payload — exactly
    // one of sanitizedMarkdown / sanitizedHtml is non-null per call.
    const collapsed = collapseEdit(
      sameRunSameAnchor,
      internalKind,
      content.contentFormat === 'html' ? sanitizedHtml : sanitizedMarkdown,
      typeof rawRationale === 'string' ? rawRationale : null,
      content.contentFormat,
    );
    if (collapsed === null) {
      // Net no-op (insert→delete): drop the existing row.
      await deletePendingEdit(sameRunSameAnchor.id);
      await emitOutboxEvent({
        topic: `talk:${content.talkId}`,
        eventType: 'content_edit_applied',
        payload: {
          contentId: content.id,
          runId: input.runId,
          editIds: [],
          collapsedEditId: sameRunSameAnchor.id,
        },
        ownerIds: [content.ownerId],
      });
      return {
        result: JSON.stringify({
          ok: true,
          contentId: content.id,
          runId: input.runId,
          editIds: [],
          note: 'net_no_op_after_collapse',
        }),
      };
    }
    const updated = await updatePendingEdit({
      editId: sameRunSameAnchor.id,
      kind: collapsed.kind,
      targetAnchorId: collapsed.targetAnchorId,
      newMarkdown: collapsed.newMarkdown,
      newHtml: collapsed.newHtml,
      rationale: collapsed.rationale,
    });
    if (!updated) {
      return {
        result:
          'Error: failed to update the pending edit row (concurrent delete?).',
        isError: true,
      };
    }
    resultingEditId = updated.id;
  } else {
    const inserted = await insertPendingEdit({
      contentId: content.id,
      runId: input.runId,
      agentId: input.agentId,
      agentNickname: input.agentNickname,
      messageId: input.messageId ?? null,
      kind: internalKind,
      baseContentVersion: workingVersion,
      targetAnchorId,
      newMarkdown:
        internalKind === 'delete' || content.contentFormat === 'html'
          ? null
          : sanitizedMarkdown,
      newHtml:
        internalKind === 'delete' || content.contentFormat !== 'html'
          ? null
          : sanitizedHtml,
      rationale: typeof rawRationale === 'string' ? rawRationale : null,
    });
    resultingEditId = inserted.id;
  }

  await emitOutboxEvent({
    topic: `talk:${content.talkId}`,
    eventType: 'content_edit_applied',
    payload: {
      contentId: content.id,
      runId: input.runId,
      editIds: [resultingEditId],
      agentId: input.agentId,
      agentNickname: input.agentNickname,
      messageId: input.messageId ?? null,
    },
    ownerIds: [content.ownerId],
  });

  return {
    result: JSON.stringify({
      ok: true,
      contentId: content.id,
      runId: input.runId,
      editId: resultingEditId,
      kind: rawKind,
    }),
  };
}

// ── Collapsing semantics (plan Section C table) ──────────────────────

interface CollapsedEdit {
  kind: ContentEditKind;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  newHtml: string | null;
  rationale: string | null;
}

function payloadFields(
  format: 'markdown' | 'html',
  payload: string | null,
): { newMarkdown: string | null; newHtml: string | null } {
  return format === 'html'
    ? { newMarkdown: null, newHtml: payload }
    : { newMarkdown: payload, newHtml: null };
}

function collapseEdit(
  existing: ContentEditRow,
  newKind: ContentEditKind,
  newPayload: string | null,
  newRationale: string | null,
  format: 'markdown' | 'html',
): CollapsedEdit | null {
  const rationale = newRationale ?? existing.rationale;
  const payload = payloadFields(format, newPayload);
  const noPayload = { newMarkdown: null, newHtml: null };
  const existingPayload = {
    newMarkdown: existing.newMarkdown,
    newHtml: existing.newHtml,
  };

  if (existing.kind === 'insert' && newKind === 'replace') {
    return {
      kind: 'insert',
      targetAnchorId: existing.targetAnchorId,
      ...payload,
      rationale,
    };
  }
  if (existing.kind === 'insert' && newKind === 'delete') {
    return null; // net no-op
  }
  if (existing.kind === 'replace' && newKind === 'replace') {
    return {
      kind: 'replace',
      targetAnchorId: existing.targetAnchorId,
      ...payload,
      rationale,
    };
  }
  if (existing.kind === 'replace' && newKind === 'delete') {
    return {
      kind: 'delete',
      targetAnchorId: existing.targetAnchorId,
      ...noPayload,
      rationale,
    };
  }
  if (existing.kind === 'delete' && newKind === 'replace') {
    return {
      kind: 'replace',
      targetAnchorId: existing.targetAnchorId,
      ...payload,
      rationale,
    };
  }
  if (existing.kind === 'delete' && newKind === 'insert') {
    // Treat as "first delete, then re-insert content here" — keep
    // replace semantics so the body block is overwritten with the new.
    return {
      kind: 'replace',
      targetAnchorId: existing.targetAnchorId,
      ...payload,
      rationale,
    };
  }
  if (existing.kind === 'insert' && newKind === 'insert') {
    // Two inserts at the same anchor: take the newer payload, keep
    // insert (the agent may be iterating on the same paragraph).
    return {
      kind: 'insert',
      targetAnchorId: existing.targetAnchorId,
      ...payload,
      rationale,
    };
  }
  if (existing.kind === 'delete' && newKind === 'delete') {
    return {
      kind: 'delete',
      targetAnchorId: existing.targetAnchorId,
      ...noPayload,
      rationale,
    };
  }

  // Defensive fall-through: keep the existing row unchanged.
  return {
    kind: existing.kind,
    targetAnchorId: existing.targetAnchorId,
    ...existingPayload,
    rationale,
  };
}

// ── HTML payload validation (PR B guards) ────────────────────────────

interface HtmlValidationOk {
  ok: true;
  sanitized: string;
}

interface HtmlValidationErr {
  ok: false;
  error: string;
}

// Reasonable heuristic: a payload that contains zero `<tag>` opens
// (after trimming) is plain text, not HTML. Catches the common AI
// regression where Kimi/etc. forget the format and dump markdown into
// the `markdown` field on an HTML doc.
function looksLikePlainText(input: string): boolean {
  // The smallest valid block payload is "<x>" — three chars. Anything
  // shorter, or anything with no tag opening at all, is plain text.
  return !/<\s*[a-zA-Z]/.test(input);
}

function validateHtmlPayload(
  input: string,
): HtmlValidationOk | HtmlValidationErr {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: 'Error: the supplied HTML payload is empty. Provide real content.',
    };
  }
  if (looksLikePlainText(trimmed)) {
    return {
      ok: false,
      error:
        'Error: this document is HTML format but the payload looks like plain text. Re-emit as HTML — for a paragraph use `<p>...</p>`, for a heading use `<h1>...</h1>`, etc. Allowed tags: ' +
        ALLOWED_TAGS.join(', ') +
        '. Banned: <script>, <iframe>, <form>.',
    };
  }
  const { clean } = sanitizeHtmlServer(input);
  if (clean.trim().length === 0) {
    return {
      ok: false,
      error:
        'Error: every tag in the HTML payload was stripped by the server sanitizer. Allowed tags: ' +
        ALLOWED_TAGS.join(', ') +
        '. Banned: <script>, <iframe>, <form>, on*-event handlers, javascript: URLs. Re-emit using allowed tags.',
    };
  }
  return { ok: true, sanitized: clean };
}

// Internal compile-time-only re-export so the unused-import linter
// recognizes the type-only usage above.
export type { ContentEditRow, ContentEditKind };
// EDIT_COLUMNS_SELECT is referenced inline only — keeping the constant
// so future direct queries can mirror the accessor's projection.
void EDIT_COLUMNS_SELECT;
// toEditRow is exported for tests that build pending rows by hand and
// need to feed them through the apply path without re-implementing the
// DB row → API row mapping.
export { toEditRow };
