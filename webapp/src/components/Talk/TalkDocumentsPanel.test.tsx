import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TalkDocumentsPanel } from './TalkDocumentsPanel';
import { ApiError, UnauthorizedError } from '../../lib/api';
import type {
  NativeDocument,
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentSummary,
  NativeDocumentTab,
} from '../../lib/api';
import * as api from '../../lib/api';

vi.mock('../../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api')>();
  return {
    ...actual,
    listDocuments: vi.fn(),
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

function summary(
  o: Partial<NativeDocumentSummary> = {},
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
    tabCount: 1,
    blockCount: 1,
    pendingEditCount: 0,
    ...o,
  };
}

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
    ...summary(),
    tabs: [tab()],
    pendingEdits: [],
    ...o,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof TalkDocumentsPanel>> = {},
) {
  return render(
    <TalkDocumentsPanel
      talkId="talk-1"
      workspaceId="ws-1"
      canEditDoc={true}
      onUnauthorized={() => {}}
      {...props}
    />,
  );
}

describe('TalkDocumentsPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('shows a loading skeleton while documents load', () => {
    mockApi.listDocuments.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByLabelText('Loading documents')).toBeTruthy();
  });

  it('waits for the workspace to resolve before listing', async () => {
    mockApi.listDocuments.mockResolvedValue([summary()]);
    mockApi.getDocument.mockResolvedValue(makeDoc());

    const { rerender } = renderPanel({ workspaceId: null });
    expect(mockApi.listDocuments).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Loading documents')).toBeTruthy();

    rerender(
      <TalkDocumentsPanel
        talkId="talk-1"
        workspaceId="ws-1"
        canEditDoc={true}
        onUnauthorized={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockApi.listDocuments).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
      }),
    );
  });

  it('shows an empty state when no document is attached to the Talk', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'other', primaryTalkId: 'talk-99' }),
    ]);
    renderPanel();
    expect(
      await screen.findByText(/No document is attached to this Talk yet/),
    ).toBeTruthy();
    expect(mockApi.getDocument).not.toHaveBeenCalled();
  });

  it('resolves the primary document and renders its native blocks', async () => {
    mockApi.listDocuments.mockResolvedValue([summary()]);
    mockApi.getDocument.mockResolvedValue(makeDoc());
    renderPanel();

    expect(await screen.findByText('Launch brief')).toBeTruthy();
    expect(screen.getByText('Original paragraph.')).toBeTruthy();
    expect(mockApi.getDocument).toHaveBeenCalledWith({
      documentId: 'doc-1',
      workspaceId: 'ws-1',
    });
  });

  it('picks the document whose primaryTalkId matches this Talk', async () => {
    mockApi.listDocuments.mockResolvedValue([
      summary({ id: 'doc-other', primaryTalkId: 'talk-2' }),
      summary({ id: 'doc-mine', primaryTalkId: 'talk-1' }),
    ]);
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ id: 'doc-mine', primaryTalkId: 'talk-1' }),
    );
    renderPanel();

    await screen.findByText('Launch brief');
    expect(mockApi.getDocument).toHaveBeenCalledTimes(1);
    expect(mockApi.getDocument).toHaveBeenCalledWith({
      documentId: 'doc-mine',
      workspaceId: 'ws-1',
    });
  });

  it('shows the pending-edit review console and accepts an edit', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ pendingEditCount: 1 })]);
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptDocumentEdit.mockResolvedValue({
      editId: 'edit-1',
      runId: 'run-1',
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    renderPanel();

    await screen.findByText('Pending edits');
    expect(screen.getByText('Replace paragraph')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Accept replace paragraph' }),
    );

    await waitFor(() =>
      expect(mockApi.acceptDocumentEdit).toHaveBeenCalledWith({
        documentId: 'doc-1',
        editId: 'edit-1',
        workspaceId: 'ws-1',
      }),
    );
    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
  });

  it('gates review controls when the member cannot edit the doc', async () => {
    mockApi.listDocuments.mockResolvedValue([summary({ pendingEditCount: 1 })]);
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    renderPanel({ canEditDoc: false });

    // The document still renders read-only with a pending-count notice…
    expect(await screen.findByText('Original paragraph.')).toBeTruthy();
    expect(screen.getByText(/1 pending edit awaiting review/)).toBeTruthy();
    // …but no accept/reject affordances are offered.
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
  });

  it('surfaces a list error with a working retry', async () => {
    mockApi.listDocuments.mockRejectedValueOnce(new Error('network down'));
    renderPanel();

    expect(await screen.findByText('network down')).toBeTruthy();

    mockApi.listDocuments.mockResolvedValue([summary()]);
    mockApi.getDocument.mockResolvedValue(makeDoc());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Launch brief')).toBeTruthy();
  });

  it('calls onUnauthorized when listing is unauthorized', async () => {
    const onUnauthorized = vi.fn();
    mockApi.listDocuments.mockRejectedValue(new UnauthorizedError());
    renderPanel({ onUnauthorized });

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it('shows a removed-document notice when the detail 404s', async () => {
    mockApi.listDocuments.mockResolvedValue([summary()]);
    mockApi.getDocument.mockRejectedValue(
      new ApiError('gone', 404, 'document_not_found'),
    );
    renderPanel();

    expect(
      await screen.findByText(/This document is no longer available/),
    ).toBeTruthy();
  });
});
