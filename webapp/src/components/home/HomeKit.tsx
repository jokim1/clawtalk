/**
 * Home surface — shared Salon-native presentational primitives.
 *
 * Ported from prototype/home-shared.jsx (Tailwind + `S.*`) to the production
 * stack: inline styles over Salon CSS-variable tokens (`var(--salon-*)` /
 * `salon.*`) and the Salon icon set. No Tailwind. Reused by every Home section
 * card so the cards stay visually identical.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { CTIcon, salon, salonFont } from '../../salon';
import type { CTIconName } from '../../salon';
import { truncate, type ActionBehavior, type BadgeTone } from './homeFormat';

export const CARD_STYLE: CSSProperties = {
  background: 'var(--salon-card, #ffffff)',
  border: '1px solid var(--salon-line, #e6e0d1)',
  borderRadius: 16,
  padding: 16,
};

/**
 * Multi-line truncation that also breaks long unbroken tokens (URLs, IDs) so
 * card text cannot overflow its flex column at narrow (390px) widths.
 */
export function clampLines(lines: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  };
}

/** Rounded Salon card. `accentRail` draws the Decide-priority left bar. */
export function Card({
  children,
  accentRail = false,
  style,
}: {
  children: ReactNode;
  accentRail?: boolean;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div
      style={{
        ...CARD_STYLE,
        ...(accentRail
          ? { boxShadow: `inset 3px 0 0 var(--salon-accent, ${salon.accent})` }
          : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Section band: serif title + mono count + hairline rule. */
export function SectionHeader({
  title,
  count,
}: {
  title: string;
  count?: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        marginBottom: 10,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontFamily: salonFont.serif,
          fontSize: 18,
          lineHeight: 1,
          fontWeight: 500,
          color: salon.ink,
        }}
      >
        {title}
      </h2>
      {count ? (
        <span
          style={{
            fontFamily: salonFont.mono,
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.16em',
            color: salon.ink2,
          }}
        >
          {count}
        </span>
      ) : null}
      <div
        aria-hidden="true"
        style={{
          flex: 1,
          height: 1,
          marginLeft: 8,
          background: 'var(--salon-line, #e6e0d1)',
        }}
      />
    </div>
  );
}

/** Small rounded badge with an optional leading dot. */
export function Badge({
  tone,
  dot = true,
}: {
  tone: BadgeTone;
  dot?: boolean;
}): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 9999,
        fontFamily: salonFont.sans,
        fontSize: 11,
        fontWeight: 500,
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {dot ? (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 9999,
            background: tone.fg,
          }}
        />
      ) : null}
      {tone.label}
    </span>
  );
}

/** Icon-in-square glyph (paper-2 chip, accent stroke). */
export function KindGlyph({
  icon,
  size = 28,
}: {
  icon: CTIconName;
  size?: number;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 8,
        background: 'var(--salon-paper-2, #f4ecdb)',
        color: salon.accent,
      }}
    >
      <CTIcon
        name={icon}
        size={Math.round(size * 0.46)}
        stroke={salon.accent}
        strokeWidth={1.8}
      />
    </span>
  );
}

/** Provenance chip linking to a Talk. */
export function TalkChip({
  talkId,
  title,
}: {
  talkId: string;
  title: string;
}): JSX.Element {
  return (
    <Link
      to={`/app/talks/${encodeURIComponent(talkId)}`}
      className="salon-btn"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        padding: '2px 10px',
        borderRadius: 9999,
        fontFamily: salonFont.sans,
        fontSize: 11.5,
        textDecoration: 'none',
        background: 'var(--salon-paper, #fbf7ef)',
        color: salon.ink2,
        border: `1px solid ${salon.line}`,
      }}
    >
      <CTIcon name="chat" size={11} stroke={salon.ink2} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {truncate(title, 30)}
      </span>
    </Link>
  );
}

function pill(
  variant: 'primary' | 'secondary',
  size: 'sm' | 'md',
): CSSProperties {
  const sized =
    size === 'md'
      ? { height: 34, padding: '0 14px', fontSize: 13 }
      : { height: 28, padding: '0 12px', fontSize: 12 };
  const tone: CSSProperties =
    variant === 'primary'
      ? {
          background: salon.accent,
          color: '#fff',
          border: '1px solid transparent',
        }
      : {
          background: 'var(--salon-card, #ffffff)',
          color: salon.ink,
          border: `1px solid ${salon.line}`,
        };
  return {
    ...sized,
    ...tone,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 9999,
    fontFamily: salonFont.sans,
    fontWeight: 500,
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

/**
 * Renders a Home action per its resolved behavior: a Link for in-app nav, an
 * external anchor for URLs, and a disabled button (with an explanatory tooltip)
 * for mutations whose write API is not built yet.
 */
export function ActionButton({
  behavior,
  variant = 'primary',
  size = 'sm',
  onActivate,
}: {
  behavior: ActionBehavior;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
  onActivate?: () => void;
}): JSX.Element {
  const style = pill(variant, size);
  if (behavior.kind === 'nav') {
    return (
      <Link
        to={behavior.to}
        className="salon-btn"
        style={style}
        onClick={onActivate}
      >
        {behavior.label}
        <CTIcon
          name="arrow"
          size={12}
          stroke={variant === 'primary' ? '#fff' : salon.ink2}
        />
      </Link>
    );
  }
  if (behavior.kind === 'href') {
    return (
      <a
        href={behavior.href}
        target="_blank"
        rel="noreferrer"
        className="salon-btn"
        style={style}
        onClick={onActivate}
        aria-label={`${behavior.label} (opens in new window)`}
      >
        {behavior.label}
        <span aria-hidden="true">↗</span>
      </a>
    );
  }
  return (
    <button
      type="button"
      disabled
      className="salon-btn"
      title={behavior.reason}
      aria-label={`${behavior.label} — unavailable: ${behavior.reason}`}
      style={{ ...style, opacity: 0.5, cursor: 'not-allowed' }}
    >
      {behavior.label}
    </button>
  );
}

/** Mono uppercase eyebrow label (Curator / Matched / etc.). */
export function Eyebrow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: salonFont.mono,
        fontSize: 10.5,
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        color: salon.ink2,
      }}
    >
      {children}
    </span>
  );
}

/** Loading placeholder card. */
export function SkeletonCard({ lines = 2 }: { lines?: number }): JSX.Element {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SkeletonLine width="40%" />
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} width={i === lines - 1 ? '70%' : '100%'} />
        ))}
      </div>
    </Card>
  );
}

export function SkeletonLine({
  width = '100%',
}: {
  width?: string;
}): JSX.Element {
  return (
    <span
      className="ct-pulse"
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height: 12,
        borderRadius: 6,
        background: 'var(--salon-paper-2, #f4ecdb)',
      }}
    />
  );
}

/** Friendly empty state for a Home section. */
export function HomeEmpty({
  icon,
  title,
  hint,
}: {
  icon: CTIconName;
  title: string;
  hint?: string;
}): JSX.Element {
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          padding: '20px 12px',
          textAlign: 'center',
        }}
      >
        <KindGlyph icon={icon} size={34} />
        <div
          style={{
            fontFamily: salonFont.serif,
            fontSize: 16,
            color: salon.ink,
          }}
        >
          {title}
        </div>
        {hint ? (
          <div style={{ fontSize: 12.5, color: salon.ink2, maxWidth: 320 }}>
            {hint}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
