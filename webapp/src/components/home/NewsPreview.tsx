/**
 * News preview — topic-matched items for monitored Talks (docs/07 §8). Ported
 * from WideNewsCard + NewsThumb in prototype/home-focus.jsx: headline + excerpt
 * on the left, an editorial thumbnail block on the right (hidden at phone
 * widths via .home-news-thumb), provenance footer. "Open" links out to the
 * source; "Add to context", "Snooze", and "Not relevant" are Home lifecycle
 * writes owned by the parent so optimistic removal and failure rollback stays
 * page-scoped.
 */
import { CTIcon, salon, salonFont } from '../../salon';
import type { HomeNewsItem, HomeNewsPayload } from '../../lib/api';
import {
  ActionButton,
  Card,
  clampLines,
  Eyebrow,
  HomeEmpty,
  LifecycleIconButton,
  SectionHeader,
  SnoozeControl,
  TalkChip,
} from './HomeKit';
import {
  isSafeHttpUrl,
  newsImpactLabel,
  newsThumbPalette,
  truncate,
} from './homeFormat';

function NewsThumb({ item }: { item: HomeNewsItem }): JSX.Element {
  const palette = newsThumbPalette(item.source, item.favicon);
  return (
    <div
      className="home-news-thumb"
      aria-hidden="true"
      style={{
        width: 200,
        height: 132,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 12,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${salon.line}`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(80% 60% at 30% 20%, rgba(255,255,255,0.18) 0%, transparent 60%), radial-gradient(60% 50% at 80% 100%, rgba(0,0,0,0.18) 0%, transparent 70%)',
        }}
      />
      <div
        style={{
          position: 'relative',
          fontFamily: salonFont.serif,
          fontSize: 42,
          lineHeight: 1,
          letterSpacing: '-0.02em',
        }}
      >
        {palette.mark}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 12,
          fontFamily: salonFont.mono,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          opacity: 0.85,
        }}
      >
        {newsImpactLabel(item.impact)}
      </div>
    </div>
  );
}

function NewsCard({
  item,
  onAddToContext,
  onSnooze,
  onNotRelevant,
}: {
  item: HomeNewsItem;
  onAddToContext: (id: string) => void;
  onSnooze: (id: string, until: string) => void;
  onNotRelevant: (id: string) => void;
}): JSX.Element {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 16 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 24,
                height: 24,
                flexShrink: 0,
                borderRadius: 6,
                display: 'grid',
                placeItems: 'center',
                fontFamily: salonFont.mono,
                fontSize: 10,
                fontWeight: 500,
                background: 'var(--salon-paper-2, #f4ecdb)',
                color: salon.ink,
                border: `1px solid ${salon.line}`,
              }}
            >
              {(item.favicon ?? item.source ?? '·').slice(0, 2)}
            </span>
            {item.source ? (
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: salon.ink,
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.source}
              </span>
            ) : null}
            {item.age ? (
              <span style={{ fontSize: 10.5, color: salon.ink2 }}>
                · {item.age}
              </span>
            ) : null}
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: salonFont.mono,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                padding: '2px 6px',
                borderRadius: 6,
                background: 'var(--salon-paper-2, #f4ecdb)',
                color: salon.ink2,
              }}
            >
              {newsImpactLabel(item.impact)}
            </span>
          </div>

          <div
            style={{
              ...clampLines(2),
              minWidth: 0,
              fontFamily: salonFont.serif,
              fontSize: 20,
              lineHeight: 1.3,
              letterSpacing: '-0.01em',
              color: salon.ink,
            }}
          >
            {item.headline}
          </div>
          {item.excerpt ? (
            <div
              style={{
                ...clampLines(3),
                fontSize: 13,
                lineHeight: 1.55,
                color: salon.ink2,
              }}
            >
              {item.excerpt}
            </div>
          ) : null}
          {item.whyItMatters ? (
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                fontStyle: 'italic',
                color: salon.ink2,
              }}
            >
              {item.whyItMatters}
            </div>
          ) : null}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginTop: 'auto',
              paddingTop: 8,
            }}
          >
            <Eyebrow>Matched</Eyebrow>
            <TalkChip talkId={item.talkId} title={item.talkTitle} />
            {item.matchedOn.length > 0 ? (
              <span
                style={{
                  fontFamily: salonFont.mono,
                  fontSize: 10.5,
                  fontStyle: 'italic',
                  color: salon.ink2,
                }}
              >
                · {truncate(item.matchedOn.join(', '), 48)}
              </span>
            ) : null}
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <button
                type="button"
                className="salon-btn"
                onClick={() => onAddToContext(item.id)}
                style={{
                  height: 28,
                  padding: '0 12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  borderRadius: 9999,
                  border: `1px solid ${salon.line}`,
                  background: 'var(--salon-card, #ffffff)',
                  color: salon.ink,
                  fontFamily: salonFont.sans,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Add to context
                <CTIcon name="check" size={12} stroke={salon.ink2} />
              </button>
              <ActionButton
                behavior={
                  isSafeHttpUrl(item.url)
                    ? { kind: 'href', href: item.url, label: 'Open' }
                    : {
                        kind: 'disabled',
                        reason: 'Link unavailable (untrusted URL).',
                        label: 'Open',
                      }
                }
                variant="secondary"
              />
              <SnoozeControl onSnooze={(until) => onSnooze(item.id, until)} />
              <LifecycleIconButton
                icon="x"
                label="Not relevant"
                onClick={() => onNotRelevant(item.id)}
              />
            </div>
          </div>
        </div>

        <NewsThumb item={item} />
      </div>
    </Card>
  );
}

export function NewsPreview({
  payload,
  onAddToContext,
  onSnooze,
  onNotRelevant,
}: {
  payload: HomeNewsPayload;
  onAddToContext: (id: string) => void;
  onSnooze: (id: string, until: string) => void;
  onNotRelevant: (id: string) => void;
}): JSX.Element {
  const items = payload.items.slice(0, 6);
  return (
    <section aria-label="News for your Talks">
      <SectionHeader
        title="News for your Talks"
        count={items.length ? `${items.length} matched` : undefined}
      />
      {items.length === 0 ? (
        <HomeEmpty
          icon="globe"
          title="No news matched"
          hint="Topic-matched news appears here once your Talks opt into monitoring."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item) => (
            <NewsCard
              key={item.id}
              item={item}
              onAddToContext={onAddToContext}
              onSnooze={onSnooze}
              onNotRelevant={onNotRelevant}
            />
          ))}
        </div>
      )}
    </section>
  );
}
