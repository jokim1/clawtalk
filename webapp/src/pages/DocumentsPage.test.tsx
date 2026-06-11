import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { DocumentsPage } from './DocumentsPage';
import type { NativeDocumentSummary, TalkSidebarTree } from '../lib/api';
import * as api from '../lib/api';

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    getTalkSidebar: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

const SIDEBAR: TalkSidebarTree = {
  items: [
    {
      type: 'folder',
      id: 'f1',
      title: 'Q1 Launches',
      sortOrder: 0,
      talks: [
        {
          type: 'talk',
          id: 'talk-1',
          title: 'Pricing v2',
          status: 'active',
          sortOrder: 0,
        },
      ],
    },
  ],
  mainTalkId: null,
  contents: [],
};

function summary(
  overrides: Partial<NativeDocumentSummary> = {},
): NativeDocumentSummary {
  return {
    id: 'doc-1',
    workspaceId: 'ws-1',
    primaryTalkId: 'talk-1',
    folderId: null,
    title: 'Launch brief',
    format: 'markdown',
    wordCount: 240,
    lastEditAt: '2026-06-02T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    tabCount: 2,
    blockCount: 8,
    pendingEditCount: 0,
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <DocumentsPage />
    </MemoryRouter>,
  );
}

describe('DocumentsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApi.getTalkSidebar.mockResolvedValue(SIDEBAR);
  });
  afterEach(() => {
    cleanup();
  });

  it('lists documents as table rows with stats', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'a', title: 'Launch brief' }),
      summary({
        id: 'b',
        title: 'Research notes',
        wordCount: 100,
        primaryTalkId: null,
      }),
    ]);
    renderPage();
    expect(
      await screen.findByRole('link', { name: 'Launch brief' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Research notes' })).toBeTruthy();
    // Stats strip: total word count + document count.
    expect(screen.getByText('340')).toBeTruthy();
    expect(screen.getByText('1 linked · 1 loose')).toBeTruthy();
    // Words column renders per-row values.
    expect(screen.getByText('240')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
  });

  it('links each row to the native document viewer', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ id: 'doc-42' })]);
    renderPage();
    const link = await screen.findByRole('link', { name: 'Launch brief' });
    expect(link.getAttribute('href')).toBe('/app/documents/doc-42');
  });

  it('resolves linked-Talk titles and folders from the sidebar tree', async () => {
    mockApi.listDocuments.mockResolvedValue([summary()]);
    renderPage();
    expect(await screen.findByText('Pricing v2')).toBeTruthy();
    expect(screen.getByText('Q1 Launches')).toBeTruthy();
  });

  it('resolves a standalone doc folder from its own folderId', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ primaryTalkId: null, folderId: 'f1' }),
    ]);
    renderPage();
    expect(await screen.findByText('Q1 Launches')).toBeTruthy();
    expect(screen.queryByText('— Inbox')).toBeNull();
  });

  it('sorts a never-edited doc by its created/updated time', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({
        id: 'old',
        title: 'Old edited doc',
        lastEditAt: '2026-06-01T00:00:00.000Z',
      }),
      summary({
        id: 'fresh',
        title: 'Fresh empty doc',
        lastEditAt: null,
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
      }),
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Fresh empty doc' });
    const titles = screen
      .getAllByRole('link', { name: /doc$/ })
      .map((el) => el.textContent ?? '');
    // Default sort is activity desc; the fresh doc coalesces to updatedAt.
    expect(titles[0]).toBe('Fresh empty doc');
  });

  it('still renders when the sidebar enrichment fails', async () => {
    mockApi.getTalkSidebar.mockRejectedValue(new Error('sidebar down'));
    mockApi.listDocuments.mockResolvedValue([summary()]);
    renderPage();
    expect(
      await screen.findByRole('link', { name: 'Launch brief' }),
    ).toBeTruthy();
    expect(screen.getByText('Open Talk')).toBeTruthy();
    expect(screen.getByText('— Inbox')).toBeTruthy();
  });

  it('shows a pending-edit badge when edits await review', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ pendingEditCount: 3 })]);
    renderPage();
    expect(await screen.findByText('3 pending')).toBeTruthy();
  });

  it('filters rows by title', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'a', title: 'Launch brief' }),
      summary({ id: 'b', title: 'Research notes' }),
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Launch brief' });
    fireEvent.change(screen.getByLabelText('Filter documents'), {
      target: { value: 'research' },
    });
    expect(screen.queryByRole('link', { name: 'Launch brief' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Research notes' })).toBeTruthy();
    expect(screen.getByText(/1 of 2 shown/)).toBeTruthy();
  });

  it('sorts by words when the column header is toggled', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'a', title: 'Small doc', wordCount: 10 }),
      summary({ id: 'b', title: 'Big doc', wordCount: 900 }),
    ]);
    renderPage();
    await screen.findByRole('link', { name: 'Small doc' });
    fireEvent.click(screen.getByRole('button', { name: /Words/ }));
    const titles = screen
      .getAllByRole('link', { name: /doc$/ })
      .map((el) => el.textContent ?? '');
    expect(titles[0]).toBe('Big doc');
  });

  it('shows an empty state when there are no documents', async () => {
    mockApi.listDocuments.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No documents yet/)).toBeTruthy();
  });

  it('surfaces an error and retries', async () => {
    mockApi.listDocuments.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('boom')).toBeTruthy();

    mockApi.listDocuments.mockResolvedValueOnce([
      summary({ title: 'Recovered' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Recovered' })).toBeTruthy(),
    );
  });
});
