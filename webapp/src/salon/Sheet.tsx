/**
 * Sheet. Larger form-modal with sectioned header/body/footer layout, ported
 * from `NewTalkSheet` in prototype/talk-dialogs.jsx (docs §4). Built on Modal.
 */
import { salon, salonFont } from './tokens';
import { Modal } from './Modal';
import { CTIcon } from './CTIcon';
import type { ReactNode } from 'react';

export interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  /** Footer content (e.g. Cancel / submit actions), right-aligned. */
  footer?: ReactNode;
  /** Extra header content placed left of the close button (e.g. a Kbd hint). */
  headerAccessory?: ReactNode;
  titleId?: string;
}

export function Sheet({
  title,
  onClose,
  width = 620,
  children,
  footer,
  headerAccessory,
  titleId = 'salon-sheet-title',
}: SheetProps) {
  return (
    <Modal onClose={onClose} width={width} ariaLabelledby={titleId}>
      <header
        style={{
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderBottom: `1px solid ${salon.line}`,
        }}
      >
        <h2
          id={titleId}
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 17,
            fontWeight: 500,
            color: salon.ink,
          }}
        >
          {title}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {headerAccessory}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="salon-btn"
            style={{
              width: 28,
              height: 28,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              background: 'transparent',
              border: 'none',
              color: salon.ink2,
              cursor: 'pointer',
            }}
          >
            <CTIcon name="x" size={14} />
          </button>
        </div>
      </header>
      <div style={{ padding: '16px 20px' }}>{children}</div>
      {footer ? (
        <footer
          style={{
            padding: '12px 20px',
            borderTop: `1px solid ${salon.line}`,
            background: salon.paper,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {footer}
        </footer>
      ) : null}
    </Modal>
  );
}
