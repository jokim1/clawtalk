/**
 * Chip. Ported from `Chip` in shell.jsx (docs §4): small rounded-full pill in
 * two tones — `paper` (filled) and `ghost` (outlined). Renders as a button when
 * `onClick` is given, otherwise as a static span (for metadata/status tags).
 */
import { salon } from './tokens';
import type { CSSProperties, ReactNode } from 'react';

export interface ChipProps {
  children: ReactNode;
  tone?: 'paper' | 'ghost';
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  ariaPressed?: boolean;
  ariaLabel?: string;
}

export function Chip({
  children,
  tone = 'paper',
  active = false,
  onClick,
  disabled = false,
  title,
  ariaPressed,
  ariaLabel,
}: ChipProps) {
  const toneStyle: CSSProperties =
    tone === 'paper'
      ? {
          background: active ? salon.accent : salon.paper2,
          color: active ? '#fff' : salon.ink,
          border: `1px solid ${active ? 'transparent' : salon.line}`,
        }
      : {
          background: 'transparent',
          color: salon.ink2,
          border: `1px solid ${salon.line}`,
        };

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: 11,
    fontWeight: 500,
    userSelect: 'none',
    ...toneStyle,
  };

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-pressed={ariaPressed}
        aria-label={ariaLabel}
        style={{
          ...style,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <span title={title} aria-label={ariaLabel} style={style}>
      {children}
    </span>
  );
}
