/**
 * News preview — topic-matched items for monitored Talks (docs/07 §8). Ported
 * from NewsCard in prototype/home-shared.jsx. "Open" links out to the source;
 * "Add to context" is disabled until the Home write API lands.
 */
import { salon, salonFont } from '../../salon';
import type { HomeNewsItem, HomeNewsPayload } from '../../lib/api';
import {
  ActionButton,
  Card,
  clampLines,
  HomeEmpty,
  SectionHeader,
  TalkChip,
} from './HomeKit';
import {
  HOME_WRITE_PENDING_REASON,
  isSafeHttpUrl,
  newsImpactLabel,
} from './homeFormat';

function NewsCard({ item }: { item: HomeNewsItem }): JSX.Element {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            fontSize: 16,
            lineHeight: 1.3,
            color: salon.ink,
          }}
        >
          {item.headline}
        </div>
        {item.excerpt ? (
          <div
            style={{
              ...clampLines(3),
              fontSize: 12.5,
              lineHeight: 1.4,
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
          }}
        >
          <TalkChip talkId={item.talkId} title={item.talkTitle} />
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <ActionButton
              behavior={{
                kind: 'disabled',
                reason: HOME_WRITE_PENDING_REASON,
                label: 'Add to context',
              }}
              variant="secondary"
            />
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
          </div>
        </div>
      </div>
    </Card>
  );
}

export function NewsPreview({
  payload,
}: {
  payload: HomeNewsPayload;
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
            <NewsCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
