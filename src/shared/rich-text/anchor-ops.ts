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
