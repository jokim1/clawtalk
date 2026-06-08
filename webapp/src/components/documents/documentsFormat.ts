/**
 * Pure formatting + edit-summary helpers for the native Documents surface.
 *
 * No React and no API calls live here so the branch/block/edit shaping logic the
 * Documents pages depend on can be unit-tested in isolation. Everything operates
 * on the native `documents`/`doc_tabs`/`doc_blocks`/`document_edits` shapes from
 * `lib/api.ts` — there is no markdown/html content facade read anywhere.
 */
import type {
  NativeDocument,
  NativeDocumentBlock,
  NativeDocumentBlockKind,
  NativeDocumentEdit,
  NativeDocumentSummary,
} from '../../lib/api';

export function formatDocDate(value: string | null): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** One-line meta for a document row: "3 tabs · 12 blocks · 240 words". */
export function documentSummaryMeta(doc: NativeDocumentSummary): string {
  return [
    plural(doc.tabCount, 'tab'),
    plural(doc.blockCount, 'block'),
    plural(doc.wordCount, 'word'),
  ].join(' · ');
}

export const BLOCK_KIND_LABEL: Record<NativeDocumentBlockKind, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  p: 'Paragraph',
  li: 'List item',
  meta: 'Metadata',
  code: 'Code',
};

export const EDIT_OP_LABEL: Record<NativeDocumentEdit['op'], string> = {
  insert: 'Insert',
  replace: 'Replace',
  delete: 'Delete',
};

export const EDIT_SOURCE_LABEL: Record<NativeDocumentEdit['source'], string> = {
  agent: 'Agent',
  forge: 'Forge',
  job: 'Job',
};

/** The block an edit targets (replace/delete), or null for an insert. */
export function findBlockById(
  doc: NativeDocument,
  blockId: string | null,
): NativeDocumentBlock | null {
  if (!blockId) return null;
  for (const tab of doc.tabs) {
    const block = tab.blocks.find((entry) => entry.id === blockId);
    if (block) return block;
  }
  return null;
}

/** Human title for the tab an edit lands in. */
export function tabTitleForEdit(
  doc: NativeDocument,
  edit: NativeDocumentEdit,
): string {
  const tab = doc.tabs.find((entry) => entry.id === edit.tabId);
  return tab?.title ?? 'Untitled tab';
}

export type EditPreview = {
  /** e.g. "Replace paragraph", "Insert heading 2", "Delete list item". */
  title: string;
  /** Existing block text the edit acts on (replace/delete); null for insert. */
  beforeText: string | null;
  /** Proposed new text (insert/replace); null for delete. */
  afterText: string | null;
};

/**
 * Shape a single pending edit into before/after text for the review card.
 * Falls back gracefully when the target block is not in the loaded document
 * (e.g. it was removed by an earlier accepted edit in the same run).
 */
export function previewEdit(
  doc: NativeDocument,
  edit: NativeDocumentEdit,
): EditPreview {
  const target = findBlockById(doc, edit.blockId);
  const kindLabel = (
    edit.newKind
      ? BLOCK_KIND_LABEL[edit.newKind]
      : target
        ? BLOCK_KIND_LABEL[target.kind]
        : 'block'
  ).toLowerCase();
  return {
    title: `${EDIT_OP_LABEL[edit.op]} ${kindLabel}`,
    beforeText: edit.op === 'insert' ? null : (target?.text ?? null),
    afterText: edit.op === 'delete' ? null : (edit.newText ?? ''),
  };
}

export type PendingRunGroup = {
  /** Non-null when the run-level accept/reject endpoints can be used. */
  runId: string | null;
  agentName: string;
  source: NativeDocumentEdit['source'];
  edits: NativeDocumentEdit[];
};

/**
 * Group pending edits by the run that proposed them, preserving first-seen
 * order. Edits with no `proposedByRunId` (e.g. one-off job/forge edits) each
 * become their own single-edit group keyed by edit id, so the review UI can
 * still offer per-edit accept/reject without a run-level control.
 */
export function groupPendingEditsByRun(
  edits: NativeDocumentEdit[],
): PendingRunGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PendingRunGroup>();
  for (const edit of edits) {
    const key = edit.proposedByRunId ?? `edit:${edit.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        runId: edit.proposedByRunId,
        agentName: edit.proposedByAgentName ?? 'An agent',
        source: edit.source,
        edits: [],
      };
      byKey.set(key, group);
      order.push(key);
    }
    group.edits.push(edit);
  }
  return order.map((key) => byKey.get(key) as PendingRunGroup);
}

/**
 * Where an insert edit lands, as a short hint for the review card. Returns null
 * for non-insert ops. Resolves `afterBlockId` against the loaded document so the
 * reviewer can see the insertion point instead of a location-less proposal.
 */
export function insertAnchorLabel(
  doc: NativeDocument,
  edit: NativeDocumentEdit,
): string | null {
  if (edit.op !== 'insert') return null;
  if (!edit.afterBlockId) return 'Insert at the top';
  const anchor = findBlockById(doc, edit.afterBlockId);
  if (!anchor) return 'Insert after a removed block';
  const text = anchor.text.trim();
  const truncated = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return `Insert after: ${truncated || BLOCK_KIND_LABEL[anchor.kind]}`;
}
