import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SourceMentionPicker,
  buildSourceMentionOptions,
  type SourceMentionOption,
} from './SourceMentionPicker';
import { getSourceDisplayRef } from './sourceDisplay';
import type { ContextSource } from '../lib/api';

afterEach(() => cleanup());

function makeSource(
  input: Partial<ContextSource> & { id: string },
): ContextSource {
  return {
    id: input.id,
    sourceRef: input.sourceRef ?? 'S1',
    sourceType: input.sourceType ?? 'text',
    title: input.title ?? 'Test source',
    note: input.note ?? null,
    sourceUrl: input.sourceUrl ?? null,
    fileName: input.fileName ?? null,
    fileSize: input.fileSize ?? null,
    status: input.status ?? 'ready',
    extractedTextLength: input.extractedTextLength ?? 120,
    extractedAt: input.extractedAt ?? '2026-05-26T00:00:00Z',
    isTruncated: input.isTruncated ?? false,
    extractionError: input.extractionError ?? null,
    mimeType: input.mimeType ?? null,
    lastFetchedAt: input.lastFetchedAt ?? null,
    fetchStrategy: input.fetchStrategy ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: '2026-05-26T00:00:00Z',
    updatedAt: '2026-05-26T00:00:00Z',
    expectedPageCount: input.expectedPageCount ?? null,
    pageImageCount: input.pageImageCount ?? 0,
    pageSetComplete: input.pageSetComplete ?? false,
  };
}

describe('buildSourceMentionOptions', () => {
  it('returns @doc option first when a content title is provided and filter matches', () => {
    const options = buildSourceMentionOptions({
      sources: [],
      filter: '',
      contentTitle: 'My doc',
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ kind: 'doc', insertion: '@doc ' });
  });

  it('omits @doc when there is no attached content', () => {
    const options = buildSourceMentionOptions({
      sources: [makeSource({ id: 's1' })],
      filter: '',
      contentTitle: null,
    });
    expect(options.every((o) => o.kind === 'source')).toBe(true);
  });

  it('inserts slug-form when slug is unique within the Talk', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({
          id: 's1',
          sourceRef: 'S1',
          title: 'Design Notes',
        }),
      ],
      filter: '',
      contentTitle: null,
    });
    const source = options.find((o) => o.kind === 'source');
    expect(source?.insertion).toBe('@design-notes ');
  });

  it('falls back to ref-form when two sources share a slug', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({
          id: 's1',
          sourceRef: 'S1',
          title: 'Notes',
        }),
        makeSource({
          id: 's2',
          sourceRef: 'S2',
          title: 'NOTES',
        }),
      ],
      filter: '',
      contentTitle: null,
    });
    const inserts = options
      .filter((o) => o.kind === 'source')
      .map((o) => o.insertion);
    expect(inserts.every((s) => s.startsWith('@S'))).toBe(true);
  });

  it('skips sources whose status is not ready', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({ id: 's1', sourceRef: 'S1', status: 'pending' }),
        makeSource({ id: 's2', sourceRef: 'S2', status: 'failed' }),
      ],
      filter: '',
      contentTitle: null,
    });
    expect(options.filter((o) => o.kind === 'source')).toHaveLength(0);
  });

  it('filters by typed substring against title, slug, ref, and note', () => {
    const sources = [
      makeSource({
        id: 's1',
        sourceRef: 'S1',
        title: 'Design Notes',
        note: 'roadmap',
      }),
      makeSource({
        id: 's2',
        sourceRef: 'S2',
        title: 'Investor memo',
        note: null,
      }),
    ];

    // Filter on title fragment
    const byTitle = buildSourceMentionOptions({
      sources,
      filter: 'design',
      contentTitle: null,
    });
    expect(byTitle).toHaveLength(1);

    // Filter on note text
    const byNote = buildSourceMentionOptions({
      sources,
      filter: 'roadmap',
      contentTitle: null,
    });
    expect(byNote).toHaveLength(1);

    // Filter on ref
    const byRef = buildSourceMentionOptions({
      sources,
      filter: 's2',
      contentTitle: null,
    });
    expect(byRef.find((o) => o.kind === 'source')?.source.id).toBe('s2');
  });

  it('filters raw UUID-backed sources by their human-readable display label', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({
          id: '0c111111-2222-4333-8444-555555555555',
          sourceRef: '0c111111-2222-4333-8444-555555555555',
          title: 'Investor memo',
          sortOrder: 0,
        }),
      ],
      filter: 'source',
      contentTitle: null,
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      kind: 'source',
      source: { id: '0c111111-2222-4333-8444-555555555555' },
    });
  });

  it('labels raw UUID-backed sources by full source-list order so panel and picker match', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({
          id: 'pending',
          sourceRef: '0c000000-2222-4333-8444-555555555555',
          title: 'Pending source',
          status: 'pending',
          sortOrder: 0,
        }),
        makeSource({
          id: '0c111111-2222-4333-8444-555555555555',
          sourceRef: '0c111111-2222-4333-8444-555555555555',
          title: 'Investor memo',
          sortOrder: 5,
        }),
      ],
      filter: '',
      contentTitle: null,
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      kind: 'source',
      displayRef: 'Source 2',
    });
  });

  it('does not offer @doc when filter excludes it', () => {
    const options = buildSourceMentionOptions({
      sources: [],
      filter: 'xyz',
      contentTitle: 'My Doc',
    });
    expect(options).toHaveLength(0);
  });

  it('matches @doc when typed filter starts with "doc"', () => {
    const options = buildSourceMentionOptions({
      sources: [],
      filter: 'do',
      contentTitle: 'My Doc',
    });
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].kind).toBe('doc');
  });
});

