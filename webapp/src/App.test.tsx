import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

describe('App', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows sign-in and hides dev quick login when dev mode is disabled', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawTalk' });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Developer Quick Login' }),
      ).toBeNull(),
    );
  });

  it('shows dev quick login when dev mode is enabled', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: true },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawTalk' });
    await screen.findByRole('heading', { name: 'Developer Quick Login' });
  });

  it('renders talks list when session is authenticated', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.getByRole('img', { name: 'ClawTalk' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search talks' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Toggle talk list' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    // The Salon Talks page renders its header eagerly (across loading/empty/list
    // states), so wait for the async sidebar fetch to resolve before asserting
    // the talk appears in both the sidebar tree and the main list.
    await waitFor(() =>
      expect(
        screen.getAllByRole('link', { name: /Family Planning/i }),
      ).toHaveLength(2),
    );
  });

  it('collapses and re-expands the talk-list column from the rail', async () => {
    const user = userEvent.setup();
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    const toggle = await screen.findByRole('button', {
      name: 'Toggle talk list',
    });
    const shell = document.querySelector('.ct-shell');
    // Starts expanded; the rail (and its Home nav) is always present.
    expect(shell).toHaveAttribute('data-secondary-collapsed', 'false');
    expect(screen.getByRole('button', { name: 'Search talks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();

    // jsdom has no matchMedia, so the toggle takes the desktop (collapse) path
    // and persists the choice.
    await user.click(toggle);
    expect(shell).toHaveAttribute('data-secondary-collapsed', 'true');
    expect(window.localStorage.getItem('clawtalk.sidebarCollapsed')).toBe(
      'true',
    );
    // The rail survives a collapse — Home stays reachable.
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();

    await user.click(toggle);
    expect(shell).toHaveAttribute('data-secondary-collapsed', 'false');
    expect(window.localStorage.getItem('clawtalk.sidebarCollapsed')).toBe(
      'false',
    );
  });

  it('shows talk activity and unread badges in the sidebar', async () => {
    window.localStorage.setItem(
      'clawtalk.talkReadMarkers',
      JSON.stringify({
        'talk-1': {
          messageCount: 2,
          lastMessageAt: '2026-03-18T09:00:00.000Z',
        },
      }),
    );

    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
                lastMessageAt: '2026-03-18T10:00:00.000Z',
                messageCount: 5,
                hasActiveRun: true,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.getByLabelText('Response in progress')).toBeTruthy();
    expect(screen.getByLabelText('3 unread messages')).toBeTruthy();
  });

  it('creates a new talk directly in the selected folder', async () => {
    const user = userEvent.setup();
    const createBodies: unknown[] = [];
    let sidebarCalls = 0;
    let resolveSidebarRefresh = (_response: Response): void => {};
    const sidebarRefresh = new Promise<Response>((resolve) => {
      resolveSidebarRefresh = resolve;
    });
    const existingTalk = {
      type: 'talk',
      id: 'talk-existing',
      title: 'Existing Talk',
      status: 'active',
      sortOrder: 0,
      lastMessageAt: null,
      messageCount: 0,
      hasActiveRun: false,
    };
    const folder = {
      id: 'folder-1',
      type: 'folder',
      title: 'Philosophy',
      sortOrder: 0,
      talks: [existingTalk],
    };
    const createdTalk = {
      id: 'talk-new',
      ownerId: 'u1',
      title: 'Folder Talk',
      agents: [],
      status: 'active',
      folderId: 'folder-1',
      sortOrder: 1,
      version: 1,
      createdAt: '2026-03-08T00:00:00.000Z',
      updatedAt: '2026-03-08T00:00:00.000Z',
      accessRole: 'owner',
    };

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const path = new URL(url, 'http://localhost').pathname;

        if (path === '/api/v1/session/me') {
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/talks/sidebar') {
          sidebarCalls += 1;
          if (sidebarCalls > 1) {
            return sidebarRefresh;
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [folder],
            },
          });
        }

        if (path === '/api/v1/talks' && init?.method === 'POST') {
          createBodies.push(JSON.parse(String(init.body)));
          return jsonResponse(201, {
            ok: true,
            data: { talk: createdTalk },
          });
        }

        if (path.startsWith('/api/v1/talks/talk-new')) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'talk_not_found', message: 'Talk not found' },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    renderWithRouter('/app/talks');
    await screen.findByRole('button', { name: 'Manage Philosophy' });

    await user.click(screen.getByRole('button', { name: 'Manage Philosophy' }));
    await user.click(screen.getByRole('button', { name: 'New Talk in Folder' }));
    await user.type(await screen.findByLabelText('Title'), 'Folder Talk');
    await user.click(screen.getByRole('button', { name: 'Create Talk' }));

    await waitFor(() =>
      expect(createBodies).toEqual([
        { title: 'Folder Talk', folderId: 'folder-1' },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: /Folder Talk/ }),
      ).toBeInTheDocument(),
    );
    expect(
      screen
        .getByRole('link', { name: /Existing Talk/ })
        .compareDocumentPosition(
          screen.getByRole('link', { name: /Folder Talk/ }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    resolveSidebarRefresh(
      jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              ...folder,
              talks: [existingTalk, { type: 'talk', ...createdTalk }],
            },
          ],
        },
      }),
    );
  });

  it('does not show unread badges when only the stored count is stale', async () => {
    window.localStorage.setItem(
      'clawtalk.talkReadMarkers',
      JSON.stringify({
        'talk-1': {
          messageCount: 2,
          lastMessageAt: '2026-03-18T10:00:00.000Z',
        },
      }),
    );

    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
                lastMessageAt: '2026-03-18T10:00:00.000Z',
                messageCount: 5,
                hasActiveRun: false,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.queryByLabelText(/unread messages/i)).toBeNull();

    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem('clawtalk.talkReadMarkers') || '{}',
        ),
      ).toMatchObject({
        'talk-1': {
          messageCount: 5,
          lastMessageAt: '2026-03-18T10:00:00.000Z',
        },
      }),
    );
  });

  it('returns to sign-in when a later API call returns 401', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ClawTalk' })).toBeTruthy(),
    );
  });

  it('shows sign-in after clicking sign out from authenticated shell', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
      '/api/v1/auth/logout': [
        jsonResponse(200, {
          ok: true,
          data: { loggedOut: true },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    const avatarButton = await screen.findByRole('button', {
      name: /account and workspace menu/i,
    });
    avatarButton.click();
    const logOutButton = await screen.findByRole('menuitem', {
      name: 'Log out',
    });
    logOutButton.click();

    await screen.findByRole('heading', { name: 'ClawTalk' });
  });

  it('shows unavailable talk state for 404 detail fetch', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
      '/api/v1/talks/talk-missing': [
        jsonResponse(404, {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        }),
      ],
      '/api/v1/talks/talk-missing/snapshot': [
        jsonResponse(404, {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        }),
      ],
      '/api/v1/talks/talk-missing/messages': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            messages: [],
            page: { limit: 100, count: 0, beforeCreatedAt: null },
          },
        }),
      ],
      '/api/v1/talks/talk-missing/agents': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            agents: [],
          },
        }),
      ],
      '/api/v1/talks/talk-missing/runs': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            runs: [],
            page: { limit: 50, count: 0, offset: 0 },
          },
        }),
      ],
    });

    renderWithRouter('/app/talks/talk-missing');
    await screen.findByRole('heading', { name: 'Talk Unavailable' });
  });
});

function renderWithRouter(initialEntry: string): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetchByPath(
  responsesByPath: Record<string, Response | Response[]>,
): void {
  const queues = new Map(
    Object.entries(responsesByPath).map(([path, responses]) => [
      path,
      Array.isArray(responses) ? [...responses] : [responses],
    ]),
  );

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`No mocked response left for fetch(${path})`);
    }
    return queue.shift()!;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
