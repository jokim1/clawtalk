// Conversion + clipboard + file-download helpers used by the Copy / Export
// menu. The canonical source is native document blocks.
//
// Clipboard writes for "Copy as HTML" set BOTH text/html and
// text/plain MIMEs so rich-text destinations (Google Docs, Substack)
// preserve formatting and plain-text destinations get a graceful
// fallback. Markdown / Plain copy use the simpler writeText path.

import type { NativeDocument, NativeDocumentBlock } from './api';

export type DocFormat = 'markdown' | 'html';

export type NativeDocumentExportBlock = Pick<
  NativeDocumentBlock,
  'kind' | 'text'
>;

export interface NativeDocumentExportTab {
  title: string;
  blocks: NativeDocumentExportBlock[];
}

export interface NativeDocumentExportSource {
  kind: 'native-document-blocks';
  format: DocFormat;
  tabs: NativeDocumentExportTab[];
}

export type DocExportSource = NativeDocumentExportSource;

export function nativeDocumentToExportSource(
  document: Pick<NativeDocument, 'format' | 'tabs'>,
): NativeDocumentExportSource {
  return {
    kind: 'native-document-blocks',
    format: document.format,
    tabs: document.tabs.map((tab) => ({
      title: tab.title,
      blocks: tab.blocks.map((block) => ({
        kind: block.kind,
        text: block.text,
      })),
    })),
  };
}

export function renderHtml(src: DocExportSource): string {
  return renderNativeHtml(src);
}

export function renderMarkdown(src: DocExportSource): string {
  return renderNativeMarkdown(src);
}

export function renderPlainText(src: DocExportSource): string {
  return renderNativePlainText(src);
}

function renderNativeMarkdown(src: NativeDocumentExportSource): string {
  const includeTabHeadings = src.tabs.length > 1;
  return src.tabs
    .map((tab) => {
      const parts = tab.blocks
        .map(nativeBlockToMarkdown)
        .filter((part) => part.trim() !== '');
      if (includeTabHeadings) {
        parts.unshift(
          `## ${escapeMarkdownText(tab.title.trim() || 'Untitled tab')}`,
        );
      }
      return parts.join('\n\n');
    })
    .filter((section) => section.trim() !== '')
    .join('\n\n');
}

function nativeBlockToMarkdown(block: NativeDocumentExportBlock): string {
  switch (block.kind) {
    case 'h1':
      return `# ${escapeMarkdownText(block.text)}`;
    case 'h2':
      return `## ${escapeMarkdownText(block.text)}`;
    case 'li':
      return `- ${escapeMarkdownText(block.text)}`;
    case 'code':
      return fencedCodeBlock(block.text);
    case 'meta':
    case 'p':
      return escapeMarkdownText(block.text);
  }
  const exhaustive: never = block.kind;
  return exhaustive;
}

function fencedCodeBlock(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function escapeMarkdownText(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]()])/g, '\\$1')
    .replace(/^(#{1,6})(\s+)/gm, '\\$1$2')
    .replace(/^([>+-])(\s+)/gm, '\\$1$2')
    .replace(/^(\d+)([.)]\s+)/gm, '$1\\$2');
}

function renderNativePlainText(src: NativeDocumentExportSource): string {
  const includeTabHeadings = src.tabs.length > 1;
  return src.tabs
    .map((tab) => {
      const parts = tab.blocks
        .map((block) => block.text.trim())
        .filter((text) => text !== '');
      if (includeTabHeadings) {
        parts.unshift(tab.title.trim() || 'Untitled tab');
      }
      return parts.join('\n\n');
    })
    .filter((section) => section.trim() !== '')
    .join('\n\n');
}

function renderNativeHtml(src: NativeDocumentExportSource): string {
  const includeTabHeadings = src.tabs.length > 1;
  return src.tabs
    .map((tab) => {
      const parts: string[] = [];
      if (includeTabHeadings) {
        parts.push(`<h2>${escapeHtml(tab.title.trim() || 'Untitled tab')}</h2>`);
      }
      parts.push(nativeBlocksToHtml(tab.blocks));
      return parts.filter(Boolean).join('\n');
    })
    .filter((section) => section.trim() !== '')
    .join('\n\n');
}

function nativeBlocksToHtml(blocks: NativeDocumentExportBlock[]): string {
  const parts: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length === 0) return;
    parts.push(`<ul>\n${listItems.join('\n')}\n</ul>`);
    listItems = [];
  };
  for (const block of blocks) {
    if (block.kind === 'li') {
      listItems.push(`<li>${escapeHtml(block.text)}</li>`);
      continue;
    }
    flushList();
    parts.push(nativeBlockToHtml(block));
  }
  flushList();
  return parts.filter((part) => part.trim() !== '').join('\n');
}

function nativeBlockToHtml(block: NativeDocumentExportBlock): string {
  const text = escapeHtml(block.text);
  switch (block.kind) {
    case 'h1':
      return `<h1>${text}</h1>`;
    case 'h2':
      return `<h2>${text}</h2>`;
    case 'li':
      return `<li>${text}</li>`;
    case 'code':
      return `<pre><code>${text}</code></pre>`;
    case 'meta':
      return `<p data-block-kind="meta"><small>${text}</small></p>`;
    case 'p':
      return `<p>${text}</p>`;
  }
  const exhaustive: never = block.kind;
  return exhaustive;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Clipboard ---------------------------------------------------

export async function clipboardCopyHtml(src: DocExportSource): Promise<void> {
  const html = renderHtml(src);
  const plain = renderPlainText(src);
  // Older browsers / test envs may not have ClipboardItem. Fall back
  // to writeText so the caller can still ship plain content rather
  // than failing the whole copy.
  if (typeof ClipboardItem === 'function') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(plain);
}

export async function clipboardCopyMarkdown(
  src: DocExportSource,
): Promise<void> {
  await navigator.clipboard.writeText(renderMarkdown(src));
}

export async function clipboardCopyPlain(src: DocExportSource): Promise<void> {
  await navigator.clipboard.writeText(renderPlainText(src));
}

// ---- File download -----------------------------------------------

// Sanitize a doc title into a filename root. Replaces filesystem-
// hostile chars with `-`, collapses runs, strips leading/trailing
// dashes, falls back to "document" if the result is empty.
export function sanitizeFilename(input: string): string {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') return 'document';
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'document' : cleaned;
}

interface DownloadOpts {
  filenameBase: string;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Some browsers require the anchor to be in the DOM for the
    // synthetic click to fire reliably.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revoke so the download has time to start. 0ms is
    // sufficient in practice; we use a short timeout to avoid
    // revoking too early in jsdom.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadAsHtml(src: DocExportSource, opts: DownloadOpts): void {
  const body = renderHtml(src);
  const blob = new Blob([body], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.html`);
}

export function downloadAsMarkdown(
  src: DocExportSource,
  opts: DownloadOpts,
): void {
  const body = renderMarkdown(src);
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.md`);
}

export function downloadAsPlain(
  src: DocExportSource,
  opts: DownloadOpts,
): void {
  const body = renderPlainText(src);
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.txt`);
}

// True when every native block is empty/whitespace; the menu uses this to
// disable copy/export.
export function isDocEmpty(src: DocExportSource): boolean {
  return src.tabs.every((tab) =>
    tab.blocks.every((block) => block.text.trim() === ''),
  );
}
