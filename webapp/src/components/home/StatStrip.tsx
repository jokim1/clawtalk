/**
 * Stat strip — Talks / Prompts / Tokens / Words for the workspace (docs/07
 * §4.2). Ported from StatStrip in prototype/home-shared.jsx. Responsive: the
 * auto-fit grid collapses from four columns to two on phone widths.
 */
import { salon, salonFont } from '../../salon';
import type { HomeSummaryPayload } from '../../lib/api';
import { formatStatValue } from './homeFormat';

export function StatStrip({
  stats,
}: {
  stats: HomeSummaryPayload['stats'];
}): JSX.Element {
  const cells: Array<{ label: string; value: string; sub: string }> = [
    { label: 'Talks', value: formatStatValue(stats.talks), sub: 'active' },
    { label: 'Prompts', value: formatStatValue(stats.prompts), sub: 'today' },
    { label: 'Tokens', value: formatStatValue(stats.tokens), sub: 'today' },
    { label: 'Words', value: formatStatValue(stats.words), sub: 'today' },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.label}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: 16,
            borderRadius: 16,
            background: 'var(--salon-card, #ffffff)',
            border: '1px solid var(--salon-line, #e6e0d1)',
          }}
        >
          <span
            style={{
              fontFamily: salonFont.mono,
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
              color: salon.ink2,
            }}
          >
            {cell.label}
          </span>
          <span
            style={{
              fontFamily: salonFont.serif,
              fontSize: 34,
              lineHeight: 1,
              color: salon.ink,
            }}
          >
            {cell.value}
          </span>
          <span
            aria-hidden="true"
            style={{
              height: 1,
              margin: '12px 0 8px',
              background: 'var(--salon-line, #e6e0d1)',
            }}
          />
          <span style={{ fontSize: 11.5, color: salon.ink2 }}>{cell.sub}</span>
        </div>
      ))}
    </div>
  );
}
