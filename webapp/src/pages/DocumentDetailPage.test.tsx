import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DocumentDetailPage } from './DocumentDetailPage';
import { ApiError } from '../lib/api';
import type {
  NativeDocument,
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentTab,
} from '../lib/api';
import * as api from '../lib/api';

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return {
    ...actual,
    getDocument: vi.fn(),
    acceptDocumentEdit: vi.fn(),
    rejectDocumentEdit: vi.fn(),
    acceptDocumentEditRun: vi.fn(),
    rejectDocumentEditRun: vi.fn(),
    acceptAllDocumentEdits: vi.fn(),
    rejectAllDocumentEdits: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

function block(o: Partial<NativeDocumentBlock> = {}): NativeDocumentBlock {
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
    ...o,
  };
}

function tab(o: Partial<NativeDocumentTab> = {}): NativeDocumentTab {
  return {
    id: 'tab-1',
    documentId: 'doc-1',
    title: 'Main',
    sortOrder: 0,
    listVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    blocks: [block()],
    ...o,
  };
}

function edit(o: Partial<NativeDocumentEdit> = {}): NativeDocumentEdit {
  return {
    id: 'edit-1',
    documentId: 'doc-1',
    tabId: 'tab-1',
    blockId: 'block-1',
    baseBlockVersion: 1,
    baseListVersion: null,
    afterBlockId: null,
    proposedByAgentId: 'agent-1',
    proposedByAgentName: 'Strategist',
    proposedByRunId: 'run-1',
    op: 'replace',
    newKind: null,
    newText: 'Proposed replacement.',
    newAttrs: null,
    status: 'pending',
    source: 'agent',
    createdAt: '2026-06-02T00:00:00.000Z',
    resolvedAt: null,
    ...o,
  };
}

