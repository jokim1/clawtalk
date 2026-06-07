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
  const cells: Array<{ label: string; value: string }> = [
    { label: 'Talks', value: formatStatValue(stats.talks) },
    { label: 'Prompts', value: formatStatValue(stats.prompts) },
    { label: 'Tokens', value: formatStatValue(stats.tokens) },
    { label: 'Words', value: formatStatValue(stats.words) },
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
            padding: 14,
            borderRadius: 14,
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
              fontSize: 24,
              lineHeight: 1,
              color: salon.ink,
            }}
          >
            {cell.value}
          </span>
        </div>
      ))}
    </div>
  );
}
