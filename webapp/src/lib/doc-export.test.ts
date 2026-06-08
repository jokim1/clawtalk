import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clipboardCopyHtml,
  clipboardCopyMarkdown,
  clipboardCopyPlain,
  downloadAsHtml,
  downloadAsMarkdown,
  downloadAsPlain,
  isDocEmpty,
  legacyContentExportProjection,
  nativeDocumentToExportSource,
  renderHtml,
  renderMarkdown,
  renderPlainText,
  sanitizeFilename,
  stripHtmlTags,
  stripMarkdown,
} from './doc-export';
import type { NativeDocument, NativeDocumentBlock } from './api';

describe('doc-export', () => {
  describe('conversion matrix', () => {
    describe('markdown source', () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown:
          '# Heading\n\nA paragraph with [a link](https://x.com).\n\n- one\n- two',
        html: null,
      });

      it('renderMarkdown returns raw legacy markdown projection', () => {
        expect(renderMarkdown(src)).toBe(src.markdown);
      });

      it('renderHtml produces <h1>, <p>, <a>, <ul>', () => {
        const html = renderHtml(src);
        expect(html).toContain('<h1');
        expect(html).toContain('Heading');
        expect(html).toContain('<p');
        expect(html).toContain('<a href="https://x.com">a link</a>');
        expect(html).toContain('<ul');
        expect(html).toContain('<li');
      });

      it('renderPlainText drops syntax and preserves text', () => {
        const text = renderPlainText(src);
        expect(text).toContain('Heading');
        expect(text).toContain('A paragraph with a link');
        expect(text).toContain('one');
        expect(text).toContain('two');
        expect(text).not.toContain('#');
        expect(text).not.toContain('[a link]');
        expect(text).not.toContain('(https://x.com)');
      });
    });

    describe('html source', () => {
      const src = legacyContentExportProjection({
        format: 'html',
        markdown: null,
        html:
          '<h1>Heading</h1><p>A paragraph with <a href="https://x.com">a link</a>.</p><ul><li>one</li><li>two</li></ul>',
      });

      it('renderHtml returns raw legacy HTML projection', () => {
        expect(renderHtml(src)).toBe(src.html);
      });

      it('renderMarkdown produces #-headings, list dashes, and link syntax', () => {
        const md = renderMarkdown(src);
        // Turndown sets atx headings by config
        expect(md).toMatch(/^#\s+Heading/m);
        expect(md).toContain('[a link](https://x.com)');
        expect(md).toMatch(/^[-]\s+one/m);
        expect(md).toMatch(/^[-]\s+two/m);
      });

      it('renderPlainText strips tags and preserves text', () => {
        const text = renderPlainText(src);
        expect(text).toContain('Heading');
        expect(text).toContain('A paragraph with a link.');
        expect(text).toContain('one');
        expect(text).toContain('two');
        expect(text).not.toContain('<');
      });
    });

    describe('edge cases', () => {
      it('renders empty bodies as empty strings (not "null")', () => {
        const empty = legacyContentExportProjection({
          format: 'markdown',
          markdown: null,
          html: null,
        });
        expect(renderMarkdown(empty)).toBe('');
        expect(renderHtml(empty)).toBe('');
        expect(renderPlainText(empty)).toBe('');
      });
    });

    describe('native document block source', () => {
      const native = nativeDocumentToExportSource(
        makeNativeDoc({
          tabCount: 2,
          tabs: [
            makeTab({
              id: 'tab-main',
              title: 'Main',
              blocks: [
                makeBlock({ kind: 'h1', text: 'Launch plan' }),
                makeBlock({ id: 'b2', sortOrder: 1, kind: 'p', text: 'Ship the MVP.' }),
                makeBlock({ id: 'b3', sortOrder: 2, kind: 'li', text: 'One' }),
                makeBlock({ id: 'b4', sortOrder: 3, kind: 'li', text: 'Two' }),
                makeBlock({
                  id: 'b5',
                  sortOrder: 4,
                  kind: 'code',
                  text: 'const shipped = true;',
                }),
                makeBlock({
                  id: 'b6',
                  sortOrder: 5,
                  kind: 'meta',
                  text: 'Owner: Ops',
                }),
              ],
            }),
            makeTab({
              id: 'tab-research',
              title: 'Research',
              sortOrder: 1,
              blocks: [
                makeBlock({
                  id: 'b7',
                  tabId: 'tab-research',
                  kind: 'h2',
                  text: 'Evidence',
                }),
              ],
            }),
          ],
        }),
      );

      it('serializes headings, lists, code, meta, and tab titles to markdown', () => {
        const markdown = renderMarkdown(native);
        expect(markdown).toContain('## Main');
        expect(markdown).toContain('# Launch plan');
        expect(markdown).toContain('- One');
        expect(markdown).toContain('- Two');
        expect(markdown).toContain('```\nconst shipped = true;\n```');
        expect(markdown).toContain('Owner: Ops');
        expect(markdown).toContain('## Research');
        expect(markdown).toContain('## Evidence');
      });

      it('escapes literal native text when exporting markdown', () => {
        const markdown = renderMarkdown(
          nativeDocumentToExportSource(
            makeNativeDoc({
              tabs: [
                makeTab({
                  title: '[Main](url)',
                  blocks: [
                    makeBlock({
                      kind: 'p',
                      text: '[RFC](url) and *literal* underscores __stay__',
                    }),
                    makeBlock({
                      id: 'literal-code',
                      sortOrder: 1,
                      kind: 'code',
                      text: 'def __init__(self):\n    return [RFC](url)',
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        expect(markdown).toContain(
          '\\[RFC\\]\\(url\\) and \\*literal\\* underscores \\_\\_stay\\_\\_',
        );
        expect(markdown).toContain('def __init__(self):');
        expect(markdown).toContain('return [RFC](url)');
      });

      it('uses a long enough markdown fence for code containing backticks', () => {
        const markdown = renderMarkdown(
          nativeDocumentToExportSource(
            makeNativeDoc({
              tabs: [
                makeTab({
                  blocks: [
                    makeBlock({
                      kind: 'code',
                      text: 'const fence = ```;\nconst inline = `tick`;',
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        expect(markdown).toContain(
          '````\nconst fence = ```;\nconst inline = `tick`;\n````',
        );
      });

      it('serializes native blocks to HTML without facade fields', () => {
        const html = renderHtml(native);
        expect(html).toContain('<h1>Launch plan</h1>');
        expect(html).toContain('<ul>');
        expect(html).toContain('<li>One</li>');
        expect(html).toContain('<pre><code>const shipped = true;</code></pre>');
        expect(html).toContain(
          '<p data-block-kind="meta"><small>Owner: Ops</small></p>',
        );
        expect(html).toContain('<h2>Research</h2>');
      });

      it('serializes native blocks to plain text', () => {
        const text = renderPlainText(native);
        expect(text).toContain('Launch plan');
        expect(text).toContain('Ship the MVP.');
        expect(text).toContain('const shipped = true;');
        expect(text).toContain('Owner: Ops');
        expect(text).not.toContain('```');
      });

      it('preserves literal native block text in plain text export', () => {
        const text = renderPlainText(
          nativeDocumentToExportSource(
            makeNativeDoc({
              tabs: [
                makeTab({
                  blocks: [
                    makeBlock({
                      kind: 'code',
                      text: 'def __init__(self):\n    return [RFC](url)',
                    }),
                    makeBlock({
                      id: 'literal-p',
                      sortOrder: 1,
                      text: '[RFC](url) and *literal* underscores __stay__',
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        expect(text).toContain('def __init__(self):');
        expect(text).toContain('return [RFC](url)');
        expect(text).toContain('[RFC](url) and *literal* underscores __stay__');
      });

      it('escapes native block HTML text', () => {
        const html = renderHtml(
          nativeDocumentToExportSource(
            makeNativeDoc({
              tabs: [
                makeTab({
                  blocks: [
                    makeBlock({ text: '<script>alert("x")</script> & copy' }),
                  ],
                }),
              ],
            }),
          ),
        );
        expect(html).toContain(
          '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; copy',
        );
        expect(html).not.toContain('<script>');
      });
    });
  });

  describe('stripMarkdown / stripHtmlTags helpers', () => {
    it('stripMarkdown drops fenced code fences but keeps content', () => {
      const text = stripMarkdown('```js\nconst x = 1\n```');
      expect(text).toContain('const x = 1');
      expect(text).not.toContain('```');
    });

    it('stripHtmlTags decodes common entities', () => {
      const text = stripHtmlTags('<p>5 &gt; 4 &amp; 3 &lt; 4</p>');
      expect(text).toContain('5 > 4 & 3 < 4');
    });

    it('stripHtmlTags adds newlines between block elements', () => {
      const text = stripHtmlTags('<p>one</p><p>two</p>');
      expect(text).toBe('one\ntwo');
    });
  });

  describe('clipboard', () => {
    let writeMock: ReturnType<typeof vi.fn>;
    let writeTextMock: ReturnType<typeof vi.fn>;
    const originalClipboardItem = globalThis.ClipboardItem;

    beforeEach(() => {
      writeMock = vi.fn().mockResolvedValue(undefined);
      writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: writeMock, writeText: writeTextMock },
      });
      // Provide a minimal ClipboardItem in jsdom.
      // @ts-expect-error: shape match is enough for the assertion
      globalThis.ClipboardItem = class FakeClipboardItem {
        public types: string[];
        constructor(public items: Record<string, Blob>) {
          this.types = Object.keys(items);
        }
      };
    });

    afterEach(() => {
      // restore (cast through unknown — the original may be undefined
      // in jsdom; the assignment back is intentional cleanup).
      (
        globalThis as unknown as { ClipboardItem: typeof ClipboardItem }
      ).ClipboardItem = originalClipboardItem;
    });

    it('clipboardCopyHtml writes BOTH text/html and text/plain', async () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# Hi\n\nWorld',
        html: null,
      });
      await clipboardCopyHtml(src);
      expect(writeMock).toHaveBeenCalledTimes(1);
      const items = writeMock.mock.calls[0]?.[0] as Array<{
        items: Record<string, Blob>;
      }>;
      expect(items).toHaveLength(1);
      const mimes = Object.keys(items[0]?.items ?? {});
      expect(mimes).toContain('text/html');
      expect(mimes).toContain('text/plain');
    });

    it('clipboardCopyMarkdown writes markdown via writeText', async () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# H',
        html: null,
      });
      await clipboardCopyMarkdown(src);
      expect(writeTextMock).toHaveBeenCalledWith('# H');
    });

    it('clipboardCopyPlain writes plain text via writeText', async () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# Hi',
        html: null,
      });
      await clipboardCopyPlain(src);
      expect(writeTextMock).toHaveBeenCalledWith('Hi');
    });
  });

  describe('file download', () => {
    let createSpy: ReturnType<typeof vi.fn>;
    let revokeSpy: ReturnType<typeof vi.fn>;
    let clickSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createSpy = vi.fn().mockReturnValue('blob:fake-url');
      revokeSpy = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: createSpy,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: revokeSpy,
      });
      // Patch synthetic anchor click — we don't actually want a navigation.
      clickSpy = vi.fn();
      const origCreate = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreate(tag);
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = clickSpy as () => void;
        }
        return el;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('downloadAsHtml creates a blob URL + triggers anchor click', () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# Hi',
        html: null,
      });
      downloadAsHtml(src, { filenameBase: 'My Doc' });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/html/);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('downloadAsMarkdown uses .md extension + text/markdown MIME', () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# Hi',
        html: null,
      });
      downloadAsMarkdown(src, { filenameBase: 'My Doc' });
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/markdown/);
    });

    it('downloadAsPlain uses .txt extension + text/plain MIME', () => {
      const src = legacyContentExportProjection({
        format: 'markdown',
        markdown: '# Hi',
        html: null,
      });
      downloadAsPlain(src, { filenameBase: 'My Doc' });
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/plain/);
    });
  });

  describe('sanitizeFilename', () => {
    it('replaces filesystem-hostile chars with -', () => {
      expect(sanitizeFilename('My/Doc:Title')).toBe('My-Doc-Title');
    });

    it('collapses whitespace and runs of dashes', () => {
      expect(sanitizeFilename('Hello   World')).toBe('Hello-World');
      expect(sanitizeFilename('a---b')).toBe('a-b');
    });

    it('falls back to document when empty', () => {
      expect(sanitizeFilename('')).toBe('document');
      expect(sanitizeFilename('   ')).toBe('document');
      expect(sanitizeFilename('///')).toBe('document');
    });
  });

  describe('isDocEmpty', () => {
    it('returns true for null/whitespace bodies', () => {
      expect(
        isDocEmpty(
          legacyContentExportProjection({
            format: 'markdown',
            markdown: null,
            html: null,
          }),
        ),
      ).toBe(true);
      expect(
        isDocEmpty(
          legacyContentExportProjection({
            format: 'markdown',
            markdown: '  \n  ',
            html: null,
          }),
        ),
      ).toBe(true);
      expect(
        isDocEmpty(
          legacyContentExportProjection({
            format: 'html',
            markdown: null,
            html: '   ',
          }),
        ),
      ).toBe(true);
      expect(
        isDocEmpty(
          nativeDocumentToExportSource(makeNativeDoc({ tabs: [makeTab({ blocks: [] })] })),
        ),
      ).toBe(true);
    });

    it('returns false for non-empty bodies', () => {
      expect(
        isDocEmpty(
          legacyContentExportProjection({
            format: 'markdown',
            markdown: '# Hi',
            html: null,
          }),
        ),
      ).toBe(false);
      expect(
        isDocEmpty(
          legacyContentExportProjection({
            format: 'html',
            markdown: null,
            html: '<p>Hi</p>',
          }),
        ),
      ).toBe(false);
      expect(
        isDocEmpty(
          nativeDocumentToExportSource(
            makeNativeDoc({ tabs: [makeTab({ blocks: [makeBlock()] })] }),
          ),
        ),
      ).toBe(false);
    });
  });
});

function makeBlock(
  overrides: Partial<NativeDocumentBlock> = {},
): NativeDocumentBlock {
  return {
    id: 'block-1',
    documentId: 'doc-1',
    tabId: 'tab-1',
    sortOrder: 0,
    version: 1,
    kind: 'p',
    text: 'Original paragraph.',
    attrs: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTab(
  overrides: Partial<NativeDocument['tabs'][number]> = {},
): NativeDocument['tabs'][number] {
  return {
    id: 'tab-1',
    documentId: 'doc-1',
    title: 'Main',
    sortOrder: 0,
    listVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    blocks: [makeBlock()],
    ...overrides,
  };
}

function makeNativeDoc(
  overrides: Partial<NativeDocument> = {},
): NativeDocument {
  return {
    id: 'doc-1',
    workspaceId: 'ws-1',
    primaryTalkId: null,
    folderId: null,
    title: 'Launch brief',
    format: 'markdown',
    wordCount: 2,
    lastEditAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    tabCount: 1,
    blockCount: 1,
    pendingEditCount: 0,
    tabs: [makeTab()],
    pendingEdits: [],
    ...overrides,
  };
}
