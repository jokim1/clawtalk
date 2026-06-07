import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { IconRail } from './IconRail';
import type { SessionUser } from '../../lib/api';

function buildUser(): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner Example',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1', name: 'Oxbow', role: 'owner', initials: 'OX' }],
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

type Overrides = Partial<React.ComponentProps<typeof IconRail>>;

function renderRail(initialEntry: string, props: Overrides = {}) {
  const base: React.ComponentProps<typeof IconRail> = {
    user: buildUser(),
    workspaces: buildUser().workspaces ?? [],
    currentWorkspaceId: 'ws-1',
    onSwitchWorkspace: vi.fn(async () => undefined),
    onSignOut: vi.fn(),
    signOutBusy: false,
    onOpenPalette: vi.fn(),
    onToggleSecondary: vi.fn(),
    secondaryAvailable: true,
  };
  const merged = { ...base, ...props };
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <IconRail {...merged} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return merged;
}

describe('IconRail', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('marks the active nav item for the current route', () => {
    renderRail('/app/home');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Talks' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks Talks active on a talk detail route', () => {
    renderRail('/app/talks/abc');
    expect(screen.getByRole('button', { name: 'Talks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks Agents active on the settings agents tab', () => {
    renderRail('/app/settings?tab=agents');
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('navigates when a nav item is clicked', async () => {
    const user = userEvent.setup();
    renderRail('/app/home');
    await user.click(screen.getByRole('button', { name: 'Talks' }));
    expect(screen.getByTestId('location').textContent).toBe('/app/talks');
  });

  it('opens the command palette from the rail button', async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    renderRail('/app/home', { onOpenPalette });
    await user.click(screen.getByRole('button', { name: 'Open command palette' }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('shows the talk-list toggle only when the secondary column is available', async () => {
    const user = userEvent.setup();
    const onToggleSecondary = vi.fn();
    const { rerender } = renderToggle(true, onToggleSecondary);
    await user.click(screen.getByRole('button', { name: 'Toggle talk list' }));
    expect(onToggleSecondary).toHaveBeenCalledTimes(1);

    rerender(false);
    expect(screen.queryByRole('button', { name: 'Toggle talk list' })).toBeNull();
  });

  it('opens the profile menu from the avatar button', async () => {
    const user = userEvent.setup();
    renderRail('/app/home');
    await user.click(
      screen.getByRole('button', { name: /Owner Example — account/ }),
    );
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
  });
});

// Helper that supports re-rendering with a different secondaryAvailable value.
function renderToggle(
  secondaryAvailable: boolean,
  onToggleSecondary: () => void,
) {
  const props: React.ComponentProps<typeof IconRail> = {
    user: buildUser(),
    workspaces: buildUser().workspaces ?? [],
    currentWorkspaceId: 'ws-1',
    onSwitchWorkspace: vi.fn(async () => undefined),
    onSignOut: vi.fn(),
    signOutBusy: false,
    onOpenPalette: vi.fn(),
    onToggleSecondary,
    secondaryAvailable,
  };
  const utils = render(
    <MemoryRouter initialEntries={['/app/home']}>
      <IconRail {...props} />
    </MemoryRouter>,
  );
  return {
    rerender: (next: boolean) =>
      utils.rerender(
        <MemoryRouter initialEntries={['/app/home']}>
          <IconRail {...props} secondaryAvailable={next} />
        </MemoryRouter>,
      ),
  };
}
