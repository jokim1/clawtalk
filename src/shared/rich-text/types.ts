// Shared Tiptap-JSON-compatible document types.
//
// This module lives in `src/shared/` because both the webapp (browser
// runtime) and the worker (Cloudflare Workers runtime) need to read,
// transform, and reserialize Content bodies. We deliberately avoid
// depending on @tiptap/core at runtime so the worker bundle stays
// small and the browser bundle doesn't double-include the editor.
//
// The shapes below are a faithful subset of @tiptap/core's JSONContent
// for the marks/nodes we use in v1 — adding a node here requires a
// matching case in tiptap-to-markdown.ts and markdown-to-tiptap.ts.

export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
}

export interface RichTextDocument extends RichTextNode {
  type: 'doc';
  content: RichTextNode[];
}

// Per-block sidecar metadata stored in `contents.anchor_map_json`.
// `content_hash` is a SHA-256 hex of the block's plain-text content
// at save time; the accept path compares this against the proposal's
// stored hash to detect semantic drift.
export interface AnchorEntry {
  kind: string;
  sort_order: number;
  preview: string;
  content_hash: string;
}

export type AnchorMap = Record<string, AnchorEntry>;

export const ANCHOR_ATTR_KEY = 'dataAnchorId' as const;
