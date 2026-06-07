/**
 * Curator summary card — the deterministic "what deserves attention now"
 * headline (docs/07 §4.1). Ported from CuratorBar in prototype/home-shared.jsx.
 */
import { Link } from 'react-router-dom';

import { salon, salonFont } from '../../salon';
import type { HomeSummaryPayload } from '../../lib/api';
import { Eyebrow } from './HomeKit';
import { targetToPath } from './homeFormat';

export function CuratorCard({
  curator,
}: {
  curator: HomeSummaryPayload['curator'];
}): JSX.Element {
  const to = targetToPath(curator.target);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: 16,
        borderRadius: 18,
        border: '1px solid var(--salon-line, #e6e0d1)',
        background:
          'linear-gradient(180deg, var(--salon-paper-2, #f4ecdb) 0%, var(--salon-paper, #fbf7ef) 100%)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          background: salon.accent,
          color: '#fff',
          fontFamily: salonFont.serif,
          fontSize: 15,
        }}
      >
        C
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ marginBottom: 2 }}>
          <Eyebrow>Curator</Eyebrow>
        </div>
        <div
          style={{
            fontFamily: salonFont.serif,
            fontSize: 18,
            lineHeight: 1.35,
            color: salon.ink,
          }}
        >
          {curator.title}
        </div>
        {curator.summary ? (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 4,
              color: salon.ink2,
            }}
          >
            {curator.summary}
          </div>
        ) : null}
      </div>
      {to ? (
        <Link
          to={to}
          style={{
            fontSize: 11.5,
            color: salon.ink2,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          Why this →
        </Link>
      ) : null}
    </div>
  );
}
