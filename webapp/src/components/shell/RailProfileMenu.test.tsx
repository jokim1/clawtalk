import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { RailProfileMenu } from './RailProfileMenu';
import type { SessionUser } from '../../lib/api';

function buildUser(): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner Example',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentWorkspaceId: 'ws-1',
    workspaces: [
      { id: 'ws-1', name: 'Oxbow', role: 'owner', initials: 'OX' },
      { id: 'ws-2', name: 'Second', role: 'member', initials: 'SE' },
    ],
  };
}

type Overrides = Partial<React.ComponentProps<typeof RailProfileMenu>>;

function renderMenu(props: Overrides = {}) {
  const user = buildUser();
  const base: React.ComponentProps<typeof RailProfileMenu> = {
    anchorRect: null,
    user,
    workspaces: user.workspaces ?? [],
    currentWorkspaceId: user.currentWorkspaceId,
    onSwitchWorkspace: vi.fn(async () => undefined),
    onSignOut: vi.fn(),
    signOutBusy: false,
    onClose: vi.fn(),
  };
  const merged = { ...base, ...props };
  render(
    <MemoryRouter>
      <RailProfileMenu {...merged} />
    </MemoryRouter>,
  );
  return merged;
}

describe('RailProfileMenu', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists the workspaces and marks the active one', () => {
    renderMenu();
    expect(screen.getByText('Oxbow')).toBeTruthy();
    const active = screen.getByRole('menuitemradio', { name: /Oxbow/ });
    expect(active.getAttribute('aria-checked')).toBe('true');
    const other = screen.getByRole('menuitemradio', { name: /Second/ });
    expect(other.getAttribute('aria-checked')).toBe('false');
  });

  it('switches to another workspace on click', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => undefined);
    renderMenu({ onSwitchWorkspace });
    await user.click(screen.getByRole('menuitemradio', { name: /Second/ }));
    expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-2');
  });

  it('closes (without switching) when the active workspace is reselected', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderMenu({ onSwitchWorkspace, onClose });
    await user.click(screen.getByRole('menuitemradio', { name: /Oxbow/ }));
    expect(onSwitchWorkspace).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates account links and closes the menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderMenu({ onClose });
    await user.click(screen.getByRole('menuitem', { name: 'API keys' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the external Help link in the menu', () => {
    renderMenu();
    const help = screen.getByRole('menuitem', { name: 'Help' });
    expect(help).toHaveAttribute('href', 'https://clawtalk.app/help');
    expect(help).toHaveAttribute('target', '_blank');
  });

  it('signs out via the logout row', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    renderMenu({ onSignOut });
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('disables the logout row while signing out', () => {
    renderMenu({ signOutBusy: true });
    const logout = screen.getByRole('menuitem', { name: 'Signing out…' });
    expect((logout as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderMenu({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
