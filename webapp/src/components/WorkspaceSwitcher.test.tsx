import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import type { SessionWorkspace } from '../lib/api';

function buildWorkspaces(): SessionWorkspace[] {
  return [
    { id: 'ws-1', name: 'Personal', role: 'owner', initials: 'PE' },
    { id: 'ws-2', name: 'Acme Inc', role: 'member', initials: 'AC' },
  ];
}

describe('WorkspaceSwitcher', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no workspaces', () => {
    const { container } = render(
      <WorkspaceSwitcher
        workspaces={[]}
        currentWorkspaceId={undefined}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the current workspace name and switches on selection', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => undefined);

    render(
      <WorkspaceSwitcher
        workspaces={buildWorkspaces()}
        currentWorkspaceId="ws-1"
        onSwitchWorkspace={onSwitchWorkspace}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Switch workspace' });
    expect(trigger).toHaveTextContent('Personal');

    await user.click(trigger);
    await user.click(screen.getByRole('menuitemradio', { name: /Acme Inc/ }));

    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);
    expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-2');
  });

  it('does not call onSwitchWorkspace when reselecting the current workspace', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => undefined);

    render(
      <WorkspaceSwitcher
        workspaces={buildWorkspaces()}
        currentWorkspaceId="ws-1"
        onSwitchWorkspace={onSwitchWorkspace}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Switch workspace' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Personal/ }));

    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('renders the name inert with no menu for a single workspace', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={[buildWorkspaces()[0]]}
        currentWorkspaceId="ws-1"
        onSwitchWorkspace={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Switch workspace' });
    expect(trigger).toHaveTextContent('Personal');
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('surfaces an inline error when switching fails', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => {
      throw new Error('Network down');
    });

    render(
      <WorkspaceSwitcher
        workspaces={buildWorkspaces()}
        currentWorkspaceId="ws-1"
        onSwitchWorkspace={onSwitchWorkspace}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Switch workspace' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Acme Inc/ }));

    expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-2');
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    // The switching guard resets so the trigger is usable again.
    expect(
      screen.getByRole('button', { name: 'Switch workspace' }),
    ).not.toBeDisabled();
  });

  it('switches to the first workspace when currentWorkspaceId is unknown', async () => {
    const user = userEvent.setup();
    const onSwitchWorkspace = vi.fn(async () => undefined);

    render(
      <WorkspaceSwitcher
        workspaces={buildWorkspaces()}
        currentWorkspaceId="ws-missing"
        onSwitchWorkspace={onSwitchWorkspace}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Switch workspace' }));
    // Nothing is marked active when the session id is not in the list.
    expect(
      screen.getByRole('menuitemradio', { name: /Personal/ }),
    ).toHaveAttribute('aria-checked', 'false');
    // Selecting the display-fallback workspace still switches (not a no-op).
    await user.click(screen.getByRole('menuitemradio', { name: /Personal/ }));
    expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={buildWorkspaces()}
        currentWorkspaceId="ws-1"
        onSwitchWorkspace={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
