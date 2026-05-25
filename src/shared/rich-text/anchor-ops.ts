// Anchor map computation + server-side proposal application.
//
// All operations work on Tiptap-JSON-shaped documents (see types.ts).
// The doc is the source of truth; markdown is a derived projection
// produced by tiptap-to-markdown.ts. Server-side proposal Accept goes
// markdown → JSON (markdown-to-tiptap.ts) → AST insert → markdown
// (tiptap-to-markdown.ts) → recompute anchor map. That round-trip is
// the strategy locked in the plan for avoiding string-surgery
// fragility on adjacent code fences and list nesting.

import {
  ANCHOR_ATTR_KEY,
  type AnchorEntry,
  type AnchorMap,
  type RichTextDocument,
  type RichTextNode,
} from './types.js';

const PREVIEW_MAX = 60;

export function freshAnchorId(): string {
  // Truncated UUID — 12 chars of entropy is enough to never collide
  // within a single document and keeps the markdown HTML comment tidy.
  const uuid = crypto.randomUUID();
  return uuid.replace(/-/g, '').slice(0, 12);
}

export function ensureAnchorIds(
  doc: RichTextDocument,
  generate: () => string = freshAnchorId,
): RichTextDocument {
  const nextContent = (doc.content ?? []).map((node) => {
    const existing = node.attrs?.[ANCHOR_ATTR_KEY];
    if (typeof existing === 'string' && existing.length > 0) return node;
    return {
      ...node,
      attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: generate() },
    };
  });
  return { ...doc, content: nextContent };
}

export function getAnchorId(node: RichTextNode): string | null {
  const v = node.attrs?.[ANCHOR_ATTR_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function plainTextOf(node: RichTextNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return '';
  return node.content.map(plainTextOf).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function computeAnchorMap(
  doc: RichTextDocument,
): Promise<AnchorMap> {
  const map: AnchorMap = {};
  const content = doc.content ?? [];
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    const anchorId = getAnchorId(node);
    if (!anchorId) continue;
    const text = plainTextOf(node);
    map[anchorId] = {
      kind: node.type,
      sort_order: i,
      preview: text.slice(0, PREVIEW_MAX),
      content_hash: await sha256Hex(text),
    };
  }
  return map;
}

export function findBlockIndexByAnchor(
  doc: RichTextDocument,
  anchorId: string,
): number {
  const content = doc.content ?? [];
  for (let i = 0; i < content.length; i++) {
    if (getAnchorId(content[i]) === anchorId) return i;
  }
  return -1;
}

export interface InsertAfterAnchorResult {
  doc: RichTextDocument;
  appliedAnchorIds: string[];
}

export function insertAfterAnchor(input: {
  doc: RichTextDocument;
  afterAnchorId: string | null;
  insertedNodes: RichTextNode[];
  generate?: () => string;
}): InsertAfterAnchorResult | { kind: 'anchor_missing' } {
  const generate = input.generate ?? freshAnchorId;
  const stamped: RichTextNode[] = [];
  const appliedAnchorIds: string[] = [];
  for (const node of input.insertedNodes) {
    const anchorId = getAnchorId(node) ?? generate();
    appliedAnchorIds.push(anchorId);
    stamped.push({
      ...node,
      attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: anchorId },
    });
  }

  const content = [...(input.doc.content ?? [])];
  let insertIdx: number;
  if (input.afterAnchorId === null) {
    insertIdx = 0;
  } else {
    const found = findBlockIndexByAnchor(input.doc, input.afterAnchorId);
    if (found === -1) return { kind: 'anchor_missing' };
    insertIdx = found + 1;
  }
  content.splice(insertIdx, 0, ...stamped);

  return {
    doc: { ...input.doc, content },
    appliedAnchorIds,
  };
}

export interface ReplaceBlockByAnchorResult {
  doc: RichTextDocument;
  appliedAnchorIds: string[];
}

/**
 * Replace the block whose data-anchor-id matches `targetAnchorId` with
 * the provided node sequence. The replacement nodes are always stamped
 * with fresh anchor IDs even if they arrive carrying anchor attrs —
 * agent-supplied anchors can't be used to hijack an existing block's
 * identity. If a single replacement node is supplied, it inherits the
 * targeted block's anchor so downstream references survive; multiple
 * nodes always get fresh IDs (no canonical "primary" block to inherit).
 */
export function replaceBlockByAnchor(input: {
  doc: RichTextDocument;
  targetAnchorId: string;
  replacementNodes: RichTextNode[];
  generate?: () => string;
}): ReplaceBlockByAnchorResult | { kind: 'anchor_missing' } {
  const generate = input.generate ?? freshAnchorId;
  const idx = findBlockIndexByAnchor(input.doc, input.targetAnchorId);
  if (idx === -1) return { kind: 'anchor_missing' };

  const stamped: RichTextNode[] = [];
  const appliedAnchorIds: string[] = [];
  const inheritTarget =
    input.replacementNodes.length === 1 ? input.targetAnchorId : null;
  for (let i = 0; i < input.replacementNodes.length; i++) {
    const node = input.replacementNodes[i];
    const anchorId = i === 0 && inheritTarget ? inheritTarget : generate();
    appliedAnchorIds.push(anchorId);
    stamped.push({
      ...node,
      attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: anchorId },
    });
  }

  const content = [...(input.doc.content ?? [])];
  content.splice(idx, 1, ...stamped);

  return {
    doc: { ...input.doc, content },
    appliedAnchorIds,
  };
}

/**
 * Structural fingerprint of a node: type + attrs (minus anchor) + the
 * recursive structural fingerprint of every child. Used to detect drift
 * that the plain-text content_hash misses — heading level changes, list
 * marker swaps, mark structure changes. Fingerprint stability does NOT
 * imply text identity (use content_hash for that); fingerprint mismatch
 * means the block's shape has changed.
 */
export function structuralFingerprint(node: RichTextNode): string {
  return JSON.stringify(fingerprintShape(node));
}

interface FingerprintShape {
  t: string;
  a?: Record<string, unknown>;
  m?: Array<Pick<FingerprintShape, 't' | 'a'>>;
  c?: FingerprintShape[];
}

function fingerprintShape(node: RichTextNode): FingerprintShape {
  const out: FingerprintShape = { t: node.type };
  if (node.attrs) {
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(node.attrs).sort()) {
      if (key === ANCHOR_ATTR_KEY) continue;
      cleaned[key] = node.attrs[key];
    }
    if (Object.keys(cleaned).length > 0) out.a = cleaned;
  }
  if (node.marks && node.marks.length > 0) {
    out.m = node.marks.map((mark) => ({
      t: mark.type,
      ...(mark.attrs ? { a: mark.attrs } : {}),
    }));
  }
  if (Array.isArray(node.content) && node.content.length > 0) {
    out.c = node.content.map(fingerprintShape);
  }
  return out;
}