function makeDoc(o: Partial<NativeDocument> = {}): NativeDocument {
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
    tabCount: 1,
    blockCount: 1,
    pendingEditCount: 0,
    tabs: [tab()],
    pendingEdits: [],
    ...o,
  };
}

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={['/app/documents/doc-1']}>
      <Routes>
        <Route
          path="/app/documents/:documentId"
          element={<DocumentDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders native tabs and blocks, and switches tabs', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({
        tabCount: 2,
        tabs: [
          tab({ id: 'tab-1', title: 'Main', blocks: [block()] }),
          tab({
            id: 'tab-2',
            title: 'Research',
            blocks: [
              block({
                id: 'block-2',
                tabId: 'tab-2',
                kind: 'h2',
                text: 'Research notes',
              }),
            ],
          }),
        ],
      }),
    );
    renderDetail();

    expect(await screen.findByText('Original paragraph.')).toBeTruthy();
    expect(screen.queryByText('Research notes')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Research' }));
    expect(await screen.findByText('Research notes')).toBeTruthy();
    expect(screen.queryByText('Original paragraph.')).toBeNull();
  });

  it('shows a pending edit in the review panel', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    renderDetail();

    expect(await screen.findByText('Pending edits')).toBeTruthy();
    expect(screen.getByText('Replace paragraph')).toBeTruthy();
    expect(screen.getByText('Proposed replacement.')).toBeTruthy();
    expect(screen.getByText('Strategist')).toBeTruthy();
  });

  it('accepts a pending edit: applies the returned bumped document and clears the panel', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptDocumentEdit.mockResolvedValue({
      editId: 'edit-1',
      runId: 'run-1',
      document: makeDoc({
        pendingEditCount: 0,
        pendingEdits: [],
        tabs: [
          tab({
            listVersion: 2,
            blocks: [block({ version: 2, text: 'Proposed replacement.' })],
          }),
        ],
      }),
    });
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(
      screen.getByRole('button', { name: 'Accept replace paragraph' }),
    );

    await waitFor(() =>
      expect(mockApi.acceptDocumentEdit).toHaveBeenCalledWith({
        documentId: 'doc-1',
        editId: 'edit-1',
      }),
    );
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
    expect(screen.getByText('Proposed replacement.')).toBeTruthy();
  });

  it('rejects a pending edit: clears the edit, leaves the block unchanged', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.rejectDocumentEdit.mockResolvedValue({
      editId: 'edit-1',
      runId: 'run-1',
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(
      screen.getByRole('button', { name: 'Reject replace paragraph' }),
    );

    await waitFor(() =>
      expect(mockApi.rejectDocumentEdit).toHaveBeenCalledWith({
        documentId: 'doc-1',
        editId: 'edit-1',
      }),
    );
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
    expect(screen.getByText('Original paragraph.')).toBeTruthy();
  });

  it('handles a version conflict: refetches, notifies, and keeps the edit pending', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptDocumentEdit.mockRejectedValue(
      new ApiError('stale', 409, 'version_conflict'),
    );
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(
      screen.getByRole('button', { name: 'Accept replace paragraph' }),
    );

    expect(
      await screen.findByText(/changed while you were reviewing/),
    ).toBeTruthy();
    // Quiet refetch ran (initial load + conflict refetch).
    await waitFor(() => expect(mockApi.getDocument).toHaveBeenCalledTimes(2));
    // The conflicting edit is still pending for re-review.
    expect(screen.getByText('Replace paragraph')).toBeTruthy();
  });

  it('shows a not-found state on 404', async () => {
    mockApi.getDocument.mockRejectedValue(
      new ApiError('gone', 404, 'document_not_found'),
    );
    renderDetail();
    expect(await screen.findByText('Document not found')).toBeTruthy();
  });

  it('accepts all pending edits in one action', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptAllDocumentEdits.mockResolvedValue({
      editIds: ['edit-1'],
      runId: 'run-1',
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));

    await waitFor(() =>
      expect(mockApi.acceptAllDocumentEdits).toHaveBeenCalledWith({
        documentId: 'doc-1',
        reviewedEditIds: ['edit-1'],
      }),
    );
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
  });

  it('distinguishes a non-recoverable 409 (anchor_missing) from a version conflict', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptDocumentEdit.mockRejectedValue(
      new ApiError('anchor gone', 409, 'anchor_missing'),
    );
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(
      screen.getByRole('button', { name: 'Accept replace paragraph' }),
    );

    expect(await screen.findByText(/no longer fits/)).toBeTruthy();
    expect(screen.queryByText(/changed while you were reviewing/)).toBeNull();
    // Still pending so the reviewer can reject it.
    expect(screen.getByText('Replace paragraph')).toBeTruthy();
  });

  it('moves the active tab with the keyboard and wires the tabpanel', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({
        tabCount: 2,
        tabs: [
          tab({ id: 'tab-1', title: 'Main', blocks: [block()] }),
          tab({
            id: 'tab-2',
            title: 'Research',
            blocks: [
              block({
                id: 'block-2',
                tabId: 'tab-2',
                kind: 'h2',
                text: 'Research notes',
              }),
            ],
          }),
        ],
      }),
    );
    renderDetail();

    const mainTab = await screen.findByRole('tab', { name: 'Main' });
    expect(mainTab.getAttribute('aria-selected')).toBe('true');
    // The panel is labelled by the active tab.
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(mainTab.id);

    fireEvent.keyDown(mainTab, { key: 'ArrowRight' });

    const researchTab = await screen.findByRole('tab', { name: 'Research' });
    expect(researchTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Research notes')).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      researchTab.id,
    );
  });

  it('serializes panel actions: locks the panel while an accept is in flight', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    let resolveAccept: (value: {
      editId: string;
      runId: string;
      document: NativeDocument;
    }) => void = () => {};
    mockApi.acceptDocumentEdit.mockReturnValue(
      new Promise((resolve) => {
        resolveAccept = resolve;
      }),
    );
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(
      screen.getByRole('button', { name: 'Accept replace paragraph' }),
    );

    // One action in flight => Accept all (and every other control) is locked.
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Accept all',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );

    resolveAccept({
      editId: 'edit-1',
      runId: 'run-1',
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
  });

  it('per-run accept sends exactly the run-group edit ids it rendered', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({
        pendingEditCount: 2,
        pendingEdits: [
          edit({ id: 'edit-1' }),
          edit({ id: 'edit-2', newText: 'Second change.' }),
        ],
      }),
    );
    mockApi.acceptDocumentEditRun.mockResolvedValue({
      runId: 'run-1',
      editIds: ['edit-1', 'edit-2'],
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(screen.getByRole('button', { name: 'Accept run' }));

    await waitFor(() =>
      expect(mockApi.acceptDocumentEditRun).toHaveBeenCalledWith({
        documentId: 'doc-1',
        runId: 'run-1',
        reviewedEditIds: ['edit-1', 'edit-2'],
      }),
    );
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
  });

  it('recovers from a bulk edit_set_mismatch: refreshes, notifies, and surfaces the unseen edit', async () => {
    mockApi.getDocument
      .mockResolvedValueOnce(
        makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
      )
      .mockResolvedValueOnce(
        makeDoc({
          pendingEditCount: 2,
          pendingEdits: [
            edit(),
            edit({
              id: 'edit-2',
              proposedByRunId: 'run-2',
              newText: 'A second proposal you had not seen.',
            }),
          ],
        }),
      );
    mockApi.acceptAllDocumentEdits.mockRejectedValue(
      new ApiError('mismatch', 409, 'edit_set_mismatch'),
    );
    renderDetail();
    await screen.findByText('Pending edits');

    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));

    // Recoverable: a notice appears, the list is refetched, and the previously
    // unseen edit is now on screen for re-review — nothing was applied.
    expect(await screen.findByText(/New edits arrived/)).toBeTruthy();
    await waitFor(() => expect(mockApi.getDocument).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('A second proposal you had not seen.'),
    ).toBeTruthy();
    expect(screen.getByText('Proposed replacement.')).toBeTruthy();
  });
});
