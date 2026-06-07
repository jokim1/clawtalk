import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { TalkListPage, formatLastActive, talkMetaLabel } from './TalkListPage';
import type { TalkSidebarItem } from '../lib/api';

describe('TalkListPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows empty-state guidance when the sidebar tree has no talks', () => {
    renderWithRouter([]);

    expect(
      screen.getByText('No talks yet. Create one from the sidebar.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        (content) =>
          content.includes('Use the blue') &&
          content.includes('button in the sidebar'),
      ),
    ).toBeTruthy();
  });

  it('renders talks from both top level and folders', async () => {
    renderWithRouter([
      {
        type: 'talk',
        id: 'talk-1',
        title: 'Smoke Talk',
        status: 'active',
        sortOrder: 0,
      },
      {
        type: 'folder',
        id: 'folder-1',
        title: 'Research',
        sortOrder: 1,
        talks: [
          {
            type: 'talk',
            id: 'talk-2',
            title: 'Nested Talk',
            status: 'active',
            sortOrder: 0,
          },
        ],
      },
    ]);

    expect(
      await screen.findByRole('link', { name: /Smoke Talk/i }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /Nested Talk/i })).toBeTruthy();
  });

  it('surfaces a streaming indicator for talks with an active run', () => {
    renderWithRouter([
      {
        type: 'talk',
        id: 'talk-live',
        title: 'Live Talk',
        status: 'active',
        sortOrder: 0,
        hasActiveRun: true,
      },
    ]);

    // RunPill renders the "running" status label.
    expect(screen.getByText('Streaming')).toBeTruthy();
  });

  it('renders the metadata line from message count and last activity', () => {
    renderWithRouter([
      {
        type: 'talk',
        id: 'talk-meta',
        title: 'Busy Talk',
        status: 'active',
        sortOrder: 0,
        messageCount: 4,
      },
    ]);

    expect(screen.getByText('4 messages')).toBeTruthy();
  });

  it('exposes the attached-document state to assistive tech (not icon-only)', () => {
    renderWithRouter([
      {
        type: 'talk',
        id: 'talk-doc',
        title: 'Doc Talk',
        status: 'active',
        sortOrder: 0,
        hasContent: true,
      },
    ]);

    expect(screen.getByRole('img', { name: 'Has a document' })).toBeTruthy();
  });

  it('renders a loading state and hides the empty-state copy while loading', () => {
    render(
      <MemoryRouter>
        <TalkListPage
          externalData={{ items: [], loading: true, error: null }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Loading talks')).toBeTruthy();
    expect(
      screen.queryByText('No talks yet. Create one from the sidebar.'),
    ).toBeNull();
  });

  it('renders the error state', () => {
    render(
      <MemoryRouter>
        <TalkListPage
          externalData={{
            items: [],
            loading: false,
            error: 'Talks are unavailable.',
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Talks are unavailable.')).toBeTruthy();
    expect(
      screen.queryByText('No talks yet. Create one from the sidebar.'),
    ).toBeNull();
  });
});

describe('talkMetaLabel', () => {
  const NOW = Date.parse('2026-06-07T12:00:00Z');

  it('joins message count and relative last-active with a middot', () => {
    expect(
      talkMetaLabel(
        {
          type: 'talk',
          id: 'x',
          title: 'X',
          status: 'active',
          sortOrder: 0,
          messageCount: 12,
          lastMessageAt: '2026-06-07T10:00:00Z',
        },
        NOW,
      ),
    ).toBe('12 messages · 2h ago');
  });

  it('singularizes a single message and omits unknown fields', () => {
    expect(
      talkMetaLabel(
        {
          type: 'talk',
          id: 'x',
          title: 'X',
          status: 'active',
          sortOrder: 0,
          messageCount: 1,
        },
        NOW,
      ),
    ).toBe('1 message');
    expect(
      talkMetaLabel(
        { type: 'talk', id: 'x', title: 'X', status: 'active', sortOrder: 0 },
        NOW,
      ),
    ).toBe('');
  });
});

describe('formatLastActive', () => {
  const NOW = Date.parse('2026-06-07T12:00:00Z');

  it('buckets recent timestamps', () => {
    expect(formatLastActive('2026-06-07T11:59:30Z', NOW)).toBe('just now');
    expect(formatLastActive('2026-06-07T11:30:00Z', NOW)).toBe('30m ago');
    expect(formatLastActive('2026-06-07T09:00:00Z', NOW)).toBe('3h ago');
    expect(formatLastActive('2026-06-04T12:00:00Z', NOW)).toBe('3d ago');
  });

  it('falls back to an absolute date beyond a week', () => {
    expect(formatLastActive('2026-05-01T12:00:00Z', NOW)).toMatch(/May/);
  });

  it('returns empty for missing or invalid input', () => {
    expect(formatLastActive(null, NOW)).toBe('');
    expect(formatLastActive(undefined, NOW)).toBe('');
    expect(formatLastActive('not-a-date', NOW)).toBe('');
  });
});

function renderWithRouter(items: TalkSidebarItem[]): void {
  render(
    <MemoryRouter>
      <TalkListPage externalData={{ items, loading: false, error: null }} />
    </MemoryRouter>,
  );
}
