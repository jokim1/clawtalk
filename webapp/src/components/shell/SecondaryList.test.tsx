import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { SecondaryList } from './SecondaryList';
import type {
  DocumentSidebarItem,
  TalkSidebarFolder,
  TalkSidebarItem,
} from '../../lib/api';

function buildFolder(): TalkSidebarFolder {
  return {
    type: 'folder',
    id: 'folder-created',
    title: 'Created Folder',
    sortOrder: 0,
    talks: [],
  };
}

function rect(input: Partial<DOMRect> = {}): DOMRect {
  return {
    x: input.left ?? 0,
    y: input.top ?? 0,
    top: input.top ?? 0,
    left: input.left ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect;
}

type Overrides = Partial<React.ComponentProps<typeof SecondaryList>>;

function renderList(props: Overrides = {}) {
  const base: React.ComponentProps<typeof SecondaryList> = {
    items: [],
    contents: [],
    loading: false,
    error: null,
    mainTalkId: null,
    onNewTalk: vi.fn(),
    onCreateFolder: vi.fn(async () => buildFolder()),
    onRenameTalk: vi.fn(),
    onPatchTalk: vi.fn(async () => undefined),
    onDeleteTalk: vi.fn(async () => undefined),
    onRenameFolder: vi.fn(async () => undefined),
    onDeleteFolder: vi.fn(async () => undefined),
    onReorder: vi.fn(),
    renameDraft: null,
    onOpenPalette: vi.fn(),
    onToggleSecondary: vi.fn(),
  };
  const merged = { ...base, ...props };
  render(
    <MemoryRouter>
      <SecondaryList {...merged} />
    </MemoryRouter>,
  );
  return merged;
}

describe('SecondaryList', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the talk count summary and an Archive link', () => {
    const items: TalkSidebarItem[] = [
      {
        type: 'talk',
        id: 'talk-1',
        title: 'D1 Retro',
        status: 'active',
        sortOrder: 0,
      },
      {
        type: 'folder',
        id: 'folder-1',
        title: 'Folder',
        sortOrder: 1,
        talks: [
          {
            type: 'talk',
            id: 'talk-2',
            title: 'Streaming one',
            status: 'active',
            sortOrder: 0,
            hasActiveRun: true,
          },
        ],
      },
    ];
    renderList({
      items: items.map((item) =>
        item.type === 'talk'
          ? { ...item, isResponding: false }
          : {
              ...item,
              talks: item.talks.map((t) => ({
                ...t,
                isResponding: !!t.hasActiveRun,
              })),
            },
      ),
    });

    expect(screen.getByText('2 active · 1 streaming')).toBeTruthy();
    const archive = screen.getByRole('link', { name: /Archive/ });
    expect(archive.getAttribute('href')).toBe('/app/archive');
  });

  it('opens the command palette from the search trigger', async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    renderList({ onOpenPalette });
    await user.click(screen.getByRole('button', { name: 'Search talks' }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('exposes the create menu under the preserved "Create talk or folder" label', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(
      screen.getByRole('button', { name: 'Create talk or folder' }),
    );
    expect(screen.getByRole('button', { name: 'New Talk' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy();
  });

  it('renders the row menu in a portal and repositions above the trigger when needed', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const element = this;
        if (element.getAttribute('aria-label') === 'Manage D1 Retro') {
          return rect({
            top: 560,
            bottom: 592,
            left: 230,
            right: 262,
            width: 32,
            height: 32,
          });
        }
        if (element.classList.contains('clawtalk-sidebar-menu-portal')) {
          return rect({
            top: 0,
            bottom: 180,
            left: 0,
            right: 170,
            width: 170,
            height: 180,
          });
        }
        return rect({ width: 100, height: 32, right: 100, bottom: 32 });
      },
    );

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 640,
    });

    renderList({
      items: [
        {
          type: 'talk',
          id: 'talk-1',
          title: 'D1 Retro',
          status: 'active',
          sortOrder: 0,
        },
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Manage D1 Retro' }));

    await waitFor(() => {
      const menu = document.body.querySelector('.clawtalk-sidebar-menu-portal');
      expect(menu).toBeTruthy();
      expect(menu).toHaveStyle({
        top: '374px',
        left: '92px',
        maxHeight: '542px',
      });
    });

    expect(screen.getByRole('button', { name: 'Rename Talk' })).toBeTruthy();
  });

  it('renders the Content section empty-state hint when no documents exist', () => {
    renderList({
      items: [
        {
          type: 'talk',
          id: 'talk-1',
          title: 'Untitled',
          status: 'active',
          sortOrder: 0,
        },
      ],
    });
    expect(screen.getByText('Content')).toBeTruthy();
    expect(
      screen.getByText('Promote a Talk to start creating documents.'),
    ).toBeTruthy();
  });

  it('renders Content rows linking to the owning thread with ?doc=1', () => {
    const contents: DocumentSidebarItem[] = [
      {
        id: 'content-1',
        talkId: 'talk-with-doc',
        title: 'Most recent doc',
        updatedAt: '2026-05-24T10:00:00.000Z',
      },
    ];
    renderList({
      items: [
        {
          type: 'talk',
          id: 'talk-with-doc',
          title: 'Talk with doc',
          status: 'active',
          sortOrder: 0,
          hasContent: true,
        },
      ],
      contents,
    });

    const docList = screen.getByLabelText('Content documents');
    const links = docList.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(
      '/app/talks/talk-with-doc?doc=1',
    );
    expect(screen.getByLabelText('Has document')).toBeTruthy();
  });
});
