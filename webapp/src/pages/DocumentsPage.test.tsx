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
import type { NativeDocumentSummary } from '../lib/api';
import * as api from '../lib/api';

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return {
    ...actual,
    listDocuments: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

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
  });
  afterEach(() => {
    cleanup();
  });

  it('lists documents with their meta', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'a', title: 'Launch brief' }),
      summary({ id: 'b', title: 'Research notes', tabCount: 1, blockCount: 3 }),
    ]);
    renderPage();
    expect(await screen.findByText('Launch brief')).toBeTruthy();
    expect(screen.getByText('Research notes')).toBeTruthy();
    expect(screen.getByText(/2 tabs · 8 blocks · 240 words/)).toBeTruthy();
  });

  it('links each row to the native document viewer', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ id: 'doc-42' })]);
    renderPage();
    const link = await screen.findByText('Launch brief');
    expect(link.closest('a')?.getAttribute('href')).toBe(
      '/app/documents/doc-42',
    );
  });

  it('shows a pending-edit badge when edits await review', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ pendingEditCount: 3 })]);
    renderPage();
    expect(await screen.findByText('3 pending')).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText('Recovered')).toBeTruthy());
  });
});
