import { describe, expect, it } from 'vitest';

import type {
  NativeDocument,
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentSummary,
} from '../../lib/api';
import {
  BLOCK_KIND_LABEL,
  documentSummaryMeta,
  formatDocDate,
  findBlockById,
  groupPendingEditsByRun,
  insertAnchorLabel,
  pendingEditCountForBlock,
  previewEdit,
  tabTitleForEdit,
} from './documentsFormat';

function block(
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

function edit(overrides: Partial<NativeDocumentEdit> = {}): NativeDocumentEdit {
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
    ...overrides,
  };
}

function doc(overrides: Partial<NativeDocument> = {}): NativeDocument {
  const summary: NativeDocumentSummary = {
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
    pendingEditCount: 1,
  };
  return {
    ...summary,
    tabs: [
      {
        id: 'tab-1',
        documentId: 'doc-1',
        title: 'Main',
        sortOrder: 0,
        listVersion: 1,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        blocks: [block()],
      },
    ],
    pendingEdits: [edit()],
    ...overrides,
  };
}

describe('formatDocDate', () => {
  it('formats an ISO date', () => {
    expect(formatDocDate('2026-06-02T00:00:00.000Z')).toMatch(/2026/);
  });
  it('returns empty for null or unparseable input', () => {
    expect(formatDocDate(null)).toBe('');
    expect(formatDocDate('not-a-date')).toBe('');
  });
});

describe('documentSummaryMeta', () => {
  it('pluralizes counts', () => {
    expect(
      documentSummaryMeta({
        ...doc(),
        tabCount: 1,
        blockCount: 2,
        wordCount: 1,
      } as NativeDocumentSummary),
    ).toBe('1 tab · 2 blocks · 1 word');
  });
});

describe('findBlockById / tabTitleForEdit', () => {
  it('finds a block across tabs and resolves the tab title', () => {
    const d = doc();
    expect(findBlockById(d, 'block-1')?.text).toBe('Original paragraph.');
    expect(findBlockById(d, 'missing')).toBeNull();
    expect(findBlockById(d, null)).toBeNull();
    expect(tabTitleForEdit(d, edit())).toBe('Main');
    expect(tabTitleForEdit(d, edit({ tabId: 'ghost' }))).toBe('Untitled tab');
  });
});

describe('previewEdit', () => {
  it('shows before+after for a replace', () => {
    const preview = previewEdit(doc(), edit());
    expect(preview.title).toBe('Replace paragraph');
    expect(preview.beforeText).toBe('Original paragraph.');
    expect(preview.afterText).toBe('Proposed replacement.');
  });
  it('shows only after for an insert (no target block)', () => {
    const preview = previewEdit(
      doc(),
      edit({
        op: 'insert',
        blockId: null,
        newKind: 'h2',
        newText: 'New section',
      }),
    );
    expect(preview.title).toBe('Insert heading 2');
    expect(preview.beforeText).toBeNull();
    expect(preview.afterText).toBe('New section');
  });
  it('shows only before for a delete', () => {
    const preview = previewEdit(doc(), edit({ op: 'delete', newText: null }));
    expect(preview.title).toBe('Delete paragraph');
    expect(preview.beforeText).toBe('Original paragraph.');
    expect(preview.afterText).toBeNull();
  });
});

describe('groupPendingEditsByRun', () => {
  it('groups edits sharing a run and keeps standalone edits separate', () => {
    const groups = groupPendingEditsByRun([
      edit({ id: 'a', proposedByRunId: 'run-1' }),
      edit({ id: 'b', proposedByRunId: 'run-1' }),
      edit({ id: 'c', proposedByRunId: null, proposedByAgentName: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      runId: 'run-1',
      agentName: 'Strategist',
    });
    expect(groups[0].edits.map((e) => e.id)).toEqual(['a', 'b']);
    expect(groups[1]).toMatchObject({ runId: null, agentName: 'An agent' });
    expect(groups[1].edits.map((e) => e.id)).toEqual(['c']);
  });
});

describe('insertAnchorLabel', () => {
  it('returns null for non-insert ops', () => {
    expect(insertAnchorLabel(doc(), edit({ op: 'replace' }))).toBeNull();
    expect(insertAnchorLabel(doc(), edit({ op: 'delete' }))).toBeNull();
  });
  it('labels a top insert and an anchored insert', () => {
    expect(
      insertAnchorLabel(doc(), edit({ op: 'insert', afterBlockId: null })),
    ).toBe('Insert at the top');
    expect(
      insertAnchorLabel(doc(), edit({ op: 'insert', afterBlockId: 'block-1' })),
    ).toBe('Insert after: Original paragraph.');
  });
  it('flags an insert whose anchor block is gone', () => {
    expect(
      insertAnchorLabel(doc(), edit({ op: 'insert', afterBlockId: 'ghost' })),
    ).toBe('Insert after a removed block');
  });
});

describe('pendingEditCountForBlock', () => {
  it('counts pending edits targeting a block', () => {
    const d = doc({
      pendingEdits: [
        edit({ id: 'a', blockId: 'block-1' }),
        edit({ id: 'b', blockId: 'block-1' }),
        edit({ id: 'c', blockId: 'block-2' }),
      ],
    });
    expect(pendingEditCountForBlock(d, 'block-1')).toBe(2);
    expect(pendingEditCountForBlock(d, 'block-9')).toBe(0);
  });
});

describe('BLOCK_KIND_LABEL', () => {
  it('covers every native block kind', () => {
    expect(Object.keys(BLOCK_KIND_LABEL).sort()).toEqual([
      'code',
      'h1',
      'h2',
      'li',
      'meta',
      'p',
    ]);
  });
});
