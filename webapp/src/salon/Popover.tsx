/**
 * Popover. Anchored floating panel with backdrop dismiss, ported from
 * `ToolsPopover` in prototype/tools.jsx (docs §4). Positions itself from an
 * anchor's DOMRect, clamps its left edge to the viewport, and caps its height
 * with internal scroll so long lists never overflow off-screen.
 *
 * Like Modal, rendered through a portal to `document.body` so its fixed backdrop
 * + panel escape any ancestor stacking context / overflow clip and stack above
 * the app at zIndex 1000/1001 (see Modal.tsx for the rationale).
 */
import { createPortal } from 'react-dom';
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
  const top = anchorRect ? anchorRect.bottom + 6 : 80;
  const horizontal = anchorRect
    ? {
        left:
          align === 'right'
            ? Math.max(8, anchorRect.right - width)
            : Math.max(8, anchorRect.left),
      }
    : { right: 16 };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label={ariaLabel}
        className="ct-screen-enter ct-thin-scroll"
        style={{
          position: 'fixed',
          zIndex: 1001,
          top,
          ...horizontal,
          width,
          maxWidth: 'calc(100vw - 16px)',
          // Cap to the space below the anchor and scroll long content, so a
          // popover near the viewport bottom never clips its lower items.
          maxHeight: `calc(100vh - ${top}px - 16px)`,
          background: salon.card,
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          overflow: 'hidden',
          overflowY: 'auto',
          boxShadow: '0 30px 60px rgba(31, 27, 22, 0.22)',
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
