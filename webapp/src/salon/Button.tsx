/**
 * Button. Salon CTA primitive — variants ported from the prototype's accent
 * Send button (primary), card-outline Cancel (secondary), ghost icon buttons,
 * and the destructive red row (danger). Pill shape (docs §3). Hover/focus live
 * in `.salon-btn` (salon.css) so they survive inline-style precedence.
 */
import { salon, salonFont } from './tokens';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: salon.accent,
    color: '#fff',
    border: '1px solid transparent',
  },
  secondary: {
    background: salon.card,
    color: salon.ink,
    border: `1px solid ${salon.line}`,
  },
  ghost: {
    background: 'transparent',
    color: salon.ink2,
    border: '1px solid transparent',
  },
  danger: {
    background: '#fbecec',
    color: '#7b2a30',
    border: '1px solid #ecc4c7',
  },
};

export function Button({
  variant = 'primary',
  children,
  style,
  type = 'button',
  disabled = false,
  className,
  ...rest
}: ButtonProps) {
  const base: CSSProperties = {
    height: 36,
    padding: '0 16px',
    borderRadius: '9999px',
    fontFamily: salonFont.sans,
    fontSize: 13,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  };
  return (
    <button
      type={type}
      disabled={disabled}
      className={['salon-btn', className].filter(Boolean).join(' ')}
      style={{
        ...base,
        ...VARIANTS[variant],
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
