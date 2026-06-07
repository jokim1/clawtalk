/**
 * Talks — Salon-native full-page list of the workspace's Talks. A fallback /
 * overview surface for `/app/talks`; the primary nav is the sidebar tree. Purely
 * presentational: receives the flattened sidebar tree via `externalData` and
 * renders loading / error / empty / list states in the Salon idiom. Each row
 * links into the Talk and surfaces the metadata the sidebar tree already carries
 * (active run, attached content, message count, last activity).
 */
import { Link } from 'react-router-dom';

import { CTIcon, RunPill, salon, salonFont } from '../salon';
import type { TalkSidebarItem, TalkSidebarTalk } from '../lib/api';

type ExternalTalkData = {
  items: TalkSidebarItem[];
  loading: boolean;
  error: string | null;
};

function flattenTalkSidebar(items: TalkSidebarItem[]): TalkSidebarTalk[] {
  return items.flatMap((item) => (item.type === 'talk' ? [item] : item.talks));
}

/** Relative "last active" label; '' for missing/invalid input. `now` is injected for testability. */
export function formatLastActive(
  value: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Compact "12 messages · 2h ago" metadata line; '' when nothing is known. */
export function talkMetaLabel(
  talk: TalkSidebarTalk,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (typeof talk.messageCount === 'number') {
    parts.push(
      talk.messageCount === 1 ? '1 message' : `${talk.messageCount} messages`,
    );
  }
  const active = formatLastActive(talk.lastMessageAt, now);
  if (active) parts.push(active);
  return parts.join(' · ');
}

export function TalkListPage({
  externalData,
}: {
  externalData: ExternalTalkData;
}): JSX.Element {
  const effectiveTalks = flattenTalkSidebar(externalData.items);

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '20px 20px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 26,
            fontWeight: 500,
            color: salon.ink,
          }}
        >
          Talks
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: salon.ink2 }}>
          Use the blue <strong>+</strong> button in the sidebar to create a new
          talk or folder.
        </p>
      </header>

      {externalData.loading ? (
        <div aria-busy="true" aria-label="Loading talks">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="ct-pulse"
              style={{
                height: 56,
                marginBottom: 10,
                borderRadius: 12,
                background: 'var(--salon-paper-2, #f4ecdb)',
              }}
            />
          ))}
        </div>
      ) : null}

      {!externalData.loading && externalData.error ? (
        <TalkListCard>
          <div style={{ fontSize: 13, color: salon.ink2 }}>
            {externalData.error}
          </div>
        </TalkListCard>
      ) : null}

      {!externalData.loading && !externalData.error ? (
        effectiveTalks.length === 0 ? (
          <TalkListCard>
            <div
              style={{
                textAlign: 'center',
                padding: '24px 12px',
                color: salon.ink2,
                fontSize: 13.5,
              }}
            >
              No talks yet. Create one from the sidebar.
            </div>
          </TalkListCard>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {effectiveTalks.map((talk) => (
              <li key={talk.id}>
                <TalkRow talk={talk} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function TalkListCard({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--salon-card, #ffffff)',
        border: `1px solid ${salon.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function TalkRow({ talk }: { talk: TalkSidebarTalk }): JSX.Element {
  const meta = talkMetaLabel(talk);
  return (
    <Link
      to={`/app/talks/${encodeURIComponent(talk.id)}`}
      className="salon-btn"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'var(--salon-card, #ffffff)',
        border: `1px solid ${salon.line}`,
        borderRadius: 12,
        padding: '12px 14px',
        textDecoration: 'none',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: salon.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {talk.title || 'Untitled Talk'}
          </span>
          {talk.hasContent ? (
            <span
              role="img"
              aria-label="Has a document"
              style={{ display: 'inline-flex', flexShrink: 0 }}
            >
              <CTIcon name="doc" size={12} stroke={salon.ink2} />
            </span>
          ) : null}
        </div>
        {meta ? (
          <div style={{ fontSize: 12, color: salon.ink2, marginTop: 2 }}>
            {meta}
          </div>
        ) : null}
      </div>
      {talk.hasActiveRun ? <RunPill status="running" /> : null}
    </Link>
  );
}
