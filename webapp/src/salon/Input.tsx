/**
 * Input + Textarea. Salon field primitives ported from the prototype's form
 * inputs (paper fill, warm line border, accent focus ring). Focus styling lives
 * in `.salon-field` (salon.css). Textareas default to the editorial serif body
 * face, matching the composer.
 */
import { salon, salonFont } from './tokens';
import type {
  CSSProperties,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

// Base background + border live in the `.salon-field` class (salon.css) so the
// `:focus` accent border can override them — inline styles would win and leave
// the focus border dead. Only layout/typography is set inline here.
const fieldBase = (serif: boolean): CSSProperties => ({
  width: '100%',
  color: salon.ink,
  outline: 'none',
  fontFamily: serif ? salonFont.serif : salonFont.sans,
});

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  serif?: boolean;
}

export function Input({
  serif = false,
  style,
  className,
  ...rest
}: InputProps) {
  return (
    <input
      className={['salon-field', className].filter(Boolean).join(' ')}
      style={{
        ...fieldBase(serif),
        height: 40,
        padding: '0 12px',
        borderRadius: 10,
        fontSize: 14,
        ...style,
      }}
      {...rest}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  serif?: boolean;
}

export function Textarea({
  serif = true,
  style,
  className,
  ...rest
}: TextareaProps) {
  return (
    <textarea
      className={['salon-field', className].filter(Boolean).join(' ')}
      style={{
        ...fieldBase(serif),
        minHeight: 92,
        padding: 12,
        borderRadius: 10,
        fontSize: 16,
        lineHeight: 1.55,
        resize: 'none',
        ...style,
      }}
      {...rest}
    />
  );
}
