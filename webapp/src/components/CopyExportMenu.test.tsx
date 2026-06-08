import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyExportMenu } from './CopyExportMenu';
import {
  legacyContentExportProjection,
  nativeDocumentToExportSource,
} from '../lib/doc-export';
import type { NativeDocument } from '../lib/api';

const MARKDOWN_SRC = legacyContentExportProjection({
  format: 'markdown' as const,
  markdown: '# Hi\n\nWorld',
  html: null,
});
const HTML_SRC = legacyContentExportProjection({
  format: 'html' as const,
  markdown: null,
  html: '<h1>Hi</h1><p>World</p>',
});
const NATIVE_SRC = nativeDocumentToExportSource({
  format: 'markdown',
  tabs: [
    {
      id: 'tab-1',
      documentId: 'doc-1',
      title: 'Main',
      sortOrder: 0,
      listVersion: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      blocks: [
        {
          id: 'block-1',
          documentId: 'doc-1',
          tabId: 'tab-1',
          sortOrder: 0,
          version: 1,
          kind: 'h1',
          text: 'Native heading',
          attrs: {},
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 'block-2',
          documentId: 'doc-1',
          tabId: 'tab-1',
          sortOrder: 1,
          version: 1,
          kind: 'li',
          text: 'Native item',
          attrs: {},
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    },
  ],
} satisfies Pick<NativeDocument, 'format' | 'tabs'>);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setupClipboard() {
  const writeMock = vi.fn().mockResolvedValue(undefined);
  const writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: writeMock, writeText: writeTextMock },
  });
  // @ts-expect-error: shape match is enough
  globalThis.ClipboardItem = class FakeClipboardItem {
    public types: string[];
    constructor(public items: Record<string, Blob>) {
      this.types = Object.keys(items);
    }
  };
  return { writeMock, writeTextMock };
}

function setupDownload(): {
  createSpy: ReturnType<typeof vi.fn>;
  clickSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn().mockReturnValue('blob:test');
  const revokeSpy = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createSpy,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeSpy,
  });
  const clickSpy = vi.fn();
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag);
    if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy as () => void;
    return el;
  });
  return { createSpy, clickSpy };
}

describe('CopyExportMenu', () => {
  describe('trigger + menu open/close', () => {
    it('renders the trigger button by default', () => {
      render(
        <CopyExportMenu
          source={MARKDOWN_SRC}
          documentTitle="My doc"
        />,
      );
      const trigger = screen.getByRole('button', { name: /Copy \/ Export/i });
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens the menu on click', () => {
      render(
        <CopyExportMenu
          source={MARKDOWN_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('disables the trigger and shows tooltip when doc is empty', () => {
      render(
        <CopyExportMenu
          source={legacyContentExportProjection({
            format: 'markdown',
            markdown: '',
            html: null,
          })}
          documentTitle="Empty"
        />,
      );
      const trigger = screen.getByRole('button', { name: /Copy \/ Export/i });
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveAttribute('title', 'Doc is empty');
    });
  });

  describe('Copy as actions', () => {
    it('Copy as HTML writes both text/html and text/plain', async () => {
      const { writeMock } = setupClipboard();
      render(
        <CopyExportMenu
          source={NATIVE_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as HTML' }));
      await waitFor(() => expect(writeMock).toHaveBeenCalled());
      const items = writeMock.mock.calls[0]?.[0] as Array<{
        items: Record<string, Blob>;
      }>;
      const mimes = Object.keys(items[0]?.items ?? {});
      expect(mimes).toContain('text/html');
      expect(mimes).toContain('text/plain');
    });

    it('Copy as Markdown uses writeText with legacy markdown projection', async () => {
      const { writeTextMock } = setupClipboard();
      render(
        <CopyExportMenu
          source={MARKDOWN_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Copy as Markdown' }),
      );
      await waitFor(() =>
        expect(writeTextMock).toHaveBeenCalledWith(MARKDOWN_SRC.markdown),
      );
    });

    it('Copy as Markdown serializes native blocks', async () => {
      const { writeTextMock } = setupClipboard();
      render(
        <CopyExportMenu source={NATIVE_SRC} documentTitle="Native doc" />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Copy as Markdown' }),
      );
      await waitFor(() =>
        expect(writeTextMock).toHaveBeenCalledWith(
          expect.stringContaining('# Native heading'),
        ),
      );
      expect(writeTextMock.mock.calls[0]?.[0]).toContain('- Native item');
    });

    it('Copy as Plain strips markdown syntax', async () => {
      const { writeTextMock } = setupClipboard();
      render(
        <CopyExportMenu
          source={legacyContentExportProjection({
            format: 'markdown',
            markdown: '# Heading\n\n**bold**',
            html: null,
          })}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Copy as Plain text' }),
      );
      await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
      const text = writeTextMock.mock.calls[0]?.[0] as string;
      expect(text).toContain('Heading');
      expect(text).toContain('bold');
      expect(text).not.toContain('#');
      expect(text).not.toContain('**');
    });
  });

  describe('Export actions', () => {
    it('Export as .html triggers a synthetic anchor click with text/html blob', async () => {
      const { createSpy, clickSpy } = setupDownload();
      render(
        <CopyExportMenu
          source={HTML_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Export as .html' }),
      );
      await waitFor(() => expect(clickSpy).toHaveBeenCalled());
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/html/);
    });

    it('Export as .md triggers a download with text/markdown blob', async () => {
      const { createSpy } = setupDownload();
      render(
        <CopyExportMenu
          source={NATIVE_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export as .md' }));
      await waitFor(() => expect(createSpy).toHaveBeenCalled());
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/markdown/);
    });

    it('Export as .txt triggers a download with text/plain blob', async () => {
      const { createSpy } = setupDownload();
      render(
        <CopyExportMenu
          source={MARKDOWN_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export as .txt' }));
      await waitFor(() => expect(createSpy).toHaveBeenCalled());
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/plain/);
    });
  });

  describe('success microcopy', () => {
    it('replaces the menu item label with the success label, then reverts', async () => {
      vi.useFakeTimers();
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: vi.fn(), writeText: writeTextMock },
      });
      render(
        <CopyExportMenu
          source={MARKDOWN_SRC}
          documentTitle="My doc"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Copy as Markdown' }),
      );
      // Menu closes after action; let microtask queue drain for the
      // success-state setState.
      await act(async () => {
        await Promise.resolve();
      });
      // Re-open the menu — the success label is on the item now.
      fireEvent.click(screen.getByRole('button', { name: /Copy \/ Export/i }));
      expect(
        screen.getByRole('menuitem', { name: 'Copied ✓' }),
      ).toBeInTheDocument();
      // Wait past the success window — label reverts.
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(
        screen.queryByRole('menuitem', { name: 'Copied ✓' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('menuitem', { name: 'Copy as Markdown' }),
      ).toBeInTheDocument();
    });
  });
});
