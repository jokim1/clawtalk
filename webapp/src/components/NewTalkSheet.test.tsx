import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewTalkSheet } from './NewTalkSheet';

afterEach(cleanup);

describe('NewTalkSheet', () => {
  it('renders a titled sheet and focuses the title field on open', () => {
    render(<NewTalkSheet onCreate={vi.fn(async () => {})} onClose={vi.fn()} />);
    expect(
      screen.getByRole('heading', { name: 'New Talk' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveFocus();
  });

  it('creates with the trimmed title on Create Talk click', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<NewTalkSheet onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Title'), '  Strategy review  ');
    await user.click(screen.getByRole('button', { name: 'Create Talk' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Strategy review');
  });

  it('submits on Enter from the title field', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<NewTalkSheet onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Title'), 'Quick talk{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Quick talk');
  });

  it('allows an empty (untitled) title', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<NewTalkSheet onCreate={onCreate} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create Talk' }));
    expect(onCreate).toHaveBeenCalledWith('');
  });

  it('cancels without creating', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewTalkSheet onCreate={onCreate} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewTalkSheet onCreate={vi.fn(async () => {})} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error and reopens for retry when create fails', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error('Workspace is read-only');
    });
    render(<NewTalkSheet onCreate={onCreate} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create Talk' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Workspace is read-only',
    );
    expect(screen.getByRole('button', { name: 'Create Talk' })).toBeEnabled();
  });

  it('locks the primary action but stays dismissable while creating', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<NewTalkSheet onCreate={onCreate} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Create Talk' }));
    // Primary locked to prevent a duplicate create...
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    // ...but the user can still back out, so a stalled request never traps them.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    release();
  });
});
