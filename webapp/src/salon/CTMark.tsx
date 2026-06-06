/**
 * ClawTalk Salon brand mark. Ported from `CTMarkSalon` in shared/data.jsx
 * (docs §7): three claw streaks over a rounded paper-cut speech bubble.
 * Renders cleanly at 16–80px. Accent follows the `--salon-accent` token.
 */
export interface CTMarkProps {
  size?: number;
  accent?: string;
  className?: string;
  /** When provided, renders an accessible label instead of aria-hidden. */
  title?: string;
}

export function CTMark({
  size = 32,
  accent = 'var(--salon-accent, #c8643a)',
  className,
  title,
}: CTMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M6 8 C6 5 8 3 11 3 H29 C32 3 34 5 34 8 V24 C34 27 32 29 29 29 H18 L11 35 V29 C8 29 6 27 6 24 Z"
        fill="var(--salon-paper, #fbf7ef)"
        stroke={accent}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M13 19 L18 9"
        stroke={accent}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M19 22 L24 10"
        stroke={accent}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M25 22 L28 13"
        stroke={accent}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
