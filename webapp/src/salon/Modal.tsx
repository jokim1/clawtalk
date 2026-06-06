/**
 * Modal. Ported from `Modal` in prototype/talk-dialogs.jsx (docs §4): centered
 * sheet with a 10vh top offset, backdrop blur, escape-close, and backdrop
 * click-to-dismiss (guarded to the backdrop itself). Width clamps on narrow
 * viewports so it stays responsive.
 */
import { useEffect } from 'react';
import { salon } from './tokens';
import type { ReactNode } from 'react';

export interface ModalProps {
  onClose: () => void;
  width?: number;
  children: ReactNode;
  ariaLabel?: string;
  ariaLabelledby?: string;
}

export function Modal({
  onClose,
  width = 520,
  children,
  ariaLabel,
  ariaLabelledby,
}: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="ct-screen-enter"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'start center',
        paddingTop: '10vh',
        background: 'rgba(31, 27, 22, 0.32)',
        backdropFilter: 'blur(3px)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        style={{
          width,
          maxWidth: 'calc(100vw - 32px)',
          // Cap height and scroll tall content so actions never clip on short
          // viewports / zoom (matches the .connector-modal max-height:90vh it
          // replaces). Top offset is 10vh, so 85vh leaves a small bottom margin.
          maxHeight: '85vh',
          background: salon.card,
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          overflow: 'hidden',
          overflowY: 'auto',
          boxShadow: '0 40px 80px rgba(31, 27, 22, 0.25)',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
