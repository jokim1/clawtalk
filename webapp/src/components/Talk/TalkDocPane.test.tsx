import { createRef } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TalkDocPane } from './TalkDocPane';
import { ApiError, UnauthorizedError } from '../../lib/api';
import type {
  NativeDocument,
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentTab,
} from '../../lib/api';
import * as api from '../../lib/api';

vi.mock('../../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api')>();
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

function renderPane(
  props: Partial<React.ComponentProps<typeof TalkDocPane>> = {},
) {
  return render(
    <TalkDocPane
      documentId="doc-1"
      workspaceId="ws-1"
      canEditDoc={true}
      onUnauthorized={() => {}}
      reloadSignal={0}
      onHidePane={() => {}}
      docBodyRef={createRef<HTMLDivElement>()}
      {...props}
    />,
  );
}

describe('TalkDocPane', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the native document by id without the flat content facade', async () => {
    mockApi.getDocument.mockResolvedValue(makeDoc());
    renderPane();

    expect(await screen.findByText('Launch brief')).toBeTruthy();
    expect(screen.getByText('Original paragraph.')).toBeTruthy();
    expect(mockApi.getDocument).toHaveBeenCalledWith({
      documentId: 'doc-1',
      workspaceId: 'ws-1',
    });
  });

  it('renders a hide-pane button that invokes onHidePane', async () => {
    const onHidePane = vi.fn();
    mockApi.getDocument.mockResolvedValue(makeDoc());
    renderPane({ onHidePane });

    const hideBtn = await screen.findByRole('button', {
      name: /hide document pane/i,
    });
    fireEvent.click(hideBtn);
    expect(onHidePane).toHaveBeenCalledTimes(1);
  });

  it('shows the pending-edit review console and accepts an edit', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    mockApi.acceptDocumentEdit.mockResolvedValue({
      editId: 'edit-1',
      runId: 'run-1',
      document: makeDoc({ pendingEditCount: 0, pendingEdits: [] }),
    });
    renderPane();

    await screen.findByText('Pending edits');
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

  it('renders read-only with a pending notice and no review controls when canEditDoc is false', async () => {
    mockApi.getDocument.mockResolvedValue(
      makeDoc({ pendingEditCount: 1, pendingEdits: [edit()] }),
    );
    renderPane({ canEditDoc: false });

    expect(await screen.findByText('Proposed replacement.')).toBeTruthy();
    expect(screen.getByText('Strategist · pending')).toBeTruthy();
    expect(screen.getByText(/1 pending edit awaiting review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
  });

  it('shows the empty pending-edits state when none are proposed', async () => {
    mockApi.getDocument.mockResolvedValue(makeDoc());
    renderPane();

    expect(await screen.findByText(/No pending edits/)).toBeTruthy();
  });

  it('reloads quietly when the reloadSignal bumps (live agent-edit bridge)', async () => {
    mockApi.getDocument.mockResolvedValue(makeDoc());
    // Stable handlers/refs so only `reloadSignal` changes between renders —
    // isolating the bridge from incidental load() identity churn.
    const onUnauthorized = vi.fn();
    const docBodyRef = createRef<HTMLDivElement>();
    const onHidePane = vi.fn();
    const paneAt = (signal: number) => (
      <TalkDocPane
        documentId="doc-1"
        workspaceId="ws-1"
        canEditDoc={true}
        onUnauthorized={onUnauthorized}
        reloadSignal={signal}
        onHidePane={onHidePane}
        docBodyRef={docBodyRef}
      />
    );

    const { rerender } = render(paneAt(0));

    await screen.findByText('Launch brief');
    expect(mockApi.getDocument).toHaveBeenCalledTimes(1);

    // A content-edit stream event bumps the signal → quiet native refetch,
    // without a loading flash (the document text stays mounted).
    rerender(paneAt(1));

    await waitFor(() => expect(mockApi.getDocument).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Launch brief')).toBeTruthy();
  });

  it('shows a removed-document notice when the document 404s', async () => {
    mockApi.getDocument.mockRejectedValue(
      new ApiError('gone', 404, 'document_not_found'),
    );
    renderPane();

    expect(
      await screen.findByText(/This document is no longer available/),
    ).toBeTruthy();
  });

  it('forwards an unauthorized load to onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    mockApi.getDocument.mockRejectedValue(new UnauthorizedError());
    renderPane({ onUnauthorized });

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
