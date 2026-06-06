/**
 * Kbd. Ported from `Kbd` in shell.jsx (docs §4): mono keyboard-shortcut display,
 * e.g. `<Kbd>⌘K</Kbd>`. Uses the semantic <kbd> element.
 */
import { salon, salonFont } from './tokens';
import type { ReactNode } from 'react';

export interface KbdProps {
  children: ReactNode;
}

export function Kbd({ children }: KbdProps) {
  return (
    <kbd
      style={{
        fontFamily: salonFont.mono,
        fontSize: 10,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 4,
        background: salon.paper2,
        color: salon.ink2,
        fontWeight: 500,
      }}
    >
      {children}
    </kbd>
  );
}