describe('SourceMentionPicker', () => {
  function makeDocOption(): SourceMentionOption {
    return { kind: 'doc', insertion: '@doc ', title: 'My Doc' };
  }
  function makeSourceOption(
    overrides?: Partial<ContextSource> & { id?: string },
  ): SourceMentionOption {
    const source = makeSource({
      id: overrides?.id ?? 's1',
      title: overrides?.title ?? 'Design Notes',
      sourceRef: overrides?.sourceRef ?? 'S1',
      sortOrder: overrides?.sortOrder,
    });
    return {
      kind: 'source',
      insertion: '@design-notes ',
      source,
      displayRef: getSourceDisplayRef(source, 0),
    };
  }

  it('renders option titles and refs', () => {
    render(
      <SourceMentionPicker
        options={[makeDocOption(), makeSourceOption()]}
        selectedIndex={0}
        onSelect={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('My Doc')).toBeInTheDocument();
    expect(screen.getByText('@doc')).toBeInTheDocument();
    expect(screen.getByText('Design Notes')).toBeInTheDocument();
    expect(screen.getByText('S1')).toBeInTheDocument();
  });

  it('renders raw UUID source refs as human-readable labels', () => {
    render(
      <SourceMentionPicker
        options={[
          makeSourceOption({
            id: '0c111111-2222-4333-8444-555555555555',
            sourceRef: '0c111111-2222-4333-8444-555555555555',
            title: 'Investor memo',
            sortOrder: 0,
          }),
        ]}
        selectedIndex={0}
        onSelect={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(
      screen.queryByText('0c111111-2222-4333-8444-555555555555'),
    ).not.toBeInTheDocument();
  });

  it('keeps raw UUID insertion for ambiguous source slugs while displaying a readable label', () => {
    const options = buildSourceMentionOptions({
      sources: [
        makeSource({
          id: '0c111111-2222-4333-8444-555555555555',
          sourceRef: '0c111111-2222-4333-8444-555555555555',
          title: 'Notes',
          sortOrder: 0,
        }),
        makeSource({
          id: '0c222222-2222-4333-8444-555555555555',
          sourceRef: '0c222222-2222-4333-8444-555555555555',
          title: 'NOTES',
          sortOrder: 1,
        }),
      ],
      filter: '',
      contentTitle: null,
    });
    const firstSource = options.find(
      (option): option is SourceMentionOption & { kind: 'source' } =>
        option.kind === 'source' &&
        option.source.id === '0c111111-2222-4333-8444-555555555555',
    );

    expect(firstSource?.insertion).toBe(
      '@0c111111-2222-4333-8444-555555555555 ',
    );

    render(
      <SourceMentionPicker
        options={options}
        selectedIndex={0}
        onSelect={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
    expect(
      screen.queryByText('0c111111-2222-4333-8444-555555555555'),
    ).not.toBeInTheDocument();
  });

  it('marks the selectedIndex option with aria-selected', () => {
    render(
      <SourceMentionPicker
        options={[makeDocOption(), makeSourceOption()]}
        selectedIndex={1}
        onSelect={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('fires onSelect with the clicked option', () => {
    const onSelect = vi.fn();
    const sourceOption = makeSourceOption();
    render(
      <SourceMentionPicker
        options={[makeDocOption(), sourceOption]}
        selectedIndex={0}
        onSelect={onSelect}
        onDismiss={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText('Design Notes'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(sourceOption);
  });

  it('renders empty state when there are no options', () => {
    render(
      <SourceMentionPicker
        options={[]}
        selectedIndex={0}
        onSelect={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('No matching sources.')).toBeInTheDocument();
  });

  it('fires onDismiss when the user clicks outside the popover', () => {
    const onDismiss = vi.fn();
    render(
      <div>
        <SourceMentionPicker
          options={[makeDocOption()]}
          selectedIndex={0}
          onSelect={() => undefined}
          onDismiss={onDismiss}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
