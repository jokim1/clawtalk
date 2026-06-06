/**
 * Popover. Anchored floating panel with backdrop dismiss, ported from
 * `ToolsPopover` in prototype/tools.jsx (docs §4). Positions itself from an
 * anchor's DOMRect; clamps to the viewport so it stays on-screen.
 */
import { salon } from './tokens';
import type { ReactNode } from 'react';

export interface PopoverProps {
  /** The trigger's bounding rect (from `ref.current.getBoundingClientRect()`). */
  anchorRect?: DOMRect | null;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  /** Align the panel's right edge (default) or left edge to the anchor. */
  align?: 'left' | 'right';
  ariaLabel?: string;
}

export function Popover({
  anchorRect,
  onClose,
  width = 360,
  children,
  align = 'right',
  ariaLabel,
}: PopoverProps) {
  const position = anchorRect
    ? {
        top: anchorRect.bottom + 6,
        left:
          align === 'right'
            ? Math.max(8, anchorRect.right - width)
            : Math.max(8, anchorRect.left),
      }
    : { top: 80, right: 16 };

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label={ariaLabel}
        className="ct-screen-enter"
        style={{
          position: 'fixed',
          zIndex: 1001,
          width,
          maxWidth: 'calc(100vw - 16px)',
          background: salon.card,
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 30px 60px rgba(31, 27, 22, 0.22)',
          ...position,
        }}
      >
        {children}
      </div>
    </>
  );
}
