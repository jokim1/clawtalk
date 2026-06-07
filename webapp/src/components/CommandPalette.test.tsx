import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, type CommandItem } from './CommandPalette';

afterEach(cleanup);

function buildItems(
  overrides: Partial<Record<string, () => void>> = {},
): CommandItem[] {
  return [
    {
      id: 'home',
      label: 'Home',
      hint: 'Go to',
      run: overrides.home ?? vi.fn(),
    },
    {
      id: 'settings',
      label: 'Settings',
      hint: 'Go to',
      keywords: 'profile agents api keys',
      run: overrides.settings ?? vi.fn(),
    },
    {
      id: 'new',
      label: 'New Talk',
      hint: 'Action',
      run: overrides.new ?? vi.fn(),
    },
    {
      id: 't1',
      label: 'Strategy review',
      hint: 'Talk',
      run: overrides.t1 ?? vi.fn(),
    },
  ];
}

describe('CommandPalette', () => {
  it('renders a focused combobox listing all items', () => {
    render(<CommandPalette items={buildItems()} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox', {
      name: 'Search commands and Talks',
    });
    expect(input).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('filters by label substring', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={buildItems()} onClose={vi.fn()} />);
    await user.keyboard('strategy');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Strategy review');
  });

  it('filters by hidden keywords (order-independent tokens)', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={buildItems()} onClose={vi.fn()} />);
    await user.keyboard('keys api');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Settings');
  });

  it('moves the active option with ArrowDown and runs it on Enter', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        items={buildItems({ settings: run })}
        onClose={onClose}
      />,
    );
    await user.keyboard('{ArrowDown}'); // 0 (Home) -> 1 (Settings)
    expect(screen.getAllByRole('option')[1]).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps selection with ArrowUp from the top', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={buildItems()} onClose={vi.fn()} />);
    await user.keyboard('{ArrowUp}'); // 0 -> last (3)
    expect(screen.getAllByRole('option')[3]).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('runs an item on click and closes', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette items={buildItems({ t1: run })} onClose={onClose} />,
    );
    await user.click(screen.getByText('Strategy review'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when nothing matches and Enter is a no-op', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette items={buildItems()} onClose={onClose} />);
    await user.keyboard('zzzznomatch');
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    // The empty-state row is a status message, not a selectable listbox option.
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette items={buildItems()} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
