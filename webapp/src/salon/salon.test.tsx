import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_ACCENTS,
  AgentAvatar,
  Avatar,
  Button,
  Chip,
  CTIcon,
  CTMark,
  Input,
  Kbd,
  Modal,
  Popover,
  RUN_STATES,
  RunPill,
  Sheet,
  Textarea,
} from './index';

afterEach(cleanup);

describe('Salon primitives', () => {
  it('RunPill renders the status label', () => {
    render(<RunPill status="running" />);
    expect(screen.getByText('Streaming')).toBeTruthy();
  });

  it('RunPill honors an explicit label override (preserves source text)', () => {
    render(<RunPill status="awaiting" label="awaiting_confirmation" />);
    expect(screen.getByText('awaiting_confirmation')).toBeTruthy();
  });

  it('RunPill renders the correct label for every run status', () => {
    (Object.keys(RUN_STATES) as Array<keyof typeof RUN_STATES>).forEach(
      (status) => {
        const { unmount } = render(<RunPill status={status} />);
        expect(screen.getByText(RUN_STATES[status].label)).toBeTruthy();
        unmount();
      },
    );
  });

  it('Chip is an interactive button that forwards aria-pressed + onClick', () => {
    const onClick = vi.fn();
    render(
      <Chip onClick={onClick} active ariaPressed>
        Web
      </Chip>,
    );
    const btn = screen.getByRole('button', { name: 'Web' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Chip renders a static span when non-interactive', () => {
    render(<Chip>Ready</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('Kbd renders a semantic <kbd>', () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    expect(container.querySelector('kbd')?.textContent).toBe('⌘K');
  });

  it('AgentAvatar renders role initials; roles map to canonical accents', () => {
    render(<AgentAvatar role="critic" initials="DA" />);
    expect(screen.getByText('DA')).toBeTruthy();
    expect(AGENT_ACCENTS.critic.accent).toBe('#8e3b59');
  });

  it('Avatar forwards className so layout classes survive a migration', () => {
    render(<Avatar initials="JK" color="#123456" className="x-layout" />);
    expect(screen.getByText('JK')).toHaveClass('x-layout');
  });

  it('Button forwards type/disabled', () => {
    render(
      <Button variant="danger" disabled>
        Delete
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('Input + Textarea carry the focusable salon-field class', () => {
    const { container } = render(
      <>
        <Input placeholder="name" />
        <Textarea placeholder="body" />
      </>,
    );
    expect(container.querySelector('input.salon-field')).toBeTruthy();
    expect(container.querySelector('textarea.salon-field')).toBeTruthy();
  });

  it('Modal closes on Escape and on backdrop mousedown', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal onClose={onClose} ariaLabel="demo">
        <p>body</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector('.ct-screen-enter') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Modal keeps open on inner-content mousedown (stopPropagation)', () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <p>inner</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Sheet renders title + footer and closes via the header Close button', () => {
    const onClose = vi.fn();
    render(
      <Sheet
        title="Delete?"
        onClose={onClose}
        footer={<button>Confirm</button>}
      >
        <p>warning</p>
      </Sheet>,
    );
    expect(screen.getByText('Delete?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Popover renders children and dismisses on backdrop mousedown', () => {
    const onClose = vi.fn();
    render(
      <Popover onClose={onClose} ariaLabel="menu">
        <button>Item</button>
      </Popover>,
    );
    expect(screen.getByRole('button', { name: 'Item' })).toBeTruthy();
    const backdrop = document.querySelector(
      '[aria-hidden="true"]',
    ) as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('CTMark + CTIcon render SVGs', () => {
    const { container: mark } = render(<CTMark title="ClawTalk" />);
    expect(mark.querySelector('svg')).toBeTruthy();
    const { container: icon } = render(<CTIcon name="search" />);
    expect(icon.querySelector('svg')).toBeTruthy();
  });
});
